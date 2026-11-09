/** Account-isolated catalog lifecycle plus real loopback Figma MCP tool execution. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { loginForTest } from "./helpers/accountFixture.js";
import { getUserSettingsPath } from "../utils/paths.js";
import { resetSettingsCache } from "../config/sources.js";
import { CANVA_MCP_URL, DEFAULT_CANVA_REDIRECT_URI, changeWebApp, webAppsView } from "../entrypoint/webApps.js";
import { normalizeFigmaMcpUrl } from "../services/mcp/figma.js";
import { loadMcpConfigs } from "../services/mcp/config.js";
import { startMcpServer, refreshGlobalToolRegistry } from "../services/mcp/bootstrap.js";
import { clearServerCache } from "../services/mcp/client.js";
import { deleteMcpRegistryEntry, getMcpRegistryEntry } from "../services/mcp/registry.js";
import { BrowserMcpOAuthProvider } from "../services/mcp/browserOAuth.js";
import { WEB_SECRET_FILE } from "../utils/webSecrets.js";
import type { ScopedMcpServerConfig } from "../types/mcp.js";

const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "ccagent-design-apps-")));
const fixture = await loginForTest(temp);
const workspace = path.join(temp, "workspace"), drawingDirectory = path.join(temp, "CAD 图纸");
await fs.mkdir(workspace); await fs.mkdir(drawingDirectory);
const settingsFile = getUserSettingsPath();
const readSettings = async () => JSON.parse(await fs.readFile(settingsFile, "utf8"));
const writeSettings = async (value: unknown) => { await fs.writeFile(settingsFile, JSON.stringify(value)); resetSettingsCache(); };
const secrets = async () => fs.readFile(path.join(fixture.home, WEB_SECRET_FILE), "utf8").catch(() => "");
let calls = 0;
const server = createServer(async (req, res) => {
  if (req.url !== "/mcp" || req.method !== "POST") { res.writeHead(405); res.end(); return; }
  let raw = ""; for await (const chunk of req) raw += chunk;
  const message = JSON.parse(raw);
  if (message.id === undefined) { res.writeHead(202); res.end(); return; }
  const result = message.method === "initialize" ? { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "figma-desktop-fixture", version: "1" } }
    : message.method === "tools/list" ? { tools: [{ name: "get_design_context", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } }] }
    : { content: [{ type: "text", text: "FIGMA_CONTEXT_FROM_REAL_LOCAL_TRANSPORT" }] };
  if (message.method === "tools/call") calls++;
  res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const localUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`;
let active: ScopedMcpServerConfig | undefined;
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, options) => {
  if (!String(input).startsWith("http://127.0.0.1:")) throw new Error("Design fixture attempted external network access");
  return originalFetch(input, options);
};
try {
  await writeSettings({ sentinel: true });
  const before = await fs.readFile(settingsFile, "utf8");
  for (const invalid of ["https://figma.com/mcp", "http://127.1/mcp", "http://127.0.0.1:0/mcp", "http://127.0.0.1:65536/mcp", "http://user@localhost:3845/mcp", "http://localhost:3845/mcp?key=1", "http://localhost:3845/mcp#x", "http://localhost:3845/a/../mcp", "http://localhost:3845/%6dcp", "http://localhost:3845/mcp\\", "http://localhost:3845/"]) {
    assert.throws(() => normalizeFigmaMcpUrl(invalid), /Figma/);
    await assert.rejects(changeWebApp(workspace, { id: "figma", op: "install", credentials: { localUrl: invalid } }), /Figma/);
  }
  assert.equal(await fs.readFile(settingsFile, "utf8"), before);
  assert.equal(normalizeFigmaMcpUrl("http://localhost:3845/mcp/"), "http://localhost:3845/mcp");
  assert.equal(normalizeFigmaMcpUrl("http://[::1]:3845/mcp"), "http://[::1]:3845/mcp");
  await changeWebApp(workspace, { id: "figma", op: "install", credentials: { localUrl } });
  assert.equal((await webAppsView(workspace)).apps.find((a) => a.id === "figma")?.state, "pending");
  active = (await loadMcpConfigs(workspace)).servers["app-figma"]!;
  assert.equal((await startMcpServer("app-figma", active)).type, "connected");
  const tool = getMcpRegistryEntry("app-figma")!.tools[0]!;
  assert.match(String((await tool.call({}, { cwd: workspace })).content), /FIGMA_CONTEXT_FROM_REAL_LOCAL_TRANSPORT/);
  assert.equal(calls, 1);
  await changeWebApp(workspace, { id: "figma", op: "uninstall" }, async (name) => {
    deleteMcpRegistryEntry(name); refreshGlobalToolRegistry(); await clearServerCache(name, active!);
  });
  active = undefined;
  assert.equal((await webAppsView(workspace)).apps.find((a) => a.id === "figma")?.state, "available");

  const beforeCanva = await secrets();
  await assert.rejects(changeWebApp(workspace, { id: "canva", op: "install", credentials: { clientId: "canva-fixture" } }), /Client Secret/);
  assert.equal((await secrets()).trim(), beforeCanva.trim());
  for (const redirectUri of ["https://remote.invalid/oauth/callback", "http://127.0.0.1:0/oauth/callback", "http://127.0.0.1:65536/oauth/callback", "http://127.0.0.1:53683/oauth/callback?x=1"]) {
    await assert.rejects(changeWebApp(workspace, { id: "canva", op: "install", credentials: { clientId: "canva-fixture", clientSecret: "canva-secret-fixture", redirectUri } }), /回调/);
  }
  await changeWebApp(workspace, { id: "canva", op: "install", credentials: { clientId: "canva-fixture", clientSecret: "canva-secret-fixture" } });
  let saved = await readSettings();
  const canva = saved.mcpServers["app-canva"];
  assert.equal(canva.url, CANVA_MCP_URL);
  assert.equal(canva.oauth.provider, "browser");
  assert.equal(canva.oauth.redirectUri, DEFAULT_CANVA_REDIRECT_URI);
  assert.ok(!JSON.stringify(saved).includes("canva-secret-fixture"));
  assert.ok(!JSON.stringify(await webAppsView(workspace)).includes("canva-fixture"));
  assert.equal((await webAppsView(workspace)).apps.find((a) => a.id === "canva")?.state, "pending");
  const provider = new BrowserMcpOAuthProvider(CANVA_MCP_URL, canva.oauth);
  await provider.saveTokens({ access_token: "fixture-browser-token", token_type: "Bearer" });
  assert.equal((await provider.tokens())?.access_token, "fixture-browser-token");
  // A manual service sharing the exact account/client/endpoint keeps its login and secret refs.
  saved.mcpServers.sharedCanva = { ...canva }; await writeSettings(saved);
  let stoppedBeforeCredentialRemoval = false;
  await changeWebApp(workspace, { id: "canva", op: "uninstall" }, async () => {
    assert.equal(process.env[canva.oauth.clientIdEnv], "canva-fixture");
    await provider.cancel(); stoppedBeforeCredentialRemoval = true;
  });
  assert.ok(stoppedBeforeCredentialRemoval);
  const sharedProvider = new BrowserMcpOAuthProvider(CANVA_MCP_URL, canva.oauth);
  assert.equal((await sharedProvider.tokens())?.access_token, "fixture-browser-token");
  saved = await readSettings(); delete saved.mcpServers.sharedCanva; await writeSettings(saved);
  // New per-install refs with the same actual Client ID still identify and clear the old login.
  await changeWebApp(workspace, { id: "canva", op: "install", credentials: { clientId: "canva-fixture", clientSecret: "canva-secret-fixture" } });
  const nextCanva = (await readSettings()).mcpServers["app-canva"];
  const nextProvider = new BrowserMcpOAuthProvider(CANVA_MCP_URL, nextCanva.oauth);
  assert.ok(await nextProvider.tokens());
  await changeWebApp(workspace, { id: "canva", op: "uninstall" }, async () => { await nextProvider.cancel(); });
  assert.equal(await sharedProvider.tokens(), undefined);
  assert.equal(process.env[nextCanva.oauth.clientIdEnv], undefined);

  const drawing = path.join(drawingDirectory, "保留图纸.dwg"); await fs.writeFile(drawing, "fixture-user-drawing");
  await assert.rejects(changeWebApp(workspace, { id: "autocad", op: "install", credentials: {} }), /CAD 工作目录/);
  await changeWebApp(workspace, { id: "autocad", op: "install", credentials: { workingDirectory: drawingDirectory, progId: "AutoCAD.Application.25" } });
  const cad = (await readSettings()).mcpServers["app-autocad"], toml = cad.env.AUTOCAD_MCP_CONFIG;
  assert.match(await fs.readFile(toml, "utf8"), /allow_launch = false/);
  assert.match(await fs.readFile(toml, "utf8"), /enable_lisp = false/);
  assert.ok(!JSON.stringify(await webAppsView(workspace)).includes(toml));
  await assert.rejects(changeWebApp(workspace, { id: "autocad", op: "install", credentials: { workingDirectory: drawingDirectory } }), /同名/);
  await changeWebApp(workspace, { id: "autocad", op: "uninstall" }, async () => { assert.ok(await fs.stat(toml)); });
  await assert.rejects(fs.stat(toml), { code: "ENOENT" });
  assert.equal(await fs.readFile(drawing, "utf8"), "fixture-user-drawing");
  assert.equal((await readSettings()).sentinel, true);
  console.log("Design catalog PASS: URL validation, real local MCP tool call, Canva OAuth config/rollback/shared-token cleanup, CAD managed config cleanup and drawing preservation.");
} finally {
  if (active) { deleteMcpRegistryEntry("app-figma"); await clearServerCache("app-figma", active); }
  globalThis.fetch = originalFetch;
  server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
  await fixture.close();
  assert.equal(path.dirname(temp).toLowerCase(), (await fs.realpath(os.tmpdir())).toLowerCase());
  await fs.rm(temp, { recursive: true, force: true });
}
