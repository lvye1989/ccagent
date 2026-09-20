#!/usr/bin/env tsx

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages.js";
import {
  buildTokenBudgetSnapshot,
  getContextWindowForModel,
} from "../utils/tokens.js";
import {
  calculateTokenWarningState,
  getAutoCompactThreshold,
  getBlockingLimit,
} from "../context/autoCompact.js";
import { selectCompactionTail } from "../context/compaction.js";
import { query } from "../core/agenticLoop.js";

console.log("=== model-aware context windows ===");
assert.equal(getContextWindowForModel("deepseek-flash"), 1_048_576);
assert.equal(getContextWindowForModel("custom-profile", 320_000), 320_000);

const previousOverride = process.env.CCAGENT_MAX_CONTEXT_TOKENS;
process.env.CCAGENT_MAX_CONTEXT_TOKENS = "777777";
assert.equal(
  getContextWindowForModel("deepseek-flash", 320_000),
  777_777,
  "process override takes precedence over a profile value",
);
if (previousOverride === undefined) delete process.env.CCAGENT_MAX_CONTEXT_TOKENS;
else process.env.CCAGENT_MAX_CONTEXT_TOKENS = previousOverride;

console.log("=== proportional thresholds ===");
const window = 1_048_576;
const auto = getAutoCompactThreshold("deepseek-flash", window);
const blocking = getBlockingLimit("deepseek-flash", window);
assert.ok(auto < blocking, "automatic compaction starts before the blocking limit");
assert.ok(window - auto > 50_000, "large windows retain a meaningful safety buffer");

const warning = calculateTokenWarningState(auto, "deepseek-flash", window);
assert.equal(warning.state, "error");
assert.equal(warning.contextWindow, window);

const snapshot = buildTokenBudgetSnapshot(
  [{ role: "user", content: "hello" }],
  { model: "profile-handle", contextWindow: 320_000 },
);
assert.equal(snapshot.contextWindow, 320_000);
assert.ok(snapshot.autoCompactThreshold < snapshot.manualCompactThreshold);

console.log("=== token-bounded compaction tail ===");
const smallHistory: MessageParam[] = Array.from({ length: 12 }, (_, index) => ({
  role: index % 2 === 0 ? "user" : "assistant",
  content: `message-${index}`,
}));
assert.equal(selectCompactionTail(smallHistory, 8, 2_000).length, 8);

const hugeTail: MessageParam[] = [
  ...smallHistory.slice(0, 10),
  { role: "user", content: "x".repeat(100_000) },
];
assert.equal(
  selectCompactionTail(hugeTail, 8, 2_000).length,
  0,
  "a giant recent message is summarized instead of reinserted verbatim",
);

console.log("=== proactive agent-loop compaction ===");
const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ccagent-context-"));
const projectDir = path.join(testRoot, "project");
await fs.mkdir(path.join(projectDir, ".ccagent"), { recursive: true });
await fs.writeFile(
  path.join(projectDir, ".ccagent", "settings.json"),
  JSON.stringify({
    models: {
      looptest: {
        protocol: "openai-chat",
        model: "loop-test-model",
        baseURL: "https://context.test/v1",
        apiKey: "${CTX_TEST_KEY}",
        contextWindow: 20_000,
      },
    },
  }),
);
process.env.CTX_TEST_KEY = "test-only";

const originalFetch = globalThis.fetch;
const originalCwd = process.cwd();
let fetchCalls = 0;
globalThis.fetch = (async () => {
  fetchCalls++;
  const content = fetchCalls === 1 ? "Durable compact summary." : "Continued after compaction.";
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content } }] })}\n\n`,
      ));
      controller.enqueue(encoder.encode(
        `data: ${JSON.stringify({
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
        })}\n\n`,
      ));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}) as typeof fetch;

try {
  process.chdir(projectDir);
  const oversizedHistory: MessageParam[] = Array.from({ length: 31 }, (_, index) => ({
    role: index % 2 === 0 ? "user" as const : "assistant" as const,
    content: `${index}:` + "z".repeat(2_000),
  }));
  const events: string[] = [];
  const errors: string[] = [];
  const loop = query({
    messages: oversizedHistory,
    model: "looptest",
    contextWindow: 20_000,
    toolContext: { cwd: projectDir },
    maxTurns: 2,
  });
  let next = await loop.next();
  while (!next.done) {
    events.push(next.value.type);
    if (next.value.type === "error") errors.push(next.value.error.message);
    next = await loop.next();
  }

  assert.equal(fetchCalls, 2, "one summary request is followed by one normal model request");
  assert.ok(events.includes("context_compacted"), "the loop reports automatic compaction");
  assert.ok(events.includes("text"), "generation continues after compaction");
  assert.deepEqual(errors, [], "the recovered turn does not surface a blocking error");
  assert.equal(next.value.reason, "completed");
} finally {
  process.chdir(originalCwd);
  globalThis.fetch = originalFetch;
  delete process.env.CTX_TEST_KEY;
  await fs.rm(testRoot, { recursive: true, force: true });
}

console.log("All context-compaction checks passed.");
