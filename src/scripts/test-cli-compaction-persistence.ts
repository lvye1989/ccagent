/** CLI TUI's real persistence order around QueryEngine pre-turn compaction; local fixtures only. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages.js";
import { QueryEngine } from "../core/queryEngine.js";
import { appendCompactionSnapshot, appendTranscriptEntry, createSessionId, initSessionStorage, restoreSession } from "../session/storage.js";
import { loginForTest } from "./helpers/accountFixture.js";

const originalEnvironment = { ...process.env }, originalCwd = process.cwd(), originalFetch = globalThis.fetch;
const parent = await fs.realpath(os.tmpdir());
const temporary = await fs.realpath(await fs.mkdtemp(path.join(parent, "ccagent-cli-compact-persistence-")));
const workspace = path.join(temporary, "workspace"); await fs.mkdir(workspace);
for (const key of Object.keys(process.env)) if (/API.?KEY|SECRET|TOKEN/i.test(key) || /^(CCAGENT|ANTHROPIC|OPENAI|QWEN|DASHSCOPE|OLLAMA|GEMINI|JEV|CLAUDE_CODE)_/i.test(key) || ["NODE_TLS_REJECT_UNAUTHORIZED", "NODE_OPTIONS"].includes(key)) delete process.env[key];
process.env.CCAGENT_DISABLE_STREAM_LOG = "1"; process.chdir(workspace);
globalThis.fetch = (input, options) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname), "CLI persistence test forbids external fetch");
  return originalFetch(input, options);
};
const requirement = "UNIQUE_CLI_REQUIREMENT_AFTER_PRETURN_AUTO preserve exact approved output path and continue.";
const priorHistory: MessageParam[] = [{ role: "user", content: "OLD_REQUEST " + "z".repeat(100_000) }, { role: "assistant", content: "An unfinished earlier task." }];
function transcriptRole(message: MessageParam): "user" | "assistant" {
  if (message.role !== "user" && message.role !== "assistant") throw new Error("The CLI persistence fixture only accepts user and assistant conversation messages");
  return message.role;
}
let summaries = 0, mainCalls = 0;
const fixtureErrors: string[] = [];
const supplier = createServer(async (request, response) => {
  try {
    assert.equal(request.url, "/v1/chat/completions");
    let raw = ""; for await (const bytes of request) raw += bytes;
    const body = JSON.parse(raw), history = JSON.stringify(body.messages);
    const summary = history.includes("Your task is to create a detailed summary of the conversation so far");
    if (summary) { summaries++; assert.equal(history.includes(requirement), false, "The pre-turn summary covers only old history; it cannot reconstruct the new requirement"); }
    else { mainCalls++; assert.ok(history.includes(requirement)); assert.match(history, /DURABLE_OLD_HISTORY/); }
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: summary ? "DURABLE_OLD_HISTORY Pending old work remains available." : "CLI_REQUIREMENT_COMPLETED" }, finish_reason: null }] })}\n\n`);
    response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 10 } })}\n\ndata: [DONE]\n\n`);
  } catch (error) { fixtureErrors.push(error instanceof Error ? error.message : String(error)); if (!response.headersSent) response.writeHead(500); response.end("Local persistence fixture failed"); }
});
await new Promise<void>(resolve => supplier.listen(0, "127.0.0.1", resolve));
const address = supplier.address(); assert.ok(address && typeof address !== "string");
const account = await loginForTest(path.join(temporary, "profile"));
try {
  const model = "cli-persistence-fixture";
  await fs.writeFile(path.join(account.home, "settings.json"), JSON.stringify({ disableAllHooks: true, mcpServers: {}, models: { [model]: { protocol: "openai-chat", model, baseURL: `http://127.0.0.1:${address.port}/v1`, apiKey: "fixture-only", contextWindow: 32_768, maxTokens: 512 } } }));
  const sessionId = createSessionId(), timestamp = new Date().toISOString();
  await initSessionStorage({ sessionId, cwd: workspace, model, startedAt: timestamp, updatedAt: timestamp });
  for (const message of priorHistory) await appendTranscriptEntry(workspace, sessionId, { type: "message", timestamp, role: transcriptRole(message), message });
  const engine = new QueryEngine({ model, initialMessages: priorHistory, toolContext: { cwd: workspace, sessionId, scopedTools: [] }, maxTurns: 2 });
  // Exact ordering of useAgentSession: stamp the turn and persist raw input before submitMessage.
  const messageId = engine.beginUserTurn();
  await appendTranscriptEntry(workspace, sessionId, { type: "message", timestamp: new Date().toISOString(), role: "user", message: { role: "user", content: requirement }, messageId });
  const run = engine.submitMessage(requirement); let compactions = 0;
  while (true) {
    const next = await run.next();
    if (next.done) { assert.equal(next.value.reason, "completed"); break; }
    const event = next.value;
    // Mirror the actual CLI TUI consumer using the shared storage functions.
    if (event.type === "compacted" && event.trigger !== "micro") {
      compactions++;
      await appendCompactionSnapshot(workspace, sessionId, event.trigger as "auto" | "manual", engine.getState().messages);
    } else if (event.type === "assistant_message" || event.type === "tool_result_message") {
      await appendTranscriptEntry(workspace, sessionId, { type: "message", timestamp: new Date().toISOString(), role: transcriptRole(event.message), message: event.message, messageId });
    } else if (event.type === "usage_updated") {
      await appendTranscriptEntry(workspace, sessionId, { type: "usage", timestamp: new Date().toISOString(), turn: event.turnUsage, total: event.totalUsage });
    }
  }
  assert.equal(summaries, 1); assert.equal(compactions, 1); assert.equal(mainCalls, 1);
  const completed = engine.getState(), restored = await restoreSession(workspace, sessionId);
  const count = (messages: MessageParam[]) => messages.filter(message => message.role === "user" && message.content === requirement).length;
  assert.equal(count(completed.messages), 1, "The live engine retains the newly accepted requirement exactly once");
  assert.equal(count(restored.messages), 1, "CLI resume must retain the new requirement beyond the compaction marker exactly once");
  assert.deepEqual(restored.messages, completed.messages, "Persisted/resumed history must match the engine after pre-turn auto-compaction");
  assert.deepEqual(fixtureErrors, []);
  console.log("PASS CLI TUI persistence order: pre-turn automatic compaction retains the new user requirement exactly once through restore; 1 summary and 1 main request, zero external providers.");
} finally {
  supplier.closeAllConnections(); await new Promise<void>(resolve => supplier.close(() => resolve())); await account.close();
  globalThis.fetch = originalFetch; process.chdir(originalCwd);
  for (const key of Object.keys(process.env)) if (!(key in originalEnvironment)) delete process.env[key]; Object.assign(process.env, originalEnvironment);
  const relative = path.relative(parent, temporary); assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative) && path.basename(temporary).startsWith("ccagent-cli-compact-persistence-")); await fs.rm(temporary, { recursive: true, force: true });
}
