import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { discoverOllamaModels, normalizeOllamaBaseURL, DEFAULT_OLLAMA_URL } from "../services/ollama.js";

const temporary = await mkdtemp(path.join(os.tmpdir(), "ccagent-ollama-"));
const home = path.join(temporary, "home"), workspace = path.join(temporary, "workspace");
await Promise.all([mkdir(home), mkdir(workspace)]);
const environmentNames = ["CCAGENT_HOME", "HOME", "USERPROFILE", "PROGRAMDATA", "CCAGENT_ACCOUNT_ID", "CCAGENT_PLATFORM_HOME", "CCAGENT_AUTH_SESSION_FILE"];
const previousEnvironment = new Map(environmentNames.map((name) => [name, process.env[name]]));
process.env.CCAGENT_HOME = home;
process.env.HOME = temporary;
process.env.USERPROFILE = temporary;
process.env.PROGRAMDATA = temporary;
delete process.env.CCAGENT_ACCOUNT_ID;
delete process.env.CCAGENT_AUTH_SESSION_FILE;
process.env.CCAGENT_PLATFORM_HOME = home;
const settingsFile = path.join(home, "settings.json");
let route = "normal", requests = 0, redirectedRequests = 0;
const server = createServer(async (req, res) => {
  requests++;
  assert.equal(req.headers.authorization, undefined);
  assert.equal(req.headers.cookie, undefined);
  assert.equal(req.method, "GET");
  if (req.url === "/redirect-target") { redirectedRequests++; res.end("{}"); return; }
  assert.equal(req.url, "/proxy/api/tags");
  if (route === "redirect") { res.writeHead(302, { location: "/redirect-target" }); res.end(); return; }
  if (route === "error") { res.writeHead(500); res.end("UPSTREAM_SECRET_FIXTURE"); return; }
  if (route === "timeout") { setTimeout(() => { if (!res.destroyed) res.end('{"models":[]}'); }, 200).unref(); return; }
  if (route === "invalid") { res.end('not-json-UPSTREAM_SECRET_FIXTURE'); return; }
  if (route === "wrong") { res.end('{"secret":"UPSTREAM_SECRET_FIXTURE"}'); return; }
  if (route === "oversize") { res.end(" ".repeat(2 * 1024 * 1024 + 1)); return; }
  if (route === "header-size") { res.writeHead(200, { "content-length": String(3 * 1024 * 1024) }); res.flushHeaders(); return; }
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ models: route === "many" ? Array.from({ length: 230 }, (_, index) => ({ name: `model:${index}` })) : route === "empty" ? [] : [
    { name: "qwen3:8b", size: 123, modified_at: "2026-11-09T00:00:00Z", details: { family: "qwen3", parameter_size: "8B", quantization_level: "Q4_K_M" } },
    { name: "qwen3:8b", size: 456 }, { model: "llama3.1:8b", size: -1 }, { name: "bad\nname" }, null,
  ] }));
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const root = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const endpoint = root + "/proxy";

