#!/usr/bin/env tsx
/**
 * Stage 16 verification — Smoke test the MCP integration end-to-end.
 *
 * What it covers:
 *   1. normalize / build / parse MCP tool names
 *   2. Schema validation rejects bad configs
 *   3. Connect to a real stdio MCP server (a tiny inline server we ship here)
 *   4. tools/list discovery
 *   5. tools/call execution
 *   6. /mcp registry surface
 *   7. Reconnect drops + re-establishes the connection
 *   8. Cleanup terminates the child process
 *
 * Run: npm run test:mcp
 *
 * Usage of an inline server:
 *   We can't depend on `npx -y @modelcontextprotocol/server-filesystem` in
 *   this script (offline / npm sandbox quirks). Instead we spawn a tiny
 *   self-contained MCP server using the SDK's Server + StdioServerTransport
 *   so the smoke test is hermetic.
 */
import { loadEnv } from "../utils/loadEnv.js";
await loadEnv();

import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as net from "node:net";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import type { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  buildMcpToolName,
  parseMcpToolName,
  isMcpToolName,
} from "../services/mcp/mcpStringUtils.js";
import { normalizeNameForMCP } from "../services/mcp/normalization.js";
import { loadMcpConfigs } from "../services/mcp/config.js";
import {
  bootstrapMcp,
  reconnectMcpServer,
} from "../services/mcp/bootstrap.js";
import { getMcpRegistry, getMcpRegistryEntry, clearMcpRegistry } from "../services/mcp/registry.js";
import { _resetMcpClientForTesting } from "../services/mcp/client.js";
import { registerMcpTools, findToolByName, getAllTools } from "../tools/index.js";
import type { ToolContext } from "../tools/Tool.js";
import { GoogleWorkspaceOAuthProvider } from "../services/mcp/googleOAuth.js";

const ctx: ToolContext = { cwd: process.cwd() };

/**
 * Reset every piece of MCP state and isolate the home dir, so each test
 * runs hermetically — independent of (a) the developer's real
 * ~/.ccagent/settings.json and (b) any cached connection Promises
 * from previous tests in this run.
 */
async function resetMcpStateForTest(): Promise<string> {
  _resetMcpClientForTesting();
  clearMcpRegistry();
  registerMcpTools([]);
  // Repoint HOME so loadMcpConfigs' user-scope read finds nothing.
  const fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), "ccagent-mcp-home-"));
  process.env.HOME = fakeHome;
  return fakeHome;
}

let exitCode = 0;
function pass(msg: string) {
  console.log(`  ✓ ${msg}`);
}
function fail(msg: string) {
  console.error(`  ✗ ${msg}`);
  exitCode = 1;
}

// ─── 1. Pure name utilities ──────────────────────────────────────────
function testNormalization() {
  console.log("── 1. Name normalization ──");
  if (normalizeNameForMCP("my.db") === "my_db") pass("normalize 'my.db' → 'my_db'");
  else fail("normalize 'my.db' should be 'my_db'");

  if (normalizeNameForMCP("foo-bar_baz") === "foo-bar_baz") pass("normalize keeps [a-z0-9_-]");
  else fail("normalize stripped legal chars");

  const tn = buildMcpToolName("my.server", "do.thing");
  if (tn === "mcp__my_server__do_thing") pass(`buildMcpToolName → ${tn}`);
  else fail(`buildMcpToolName produced wrong shape: ${tn}`);

  if (isMcpToolName(tn)) pass("isMcpToolName recognizes mcp__ prefix");
  else fail("isMcpToolName false negative");

  const parsed = parseMcpToolName(tn);
  if (parsed && parsed.serverName === "my_server" && parsed.toolName === "do_thing") {
    pass(`parseMcpToolName → ${JSON.stringify(parsed)}`);
  } else {
    fail(`parseMcpToolName returned ${JSON.stringify(parsed)}`);
  }
}

