import { createPluginUI } from "./plugins.js";
import { createHomePromotion } from "./promotion.js";
import { createVoiceUI } from "./voice.js";
import { createBrowserPanel } from "./browser-panel.js";
import { createLibraryUI } from "./library.js";
import { createMemoryUI } from "./memory.js";
import { createSchedulesUI } from "./schedules.js";
import { createCustomizationUI } from "./customization.js";
import { createWorkspacePicker } from "./workspace-picker.js";
import { createWorkspaceFiles } from "./workspace-files.js";
import { createComposerTools } from "./composer-tools.js";
import { createVisualizationUI } from "./visualization.js";
import { createCloudTVUI } from "./cloudtv.js";
import { createWhiteboardUI } from "./whiteboard.js";
import { folderIcon } from "./app-icons.js";

const $ = (id) => document.getElementById(id);
const initialWorkspace = new URLSearchParams(location.search).get("workspace") || "";
const state = { workspace: initialWorkspace, model: "", mode: "default", selectedModel: "", availableModels: [], version: "", sessions: [], changes: [], sessionId: null, temporary: false, source: null, busy: false, pending: null, view: "tasks", composeMode: "work", activity: "changes", streamNode: null, toolNodes: new Map(), execution: null, executionNode: null, executionTimer: null, serverClockOffset: 0, storageWarningShown: false };
let toastTimer;
let sessionListRequest = 0;
let openingSession = null;
let sessionRecoveryTimer = null;
let sessionRecoveryAttempt = 0;
const deletingSessions = new Set();
const STREAM_FLUSH_MS = 30;
const MAX_STREAM_BUFFER_CHARS = 32 * 1024;
let streamTextNode = null;
let streamPendingText = "";
let streamFlushTimer = null;
let composeContext = 0;
let submitRequest = 0;
let taskConflict = null;
let workspaceEpoch = 0;
const workspaceSessions = new Map();
const workspaceDrafts = new Map();
const STALE_WORKSPACE = "工作区已切换，忽略原项目响应";

function projectUrl(values = {}) {
  const params = new URLSearchParams(values);
  if (state.workspace) params.set("workspace", state.workspace);
  return params.size ? `/?${params}` : "/";
}

function toast(message) {
  if (String(message).includes(STALE_WORKSPACE)) return;
  const node = $("toast");
  node.textContent = message;
  node.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.add("hidden"), 4500);
}

async function api(route, options = {}) {
  const epoch = workspaceEpoch;
  const queryWorkspace = new URL(route, location.href).searchParams.get("workspace");
  let bodyWorkspace;
  if (typeof options.body === "string") {
    try { bodyWorkspace = JSON.parse(options.body)?.workspace; } catch { /* Non-JSON requests carry the visible project. */ }
  }
  const workspace = queryWorkspace || (typeof bodyWorkspace === "string" ? bodyWorkspace : "") || state.workspace;
  const response = await fetch(route, {
    ...options,
    headers: { ...(options.body ? { "content-type": "application/json" } : {}), "x-ccagent-web": "1", ...(workspace ? { "x-ccagent-workspace": encodeURIComponent(workspace) } : {}), ...(options.headers || {}) },
  });
  const body = await response.json();
  // A completed request still belongs to the project that initiated it.
  // Closing its view never cancels execution in the background Worker.
  if (epoch !== workspaceEpoch) throw new Error(STALE_WORKSPACE);
  if (response.status === 401) { state.source?.close(); window.location.replace('/login'); }
  if (!response.ok) {
    const error = new Error(body.error || `HTTP ${response.status}`);
    error.status = response.status;
    error.code = body.code;
    if (response.status === 409) error.conflict = taskConflictDetails(body);
    throw error;
  }
  return body;
}

function taskConflictDetails(body) {
  const reasons = ["waiting_permission", "waiting_question", "task_running", "whiteboard_running", "configuration_busy", "team_active"];
  if (!body || body.code !== "TASK_BUSY" || !reasons.includes(body.reason) || typeof body.canInterrupt !== "boolean"
      || !(body.activeSessionId === null || typeof body.activeSessionId === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(body.activeSessionId))) return null;
  return { reason: body.reason, activeSessionId: body.activeSessionId, canInterrupt: body.canInterrupt && body.activeSessionId !== null && body.reason !== "whiteboard_running" };
}

function clearTaskConflict() {
  const conflict = taskConflict;
  taskConflict = null;
  conflict?.controller?.abort();
  conflict?.node.remove();
}

function showTaskConflict(details) {
  clearTaskConflict();
  const node = document.createElement("div");
  node.id = "task-conflict";
  node.className = "notice-line";
  node.setAttribute("role", "status");
  node.setAttribute("aria-live", "polite");
  const summary = document.createElement("p");
  summary.textContent = ({
    waiting_permission: "后台还有任务等待你的授权。请查看原任务并处理授权，或主动停止原任务后再发送。",
    waiting_question: "后台还有任务等待你的回答。请查看原任务并回答，或主动停止原任务后再发送。",
    task_running: "后台还有任务正在执行。可查看执行进度，或主动停止原任务后再发送。",
    whiteboard_running: "白板正在执行绘图任务。请到白板查看进度，完成后再发送。",
    configuration_busy: "后台正在更新配置。请等待更新完成后重新发送。",
    team_active: "后台还有团队任务正在执行。请查看原任务，完成后再发送。",
  })[details.reason];
  const status = document.createElement("p");
  status.textContent = "当前消息与附件草稿已保留。";
  const actions = document.createElement("div");
  actions.className = "modal-actions";
  const conflict = { node, context: composeContext, sessionId: state.sessionId, controller: null };
  taskConflict = conflict;
  const current = () => taskConflict === conflict && composeContext === conflict.context && state.sessionId === conflict.sessionId && node.isConnected;
  if (details.activeSessionId || details.reason === "whiteboard_running") {
    const link = document.createElement("a");
    link.className = "secondary-button";
    link.textContent = details.reason === "whiteboard_running" ? "查看白板（新窗口）" : "查看占用任务（新窗口）";
    link.href = projectUrl(details.reason === "whiteboard_running" ? { view: "whiteboard" } : { session: details.activeSessionId });
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    actions.append(link);
  }
  if (details.canInterrupt && details.activeSessionId) {
    const stop = document.createElement("button");
    stop.type = "button";
    stop.className = "secondary-button";
    stop.textContent = "停止占用任务";
    stop.addEventListener("click", async () => {
      if (!current() || conflict.controller) return;
      const controller = new AbortController();
      conflict.controller = controller;
      const deadline = setTimeout(() => controller.abort(), 10000);
      stop.disabled = true;
      status.textContent = "正在停止占用任务并确认状态…";
      try {
        await api(`/api/sessions/${details.activeSessionId}/interrupt`, { method: "POST", body: "{}", signal: controller.signal });
        for (let attempt = 0; attempt < 40 && current(); attempt++) {
          controller.signal.throwIfAborted();
          const session = await api(`/api/sessions/${details.activeSessionId}`, { signal: controller.signal });
          if (!current()) return;
          if (session.sessionId !== details.activeSessionId || typeof session.busy !== "boolean") throw new Error("Invalid task state");
          if (!session.busy) {
            status.textContent = "占用任务已停止。草稿已保留，请点击发送重新提交。";
            return;
          }
          await new Promise(resolve => setTimeout(resolve, 250));
        }
        if (current()) { status.textContent = "任务仍未停止，请查看原任务状态后重试。"; stop.disabled = false; }
      } catch {
        if (current()) { status.textContent = controller.signal.aborted ? "停止确认超时，请查看原任务状态后重试。" : "暂时无法停止任务，请查看原任务状态后重试。"; stop.disabled = false; }
      } finally {
        clearTimeout(deadline);
        if (conflict.controller === controller) conflict.controller = null;
      }
    });
    actions.append(stop);
  }
  node.append(summary, status, actions);
  $(state.view === "thread" ? "thread-form" : "home-form").before(node);
}

function shortWorkspace() {
  return state.workspace.split(/[\\/]/).filter(Boolean).pop() || "工作区";
}

