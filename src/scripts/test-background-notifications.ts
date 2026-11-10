/** Conversation isolation and real Web background continuation, using only loopback fixtures. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer, type ServerResponse } from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accountHome } from "../platform/account.js";
import { startAccountFixture, withTestAccount } from "./helpers/accountFixture.js";
import {
  clearPendingNotifications, drainPendingNotifications, enqueuePendingNotification,
  notificationScopeForContext, pendingNotificationCount, peekPendingNotifications,
} from "../state/notificationStore.js";
import { createWebNotificationDispatcher, findWebNotificationSession } from "../entrypoint/webNotifications.js";
import { createWorkfriendSchedule, clearWorkfriendTimers, listWorkfriendSchedules } from "../workfriend/scheduler.js";
import { bootstrapAgentStates, setAgentState } from "../agents/preferences.js";

let passed = 0;
const test = async (name: string, action: () => void | Promise<void>) => { await action(); passed++; console.log("PASS " + name); };
const pause = (ms = 60) => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check: () => boolean | Promise<boolean>, message: string, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (await check()) return; await pause(); }
  throw new Error(message);
}

await withTestAccount(async () => {
  await bootstrapAgentStates();
  const a = { sessionId: "owner-a" }, b = { sessionId: "owner-b" };
  const strictA = notificationScopeForContext({ ...a, strictNotificationScope: true });
  await test("strict Web scope and CLI legacy compatibility never consume another owner", () => {
    clearPendingNotifications();
    enqueuePendingNotification({ mode: "task-notification", text: "a-first", ownerSessionId: a.sessionId });
    enqueuePendingNotification({ mode: "task-notification", text: "b-only", ownerSessionId: b.sessionId });
    enqueuePendingNotification({ mode: "workfriend-notification", text: "legacy" });
    enqueuePendingNotification({ mode: "task-notification", text: "a-second", ownerSessionId: a.sessionId });
    assert.deepEqual(drainPendingNotifications(strictA).map(item => item.text), ["a-first", "a-second"]);
    assert.equal(pendingNotificationCount(strictA), 0);
    assert.deepEqual(drainPendingNotifications(notificationScopeForContext(a)).map(item => item.text), ["legacy"]);
    assert.deepEqual(drainPendingNotifications(notificationScopeForContext(b)).map(item => item.text), ["b-only"]);
    assert.equal(pendingNotificationCount(), 0);
  });
  await test("Web auto continuation selects the exact loaded owner, honors busy/pending and team ownership", () => {
    enqueuePendingNotification({ mode: "task-notification", text: "a", ownerSessionId: a.sessionId });
    enqueuePendingNotification({ mode: "task-notification", text: "unloaded", ownerSessionId: "unloaded-owner" });
    enqueuePendingNotification({ mode: "workfriend-notification", text: "legacy" });
    const sessions = [{ id: b.sessionId, busy: false }, { id: a.sessionId, busy: false }];
    assert.equal(findWebNotificationSession(sessions, null)?.id, a.sessionId);
    assert.equal(findWebNotificationSession(sessions, b.sessionId), undefined);
    assert.equal(findWebNotificationSession([{ id: a.sessionId, busy: true }], null), undefined);
    assert.equal(findWebNotificationSession([{ id: a.sessionId, busy: false, pending: {} }], null), undefined);
    assert.equal(findWebNotificationSession([{ id: b.sessionId, busy: false }], null), undefined);
    assert.equal(findWebNotificationSession(sessions, a.sessionId)?.id, a.sessionId);
    clearPendingNotifications();
  });
  await test("Web push continuation coalesces enqueues, runs before a timer and retries on idle exactly once", async () => {
    let busy = false;
    const starts: string[] = [], sessions = [{ id: a.sessionId, busy: false }, { id: b.sessionId, busy: false }];
    const dispatcher = createWebNotificationDispatcher({ sessions: () => sessions, teamOwner: () => null, blocked: () => busy,
      start(session) { busy = true; starts.push(session.id); drainPendingNotifications({ sessionId: session.id }); } });
    try {
      // B arrived first even though A was the first session opened.
      enqueuePendingNotification({ mode: "task-notification", text: "b-first", ownerSessionId: b.sessionId });
      enqueuePendingNotification({ mode: "task-notification", text: "a-next", ownerSessionId: a.sessionId });
      enqueuePendingNotification({ mode: "task-notification", text: "b-batched", ownerSessionId: b.sessionId });
      assert.deepEqual(starts, [], "Enqueue must not synchronously re-enter the executing engine");
      await Promise.resolve(); assert.deepEqual(starts, [b.sessionId]);
      dispatcher.request(); await Promise.resolve(); assert.deepEqual(starts, [b.sessionId], "A running foreground turn keeps exclusive ownership");
      busy = false; dispatcher.request(); dispatcher.request();
      await Promise.resolve(); assert.deepEqual(starts, [b.sessionId, a.sessionId]);
      busy = false; dispatcher.request(); await Promise.resolve(); assert.equal(starts.length, 2);
    } finally { dispatcher.dispose(); clearPendingNotifications(); }
  });
  await test("pending approval and a disposed worker never trigger background continuation", async () => {
    const owner = { id: a.sessionId, busy: false, pending: {} as unknown }, starts: string[] = [];
    const dispatcher = createWebNotificationDispatcher({ sessions: () => [owner], teamOwner: () => null, blocked: () => false,
      start(session) { starts.push(session.id); drainPendingNotifications({ sessionId: session.id }); } });
    enqueuePendingNotification({ mode: "task-notification", text: "approval-held", ownerSessionId: a.sessionId });
    await Promise.resolve(); assert.deepEqual(starts, []);
    owner.pending = undefined; dispatcher.request(); dispatcher.dispose();
    await Promise.resolve(); assert.deepEqual(starts, [], "A queued microtask must not resume after shutdown");
    enqueuePendingNotification({ mode: "task-notification", text: "after-shutdown", ownerSessionId: a.sessionId });
    await Promise.resolve(); assert.deepEqual(starts, []); clearPendingNotifications();
  });
  await test("closed Workfriend reminders stay owned and deletion clears only the chosen conversation", async () => {
    await setAgentState("workfriend", "close");
    enqueuePendingNotification({ mode: "workfriend-notification", text: "held-a", ownerSessionId: a.sessionId });
    enqueuePendingNotification({ mode: "task-notification", text: "task-a", ownerSessionId: a.sessionId });
    enqueuePendingNotification({ mode: "task-notification", text: "task-b", ownerSessionId: b.sessionId });
    assert.deepEqual(drainPendingNotifications(strictA).map(item => item.text), ["task-a"]);
    clearPendingNotifications({ sessionId: a.sessionId });
    await setAgentState("workfriend", "open");
    assert.equal(pendingNotificationCount(strictA), 0);
    assert.deepEqual(peekPendingNotifications().map(item => item.text), ["task-b"]);
    clearPendingNotifications();
  });
  await test("Workfriend persisted owners survive scheduler reload shape and legacy reminders cannot enter Web", async () => {
    const now = new Date(), end = new Date(now.getTime() + 30 * 60_000);
    const workdayEnd = `${String(end.getHours()).padStart(2, "0")}:${String(end.getMinutes()).padStart(2, "0")}`;
    const owned = await createWorkfriendSchedule({ cwd: process.cwd(), ownerSessionId: a.sessionId, now, workdayEnd, workSummary: "owned fixture", moodSummary: "neutral" });
    const legacy = await createWorkfriendSchedule({ cwd: process.cwd(), now, workdayEnd, workSummary: "legacy fixture", moodSummary: "neutral" });
    assert.equal((await listWorkfriendSchedules()).find(item => item.id === owned.id)?.ownerSessionId, a.sessionId);
    assert.equal((await listWorkfriendSchedules()).find(item => item.id === legacy.id)?.ownerSessionId, undefined);
    await waitFor(() => pendingNotificationCount() === 2, "Both isolated reminders must fire");
    assert.equal(drainPendingNotifications(strictA).length, 1);
    assert.equal(pendingNotificationCount({ sessionId: b.sessionId }), 0);
    assert.equal(drainPendingNotifications(notificationScopeForContext(b)).length, 1);
    clearWorkfriendTimers(); clearPendingNotifications();
  });
});

const repository = path.resolve(import.meta.dirname, "../..");
const temporaryParent = await fs.realpath(os.tmpdir());
const temporary = await fs.realpath(await fs.mkdtemp(path.join(temporaryParent, "ccagent-notification-web-")));
const workspace = path.join(temporary, "workspace"), base = path.join(temporary, "profile");
await fs.mkdir(workspace);
const account = await startAccountFixture(base);
const profileId = "notification-fixture", supplierErrors: string[] = [];
const requests: { user: string; history: string; startedAt: number }[] = [];
const releaseTimes = new Map<string, number>();
const continuationTimings: Record<string, number> = {};
const held = new Map<string, ServerResponse>();
let sequence = 0;
function reply(response: ServerResponse, text: string, tool?: { name: string; input: Record<string, unknown> }) {
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
  const delta = tool ? { tool_calls: [{ index: 0, id: `notification-tool-${++sequence}`, type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.input) } }] } : { content: text };
  response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
  response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }], usage: { prompt_tokens: 30, completion_tokens: 10 } })}\n\ndata: [DONE]\n\n`);
}
const supplier = createServer(async (request, response) => {
  try {
    assert.equal(new URL(request.url ?? "/", "http://127.0.0.1").pathname, "/v1/chat/completions");
    let raw = ""; for await (const chunk of request) { raw += chunk; assert.ok(raw.length < 2 * 1024 * 1024); }
    const body = JSON.parse(raw), messages = body.messages as Array<Record<string, any>>;
    assert.equal(body.model, profileId);
    let lastUserIndex = messages.length - 1;
    while (lastUserIndex >= 0 && messages[lastUserIndex]!.role !== "user") lastUserIndex--;
    const user = String(messages[lastUserIndex]?.content ?? ""), history = JSON.stringify(messages.filter(message => message.role !== "system"));
    const calls = messages.slice(lastUserIndex + 1).flatMap(message => message.tool_calls ?? []).map(call => call.function.name);
    requests.push({ user, history, startedAt: Date.now() });
    if (user.includes("[task-notification]")) {
      assert.ok(!history.includes("UNRELATED_B"), "A task completion must never enter conversation B");
      if (history.includes("START_FAILED_BACKGROUND")) { assert.match(user, /<status>failed<\/status>/); reply(response, "FAILURE_NOTIFIED"); }
      else if (history.includes("START_BACKGROUND_A")) { assert.match(user, /CHILD_DONE_A/); reply(response, "AUTO_RESUMED_A"); }
      else if (history.includes("START_BACKGROUND_C")) { assert.match(user, /CHILD_DONE_C/); reply(response, "AUTO_RESUMED_C"); }
      else throw new Error("Unknown notification owner");
    } else if (user.includes("[workfriend-notification]")) {
      assert.ok(!history.includes("UNRELATED_B"));
      assert.match(user, /OWNED_RESTART_REMINDER/);
      assert.ok(!user.includes("LEGACY_RESTART_REMINDER"));
      reply(response, "OWNED_REMINDER_RESUMED");
    } else if (/START_BACKGROUND_[AC]|START_FAILED_BACKGROUND/.test(user)) {
      const marker = user.includes("START_BACKGROUND_A") ? "A" : user.includes("START_BACKGROUND_C") ? "C" : "FAIL";
      if (!calls.includes("Agent")) reply(response, "", { name: "Agent", input: { subagent_type: "general-purpose", run_in_background: true, description: "Notification isolation fixture", prompt: "CHILD_BACKGROUND_" + marker } });
      else reply(response, "BACKGROUND_STARTED_" + marker);
    } else if (user.includes("CHILD_BACKGROUND_A")) {
      if (!calls.includes("WorkfriendSchedule")) {
        const end = new Date(Date.now() + 2 * 3600_000);
        reply(response, "", { name: "WorkfriendSchedule", input: { action: "schedule", workday_end: `${String(end.getHours()).padStart(2, "0")}:${String(end.getMinutes()).padStart(2, "0")}`, work_summary: "Child owner inheritance", mood_summary: "neutral" } });
      } else { assert.ok(!held.has("A")); held.set("A", response); }
    } else if (user.includes("CHILD_BACKGROUND_C")) { assert.ok(!held.has("C")); held.set("C", response); }
    else if (user.includes("CHILD_BACKGROUND_FAIL")) { response.writeHead(400, { "content-type": "application/json" }); response.end(JSON.stringify({ error: { message: "Synthetic background failure", type: "invalid_request_error" } })); }
    else if (user.includes("HOLD_OTHER_TURN")) { assert.ok(!held.has("OTHER")); held.set("OTHER", response); }
    else if (user.includes("UNRELATED_B")) { assert.ok(!history.includes("<task-notification>")); reply(response, "B_FINISHED"); }
    else throw new Error("Unknown notification fixture prompt");
  } catch (error) {
    supplierErrors.push(error instanceof Error ? error.message : String(error));
    if (!response.headersSent) response.writeHead(500); response.end("Synthetic notification fixture failed");
  }
});
await new Promise<void>(resolve => supplier.listen(0, "127.0.0.1", resolve));
const supplierAddress = supplier.address(); assert.ok(supplierAddress && typeof supplierAddress !== "string");
const home = accountHome(base, account.users[0]!.id); await fs.mkdir(home, { recursive: true });
await fs.writeFile(path.join(home, "settings.json"), JSON.stringify({ defaultModel: profileId, model: profileId,
  models: { [profileId]: { protocol: "openai-chat", model: profileId, baseURL: `http://127.0.0.1:${supplierAddress.port}/v1`, apiKey: "fixture-only" } },
  mcpServers: {}, disableAllHooks: true, agentTeams: false,
}));
const emptyEnv = path.join(temporary, "empty.env"); await fs.writeFile(emptyEnv, "");
const reservation = createServer(); await new Promise<void>(resolve => reservation.listen(0, "127.0.0.1", resolve));
const address = reservation.address(); assert.ok(address && typeof address !== "string"); const port = address.port;
await new Promise<void>(resolve => reservation.close(() => resolve()));
const origin = `http://127.0.0.1:${port}`;
const environment: NodeJS.ProcessEnv = { ...process.env, CCAGENT_HOME: base, CCAGENT_PLATFORM_HOME: base, CCAGENT_ENV_FILE: emptyEnv, CCAGENT_DISABLE_STREAM_LOG: "1" };
for (const key of Object.keys(environment)) if (/API.?KEY|SECRET|TOKEN/i.test(key) || /^(ANTHROPIC|OPENAI|QWEN|DASHSCOPE|OLLAMA|GEMINI)_/i.test(key) || ["CCAGENT_ACCOUNT_ID", "CCAGENT_AUTH_SESSION_FILE", "CCAGENT_DESKTOP_APP", "NODE_TLS_REJECT_UNAUTHORIZED"].includes(key)) delete environment[key];
let logs = "", cookie = "";
function startWeb() {
  const process = spawn(globalThis.process.execPath, ["--import", import.meta.resolve("tsx"), path.join(repository, "src/entrypoint/cli.ts"), "web", "--workspace", workspace, "--port", String(port)], {
    cwd: temporary, env: environment, windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  process.stdout!.on("data", chunk => { logs = (logs + String(chunk)).slice(-12000); }); process.stderr!.on("data", chunk => { logs = (logs + String(chunk)).slice(-12000); });
  return process;
}
let child = startWeb();
async function stopWeb() {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exiting = child;
  const exited = new Promise<void>(resolve => exiting.once("close", () => resolve())); if (exiting.connected) exiting.send("ccagent:shutdown", () => {});
  const deadline = setTimeout(() => { if (process.platform === "win32" && exiting.pid) { try { execFileSync("taskkill.exe", ["/PID", String(exiting.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); } catch { exiting.kill(); } } else exiting.kill(); }, 5000);
  await exited; clearTimeout(deadline);
}
async function request(route: string, body?: Record<string, unknown>) {
  const response = await fetch(origin + route, { method: body ? "POST" : "GET", headers: { ...(cookie ? { cookie } : {}), ...(body ? { "content-type": "application/json", "x-ccagent-web": "1", origin } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20000) });
  assert.ok(response.ok, `HTTP ${response.status}: ${await response.clone().text()}`); return response;
}
const state = async (id: string): Promise<any> => (await request(`/api/sessions/${id}`)).json();
const create = async (): Promise<string> => (await (await request("/api/sessions", { mode: "full", model: profileId, team: "off" })).json() as any).sessionId;
async function submit(id: string, text: string) { await request(`/api/sessions/${id}/messages`, { text }); }
async function waitIdle(id: string) {
  let current: any;
  try { await waitFor(async () => { current = await state(id); assert.equal(current.pending, null); return !current.busy && Boolean(current.execution?.completedAt); }, "Web turn must finish", 45000); }
  catch (error) { throw new Error(String(error) + " " + JSON.stringify({ current, requests: requests.map(item => item.user), supplierErrors, logs })); }
}
function release(key: string, text: string) { const response = held.get(key); assert.ok(response); held.delete(key); releaseTimes.set(key, Date.now()); reply(response, text); }
async function loginWeb() {
  await waitFor(async () => { if (child.exitCode !== null) throw new Error(logs); try { return (await fetch(origin + "/api/health", { signal: AbortSignal.timeout(500) })).ok; } catch { return false; } }, "Source Web did not start: " + logs);
  const login = await request("/api/account/login", { email: account.users[0]!.email, password: account.password }); cookie = login.headers.get("set-cookie")!.split(";")[0]!;
}
try {
  await loginWeb();
  await test("ordinary Web background Agent resumes its own parent automatically and child tools inherit root ownership", async () => {
    const a = await create(), b = await create();
    await submit(a, "START_BACKGROUND_A"); await waitIdle(a); await waitFor(() => held.has("A"), "Child A must wait at fixture barrier");
    await submit(b, "UNRELATED_B"); await waitIdle(b);
    const schedules = JSON.parse(await fs.readFile(path.join(home, "workfriend", "schedules.json"), "utf8"));
    assert.equal(schedules.schedules[0].ownerSessionId, a, "Child context must preserve its root conversation owner");
    release("A", "CHILD_DONE_A");
    await waitFor(async () => JSON.stringify((await state(a)).messages).includes("AUTO_RESUMED_A"), "Normal background Agent must auto-resume without teamOwner");
    await waitIdle(a);
    const other = await state(b); assert.ok(!JSON.stringify(other.messages).includes("CHILD_DONE_A"));
    assert.equal(requests.filter(item => item.user.includes("[task-notification]") && item.history.includes("START_BACKGROUND_A")).length, 1);
    continuationTimings.childReleaseToParentRequestMs = requests.find(item => item.user.includes("[task-notification]") && item.history.includes("START_BACKGROUND_A"))!.startedAt - releaseTimes.get("A")!;
  });
  await test("completion arriving while another conversation is busy waits and resumes exactly once after idle", async () => {
    const c = await create(), other = await create();
    await submit(c, "START_BACKGROUND_C"); await waitIdle(c); await waitFor(() => held.has("C"), "Child C must wait at fixture barrier");
    await submit(other, "HOLD_OTHER_TURN"); await waitFor(() => held.has("OTHER"), "Other conversation must hold activeTurn");
    release("C", "CHILD_DONE_C"); await pause(1400);
    assert.equal(requests.filter(item => item.user.includes("[task-notification]") && item.history.includes("START_BACKGROUND_C")).length, 0);
    release("OTHER", "OTHER_FINISHED"); await waitIdle(other);
    await waitFor(async () => JSON.stringify((await state(c)).messages).includes("AUTO_RESUMED_C"), "Queued owner must resume after other turn finishes");
    await waitIdle(c);
    assert.ok(!JSON.stringify((await state(other)).messages).includes("CHILD_DONE_C"));
    assert.equal(requests.filter(item => item.user.includes("[task-notification]") && item.history.includes("START_BACKGROUND_C")).length, 1);
    continuationTimings.busyTurnReleaseToParentRequestMs = requests.find(item => item.user.includes("[task-notification]") && item.history.includes("START_BACKGROUND_C"))!.startedAt - releaseTimes.get("OTHER")!;
  });
  await test("a failed background model reports failure only to its owning Web conversation", async () => {
    const failed = await create(); await submit(failed, "START_FAILED_BACKGROUND");
    await waitFor(async () => JSON.stringify((await state(failed)).messages).includes("FAILURE_NOTIFIED"), "Failed Agent notification must auto-resume its owner");
    await waitIdle(failed); assert.deepEqual(supplierErrors, []);
  });
  await test("Web restart restores owned Workfriend reminders without adopting legacy or unloaded owners", async () => {
    const owner = await create();
    await stopWeb();
    const schedulePath = path.join(home, "workfriend", "schedules.json");
    const file = JSON.parse(await fs.readFile(schedulePath, "utf8"));
    const timestamp = new Date(Date.now() - 1000).toISOString();
    for (const legacy of [false, true]) file.schedules.push({ id: randomUUID(), createdAt: timestamp, checkInAt: timestamp,
      workdayEnd: "18:00", workSummary: legacy ? "LEGACY_RESTART_REMINDER" : "OWNED_RESTART_REMINDER", moodSummary: "neutral",
      cwd: workspace, status: "pending", ...(!legacy ? { ownerSessionId: owner } : {}),
    });
    await fs.writeFile(schedulePath, JSON.stringify(file));
    cookie = ""; child = startWeb(); await loginWeb();
    const other = await create(); await submit(other, "UNRELATED_B"); await waitIdle(other);
    assert.equal(requests.filter(item => item.user.includes("[workfriend-notification]")).length, 0, "Unloaded owner's reminder must remain queued");
    await state(owner);
    await waitFor(async () => JSON.stringify((await state(owner)).messages).includes("OWNED_REMINDER_RESUMED"), "Restored reminder must resume only its loaded owner");
    await waitIdle(owner); assert.ok(!JSON.stringify((await state(other)).messages).includes("OWNED_RESTART_REMINDER"));
    assert.equal(requests.filter(item => item.user.includes("[workfriend-notification]")).length, 1);
    assert.deepEqual(supplierErrors, []);
  });
  console.log(`Background notifications: ${passed} checks passed; loopback fixtures only, no real suppliers or browser launches.`);
  console.log("Isolated continuation timings (includes model-history preparation and transcript I/O): " + JSON.stringify(continuationTimings));
} finally {
  await stopWeb();
  supplier.closeAllConnections(); await new Promise<void>(resolve => supplier.close(() => resolve())); await account.close();
  const relative = path.relative(temporaryParent, temporary); assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative) && path.basename(temporary).startsWith("ccagent-notification-web-"));
  await fs.rm(temporary, { recursive: true, force: true });
}
