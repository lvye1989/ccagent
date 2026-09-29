/** Offline regression for Anthropic-to-OpenAI tool-choice translation. */
import assert from "node:assert/strict";

import { prepareRequest } from "../services/api/providers/providerStream.js";
import type { ModelProfile } from "../services/api/providers/profile.js";
import type { StreamRequestParams } from "../services/api/streaming.js";

const tools: NonNullable<StreamRequestParams["tools"]> = [{
  name: "Echo",
  description: "Return the supplied text",
  input_schema: {
    type: "object",
    properties: { text: { type: "string" } },
  },
}];

const choices: Array<{
  choice: NonNullable<StreamRequestParams["toolChoice"]>;
  chat: unknown;
  responses: unknown;
}> = [
  {
    choice: { type: "tool", name: "Echo" },
    chat: { type: "function", function: { name: "Echo" } },
    responses: { type: "function", name: "Echo" },
  },
  { choice: { type: "any" }, chat: "required", responses: "required" },
  { choice: { type: "auto" }, chat: "auto", responses: "auto" },
  { choice: { type: "none" }, chat: "none", responses: "none" },
];

let checks = 0;
for (const protocol of ["openai-chat", "openai-responses"] as const) {
  const profile: ModelProfile = { id: "test", protocol, model: "test-model" };
  const request = (toolChoice?: StreamRequestParams["toolChoice"]) =>
    prepareRequest(profile, {
      messages: [{ role: "user", content: "Use Echo." }],
      tools,
      toolChoice,
    }).body;

  for (const { choice, chat, responses } of choices) {
    const body = request(choice);
    assert.deepEqual(body.tool_choice, protocol === "openai-chat" ? chat : responses);
    checks++;
  }

  const serial = request({ type: "tool", name: "Echo", disable_parallel_tool_use: true });
  assert.equal(serial.parallel_tool_calls, false);
  checks++;

  const defaultChoice = request();
  assert.equal(defaultChoice.tool_choice, undefined);
  assert.equal(defaultChoice.parallel_tool_calls, undefined);
  checks += 2;
}

console.log(`[pass] OpenAI tool_choice translation (${checks} checks, no provider calls)`);
