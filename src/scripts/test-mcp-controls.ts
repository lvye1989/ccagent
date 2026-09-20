/** Hermetic MCP lifecycle tests. No real credentials, browser, or external server. */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createServer, type Server } from "node:http";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import type { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { bootstrapMcp, reconnectMcpServer, setMcpServerOpen, startMcpServer } from "../services/mcp/bootstrap.js";
import { clearServerCache, _resetMcpClientForTesting } from "../services/mcp/client.js";
import { clearMcpRegistry, getMcpRegistryEntry, getMcpRegistry, setMcpRegistryEntry } from "../services/mcp/registry.js";
import { _resetMcpPreferencesForTesting, loadMcpPreferences, saveMcpServerState } from "../services/mcp/preferences.js";
import { GoogleWorkspaceOAuthProvider } from "../services/mcp/googleOAuth.js";
import { applyPluginMcpDiff } from "../plugins/mcpApply.js";
import { handleMcpCommand } from "../core/queryEngine/commands/mcp.js";
import { findToolByName } from "../tools/index.js";
import { resetSettingsCache } from "../config/sources.js";
import type { ScopedMcpServerConfig, McpGoogleOAuthConfig } from "../types/mcp.js";
import type { ToolContext, UserQuestionRequest } from "../tools/Tool.js";
import { QueryEngine } from "../core/queryEngine.js";
import React from "react";
import { PassThrough } from "node:stream";
import { render } from "ink";
import { QuestionPrompt } from "../ui/components/QuestionPrompt.js";
import { stripVTControlCharacters } from "node:util";

const taskHome = await fs.mkdtemp(path.join(os.tmpdir(), "ccagent-mcp-controls-"));
const oldHome = process.env.CCAGENT_HOME;
process.env.CCAGENT_HOME = taskHome;
process.env.TEST_MCP_CLIENT_ID = "test-id";
process.env.TEST_MCP_CLIENT_SECRET = "test-secret";
const settingsFile = path.join(taskHome, "settings.json");
let passed = 0;
function check(value: unknown, message: string): void { assert.ok(value, message); console.log(`  OK ${++passed}. ${message}`); }
async function until(predicate: () => boolean): Promise<void> {
  const end = Date.now() + 4_000;
  while (!predicate()) {
    if (Date.now() > end) throw new Error("Test condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
async function bounded<T>(task: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([task, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Cancellation exceeded 2 seconds")), 2_000);
    })]);
  } finally { clearTimeout(timer!); }
}
async function listen(server: Server, port = 0): Promise<number> {
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  return (server.address() as { port: number }).port;
}
async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
async function command(args: string[], ask?: ToolContext["requestUserQuestion"]): Promise<string> {
  const messages: string[] = [];
  for await (const event of handleMcpCommand(args, ask)) if (event.type === "command") messages.push(event.message);
  return messages.join("\n");
}
let postCount = 0;
let slowInitialize = false;
const delayedReplies: Array<() => void> = [];
let holdTool = false;
let toolRequests = 0;
let refreshes = 0;
let authAtDiscovery = false;
let origin = "";
const server = createServer(async (req, res) => {
  const route = req.url ?? "/";
  const json = (body: unknown, code = 200): void => {
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(body));
  };
  if (route.includes("oauth-protected-resource")) {
    json({ resource: origin, authorization_servers: [origin] }); return;
  }
  if (route.includes("oauth-authorization-server")) {
    json({ issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`,
      response_types_supported: ["code"], code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["client_secret_post"] }); return;
  }
  if (route === "/token") {
    refreshes++;
    req.resume(); json({ access_token: "refreshed", token_type: "Bearer", refresh_token: "test-refresh" }); return;
  }
  if (req.method !== "POST") { res.writeHead(405); res.end(); return; }
  postCount++;
  let body = "";
  for await (const chunk of req) body += chunk;
  const rpc = JSON.parse(body);
  const challenge = (): void => {
    res.setHeader("WWW-Authenticate", `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource", scope="test.read"`);
    json({ error: "unauthorized" }, 401);
  };
  if (route === "/auth" && req.headers.authorization !== "Bearer refreshed") { challenge(); return; }
  if (authAtDiscovery && rpc.method === "tools/list") { challenge(); return; }
  if (rpc.method === "initialize") {
    const reply = () => json({ jsonrpc: "2.0", id: rpc.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "switch-test", version: "1" } } });
    if (slowInitialize) delayedReplies.push(reply); else reply();
  } else if (rpc.method === "tools/list") {
    json({ jsonrpc: "2.0", id: rpc.id, result: { tools: [{ name: "echo", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } }] } });
  } else if (rpc.method === "tools/call") {
    toolRequests++;
    if (!holdTool) json({ jsonrpc: "2.0", id: rpc.id, result: { content: [{ type: "text", text: "ok" }] } });
  } else { res.writeHead(202); res.end(); }
});
const port = await listen(server);
origin = `http://127.0.0.1:${port}`;
const config: ScopedMcpServerConfig = { type: "http", url: `${origin}/mcp`, scope: "user" };
const oauth: McpGoogleOAuthConfig = {
  provider: "google", clientIdEnv: "TEST_MCP_CLIENT_ID", clientSecretEnv: "TEST_MCP_CLIENT_SECRET",
  redirectUri: "http://127.0.0.1:53682/oauth/callback",
};
try {
  await fs.writeFile(settingsFile, JSON.stringify({ sentinel: { preserved: true }, mcpServers: {
    demo: { type: "http", url: config.url },
    "off-stdio": { command: "must-never-be-spawned", enabled: false },
    "off-sse": { type: "sse", url: `${origin}/sse`, enabled: false },
    "off-http": { type: "http", url: `${origin}/off`, enabled: false },
  } }));
  const result = await bootstrapMcp(taskHome);
  check(result.connections.filter((c) => c.type === "disabled").length === 3, "enabled:false honored for stdio, HTTP, SSE without connecting");
  check(getMcpRegistryEntry("demo")?.tools.length === 1, "Open server discovers real localhost MCP tool");
  const captured = getMcpRegistryEntry("demo")!.tools[0];
  check((await captured.call({}, { cwd: taskHome })).content === "ok", "Open tool executes successfully");
  holdTool = true;
  const running = captured.call({}, { cwd: taskHome });
  await until(() => toolRequests === 2);
  await bounded(setMcpServerOpen("demo", false));
  check((await bounded(running)).isError, "Close cancels an in-flight tools/call");
  holdTool = false;
  check(!findToolByName(captured.name), "Close removes tool from global registry immediately");
  check(!captured.isEnabled() && (await captured.call({}, { cwd: taskHome })).isError, "Captured stale tool cannot execute after Close");
  const saved = JSON.parse(await fs.readFile(settingsFile, "utf8"));
  check(saved.mcpServerStates.demo === "close" && saved.sentinel.preserved, "User switch persisted without changing unrelated settings");
  check((await reconnectMcpServer("demo"))?.type === "disabled", "Reconnect cannot bypass Close");
  const beforeRestart = postCount;
  _resetMcpPreferencesForTesting();
  _resetMcpClientForTesting(); clearMcpRegistry(); resetSettingsCache();
  await bootstrapMcp(taskHome);
  check(postCount === beforeRestart, "Restart with all services closed sends zero requests");
  await setMcpServerOpen("demo", true);
  await until(() => getMcpRegistryEntry("demo")?.connection.type === "connected");
  check(getMcpRegistryEntry("demo")?.tools.length === 1, "Open restores tools without restarting application");
  check((await captured.call({}, { cwd: taskHome })).isError, "Reopen does not revive a stale adapter");

  const questions: UserQuestionRequest[] = [];
  const ui = await command(["demo"], async (request) => {
    questions.push(request); return { answers: { [request.questions[0].question]: "Close" } };
  });
  check(questions[0].questions[0].options.map((o) => o.label).join() === "Open,Close" && ui.includes("Close"), "Per-server card offers Open / Close and applies selected state");
  let engineQuestions = 0;
  const engine = new QueryEngine({
    model: "test-no-network", permissionMode: "default", permissionSettings: { allow: [], deny: [], mode: "default" },
    toolContext: { cwd: taskHome, requestUserQuestion: async (request) => {
      engineQuestions++;
      const q = request.questions[0];
      return { answers: { [q.question]: q.options.some((o) => o.label === "Close") ? "Close" : q.options[0].label } };
    } },
  });
  let engineOutput = "";
  for await (const event of engine.submitMessage("/mcp")) {
    if (event.type === "command") engineOutput += event.message;
    assert.ok(event.type !== "text", "MCP menu must not invoke an LLM");
  }
  check(engineQuestions === 2 && engineOutput.includes("Close"), "Real QueryEngine /mcp path wires both native cards without an LLM");
  const stdout = new PassThrough();
  Object.assign(stdout, { columns: 90, rows: 35 });
  let frame = "";
  stdout.on("data", (chunk) => { frame += chunk.toString(); });
  const screen = render(React.createElement(QuestionPrompt, {
    questions: questions[0].questions, questionIndex: 0, highlight: 1, selected: new Set<number>(), textInput: "",
  }), { stdout: stdout as unknown as NodeJS.WriteStream, debug: true, exitOnCtrlC: false });
  await new Promise((resolve) => setTimeout(resolve, 80));
  screen.unmount(); screen.cleanup();
  frame = stripVTControlCharacters(frame);
  check(frame.includes("Open") && frame.includes("Close") && frame.includes("demo"), "Native Ink card renders server name and Open / Close choices");
  let pageQueries = 0;
  await command([], async (request) => {
    const q = request.questions[0]; pageQueries++;
    assert.ok(q.options.length <= 4);
    return pageQueries === 1 ? { answers: { [q.question]: "Next page" } } : null;
  });
  check(pageQueries === 2, "Server selector paginates without overflowing question cards");
  check((await command(["auth", "demo"])).includes("closed"), "Auth cannot bypass Close");
  check((await command(["open", "not-approved"])).includes("not configured"), "Switch cannot introduce unconfigured/unapproved servers");
  setMcpRegistryEntry("managed", { name: "managed", type: "disabled", config: { ...config, scope: "policy", enabled: false } }, []);
  await assert.rejects(setMcpServerOpen("managed", true), /managed policy/);
  check(true, "Managed policy Close cannot be overridden by user Open");

  const pluginName = "plugin:demo:local";
  await saveMcpServerState(pluginName, "close");
  const priorRequests = postCount;
  await applyPluginMcpDiff(new Map(), new Map([[pluginName, config]]));
  check(getMcpRegistryEntry(pluginName)?.connection.type === "disabled" && postCount === priorRequests, "Plugin MCP startup honors user Close");
  await applyPluginMcpDiff(new Map([[pluginName, config]]), new Map([[pluginName, { ...config, toolTimeoutMs: 2_000 }]]));
  check(postCount === priorRequests, "Plugin configuration reload cannot reopen a closed server");

  slowInitialize = true;
  const pending = startMcpServer("slow", config);
  await until(() => postCount > priorRequests);
  await bounded(setMcpServerOpen("slow", false));
  await bounded(pending);
  check(getMcpRegistryEntry("slow")?.connection.type === "disabled", "Close cancels slow handshake; late startup cannot resurrect server");
  slowInitialize = false;
  let generation = 1;
  slowInitialize = true;
  const beforeOverlap = postCount;
  const stale = startMcpServer("overlap", config, () => generation === 1);
  await until(() => postCount > beforeOverlap);
  const firstPlaceholder = getMcpRegistryEntry("overlap")?.connection;
  generation = 2;
  const latest = startMcpServer("overlap", config, () => generation === 2);
  await until(() => getMcpRegistryEntry("overlap")?.connection !== firstPlaceholder);
  slowInitialize = false;
  delayedReplies.splice(0).forEach((reply) => reply());
  await Promise.all([stale, latest]);
  const overlapTool = getMcpRegistryEntry("overlap")?.tools[0];
  check(overlapTool && (await overlapTool.call({}, { cwd: taskHome })).content === "ok", "Overlapping plugin starts cannot close a shared newer connection");

  const bad = await startMcpServer("needs-auth", { ...config, url: `${origin}/auth`, oauth });
  check(bad.type === "failed" && /Authorization required/.test(bad.error), "401 during initialize fails fast without browser consent");
  authAtDiscovery = true;
  const discovered = await startMcpServer("list-auth", { ...config, oauth });
  check(discovered.type === "connected" && /Authorization required/.test(discovered.discoveryError ?? ""), "401 during tools/list reports authorization required instead of waiting five minutes");
  authAtDiscovery = false;
  const tokenProvider = new GoogleWorkspaceOAuthProvider("127.0.0.1", oauth, { homeDir: taskHome });
  await tokenProvider.saveTokens({ access_token: "expired", token_type: "Bearer", refresh_token: "test-refresh" });
  const refreshed = await reconnectMcpServer("needs-auth");
  check(refreshed?.type === "connected" && refreshes === 1, "Stored refresh token renews silently; SDK recursive retry does not deadlock");

  const reserve = createServer();
  const callbackPort = await listen(reserve); await close(reserve);
  let opened = 0;
  let finished = 0;
  const fakeTransport = { finishAuth: async () => { finished++; } } as unknown as StreamableHTTPClientTransport;
  const providers = ["first", "queued"].map((name) => new GoogleWorkspaceOAuthProvider(name,
    { ...oauth, redirectUri: `http://127.0.0.1:${callbackPort}/oauth/callback` }, {
      homeDir: taskHome, openExternal: async () => { opened++; return true; },
    }));
  for (const provider of providers) {
    const state = provider.state(); provider.redirectToAuthorization(new URL(`https://accounts.google.test/auth?state=${state}`));
  }
  await assert.rejects(providers[0].runWithAuth(fakeTransport, async () => { throw new UnauthorizedError(); }), /Authorization required/);
  check(opened === 0, "Default runWithAuth cannot launch browser");
  const firstAuth = providers[0].runWithAuth(fakeTransport, async () => { throw new UnauthorizedError(); }, { interactive: true }).catch((e: Error) => e);
  await until(() => opened === 1);
  const queuedAuth = providers[1].runWithAuth(fakeTransport, async () => { throw new UnauthorizedError(); }, { interactive: true }).catch((e: Error) => e);
  await bounded(providers[1].cancel());
  check((await bounded(queuedAuth)) instanceof Error && opened === 1, "Cancel a queued OAuth request without waiting for another server");
  await bounded(providers[0].cancel());
  check((await bounded(firstAuth)) instanceof Error && finished === 0, "Cancel active browser OAuth without finishing auth or retrying action");
  const reuse = createServer(); await listen(reuse, callbackPort); await close(reuse);
  check(true, "OAuth callback port is released immediately after cancellation");

  await fs.writeFile(settingsFile, "{invalid settings");
  await assert.rejects(setMcpServerOpen("demo", true), /invalid user settings/);
  check(await fs.readFile(settingsFile, "utf8") === "{invalid settings", "Malformed user settings are never overwritten by switch persistence");
  console.log(`\n${passed} MCP control checks passed.`);
} finally {
  await Promise.all(getMcpRegistry().map(({ connection }) => clearServerCache(connection.name, connection.config)));
  _resetMcpClientForTesting(); _resetMcpPreferencesForTesting(); clearMcpRegistry();
  await close(server);
  if (oldHome === undefined) delete process.env.CCAGENT_HOME; else process.env.CCAGENT_HOME = oldHome;
  delete process.env.TEST_MCP_CLIENT_ID; delete process.env.TEST_MCP_CLIENT_SECRET;
  // Only this test-created temporary directory is removed.
  await fs.rm(taskHome, { recursive: true, force: true });
}