function relativeTime(dateString) {
  const time = new Date(dateString).getTime();
  if (!Number.isFinite(time)) return "刚刚";
  const minutes = Math.max(0, Math.floor((Date.now() - time) / 60000));
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)} 小时前`;
  return new Date(time).toLocaleDateString("zh-CN", { month: "short", day: "numeric" });
}

function taskTitle(session) {
  return session.firstPrompt?.trim().replace(/\s+/g, " ").slice(0, 80) || "新任务";
}

function renderSessions() {
  $("task-count").textContent = state.sessions.length ? String(state.sessions.length) : "";
  const list = $("recent-list");
  list.replaceChildren();
  if (!state.sessions.length) {
    const empty = document.createElement("div");
    empty.className = "sidebar-empty";
    empty.textContent = "还没有任务，点击新聊天开始";
    list.append(empty);
  }
  for (const session of state.sessions) {
    const row = document.createElement("div");
    row.className = "recent-row";
    const title = taskTitle(session);
    const button = document.createElement("button");
    button.type = "button";
    button.className = `recent-item${session.sessionId === state.sessionId ? " active" : ""}`;
    button.textContent = title;
    button.title = `${title} · ${relativeTime(session.updatedAt)}`;
    button.disabled = deletingSessions.has(session.sessionId);
    button.addEventListener("click", () => openSession(session.sessionId));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "recent-delete";
    remove.title = "删除记录";
    remove.setAttribute("aria-label", `删除记录：${title}`);
    remove.disabled = button.disabled;
    remove.innerHTML = '<svg class="nav-line-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 7h16M9 7V4h6v3m3 0-1 13H7L6 7m4 4v5m4-5v5"/></svg>';
    remove.addEventListener("click", () => void deleteRecentSession(session, remove, button));
    row.append(button, remove);
    list.append(row);
  }
}

async function deleteRecentSession(session, remove, button) {
  const id = session.sessionId, workspace = state.workspace;
  if (deletingSessions.has(id) || !window.confirm(`永久删除「${taskTitle(session)}」的聊天记录？此操作无法撤销。`)) return;
  deletingSessions.add(id);
  remove.disabled = button.disabled = true;
  try {
    await api(`/api/memory/sessions/${id}`, { method: "POST", body: JSON.stringify({ action: "delete", workspace }) });
    if (state.workspace === workspace) await onSessionDeleted(id);
    toast("已删除聊天记录");
  } catch (error) {
    toast(error.message);
  } finally {
    deletingSessions.delete(id);
    if (remove.isConnected) remove.disabled = button.disabled = false;
    else if (state.sessions.some((item) => item.sessionId === id)) renderSessions();
  }
}

async function onSessionDeleted(id) {
  for (const [workspace, sessionId] of workspaceSessions) if (sessionId === id) workspaceSessions.delete(workspace);
  sessionListRequest++;
  state.sessions = state.sessions.filter((item) => item.sessionId !== id);
  if (openingSession?.id === id) openingSession = null;
  if (state.sessionId === id) {
    if (state.view === "thread") await newTask();
    else clearOpenSession();
  }
  renderSessions();
  void refreshSessions();
}

function renderChanges() {
  const count = state.changes.length;
  $("activity-count").textContent = count;
  const list = $("changes-list");
  list.replaceChildren();
  if (!count) {
    const empty = document.createElement("div");
    empty.className = "no-tasks";
    empty.textContent = "工作区没有未提交的更改。";
    list.append(empty);
  }
  for (const file of state.changes) {
    const button = document.createElement("button");
    button.className = "change-row";
    const badge = document.createElement("span");
    badge.className = "change-badge";
    badge.textContent = file.status.trim() || "?";
    const name = document.createElement("span");
    name.className = "change-path";
    name.textContent = file.displayPath || file.path;
    const arrow = document.createElement("span");
    arrow.textContent = "→";
    button.append(badge, name, arrow);
    button.addEventListener("click", () => showDiff(file.path));
    list.append(button);
  }
  renderActivity();
}

function renderActivity() {
  const content = $("activity-content");
  content.replaceChildren();
  document.querySelectorAll(".activity-tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.activity === state.activity));
  if (state.activity === "details") {
    for (const [label, value] of [["工作区", state.workspace], ["模型", state.model], ["会话", state.sessionId || "—"], ["状态", state.busy ? "正在执行" : "就绪"]]) {
      const row = document.createElement("div");
      row.className = "activity-info-row";
      const name = document.createElement("span");
      name.textContent = label;
      const text = document.createElement("strong");
      text.textContent = value;
      row.append(name, text);
      content.append(row);
    }
    return;
  }
  if (!state.changes.length) {
    const empty = document.createElement("div");
    empty.className = "activity-empty";
    const icon = document.createElement("div");
    icon.className = "activity-empty-icon";
    icon.textContent = "✓";
    const text = document.createElement("div");
    text.textContent = "工作区尚无代码更改。运行任务后可在此查看结果。";
    empty.append(icon, text);
    content.append(empty);
    return;
  }
  for (const file of state.changes) {
    const row = document.createElement("button");
    row.className = "activity-file";
    const status = document.createElement("span");
    status.className = "file-status";
    status.textContent = file.status.trim() || "?";
    const name = document.createElement("span");
    name.className = "file-path";
    name.textContent = file.displayPath || file.path;
    row.append(status, name);
    row.addEventListener("click", () => showDiff(file.path));
    content.append(row);
  }
}

async function showDiff(file) {
  setView("changes");
  $("diff-title").textContent = file;
  $("diff-content").textContent = "正在载入差异…";
  $("diff-view").classList.remove("hidden");
  try {
    const result = await api(`/api/diff?file=${encodeURIComponent(file)}`);
    $("diff-content").textContent = result.diff || "这个文件尚未加入 Git，或没有可显示的文本差异。";
  } catch (error) { $("diff-content").textContent = error.message; }
}

let viewRequest = 0;
async function setView(view) {
  const request = ++viewRequest;
  if (state.view === "whiteboard" && view !== "whiteboard") {
    if (!await whiteboardUI.beforeLeave() || request !== viewRequest) return false;
  }
  if (view !== state.view) { composeContext++; clearTaskConflict(); }
  if (view !== state.view) voiceUI.stopDictation();
  state.view = view;
  workspaceFiles.setView(view);
  composerTools.close();
  const pluginView = ["plugins", "skills", "agents", "mcp"].includes(view);
  const customizing = pluginView || view === "teams" || view === "power-settings";
  const feature = ["schedules", "library", "memory"].includes(view);
  document.querySelector(".main-area").classList.toggle("home-active", view === "tasks");
  $("sidebar").classList.toggle("hidden", customizing || feature || view === "settings" || view === "visualization" || view === "whiteboard");
  document.querySelector(".main-area").classList.toggle("visualization-active", view === "visualization");
  document.querySelector(".main-area").classList.toggle("cloudtv-active", view === "cloudtv");
  document.querySelector(".main-area").classList.toggle("whiteboard-active", view === "whiteboard");
  $("cloudtv-entry").classList.toggle("selected", view === "cloudtv");
  if (view === "cloudtv") $("cloudtv-entry").setAttribute("aria-current", "page");
  else $("cloudtv-entry").removeAttribute("aria-current");
  $("customize-sidebar").classList.toggle("hidden", !customizing);
  $("feature-sidebar").classList.toggle("hidden", !feature);
  document.querySelector(".main-area").classList.toggle("customizing", customizing);
  document.querySelector(".main-area").classList.toggle("feature-active", feature);
  if (feature) {
    $("feature-sidebar-title").textContent = ({ schedules: "定时任务", library: "资料空间", memory: "记忆管理" })[view];
    for (const name of ["schedules", "library", "memory"]) $("feature-" + name + "-nav").classList.toggle("hidden", name !== view);
  }
  $("home-view").classList.toggle("hidden", view !== "tasks");
  $("thread-view").classList.toggle("hidden", view !== "thread");
  $("changes-view").classList.toggle("hidden", view !== "changes");
  $("about-view").classList.toggle("hidden", view !== "about");
  $("library-view").classList.toggle("hidden", view !== "library");
  $("memory-view").classList.toggle("hidden", view !== "memory");
  $("schedules-view").classList.toggle("hidden", view !== "schedules");
  $("plugins-view").classList.toggle("hidden", view !== "plugins");
  $("skills-view").classList.toggle("hidden", view !== "skills");
  $("agents-view").classList.toggle("hidden", view !== "agents");
  $("mcp-view").classList.toggle("hidden", view !== "mcp");
  $("power-settings-view").classList.toggle("hidden", view !== "power-settings");
  $("settings-view").classList.toggle("hidden", view !== "settings");
  $("teams-view").classList.toggle("hidden", view !== "teams");
  $("visualization-view").classList.toggle("hidden", view !== "visualization");
  $("cloudtv-view").classList.toggle("hidden", view !== "cloudtv");
  $("whiteboard-view").classList.toggle("hidden", view !== "whiteboard");
  $("header-title").textContent = view === "thread" ? $("thread-title").textContent : ({ tasks: "任务", changes: "代码更改", about: "关于工作区", library: "资料空间", memory: "记忆管理", schedules: "定时任务", plugins: "Plugins", skills: "Skills", agents: "Agents", mcp: "MCP 服务", teams: "Agent Teams", settings: "设置", "power-settings": "软件权限设置" })[view];
  document.querySelectorAll(".rail-button[data-view]").forEach((item) => item.classList.toggle("selected", item.dataset.view === (view === "thread" ? "tasks" : customizing ? "plugins" : view)));
  $("customize-search").classList.toggle("hidden", !pluginView);
  $("sidebar").classList.remove("open");
  $("customize-sidebar").classList.remove("open");
  $("feature-sidebar").classList.remove("open");
  if (view === "tasks") history.replaceState(null, "", projectUrl());
  else if (view !== "thread") history.replaceState(null, "", projectUrl({ view }));
  if (pluginView) void pluginUI.open(view);
  if (view === "settings" || (customizing && !pluginView)) void customizationUI.open(view);
  if (customizing && !pluginView) document.querySelectorAll(".customize-nav-item").forEach((item) => item.classList.toggle("selected", item.dataset.customizeView === view));
  if (view === "library") void libraryUI.open();
  if (view === "memory") void memoryUI.open();
  if (view === "schedules") void schedulesUI.open();
  if (view === "visualization") { $("header-title").textContent = "数据可视化"; void visualizationUI.open(); }
  if (view === "cloudtv") { $("header-title").textContent = "cloudTV"; cloudTVUI.open(); }
  if (view === "whiteboard") { $("header-title").textContent = "画布 · Excalidraw"; void whiteboardUI.open(); }
  return true;
}

function setComposeMode(mode) {
  state.composeMode = mode;
  if (mode === "chat") $("home-mode").value = "default";
  $("home-view").dataset.composeMode = mode;
  $("home-greeting").textContent = mode === "chat" ? "今天想聊点什么？" : "我们要做什么？";
  $("home-input").placeholder = mode === "chat" ? "询问 CCAGENT" : "和 CCAGENT 一起工作";
  for (const value of ["chat", "work"]) {
    const button = $(value === "chat" ? "surface-chat" : "surface-work");
    button.classList.toggle("selected", value === mode);
    button.setAttribute("aria-pressed", String(value === mode));
  }
}

function messageText(message) {
  if (typeof message.content === "string") return message.content;
  return (message.content || []).filter((block) => block.type === "text").map((block) => block.text).join("\n");
}

function appendTimeline(row) {
  $("timeline").insertBefore(row, $("thread-progress"));
}

function addUser(text) {
  const node = document.createElement("div");
  node.className = "message user";
  node.textContent = text;
  appendTimeline(node);
  if (state.execution && !state.execution.completedAt) {
    ensureExecutionNode(node);
    // An SSE connection can snapshot turn_started before the user message is persisted.
    // Keep that turn's activity header below its own user bubble when the message arrives.
    node.after(state.executionNode);
  }
  scrollTimeline();
}

// Model output is untrusted. Build nodes from text instead of inserting its HTML.
async function copyReply(text, button) {
  try {
    await navigator.clipboard.writeText(text);
    const previous = button.textContent;
    button.textContent = "已复制";
    setTimeout(() => { button.textContent = previous; }, 1800);
  } catch { toast("复制失败，请检查浏览器剪贴板权限"); }
}

const artifactExtension = /\.(?:md|txt|pdf|docx|pptx|xlsx|csv|html|xmind|png|jpe?g|webp)$/i;

function normalizeArtifactPath(value) {
  const raw = value.trim().replace(/^<|>$/g, "").replaceAll("\\", "/");
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(raw) || !artifactExtension.test(raw)) return null;
  const root = state.workspace.replaceAll("\\", "/").replace(/\/$/, "");
  const relative = root && raw.toLowerCase().startsWith(`${root.toLowerCase()}/`) ? raw.slice(root.length + 1) : raw;
  if (/^(?:[a-z]:\/|\/)/i.test(relative) || relative.split("/").includes("..")) return null;
  return relative.replace(/^\.\//, "");
}

function appendLink(parent, label, destination, artifacts) {
  const target = destination.trim().replace(/^<|>$/g, "").replace(/\s+"[^"]*"$/, "");
  let webUrl = null;
  try {
    const parsed = new URL(target);
    if (["http:", "https:"].includes(parsed.protocol)) webUrl = parsed.href;
  } catch { /* A relative workspace file may be a document link. */ }
  const artifact = webUrl ? null : normalizeArtifactPath(target);
  if (!webUrl && !artifact) {
    parent.append(document.createTextNode(label));
    return;
  }
  const link = document.createElement("button");
  link.type = "button";
  link.className = artifact ? "message-artifact-link" : "message-link";
  link.textContent = label;
  link.title = artifact ? `在资料空间查找 ${artifact}` : `在侧栏打开 ${webUrl}`;
  link.addEventListener("click", () => {
    if (artifact) {
      setView("library");
      void libraryUI.openPath(artifact);
    } else void browserUI.open(webUrl);
  });
  if (artifact) artifacts?.add(artifact);
  parent.append(link);
}

function appendInline(parent, source, artifacts, depth = 0) {
  if (depth > 5) { parent.append(document.createTextNode(source)); return; }
  let plain = "";
  const flush = () => { if (plain) parent.append(document.createTextNode(plain)); plain = ""; };
  for (let i = 0; i < source.length;) {
    if (source[i] === "\\" && i + 1 < source.length && /[\\`*_~!\[\]()]/.test(source[i + 1])) {
      plain += source[i + 1]; i += 2; continue;
    }
    if (source[i] === "`") {
      const marker = /^`+/.exec(source.slice(i))[0];
      const end = source.indexOf(marker, i + marker.length);
      if (end > i) {
        flush();
        const code = document.createElement("code");
        code.textContent = source.slice(i + marker.length, end).replace(/^ | $/g, "");
        parent.append(code);
        i = end + marker.length; continue;
      }
    }
    const image = source.startsWith("![", i);
    if (source[i] === "[" || image) {
      const labelStart = i + (image ? 2 : 1);
      const endLabel = source.indexOf("](", labelStart);
      let endTarget = -1;
      if (endLabel >= 0) {
        let nested = 0;
        for (let cursor = endLabel + 2; cursor < source.length; cursor++) {
          if (source[cursor] === "(" && source[cursor - 1] !== "\\") nested++;
          if (source[cursor] === ")" && source[cursor - 1] !== "\\" && nested-- === 0) { endTarget = cursor; break; }
        }
      }
      if (endLabel >= 0 && endTarget >= 0) {
        flush();
        const label = source.slice(labelStart, endLabel);
        appendLink(parent, image ? `图片：${label}` : label, source.slice(endLabel + 2, endTarget), artifacts);
        i = endTarget + 1; continue;
      }
    }
    const url = source[i].toLowerCase() === "h" ? /^https?:\/\/[^\s<>()]+/i.exec(source.slice(i)) : null;
    if (url) {
      flush();
      const clean = url[0].replace(/[.,;!?，。；！？]+$/, "");
      appendLink(parent, clean, clean, artifacts);
      plain += url[0].slice(clean.length);
      i += url[0].length; continue;
    }
    let formatted = false;
    for (const [marker, tag] of [["**", "strong"], ["__", "strong"], ["~~", "del"], ["*", "em"], ["_", "em"]]) {
      if (!source.startsWith(marker, i) || source[i + marker.length] === " ") continue;
      const end = source.indexOf(marker, i + marker.length);
      if (end <= i + marker.length) continue;
      flush();
      const node = document.createElement(tag);
      appendInline(node, source.slice(i + marker.length, end), artifacts, depth + 1);
      parent.append(node);
      i = end + marker.length;
      formatted = true;
      break;
    }
    if (formatted) continue;
    plain += source[i++];
  }
  flush();
}

function listMatch(line) { return /^(\s{0,8})([-*+]\s+|\d+[.)]\s+)(.*)$/.exec(line); }
function tableCells(line) { return line.trim().replace(/^\||\|$/g, "").split(/(?<!\\)\|/).map((cell) => cell.trim().replaceAll("\\|", "|")); }
function isTableDivider(line) { return /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line); }
function isMarkdownBlock(line) { return /^\s{0,3}(?:#{1,6}\s|```|~~~|>\s?|(?:[-*_]\s*){3,}$)/.test(line) || !!listMatch(line); }

