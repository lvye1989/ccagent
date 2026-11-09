/** Offline regression for DeepSeek thinking + tools. No provider or billable calls. */
import assert from "node:assert/strict";
import { parseOpenAIStream, type UniversalStreamEvent } from "llm-bridge";
import { applyDeepSeekHistory, deepseekReasoningEndpoint, isDeepSeekProfile, parseDeepSeekChatStream } from "../services/api/providers/deepseekChat.js";
import { prepareRequest, streamViaProvider } from "../services/api/providers/providerStream.js";
import type { ModelProfile } from "../services/api/providers/profile.js";
import type { StreamRequestParams, StreamResult } from "../services/api/streaming.js";
import { normalizeMessagesForAPI } from "../services/api/streaming.js";
import { setSessionEffortLevel, setSessionThinkingConfig } from "../utils/thinking.js";

const profile: ModelProfile & { upstreamProvider?: string } = {
  id: "fixture-deepseek", protocol: "openai-chat", model: "deepseek-flash", baseURL: "https://api.deepseek.com", upstreamProvider: "deepseek",
};
const tool = { name: "Echo", description: "Echo a fixture string", input_schema: { type: "object" as const, properties: { text: { type: "string" } }, required: ["text"] } };
const reasoning = "检查工具结果，继续完成任务。";
const endpoint = deepseekReasoningEndpoint(profile);
let checks = 0;
async function check(name: string, run: () => unknown | Promise<unknown>): Promise<void> { await run(); checks++; console.log(`[pass] ${name}`); }

function sse(payloads: unknown[], done = true): string {
  return payloads.map(value => `data: ${JSON.stringify(value)}\r\n\r\n`).join("") + (done ? "data: [DONE]\r\n\r\n" : "");
}
function wire(text: string, bytesPerChunk = 7): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({ start(controller) {
    for (let offset = 0; offset < bytes.length; offset += bytesPerChunk) controller.enqueue(bytes.slice(offset, offset + bytesPerChunk));
    controller.close();
  } });
}
const chunk = (delta: unknown, finish_reason: string | null = null) => ({ id: "fixture-message", model: "deepseek-flash", choices: [{ delta, finish_reason }] });
const usage = { id: "fixture-message", choices: [], usage: { prompt_tokens: 12, completion_tokens: 7 } };
const firstFrames = [chunk({ reasoning_content: reasoning }), chunk({ tool_calls: [{ index: 0, id: "call_fixture", type: "function", function: { name: "Echo", arguments: '{"text":"合成结果"}' } }] }), chunk({}, "tool_calls"), usage];
async function collect(source: AsyncGenerator<UniversalStreamEvent>): Promise<UniversalStreamEvent[]> { const values: UniversalStreamEvent[] = []; for await (const value of source) values.push(value); return values; }
async function drain(params: StreamRequestParams): Promise<StreamResult> {
  const stream = streamViaProvider(profile, params);
  while (true) { const next = await stream.next(); if (next.done) return next.value; }
}

await check("DeepSeek detection is supplier scoped and excludes Ollama", () => {
  assert.equal(isDeepSeekProfile(profile), true);
  assert.equal(isDeepSeekProfile({ ...profile, model: "catalog-alias" }), true);
  assert.equal(isDeepSeekProfile({ ...profile, upstreamProvider: "qwen" }), false);
  assert.equal(isDeepSeekProfile({ ...profile, provider: "ollama" }), false);
  assert.equal(isDeepSeekProfile({ ...profile, protocol: "openai-responses" }), false);
  assert.equal(isDeepSeekProfile({ protocol: "openai-chat", model: "gpt-fixture", baseURL: "https://api.openai.com/v1" }), false);
  assert.equal(isDeepSeekProfile({ protocol: "openai-chat", model: "alias", platformService: "deepseek-main" }), true);
  assert.equal(isDeepSeekProfile({ protocol: "openai-chat", model: "deepseek-flash", baseURL: "http://127.0.0.1:10001/v1" }), true);
  assert.equal(deepseekReasoningEndpoint({ ...profile, baseURL: "https://api.deepseek.com/" }), endpoint);
});

