import assert from "node:assert/strict";
import { assembleOpenAIResponses } from "../services/api/providers/openaiResponsesNative.js";

const sse = (events: Record<string, unknown>[], named = true) => new ReadableStream<Uint8Array>({
  start(controller) {
    for (const event of events) controller.enqueue(new TextEncoder().encode(`${named ? `event: ${event.type}\n` : ""}data: ${JSON.stringify(event)}\n\n`));
    controller.close();
  },
});
async function collect(events: Record<string, unknown>[], named = true) {
  const stream = assembleOpenAIResponses(sse(events, named));
  while (true) { const next = await stream.next(); if (next.done) return next.value; }
}
const text = { type: "response.output_text.delta", delta: "fixture answer" };
const completed = { type: "response.completed", response: { status: "completed", usage: { input_tokens: 12, output_tokens: 3 } } };
let checks = 0;
async function check(name: string, action: () => Promise<unknown>) { await action(); checks++; console.log(`[PASS] ${name}`); }
await check("Named SSE completion works", async () => assert.equal((await collect([text, completed])).stopReason, "completed"));
await check("Data-only SSE uses JSON event type", async () => assert.equal((await collect([text, completed], false)).usage.input_tokens, 12));
await check("Empty SSE is an error, not success", () => assert.rejects(collect([]), /without a terminal/));
await check("Truncated text is an error, not success", () => assert.rejects(collect([text]), /without a terminal/));
await check("Empty completed result is an error", () => assert.rejects(collect([completed]), /empty completed/));
await check("Thinking-only result cannot complete a task", () => assert.rejects(collect([{ type: "response.reasoning_summary_text.delta", delta: "Still planning" }, completed]), /empty completed/));
await check("Failed Responses events surface the provider error", () => assert.rejects(collect([{ type: "response.failed", response: { error: { message: "fixture failure" } } }]), /fixture failure/));
await check("Unknown incomplete response is not completion", () => assert.rejects(collect([{ type: "response.incomplete", response: { incomplete_details: { reason: "content_filter" } } }]), /incomplete/));
await check("Token limit preserves the recovery stop reason", async () => assert.equal((await collect([{ type: "response.incomplete", response: { incomplete_details: { reason: "max_output_tokens" }, usage: { input_tokens: 10, output_tokens: 100 } } }])).stopReason, "max_tokens"));
const tool = { type: "response.output_item.added", output_index: 0, item: { type: "function_call", call_id: "fixture-call", name: "RhinoAction" } };
await check("Truncated tool calls cannot dispatch", () => assert.rejects(collect([tool]), /without a terminal/));
await check("Token-limited tool calls cannot dispatch", async () => assert.equal((await collect([tool, { type: "response.incomplete", response: { incomplete_details: { reason: "max_output_tokens" } } }])).stopReason, "max_tokens"));
console.log(`All ${checks} Responses completion checks passed.`);
