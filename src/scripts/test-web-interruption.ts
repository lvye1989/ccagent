/** Actual Web supervisor/worker/QueryEngine HTTP cancellation; auth and model are isolated fixtures. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { startWhiteboardAIFixture } from "./helpers/whiteboardAIFixture.js";

const fixture = await startWhiteboardAIFixture(), { origin } = fixture;
const deadline = AbortSignal.timeout(45000);
const pause = () => new Promise(resolve => setTimeout(resolve, 50));
let checks = 0;
type WebEvent = { type: string; reason?: string; text?: string; name?: string };
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
try {
  const owner = await login(0), other = await login(1);
  const created = await request("/api/sessions", owner, { model: "whiteboard-fixture", temporary: true });
  assert.equal(created.status, 201); const { sessionId } = await created.json() as { sessionId: string };
  const turn = (text: string) => request(`/api/sessions/${sessionId}/messages`, owner, { text });
  const stop = (cookie = owner) => request(`/api/sessions/${sessionId}/interrupt`, cookie, {});
  let feed = await openFeed(sessionId, owner);
  assert.equal((await turn("HOLD_WEB_RESPONSE first interruption")).status, 202);
  await until(feed, event => event.type === "text" && event.text === "PARTIAL_WEB_RESPONSE");
  assert.equal(fixture.requests.length, 1); assert.equal(fixture.held(), 1);
  assert.equal((await stop(other)).status, 404); assert.equal(fixture.held(), 1);
  assert.equal((await (await request(`/api/sessions/${sessionId}`, owner)).json() as { busy: boolean }).busy, true);
  pass("another logged-in account cannot interrupt the owner's active engine");
  const stopping = await stop(); assert.equal(stopping.status, 200); assert.equal((await stopping.json() as { interrupted: boolean }).interrupted, true);
  assert.equal((await until(feed, event => event.type === "turn_complete")).reason, "aborted");
  await released(); assert.equal(fixture.requests.length, 1);
  assert.equal((await (await stop()).json() as { interrupted: boolean }).interrupted, false);
  pass("mid-text stop aborts the model transport once without retrying the generation");
  assert.equal((await turn("WEB_RESPONSE_COMPLETE continue only after explicit user input")).status, 202);
  await until(feed, event => event.type === "text" && event.text === "WEB_RESUMED_EXPLICITLY");
  assert.equal((await until(feed, event => event.type === "turn_complete")).reason, "completed");
  assert.equal(fixture.requests.length, 2); pass("the stopped session accepts a subsequent explicit turn");
  assert.equal((await turn("HOLD_WEB_RESPONSE browser disconnect")).status, 202);
  await until(feed, event => event.type === "text" && event.text === "PARTIAL_WEB_RESPONSE");
  const lastId = feed.lastId(); await feed.close();
  assert.equal((await (await request(`/api/sessions/${sessionId}`, owner)).json() as { busy: boolean }).busy, true);
  assert.equal(fixture.held(), 1); assert.equal(fixture.requests.length, 3);
  feed = await openFeed(sessionId, owner, lastId);
  assert.equal((await stop()).status, 200); assert.equal((await until(feed, event => event.type === "turn_complete")).reason, "aborted");
  await released(); assert.equal(fixture.requests.length, 3);
  pass("closing and reconnecting the event stream does not restart or silently stop the model");
  assert.equal((await turn("HOLD_WEB_TOOL stop before a complete tool response")).status, 202);
  await until(feed, event => event.type === "tool_start" && event.name === "Write");
  assert.equal((await stop()).status, 200); assert.equal((await until(feed, event => event.type === "turn_complete")).reason, "aborted");
  await released(); assert.equal(fixture.requests.length, 4);
  assert.equal(await fs.stat(path.join(fixture.workspace, "must-not-exist.txt")).then(() => true, () => false), false);
  const state = await (await request(`/api/sessions/${sessionId}`, owner)).json() as { busy: boolean; lastTurnReason: string };
  assert.equal(state.busy, false); assert.equal(state.lastTurnReason, "aborted");
  pass("an interrupted tool stream cannot execute a file write or leave the session busy");
  console.log(`${checks} Web interruption checks passed (actual QueryEngine and HTTP; synthetic auth/model, no cloud settlement or provider charge).`);
} finally {
  await Promise.allSettled(feeds.map(feed => feed.close()));
  await fixture.close();
}