function appendMarkdown(parent, source, artifacts, depth = 0) {
  if (depth > 4) { parent.textContent = source; return; }
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const fence = /^\s{0,3}(`{3,}|~{3,})\s*([\w#+.-]*)/.exec(line);
    if (fence) {
      const codeLines = [];
      i++;
      const close = new RegExp(`^\\s{0,3}${fence[1][0]}{${fence[1].length},}\\s*$`);
      while (i < lines.length && !close.test(lines[i])) codeLines.push(lines[i++]);
      if (i < lines.length) i++;
      const box = document.createElement("div"); box.className = "assistant-code-block";
      const bar = document.createElement("div"); bar.className = "assistant-code-bar";
      const language = document.createElement("span"); language.textContent = fence[2] || "代码";
      const copy = document.createElement("button"); copy.type = "button"; copy.textContent = "复制代码";
      const codeText = codeLines.join("\n");
      copy.addEventListener("click", () => void copyReply(codeText, copy));
      bar.append(language, copy);
      const pre = document.createElement("pre"); const code = document.createElement("code"); code.textContent = codeText;
      pre.append(code); box.append(bar, pre); parent.append(box);
      continue;
    }
    const heading = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      const node = document.createElement(`h${Math.min(heading[1].length + 1, 6)}`);
      if (/^(?:已完成|交付|成果|结果|验证|下一步)/.test(heading[2])) node.className = "assistant-result-heading";
      appendInline(node, heading[2], artifacts); parent.append(node); i++; continue;
    }
    if (/^\s{0,3}(?:[-*_]\s*){3,}$/.test(line)) { parent.append(document.createElement("hr")); i++; continue; }
    if (/^\s{0,3}>/.test(line)) {
      const quoted = [];
      while (i < lines.length && /^\s{0,3}>/.test(lines[i])) quoted.push(lines[i++].replace(/^\s{0,3}>\s?/, ""));
      const block = document.createElement("blockquote"); appendMarkdown(block, quoted.join("\n"), artifacts, depth + 1); parent.append(block); continue;
    }
    if (i + 1 < lines.length && line.includes("|") && isTableDivider(lines[i + 1])) {
      const headers = tableCells(line);
      const wrapper = document.createElement("div"); wrapper.className = "assistant-table-scroll";
      const table = document.createElement("table"); const thead = document.createElement("thead"); const tr = document.createElement("tr");
      for (const cell of headers) { const th = document.createElement("th"); appendInline(th, cell, artifacts); tr.append(th); }
      thead.append(tr); table.append(thead); i += 2;
      const tbody = document.createElement("tbody");
      while (i < lines.length && lines[i].trim() && lines[i].includes("|")) {
        const row = document.createElement("tr");
        for (const cell of tableCells(lines[i++]).slice(0, headers.length)) { const td = document.createElement("td"); appendInline(td, cell, artifacts); row.append(td); }
        tbody.append(row);
      }
      table.append(tbody); wrapper.append(table); parent.append(wrapper); continue;
    }
    const first = listMatch(line);
    if (first) {
      const baseIndent = first[1].length;
      const ordered = /^\d/.test(first[2]);
      const list = document.createElement(ordered ? "ol" : "ul");
      if (ordered) list.start = Number.parseInt(first[2], 10);
      let item = null;
      while (i < lines.length) {
        const match = listMatch(lines[i]);
        if (!match || match[1].length < baseIndent) break;
        if (match[1].length > baseIndent) {
          const nested = [];
          while (i < lines.length && listMatch(lines[i])?.[1].length > baseIndent) nested.push(lines[i++].slice(baseIndent + 2));
          if (item) appendMarkdown(item, nested.join("\n"), artifacts, depth + 1);
          continue;
        }
        if (/^\d/.test(match[2]) !== ordered) break;
        item = document.createElement("li");
        const task = /^\[([ xX])\]\s+/.exec(match[3]);
        if (task) {
          const checkbox = document.createElement("input"); checkbox.type = "checkbox"; checkbox.disabled = true; checkbox.checked = task[1].toLowerCase() === "x";
          checkbox.setAttribute("aria-label", checkbox.checked ? "已完成" : "未完成");
          item.className = "assistant-task-item"; item.append(checkbox);
        }
        appendInline(item, task ? match[3].slice(task[0].length) : match[3], artifacts); list.append(item); i++;
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !listMatch(lines[i])) {
          item.append(document.createElement("br")); appendInline(item, lines[i++].trim(), artifacts);
        }
      }
      parent.append(list); continue;
    }
    const paragraph = [];
    while (i < lines.length && lines[i].trim() && (!paragraph.length || !(isMarkdownBlock(lines[i]) || (i + 1 < lines.length && lines[i].includes("|") && isTableDivider(lines[i + 1]))))) paragraph.push(lines[i++]);
    const node = document.createElement("p");
    paragraph.forEach((part, index) => { if (index) node.append(document.createElement("br")); appendInline(node, part.trim(), artifacts); });
    parent.append(node);
  }
}

async function appendArtifactSummary(body, paths) {
  const epoch = workspaceEpoch;
  const found = [];
  for (const path of [...paths].slice(0, 5)) {
    if (epoch !== workspaceEpoch || !body.isConnected) return;
    try {
      const name = path.split("/").pop();
      const result = await api(`/api/library?kind=all&query=${encodeURIComponent(name)}`);
      const file = result.files.find((item) => item.path.toLowerCase() === path.toLowerCase());
      if (file) found.push(file);
    } catch { /* The reply remains readable while the library is unavailable. */ }
  }
  if (!found.length || !body.isConnected) return;
  const section = document.createElement("div"); section.className = "assistant-artifacts";
  const heading = document.createElement("strong"); heading.textContent = "成果文件"; section.append(heading);
  for (const file of found) {
    const button = document.createElement("button"); button.type = "button"; button.className = "assistant-artifact";
    const icon = folderIcon();
    const name = document.createElement("span"); name.textContent = file.name;
    const kind = document.createElement("small"); kind.textContent = file.kind;
    button.append(icon, name, kind);
    button.addEventListener("click", () => { setView("library"); void libraryUI.openPath(file.path); });
    section.append(button);
  }
  body.append(section);
}

function addAssistant(text) {
  if (!text.trim()) return;
  const row = document.createElement("div"); row.className = "message assistant";
  const avatar = document.createElement("span"); avatar.className = "message-avatar"; avatar.textContent = "✦"; avatar.setAttribute("aria-hidden", "true");
  const content = document.createElement("div"); content.className = "assistant-content";
  const body = document.createElement("div"); body.className = "assistant-body";
  const artifacts = new Set();
  appendMarkdown(body, text, artifacts);
  for (const match of text.matchAll(/`([^`\n]{1,260})`/g)) {
    const path = normalizeArtifactPath(match[1]);
    if (path) artifacts.add(path);
  }
  const actions = document.createElement("div"); actions.className = "assistant-actions";
  const copy = document.createElement("button"); copy.type = "button"; copy.textContent = "复制回复"; copy.title = "复制完整回复";
  copy.addEventListener("click", () => void copyReply(text, copy)); actions.append(copy);
  content.append(body, actions); row.append(avatar, content); appendTimeline(row);
  if (artifacts.size) void appendArtifactSummary(body, artifacts);
  scrollTimeline();
}

function addModelFile(file) {
  const sessionId = state.sessionId;
  if (!file || !/^[0-9a-f-]{36}$/i.test(file.id) || typeof file.path !== "string" || typeof file.name !== "string"
    || file.openUrl !== `/api/sessions/${sessionId}/model-files/${file.id}/open`) return;
  if ($("timeline").querySelector(`[data-model-file="${file.id}"]`)) return;
  const row = document.createElement("div"); row.className = "message assistant model-file-message"; row.dataset.modelFile = file.id;
  const card = document.createElement("div"); card.className = "model-file-card";
  const heading = document.createElement("strong"); heading.textContent = "模型文件已保存";
  const link = document.createElement("button"); link.type = "button"; link.className = "model-file-open";
  link.title = `打开 ${file.path}`;
  const name = document.createElement("span"); name.className = "model-file-name"; name.textContent = file.name;
  const address = document.createElement("span"); address.className = "model-file-path"; address.textContent = file.path;
  const hint = document.createElement("small"); hint.textContent = "点击文件名或地址，在本机打开模型";
  link.append(folderIcon(), name, address, hint);
  link.addEventListener("click", async () => {
    if (state.sessionId !== sessionId || link.disabled) return;
    link.disabled = true;
    try { await api(file.openUrl, { method: "POST" }); toast("已发送打开请求，请查看 Rhino 窗口"); }
    catch (error) { toast(error.message); }
    finally { link.disabled = false; }
  });
  const copy = document.createElement("button"); copy.type = "button"; copy.className = "model-file-copy"; copy.textContent = "复制保存地址";
  copy.addEventListener("click", () => void copyReply(file.path, copy));
  card.append(heading, link, copy); row.append(card); appendTimeline(row);
}

const toolLabels = {
  Read: "读取文件", ReadImage: "查看图片", Glob: "查找文件", Grep: "搜索文件内容",
  Write: "写入文件", Edit: "编辑文件", MultiEdit: "编辑文件", Bash: "执行命令",
  WebSearch: "搜索网页", WebFetch: "读取网页", Task: "调用 Agent", Agent: "调用 Agent",
  WhiteboardRead: "读取画布", WhiteboardDraw: "绘制画布", AskUserQuestion: "询问用户",
};

function toolLabel(name) { return toolLabels[name] || "调用工具"; }

function toolIcon(name) {
  if (["Read", "Write", "Edit", "MultiEdit"].includes(name)) return folderIcon();
  const paths = /Search|Grep|Glob|Fetch/.test(name)
    ? ["M21 21l-4.3-4.3", "M19 10.5a8.5 8.5 0 1 1-17 0 8.5 8.5 0 0 1 17 0"]
    : /Bash|Shell|Terminal/.test(name) ? ["M4 5h16v14H4z", "m8 9 3 3-3 3", "M13 15h3"]
    : /Edit|Write|Draw/.test(name) ? ["m15 5 4 4", "m4 16-1 5 5-1L21 7a2.8 2.8 0 0 0-4-4Z"]
    : ["M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z", "M14 2v6h6", "M8 13h8", "M8 17h5"];
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  for (const d of paths) {
    const path = document.createElementNS(svg.namespaceURI, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

function addTool(id, name, status = "调用中") {
  if (id && state.toolNodes.has(id)) return state.toolNodes.get(id);
  const row = document.createElement("div");
  row.className = "tool-card";
  const icon = document.createElement("span");
  icon.className = "tool-icon";
  icon.append(toolIcon(name));
  const title = document.createElement("strong");
  title.textContent = toolLabel(name);
  const toolName = document.createElement("span");
  toolName.className = "tool-name";
  toolName.textContent = name === "BrowserSearch" ? "Jev Browser Search" : name;
  const stateLabel = document.createElement("span");
  stateLabel.className = "tool-state";
  stateLabel.textContent = status;
  row.append(icon, title, toolName, stateLabel);
  appendTimeline(row);
  if (id) state.toolNodes.set(id, row);
  scrollTimeline();
  return row;
}

function toolResultDetail(row, detail) {
  row.querySelector(".tool-detail")?.remove();
  if (!detail) return;
  const disclosure = document.createElement("details"); disclosure.className = "tool-detail";
  const summary = document.createElement("summary"); summary.textContent = "查看原因";
  const content = document.createElement("pre"); content.textContent = detail.slice(0, 2500);
  disclosure.append(summary, content); row.append(disclosure);
}

function updateTool(tool) {
  const status = tool.completedAt ? tool.outcome === "handoff" ? "已暂停" : tool.isError ? "失败" : "已完成"
    : state.execution?.completedAt ? tool.phase === "preparing" ? "未执行" : state.execution.reason === "aborted" ? "已停止" : "结果待确认"
    : tool.phase === "preparing" ? "准备调用" : "调用中";
  const row = addTool(tool.id, tool.name, status);
  row.querySelector(".tool-state").textContent = status;
  row.classList.toggle("error", (Boolean(tool.isError) && tool.outcome !== "handoff") || status === "结果待确认");
  row.classList.toggle("tool-running", status === "调用中" || status === "准备调用");
  toolResultDetail(row, tool.detail);
}

function executionTime(value) {
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function elapsedLabel(milliseconds) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds >= 3600) return `${Math.floor(seconds / 3600)}小时 ${Math.floor(seconds % 3600 / 60)}分 ${seconds % 60}秒`;
  if (seconds >= 60) return `${Math.floor(seconds / 60)}分 ${seconds % 60}秒`;
  return `${seconds}秒`;
}

function ensureExecutionNode(after) {
  if (!state.execution || state.executionNode) return;
  const row = document.createElement("div");
  row.className = "turn-activity";
  row.setAttribute("aria-live", "off");
  row.dataset.turnId = state.execution.id;
  const elapsed = document.createElement("span");
  elapsed.className = "turn-elapsed";
  const status = document.createElement("span");
  status.className = "turn-outcome";
  row.append(elapsed, status);
  if (after) after.after(row);
  else appendTimeline(row);
  state.executionNode = row;
  syncExecutionClock();
}

function syncExecutionClock() {
  const execution = state.execution;
  if (!execution || !state.executionNode) return;
  const start = executionTime(execution.startedAt);
  const end = executionTime(execution.completedAt);
  state.executionNode.querySelector(".turn-elapsed").textContent = start === null ? "本轮执行" : `已处理 ${elapsedLabel((end ?? Date.now() + state.serverClockOffset) - start)}`;
  const terminal = { aborted: "已停止", completed: "已完成", max_turns: "已达轮数上限", model_error: "模型回复中断" };
  state.executionNode.querySelector(".turn-outcome").textContent = execution.completedAt ? terminal[execution.reason] || "执行失败" : "执行中";
  state.executionNode.classList.toggle("turn-active", !execution.completedAt);
}

function restoreExecution(execution, serverTime) {
  clearInterval(state.executionTimer);
  state.executionTimer = null;
  state.execution = execution ? { ...execution, tools: [...(execution.tools || [])] } : null;
  const server = executionTime(serverTime);
  if (server !== null) state.serverClockOffset = server - Date.now();
  if (!execution) {
    if (state.executionNode?.classList.contains("turn-active")) {
      state.executionNode.classList.remove("turn-active");
      state.executionNode.querySelector(".turn-outcome").textContent = "未完成";
    }
    state.executionNode = null;
    return;
  }
  if (state.executionNode?.dataset.turnId !== execution.id) state.executionNode = null;
  if (!state.executionNode) ensureExecutionNode([...$("timeline").querySelectorAll(".message.user")].at(-1));
  for (const tool of state.execution.tools) updateTool(tool);
  syncExecutionClock();
  if (!execution.completedAt) state.executionTimer = setInterval(syncExecutionClock, 1000);
}

function addNotice(message, error = false) {
  const row = document.createElement("div");
  row.className = `notice-line${error ? " error" : ""}`;
  row.textContent = message;
  appendTimeline(row);
  scrollTimeline();
}

function scrollTimeline() { const timeline = $("timeline"); timeline.scrollTop = timeline.scrollHeight; }

function clearStream() {
  clearTimeout(streamFlushTimer);
  streamFlushTimer = null;
  streamPendingText = "";
  streamTextNode = null;
  state.streamNode?.remove();
  state.streamNode = null;
  syncThreadProgress();
}

function flushStream() {
  clearTimeout(streamFlushTimer);
  streamFlushTimer = null;
  if (!streamPendingText || !streamTextNode || !state.streamNode) return;
  streamTextNode.appendData(streamPendingText);
  streamPendingText = "";
  syncThreadProgress();
  scrollTimeline();
}

function finishStream() {
  // An interrupted stream may have no assistant_message event. Preserve all
  // received text, including the final unpainted batch, as a normal reply.
  const text = (streamTextNode?.data || "") + streamPendingText;
  clearStream();
  if (text) addAssistant(text);
}

function appendStream(text) {
  if (!text) return;
  if (!state.streamNode) {
    const row = document.createElement("div");
    row.className = "message assistant streaming";
    const avatar = document.createElement("span");
    avatar.className = "message-avatar";
    avatar.textContent = "✦";
    const body = document.createElement("div");
    body.className = "assistant-body";
    streamTextNode = document.createTextNode(text);
    body.append(streamTextNode);
    row.append(avatar, body);
    appendTimeline(row);
    state.streamNode = row;
    // Show the first chunk immediately; coalesce later chunks like the CLI.
    syncThreadProgress();
    scrollTimeline();
  } else {
    // Keep the deferred buffer bounded even when timers are throttled in a
    // background tab. Large individual chunks can go straight into the node.
    if (streamPendingText.length + text.length >= MAX_STREAM_BUFFER_CHARS) flushStream();
    if (text.length >= MAX_STREAM_BUFFER_CHARS) {
      streamTextNode.appendData(text);
      syncThreadProgress();
      scrollTimeline();
    } else streamPendingText += text;
  }
  if (streamFlushTimer === null) streamFlushTimer = setTimeout(flushStream, STREAM_FLUSH_MS);
}

function renderStoredMessages(messages) {
  clearInterval(state.executionTimer);
  state.executionTimer = null;
  state.execution = null;
  state.executionNode = null;
  $("timeline").replaceChildren($("thread-progress"));
  clearStream();
  state.toolNodes.clear();
  for (const message of messages) {
    if (message.role === "user") {
      if (Array.isArray(message.content)) {
        for (const block of message.content) {
          if (block.type !== "tool_result") continue;
          const row = state.toolNodes.get(block.tool_use_id);
          if (row) {
            let handoff = false, detail = typeof block.content === "string" ? block.content : "";
            if (row.querySelector(".tool-name")?.textContent === "RhinoSequence") {
              try { const report = JSON.parse(detail); handoff = report.status === "handoff"; if (handoff && typeof report.reason === "string") detail = report.reason; } catch { /* Ordinary tool error. */ }
            }
            row.querySelector(".tool-state").textContent = handoff ? "已暂停" : block.is_error ? "失败" : "已完成";
            row.classList.toggle("error", Boolean(block.is_error) && !handoff);
            if (block.is_error) toolResultDetail(row, detail);
          }
        }
      }
      const text = messageText(message);
      if (text.trim()) {
        state.toolNodes.clear();
        addUser(text);
      }
      continue;
    }
    if (message.role !== "assistant") continue;
    const text = messageText(message);
    if (text) addAssistant(text);
    if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block.type === "tool_use") addTool(block.id, block.name, "结果未记录");
      }
    }
  }
}

