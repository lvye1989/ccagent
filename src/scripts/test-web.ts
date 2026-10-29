#!/usr/bin/env tsx

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setPluginEnabled } from "../plugins/enable.js";

const root = path.resolve(import.meta.dirname, "../..");
const entry = path.join(root, "dist", "ccagent.js");
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "ccagent-web-test-")));
const workspace = path.join(temp, "project");
const home = path.join(temp, "home");
await fs.mkdir(workspace);
await fs.mkdir(home);
await fs.writeFile(path.join(home, ".env"), "DEEPSEEK_API_KEY=web-test-key\nDASHSCOPE_API_KEY=web-test-key\n");
execFileSync("git", ["init", "-q"], { cwd: workspace, windowsHide: true });
await fs.writeFile(path.join(workspace, "staged file.txt"), "staged content\n");
await fs.writeFile(path.join(workspace, "draft file.txt"), "untracked content\n");
execFileSync("git", ["add", "--", "staged file.txt"], { cwd: workspace, windowsHide: true });
const mcpServer = createServer(async (req, res) => {
  if (req.method !== "POST") { res.writeHead(405); res.end(); return; }
  let input = "";
  for await (const chunk of req) input += chunk;
  const request = JSON.parse(input) as { id?: number; method?: string };
  if (request.id === undefined) { res.writeHead(202); res.end(); return; }
  const result = request.method === "initialize"
    ? { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "web-smoke", version: "1" } }
    : request.method === "tools/list"
      ? { tools: [{ name: "echo", description: "A local smoke tool", inputSchema: { type: "object" } }] }
      : { content: [{ type: "text", text: "ok" }] };
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
});
await new Promise<void>((resolve, reject) => {
  mcpServer.once("error", reject);
  mcpServer.listen(0, "127.0.0.1", resolve);
});
const mcpAddress = mcpServer.address();
assert(mcpAddress && typeof mcpAddress !== "string");
await fs.writeFile(path.join(home, "settings.json"), JSON.stringify({
  env: { CCAGENT_ENV_FILE: path.join(home, ".env") },
  defaultModel: "deepseek",
  models: {
    deepseek: { protocol: "openai-chat", model: "deepseek-chat", baseURL: "https://api.deepseek.com", apiKey: "${DEEPSEEK_API_KEY}" },
    "qwen-plus": { protocol: "openai-chat", model: "qwen-plus", baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1", apiKey: "${DASHSCOPE_API_KEY}" },
  },
  mcpServers: { "web-smoke": { type: "http", url: `http://127.0.0.1:${mcpAddress.port}/mcp` } },
}));

const port = await new Promise<number>((resolve, reject) => {
  const reservation = net.createServer();
  reservation.once("error", reject);
  reservation.listen(0, "127.0.0.1", () => {
    const address = reservation.address();
    if (!address || typeof address === "string") return reject(new Error("No test port"));
    reservation.close(() => resolve(address.port));
  });
});

const env: NodeJS.ProcessEnv = { ...process.env, CCAGENT_HOME: home, DEEPSEEK_API_KEY: "web-test-key", DASHSCOPE_API_KEY: "web-test-key" };
delete env.CCAGENT_ENV_FILE;
const child = spawn(process.execPath, [entry, "web", "--workspace", workspace, "--port", String(port)], {
  cwd: temp, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
});
let logs = "";
child.stdout.on("data", (chunk: Buffer) => { logs = (logs + chunk.toString()).slice(-5000); });
child.stderr.on("data", (chunk: Buffer) => { logs = (logs + chunk.toString()).slice(-5000); });
const base = `http://127.0.0.1:${port}`;
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`Web process exited early: ${logs}`);
    try {
      const response = await fetch(`${base}/api/health`);
      if (response.ok) { ready = true; break; }
    } catch { /* Still starting. */ }
    await delay(100);
  }
  assert(ready, `Web process did not become ready: ${logs}`);

  const page = await fetch(base);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /<script src="\/app\.js" type="module"><\/script>/);
  assert.match(html, /id="mcp-view"/);
  assert.match(html, /href="\/favicon\.svg"/);
  assert.match(html, /id="home-model"/);
  assert.match(html, /id="thread-voice"/);
  assert.match(html, /browser-panel\.css/);
  assert.match(html, /id="agents-view"/);
  assert.match(html, /id="skill-import"/);
  assert.match(html, /value="full">完全访问权益/);
  assert.match(html, /id="temporary-chat"/);
  assert.match(html, /id="library-view"/);
  assert.match(html, /id="memory-view"/);
  assert.match(html, /id="schedules-view"/);
  assert.equal((await fetch(`${base}/app.js`)).status, 200);
  assert.equal((await fetch(`${base}/styles.css`)).status, 200);
  assert.equal((await fetch(`${base}/codex-layout.css`)).status, 200);
  assert.equal((await fetch(`${base}/plugins.css`)).status, 200);
  assert.equal((await fetch(`${base}/chatgpt-web.css`)).status, 200);
  assert.equal((await fetch(`${base}/plugins.js`)).status, 200);
  assert.equal((await fetch(`${base}/voice.js`)).status, 200);
  assert.equal((await fetch(`${base}/voice.css`)).status, 200);
  assert.equal((await fetch(`${base}/browser-panel.js`)).status, 200);
  assert.equal((await fetch(`${base}/browser-panel.css`)).status, 200);
  assert.equal((await fetch(`${base}/library.js`)).status, 200);
  assert.equal((await fetch(`${base}/memory.js`)).status, 200);
  assert.equal((await fetch(`${base}/schedules.js`)).status, 200);
  assert.equal((await fetch(`${base}/workspace-features.css`)).status, 200);
  assert.equal((await fetch(`${base}/workspace-picker.js`)).status, 200);
  assert.equal((await fetch(`${base}/workspace-picker.css`)).status, 200);
  assert.equal((await fetch(`${base}/favicon.svg`)).status, 200);

  const bootstrap = await (await fetch(`${base}/api/bootstrap`)).json() as { workspace: string };
  assert.equal(bootstrap.workspace, workspace);
  const models = await (await fetch(`${base}/api/models`)).json() as { defaultModel: string; models: { id: string; available: boolean }[] };
  assert.equal(models.defaultModel, "deepseek");
  assert(models.models.some((item) => item.id === "deepseek" && item.available));
  assert(models.models.some((item) => item.id === "qwen-plus" && item.available));
  const changes = await (await fetch(`${base}/api/changes`)).json() as { files: { path: string; status: string }[] };
  assert(changes.files.some((file) => file.path === "staged file.txt" && file.status.startsWith("A")));
  assert(changes.files.some((file) => file.path === "draft file.txt" && file.status === "??"));
  const stagedDiff = await (await fetch(`${base}/api/diff?file=staged%20file.txt`)).json() as { diff: string };
  assert.match(stagedDiff.diff, /staged content/);
  const untrackedDiff = await (await fetch(`${base}/api/diff?file=draft%20file.txt`)).json() as { diff: string };
  assert.match(untrackedDiff.diff, /untracked content/);
  await fs.mkdir(path.join(workspace, "deliverables"));
  await fs.writeFile(path.join(workspace, "deliverables", "meeting.md"), "# Meeting\nUnique library phrase\n");
  await fs.writeFile(path.join(workspace, "deliverables", "secret-token.md"), "hidden text\n");
  const documents = await (await fetch(`${base}/api/library?query=Unique%20library%20phrase`)).json() as { files: { path: string; previewable: boolean }[] };
  assert(documents.files.some((file) => file.path === "deliverables/meeting.md" && file.previewable));
  assert(!((await (await fetch(`${base}/api/library`)).json()) as typeof documents).files.some((file) => file.path.includes("secret-token")));
  const documentPreview = await (await fetch(`${base}/api/library/file?path=deliverables%2Fmeeting.md`)).json() as { content: string };
  assert.match(documentPreview.content, /Unique library phrase/);
  assert.equal((await fetch(`${base}/api/library/download?path=deliverables%2Fmeeting.md`)).headers.get("content-disposition")?.startsWith("attachment;"), true);
  assert.equal((await fetch(`${base}/api/library/file?path=..%2Foutside.md`)).status, 400);

  const missingHeader = await fetch(`${base}/api/sessions`, {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}",
  });
  assert.equal(missingHeader.status, 403);
  const foreignOrigin = await fetch(`${base}/api/sessions`, {
    method: "POST", headers: { "content-type": "application/json", "x-ccagent-web": "1", origin: "http://evil.example" }, body: "{}",
  });
  assert.equal(foreignOrigin.status, 403);

  const headers = { "content-type": "application/json", "x-ccagent-web": "1" };
  const agentsBefore = await (await fetch(`${base}/api/agents`)).json() as { agents: { name: string; enabled: boolean; source: string }[] };
  assert(agentsBefore.agents.some((agent) => agent.source === "built-in"), "Web lists built-in agents");
  const agentName = agentsBefore.agents[0]!.name;
  assert.equal((await fetch(`${base}/api/agents/state`, { method: "POST", headers, body: JSON.stringify({ name: agentName, state: "close" }) })).status, 200);
  assert.equal(((await (await fetch(`${base}/api/agents`)).json()) as typeof agentsBefore).agents.find((agent) => agent.name === agentName)?.enabled, false);
  assert.equal((await fetch(`${base}/api/agents/state`, { method: "POST", headers, body: JSON.stringify({ name: agentName, state: "open" }) })).status, 200);
  const skillContent = "---\nname: local-web-test\ndescription: Imported through the Web UI.\n---\nSay hello.\n";
  const invalidSkill = await fetch(`${base}/api/skills/import`, { method: "POST", headers, body: JSON.stringify({ name: "../bad", scope: "project", content: skillContent }) });
  assert.equal(invalidSkill.status, 400);
  const importedSkill = await fetch(`${base}/api/skills/import`, { method: "POST", headers, body: JSON.stringify({ name: "local-web-test", scope: "project", content: skillContent }) });
  assert.equal(importedSkill.status, 201);
  assert.equal(await fs.readFile(path.join(workspace, ".ccagent", "skills", "local-web-test", "SKILL.md"), "utf8"), skillContent);
  assert(((await (await fetch(`${base}/api/skills`)).json()) as { skills: { name: string; source: string }[] }).skills.some((skill) => skill.name === "local-web-test" && skill.source === "project"));
  assert.equal((await fetch(`${base}/api/skills/import`, { method: "POST", headers, body: JSON.stringify({ name: "local-web-test", scope: "project", content: skillContent }) })).status, 400, "Import does not overwrite existing skills");
  assert.equal((await fetch(`${base}/api/skills/import`, { method: "POST", headers, body: JSON.stringify({ name: "dotted.skill", scope: "user", content: "---\nname: dotted.skill\ndescription: Dot name.\n---\nUse dots.\n" }) })).status, 201);
  assert(((await (await fetch(`${base}/api/skills`)).json()) as { skills: { name: string }[] }).skills.some((skill) => skill.name === "dotted.skill"));
  const fullResponse = await fetch(`${base}/api/sessions`, { method: "POST", headers, body: JSON.stringify({ mode: "full" }) });
  assert.equal(fullResponse.status, 201);
  const fullSession = await fullResponse.json() as { sessionId: string };
  assert.equal(((await (await fetch(`${base}/api/sessions/${fullSession.sessionId}`)).json()) as { mode: string }).mode, "full");
  const temporaryResponse = await fetch(`${base}/api/sessions`, { method: "POST", headers, body: JSON.stringify({ temporary: true }) });
  assert.equal(temporaryResponse.status, 201);
  const temporary = await temporaryResponse.json() as { sessionId: string; temporary: boolean };
  assert.equal(temporary.temporary, true);
  assert.equal(((await (await fetch(`${base}/api/sessions/${temporary.sessionId}`)).json()) as { temporary: boolean }).temporary, true);
  assert(!((await (await fetch(`${base}/api/bootstrap`)).json()) as { sessions: { sessionId: string }[] }).sessions.some((item) => item.sessionId === temporary.sessionId));
  const temporaryHelp = await fetch(`${base}/api/sessions/${temporary.sessionId}/messages`, { method: "POST", headers, body: JSON.stringify({ text: "/help" }) });
  assert.equal(temporaryHelp.status, 202);
  for (let attempt = 0; attempt < 100; attempt++) {
    const current = await (await fetch(`${base}/api/sessions/${temporary.sessionId}`)).json() as { busy: boolean; lastEventId: number };
    if (!current.busy && current.lastEventId >= 3) break;
    await delay(50);
  }
  const projectDirForTemporary = path.dirname((await fs.readdir(path.join(home, "projects"))).map((name) => path.join(home, "projects", name, "latest"))[0]!);
  assert.equal(await fs.stat(path.join(projectDirForTemporary, `${temporary.sessionId}.jsonl`)).then(() => true, () => false), false, "Temporary chat has no transcript");
  const invalidModel = await fetch(`${base}/api/sessions`, { method: "POST", headers, body: JSON.stringify({ model: "unknown" }) });
  assert.equal(invalidModel.status, 400);
  const createdResponse = await fetch(`${base}/api/sessions`, { method: "POST", headers, body: JSON.stringify({ mode: "plan", model: "qwen-plus" }) });
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json() as { sessionId: string };
  assert.match(created.sessionId, /^[0-9a-f-]{36}$/);
  const commandResponse = await fetch(`${base}/api/sessions/${created.sessionId}/messages`, {
    method: "POST", headers, body: JSON.stringify({ text: "/help" }),
  });
  assert.equal(commandResponse.status, 202);
  let session: { busy: boolean; mode: string; lastEventId: number; recentNotices: { message: string }[] } | undefined;
  for (let attempt = 0; attempt < 100; attempt++) {
    session = await (await fetch(`${base}/api/sessions/${created.sessionId}`)).json() as typeof session;
    if (!session?.busy && (session?.lastEventId ?? 0) >= 4) break;
    await delay(50);
  }
  assert.equal(session?.busy, false);
  assert.equal(session?.mode, "plan");
  assert.equal((await fetch(`${base}/api/sessions/${created.sessionId}/mode`, { method: "POST", headers, body: JSON.stringify({ mode: "full" }) })).status, 200);
  assert.equal(((await (await fetch(`${base}/api/sessions/${created.sessionId}`)).json()) as { mode: string }).mode, "full");
  assert.equal((await fetch(`${base}/api/sessions/${created.sessionId}/mode`, { method: "POST", headers, body: JSON.stringify({ mode: "plan" }) })).status, 200);
  assert((session?.lastEventId ?? 0) >= 4);
  const unsafeBrowser = await fetch(`${base}/api/sessions/${created.sessionId}/browser`, { method: "POST", headers, body: JSON.stringify({ url: "javascript:alert(1)" }) });
  assert.equal(unsafeBrowser.status, 400);
  const browserOpened = await fetch(`${base}/api/sessions/${created.sessionId}/browser`, { method: "POST", headers, body: JSON.stringify({ url: "https://example.com/docs" }) });
  assert.equal(browserOpened.status, 200);
  const withBrowser = await (await fetch(`${base}/api/sessions/${created.sessionId}`)).json() as { browserUrl: string };
  assert.equal(withBrowser.browserUrl, "https://example.com/docs");
  assert.equal((await fetch(`${base}/api/sessions/${created.sessionId}`)).status, 200);
  assert.equal((await fetch(`${base}/api/sessions/${created.sessionId}`).then((response) => response.json()) as { model: string }).model, "qwen-plus");
  const switched = await fetch(`${base}/api/sessions/${created.sessionId}/model`, { method: "POST", headers, body: JSON.stringify({ model: "deepseek" }) });
  assert.equal(switched.status, 200);
  assert.equal((await fetch(`${base}/api/sessions/${created.sessionId}`).then((response) => response.json()) as { model: string }).model, "deepseek");
  const listed = await (await fetch(`${base}/api/bootstrap`)).json() as { sessions: { sessionId: string; model: string }[] };
  assert(listed.sessions.some((item) => item.sessionId === created.sessionId && item.model === "deepseek"), "Model choice is persisted in the session list");
  const memoryBefore = await (await fetch(`${base}/api/memory`)).json() as { sessions: { sessionId: string; pinned: boolean }[] };
  assert(memoryBefore.sessions.some((item) => item.sessionId === created.sessionId));
  assert(!memoryBefore.sessions.some((item) => item.sessionId === temporary.sessionId), "Temporary chat is absent from memory manager");
  assert.equal((await fetch(`${base}/api/memory/sessions/${created.sessionId}`)).status, 200);
  assert.equal((await fetch(`${base}/api/memory/sessions/${created.sessionId}`, { method: "POST", headers, body: JSON.stringify({ action: "pin" }) })).status, 200);
  const memoryPinned = await (await fetch(`${base}/api/memory`)).json() as typeof memoryBefore;
  assert.equal(memoryPinned.sessions.find((item) => item.sessionId === created.sessionId)?.pinned, true);
  assert.equal((await fetch(`${base}/api/memory/sessions/${fullSession.sessionId}`, { method: "POST", headers, body: JSON.stringify({ action: "delete" }) })).status, 200);
  assert.equal((await fetch(`${base}/api/memory/sessions/${fullSession.sessionId}`)).status, 400);

  const projectDirs = await fs.readdir(path.join(home, "projects"));
  assert.equal(projectDirs.length, 1);
  const latest = path.join(home, "projects", projectDirs[0]!, "latest");
  await fs.rename(latest, `${latest}.saved`);
  await fs.mkdir(latest);
  const fallbackResponse = await fetch(`${base}/api/sessions`, { method: "POST", headers, body: "{}" });
  assert.equal(fallbackResponse.status, 201, "A blocked latest pointer should not prevent a new conversation");
  const fallback = await fallbackResponse.json() as { sessionId: string };
  const fallbackSession = await (await fetch(`${base}/api/sessions/${fallback.sessionId}`)).json() as { recentNotices: { message: string }[] };
  assert(fallbackSession.recentNotices.some((notice) => notice.message.includes("会话记录暂时无法写入")));
  await fs.rmdir(latest);
  await fs.rename(`${latest}.saved`, latest);
  assert.equal((await fetch(`${base}/api/bootstrap`)).status, 200);
  const projectDir = path.dirname(latest);
  const projectRelative = path.relative(temp, projectDir);
  assert(projectRelative && !projectRelative.startsWith("..") && !path.isAbsolute(projectRelative), "Unsafe test project move");
  await fs.rename(projectDir, `${projectDir}.saved`);
  await fs.writeFile(projectDir, "blocked directory");
  const degradedResponse = await fetch(`${base}/api/bootstrap`);
  assert.equal(degradedResponse.status, 200);
  const degraded = await degradedResponse.json() as { storageUnavailable: boolean };
  assert.equal(degraded.storageUnavailable, true, "An inaccessible session directory should not break the task list");
  const memoryOnlyResponse = await fetch(`${base}/api/sessions`, { method: "POST", headers, body: "{}" });
  assert.equal(memoryOnlyResponse.status, 201);
  await fs.unlink(projectDir);
  await fs.rename(`${projectDir}.saved`, projectDir);

  const events = await fetch(`${base}/api/sessions/${created.sessionId}/events?lastEventId=0`);
  const reader = events.body?.getReader();
  assert(reader);
  let stream = "";
  for (let attempt = 0; attempt < 10 && (!stream.includes("turn_complete") || !stream.includes("browser_open")); attempt++) {
    const chunk = await reader.read();
    if (chunk.done) break;
    stream += Buffer.from(chunk.value).toString("utf-8");
  }
  await reader.cancel();
  assert.match(stream, /"type":"notice"/);
  assert.match(stream, /"type":"browser_open"/);
  assert.match(stream, /"type":"turn_complete"/);
  assert.equal((await fetch(`${base}/api/sessions/${created.sessionId}/browser`, { method: "DELETE" })).status, 200);
  assert.equal(((await (await fetch(`${base}/api/sessions/${created.sessionId}`)).json()) as { browserUrl: null }).browserUrl, null);

  const market = path.join(temp, "market");
  const demo = path.join(market, "plugins", "demo");
  await fs.mkdir(path.join(market, ".ccagent-plugin"), { recursive: true });
  await fs.mkdir(path.join(demo, ".ccagent-plugin"), { recursive: true });
  await fs.mkdir(path.join(demo, "skills", "greet"), { recursive: true });
  await fs.writeFile(path.join(market, ".ccagent-plugin", "marketplace.json"), JSON.stringify({
    name: "webtest", plugins: [{ name: "demo", source: "./plugins/demo", description: "A test plugin" }],
  }));
  await fs.writeFile(path.join(demo, ".ccagent-plugin", "plugin.json"), JSON.stringify({ name: "demo", version: "1.0.0", description: "A test plugin" }));
  await fs.writeFile(path.join(demo, "skills", "greet", "SKILL.md"), "---\nname: greet\ndescription: Greet the user.\n---\nSay hello.\n");
  const post = (route: string, body: Record<string, unknown>) => fetch(`${base}${route}`, { method: "POST", headers, body: JSON.stringify(body) });
  type McpView = { servers: { name: string; state: string; tools: { name: string }[] }[]; pending: string[] };
  let mcp: McpView | undefined;
  for (let attempt = 0; attempt < 100; attempt++) {
    mcp = await (await fetch(`${base}/api/mcp`)).json() as McpView;
    if (mcp.servers.some((server) => server.name === "web-smoke" && server.state === "connected" && server.tools.some((tool) => tool.name.includes("echo")))) break;
    await delay(50);
  }
  assert(mcp?.servers.some((server) => server.name === "web-smoke" && server.state === "connected" && server.tools.some((tool) => tool.name.includes("echo"))), `MCP tool did not appear: ${logs}`);
  assert(!JSON.stringify(mcp).includes(String(mcpAddress.port)), "MCP API must not expose configured URLs");
  assert.equal((await post("/api/mcp/action", { op: "close", name: "web-smoke" })).status, 200);
  mcp = await (await fetch(`${base}/api/mcp`)).json() as McpView;
  assert(mcp.servers.some((server) => server.name === "web-smoke" && server.state === "disabled" && server.tools.length === 0));
  assert.equal((await post("/api/mcp/action", { op: "open", name: "web-smoke" })).status, 200);
  for (let attempt = 0; attempt < 100; attempt++) {
    mcp = await (await fetch(`${base}/api/mcp`)).json() as McpView;
    if (mcp.servers.some((server) => server.name === "web-smoke" && server.state === "connected")) break;
    await delay(50);
  }
  assert(mcp?.servers.some((server) => server.name === "web-smoke" && server.state === "connected"));
  assert.equal((await post("/api/mcp/action", { op: "auth", name: "web-smoke" })).status, 400);
  assert.equal((await post("/api/mcp/action", { op: "close", name: "missing" })).status, 404);
  const savedSettings = JSON.parse(await fs.readFile(path.join(home, "settings.json"), "utf-8")) as { mcpServerStates: Record<string, string> };
  assert.equal(savedSettings.mcpServerStates["web-smoke"], "open");
  savedSettings.mcpServerStates["web-smoke"] = "close";
  await fs.writeFile(path.join(home, "settings.json"), JSON.stringify(savedSettings));
  assert.equal((await post("/api/integrations/sync", {})).status, 200);
  mcp = await (await fetch(`${base}/api/mcp`)).json() as McpView;
  assert(mcp.servers.some((server) => server.name === "web-smoke" && server.state === "disabled"), "External CLI setting should sync into Web");
  await fs.writeFile(path.join(home, "settings.json"), "{invalid json");
  assert.equal((await post("/api/integrations/sync", {})).status, 400, "Invalid settings should not discard live MCP entries");
  mcp = await (await fetch(`${base}/api/mcp`)).json() as McpView;
  assert(mcp.servers.some((server) => server.name === "web-smoke"), "Registry must survive invalid external settings");
  await fs.writeFile(path.join(home, "settings.json"), JSON.stringify(savedSettings));
  delete (savedSettings as { mcpServers?: unknown }).mcpServers;
  await fs.writeFile(path.join(home, "settings.json"), JSON.stringify(savedSettings));
  assert.equal((await post("/api/integrations/sync", {})).status, 200);
  mcp = await (await fetch(`${base}/api/mcp`)).json() as McpView;
  assert(!mcp.servers.some((server) => server.name === "web-smoke"), "Removed MCP config should disappear after sync");
  assert.equal((await post("/api/plugins/action", { op: "marketplace-add", source: market })).status, 200);
  let plugins = await (await fetch(`${base}/api/plugins`)).json() as { available: { pluginId: string }[]; installed: { pluginId: string; enabled: boolean }[] };
  assert(plugins.available.some((item) => item.pluginId === "demo@webtest"));
  assert.equal((await post("/api/plugins/action", { op: "install", pluginId: "demo@webtest", scope: "local" })).status, 409);
  const previewResponse = await post("/api/plugins/preview", { pluginId: "demo@webtest" });
  assert.equal(previewResponse.status, 200);
  const preview = await previewResponse.json() as { token: string; preview: { components: { skills: string[] } } };
  assert(preview.preview.components.skills.includes("demo:greet"));
  assert.equal((await post("/api/plugins/action", { op: "install", pluginId: "demo@webtest", scope: "local", token: preview.token })).status, 200);
  plugins = await (await fetch(`${base}/api/plugins`)).json() as typeof plugins;
  assert(plugins.installed.some((item) => item.pluginId === "demo@webtest" && item.enabled));
  const skillNames = async () => ((await (await fetch(`${base}/api/skills`)).json()) as { skills: { name: string }[] }).skills.map((skill) => skill.name);
  assert((await skillNames()).includes("demo:greet"), "Installed plugin skill should appear in Web and CLI registry");
  const previousHome = process.env.CCAGENT_HOME;
  process.env.CCAGENT_HOME = home;
  try {
    await setPluginEnabled(workspace, "demo@webtest", false, "local");
    assert.equal((await post("/api/integrations/sync", {})).status, 200);
    assert(!(await skillNames()).includes("demo:greet"), "CLI-side plugin disable should sync into Web skills");
    await setPluginEnabled(workspace, "demo@webtest", true, "local");
    assert.equal((await post("/api/integrations/sync", {})).status, 200);
    assert((await skillNames()).includes("demo:greet"), "CLI-side plugin enable should sync into Web skills");
  } finally {
    if (previousHome === undefined) delete process.env.CCAGENT_HOME;
    else process.env.CCAGENT_HOME = previousHome;
  }
  assert.equal((await post("/api/plugins/action", { op: "disable", pluginId: "demo@webtest", scope: "local" })).status, 200);
  plugins = await (await fetch(`${base}/api/plugins`)).json() as typeof plugins;
  assert(plugins.installed.some((item) => item.pluginId === "demo@webtest" && !item.enabled));
  assert(!(await skillNames()).includes("demo:greet"), "Disabled plugin skill should disappear");
  assert.equal((await post("/api/plugins/action", { op: "enable", pluginId: "demo@webtest", scope: "local" })).status, 200);
  assert((await skillNames()).includes("demo:greet"), "Re-enabled plugin skill should return");
  assert.equal((await fetch(`${base}/api/skills`)).status, 200);
  assert.equal((await post("/api/plugins/action", { op: "uninstall", pluginId: "demo@webtest", scope: "local" })).status, 200);
  assert(!(await skillNames()).includes("demo:greet"), "Uninstalled plugin skill should disappear");
  plugins = await (await fetch(`${base}/api/plugins`)).json() as typeof plugins;
  assert(!plugins.installed.some((item) => item.pluginId === "demo@webtest"));
  assert.equal((await post("/api/plugins/action", { op: "marketplace-remove", name: "webtest" })).status, 200);

  const traversal = await fetch(`${base}/api/diff?file=../outside.txt`);
  assert.equal(traversal.status, 400);
  const runAt = new Date(Date.now() + 60_000).toISOString();
  assert.equal((await post("/api/schedules", { title: "unsafe", prompt: "/help", nextRunAt: runAt, repeat: "none", mode: "full" })).status, 400);
  const scheduledResponse = await post("/api/schedules", { title: "Web smoke schedule", prompt: "/help", nextRunAt: runAt, repeat: "none", mode: "default", model: "deepseek" });
  assert.equal(scheduledResponse.status, 201);
  const scheduled = (await scheduledResponse.json()) as { task: { id: string } };
  assert.equal((await post(`/api/schedules/${scheduled.task.id}`, { action: "pause" })).status, 200);
  let scheduleList = await (await fetch(`${base}/api/schedules`)).json() as { tasks: { id: string; status: string; lastSessionId?: string }[] };
  assert.equal(scheduleList.tasks.find((item) => item.id === scheduled.task.id)?.status, "paused");
  assert.equal((await post(`/api/schedules/${scheduled.task.id}`, { action: "run-now" })).status, 200);
  for (let attempt = 0; attempt < 100; attempt++) {
    scheduleList = await (await fetch(`${base}/api/schedules`)).json() as typeof scheduleList;
    if (scheduleList.tasks.find((item) => item.id === scheduled.task.id)?.status === "completed") break;
    await delay(50);
  }
  const scheduleResult = scheduleList.tasks.find((item) => item.id === scheduled.task.id);
  assert.equal(scheduleResult?.status, "completed");
  assert(scheduleResult.lastSessionId, "Due schedule creates a saved conversation");
  assert.equal((await fetch(`${base}/api/sessions/${scheduleResult.lastSessionId}`)).status, 200);
  assert.equal((await post(`/api/schedules/${scheduled.task.id}`, { action: "delete" })).status, 200);
  const dueAt = new Date(Date.now() + 1000).toISOString();
  const dueResponse = await post("/api/schedules", { title: "Due Web schedule", prompt: "/help", nextRunAt: dueAt, repeat: "none", mode: "default", model: "deepseek" });
  assert.equal(dueResponse.status, 201);
  const dueTask = (await dueResponse.json()) as { task: { id: string } };
  let dueResult: { lastSessionId?: string; status: string } | undefined;
  for (let attempt = 0; attempt < 150; attempt++) {
    scheduleList = await (await fetch(`${base}/api/schedules`)).json() as typeof scheduleList;
    dueResult = scheduleList.tasks.find((item) => item.id === dueTask.task.id);
    if (dueResult?.status === "completed") break;
    await delay(100);
  }
  assert(dueResult?.lastSessionId && dueResult.status === "completed", "Due task runs automatically while Web service is active");
  assert.equal((await post(`/api/schedules/${dueTask.task.id}`, { action: "delete" })).status, 200);
  const otherWorkspace = path.join(temp, "other-project");
  await fs.mkdir(otherWorkspace);
  await fs.mkdir(path.join(otherWorkspace, "项目 文件夹"));
  await fs.mkdir(path.join(otherWorkspace, ".hidden-folder"));
  await fs.writeFile(path.join(otherWorkspace, "ordinary-file.txt"), "not a folder");
  const browse = await (await fetch(`${base}/api/workspaces/browse?path=${encodeURIComponent(otherWorkspace)}`)).json() as { path: string; parent: string | null; breadcrumbs: { path: string }[]; folders: { name: string; path: string }[] };
  assert.equal(browse.path, await fs.realpath(otherWorkspace));
  assert.equal(browse.parent, path.dirname(otherWorkspace));
  assert(browse.folders.some((f) => f.name === "项目 文件夹"), "Folder browser preserves Unicode and spaces");
  assert(!browse.folders.some((f) => f.name === "ordinary-file.txt" || f.name.startsWith(".")), "Browser lists directories and hides dot folders by default");
  assert.equal(browse.breadcrumbs.at(-1)?.path, browse.path);
  const hidden = await (await fetch(`${base}/api/workspaces/browse?path=${encodeURIComponent(otherWorkspace)}&hidden=1&query=hidden`)).json() as typeof browse;
  assert.deepEqual(hidden.folders.map((f) => f.name), [".hidden-folder"]);
  assert.equal((await fetch(`${base}/api/workspaces/browse?path=relative-folder`)).status, 400);
  assert.equal((await fetch(`${base}/api/workspaces/browse?path=${encodeURIComponent(path.join(otherWorkspace, "ordinary-file.txt"))}`)).status, 400);
  assert.equal((await post("/api/workspaces/pick", { initialPath: "relative-folder" })).status, 400, "Invalid picker request cannot open a system dialog");
  assert.equal((await post("/api/workspaces/select", { path: "relative-folder" })).status, 400);
  assert.equal((await post("/api/workspaces/select", { path: otherWorkspace })).status, 200);
  assert.equal(((await (await fetch(`${base}/api/bootstrap`)).json()) as { workspace: string }).workspace, otherWorkspace);
  assert(!(await skillNames()).includes("local-web-test"), "Project skills do not leak into another folder");
  const workspaces = await (await fetch(`${base}/api/workspaces`)).json() as { current: string; recent: string[]; locations: { name: string; path: string }[]; nativePickerAvailable: boolean };
  assert.equal(workspaces.current, otherWorkspace);
  assert(workspaces.recent.includes(workspace) && workspaces.recent.includes(otherWorkspace));
  assert(workspaces.locations.some((item) => path.isAbsolute(item.path)), "Quick locations expose real absolute directories");
  assert.equal(workspaces.nativePickerAvailable, process.platform === "win32");
  assert.equal((await post("/api/workspaces/select", { path: workspace })).status, 200);
  assert((await skillNames()).includes("local-web-test"), "Original workspace skills reload after switching back");
  assert.equal((await fetch(`${base}/api/sessions/${created.sessionId}`)).status, 200, "Original conversation restores after switching back");
  console.log("Web smoke: assets, sessions, side panel, workspace switching, agents, skills, permissions, temporary chat, library, memory, schedules, MCP, and plugins passed.");
} finally {
  child.kill();
  await Promise.race([new Promise<void>((resolve) => child.once("close", () => resolve())), delay(3000)]);
  mcpServer.closeAllConnections();
  await new Promise<void>((resolve) => mcpServer.close(() => resolve()));
  const relative = path.relative(await fs.realpath(os.tmpdir()), temp);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Unsafe test cleanup path");
  await fs.rm(temp, { recursive: true, force: true });
}
