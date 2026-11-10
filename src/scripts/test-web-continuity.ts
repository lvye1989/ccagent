/** Real source-mode Web/QueryEngine continuity. Account and supplier are loopback fixtures only. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer, type ServerResponse } from "node:http";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { accountHome } from "../platform/account.js";
import { startAccountFixture } from "./helpers/accountFixture.js";

const repository = path.resolve(import.meta.dirname, "../..");
const temporaryParent = await fs.realpath(os.tmpdir());
const temporary = await fs.realpath(await fs.mkdtemp(path.join(temporaryParent, "ccagent-web-continuity-")));
const workspace = path.join(temporary, "workspace"), base = path.join(temporary, "profile");
await fs.mkdir(workspace);
await fs.writeFile(path.join(workspace, "limit-input.txt"), "READ_ONLY_LIMIT_FIXTURE\n");
const account = await startAccountFixture(base), profileId = "continuity-fixture";
const requests: Array<{ user: string; history: string }> = [], supplierErrors: string[] = [];
const held = new Set<ServerResponse>();
let sequence = 0;
function reply(response: ServerResponse, text: string, tool?: { name: string; input: Record<string, unknown> }, chunks = 0, inputTokens = 100) {
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
  const emit = (delta: unknown) => response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
  for (let index = 0; index < chunks; index++) emit({ content: `gap-${index} ` });
  emit(tool ? { tool_calls: [{ index: 0, id: `continuity-${++sequence}`, type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.input) } }] } : { content: text });
  response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }], usage: { prompt_tokens: inputTokens, completion_tokens: 20 } })}\n\ndata: [DONE]\n\n`);
}
const supplier = createServer(async (request, response) => {
  try {
    assert.equal(new URL(request.url ?? "/", "http://127.0.0.1").pathname, "/v1/chat/completions");
    let raw = ""; for await (const bytes of request) { raw += bytes; assert.ok(raw.length < 4 * 1024 * 1024); }
    const body = JSON.parse(raw), messages = body.messages as Array<Record<string, any>>;
    assert.equal(body.model, profileId);
    let last = messages.length - 1; while (last >= 0 && messages[last]!.role !== "user") last--;
    const user = String(messages[last]?.content ?? ""), history = JSON.stringify(messages.filter(message => message.role !== "system"));
    requests.push({ user, history });
    const calls = messages.slice(last + 1).flatMap(message => message.tool_calls ?? []).map(call => call.function.name);
    if (user.startsWith("Conversation to summarize:")) reply(response, "COMPACT_SUMMARY_KEEP_GOAL: Continue the requested continuity checks; do not repeat completed writes.");
    else if (user === "PRETURN_AUTO_SEED") reply(response, "Earlier work finished; retain the next distinct requirement.", undefined, 0, 185000);
    else if (user === "UNIQUE_NEW_REQUIREMENT_AFTER_PRETURN_AUTO") { assert.match(history, /COMPACT_SUMMARY_KEEP_GOAL/); reply(response, "PRETURN_AUTO_NEW_REQUEST_COMPLETED"); }
    else if (user === "UNIQUE_NEW_REQUIREMENT_PRETURN_AUTO_STOP") {
      assert.match(history, /COMPACT_SUMMARY_KEEP_GOAL/);
      response.writeHead(200, { "content-type": "text/event-stream" }); response.flushHeaders(); held.add(response);
      response.on("close", () => held.delete(response));
    }
    else if (user.startsWith("SEED_HISTORY_")) reply(response, "HISTORICAL_RESPONSE ".repeat(150));
    else if (user.includes("RESUME_AFTER_COMPACT")) {
      assert.match(history, /COMPACT_SUMMARY_KEEP_GOAL/); assert.ok(!history.includes("SEED_HISTORY_0 "));
      reply(response, "RESUMED_WITH_COMPACTED_CONTEXT");
    } else if (user.includes("SSE_GAP_PERMISSION")) {
      if (!calls.includes("Write")) reply(response, "", { name: "Write", input: { file_path: path.join(workspace, user.includes("STOP") ? "must-not-write.txt" : "approval-gap.txt"), content: "APPROVED_WRITE_ONCE" } }, 620);
      else reply(response, "APPROVAL_CONTINUED_ONCE");
    } else if (user.includes("SSE_GAP_QUESTION")) {
      if (!calls.includes("AskUserQuestion")) reply(response, "", { name: "AskUserQuestion", input: { questions: [{ header: "Continue", question: "Continue the isolated fixture?", options: [{ label: "Continue" }, { label: "Stop" }] }] } }, 620);
      else reply(response, "QUESTION_CONTINUED_ONCE");
    } else if (user.includes("SCHEDULE_FAILURE")) {
      response.writeHead(400, { "content-type": "application/json" }); response.end(JSON.stringify({ error: { message: "Synthetic nonretryable model failure", type: "invalid_request_error" } }));
    } else if (user.includes("SCHEDULE_STOP")) {
      response.writeHead(200, { "content-type": "text/event-stream" }); response.flushHeaders(); held.add(response);
      response.on("close", () => held.delete(response));
    } else if (user.includes("SCHEDULE_LIMIT")) reply(response, "", { name: "Read", input: { file_path: path.join(workspace, "limit-input.txt") } });
    else if (user.includes("SCHEDULE_SUCCESS")) reply(response, "SCHEDULE_COMPLETED");
    else throw new Error("Unknown isolated continuity prompt");
  } catch (error) {
    supplierErrors.push(error instanceof Error ? error.message : String(error));
    if (!response.headersSent) response.writeHead(500); response.end("Synthetic continuity assertion failed");
  }
});
await new Promise<void>(resolve => supplier.listen(0, "127.0.0.1", resolve));
const supplierAddress = supplier.address(); assert.ok(supplierAddress && typeof supplierAddress !== "string");
const home = accountHome(base, account.users[0]!.id); await fs.mkdir(home, { recursive: true });
await fs.writeFile(path.join(home, "settings.json"), JSON.stringify({ model: profileId, defaultModel: profileId,
  models: { [profileId]: { protocol: "openai-chat", model: profileId, baseURL: `http://127.0.0.1:${supplierAddress.port}/v1`, apiKey: "fixture-only" } },
  mcpServers: {}, disableAllHooks: true, agentTeams: false,
}));
const emptyEnv = path.join(temporary, "empty.env"); await fs.writeFile(emptyEnv, "");
const reservation = createServer(); await new Promise<void>(resolve => reservation.listen(0, "127.0.0.1", resolve));
const address = reservation.address(); assert.ok(address && typeof address !== "string"); const port = address.port;
await new Promise<void>(resolve => reservation.close(() => resolve()));
const origin = `http://127.0.0.1:${port}`, environment: NodeJS.ProcessEnv = { ...process.env, CCAGENT_HOME: base, CCAGENT_PLATFORM_HOME: base, CCAGENT_ENV_FILE: emptyEnv, CCAGENT_DISABLE_STREAM_LOG: "1" };
for (const key of Object.keys(environment)) if (/API.?KEY|SECRET|TOKEN/i.test(key) || /^(ANTHROPIC|OPENAI|QWEN|DASHSCOPE|OLLAMA|GEMINI)_/i.test(key) || ["CCAGENT_ACCOUNT_ID", "CCAGENT_AUTH_SESSION_FILE", "CCAGENT_DESKTOP_APP", "NODE_TLS_REJECT_UNAUTHORIZED"].includes(key)) delete environment[key];
let child: ChildProcess | undefined, logs = "", cookie = "", checks = 0;
const pause = (ms = 35) => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check: () => boolean | Promise<boolean>, message: string, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await pause(); }
  throw new Error(message + "\n" + logs);
}
async function request(route: string, body?: Record<string, unknown>) {
  return fetch(origin + route, { method: body ? "POST" : "GET", headers: { ...(cookie ? { cookie } : {}), ...(body ? { "content-type": "application/json", "x-ccagent-web": "1", origin } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20000) });
}
async function json(route: string, body?: Record<string, unknown>, expected = 200): Promise<any> {
  const response = await request(route, body); assert.equal(response.status, expected, await response.clone().text()); return response.json();
}
async function startWeb() {
  child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), path.join(repository, "src/entrypoint/cli.ts"), "web", "--workspace", workspace, "--port", String(port)], { cwd: temporary, env: environment, windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  child.stdout!.on("data", bytes => { logs = (logs + bytes).slice(-10000); }); child.stderr!.on("data", bytes => { logs = (logs + bytes).slice(-10000); });
  await waitFor(async () => { if (child!.exitCode !== null) throw new Error(logs); try { return (await fetch(origin + "/api/health")).ok; } catch { return false; } }, "Own fixture Web startup failed");
  cookie = "";
  const login = await request("/api/account/login", { email: account.users[0]!.email, password: account.password });
  assert.equal(login.status, 200); cookie = login.headers.get("set-cookie")!.split(";")[0]!;
}
async function stopWeb() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exiting = child, exited = new Promise<void>(resolve => exiting.once("close", () => resolve()));
  if (exiting.connected) exiting.send("ccagent:shutdown", () => {});
  const timeout = setTimeout(() => { if (process.platform === "win32" && exiting.pid) { try { execFileSync("taskkill.exe", ["/PID", String(exiting.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); } catch { exiting.kill(); } } else exiting.kill(); }, 5000);
  await exited; clearTimeout(timeout);
}
const state = (id: string) => json(`/api/sessions/${id}`);
async function create() { return (await json("/api/sessions", { model: profileId, mode: "default" }, 201)).sessionId as string; }
async function run(id: string, text: string) {
  await json(`/api/sessions/${id}/messages`, { text }, 202);
  let result: any;
  await waitFor(async () => { result = await state(id); return !result.busy && Boolean(result.execution?.completedAt); }, "Foreground turn must finish"); return result;
}
async function firstEvent(id: string, cursor: number, headerCursor?: number): Promise<any> {
  const controller = new AbortController();
  const response = await fetch(`${origin}/api/sessions/${id}/events?lastEventId=${cursor}`, { headers: { cookie, ...(headerCursor !== undefined ? { "last-event-id": String(headerCursor) } : {}) }, signal: controller.signal });
  assert.equal(response.status, 200); const reader = response.body!.getReader(), decoder = new TextDecoder(); let buffer = "";
  try {
    while (true) {
      const frame = /(?:^|\n)data: (.*)\n\n/.exec(buffer); if (frame) return JSON.parse(frame[1]!);
      const chunk = await reader.read(); assert.equal(chunk.done, false); buffer += decoder.decode(chunk.value, { stream: true });
    }
  } finally { controller.abort(); await reader.cancel().catch(() => {}); }
}
const test = async (name: string, action: () => Promise<void>) => { await action(); checks++; console.log("PASS " + name); };
try {
  await startWeb();
  await test("SSE ring overflow restores the authoritative transcript and pending question without rerunning a task", async () => {
    const id = await create(); await json(`/api/sessions/${id}/messages`, { text: "SSE_GAP_QUESTION" }, 202);
    let pending: any; await waitFor(async () => { pending = await state(id); return Boolean(pending.pending); }, "Question must wait for its owner");
    assert.ok(pending.lastEventId > 500); assert.equal(pending.busy, true); assert.equal(pending.pending.kind, "question");
    assert.equal((await firstEvent(id, 0)).type, "session_snapshot_required");
    assert.equal((await firstEvent(id, pending.lastEventId)).type, "execution_state", "Fresh snapshot cursor must not cause a reload loop");
    const restored = await state(id); assert.deepEqual(restored.messages, pending.messages); assert.equal(restored.pending.id, pending.pending.id);
    assert.equal(requests.filter(item => item.user.includes("SSE_GAP_QUESTION")).length, 1);
    await json(`/api/sessions/${id}/respond`, { id: pending.pending.id, answers: { "Continue the isolated fixture?": "Continue" } });
    await waitFor(async () => !(await state(id)).busy, "Answered question must continue");
    assert.match(JSON.stringify((await state(id)).messages), /QUESTION_CONTINUED_ONCE/);
    assert.equal(requests.filter(item => item.user.includes("SSE_GAP_QUESTION")).length, 2);
  });
  await test("a missing approval event is restored after SSE overflow and one approval executes the write exactly once", async () => {
    const id = await create(); await json(`/api/sessions/${id}/messages`, { text: "SSE_GAP_PERMISSION" }, 202);
    let pending: any; await waitFor(async () => { pending = await state(id); return Boolean(pending.pending); }, "Write must wait for an explicit approval");
    assert.equal(pending.pending.kind, "permission"); assert.ok(pending.lastEventId > 500);
    assert.equal((await firstEvent(id, 0)).type, "session_snapshot_required");
    const restored = await state(id); assert.equal(restored.pending.id, pending.pending.id); assert.deepEqual(restored.messages, pending.messages);
    assert.equal(await fs.stat(path.join(workspace, "approval-gap.txt")).then(() => true, () => false), false);
    await json(`/api/sessions/${id}/respond`, { id: restored.pending.id, decision: "allow_once" });
    await waitFor(async () => !(await state(id)).busy, "Approved write must complete");
    assert.equal(await fs.readFile(path.join(workspace, "approval-gap.txt"), "utf8"), "APPROVED_WRITE_ONCE");
    assert.equal(requests.filter(item => item.user === "SSE_GAP_PERMISSION").length, 2);
    assert.equal((await request(`/api/sessions/${id}/respond`, { id: restored.pending.id, decision: "allow_once" })).status, 409);
  });
  await test("stopping at a pending approval releases the worker and cannot execute a stale approval or replay the write", async () => {
    const id = await create(); await json(`/api/sessions/${id}/messages`, { text: "SSE_GAP_PERMISSION_STOP" }, 202);
    let pending: any; await waitFor(async () => { pending = await state(id); return Boolean(pending.pending); }, "Stop fixture must await approval");
    assert.equal((await json(`/api/sessions/${id}/interrupt`, {})).interrupted, true);
    await waitFor(async () => !(await state(id)).busy, "Stopped approval must release the session");
    assert.equal((await state(id)).lastTurnReason, "aborted");
    assert.equal((await request(`/api/sessions/${id}/respond`, { id: pending.pending.id, decision: "allow_once" })).status, 409);
    assert.equal(await fs.stat(path.join(workspace, "must-not-write.txt")).then(() => true, () => false), false);
    await pause(1100); assert.equal(requests.filter(item => item.user === "SSE_GAP_PERMISSION_STOP").length, 1);
    assert.equal((await run(id, "SEED_HISTORY_after_explicit_stop")).lastTurnReason, "completed");
  });
  await test("Web manual compaction survives worker restart and the next request uses the summary rather than old history", async () => {
    const id = await create(); for (let index = 0; index < 12; index++) await run(id, `SEED_HISTORY_${index} preserve the same goal`);
    const before = await state(id), compacted = await run(id, "/compact");
    assert.match(JSON.stringify(compacted.messages), /COMPACT_SUMMARY_KEEP_GOAL/); assert.ok(compacted.messages.length < before.messages.length);
    assert.ok(!JSON.stringify(compacted.messages).includes("SEED_HISTORY_0 "));
    const priorCursor = compacted.lastEventId; await stopWeb(); await startWeb();
    const restored = await state(id); assert.deepEqual(restored.messages, compacted.messages); assert.deepEqual(restored.usage, compacted.usage);
    assert.equal((await firstEvent(id, 0, priorCursor)).type, "session_snapshot_required", "A stale worker cursor must request a fresh snapshot");
    assert.equal((await firstEvent(id, restored.lastEventId)).type, "execution_state");
    assert.equal((await run(id, "RESUME_AFTER_COMPACT")).lastTurnReason, "completed");
  });
  await test("pre-turn automatic compaction cannot erase the newly submitted requirement from the persisted session", async () => {
    const id = await create(); await run(id, "PRETURN_AUTO_SEED");
    const completed = await run(id, "UNIQUE_NEW_REQUIREMENT_AFTER_PRETURN_AUTO");
    assert.equal(completed.lastTurnReason, "completed"); assert.match(JSON.stringify(completed.messages), /COMPACT_SUMMARY_KEEP_GOAL/);
    assert.equal(completed.messages.filter((message: any) => message.role === "user" && message.content === "UNIQUE_NEW_REQUIREMENT_AFTER_PRETURN_AUTO").length, 1);
    await stopWeb(); await startWeb(); const restored = await state(id);
    assert.equal(restored.messages.filter((message: any) => message.role === "user" && message.content === "UNIQUE_NEW_REQUIREMENT_AFTER_PRETURN_AUTO").length, 1, "Restoring from the compaction boundary must retain this turn's distinct new user request exactly once");
    assert.deepEqual(restored.messages, completed.messages);
  });
  await test("stopping after pre-turn automatic compaction still restores the distinct current user request exactly once", async () => {
    const id = await create(); await run(id, "PRETURN_AUTO_SEED");
    await json(`/api/sessions/${id}/messages`, { text: "UNIQUE_NEW_REQUIREMENT_PRETURN_AUTO_STOP" }, 202);
    await waitFor(() => held.size > 0, "The main model must receive the new request after pre-turn compaction");
    assert.equal((await json(`/api/sessions/${id}/interrupt`, {})).interrupted, true);
    let stopped: any; await waitFor(async () => { stopped = await state(id); return !stopped.busy; }, "Stopped compacted request must become idle");
    assert.equal(stopped.lastTurnReason, "aborted");
    await stopWeb(); await startWeb(); const restored = await state(id);
    assert.equal(restored.messages.filter((message: any) => message.role === "user" && message.content === "UNIQUE_NEW_REQUIREMENT_PRETURN_AUTO_STOP").length, 1);
    assert.deepEqual(restored.messages, stopped.messages);
  });
  async function schedule(prompt: string) {
    const { task } = await json("/api/schedules", { title: prompt, prompt, nextRunAt: new Date(Date.now() + 60_000).toISOString(), repeat: "none", model: profileId, mode: "default" }, 201);
    await json(`/api/schedules/${task.id}`, { action: "run-now" }); return task.id as string;
  }
  async function scheduled(id: string) { return (await json("/api/schedules")).tasks.find((task: any) => task.id === id); }
  await test("a nonretryable scheduled model failure is paused with an error and never reported completed or rerun", async () => {
    const id = await schedule("SCHEDULE_FAILURE"); let task: any;
    await waitFor(async () => { task = await scheduled(id); return task.status === "paused"; }, "Failed schedule must pause");
    assert.ok(task.lastError); assert.equal((await state(task.lastSessionId)).lastTurnReason, "model_error");
    const count = requests.length; await pause(1100); assert.equal(requests.length, count);
  });
  await test("an explicitly stopped scheduled request is paused and requires a user action before retry", async () => {
    const id = await schedule("SCHEDULE_STOP"); let task: any;
    await waitFor(async () => { task = await scheduled(id); return Boolean(task.lastSessionId) && held.size > 0; }, "Scheduled transport must wait");
    assert.equal((await json(`/api/sessions/${task.lastSessionId}/interrupt`, {})).interrupted, true);
    await waitFor(async () => (await scheduled(id)).status === "paused", "Stopped scheduled task must pause");
    assert.equal((await state(task.lastSessionId)).lastTurnReason, "aborted");
    const count = requests.length; await pause(1100); assert.equal(requests.length, count);
  });
  await test("a successful scheduled request remains completed", async () => {
    const id = await schedule("SCHEDULE_SUCCESS"); await waitFor(async () => (await scheduled(id)).status === "completed", "Successful schedule must complete");
    assert.equal((await state((await scheduled(id)).lastSessionId)).lastTurnReason, "completed"); assert.deepEqual(supplierErrors, []);
  });
  await test("a long tool chain continues without extra input and its turn limit pauses the schedule truthfully", async () => {
    const id = await schedule("SCHEDULE_LIMIT"); let task: any;
    await waitFor(async () => { task = await scheduled(id); return task.status === "paused"; }, "A turn-limited schedule must pause");
    assert.ok(task.lastError); const final = await state(task.lastSessionId);
    assert.equal(final.lastTurnReason, "max_turns"); assert.ok(final.execution.tools.length >= 40);
    assert.ok(final.execution.tools.every((tool: any) => tool.name === "Read" && tool.completedAt && !tool.isError));
    const calls = requests.filter(item => item.user === "SCHEDULE_LIMIT").length;
    assert.equal(calls, final.execution.tools.length); await pause(1100);
    assert.equal(requests.filter(item => item.user === "SCHEDULE_LIMIT").length, calls, "A turn limit must not silently start another chain");
    assert.deepEqual(supplierErrors, []);
  });
  console.log(`Web continuity: ${checks} checks passed; actual source-mode worker, QueryEngine, SSE, compaction/restart and schedules; isolated loopback models/accounts only.`);
} finally {
  await stopWeb(); supplier.closeAllConnections(); await new Promise<void>(resolve => supplier.close(() => resolve())); await account.close();
  const relative = path.relative(temporaryParent, temporary); assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative) && path.basename(temporary).startsWith("ccagent-web-continuity-"));
  await fs.rm(temporary, { recursive: true, force: true });
}