function syncThreadProgress() {
  const terminal = { model_error: "模型回复中断，已完成的操作已保留", error: "本轮中断，请核对已完成的操作后继续", aborted: "已停止", max_turns: "已达执行轮数上限", incomplete: "上次执行未完成，请核对执行记录" };
  const activeTools = (state.execution?.tools || []).filter((tool) => !tool.completedAt);
  const tools = activeTools.slice(0, 2).map((tool) => `${toolLabel(tool.name)} · ${tool.name}`).join("、");
  const current = state.pending ? state.pending.kind === "question" ? "等待你的回答" : "等待你的批准"
    : activeTools.length ? `${activeTools.every(tool => tool.phase === "preparing") ? "准备调用" : "正在调用"}：${tools}${activeTools.length > 2 ? ` 等 ${activeTools.length} 项工具` : ""}`
    : state.streamNode ? "正在生成回复" : state.execution?.tools.length ? "正在整理结果" : "Thinking";
  const text = state.busy ? current : terminal[state.lastTurnReason] || "";
  $("thread-status-label").textContent = text;
  $("thread-progress").classList.toggle("hidden", !text);
  $("thread-status-dot").classList.toggle("busy", state.busy && Boolean(text));
  $("thread-status-dot").classList.toggle("hidden", !state.busy);
  syncExecutionClock();
}

