/** Crash recovery and real shared-loop journaling. Loopback fixtures only. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { QueryEngine } from "../core/queryEngine.js";
import { runTools } from "../core/agenticLoop.js";
import { executionHash, type ExecutionEvent, type ExecutionScope } from "../session/execution.js";
import { appendCompactionSnapshot, appendTranscriptEntry, createExecutionRecorder, createExecutionReplayFence, createSessionId,
  getSessionPaths, initSessionStorage, listProjectSessions, readSessionExecutionEvents, restoreSession } from "../session/storage.js";
import { configureSessionPersistence } from "../session/storage.js";
import type { Tool, ToolContext } from "../tools/Tool.js";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages.js";
import { headlessPermissionDecision } from "../entrypoint/headless.js";
import { resetSettingsCache } from "../config/sources.js";
import { _resetHooksSettingsCache } from "../hooks/index.js";
import { loginForTest } from "./helpers/accountFixture.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "ccagent-journal-"));
const workspace = path.join(root, "workspace"); await fs.mkdir(workspace);
const account = await loginForTest(path.join(root, "profile"));
const timestamp = new Date().toISOString();
let checks = 0;
const pass = (label: string) => console.log(`PASS ${++checks}: ${label}`);
async function fresh() {
  const id = createSessionId();
  await initSessionStorage({ cwd: workspace, sessionId: id, startedAt: timestamp, updatedAt: timestamp, model: "journal-fixture" });
  return id;
}
async function message(id: string, value: MessageParam, executionScope?: ExecutionScope) {
  await appendTranscriptEntry(workspace, id, { type: "message", timestamp, role: value.role === "assistant" ? "assistant" : "user", message: value, executionScope });
}
async function seed(id: string) {
  await message(id, { role: "user", content: "original requirement" });
  await message(id, { role: "assistant", content: "original answer" });
}
async function event(id: string, scope: ExecutionScope, phase: ExecutionEvent["phase"], extra: Partial<ExecutionEvent> = {}) {
  await createExecutionRecorder(workspace, id)({ ...scope, id: randomUUID(), timestamp, phase, ...extra });
}
async function waitFor(predicate: () => Promise<boolean>, label: string) {
  const end = Date.now() + 10_000;
  while (Date.now() < end) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error(label);
}
let releaseHold = () => {};
let modelCalls = 0;
const supplier = createServer(async (request, response) => {
  for await (const _chunk of request) { /* consume only isolated fixture input */ }
  modelCalls++;
  response.writeHead(200, { "content-type": "text/event-stream" });
  const calls = ["JournalWrite", "JournalHold"].map((name, index) => ({ index, id: `fixture-${index}`, type: "function",
    function: { name, arguments: JSON.stringify({ value: name }) } }));
  response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: calls }, finish_reason: null }] })}\n\n`
    + `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 20, completion_tokens: 10 } })}\n\ndata: [DONE]\n\n`);
});
await new Promise<void>(resolve => supplier.listen(0, "127.0.0.1", resolve));
const address = supplier.address(); assert.ok(address && typeof address !== "string");
const settings = { disableAllHooks: true, mcpServers: {}, models: { "journal-fixture": {
  protocol: "openai-chat", model: "journal-fixture", baseURL: `http://127.0.0.1:${address.port}/v1`, apiKey: "fixture-only", maxTokens: 512,
} } };
await fs.writeFile(path.join(account.home, "settings.json"), JSON.stringify(settings));
let sideEffects = 0;
const write: Tool = { name: "JournalWrite", description: "Isolated receipt fixture", inputSchema: { type: "object" },
  decisionPolicy: "permission_only", isEnabled: () => true, isReadOnly: () => false, isConcurrencySafe: () => true,
  call: async () => { sideEffects++; await fs.appendFile(path.join(workspace, "effects.txt"), "effect\n"); return { content: "DURABLE_RECEIPT" }; } };
