/** Authenticated real agent loop/HTTP regression: a route cap must not create an identical paid retry. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { startAccountFixture } from "./helpers/accountFixture.js";
import { enterPlatformAccount } from "../platform/account.js";
import { saveOfficialServices } from "../platform/gatewayClient.js";
import { query, type AgenticLoopEvent } from "../core/agenticLoop.js";
import { DEFAULT_MAX_TOKENS, ESCALATED_MAX_TOKENS, MAX_OUTPUT_TOKENS_RECOVERY_LIMIT } from "../services/api/client.js";

const parent = await fs.realpath(os.tmpdir());
const temporary = await fs.realpath(await fs.mkdtemp(path.join(parent, "ccagent-token-escalation-")));
const base = path.join(temporary, "profile"), workspace = path.join(temporary, "workspace"); await fs.mkdir(workspace);
const previousEnvironment = { ...process.env }, previousCwd = process.cwd();
process.env.CCAGENT_HOME = base; process.env.CCAGENT_PLATFORM_HOME = base;
for (const key of Object.keys(process.env)) if (/API.?KEY|SECRET|TOKEN/i.test(key) || /^(ANTHROPIC|OPENAI|QWEN|DASHSCOPE|OLLAMA|GEMINI)_/i.test(key) || ["CCAGENT_ACCOUNT_ID", "CCAGENT_AUTH_SESSION_FILE", "CCAGENT_CLOUD_URL", "CCAGENT_ENV_FILE", "NODE_TLS_REJECT_UNAUTHORIZED"].includes(key)) delete process.env[key];
process.env.CCAGENT_DISABLE_STREAM_LOG = "1";
process.chdir(workspace);
const platformKey = "ccagent_" + randomBytes(32).toString("base64url");
const routes = [
  { id: "capped-chat", protocol: "openai-chat", maxOutputTokens: 64 },
  { id: "large-chat", protocol: "openai-chat", maxOutputTokens: 128000 },
  { id: "capped-responses", protocol: "openai-responses", maxOutputTokens: 64 },
].map(item => ({ id: item.id, name: item.id, service: "chat", protocol: item.protocol,
  pricing: { currency: "CNY", definition: { rates: [{ metric: "requests", price: "1", unitQuantity: "1" }], tariff: { kind: "constant" } }, markup: "1.3", version: 1, usdCny: null, sourceUrl: "https://example.invalid/pricing" },
  limits: { contextWindow: 262144, maxOutputTokens: item.maxOutputTokens, maxImages: 0, fallbackEnabled: false, fallbackRouteId: null },
}));
const requests: Array<{ model: string; body: Record<string, any>; requestId?: string }> = [];
const supplierErrors: string[] = [];
async function respond(request: IncomingMessage, response: ServerResponse, official: boolean) {
  try {
    let raw = ""; for await (const bytes of request) raw += bytes;
    const body = JSON.parse(raw), model = String(body.model), messages = body.messages ?? body.input;
    assert.ok(Array.isArray(messages)); assert.equal(body.stream, true);
    if (official) { assert.equal(request.headers.authorization, "Bearer " + platformKey); assert.match(String(request.headers["idempotency-key"]), /^[a-f0-9-]{36}$/); }
    requests.push({ model, body, requestId: official ? String(request.headers["idempotency-key"]) : undefined });
    const own = requests.filter(item => item.model === model && JSON.stringify(item.body).includes("SCENARIO_" + scenario));
    const truncated = scenario === "repeat-limit" || own.length === 1;
    const content = truncated ? `PRESERVED_PARTIAL_${own.length}` : "FINISHED_AFTER_LIMIT";
    const usage = { input_tokens: 40, output_tokens: 12 };
    response.writeHead(200, { "content-type": "text/event-stream" });
    if (request.url === "/v1/responses") {
      const terminal = truncated ? { type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, usage } } : { type: "response.completed", response: { status: "completed", usage } };
      for (const event of [{ type: "response.output_text.delta", delta: content }, terminal]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      response.end();
    } else {
      response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`);
      response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: truncated ? "length" : "stop" }], usage: { prompt_tokens: 40, completion_tokens: 12 } })}\n\ndata: [DONE]\n\n`);
    }
  } catch (error) {
    supplierErrors.push(error instanceof Error ? error.message : String(error));
    if (!response.headersSent) response.writeHead(500); response.end("Synthetic fixture assertion failed");
  }
}
let scenario = "";
let fixture: Awaited<ReturnType<typeof startAccountFixture>>;
fixture = await startAccountFixture(base, { handleService: async (request, response, user) => {
  if (!user) { response.writeHead(401); response.end("{}"); return true; }
  if (request.url === "/v1/models") { assert.equal(request.headers.authorization, "Bearer " + platformKey); response.writeHead(200); response.end(JSON.stringify({ data: routes })); return true; }
  if (["/v1/chat/completions", "/v1/responses"].includes(request.url ?? "")) { await respond(request, response, true); return true; }
  return false;
} });
const local = createServer((request, response) => { void respond(request, response, false); });
await new Promise<void>(resolve => local.listen(0, "127.0.0.1", resolve));
const address = local.address(); assert.ok(address && typeof address !== "string");
let passed = 0;
async function test(name: string, action: () => Promise<void>) { await action(); passed++; console.log("PASS " + name); }
async function run(model: string, name: string) {
  scenario = name; const before = requests.length;
  const iterator = query({ messages: [{ role: "user", content: "SCENARIO_" + scenario }], model, contextWindow: 262144,
    toolContext: { cwd: workspace, sessionId: "token-limit-fixture-" + scenario }, maxTurns: 8, abortSignal: AbortSignal.timeout(20000) });
  const events: AgenticLoopEvent[] = [];
  while (true) { const next = await iterator.next(); if (next.done) return { result: next.value, events, calls: requests.slice(before) }; events.push(next.value); }
}
try {
  await fixture.nativeClient.signIn(fixture.users[0]!.email, fixture.password); const { home } = await enterPlatformAccount();
  const settings = { disableAllHooks: true, mcpServers: {}, models: {
    "token-local-uncapped": { protocol: "openai-chat", model: "token-local-uncapped", baseURL: `http://127.0.0.1:${address.port}/v1`, apiKey: "fixture-only" },
    "token-custom-fixed": { protocol: "openai-chat", model: "token-custom-fixed", baseURL: `http://127.0.0.1:${address.port}/v1`, apiKey: "fixture-only", maxTokens: 4096 },
  } };
  await fs.writeFile(path.join(home, "settings.json"), JSON.stringify(settings));
  await saveOfficialServices({ apiKey: platformKey, roles: { main: "capped-chat" }, auxiliaryEnabled: false });
  for (const [id, name, cap, key] of [["capped-chat", "small-chat", 64, "max_tokens"], ["large-chat", "large-chat", 128000, "max_tokens"], ["capped-responses", "responses", 64, "max_output_tokens"]] as const) {
    await test(`official ${name} continues preserved output without an identical or smaller-cap paid restart`, async () => {
      const { result, events, calls } = await run("ccagent:" + id, name);
      assert.equal(result.reason, "completed"); assert.equal(calls.length, 2); assert.ok(calls.every(call => call.body[key] === cap));
      assert.equal(events.some(event => event.type === "stream_restart" && event.reason === "max_tokens_escalation"), false);
      const continuation = JSON.stringify(calls[1]!.body);
      assert.match(continuation, /PRESERVED_PARTIAL_1/); assert.match(continuation, /Output token limit hit/);
      assert.match(JSON.stringify(result.state.messages), /PRESERVED_PARTIAL_1/); assert.match(JSON.stringify(result.state.messages), /FINISHED_AFTER_LIMIT/);
      assert.equal(new Set(calls.map(call => call.requestId)).size, 2, "Distinct continuation input keeps a distinct logical request identity");
    });
  }
  await test("repeated official truncation retains the existing bounded continuation limit without duplicate paid attempts", async () => {
    const { result, events, calls } = await run("ccagent:capped-chat", "repeat-limit");
    assert.equal(result.reason, "completed"); assert.equal(calls.length, MAX_OUTPUT_TOKENS_RECOVERY_LIMIT + 1);
    assert.equal(events.filter(event => event.type === "stream_restart").length, 0);
    assert.equal(new Set(calls.map(call => JSON.stringify(call.body))).size, calls.length);
    for (let index = 1; index <= calls.length; index++) assert.match(JSON.stringify(result.state.messages), new RegExp("PRESERVED_PARTIAL_" + index));
  });
  await test("ordinary uncapped local/custom models retain the genuine default-to-64K escalation", async () => {
    const { result, events, calls } = await run("token-local-uncapped", "local-uncapped");
    assert.equal(result.reason, "completed"); assert.equal(calls.length, 2);
    assert.equal(calls[0]!.body.max_tokens, DEFAULT_MAX_TOKENS); assert.equal(calls[1]!.body.max_tokens, ESCALATED_MAX_TOKENS);
    assert.deepEqual(calls[0]!.body.messages, calls[1]!.body.messages);
    assert.equal(events.filter(event => event.type === "stream_restart" && event.reason === "max_tokens_escalation").length, 1);
    assert.equal(JSON.stringify(result.state.messages).includes("PRESERVED_PARTIAL_1"), false);
  });
  await test("explicit custom maxTokens behavior remains unchanged by the official-only fix", async () => {
    const { result, events, calls } = await run("token-custom-fixed", "custom-fixed");
    assert.equal(result.reason, "completed"); assert.deepEqual(calls.map(call => call.body.max_tokens), [4096, 4096]);
    assert.equal(events.filter(event => event.type === "stream_restart" && event.reason === "max_tokens_escalation").length, 1);
    assert.deepEqual(supplierErrors, []);
  });
  console.log(`Platform token escalation: ${passed} checks passed; actual authenticated loop/HTTP, synthetic suppliers, no production billing.`);
} finally {
  local.closeAllConnections(); await new Promise<void>(resolve => local.close(() => resolve())); await fixture.close();
  process.chdir(previousCwd);
  for (const key of Object.keys(process.env)) if (!(key in previousEnvironment)) delete process.env[key];
  Object.assign(process.env, previousEnvironment);
  const relative = path.relative(parent, temporary); assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative) && path.basename(temporary).startsWith("ccagent-token-escalation-"));
  await fs.rm(temporary, { recursive: true, force: true });
}