// ─── 2. Config validation ────────────────────────────────────────────
async function testConfigValidation() {
  console.log("\n── 2. Config validation ──");
  const fakeHome = await resetMcpStateForTest();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ccagent-mcp-cfg-"));
  await fs.mkdir(path.join(tmp, ".ccagent"), { recursive: true });
  await fs.writeFile(
    path.join(tmp, ".ccagent", "settings.json"),
    JSON.stringify({
      mcpServers: {
        "good-stdio": { command: "echo", args: ["hello"], toolTimeoutMs: 123456 },
        "good-http": { type: "http", url: "https://example.com/mcp" },
        "good-google-oauth": {
          type: "http",
          url: "https://drivemcp.googleapis.com/mcp/v1",
          oauth: {
            provider: "google",
            clientIdEnv: "GOOGLE_MCP_CLIENT_ID",
            clientSecretEnv: "GOOGLE_MCP_CLIENT_SECRET",
            redirectUri: "http://127.0.0.1:53682/oauth/callback",
          },
        },
        "good-sse": { type: "sse", url: "http://localhost:3000/sse" },
        "bad-no-command": { args: ["x"] },
        "bad-bad-url": { type: "http", url: "not a url" },
        "bad-bad-type": { type: "ws", url: "wss://x" },
        "bad-timeout": { command: "echo", toolTimeoutMs: 999 },
        "bad-oauth-env": {
          type: "http",
          url: "https://example.com/mcp",
          oauth: { provider: "google", clientIdEnv: "not-valid!", clientSecretEnv: "SECRET", redirectUri: "http://127.0.0.1:53682/callback" },
        },
        "bad-oauth-redirect": {
          type: "http",
          url: "https://example.com/mcp",
          oauth: { provider: "google", clientIdEnv: "CLIENT", clientSecretEnv: "SECRET", redirectUri: "https://example.com/callback" },
        },
      },
    }),
  );
  const result = await loadMcpConfigs(tmp);
  const good = result.servers["good-stdio"];
  if (
    good &&
    good.type !== "http" &&
    good.type !== "sse" &&
    good.command === "echo" &&
    good.toolTimeoutMs === 123456
  ) pass("good-stdio + toolTimeoutMs validated");
  else fail("good-stdio missing");

  const http = result.servers["good-http"];
  if (http?.type === "http" && http.url === "https://example.com/mcp") pass("good-http validated");
  else fail("good-http missing");

  const sse = result.servers["good-sse"];
  if (sse?.type === "sse" && sse.url === "http://localhost:3000/sse") pass("good-sse validated");
  else fail("good-sse missing");

  const google = result.servers["good-google-oauth"];
  if (google?.type === "http" && google.oauth?.provider === "google") pass("Google OAuth HTTP config validated");
  else fail("good-google-oauth missing");

  if (!result.servers["bad-no-command"]) pass("bad-no-command rejected");
  else fail("bad-no-command should have been rejected");

  if (!result.servers["bad-bad-url"]) pass("bad-bad-url rejected (invalid URL)");
  else fail("bad-bad-url should have been rejected");

  if (!result.servers["bad-bad-type"]) pass("bad-bad-type rejected (ws not supported)");
  else fail("bad-bad-type should have been rejected");

  if (!result.servers["bad-timeout"]) pass("bad-timeout rejected (<1000ms)");
  else fail("bad-timeout should have been rejected");

  if (!result.servers["bad-oauth-env"]) pass("bad-oauth-env rejected");
  else fail("bad-oauth-env should have been rejected");

  if (!result.servers["bad-oauth-redirect"]) pass("bad-oauth-redirect rejected");
  else fail("bad-oauth-redirect should have been rejected");

  if (result.errors.length === 6) pass(`emitted ${result.errors.length} errors`);
  else fail(`expected 6 errors, got ${result.errors.length}: ${JSON.stringify(result.errors)}`);

  await fs.rm(tmp, { recursive: true, force: true });
  await fs.rm(fakeHome, { recursive: true, force: true });
}