function setBusy(busy) {
  if (busy) voiceUI.stopDictation();
  state.busy = busy;
  customizationUI.syncBusy(busy);
  if (busy) state.lastTurnReason = null;
  syncThreadProgress();
  if (busy) scrollTimeline();
  $("stop-button").classList.toggle("hidden", !busy);
  $("thread-send").disabled = busy;
  $("thread-input").disabled = busy;
  $("thread-model-select").disabled = busy || !state.availableModels.some((item) => item.available);
  $("thread-mode-select").disabled = busy;
  for (const id of ["home-effort", "thread-effort", "thread-dictate"]) $(id).disabled = busy;
  composerTools.sync();
  renderActivity();
}

function modelLabel(id) {
  return state.availableModels.find((item) => item.id === id)?.label || id;
}

function syncModelSelectors() {
  for (const id of ["home-model", "thread-model-select"]) {
    const select = $(id);
    select.replaceChildren();
    for (const item of state.availableModels) {
      const option = document.createElement("option");
      option.value = item.id;
      option.textContent = item.available ? item.label : `${item.label}（未配置）`;
      option.disabled = !item.available;
      select.append(option);
    }
    const selected = id === "home-model" ? state.selectedModel : state.model;
    if (selected && !state.availableModels.some((item) => item.id === selected)) {
      const option = document.createElement("option");
      option.value = selected;
      option.textContent = selected.startsWith("ccagent:") ? "原官方模型不可用，请更新服务或手动选择模型" : `${selected}（此会话）`;
      option.disabled = true;
      select.append(option);
    }
    select.value = selected;
    if (!select.value && state.availableModels.some((item) => item.available)) {
      select.value = state.availableModels.find((item) => item.available).id;
    }
    select.disabled = !state.availableModels.some((item) => item.available) || (id === "thread-model-select" && state.busy);
  }
  $("about-model").textContent = modelLabel(state.model || state.selectedModel);
  renderActivity();
}

async function refreshModels() {
  try {
    const data = await api("/api/models");
    state.availableModels = data.models.filter((item) => item.mainModelSelectable !== false);
    if (!state.selectedModel || !state.availableModels.some((item) => item.id === state.selectedModel && item.available)) {
      const requested = state.selectedModel || data.defaultModel;
      const auxiliary = data.models.some((item) => item.id === requested && item.mainModelSelectable === false);
      state.selectedModel = requested?.startsWith("ccagent:") && !auxiliary ? requested : state.availableModels.find((item) => item.id === data.defaultModel && item.available)?.id
        || state.availableModels.find((item) => item.available)?.id || "";
    }
    syncModelSelectors();
  } catch (error) { toast(`无法载入模型：${error.message}`); }
}

