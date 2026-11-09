/** Isolated account settings + real local MCP transport. No third-party account is used. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { changeWebApp, COMMON_APPS, webAppsView } from "../entrypoint/webApps.js";
import { loginForTest } from "./helpers/accountFixture.js";
import { getUserSettingsPath } from "../utils/paths.js";
import { resetSettingsCache } from "../config/sources.js";
import { loadMcpConfigs } from "../services/mcp/config.js";
import { startMcpServer, setMcpServerOpen, refreshGlobalToolRegistry } from "../services/mcp/bootstrap.js";
import { getMcpRegistryEntry, deleteMcpRegistryEntry } from "../services/mcp/registry.js";
import { clearServerCache } from "../services/mcp/client.js";
import { resolveMcpEnvironment } from "../services/mcp/environment.js";
import { WEB_SECRET_FILE } from "../utils/webSecrets.js";

const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "ccagent-web-apps-")));
const fixture = await loginForTest(temp);
const workspace = path.join(temp, "workspace"); await fs.mkdir(workspace);
const settingsFile = getUserSettingsPath();
const readSettings = async () => JSON.parse(await fs.readFile(settingsFile, "utf8"));
const token = "fixture-private-token-never-export";
let calls = 0;
const mock = createServer(async (req, res) => {
  assert.equal(req.headers.authorization, `Bearer ${token}`);
  if (req.method !== "POST") { res.writeHead(405); res.end(); return; }
  let text = ""; for await (const chunk of req) text += chunk;
  const rpc = JSON.parse(text);
  if (rpc.id === undefined) { res.writeHead(202); res.end(); return; }
  const result = rpc.method === "initialize" ? { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "catalog-fixture", version: "1" } }
    : rpc.method === "tools/list" ? { tools: [{ name: "echo", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } }] }
    : { content: [{ type: "text", text: "CATALOG_TOOL_OK" }] };
  if (rpc.method === "tools/call") calls++;
  res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
});
await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${(mock.address() as { port: number }).port}`;
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, options) => {
  const url = String(input);
  if (url.startsWith("https://api.githubcopilot.com/mcp/")) return originalFetch(url.replace("https://api.githubcopilot.com", origin), options);
  if (!url.startsWith("http://127.0.0.1:")) throw new Error("Test attempted an external request");
  return originalFetch(input, options);
};
let activeConfig: Awaited<ReturnType<typeof loadMcpConfigs>>["servers"][string] | undefined;
try {
  await fs.writeFile(settingsFile, JSON.stringify({ sentinel: { preserve: true }, mcpServers: { manual: { command: "manual-only", enabled: false } } }));
  assert.equal(COMMON_APPS.length, 15);
  assert.ok((await webAppsView(workspace)).apps.every((app) => app.state === "available"));
  const beforeSketchup = await fs.readFile(settingsFile, "utf8");
  await assert.rejects(changeWebApp(workspace, { id: "sketchup", op: "install", credentials: { port: 0 } }), /端口/);
  assert.equal(await fs.readFile(settingsFile, "utf8"), beforeSketchup);
  await changeWebApp(workspace, { id: "sketchup", op: "install", credentials: { port: 9876 } });
  const sketchupConfig = await readSettings();
  assert.equal(sketchupConfig.mcpServers["app-sketchup"].env.SKETCHUP_MCP_HOST, "127.0.0.1");
  assert.equal(sketchupConfig.mcpServers["app-sketchup"].env.SKETCHUP_MCP_PORT, "9876");
  assert.deepEqual(sketchupConfig.webAppConnections.sketchup.secrets, []);
  await changeWebApp(workspace, { id: "sketchup", op: "uninstall" });
  assert.ok(!(await readSettings()).mcpServers["app-sketchup"]);
  const beforeInvalidLocal = await fs.readFile(settingsFile, "utf8");
  await assert.rejects(changeWebApp(workspace, { id: "comfyui", op: "install", credentials: { localUrl: "http://remote.invalid:8188" } }), /本地插件/);
  assert.equal(await fs.readFile(settingsFile, "utf8"), beforeInvalidLocal);
  await changeWebApp(workspace, { id: "comfyui", op: "install", credentials: { localUrl: "http://localhost:8189" } });
  const localConfig = await readSettings();
  assert.equal(localConfig.mcpServers["app-comfyui"].env.COMFY_LOCAL_URL, "http://localhost:8189");
  assert.deepEqual(localConfig.webAppConnections.comfyui.secrets, []);
  assert.equal((await webAppsView(workspace)).apps.find((app) => app.id === "comfyui")?.state, "pending");
  await changeWebApp(workspace, { id: "comfyui", op: "uninstall" });
  assert.ok(!(await readSettings()).mcpServers["app-comfyui"]);
  await Promise.all([
    changeWebApp(workspace, { id: "github", op: "install", credentials: { token } }),
    changeWebApp(workspace, { id: "linear", op: "install", credentials: { token: "linear-fixture" } }),
  ]);
  let saved = await readSettings();
  assert.equal(saved.sentinel.preserve, true); assert.ok(saved.mcpServers.manual);
  assert.ok(saved.mcpServers["app-github"] && saved.mcpServers["app-linear"]);
  assert.ok(!JSON.stringify(saved).includes(token));
  assert.ok(!JSON.stringify(await webAppsView(workspace)).includes(token));
  assert.equal((await webAppsView(workspace)).apps.find((app) => app.id === "github")?.state, "pending");
  const beforeDuplicate = await fs.readFile(settingsFile, "utf8");
  await assert.rejects(changeWebApp(workspace, { id: "github", op: "install", credentials: { token: "overwrite" } }), /同名/);
  assert.equal(await fs.readFile(settingsFile, "utf8"), beforeDuplicate);
  const secretFile = path.join(fixture.home, WEB_SECRET_FILE);
  const beforePartial = await fs.readFile(secretFile, "utf8");
  await assert.rejects(changeWebApp(workspace, { id: "google-docs", op: "install", credentials: { clientId: "fixture-client" } }), /Client Secret/);
  assert.equal(await fs.readFile(secretFile, "utf8"), beforePartial);
  assert.equal(resolveMcpEnvironment({ Authorization: saved.mcpServers["app-github"].headers.Authorization })?.Authorization, `Bearer ${token}`);
  assert.throws(() => resolveMcpEnvironment({ Authorization: "Bearer ${CCAGENT_TEST_ABSENT_SECRET}" }), /not configured/);
  activeConfig = (await loadMcpConfigs(workspace)).servers["app-github"]!;
  assert.equal((await startMcpServer("app-github", activeConfig)).type, "connected");
  assert.equal((await webAppsView(workspace)).apps.find((app) => app.id === "github")?.state, "connected");
  const tool = getMcpRegistryEntry("app-github")!.tools[0]!;
  assert.equal((await tool.call({}, { cwd: workspace })).content, "CATALOG_TOOL_OK"); assert.equal(calls, 1);
  await setMcpServerOpen("app-github", false);
  assert.equal((await webAppsView(workspace)).apps.find((app) => app.id === "github")?.state, "disabled");
  assert.ok((await tool.call({}, { cwd: workspace })).isError);
  await changeWebApp(workspace, { id: "github", op: "uninstall" });
  deleteMcpRegistryEntry("app-github"); refreshGlobalToolRegistry(); await clearServerCache("app-github", activeConfig);
  assert.ok(!(await fs.readFile(secretFile, "utf8")).includes(token));
  assert.equal((await webAppsView(workspace)).apps.find((app) => app.id === "github")?.installed, false);

  saved = await readSettings(); saved.mcpServers["app-linear"].url = "https://example.invalid/modified";
  await fs.writeFile(settingsFile, JSON.stringify(saved)); resetSettingsCache();
  assert.equal((await webAppsView(workspace)).apps.find((app) => app.id === "linear")?.state, "conflict");
  await assert.rejects(changeWebApp(workspace, { id: "linear", op: "uninstall" }), /修改或覆盖/);
  assert.ok((await readSettings()).mcpServers["app-linear"]);
  const accountHome = process.env.CCAGENT_HOME;
  process.env.CCAGENT_HOME = path.join(temp, "other-account"); resetSettingsCache();
  assert.ok((await webAppsView(workspace)).apps.every((app) => !app.installed));
  process.env.CCAGENT_HOME = accountHome; resetSettingsCache();
  await fs.writeFile(settingsFile, "{broken");
  await assert.rejects(changeWebApp(workspace, { id: "notion", op: "install", credentials: { token: "fixture" } }), /原文件未改动/);
  assert.equal(await fs.readFile(settingsFile, "utf8"), "{broken");
  console.log("Web app catalog: account isolation, concurrent persistence, credentials, rollback, real MCP tool execution, disconnect, uninstall, conflicts and malformed settings passed.");
} finally {
  if (activeConfig) { deleteMcpRegistryEntry("app-github"); await clearServerCache("app-github", activeConfig); }
  globalThis.fetch = originalFetch;
  mock.closeAllConnections(); await new Promise<void>((resolve) => mock.close(() => resolve()));
  await fixture.close();
  assert.equal(path.dirname(temp).toLowerCase(), (await fs.realpath(os.tmpdir())).toLowerCase());
  await fs.rm(temp, { recursive: true, force: true });
}