async function reserveLoopbackPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function testGoogleOAuthProvider(): Promise<void> {
  console.log("\n── 2b. Google OAuth provider ──");
  const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "ccagent-google-oauth-"));
  const port = await reserveLoopbackPort();
  const redirectUri = `http://127.0.0.1:${port}/oauth/callback`;
  const oldClientId = process.env.TEST_GOOGLE_CLIENT_ID;
  const oldClientSecret = process.env.TEST_GOOGLE_CLIENT_SECRET;
  process.env.TEST_GOOGLE_CLIENT_ID = "client-id";
  process.env.TEST_GOOGLE_CLIENT_SECRET = "client-secret";
  let openedUrl = "";
  const provider = new GoogleWorkspaceOAuthProvider(
    "google-test",
    {
      provider: "google",
      clientIdEnv: "TEST_GOOGLE_CLIENT_ID",
      clientSecretEnv: "TEST_GOOGLE_CLIENT_SECRET",
      redirectUri,
    },
    {
      homeDir: tmpHome,
      openExternal: async (url) => {
        openedUrl = url;
        return true;
      },
    },
  );

  try {
    const info = provider.clientInformation();
    if (info.client_id === "client-id" && info.client_secret === "client-secret") {
      pass("OAuth client credentials resolve from named environment variables");
    } else {
      fail("OAuth client credentials were not resolved from the environment");
    }

    await provider.saveTokens({ access_token: "access", token_type: "Bearer", refresh_token: "refresh" });
    const restored = await provider.tokens();
    if (restored?.access_token === "access" && restored.refresh_token === "refresh") {
      pass("OAuth tokens persist under the private CCAGENT user directory");
    } else {
      fail("OAuth token persistence failed");
    }

    await provider.saveTokens({ access_token: "renewed-access", token_type: "Bearer" });
    const refreshed = await provider.tokens();
    if (refreshed?.access_token === "renewed-access" && refreshed.refresh_token === "refresh") {
      pass("OAuth refresh responses preserve the existing Google refresh token");
    } else {
      fail("OAuth refresh response discarded the existing refresh token");
    }

    const state = provider.state();
    provider.saveCodeVerifier("verifier");
    provider.redirectToAuthorization(new URL(`https://accounts.google.test/authorize?state=${state}`));
    let calls = 0;
    let finishedCode = "";
    const fakeTransport = {
      finishAuth: async (code: string) => { finishedCode = code; },
    } as unknown as StreamableHTTPClientTransport;
    const run = provider.runWithAuth(fakeTransport, async () => {
      calls += 1;
      if (calls === 1) throw new UnauthorizedError();
      return "authorized";
    }, { interactive: true });

    let callbackDelivered = false;
    for (let i = 0; i < 100 && !callbackDelivered; i += 1) {
      try {
        const response = await fetch(`${redirectUri}?code=test-code&state=${encodeURIComponent(state)}`);
        callbackDelivered = response.ok;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    const result = await run;
    if (callbackDelivered && result === "authorized" && calls === 2 && finishedCode === "test-code") {
      pass("401 challenge completes loopback OAuth and retries the MCP request once");
    } else {
      fail(`OAuth retry mismatch: callback=${callbackDelivered}, result=${result}, calls=${calls}, code=${finishedCode}`);
    }
    const opened = new URL(openedUrl);
    if (
      opened.origin === "https://accounts.google.test"
      && opened.pathname === "/authorize"
      && opened.searchParams.get("access_type") === "offline"
      && opened.searchParams.get("prompt") === "consent"
      && opened.searchParams.get("include_granted_scopes") === "true"
    ) {
      pass("authorization URL requests durable offline Google access");
    } else {
      fail("authorization URL did not request durable offline Google access");
    }
  } finally {
    if (oldClientId === undefined) delete process.env.TEST_GOOGLE_CLIENT_ID;
    else process.env.TEST_GOOGLE_CLIENT_ID = oldClientId;
    if (oldClientSecret === undefined) delete process.env.TEST_GOOGLE_CLIENT_SECRET;
    else process.env.TEST_GOOGLE_CLIENT_SECRET = oldClientSecret;
    await fs.rm(tmpHome, { recursive: true, force: true });
  }
}

// ─── 3. End-to-end with an inline MCP server ─────────────────────────
/**
 * Write a tiny standalone MCP server JS file. We spawn it with `node` so the
 * test doesn't depend on any external npm package being installed.
 *
 * The inline server exposes one tool: `echo` that returns its `message` arg.
 */
async function writeInlineServer(opts: { startupDelayMs?: number } = {}): Promise<string> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ccagent-mcp-srv-"));
  const serverPath = path.join(tmpDir, "server.mjs");
  // Resolve the SDK's package path from the test process so the spawned
  // child can `import` it via an absolute path. Avoids any cwd assumption.
  const sdkPkg = path.dirname(
    new URL(import.meta.resolve("@modelcontextprotocol/sdk/server/index.js")).pathname,
  );
  const startupDelayMs = opts.startupDelayMs ?? 0;
  const serverJs = `
${startupDelayMs > 0 ? `await new Promise((r) => setTimeout(r, ${startupDelayMs}));` : ""}
import { Server } from "${sdkPkg}/index.js";
import { StdioServerTransport } from "${sdkPkg}/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "${sdkPkg.replace("/server", "")}/types.js";

const server = new Server(
  { name: "inline-test", version: "0.0.1" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "echo",
      description: "Echo back the message argument.",
      inputSchema: {
        type: "object",
        properties: { message: { type: "string" } },
        required: ["message"],
      },
      annotations: { readOnlyHint: true, title: "Echo Tool" },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name === "echo") {
    const delayMs = Number(req.params.arguments?.delayMs ?? 0);
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    return {
      content: [{ type: "text", text: String(req.params.arguments?.message ?? "") }],
    };
  }
  return { content: [{ type: "text", text: "unknown tool" }], isError: true };
});

const transport = new StdioServerTransport();
await server.connect(transport);
`;
  await fs.writeFile(serverPath, serverJs);
  return serverPath;
}

