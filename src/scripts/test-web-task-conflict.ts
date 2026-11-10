/** Real supervisor/worker lock ownership with an unapproved, never-executed fixture tool. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { startWhiteboardAIFixture } from "./helpers/whiteboardAIFixture.js";

const fixture = await startWhiteboardAIFixture();
const deadline = AbortSignal.timeout(45000);
let checks = 0;
async function request(route: string, cookie: string, body?: Record<string, unknown>) {
  return fetch(fixture.origin + route, { method: body ? "POST" : "GET", headers: { cookie,
    ...(body ? { "content-type": "application/json", "x-ccagent-web": "1", origin: fixture.origin } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: deadline });
}
async function login(index: number) {
  const response = await request("/api/account/login", "", { email: fixture.account.users[index]!.email, password: fixture.account.password });
  assert.equal(response.status, 200); return response.headers.get("set-cookie")!.split(";")[0]!;
}
async function create(cookie: string) {
  const response = await request("/api/sessions", cookie, { model: "whiteboard-fixture", temporary: true });
  assert.equal(response.status, 201); return (await response.json() as { sessionId: string }).sessionId;
}
type Snapshot = { sessionId: string; busy: boolean; pending: { kind: string } | null; messages: unknown[]; lastTurnReason: string | null };
async function snapshot(id: string, cookie: string): Promise<Snapshot> {
  const response = await request(`/api/sessions/${id}`, cookie); assert.equal(response.status, 200); return response.json() as Promise<Snapshot>;
}
async function until(id: string, cookie: string, predicate: (value: Snapshot) => boolean) {
  for (let n = 0; n < 150; n++) {
    const value = await snapshot(id, cookie); if (predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error("Expected isolated task state did not arrive");
}
const pass = (message: string) => { console.log(`PASS ${++checks} ${message}`); };
try {
  const owner = await login(0), other = await login(1), first = await create(owner), next = await create(owner);
  const send = (id: string, text: string) => request(`/api/sessions/${id}/messages`, owner, { text });
  assert.equal((await send(first, "WAIT_WEB_PERMISSION isolated task")).status, 202);
  await until(first, owner, value => value.pending?.kind === "permission");
  const blocked = await send(next, "WEB_RESPONSE_COMPLETE next explicit task");
  assert.equal(blocked.status, 409);
  const conflict = await blocked.json() as Record<string, unknown>;
  assert.deepEqual(Object.keys(conflict).sort(), ["activeSessionId", "canInterrupt", "code", "error", "reason"]);
  assert.equal(conflict.code, "TASK_BUSY"); assert.equal(conflict.reason, "waiting_permission");
  assert.equal(conflict.activeSessionId, first); assert.equal(conflict.canInterrupt, true);
  assert.match(String(conflict.error), /授权/);
  assert.equal(JSON.stringify(conflict).includes("permission-must-not-exist"), false);
  assert.equal((await snapshot(next, owner)).messages.length, 0); assert.equal(fixture.requests.length, 1);
  pass("a blocked new conversation identifies the waiting permission owner without executing or persisting its message");
  assert.equal((await request(`/api/sessions/${first}`, other)).status, 404);
  const otherSession = await create(other);
  assert.equal((await request(`/api/sessions/${otherSession}/messages`, other, { text: "/help" })).status, 202);
  await until(otherSession, other, value => !value.busy);
  assert.equal((await snapshot(first, owner)).pending?.kind, "permission");
  pass("another account cannot inspect the blocker and retains its own independent execution slot");
  const stopped = await request(`/api/sessions/${first}/interrupt`, owner, {});
  assert.equal(stopped.status, 200); assert.equal((await stopped.json() as { interrupted: boolean }).interrupted, true);
  const after = await until(first, owner, value => !value.busy);
  assert.equal(after.pending, null); assert.equal(after.lastTurnReason, "aborted");
  assert.equal(fixture.requests.length, 1);
  assert.equal(await fs.stat(path.join(fixture.workspace, "permission-must-not-exist.txt")).then(() => true, () => false), false);
  pass("stopping the waiting task releases the slot without approving the tool or resuming a model call");
  assert.equal((await send(next, "WEB_RESPONSE_COMPLETE next explicit task")).status, 202);
  const finished = await until(next, owner, value => !value.busy);
  assert.equal(finished.lastTurnReason, "completed"); assert.equal(fixture.requests.length, 2);
  pass("the new conversation starts exactly once after an explicit resend");
  assert.equal((await send(first, "HOLD_WEB_RESPONSE lock description")).status, 202);
  for (let n = 0; n < 150 && !fixture.held(); n++) await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(fixture.held(), 1);
  const running = await send(next, "WEB_RESPONSE_COMPLETE still blocked"); assert.equal(running.status, 409);
  const busy = await running.json() as Record<string, unknown>;
  assert.equal(busy.reason, "task_running"); assert.equal(busy.activeSessionId, first); assert.equal(busy.canInterrupt, true);
  await request(`/api/sessions/${first}/interrupt`, owner, {});
  await until(first, owner, value => !value.busy);
  assert.equal(fixture.requests.length, 3);
  pass("a running task also reports its actual owner and is stopped without replaying a rejected message");
  console.log(`${checks} task conflict checks passed; synthetic auth/model only, no cloud inference or real file write.`);
} finally { await fixture.close(); }
