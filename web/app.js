import { createPluginUI } from "./plugins.js";
import { createVoiceUI } from "./voice.js";
import { createBrowserPanel } from "./browser-panel.js";
import { createLibraryUI } from "./library.js";
import { createMemoryUI } from "./memory.js";
import { createSchedulesUI } from "./schedules.js";
import { createCustomizationUI } from "./customization.js";
import { createWorkspacePicker } from "./workspace-picker.js";
import { createWorkspaceFiles } from "./workspace-files.js";
import { createComposerTools } from "./composer-tools.js";

const $ = (id) => document.getElementById(id);
const state = { workspace: "", model: "", mode: "default", selectedModel: "", availableModels: [], version: "", sessions: [], changes: [], sessionId: null, temporary: false, source: null, busy: false, pending: null, view: "tasks", composeMode: "work", activity: "changes", streamNode: null, toolNodes: new Map(), storageWarningShown: false };
let toastTimer;

function toast(message) {
  const node = $("toast");
  node.textContent = message;
  node.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.add("hidden"), 4500);
}

async function api(route, options = {}) {
  const response = await fetch(route, {
    ...options,
    headers: { ...(options.body ? { "content-type": "application/json" } : {}), "x-ccagent-web": "1", ...(options.headers || {}) },
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
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
    const button = document.createElement("button");
    button.className = `recent-item${session.sessionId === state.sessionId ? " active" : ""}`;
    button.textContent = taskTitle(session);
    button.title = `${taskTitle(session)} · ${relativeTime(session.updatedAt)}`;
    button.addEventListener("click", () => openSession(session.sessionId));
    list.append(button);
  }
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

function setView(view) {
  if (view !== state.view) voiceUI.stopDictation();
  state.view = view;
  workspaceFiles.setView(view);
  composerTools.close();
  const customizing = ["plugins", "skills", "agents", "mcp", "teams"].includes(view);
  const feature = ["schedules", "library", "memory"].includes(view);
  document.querySelector(".main-area").classList.toggle("home-active", view === "tasks");
  $("sidebar").classList.toggle("hidden", customizing || feature || view === "settings");
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
  $("settings-view").classList.toggle("hidden", view !== "settings");
  $("teams-view").classList.toggle("hidden", view !== "teams");
  $("header-title").textContent = view === "thread" ? $("thread-title").textContent : ({ tasks: "任务", changes: "代码更改", about: "关于工作区", library: "资料空间", memory: "记忆管理", schedules: "定时任务", plugins: "Plugins", skills: "Skills", agents: "Agents", mcp: "MCP 服务", teams: "Agent Teams", settings: "设置" })[view];
  document.querySelectorAll(".rail-button[data-view]").forEach((item) => item.classList.toggle("selected", item.dataset.view === (view === "thread" ? "tasks" : ["skills", "agents", "mcp", "teams"].includes(view) ? "plugins" : view)));
  $("customize-search").classList.toggle("hidden", view === "teams");
  $("sidebar").classList.remove("open");
  $("customize-sidebar").classList.remove("open");
  $("feature-sidebar").classList.remove("open");
  if (view === "tasks") history.replaceState(null, "", "/");
  else if (view !== "thread") history.replaceState(null, "", `/?view=${view}`);
  if (customizing && view !== "teams") void pluginUI.open(view);
  if (view === "settings" || view === "teams") void customizationUI.open(view);
  if (view === "teams") document.querySelectorAll(".customize-nav-item").forEach((item) => item.classList.toggle("selected", item.dataset.customizeView === view));
  if (view === "library") void libraryUI.open();
  if (view === "memory") void memoryUI.open();
  if (view === "schedules") void schedulesUI.open();
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

function addUser(text) {
  const node = document.createElement("div");
  node.className = "message user";
  node.textContent = text;
  $("timeline").append(node);
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
  const found = [];
  for (const path of [...paths].slice(0, 5)) {
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
    const icon = document.createElement("span"); icon.textContent = "▧";
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
  content.append(body, actions); row.append(avatar, content); $("timeline").append(row);
  if (artifacts.size) void appendArtifactSummary(body, artifacts);
  scrollTimeline();
}

function addTool(id, name, status = "执行中") {
  const row = document.createElement("div");
  row.className = "tool-card";
  const icon = document.createElement("span");
  icon.className = "tool-icon";
  icon.textContent = "⌘";
  const title = document.createElement("strong");
  title.textContent = name;
  const stateLabel = document.createElement("span");
  stateLabel.className = "tool-state";
  stateLabel.textContent = status;
  row.append(icon, title, stateLabel);
  $("timeline").append(row);
  if (id) state.toolNodes.set(id, row);
  scrollTimeline();
}

function addNotice(message, error = false) {
  const row = document.createElement("div");
  row.className = `notice-line${error ? " error" : ""}`;
  row.textContent = message;
  $("timeline").append(row);
  scrollTimeline();
}

function scrollTimeline() { const timeline = $("timeline"); timeline.scrollTop = timeline.scrollHeight; }

function clearStream() {
  state.streamNode?.remove();
  state.streamNode = null;
}

function appendStream(text) {
  if (!state.streamNode) {
    const row = document.createElement("div");
    row.className = "message assistant streaming";
    const avatar = document.createElement("span");
    avatar.className = "message-avatar";
    avatar.textContent = "✦";
    const body = document.createElement("div");
    body.className = "assistant-body";
    row.append(avatar, body);
    $("timeline").append(row);
    state.streamNode = row;
  }
  state.streamNode.querySelector(".assistant-body").textContent += text;
  scrollTimeline();
}

function renderStoredMessages(messages) {
  $("timeline").replaceChildren();
  clearStream();
  state.toolNodes.clear();
  for (const message of messages) {
    if (message.role === "user") {
      if (typeof message.content === "string" && message.content.trim()) addUser(message.content);
      continue;
    }
    if (message.role !== "assistant") continue;
    const text = messageText(message);
    if (text) addAssistant(text);
    if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block.type === "tool_use") addTool(block.id, block.name, "已执行");
      }
    }
  }
}

function setBusy(busy) {
  if (busy) voiceUI.stopDictation();
  state.busy = busy;
  customizationUI.syncBusy(busy);
  if (busy) state.lastTurnReason = null;
  const terminal = { model_error: "本轮失败，可重试", aborted: "已停止", max_turns: "已达执行轮数上限", incomplete: "上次执行未完成，可重试" };
  $("thread-status-label").textContent = busy ? "正在执行" : terminal[state.lastTurnReason] || "就绪";
  $("thread-status-dot").classList.toggle("busy", busy);
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
      option.textContent = `${selected}（此会话）`;
      option.disabled = true;
      select.append(option);
    }
    select.value = selected;
    if (!select.value && state.availableModels.some((item) => item.available)) {
      select.value = state.availableModels.find((item) => item.available).id;
    }
    select.disabled = !state.availableModels.some((item) => item.available) || (id === "thread-model-select" && state.busy);
  }
  $("thread-model").textContent = modelLabel(state.model);
  $("about-model").textContent = modelLabel(state.model || state.selectedModel);
  renderActivity();
}