async function testEndToEnd(): Promise<void> {
  console.log("\n── 3. End-to-end (inline stdio server) ──");
  const fakeHome = await resetMcpStateForTest();

  const serverPath = await writeInlineServer();
  const tmpCwd = await fs.mkdtemp(path.join(os.tmpdir(), "ccagent-mcp-e2e-"));
  await fs.mkdir(path.join(tmpCwd, ".ccagent"), { recursive: true });
  await fs.writeFile(
    path.join(tmpCwd, ".ccagent", "settings.json"),
    JSON.stringify({
      mcpServers: {
        inline: { command: "node", args: [serverPath], toolTimeoutMs: 1000 },
        "missing-cmd": { command: "this-binary-definitely-does-not-exist-xyz" },
      },
    }),
  );

  const result = await bootstrapMcp(tmpCwd);
  if (result.connections.length === 2) pass(`bootstrap returned ${result.connections.length} connections`);
  else fail(`expected 2 connections, got ${result.connections.length}`);

  const inline = result.connections.find((c) => c.name === "inline");
  if (inline?.type === "connected") pass("inline server connected");
  else fail(`inline should be connected, got ${inline?.type}`);

  const missing = result.connections.find((c) => c.name === "missing-cmd");
  if (missing?.type === "failed") pass(`missing-cmd correctly marked failed (${missing.error.slice(0, 60)}...)`);
  else fail(`missing-cmd should be failed, got ${missing?.type}`);

  if (result.toolCount === 1) pass(`discovered ${result.toolCount} tool`);
  else fail(`expected 1 tool, got ${result.toolCount}`);

  // Tool is registered globally
  const toolName = buildMcpToolName("inline", "echo");
  const tool = findToolByName(toolName);
  if (tool) pass(`global registry has '${toolName}'`);
  else fail(`global registry missing '${toolName}'`);

  if (tool?.isReadOnly()) pass("annotations.readOnlyHint → tool.isReadOnly() === true");
  else fail("readOnlyHint mapping failed");

  // Call the tool through the local Tool interface
  if (tool) {
    const callResult = await tool.call({ message: "hello mcp" }, ctx);
    if (!callResult.isError && callResult.content === "hello mcp") {
      pass("tool.call() roundtripped 'hello mcp'");
    } else {
      fail(`tool.call() returned ${JSON.stringify(callResult)}`);
    }

    const timedOut = await tool.call({ message: "late", delayMs: 1200 }, ctx);
    if (timedOut.isError && String(timedOut.content).includes("after 1000ms")) {
      pass("server-level toolTimeoutMs overrides the SDK 60s default");
    } else {
      fail(`expected configured timeout, got ${JSON.stringify(timedOut)}`);
    }
    // Let the inline handler finish its delayed work before reconnecting and
    // closing the transport. This also verifies that a timed-out request does
    // not poison the stdio connection for subsequent calls.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const afterTimeout = await tool.call({ message: "still connected" }, ctx);
    if (!afterTimeout.isError && afterTimeout.content === "still connected") {
      pass("connection remains usable after one tool timeout");
    } else {
      fail(`connection was poisoned by timeout: ${JSON.stringify(afterTimeout)}`);
    }
  }

  // /mcp registry view
  const reg = getMcpRegistry();
  if (reg.length === 2) pass(`registry has ${reg.length} entries`);
  else fail(`expected 2 registry entries, got ${reg.length}`);

  // Reconnect
  const reconnected = await reconnectMcpServer("inline");
  if (reconnected?.type === "connected") pass("reconnect succeeded");
  else fail(`reconnect failed: ${reconnected?.type}`);
  const reEntry = getMcpRegistryEntry("inline");
  if (reEntry?.tools.length === 1) pass(`reconnect re-discovered ${reEntry.tools.length} tool`);
  else fail(`reconnect should re-discover 1 tool, got ${reEntry?.tools.length}`);

  // Cleanup all connections
  for (const { connection } of getMcpRegistry()) {
    if (connection.type === "connected") await connection.cleanup();
  }
  pass("all connections cleaned up");

  // Total tools should still include the freshly registered MCP tool *until*
  // we cleared the global registry. We cleaned up connections (kills the
  // children) but the Tool adapters are still in the registry. That's
  // acceptable — calling them will just return a connection-closed error.
  const total = getAllTools().length;
  if (total >= 14) pass(`getAllTools() returns ${total} tools (builtins + mcp)`);
  else fail(`getAllTools returned only ${total}`);

  // Tidy up tmp dirs
  await fs.rm(tmpCwd, { recursive: true, force: true });
  await fs.rm(path.dirname(serverPath), { recursive: true, force: true });
  await fs.rm(fakeHome, { recursive: true, force: true });
}

