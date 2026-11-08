import assert from "node:assert/strict";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { startAccountFixture } from "./helpers/accountFixture.js";
import { enterPlatformAccount } from "../platform/account.js";
import { authorizedPrivateUploadUrl, forgetOfficialKey, getPlatformGatewayClient, officialRole, officialServicesView, saveOfficialServices } from "../platform/gatewayClient.js";
import { servicePaths, readServiceBinding } from "../platform/serviceState.js";
import { loadProfiles, resolveProfile } from "../services/api/providers/profile.js";
import { streamMessage, createMessage } from "../services/api/streaming.js";
import { QueryEngine } from "../core/queryEngine.js";
import { analyzeImageFile } from "../services/vision/analyzeImage.js";
import { callOpenRouterJev } from "../services/jev/openRouterJev.js";
import { createAdapter, createFallbackAdapters } from "../tools/webSearch/adapters.js";
import { workfriendDeliverTool } from "../tools/workfriendDeliverTool.js";
import { inPlatformTask } from "../platform/taskScope.js";
import { runAccountCommand } from "../entrypoint/account.js";

const temporaryRoot = await realpath(os.tmpdir());
const directory = await mkdtemp(path.join(temporaryRoot, "ccagent-official-client-")), base = path.join(directory, "platform"), workspace = path.join(directory, "workspace");
await mkdir(base); await mkdir(workspace);
const envNames = ["CCAGENT_HOME", "CCAGENT_PLATFORM_HOME", "CCAGENT_ACCOUNT_ID", "CCAGENT_AUTH_SESSION_FILE", "CCAGENT_CLOUD_URL", "CCAGENT_ENV_FILE", "NODE_TLS_REJECT_UNAUTHORIZED", "OPENROUTER_API_KEY", "TAVILY_API_KEY", "BOCHA_API_KEY", "DASHSCOPE_API_KEY", "QWEN_API_KEY"];
const previous = Object.fromEntries(envNames.map(name => [name, process.env[name]]));
process.env.CCAGENT_HOME = base; process.env.CCAGENT_PLATFORM_HOME = base;
for (const name of ["CCAGENT_ACCOUNT_ID", "CCAGENT_AUTH_SESSION_FILE", "CCAGENT_CLOUD_URL", "CCAGENT_ENV_FILE", "NODE_TLS_REJECT_UNAUTHORIZED"]) delete process.env[name];
const keys = new Map([["fixture-account-a", "ccagent_" + randomBytes(32).toString("base64url")], ["fixture-account-b", "ccagent_" + randomBytes(32).toString("base64url")]]);
const routes = [
  { id: "official-main", name: "Official Responses", service: "chat", protocol: "openai-responses" },
  { id: "official-vision", name: "Official vision", service: "vision", protocol: "openai-chat" },
  { id: "official-decision", name: "Official Jev", service: "decision", protocol: "jev-decisions" },
  { id: "official-search", name: "Official Tavily", service: "search", protocol: "tavily" },
  { id: "official-bocha", name: "Official Bocha", service: "search", protocol: "bocha" },
  { id: "official-voice", name: "Official voice", service: "voice", protocol: "dashscope-tts" },
].map(route => ({ ...route, pricing: { currency: "CNY", definition: { rates: [{ metric: "requests", price: "1", unitQuantity: "1" }], tariff: { kind: "constant" } }, markup: "1.3", usdCny: null, version: 1, sourceUrl: "https://example.com/pricing", fingerprint: undefined as string | undefined }, limits: { contextWindow: 131072, maxOutputTokens: 64, maxImages: 20, fallbackRouteId: null as string | null, fallbackEnabled: false } }));
const roles = { main: "official-main", image: "official-vision", decision: "official-decision", search: "official-search", voice: "official-voice" };
const recommended = { chat: 'official-main', vision: 'official-vision', decision: 'official-decision', search: 'official-bocha', voice: 'official-voice' };
let catalogMode: 'normal' | 'invalid' | 'legacy' = 'normal';
let heldCatalog: { arrived: () => void; wait: Promise<void> } | undefined;
type StoredFile = { owner: string; bytes: Buffer; token: string; ready: boolean; deleted?: boolean };
const files = new Map<string, StoredFile>();
const calls = new Map<string, { owner: string; body: any; taskId: string; status: string; result: string; contentType: string; id: string }>();
const sent: { body: any; requestId: string; taskId: string; path: string; pins: Record<string, string | string[] | undefined> }[] = [];
let suppliers = 0, modelRequests = 0, lookups = 0, uploads = 0, deletes = 0, uploadMode = "normal";
const wav = Buffer.alloc(44); wav.write("RIFF", 0); wav.writeUInt32LE(36, 4); wav.write("WAVEfmt ", 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write("data", 36);
let fixture: Awaited<ReturnType<typeof startAccountFixture>>;
fixture = await startAccountFixture(base, { handleService: async (req, res, user) => {
  const url = new URL(req.url!, fixture.origin);
  const reply = (status: number, value: unknown) => { res.writeHead(status); res.end(JSON.stringify(value)); return true; };
  const data = async () => { const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk)); return Buffer.concat(chunks); };
  if (req.method === "PUT" && url.pathname.startsWith("/ccagent/users/")) {
    assert(!req.headers.cookie && !req.headers.authorization, "Blob upload receives no account Cookie or platform Key");
    const id = path.posix.basename(url.pathname, ".json"), file = files.get(id);
    if (!file || file.token !== url.searchParams.get("token")) return reply(403, {});
    if (uploadMode === "redirect") { res.writeHead(302, { location: "https://attacker.invalid/upload" }); res.end(); return true; }
    assert(req.headers["x-content-type"] === "application/json", "Required Blob object type header is retained");
    file.bytes = await data(); uploads++; return reply(200, { uploaded: true });
  }
  if (!user) return reply(401, { code: "UNAUTHORIZED" });
  if (url.pathname === "/api/account/me") return reply(200, { user, permissions: user.id.endsWith("-a") ? ["admin.read"] : [] });
  if (url.pathname === "/api/account/wallet") return reply(200, { wallet: { available: "1000000", frozen: "0" }, entries: [] });
  if (url.pathname.startsWith("/api/account/calls/")) {
    lookups++;
    const call = calls.get(decodeURIComponent(url.pathname.split("/").at(-1)!));
    if (!call || call.owner !== user.id) return reply(404, { code: "CALL_NOT_FOUND" });
    return reply(200, { id: call.id, status: call.status, resultAvailable: call.status === "settled", charged: "13" });
  }
  if (url.pathname === "/api/files" && req.method === "POST") {
    const input = JSON.parse((await data()).toString("utf8")); assert.equal(input.purpose, "request");
    const id = randomUUID(), token = randomUUID(); files.set(id, { owner: user.id, token, bytes: Buffer.alloc(0), ready: false });
    const prefix = createHash("sha256").update(user.id).digest("hex").slice(0, 32);
    const target = uploadMode === "attacker" ? "https://attacker.invalid" : fixture.origin;
    return reply(201, { id, upload: { url: `${target}/ccagent/users/${prefix}/request/${id}.json?token=${token}`, method: "PUT", headers: { "content-type": "application/json", "x-content-type": "application/json" }, validUntil: Date.now() + 120000 } });
  }
  if (url.pathname.startsWith("/api/files/")) {
    const id = url.pathname.split("/").at(-1)!, file = files.get(id);
    if (!file || file.owner !== user.id || file.deleted) return reply(404, { code: "FILE_NOT_FOUND" });
    if (req.method === "POST") { file.ready = true; return reply(200, { id, ready: true }); }
    if (req.method === "DELETE") { file.deleted = true; deletes++; return reply(200, { deleted: true }); }
    res.writeHead(200, { "content-type": "audio/wav", "content-length": file.bytes.length }); res.end(file.bytes); return true;
  }
  if (!url.pathname.startsWith("/v1/")) return false;
  if (req.headers.authorization !== `Bearer ${keys.get(user.id)}`) return reply(403, { code: "INVALID_KEY" });
  if (url.pathname === "/v1/models") {
    const held = heldCatalog; heldCatalog = undefined;
    if (held) { held.arrived(); await held.wait; }
    return reply(200, { object: "list", data: routes, defaults: catalogMode === 'legacy' ? undefined : catalogMode === 'invalid' ? { chat: 'official-voice' }
      : Object.fromEntries(Object.entries(recommended).map(([service, id]) => [service, routes.some(route => route.id === id && route.service === service) ? id : null])) });
  }
  let body = JSON.parse((await data()).toString("utf8"));
  if (body.request_file_id) {
    assert.deepEqual(Object.keys(body), ["request_file_id"]);
    const file = files.get(body.request_file_id); assert(file?.owner === user.id && file.ready);
    body = JSON.parse(file.bytes.toString("utf8"));
  }
  const requestId = String(req.headers["idempotency-key"]), taskId = String(req.headers["x-ccagent-task-id"]);
  assert.equal(req.headers["x-ccagent-price-version"], "1", "The client pins the displayed price version before a paid call");
  assert.match(requestId, /^[a-f0-9-]{36}$/); assert(taskId && taskId !== "undefined");
  modelRequests++; sent.push({ body, requestId, taskId, path: url.pathname, pins: Object.fromEntries(['x-ccagent-price-version','x-ccagent-price-fingerprint','x-ccagent-fallback-route','x-ccagent-fallback-price-version','x-ccagent-fallback-price-fingerprint'].map(name => [name, req.headers[name]])) });
  if (JSON.stringify(body).includes("INSUFFICIENT_CASE")) return reply(402, { code: "INSUFFICIENT_BALANCE", message: keys.get(user.id) });
  let call = calls.get(requestId);
  if (call) {
    if (call.owner !== user.id || JSON.stringify(call.body) !== JSON.stringify(body) || call.taskId !== taskId) return reply(409, { code: "IDEMPOTENCY_CONFLICT" });
    if (call.status !== "settled") return reply(409, { code: "CALL_IN_PROGRESS" });
    res.setHeader("content-type", call.contentType); res.setHeader("x-ccagent-call-id", call.id); res.setHeader("x-ccagent-replay", "true"); res.end(call.result); return true;
  }
  suppliers++;
  const usage = { input_tokens: 10, output_tokens: 2 };
  let result: unknown = { id: randomUUID(), object: "response", status: "completed", model: body.model, output: [{ type: "message", content: [{ type: "output_text", text: "PLATFORM_OK" }] }], usage };
  if (url.pathname === "/v1/chat/completions") result = { id: randomUUID(), object: "chat.completion", model: body.model, choices: [{ index: 0, message: { role: "assistant", content: "VISION_OK" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2 } };
  if (url.pathname === "/v1/decisions") result = { model: "~typesafe/jev-latest", answers: { q: { type: "choice", choice: "allow", probabilities: { allow: 1, deny: 0 } } }, usage };
  if (url.pathname === "/v1/search") result = body.model === "official-bocha" ? { code: 200, data: { webPages: { value: [{ name: "Owned result", url: "https://example.com/source", snippet: "BOCHA_EVIDENCE" }] } } } : { results: [{ title: "Owned result", url: "https://example.com/source", content: "TAVILY_EVIDENCE" }] };
  if (url.pathname === "/v1/voice") { const id = randomUUID(); files.set(id, { owner: user.id, bytes: wav, token: "", ready: true }); result = { model: body.model, audio: { file_id: id }, usage }; }
  let contentType = "application/json", resultText = JSON.stringify(result);
  if (body.stream && url.pathname === "/v1/responses") {
    contentType = "text/event-stream";
    resultText = [{ type: "response.created", response: { id: "native-response", model: body.model } }, { type: "response.output_text.delta", delta: "PLATFORM_OK" }, { type: "response.completed", response: result }].map(value => `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`).join("");
  }
  if (body.stream && url.pathname === "/v1/chat/completions") {
    contentType = "text/event-stream";
    resultText = [{ id: "vision", model: body.model, choices: [{ index: 0, delta: { role: "assistant", content: "VISION_OK" }, finish_reason: null }] }, { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2 } }].map(value => `data: ${JSON.stringify(value)}\n\n`).join("") + "data: [DONE]\n\n";
  }
  call = { owner: user.id, body, taskId, status: JSON.stringify(body).includes("PENDING_STREAM_CASE") ? "pending" : "settled", result: resultText, contentType, id: randomUUID() }; calls.set(requestId, call);
  if (JSON.stringify(body).includes("DROP_CONNECTION_CASE")) { req.socket.destroy(); return true; }
  res.setHeader("content-type", contentType); res.setHeader("x-ccagent-call-id", call.id);
  if (call.status === "pending") { res.write("event: response.output_text.delta\ndata: {\"delta\":\"partial\"}\n\n"); setTimeout(() => req.socket.destroy(), 20); return true; }
  res.end(resultText); return true;
} });
let checks = 0;
async function test(name: string, action: () => Promise<void>) { await action(); checks++; console.log(`PASS ${name}`); }
const key = keys.get(fixture.users[0]!.id)!;
const baseInput = (text: string) => ({ model: "official-main", input: text, max_output_tokens: 16 });
try {
  await test("presigned Blob API URLs enforce the exact origin and owned object path", async () => {
    const expected = `/ccagent/users/${"a".repeat(32)}/request/${randomUUID()}.json`;
    const valid = new URL("https://vercel.com/api/blob/"); valid.searchParams.set("pathname", expected.slice(1));
    assert(authorizedPrivateUploadUrl(valid, expected, fixture.origin));
    for (const mutate of [
      (url: URL) => { url.hostname = "vercel.com.attacker.invalid"; },
      (url: URL) => { url.protocol = "http:"; },
      (url: URL) => { url.port = "444"; },
      (url: URL) => { url.username = "secret"; },
      (url: URL) => { url.pathname = "/api/other/"; },
      (url: URL) => { url.searchParams.set("pathname", "ccagent/users/another-owner/request/other.json"); },
      (url: URL) => { url.searchParams.append("pathname", expected.slice(1)); },
    ]) { const invalid = new URL(valid); mutate(invalid); assert(!authorizedPrivateUploadUrl(invalid, expected, fixture.origin)); }
  });
  await fixture.nativeClient.signIn(fixture.users[0]!.email, fixture.password); const { home } = await enterPlatformAccount();
  await test("a supplier Key is rejected before catalog access", async () => { await assert.rejects(saveOfficialServices({ apiKey: "sk-not-a-platform-key" }), /CCAGENT API Key/); });
  await test('delayed catalog verification preserves another window selections empty selections and rotated Keys', async () => {
    for (const selected of [{ search: 'official-search' }, {}]) {
      let release!: () => void, arrived!: () => void;
      const wait = new Promise<void>(resolve => { release = resolve; }), observed = new Promise<void>(resolve => { arrived = resolve; });
      heldCatalog = { arrived, wait };
      const delayed = saveOfficialServices({ apiKey: key });
      try {
        await Promise.race([observed, delay(5000).then(() => { throw new Error('CATALOG_WAIT_NOT_OBSERVED'); })]);
        await saveOfficialServices({ apiKey: key, roles: selected });
        release(); await delayed;
        assert.deepEqual((await readServiceBinding())!.configuration.roles, selected);
      } finally { release(); await delayed; await forgetOfficialKey(); }
    }
    await saveOfficialServices({ apiKey: key });
    let release!: () => void, arrived!: () => void;
    heldCatalog = { arrived: () => arrived(), wait: new Promise<void>(resolve => { release = resolve; }) };
    const observed = new Promise<void>(resolve => { arrived = resolve; });
    const refresh = saveOfficialServices({}), refused = assert.rejects(refresh, (error: unknown) => error instanceof Error && 'code' in error && error.code === 'SERVICE_CONFIGURATION_CHANGED');
    const rotated = 'ccagent_' + randomBytes(32).toString('base64url'), owner = fixture.users[0]!.id;
    try {
      await Promise.race([observed, delay(5000).then(() => { throw new Error('CATALOG_WAIT_NOT_OBSERVED'); })]);
      keys.set(owner, rotated); await saveOfficialServices({ apiKey: rotated, roles: {} });
      release(); await refused;
      assert.equal(createHash('sha256').update((await readServiceBinding())!.credential.apiKey).digest('hex'), createHash('sha256').update(rotated).digest('hex'));
    } finally { release(); await refused; keys.set(owner, key); await saveOfficialServices({ apiKey: key, roles: {} }); await forgetOfficialKey(); }
  });
  await test('first platform Key verification uses published defaults without enabling auxiliary services or calling suppliers', async () => {
    const before = modelRequests;
    await saveOfficialServices({ apiKey: key });
    const configuration = (await readServiceBinding())!.configuration;
    assert.deepEqual(configuration.roles, { ...roles, search: 'official-bocha' });
    assert.equal(configuration.auxiliaryEnabled, false); assert.equal(modelRequests, before);
  });
  await test("platform Key validation saves encrypted credentials and public catalog separately", async () => {
    await saveOfficialServices({ apiKey: key, roles, auxiliaryEnabled: false });
    const bytes = await readFile(servicePaths().key, "utf8");
    if (process.platform === "win32") assert(!bytes.includes(key), "DPAPI file does not contain the plaintext Key");
    assert(!(await readFile(servicePaths().state, "utf8")).includes(key));
    const view = await officialServicesView(); assert(view.configured); assert.equal(view.routes.length, 6); assert.equal(view.wallet && (view.wallet as any).available, "1000000");
    assert(!JSON.stringify(view).includes(key), "No full Key is returned by the settings API");
  });
  await test("official profiles override reserved user entries without exposing a Key", async () => {
    await writeFile(path.join(home, "settings.json"), JSON.stringify({ models: { "ccagent:official-main": { protocol: "openai-chat", model: "steal", baseURL: "https://attacker.invalid/v1", apiKey: "private-secret" }, personal: { protocol: "openai-chat", model: "private", baseURL: "https://private.invalid/v1", apiKey: "private-secret" } } }));
    const { profiles } = await loadProfiles(workspace); assert(profiles.personal);
    assert.equal(profiles["ccagent:official-main"]!.baseURL, fixture.origin + "/v1"); assert.equal(profiles["ccagent:official-main"]!.apiKey, undefined);
  });
  let client = await getPlatformGatewayClient();
  await test("native request identity and result replay execute one synthetic supplier operation", async () => {
    const requestId = randomUUID(), input = baseInput("SYNTHETIC_PROMPT_NOT_STORED"), before = suppliers;
    assert.equal((await (await client.call("responses", input, { requestId, taskId: "same-task" })).json()).output[0].content[0].text, "PLATFORM_OK");
    const replay = await client.call("responses", input, { requestId, taskId: "same-task" }); assert.equal(replay.headers.get("x-ccagent-replay"), "true"); await replay.json();
    assert.equal(suppliers - before, 1); await assert.rejects(client.call("responses", { ...input, input: "changed" }, { requestId, taskId: "same-task" }), /同一调用标识/);
    const journal = await readFile(servicePaths().journal, "utf8"); assert(!journal.includes(key)); assert(!journal.includes("SYNTHETIC_PROMPT_NOT_STORED"));
  });
  await test("a lost connection queries status then replays using its original identity", async () => {
    const before = suppliers, checkedBefore = lookups;
    const result = await client.call("responses", baseInput("DROP_CONNECTION_CASE")); assert.equal((await result.json()).status, "completed");
    assert.equal(suppliers - before, 1); assert(lookups > checkedBefore);
    assert.equal(sent.at(-1)!.requestId, sent.at(-2)!.requestId);
  });
  await test("a disconnected pending stream prevents a second paid POST even with a new local id", async () => {
    const input = { ...baseInput("PENDING_STREAM_CASE"), stream: true }, before = modelRequests;
    const response = await client.call("responses", input, { taskId: "pending-task" }); await assert.rejects(response.text());
    await assert.rejects(client.call("responses", input, { taskId: "pending-task" }), /原调用仍在执行/);
    assert.equal(modelRequests - before, 1);
  });
  await test("large JSON uses private upload, exact required headers, finalization and cleanup", async () => {
    const before = uploads, deletedBefore = deletes;
    const response = await client.call("responses", baseInput("x".repeat(3 * 1024 * 1024 + 100))); await response.json();
    for (let i = 0; deletes === deletedBefore && i < 30; i++) await delay(50);
    assert.equal(uploads - before, 1); assert.equal(deletes - deletedBefore, 1);
    assert(sent.at(-1)!.body.input.length > 3 * 1024 * 1024);
  });
  await test("upload hosts and redirects are rejected before a supplier call", async () => {
    const before = modelRequests;
    for (const mode of ["attacker", "redirect"]) { uploadMode = mode; await assert.rejects(client.call("responses", baseInput("y".repeat(3 * 1024 * 1024 + 101)))); }
    uploadMode = "normal"; assert.equal(modelRequests, before);
  });
  await test("official Responses reaches the real streaming translator without generic retries", async () => {
    const before = modelRequests, events: any[] = [];
    for await (const event of streamMessage({ model: "ccagent:official-main", messages: [{ role: "user", content: "native stream" }] })) events.push(event);
    assert(events.some(event => event.type === "text" && event.text.includes("PLATFORM_OK"))); assert.equal(modelRequests - before, 1);
    const failed: any[] = [], failedBefore = modelRequests;
    for await (const event of streamMessage({ model: "ccagent:official-main", messages: [{ role: "user", content: "INSUFFICIENT_CASE" }] })) failed.push(event);
    const error = failed.find(event => event.type === "error"); assert(error); assert.match(error.error.message, /余额/); assert(!error.error.message.includes(key)); assert.equal(modelRequests - failedBefore, 1);
  });
  await test("a real QueryEngine turn attaches the same task identity to its paid model call", async () => {
    const engine = new QueryEngine({ model: "ccagent:official-main", toolContext: { cwd: workspace, sessionId: "real-engine-task" } });
    for await (const _event of engine.submitMessage("Reply with PLATFORM_OK")) { /* Run the shared engine. */ }
    assert.equal(sent.at(-1)!.taskId, "real-engine-task");
  });
  await saveOfficialServices({ roles, auxiliaryEnabled: true }); client = await getPlatformGatewayClient();
  for (const name of ["OPENROUTER_API_KEY", "TAVILY_API_KEY", "BOCHA_API_KEY", "DASHSCOPE_API_KEY", "QWEN_API_KEY"]) process.env[name] = "PRIVATE_KEY_MUST_NOT_BE_USED";
  await test("vision forwards actual image bytes through the official chat protocol", async () => {
    const image = path.join(workspace, "image.png"); await writeFile(image, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jr4kAAAAASUVORK5CYII=", "base64"));
    const result = await analyzeImageFile(image, "Read this image", workspace); assert.equal(result.text, "VISION_OK");
    assert.equal(sent.at(-1)!.path, "/v1/chat/completions"); assert(JSON.stringify(sent.at(-1)!.body).includes("data:image/png;base64,"));
  });
  await test("typed Jev uses the Decisions endpoint and ignores the personal supplier Key", async () => {
    const result = await callOpenRouterJev({ state: "test", questions: { q: { type: "choice", instructions: "choose", criteria: { allow: "allowed", deny: "denied" } } } }, { apiKey: "PRIVATE_KEY_MUST_NOT_BE_USED" });
    assert.equal((result.answers.q as any).choice, "allow"); assert.equal(sent.at(-1)!.path, "/v1/decisions");
  });
  await test("Tavily and Bocha preserve native parsing and official mode has no private fallback", async () => {
    const adapter = await createAdapter(); const results = await adapter.search("test", { allowedDomains: ["example.com"] }); assert.equal(results[0]!.snippet, "TAVILY_EVIDENCE"); assert.deepEqual(createFallbackAdapters(adapter.name), []);
    await saveOfficialServices({ roles: { ...roles, search: "official-bocha" }, auxiliaryEnabled: true });
    const bocha = await createAdapter(); assert.equal((await bocha.search("test", {}))[0]!.snippet, "BOCHA_EVIDENCE");
  });
  await test("voice downloads its authenticated WAV file into the authorized workspace", async () => {
    const result = await workfriendDeliverTool.call({ format: "voice", content: "Synthetic voice test", output_path: "official.wav" }, { cwd: workspace, sessionId: "voice-task" });
    assert.notEqual(result.isError, true); assert((await readFile(path.join(workspace, "official.wav"))).equals(wav));
  });
  await test("async task attribution survives pauses and includes auxiliary calls", async () => {
    const start = sent.length;
    async function* work() { await (await client.call("responses", baseInput("scope-one"))).json(); yield 1; await delay(10); await (await client.call("decisions", { model: "official-decision", state: "scope", questions: {} })).json(); return 2; }
    const iterator = inPlatformTask("scope-task", work()); await iterator.next(); await iterator.next();
    assert(sent.slice(start).every(call => call.taskId === "scope-task"));
  });
  await test("CLI key setup masks the input and shares the same account configuration", async () => {
    let output = "";
    assert.equal(await runAccountCommand(["key"], { output: { write(value: string) { output += value; return true; } } as any, prompter: { ask: async () => "", secret: async () => key, close() {} } }), 0);
    assert(!output.includes(key)); assert((await readServiceBinding())?.configuration.routes.length === 6);
  });
  await test('existing selections and intentional empty selections survive changed recommendations and legacy catalogs', async () => {
    const before = (await readServiceBinding())!.configuration;
    try {
      await saveOfficialServices({ roles: { search: 'official-search' } }); await saveOfficialServices({});
      assert.deepEqual((await readServiceBinding())!.configuration.roles, { search: 'official-search' });
      await saveOfficialServices({ roles: {} }); await saveOfficialServices({});
      assert.deepEqual((await readServiceBinding())!.configuration.roles, {});
      catalogMode = 'legacy'; await saveOfficialServices({});
      assert.deepEqual((await readServiceBinding())!.configuration.roles, {});
    } finally { catalogMode = 'normal'; await saveOfficialServices({ roles: before.roles }); }
  });
  await test('invalid recommendations do not alter the saved configuration or stored Key and never trigger inference', async () => {
    const before = await readFile(servicePaths().state), stored = await readFile(servicePaths().key), requestsBefore = modelRequests;
    catalogMode = 'invalid';
    try {
      await assert.rejects(saveOfficialServices({}), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'INVALID_CATALOG');
      assert.deepEqual(await readFile(servicePaths().state), before); assert.deepEqual(await readFile(servicePaths().key), stored);
      assert.equal(modelRequests, requestsBefore);
    } finally { catalogMode = 'normal'; }
  });
  await test("catalog refresh clears withdrawn roles and never selects a replacement paid service", async () => {
    const before = (await readServiceBinding())!.configuration;
    const index = routes.findIndex(route => route.id === "official-voice"), [removed] = routes.splice(index, 1);
    try {
      await saveOfficialServices({});
      const current = (await readServiceBinding())!.configuration;
      assert.equal(current.roles.voice, undefined); assert.equal(current.roles.main, before.roles.main); assert(current.auxiliaryEnabled);
      await assert.rejects(officialRole("voice"), /尚未选择/);
      await assert.rejects(saveOfficialServices({ roles: { voice: "withdrawn-service" } }), /已不可用/);
    } finally { routes.splice(index, 0, removed!); await saveOfficialServices({ roles: before.roles }); }
  });
  const primaryRoute = routes.find(route => route.id === 'official-main')!, originalRoute = structuredClone(primaryRoute);
  const backupRoute = { ...structuredClone(primaryRoute), id: 'official-backup', name: 'Synthetic backup', pricing: { ...primaryRoute.pricing, fingerprint: 'b'.repeat(64) } };
  primaryRoute.pricing.fingerprint = 'a'.repeat(64); primaryRoute.limits.fallbackEnabled = true; primaryRoute.limits.fallbackRouteId = backupRoute.id; routes.push(backupRoute);
  let approvedRequest = '', approvedBody: ReturnType<typeof baseInput>, approvedPins: Record<string, string | string[] | undefined>;
  try {
    await test('fallback is off until the displayed catalog revision is explicitly confirmed and only then sends exact price pins', async () => {
      await saveOfficialServices({}); assert.equal((await readServiceBinding())!.configuration.fallbackEnabled, false);
      const off = await getPlatformGatewayClient(); await (await off.call('responses', baseInput('FALLBACK_OFF'))).text(); assert.equal(sent.at(-1)!.pins['x-ccagent-fallback-route'], undefined);
      await assert.rejects(saveOfficialServices({ fallbackEnabled: true }), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'FALLBACK_CONFIRMATION_REQUIRED');
      const view = await officialServicesView(); await saveOfficialServices({ fallbackEnabled: true, catalogRevision: view.catalogRevision });
      assert.equal((await readServiceBinding())!.configuration.fallbackEnabled, true);
      approvedRequest = randomUUID(); approvedBody = baseInput('APPROVED_FALLBACK_REPLAY'); const active = await getPlatformGatewayClient();
      await (await active.call('responses', approvedBody, { requestId: approvedRequest })).text(); approvedPins = sent.at(-1)!.pins;
      assert.equal(approvedPins['x-ccagent-price-fingerprint'], 'a'.repeat(64)); assert.equal(approvedPins['x-ccagent-fallback-route'], backupRoute.id);
      assert.equal(approvedPins['x-ccagent-fallback-price-version'], '1'); assert.equal(approvedPins['x-ccagent-fallback-price-fingerprint'], 'b'.repeat(64));
    });
    await test('changed prices revoke new-call consent while replay retains the original approved prices and unresolved calls stay deduplicated', async () => {
      const old = await officialServicesView(); backupRoute.pricing.version = 2; backupRoute.pricing.fingerprint = 'c'.repeat(64);
      await assert.rejects(saveOfficialServices({ fallbackEnabled: true, catalogRevision: old.catalogRevision }), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'FALLBACK_CONFIRMATION_REQUIRED');
      await saveOfficialServices({}); assert.equal((await readServiceBinding())!.configuration.fallbackEnabled, false);
      await assert.rejects(saveOfficialServices({ fallbackEnabled: true, catalogRevision: old.catalogRevision }), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'FALLBACK_CONFIRMATION_REQUIRED');
      const current = await getPlatformGatewayClient(), before = suppliers;
      const replay = await current.call('responses', approvedBody!, { requestId: approvedRequest }); await replay.text(); assert.equal(replay.headers.get('x-ccagent-replay'), 'true');
      assert.deepEqual(sent.at(-1)!.pins, approvedPins!); assert.equal(suppliers, before);
      const view = await officialServicesView(); await saveOfficialServices({ fallbackEnabled: true, catalogRevision: view.catalogRevision });
      const active = await getPlatformGatewayClient(), taskId = randomUUID(), pendingBody = { ...baseInput('PENDING_STREAM_CASE'), stream: true };
      const pending = await active.call('responses', pendingBody, { taskId }); await pending.body!.cancel();
      await saveOfficialServices({ fallbackEnabled: false }); const disabled = await getPlatformGatewayClient(), sentBefore = modelRequests;
      await assert.rejects(disabled.call('responses', pendingBody, { taskId, requestId: randomUUID() }), /原调用仍在执行/); assert.equal(modelRequests, sentBefore);
    });
    await test('CLI displays primary and backup rates before opt-in cancellation and opt-out never invoke a model', async () => {
      let output = '', questions = 0; const before = modelRequests;
      const options = (answer: string) => ({ output: { write(value: string) { output += value; return true; } } as any, prompter: { ask: async () => { questions++; return answer; }, secret: async () => { throw new Error('UNEXPECTED_KEY_PROMPT'); }, close() {} } });
      assert.equal(await runAccountCommand(['fallback','--enabled','true'], options('n')), 0); assert.equal((await readServiceBinding())!.configuration.fallbackEnabled, false);
      assert.equal(await runAccountCommand(['fallback','--enabled','true'], options('yes')), 0); assert.equal((await readServiceBinding())!.configuration.fallbackEnabled, true);
      assert.equal(await runAccountCommand(['fallback','--enabled','false'], options('n')), 0); assert.equal((await readServiceBinding())!.configuration.fallbackEnabled, false);
      assert.equal(questions, 2); assert.equal(modelRequests, before); assert.ok(output.includes(backupRoute.id)); assert.ok(output.includes('1.3')); assert.equal(output.includes(key), false);
    });
    await test('CLI reviews every Qwen tier and reasoning allowance before accepting a fallback decision', async () => {
      const originalPricing = structuredClone(primaryRoute.pricing), before = modelRequests;
      try {
        Object.assign(primaryRoute.pricing, { version: 77, fingerprint: 'c'.repeat(64), definition: {
          tariff: { kind: 'qwen-input-tiers', defaultThinking: true, maxThinkingTokens: 32768 },
          rates: ['input_tokens', 'cached_input_tokens', 'output_tokens'].map(metric => ({ metric, unitQuantity: '1000000', tiers: [
            { upToInputTokens: 128000, price: metric === 'cached_input_tokens' ? '0' : '2', ...(metric === 'output_tokens' ? { thinkingPrice: '8' } : {}) },
            { upToInputTokens: 1000000, price: '48', ...(metric === 'output_tokens' ? { thinkingPrice: '64' } : {}) },
          ] })),
        } });
        let output = '';
        assert.equal(await runAccountCommand(['fallback', '--enabled', 'true'], { output: { write(value: string) { output += value; return true; } } as any,
          prompter: { ask: async () => 'n', secret: async () => { throw new Error('UNEXPECTED_KEY_PROMPT'); }, close() {} } }), 0);
        assert(output.includes('128000 < Token ≤ 1000000')); assert(output.includes('思考 64')); assert(output.includes('32768 Token')); assert(output.includes('缓存') || output.includes('cached_input_tokens'));
        assert.equal((await readServiceBinding())!.configuration.fallbackEnabled, false); assert.equal(modelRequests, before); assert.equal(output.includes(key), false);
      } finally { Object.assign(primaryRoute.pricing, originalPricing); }
    });
  } finally { routes.splice(routes.findIndex(route => route.id === backupRoute.id), 1); Object.assign(primaryRoute, originalRoute); await saveOfficialServices({ fallbackEnabled: false }); }
  await test("switching accounts cannot reuse an old client or read its private result", async () => {
    await fixture.nativeClient.signIn(fixture.users[1]!.email, fixture.password); delete process.env.CCAGENT_ACCOUNT_ID; process.env.CCAGENT_HOME = base; await enterPlatformAccount();
    await assert.rejects(client.call("responses", baseInput("cross-account")), /账户或官方服务地址已改变/);
    await assert.rejects(getPlatformGatewayClient(), /平台 Key/);
    await saveOfficialServices({ apiKey: keys.get(fixture.users[1]!.id) });
    assert.equal(await (await getPlatformGatewayClient()).callStatus(sent[0]!.requestId), null);
  });
  await test("forgetting a local Key removes official profiles without changing personal configuration", async () => {
    await fixture.nativeClient.signIn(fixture.users[0]!.email, fixture.password); delete process.env.CCAGENT_ACCOUNT_ID; process.env.CCAGENT_HOME = base; await enterPlatformAccount(); await forgetOfficialKey();
    assert((await loadProfiles(workspace)).profiles.personal); await assert.rejects(resolveProfile("ccagent:official-main"), /官方模型不可用/);
  });
  console.log(`Official client: ${checks} checks passed with real HTTP, DPAPI, native protocol translators and QueryEngine; supplier responses are synthetic, no paid provider calls.`);
} finally {
  await fixture.close();
  for (const [name, value] of Object.entries(previous)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  assert.equal(path.dirname(directory), temporaryRoot); assert(path.basename(directory).startsWith("ccagent-official-client-"));
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

await import("./test-official-service-connect.js");
