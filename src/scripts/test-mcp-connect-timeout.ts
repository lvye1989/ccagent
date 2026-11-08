#!/usr/bin/env tsx
/** Hermetic connect-timeout validation, precedence, OAuth allowance, and stdio handshake regression. */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { McpHTTPServerConfig, McpServerConfig, ScopedMcpServerConfig } from "../types/mcp.js";
import { validateServerConfig } from "../services/mcp/config.js";
import { resolveMcpConnectTimeoutMs } from "../services/mcp/connectTimeout.js";
import {
  clearServerCache,
  connectToServer,
  getActiveMcpConnections,
} from "../services/mcp/client.js";
import { _resetMcpPreferencesForTesting } from "../services/mcp/preferences.js";

const transports: McpServerConfig[] = [
  { command: process.execPath },
  { type: "stdio", command: process.execPath },
  { type: "http", url: "http://127.0.0.1:1/mcp" },
  { type: "sse", url: "http://127.0.0.1:1/sse" },
];
for (const config of transports) {
  for (const connectTimeoutMs of [1_000, 180_000, 600_000]) {
    const validated = validateServerConfig("connect-test", { ...config, connectTimeoutMs, toolTimeoutMs: 45_000 }, "user");
    assert(validated.ok, `${config.type ?? "default stdio"} accepts ${connectTimeoutMs}`);
    assert.equal(validated.value.connectTimeoutMs, connectTimeoutMs);
    assert.equal(validated.value.toolTimeoutMs, 45_000, "connect and tool deadlines remain separate");
    assert.equal(resolveMcpConnectTimeoutMs(validated.value, "20"), connectTimeoutMs);
  }
  for (const connectTimeoutMs of [null, "180000", true, 0, -1, 999, 1_000.5, 600_001, Infinity, NaN]) {
    const validated = validateServerConfig("connect-test", { ...config, connectTimeoutMs }, "user");
    assert(!validated.ok, `${config.type ?? "default stdio"} rejects ${String(connectTimeoutMs)}`);
    assert.match(validated.error, /connectTimeoutMs/);
  }
  assert(validateServerConfig("connect-test", config, "user").ok, "older configs remain valid");
  assert.equal(resolveMcpConnectTimeoutMs(config, undefined), 30_000);
  assert.equal(resolveMcpConnectTimeoutMs(config, "42000"), 42_000);
  assert.equal(resolveMcpConnectTimeoutMs(config, "75"), 75, "legacy environment limits stay unchanged");
  assert.equal(resolveMcpConnectTimeoutMs(config, "42000ms"), 42_000, "preserve legacy parseInt behavior");
  for (const invalidEnvironment of ["", "0", "-1", "invalid"]) {
    assert.equal(resolveMcpConnectTimeoutMs(config, invalidEnvironment), 30_000);
  }
  assert.equal(resolveMcpConnectTimeoutMs(config, undefined, true), 30_000, "ordinary connections get no browser allowance");
}

const google: McpHTTPServerConfig = {
  type: "http",
  url: "https://drivemcp.googleapis.com/mcp/v1",
  oauth: {
    provider: "google",
    clientIdEnv: "TEST_GOOGLE_ID",
    clientSecretEnv: "TEST_GOOGLE_SECRET",
    redirectUri: "http://127.0.0.1:53682/oauth/callback",
  },
};
assert.equal(resolveMcpConnectTimeoutMs(google, undefined, true), 330_000);
assert.equal(resolveMcpConnectTimeoutMs(google, "45000", true), 345_000);
assert.equal(resolveMcpConnectTimeoutMs({ ...google, connectTimeoutMs: 180_000 }, "45000", true), 480_000);
assert.equal(resolveMcpConnectTimeoutMs({ ...google, connectTimeoutMs: 180_000 }, "45000"), 180_000);

const previousHome = process.env.CCAGENT_HOME;
const previousTimeout = process.env.MCP_CONNECT_TIMEOUT;
const temporaryRoot = await mkdtemp(path.join(tmpdir(), "ccagent-mcp-connect-"));
const configuredConnections: Array<{ name: string; config: ScopedMcpServerConfig }> = [];
try {
  process.env.CCAGENT_HOME = temporaryRoot;
  process.env.MCP_CONNECT_TIMEOUT = "50";
  _resetMcpPreferencesForTesting();
  const serverFile = path.join(temporaryRoot, "slow-server.mjs");
  await writeFile(serverFile, `
import { Server } from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/sdk/server/index.js"))};
import { StdioServerTransport } from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/sdk/server/stdio.js"))};
await new Promise((resolve) => setTimeout(resolve, 350));
const server = new Server({ name: "connect-timeout-fixture", version: "1.0.0" }, { capabilities: {} });
await server.connect(new StdioServerTransport());
`, "utf8");

  const config: ScopedMcpServerConfig = {
    command: process.execPath,
    args: [serverFile],
    connectTimeoutMs: 3_000,
    scope: "user",
  };
  const name = "connect-timeout-fixture";
  configuredConnections.push({ name, config });
  const first = await connectToServer(name, config);
  assert.equal(first.type, "connected", "server timeout overrides the 50 ms global deadline for a cold start");
  assert.equal((await connectToServer(name, { ...config })).type, "connected");
  assert.strictEqual(await connectToServer(name, { ...config }), first, "unchanged timeout reuses the connection");

  const changed = { ...config, connectTimeoutMs: 4_000 };
  configuredConnections.push({ name, config: changed });
  const second = await connectToServer(name, changed);
  assert.equal(second.type, "connected");
  assert.notStrictEqual(second, first, "changing only the server timeout invalidates its cached connection");

  const legacyConfig: ScopedMcpServerConfig = { command: process.execPath, args: [serverFile], scope: "user" };
  configuredConnections.push({ name: "legacy-connect-deadline", config: legacyConfig });
  const legacy = await connectToServer("legacy-connect-deadline", legacyConfig);
  assert.equal(legacy.type, "failed", "servers without an override still obey MCP_CONNECT_TIMEOUT");
  if (legacy.type === "failed") assert.match(legacy.error, /timed out|timeout/i);
} finally {
  await Promise.allSettled(configuredConnections.map(({ name, config }) => clearServerCache(name, config)));
  assert.equal(getActiveMcpConnections().length, 0, "the fixture leaves no active MCP children");
  if (previousHome === undefined) delete process.env.CCAGENT_HOME;
  else process.env.CCAGENT_HOME = previousHome;
  if (previousTimeout === undefined) delete process.env.MCP_CONNECT_TIMEOUT;
  else process.env.MCP_CONNECT_TIMEOUT = previousTimeout;
  _resetMcpPreferencesForTesting();
  assert.equal(path.dirname(temporaryRoot), path.resolve(tmpdir()));
  assert(path.basename(temporaryRoot).startsWith("ccagent-mcp-connect-"));
  await rm(temporaryRoot, { recursive: true, force: true });
}
console.log("PASS: MCP connect timeout boundaries, all transports, precedence, OAuth budget, delayed handshake, cache invalidation, and cleanup");