// ─── 4. Non-blocking bootstrap (pending → connected race) ───────────
async function testNonBlockingBootstrap(): Promise<void> {
  console.log("\n── 4. Non-blocking bootstrap ──");
  const fakeHome = await resetMcpStateForTest();
  // 500ms server startup delay — gives us a wide-open window to observe the
  // pending → connected transition. Without it the inline node spawn races
  // ahead of any reasonable polling interval.
  const serverPath = await writeInlineServer({ startupDelayMs: 500 });
  const tmpCwd = await fs.mkdtemp(path.join(os.tmpdir(), "ccagent-mcp-nb-"));
  await fs.mkdir(path.join(tmpCwd, ".ccagent"), { recursive: true });
  await fs.writeFile(
    path.join(tmpCwd, ".ccagent", "settings.json"),
    JSON.stringify({
      mcpServers: { inline: { command: "node", args: [serverPath] } },
    }),
  );

  // Don't await — kick off bootstrap in background, exactly like cli.ts does.
  const bootstrapPromise = bootstrapMcp(tmpCwd);

  // Poll the registry until the seed-pending step lands (or until we time
  // out). The seed runs after `loadMcpConfigs` resolves an fs.readFile, so
  // we can't observe it on the very next microtask — but we DEFINITELY
  // should see it well before the 500ms server-startup delay completes.
  let pendingSeen = false;
  const pollDeadline = Date.now() + 400; // must beat 500ms server delay
  while (Date.now() < pollDeadline) {
    await new Promise((r) => setImmediate(r));
    const entry = getMcpRegistryEntry("inline");
    if (entry?.connection.type === "pending") { pendingSeen = true; break; }
    if (entry?.connection.type === "connected") break; // missed the window
  }
  if (pendingSeen) pass("registry seeded with 'pending' before connect resolves");
  else fail("never observed 'pending' state — bootstrap might be blocking");

  // Now wait for connection to actually finish
  await bootstrapPromise;

  const lateEntry = getMcpRegistryEntry("inline");
  if (lateEntry?.connection.type === "connected") pass("placeholder replaced with 'connected'");
  else fail(`expected connected, got ${lateEntry?.connection.type}`);

  // Cleanup
  for (const { connection } of getMcpRegistry()) {
    if (connection.type === "connected") await connection.cleanup();
  }
  await fs.rm(tmpCwd, { recursive: true, force: true });
  await fs.rm(path.dirname(serverPath), { recursive: true, force: true });
  await fs.rm(fakeHome, { recursive: true, force: true });
}

