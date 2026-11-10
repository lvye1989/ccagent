/** Compiled CLI/Web latency and continuity checks. All accounts, files and models are local fixtures. */
import assert from "node:assert/strict";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { accountHome } from "../platform/account.js";
import { startAccountFixture } from "./helpers/accountFixture.js";

type Capture = { caseId: string; summary: boolean; at: number; firstToken: number; results: string[]; requestBytes: number };
type Metric = { surface: "cli" | "web"; caseId: string; firstEventMs: number; firstAssistantMs: number; providerRequestMs: number; providerFirstTokenMs: number; completeMs: number; requests: number; summaries: number };
type WebEvent = { type: string; text?: string; reason?: string; name?: string; id?: string; timestamp?: string; execution?: { id: string; startedAt: string; completedAt: string | null } | null };
const repository = path.resolve(import.meta.dirname, "../..");
const binary = path.join(repository, "dist/ccagent.js");
const binaryHash = createHash("sha256").update(await fs.readFile(binary)).digest("hex");
const repeats = Math.max(3, Math.min(9, Number(process.env.CCAGENT_BENCH_REPEATS) || 3));
const reportArgument = process.argv.find(value => value.startsWith("--report="))?.slice(9) ?? "runtime-parity-benchmark-latest.json";
assert.match(reportArgument, /^[a-z0-9._-]+\.json$/i, "Report is a filename under ignored output/checks");
const parent = await fs.realpath(os.tmpdir());
const temporary = await fs.realpath(await fs.mkdtemp(path.join(parent, "ccagent-runtime-parity-")));
const workspace = path.join(temporary, "workspace"), platformBase = path.join(temporary, "profile");
await fs.mkdir(workspace);
await fs.writeFile(path.join(workspace, "evidence.txt"), "SHARED_RUNTIME_EVIDENCE\n");
await fs.writeFile(path.join(workspace, "long-evidence.txt"), "LONG_EVIDENCE " + "x".repeat(80_000));
const account = await startAccountFixture(platformBase);
const home = accountHome(platformBase, account.users[0]!.id); await fs.mkdir(home, { recursive: true });
const captures: Capture[] = [], metrics: Metric[] = [], fixtureErrors: string[] = [], children: ChildProcess[] = [];
const feeds: Array<{ close(): Promise<void> }> = [];
let web: ChildProcess | undefined, webLogs = "", origin = "", cookie = "", checks = 0, startupMs = 0, restoredStartupMs = 0;
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const pass = (text: string) => { checks++; console.log("PASS " + text); };
const group = (id: string) => captures.filter(value => value.caseId === id);
const supplier = createServer(async (request, response) => {
  try {
    assert.equal(request.url, "/v1/chat/completions");
    let raw = ""; for await (const bytes of request) raw += bytes;
    const body = JSON.parse(raw), history = JSON.stringify(body.messages);
    const summary = history.includes("Your task is to create a detailed summary of the conversation so far");
    const caseId = [...history.matchAll(/BENCH:([a-z0-9-]+)/g)].at(-1)?.[1];
    assert.ok(caseId, "Every fixture request belongs to an explicit case");
    const previous = group(caseId), mainCount = previous.filter(value => !value.summary).length;
    const results = body.messages.filter((message: any) => message.role === "tool").map((message: any) => String(message.content));
    const capture: Capture = { caseId, summary, at: performance.now(), firstToken: 0, results, requestBytes: Buffer.byteLength(raw) }; captures.push(capture);
    let tool: { name: string; args: object } | undefined;
    let text = "FINISHED:" + caseId;
    if (summary) {
      assert.ok(caseId.includes("long"), "Short cases must not spuriously summarize authoritative usage");
      assert.match(history, /LONG_EVIDENCE/);
      text = `DURABLE_SUMMARY BENCH:${caseId} original requirement: preserve INVARIANT_42 and continue after reading long-evidence.txt. Read completed. Next write ${caseId}.txt then read it.`;
    } else if (caseId.includes("followup")) {
      assert.match(history, /SHARED_RUNTIME_EVIDENCE/);
      assert.match(history, /FINISHED:web-tools-continuity/);
      text = "FOLLOWUP_CONFIRMED_HISTORY";
    } else if (caseId.includes("chain")) {
      if (mainCount < 18) tool = { name: "Read", args: { file_path: mainCount === 5 ? "missing-fixture.txt" : "evidence.txt" } };
      else { assert.equal(mainCount, 18); assert.equal(results.length, 18); assert.match(results[5]!, /File not found/); assert.match(results.at(-1)!, /SHARED_RUNTIME_EVIDENCE/); }
    } else if (caseId.includes("tools") || caseId.includes("long") || caseId.includes("reconnect")) {
      if (mainCount === 0) tool = { name: "Read", args: { file_path: caseId.includes("long") ? "long-evidence.txt" : "evidence.txt" } };
      else if (mainCount === 1) {
        if (caseId.includes("long")) { assert.match(history, /DURABLE_SUMMARY/); assert.match(history, /INVARIANT_42/); }
        else assert.match(results[0]!, /SHARED_RUNTIME_EVIDENCE/);
        tool = { name: "Write", args: { file_path: caseId + ".txt", content: "PERSISTED_INVARIANT_42" } };
      } else if (mainCount === 2) tool = { name: "Read", args: { file_path: caseId + ".txt" } };
      else { assert.equal(mainCount, 3); assert.match(results.at(-1)!, /PERSISTED_INVARIANT_42/); }
    }
    if (tool) assert.ok(body.tools.some((value: any) => value.function.name === tool!.name));
    await pause(20);
    response.writeHead(200, { "content-type": "text/event-stream" });
    const write = (delta: unknown) => response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    capture.firstToken = performance.now();
    if (tool) write({ tool_calls: [{ index: 0, id: `${caseId}-${mainCount}`, type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.args) } }] });
    else {
      // A deliberately delayed stream distinguishes real first-text delivery from a buffered final message.
      const pieces = text.match(/.{1,7}/g)!;
      for (const piece of pieces) { write({ content: piece }); await pause(15); }
    }
    response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }], usage: { prompt_tokens: summary ? 100 : mainCount === 0 ? 16_000 : 2_000, completion_tokens: 10 } })}\n\ndata: [DONE]\n\n`);
  } catch (error) {
    fixtureErrors.push(error instanceof Error ? error.message : String(error));
    if (!response.headersSent) response.writeHead(500); response.end("Local benchmark fixture failed");
  }
});
await new Promise<void>(resolve => supplier.listen(0, "127.0.0.1", resolve));
const supplierAddress = supplier.address(); assert.ok(supplierAddress && typeof supplierAddress !== "string");
await fs.writeFile(path.join(home, "settings.json"), JSON.stringify({ model: "runtime-fixture", defaultModel: "runtime-fixture", disableAllHooks: true, alwaysThinkingEnabled: false,
  models: { "runtime-fixture": { protocol: "openai-chat", model: "runtime-fixture", baseURL: `http://127.0.0.1:${supplierAddress.port}/v1`, apiKey: "fixture-only", contextWindow: 32_768, maxTokens: 512 } }, mcpServers: {} }));
