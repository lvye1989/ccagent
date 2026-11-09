/** Real Web/QueryEngine tool and child-Agent execution; all models/accounts are isolated loopback fixtures. */
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
const temporary = await fs.realpath(await fs.mkdtemp(path.join(parent, "ccagent-tool-agent-")));
const workspace = path.join(temporary, "workspace"), desktop = path.join(temporary, "Desktop"), base = path.join(temporary, "profile");
await fs.mkdir(workspace); await fs.mkdir(desktop);
await fs.writeFile(path.join(workspace, "agent-input.txt"), "CHILD_READ_EVIDENCE\n");
const account = await startAccountFixture(base);
const requests: Array<{ user: string; calls: string[]; results: string[]; offered: string[] }> = [];
const supplierErrors: string[] = [];
const profileId = "tool-agent-fixture";
const quote = (value: string) => "'" + value.replaceAll("'", "''") + "'";
const sourceDocx = path.join(workspace, "工具测试.docx"), desktopDocx = path.join(desktop, "工具测试.docx");
const failedDocx = path.join(workspace, "continued-after-error.docx");
const supplier = createServer(async (request, response) => {
  try {
    assert.equal(new URL(request.url ?? "/", "http://127.0.0.1").pathname, "/v1/chat/completions");
    let raw = ""; for await (const value of request) { raw += value; assert.ok(raw.length < 5 * 1024 * 1024); }
    const body = JSON.parse(raw), messages = body.messages as Array<Record<string, any>>;
    assert.equal(body.model, profileId); assert.equal(body.stream, true);
    let lastUserIndex = messages.length - 1;
    while (lastUserIndex >= 0 && messages[lastUserIndex]!.role !== "user") lastUserIndex--;
    const user = String(messages[lastUserIndex]?.content ?? ""), after = messages.slice(lastUserIndex + 1);
    const calls = after.flatMap(message => message.tool_calls ?? []).map(call => String(call.function.name));
    const results = after.filter(message => message.role === "tool").map(message => String(message.content));
    const offered = (body.tools ?? []).map((tool: any) => String(tool.function.name));
    requests.push({ user, calls, results, offered });
    let name = "", input: Record<string, unknown> = {}, text = "";
    if (user.includes("RUN_TOOL_AGENT_SUCCESS")) {
      if (!calls.includes("WorkfriendDeliver")) {
        name = "WorkfriendDeliver"; input = { format: "word", title: "真实工具与 Agent 测试", content: "# 执行记录\nWord 文档由本地工具生成。\n中文与符号 < & > 可编辑。", output_path: sourceDocx };
      } else if (!calls.includes("PowerShell")) {
        assert.match(results.join("\n"), /Word document created/);
        name = "PowerShell"; input = { command: `Copy-Item -LiteralPath ${quote(sourceDocx)} -Destination ${quote(desktopDocx)} -ErrorAction Stop; Write-Output 'DESKTOP_COPY_OK'` };
      } else if (!calls.includes("Agent")) {
        assert.match(results.join("\n"), /DESKTOP_COPY_OK/);
        name = "Agent"; input = { subagent_type: "general-purpose", description: "检查交付证据", prompt: "CHILD_AGENT_SUCCESS 读取 agent-input.txt，写入 agent-output.txt，返回检查结论。" };
      } else { assert.match(results.join("\n"), /CHILD_AGENT_FINISHED/); text = "ALL_TOOL_AGENT_FINISHED"; }
    } else if (user.includes("CHILD_AGENT_SUCCESS")) {
      assert.ok(!offered.includes("Agent"), "Child Agent must not recursively delegate through its tools");
      if (!calls.includes("Read")) { name = "Read"; input = { file_path: "agent-input.txt" }; }
      else if (!calls.includes("Write")) { assert.match(results.join("\n"), /CHILD_READ_EVIDENCE/); name = "Write"; input = { file_path: "agent-output.txt", content: "CHILD_WRITE_EVIDENCE 已读取并验证。\n" }; }
      else { assert.match(results.join("\n"), /agent-output\.txt/); text = "CHILD_AGENT_FINISHED"; }
    } else if (user.includes("FAIL_AFTER_WORD")) {
      if (!calls.includes("WorkfriendDeliver")) { name = "WorkfriendDeliver"; input = { format: "word", title: "Preserved output", content: "PRESERVED_WORD_EVIDENCE", output_path: failedDocx }; }
      else { assert.match(results.join("\n"), /Word document created/); response.writeHead(400, { "content-type": "application/json" }); response.end(JSON.stringify({ error: { message: "Synthetic continuation rejected", type: "invalid_request_error" } })); return; }
    } else if (user.includes("EXPLICIT_RECOVERY")) {
      assert.ok(!calls.length, "Explicit continuation starts without replaying earlier tools"); text = "EXPLICIT_RECOVERY_FINISHED";
    } else if (user.includes("RUN_FAILED_CHILD")) {
      if (!calls.includes("Agent")) { name = "Agent"; input = { subagent_type: "general-purpose", description: "测试子任务失败边界", prompt: "CHILD_AGENT_FAILURE_ONLY" }; }
      else { assert.match(results.join("\n"), /failed/i); text = "PARENT_OBSERVED_CHILD_FAILURE"; }
    } else if (user.includes("CHILD_AGENT_FAILURE_ONLY")) {
      response.writeHead(400, { "content-type": "application/json" }); response.end(JSON.stringify({ error: { message: "Synthetic child model failure", type: "invalid_request_error" } })); return;
    } else if (user.includes("RUN_DENIED_OUTPUT")) {
      if (!calls.includes("WorkfriendDeliver")) { name = "WorkfriendDeliver"; input = { format: "word", content: "must stay blocked", output_path: path.join(temporary, "outside-allowed-roots.docx") }; }
      else { assert.match(results.join("\n"), /outside the allowed roots/); text = "PARENT_OBSERVED_TOOL_FAILURE"; }
    } else if (user.includes("RUN_POWERSHELL_FAILURE")) {
      if (!calls.includes("PowerShell")) { name = "PowerShell"; input = { command: "throw 'SYNTHETIC_POWERSHELL_FAILURE'" }; }
      else { assert.match(results.join("\n"), /Exit code: 1/); text = "PARENT_OBSERVED_POWERSHELL_FAILURE"; }
    } else throw new Error("Unknown fixture prompt");
    if (name) assert.ok(offered.includes(name), "Real engine must offer requested tool " + name);
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
    const delta = name ? { tool_calls: [{ index: 0, id: `fixture-tool-${requests.length}`, type: "function", function: { name, arguments: JSON.stringify(input) } }] } : { content: text };
    response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: name ? "tool_calls" : "stop" }], usage: { prompt_tokens: 40, completion_tokens: 12 } })}\n\ndata: [DONE]\n\n`);
  } catch (error) {
    supplierErrors.push(error instanceof Error ? error.message : String(error));
    if (!response.headersSent) response.writeHead(500); response.end("Synthetic fixture assertion failed");
  }
});
await new Promise<void>(resolve => supplier.listen(0, "127.0.0.1", resolve));
const supplierAddress = supplier.address(); assert.ok(supplierAddress && typeof supplierAddress !== "string");
const home = accountHome(base, account.users[0]!.id); await fs.mkdir(home, { recursive: true });
await fs.writeFile(path.join(home, "settings.json"), JSON.stringify({ defaultModel: profileId, model: profileId,
  models: { [profileId]: { protocol: "openai-chat", model: profileId, baseURL: `http://127.0.0.1:${supplierAddress.port}/v1`, apiKey: "fixture-only" } },
  additionalDirectories: [desktop], mcpServers: {}, disableAllHooks: true, agentTeams: false,
}));
const emptyEnv = path.join(temporary, "empty.env"); await fs.writeFile(emptyEnv, "");
const reservation = createServer(); await new Promise<void>(resolve => reservation.listen(0, "127.0.0.1", resolve));
const address = reservation.address(); assert.ok(address && typeof address !== "string"); const port = address.port;
await new Promise<void>(resolve => reservation.close(() => resolve()));
const origin = `http://127.0.0.1:${port}`;
const environment: NodeJS.ProcessEnv = { ...process.env, CCAGENT_HOME: base, CCAGENT_PLATFORM_HOME: base, CCAGENT_ENV_FILE: emptyEnv, CCAGENT_DISABLE_STREAM_LOG: "1" };
for (const key of Object.keys(environment)) if (/API.?KEY|SECRET|TOKEN/i.test(key) || /^(ANTHROPIC|OPENAI|QWEN|DASHSCOPE|OLLAMA|GEMINI)_/i.test(key) || ["CCAGENT_ACCOUNT_ID", "CCAGENT_AUTH_SESSION_FILE", "CCAGENT_DESKTOP_APP", "NODE_TLS_REJECT_UNAUTHORIZED"].includes(key)) delete environment[key];
const child: ChildProcess = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), path.join(repository, "src/entrypoint/cli.ts"), "web", "--workspace", workspace, "--port", String(port)], {
  cwd: temporary, env: environment, windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"],
});
let logs = "", passed = 0;
child.stdout!.on("data", bytes => { logs = (logs + String(bytes)).slice(-12000); }); child.stderr!.on("data", bytes => { logs = (logs + String(bytes)).slice(-12000); });
const pause = (ms = 80) => new Promise(resolve => setTimeout(resolve, ms));
const test = async (name: string, action: () => Promise<void>) => { await action(); passed++; console.log("PASS " + name); };
async function request(route: string, cookie = "", body?: Record<string, unknown>) {
  return fetch(origin + route, { method: body ? "POST" : "GET", headers: { ...(cookie ? { cookie } : {}), ...(body ? { "content-type": "application/json", "x-ccagent-web": "1", origin } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20000) });
}
async function json(response: Response, status = 200): Promise<any> { assert.equal(response.status, status, await response.clone().text()); return response.json(); }
async function login(index: number) { const response = await request("/api/account/login", "", { email: account.users[index]!.email, password: account.password }); await json(response); return response.headers.get("set-cookie")!.split(";")[0]!; }
async function session(cookie: string) { return json(await request("/api/sessions", cookie, { mode: "default", model: profileId, team: "off" }), 201); }
async function run(id: string, cookie: string, text: string) {
  await json(await request(`/api/sessions/${id}/messages`, cookie, { text }), 202);
  for (let index = 0; index < 400; index++) {
    const state = await json(await request(`/api/sessions/${id}`, cookie));
    if (state.pending) await json(await request(`/api/sessions/${id}/respond`, cookie, { id: state.pending.id, decision: "allow_once" }));
    if (!state.busy && state.execution?.completedAt) return state;
    await pause();
  }
  throw new Error("Actual Web tool/Agent turn did not terminate; " + logs);
}
function docxDocument(bytes: Buffer) {
  let offset = 0; const entries = new Map<string, Buffer>();
  while (bytes.readUInt32LE(offset) === 0x04034b50) {
    assert.equal(bytes.readUInt16LE(offset + 8), 0, "Dependency-free DOCX uses STORE ZIP entries");
    const size = bytes.readUInt32LE(offset + 18), nameLength = bytes.readUInt16LE(offset + 26), extraLength = bytes.readUInt16LE(offset + 28);
    const name = bytes.toString("utf8", offset + 30, offset + 30 + nameLength), start = offset + 30 + nameLength + extraLength;
    assert.ok(start + size <= bytes.length); entries.set(name, bytes.subarray(start, start + size)); offset = start + size;
  }
  for (const name of ["[Content_Types].xml", "_rels/.rels", "word/document.xml", "word/styles.xml", "word/_rels/document.xml.rels"]) assert.ok(entries.has(name), "DOCX has required entry " + name);
  assert.equal(bytes.readUInt32LE(bytes.length - 22), 0x06054b50); assert.equal(bytes.readUInt16LE(bytes.length - 12), entries.size);
  return entries.get("word/document.xml")!.toString("utf8");
}
try {
  let ready = false;
  for (let index = 0; index < 150; index++) {
    if (child.exitCode !== null) throw new Error(logs);
    try { if ((await fetch(origin + "/api/health", { signal: AbortSignal.timeout(500) })).ok) { ready = true; break; } } catch { /* Own source-mode supervisor startup. */ }
    await pause(100);
  }
  assert.ok(ready, logs); const owner = await login(0);
  await test("actual Web tool→model→PowerShell→child Agent chain creates Word and verifies real filesystem outputs", async () => {
    const created = await session(owner), state = await run(created.sessionId, owner, "RUN_TOOL_AGENT_SUCCESS 请生成 Word 文档、复制至允许的桌面目录并交由 Agent 检查。");
    assert.equal(state.lastTurnReason, "completed"); assert.match(JSON.stringify(state.messages), /ALL_TOOL_AGENT_FINISHED/);
    assert.deepEqual(state.execution.tools.map((tool: any) => tool.name), ["WorkfriendDeliver", "PowerShell", "Agent"]);
    assert.ok(state.execution.tools.every((tool: any) => tool.completedAt && !tool.isError));
    const bytes = await fs.readFile(sourceDocx); assert.deepEqual(await fs.readFile(desktopDocx), bytes);
    assert.match(docxDocument(bytes), /真实工具与 Agent 测试/); assert.match(docxDocument(bytes), /&lt; &amp; &gt;/);
    assert.match(await fs.readFile(path.join(workspace, "agent-output.txt"), "utf8"), /CHILD_WRITE_EVIDENCE/);
    const childRequests = requests.filter(item => item.user.includes("CHILD_AGENT_SUCCESS")); assert.equal(childRequests.length, 3); assert.ok(childRequests[2]!.results.some(result => result.includes("agent-output.txt")));
  });
  await test("model continuation failure preserves completed Word tool, its output and truthful execution state without tool replay", async () => {
    const created = await session(owner), state = await run(created.sessionId, owner, "FAIL_AFTER_WORD");
    assert.equal(state.lastTurnReason, "model_error"); assert.equal(state.busy, false);
    assert.equal(state.execution.reason, "model_error"); assert.equal(state.execution.tools.length, 1);
    assert.equal(state.execution.tools[0].name, "WorkfriendDeliver"); assert.equal(state.execution.tools[0].isError, false); assert.ok(state.execution.tools[0].completedAt);
    assert.match(docxDocument(await fs.readFile(failedDocx)), /PRESERVED_WORD_EVIDENCE/);
    const before = requests.length, fileState = await fs.stat(failedDocx); await pause(250);
    assert.equal(requests.length, before, "No automatic generation/tool retry after a completed failure");
    const recovered = await run(created.sessionId, owner, "EXPLICIT_RECOVERY"); assert.equal(recovered.lastTurnReason, "completed"); assert.match(JSON.stringify(recovered.messages), /EXPLICIT_RECOVERY_FINISHED/);
    assert.equal((await fs.stat(failedDocx)).mtimeMs, fileState.mtimeMs, "Explicit continuation must not rewrite the earlier Word output");
    assert.equal(requests.filter(item => item.user.includes("FAIL_AFTER_WORD")).length, 2);
  });
  await test("a failed child model surfaces an errored Agent tool while the parent can inspect and finish", async () => {
    const created = await session(owner), state = await run(created.sessionId, owner, "RUN_FAILED_CHILD");
    assert.equal(state.lastTurnReason, "completed"); assert.match(JSON.stringify(state.messages), /PARENT_OBSERVED_CHILD_FAILURE/);
    assert.equal(state.execution.tools.length, 1); assert.equal(state.execution.tools[0].name, "Agent"); assert.equal(state.execution.tools[0].isError, true); assert.ok(state.execution.tools[0].completedAt);
  });
  await test("out-of-scope Word output remains denied and records a failed tool without creating the file", async () => {
    const created = await session(owner), state = await run(created.sessionId, owner, "RUN_DENIED_OUTPUT");
    assert.equal(state.lastTurnReason, "completed"); assert.match(JSON.stringify(state.messages), /PARENT_OBSERVED_TOOL_FAILURE/);
    assert.equal(state.execution.tools[0].isError, true); assert.equal(await fs.stat(path.join(temporary, "outside-allowed-roots.docx")).then(() => true, () => false), false);
  });
  if (process.platform === "win32") await test("a real PowerShell failure records a failed tool and returns its exit code to the model", async () => {
    const created = await session(owner), state = await run(created.sessionId, owner, "RUN_POWERSHELL_FAILURE");
    assert.equal(state.lastTurnReason, "completed"); assert.match(JSON.stringify(state.messages), /PARENT_OBSERVED_POWERSHELL_FAILURE/);
    assert.equal(state.execution.tools[0].isError, true); assert.ok(state.execution.tools[0].completedAt);
  });
  await test("a different authenticated account cannot read the first account's tool/Agent session", async () => {
    const created = await session(owner), other = await login(1); assert.equal((await request(`/api/sessions/${created.sessionId}`, other)).status, 404); assert.deepEqual(supplierErrors, []);
  });
  console.log(`Tool/Agent recovery: ${passed} checks passed; actual source-mode Web/QueryEngine, PowerShell, DOCX and child Agent; no production suppliers or charges.`);
} finally {
  if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise<void>(resolve => child.once("close", () => resolve())); if (child.connected) child.send("ccagent:shutdown", () => {});
    const deadline = setTimeout(() => { if (process.platform === "win32" && child.pid) { try { execFileSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); } catch { child.kill(); } } else child.kill(); }, 5000);
    await exited; clearTimeout(deadline);
  }
  supplier.closeAllConnections(); await new Promise<void>(resolve => supplier.close(() => resolve())); await account.close();
  const relative = path.relative(parent, temporary); assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative) && path.basename(temporary).startsWith("ccagent-tool-agent-"));
  await fs.rm(temporary, { recursive: true, force: true });
}
