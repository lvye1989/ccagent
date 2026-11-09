/** Real Web account worker and shared CLI engine, backed only by an isolated loopback Ollama fixture. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { accountHome } from "../platform/account.js";
import { startAccountFixture } from "./helpers/accountFixture.js";

const repository = path.resolve(import.meta.dirname, "../..");
const parent = await fs.realpath(os.tmpdir());
const temporary = await fs.realpath(await fs.mkdtemp(path.join(parent, "ccagent-ollama-http-")));
const workspace = path.join(temporary, "workspace"), base = path.join(temporary, "profile");
await fs.mkdir(workspace);
await fs.writeFile(path.join(workspace, "ollama-evidence.txt"), "OLLAMA_FILE_EVIDENCE\n");
const account = await startAccountFixture(base);
await account.nativeClient.signIn(account.users[0]!.email, account.password);
const model = "qwen3:8b-q4_K_M", profileId = "local-ollama";
const staleKey = "fixture-stale-key-must-not-reach-ollama", staleHeader = "fixture-stale-header-must-not-reach-ollama";
const supplierBody = "SUPPLIER_PRIVATE_ERROR_MUST_NOT_REACH_UI";
const requests: Record<string, any>[] = [], supplierErrors: string[] = [], tagPaths: string[] = [];
const supplier = createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    assert.equal(req.headers.authorization, undefined, "Local Ollama must not inherit an old API key");
    assert.equal(req.headers["x-legacy-key"], undefined, "Local Ollama must not inherit old custom headers");
    if (pathname.endsWith("/api/tags")) {
      assert.equal(req.method, "GET"); tagPaths.push(pathname);
      if (pathname.startsWith("/malformed/")) { res.writeHead(200, { "content-type": "application/json" }); res.end(supplierBody); return; }
      if (pathname.startsWith("/denied/")) { res.writeHead(503, { "content-type": "application/json" }); res.end(JSON.stringify({ error: supplierBody })); return; }
      if (pathname.startsWith("/redirect/")) { res.writeHead(302, { location: "/ollama/api/tags" }); res.end(); return; }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ models: pathname.startsWith("/empty/") ? [] : [
        { name: model, model, size: 5_232_254_432, modified_at: "2026-01-01T00:00:00Z", details: { family: "qwen3", parameter_size: "8B", quantization_level: "Q4_K_M" } },
        { name: "gemma3:4b", size: 3_333_333_333 },
      ] })); return;
    }
    assert.equal(pathname, "/ollama/v1/chat/completions"); assert.equal(req.method, "POST");
    let input = ""; for await (const value of req) { input += value; assert.ok(input.length < 2 * 1024 * 1024); }
    const body = JSON.parse(input); assert.equal(body.model, model); assert.equal(body.stream, true); requests.push(body);
    const history = JSON.stringify(body.messages ?? []);
    if (history.includes("RUN_OLLAMA_WEB_TOOL") || history.includes("RUN_OLLAMA_CLI")) {
      assert.equal(body.reasoning_effort, undefined, "Global max effort must not force unsupported minimal/xhigh thinking levels onto Ollama");
    } else {
      assert.equal(body.reasoning_effort, "none", "The explicit non-thinking connection test must disable Ollama thinking rather than send minimal");
    }
    const hasReadResult = body.messages?.some((message: any) => message.role === "tool" && JSON.stringify(message.content).includes("OLLAMA_FILE_EVIDENCE"));
    const tool = history.includes("RUN_OLLAMA_WEB_TOOL") && !hasReadResult;
    if (tool) assert.ok(body.tools?.some((item: any) => item.function?.name === "Read"), "Normal app conversations expose shared engine tools to the local model");
    const content = history.includes("RUN_OLLAMA_CLI") ? "OLLAMA_CLI_FINISHED" : hasReadResult ? "OLLAMA_WEB_READ_FINISHED OLLAMA_FILE_EVIDENCE" : "OK";
    const delta = tool
      ? { tool_calls: [{ index: 0, id: "ollama-read-call", type: "function", function: { name: "Read", arguments: JSON.stringify({ file_path: "ollama-evidence.txt" }) } }] }
      : { content };
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }], usage: { prompt_tokens: 30, completion_tokens: 10 } })}\n\ndata: [DONE]\n\n`);
  } catch (error) {
    supplierErrors.push(error instanceof Error ? error.message : "loopback fixture error");
    if (!res.headersSent) res.writeHead(500); res.end("fixture failed");
  }
});
await new Promise<void>(resolve => supplier.listen(0, "127.0.0.1", resolve));
const supplierAddress = supplier.address(); assert.ok(supplierAddress && typeof supplierAddress !== "string");
const supplierOrigin = `http://127.0.0.1:${supplierAddress.port}`, ollamaRoot = supplierOrigin + "/ollama";
const home = accountHome(base, account.users[0]!.id); await fs.mkdir(home, { recursive: true });
await fs.writeFile(path.join(home, "settings.json"), JSON.stringify({
  sentinel: "preserve-existing-settings", defaultModel: profileId, model: profileId,
  models: { [profileId]: { protocol: "openai-chat", model: "previous-model", baseURL: ollamaRoot + "/v1", apiKey: staleKey, headers: { "x-legacy-key": staleHeader } } },
  mcpServers: {}, disableAllHooks: true, agentTeams: false, alwaysThinkingEnabled: true, effortLevel: "max",
}));
const emptyEnv = path.join(temporary, "empty.env"); await fs.writeFile(emptyEnv, "");
const probe = createServer(); await new Promise<void>(resolve => probe.listen(0, "127.0.0.1", resolve));
const probeAddress = probe.address(); assert.ok(probeAddress && typeof probeAddress !== "string");
const port = probeAddress.port, origin = `http://127.0.0.1:${port}`; await new Promise<void>(resolve => probe.close(() => resolve()));
const environment: NodeJS.ProcessEnv = { ...process.env, CCAGENT_HOME: base, CCAGENT_PLATFORM_HOME: base, CCAGENT_ENV_FILE: emptyEnv, CCAGENT_DISABLE_STREAM_LOG: "1" };
for (const name of Object.keys(environment)) {
  if (/API.?KEY|SECRET|TOKEN/i.test(name) || /^(?:ANTHROPIC|OPENAI|QWEN|DASHSCOPE|OLLAMA|GEMINI)_/i.test(name) || ["CCAGENT_ACCOUNT_ID", "CCAGENT_AUTH_SESSION_FILE", "CCAGENT_DESKTOP_APP", "NODE_TLS_REJECT_UNAUTHORIZED"].includes(name)) delete environment[name];
}
const sourceArguments = ["--import", import.meta.resolve("tsx"), path.join(repository, "src/entrypoint/cli.ts")];
const child: ChildProcess = spawn(process.execPath, [...sourceArguments, "web", "--workspace", workspace, "--port", String(port)], {
  cwd: temporary, env: environment, windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"],
});
let logs = "", passed = 0;
child.stdout!.on("data", bytes => { logs = (logs + String(bytes)).slice(-8000); });
child.stderr!.on("data", bytes => { logs = (logs + String(bytes)).slice(-8000); });
const pause = (ms = 60) => new Promise(resolve => setTimeout(resolve, ms));
const test = async (name: string, action: () => Promise<void>) => { await action(); passed++; console.log("PASS " + name); };
async function request(route: string, cookie = "", body?: Record<string, unknown>) {
  return fetch(origin + route, {
    method: body ? "POST" : "GET", headers: { ...(cookie ? { cookie } : {}), ...(body ? { "content-type": "application/json", "x-ccagent-web": "1", origin } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20_000),
  });
}
async function json(response: Response, status = 200): Promise<any> { assert.equal(response.status, status, await response.clone().text()); return response.json(); }
async function login(index: number) {
  const response = await request("/api/account/login", "", { email: account.users[index]!.email, password: account.password }); await json(response);
  return response.headers.get("set-cookie")!.split(";")[0]!;
}
try {
  let ready = false;
  for (let index = 0; index < 150; index++) {
    if (child.exitCode !== null) throw new Error(logs);
    try { if ((await fetch(origin + "/api/health", { signal: AbortSignal.timeout(500) })).ok) { ready = true; break; } } catch { /* Own isolated server startup. */ }
    await pause(100);
  }
  assert.ok(ready, logs); const cookie = await login(0);
  await test("Ollama discovery retains real login and CSRF protection", async () => {
    assert.equal((await request("/api/customize/ollama-models", "", { baseURL: ollamaRoot })).status, 401);
    const blocked = await fetch(origin + "/api/customize/ollama-models", { method: "POST", headers: { cookie, origin, "content-type": "application/json" }, body: JSON.stringify({ baseURL: ollamaRoot }) });
    assert.equal(blocked.status, 403); assert.equal(tagPaths.length, 0);
  });
  await test("discovery uses native /api/tags under a proxy prefix and preserves actual installed model tags", async () => {
    const found = await json(await request("/api/customize/ollama-models", cookie, { baseURL: ollamaRoot + "/v1/" }));
    assert.equal(found.baseURL, ollamaRoot + "/v1"); assert.equal(found.truncated, false);
    assert.ok(found.models.some((item: any) => item.name === model)); assert.equal(found.models.length, 2);
    assert.equal(found.models.find((item: any) => item.name === model).parameterSize, "8B");
    assert.deepEqual(tagPaths, ["/ollama/api/tags"]); assert.equal(requests.length, 0, "Discovery never runs inference");
  });
  await test("empty lists remain valid; malformed responses, redirects and credential URLs fail without leaking upstream text", async () => {
    const empty = await json(await request("/api/customize/ollama-models", cookie, { baseURL: supplierOrigin + "/empty" })); assert.deepEqual(empty.models, []);
    for (const suffix of ["malformed", "denied", "redirect"]) {
      const failure = await json(await request("/api/customize/ollama-models", cookie, { baseURL: supplierOrigin + "/" + suffix }), 400);
      assert.equal(typeof failure.error, "string"); assert.ok(failure.error.length > 0); assert.equal(JSON.stringify(failure).includes(supplierBody), false);
    }
    assert.equal(tagPaths.filter(item => item === "/ollama/api/tags").length, 1, "Discovery must not follow HTTP redirects");
    const count = tagPaths.length;
    for (const baseURL of ["ftp://127.0.0.1:11434", "http://user:fixture-password@127.0.0.1:11434", ollamaRoot + "?api_key=fixture-query-key"]) {
      assert.equal((await request("/api/customize/ollama-models", cookie, { baseURL })).status, 400);
    }
    assert.equal(tagPaths.length, count, "Invalid endpoints fail before network access");
  });
  await test("saving a keyless local model clears stale credentials and preserves other settings", async () => {
    const payload = { id: profileId, provider: "ollama", protocol: "openai-chat", model, baseURL: ollamaRoot, apiKey: "", makeDefault: true };
    assert.equal((await request("/api/customize/models", cookie, { ...payload, apiKey: "unexpected-local-key" })).status, 400);
    await json(await request("/api/customize/models", cookie, payload));
    const disk = JSON.parse(await fs.readFile(path.join(home, "settings.json"), "utf8"));
    assert.equal(disk.sentinel, "preserve-existing-settings"); assert.equal(disk.defaultModel, profileId); assert.equal(disk.models[profileId].model, model);
    assert.equal(disk.models[profileId].provider, "ollama"); assert.equal(disk.models[profileId].baseURL, ollamaRoot + "/v1");
    assert.equal(Boolean(disk.models[profileId].apiKey), false); assert.equal(Boolean(disk.models[profileId].headers), false);
    assert.equal(JSON.stringify(disk).includes(staleKey), false); assert.equal(JSON.stringify(disk).includes(staleHeader), false);
    const view = await json(await request("/api/customize/models", cookie)); const local = view.models.find((item: any) => item.id === profileId);
    assert.equal(view.defaultModel, profileId); assert.equal(local.provider, "ollama"); assert.equal(local.localModel, true); assert.equal(local.hasKey, false); assert.equal(local.editable, true);
    assert.equal((await json(await request("/api/models", cookie))).models.find((item: any) => item.id === profileId).available, true);
  });
  await test("the existing connection test streams without auth and explicitly disables thinking even with global max effort", async () => {
    const result = await json(await request("/api/customize/model-test", cookie, { id: profileId })); assert.equal(result.ok, true); assert.equal(result.reply, "OK");
    assert.equal(requests.length, 1); assert.equal(requests[0]!.model, model); assert.equal(requests[0]!.reasoning_effort, "none");
  });
  await test("a normal application conversation calls a real shared Read tool and sends the tool result back to Ollama", async () => {
    const created = await json(await request("/api/sessions", cookie, { mode: "full", team: "off" }), 201);
    assert.equal(created.model, profileId);
    await json(await request(`/api/sessions/${created.sessionId}/messages`, cookie, { text: "RUN_OLLAMA_WEB_TOOL 请读取 ollama-evidence.txt 并确认内容。" }), 202);
    let finished = false;
    for (let index = 0; index < 200; index++) {
      const session = await json(await request(`/api/sessions/${created.sessionId}`, cookie));
      if (session.pending) await json(await request(`/api/sessions/${created.sessionId}/respond`, cookie, { id: session.pending.id, decision: "allow_once" }));
      if (!session.busy && JSON.stringify(session.messages).includes("OLLAMA_WEB_READ_FINISHED OLLAMA_FILE_EVIDENCE")) { finished = true; break; }
      await pause(75);
    }
    assert.ok(finished, "Normal conversation must complete after the actual file tool result");
    const actual = requests.filter(item => JSON.stringify(item.messages).includes("RUN_OLLAMA_WEB_TOOL"));
    assert.equal(actual.length, 2); assert.ok(actual[0]!.tools.some((item: any) => item.function?.name === "Read"));
    assert.ok(actual.every(item => item.reasoning_effort === undefined), "Normal tool turns retain Ollama's model default rather than inherit global max effort");
    assert.ok(actual[1]!.messages.some((item: any) => item.role === "tool" && JSON.stringify(item.content).includes("OLLAMA_FILE_EVIDENCE")));
  });
  await test("CLI reads the Web-saved default profile and reaches the same local model without a second configuration", async () => {
    const cli = spawn(process.execPath, [...sourceArguments, "-p", "RUN_OLLAMA_CLI"], { cwd: workspace, env: environment, windowsHide: true, timeout: 25_000, stdio: ["ignore", "pipe", "pipe"] });
    let output = "", errorOutput = ""; cli.stdout!.on("data", bytes => { output += bytes; }); cli.stderr!.on("data", bytes => { errorOutput += bytes; });
    await new Promise<void>((resolve, reject) => { cli.once("error", reject); cli.once("close", code => code === 0 ? resolve() : reject(new Error(errorOutput || "Source CLI failed"))); });
    assert.match(output, /OLLAMA_CLI_FINISHED/);
    const cliRequest = requests.find(item => item.model === model && JSON.stringify(item.messages).includes("RUN_OLLAMA_CLI"));
    assert.ok(cliRequest); assert.equal(cliRequest.reasoning_effort, undefined, "CLI must also avoid forcing global max effort onto Ollama");
  });
  await test("a different real account cannot see this account's saved local profile", async () => {
    const otherCookie = await login(1), view = await json(await request("/api/customize/models", otherCookie));
    assert.equal(view.models.some((item: any) => item.id === profileId), false); assert.deepEqual(supplierErrors, []);
  });
  console.log(`Ollama HTTP: ${passed} checks passed with real account workers, streaming, tools and CLI; no installation, pull or production model calls.`);
} finally {
  if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise<void>(resolve => child.once("close", () => resolve()));
    if (child.connected) child.send("ccagent:shutdown", () => {});
    const deadline = setTimeout(() => {
      if (process.platform === "win32" && child.pid) { try { execFileSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); } catch { child.kill(); } }
      else child.kill();
    }, 5000);
    await exited; clearTimeout(deadline);
  }
  supplier.closeAllConnections(); await new Promise<void>(resolve => supplier.close(() => resolve())); await account.close();
  const relative = path.relative(parent, temporary);
  assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative) && path.basename(temporary).startsWith("ccagent-ollama-http-"));
  await fs.rm(temporary, { recursive: true, force: true });
}