async function refreshModels() {
  try {
    const data = await api("/api/models");
    state.availableModels = data.models;
    if (!state.selectedModel || !data.models.some((item) => item.id === state.selectedModel && item.available)) {
      state.selectedModel = data.models.find((item) => item.id === data.defaultModel && item.available)?.id
        || data.models.find((item) => item.available)?.id || "";
    }
    syncModelSelectors();
  } catch (error) { toast(`无法载入模型：${error.message}`); }
}

function showInteraction(pending) {
  state.pending = pending;
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
    $("interaction-overlay").classList.add("hidden");
  } catch (error) { toast(error.message); }
}

function handleEvent(event) {
  voiceUI.handleEvent(event);
  browserUI.handleEvent(event);
  switch (event.type) {
    case "turn_started": setBusy(true); break;
    case "user": addUser(event.text); break;
    case "text": appendStream(event.text); break;
    case "stream_restart": clearStream(); break;
    case "assistant": clearStream(); addAssistant(messageText(event.message)); break;
    case "model": state.model = event.model; syncModelSelectors(); break;
    case "mode": state.mode = event.mode; $("thread-mode-select").value = event.mode; break;
    case "team": customizationUI.setSessionTeam(event.team); break;
    case "tool_start": addTool(event.id, event.name); break;
    case "tool_done": {
      const row = state.toolNodes.get(event.id);
      if (row) {
        row.querySelector(".tool-state").textContent = event.isError ? "失败" : "已完成";
        if (event.isError) row.classList.add("error");
      }
      break;
    }
    case "notice": addNotice(event.message, event.tone === "error"); break;
    case "interaction": showInteraction(event); break;
    case "interaction_resolved": state.pending = null; $("interaction-overlay").classList.add("hidden"); break;
    case "turn_complete":
      state.lastTurnReason = event.reason;
      for (const row of state.toolNodes.values()) {
        const label = row.querySelector(".tool-state");
        if (label?.textContent === "执行中") { label.textContent = event.reason === "aborted" ? "已停止" : "未完成"; row.classList.add("error"); }
      }
      clearStream(); setBusy(false); refreshSessions(); refreshChanges();
      if (event.reason && event.reason !== "completed") toast(`任务结束：${event.reason}`);
      break;
  }
}

