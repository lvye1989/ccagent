import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { reconcileSessionBilling } from "../core/queryEngine/commands/billing.js";
import { initSessionStorage, createExecutionRecorder, readSessionExecutionEvents } from "../session/storage.js";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { runTools } from "../core/agenticLoop.js";
import { measureStage, withTurnTimings, type TurnTimings } from "../core/turnTimings.js";
import { headlessPermissionDecision } from "../entrypoint/headless.js";
import { setPluginApprovalRules } from "../plugins/approvalRules.js";
import { loadPlugin } from "../plugins/loader.js";
import type { PermissionDecision, PermissionRequest } from "../permissions/permissions.js";
import type { Tool } from "../tools/Tool.js";
import { fetchUrlContent } from "../tools/webFetch/fetcher.js";
import { withTestAccount } from "./helpers/accountFixture.js";

async function verifyFetch() {
  const originalFetch = globalThis.fetch;
  const originalTimeout = AbortSignal.timeout;
  try {
    let redirected = false;
    const signals: (AbortSignal | undefined | null)[] = [];
    globalThis.fetch = async (_url, init) => {
      signals.push(init?.signal);
      if (signals.length === 1) {
        return new Response(new ReadableStream({ cancel() { redirected = true; } }), {
          status: 302, headers: { location: "/body" },
        });
      }
      const bytes = new TextEncoder().encode("文档");
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(bytes.slice(0, 1)); controller.enqueue(bytes.slice(1)); controller.close();
      } }), { headers: { "content-type": "text/plain" } });
    };
    const fetched = await fetchUrlContent("https://example.org/start");
    assert.equal(fetched.type === "content" && fetched.content, "文档");
    assert.equal(fetched.type === "content" && fetched.bytes, 6);
    assert.ok(redirected && signals[0] && signals[0] === signals[1]);

    for (const source of ["caller", "deadline"] as const) {
      const caller = new AbortController();
      const deadline = new AbortController();
      AbortSignal.timeout = () => deadline.signal;
      let reading!: () => void;
      const bodyRequested = new Promise<void>(resolve => { reading = resolve; });
      let cancelled = false;
      globalThis.fetch = async () => new Response(new ReadableStream({
        pull() { reading(); }, cancel() { cancelled = true; },
      }), { headers: { "content-type": "text/plain" } });
      const pending = fetchUrlContent("https://example.org/slow", caller.signal);
      await bodyRequested;
      await delay(0);
      (source === "caller" ? caller : deadline).abort(new Error(source));
      await assert.rejects(pending, new RegExp(source));
      assert.ok(cancelled, source + " cancelled the response body");
    }
    AbortSignal.timeout = originalTimeout;
    let chunks = 0;
    let cancelled = false;
    globalThis.fetch = async () => new Response(new ReadableStream({
      pull(controller) { chunks++; controller.enqueue(new Uint8Array(1024 * 1024)); },
      cancel() { cancelled = true; return new Promise<void>(() => {}); },
    }), { headers: { "content-type": "application/octet-stream" } });
    await assert.rejects(fetchUrlContent("https://example.org/large"), /too large/);
    assert.ok(cancelled && chunks <= 12);
  } finally {
    globalThis.fetch = originalFetch;
    AbortSignal.timeout = originalTimeout;
  }
}

async function verifyTimings() {
  const fresh = (queueMs: number): TurnTimings => ({ queueMs, toolsMs: 0, modelMs: 0, summaryMs: 0 });
  const a = fresh(7), b = fresh(13);
  async function* stage(name: "toolsMs" | "modelMs") {
    await measureStage(name, () => delay(12));
    yield name;
    await measureStage("summaryMs", () => delay(8));
  }
  const ra = withTurnTimings(a, stage("modelMs")), rb = withTurnTimings(b, stage("toolsMs"));
  await Promise.all([ra.next(), rb.next()]);
  await Promise.all([ra.next(), rb.return(undefined)]);
  assert.ok(a.modelMs > 0 && a.summaryMs > 0);
  assert.equal(a.toolsMs, 0); assert.equal(a.queueMs, 7);
  assert.ok(b.toolsMs > 0); assert.equal(b.modelMs, 0);
  assert.equal(b.summaryMs, 0); assert.equal(b.queueMs, 13);
}

