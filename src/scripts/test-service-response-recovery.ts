import assert from "node:assert/strict";
import { recoverableResponseBody } from "../platform/recoverableResponse.js";
import { parseDeepSeekChatStream } from "../services/api/providers/deepseekChat.js";

const encoder = new TextEncoder();
const headers = { "content-type": "text/event-stream; charset=utf-8", "x-ccagent-call-id": "original-call" };
function stream(chunks: Uint8Array[], fail = false) {
  let index = 0;
  return new ReadableStream<Uint8Array>({ pull(controller) {
    if (index < chunks.length) controller.enqueue(chunks[index++]!);
    else if (fail) controller.error(new Error("connection lost"));
    else controller.close();
  } }, { highWaterMark: 0 });
}
function fixture(prefix: Uint8Array, saved: Uint8Array[], options: { pending?: boolean; failReplay?: boolean; invalidIdentity?: boolean; signal?: AbortSignal } = {}) {
  const counts = { replays: 0, completed: 0, interrupted: 0, cancelled: 0 };
  const response = new Response(stream([prefix], true), { headers });
  const body = recoverableResponseBody(response, {
    signal: options.signal,
    replay: async () => {
      counts.replays++;
      return options.pending ? null : new Response(stream(saved, options.failReplay), { headers: { ...headers, "x-ccagent-replay": "true", ...(options.invalidIdentity ? { "x-ccagent-call-id": "another-call" } : {}) } });
    },
    complete: async () => { counts.completed++; },
    interrupted: async () => { counts.interrupted++; return new Error("result unconfirmed"); },
    cancelled: async () => { counts.cancelled++; },
  });
  return { counts, body };
}
const event = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const sse = event({ id: "reply", choices: [{ delta: { tool_calls: [{ index: 0, id: "floor-1", function: { name: "RhinoAction", arguments: '{"name":"楼板"}' } }] }, finish_reason: null }] })
  + event({ choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 1, completion_tokens: 2 } }) + "data: [DONE]\n\n";
const bytes = encoder.encode(sse), cut = Buffer.from(bytes).indexOf(Buffer.from("楼板")) + 1;
{
  const { body, counts } = fixture(bytes.subarray(0, cut), [bytes.subarray(0, 19), bytes.subarray(19, cut + 3), bytes.subarray(cut + 3)]);
  const events = [];
  for await (const value of parseDeepSeekChatStream(body, { waitForEOF: true })) events.push(value);
  assert.equal(events.filter(e => e.type === "tool_call_start").length, 1);
  assert.equal(events.filter(e => e.type === "tool_call_end").length, 1);
  assert.equal(events.filter(e => e.type === "message_end").length, 1);
  assert.deepEqual(counts, { replays: 1, completed: 1, interrupted: 0, cancelled: 0 });
}
for (const saved of [[bytes.subarray(0, cut)], [encoder.encode("changed response")], [bytes.subarray(0, 10)]]) {
  const { body, counts } = fixture(bytes.subarray(0, cut), saved);
  if (saved[0]!.length === cut) assert.equal(await new Response(body).text(), new TextDecoder().decode(bytes.subarray(0, cut)));
  else await assert.rejects(new Response(body).text(), /unconfirmed/);
  assert.equal(counts.replays, 1);
}
for (const options of [{ pending: true }, { invalidIdentity: true }, { failReplay: true }]) {
  const { body, counts } = fixture(bytes.subarray(0, cut), [bytes], options);
  await assert.rejects(new Response(body).text(), /unconfirmed/);
  assert.equal(counts.replays, 1);
  assert.equal(counts.completed, 0);
}
{
  const abort = new AbortController();
  const { body, counts } = fixture(bytes.subarray(0, cut), [bytes], { signal: abort.signal });
  const reader = body.getReader(); await reader.read(); abort.abort();
  await assert.rejects(reader.read(), /unconfirmed/);
  assert.equal(counts.replays, 0);
}
{
  const { body, counts } = fixture(bytes.subarray(0, cut), [bytes]);
  await body.cancel();
  assert.deepEqual(counts, { replays: 0, completed: 0, interrupted: 0, cancelled: 1 });
}
console.log("PASS saved-response recovery: UTF-8/SSE boundaries, one tool dispatch, identity/prefix checks, pending, abort and bounded replay");
