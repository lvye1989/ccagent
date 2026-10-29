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
globalThis.EventSource = class { constructor() { globalThis.lastEventSource = this; } close() {} };
const calls = [], models = [{ id: "fixture", label: "Fixture", model: "fixture", available: true }];
const agent = { name: "qa", description: "QA Agent", source: "project", editable: true, enabled: true, prompt: "Check evidence" };
const skill = { name: "test-skill", description: "Skill", source: "project", enabled: true };
const teams = [{ id: "qa-team", name: "QA Team", description: "Evidence", enabled: true, roles: [{ name: "reviewer", agentType: "qa", prompt: "Check facts" }] }];
let teamEnabled = true;
const sessionId = "11111111-1111-4111-8111-111111111111";
let sessionMode = "default", failUpload = false, failSubmit = false, effortLevel = "";
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
globalThis.fetch = async (route, options = {}) => {
  const payload = options.body ? JSON.parse(options.body) : null;
  calls.push({ route, payload });
  let data;
  if (route === "/api/bootstrap") data = { sessions: [{ sessionId, firstPrompt: "保留的历史任务" }], workspace: "C:\\offline-project", version: "test", model: "fixture", defaultMode: "plan" };
  else if (route === "/api/sessions") data = { sessionId };
  else if (route === `/api/sessions/${sessionId}`) data = { sessionId, mode: sessionMode, model: "fixture", messages: [], team: "off", busy: false };
  else if (route === `/api/sessions/${sessionId}/mode`) { sessionMode = payload.mode; data = {}; }
  else if (route === `/api/sessions/${sessionId}/messages`) { if (failSubmit) throw new Error("Fixture submit failure"); data = { accepted: true }; }
  else if (route === "/api/composer-tools") data = { commands: [{ name: "test-skill", description: "Fixture skill", kind: "技能" }, { name: "help", description: "Help", kind: "命令" }] };
  else if (route === "/api/files/upload") { if (failUpload) throw new Error("Fixture upload failure"); data = { path: `.ccagent/attachments/id/${payload.name}`, name: payload.name, size: 4 }; }
  else if (route.startsWith("/api/files")) {
    const url = new URL(route, "http://offline-ui.test"), dir = url.searchParams.get("path");
    if (url.pathname === "/api/files/preview") data = files.find((file) => file.path === dir);
    else data = { path: dir, entries: dir ? [{ path: "资料/中文.md", name: "中文.md", size: 12, format: "text" }] : files, nextOffset: null, total: dir ? 1 : files.length };
  }
  else if (route === "/api/workspaces") data = { current: "C:\\offline-project", recent: [], locations: [], nativePickerAvailable: false };
  else if (route.startsWith("/api/workspaces/browse")) data = { path: "C:\\offline-project", parent: null, breadcrumbs: [], folders: [], total: 0 };
  else if (route === "/api/changes") data = { files: [] };
  else if (route === "/api/models") data = { defaultModel: "fixture", models };
  else if (route === "/api/customize/settings") { if (payload?.effortLevel) effortLevel = payload.effortLevel; data = { settings: { language: "中文", mode: "plan", cleanupPeriodDays: 60, effortLevel }, settingsPath: "offline-settings.json", defaultModel: "fixture" }; }
  else if (route === "/api/customize/models") { if (payload) models.push({ id: payload.id, label: payload.id, model: payload.model, available: true }); data = payload ? { id: payload.id } : { models: models.map((m) => ({ ...m, protocol: "openai-chat", baseURL: "https://example.test/v1" })) }; }
  else if (route === "/api/customize/model-test") data = { ok: true, reply: "OK" };
  else if (route === "/api/customize/teams") { if (payload?.op === "global") teamEnabled = payload.enabled; data = { teams, enabled: teamEnabled, activeTeam: null }; }
  else if (route === "/api/customize/rag") data = { connections: [] };
  else if (route === "/api/plugins") data = { installed: [], available: [], marketplaces: [] };
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
  $("home-form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })); await settle();
  const submitted = calls.find((call) => call.route === `/api/sessions/${sessionId}/messages`);
  assert.match(submitted.payload.text, /^\/test-skill\s/); assert.match(submitted.payload.text, /code.ts/); assert.match(submitted.payload.text, /WebSearch/); assert.match(submitted.payload.text, /Office 正文摘录/); assert.match(submitted.payload.text, /<img src=x>/);
  assert.match(submitted.payload.text, /@"image\.png"/, "Images use the shared CLI attachment grammar");
  assert($("home-input-attachments").classList.contains("hidden"), "Successful submission clears consumed references");
  lastEventSource.onmessage({ data: JSON.stringify({ type: "turn_started" }) });
  lastEventSource.onmessage({ data: JSON.stringify({ type: "tool_start", id: "failed-image", name: "ReadImage" }) });
  lastEventSource.onmessage({ data: JSON.stringify({ type: "turn_complete", reason: "model_error" }) }); await settle();
  assert.match($("thread-status-label").textContent, /失败/); assert(![...document.querySelectorAll(".tool-state")].some((node) => node.textContent === "执行中"), "Failed turns leave no tool card looking active");
  await click("#thread-insert-tool"); await click(tool("计划模式")); assert.equal(sessionMode, "plan");
  await click("#new-task");
  await click("#insert-command"); await click(tool("添加照片和文件"));
  Object.defineProperty($("composer-upload"), "files", { value: [new window.File([new Uint8Array([0, 1, 255, 48])], "upload.bin")], configurable: true });
  $("composer-upload").dispatchEvent(new window.Event("change", { bubbles: true })); await settle();
  assert(calls.some((call) => call.route === "/api/files/upload" && call.payload.base64 === "AAH/MA==")); assert.match($("home-input-attachments").textContent, /upload.bin/);
  failSubmit = true; $("home-input").value = "Read attachment";
  $("home-form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })); await settle(); assert.match($("thread-input-attachments").textContent, /upload.bin/, "Failed send keeps the reference in the visible composer"); assert.equal($("thread-input").value, "Read attachment");
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

  await click('[data-customize-view="skills"]');
  await click([...$("skills-list").querySelectorAll("button")].find((b) => b.textContent === "关闭"));
  assert.equal(skill.enabled, false); assert.match($("skills-list").textContent, /已关闭/);
  await click("#skill-local-path"); $("edit-skill-path").value = "C:\\offline-skill"; await click(action("导入完整技能"));
  assert(calls.some((c) => c.route === "/api/customize/local-skill" && c.payload.path === "C:\\offline-skill"));

  await click('[data-view="settings"]'); assert(!$("settings-view").classList.contains("hidden"));
  await click('[data-setting="models"]'); await click(".settings-primary");
  $("edit-model-id").value = "new-ui-model"; $("edit-model-name").value = "new-model"; $("edit-model-url").value = "https://example.test/v1"; $("edit-model-key").value = "fake-ui-key";
  await click(action("保存模型")); assert([...$("home-model").options].some((o) => o.value === "new-ui-model"), "Saved model updates home selector");
  await click('[data-setting="execution"]'); $("settings-mode").value = "auto";
  $("settings-content").querySelector("form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })); await settle();
  assert(calls.some((c) => c.route === "/api/customize/settings" && c.payload?.mode === "auto"));

  await click('[data-customize-view="teams"]'); assert(!$("teams-view").classList.contains("hidden"));
  await click("#teams-create"); assert($("edit-team-name"));
  $("editor-requirements").value = "Organize a team"; await click(".editor-generate");
  assert.equal($("edit-team-id").value, "qa-team"); assert.equal(document.querySelectorAll(".team-role-row").length, 1);
  await click(action("保存团队")); assert(calls.some((c) => c.route === "/api/customize/teams" && c.payload?.roles?.[0].name === "reviewer"));
  await click("#teams-global"); assert.equal(teamEnabled, false); assert(![...$("home-team").options].some((o) => o.value === "auto"));

  await click('[data-view="library"]'); await click("#library-rag");
  await click(action("＋ 添加知识库")); $("edit-rag-id").value = "offline"; $("edit-rag-name").value = "Offline KB"; $("edit-rag-url").value = "https://example.test/retrieve";
  await click(action("保存知识库")); assert(calls.some((c) => c.route === "/api/customize/rag" && c.payload?.id === "offline"));
  console.log("Offline Web DOM: all six feature entries, generation/edit/save dialogs, literal rendering, skill toggles, model selector linkage, team controls, settings and RAG forms passed.");
  console.log("Workspace/composer DOM: search removed with history retained, right-side directory browse, all preview renderers, safe text, reference chips, 7 executable menu actions, keyboard/outside dismissal, uploads, commands/search submission, plan mode and retry preservation passed.");
} finally { await window.happyDOM.close(); }