const hold: Tool = { ...write, name: "JournalHold", call: async () => {
  await new Promise<void>(resolve => { releaseHold = resolve; }); return { content: "HOLD_RELEASED" };
} };
try {
  for (const legacy of [false, true]) {
    const id = await fresh(); await seed(id);
    const paths = await getSessionPaths(workspace, id);
    const checkpoint = { type: "compaction_snapshot", timestamp, trigger: "auto", messages: [{ role: "user", content: "replacement" }] };
    const torn = legacy ? JSON.stringify({ type: "compaction", timestamp, trigger: "auto" }) + '\n{"type":"message"'
      : JSON.stringify(checkpoint).slice(0, -8);
    await fs.appendFile(paths.transcriptPath, torn);
    assert.equal((await restoreSession(workspace, id)).messages.length, 2);
    await message(id, { role: "user", content: "first input after restart" });
    assert.equal((await restoreSession(workspace, id)).messages.length, 3);
    assert.ok((await fs.readdir(paths.projectDir)).some(name => name.startsWith(`${id}.jsonl.interrupted-`)));
  }
  pass("torn new and legacy compaction writes preserve history and the first post-restart input; damaged tails are quarantined");

  const checkpointId = await fresh(); await seed(checkpointId);
  const replacement: MessageParam[] = [{ role: "user", content: "durable summary" }];
  await appendCompactionSnapshot(workspace, checkpointId, "auto", replacement);
  assert.deepEqual((await restoreSession(workspace, checkpointId)).messages, replacement);
  const cp = await getSessionPaths(workspace, checkpointId);
  await fs.appendFile(cp.transcriptPath, JSON.stringify({ type: "compaction_snapshot", timestamp, trigger: "auto", messages: [], checksum: "invalid" }) + "\n");
  assert.deepEqual((await restoreSession(workspace, checkpointId)).messages, replacement);
  pass("only complete checksummed snapshots replace the recovery baseline");

  const knownId = await fresh();
  const s1 = { turnId: randomUUID(), requestId: randomUUID(), step: 1, agentSessionId: knownId };
  const s2 = { turnId: randomUUID(), requestId: randomUUID(), step: 1, agentSessionId: knownId };
  const reused: MessageParam = { role: "assistant", content: [{ type: "tool_use", id: "reused-id", name: write.name, input: { value: "same" } }] };
  await message(knownId, reused, s1);
  await event(knownId, s1, "tool_start", { toolUseId: "reused-id", toolName: write.name, inputHash: executionHash({ value: "same" }) });
  await event(knownId, s1, "tool_result", { toolUseId: "reused-id", status: "settled", result: { content: "FIRST_RECEIPT" } });
  await message(knownId, reused, s2);
  await event(knownId, s2, "tool_start", { toolUseId: "reused-id", toolName: write.name, inputHash: executionHash({ value: "same" }) });
  const restored = await restoreSession(workspace, knownId);
  assert.match(JSON.stringify(restored.messages[1]), /FIRST_RECEIPT/);
  assert.match(JSON.stringify(restored.messages[3]), /Execution outcome unknown/);
  assert.doesNotMatch(JSON.stringify(restored.messages[3]), /FIRST_RECEIPT/);
  assert.deepEqual(restored.unknownToolIds, ["reused-id"]);
  pass("reused provider tool IDs are paired by session/turn/request; known results recover and missing outcomes remain unknown without replay");

  const input = { value: "same" }, fence = createExecutionReplayFence(workspace, knownId);
  const context: ToolContext = { cwd: workspace, sessionId: knownId, scopedTools: [write], recordExecutionEvent: createExecutionRecorder(workspace, knownId),
    findUnresolvedExecutions: fence, executionScope: { ...s2, turnId: randomUUID(), requestId: randomUUID() } };
  const call = (id: string) => [{ type: "tool_use" as const, id, name: write.name, input }];
  const denied = await runTools(call("new-id"), context, { permissionMode: "full", onPermissionRequest: async request => headlessPermissionDecision(request, true) });
  assert.equal(sideEffects, 0); assert.match(String(denied.executions[0]!.result.content), /Blocked automatic repetition/);
  let confirmations = 0;
  const allowed = await runTools(call("reviewed-id"), context, { permissionMode: "full", onPermissionRequest: async request => {
    assert.equal(request.requiresHumanReview, true); confirmations++; return "allow_once";
  } });
  assert.equal(confirmations, 1); assert.equal(sideEffects, 1); assert.equal(allowed.executions[0]!.result.isError, undefined);
  assert.equal((await fence(write.name, executionHash(input))).length, 0);
  assert.equal(executionHash({ a: 1, b: 2 }), executionHash({ b: 2, a: 1 }));
  pass("a new tool ID or Full/Headless bypass cannot repeat unresolved writes; explicit foreground review releases one retry");

  const uncertainId = await fresh();
  let uncertainEffects = 0;
  const uncertain: Tool = { ...write, name: "UncertainWrite", call: async () => { uncertainEffects++; throw new Error("Synthetic receipt loss after mutation"); } };
  const uncertainContext: ToolContext = { cwd: workspace, sessionId: uncertainId, scopedTools: [uncertain],
    recordExecutionEvent: createExecutionRecorder(workspace, uncertainId), findUnresolvedExecutions: createExecutionReplayFence(workspace, uncertainId),
    executionScope: { turnId: randomUUID(), requestId: randomUUID(), step: 1, agentSessionId: uncertainId } };
  await runTools([{ type: "tool_use", id: "first", name: uncertain.name, input }], uncertainContext, { permissionMode: "full" });
  const duplicate = await runTools([{ type: "tool_use", id: "different", name: uncertain.name, input }], uncertainContext, { permissionMode: "full" });
  assert.equal(uncertainEffects, 1); assert.match(String(duplicate.executions[0]!.result.content), /Blocked automatic repetition/);
  pass("an exception after native dispatch creates a durable unknown outcome and fences an automatic repeat in the same running session");

  const returnedUnknownId = await fresh(); let returnedUnknownEffects = 0;
  const returnedUnknown: Tool = { ...write, name: "ReturnedUnknown", call: async () => {
    returnedUnknownEffects++; return { content: "SMTP connection lost after DATA; delivery uncertain", isError: true, executionOutcome: "unknown" };
  } };
  const returnedUnknownContext: ToolContext = { cwd: workspace, sessionId: returnedUnknownId, scopedTools: [returnedUnknown],
    recordExecutionEvent: createExecutionRecorder(workspace, returnedUnknownId), findUnresolvedExecutions: createExecutionReplayFence(workspace, returnedUnknownId),
    executionScope: { turnId: randomUUID(), requestId: randomUUID(), step: 1, agentSessionId: returnedUnknownId } };
  await message(returnedUnknownId, { role: "assistant", content: [{ type: "tool_use", id: "smtp-first", name: returnedUnknown.name, input }] }, returnedUnknownContext.executionScope);
  await runTools([{ type: "tool_use", id: "smtp-first", name: returnedUnknown.name, input }], returnedUnknownContext, { permissionMode: "full" });
  const unknownRestored = await restoreSession(workspace, returnedUnknownId);
  assert.match(JSON.stringify(unknownRestored.messages), /SMTP connection lost after DATA/);
  assert.match(JSON.stringify(unknownRestored.messages), /Execution outcome unknown/);
  const afterRestart: ToolContext = { ...returnedUnknownContext, executionScope: { ...returnedUnknownContext.executionScope!, turnId: randomUUID(), requestId: randomUUID() },
    findUnresolvedExecutions: createExecutionReplayFence(workspace, returnedUnknownId) };
  const smtpRetry = await runTools([{ type: "tool_use", id: "smtp-new-id", name: returnedUnknown.name, input }], afterRestart, { permissionMode: "full" });
  assert.equal(returnedUnknownEffects, 1); assert.match(String(smtpRetry.executions[0]!.result.content), /Blocked automatic repetition/);
  pass("an explicit unknown outcome returned as an error retains its original receipt text and remains fenced after restore");

  const abortId = await fresh(), interrupted = new AbortController(); let abortedEffects = 0;
  const abortingTool: Tool = { ...write, name: "AbortedWrite", call: async () => {
    abortedEffects++; interrupted.abort(); return { content: "Stopped after mutation", isError: true };
  } };
  const abortContext: ToolContext = { cwd: workspace, sessionId: abortId, scopedTools: [abortingTool], abortSignal: interrupted.signal,
    recordExecutionEvent: createExecutionRecorder(workspace, abortId), findUnresolvedExecutions: createExecutionReplayFence(workspace, abortId),
    executionScope: { turnId: randomUUID(), requestId: randomUUID(), step: 1, agentSessionId: abortId } };
  const aborted = await runTools([{ type: "tool_use", id: "aborted-first", name: abortingTool.name, input }], abortContext, { permissionMode: "full" });
  assert.equal(aborted.executions[0]!.result.executionOutcome, "unknown");
  await runTools([{ type: "tool_use", id: "aborted-retry", name: abortingTool.name, input }], { ...abortContext, abortSignal: undefined }, { permissionMode: "full" });
  assert.equal(abortedEffects, 1);
  pass("generic cancellation during a mutating native call conservatively retains an unknown outcome and fences the retry");

  configureSessionPersistence(false);
  try {
    const privateId = randomUUID(), privateContext: ToolContext = { ...returnedUnknownContext, sessionId: privateId,
      recordExecutionEvent: createExecutionRecorder(workspace, privateId), findUnresolvedExecutions: createExecutionReplayFence(workspace, privateId),
      executionScope: { turnId: randomUUID(), requestId: randomUUID(), step: 1, agentSessionId: privateId } };
    const before = returnedUnknownEffects;
    await runTools([{ type: "tool_use", id: "private-first", name: returnedUnknown.name, input }], privateContext, { permissionMode: "full" });
    await runTools([{ type: "tool_use", id: "private-retry", name: returnedUnknown.name, input }], privateContext, { permissionMode: "full" });
    assert.equal(returnedUnknownEffects, before + 1);
    assert.equal(await fs.stat((await getSessionPaths(workspace, privateId)).transcriptPath).then(() => true, () => false), false);
  } finally { configureSessionPersistence(true); }
  pass("disabled transcript persistence retains in-memory replay protection without writing a private journal");

  const liveId = await fresh();
  const engine = new QueryEngine({ model: "journal-fixture", maxTurns: 1, permissionMode: "full", toolContext: {
    cwd: workspace, sessionId: liveId, scopedTools: [write, hold], recordExecutionEvent: createExecutionRecorder(workspace, liveId),
    findUnresolvedExecutions: createExecutionReplayFence(workspace, liveId),
  } });
  let completed = false;
  const running = (async () => {
    const iterator = engine.submitMessage("Run the isolated parallel receipts");
    while (true) {
      const next = await iterator.next(); if (next.done) { completed = true; return next.value; }
      if (next.value.type === "assistant_message" || next.value.type === "tool_result_message") await message(liveId, next.value.message, next.value.executionScope);
    }
  })();
  await waitFor(async () => {
    const events = await readSessionExecutionEvents(workspace, liveId);
    return events.some(item => item.phase === "tool_result" && item.toolName === write.name) && events.some(item => item.phase === "tool_start" && item.toolName === hold.name);
  }, "parallel tool receipts must be durable while another tool remains in flight");
  assert.equal(completed, false);
  const during = await restoreSession(workspace, liveId);
  assert.match(JSON.stringify(during.messages), /DURABLE_RECEIPT/); assert.match(JSON.stringify(during.messages), /Execution outcome unknown/);
  releaseHold(); assert.equal((await running).reason, "max_turns");
  const events = await readSessionExecutionEvents(workspace, liveId);
  const request = events.find(item => item.phase === "request_start")!;
  assert.equal(events.filter(item => item.toolUseId === "fixture-0" && item.result?.content === "DURABLE_RECEIPT").length, 1, "Unchanged native/final receipts must not duplicate payloads");
  assert.ok(request.requestId); assert.ok(events.filter(item => item.phase === "tool_result").every(item => item.requestId === request.requestId));
  assert.equal(events.find(item => item.phase === "request_end")?.billingStatus, "unverified");
  assert.ok(events.filter(item => item.phase === "request_end" || item.phase === "tool_result").every(item => typeof item.durationMs === "number"));
  pass("real QueryEngine/shared provider loop records each tool before its batch finishes, associates request IDs and timings, and leaves billing unverified");

  const indexFile = `${cp.transcriptPath}.summary.json`;
  await listProjectSessions(workspace);
  const indexBefore = await fs.stat(indexFile); const listed = await listProjectSessions(workspace);
  assert.equal((await fs.stat(indexFile)).mtimeMs, indexBefore.mtimeMs);
  assert.ok(listed.some(item => item.sessionId === checkpointId));
  await fs.appendFile(cp.transcriptPath, JSON.stringify({ type: "model_change", timestamp, model: "changed-on-disk" }) + "\n");
  assert.equal((await listProjectSessions(workspace)).find(item => item.sessionId === checkpointId)?.model, "changed-on-disk");
  assert.equal(JSON.parse(await fs.readFile(indexFile, "utf8")).size, (await fs.stat(cp.transcriptPath)).size);
  pass("warm listing retains its lightweight summary cache and external journal changes invalidate/rebuild it");

  const bulkIds: string[] = [];
  for (let index = 0; index < 40; index++) {
    const id = await fresh(); bulkIds.push(id);
    await message(id, { role: "user", content: `Bulk fixture ${index}: ` + "x".repeat(128 * 1024) });
  }
  const readFile = fs.readFile;
  let transcriptReads = 0;
  fs.readFile = (async (...args: any[]) => {
    if (String(args[0]).endsWith(".jsonl")) { transcriptReads++; throw new Error("Warm listing must not read a transcript body"); }
    return (readFile as any)(...args);
  }) as typeof fs.readFile;
  syncBuiltinESMExports();
  const listStartedAt = performance.now();
  try {
    const bulk = await listProjectSessions(workspace, 1000);
    assert.ok(bulkIds.every(id => bulk.some(item => item.sessionId === id)));
    assert.equal(transcriptReads, 0);
  } finally { fs.readFile = readFile; syncBuiltinESMExports(); }
  pass(`warm listing of 40 additional 128 KiB sessions reads zero transcript bodies (${Math.round(performance.now() - listStartedAt)} ms)`);

  await fs.writeFile(path.join(account.home, "settings.json"), JSON.stringify({ ...settings, disableAllHooks: false,
    hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "sleep 20", timeout: 20 }] }] } }));
  resetSettingsCache(); _resetHooksSettingsCache();
  const hookEngine = new QueryEngine({ model: "journal-fixture", toolContext: { cwd: workspace, sessionId: "hook-fixture", scopedTools: [] } });
  const hookRun = (async () => { const iterator = hookEngine.submitMessage("Stop during the hook"); while (true) { const next = await iterator.next(); if (next.done) return next.value; } })();
  await new Promise(resolve => setTimeout(resolve, 150));
  const beforeStop = Date.now(), callsBefore = modelCalls;
  assert.equal(hookEngine.interrupt(), true);
  const stopped = await hookRun;
  assert.equal(stopped.reason, "aborted"); assert.ok(Date.now() - beforeStop < 2500); assert.equal(modelCalls, callsBefore);
  pass("real QueryEngine Stop cancels UserPromptSubmit before any model request");
  console.log(`Session journal: ${checks} scenarios passed; no external model, account, or billing calls.`);
} finally {
  releaseHold(); supplier.closeAllConnections(); await new Promise<void>(resolve => supplier.close(() => resolve()));
  await account.close();
  if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith("ccagent-journal-")) throw new Error("Unsafe test cleanup");
  await fs.rm(root, { recursive: true, force: true });
}