function showInteraction(pending) {
  state.pending = pending;
  syncThreadProgress();
  const request = pending.request;
  const question = pending.kind === "question";
  $("interaction-eyebrow").textContent = question ? "需要你的回答" : "需要你的批准";
  $("interaction-title").textContent = question ? "回答问题" : `允许 ${request.toolName}？`;
  $("interaction-summary").textContent = question ? "请逐项选择回答。" : request.summary;
  $("interaction-detail").textContent = question ? "" : JSON.stringify(request.input, null, 2);
  $("interaction-detail").classList.toggle("hidden", question);
  $("interaction-allow").textContent = question ? "提交回答" : "允许一次";
  $("interaction-deny").textContent = question ? "取消" : "拒绝";
  const options = $("question-options");
  options.replaceChildren();
  options.classList.toggle("hidden", !question);
  if (question) {
    for (const [index, item] of (request.questions || []).entries()) {
      const group = document.createElement("fieldset");
      group.className = "question-group";
      const heading = document.createElement("legend");
      heading.textContent = `${index + 1}. ${item.header ? `${item.header} · ` : ""}${item.question}`;
      group.append(heading);
      for (const option of item.options || []) {
        const label = document.createElement("label");
        const input = document.createElement("input");
        input.type = item.multiSelect ? "checkbox" : "radio";
        input.name = `question-${index}`;
        input.value = option.label;
        const text = document.createElement("span");
        text.textContent = option.description ? `${option.label} · ${option.description}` : option.label;
        label.append(input, text);
        group.append(label);
      }
      options.append(group);
    }
  }
  $("interaction-overlay").classList.remove("hidden");
}

async function answerInteraction(allow) {
  const pending = state.pending;
  if (!pending || !state.sessionId) return;
  let body;
  if (pending.kind === "permission") body = { id: pending.id, decision: allow ? "allow_once" : "deny" };
  else if (!allow) body = { id: pending.id, answers: null };
  else {
    const answers = {};
    for (const [index, item] of (pending.request.questions || []).entries()) {
      const checked = [...$("question-options").querySelectorAll(`input[name="question-${index}"]:checked`)].map((input) => input.value);
      if (!checked.length) return toast("请选择回答");
      answers[item.question] = checked.join(", ");
    }
    body = { id: pending.id, answers };
  }
  try {
    await api(`/api/sessions/${state.sessionId}/respond`, { method: "POST", body: JSON.stringify(body) });
    state.pending = null;
    syncThreadProgress();
    $("interaction-overlay").classList.add("hidden");
  } catch (error) { toast(error.message); }
}

function handleEvent(event) {
  voiceUI.handleEvent(event);
  browserUI.handleEvent(event);
  switch (event.type) {
    case "session_deleted":
      if (!deletingSessions.has(state.sessionId)) void onSessionDeleted(state.sessionId);
      break;
    case "turn_started":
      finishStream();
      clearInterval(state.executionTimer);
      state.toolNodes.clear();
      state.executionNode = null;
      state.execution = { id: event.turnId || `live-${state.sessionId}`, startedAt: event.startedAt || event.timestamp, completedAt: null, reason: null, tools: [] };
      state.pending = null;
      ensureExecutionNode();
      state.executionTimer = setInterval(syncExecutionClock, 1000);
      setBusy(true);
      break;
    case "user": addUser(event.text); break;
    case "text": appendStream(event.text); break;
    case "stream_restart": clearStream(); break;
    case "assistant": clearStream(); addAssistant(messageText(event.message)); break;
    case "model_file": addModelFile(event.file); scrollTimeline(); break;
    case "model": state.model = event.model; syncModelSelectors(); break;
    case "mode": state.mode = event.mode; $("thread-mode-select").value = event.mode; break;
    case "team": customizationUI.setSessionTeam(event.team); break;
    case "tool_preparing":
    case "tool_start": {
      if (state.execution && !state.execution.tools.some((tool) => tool.id === event.id)) state.execution.tools.push({ id: event.id, name: event.name, startedAt: event.timestamp, completedAt: null });
      const tool = state.execution?.tools.find((tool) => tool.id === event.id);
      if (tool) tool.phase = event.type === "tool_preparing" ? "preparing" : "running";
      if (tool) updateTool(tool);
      else addTool(event.id, event.name, event.type === "tool_preparing" ? "准备调用" : "调用中");
      syncThreadProgress();
      break;
    }
    case "tool_done": {
      const tool = state.execution?.tools.find((tool) => tool.id === event.id);
      if (tool) { tool.completedAt = event.timestamp || new Date(Date.now() + state.serverClockOffset).toISOString(); tool.isError = event.isError; tool.outcome = event.outcome; tool.detail = event.detail; updateTool(tool); }
      const row = state.toolNodes.get(event.id);
      if (row) {
        row.querySelector(".tool-state").textContent = event.outcome === "handoff" ? "已暂停" : event.isError ? "失败" : "已完成";
        row.classList.toggle("error", Boolean(event.isError) && event.outcome !== "handoff");
        row.classList.remove("tool-running");
        if (!tool) toolResultDetail(row, event.detail);
      }
      syncThreadProgress();
      break;
    }
    case "notice": addNotice(event.message, event.tone === "error"); break;
    case "interaction": showInteraction(event); break;
    case "interaction_resolved": state.pending = null; $("interaction-overlay").classList.add("hidden"); syncThreadProgress(); break;
    case "session_snapshot_required":
      // A bounded event log cannot reconstruct missing replies or approvals.
      // Reload state without submitting a prompt or restarting the task.
      if (state.sessionId && !openingSession) void openSession(state.sessionId, undefined, true);
      break;
    case "execution_state":
      if (event.execution && state.execution && event.execution.id !== state.execution.id) {
        // The bounded replay buffer may omit a newer turn's start and user message.
        if (!openingSession) void openSession(state.sessionId, undefined, true);
        break;
      }
      restoreExecution(event.execution, event.serverTime);
      if (event.execution) { state.lastTurnReason = event.execution.reason; setBusy(!event.execution.completedAt); }
      else {
        if (state.busy) {
          state.lastTurnReason = "incomplete";
          state.pending = null;
          $("interaction-overlay").classList.add("hidden");
          for (const row of state.toolNodes.values()) {
            const label = row.querySelector(".tool-state");
            if (!["执行中", "调用中", "准备调用"].includes(label.textContent)) continue;
            label.textContent = label.textContent === "准备调用" ? "未执行" : "结果待确认";
            row.classList.remove("tool-running");
            row.classList.add("error");
          }
        }
        setBusy(false);
      }
      break;
    case "turn_complete":
      state.lastTurnReason = event.reason;
      clearInterval(state.executionTimer);
      state.executionTimer = null;
      if (state.execution) {
        state.execution.completedAt = event.completedAt || event.timestamp || new Date(Date.now() + state.serverClockOffset).toISOString();
        state.execution.reason = event.reason;
        for (const tool of state.execution.tools) updateTool(tool);
      }
      for (const row of state.toolNodes.values()) {
        const label = row.querySelector(".tool-state");
        if (["执行中", "调用中", "准备调用"].includes(label?.textContent)) { label.textContent = label.textContent === "准备调用" ? "未执行" : event.reason === "aborted" ? "已停止" : "结果待确认"; row.classList.toggle("error", label.textContent === "结果待确认"); row.classList.remove("tool-running"); }
      }
      state.pending = null;
      $("interaction-overlay").classList.add("hidden");
      finishStream(); setBusy(false); refreshSessions(); refreshChanges();
      if (event.reason && event.reason !== "completed") toast({ model_error: "模型回复中断，已完成的操作已保留", aborted: "已停止", max_turns: "已达执行轮数上限" }[event.reason] || "本轮执行中断，请查看执行记录");
      break;
  }
}

async function openSession(id, initialSnapshot, recovery = false) {
  if (deletingSessions.has(id)) return false;
  if (!recovery) { composeContext++; clearTaskConflict(); }
  const request = { id, recovery };
  const previousSource = state.source;
  clearTimeout(sessionRecoveryTimer);
  sessionRecoveryTimer = null;
  openingSession = request;
  try {
    if (!recovery && state.view === "whiteboard" && !await whiteboardUI.beforeLeave()) return false;
    if (openingSession !== request || deletingSessions.has(id)) return false;
    if (state.sessionId !== id) voiceUI.stop();
    if (!recovery) { state.source?.close(); state.source = null; }
    // Creation already returns the authoritative initial state. Reuse only a
    // matching snapshot; ordinary navigation/reconnect still reloads state.
    const data = initialSnapshot?.sessionId === id ? initialSnapshot : await api(`/api/sessions/${id}`);
    if (openingSession !== request || deletingSessions.has(id)) return false;
    previousSource?.close();
    state.source = null;
    sessionRecoveryAttempt = 0;
    state.sessionId = id;
    state.temporary = data.temporary === true;
    $("thread-view").classList.toggle("temporary-thread", state.temporary);
    $("thread-privacy").classList.toggle("hidden", !state.temporary);
    $("thread-composer-workspace").textContent = shortWorkspace();
    state.model = data.model;
    state.mode = data.mode;
    customizationUI.setSessionTeam(data.team);
    $("thread-mode-select").value = data.mode;
    syncModelSelectors();
    browserUI.restore(data.browserUrl);
    state.pending = null;
    $("interaction-overlay").classList.add("hidden");
    renderStoredMessages(data.messages);
    for (const file of data.modelFiles || []) addModelFile(file);
    restoreExecution(data.execution, data.serverTime);
    for (const notice of data.recentNotices || []) addNotice(notice.message, notice.tone === "error");
    const lastContent = data.messages.at(-1)?.content;
    state.lastTurnReason = data.lastTurnReason || (!data.busy && Array.isArray(lastContent) && lastContent.some((block) => block.type === "tool_use" || block.type === "tool_result") ? "incomplete" : null);
    setBusy(data.busy);
    if (data.pending) showInteraction(data.pending);
    if (!recovery && !await setView("thread")) return false;
    if (openingSession !== request || deletingSessions.has(id)) return false;
    if (!recovery) history.replaceState(null, "", projectUrl({ session: id }));
    renderSessions();
    const source = new EventSource(`/api/sessions/${id}/events?workspace=${encodeURIComponent(state.workspace)}&lastEventId=${data.lastEventId || 0}`);
    state.source = source;
    source.onmessage = (message) => {
      if (state.sessionId !== id || state.source !== source) return;
      try {
        const event = JSON.parse(message.data);
        if (!openingSession?.recovery || event.type === "session_deleted") handleEvent(event);
      } catch (error) { console.error(error); }
    };
    source.onerror = () => { if (state.source === source && !state.switchingWorkspace) toast("连接中断，正在重新连接…"); };
    if (!recovery) $("thread-input").focus();
    return true;
  } catch (error) {
    if (openingSession !== request) return false;
    if (recovery && error.status === 404) {
      await onSessionDeleted(id);
      return false;
    }
    if (recovery && state.sessionId === id && state.source === previousSource && (!error.status || error.status >= 500)) {
      // Keep EventSource's own reconnect alive while retrying the read-only
      // snapshot. Navigation/source changes cancel the delayed recovery.
      const delay = Math.min(5000, 250 * 2 ** Math.min(sessionRecoveryAttempt++, 5));
      sessionRecoveryTimer = setTimeout(() => {
        sessionRecoveryTimer = null;
        if (state.sessionId === id && state.source === previousSource && !openingSession && !deletingSessions.has(id)) void openSession(id, undefined, true);
      }, delay);
      toast("连接恢复中，正在重新读取任务状态…");
      return false;
    }
    if (new URLSearchParams(location.search).get("session") === id) history.replaceState(null, "", projectUrl());
    toast(error.message);
    return false;
  } finally {
    if (openingSession === request) openingSession = null;
  }
}