async function openSession(id) {
  try {
    if (state.sessionId !== id) voiceUI.stop();
    state.source?.close();
    state.source = null;
    const data = await api(`/api/sessions/${id}`);
    state.sessionId = id;
    state.temporary = data.temporary === true;
    $("thread-view").classList.toggle("temporary-thread", state.temporary);
    history.replaceState(null, "", `/?session=${encodeURIComponent(id)}`);
    const entry = state.sessions.find((item) => item.sessionId === id);
    const firstUser = data.messages.find((message) => message.role === "user" && typeof message.content === "string");
    const title = entry ? taskTitle(entry) : (firstUser?.content || "新任务").slice(0, 80);
    $("thread-title").textContent = state.temporary ? `临时对话 · ${title}` : title;
    $("thread-workspace").textContent = shortWorkspace();
    $("thread-composer-workspace").textContent = shortWorkspace();
    state.model = data.model;
    state.mode = data.mode;
    customizationUI.setSessionTeam(data.team);
    $("thread-mode-select").value = data.mode;
    syncModelSelectors();
    browserUI.restore(data.browserUrl);
    renderStoredMessages(data.messages);
    for (const notice of data.recentNotices || []) addNotice(notice.message, notice.tone === "error");
    const lastContent = data.messages.at(-1)?.content;
    state.lastTurnReason = data.lastTurnReason || (!data.busy && Array.isArray(lastContent) && lastContent.some((block) => block.type === "tool_use" || (block.type === "tool_result" && block.is_error)) ? "incomplete" : null);
    setBusy(data.busy);
    if (data.pending) showInteraction(data.pending);
    setView("thread");
    renderSessions();
    state.source = new EventSource(`/api/sessions/${id}/events?lastEventId=${data.lastEventId || 0}`);
    state.source.onmessage = (message) => {
      if (state.sessionId !== id) return;
      try { handleEvent(JSON.parse(message.data)); } catch (error) { console.error(error); }
    };
    state.source.onerror = () => { if (!state.switchingWorkspace) toast("连接中断，正在重新连接…"); };
    $("thread-input").focus();
    return true;
  } catch (error) {
    if (new URLSearchParams(location.search).get("session") === id) history.replaceState(null, "", "/");
    toast(error.message);
    return false;
  }
}

async function submit(text, mode) {
  const inputId = state.view === "thread" ? "thread-input" : "home-input";
  const input = composerTools.prepare(text.trim(), inputId);
  if (!input) return false;
  if (input.length > 50000) { toast("单条消息不能超过 50000 字符。"); return false; }
  try {
    if (!state.sessionId || state.view !== "thread") {
      const created = await api("/api/sessions", { method: "POST", body: JSON.stringify({ mode, model: state.selectedModel || undefined, team: $("home-team").value }) });
      state.sessionId = created.sessionId;
      if (!(await openSession(created.sessionId))) return false;
    }
    await api(`/api/sessions/${state.sessionId}/messages`, { method: "POST", body: JSON.stringify({ text: input }) });
    composerTools.clear(inputId);
    $("home-input").value = "";
    $("thread-input").value = "";
    composerTools.sync();
    return true;
  } catch (error) {
    if (inputId === "home-input" && state.view === "thread") {
      composerTools.move("home-input", "thread-input");
      $("thread-input").value = text;
      $("home-input").value = "";
      composerTools.sync();
    }
    toast(error.message); return false;
  }
}

async function refreshSessions() {
  try {
    const data = await api("/api/bootstrap");
    state.sessions = data.sessions;
    if (state.workspace && state.workspace !== data.workspace) composerTools.workspaceChanged();
    state.workspace = data.workspace;
    await workspaceFiles.workspaceChanged(state.workspace);
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
  } catch (error) { toast(`无法连接 CCAGENT Web：${error.message}`); }
}

async function refreshChanges() {
  try { state.changes = (await api("/api/changes")).files; renderChanges(); }
  catch (error) { toast(error.message); }
}

function newTask() {
  composerTools.clear("thread-input");
  voiceUI.stop();
  browserUI.restore(null);
  state.source?.close();
  state.source = null;
  state.sessionId = null;
  state.temporary = false;
  history.replaceState(null, "", "/");
  state.pending = null;
  $("interaction-overlay").classList.add("hidden");
  renderSessions();
  setView("tasks");
  $("home-input").focus();
}