await check("reproduces old parser loss and preserves actual reasoning with the native parser", async () => {
  const old = await collect(parseOpenAIStream(wire(sse(firstFrames))));
  assert.equal(old.some(event => event.type === "content_delta" && event.delta.thinking), false);
  const events = await collect(parseDeepSeekChatStream(wire(sse(firstFrames), 1)));
  assert.equal(events.filter(event => event.type === "content_delta").map(event => event.type === "content_delta" ? event.delta.thinking ?? "" : "").join(""), reasoning);
  assert.equal(events.filter(event => event.type === "message_end").length, 1);
  assert.deepEqual(events.at(-1), { type: "message_end", stop_reason: "tool_calls", usage: { input_tokens: 12, output_tokens: 7 } });
});

await check("parallel tool ids and split JSON remain paired", async () => {
  const events = await collect(parseDeepSeekChatStream(wire(sse([
    chunk({ reasoning_content: "第一段" }),
    chunk({ tool_calls: [{ index: 1, id: "call_b", function: { name: "Second", arguments: '{"b":' } }, { index: 0, id: "call_a", function: { name: "First", arguments: '{"a":' } }] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: "1}" } }, { index: 1, function: { arguments: "2}" } }] }),
    chunk({}, "tool_calls"), usage,
  ]))));
  const argumentsById = new Map<string, string>();
  for (const event of events) if (event.type === "tool_call_delta") argumentsById.set(event.tool_call.id, (argumentsById.get(event.tool_call.id) ?? "") + event.tool_call.arguments_delta);
  assert.deepEqual(JSON.parse(argumentsById.get("call_a")!), { a: 1 });
  assert.deepEqual(JSON.parse(argumentsById.get("call_b")!), { b: 2 });
  assert.equal(events.filter(event => event.type === "tool_call_end").length, 2);
});

await check("SSE multiline data and EOF with a valid finish retain reasoning and usage", async () => {
  const payload = JSON.stringify(chunk({ reasoning_content: "多行" })).replace(',"choices"', ',\r\ndata: "choices"');
  const events = await collect(parseDeepSeekChatStream(wire(`data: ${payload}\r\n\r\n${sse([chunk({ content: "完成" }, "stop"), usage], false)}`)));
  assert.equal(events.some(event => event.type === "content_delta" && event.delta.thinking === "多行"), true);
  assert.deepEqual(events.at(-1), { type: "message_end", stop_reason: "stop", usage: { input_tokens: 12, output_tokens: 7 } });
});

await check("thinking-only maximum-token output stays recoverable and terminal cancels an open body", async () => {
  let cancelled = false;
  const bytes = new TextEncoder().encode(sse([chunk({ reasoning_content: reasoning }), chunk({}, "length"), usage]));
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); }, cancel() { cancelled = true; } });
  const events = await collect(parseDeepSeekChatStream(body));
  assert.equal(cancelled, true);
  assert.equal(events.some(event => event.type === "content_delta" && event.delta.thinking === reasoning), true);
  assert.deepEqual(events.at(-1), { type: "message_end", stop_reason: "length", usage: { input_tokens: 12, output_tokens: 7 } });
});

await check("official wrapped stream drains through settlement EOF without cancelling or duplicate terminal events", async () => {
  let cancelled = false, settlementComplete = false;
  const bytes = new TextEncoder().encode(sse([chunk({ reasoning_content: reasoning }), chunk({ content: "完成" }, "stop"), usage]));
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      setTimeout(() => { settlementComplete = true; controller.close(); }, 10);
    },
    cancel() { cancelled = true; },
  });
  const events = await collect(parseDeepSeekChatStream(body, { waitForEOF: true }));
  assert.equal(settlementComplete, true);
  assert.equal(cancelled, false);
  assert.equal(events.filter(event => event.type === "message_end").length, 1);
  assert.deepEqual(events.at(-1), { type: "message_end", stop_reason: "stop", usage: { input_tokens: 12, output_tokens: 7 } });
});

await check("arguments received before tool identity are not lost", async () => {
  const events = await collect(parseDeepSeekChatStream(wire(sse([
    chunk({ tool_calls: [{ index: 0, function: { arguments: '{"text":' } }] }),
    chunk({ tool_calls: [{ index: 0, id: "call_later", function: { name: "Echo", arguments: '"later"}' } }] }),
    chunk({}, "tool_calls"), usage,
  ]))));
  const fragments = events.filter(event => event.type === "tool_call_delta").map(event => event.type === "tool_call_delta" ? event.tool_call.arguments_delta : "").join("");
  assert.deepEqual(JSON.parse(fragments), { text: "later" });
});