async function submit(text, mode) {
  if (state.switchingWorkspace) return false;
  const inputId = state.view === "thread" ? "thread-input" : "home-input";
  const input = composerTools.prepare(text.trim(), inputId);
  if (!input) return false;
  if (input.length > 50000) { toast("单条消息不能超过 50000 字符。"); return false; }
  const request = ++submitRequest;
  let context = composeContext;
  const current = () => request === submitRequest && context === composeContext;
  try {
    if (!state.sessionId || state.view !== "thread") {
      const created = await api("/api/sessions", { method: "POST", body: JSON.stringify({ mode, model: state.selectedModel || undefined, team: $("home-team").value }) });
      if (!current()) return false;
      state.sessionId = created.sessionId;
      if (!(await openSession(created.sessionId, created.snapshot))) return false;
      context = composeContext;
    }
    await api(`/api/sessions/${state.sessionId}/messages`, { method: "POST", body: JSON.stringify({ text: input }) });
    if (!current()) return false;
    clearTaskConflict();
    composerTools.clear(inputId);
    $("home-input").value = "";
    $("thread-input").value = "";
    composerTools.sync();
    return true;
  } catch (error) {
    if (!current()) return false;
    if (inputId === "home-input" && state.view === "thread") {
      composerTools.move("home-input", "thread-input");
      $("thread-input").value = text;
      $("home-input").value = "";
      composerTools.sync();
    }
    if (error.conflict) showTaskConflict(error.conflict);
    toast(error.message); return false;
  }
}

async function refreshSessions() {
  const request = ++sessionListRequest, epoch = workspaceEpoch;
  try {
    const data = await api("/api/bootstrap");
    if (request !== sessionListRequest) return;
    state.sessions = data.sessions;
    if (state.workspace && state.workspace !== data.workspace) composerTools.workspaceChanged();
    state.workspace = data.workspace;
    const whiteboardWorkspaceChanged = await whiteboardUI.workspaceChanged(state.workspace);
    if (request !== sessionListRequest || epoch !== workspaceEpoch) return;
    if (whiteboardWorkspaceChanged && state.view === "whiteboard") void whiteboardUI.open();
    const visualizationWorkspaceChanged = visualizationUI.workspaceChanged(state.workspace);
    if (visualizationWorkspaceChanged && state.view === "visualization") void visualizationUI.open();
    await workspaceFiles.workspaceChanged(state.workspace);
    if (request !== sessionListRequest || epoch !== workspaceEpoch) return;
    if (!state.sessionId) state.model = data.model;
    state.version = data.version;
    $("home-mode").value = data.defaultMode || "default";
    if (data.storageUnavailable && !state.storageWarningShown) {
      toast("会话目录暂时无法读取；当前进程中的对话仍可使用。");
      state.storageWarningShown = true;
    }
    if (!data.storageUnavailable) state.storageWarningShown = false;
    $("workspace-name").textContent = shortWorkspace();
    $("workspace-path").textContent = state.workspace;
    $("workspace-path").title = state.workspace;
    $("composer-workspace").textContent = shortWorkspace();
    $("workspace-project-name").textContent = shortWorkspace();
    $("hero-workspace").textContent = shortWorkspace();
    $("version-label").textContent = `v${state.version}`;
    $("about-workspace").textContent = state.workspace;
    $("about-model").textContent = modelLabel(state.model);
    $("about-version").textContent = `v${state.version}`;
    renderSessions();
  } catch (error) {
    if (error.code === "workspace_not_open" && state.workspace && request === sessionListRequest && epoch === workspaceEpoch) {
      // A saved project URL can outlive its account or directory. Recover only
      // bootstrap; ordinary operations must never fall through to another project.
      workspaceEpoch++;
      submitRequest++;
      clearOpenSession();
      state.workspace = "";
      state.sessions = [];
      state.changes = [];
      state.selectedModel = "";
      state.availableModels = [];
      state.model = "";
      workspaceSessions.clear();
      workspaceDrafts.clear();
      composerTools.workspaceChanged();
      $("home-input").value = "";
      $("thread-input").value = "";
      $("timeline").replaceChildren($("thread-progress"));
      $("diff-view").classList.add("hidden");
      renderSessions();
      renderChanges();
      // Preserve any unavailable whiteboard's local scene for later export.
      state.view = "tasks";
      await setView("tasks");
      await refreshSessions();
      if (!state.workspace) return;
      await Promise.all([refreshChanges(), refreshModels(), customizationUI.refreshTeams(), customizationUI.refreshPreferences()]);
      toast("原工作文件夹不可用，已返回默认项目，请重新选择工作文件夹。");
      return;
    }
    toast(`无法连接 CCAGENT Web：${error.message}`);
  }
}

async function refreshChanges() {
  try { state.changes = (await api("/api/changes")).files; renderChanges(); }
  catch (error) { toast(error.message); }
}

function clearOpenSession() {
  openingSession = null;
  clearTimeout(sessionRecoveryTimer);
  sessionRecoveryTimer = null;
  sessionRecoveryAttempt = 0;
  composeContext++;
  clearTaskConflict();
  clearStream();
  composerTools.clear("thread-input");
  voiceUI.stop();
  browserUI.restore(null);
  state.source?.close();
  state.source = null;
  clearInterval(state.executionTimer);
  state.executionTimer = null;
  state.execution = null;
  state.executionNode = null;
  state.sessionId = null;
  state.temporary = false;
  state.pending = null;
  $("interaction-overlay").classList.add("hidden");
  setBusy(false);
}

async function newTask() {
  if (state.view === "whiteboard" && !await setView("tasks")) return false;
  openingSession = null;
  clearOpenSession();
  history.replaceState(null, "", projectUrl());
  renderSessions();
  setView("tasks");
  $("home-input").focus();
  return true;
}

async function selectWorkspace(folder) {
  if (state.switchingWorkspace) return;
  state.switchingWorkspace = true;
  try {
    if (!await whiteboardUI.beforeLeave()) throw new Error("画布尚未保存，请先重试保存或导出备份。");
    const previousWorkspace = state.workspace;
    const result = await api("/api/workspaces/select", { method: "POST", body: JSON.stringify({ path: folder.trim() }) });
    if (result.workspace !== previousWorkspace) {
      if (state.sessionId) workspaceSessions.set(previousWorkspace, state.sessionId);
      workspaceDrafts.set(previousWorkspace, { home: $("home-input").value, thread: $("thread-input").value });
      workspaceEpoch++;
      sessionListRequest++;
      submitRequest++;
      clearOpenSession();
      state.workspace = result.workspace;
      state.sessions = [];
      state.changes = [];
      state.selectedModel = "";
      state.availableModels = [];
      state.model = "";
      composerTools.workspaceChanged();
      const draft = workspaceDrafts.get(state.workspace);
      $("home-input").value = draft?.home || "";
      $("thread-input").value = draft?.thread || "";
      composerTools.sync();
      $("timeline").replaceChildren($("thread-progress"));
      $("diff-view").classList.add("hidden");
      renderSessions();
      renderChanges();
      await setView("tasks");
      await Promise.all([refreshSessions(), refreshChanges(), refreshModels(), customizationUI.refreshTeams(), customizationUI.refreshPreferences()]);
      const previousSession = result.activeSessionId || workspaceSessions.get(state.workspace);
      if (previousSession) await openSession(previousSession);
    }
    await workspaceFiles.workspaceChanged(result.workspace, true);
    toast(result.warning || `已在 ${shortWorkspace()} 中工作；其他项目中的任务会继续执行`);
  } finally { state.switchingWorkspace = false; }
}