// ─── 5. HTTP transport (real localhost MCP server) ──────────────────
async function testHttpTransport(): Promise<void> {
  console.log("\n── 5. HTTP transport (real localhost MCP server) ──");
  const fakeHome = await resetMcpStateForTest();

  // Lazily import server-side SDK only here so the rest of the test file
  // doesn't pay for it. This is the same SDK CCAGENT depends on, so the
  // resolution is local/no-network.
  const { Server } = await import("@modelcontextprotocol/sdk/server/index.js");
  const { StreamableHTTPServerTransport } = await import(
    "@modelcontextprotocol/sdk/server/streamableHttp.js"
  );
  const { CallToolRequestSchema, ListToolsRequestSchema } = await import(
    "@modelcontextprotocol/sdk/types.js"
  );
  const http = await import("node:http");

  const REQUIRED_TOKEN = "Bearer test-secret-123";
  const seenAuthHeaders: string[] = [];

  // Per-request stateless MCP server. This is the pattern recommended by
  // the SDK for "stateless mode" deployments (e.g. serverless / per-call).
  const httpServer = http.createServer(async (req, res) => {
    if (!req.url?.startsWith("/mcp")) {
      res.writeHead(404).end("Not found");
      return;
    }
    const auth = req.headers.authorization ?? "";
    seenAuthHeaders.push(auth);
    if (auth !== REQUIRED_TOKEN) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "missing or invalid bearer token" }));
      return;
    }

    const server = new Server(
      { name: "inline-http", version: "0.0.1" },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: "ping",
          description: "Reply with pong + the message.",
          inputSchema: {
            type: "object",
            properties: { message: { type: "string" } },
            required: ["message"],
          },
          annotations: { readOnlyHint: true, title: "Ping" },
        },
      ],
    }));
    server.setRequestHandler(CallToolRequestSchema, async (r) => ({
      content: [{ type: "text", text: `pong:${String(r.params.arguments?.message ?? "")}` }],
    }));

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
      enableJsonResponse: true,      // simple JSON, no SSE upgrade
    });
    res.on("close", () => { void transport.close(); void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  });
  await new Promise<void>((r) => httpServer.listen(0, "127.0.0.1", r));
  const addr = httpServer.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  const baseUrl = `http://127.0.0.1:${port}/mcp`;

  // Case A: correct token → connection should succeed and discover the tool
  const tmpCwd = await fs.mkdtemp(path.join(os.tmpdir(), "ccagent-mcp-http-"));
  await fs.mkdir(path.join(tmpCwd, ".ccagent"), { recursive: true });
  await fs.writeFile(
    path.join(tmpCwd, ".ccagent", "settings.json"),
    JSON.stringify({
      mcpServers: {
        "remote-ok": { type: "http", url: baseUrl, headers: { Authorization: REQUIRED_TOKEN } },
      },
    }),
  );

  const result = await bootstrapMcp(tmpCwd);
  const ok = result.connections.find((c) => c.name === "remote-ok");
  if (ok?.type === "connected") pass("HTTP server connected with bearer token");
  else fail(`HTTP server should be connected, got ${ok?.type}: ${(ok as any)?.error ?? ""}`);

  if (seenAuthHeaders.includes(REQUIRED_TOKEN)) pass("server received Authorization header from client");
  else fail(`server never saw Authorization header: ${JSON.stringify(seenAuthHeaders)}`);

  if (result.toolCount === 1) pass(`HTTP discovered ${result.toolCount} tool`);
  else fail(`HTTP expected 1 tool, got ${result.toolCount}`);

  const toolName = buildMcpToolName("remote-ok", "ping");
  const tool = findToolByName(toolName);
  if (tool) pass(`global registry has '${toolName}'`);
  else fail(`global registry missing '${toolName}'`);

  if (tool) {
    const callRes = await tool.call({ message: "world" }, ctx);
    if (!callRes.isError && callRes.content === "pong:world") pass("tools/call roundtripped over HTTP");
    else fail(`tools/call returned ${JSON.stringify(callRes)}`);
  }

  // Cleanup connections (calls client.close which DELETEs the session)
  for (const { connection } of getMcpRegistry()) {
    if (connection.type === "connected") await connection.cleanup();
  }

  // Case B: wrong token → graceful failure (no crash, marked failed)
  await resetMcpStateForTest();
  process.env.HOME = fakeHome; // re-isolate user scope
  await fs.writeFile(
    path.join(tmpCwd, ".ccagent", "settings.json"),
    JSON.stringify({
      mcpServers: {
        "remote-bad": { type: "http", url: baseUrl, headers: { Authorization: "Bearer wrong" } },
      },
    }),
  );
  const badResult = await bootstrapMcp(tmpCwd);
  const bad = badResult.connections.find((c) => c.name === "remote-bad");
  if (bad?.type === "failed") pass(`401 → connection marked failed (${bad.error.slice(0, 80)}…)`);
  else fail(`expected failed, got ${bad?.type}`);

  // Tear down test HTTP server
  await new Promise<void>((r) => httpServer.close(() => r()));
  await fs.rm(tmpCwd, { recursive: true, force: true });
  await fs.rm(fakeHome, { recursive: true, force: true });
}

async function main() {
  console.log("── Stage 16: MCP Verification ──\n");
  testNormalization();
  await testConfigValidation();
  await testGoogleOAuthProvider();
  await testEndToEnd();
  await testNonBlockingBootstrap();
  await testHttpTransport();
  console.log(exitCode === 0 ? "\nAll MCP smoke tests passed." : "\nSome MCP smoke tests failed.");
  // Do not force process.exit() while Windows is still delivering the final
  // child-process close callbacks. Forcing libuv to tear down an async handle
  // in UV_HANDLE_CLOSING can trigger an assertion even though every MCP
  // assertion already passed. Setting exitCode lets Node drain those handles
  // normally and still returns the correct status to the caller.
  process.exitCode = exitCode;
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exitCode = 1;
});