async function selectWorkspace(folder) {
    state.switchingWorkspace = true;
    try {
    const result = await api("/api/workspaces/select", { method: "POST", body: JSON.stringify({ path: folder.trim() }) });
    if (result.workspace !== state.workspace) {
      newTask();
      state.workspace = result.workspace;
      composerTools.workspaceChanged();
      state.selectedModel = "";
      await Promise.all([refreshSessions(), refreshChanges(), refreshModels(), customizationUI.refreshTeams(), customizationUI.refreshPreferences()]);
    }
    await workspaceFiles.workspaceChanged(result.workspace, true);
    toast(result.warning || `已在 ${shortWorkspace()} 中工作`);
    } finally { state.switchingWorkspace = false; }
}

function installHandlers() {
  $("temporary-chat").addEventListener("click", async () => {
    try {
      const created = await api("/api/sessions", { method: "POST", body: JSON.stringify({ temporary: true, mode: "default", model: state.selectedModel || undefined }) });
      await openSession(created.sessionId);
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
  $("refresh-all").addEventListener("click", () => { if (["teams", "settings"].includes(state.view)) void customizationUI.open(state.view); else if (["plugins", "skills", "agents", "mcp"].includes(state.view)) void pluginUI.refresh(); else if (state.view === "library") void libraryUI.refresh(); else if (state.view === "memory") void memoryUI.refresh(); else if (state.view === "schedules") void schedulesUI.refresh(); else { refreshSessions(); refreshChanges(); void workspaceFiles.refresh(); } });
  $("activity-refresh").addEventListener("click", refreshChanges);
  $("close-diff").addEventListener("click", () => $("diff-view").classList.add("hidden"));
  $("stop-button").addEventListener("click", async () => {
    if (!state.sessionId) return;
    try { await api(`/api/sessions/${state.sessionId}/interrupt`, { method: "POST", body: "{}" }); }
    catch (error) { toast(error.message); }
  });
  $("interaction-deny").addEventListener("click", () => answerInteraction(false));
  $("interaction-allow").addEventListener("click", () => answerInteraction(true));
}

const pluginUI = createPluginUI({ api, toast, navigate: setView, editAgent: (agent) => customizationUI.agentEditor(agent) });
$("feature-schedule-list").append($("schedule-list"));
const libraryUI = createLibraryUI({ api, toast });
const memoryUI = createMemoryUI({ api, toast, onDelete: (id) => { if (state.sessionId === id) { state.source?.close(); state.sessionId = null; } void refreshSessions(); } });
const schedulesUI = createSchedulesUI({ api, toast, openSession: (id) => void openSession(id) });
const browserUI = createBrowserPanel({ api, toast, getSessionId: () => state.sessionId });
const voiceUI = createVoiceUI({ submit, getBusy: () => state.busy, getMode: () => $(state.view === "thread" ? "thread-mode-select" : "home-mode").value, toast });
const customizationUI = createCustomizationUI({ api, toast, navigate: setView, getModel: () => state.selectedModel || state.model, getSessionId: () => state.sessionId, getBusy: () => state.busy, changed: async (resource) => {
  if (["agents", "skills", "mcp"].includes(resource)) await pluginUI.open(resource);
  else if (resource === "models") { state.selectedModel = ""; await refreshModels(); }
  else if (resource === "session" && state.sessionId) await openSession(state.sessionId);
  else if (resource === "settings") await customizationUI.refreshPreferences();
} });
const workspacePicker = createWorkspacePicker({ api, onSelect: selectWorkspace, getWorkspace: () => state.workspace });
const workspaceFiles = createWorkspaceFiles({ api, toast, getWorkspace: () => state.workspace, reference: (file) => composerTools.reference(file) });
const composerTools = createComposerTools({ api, toast, getWorkspace: () => state.workspace, getInput: () => $(state.view === "thread" ? "thread-input" : "home-input"), files: workspaceFiles, chooseWorkspace: () => workspacePicker.open(), navigate: setView });
installHandlers();
setComposeMode("work");
await Promise.all([refreshSessions(), refreshChanges(), refreshModels(), customizationUI.refreshTeams(), customizationUI.refreshPreferences()]);
const params = new URLSearchParams(location.search);
const savedSession = params.get("session");
if (savedSession && /^[0-9a-f-]{36}$/.test(savedSession)) await openSession(savedSession);
else if (["plugins", "skills", "agents", "mcp", "teams", "settings", "library", "memory", "schedules", "changes", "about"].includes(params.get("view"))) setView(params.get("view"));
else setView("tasks");
