#!/usr/bin/env tsx
/** Hermetic registered-client OAuth + real Streamable HTTP MCP round trip; never opens a real browser. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, request as httpRequest, type Server } from "node:http";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { BrowserMcpOAuthProvider, createMcpOAuthProvider, clearBrowserMcpOAuthCredentials, isValidBrowserMcpRedirectUri } from "../services/mcp/browserOAuth.js";
import { GoogleWorkspaceOAuthProvider, McpAuthorizationRequiredError } from "../services/mcp/googleOAuth.js";
import { validateServerConfig } from "../services/mcp/config.js";
import type { McpBrowserOAuthConfig } from "../types/mcp.js";

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  assert(address && typeof address !== "string");
  return address.port;
}
async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
async function freePort() { const server = createServer(); const port = await listen(server); await close(server); return port; }
async function wrongHost(url: URL): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { headers: { Host: "attacker.invalid" } }, (response) => { response.resume(); resolve(response.statusCode!); });
    request.once("error", reject); request.end();
  });
}

const temporary = await mkdtemp(path.join(os.tmpdir(), "ccagent-browser-mcp-oauth-"));
const savedId = process.env.CCAGENT_TEST_BROWSER_ID;
const savedSecret = process.env.CCAGENT_TEST_BROWSER_SECRET;
process.env.CCAGENT_TEST_BROWSER_ID = "synthetic-client";
process.env.CCAGENT_TEST_BROWSER_SECRET = "synthetic-client-secret";
const config: McpBrowserOAuthConfig = { provider: "browser", clientIdEnv: "CCAGENT_TEST_BROWSER_ID", clientSecretEnv: "CCAGENT_TEST_BROWSER_SECRET", redirectUri: `http://127.0.0.1:${await freePort()}/oauth/callback` };
let checks = 0;
const pass = (message: string) => { checks++; console.log(`PASS ${message}`); };
const providers: BrowserMcpOAuthProvider[] = [];
const transports: StreamableHTTPClientTransport[] = [];
let fixtureError: unknown;
let origin = "";
let challenge = "";
let tokenRequests = 0;
let mode = "client_secret_basic";
const server = createServer(async (request, response) => {
  const json = (status: number, body: unknown, headers: Record<string, string> = {}) => { response.writeHead(status, { "Content-Type": "application/json", ...headers }); response.end(JSON.stringify(body)); };
  try {
    const url = new URL(request.url!, origin);
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) return json(200, { resource: `${origin}/mcp`, authorization_servers: [origin], scopes_supported: ["design:meta:read"] });
    if (url.pathname === "/.well-known/oauth-authorization-server") return json(200, { issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, response_types_supported: ["code"], code_challenge_methods_supported: ["S256"], grant_types_supported: ["authorization_code", "refresh_token"], token_endpoint_auth_methods_supported: [mode] });
    if (url.pathname === "/authorize") {
      assert.equal(url.searchParams.get("client_id"), "synthetic-client");
      assert.equal(url.searchParams.get("code_challenge_method"), "S256");
      assert(url.searchParams.get("state"));
      for (const key of ["access_type", "prompt", "include_granted_scopes"]) assert(!url.searchParams.has(key));
      challenge = url.searchParams.get("code_challenge")!;
      const callback = new URL(url.searchParams.get("redirect_uri")!);
      callback.searchParams.set("code", "synthetic-code"); callback.searchParams.set("state", url.searchParams.get("state")!);
      response.writeHead(302, { Location: callback.href }); response.end(); return;
    }
    if (url.pathname === "/token") {
      let raw = ""; for await (const chunk of request) raw += chunk;
      const body = new URLSearchParams(raw);
      if (mode === "client_secret_basic") assert.equal(request.headers.authorization, `Basic ${Buffer.from("synthetic-client:synthetic-client-secret").toString("base64")}`);
      else { assert.equal(body.get("client_id"), "synthetic-client"); assert.equal(body.get("client_secret"), "synthetic-client-secret"); }
      assert.equal(body.get("code"), "synthetic-code");
      assert.equal(createHash("sha256").update(body.get("code_verifier")!).digest("base64url"), challenge);
      tokenRequests++;
      return json(200, { access_token: "synthetic-access", token_type: "Bearer", refresh_token: "synthetic-refresh", expires_in: 3600 });
    }
    if (url.pathname === "/mcp") {
      if (request.method === "GET" || request.method === "DELETE") { response.writeHead(405); response.end(); return; }
      if (request.headers.authorization !== "Bearer synthetic-access") return json(401, {}, { "WWW-Authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"` });
      let raw = ""; for await (const chunk of request) raw += chunk;
      const message = JSON.parse(raw);
      if (!Object.hasOwn(message, "id")) { response.writeHead(202); response.end(); return; }
      const result = message.method === "initialize" ? { protocolVersion: message.params.protocolVersion, serverInfo: { name: "canva-oauth-fixture", version: "1" }, capabilities: { tools: {} } }
        : message.method === "tools/list" ? { tools: [{ name: "search-designs", description: "Fixture read tool", inputSchema: { type: "object", properties: { query: { type: "string" } } } }] }
        : { content: [{ type: "text", text: `Found ${message.params.arguments.query}` }] };
      return json(200, { jsonrpc: "2.0", id: message.id, result });
    }
    json(404, {});
  } catch (error) { fixtureError = error; json(500, { error: "fixture assertion failed" }); }
});

try {
  origin = `http://127.0.0.1:${await listen(server)}`;
  for (const bad of ["https://example.com/callback", "http://127.0.0.1/oauth/callback", "http://user@127.0.0.1:53683/callback", "http://127.0.0.1:53683/callback?x=1", "http://127.0.0.1:53683/callback#x"]) {
    assert(!isValidBrowserMcpRedirectUri(bad));
    assert(!validateServerConfig("canva", { type: "http", url: origin + "/mcp", oauth: { ...config, redirectUri: bad } }, "user").ok);
  }
  assert(validateServerConfig("canva", { type: "http", url: origin + "/mcp", oauth: config }, "user").ok);
  assert(createMcpOAuthProvider("https://example.com/mcp", { ...config, provider: "google" }, { homeDir: temporary }) instanceof GoogleWorkspaceOAuthProvider);
  pass("config accepts browser OAuth and retains Google factory; unsafe callbacks rejected");

  let browserOpens = 0;
  const runtime = { homeDir: temporary, openExternal: async (url: string) => {
    browserOpens++;
    const authorization = await fetch(url, { redirect: "manual" });
    assert.equal(authorization.status, 302);
    const callback = new URL(authorization.headers.get("location")!);
    assert.equal(await wrongHost(callback), 400);
    const forged = new URL(callback); forged.searchParams.set("state", "forged-state");
    assert.equal((await fetch(forged)).status, 400);
    assert.equal((await fetch(callback)).status, 200);
    return true;
  } };
  const provider = new BrowserMcpOAuthProvider(`${origin}/mcp`, config, runtime); providers.push(provider);
  const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), { authProvider: provider }); transports.push(transport);
  const client = new Client({ name: "CCAGENT-OAuth-fixture", version: "1" });
  const send = transport.send.bind(transport);
  transport.send = (message, options) => { transport.send = send; return provider.runWithAuth(transport, () => send(message, options), { interactive: true }); };
  await client.connect(transport);
  transport.send = send;
  const tools = await client.listTools(); assert.equal(tools.tools[0]?.name, "search-designs");
  const result = await client.callTool({ name: "search-designs", arguments: { query: "site plan" } });
  assert.deepEqual(result.content, [{ type: "text", text: "Found site plan" }]);
  if (fixtureError) throw fixtureError;
  assert.equal(browserOpens, 1); assert.equal(tokenRequests, 1);
  pass("real HTTP metadata discovery, PKCE S256, Basic client auth, forged callback rejection and MCP tool call");

  const files = await readdir(path.join(temporary, "oauth", "browser"));
  const credentials = files.filter(file => /^[a-f0-9]{64}\.json$/.test(file));
  assert.equal(credentials.length, 1, "One OAuth identity persists exactly one credential envelope");
  // SecureCredentialStore deliberately keeps its cross-process transaction
  // sentinel. It is not a second credential, temporary write or live lock.
  assert.deepEqual(files.sort(), [credentials[0]!, `${credentials[0]}.transaction`].sort(), "Only the credential and its transaction sentinel remain after a completed write");
  const stored = await readFile(path.join(temporary, "oauth", "browser", credentials[0]!), "utf8");
  if (process.platform === "win32") { assert(!stored.includes("synthetic-access")); assert(stored.includes("windows-dpapi")); }
  const restored = new BrowserMcpOAuthProvider(`${origin}/mcp`, config, runtime); providers.push(restored);
  assert.equal((await restored.tokens())?.access_token, "synthetic-access");
  await restored.saveTokens({ access_token: "updated", token_type: "Bearer" });
  assert.equal((await restored.tokens())?.refresh_token, "synthetic-refresh");
  pass("account-private encrypted persistence and refresh-token preservation");

  for (const alternate of [new BrowserMcpOAuthProvider(`${origin}/other-mcp`, config, runtime), new BrowserMcpOAuthProvider(`${origin}/mcp`, { ...config, redirectUri: config.redirectUri.replace("callback", "other") }, runtime), new BrowserMcpOAuthProvider(`${origin}/mcp`, config, { ...runtime, homeDir: path.join(temporary, "other-account") })]) {
    providers.push(alternate); assert.equal(await alternate.tokens(), undefined);
  }
  process.env.CCAGENT_TEST_BROWSER_ID = "different-client";
  const otherClient = new BrowserMcpOAuthProvider(`${origin}/mcp`, config, runtime); providers.push(otherClient); assert.equal(await otherClient.tokens(), undefined);
  process.env.CCAGENT_TEST_BROWSER_ID = "synthetic-client";
  pass("tokens isolated by account directory, endpoint, client ID and redirect URI");

  const before = browserOpens;
  await assert.rejects(() => provider.runWithAuth(transport, async () => { throw new UnauthorizedError(); }), McpAuthorizationRequiredError);
  assert.equal(browserOpens, before);
  pass("background OAuth challenge never opens a browser");

  let authorized = false;
  let concurrentOpens = 0;
  const serialized = new BrowserMcpOAuthProvider(`${origin}/serialized`, config, { homeDir: temporary, openExternal: async (url) => {
    concurrentOpens++;
    const callback = new URL(config.redirectUri);
    callback.searchParams.set("state", new URL(url).searchParams.get("state")!);
    callback.searchParams.set("code", "serialized-code");
    assert.equal((await fetch(callback)).status, 200); return true;
  } }); providers.push(serialized);
  const serializedTransport = { finishAuth: async (code: string) => { assert.equal(code, "serialized-code"); authorized = true; } } as unknown as StreamableHTTPClientTransport;
  const operation = async () => {
    if (authorized) return "ready";
    const state = serialized.state(); serialized.redirectToAuthorization(new URL(`${origin}/authorize?state=${state}`));
    throw new UnauthorizedError();
  };
  assert.deepEqual(await Promise.all([serialized.runWithAuth(serializedTransport, operation, { interactive: true }), serialized.runWithAuth(serializedTransport, operation, { interactive: true })]), ["ready", "ready"]);
  assert.equal(concurrentOpens, 1);
  pass("concurrent challenges serialize and reuse the completed authorization");

  await client.close();
  await clearBrowserMcpOAuthCredentials(`${origin}/mcp`, config, temporary);
  assert.equal(await restored.tokens(), undefined);
  pass("uninstall cleanup clears only matching local authorization");

  mode = "client_secret_post";
  const postProvider = new BrowserMcpOAuthProvider(`${origin}/mcp`, config, runtime); providers.push(postProvider);
  const postTransport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), { authProvider: postProvider }); transports.push(postTransport);
  const postClient = new Client({ name: "CCAGENT-post-fixture", version: "1" });
  const postSend = postTransport.send.bind(postTransport);
  postTransport.send = (message, options) => { postTransport.send = postSend; return postProvider.runWithAuth(postTransport, () => postSend(message, options), { interactive: true }); };
  await postClient.connect(postTransport); await postClient.close();
  if (fixtureError) throw fixtureError;
  assert.equal(tokenRequests, 2);
  pass("SDK follows advertised client_secret_post instead of forcing a provider-specific method");

  let opened!: () => void;
  const browserOpened = new Promise<void>((resolve) => { opened = resolve; });
  const cancelled = new BrowserMcpOAuthProvider(`${origin}/cancel`, config, { homeDir: temporary, openExternal: async () => { opened(); return true; } }); providers.push(cancelled);
  const state = cancelled.state(); cancelled.redirectToAuthorization(new URL(`${origin}/authorize?state=${state}`));
  const pending = cancelled.runWithAuth(transport, async () => { throw new UnauthorizedError(); }, { interactive: true });
  void pending.catch(() => undefined);
  await browserOpened; await cancelled.cancel();
  await assert.rejects(() => pending, /cancelled/);
  // Port released after cancellation, including any callback awaiting completion.
  const checkPort = createServer();
  await new Promise<void>((resolve, reject) => { checkPort.once("error", reject); checkPort.listen(Number(new URL(config.redirectUri).port), "127.0.0.1", resolve); });
  await close(checkPort);
  pass("closing an authorization cancels pending work and releases the callback listener");
  console.log(`Browser MCP OAuth: ${checks} checks passed.`);
} finally {
  await Promise.allSettled(providers.map((provider) => provider.cancel()));
  await Promise.allSettled(transports.map((transport) => transport.close()));
  await close(server);
  if (savedId === undefined) delete process.env.CCAGENT_TEST_BROWSER_ID; else process.env.CCAGENT_TEST_BROWSER_ID = savedId;
  if (savedSecret === undefined) delete process.env.CCAGENT_TEST_BROWSER_SECRET; else process.env.CCAGENT_TEST_BROWSER_SECRET = savedSecret;
  const resolved = path.resolve(temporary);
  assert(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith("ccagent-browser-mcp-oauth-"));
  await rm(resolved, { recursive: true, force: true });
}
