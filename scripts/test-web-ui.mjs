/** Offline DOM integration. No browser or live service access. Pass happy-dom's index.js path. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
const root = path.resolve(import.meta.dirname, "..");
const { Window } = await import(process.argv[2] ? pathToFileURL(path.resolve(process.argv[2])).href : "happy-dom");
const window = new Window({ url: "http://offline-ui.test/", settings: { disableJavaScriptFileLoading: true, enableJavaScriptEvaluation: false, enableCSSFileLoading: false, enableImageFileLoading: false } });
window.document.write(await fs.readFile(path.join(root, "web/index.html"), "utf8"));
for (const name of ["window", "document", "location", "history", "localStorage", "HTMLElement", "HTMLSelectElement", "Event", "KeyboardEvent", "File", "FormData", "MutationObserver", "Node"]) globalThis[name] = name === "window" ? window : window[name];
Object.defineProperty(globalThis, "navigator", { value: window.navigator, configurable: true });
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
globalThis.setInterval = () => 0;
globalThis.EventSource = class { close() {} };
const calls = [], models = [{ id: "fixture", label: "Fixture", model: "fixture", available: true }];
const agent = { name: "qa", description: "QA Agent", source: "project", editable: true, enabled: true, prompt: "Check evidence" };
const skill = { name: "test-skill", description: "Skill", source: "project", enabled: true };
const teams = [{ id: "qa-team", name: "QA Team", description: "Evidence", enabled: true, roles: [{ name: "reviewer", agentType: "qa", prompt: "Check facts" }] }];
let teamEnabled = true;
globalThis.fetch = async (route, options = {}) => {
  const payload = options.body ? JSON.parse(options.body) : null;
  calls.push({ route, payload });
  let data;
  if (route === "/api/bootstrap") data = { sessions: [], workspace: "C:\\offline-project", version: "test", model: "fixture", defaultMode: "plan" };
  else if (route === "/api/changes") data = { files: [] };
  else if (route === "/api/models") data = { defaultModel: "fixture", models };
  else if (route === "/api/customize/settings") data = { settings: { language: "中文", mode: "plan", cleanupPeriodDays: 60 }, settingsPath: "offline-settings.json", defaultModel: "fixture" };
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
} finally { await window.happyDOM.close(); }
