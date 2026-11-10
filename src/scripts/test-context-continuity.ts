/** Shared CLI/Web compaction fixtures. Only authentication/provider loopback servers are used. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages.js";
import { autoCompactIfNeeded, createAutoCompactState, shouldAutoCompact } from "../context/autoCompact.js";
import { compactMessages, microCompactMessages, OLD_TOOL_RESULT_PLACEHOLDER, selectCompactionTail } from "../context/compaction.js";
import { estimateSystemPromptTokens, estimateToolDefinitionTokens, roughTokenCountEstimationForMessages, tokenCountWithEstimation } from "../utils/tokens.js";
import { QueryEngine } from "../core/queryEngine.js";
import { query } from "../core/agenticLoop.js";
import { toolToApiParam, type Tool } from "../tools/Tool.js";
import { loginForTest } from "./helpers/accountFixture.js";

let scenarios = 0;
const passed = (label: string) => { scenarios++; console.log(`PASS ${scenarios}: ${label}`); };
async function collect<T, R>(generator: AsyncGenerator<T, R>, onEvent?: (event: T) => void) {
  const events: T[] = [];
  while (true) { const next = await generator.next(); if (next.done) return { events, result: next.value }; events.push(next.value); onEvent?.(next.value); }
}
async function within<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([promise, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Compaction fixture timed out")), milliseconds); })]); }
  finally { clearTimeout(timer); }
}

const history: MessageParam[] = [{ role: "user", content: "Continue the pending task." }, { role: "assistant", content: "Ready." }];
const smallTools = [{ name: "Probe", description: "small", input_schema: { type: "object" } }];
const largeTools = [{ name: "Probe", description: "x".repeat(50_000), input_schema: { type: "object" } }];
const baseTools = estimateToolDefinitionTokens(smallTools), grownTools = estimateToolDefinitionTokens(largeTools);
const systemPrompt = "system", systemTokens = estimateSystemPromptTokens(systemPrompt);
const usage = { input_tokens: 16_000, output_tokens: 100 };
const measuredOptions = { usage, usageAnchorIndex: 1, usageSystemPromptTokens: systemTokens, usageToolDefinitionTokens: baseTools, systemPrompt };
assert.equal(tokenCountWithEstimation(history, { ...measuredOptions, toolDefinitions: smallTools }), 16_100);
assert.equal(tokenCountWithEstimation(history, { ...measuredOptions, toolDefinitions: largeTools }), 16_100 + grownTools - baseTools);
assert.equal(tokenCountWithEstimation(history, { ...measuredOptions, toolDefinitions: [] }), 16_100);
assert.equal(tokenCountWithEstimation(history, { ...measuredOptions, toolDefinitions: largeTools, systemPrompt: systemPrompt + "x".repeat(4_000) }), 17_100 + grownTools - baseTools);
passed("measured tools count once; only schema/system growth is added; shrinking keeps the measured safety margin");
assert.equal(tokenCountWithEstimation(history, { systemPrompt, toolDefinitions: largeTools }), roughTokenCountEstimationForMessages(history) + systemTokens + grownTools);
for (const baseline of [undefined, NaN, -1]) assert.equal(tokenCountWithEstimation(history, { ...measuredOptions, toolDefinitions: largeTools, usageToolDefinitionTokens: baseline }), Math.max(16_100, roughTokenCountEstimationForMessages(history) + systemTokens + grownTools));
passed("restored and legacy/invalid schema anchors count visible definitions without duplicating measured input");
const chineseHistory: MessageParam[] = [{ role: "user", content: "请持续执行任务，保留原有要求。".repeat(1_500) }];
assert.ok(tokenCountWithEstimation(chineseHistory) > 25_000, "A long Chinese input must not look like a short English input");
assert.equal(tokenCountWithEstimation(history, { ...measuredOptions, toolDefinitions: smallTools }), 16_100, "Measured input remains authoritative instead of adding estimated Chinese/system/tools twice");
assert.ok(tokenCountWithEstimation([...history, ...chineseHistory], { ...measuredOptions, toolDefinitions: smallTools }) > 40_000, "Only new unmeasured Chinese text is added after the usage anchor");
passed("Chinese/new multilingual input and restored unmeasured history retain a conservative budget; measured usage is not duplicated");

const oldResults: MessageParam[] = [
  { role: "assistant", content: [
    { type: "tool_use", id: "read", name: "Read", input: {} },
    { type: "tool_use", id: "shell", name: "PowerShell", input: {} },
    { type: "tool_use", id: "error", name: "Read", input: {} },
    { type: "tool_use", id: "durable", name: "WorkfriendAssess", input: {} },
  ] },
  { role: "user", content: [
    { type: "tool_result", tool_use_id: "read", content: "1 source content without a Read prefix" },
    { type: "tool_result", tool_use_id: "shell", content: "plain stdout without a shell prefix" },
    { type: "tool_result", tool_use_id: "error", content: "Read failed because a required file is missing", is_error: true },
    { type: "tool_result", tool_use_id: "durable", content: "Read: durable decision, not a retrieval result" },
  ] },
  ...Array.from({ length: 8 }, (_, index): MessageParam => ({ role: index % 2 ? "assistant" : "user", content: `recent-${index}` })),
];
const serializedBefore = JSON.stringify(oldResults);
const micro = microCompactMessages(oldResults);
assert.deepEqual(micro.compactedToolIds, ["read", "shell"]);
const old = micro.messages[1]!.content as { type: string; content: string }[];
assert.equal(old[0]!.content, OLD_TOOL_RESULT_PLACEHOLDER); assert.equal(old[1]!.content, OLD_TOOL_RESULT_PLACEHOLDER);
assert.equal(old[2]!.content, "Read failed because a required file is missing");
assert.equal(old[3]!.content, "Read: durable decision, not a retrieval result");
assert.equal(JSON.stringify(oldResults), serializedBefore);
assert.deepEqual(micro.messages.slice(-8), oldResults.slice(-8));
assert.deepEqual(microCompactMessages(micro.messages).compactedToolIds, [], "Micro-compaction is idempotent");
assert.equal(microCompactMessages(micro.messages).messages, micro.messages, "An unchanged history needs no full JSON serialization to detect changes");
passed("actual Read/Windows PowerShell outputs compact by tool ID; recent/error/durable results and the original history survive");

const paired: MessageParam[] = [...history,
  { role: "assistant", content: [{ type: "tool_use", id: "pair", name: "Read", input: {} }] },
  { role: "user", content: [{ type: "tool_result", tool_use_id: "pair", content: "returned" }] },
];
assert.equal(selectCompactionTail(paired, 1, 2_000).length, 2, "A preserved result retains its matching tool use");
const giantPair = structuredClone(paired); (giantPair[3]!.content as { content: string }[])[0]!.content = "x".repeat(100_000);
assert.deepEqual(selectCompactionTail(giantPair, 2, 2_000), []);
passed("preserved tails retain tool pairs and never reinsert an oversized recent result");

const previousEnvironment = { ...process.env }, previousCwd = process.cwd();
const temporaryParent = await fs.realpath(os.tmpdir());
const temporary = await fs.realpath(await fs.mkdtemp(path.join(temporaryParent, "ccagent-context-continuity-")));
const workspace = path.join(temporary, "workspace"); await fs.mkdir(workspace);
for (const key of Object.keys(process.env)) if (/API.?KEY|SECRET|TOKEN/i.test(key) || /^(ANTHROPIC|OPENAI|QWEN|DASHSCOPE|OLLAMA|GEMINI)_/i.test(key) || ["CCAGENT_ACCOUNT_ID", "CCAGENT_AUTH_SESSION_FILE", "CCAGENT_CLOUD_URL", "CCAGENT_ENV_FILE", "NODE_TLS_REJECT_UNAUTHORIZED"].includes(key)) delete process.env[key];
delete process.env.CCAGENT_MAX_CONTEXT_TOKENS; delete process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS;
process.env.CCAGENT_DISABLE_STREAM_LOG = "1";
process.chdir(workspace);
type Mode = "success" | "failure" | "hold" | "dynamic" | "reactive";
let mode: Mode = "success", summaries = 0, mainCalls = 0, summaryStarted: (() => void) | undefined, latestSummary: Record<string, unknown> | undefined;
const supplierErrors: string[] = [];
const supplier = createServer(async (request, response) => {
  try {
    assert.equal(request.url, "/v1/chat/completions");
    let raw = ""; for await (const bytes of request) raw += bytes;
    const body = JSON.parse(raw);
    const summary = JSON.stringify(body.messages).includes("Your task is to create a detailed summary of the conversation so far");
    if (summary) { summaries++; latestSummary = body; summaryStarted?.(); }
    else mainCalls++;
    if (summary && mode === "failure") { response.writeHead(400, { "content-type": "application/json" }); response.end(JSON.stringify({ error: { message: "Synthetic summary failure", type: "invalid_request_error" } })); return; }
    if (summary && mode === "hold") return;
    if (!summary && mode === "reactive" && mainCalls === 1) { response.writeHead(413, { "content-type": "application/json" }); response.end(JSON.stringify({ error: { message: "prompt is too long", type: "invalid_request_error" } })); return; }
    const toolTurn = !summary && mode === "dynamic" && mainCalls === 1;
    const delta = toolTurn ? { tool_calls: [{ index: 0, id: "grow", type: "function", function: { name: "ContextGrow", arguments: "{}" } }] } : { content: summary ? "Pending task: preserve intent and continue using the verified observations." : "Completed." };
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: toolTurn ? "tool_calls" : "stop" }], usage: { prompt_tokens: summary ? 100 : 16_000, completion_tokens: 100 } })}\n\ndata: [DONE]\n\n`);
  } catch (error) { supplierErrors.push(error instanceof Error ? error.message : String(error)); if (!response.headersSent) response.writeHead(500); response.end("Fixture failure"); }
});
await new Promise<void>(resolve => supplier.listen(0, "127.0.0.1", resolve));
const address = supplier.address(); assert.ok(address && typeof address !== "string");
const account = await loginForTest(path.join(temporary, "account"));
const oversized: MessageParam[] = [{ role: "user", content: "z".repeat(100_000) }, { role: "assistant", content: "Pending task remains unfinished." }];
function reset(next: Mode) { mode = next; summaries = 0; mainCalls = 0; summaryStarted = undefined; latestSummary = undefined; }
try {
  await fs.writeFile(path.join(account.home, "settings.json"), JSON.stringify({ disableAllHooks: true, mcpServers: {}, models: { "context-continuity": { protocol: "openai-chat", model: "context-fixture", baseURL: `http://127.0.0.1:${address.port}/v1`, apiKey: "fixture-only", maxTokens: 512, contextWindow: 32_768 } } }));
  reset("success");
  const empty = await compactMessages([], undefined, { model: "context-continuity", force: true });
  assert.equal(empty.didCompact, false); assert.equal(summaries, 0); assert.equal(mainCalls, 0);
  passed("empty manual compaction makes no supplier request");

  reset("failure");
  const stateA = createAutoCompactState(), stateB = createAutoCompactState();
  for (let index = 0; index < 3; index++) {
    const failed = await autoCompactIfNeeded(oversized, "context-continuity", { contextWindow: 32_768, state: stateA });
    assert.equal(failed.didAutoCompact, false); assert.equal(failed.result.messages, oversized);
  }
  assert.equal(stateA.consecutiveFailures, 3); assert.equal(summaries, 3);
  assert.equal(shouldAutoCompact(100_000, "context-continuity", undefined, 32_768, stateA), false);
  assert.equal(shouldAutoCompact(100_000, "context-continuity", undefined, 32_768, stateB), true);
  await autoCompactIfNeeded(oversized, "context-continuity", { contextWindow: 32_768, state: stateA }); assert.equal(summaries, 3);
  reset("success");
  const recovered = await autoCompactIfNeeded(oversized, "context-continuity", { contextWindow: 32_768, state: stateB });
  assert.equal(recovered.didAutoCompact, true); assert.equal(summaries, 1); assert.equal(stateB.consecutiveFailures, 0); assert.equal(stateA.consecutiveFailures, 3);
  passed("three failed summaries retain history and stop repeated calls in one session; a separate session still compacts");

  reset("hold");
  const cancellationState = createAutoCompactState(), cancellation = new AbortController();
  const started = new Promise<void>(resolve => { summaryStarted = resolve; });
  const pending = autoCompactIfNeeded(oversized, "context-continuity", { contextWindow: 32_768, state: cancellationState, signal: cancellation.signal });
  const rejection = assert.rejects(pending); await started; cancellation.abort(); await within(rejection, 1_500);
  assert.equal(cancellationState.consecutiveFailures, 0);
  passed("cancelled automatic summaries stop promptly and do not count as provider failures");

  for (const command of ["Continue the task.", "/compact pending tasks"]) {
    reset("hold");
    const engine = new QueryEngine({ model: "context-continuity", initialMessages: oversized, toolContext: { cwd: workspace, temporaryChat: true, scopedTools: [] }, maxTurns: 2 });
    const before = engine.getState().messages;
    const engineStarted = new Promise<void>(resolve => { summaryStarted = resolve; });
    const run = collect(engine.submitMessage(command)); await engineStarted;
    const stoppedAt = Date.now(); assert.equal(engine.interrupt(), true);
    const stopped = await within(run, 1_500);
    assert.equal(stopped.result.reason, "aborted"); assert.deepEqual(engine.getState().messages, before); assert.equal(mainCalls, 0); assert.equal(summaries, 1);
    passed(`real QueryEngine ${command.startsWith("/") ? "manual" : "between-turn automatic"} compaction obeys Stop without losing the pending task (${Date.now() - stoppedAt} ms)`);
  }

  reset("failure");
  const failedEngine = new QueryEngine({ model: "context-continuity", initialMessages: history, toolContext: { cwd: workspace, temporaryChat: true, scopedTools: [] }, maxTurns: 2 });
  await assert.rejects(collect(failedEngine.submitMessage("/compact"))); assert.deepEqual(failedEngine.getState().messages, history);
  passed("a failed manual summary leaves the existing conversation intact");

  reset("failure");
  const oversizedFailure = new QueryEngine({ model: "context-continuity", initialMessages: oversized, toolContext: { cwd: workspace, temporaryChat: true, scopedTools: [] }, maxTurns: 2 });
  const blocked = await collect(oversizedFailure.submitMessage("Continue after the provider recovers."));
  assert.equal(blocked.result.reason, "blocking_limit"); assert.equal(summaries, 1, "A failed parent summary must not be duplicated at the first loop iteration"); assert.equal(mainCalls, 0, "The hard window still prevents sending an over-limit main request");
  assert.deepEqual(oversizedFailure.getState().messages.slice(0, oversized.length), oversized);
  assert.equal(oversizedFailure.getState().messages.at(-1)?.content, "Continue after the provider recovers.");
  await assert.rejects(collect(oversizedFailure.submitMessage("/compact pending work"))); assert.equal(summaries, 2, "An explicit user compaction remains available after an automatic failure");
  passed("failed between-turn recovery makes one summary attempt, preserves pending context, and keeps the hard window and explicit retry");

  reset("dynamic");
  let manifestLarge = false, manifestReads = 0;
  const grow: Tool = { name: "ContextGrow", description: "Grow the synthetic tools manifest", inputSchema: { type: "object", properties: {} }, isEnabled: () => true, isReadOnly: () => true, call: async () => { manifestLarge = true; return { content: "Small result" }; } };
  const run = await collect(query({ messages: history, model: "context-continuity", contextWindow: 32_768, systemPrompt: "short", initialCompactionFailed: true, getTools: () => { manifestReads++; return [toolToApiParam(grow), ...(manifestLarge ? [{ name: "ExtraMetadata", description: "x".repeat(50_000), input_schema: { type: "object" as const, properties: {} } }] : [])]; }, toolContext: { cwd: workspace, scopedTools: [grow] }, maxTurns: 4, abortSignal: AbortSignal.timeout(20_000) }));
  assert.equal(run.result.reason, "completed"); assert.equal(mainCalls, 2); assert.equal(summaries, 1); assert.equal(manifestReads, 2, "Each iteration reads one manifest for both budget and sending");
  assert.equal(run.events.filter(event => event.type === "context_compacted").length, 1);
  assert.ok((run.result.lastCallToolDefinitionTokens ?? 0) >= grownTools);
  assert.equal(latestSummary?.tools, undefined, "A continuation summary cannot dispatch tools");
  passed("a real tool continuation notices MCP/schema growth, compacts once, and uses the same manifest for budget and request");

  reset("reactive");
  const overflow = await collect(query({ messages: history, model: "context-continuity", contextWindow: 32_768, initialCompactionFailed: true, toolContext: { cwd: workspace, scopedTools: [] }, maxTurns: 2, abortSignal: AbortSignal.timeout(20_000) }));
  assert.equal(overflow.result.reason, "completed"); assert.equal(mainCalls, 2); assert.equal(summaries, 1);
  assert.equal(overflow.events.filter(event => event.type === "stream_restart" && event.reason === "reactive_compact").length, 1);
  passed("a real provider overflow still recovers once after the initial automatic-summary retry was suppressed");

  reset("success");
  const chineseEngine = new QueryEngine({ model: "context-continuity", initialMessages: chineseHistory, initialUsage: { input_tokens: 0, output_tokens: 0 }, toolContext: { cwd: workspace, temporaryChat: true, scopedTools: [] }, maxTurns: 2 });
  const chineseResumed = await collect(chineseEngine.submitMessage("继续执行。"));
  assert.equal(chineseResumed.result.reason, "completed"); assert.equal(summaries, 1); assert.equal(mainCalls, 1);
  assert.equal(chineseResumed.events.filter(event => event.type === "compacted" && event.trigger === "auto").length, 1);
  passed("the real QueryEngine compacts restored Chinese history with zero usage before continuing");

  reset("success");
  const checkpointEngine = new QueryEngine({ model: "context-continuity", initialMessages: oversized, toolContext: { cwd: workspace, temporaryChat: true, scopedTools: [] }, maxTurns: 2 });
  const latestRequest = "CURRENT_USER_REQUIREMENT_MUST_SURVIVE_AUTO_CHECKPOINT";
  let checkpoint: MessageParam[] | undefined;
  const checkpointRun = await collect(checkpointEngine.submitMessage(latestRequest), event => {
    if (event.type !== "compacted" || event.trigger !== "auto") return;
    checkpoint = checkpointEngine.getState().messages;
    assert.equal(mainCalls, 0, "The checkpoint precedes foreground generation");
    assert.equal(checkpoint.filter(message => message.role === "user" && message.content === latestRequest).length, 1, "The persisted compacted state includes the new requirement exactly once");
  });
  assert.equal(checkpointRun.result.reason, "completed"); assert.ok(checkpoint); assert.equal(summaries, 1); assert.equal(mainCalls, 1);
  assert.equal(JSON.stringify(checkpoint).includes("z".repeat(100_000)), false, "The checkpoint still replaces oversized earlier history");
  passed("the between-turn automatic checkpoint contains this turn's prepared user requirement exactly once before generation");

  reset("success");
  const cancelledCheckpoint = new QueryEngine({ model: "context-continuity", initialMessages: oversized, toolContext: { cwd: workspace, temporaryChat: true, scopedTools: [] }, maxTurns: 2 });
  let stoppedAfterSummary = false;
  const cancelledCheckpointRun = await collect(cancelledCheckpoint.submitMessage(latestRequest), event => {
    if (stoppedAfterSummary || event.type !== "messages_updated" || !event.messages.some(message => typeof message.content === "string" && message.content.startsWith("[CompactBoundary]"))) return;
    stoppedAfterSummary = true; assert.equal(cancelledCheckpoint.interrupt(), true);
  });
  assert.equal(stoppedAfterSummary, true); assert.equal(cancelledCheckpointRun.result.reason, "aborted");
  assert.equal(cancelledCheckpointRun.events.some(event => event.type === "compacted" && event.trigger === "auto"), false, "A cancelled preparation publishes no replacement checkpoint over the already persisted raw prompt");
  assert.equal(mainCalls, 0); assert.equal(summaries, 1);
  passed("cancellation between summary and prepared input emits no destructive checkpoint over the persisted current request");

  reset("success");
  const engine = new QueryEngine({ model: "context-continuity", toolContext: { cwd: workspace, temporaryChat: true, scopedTools: [grow] }, maxTurns: 2 });
  await collect(engine.submitMessage("First.")); const firstCalls = mainCalls;
  await collect(engine.submitMessage("Second.")); assert.equal(mainCalls, firstCalls + 1); assert.equal(summaries, 0);
  await collect(engine.submitMessage("/clear")); assert.deepEqual(engine.getState().messages, []);
  await collect(engine.submitMessage("Fresh task.")); assert.equal(summaries, 0);
  passed("stable schemas do not trigger extra summaries across user turns or after /clear");
  assert.deepEqual(supplierErrors, []);
} finally {
  supplier.closeAllConnections(); await new Promise<void>(resolve => supplier.close(() => resolve())); await account.close();
  process.chdir(previousCwd);
  for (const key of Object.keys(process.env)) if (!(key in previousEnvironment)) delete process.env[key]; Object.assign(process.env, previousEnvironment);
  const relative = path.relative(temporaryParent, temporary);
  assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative) && path.basename(temporary).startsWith("ccagent-context-continuity-"));
  await fs.rm(temporary, { recursive: true, force: true });
}
console.log(`Context continuity: ${scenarios} scenarios passed; no production accounts, sessions, models, or billing.`);