await check("truncated, malformed, supplier-error and invalid-tool streams fail safely", async () => {
  const invalid = [
    sse([chunk({ reasoning_content: "unfinished" })], false),
    "data: {broken}\n\n",
    sse([{ error: { message: "SECRET_SUPPLIER_MESSAGE" } }]),
    sse([chunk({ content: "blocked" }, "content_filter")]),
    sse([chunk({}, "tool_calls")]),
    sse([chunk({ tool_calls: [{ index: 0, id: "bad", function: { name: "Echo", arguments: '{"text":' } }] }, "tool_calls")]),
    sse([chunk({ tool_calls: [{ index: 0, function: { arguments: "{}" } }] }, "tool_calls")]),
    sse([chunk({ tool_calls: [{ index: 0, id: "duplicate", function: { name: "One", arguments: "{}" } }, { index: 1, id: "duplicate", function: { name: "Two", arguments: "{}" } }] }, "tool_calls")]),
  ];
  for (const input of invalid) await assert.rejects(() => collect(parseDeepSeekChatStream(wire(input))), error => error instanceof Error && !error.message.includes("SECRET_SUPPLIER_MESSAGE"));
});

await check("a length-truncated tool turn fails before completing even syntactically valid commands", async () => {
  const events: UniversalStreamEvent[] = [];
  const stream = parseDeepSeekChatStream(wire(sse([
    chunk({ reasoning_content: reasoning }),
    chunk({ tool_calls: [{ index: 0, id: "must_not_execute", function: { name: "Echo", arguments: '{"text":"complete JSON, unfinished turn"}' } }] }),
    chunk({}, "length"), usage,
  ])));
  await assert.rejects(async () => { for await (const event of stream) events.push(event); }, error =>
    error instanceof Error && (error as Error & { code?: string }).code === "DEEPSEEK_TOOL_TURN_TRUNCATED",
  );
  assert.equal(events.some(event => event.type === "tool_call_start"), true);
  assert.equal(events.some(event => event.type === "tool_call_end"), false);
  assert.equal(events.some(event => event.type === "message_end"), false);
});

await check("switching to Anthropic excludes DeepSeek reasoning metadata and keeps tool pairing", () => {
  const original = [
    { role: "user", content: "fixture" },
    { role: "assistant", content: [
      { type: "thinking", thinking: reasoning, reasoningProvider: "deepseek", reasoningEndpoint: endpoint },
      { type: "tool_use", id: "preserved", name: "Echo", input: { text: "fixture" } },
    ] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "preserved", content: "fixture" }] },
  ] as unknown as StreamRequestParams["messages"];
  const normalized = normalizeMessagesForAPI(original, "claude-fixture", true, "https://api.anthropic.com|claude-fixture");
  assert.equal(JSON.stringify(normalized).includes("reasoningProvider"), false);
  assert.equal(JSON.stringify(normalized).includes(reasoning), false);
  assert.equal(JSON.stringify(normalized).includes("preserved"), true);
  assert.equal(JSON.stringify(original).includes(reasoning), true);
});

await check("history replays every same-endpoint assistant reasoning and excludes foreign thoughts", () => {
  const messages: Array<{ role: string; reasoning_content?: string }> = Array.from({ length: 4 }, () => ({ role: "assistant" }));
  const source = [
    { role: "assistant", content: [{ type: "thinking", thinking: reasoning, reasoningProvider: "deepseek", reasoningEndpoint: endpoint }] },
    { role: "assistant", content: [{ type: "thinking", thinking: "FOREIGN", reasoningProvider: "deepseek", reasoningEndpoint: `${endpoint}-different` }] },
    { role: "assistant", content: [{ type: "thinking", thinking: "ANTHROPIC", signature: "unrelated" }] },
    { role: "assistant", content: [{ type: "text", text: "legacy" }] },
  ];
  applyDeepSeekHistory(messages, source, profile);
  assert.deepEqual(messages.map(message => message.reasoning_content), [reasoning, "", "", ""]);
  const openAI = [{ role: "assistant" }];
  applyDeepSeekHistory(openAI, [source[0]], { ...profile, upstreamProvider: "openai" });
  assert.deepEqual(openAI, [{ role: "assistant" }]);
  assert.throws(() => applyDeepSeekHistory([], source, profile), /记录不完整/);
});

