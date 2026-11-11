/** Offline DOM integration. No browser or live service access. Pass happy-dom's index.js path. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
const root = path.resolve(import.meta.dirname, "..");
const { Window } = await import(process.argv[2] ? pathToFileURL(path.resolve(process.argv[2])).href : "happy-dom");
const window = new Window({ url: "http://offline-ui.test/", settings: { disableJavaScriptFileLoading: true, enableJavaScriptEvaluation: false, enableCSSFileLoading: false, enableImageFileLoading: false } });
Object.defineProperty(window, "innerWidth", { value: 1440, configurable: true });
window.document.write(await fs.readFile(path.join(root, "web/index.html"), "utf8"));
for (const name of ["window", "document", "location", "history", "localStorage", "HTMLElement", "HTMLSelectElement", "Event", "KeyboardEvent", "File", "FormData", "MutationObserver", "Node"]) globalThis[name] = name === "window" ? window : window[name];
Object.defineProperty(globalThis, "navigator", { value: window.navigator, configurable: true });
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
globalThis.setInterval = () => 0;
globalThis.EventSource = class { constructor(url) { this.url = url; this.closed = false; globalThis.lastEventSource = this; } close() { this.closed = true; } };
const calls = [], models = [
  { id: "fixture", label: "Fixture", model: "fixture", available: true },
  { id: "ccagent:qwen-vision", label: "Qwen vision tool", model: "qwen-vision", available: true, mainModelSelectable: false },
  { id: "ccagent:backup", label: "Official backup", model: "backup", available: true, mainModelSelectable: false },
];
const accountPopups = [];
let accountGesture = false;
window.open = (url, name) => { const popup = { url, name, inGesture: accountGesture, closed: false, sent: [], postMessage(value, targetOrigin) { this.sent.push({ value, targetOrigin }); } }; accountPopups.push(popup); return popup; };
const agent = { name: "qa", description: "QA Agent", source: "project", editable: true, enabled: true, prompt: "Check evidence" };
const skill = { name: "test-skill", description: "Skill", source: "project", enabled: true };
const teams = [{ id: "qa-team", name: "QA Team", description: "Evidence", enabled: true, roles: [{ name: "reviewer", agentType: "qa", prompt: "Check facts" }] }];
let teamEnabled = true;
const sessionId = "11111111-1111-4111-8111-111111111111";
const modelFile = { id: "44444444-4444-4444-8444-444444444444", name: "中国尊模型.3dm", path: "C:\\Users\\Test\\Desktop\\CCAGENT-Rhino\\中国尊\\models\\中国尊模型.3dm", persistent: true };
modelFile.openUrl = `/api/sessions/${sessionId}/model-files/${modelFile.id}/open`;
const removableSessionId = "33333333-3333-4333-8333-333333333333";
let recentSessions = [{ sessionId, firstPrompt: "保留的历史任务" }, { sessionId: removableSessionId, firstPrompt: "待删除任务" }];
let sessionMode = "default", failUpload = false, failSubmit = false, effortLevel = "", useCreationSnapshot = true;
let recoveredSessionSnapshot = null;
let failSessionSnapshotReads = 0;
let failSessionSnapshotStatus = 503;
let additionalDirectories = [], pickedDirectory = "E:\\选择的 输出目录";
const mailPowers = Object.fromEntries(["qq", "163"].map(account => [account, { read: false, write: false, delete: false, search: false, send: false }]));
let failMailPowerWrite = false;
const recognizers = [];
window.SpeechRecognition = class {
  constructor() { recognizers.push(this); }
  start() { this.started = true; }
  abort() { this.aborted = true; }
  stop() { this.onend?.(); }
};
const files = [
  { path: "资料", name: "资料", directory: true },
  { path: "code.ts", name: "code.ts", size: 20, format: "text", content: '<script>alert("literal")</script>' },
  { path: "image.png", name: "image.png", size: 20, format: "image" },
  { path: "report.pdf", name: "report.pdf", size: 20, format: "pdf" },
  { path: "song.mp3", name: "song.mp3", size: 20, format: "audio" },
  { path: "video.mp4", name: "video.mp4", size: 20, format: "video" },
  { path: "book.xlsx", name: "book.xlsx", size: 20, format: "office", sheets: [{ name: "工作表1", rows: [["<img src=x>", "42"]] }] },
  { path: "other.bin", name: "other.bin", size: 20, format: "binary" },
];
let officialConfigured = false, selectedOfficialRoles = {}, officialFallback = false, officialAuxiliaryEnabled = false, officialDefaultModel = '';
let adminPermissions = [], failAccess = false, pendingAccess = null;
const catalogRevision = '11111111-1111-4111-8111-111111111111';
const defaultOfficialRoute = { id: 'fixture-default', name: '默认服务测试', service: 'chat', protocol: 'openai-responses', pricing: { version: 1, currency: 'CNY', markup: '1.3', sourceUrl: 'https://example.invalid/pricing', definition: { rates: [{ metric: 'requests', price: '1', unitQuantity: '1' }], tariff: { kind: 'constant' } } }, limits: { fallbackEnabled: true, fallbackRouteId: 'fixture-backup' } };
const backupOfficialRoute = { ...defaultOfficialRoute, id: 'fixture-backup', name: '备用服务测试', limits: { fallbackEnabled: false, fallbackRouteId: null } };
let imageOfficialRoutes = [];
const auxiliaryOfficialRoutes = ['vision', 'decision', 'search', 'voice'].map(service => ({ ...defaultOfficialRoute, id: `fixture-${service}`, service, name: `后台自动${service}模型` }));
let officialAuxiliaryDefaults = { image: 'fixture-vision', decision: 'fixture-decision', search: 'fixture-search', voice: 'fixture-voice' };
globalThis.fetch = async (route, options = {}) => {
  const payload = options.body ? JSON.parse(options.body) : null;
  calls.push({ route, payload, headers: options.headers });
  let data;
  if (route === "/api/bootstrap") data = { sessions: recentSessions, workspace: "C:\\offline-project", version: "test", model: "fixture", defaultMode: "plan" };
  else if (route === `/api/memory/sessions/${removableSessionId}` && payload?.action === "delete") {
    assert.equal(payload.workspace, "C:\\offline-project");
    recentSessions = recentSessions.filter((item) => item.sessionId !== removableSessionId);
    data = { deleted: true };
  }
  else if (route === "/api/sessions") data = { sessionId, ...(useCreationSnapshot ? { snapshot: { sessionId, mode: sessionMode, model: "fixture", messages: [], team: "off", busy: false, lastEventId: 0 } } : {}) };
  else if (route === `/api/sessions/${sessionId}`) {
    if (failSessionSnapshotReads > 0) { failSessionSnapshotReads--; const error = new Error("Fixture snapshot unavailable"); error.status = failSessionSnapshotStatus; throw error; }
    data = recoveredSessionSnapshot || { sessionId, mode: sessionMode, model: "fixture", messages: [], team: "off", busy: false };
  }
  else if (route === `/api/sessions/${sessionId}/mode`) { sessionMode = payload.mode; data = {}; }
  else if (route === `/api/sessions/${sessionId}/messages`) { if (failSubmit) throw new Error("Fixture submit failure"); data = { accepted: true }; }
  else if (route === `/api/sessions/${sessionId}/interrupt`) data = { interrupted: true };
  else if (route === modelFile.openUrl) data = { opened: true };
  else if (route === "/api/composer-tools") data = { commands: [{ name: "test-skill", description: "Fixture skill", kind: "技能" }, { name: "help", description: "Help", kind: "命令" }] };
  else if (route === "/api/files/upload") { if (failUpload) throw new Error("Fixture upload failure"); data = { path: `.ccagent/attachments/id/${payload.name}`, name: payload.name, size: 4 }; }
  else if (route.startsWith("/api/files")) {
    const url = new URL(route, "http://offline-ui.test"), dir = url.searchParams.get("path");
    if (url.pathname === "/api/files/preview") data = files.find((file) => file.path === dir);
    else data = { path: dir, entries: dir ? [{ path: "资料/中文.md", name: "中文.md", size: 12, format: "text" }] : files, nextOffset: null, total: dir ? 1 : files.length };
  }
  else if (route === "/api/workspaces") data = { current: "C:\\offline-project", recent: [], locations: [], nativePickerAvailable: false };
  else if (route === "/api/workspaces/pick") data = { path: pickedDirectory };
  else if (route.startsWith("/api/visualization?")) data = { workspace: "C:\\offline-project", datasets: [] };
  else if (route.startsWith("/api/workspaces/browse")) data = { path: "C:\\offline-project", parent: null, breadcrumbs: [], folders: [], total: 0 };
  else if (route === "/api/changes") data = { files: [] };
  else if (route === "/api/models") data = { defaultModel: "ccagent:qwen-vision", models };
  else if (route === '/api/customize/official-services') {
    if (failAccess) throw new Error('Fixture permission lookup unavailable');
    if (pendingAccess) return pendingAccess;
    if (payload) {
      if (!officialConfigured) { officialConfigured = true; selectedOfficialRoles = { main: defaultOfficialRoute.id }; }
      else if (payload.roles !== undefined) selectedOfficialRoles = payload.roles;
      if (payload.automaticAuxiliary) selectedOfficialRoles = { ...(selectedOfficialRoles.main ? { main: selectedOfficialRoles.main } : {}), ...officialAuxiliaryDefaults };
      if (payload.auxiliaryEnabled !== undefined) officialAuxiliaryEnabled = payload.auxiliaryEnabled;
      if (payload.makeDefault && selectedOfficialRoles.main) officialDefaultModel = selectedOfficialRoles.main;
      if (payload.fallbackEnabled !== undefined) officialFallback = payload.fallbackEnabled;
    }
    data = { configured: officialConfigured, origin: 'https://ccagent.example.invalid', user: { id: 'offline-ui-user' }, permissions: [...adminPermissions], keyPrefix: 'ccagent_fixture', roles: selectedOfficialRoles, auxiliaryEnabled: officialAuxiliaryEnabled, fallbackEnabled: officialFallback, catalogRevision, routes: officialConfigured ? [defaultOfficialRoute, backupOfficialRoute, ...auxiliaryOfficialRoutes, ...imageOfficialRoutes] : [], wallet: { available: '1', balance: '100001', frozen: '100000' } };
  }
  else if (route === "/api/customize/settings") { if (payload?.effortLevel) effortLevel = payload.effortLevel; if (payload?.additionalDirectories) additionalDirectories = payload.additionalDirectories; data = { settings: { language: "中文", mode: "plan", cleanupPeriodDays: 60, effortLevel, additionalDirectories }, settingsPath: "offline-settings.json", defaultModel: "fixture" }; }
  else if (route === "/api/customize/power-settings") {
    if (payload && failMailPowerWrite) throw new Error("Fixture save failure");
    if (payload) mailPowers[payload.account][payload.power] = payload.enabled;
    data = { mailPowers };
  }
  else if (route === "/api/customize/models") { if (payload) models.push({ id: payload.id, label: payload.id, model: payload.model, available: true }); data = payload ? { id: payload.id } : { models: models.map((m) => ({ ...m, protocol: "openai-chat", baseURL: "https://example.test/v1" })) }; }
  else if (route === "/api/customize/model-test") data = { ok: true, reply: "OK" };
  else if (route === "/api/customize/teams") { if (payload?.op === "global") teamEnabled = payload.enabled; data = { teams, enabled: teamEnabled, activeTeam: null }; }
  else if (route === "/api/customize/rag") data = { connections: [] };
  else if (route === "/api/plugins") data = { installed: [], available: [], marketplaces: [] };
  else if (route === "/api/apps") data = { apps: [] };
  else if (route === "/api/account/status") data = { user: { id: "offline-ui-user" } };
  else if (route === '/api/account/access') {
    if (failAccess) throw new Error('Fixture permission lookup unavailable');
    if (pendingAccess) return pendingAccess;
    data = { origin: 'https://ccagent.example.invalid', user: { id: 'offline-ui-user' }, permissions: [...adminPermissions] };
  }
  else if (route === '/api/account/bridge') data = { ticket: 'T'.repeat(43), expiresAt: new Date(Date.now() + 30000).toISOString(), userId: 'offline-ui-user', origin: 'https://ccagent.example.invalid' };
  else if (route === "/api/agents") data = { agents: [agent] };
  else if (route === "/api/skills") data = { globallyEnabled: true, skills: [skill] };
  else if (route === "/api/skills/state") { skill.enabled = payload.state === "open"; data = {}; }
  else if (route === "/api/mcp") data = { servers: [], pending: [], configErrorCount: 0 };
  else if (route.startsWith("/api/library")) data = { files: [] };
  else if (route === "/api/customize/draft") data = payload.kind === "agent" ? { name: "generated", description: "Generated", prompt: "<img src=x onerror=alert(1)>Safe literal", tools: "Read" } : payload.kind === "team" ? teams[0] : { name: "my-mcp", config: { type: "http", url: "https://example.test/mcp" } };
  else if (route.startsWith("/api/customize/")) data = { ok: true };
  else throw new Error("Unexpected offline fixture route: " + route);
  return { ok: true, json: async () => data };
};
await import(pathToFileURL(path.join(root, "web/app.js")).href);
const $ = (id) => document.getElementById(id);
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0)); };
const click = async (selector) => { const n = typeof selector === "string" ? document.querySelector(selector) : selector; assert(n, "Missing UI element " + selector); n.click(); await settle(); };
const close = () => click("#editor-close");
function action(label) { return [...$("editor-actions").querySelectorAll("button")].find((b) => b.textContent === label); }
try {
  for (const id of ["home-model", "thread-model-select"]) {
    assert.deepEqual([...$(id).options].map(option => option.value), ["fixture"], "Only main models appear; auxiliary and backup profiles remain outside the chat picker");
    assert.equal($(id).value, "fixture", "A stale auxiliary default must not become the next chat's main model");
  }
  for (const prefix of ["home", "thread"]) {
    const form = $(`${prefix}-form`), options = form.querySelector(".composer-options"), actions = form.querySelector(".composer-actions");
    assert(options.contains($(prefix === "home" ? "insert-command" : "thread-insert-tool")));
    assert(options.contains($(prefix === "home" ? "home-mode" : "thread-mode-select")), "Permission control sits beside +");
    assert(actions.contains($(`${prefix}-dictate`))); assert(actions.contains($(`${prefix}-voice`))); assert(actions.contains($(`${prefix}-effort`)));
  }
  assert.equal($("thread-insert-tool").textContent, "＋"); assert.equal($("thread-insert-tool").getAttribute("aria-label"), "添加内容与工具");
  assert($("home-send").classList.contains("hidden")); assert(!$("home-voice").classList.contains("hidden"));
  const beforeDictationCalls = calls.length;
  await click("#home-dictate"); const speech = recognizers.at(-1); assert(speech.started);
  assert.equal($("home-dictate").getAttribute("aria-pressed"), "true");
  speech.onresult({ resultIndex: 0, results: [Object.assign([{ transcript: "语音测试内容" }], { isFinal: true })] });
  assert.equal($("home-input").value, "语音测试内容"); assert(!$("home-send").classList.contains("hidden")); assert($("home-voice").classList.contains("hidden"));
  assert.equal(calls.length, beforeDictationCalls, "Dictation never sends without user action");
  speech.onend(); assert.equal($("home-dictate").getAttribute("aria-pressed"), "false");
  $("home-input").value = ""; $("home-input").dispatchEvent(new window.Event("input"));
  assert($("home-send").classList.contains("hidden")); assert(!$("home-voice").classList.contains("hidden"));
  await click("#home-dictate"); recognizers.at(-1).onerror({ error: "not-allowed" }); assert.match($("toast").textContent, /麦克风/); assert.equal($("home-dictate").getAttribute("aria-pressed"), "false");
  $("home-mode").value = "full";
  $("home-effort").value = "max"; $("home-effort").dispatchEvent(new window.Event("change", { bubbles: true })); await settle();
  assert(calls.some((call) => call.route === "/api/customize/settings" && call.payload?.effortLevel === "max")); assert.equal($("thread-effort").value, "max");
  assert.equal($("home-mode").value, "full", "Changing effort preserves the user's selected permission mode"); $("home-mode").value = "plan";
  assert.equal($("search-tasks"), null); assert.equal($("rail-history"), null); assert.equal($("task-search-box"), null);
  assert.match($("recent-list").textContent, /保留的历史任务/, "Removing task search preserves history");
  assert.equal($("cloudtv-entry").querySelector("img").getAttribute("src"), "/cloudtv-logo.jpg");
  assert.equal($("city-renewal-entry").querySelector("img").getAttribute("src"), "/caiyunjian-logo.jpg");
  for (const selector of ["#home-file", "#workspace-files-toggle", '[data-view="library"]']) assert(document.querySelector(`${selector} .folder-icon`));
  const removeRecent = '[aria-label="删除记录：待删除任务"]';
  window.confirm = () => false;
  await click(removeRecent);
  assert(!calls.some((call) => call.route === `/api/memory/sessions/${removableSessionId}`));
  window.confirm = () => true;
  await click(removeRecent);
  assert.equal(document.querySelector(removeRecent), null);
  assert.equal($("task-count").textContent, "1");
  assert.match($("recent-list").textContent, /保留的历史任务/);
  assert(!$("workspace-files").classList.contains("hidden"), "Desktop home exposes the selected workspace on the right");
  const fileRow = (name) => [...$("files-list").querySelectorAll("button")].find((node) => node.dataset.path === name);
  await click(fileRow("资料")); assert.match($("files-list").textContent, /中文.md/); await click("#files-up");
  await click(fileRow("code.ts")); assert.match($("files-preview").textContent, /<script>/); assert.equal($("files-preview").querySelector("script"), null);
  for (const [name, selector] of [["image.png", "img"], ["report.pdf", "iframe"], ["song.mp3", "audio"], ["video.mp4", "video"], ["book.xlsx", "table"], ["other.bin", "a[download]"]]) {
    await click(fileRow(name)); assert($("files-preview").querySelector(selector), `${name} has a working renderer`);
    assert.equal($("files-preview").querySelector("script"), null);
  }
  await click(fileRow("code.ts")); await click($("files-preview").querySelector("button"));
  await click(fileRow("book.xlsx")); await click($("files-preview").querySelector("button"));
  await click(fileRow("image.png")); await click($("files-preview").querySelector("button"));
  assert.match($("home-input-attachments").textContent, /code.ts/);
  const tool = (label) => [...$("composer-tools").querySelectorAll("button")].find((node) => node.querySelector("strong")?.textContent === label);
  await click("#insert-command"); assert(!$("composer-tools").classList.contains("hidden")); assert.equal($("composer-tools").querySelectorAll("button").length, 7);
  document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  assert.equal(document.activeElement, $("composer-tools").querySelectorAll("button")[1]);
  document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })); assert($("composer-tools").classList.contains("hidden")); assert.equal(document.activeElement.id, "insert-command");
  await click("#insert-command"); await click(tool("选择工作文件夹")); assert(!$("workspace-overlay").classList.contains("hidden")); await click("#workspace-cancel");
  await click("#insert-command"); await click(tool("网络搜索")); assert.match($("home-input-attachments").textContent, /网络搜索/);
  await click("#insert-command"); await click(tool("技能和命令")); assert(!$("composer-tools").classList.contains("hidden")); await click(tool("/test-skill")); assert.match($("home-input").value, /^\/test-skill /);
  const beforeFirstSubmit = calls.length;
  $("home-form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })); await settle();
  assert.equal(calls.slice(beforeFirstSubmit).filter(call => call.route === `/api/sessions/${sessionId}`).length, 0, "First send reuses the authenticated creation snapshot instead of requesting the session again");
  const submitted = calls.find((call) => call.route === `/api/sessions/${sessionId}/messages`);
  assert.match(submitted.payload.text, /^\/test-skill\s/); assert.match(submitted.payload.text, /code.ts/); assert.match(submitted.payload.text, /WebSearch/); assert.match(submitted.payload.text, /Office 正文摘录/); assert.match(submitted.payload.text, /<img src=x>/);
  assert.match(submitted.payload.text, /@"image\.png"/, "Images use the shared CLI attachment grammar");
  assert($("home-input-attachments").classList.contains("hidden"), "Successful submission clears consumed references");
  const executionId = "22222222-2222-4222-8222-222222222222";
  const startedAt = new Date(Date.now() - 125000).toISOString();
  const emit = (event) => lastEventSource.onmessage({ data: JSON.stringify(event) });
  emit({ type: "turn_started", turnId: executionId, startedAt });
  assert.equal(document.querySelectorAll(".turn-active").length, 1, "A team continuation without a user event still shows its real elapsed time");
  emit({ type: "execution_state", execution: { id: executionId, startedAt, completedAt: null, reason: null, tools: [] }, serverTime: new Date().toISOString() });
  emit({ type: "user", text: "展示真实执行状态" });
  assert.equal(document.querySelector(".turn-activity").previousElementSibling?.textContent, "展示真实执行状态", "An early execution snapshot keeps the header below the arriving user bubble");
  assert.match(document.querySelector(".turn-elapsed").textContent, /已处理 2分/);
  emit({ type: "tool_start", id: "read-state", name: "Read", timestamp: startedAt });
  assert.match($("thread-status-label").textContent, /正在调用.*读取文件.*Read/);
  const runningExecution = { id: executionId, startedAt, completedAt: null, reason: null, tools: [{ id: "read-state", name: "Read", startedAt, completedAt: null }] };
  emit({ type: "execution_state", execution: runningExecution, serverTime: new Date(Date.now() + 60000).toISOString() });
  assert.equal(document.querySelectorAll(".turn-activity").length, 1, "Reconnect updates the existing turn header");
  assert.equal(document.querySelectorAll(".tool-card").length, 1, "Reconnect does not duplicate a tool call");
  assert.match(document.querySelector(".turn-elapsed").textContent, /已处理 3分/, "Elapsed uses the server clock");
  emit({ type: "tool_done", id: "read-state", name: "Read", isError: false, timestamp: new Date().toISOString() });
  assert.match($("thread-status-label").textContent, /正在整理结果/);
  emit({ type: "tool_preparing", id: "failed-image", name: "ReadImage" });
  assert.equal([...document.querySelectorAll(".tool-card")].find(row => row.textContent.includes("ReadImage")).querySelector(".tool-state").textContent, "准备调用");
  const completedAt = new Date(Date.parse(startedAt) + 125000).toISOString();
  emit({ type: "turn_complete", reason: "model_error", completedAt }); await settle();
  assert.match($("thread-status-label").textContent, /模型回复中断/); assert(![...document.querySelectorAll(".tool-state")].some((node) => ["执行中", "调用中", "准备调用"].includes(node.textContent)), "Failed turns leave no tool card looking active");
  const finishedExecution = { ...runningExecution, completedAt, reason: "model_error", tools: [{ ...runningExecution.tools[0], completedAt, isError: false }, { id: "failed-image", name: "ReadImage", startedAt, completedAt: null, phase: "preparing" }] };
  emit({ type: "execution_state", execution: finishedExecution, serverTime: new Date(Date.now() + 3600000).toISOString() });
  assert.equal(document.querySelector(".turn-elapsed").textContent, "已处理 2分 5秒", "Completed elapsed stays frozen across reconnect and server clock changes");
  assert.equal([...document.querySelectorAll(".tool-card")].find(row => row.textContent.includes("ReadImage")).querySelector(".tool-state").textContent, "未执行", "A draft tool interrupted during model generation was never executed");
  emit({ type: "turn_started", turnId: "handoff-state", startedAt });
  emit({ type: "tool_preparing", id: "sequence-state", name: "RhinoSequence" });
  emit({ type: "tool_start", id: "sequence-state", name: "RhinoSequence" });
  assert.equal(document.querySelectorAll(".tool-card").length, 3, "Dispatch readiness updates the draft card rather than duplicating it");
  emit({ type: "tool_done", id: "sequence-state", name: "RhinoSequence", isError: true, outcome: "handoff", detail: "审查后继续 <img src=x>" });
  const handoffCard = [...document.querySelectorAll(".tool-card")].find(row => row.textContent.includes("RhinoSequence"));
  assert.equal(handoffCard.querySelector(".tool-state").textContent, "已暂停");
  assert.equal(handoffCard.querySelector(".tool-detail pre").textContent, "审查后继续 <img src=x>");
  assert.equal(handoffCard.querySelector("img"), null, "Tool diagnostics are rendered as literal text");
  assert(!handoffCard.classList.contains("error"));
  const beforeModelFile = calls.length;
  emit({ type: "model_file", file: modelFile });
  emit({ type: "model_file", file: modelFile });
  assert.equal(document.querySelectorAll(".model-file-card").length, 1, "Event replay never duplicates an export card");
  assert.equal(document.querySelector(".model-file-path").textContent, modelFile.path);
  assert.equal(calls.length, beforeModelFile, "Receiving a file never automatically opens Rhino");
  await click(".model-file-open");
  assert.equal(calls.at(-1).route, modelFile.openUrl);
  emit({ type: "model_file", file: { ...modelFile, id: "55555555-5555-4555-8555-555555555555", openUrl: "javascript:alert(1)" } });
  assert.equal(document.querySelectorAll(".model-file-card").length, 1, "Only the current session's exact open route can be rendered");
  emit({ type: "turn_complete", reason: "completed" });
  console.log("Execution DOM: early-snapshot ordering, server-clock elapsed, current tools, reconnect deduplication, terminal tool state and frozen duration passed.");
  lastEventSource.onmessage({ data: JSON.stringify({ type: "model", model: "ccagent:fixture" }) });
  lastEventSource.onmessage({ data: JSON.stringify({ type: "turn_started" }) });
  emit({ type: "tool_start", id: "read-state", name: "Read" });
  assert.equal([...document.querySelectorAll(".tool-card")].filter(row => row.querySelector(".tool-name").textContent === "Read").length, 2, "A reused tool ID in a new turn creates a new row and preserves history");
  emit({ type: "tool_start", id: "browser-parity", name: "BrowserSearch" });
  assert.equal([...document.querySelectorAll(".tool-name")].find(node => node.textContent === "Jev Browser Search")?.textContent, "Jev Browser Search", "The canonical BrowserSearch event uses the CLI display name");
  emit({ type: "tool_done", id: "browser-parity", name: "BrowserSearch", isError: false });
  const beforeStop = calls.length;
  await click("#stop-button");
  assert.equal(calls.slice(beforeStop).filter(call => call.route.endsWith('/interrupt')).length, 1);
  assert.match($("timeline").textContent, /官方服务调用仍会按可核实用量结算/);
  assert.match($("timeline").textContent, /查询不会新增消费/);
  assert.equal($("stop-button").disabled, false);
  lastEventSource.onmessage({ data: JSON.stringify({ type: "turn_complete", reason: "aborted" }) });
  lastEventSource.onmessage({ data: JSON.stringify({ type: "model", model: "fixture" }) });
  emit({ type: "turn_started", turnId: "worker-recovery", startedAt: new Date().toISOString() });
  emit({ type: "user", text: "模拟执行中连接恢复" });
  emit({ type: "tool_start", id: "lost-tool", name: "Read" });
  emit({ type: "execution_state", execution: null, serverTime: new Date().toISOString() });
  assert.equal($("thread-input").disabled, false, "An empty recovery snapshot releases stale busy controls");
  assert.equal(document.querySelectorAll(".turn-active").length, 0);
  assert.equal([...document.querySelectorAll(".turn-outcome")].at(-1).textContent, "未完成", "Worker recovery does not invent a completed execution");
  assert.match($("thread-status-label").textContent, /上次执行未完成/);
  await click("#thread-insert-tool"); await click(tool("计划模式")); assert.equal(sessionMode, "plan");

  const streamingBody = () => document.querySelector(".streaming .assistant-body");
  emit({ type: "turn_started", turnId: "stream-batching", startedAt: new Date().toISOString() });
  emit({ type: "text", text: "首段 <img src=x>" });
  const streamText = streamingBody().firstChild;
  assert.equal(streamText.nodeType, Node.TEXT_NODE);
  assert.equal(streamText.data, "首段 <img src=x>", "The first chunk is visible immediately and remains literal text");
  assert.equal(streamingBody().querySelector("img"), null);
  const burst = Array.from({ length: 100 }, (_, i) => `|${i}`).join("");
  for (let i = 0; i < 100; i++) emit({ type: "text", text: `|${i}` });
  assert.equal(streamText.data, "首段 <img src=x>", "Rapid chunks wait for a single batch instead of repainting per token");
  await new Promise(resolve => setTimeout(resolve, 45));
  assert.equal(streamingBody().firstChild, streamText, "Streaming keeps one text node instead of replacing the whole reply");
  assert.equal(streamText.data, `首段 <img src=x>${burst}`);
  emit({ type: "text", text: "最后一批" });
  const fullReply = `首段 <img src=x>${burst}最后一批`;
  emit({ type: "assistant", message: { role: "assistant", content: fullReply } });
  assert.equal(streamingBody(), null);
  await new Promise(resolve => setTimeout(resolve, 45));
  assert.equal([...document.querySelectorAll(".assistant-body")].at(-1).textContent, fullReply, "Assistant commit consumes the final batch exactly once");
  emit({ type: "turn_complete", reason: "completed" });

  emit({ type: "turn_started", turnId: "stream-restart", startedAt: new Date().toISOString() });
  emit({ type: "text", text: "discarded draft" });
  emit({ type: "text", text: "discarded pending" });
  emit({ type: "stream_restart" });
  emit({ type: "text", text: "fresh draft" });
  await new Promise(resolve => setTimeout(resolve, 45));
  assert.equal(streamingBody().textContent, "fresh draft", "A retry cannot repaint chunks from the abandoned stream");
  const largeChunk = "x".repeat(4096);
  for (let i = 0; i < 20; i++) emit({ type: "text", text: largeChunk });
  const expectedLargeReply = "fresh draft" + largeChunk.repeat(20);
  assert(streamingBody().textContent.length > expectedLargeReply.length - 32768, "Pending chunks remain below the 32 KiB cap without waiting for a timer");
  emit({ type: "text", text: "末尾" });
  emit({ type: "turn_complete", reason: "aborted" });
  await new Promise(resolve => setTimeout(resolve, 45));
  assert.equal(streamingBody(), null);
  assert.equal([...document.querySelectorAll(".assistant-body")].at(-1).textContent, expectedLargeReply + "末尾", "Interrupted turns retain every received chunk, including unpainted text");

  emit({ type: "turn_started", turnId: "stream-old-turn", startedAt: new Date().toISOString() });
  emit({ type: "text", text: "old turn" });
  emit({ type: "text", text: " pending" });
  emit({ type: "turn_started", turnId: "stream-new-turn", startedAt: new Date().toISOString() });
  emit({ type: "text", text: "new turn" });
  await new Promise(resolve => setTimeout(resolve, 45));
  assert.equal(streamingBody().textContent, "new turn", "Turn boundaries cannot append old pending chunks into a newer turn");
  assert.equal([...document.querySelectorAll(".message.assistant:not(.streaming) .assistant-body")].at(-1)?.textContent, "old turn pending");
  emit({ type: "text", text: " pending before navigation" });
  await click("#new-task");
  await new Promise(resolve => setTimeout(resolve, 45));
  assert.equal(streamingBody(), null, "Leaving a session cancels its pending stream flush");
  const beforeHistoryOpen = calls.length;
  await click("#recent-list .recent-item");
  assert.equal(calls.slice(beforeHistoryOpen).filter(call => call.route === `/api/sessions/${sessionId}`).length, 1, "Opening history still reloads the authoritative session state");
  const staleSource = lastEventSource;
  recoveredSessionSnapshot = {
    sessionId, mode: sessionMode, model: "fixture", team: "off", busy: true, lastEventId: 901,
    modelFiles: [modelFile],
    messages: [
      { role: "user", content: [{ type: "text", text: "断线前带图的任务" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } }] },
      { role: "assistant", content: [{ type: "tool_use", id: "historical-failure", name: "RhinoAction", input: {} }, { type: "tool_use", id: "historical-success", name: "RhinoObserve", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "historical-failure", is_error: true, content: "原失败原因" }, { type: "tool_result", tool_use_id: "historical-success", content: "ok" }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "internal-result", content: "工具结果不能作为用户消息显示" }] },
      { role: "assistant", content: "断线期间完整回复" },
    ],
    pending: { id: "recovered-approval", kind: "permission", request: { toolName: "Write", summary: "恢复等待中的授权", input: { file_path: "fixture.txt" } } },
    execution: { id: executionId, startedAt, completedAt: null, reason: null, tools: [] },
  };
  const beforeGapRecovery = calls.length;
  failSessionSnapshotReads = 1;
  emit({ type: "session_snapshot_required" });
  staleSource.onmessage({ data: JSON.stringify({ type: "session_snapshot_required" }) });
  staleSource.onmessage({ data: JSON.stringify({ type: "assistant", message: { role: "assistant", content: "过期连接不能写入" } }) });
  await settle();
  assert.equal(staleSource.closed, false, "A transient snapshot failure leaves EventSource reconnect available");
  assert.match(location.search, /session=/, "A transient recovery failure preserves the selected conversation URL");
  await new Promise(resolve => setTimeout(resolve, 350)); await settle();
  assert(staleSource.closed);
  assert.notEqual(lastEventSource, staleSource);
  assert.match(lastEventSource.url, /lastEventId=901$/);
  assert.equal(calls.slice(beforeGapRecovery).filter(call => call.route === `/api/sessions/${sessionId}`).length, 2, "A replay gap retries a transient read failure without duplicate queued reloads");
  assert.equal(calls.slice(beforeGapRecovery).filter(call => call.route.endsWith("/messages")).length, 0, "Snapshot recovery never resubmits a task");
  assert.match($("timeline").textContent, /断线期间完整回复/);
  assert.equal(document.querySelectorAll(".model-file-card").length, 1, "File cards survive history reload and response interruption");
  assert.equal(document.querySelector(".model-file-path").textContent, modelFile.path);
  assert.equal([...document.querySelectorAll(".tool-card")].find(row => row.textContent.includes("RhinoAction")).querySelector(".tool-state").textContent, "失败", "History restores the recorded failure rather than inventing execution success");
  assert.equal([...document.querySelectorAll(".tool-card")].find(row => row.textContent.includes("RhinoObserve")).querySelector(".tool-state").textContent, "已完成");
  assert.match($("timeline").textContent, /断线前带图的任务/);
  assert(!$("timeline").textContent.includes("工具结果不能作为用户消息显示"));
  assert(!$("timeline").textContent.includes("过期连接不能写入"));
  assert(!$("interaction-overlay").classList.contains("hidden"));
  assert.match($("interaction-title").textContent, /Write/);
  staleSource.onmessage({ data: JSON.stringify({ type: "turn_complete", reason: "completed" }) });
  assert.equal($("stop-button").classList.contains("hidden"), false, "A stale source cannot complete the recovered active task");
  emit({ type: "interaction_resolved" });
  emit({ type: "turn_complete", reason: "completed" });
  await click('[data-customize-view="agents"]');
  const backgroundRecoveryUrl = location.href;
  recoveredSessionSnapshot = { ...recoveredSessionSnapshot, busy: false, pending: null, execution: null };
  emit({ type: "session_snapshot_required" }); await settle();
  assert(!$("agents-view").classList.contains("hidden"), "Automatic recovery preserves the user's current page");
  assert.equal(location.href, backgroundRecoveryUrl);
  const deletedSource = lastEventSource;
  failSessionSnapshotReads = 1; failSessionSnapshotStatus = 404;
  const beforeDeletedRecovery = calls.length;
  emit({ type: "session_snapshot_required" }); await settle();
  assert(deletedSource.closed, "A terminal missing-session response closes the old source");
  assert($("interaction-overlay").classList.contains("hidden"));
  assert(!$("agents-view").classList.contains("hidden"), "Deleting a background conversation preserves the current page");
  await new Promise(resolve => setTimeout(resolve, 350));
  assert.equal(calls.slice(beforeDeletedRecovery).filter(call => call.route === `/api/sessions/${sessionId}`).length, 1, "A deleted session is not retried as a transient failure");
  failSessionSnapshotStatus = 503;
  recoveredSessionSnapshot = null;
  console.log("Replay gap DOM: authoritative replies/approval, transient read retry, preserved page/cursor, no resubmission, stale same-session callbacks ignored.");
  await click("#new-task");
  console.log("Streaming DOM: immediate first text, batched text-node appends, bounded deferred buffer, exact final chunks, retry and navigation isolation passed.");
  await click("#insert-command"); await click(tool("添加照片和文件"));
  Object.defineProperty($("composer-upload"), "files", { value: [new window.File([new Uint8Array([0, 1, 255, 48])], "upload.bin")], configurable: true });
  $("composer-upload").dispatchEvent(new window.Event("change", { bubbles: true })); await settle();
  assert(calls.some((call) => call.route === "/api/files/upload" && call.payload.base64 === "AAH/MA==")); assert.match($("home-input-attachments").textContent, /upload.bin/);
  useCreationSnapshot = false;
  const beforeLegacySubmit = calls.length;
  failSubmit = true; $("home-input").value = "Read attachment";
  $("home-form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })); await settle(); assert.match($("thread-input-attachments").textContent, /upload.bin/, "Failed send keeps the reference in the visible composer"); assert.equal($("thread-input").value, "Read attachment");
  assert.equal(calls.slice(beforeLegacySubmit).filter(call => call.route === `/api/sessions/${sessionId}`).length, 1, "Older creation responses without snapshots still load the session normally");
  useCreationSnapshot = true;
  failSubmit = false;
  $("thread-form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })); await settle(); assert($("thread-input-attachments").classList.contains("hidden"), "Retry consumes the preserved reference");
  await click("#new-task");
  await click("#insert-command"); await click(tool("插件与 MCP")); assert(!$("plugins-view").classList.contains("hidden"));
  await click("#brand-home"); await click("#surface-chat"); await click("#insert-command"); assert(!$("composer-tools").classList.contains("hidden"));
  document.body.click(); await settle(); assert($("composer-tools").classList.contains("hidden"));
  await click("#surface-work"); await click("#insert-command"); await click(tool("计划模式"));
  assert.equal($("home-mode").value, "plan");
  assert([...$("home-team").options].some((o) => o.value === "auto"));
  await click('[data-customize-view="agents"]'); await click("#agent-create");
  $("editor-requirements").value = "Make an agent"; await click(".editor-generate");
  assert.equal($("edit-agent-name").value, "generated");
  assert.equal($("edit-agent-prompt").value, "<img src=x onerror=alert(1)>Safe literal");
  assert.equal($("editor-body").querySelector("img"), null, "Generated text is never rendered as HTML");
  await click(action("保存 Agent")); assert(calls.some((c) => c.route === "/api/customize/agents" && c.payload.name === "generated"));
  await click([...$("agents-list").querySelectorAll("button")].find((b) => b.textContent === "编辑"));
  assert.equal($("edit-agent-name").disabled, true); assert.equal($("edit-agent-prompt").value, agent.prompt); await close();

  await click('[data-customize-view="mcp"]'); await click("#mcp-add");
  $("editor-requirements").value = "https://example.test/mcp"; await click(".editor-generate");
  assert.equal($("edit-mcp-name").value, "my-mcp"); await click(action("添加并连接"));
  assert(calls.some((c) => c.route === "/api/customize/mcp" && c.payload.config.type === "http"));
  const powerNav = document.querySelector('[data-customize-view="power-settings"]');
  assert.equal(powerNav.previousElementSibling.dataset.customizeView, "mcp");
  assert(powerNav.querySelector("svg"));
  await click(powerNav);
  assert(powerNav.classList.contains("selected"));
  assert.equal(new URLSearchParams(location.search).get("view"), "power-settings");
  assert.equal(new URLSearchParams(location.search).get("workspace"), "C:\\offline-project");
  const switches = $("power-settings-list").querySelectorAll('[role="switch"]');
  assert.equal(switches.length, 10);
  const qqRead = switches[0], qqDelete = switches[2], mail163Read = switches[5];
  await click(qqRead);
  assert.deepEqual(calls.at(-1).payload, { account: "qq", power: "read", enabled: true });
  assert.equal(qqRead.getAttribute("aria-checked"), "true");
  assert.equal(mail163Read.getAttribute("aria-checked"), "false");
  failMailPowerWrite = true;
  await click(qqDelete);
  assert.equal(qqDelete.getAttribute("aria-checked"), "false");
  assert.match($("power-settings-status").textContent, /保存失败/);
  failMailPowerWrite = false;
  await click('[data-customize-view="mcp"]');
  await click(powerNav);
  assert.equal(qqRead.getAttribute("aria-checked"), "true");

  await click('[data-customize-view="skills"]');
  await click([...$("skills-list").querySelectorAll("button")].find((b) => b.textContent === "关闭"));
  assert.equal(skill.enabled, false); assert.match($("skills-list").textContent, /已关闭/);
  await click("#skill-local-path"); $("edit-skill-path").value = "C:\\offline-skill"; await click(action("导入完整技能"));
  assert(calls.some((c) => c.route === "/api/customize/local-skill" && c.payload.path === "C:\\offline-skill"));

  await click('[data-view="settings"]'); assert(!$("settings-view").classList.contains("hidden"));
  await click('[data-setting="models"]');
  assert.equal(document.querySelector('.settings-primary').textContent, '＋ 接入大模型');
  assert(!$('settings-content').textContent.includes('连接测试会发送简短消息'));
  await click(".settings-primary");
  assert.equal($('editor-title').textContent, '接入大模型');
  $("edit-model-id").value = "new-ui-model"; $("edit-model-name").value = "new-model"; $("edit-model-url").value = "https://example.test/v1"; $("edit-model-key").value = "fake-ui-key";
  await click(action("保存模型")); assert([...$("home-model").options].some((o) => o.value === "new-ui-model"), "Saved model updates home selector");
  await click('[data-setting="execution"]'); $("settings-mode").value = "auto";
  assert.equal($("settings-directories").tagName, "TEXTAREA");
  $("settings-directories").value = "C:\\交付 文件\\桌面输出\n\nD:\\项目\\验收";
  $("settings-content").querySelector("form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })); await settle();
  assert(calls.some((c) => c.route === "/api/customize/settings" && c.payload?.mode === "auto"));
  assert(calls.some((c) => c.route === "/api/customize/settings" && JSON.stringify(c.payload?.additionalDirectories) === JSON.stringify(["C:\\交付 文件\\桌面输出", "D:\\项目\\验收"])));
  const savesBeforePicker = calls.filter(call => call.route === "/api/customize/settings" && call.payload).length;
  const pickDirectoryButton = [...$("settings-content").querySelectorAll("button")].find(control => control.textContent === "选择文件夹并加入");
  pickDirectoryButton.click(); await settle();
  pickDirectoryButton.click(); await settle();
  assert.equal($("settings-directories").value.split("\n").filter(value => value === pickedDirectory).length, 1, "Folder picker deduplicates selected destinations");
  const directoriesBeforeCancel = $("settings-directories").value; pickedDirectory = null;
  pickDirectoryButton.click(); await settle();
  assert.equal($("settings-directories").value, directoriesBeforeCancel, "Cancel preserves typed directory grants");
  assert.equal(calls.filter(call => call.route === "/api/customize/settings" && call.payload).length, savesBeforePicker, "Picking a folder does not grant access until Save");

  await click('[data-setting="official"]');
  assert.equal(accountPopups.length, 0, 'Rendering official services never opens an account window');
  assert(!$('settings-content').textContent.includes('账户服务：'));
  assert(!$('settings-content').textContent.includes('验证 Key 和刷新目录不会调用收费模型'));
  assert(!$('settings-content').textContent.includes('请先验证平台 Key'));
  assert(!$('settings-content').textContent.includes('收费按公开成本'));
  assert(!$('settings-content').textContent.includes('开启前请核对下方'));
  assert.equal($('settings-content').querySelector('a[href$="/account/usage"]'), null);
  assert.equal($('settings-content').querySelector('a[href$="/account/keys"]').textContent, '创建管理平台APIkey');
  assert($('settings-content').textContent.includes('余额 ¥0.000001 · 冻结 ¥0.10'), 'Official settings preserve a single micro-yuan as exact yuan');
  for (const [route, type, extra] of [['/account/billing', 'click', {}], ['/account/keys', 'auxclick', { button: 1 }]]) {
    const link = [...$('settings-content').querySelectorAll('a')].find(item => new URL(item.href).pathname === route);
    assert.equal(link.href, 'https://ccagent.example.invalid' + route, 'Account links keep their static destinations');
    const event = new window.MouseEvent(type, { bubbles: true, cancelable: true, ...extra });
    accountGesture = true; link.dispatchEvent(event); accountGesture = false;
    assert.equal(event.defaultPrevented, true); const popup = accountPopups.at(-1); assert.equal(popup.inGesture, true);
    const channel = new URL(popup.url).searchParams.get('channel'); assert.equal(new URL(popup.url).searchParams.get('target'), route);
    window.dispatchEvent(new window.MessageEvent('message', { origin: 'https://ccagent.example.invalid', source: popup, data: { type: 'ccagent:account-bridge-ready', channel, state: 'offline.payload.signature' } })); await settle();
    assert.equal(popup.sent.length, 1); assert.equal(popup.sent[0].targetOrigin, 'https://ccagent.example.invalid');
    window.dispatchEvent(new window.MessageEvent('message', { origin: 'https://ccagent.example.invalid', source: popup, data: { type: 'ccagent:account-bridge-complete', channel } })); await settle();
  }
  document.querySelector('[data-setting="official"]').click(); document.querySelector('[data-setting="official"]').click(); await settle();
  assert.equal(document.querySelectorAll('#official-api-key').length, 1, 'Concurrent settings renders never append duplicate forms or duplicate ids');
  assert.equal($('official-fallback'), null, 'Removed fallback authorization is not rendered');
  assert($('official-role-main').disabled, 'The main-model selector remains visible and disabled before connection');
  assert($('official-auxiliary').disabled && $('official-default').disabled, 'A first Key verification cannot silently enable services or replace the chat default');
  assert.equal($('official-api-key').closest('details').open, false, 'Manual Key entry is optional and collapsed');
  assert(!calls.some(call => call.route === '/api/customize/official-services' && call.payload), 'Rendering never creates or connects a Key');
  $('settings-content').querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); await settle();
  assert.deepEqual(calls.filter(call => call.route === '/api/customize/official-services' && call.payload).at(-1).payload, { automaticAuxiliary: true, op: 'connect', fallbackEnabled: false });
  officialConfigured = false; await click('[data-setting="official"]');
  $('official-api-key').value = 'ccagent_' + 'x'.repeat(43);
  $('settings-content').querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); await settle();
  const firstVerification = calls.filter(call => call.route === '/api/customize/official-services' && call.payload).at(-1).payload;
  assert.deepEqual(Object.keys(firstVerification), ['automaticAuxiliary', 'apiKey', 'fallbackEnabled'], 'First verification leaves role initialization to the authenticated catalog');
  assert.equal(firstVerification.automaticAuxiliary, true);
  assert.equal(firstVerification.fallbackEnabled, false);
  assert.equal($('official-role-main').value, defaultOfficialRoute.id); assert.equal($('official-auxiliary').checked, false); assert.equal($('official-default').checked, false);
  assert.equal($('settings-content').querySelector('button[type="submit"]').textContent, '保存选择并刷新目录');
  assert.deepEqual([...$('settings-content').querySelectorAll('[id^="official-role-"]')].map(control => control.id), ['official-role-main'], 'Only the main model needs a user selection');
  assert.equal($('official-auxiliary').closest('label').textContent, '读图、决策、搜索、语音和图像生成使用所选官方服务');
  assert.equal($('official-default').closest('label').textContent, '将所选官方主模型设为新对话的默认模型');
  assert.equal($('official-main-pricing').querySelectorAll('article').length, 1, 'The selected main model has one readable price card');
  assert.equal($('official-main-pricing').querySelector('strong').textContent, defaultOfficialRoute.name);
  assert(!$('official-main-pricing').textContent.includes(backupOfficialRoute.name));
  assert(![...$('settings-content').querySelectorAll('button')].some(button => /移除.*KEY|停用官方辅助服务/i.test(button.textContent)), 'The Key-removal control is absent');
  $('official-role-main').value = '';
  $('official-role-main').dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.equal($('official-main-pricing').querySelectorAll('article').length, 0);
  assert.equal($('official-main-pricing').textContent, '选择主模型后查看价格。');
  $('settings-content').querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); await settle();
  assert.deepEqual(calls.filter(call => call.route === '/api/customize/official-services' && call.payload).at(-1).payload.roles, {});
  assert.deepEqual(selectedOfficialRoles, officialAuxiliaryDefaults, 'Clearing the main model still lets the backend configure available auxiliary services');
  assert.equal($('official-role-main').value, '', 'A saved empty selection is kept on reload');
  officialFallback = true; await click('[data-setting="official"]');
  $('settings-content').querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); await settle();
  const consent = calls.filter(call => call.route === '/api/customize/official-services' && call.payload).at(-1).payload;
  assert.equal(consent.automaticAuxiliary, true); assert.equal(consent.auxiliaryEnabled, false); assert.equal(consent.makeDefault, false);
  assert.equal(consent.fallbackEnabled, false); assert.equal(consent.catalogRevision, catalogRevision); assert.equal($('official-fallback'), null);
  assert(!$('settings-content').textContent.includes('需单独开启备用授权')); assert($('settings-content').textContent.includes('备用服务测试'));
  $('official-role-main').value = defaultOfficialRoute.id;
  $('official-auxiliary').checked = true; $('official-default').checked = true;
  $('settings-content').querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); await settle();
  const enabledSelection = calls.filter(call => call.route === '/api/customize/official-services' && call.payload).at(-1).payload;
  assert.deepEqual(enabledSelection.roles, { main: defaultOfficialRoute.id }, 'Saving sends only the main role; backend supplies all auxiliary defaults');
  assert.equal(enabledSelection.automaticAuxiliary, true); assert.equal(enabledSelection.auxiliaryEnabled, true); assert.equal(enabledSelection.makeDefault, true);
  assert.equal(officialDefaultModel, defaultOfficialRoute.id, 'The default-model checkbox still updates the next conversation default');
  assert.equal($('official-auxiliary').checked, true, 'Auxiliary consent survives save and reload');
  assert.equal($('official-default').checked, false, 'Making the model default remains an explicit per-save action');
  assert.deepEqual(selectedOfficialRoles, { main: defaultOfficialRoute.id, ...officialAuxiliaryDefaults });

  imageOfficialRoutes = ['sunburst', 'flare'].map(variant => ({ ...defaultOfficialRoute, id: `${variant}-text-to-image`, service: 'image', protocol: 'kie-images', upstreamModel: `gpt-image-2-5-${variant}-text-to-image`, name: `${variant} 自动图像模型` }));
  selectedOfficialRoles.imageGeneration = imageOfficialRoutes[0].id;
  officialAuxiliaryDefaults = { ...officialAuxiliaryDefaults, imageGeneration: imageOfficialRoutes[1].id };
  const beforeCatalogRefresh = calls.length;
  await click([...$('settings-content').querySelectorAll('button')].find(button => button.textContent === '刷新服务目录'));
  const catalogRefresh = calls.slice(beforeCatalogRefresh).filter(call => call.route === '/api/customize/official-services' && call.payload);
  assert.equal(catalogRefresh.length, 1, 'Refreshing the catalog makes one actual update request');
  assert.deepEqual(catalogRefresh[0].payload, { automaticAuxiliary: true, fallbackEnabled: false });
  assert.equal(selectedOfficialRoles.imageGeneration, imageOfficialRoutes[1].id, 'Refresh picks up changed backend image-generation availability without a user selector');
  assert.equal(selectedOfficialRoles.main, defaultOfficialRoute.id); assert.equal(officialDefaultModel, defaultOfficialRoute.id);
  assert.equal($('official-auxiliary').checked, true, 'Catalog refresh preserves the auxiliary consent checkbox');
  assert.equal($('official-role-main').value, defaultOfficialRoute.id);
  assert.deepEqual([...$('settings-content').querySelectorAll('[id^="official-role-"]')].map(control => control.id), ['official-role-main']);
  for (const route of [...auxiliaryOfficialRoutes, ...imageOfficialRoutes]) assert(!$('official-main-pricing').textContent.includes(route.name), 'Auxiliary prices never appear in the main-model price card');
  assert(!calls.some(call => call.route === '/api/customize/official-services' && call.payload?.op === 'forget'), 'Saving and refreshing never remove the Key or disable auxiliary services through a forget request');
  console.log('Official service DOM: one main selector and price card, explicit connection/manual Key, automatic backend auxiliaries, preserved consent/default checkboxes, cleared main and real save/refresh requests passed.');

  const originalBackupPricing = backupOfficialRoute.pricing;
  backupOfficialRoute.pricing = { ...originalBackupPricing, definition: { tariff: { kind: 'qwen-input-tiers', defaultThinking: true, maxThinkingTokens: 32768 },
    rates: ['input_tokens', 'cached_input_tokens', 'output_tokens'].map(metric => ({ metric, unitQuantity: '1000000', tiers: [
      { upToInputTokens: 128000, price: '0', ...(metric === 'output_tokens' ? { thinkingPrice: '8' } : {}) },
      { upToInputTokens: 1000000, price: '48', ...(metric === 'output_tokens' ? { thinkingPrice: '64' } : {}) },
    ] })),
  } };
  const originalMainPricing = defaultOfficialRoute.pricing;
  defaultOfficialRoute.pricing = { ...originalMainPricing, currency: 'USD', usdCny: '7.1', definition: { tariff: { kind: 'constant' }, rates: [{ metric: 'input_tokens', unitQuantity: '1000000', price: '2', offPeakPrice: '1' }] } };
  await click('[data-setting="official"]');
  assert($('official-main-pricing').textContent.includes('USD 2（低峰 1）'));
  assert($('official-main-pricing').textContent.includes('结算汇率 7.1 元/美元'));
  assert.equal($('official-main-pricing').querySelector('a').href, originalMainPricing.sourceUrl);
  assert(!$('official-main-pricing').textContent.includes('128000 < Token ≤ 1000000'), 'Unselected model tiers are hidden');
  const beforeModelChange = calls.length;
  $('official-role-main').value = backupOfficialRoute.id;
  $('official-role-main').dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.equal(calls.length, beforeModelChange, 'Changing the selected main model updates pricing immediately without a network request');
  assert.equal($('official-main-pricing').querySelector('strong').textContent, backupOfficialRoute.name);
  assert($('official-main-pricing').textContent.includes('128000 < Token ≤ 1000000'));
  assert($('official-main-pricing').textContent.includes('思考 64'));
  assert($('official-main-pricing').textContent.includes('32768 Token'));
  for (const label of ['输入 Token', '缓存输入 Token', '输出 Token']) {
    assert($('official-main-pricing').textContent.includes(`输入 0 < Token ≤ 128000，每 1000000 ${label}：CNY 0${label === '输出 Token' ? '（思考 8）' : ''}`));
    assert($('official-main-pricing').textContent.includes(`输入 128000 < Token ≤ 1000000，每 1000000 ${label}：CNY 48${label === '输出 Token' ? '（思考 64）' : ''}`));
  }
  assert(!$('official-main-pricing').textContent.includes('USD 2'));
  assert(!$('official-main-pricing').textContent.includes('CNY undefined'));
  $('official-auxiliary').checked = false;
  $('settings-content').querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); await settle();
  const disabledSelection = calls.filter(call => call.route === '/api/customize/official-services' && call.payload).at(-1).payload;
  assert.deepEqual(disabledSelection.roles, { main: backupOfficialRoute.id }); assert.equal(disabledSelection.auxiliaryEnabled, false); assert.equal(disabledSelection.makeDefault, false);
  assert.equal($('official-role-main').value, backupOfficialRoute.id); assert.equal($('official-auxiliary').checked, false);
  assert.equal(officialDefaultModel, defaultOfficialRoute.id, 'Saving a different main model with the default checkbox clear preserves the existing new-chat default');
  backupOfficialRoute.pricing = originalBackupPricing;
  defaultOfficialRoute.pricing = originalMainPricing; imageOfficialRoutes = []; selectedOfficialRoles = {};
  console.log('Official service DOM: main-model change immediately swaps prices; Qwen tiers/thinking allowance, off-peak rates, exchange rate/source and disabled consent/default preservation passed.');

  const adminEntry = $('settings-admin-entry');
  assert.equal(adminEntry.previousElementSibling.dataset.setting, 'import');
  assert.equal(adminEntry.hidden, true, 'Ordinary users have no administrator entry');
  const beforeDenied = accountPopups.length;
  await click(adminEntry);
  assert.equal(accountPopups.length, beforeDenied, 'A forged click cannot open the admin bridge without permissions');
  adminPermissions = ['admin.read']; await click('[data-setting="official"]');
  assert.equal(adminEntry.hidden, false, 'Business admin permission enables the entry without requiring a platform Key');
  accountGesture = true; adminEntry.click(); accountGesture = false; await settle();
  const adminPopup = accountPopups.at(-1), adminChannel = new URL(adminPopup.url).searchParams.get('channel');
  assert.equal(adminPopup.inGesture, true, 'Admin popup opens synchronously in the user gesture');
  assert.equal(new URL(adminPopup.url).searchParams.get('target'), '/admin');
  assert.equal(document.querySelector('.settings-nav .selected').dataset.setting, 'official', 'Admin action preserves the settings category');
  window.dispatchEvent(new window.MessageEvent('message', { origin: 'https://ccagent.example.invalid', source: adminPopup, data: { type: 'ccagent:account-bridge-ready', channel: adminChannel, state: 'offline.payload.signature' } })); await settle();
  assert.equal(adminPopup.sent.length, 1);
  window.dispatchEvent(new window.MessageEvent('message', { origin: 'https://ccagent.example.invalid', source: adminPopup, data: { type: 'ccagent:account-bridge-complete', channel: adminChannel } })); await settle();
  adminPermissions = []; await click('[data-setting="official"]');
  assert.equal(adminEntry.hidden, true, 'A refreshed lookup removes revoked access');
  adminPermissions = ['admin.read']; await click('[data-setting="official"]');
  failAccess = true; await click('[data-setting="official"]');
  assert.equal(adminEntry.hidden, true, 'A failed lookup cannot retain earlier admin visibility'); failAccess = false;
  let resolveAccess;
  pendingAccess = new Promise(resolve => { resolveAccess = resolve; });
  document.querySelector('[data-setting="official"]').click(); await settle();
  window.dispatchEvent(new window.Event('ccagent:account-changing'));
  resolveAccess({ ok: true, json: async () => ({ origin: 'https://ccagent.example.invalid', user: { id: 'offline-ui-user' }, permissions: ['admin.read'] }) }); await settle(); pendingAccess = null;
  assert.equal(adminEntry.hidden, true, 'An in-flight result cannot re-enable admin access after logout/account switching');
  adminPermissions = [];
  console.log('Admin entry DOM: ordering, ordinary-user denial, authenticated bridge, refreshed revocation, lookup failure and account-switch race passed.');

  const beforeOfficialReads = calls.length;
  await click('[data-setting="official"]');
  const officialReads = calls.slice(beforeOfficialReads).filter(call => !call.payload).map(call => call.route);
  assert.deepEqual(officialReads, ['/api/customize/official-services'], 'Official settings uses one resource without duplicate permission or unrelated settings reads');
  let releaseSlowSettings;
  pendingAccess = new Promise(resolve => { releaseSlowSettings = resolve; });
  document.querySelector('[data-setting="official"]').click(); await settle();
  await click('[data-setting="general"]');
  assert($('settings-language'), 'General settings renders while earlier official and administrator requests are still pending');
  releaseSlowSettings({ ok: true, json: async () => ({ origin: 'https://ccagent.example.invalid', user: { id: 'offline-ui-user' }, permissions: [] }) });
  await settle(); pendingAccess = null;
  assert($('settings-language'), 'Late settings result cannot replace the newly selected page');
  console.log('Settings performance DOM: one official request, nonblocking permissions, immediate category changes and stale response isolation passed.');

  await click('[data-customize-view="teams"]'); assert(!$("teams-view").classList.contains("hidden"));
  await click("#teams-create"); assert($("edit-team-name"));
  $("editor-requirements").value = "Organize a team"; await click(".editor-generate");
  assert.equal($("edit-team-id").value, "qa-team"); assert.equal(document.querySelectorAll(".team-role-row").length, 1);
  await click(action("保存团队")); assert(calls.some((c) => c.route === "/api/customize/teams" && c.payload?.roles?.[0].name === "reviewer"));
  await click("#teams-global"); assert.equal(teamEnabled, false); assert(![...$("home-team").options].some((o) => o.value === "auto"));

  await click('[data-view="library"]'); await click("#library-rag");
  await click(action("＋ 添加知识库")); $("edit-rag-id").value = "offline"; $("edit-rag-name").value = "Offline KB"; $("edit-rag-url").value = "https://example.test/retrieve";
  await click(action("保存知识库")); assert(calls.some((c) => c.route === "/api/customize/rag" && c.payload?.id === "offline"));
  await click('[data-view="visualization"]'); assert(!$("visualization-view").classList.contains("hidden")); assert($("viz-dropzone")); assert($("sidebar").classList.contains("hidden")); assert.equal(new URLSearchParams(location.search).get("view"), "visualization");
  assert(calls.some((c) => c.route.startsWith("/api/visualization?workspace=")), "Sidebar entry loads the actual workspace-scoped visualization API");
  const chartStyles = document.createElement("style"); chartStyles.textContent = await fs.readFile(path.join(root, "web/styles.css"), "utf8") + await fs.readFile(path.join(root, "web/visualization.css"), "utf8"); document.head.append(chartStyles);
  assert(["#f6f8fe", "rgb(246, 248, 254)"].includes(window.getComputedStyle(document.querySelector(".content")).backgroundColor), "Visualization background overrides the normal content surface");
  console.log("Offline Web DOM: all six feature entries, generation/edit/save dialogs, literal rendering, skill toggles, model selector linkage, team controls, settings and RAG forms passed.");
  console.log("Workspace/composer DOM: search removed with history retained, right-side directory browse, all preview renderers, safe text, reference chips, 7 executable menu actions, keyboard/outside dismissal, uploads, commands/search submission, plan mode and retry preservation passed.");

  // Use the real application and picker to keep two project tasks alive.
  const projectA = "C:\\offline-project", projectB = "D:\\并行项目 B";
  const projectBSession = "55555555-5555-4555-8555-555555555555";
  let currentProject = projectA, projectBBusy = false, slowChanges, releaseOldChanges, unavailableProject;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (route, options = {}) => {
    const workspace = options.headers?.["x-ccagent-workspace"] ? decodeURIComponent(options.headers["x-ccagent-workspace"]) : currentProject;
    const payload = options.body ? JSON.parse(options.body) : null;
    if (route === "/api/bootstrap" && workspace === unavailableProject) {
      calls.push({ route, payload, headers: options.headers });
      return { status: 409, ok: false, json: async () => ({ error: "Project is no longer available", code: "workspace_not_open" }) };
    }
    let data;
    if (route === "/api/workspaces") data = { current: workspace, recent: [projectA, projectB], locations: [], nativePickerAvailable: false, activeWorkers: [{ workspace: projectA, busy: true, activeSessionId: sessionId }, { workspace: projectB, busy: projectBBusy, activeSessionId: projectBBusy ? projectBSession : null }] };
    else if (route.startsWith("/api/workspaces/browse")) data = { path: new URL(route, location.href).searchParams.get("path"), parent: null, breadcrumbs: [], folders: [], total: 0 };
    else if (route === "/api/workspaces/select") { currentProject = payload.path; data = { workspace: currentProject, activeSessionId: currentProject === projectA ? sessionId : projectBBusy ? projectBSession : null, preservedBackgroundTasks: true }; }
    else if (route === "/api/bootstrap") data = { workspace, sessions: workspace === projectA ? recentSessions : projectBBusy ? [{ sessionId: projectBSession, firstPrompt: "B project task" }] : [], version: "test", model: "fixture", defaultMode: "plan" };
    else if (route === "/api/changes" && workspace === projectA && slowChanges) { slowChanges = false; return new Promise(resolve => { releaseOldChanges = resolve; }); }
    else if (route === "/api/sessions" && workspace === projectB) data = { sessionId: projectBSession, snapshot: { sessionId: projectBSession, mode: "plan", model: "fixture", messages: [], team: "off", busy: false } };
    else if (route === `/api/sessions/${projectBSession}/messages`) { assert.equal(workspace, projectB); projectBBusy = true; data = { accepted: true }; }
    else if (route === `/api/sessions/${projectBSession}`) { assert.equal(workspace, projectB); data = { sessionId: projectBSession, mode: "plan", model: "fixture", messages: [], team: "off", busy: projectBBusy }; }
    else return originalFetch(route, options);
    calls.push({ route, payload, headers: options.headers });
    return { ok: true, json: async () => data };
  };
  await click("#new-task");
  await click("#recent-list .recent-item");
  lastEventSource.onmessage({ data: JSON.stringify({ type: "turn_started" }) });
  const projectASource = lastEventSource;
  recoveredSessionSnapshot = { sessionId, mode: "plan", model: "fixture", messages: [], team: "off", busy: true };
  $("thread-input").value = "A project draft";
  assert.equal(new URL(lastEventSource.url, location.href).searchParams.get("workspace"), projectA);
  slowChanges = true;
  $("activity-refresh").click(); await settle();
  const beforeProjectSwitch = calls.length;
  async function switchProject(folder) {
    await click("#context-workspace");
    assert.match($("workspace-recent").textContent, /执行中/);
    $("workspace-input").value = folder;
    await click("#workspace-use");
    assert($("workspace-overlay").classList.contains("hidden"));
  }
  await switchProject(projectB);
  assert(projectASource.closed, "Switching closes only the view's event connection");
  assert.equal($("workspace-path").textContent, projectB);
  assert(!$("home-view").classList.contains("hidden"));
  assert.equal($("thread-input").value, "", "Project A's draft is not shown in project B");
  assert.equal($("home-effort").disabled, false, "A task in project A does not lock project B's composer");
  releaseOldChanges({ ok: true, json: async () => ({ files: [{ path: "stale-project-a.txt", status: "M" }] }) }); await settle();
  assert(!$("changes-list").textContent.includes("stale-project-a.txt"), "A late response cannot replace project B's changes");
  projectASource.onmessage({ data: JSON.stringify({ type: "assistant", message: { role: "assistant", content: "stale A event" } }) });
  assert(!$("timeline").textContent.includes("stale A event"));
  $("home-input").value = "Run the second project in parallel";
  $("home-form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })); await settle();
  assert(projectBBusy, `B submit failed: ${$("toast").textContent}; ${calls.slice(beforeProjectSwitch).map(call => call.route).join(",")}`);
  assert.equal(new URL(lastEventSource.url, location.href).searchParams.get("workspace"), projectB);
  lastEventSource.onmessage({ data: JSON.stringify({ type: "turn_started" }) });
  await switchProject(projectA);
  assert.equal(new URLSearchParams(location.search).get("session"), sessionId);
  assert.equal(new URLSearchParams(location.search).get("workspace"), projectA);
  assert.equal($("thread-input").disabled, true, "Returning to A restores its still-running task");
  assert.equal($("thread-input").value, "A project draft", "Returning to A restores its own text draft");
  await switchProject(projectB);
  assert.equal(new URLSearchParams(location.search).get("session"), projectBSession);
  assert.equal($("thread-input").disabled, true, "Returning to B restores its independent running task");
  assert.equal(calls.slice(beforeProjectSwitch).filter(call => call.route.endsWith("/interrupt")).length, 0, "Project switching never interrupts either root task");
  assert(calls.slice(beforeProjectSwitch).some(call => call.headers?.["x-ccagent-workspace"] === encodeURIComponent(projectB)), "Unicode project paths are encoded in request headers");
  console.log("Parallel projects DOM: independent submissions, running-task restoration, encoded request/SSE/URL binding, picker task status and stale response/event isolation passed.");

  unavailableProject = projectB;
  currentProject = projectA;
  const beforeUnavailableRecovery = calls.length;
  await click("#refresh-all");
  const recoveryCalls = calls.slice(beforeUnavailableRecovery);
  const bootstrapRecovery = recoveryCalls.filter(call => call.route === "/api/bootstrap");
  assert.equal(bootstrapRecovery.length, 2, "An unavailable project triggers one unbound bootstrap retry");
  assert.equal(bootstrapRecovery[0].headers["x-ccagent-workspace"], encodeURIComponent(projectB));
  assert.equal(bootstrapRecovery[1].headers["x-ccagent-workspace"], undefined, "Recovery removes the unavailable project header");
  assert.equal($("workspace-path").textContent, projectA);
  assert(!$("home-view").classList.contains("hidden"));
  assert.equal(new URLSearchParams(location.search).get("session"), null, "A stale saved session is not opened in the default project");
  assert.equal(new URLSearchParams(location.search).get("workspace"), null, "Recovery removes the unavailable project URL binding");
  assert.equal(recoveryCalls.filter(call => call.route.endsWith("/messages") || call.route.endsWith("/interrupt")).length, 0, "Recovery neither submits nor interrupts tasks");
  assert.match($("toast").textContent, /原工作文件夹不可用/);
  await click("#context-workspace");
  assert(!$("workspace-overlay").classList.contains("hidden"), "The project picker remains usable after account or directory changes");
  await click("#workspace-cancel");
  console.log("Unavailable project DOM: one unbound bootstrap recovery, removed stale URL/session, default project restored and usable project picker passed.");
} finally { await window.happyDOM.close(); }