function installHandlers() {
  document.addEventListener("ccagent:official-services", () => customizationUI.openOfficial());
  document.addEventListener("ccagent:models-changed", () => { state.selectedModel = ""; void refreshModels(); });
  $("temporary-chat").addEventListener("click", async () => {
    if (state.switchingWorkspace) return;
    try {
      const created = await api("/api/sessions", { method: "POST", body: JSON.stringify({ temporary: true, mode: "default", model: state.selectedModel || undefined }) });
      await openSession(created.sessionId, created.snapshot);
    } catch (error) { toast(error.message); }
  });
  $("new-task").addEventListener("click", newTask);
  $("rail-new-task").addEventListener("click", newTask);
  $("brand-home").addEventListener("click", newTask);
  $("surface-chat").addEventListener("click", () => setComposeMode("chat"));
  $("surface-work").addEventListener("click", () => setComposeMode("work"));
  $("home-plugins").addEventListener("click", () => setView("plugins"));
  $("home-file").addEventListener("click", () => void workspaceFiles.open());
  $("context-workspace").addEventListener("click", () => void workspacePicker.open());
  $("thread-workspace-select").addEventListener("click", () => void workspacePicker.open());
  $("workspace-project").addEventListener("click", () => void workspacePicker.open());
  $("feature-sidebar-close").addEventListener("click", () => $("feature-sidebar").classList.remove("open"));
  $("feature-new-schedule").addEventListener("click", () => { $("schedule-title").focus(); $("schedule-title").scrollIntoView({ block: "center" }); });
  $("feature-library-nav").querySelectorAll("[data-library-kind]").forEach((button) => button.addEventListener("click", () => {
    $("feature-library-nav").querySelectorAll("[data-library-kind]").forEach((item) => item.classList.toggle("selected", item === button));
    $("library-filters").querySelector(`[data-kind="${button.dataset.libraryKind}"]`)?.click();
  }));
  $("feature-memory-chats").addEventListener("click", () => $("memory-session-list").scrollIntoView({ block: "start" }));
  $("feature-memory-files").addEventListener("click", () => $("memory-file-list").scrollIntoView({ block: "start" }));
  $("workspace-entry").addEventListener("click", () => setView("about"));
  $("cloudtv-entry").addEventListener("click", () => setView("cloudtv"));
  $("sidebar-open").addEventListener("click", () => {
    const shell = document.querySelector(".app-shell");
    if (shell.classList.contains("sidebar-collapsed")) shell.classList.remove("sidebar-collapsed");
    else $(["plugins", "skills", "agents", "mcp", "teams"].includes(state.view) ? "customize-sidebar" : ["schedules", "library", "memory"].includes(state.view) ? "feature-sidebar" : "sidebar").classList.add("open");
  });
  $("sidebar-toggle").addEventListener("click", () => document.querySelector(".app-shell").classList.toggle("sidebar-collapsed"));
  $("sidebar-close").addEventListener("click", () => $("sidebar").classList.remove("open"));
  document.querySelectorAll(".rail-button[data-view]").forEach((button) => button.addEventListener("click", () => { if (button.dataset.view === "tasks") newTask(); else setView(button.dataset.view); }));
  document.querySelectorAll(".activity-tab").forEach((button) => button.addEventListener("click", () => { state.activity = button.dataset.activity; renderActivity(); }));
  $("home-form").addEventListener("submit", (event) => { event.preventDefault(); submit($("home-input").value, $("home-mode").value); });
  $("thread-form").addEventListener("submit", (event) => { event.preventDefault(); if (!state.busy) submit($("thread-input").value); });
  $("home-model").addEventListener("change", (event) => { state.selectedModel = event.target.value; syncModelSelectors(); });
  $("thread-model-select").addEventListener("change", async (event) => {
    const selected = event.target.value;
    if (!state.sessionId || selected === state.model) return;
    try {
      await api(`/api/sessions/${state.sessionId}/model`, { method: "POST", body: JSON.stringify({ model: selected }) });
      state.model = selected;
      syncModelSelectors();
    } catch (error) { syncModelSelectors(); toast(error.message); }
  });
  $("thread-mode-select").addEventListener("change", async (event) => {
    const selected = event.target.value;
    if (!state.sessionId || selected === state.mode) return;
    try {
      await api(`/api/sessions/${state.sessionId}/mode`, { method: "POST", body: JSON.stringify({ mode: selected }) });
      state.mode = selected;
    } catch (error) { event.target.value = state.mode; toast(error.message); }
  });
  for (const input of [$("home-input"), $("thread-input")]) {
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); input.closest("form").requestSubmit(); }
    });
  }
  document.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") { event.preventDefault(); newTask(); }
    if (event.key === "Escape" && !$("interaction-overlay").classList.contains("hidden")) answerInteraction(false);
    if (event.key === "Escape") workspacePicker.close();
  });
  $("refresh-all").addEventListener("click", () => { if (state.view === "whiteboard") void whiteboardUI.open(); else if (state.view === "cloudtv") cloudTVUI.refresh(); else if (["teams", "settings", "power-settings"].includes(state.view)) void customizationUI.open(state.view); else if (["plugins", "skills", "agents", "mcp"].includes(state.view)) void pluginUI.refresh(); else if (state.view === "library") void libraryUI.refresh(); else if (state.view === "memory") void memoryUI.refresh(); else if (state.view === "schedules") void schedulesUI.refresh(); else { refreshSessions(); refreshChanges(); void workspaceFiles.refresh(); } });
  $("activity-refresh").addEventListener("click", refreshChanges);
  $("close-diff").addEventListener("click", () => $("diff-view").classList.add("hidden"));
  $("stop-button").addEventListener("click", async () => {
    if (!state.sessionId) return;
    const sessionId = state.sessionId;
    $("stop-button").disabled = true;
    try {
      const result = await api(`/api/sessions/${sessionId}/interrupt`, { method: "POST", body: "{}" });
      if (state.sessionId === sessionId && result.interrupted && state.model?.startsWith("ccagent:")) {
        addNotice("已请求停止。已发出的官方服务调用仍会按可核实用量结算。请在“官方服务设置 → 调用与费用明细”核对原请求状态；查询不会新增消费。");
      }
    }
    catch (error) { toast(error.message); }
    finally { $("stop-button").disabled = false; }
  });
  $("interaction-deny").addEventListener("click", () => answerInteraction(false));
  $("interaction-allow").addEventListener("click", () => answerInteraction(true));
}

const pluginUI = createPluginUI({ api, toast, navigate: setView, editAgent: (agent) => customizationUI.agentEditor(agent) });
$("feature-schedule-list").append($("schedule-list"));
const libraryUI = createLibraryUI({ api, toast, getWorkspace: () => state.workspace });
const memoryUI = createMemoryUI({ api, toast, onDelete: onSessionDeleted });
const schedulesUI = createSchedulesUI({ api, toast, openSession: (id) => void openSession(id) });
const browserUI = createBrowserPanel({ api, toast, getSessionId: () => state.sessionId });
const voiceUI = createVoiceUI({ submit, getBusy: () => state.busy, getMode: () => $(state.view === "thread" ? "thread-mode-select" : "home-mode").value, toast });
const customizationUI = createCustomizationUI({ api, toast, navigate: setView, getWorkspace: () => state.workspace, getModel: () => state.selectedModel || state.model, getSessionId: () => state.sessionId, getBusy: () => state.busy, changed: async (resource) => {
  if (["agents", "skills", "mcp"].includes(resource)) await pluginUI.open(resource);
  else if (resource === "models") { state.selectedModel = ""; await refreshModels(); }
  else if (resource === "session" && state.sessionId) await openSession(state.sessionId);
  else if (resource === "settings") await customizationUI.refreshPreferences();
  else if (resource === "history") await refreshSessions();
} });
const workspacePicker = createWorkspacePicker({ api, onSelect: selectWorkspace, getWorkspace: () => state.workspace });
const workspaceFiles = createWorkspaceFiles({ api, toast, getWorkspace: () => state.workspace, reference: (file) => composerTools.reference(file) });
const composerTools = createComposerTools({ api, toast, getWorkspace: () => state.workspace, getInput: () => $(state.view === "thread" ? "thread-input" : "home-input"), files: workspaceFiles, chooseWorkspace: () => workspacePicker.open(), navigate: setView });
const cloudTVUI = createCloudTVUI({ onBack: () => {
  setView(state.sessionId ? "thread" : "tasks");
  if (state.sessionId) history.replaceState(null, "", projectUrl({ session: state.sessionId }));
  $(state.sessionId ? "thread-input" : "home-input").focus();
} });
const whiteboardUI = createWhiteboardUI({ api, toast, getWorkspace: () => state.workspace });
window.ccagentBeforeAccountChange = () => whiteboardUI.beforeLeave();
const visualizationUI = createVisualizationUI({ api, toast, getWorkspace: () => state.workspace, onAnalyze: ({ dataset, analysis }) => {
  newTask(); $("home-input").value = `请使用 AnalyzeData 分析当前工作文件夹的数据集 ${dataset.id}（${dataset.name} / ${dataset.sheet}）。字段映射：${JSON.stringify(analysis.config)}。筛选条件：${JSON.stringify(analysis.filters)}。请核对数据质量、解释图表趋势与异常，并给出有数据依据的建议。保留原文件，标注数据口径和源行。`; $("home-input").dispatchEvent(new Event("input", { bubbles: true })); toast("已填写分析请求，发送即可继续");
} });
installHandlers();
setComposeMode("work");
const params = new URLSearchParams(location.search);
const savedSession = params.get("session");
const earlySettings = !savedSession && ["settings", "power-settings"].includes(params.get("view"));
if (earlySettings) await setView(params.get("view"));
const startupViewRequest = viewRequest;
const startup = await Promise.allSettled([refreshSessions(), refreshChanges(), refreshModels(), customizationUI.refreshTeams(), customizationUI.refreshPreferences()]);
for (const result of startup) if (result.status === "rejected") toast(result.reason?.message || "部分工作区信息暂时无法读取，请刷新重试。");
if (!earlySettings && startupViewRequest === viewRequest) {
  if (savedSession && /^[0-9a-f-]{36}$/.test(savedSession)) await openSession(savedSession);
  else if (["plugins", "skills", "agents", "mcp", "teams", "settings", "power-settings", "library", "memory", "schedules", "changes", "about", "visualization", "cloudtv", "whiteboard"].includes(params.get("view"))) await setView(params.get("view"));
  else setView("tasks");
}
const homePromotion = createHomePromotion({ api, isIdle: () => state.view === "tasks" && !state.busy && !state.pending && !$("home-input").value.trim() });
void homePromotion.start();