async function verifyPlugin() {
  await withTestAccount(async ({ home }) => {
    const root = path.join(home, "test-plugin");
    await mkdir(path.join(root, ".ccagent-plugin"), { recursive: true });
    await mkdir(path.join(root, "hooks"));
    const rule = { tool: "FixtureRead", behavior: "ask", reason: "Confirm this read" };
    await writeFile(path.join(root, ".ccagent-plugin", "plugin.json"), JSON.stringify({
      name: "fixture", version: "1.0.0", approvalRules: [rule],
    }));
    await writeFile(path.join(root, "hooks", "hooks.json"), JSON.stringify({
      PreToolUse: [{ hooks: [{ type: "command", command: "echo ok" }] }],
    }));
    await writeFile(path.join(root, ".mcp.json"), JSON.stringify({
      mcpServers: { demo: { type: "stdio", command: process.execPath, args: [] } },
    }));
    await writeFile(path.join(root, "asset.txt"), "样本");
    const plugin = await loadPlugin({ root, strict: true, pluginId: "fixture@dev" });
    assert.deepEqual(plugin.errors, []);
    const sdkUrl = plugin.hooks[0]!.hooks[0]!.env!.CCAGENT_PLUGIN_API!;
    const config = plugin.mcpServers[0]!.config;
    assert.ok(config.type === "stdio" && config.env?.CCAGENT_PLUGIN_API === sdkUrl);
    const { createPluginHost } = await import(sdkUrl);
    const host = createPluginHost({ root, data: plugin.dataDir });
    assert.equal(await host.files.readText("asset.txt"), "样本");
    await assert.rejects(host.files.readText("../asset.txt"), /outside/);
    assert.equal(await host.storage.get("current"), undefined);
    await Promise.all([1, 2].map(n => host.storage.set("current", { n })));
    assert.ok([1, 2].includes((await host.storage.get("current")).n));
    await assert.rejects(host.storage.get("../other"), /Invalid plugin storage key/);
    const child = await host.processes.run(process.execPath, ["-e", "process.stdout.write(process.argv[1])", "a & b"]);
    assert.equal(child.stdout, "a & b");
    await assert.rejects(host.processes.run(process.execPath, ["-e", "setInterval(()=>{},1000)"], { timeout: 40 }));
    const unicode = await host.processes.run(process.execPath, ["-e", "process.stdout.write('输出'); process.stderr.write('提示')"]);
    assert.equal(unicode.stdout, "输出"); assert.equal(unicode.stderr, "提示");
    await assert.rejects(host.processes.run(path.join(root, "missing-fixture-program"), []), (error: unknown) => {
      assert.equal((error as NodeJS.ErrnoException).code, "ENOENT");
      assert.equal((error as { stdout: string }).stdout, "");
      assert.equal((error as { stderr: string }).stderr, "");
      return true;
    });
    const preAborted = new AbortController(); preAborted.abort();
    await assert.rejects(host.processes.run(process.execPath, ["-e", "process.exit(0)"], { signal: preAborted.signal }),
      (error: unknown) => (error as { code?: string }).code === "ABORT_ERR");
    await assert.rejects(host.processes.run(process.execPath, ["-e", "process.stdout.write('partial'); process.stderr.write('normal failure'); process.exitCode=7"]), (error: unknown) => {
      const value = error as { code: number; stdout: string; stderr: string };
      assert.equal(value.code, 7); assert.equal(value.stdout, "partial"); assert.equal(value.stderr, "normal failure");
      return true;
    });
    await assert.rejects(host.processes.run(process.execPath, ["-e", "process.stderr.write(Buffer.alloc(1024*1024+1,120)); setInterval(()=>{},1000)"]), (error: unknown) => {
      const value = error as { code: string; stdout: string; stderr: string };
      assert.equal(value.code, "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"); assert.equal(value.stdout, "");
      assert.ok(Buffer.byteLength(value.stderr) <= 1024 * 1024); return true;
    });
    const concurrentAbort = new AbortController();
    const cancelledCall: Promise<unknown> = host.processes.run(process.execPath, ["-e", "setInterval(()=>{},1000)"], { signal: concurrentAbort.signal });
    const cancelledResult = cancelledCall.then(() => undefined, (error: unknown) => error);
    const cancelTimer = setTimeout(() => concurrentAbort.abort(), 100);
    try {
      const [error, sibling] = await Promise.all([cancelledResult,
        host.processes.run(process.execPath, ["-e", "setTimeout(()=>process.stdout.write('unrelated sibling completed'),350)"])]);
      assert.equal((error as { code?: string }).code, "ABORT_ERR");
      assert.equal(sibling.stdout, "unrelated sibling completed", "Cleaning one invocation leaves its sibling alone");
    } finally { clearTimeout(cancelTimer); concurrentAbort.abort(); await cancelledResult; }

    // Ordinary foreground Node parents/children only. No detached processes,
    // external services, user files, or shell execution are used by fixtures.
    const { readFile } = await import("node:fs/promises");
    const active = async (pid: number) => {
      try { process.kill(pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
      if (process.platform === "linux") {
        try { if (/\)\s+Z\s/.test(await readFile(`/proc/${pid}/stat`, "utf8"))) return false; }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
      }
      return true;
    };
    const waitForInactive = async (pid: number) => {
      const deadline = Date.now() + 3000;
      while (await active(pid)) { assert.ok(Date.now() < deadline, `Owned foreground fixture ${pid} stopped`); await delay(20); }
    };
    for (const mode of ["timeout", "cancel", "output", "race"] as const) {
      const marker = path.join(root, `normal-process-tree-${mode}.json`);
      const controller = new AbortController();
      const script = `const fs=require('node:fs'),{spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'}); fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({parent:process.pid,child:child.pid})); ${mode === "output" ? "setTimeout(()=>process.stdout.write(Buffer.alloc(1024*1024+1,120)),250);" : ""} setInterval(()=>{},1000);`;
      const run: Promise<unknown> = host.processes.run(process.execPath, ["-e", script], { timeout: mode === "timeout" || mode === "race" ? 1200 : 5000, signal: controller.signal });
      const raceTimer = mode === "race" ? setTimeout(() => controller.abort(), 1200) : undefined;
      const observed = run.then(() => ({ error: undefined }), (error: unknown) => ({ error }));
      let ids: { parent: number; child: number } | undefined;
      try {
        const deadline = Date.now() + 3000;
        while (!ids) {
          try { ids = JSON.parse(await readFile(marker, "utf8")); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; assert.ok(Date.now() < deadline, "Foreground fixture started"); await delay(20); }
        }
        assert.ok(Number.isSafeInteger(ids.parent) && Number.isSafeInteger(ids.child));
        assert.ok(ids.parent > 0 && ids.child > 0 && ids.parent !== process.pid && ids.child !== process.pid);
        if (mode === "cancel") { controller.abort(); controller.abort(); }
        const result = await observed;
        assert.ok(result.error instanceof Error);
        const error = result.error as Error & { code?: string; stdout?: string; stderr?: string };
        if (mode === "race") assert.ok(error.code === "ETIMEDOUT" || error.code === "ABORT_ERR");
        else assert.equal(error.code, mode === "timeout" ? "ETIMEDOUT" : mode === "cancel" ? "ABORT_ERR" : "ERR_CHILD_PROCESS_STDIO_MAXBUFFER");
        assert.equal(typeof error.stdout, "string"); assert.equal(typeof error.stderr, "string");
        assert.ok(Buffer.byteLength(error.stdout!) <= 1024 * 1024);
        await Promise.all([waitForInactive(ids.parent), waitForInactive(ids.child)]);
      } finally {
        if (raceTimer) clearTimeout(raceTimer);
        controller.abort();
        // A failing test still cleans only its own two recorded fixture PIDs.
        if (ids) for (const pid of [ids.child, ids.parent]) if (pid > 0 && pid !== process.pid && await active(pid)) {
          try { process.kill(pid, "SIGKILL"); } catch { /* already exited */ }
        }
        await observed;
      }
    }
    console.log("Verified plugin SDK stdout/stderr, startup errors, and normal process-tree timeout/cancel/output cleanup.");
    let calls = 0;
    const tool: Tool = {
      name: rule.tool, description: "Test read", inputSchema: { type: "object", properties: {} },
      isEnabled: () => true, isReadOnly: () => true, isConcurrencySafe: () => true,
      async call() { calls++; return { content: "fixture" }; },
    };
    const rules = { allow: [] as string[], deny: [] as string[] };
    const run = (ids: string[], onPermissionRequest: (request: PermissionRequest) => Promise<PermissionDecision>) =>
      runTools(ids.map(id => ({ type: "tool_use", name: rule.tool, id, input: {} })), {
        cwd: root, scopedTools: [tool], sessionId: "fixture",
      }, { permissionMode: "full", permissionSettings: { mode: "full", allow: [], deny: [] },
        sessionPermissionRules: rules, onPermissionRequest });
    try {
      const trust = new Map([[plugin.pluginId, true]]);
      setPluginApprovalRules([plugin], trust);
      let active = 0, prompts = 0;
      const allowed = await run(["a", "b"], async req => {
        assert.equal(++active, 1); assert.equal(req.requiresHumanReview, true);
        await delay(10); active--; prompts++; return "allow_always";
      });
      assert.ok(allowed.executions.every(item => !item.result.isError));
      assert.equal(prompts, 2); assert.equal(calls, 2); assert.deepEqual(rules.allow, []);
      const denied = await run(["c"], async req => headlessPermissionDecision(req, true));
      assert.ok(denied.executions[0]?.result.isError); assert.equal(calls, 2);
      setPluginApprovalRules([plugin], new Map());
      await run(["d"], async () => { throw new Error("Untrusted rule requested approval"); });
      assert.equal(calls, 3);
      setPluginApprovalRules([plugin], trust);
      const changed = await run(["e"], async () => {
        setPluginApprovalRules([{ ...plugin, manifest: { ...plugin.manifest, approvalRules: [{ ...rule, behavior: "deny" }] } }], trust);
        return "allow_once";
      });
      assert.ok(changed.executions[0]?.result.isError); assert.equal(calls, 3);
    } finally { setPluginApprovalRules([], new Map()); }
  });
}

async function verifyBillingLookup() {
  await withTestAccount(async ({ home }) => {
    const sessionId = randomUUID(), logical = randomUUID(), actual = randomUUID(), server = randomUUID();
    const timestamp = new Date().toISOString();
    await initSessionStorage({ cwd: home, sessionId, startedAt: timestamp, updatedAt: timestamp, model: "test" });
    const recorder = createExecutionRecorder(home, sessionId);
    const context = { cwd: home, sessionId, recordExecutionEvent: recorder };
    const initial = { logicalRequestId: logical, actualRequestId: actual, serverCallId: server, status: "held" as const, authoritative: true };
    const scope = { agentSessionId: sessionId, turnId: randomUUID(), requestId: logical, step: 1 };
    await recorder({ ...scope, id: randomUUID(), phase: "billing_receipt", timestamp, platformReceipt: initial });
    let lookups = 0;
    const lookup = async (logicalId: string, actualId: string) => {
      assert.equal(logicalId, logical); assert.equal(actualId, actual); lookups++;
      return { ...initial, status: "settled" as const, chargedMicro: "250000" };
    };
    assert.match(await reconcileSessionBilling(context, [randomUUID()], lookup), /未找到/);
    assert.match(await reconcileSessionBilling({ ...context, temporaryChat: true }, [], lookup), /未保存/);
    assert.equal(lookups, 0);
    const reply = await reconcileSessionBilling(context, [], lookup);
    assert.ok(reply.includes("已结算") && reply.includes("¥0.250000") && reply.includes(actual));
    const receipt = (await readSessionExecutionEvents(home, sessionId)).at(-1)!;
    assert.equal(receipt.turnId, scope.turnId);
    assert.equal(receipt.platformReceipt?.status, "settled");
    const newest = randomUUID();
    await recorder({ ...scope, id: randomUUID(), requestId: newest, phase: "request_end", timestamp,
      platformReceipt: { ...initial, logicalRequestId: newest, actualRequestId: newest } });
    await reconcileSessionBilling(context, [logical], lookup);
    assert.equal(lookups, 2);
    await reconcileSessionBilling(context, [], async (logicalId, actualId) => {
      assert.equal(logicalId, newest); assert.equal(actualId, newest);
      return { logicalRequestId: newest, actualRequestId: newest, status: "pending", authoritative: true };
    });
  });
}

await verifyBillingLookup();
await verifyFetch();
await verifyTimings();
await verifyPlugin();
console.log("Verified read-only billing reconciliation, streamed body limits and cancellation, per-turn timings, plugin SDK and dispatch approvals.");
