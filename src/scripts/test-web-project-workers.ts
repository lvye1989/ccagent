/** Real supervisor/project-worker concurrency; loopback authentication and model only. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createServer } from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { startWhiteboardAIFixture } from "./helpers/whiteboardAIFixture.js";

const fixture = await startWhiteboardAIFixture();
const { origin, workspace } = fixture;
// Exercise Unicode header encoding and canonical path lookup as real projects do.
const secondWorkspace = path.join(fixture.secondWorkspace, "项目 B");
await fs.mkdir(secondWorkspace);
const deadline = AbortSignal.timeout(90000);
const pause = () => new Promise(resolve => setTimeout(resolve, 35));
let checks = 0;

type Snapshot = {
  sessionId: string;
  busy: boolean;
  pending: { kind: string; id: string } | null;
  messages: unknown[];
  lastTurnReason: string | null;
  lastEventId: number;
  execution: { id: string; startedAt: string; completedAt: string | null; reason: string | null } | null;
};
type WebEvent = { type: string; execution?: Snapshot["execution"]; text?: string; reason?: string };
type Selection = { workspace: string; activeSessionId: string | null; preservedBackgroundTasks: boolean };
type Bootstrap = { workspace: string; activeTurn: string | null };

async function request(route: string, cookie: string, project?: string, body?: Record<string, unknown>) {
  return fetch(origin + route, {
    method: body ? "POST" : "GET",
    headers: {
      cookie,
      ...(project ? { "x-ccagent-workspace": encodeURIComponent(project) } : {}),
      ...(body ? { "content-type": "application/json", "x-ccagent-web": "1", origin } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: deadline,
  });
}
async function json<T>(route: string, cookie: string, project?: string, body?: Record<string, unknown>, status = 200): Promise<T> {
  const response = await request(route, cookie, project, body);
  assert.equal(response.status, status, await response.clone().text());
  return response.json() as Promise<T>;
}
async function login(index: number, previousCookie = "") {
  const response = await request("/api/account/login", previousCookie, undefined, {
    email: fixture.account.users[index]!.email,
    password: fixture.account.password,
  });
  assert.equal(response.status, 200, await response.clone().text());
  return response.headers.get("set-cookie")!.split(";")[0]!;
}
async function create(cookie: string, project?: string) {
  return (await json<{ sessionId: string }>("/api/sessions", cookie, project,
    { model: "whiteboard-fixture", temporary: true }, 201)).sessionId;
}
const snapshot = (id: string, cookie: string, project?: string) => json<Snapshot>(`/api/sessions/${id}`, cookie, project);
const send = (id: string, cookie: string, project: string, text: string) =>
  json(`/api/sessions/${id}/messages`, cookie, project, { text }, 202);
async function waitFor<T>(read: () => T | Promise<T>, predicate: (value: T) => boolean, message: string): Promise<T> {
  for (let count = 0; count < 350; count++) {
    const value = await read();
    if (predicate(value)) return value;
    await pause();
  }
  throw new Error(message);
}
const pass = (label: string) => { console.log(`PASS ${++checks} ${label}`); };

// EventSource cannot set custom headers: workspace query routing must select the
// same Worker even after the foreground project changes.
async function firstExecutionEvent(id: string, cookie: string, project: string, cursor: number) {
  const controller = new AbortController();
  const query = new URLSearchParams({ workspace: project, lastEventId: String(cursor) });
  const response = await fetch(`${origin}/api/sessions/${id}/events?${query}`, {
    headers: { cookie }, signal: AbortSignal.any([deadline, controller.signal]),
  });
  assert.equal(response.status, 200, response.status === 200 ? undefined : await response.text());
  const reader = response.body!.getReader(), decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const boundary = buffer.indexOf("\n\n");
      if (boundary >= 0) {
        const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
        const data = /^data: (.*)$/m.exec(frame);
        if (data) {
          const event = JSON.parse(data[1]!) as WebEvent;
          if (event.type === "execution_state") return event;
        }
        continue;
      }
      const part = await reader.read();
      assert.equal(part.done, false, "Project SSE closed before execution state");
      buffer += decoder.decode(part.value, { stream: true }).replaceAll("\r\n", "\n");
    }
  } finally { controller.abort(); await reader.cancel().catch(() => {}); }
}

// A separate supervisor starts with an empty in-memory LocalClient map while
// retaining this cookie's real encrypted session, reproducing server restart.
async function checkRestoredCookieConcurrency(cookie: string) {
  const reservation = createServer();
  await new Promise<void>(resolve => reservation.listen(0, "127.0.0.1", resolve));
  const address = reservation.address(); assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  const restoredOrigin = `http://127.0.0.1:${port}`;
  const env: NodeJS.ProcessEnv = { ...process.env, CCAGENT_HOME: fixture.base, CCAGENT_PLATFORM_HOME: fixture.base, CCAGENT_ENV_FILE: path.join(fixture.temp, "empty.env") };
  for (const key of Object.keys(env)) if (/API.?KEY|SECRET|TOKEN/i.test(key) || ["CCAGENT_ACCOUNT_ID", "CCAGENT_AUTH_SESSION_FILE", "CCAGENT_DESKTOP_APP", "NODE_TLS_REJECT_UNAUTHORIZED"].includes(key)) delete env[key];
  const child = spawn(process.execPath, [path.resolve(import.meta.dirname, "../../dist/ccagent.js"), "web", "--workspace", workspace, "--port", String(port)],
    { cwd: fixture.temp, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let logs = "";
  child.stdout!.on("data", data => { logs = (logs + data).slice(-4000); });
  child.stderr!.on("data", data => { logs = (logs + data).slice(-4000); });
  const restoredRequest = (route: string, body?: Record<string, unknown>) => fetch(restoredOrigin + route, {
    method: body ? "POST" : "GET", headers: { cookie, "x-ccagent-workspace": encodeURIComponent(workspace),
      ...(body ? { "content-type": "application/json", "x-ccagent-web": "1", origin: restoredOrigin } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: deadline,
  });
  const restoredJson = async <T>(route: string, body?: Record<string, unknown>, status = 200): Promise<T> => {
    const response = await restoredRequest(route, body);
    assert.equal(response.status, status, await response.clone().text()); return response.json() as Promise<T>;
  };
  try {
    await waitFor(async () => {
      if (child.exitCode !== null) throw new Error(logs);
      try { return (await fetch(restoredOrigin + "/api/health", { signal: deadline })).ok; } catch { return false; }
    }, Boolean, "Restored-cookie supervisor did not start");
    const created = await Promise.all(Array.from({ length: 10 }, () => restoredJson<{ sessionId: string }>("/api/sessions", { model: "whiteboard-fixture", temporary: true }, 201)));
    assert.equal(new Set(created.map(item => item.sessionId)).size, 10);
    const initial = await Promise.all(created.map(item => restoredJson<Snapshot>(`/api/sessions/${item.sessionId}`)));
    assert.ok(initial.every(item => !item.busy && item.messages.length === 0));
    const statuses = await restoredJson<{ activeWorkers: Array<{ workspace: string }> }>("/api/workspaces");
    assert.deepEqual(statuses.activeWorkers.map(item => item.workspace), [workspace]);
    const before = fixture.requests.length;
    await restoredJson(`/api/sessions/${created[0]!.sessionId}/messages`, { text: "HOLD_WEB_RESPONSE restored cookie one execution slot" }, 202);
    await waitFor(fixture.held, value => value === 1, "Restored worker did not reach its local model stream");
    const rejected = await restoredRequest(`/api/sessions/${created[1]!.sessionId}/messages`, { text: "WEB_RESPONSE_COMPLETE duplicate worker must not run" });
    assert.equal(rejected.status, 409);
    const conflict = await rejected.json() as { code: string; activeSessionId: string };
    assert.equal(conflict.code, "TASK_BUSY"); assert.equal(conflict.activeSessionId, created[0]!.sessionId);
    assert.equal(fixture.requests.length, before + 1);
    await restoredJson(`/api/sessions/${created[0]!.sessionId}/interrupt`, {});
    await waitFor(fixture.held, value => value === 0, "Restored worker model stream did not stop");
    pass("ten simultaneous first requests restore one cookie/project worker with every temporary session and one execution slot intact");
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>(resolve => child.once("close", () => resolve()));
      if (child.connected) child.send("ccagent:shutdown", () => {});
      const force = setTimeout(() => {
        if (process.platform === "win32" && child.pid) {
          try { execFileSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); } catch { child.kill(); }
        } else child.kill();
      }, 5000);
      await exited; clearTimeout(force);
    }
  }
}

try {
  const owner = await login(0), other = await login(1);
  const initialBootstrap = await Promise.all(Array.from({ length: 10 }, () => json<Bootstrap>("/api/bootstrap", owner)));
  assert.ok(initialBootstrap.every(item => item.workspace === workspace && item.activeTurn === null));
  assert.deepEqual((await json<{ activeWorkers: Array<{ workspace: string }> }>("/api/workspaces", owner)).activeWorkers.map(item => item.workspace), [workspace]);
  pass("simultaneous first project bootstrap requests share one opened worker");
  const first = await create(owner, workspace), sameProject = await create(owner, workspace);
  await send(first, owner, workspace, "HOLD_WEB_RESPONSE project A retains its process");
  const runningA = await waitFor(() => snapshot(first, owner, workspace), value => value.busy && Boolean(value.execution), "Project A did not start");
  await waitFor(fixture.held, value => value === 1, "Project A did not reach its local model stream");
  assert.equal(fixture.requests.length, 1);

  const selected = await json<Selection>("/api/workspaces/select", owner, workspace, { path: secondWorkspace });
  assert.equal(selected.workspace, await fs.realpath(secondWorkspace));
  assert.equal(selected.activeSessionId, null); assert.equal(selected.preservedBackgroundTasks, true);
  assert.equal((await json<Bootstrap>("/api/bootstrap", owner)).workspace, await fs.realpath(secondWorkspace));
  const afterSwitchA = await snapshot(first, owner, workspace);
  assert.equal(afterSwitchA.busy, true);
  assert.equal(afterSwitchA.execution!.id, runningA.execution!.id);
  assert.equal(afterSwitchA.execution!.startedAt, runningA.execution!.startedAt);
  assert.equal(fixture.held(), 1);
  pass("switching projects while A runs selects B without stopping or recreating A");

  // No project header exercises the selected-project fallback for older callers.
  const second = await create(owner);
  await send(second, owner, secondWorkspace, "HOLD_WEB_RESPONSE project B runs concurrently");
  const runningB = await waitFor(() => snapshot(second, owner, secondWorkspace), value => value.busy && Boolean(value.execution), "Project B did not start");
  await waitFor(fixture.held, value => value === 2, "Both projects must hold independent model streams");
  assert.notEqual(runningA.execution!.id, runningB.execution!.id);
  assert.equal((await snapshot(first, owner, workspace)).busy, true);
  assert.equal((await snapshot(second, owner)).execution!.id, runningB.execution!.id);
  assert.equal(fixture.requests.length, 2);
  pass("one authenticated browser runs real model streams in A and B simultaneously");

  const overview = await json<{ current: string; recent: string[]; activeWorkers: Array<{ workspace: string; busy: boolean; activeSessionId: string | null; pending: string | null }> }>("/api/workspaces", owner);
  assert.equal(overview.current, await fs.realpath(secondWorkspace));
  assert.ok(overview.recent.includes(workspace) && overview.recent.includes(await fs.realpath(secondWorkspace)));
  assert.deepEqual(overview.activeWorkers.map(item => [item.workspace, item.busy, item.activeSessionId, item.pending]).sort(),
    [[workspace, true, first, null], [await fs.realpath(secondWorkspace), true, second, null]].sort());
  const unopened = await request("/api/bootstrap", owner, fixture.secondWorkspace);
  assert.equal(unopened.status, 409);
  assert.equal((await unopened.json() as { code: string }).code, "workspace_not_open");
  assert.equal((await request(`/api/bootstrap?workspace=${encodeURIComponent(secondWorkspace)}`, owner, workspace)).status, 400);
  assert.equal(fixture.held(), 2); assert.equal(fixture.requests.length, 2);
  pass("project overview includes both owners and invalid routing cannot silently launch or retarget a worker");

  const blocked = await request(`/api/sessions/${sameProject}/messages`, owner, workspace, { text: "WEB_RESPONSE_COMPLETE must stay rejected" });
  assert.equal(blocked.status, 409);
  const conflict = await blocked.json() as { code: string; reason: string; activeSessionId: string; canInterrupt: boolean };
  assert.equal(conflict.code, "TASK_BUSY"); assert.equal(conflict.reason, "task_running");
  assert.equal(conflict.activeSessionId, first); assert.equal(conflict.canInterrupt, true);
  assert.equal((await snapshot(sameProject, owner, workspace)).messages.length, 0);
  assert.equal(fixture.requests.length, 2);
  assert.equal((await request(`/api/sessions/${first}`, owner, secondWorkspace)).status, 404);
  assert.equal((await request(`/api/sessions/${second}`, owner, workspace)).status, 404);
  pass("same-project turns remain serial and temporary session state cannot leak between project workers");

  const restoredEvent = await firstExecutionEvent(first, owner, workspace, afterSwitchA.lastEventId);
  assert.equal(restoredEvent.execution!.id, runningA.execution!.id);
  assert.equal(restoredEvent.execution!.startedAt, runningA.execution!.startedAt);
  assert.equal(restoredEvent.execution!.completedAt, null);
  assert.equal(fixture.held(), 2);
  pass("SSE workspace query reconnects to background A while B is foreground");

  const selectedA = await json<Selection>("/api/workspaces/select", owner, secondWorkspace, { path: workspace });
  assert.equal(selectedA.activeSessionId, first); assert.equal(selectedA.preservedBackgroundTasks, true);
  assert.deepEqual(await json<Bootstrap>("/api/bootstrap", owner).then(value => [value.workspace, value.activeTurn]), [workspace, first]);
  const selectedB = await json<Selection>("/api/workspaces/select", owner, workspace, { path: secondWorkspace });
  assert.equal(selectedB.activeSessionId, second); assert.equal(selectedB.preservedBackgroundTasks, true);
  assert.deepEqual(await json<Bootstrap>("/api/bootstrap", owner).then(value => [value.workspace, value.activeTurn]), [await fs.realpath(secondWorkspace), second]);
  assert.equal(fixture.held(), 2); assert.equal(fixture.requests.length, 2);
  pass("project selection identifies the existing active session and bootstrap restores that project's running context");

  assert.equal((await json<{ busy: boolean }>("/api/desktop/status", owner)).busy, true);
  assert.equal((await request(`/api/sessions/${first}`, other, workspace)).status, 404);
  assert.equal((await request(`/api/sessions/${first}/interrupt`, other, workspace, {})).status, 404);
  await json("/api/workspaces/select", other, workspace, { path: secondWorkspace });
  const otherSession = await create(other);
  await send(otherSession, other, secondWorkspace, "WEB_RESPONSE_COMPLETE separate account remains independent");
  const otherFinished = await waitFor(() => snapshot(otherSession, other, secondWorkspace), value => !value.busy && value.lastTurnReason === "completed", "Other account did not finish");
  assert.match(JSON.stringify(otherFinished.messages), /WEB_RESUMED_EXPLICITLY/);
  assert.equal(fixture.held(), 2); assert.equal(fixture.requests.length, 3);
  pass("another account cannot inspect or interrupt A and has an independent worker for the same B folder");

  const stopped = await json<{ interrupted: boolean }>(`/api/sessions/${first}/interrupt`, owner, workspace, {});
  assert.equal(stopped.interrupted, true);
  const stoppedA = await waitFor(() => snapshot(first, owner, workspace), value => !value.busy && value.lastTurnReason === "aborted", "A did not stop");
  await waitFor(fixture.held, value => value === 1, "Stopping A must close exactly one model stream");
  const unaffectedB = await snapshot(second, owner, secondWorkspace);
  assert.equal(unaffectedB.busy, true);
  assert.equal(unaffectedB.execution!.id, runningB.execution!.id);
  assert.equal(unaffectedB.execution!.completedAt, null);
  assert.equal(fixture.requests.length, 3);
  pass("interrupting background A leaves B's original execution and model transport running");

  const returnedA = await json<Selection>("/api/workspaces/select", owner, secondWorkspace, { path: workspace });
  assert.equal(returnedA.activeSessionId, null); assert.equal(returnedA.preservedBackgroundTasks, true);
  const bootstrapA = await json<Bootstrap>("/api/bootstrap", owner);
  assert.equal(bootstrapA.workspace, await fs.realpath(workspace)); assert.equal(bootstrapA.activeTurn, null);
  const restoredA = await snapshot(first, owner);
  assert.deepEqual(restoredA.messages, stoppedA.messages);
  assert.equal(restoredA.execution!.id, runningA.execution!.id);
  assert.equal(restoredA.lastTurnReason, "aborted");
  assert.equal((await json<{ busy: boolean }>("/api/desktop/status", owner)).busy, true, "A is idle but B is still running");
  pass("returning to A restores its transcript and desktop busy status still includes background B");

  await send(sameProject, owner, workspace, "WAIT_WEB_PERMISSION isolated project A approval");
  const waitingA = await waitFor(() => snapshot(sameProject, owner, workspace), value => value.pending?.kind === "permission", "A did not enter pending approval");
  const pendingOverview = await json<{ activeWorkers: Array<{ workspace: string; busy: boolean; activeSessionId: string | null; pending: string | null }> }>("/api/workspaces", owner);
  const projectAStatus = pendingOverview.activeWorkers.find(item => item.workspace === workspace)!;
  assert.equal(projectAStatus.activeSessionId, sameProject); assert.equal(projectAStatus.pending, "permission"); assert.equal(projectAStatus.busy, true);
  const projectBStatus = pendingOverview.activeWorkers.find(item => item.workspace === secondWorkspace)!;
  assert.equal(projectBStatus.activeSessionId, second); assert.equal(projectBStatus.pending, null); assert.equal(projectBStatus.busy, true);
  const approvalId = waitingA.pending!.id;
  assert.ok(approvalId);
  assert.equal((await request(`/api/sessions/${sameProject}/respond`, owner, secondWorkspace, { id: approvalId, decision: "allow_once" })).status, 404);
  assert.equal((await request(`/api/sessions/${second}/respond`, owner, secondWorkspace, { id: approvalId, decision: "allow_once" })).status, 409);
  assert.equal((await snapshot(sameProject, owner, workspace)).pending?.kind, "permission");
  assert.equal((await snapshot(second, owner, secondWorkspace)).execution!.id, runningB.execution!.id);
  await json(`/api/sessions/${sameProject}/interrupt`, owner, workspace, {});
  await waitFor(() => snapshot(sameProject, owner, workspace), value => !value.busy && value.pending === null, "A's pending approval did not stop");
  assert.equal(await fs.stat(path.join(workspace, "permission-must-not-exist.txt")).then(() => true, () => false), false);
  assert.equal(fixture.held(), 1);
  pass("pending approval belongs only to A and cannot be accepted through B or interfere with B's running task");

  await send(sameProject, owner, workspace, "HOLD_WEB_RESPONSE A task after releasing its slot");
  await waitFor(fixture.held, value => value === 2, "A must reuse its released execution slot while B runs");
  assert.equal((await snapshot(second, owner, secondWorkspace)).execution!.id, runningB.execution!.id);
  pass("A can start its next explicit task while the original B task continues");

  await json("/api/account/logout", owner, undefined, {});
  await waitFor(fixture.held, value => value === 0, "Logout must close both project model streams");
  assert.equal((await request(`/api/sessions/${first}`, owner, workspace)).status, 401);
  assert.equal((await request(`/api/sessions/${second}`, owner, secondWorkspace)).status, 401);
  assert.equal((await snapshot(otherSession, other, secondWorkspace)).lastTurnReason, "completed");
  pass("logout stops every owned project worker and leaves the other account authenticated");

  const returningOwner = await login(0);
  await checkRestoredCookieConcurrency(returningOwner);
  const loginA = await create(returningOwner, workspace);
  await send(loginA, returningOwner, workspace, "HOLD_WEB_RESPONSE A before changing account");
  await json("/api/workspaces/select", returningOwner, workspace, { path: secondWorkspace });
  const loginB = await create(returningOwner, secondWorkspace);
  await send(loginB, returningOwner, secondWorkspace, "HOLD_WEB_RESPONSE B before changing account");
  await waitFor(fixture.held, value => value === 2, "Both old identity workers must run before account change");
  const replacement = await login(1, returningOwner);
  assert.notEqual(replacement, returningOwner);
  await waitFor(fixture.held, value => value === 0, "Changing account must close every old identity model stream");
  assert.equal((await request(`/api/sessions/${loginA}`, returningOwner, workspace)).status, 401);
  assert.equal((await request(`/api/sessions/${loginB}`, returningOwner, secondWorkspace)).status, 401);
  assert.equal((await request(`/api/sessions/${loginA}`, replacement, workspace)).status, 404);
  await json("/api/workspaces/select", replacement, workspace, { path: secondWorkspace });
  assert.equal((await request(`/api/sessions/${loginB}`, replacement, secondWorkspace)).status, 404);
  assert.equal((await snapshot(otherSession, other, secondWorkspace)).lastTurnReason, "completed");
  await json("/api/account/logout", replacement, undefined, {});
  pass("signing into another account stops both previous project workers and neither old cookie nor replacement identity can access their sessions");

  console.log(`${checks} project-worker checks passed; actual supervisor/QueryEngine with synthetic local auth/model only.`);
} finally { await fixture.close(); }