await check("real request translation handles legacy history and genuine thinking off", () => {
  const messages = [
    { role: "user", content: "fixture" },
    { role: "assistant", content: [{ type: "tool_use", id: "legacy", name: "Echo", input: { text: "old" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "legacy", content: "done" }] },
  ] as StreamRequestParams["messages"];
  const body = prepareRequest(profile, { messages, tools: [tool], thinking: { type: "disabled" }, effortLevel: "max" }).body;
  assert.deepEqual(body.thinking, { type: "disabled" });
  assert.equal(body.reasoning_effort, undefined);
  assert.equal((body.messages as Array<Record<string, unknown>>).find(message => message.role === "assistant")!.reasoning_content, "");
  const maximum = prepareRequest(profile, { messages: [{ role: "user", content: "fixture" }], tools: [tool], effortLevel: "max", thinking: { type: "enabled", budgetTokens: 200 } }).body;
  assert.equal(maximum.reasoning_effort, "max");
  const ordinary = prepareRequest({ id: "gpt", protocol: "openai-chat", model: "gpt-fixture" }, { messages, tools: [tool], thinking: { type: "disabled" } }).body;
  assert.equal(ordinary.thinking, undefined);
  assert.equal((ordinary.messages as Array<Record<string, unknown>>).find(message => message.role === "assistant")!.reasoning_content, undefined);
});

await check("shared adapter retains thinking-only max-token output for continuation", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(wire(sse([chunk({ reasoning_content: reasoning }), chunk({}, "length"), usage])), {
    headers: { "content-type": "text/event-stream" },
  })) as typeof fetch;
  try {
    const result = await drain({ messages: [{ role: "user", content: "fixture" }], tools: [tool] });
    assert.equal(result.stopReason, "max_tokens");
    const history: unknown[] = [{ role: "assistant", content: result.assistantMessage.content }, { role: "user", content: "continue" }];
    const body = prepareRequest(profile, { messages: history as StreamRequestParams["messages"], tools: [tool] }).body;
    assert.equal((body.messages as Array<Record<string, unknown>>)[0]!.reasoning_content, reasoning);
  } finally { globalThis.fetch = originalFetch; }
});

await check("shared stream adapter completes tool continuation and the following user turn", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  // This stub acts as the supplier's documented 400 validator. Prior to the
  // fix, the first tool response passes and the very next request is rejected.
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    calls++;
    const body = JSON.parse(String(init?.body)) as { messages: Array<Record<string, unknown>> };
    const assistants = body.messages.filter(message => message.role === "assistant");
    if (assistants.some(message => typeof message.reasoning_content !== "string")) return new Response(JSON.stringify({ error: { message: "reasoning_content required" } }), { status: 400 });
    if (calls === 1) return new Response(wire(sse(firstFrames)), { headers: { "content-type": "text/event-stream" } });
    assert.equal(assistants[0]!.reasoning_content, reasoning);
    assert.equal(body.messages.find(message => message.role === "tool")!.tool_call_id, "call_fixture");
    if (calls === 3) assert.equal(assistants[1]!.reasoning_content, "核对完成。");
    return new Response(wire(sse([chunk({ reasoning_content: "核对完成。" }), chunk({ content: "任务已完成。" }, "stop"), usage])), { headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  try {
    setSessionThinkingConfig({ type: "enabled", budgetTokens: 500 }); setSessionEffortLevel(undefined);
    const history: unknown[] = [{ role: "user", content: "使用 Echo 完成任务" }];
    const one = await drain({ messages: history as StreamRequestParams["messages"], tools: [tool] });
    assert.equal(one.stopReason, "tool_use");
    assert.equal(Array.isArray(one.assistantMessage.content), true);
    const firstThinking = (one.assistantMessage.content as unknown as Array<Record<string, unknown>>).find(block => block.type === "thinking")!;
    assert.equal(firstThinking.reasoningProvider, "deepseek"); assert.equal(firstThinking.reasoningEndpoint, endpoint);
    history.push(one.assistantMessage, { role: "user", content: [{ type: "tool_result", tool_use_id: "call_fixture", content: "合成结果" }] });
    const two = await drain({ messages: history as StreamRequestParams["messages"], tools: [tool] });
    assert.equal(two.stopReason, "end_turn");
    history.push(two.assistantMessage, { role: "user", content: "再确认一次" });
    const three = await drain({ messages: history as StreamRequestParams["messages"], tools: [tool] });
    assert.equal(three.stopReason, "end_turn");
    assert.equal(calls, 3);
  } finally { globalThis.fetch = originalFetch; setSessionThinkingConfig(undefined); setSessionEffortLevel(undefined); }
});

console.log(`DeepSeek replay regression passed: ${checks} groups; synthetic SSE/fetch only, no supplier charges.`);
