/** Actual Web supervisor/worker/QueryEngine HTTP cancellation; auth and model are isolated fixtures. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { startWhiteboardAIFixture } from "./helpers/whiteboardAIFixture.js";

const fixture = await startWhiteboardAIFixture(), { origin } = fixture;
const deadline = AbortSignal.timeout(45000);
const pause = () => new Promise(resolve => setTimeout(resolve, 50));
let checks = 0;
type Execution = { id: string; startedAt: string; completedAt: string | null; reason: string | null;
  tools: Array<{ id: string; name: string; startedAt: string; completedAt: string | null; phase?: string; isError?: boolean }> };
type WebEvent = { type: string; id?: string; reason?: string; text?: string; name?: string; timestamp: string; turnId?: string;
  startedAt?: string; completedAt?: string; isError?: boolean; execution?: Execution | null; serverTime?: string };
type EventFeed = { next: () => Promise<WebEvent>; close: () => Promise<void>; lastId: () => number };
const feeds: EventFeed[] = [];
async function request(route: string, cookie: string, body?: Record<string, unknown>) {
  return fetch(origin + route, { method: body ? "POST" : "GET", headers: { cookie,
    ...(body ? { "content-type": "application/json", "x-ccagent-web": "1", origin } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: deadline });
}
async function login(index: number) {
  const response = await request("/api/account/login", "", { email: fixture.account.users[index]!.email, password: fixture.account.password });
  assert.equal(response.status, 200); return response.headers.get("set-cookie")!.split(";")[0]!;
}
async function openFeed(id: string, cookie: string, after = 0): Promise<EventFeed> {
  const controller = new AbortController();
  const response = await fetch(`${origin}/api/sessions/${id}/events?lastEventId=${after}`, { headers: { cookie }, signal: AbortSignal.any([deadline, controller.signal]) });
  assert.equal(response.status, 200); const reader = response.body!.getReader(), decoder = new TextDecoder(); let buffer = "", lastId = after;
  const feed = {
    lastId: () => lastId,
    async next(): Promise<WebEvent> {
      while (true) {
        const boundary = buffer.indexOf("\n\n");
        if (boundary >= 0) {
          const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
          const id = /^id: (\d+)$/m.exec(frame), data = /^data: (.*)$/m.exec(frame);
          if (id) lastId = Number(id[1]);
          if (data) return JSON.parse(data[1]!) as WebEvent;
          continue;
        }
        const part = await reader.read(); assert.equal(part.done, false, "SSE ended before the expected engine event");
        buffer += decoder.decode(part.value, { stream: true }).replaceAll("\r\n", "\n");
      }
    },
    async close() { controller.abort(); await reader.cancel().catch(() => {}); },
  };
  feeds.push(feed); return feed;
}
async function until(feed: EventFeed, predicate: (event: WebEvent) => boolean) {
  for (let count = 0; count < 500; count++) { const event = await feed.next(); if (predicate(event)) return event; }
  throw new Error("Expected Web event missing");
}
async function released() {
  for (let count = 0; count < 100 && fixture.held(); count++) await pause();
  assert.equal(fixture.held(), 0, "Stop must close the active model connection");
}
const pass = (label: string) => { console.log(`PASS ${++checks} ${label}`); };
const iso = (value: string | undefined) => { assert.ok(value); assert.equal(new Date(value).toISOString(), value); return Date.parse(value); };
try {
  const owner = await login(0), other = await login(1);
  const created = await request("/api/sessions", owner, { model: "whiteboard-fixture", temporary: true });
  assert.equal(created.status, 201); const { sessionId } = await created.json() as { sessionId: string };
  const turn = (text: string) => request(`/api/sessions/${sessionId}/messages`, owner, { text });
  const stop = (cookie = owner) => request(`/api/sessions/${sessionId}/interrupt`, cookie, {});
  const snapshot = async () => {
    const response = await request(`/api/sessions/${sessionId}`, owner); assert.equal(response.status, 200);
    return response.json() as Promise<{ busy: boolean; execution: Execution | null; serverTime: string; lastTurnReason: string }>;
  };
  assert.equal((await snapshot()).execution, null, "a session without a turn has no invented execution time");
  let feed = await openFeed(sessionId, owner);
  assert.equal((await turn("HOLD_WEB_RESPONSE first interruption")).status, 202);
  const firstStart = await until(feed, event => event.type === "turn_started");
  assert.match(firstStart.turnId!, /^[0-9a-f-]{36}$/); assert.equal(firstStart.startedAt, firstStart.timestamp); iso(firstStart.timestamp);
  const firstUser = await until(feed, event => event.type === "user");
  assert.equal(firstUser.turnId, firstStart.turnId); assert.ok(iso(firstUser.timestamp) >= iso(firstStart.timestamp));
  await until(feed, event => event.type === "text" && event.text === "PARTIAL_WEB_RESPONSE");
  assert.equal(fixture.requests.length, 1); assert.equal(fixture.held(), 1);
  assert.equal((await stop(other)).status, 404); assert.equal(fixture.held(), 1);
  const firstRunning = await snapshot(); assert.equal(firstRunning.busy, true); assert.equal(firstRunning.execution!.id, firstStart.turnId);
  assert.equal(firstRunning.execution!.startedAt, firstStart.timestamp); assert.equal(firstRunning.execution!.completedAt, null);
  assert.equal(firstRunning.execution!.reason, null); assert.deepEqual(firstRunning.execution!.tools, []); iso(firstRunning.serverTime);
  pass("another logged-in account cannot interrupt the owner's active engine");
  const stopping = await stop(); assert.equal(stopping.status, 200); assert.equal((await stopping.json() as { interrupted: boolean }).interrupted, true);
  const firstComplete = await until(feed, event => event.type === "turn_complete"); assert.equal(firstComplete.reason, "aborted");
  assert.equal(firstComplete.turnId, firstStart.turnId); assert.equal(firstComplete.completedAt, firstComplete.timestamp);
  assert.ok(iso(firstComplete.timestamp) >= iso(firstStart.timestamp));
  const stopped = await snapshot(); assert.equal(stopped.execution!.startedAt, firstStart.timestamp);
  assert.equal(stopped.execution!.completedAt, firstComplete.timestamp); assert.equal(stopped.execution!.reason, "aborted");
  await released(); assert.equal(fixture.requests.length, 1);
  assert.equal((await (await stop()).json() as { interrupted: boolean }).interrupted, false);
  pass("mid-text stop aborts the model transport once without retrying the generation");
  assert.equal((await turn("WEB_RESPONSE_COMPLETE continue only after explicit user input")).status, 202);
  const secondStart = await until(feed, event => event.type === "turn_started"); assert.notEqual(secondStart.turnId, firstStart.turnId);
  assert.ok(iso(secondStart.timestamp) >= iso(firstComplete.timestamp));
  await until(feed, event => event.type === "text" && event.text === "WEB_RESUMED_EXPLICITLY");
  const secondComplete = await until(feed, event => event.type === "turn_complete"); assert.equal(secondComplete.reason, "completed");
  const completed = await snapshot(); assert.equal(completed.execution!.id, secondStart.turnId); assert.equal(completed.execution!.reason, "completed");
  assert.equal(completed.execution!.completedAt, secondComplete.timestamp); assert.deepEqual(completed.execution!.tools, []);
  assert.equal(fixture.requests.length, 2); pass("the stopped session accepts a subsequent explicit turn");
  assert.equal((await turn("HOLD_WEB_RESPONSE browser disconnect")).status, 202);
  const reconnectStart = await until(feed, event => event.type === "turn_started");
  await until(feed, event => event.type === "text" && event.text === "PARTIAL_WEB_RESPONSE");
  const lastId = feed.lastId(); await feed.close();
  await pause();
  const disconnected = await snapshot(); assert.equal(disconnected.busy, true);
  assert.equal(disconnected.execution!.startedAt, reconnectStart.timestamp); assert.equal(disconnected.execution!.id, reconnectStart.turnId);
  assert.ok(iso(disconnected.serverTime) > iso(reconnectStart.timestamp), "elapsed origin precedes reconnection and must not reset to now");
  assert.equal(fixture.held(), 1); assert.equal(fixture.requests.length, 3);
  feed = await openFeed(sessionId, owner, lastId);
  const restored = await until(feed, event => event.type === "execution_state");
  assert.equal(restored.execution!.startedAt, reconnectStart.timestamp); assert.equal(restored.execution!.id, reconnectStart.turnId);
  assert.equal(restored.turnId, reconnectStart.turnId); assert.equal(restored.execution!.completedAt, null);
  assert.equal(restored.timestamp, restored.serverTime); iso(restored.serverTime);
  assert.equal((await stop()).status, 200); assert.equal((await until(feed, event => event.type === "turn_complete")).reason, "aborted");
  await released(); assert.equal(fixture.requests.length, 3);
  pass("closing and reconnecting the event stream does not restart or silently stop the model");
  assert.equal((await turn("HOLD_WEB_TOOL stop before a complete tool response")).status, 202);
  const toolStart = await until(feed, event => event.type === "tool_preparing" && event.name === "Write");
  const calling = await snapshot(), pendingTool = calling.execution!.tools.find(tool => tool.id === toolStart.id)!;
  assert.equal(pendingTool.name, "Write"); assert.equal(pendingTool.startedAt, toolStart.timestamp); assert.equal(pendingTool.completedAt, null);
  assert.equal(pendingTool.phase, "preparing", "an incomplete model stream must not claim that the tool is executing");
  assert.equal(calling.execution!.id, toolStart.turnId);
  assert.deepEqual(Object.keys(pendingTool).sort(), ["completedAt", "id", "name", "phase", "startedAt"], "snapshot excludes tool arguments, commands and model reasoning");
  assert.equal((await stop()).status, 200); assert.equal((await until(feed, event => event.type === "turn_complete")).reason, "aborted");
  await released(); assert.equal(fixture.requests.length, 4);
  assert.equal(await fs.stat(path.join(fixture.workspace, "must-not-exist.txt")).then(() => true, () => false), false);
  const state = await snapshot();
  assert.equal(state.busy, false); assert.equal(state.lastTurnReason, "aborted");
  assert.equal(state.execution!.tools[0]!.completedAt, null, "an interrupted call without tool_done has no fabricated completion");
  assert.equal(state.execution!.tools[0]!.isError, undefined); assert.ok(state.execution!.completedAt);
  pass("an interrupted tool stream cannot execute a file write or leave the session busy");
  assert.equal((await turn("Synthetic unknown-tool result lifecycle")).status, 202);
  // The model fixture asks for unavailable whiteboard tools: the real engine returns safe errors, never executes a shell or file write.
  const toolDone = await until(feed, event => event.type === "tool_done" && event.name === "WhiteboardRead");
  assert.equal(toolDone.isError, true); iso(toolDone.timestamp);
  const finalEvent = await until(feed, event => event.type === "turn_complete"); assert.equal(finalEvent.reason, "completed");
  const finished = await snapshot(), finishedTool = finished.execution!.tools.find(tool => tool.id === toolDone.id)!;
  assert.equal(finished.execution!.id, toolDone.turnId); assert.equal(finishedTool.completedAt, toolDone.timestamp); assert.equal(finishedTool.isError, true);
  assert.ok(iso(finishedTool.completedAt!) >= iso(finishedTool.startedAt));
  assert.equal(finished.execution!.completedAt, finalEvent.timestamp); assert.ok(finished.execution!.tools.every(tool => tool.completedAt));
  assert.ok(finished.execution!.tools.every(tool => !Object.hasOwn(tool, "input") && !Object.hasOwn(tool, "command")));
  pass("real tool results retain server timestamps, error status and a bounded per-turn state without argument disclosure");
  console.log(`${checks} Web interruption checks passed (actual QueryEngine and HTTP; synthetic auth/model, no cloud settlement or provider charge).`);
} finally {
  await Promise.allSettled(feeds.map(feed => feed.close()));
  await fixture.close();
}
