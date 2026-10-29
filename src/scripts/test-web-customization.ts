import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";

const root = path.resolve(import.meta.dirname, "../..");
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "ccagent-customization-")));
const workspace = path.join(temp, "workspace"), home = path.join(temp, "home");
await fs.mkdir(workspace); await fs.mkdir(home);
await fs.writeFile(path.join(workspace, "image fixture.png"), Buffer.from("image-fixture-bytes"));
await fs.mkdir(path.join(workspace, ".ccagent", "commands"), { recursive: true });
await fs.writeFile(path.join(workspace, ".ccagent", "commands", "menu-review.md"), "---\ndescription: Menu command fixture\n---\nMENU_COMMAND_PROMPT $ARGUMENTS\n");
const secret = "test-only-local-secret", requests: Record<string, any>[] = [];
let menuAttachment = "";
const mock = createServer(async (req, res) => {
  let input = ""; for await (const chunk of req) input += chunk;
  const body = JSON.parse(input || "{}");
  if (req.url === "/retrieve") {
    assert.equal(req.headers.authorization, `Bearer ${secret}`);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ results: [{ text: "SOURCE_EVIDENCE " + body.query, source: "local-fixture", score: 0.95 }] })); return;
  }
  requests.push(body);
  const system = body.messages?.filter((m: any) => m.role === "system").map((m: any) => m.content).join("\n") || "";
  const history = JSON.stringify(body.messages || []);
  const notified = (body.messages || []).some((m: any) => m.role === "user" && typeof m.content === "string" && m.content.includes("<task-notification>"));
  const calls = (body.messages || []).flatMap((m: any) => m.tool_calls || []);
  const has = (name: string) => calls.some((c: any) => c.function.name === name);
  let output = "OK", tool: { name: string; args: object } | undefined;
  if (history.includes("VISION_TOOL_CHECK") && !body.tools?.length) output = "VISION_SHARED_EVIDENCE";
  else if (system.includes("You read local images and perform OCR")) {
    if (!has("ReadImage")) tool = { name: "ReadImage", args: { file_path: "image fixture.png", prompt: "VISION_TOOL_CHECK" } };
    else output = "IMAGE_AGENT_FINISHED VISION_SHARED_EVIDENCE";
  } else if (history.includes("RUN_IMAGE_AGENT_CASE")) {
    if (!has("Agent")) tool = { name: "Agent", args: { subagent_type: "image_reader", description: "Read image", prompt: "Extract text from image fixture.png" } };
    else output = "PARENT_IMAGE_FINISHED";
  } else if (history.includes("RUN_IMAGE_TOOL_CASE")) {
    if (!has("ReadImage")) tool = { name: "ReadImage", args: { file_path: "image fixture.png", prompt: "VISION_TOOL_CHECK" } };
    else output = "IMAGE_TOOL_FINISHED";
  } else if (history.includes("RUN_WEB_IMAGE_CASE")) output = "WEB_IMAGE_FINISHED";
  else if (history.includes("RUN_CLI_IMAGE_CASE")) output = "CLI_IMAGE_FINISHED";
  else if (system.includes("You edit CCAGENT configuration")) {
    output = system.includes('"roles"')
      ? JSON.stringify({ id: "qa-team", name: "QA Team", description: "Review evidence", roles: [{ name: "reviewer", agentType: "general-purpose", prompt: "WORKER_JOB" }] })
      : system.includes('"config"') ? JSON.stringify({ name: "draft-mcp", config: { command: "node", args: ["server.mjs"] } })
      : JSON.stringify({ name: "qa-agent", description: "QA specialist", prompt: "CUSTOM_PROMPT", tools: "Read,Glob,Grep" });
  } else if (history.includes("WORKER_JOB") && !system.includes("The user selected Agent Teams")) {
    await new Promise((r) => setTimeout(r, 250)); output = "WORKER_OK";
  } else if (system.includes("CUSTOM_PROMPT")) output = "CUSTOM_OK";
  else if (history.includes("RUN_AGENT_CASE")) {
    if (!has("Agent")) tool = { name: "Agent", args: { subagent_type: "qa-agent", description: "Test custom agent", prompt: "DO_CUSTOM" } };
    else output = "CUSTOM_FINISHED";
  } else if (history.includes("RUN_TEAM_CASE")) {
    if (!has("TeamCreate")) tool = { name: "TeamCreate", args: { team_name: "qa-runtime" } };
    else if (!has("Agent")) tool = { name: "Agent", args: { subagent_type: "general-purpose", team_name: "qa-runtime", name: "reviewer", description: "Review evidence", prompt: "WORKER_JOB", run_in_background: true } };
    else if (!notified) output = "Waiting for teammate";
    else if (!has("TeamDelete")) tool = { name: "TeamDelete", args: {} };
    else output = "TEAM_FINISHED WORKER_OK";
  } else if (history.includes("TRY_TEAM_WHEN_OFF")) {
    if (!has("TeamCreate")) tool = { name: "TeamCreate", args: { team_name: "must-not-exist" } };
    else output = "BLOCKED_DONE";
  } else if (history.includes("RUN_CLOSED_SKILL_CASE")) {
    if (!has("Skill")) tool = { name: "Skill", args: { skill: "package-skill" } };
    else output = "CLOSED_SKILL_DONE";
  } else if (history.includes("RUN_RAG_CASE")) {
    if (!has("KnowledgeSearch")) tool = { name: "KnowledgeSearch", args: { query: "fixture question" } };
    else output = "RAG_FINISHED SOURCE_EVIDENCE";
  } else if (history.includes("RUN_WORKSPACE_CASE")) {
    if (!has("Read")) tool = { name: "Read", args: { file_path: "workspace-marker.txt" } };
    else output = "WORKSPACE_VERIFIED";
  } else if (history.includes("RUN_ATTACHMENT_CASE")) {
    if (!has("Read")) tool = { name: "Read", args: { file_path: menuAttachment } };
    else output = "ATTACHMENT_VERIFIED";
  } else if (history.includes("RUN_TOOL_MENU_SKILL")) output = "MENU_SKILL_FINISHED";
  else if (history.includes("RUN_TOOL_MENU_COMMAND")) output = "MENU_COMMAND_FINISHED";
  res.writeHead(200, { "content-type": "text/event-stream" });
  const chunk = tool
    ? { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call-" + requests.length, type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.args) } }] }, finish_reason: null }] }
    : { choices: [{ index: 0, delta: { content: output }, finish_reason: null }] };
  res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }], usage: { prompt_tokens: 20, completion_tokens: 10 } })}\n\ndata: [DONE]\n\n`);
});
await new Promise<void>((r) => mock.listen(0, "127.0.0.1", r));
const mockPort = (mock.address() as { port: number }).port;
await fs.writeFile(path.join(home, "settings.json"), JSON.stringify({
  sentinel: "preserve", model: "fixture", defaultModel: "fixture", language: "English", alwaysThinkingEnabled: false,
  models: { fixture: { protocol: "openai-chat", model: "fixture", baseURL: `http://127.0.0.1:${mockPort}/v1`, apiKey: "${FIXTURE_KEY}" } },
  modelRoles: { image: "fixture" },
}));
const headers = { "content-type": "application/json", "x-ccagent-web": "1" };
const env: NodeJS.ProcessEnv = { ...process.env, CCAGENT_HOME: home, FIXTURE_KEY: secret, CCAGENT_DISABLE_STREAM_LOG: "1" };
delete env.CCAGENT_ENV_FILE;
for (const name of ["QWEN_MODEL", "QWEN_BASE_URL", "QWEN_API_KEY", "DASHSCOPE_BASE_URL", "DASHSCOPE_API_KEY"]) delete env[name];
let server: ChildProcess | undefined, base = "", logs = "";
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function start() {
  const reserve = createServer(); await new Promise<void>((r) => reserve.listen(0, "127.0.0.1", r));
  const port = (reserve.address() as { port: number }).port; await new Promise<void>((r) => reserve.close(() => r()));
  server = spawn(process.execPath, [path.join(root, "dist/ccagent.js"), "web", "--workspace", workspace, "--port", String(port)], { cwd: workspace, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  server.stdout!.on("data", (b) => { logs = (logs + b).slice(-6000); }); server.stderr!.on("data", (b) => { logs = (logs + b).slice(-6000); });
  base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) { try { if ((await fetch(base + "/api/health")).ok) return; } catch {} if (server.exitCode !== null) throw new Error(logs); await delay(100); }
  throw new Error("Web startup timeout: " + logs);
}
async function stop() { server?.kill(); await Promise.race([new Promise<void>((r) => server?.once("close", () => r())), delay(3000)]); }
async function get(route: string): Promise<any> { const r = await fetch(base + route); assert.equal(r.status, 200); return r.json(); }
async function post(route: string, body: object, expected = 200): Promise<any> {
  const r = await fetch(base + route, { method: "POST", headers, body: JSON.stringify(body) });
  const result = await r.json(); assert.equal(r.status, expected, `${route}: ${JSON.stringify(result)}`); return result;
}
async function turn(id: string, message: string, until?: string) {
  await post(`/api/sessions/${id}/messages`, { text: message }, 202);
  for (let i = 0; i < 200; i++) {
    await delay(75); const session = await get(`/api/sessions/${id}`);
    if (!session.busy && (!until || JSON.stringify(session.messages).includes(until))) return session;
    if (session.pending) await post(`/api/sessions/${id}/respond`, { id: session.pending.id, decision: "allow_once" });
  }
  throw new Error("Turn timeout: " + JSON.stringify(await get(`/api/sessions/${id}`)).slice(-4000));
}
try {
  await start();
  const imageSession = await post("/api/sessions", { mode: "full" }, 201);
  await turn(imageSession.sessionId, 'RUN_WEB_IMAGE_CASE @"image fixture.png"', "WEB_IMAGE_FINISHED");
  assert(requests.some((request) => JSON.stringify(request.messages).includes("RUN_WEB_IMAGE_CASE") && JSON.stringify(request.messages).includes("data:image/png;base64,")), "Web image references reach the model as pixels");
  const imageToolSession = await post("/api/sessions", { mode: "full" }, 201);
  const imageToolTurn = await turn(imageToolSession.sessionId, "RUN_IMAGE_TOOL_CASE", "IMAGE_TOOL_FINISHED");
  assert.match(JSON.stringify(imageToolTurn.messages), /VISION_SHARED_EVIDENCE/);
  const imageAgentSession = await post("/api/sessions", { mode: "full" }, 201);
  const imageAgentTurn = await turn(imageAgentSession.sessionId, "RUN_IMAGE_AGENT_CASE", "PARENT_IMAGE_FINISHED");
  assert.match(JSON.stringify(imageAgentTurn.messages), /IMAGE_AGENT_FINISHED/);
  const imageCli = spawn(process.execPath, [path.join(root, "dist/ccagent.js"), "--model", "fixture", "-p", 'RUN_CLI_IMAGE_CASE @"image fixture.png"'], { cwd: workspace, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let imageCliText = ""; imageCli.stdout!.on("data", (chunk) => { imageCliText += chunk; });
  await new Promise<void>((resolve, reject) => { imageCli.once("error", reject); imageCli.once("close", (code) => code === 0 ? resolve() : reject(new Error("Image CLI failed"))); });
  assert.match(imageCliText, /CLI_IMAGE_FINISHED/);
  assert(requests.some((request) => JSON.stringify(request.messages).includes("RUN_CLI_IMAGE_CASE") && JSON.stringify(request.messages).includes("data:image/png;base64,")), "CLI and Web use the same image attachment and model role pipeline");
  assert.equal((await fetch(base + "/customization.js")).status, 200);
  assert.equal((await fetch(base + "/customization.css")).status, 200);
  await post("/api/customize/agents", { name: "../bad", description: "bad", prompt: "bad" }, 400);
  const agent = await post("/api/customize/draft", { kind: "agent", request: "Create a QA agent" });
  assert.equal(agent.name, "qa-agent");
  await post("/api/customize/agents", { ...agent, scope: "project" });
  const agentPath = path.join(workspace, ".ccagent/agents/qa-agent.md");
  await fs.writeFile(agentPath, (await fs.readFile(agentPath, "utf8")).replace("---\n", "---\nmaxTurns: 5\ndisallowedTools: [Write]\n"));
  await post("/api/customize/agents", { ...agent, scope: "project", edit: true, description: "Edited QA" });
  assert.match(await fs.readFile(agentPath, "utf8"), /maxTurns: 5/);
  assert((await get("/api/agents")).agents.some((a: any) => a.name === "qa-agent" && a.prompt === "CUSTOM_PROMPT"));
  const one = await post("/api/sessions", { mode: "full", team: "off" }, 201);
  const agentSession = await turn(one.sessionId, "RUN_AGENT_CASE", "CUSTOM_FINISHED");
  assert.match(JSON.stringify(agentSession.messages), /CUSTOM_OK/);

  const skillDir = path.join(temp, "package-skill"); await fs.mkdir(path.join(skillDir, "scripts"), { recursive: true });
  await fs.writeFile(path.join(skillDir, "SKILL.md"), "---\nname: package-skill\ndescription: Complete package\n---\nPACKAGED_SKILL\n");
  await fs.writeFile(path.join(skillDir, "scripts/helper.py"), "print('fixture')\n");
  await post("/api/customize/local-skill", { path: skillDir, scope: "project" });
  assert.equal(await fs.readFile(path.join(workspace, ".ccagent/skills/package-skill/scripts/helper.py"), "utf8"), "print('fixture')\n");
  let menuCommands = (await get("/api/composer-tools")).commands;
  assert(menuCommands.some((item: any) => item.name === "package-skill"));
  assert(menuCommands.some((item: any) => item.name === "menu-review"));
  const menuSession = await post("/api/sessions", { mode: "full" }, 201);
  await turn(menuSession.sessionId, "/package-skill RUN_TOOL_MENU_SKILL", "MENU_SKILL_FINISHED");
  assert(requests.some((request) => JSON.stringify(request.messages).includes("PACKAGED_SKILL") && JSON.stringify(request.messages).includes("RUN_TOOL_MENU_SKILL")), "Menu skill runs the real prompt expansion");
  const commandSession = await post("/api/sessions", { mode: "full" }, 201);
  await turn(commandSession.sessionId, "/menu-review RUN_TOOL_MENU_COMMAND", "MENU_COMMAND_FINISHED");
  assert(requests.some((request) => JSON.stringify(request.messages).includes("MENU_COMMAND_PROMPT RUN_TOOL_MENU_COMMAND")), "Menu custom command reaches the real engine");
  const attachment = await post("/api/files/upload", { workspace, name: "菜单 附件.txt", base64: Buffer.from("ATTACHMENT_READ_EVIDENCE").toString("base64") }, 201);
  menuAttachment = attachment.path;
  const attachmentSession = await post("/api/sessions", { mode: "full" }, 201);
  const attachmentTurn = await turn(attachmentSession.sessionId, `RUN_ATTACHMENT_CASE\n[用户引用的工作区文件，请使用文件工具读取]\n- ${JSON.stringify(menuAttachment)}\n[/用户引用的工作区文件]`, "ATTACHMENT_VERIFIED");
  assert.match(JSON.stringify(attachmentTurn.messages), /ATTACHMENT_READ_EVIDENCE/, "Uploaded attachment is readable through the actual tool dispatcher");
  await post("/api/skills/state", { name: "package-skill", state: "close" });
  menuCommands = (await get("/api/composer-tools")).commands;
  assert(!menuCommands.some((item: any) => item.name === "package-skill"), "Closed skills disappear from the tool menu");
  assert((await get("/api/skills")).skills.some((s: any) => s.name === "package-skill" && !s.enabled));
  const countBefore = requests.length; await turn(one.sessionId, "/package-skill"); assert.equal(requests.length, countBefore, "Closed slash command never reaches the model");
  const closedSkill = await post("/api/sessions", { mode: "full" }, 201);
  const closedRun = await turn(closedSkill.sessionId, "RUN_CLOSED_SKILL_CASE", "CLOSED_SKILL_DONE");
  assert.match(JSON.stringify(closedRun.messages), /is closed/);

  const mcpFile = path.join(temp, "mcp.mjs");
  await fs.writeFile(mcpFile, `import readline from 'node:readline'; readline.createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);if(r.id===undefined)return; const result=r.method==='initialize'?{protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'stdio-fixture',version:'1'}}:r.method==='tools/list'?{tools:[{name:'echo',description:'Fixture echo',inputSchema:{type:'object'}}]}:{};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result})+'\\n');});`);
  const parsed = await post("/api/customize/draft", { kind: "mcp", request: JSON.stringify({ mcpServers: { "stdio-fixture": { command: process.execPath, args: [mcpFile] } } }) });
  await post("/api/customize/mcp", parsed);
  let connected = false;
  for (let i = 0; i < 80; i++) { const s = (await get("/api/mcp")).servers.find((s: any) => s.name === "stdio-fixture"); if (s?.state === "connected" && s.tools.length === 1) { connected = true; break; } await delay(100); }
  assert(connected, "Adding MCP starts the actual stdio program and discovers tools");

  await post("/api/customize/models", { id: "new-model", protocol: "openai-chat", model: "new-fixture", baseURL: `http://127.0.0.1:${mockPort}/v1`, apiKey: secret, makeDefault: true });
  const disk = await fs.readFile(path.join(home, "settings.json"), "utf8"); assert(!disk.includes(secret)); assert.equal(JSON.parse(disk).sentinel, "preserve");
  assert((await get("/api/models")).models.some((m: any) => m.id === "new-model" && m.available));
  const publicConfig = await get("/api/customize/models"); assert(!JSON.stringify(publicConfig).includes(secret));
  assert.equal((await post("/api/customize/model-test", { id: "new-model" })).reply, "OK");
  await post("/api/customize/settings", { language: "中文", mode: "plan", effortLevel: "medium", cleanupPeriodDays: 60, alwaysThinkingEnabled: false });
  assert.equal((await get("/api/customize/settings")).settings.language, "中文");
  const afterSettings = await post("/api/sessions", {}, 201); assert.equal((await get(`/api/sessions/${afterSettings.sessionId}`)).mode, "plan");

  const team = await post("/api/customize/draft", { kind: "team", request: "Organize a QA team" });
  await post("/api/customize/teams", team);
  const teamSession = await post("/api/sessions", { mode: "full", team: team.id }, 201);
  const teamRun = await turn(teamSession.sessionId, "RUN_TEAM_CASE", "TEAM_FINISHED");
  assert.match(JSON.stringify(teamRun.messages), /WORKER_OK/);
  assert.equal((await get("/api/customize/teams")).activeTeam, null, "Team automatically resumes on teammate completion and disbands: " + JSON.stringify(teamRun.messages).slice(-5000));
  const automatic = await post("/api/sessions", { mode: "full", team: "auto" }, 201);
  await turn(automatic.sessionId, "RUN_TEAM_CASE", "TEAM_FINISHED");
  assert(requests.some((r) => JSON.stringify(r.messages).includes("Choose and compose the team roles")), "Auto selection asks the actual lead model to compose task-specific roles");
  assert(requests.some((r) => JSON.stringify(r.messages).includes("QA Team") && JSON.stringify(r.messages).includes("WORKER_JOB")), "Preset role instructions reach the lead model");
  await post("/api/customize/teams", { op: "state", id: team.id, enabled: false });
  await post("/api/sessions", { team: team.id }, 400);
  await post("/api/customize/teams", { op: "state", id: team.id, enabled: true });
  await post(`/api/sessions/${teamSession.sessionId}/team`, { team: "off" });
  assert.equal((await get(`/api/sessions/${teamSession.sessionId}`)).team, "off");
  const blocked = await post("/api/sessions", { mode: "full", team: "off" }, 201);
  const blockedRun = await turn(blocked.sessionId, "TRY_TEAM_WHEN_OFF", "BLOCKED_DONE");
  assert.match(JSON.stringify(blockedRun.messages), /disabled/);
  assert.equal(await fs.stat(path.join(home, "teams/must-not-exist")).then(() => true, () => false), false);
  const offRequest = requests.find((r) => JSON.stringify(r.messages).includes("TRY_TEAM_WHEN_OFF"));
  assert(!offRequest?.tools.some((t: any) => t.function.name === "TeamCreate"), "Team tools hidden for an opted-out conversation");

  await post("/api/customize/rag", { id: "local-rag", name: "Local KB", url: `http://127.0.0.1:${mockPort}/retrieve`, apiKey: secret, topK: 3 });
  assert(!JSON.stringify(await get("/api/customize/rag")).includes(secret));
  assert.match((await post("/api/customize/rag", { op: "search", id: "local-rag", query: "question" })).documents[0].text, /SOURCE_EVIDENCE/);
  const ragSession = await post("/api/sessions", { mode: "full" }, 201);
  assert.match(JSON.stringify((await turn(ragSession.sessionId, "RUN_RAG_CASE", "RAG_FINISHED")).messages), /local-fixture/);
  await post("/api/customize/rag", { op: "state", id: "local-rag", enabled: false });
  await post("/api/customize/rag", { op: "search", id: "local-rag", query: "question" }, 400);

  await stop(); await start();
  assert((await get("/api/models")).models.find((m: any) => m.id === "new-model").available, "Env-backed model credential loads on restart");
  assert.equal((await post("/api/customize/model-test", { id: "new-model" })).reply, "OK");
  assert((await get("/api/skills")).skills.some((s: any) => s.name === "package-skill" && !s.enabled), "Skill close survives restart");
  assert.equal((await get(`/api/sessions/${teamSession.sessionId}`)).team, "off", "Conversation team choice survives restart");
  const cli = spawn(process.execPath, [path.join(root, "dist/ccagent.js"), "--model", "new-model", "-p", "Reply with OK"], { cwd: workspace, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let cliOutput = ""; cli.stdout!.on("data", (b) => { cliOutput += b; });
  await new Promise<void>((r, reject) => { cli.once("error", reject); cli.once("close", (code) => code === 0 ? r() : reject(new Error("CLI test failed"))); });
  assert.match(cliOutput, /OK/, "CLI calls a model saved through Web with the persisted secret reference");
  const selectedFolder = path.join(temp, "用户 选择的项目");
  await fs.mkdir(selectedFolder);
  await fs.writeFile(path.join(workspace, "workspace-marker.txt"), "PREVIOUS_WORKSPACE_MARKER");
  await fs.writeFile(path.join(selectedFolder, "workspace-marker.txt"), "SELECTED_WORKSPACE_MARKER");
  await post("/api/workspaces/select", { path: selectedFolder });
  assert.equal((await get("/api/files")).workspace, selectedFolder);
  assert(!(await get("/api/composer-tools")).commands.some((item: any) => item.name === "menu-review"), "Menu commands follow the selected workspace");
  const selectedSession = await post("/api/sessions", { mode: "full" }, 201);
  const selectedTurn = await turn(selectedSession.sessionId, "RUN_WORKSPACE_CASE", "WORKSPACE_VERIFIED");
  assert.match(JSON.stringify(selectedTurn.messages), /SELECTED_WORKSPACE_MARKER/, "Tools execute relative to the selected folder");
  assert(!JSON.stringify(selectedTurn.messages).includes("PREVIOUS_WORKSPACE_MARKER"));
  assert.equal((await get("/api/library")).workspace, selectedFolder);
  assert(!(await get("/api/agents")).agents.some((a: any) => a.name === "qa-agent"), "Previous project's Agent definitions do not leak");
  await post("/api/workspaces/select", { path: workspace });
  assert.equal((await get(`/api/sessions/${one.sessionId}`)).sessionId, one.sessionId, "Switching back restores the original conversation");
  console.log("Web customization: Agent generation/edit/execution, packaged skills/toggles, real stdio MCP, LLM connection/settings/CLI/restart, team roles/execution/opt-out, and RAG retrieval passed.");
} finally {
  await stop(); mock.closeAllConnections(); await new Promise<void>((r) => mock.close(() => r()));
  const relative = path.relative(await fs.realpath(os.tmpdir()), temp); if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Unsafe test cleanup");
  await fs.rm(temp, { recursive: true, force: true });
}
