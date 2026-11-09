/** Real shared-loop HTTP fixtures; no production models, sessions, or billing. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages.js";
import { tokenCountWithEstimation, estimateSystemPromptTokens, roughTokenCountEstimationForMessages } from "../utils/tokens.js";
import { getAutoCompactThreshold } from "../context/autoCompact.js";
import { query, type AgenticLoopEvent, type AgenticLoopResult } from "../core/agenticLoop.js";
import { QueryEngine, type QueryEngineEvent } from "../core/queryEngine.js";
import type { Tool } from "../tools/Tool.js";
import { toolToApiParam } from "../tools/Tool.js";
import { loginForTest } from "./helpers/accountFixture.js";

const messages: MessageParam[] = [{ role: "user", content: "Open the test page." }, { role: "assistant", content: "OK" }];
const systemPrompt = "s".repeat(36_000), systemTokens = estimateSystemPromptTokens(systemPrompt);
const usage = { input_tokens: 16_000, output_tokens: 300 };
const estimate = (options: Parameters<typeof tokenCountWithEstimation>[1]) => tokenCountWithEstimation(messages, options);
assert.equal(estimate({ usage, usageAnchorIndex: 1, usageSystemPromptTokens: systemTokens, systemPrompt }), 16_300);
assert.equal(estimate({ usage, usageAnchorIndex: 1, systemPrompt }), 16_300, "Legacy callers must not add the system prompt to measured input twice");
assert.ok(16_300 + systemTokens > getAutoCompactThreshold("fixture", 32_768), "The fixture reproduces the former false compaction");
assert.equal(estimate({ usage, usageAnchorIndex: 1, usageSystemPromptTokens: systemTokens, systemPrompt: systemPrompt + "x".repeat(4_000) }), 17_300, "Only dynamic system growth is added");
assert.equal(estimate({ usage, usageAnchorIndex: 1, usageSystemPromptTokens: systemTokens, systemPrompt: "short" }), 16_300, "Shrinking system context does not discard measured safety headroom");
assert.equal(estimate({ usage: { input_tokens: 0, output_tokens: 3, cache_read_input_tokens: 16_000, cache_creation_input_tokens: 20 }, usageAnchorIndex: 1, usageSystemPromptTokens: systemTokens, systemPrompt }), 16_023, "Cached-only input remains authoritative, and cache buckets count once");
assert.equal(estimate({ usage: { input_tokens: 2_000, output_tokens: 300, cache_read_input_tokens: 10_000, cache_creation_input_tokens: 3_000 }, usageAnchorIndex: 1, usageSystemPromptTokens: systemTokens, systemPrompt }), 15_300, "Uncached, cache creation, and cache reads are separate normalized input buckets");
for (const anchor of [-1, 2]) assert.equal(estimate({ usage, usageAnchorIndex: anchor, systemPrompt }), roughTokenCountEstimationForMessages(messages) + systemTokens, "An invalid anchor falls back to the current history");
assert.equal(estimate({ usage: { input_tokens: 0, output_tokens: 0 }, usageAnchorIndex: 1, systemPrompt }), roughTokenCountEstimationForMessages(messages) + systemTokens, "Restored zero usage cannot hide history");
const withResult: MessageParam[] = [...messages, { role: "user", content: [{ type: "tool_result", tool_use_id: "probe", content: "x".repeat(15_000) }] }];
assert.ok(tokenCountWithEstimation(withResult, { usage, usageAnchorIndex: 1, usageSystemPromptTokens: systemTokens, systemPrompt }) > getAutoCompactThreshold("fixture", 32_768), "A large new tool result must cross the real threshold");
console.log("PASS measured usage, dynamic system growth, cached-only usage, invalid anchors, restored history, and large tool-result accounting");

const originalEnvironment = { ...process.env }, originalCwd = process.cwd();
const temporaryParent = await fs.realpath(os.tmpdir());
const temporary = await fs.realpath(await fs.mkdtemp(path.join(temporaryParent, "ccagent-context-usage-")));
const workspace = path.join(temporary, "workspace"); await fs.mkdir(workspace);
for (const key of Object.keys(process.env)) if (/API.?KEY|SECRET|TOKEN/i.test(key) || /^(ANTHROPIC|OPENAI|QWEN|DASHSCOPE|OLLAMA|GEMINI)_/i.test(key) || ["CCAGENT_ACCOUNT_ID", "CCAGENT_AUTH_SESSION_FILE", "CCAGENT_CLOUD_URL", "CCAGENT_ENV_FILE", "NODE_TLS_REJECT_UNAUTHORIZED"].includes(key)) delete process.env[key];
process.env.CCAGENT_DISABLE_STREAM_LOG = "1";
delete process.env.CCAGENT_MAX_CONTEXT_TOKENS; delete process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS;
process.chdir(workspace);
let toolResult = "accepted", mainCalls = 0, summaries = 0;
const supplierErrors: string[] = [];
const supplier = createServer(async (request, response) => {
  try {
    assert.equal(request.url, "/v1/chat/completions");
    let raw = ""; for await (const bytes of request) raw += bytes;
    const body = JSON.parse(raw);
    const summary = JSON.stringify(body.messages).includes("Your task is to create a detailed summary of the conversation so far");
    if (summary) summaries++; else mainCalls++;
    const toolTurn = !summary && mainCalls === 1;
    const delta = toolTurn ? { tool_calls: [{ index: 0, id: "probe-call", type: "function", function: { name: "ContextProbe", arguments: "{}" } }] } : { content: summary ? "A concise durable summary." : "Task complete." };
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: toolTurn ? "tool_calls" : "stop" }], usage: { prompt_tokens: summary ? 100 : 16_000, completion_tokens: toolTurn ? 300 : 10 } })}\n\ndata: [DONE]\n\n`);
  } catch (error) {
    supplierErrors.push(error instanceof Error ? error.message : String(error));
    if (!response.headersSent) response.writeHead(500); response.end("Fixture failed");
  }
});
await new Promise<void>(resolve => supplier.listen(0, "127.0.0.1", resolve));
const address = supplier.address(); assert.ok(address && typeof address !== "string");
const account = await loginForTest(path.join(temporary, "profile"));
const probe: Tool = { name: "ContextProbe", description: "Return a synthetic observation.", inputSchema: { type: "object", properties: {} }, isEnabled: () => true, isReadOnly: () => true, call: async () => ({ content: toolResult }) };
async function collect<T, R>(generator: AsyncGenerator<T, R>) { const events: T[] = []; while (true) { const next = await generator.next(); if (next.done) return { events, result: next.value }; events.push(next.value); } }
async function runLoop(system: string, output: string, maxTurns = 4) {
  mainCalls = 0; summaries = 0; toolResult = output;
  return collect<AgenticLoopEvent, AgenticLoopResult>(query({ messages: [{ role: "user", content: "Use ContextProbe." }], model: "context-usage", contextWindow: 32_768, systemPrompt: system, tools: [toolToApiParam(probe)], toolContext: { cwd: workspace, scopedTools: [probe] }, maxTurns, abortSignal: AbortSignal.timeout(20_000) }));
}
try {
  await fs.writeFile(path.join(account.home, "settings.json"), JSON.stringify({ disableAllHooks: true, mcpServers: {}, models: { "context-usage": { protocol: "openai-chat", model: "context-usage-fixture", baseURL: `http://127.0.0.1:${address.port}/v1`, apiKey: "fixture-only", maxTokens: 512, contextWindow: 32_768 } } }));
  const small = await runLoop(systemPrompt, "accepted");
  assert.equal(small.result.reason, "completed"); assert.equal(mainCalls, 2); assert.equal(summaries, 0, "A short tool task requires two main requests and no extra compaction request");
  assert.equal(small.events.some(event => event.type === "context_compacted"), false);
  console.log("PASS shared-loop small tool task: 2 requests, 0 summaries (formerly 3 requests)");

  const large = await runLoop("short", "x".repeat(15_000));
  assert.equal(large.result.reason, "completed"); assert.equal(mainCalls, 2); assert.equal(summaries, 1);
  assert.equal(large.events.filter(event => event.type === "context_compacted").length, 1);
  assert.equal(large.result.lastCallUsageAnchorIndex, large.result.state.messages.length - 1);
  console.log("PASS shared-loop real tool-result growth: 2 main requests plus 1 necessary summary; usage anchor reset after compaction");

  const stopped = await runLoop("short", "x".repeat(15_000), 1);
  assert.equal(stopped.result.reason, "max_turns");
  assert.equal(stopped.result.lastCallUsageAnchorIndex, 1, "Usage covers the assistant, not the trailing unmeasured tool result");
  assert.ok(tokenCountWithEstimation(stopped.result.state.messages, { usage: stopped.result.lastCallUsage, usageAnchorIndex: stopped.result.lastCallUsageAnchorIndex, usageSystemPromptTokens: stopped.result.lastCallSystemPromptTokens, systemPrompt: "short" }) > getAutoCompactThreshold("fixture", 32_768));
  console.log("PASS tool-result usage anchor survives max-turn termination accurately");

  mainCalls = 0; summaries = 0; toolResult = "accepted";
  const grownSystem = await collect(query({ messages, model: "context-usage", contextWindow: 32_768, systemPrompt: systemPrompt + "x".repeat(36_000), initialCallUsage: usage, initialUsageAnchorIndex: 1, initialSystemPromptTokens: systemTokens, tools: [toolToApiParam(probe)], toolContext: { cwd: workspace, scopedTools: [probe] }, maxTurns: 4, abortSignal: AbortSignal.timeout(20_000) }));
  assert.equal(grownSystem.result.reason, "completed"); assert.equal(mainCalls, 2); assert.equal(summaries, 1);
  assert.equal(grownSystem.events.filter(event => event.type === "context_compacted").length, 1, "A dynamic system increase that genuinely crosses the threshold still compacts");
  console.log("PASS dynamic system growth crossing the threshold still triggers one necessary summary");

  mainCalls = 0; summaries = 0; toolResult = "accepted";
  const engine = new QueryEngine({ model: "context-usage", toolContext: { cwd: workspace, temporaryChat: true, scopedTools: [probe], sessionInstructions: systemPrompt }, maxTurns: 4 });
  const foreground = await collect<QueryEngineEvent, { handled: boolean; reason?: import("../core/agenticLoop.js").LoopTerminationReason }>(engine.submitMessage("Use ContextProbe."));
  assert.equal(foreground.result.reason, "completed"); assert.equal(mainCalls, 2); assert.equal(summaries, 0);
  const followup = await collect(engine.submitMessage("Continue."));
  assert.equal(followup.result.reason, "completed"); assert.equal(mainCalls, 3); assert.equal(summaries, 0, "The next user turn must reuse the correct measured system baseline");
  assert.equal(foreground.events.some(event => event.type === "compacted"), false);
  console.log("PASS QueryEngine foreground plus follow-up: 3 requests, 0 summaries; same path used by CLI and Web");

  mainCalls = 0; summaries = 0; toolResult = "accepted";
  const restored = new QueryEngine({ model: "context-usage", initialMessages: [{ role: "user", content: "z".repeat(80_000) }, { role: "assistant", content: "restored" }], initialUsage: { input_tokens: 0, output_tokens: 0 }, toolContext: { cwd: workspace, temporaryChat: true, scopedTools: [probe] }, maxTurns: 4 });
  const resumed = await collect(restored.submitMessage("Continue."));
  assert.equal(resumed.result.reason, "completed"); assert.equal(mainCalls, 2); assert.equal(summaries, 1);
  assert.equal(resumed.events.filter(event => event.type === "compacted" && event.trigger === "auto").length, 1);
  console.log("PASS restored zero-usage history is counted and compacted before foreground generation");
  assert.deepEqual(supplierErrors, []);
} finally {
  supplier.closeAllConnections(); await new Promise<void>(resolve => supplier.close(() => resolve())); await account.close();
  process.chdir(originalCwd);
  for (const key of Object.keys(process.env)) if (!(key in originalEnvironment)) delete process.env[key];
  Object.assign(process.env, originalEnvironment);
  const relative = path.relative(temporaryParent, temporary);
  assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative) && path.basename(temporary).startsWith("ccagent-context-usage-"));
  await fs.rm(temporary, { recursive: true, force: true });
}
console.log("Context usage accounting passed; loopback authentication and synthetic providers only.");
