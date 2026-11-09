/** Real CLI/Web entrypoint parity. All authentication, models, Jev and MCP are isolated local fixtures. */
import assert from "node:assert/strict";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { accountHome } from "../platform/account.js";
import { startAccountFixture } from "./helpers/accountFixture.js";

type Mode = "default" | "auto" | "plan" | "full";
type ApiTool = { type: string; function: { name: string; description?: string; parameters: unknown } };
type ModelCapture = { caseId: string; tools: ApiTool[]; results: string[] };
type Policy = { name: string; decision_policy: string };
const repository = path.resolve(import.meta.dirname, "../..");
const tempParent = await fs.realpath(os.tmpdir());
const temporary = await fs.realpath(await fs.mkdtemp(path.join(tempParent, "ccagent-cli-web-parity-")));
const workspace = path.join(temporary, "workspace"), platformBase = path.join(temporary, "profile");
await fs.mkdir(workspace);
await fs.writeFile(path.join(workspace, "evidence.txt"), "SHARED_READ_EVIDENCE\n");
const account = await startAccountFixture(platformBase);
const home = accountHome(platformBase, account.users[0]!.id);
await fs.mkdir(home, { recursive: true });
const captures: ModelCapture[] = [], policyCaptures: Array<{ caseId: string; tools: Policy[] }> = [];
const fixtureErrors: string[] = [];
let mcpCalls = 0;
const fixture = createServer(async (request, response) => {
  try {
    let raw = ""; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw) as any;
    if (request.url === "/jev") {
      const caseId = /PARITY_CASE:([a-z-]+)/.exec(JSON.stringify(body.state))?.[1];
      assert.ok(caseId, "Jev must receive the active user's intent");
      assert.equal(body.state.proposed_tool, "Write");
      assert.ok(body.state.tools_list.enabled_tools.length > 30, "Actual central gate receives full runtime registry");
      policyCaptures.push({ caseId, tools: body.state.tools_list.enabled_tools });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ model: "typesafe/jev-fixture", answers: {
        disposition: { type: "choice", choice: "allow", confidence: 0.99 },
        risk: { type: "choice", choice: "file_write", confidence: 0.99 },
        goal_aligned: { type: "noul", noul: 0.99 }, tool_match: { type: "noul", noul: 0.99 },
        irreversible: { type: "noul", noul: 0.01 }, secret_exposure: { type: "noul", noul: 0.01 },
        external_effect: { type: "noul", noul: 0.01 }, scope_change: { type: "noul", noul: 0.01 },
      } })); return;
    }
    assert.equal(request.url, "/v1/chat/completions");
    const caseId = /PARITY_CASE:([a-z-]+)/.exec(body.messages.filter((message: any) => message.role === "user").map((message: any) => JSON.stringify(message.content)).join("\n"))?.[1];
    assert.ok(caseId, "Every model turn belongs to an explicit fixture case");
    const results = body.messages.filter((message: any) => message.role === "tool").map((message: any) => String(message.content));
    captures.push({ caseId, tools: body.tools, results });
    const index = results.length;
    const tool = index === 0 ? { name: "Read", arguments: { file_path: "evidence.txt" } }
      : index === 1 ? { name: "mcp__parity-local__echo", arguments: { value: caseId } }
      : index === 2 ? { name: "Write", arguments: { file_path: caseId + ".txt", content: "SHARED_WRITE_EVIDENCE" } }
      : undefined;
    if (tool) assert.ok(body.tools.some((offered: ApiTool) => offered.function.name === tool.name), "Actual entrypoint must offer " + tool.name);
    response.writeHead(200, { "content-type": "text/event-stream" });
    const delta = tool ? { tool_calls: [{ index: 0, id: caseId + "-" + index, type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.arguments) } }] }
      : { content: "PARITY_FINISHED:" + caseId };
    response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }], usage: { prompt_tokens: 20, completion_tokens: 5 } })}\n\ndata: [DONE]\n\n`);
  } catch (error) {
    fixtureErrors.push(error instanceof Error ? error.message : String(error));
    if (!response.headersSent) response.writeHead(500);
    response.end("Local parity fixture assertion failed");
  }
});
await new Promise<void>(resolve => fixture.listen(0, "127.0.0.1", resolve));
const fixtureAddress = fixture.address(); assert.ok(fixtureAddress && typeof fixtureAddress !== "string");
const fixtureOrigin = `http://127.0.0.1:${fixtureAddress.port}`;
// Preload only redirects Jev's fixed provider endpoint. Every other non-loopback
// fetch fails locally, so this suite cannot accidentally send a supplier request.
const preload = path.join(temporary, "loopback-network-only.mjs");
await fs.writeFile(preload, `const original = globalThis.fetch; globalThis.fetch = (input, options) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (url.origin === "https://openrouter.ai" && url.pathname === "/api/alpha/decisions") return original(${JSON.stringify(fixtureOrigin + "/jev")}, options);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) throw new Error("Parity suite forbids external fetch: " + url.hostname);
  return original(input, options);
};\n`);
const mcpScript = path.join(temporary, "mcp-fixture.mjs");
const mcpReceipt = path.join(temporary, "mcp-calls.txt");
await fs.writeFile(mcpScript, `import readline from "node:readline"; import { appendFileSync } from "node:fs";
readline.createInterface({ input: process.stdin }).on("line", line => {
  const request = JSON.parse(line); if (request.id === undefined) return;
  const result = request.method === "initialize" ? { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "parity-local", version: "1" } }
    : request.method === "tools/list" ? { tools: [{ name: "echo", description: "Read-only local parity evidence", inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false }, annotations: { readOnlyHint: true } }] }
    : request.method === "tools/call" ? (appendFileSync(${JSON.stringify(mcpReceipt)}, request.params.arguments.value + "\\n"), { content: [{ type: "text", text: "SHARED_MCP_EVIDENCE:" + request.params.arguments.value }] }) : {};
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
});\n`);
await fs.writeFile(path.join(home, "settings.json"), JSON.stringify({
  model: "parity-fixture", defaultModel: "parity-fixture", disableAllHooks: true, agentTeams: true,
  allow: ["Write"], models: { "parity-fixture": { protocol: "openai-chat", model: "parity-fixture", baseURL: fixtureOrigin + "/v1", apiKey: "fixture-only" } },
  mcpServers: { "parity-local": { command: process.execPath, args: [mcpScript] } },
}));
const emptyEnv = path.join(temporary, "empty.env"); await fs.writeFile(emptyEnv, "");
const environment: NodeJS.ProcessEnv = { ...process.env };
for (const key of Object.keys(environment)) if (/API.?KEY|SECRET|TOKEN/i.test(key) || /^(CCAGENT|ANTHROPIC|OPENAI|QWEN|DASHSCOPE|OLLAMA|GEMINI|JEV)_/i.test(key) || ["NODE_OPTIONS", "NODE_TLS_REJECT_UNAUTHORIZED"].includes(key)) delete environment[key];
Object.assign(environment, { CCAGENT_HOME: platformBase, CCAGENT_PLATFORM_HOME: platformBase, CCAGENT_ENV_FILE: emptyEnv, CCAGENT_DISABLE_STREAM_LOG: "1", OPENROUTER_API_KEY: "fixture-only-key", CCAGENT_TOOL_JEV: "1", JEV_TOOL_MODE: "enforce" });
const launchArgs = ["--import", pathToFileURL(preload).href, "--import", import.meta.resolve("tsx"), path.join(repository, "src/entrypoint/cli.ts")];
const children: ChildProcess[] = [];
let web: ChildProcess | undefined, webLogs = "", origin = "", cookie = "", checks = 0;
const pause = (ms = 75) => new Promise(resolve => setTimeout(resolve, ms));
const pass = (label: string) => { checks++; console.log("PASS " + label); };
async function request(route: string, body?: object): Promise<any> {
  const response = await fetch(origin + route, { method: body ? "POST" : "GET", headers: { ...(cookie ? { cookie } : {}), ...(body ? { "content-type": "application/json", "x-ccagent-web": "1", origin } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20000) });
  assert.ok(response.ok, route + ": " + await response.clone().text());
  if (route === "/api/account/login") cookie = response.headers.get("set-cookie")!.split(";")[0]!;
  return response.json();
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>(resolve => child.once("close", () => resolve()));
  if (child.connected) child.send("ccagent:shutdown", () => {}); else child.kill();
  const deadline = setTimeout(() => {
    if (process.platform === "win32" && child.pid) { try { execFileSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); } catch { child.kill(); } }
    else child.kill();
  }, 5000);
  await exited; clearTimeout(deadline);
}
function sortedTools(tools: ApiTool[]) { return [...tools].sort((a, b) => a.function.name.localeCompare(b.function.name)); }
function caseCaptures(caseId: string) { return captures.filter(capture => capture.caseId === caseId); }
async function cliCase(mode: Mode) {
  const caseId = "cli-" + mode;
  const child = spawn(process.execPath, [...launchArgs, "--print", "PARITY_CASE:" + caseId, "--permission-mode", mode, "--output-format", "stream-json"], { cwd: workspace, env: environment, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child); let stdout = "", stderr = "";
  child.stdout!.on("data", bytes => stdout += String(bytes)); child.stderr!.on("data", bytes => stderr = (stderr + String(bytes)).slice(-8000));
  const exited = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  const timeout = setTimeout(() => child.kill(), 40000);
  try { assert.equal(await exited, 0, stderr + "\n" + stdout.slice(-1500)); } finally { clearTimeout(timeout); }
  const messages = stdout.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  const init = messages.find(message => message.type === "system" && message.subtype === "init");
  assert.ok(init); assert.equal(init.permissionMode, mode);
  assert.equal(messages.at(-1)?.is_error, false); assert.match(messages.at(-1)?.result, new RegExp("PARITY_FINISHED:" + caseId));
  return init.tools as string[];
}
async function webCase(mode: Mode) {
  const caseId = "web-" + mode;
  const created = await request("/api/sessions", { model: "parity-fixture", mode, team: "auto" });
  await request(`/api/sessions/${created.sessionId}/messages`, { text: "PARITY_CASE:" + caseId });
  for (let attempt = 0; attempt < 400; attempt++) {
    const current = await request(`/api/sessions/${created.sessionId}`);
    assert.equal(current.pending, null, "Shared allow rules should not need Web-only permission prompts");
    if (!current.busy && current.execution?.completedAt) {
      assert.equal(current.lastTurnReason, "completed");
      assert.equal(current.mode, mode);
      assert.match(JSON.stringify(current.messages), new RegExp("PARITY_FINISHED:" + caseId));
      assert.deepEqual(current.execution.tools.map((tool: any) => tool.name), ["Read", "mcp__parity-local__echo", "Write"]);
      assert.equal(current.execution.tools[2].isError, mode === "plan"); return;
    }
    await pause();
  }
  throw new Error("Actual Web parity case timed out: " + webLogs);
}
try {
  await account.nativeClient.signIn(account.users[0]!.email, account.password);
  const reservation = createServer(); await new Promise<void>(resolve => reservation.listen(0, "127.0.0.1", resolve));
  const reserved = reservation.address(); assert.ok(reserved && typeof reserved !== "string");
  origin = `http://127.0.0.1:${reserved.port}`; await new Promise<void>(resolve => reservation.close(() => resolve()));
  web = spawn(process.execPath, [...launchArgs, "web", "--workspace", workspace, "--port", String(reserved.port)], { cwd: workspace, env: environment, windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  children.push(web);
  web.stdout!.on("data", bytes => webLogs = (webLogs + String(bytes)).slice(-8000)); web.stderr!.on("data", bytes => webLogs = (webLogs + String(bytes)).slice(-8000));
  let ready = false;
  for (let attempt = 0; attempt < 150; attempt++) {
    assert.equal(web.exitCode, null, webLogs);
    try { if ((await fetch(origin + "/api/health", { signal: AbortSignal.timeout(500) })).ok) { ready = true; break; } } catch { /* Own local startup. */ }
    await pause(100);
  }
  assert.ok(ready, webLogs);
  await request("/api/account/login", { email: account.users[0]!.email, password: account.password });
  ready = false;
  for (let attempt = 0; attempt < 150; attempt++) {
    const state = await request("/api/mcp");
    if (state.servers.some((server: any) => server.name === "parity-local" && server.state === "connected" && server.tools.length === 1)) { ready = true; break; }
    await pause(100);
  }
  assert.ok(ready, "Web must finish the same MCP discovery that CLI print mode awaits");
  for (const mode of ["default", "auto", "plan", "full"] as Mode[]) {
    const announced = await cliCase(mode);
    await webCase(mode);
    const cli = caseCaptures("cli-" + mode), webRequests = caseCaptures("web-" + mode);
    assert.equal(cli.length, 4); assert.equal(webRequests.length, 4);
    const expected = sortedTools(cli[0]!.tools);
    assert.ok(expected.length > 35, "Builtins and discovered MCP must both reach the actual request");
    const names = expected.map(tool => tool.function.name);
    assert.equal(new Set(names).size, names.length, "No duplicate model-visible identities");
    assert.ok(names.includes("mcp__parity-local__echo")); assert.ok(names.includes("BrowserSearch")); assert.ok(names.includes("ReadImage")); assert.ok(names.includes("Agent"));
    assert.ok(names.includes("TeamCreate"), "Equivalent enabled team settings must preserve team tools");
    assert.equal(names.includes("EnterPlanMode"), mode !== "plan"); assert.equal(names.includes("ExitPlanMode"), mode === "plan");
    assert.deepEqual([...announced].sort(), [...names].sort(), "CLI init metadata matches its actual provider tools");
    for (const capture of [...cli, ...webRequests]) assert.deepEqual(sortedTools(capture.tools), expected, "Full schemas/descriptions match across entrypoints and follow-up calls");
    for (const group of [cli, webRequests]) {
      assert.match(group[3]!.results[0]!, /SHARED_READ_EVIDENCE/);
      if (mode === "plan") {
        assert.match(group[3]!.results[1]!, /plan mode|Plan mode|denied/i);
        assert.match(group[3]!.results[2]!, /plan mode|Plan mode|denied/i);
      } else assert.match(group[3]!.results[1]!, /SHARED_MCP_EVIDENCE/);
    }
    for (const surface of ["cli", "web"]) {
      const output = path.join(workspace, `${surface}-${mode}.txt`);
      if (mode === "plan") assert.equal(await fs.stat(output).then(() => true, () => false), false);
      else assert.equal(await fs.readFile(output, "utf8"), "SHARED_WRITE_EVIDENCE");
    }
    pass(`${mode}: identical full tool schemas, builtin/MCP dispatch and permission outcomes in real CLI/Web`);
  }
  const normalizePolicies = (tools: Policy[]) => [...tools].sort((a, b) => a.name.localeCompare(b.name));
  const cliPolicy = policyCaptures.find(capture => capture.caseId === "cli-auto");
  const webPolicy = policyCaptures.find(capture => capture.caseId === "web-auto");
  assert.ok(cliPolicy && webPolicy, "Auto Mode must actually invoke the shared Jev tool gate in both consumers");
  assert.deepEqual(normalizePolicies(webPolicy.tools), normalizePolicies(cliPolicy.tools));
  assert.equal(cliPolicy.tools.find(tool => tool.name === "Write")?.decision_policy, "generic_jev");
  assert.equal(cliPolicy.tools.find(tool => tool.name === "BrowserSearch")?.decision_policy, "specialized_jev");
  assert.equal(cliPolicy.tools.find(tool => tool.name === "EnterPlanMode")?.decision_policy, "permission_only");
  assert.equal(cliPolicy.tools.find(tool => tool.name === "mcp__parity-local__echo")?.decision_policy, "local");
  assert.deepEqual(fixtureErrors, []);
  mcpCalls = (await fs.readFile(mcpReceipt, "utf8")).trim().split(/\r?\n/).length;
  assert.equal(mcpCalls, 6, "Both entrypoints execute MCP identically in default/auto/full and deny it identically in plan mode");
  pass("Auto Mode central execution manifest carries identical decision policies for every builtin and MCP tool");
  console.log(`CLI/Web tool parity: ${checks} checks passed; actual source entrypoints, account, QueryEngine, local stdio MCP and filesystem; zero external providers or charges.`);
} finally {
  await Promise.allSettled(children.map(stop));
  fixture.closeAllConnections(); await new Promise<void>(resolve => fixture.close(() => resolve())); await account.close();
  const relative = path.relative(tempParent, temporary);
  assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative) && path.basename(temporary).startsWith("ccagent-cli-web-parity-"));
  await fs.rm(temporary, { recursive: true, force: true });
}