const preload = path.join(temporary, "loopback-only.mjs");
await fs.writeFile(preload, `const original = globalThis.fetch; globalThis.fetch = (input, options) => { const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url); if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) throw new Error("Runtime parity forbids external fetch: " + url.hostname); return original(input, options); };\n`);
const emptyEnv = path.join(temporary, "empty.env"); await fs.writeFile(emptyEnv, "");
const environment: NodeJS.ProcessEnv = { ...process.env };
for (const key of Object.keys(environment)) if (/API.?KEY|SECRET|TOKEN/i.test(key) || /^(CCAGENT|ANTHROPIC|OPENAI|QWEN|DASHSCOPE|OLLAMA|GEMINI|JEV|CLAUDE_CODE)_/i.test(key) || ["NODE_OPTIONS", "NODE_TLS_REJECT_UNAUTHORIZED"].includes(key)) delete environment[key];
Object.assign(environment, { CCAGENT_HOME: platformBase, CCAGENT_PLATFORM_HOME: platformBase, CCAGENT_ENV_FILE: emptyEnv, CCAGENT_DISABLE_STREAM_LOG: "1" });
const launch = ["--import", pathToFileURL(preload).href, binary];
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
  if (child.connected) child.send("ccagent:shutdown", () => {}); else child.kill();
  const timer = setTimeout(() => { if (process.platform === "win32" && child.pid) { try { execFileSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); } catch { child.kill(); } } else child.kill(); }, 6000);
  await closed; clearTimeout(timer);
}
async function request(route: string, body?: object) {
  const response = await fetch(origin + route, { method: body ? "POST" : "GET", headers: { ...(cookie ? { cookie } : {}), ...(body ? { origin, "x-ccagent-web": "1", "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20_000) });
  assert.ok(response.ok, route + " " + response.status + " " + await response.clone().text());
  if (route === "/api/account/login") cookie = response.headers.get("set-cookie")!.split(";")[0]!;
  return response.json() as Promise<any>;
}
async function startWeb(port: number) {
  const startup = performance.now();
  web = spawn(process.execPath, [...launch, "web", "--workspace", workspace, "--port", String(port)], { cwd: workspace, env: environment, windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"] }); children.push(web);
  web.stdout!.on("data", bytes => webLogs = (webLogs + String(bytes)).slice(-12_000)); web.stderr!.on("data", bytes => webLogs = (webLogs + String(bytes)).slice(-12_000));
  let ready = false; for (let attempt = 0; attempt < 150; attempt++) { assert.equal(web.exitCode, null, webLogs); try { if ((await fetch(origin + "/api/health", { signal: AbortSignal.timeout(500) })).ok) { ready = true; break; } } catch {} await pause(100); }
  assert.ok(ready, webLogs); return Math.round(performance.now() - startup);
}
async function feed(id: string, after = 0) {
  const controller = new AbortController();
  const response = await fetch(`${origin}/api/sessions/${id}/events`, { headers: { cookie, "Last-Event-ID": String(after) }, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]) });
  assert.equal(response.status, 200);
  const reader = response.body!.getReader(), decoder = new TextDecoder(); let buffer = "", lastId = after;
  const value = { lastId: () => lastId, async close() { controller.abort(); await reader.cancel().catch(() => {}); }, async next(): Promise<WebEvent> {
    while (true) {
      const boundary = buffer.indexOf("\n\n");
      if (boundary >= 0) { const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2); const eventId = /^id: (\d+)$/m.exec(frame), data = /^data: (.*)$/m.exec(frame); if (eventId) { assert.ok(Number(eventId[1]) > lastId, "SSE replay IDs advance without duplicates"); lastId = Number(eventId[1]); } if (data) return JSON.parse(data[1]!) as WebEvent; continue; }
      const chunk = await reader.read(); assert.equal(chunk.done, false, "SSE must reach terminal engine event"); buffer += decoder.decode(chunk.value, { stream: true }).replaceAll("\r\n", "\n");
    }
  } }; feeds.push(value); return value;
}
function metric(surface: Metric["surface"], caseId: string, started: number, firstEvent: number, firstAssistant: number, completed: number) {
  const values = group(caseId), main = values.find(value => !value.summary)!;
  assert.ok(main); const ms = (value: number) => Math.round((value - started) * 10) / 10;
  metrics.push({ surface, caseId, firstEventMs: ms(firstEvent), firstAssistantMs: ms(firstAssistant), providerRequestMs: ms(main.at), providerFirstTokenMs: ms(main.firstToken), completeMs: ms(completed), requests: values.length, summaries: values.filter(value => value.summary).length });
}
async function cliCase(caseId: string) {
  const started = performance.now(), child = spawn(process.execPath, [...launch, "--print", "BENCH:" + caseId + " preserve INVARIANT_42", "--permission-mode", "full", "--output-format", "stream-json"], { cwd: workspace, env: environment, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }); children.push(child);
  let output = "", error = "", pending = "", firstEvent = 0, firstAssistant = 0; const lines: any[] = [];
  child.stdout!.on("data", bytes => { output += String(bytes); pending += String(bytes); while (pending.includes("\n")) { const end = pending.indexOf("\n"), line = pending.slice(0, end).trim(); pending = pending.slice(end + 1); if (!line) continue; const value = JSON.parse(line); lines.push(value); firstEvent ||= performance.now(); if (value.type === "assistant" && value.message.content.some((block: any) => block.type === "text")) firstAssistant ||= performance.now(); } });
  child.stderr!.on("data", bytes => error = (error + String(bytes)).slice(-12_000));
  const exited = new Promise<number | null>((resolve, reject) => { child.once("close", resolve); child.once("error", reject); });
  const timer = setTimeout(() => child.kill(), 45_000);
  try { assert.equal(await exited, 0, error + "\n" + output.slice(-2000)); } finally { clearTimeout(timer); }
  const last = lines.at(-1); assert.equal(last?.is_error, false); assert.equal(last.result, "FINISHED:" + caseId);
  metric("cli", caseId, started, firstEvent, firstAssistant, performance.now()); return lines;
}
async function webCase(caseId: string, existing?: string, reconnect = false) {
  const id: string = existing ?? (await request("/api/sessions", { model: "runtime-fixture", mode: "full", team: "off" })).sessionId;
  let stream = await feed(id, existing ? (await request(`/api/sessions/${id}`)).lastEventId : 0);
  await stream.next(); // initial execution snapshot is connection setup, not task latency.
  const started = performance.now(); await request(`/api/sessions/${id}/messages`, { text: "BENCH:" + caseId + " preserve INVARIANT_42" });
  let firstEvent = 0, firstAssistant = 0, output = "", reconnectCount = 0; const events: WebEvent[] = [];
  while (true) {
    const event = await stream.next(); events.push(event); firstEvent ||= performance.now();
    if (event.type === "text") { firstAssistant ||= performance.now(); output += event.text; }
    if (reconnect && !reconnectCount && event.type === "tool_done" && event.name === "Write") {
      const after = stream.lastId(), before = await request(`/api/sessions/${id}`), requestsBefore = group(caseId).length;
      await stream.close(); await pause(35); stream = await feed(id, after); reconnectCount++;
      assert.equal(group(caseId).filter(value => !value.summary).length <= 4, true);
      let snapshot: WebEvent | undefined;
      while (!snapshot) { const replay = await stream.next(); events.push(replay); if (replay.type === "execution_state") snapshot = replay; else if (replay.type === "text") { firstAssistant ||= performance.now(); output += replay.text; } }
      assert.equal(snapshot.execution?.id, before.execution.id, "Reconnect preserves original turn identity");
      assert.equal(snapshot.execution?.startedAt, before.execution.startedAt, "Reconnect preserves original elapsed-time origin");
      assert.ok(group(caseId).length >= requestsBefore);
    }
    const terminal = event.type === "turn_complete" ? event : [...events].reverse().find(value => value.type === "turn_complete");
    if (terminal) { assert.equal(terminal.reason, "completed"); break; }
  }
  const completed = performance.now(), state = await request(`/api/sessions/${id}`); assert.equal(state.busy, false); assert.equal(state.pending, null);
  if (caseId.includes("followup")) assert.equal(output, "FOLLOWUP_CONFIRMED_HISTORY"); else assert.equal(output, "FINISHED:" + caseId);
  if (caseId.includes("chain")) { assert.equal(state.execution.tools.length, 18); assert.equal(state.execution.tools.filter((tool: any) => tool.isError).length, 1); }
  else if (!caseId.includes("simple") && !caseId.includes("followup")) { assert.deepEqual(state.execution.tools.map((tool: any) => tool.name), ["Read", "Write", "Read"]); assert.ok(state.execution.tools.every((tool: any) => tool.isError === false)); }
  metric("web", caseId, started, firstEvent, firstAssistant, completed); await stream.close(); return { id, state, events, reconnectCount };
}
try {
  await account.nativeClient.signIn(account.users[0]!.email, account.password);
  const reservation = createServer(); await new Promise<void>(resolve => reservation.listen(0, "127.0.0.1", resolve)); const address = reservation.address(); assert.ok(address && typeof address !== "string"); await new Promise<void>(resolve => reservation.close(() => resolve())); origin = `http://127.0.0.1:${address.port}`;
  startupMs = await startWeb(address.port);
  await request("/api/account/login", { email: account.users[0]!.email, password: account.password });
  for (let index = 0; index < repeats; index++) {
    // Alternate order to reduce systematic warm-cache/order bias.
    if (index % 2) { await webCase(`web-simple-${index}`); await cliCase(`cli-simple-${index}`); }
    else { await cliCase(`cli-simple-${index}`); await webCase(`web-simple-${index}`); }
  }
  for (const value of metrics) { assert.equal(value.requests, 1); assert.equal(value.summaries, 0); assert.ok(value.providerFirstTokenMs <= value.firstAssistantMs + 5); }
  pass(`${repeats} cold CLI and ${repeats} warm Web samples: one identical model request, streamed-first-text timing captured separately`);
  const cliTools = await cliCase("cli-tools-continuity"), webTools = await webCase("web-tools-continuity");
  for (const id of ["cli-tools-continuity", "web-tools-continuity"]) { assert.equal(group(id).length, 4); assert.equal(group(id).filter(value => value.summary).length, 0); assert.equal(await fs.readFile(path.join(workspace, id + ".txt"), "utf8"), "PERSISTED_INVARIANT_42"); }
  const cliResults = cliTools.filter(value => value.type === "user").flatMap(value => value.message.content).filter((value: any) => value.type === "tool_result"); assert.equal(cliResults.length, 3); assert.ok(cliResults.every((value: any) => !value.is_error));
  pass("Read → Write → Read executes once per step in both compiled entrypoints; authoritative 16K input does not cause false summarization");
  await cliCase("cli-chain-continuity"); await webCase("web-chain-continuity");
  for (const id of ["cli-chain-continuity", "web-chain-continuity"]) { assert.equal(group(id).length, 19); assert.equal(group(id).filter(value => value.summary).length, 0); }
  pass("18 consecutive tool rounds in both entrypoints survive one real missing-file error and finish without an extra user Continue message");
  await webCase("web-followup-continuity", webTools.id); assert.equal(group("web-followup-continuity").length, 1);
  pass("same Web session follows up with original evidence, prior final answer and exact task invariant retained");
  const reconnected = await webCase("web-reconnect-continuity", undefined, true); assert.equal(reconnected.reconnectCount, 1); assert.equal(group("web-reconnect-continuity").length, 4);
  pass("SSE disconnect after Write and Last-Event-ID replay preserve task time/identity and do not rerun model or file tools");
  await cliCase("cli-long-context"); await webCase("web-long-context");
  for (const id of ["cli-long-context", "web-long-context"]) { assert.equal(group(id).filter(value => value.summary).length, 1); assert.equal(group(id).filter(value => !value.summary).length, 4); assert.equal(await fs.readFile(path.join(workspace, id + ".txt"), "utf8"), "PERSISTED_INVARIANT_42"); }
  pass("80K-character Read result triggers exactly one automatic summary and completes the remaining tools with preserved invariant in CLI and Web");
  await stop(web!); restoredStartupMs = await startWeb(address.port);
  await request("/api/account/login", { email: account.users[0]!.email, password: account.password });
  const restored = await request(`/api/sessions/${webTools.id}`);
  assert.equal(restored.busy, false); assert.match(JSON.stringify(restored.messages), /FINISHED:web-tools-continuity/); assert.match(JSON.stringify(restored.messages), /SHARED_RUNTIME_EVIDENCE/);
  await webCase("web-followup-restored", webTools.id);
  assert.equal(group("web-followup-restored").length, 1);
  pass("restarting the isolated compiled Web process restores the persisted conversation and continues with original tool evidence intact");
  assert.deepEqual(fixtureErrors, []);
  const report = { generatedAt: new Date().toISOString(), binarySha256: binaryHash, checks, repeats, startupMs, restoredStartupMs, environment: { platform: process.platform, architecture: process.arch, node: process.version, cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length, freeMemoryGiB: Math.round(os.freemem() / 2 ** 30 * 10) / 10 }, methods: { cli: "new compiled process per sample, from spawn through stdout result/process close; NDJSON emits whole assistant messages", web: "one compiled warmed server; from message POST initiation through SSE turn_complete; first text is incremental", provider: "loopback synthetic SSE: 20ms initial delay, 15ms per 7 characters; same configured model/context/permissions/account/workspace", limitations: "No supplier latency/billing, browser rendering or production network measured. Sequential samples share machine load. Cold CLI and warmed Web are labeled separately and are not equivalent startup conditions." }, metrics, requestSummary: captures.map(({ caseId, summary, requestBytes }) => ({ caseId, summary, requestBytes })) };
  const reportPath = path.join(repository, "output/checks", reportArgument); await fs.mkdir(path.dirname(reportPath), { recursive: true }); await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ checks, repeats, startupMs, binarySha256: binaryHash, metrics, report: path.relative(repository, reportPath) }, null, 2));
} finally {
  await Promise.allSettled(feeds.map(value => value.close())); await Promise.allSettled(children.map(stop)); supplier.closeAllConnections(); await new Promise<void>(resolve => supplier.close(() => resolve())); await account.close();
  const relative = path.relative(parent, temporary); assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative) && path.basename(temporary).startsWith("ccagent-runtime-parity-")); await fs.rm(temporary, { recursive: true, force: true });
}