try {
  assert.equal(normalizeOllamaBaseURL(), DEFAULT_OLLAMA_URL + "/v1");
  assert.equal(normalizeOllamaBaseURL(""), DEFAULT_OLLAMA_URL + "/v1");
  for (const suffix of ["", "/", "/v1", "/v1/", "/v1/chat/completions", "/v1/models", "/api", "/api/tags", "/api/chat", "/api/generate"]) {
    assert.equal(normalizeOllamaBaseURL(endpoint + suffix), endpoint + "/v1");
  }
  assert.equal(normalizeOllamaBaseURL("https://192.168.10.20:11434/proxy/v1"), "https://192.168.10.20:11434/proxy/v1");
  assert.equal(normalizeOllamaBaseURL("http://[::1]:11434"), "http://[::1]:11434/v1");
  for (const invalid of [null, 123, "ftp://localhost", "http://user:secret@localhost", "http://localhost?token=secret", "http://localhost#secret", "http://local host", "http://localhost/with\\slash", "http://localhost/%2fsecret", "x".repeat(4097)]) {
    assert.throws(() => normalizeOllamaBaseURL(invalid), (error: Error) => !error.message.includes("secret"));
  }
  const discovered = await discoverOllamaModels(endpoint + "/v1");
  assert.equal(discovered.baseURL, endpoint + "/v1");
  assert.deepEqual(discovered.models, [
    { name: "qwen3:8b", size: 123, family: "qwen3", parameterSize: "8B", quantizationLevel: "Q4_K_M", modifiedAt: "2026-11-09T00:00:00Z" },
    { name: "llama3.1:8b" },
  ]);
  assert.equal(discovered.truncated, false);
  route = "many";
  const many = await discoverOllamaModels(endpoint);
  assert.equal(many.models.length, 200);
  assert.equal(many.truncated, true);
  route = "empty";
  assert.deepEqual((await discoverOllamaModels(endpoint)).models, []);
  for (const invalid of ["redirect", "error", "invalid", "wrong", "oversize", "header-size", "timeout"]) {
    route = invalid;
    await assert.rejects(discoverOllamaModels(endpoint, { timeoutMs: invalid === "timeout" ? 25 : 1000 }), (error: Error) => !error.message.includes("UPSTREAM_SECRET_FIXTURE") && !error.message.includes(endpoint));
  }
  assert.equal(redirectedRequests, 0, "discovery never follows redirects");
  const beforeInvalid = requests;
  await assert.rejects(discoverOllamaModels("http://user:secret@localhost"));
  assert.equal(requests, beforeInvalid, "invalid URL rejected before network");

  const { handleCustomization } = await import("../entrypoint/webCustomization.js");
  const { loadProfiles } = await import("../services/api/providers/profile.js");
  const { resetSettingsCache } = await import("../config/sources.js");
  const { storeWebSecret, resolveWebSecret } = await import("../utils/webSecrets.js");
  const reference = await storeWebSecret("model:fixture", "OLD_CLOUD_FIXTURE_SECRET");
  const context = { workspace, defaultModel: "fixture" };
  await writeFile(settingsFile, JSON.stringify({ sentinel: "preserve", ragConnections: [{ id: "shared-rag", name: "Fixture knowledge", enabled: true, url: root + "/retrieve", topK: 5, apiKey: reference }], models: {
    fixture: { protocol: "openai-chat", model: "old-cloud", baseURL: "https://example.com/v1", apiKey: reference, headers: { authorization: "Bearer OLD_CLOUD_FIXTURE_SECRET", "x-secret": "secret" } },
  } }));
  resetSettingsCache();
  const save = { id: "fixture", provider: "ollama", protocol: "openai-chat", model: "qwen3:8b", baseURL: endpoint, apiKey: "", maxTokens: "4096", contextWindow: "32768", makeDefault: true };
  assert.deepEqual(await handleCustomization("models", "POST", save, context), { id: "fixture" });
  let saved = JSON.parse(await readFile(settingsFile, "utf8"));
  assert.equal(saved.sentinel, "preserve");
  assert.equal(saved.defaultModel, "fixture");
  assert.equal(saved.models.fixture.provider, "ollama");
  assert.equal(saved.models.fixture.baseURL, endpoint + "/v1");
  assert.equal(saved.models.fixture.apiKey, "");
  assert.equal(saved.models.fixture.headers, undefined);
  assert.equal(resolveWebSecret(reference), "OLD_CLOUD_FIXTURE_SECRET", "shared backing credential remains available to other saved definitions");
  assert((await readFile(path.join(home, "web-secrets.env"), "utf8")).includes("OLD_CLOUD_FIXTURE_SECRET"));
  assert.equal(saved.ragConnections[0].apiKey, reference, "conversion preserves unrelated RAG credential references");
  const { loadRagConnections } = await import("../services/rag.js");
  assert.equal(resolveWebSecret((await loadRagConnections())[0]!.apiKey), "OLD_CLOUD_FIXTURE_SECRET");
  let profile = (await loadProfiles(workspace)).profiles.fixture!;
  assert.equal(profile.provider, "ollama");
  assert.equal(profile.apiKey, undefined);
  assert.equal(profile.headers, undefined);
  assert.equal(profile.contextWindow, 32768);
  const view = await handleCustomization("models", "GET", {}, context) as { models: Record<string, unknown>[] };
  assert.equal(view.models[0]!.provider, "ollama");
  assert.equal(view.models[0]!.localModel, true);
  assert.equal(view.models[0]!.hasKey, false);
  route = "normal";
  assert.equal((await handleCustomization("ollama-models", "POST", { baseURL: endpoint }, context) as { models: unknown[] }).models.length, 2);
  const beforeRejected = await readFile(settingsFile, "utf8");
  for (const body of [{ ...save, apiKey: "secret" }, { ...save, protocol: "gemini" }, { ...save, baseURL: root + "?key=secret" }, { ...save, provider: "other" }]) await assert.rejects(handleCustomization("models", "POST", body, context));
  assert.equal(await readFile(settingsFile, "utf8"), beforeRejected);

  // Even hand-edited or merged profiles may not forward inherited cloud credentials.
  saved.models.fixture.apiKey = "${SECRET_NOT_FOR_OLLAMA}";
  saved.models.fixture.headers = { authorization: "Bearer secret" };
  saved.models.invalid = { ...saved.models.fixture, protocol: "gemini" };
  await writeFile(settingsFile, JSON.stringify(saved)); resetSettingsCache();
  profile = (await loadProfiles(workspace)).profiles.fixture!;
  assert.equal(profile.apiKey, undefined); assert.equal(profile.headers, undefined);
  assert.equal((await loadProfiles(workspace)).profiles.invalid, undefined);
  await mkdir(path.join(workspace, ".ccagent"));
  await writeFile(path.join(workspace, ".ccagent", "settings.json"), JSON.stringify({ models: { hostile: { provider: "ollama", protocol: "openai-chat", model: "hostile", baseURL: endpoint } } }));
  resetSettingsCache();
  assert.equal((await loadProfiles(workspace)).profiles.hostile, undefined, "project trust remains required");

  await handleCustomization("models", "POST", { ...save, provider: "custom", baseURL: "https://example.com/v1", apiKey: "NEW_CLOUD_FIXTURE_SECRET" }, context);
  saved = JSON.parse(await readFile(settingsFile, "utf8"));
  assert.equal(saved.models.fixture.provider, undefined);
  assert(!JSON.stringify(saved).includes("NEW_CLOUD_FIXTURE_SECRET"));
  assert.equal((await loadProfiles(workspace)).profiles.fixture!.apiKey, "NEW_CLOUD_FIXTURE_SECRET");
  console.log("Ollama discovery, URL boundaries, profile isolation, saved credentials and model settings: PASS");
} finally {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const [name, value] of previousEnvironment) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  // Only the exact test-created directory is recursively removed.
  assert(path.resolve(temporary).startsWith(path.resolve(os.tmpdir()) + path.sep));
  await rm(temporary, { recursive: true, force: true });
}
