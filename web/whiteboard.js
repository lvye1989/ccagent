import { createWhiteboardAI } from "./whiteboard-ai.js";
const MESSAGE_TYPE = "ccagent-whiteboard";
const EMPTY_SCENE = { type: "excalidraw", version: 2, source: "CCAGENT", elements: [], appState: {}, files: {} };
const MAX_IMPORT_BYTES = 10 * 1024 * 1024;
function node(tag, className = "", text) { const element = document.createElement(tag); element.className = className; if (text !== undefined) element.textContent = text; return element; }
function button(text, action, className = "whiteboard-button") { const element = node("button", className, text); element.type = "button"; element.addEventListener("click", action); return element; }
function nonce() { return globalThis.crypto.randomUUID(); }
function sceneObject(value) { return value && typeof value === "object" && !Array.isArray(value) && Array.isArray(value.elements) && (!value.appState || typeof value.appState === "object") && (!value.files || typeof value.files === "object"); }
function filename(name) { return (name || "未命名白板").replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-").trim().slice(0, 100) || "白板"; }
function download(blob, name) { const url = URL.createObjectURL(blob); const link = node("a"); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
function isConflict(error) { return error?.code === "conflict" || (!error?.code && (error?.status === 409 || error?.statusCode === 409)) || /版本冲突|revision conflict|conflict|版本已.*更新|已被.*更新/i.test(error?.message || ""); }

export function createWhiteboardUI({ api, toast, getWorkspace }) {
  const s = { workspace: "", generation: 0, boards: [], board: null, scene: null, sceneKey: "", name: "", dirty: false, edits: 0, canvasVersion: 0, busy: false, freezing: false, conflict: false, error: "", saving: null, action: null, timer: null, ready: false, frame: null, channel: "", token: "", framePromise: null, frameError: false };
  const pending = new Map(); let requestId = 0, root, selector, title, statusText, statusBox, recovery, stage, welcome, loading, importInput, ai;

  function valid(generation, workspace) { return generation === s.generation && workspace === s.workspace && workspace === getWorkspace(); }
  function mounted() {
    if (root) return;
    root = document.getElementById("whiteboard-view") || node("section", "whiteboard-view hidden"); root.id = "whiteboard-view"; root.classList.add("whiteboard-view");
    if (!root.parentNode) document.getElementById("content").append(root);
    const header = node("header", "whiteboard-header"); const heading = node("div", "whiteboard-heading");
    heading.append(node("span", "whiteboard-eyebrow", "EXCALIDRAW"), node("h1", "", "白板"), node("p", "", "把想法画出来，让协作更清晰。"));
    const tools = node("div", "whiteboard-header-actions");
    tools.append(button("＋ 新建白板", () => void runAction(createBoard), "whiteboard-button primary"), button("导入白板", () => importInput.click()));
    importInput = node("input", "sr-only"); importInput.id = "whiteboard-import"; importInput.type = "file"; importInput.accept = ".excalidraw,application/json";
    importInput.addEventListener("change", () => { const file = importInput.files?.[0]; importInput.value = ""; if (file) void runAction(() => importBoard(file)); });
    header.append(heading, tools, importInput); root.append(header);
    const toolbar = node("div", "whiteboard-toolbar");
    const boardField = node("label", "whiteboard-board-field"); boardField.append(node("span", "sr-only", "选择白板")); selector = node("select"); selector.id = "whiteboard-select"; selector.setAttribute("aria-label", "选择白板");
    selector.addEventListener("change", () => { const id = selector.value; selector.value = s.board?.id || ""; if (id && id !== s.board?.id) void runAction(() => chooseBoard(id)); }); boardField.append(selector);
    const nameField = node("label", "whiteboard-name-field"); nameField.append(node("span", "sr-only", "白板名称")); title = node("input"); title.id = "whiteboard-name"; title.type = "text"; title.maxLength = 100; title.placeholder = "给白板起个名字"; title.setAttribute("aria-label", "白板名称");
    title.addEventListener("input", () => { s.name = title.value; markDirty(); }); title.addEventListener("blur", () => { if (!s.name.trim() && s.board) { s.name = "未命名白板"; title.value = s.name; } }); nameField.append(title);
    const actions = node("div", "whiteboard-export-actions");
    const save = button("保存", () => void runAction(() => flush()), "whiteboard-button primary"); save.id = "whiteboard-save";
    const json = button("导出白板", () => void runAction(exportJson)); json.id = "whiteboard-export-json";
    const png = button("PNG", () => void runAction(() => exportImage("png"))); png.id = "whiteboard-export-png"; png.title = "导出 PNG 图片";
    const svg = button("SVG", () => void runAction(() => exportImage("svg"))); svg.id = "whiteboard-export-svg"; svg.title = "导出 SVG 图片";
    actions.append(save, json, png, svg); toolbar.append(boardField, nameField, actions); root.append(toolbar);
    statusBox = node("div", "whiteboard-status"); statusBox.id = "whiteboard-status"; statusBox.setAttribute("aria-live", "polite");
    statusText = node("span"); recovery = node("div", "whiteboard-recovery"); statusBox.append(statusText, recovery); root.append(statusBox);
    stage = node("div", "whiteboard-stage"); welcome = node("div", "whiteboard-welcome");
    const illustration = node("div", "whiteboard-illustration"); illustration.setAttribute("aria-hidden", "true"); illustration.append(node("span", "whiteboard-sketch-box", "一个想法"), node("span", "whiteboard-sketch-arrow", "⟶"), node("span", "whiteboard-sketch-box accent", "无限可能"));
    welcome.append(illustration, node("h2", "", "从一块空白开始"), node("p", "", "流程图、草图、便签与思维导图，在同一个画布里自由展开。"), button("创建第一块白板", () => void runAction(createBoard), "whiteboard-button primary"), node("small", "", "自动保存在当前账号与工作文件夹中 · 可导入和导出 .excalidraw"));
    loading = node("div", "whiteboard-loading hidden", "正在打开本地白板编辑器…"); loading.setAttribute("role", "status"); stage.append(welcome, loading);
    const workbench = node("div", "whiteboard-workbench"), aiHost = node("div"); workbench.append(stage, aiHost); root.append(workbench);
    ai = createWhiteboardAI({ api, toast, host: aiHost, getContext: aiContext, applyDrawing: applyAIDrawing, undoDrawing: undoAIDrawing });
    window.addEventListener("beforeunload", (event) => { if (s.dirty || s.saving) { event.preventDefault(); event.returnValue = ""; } }); render();
  }
  function render() {
    if (!root) return;
    const selected = s.board?.id || ""; selector.replaceChildren(); const placeholder = node("option", "", s.boards.length ? "选择白板" : "还没有白板"); placeholder.value = ""; selector.append(placeholder);
    for (const board of s.boards) { const option = node("option", "", board.id === selected ? s.name || "未命名白板" : board.name); option.value = board.id; selector.append(option); } selector.value = selected;
    if (document.activeElement !== title) title.value = s.name;
    const locked = s.busy || s.freezing;
    root.setAttribute("aria-busy", String(locked)); root.classList.toggle("whiteboard-locked", locked);
    root.querySelectorAll("button,select,input").forEach((control) => { if (!control.closest(".whiteboard-ai")) control.disabled = locked; });
    title.disabled = locked || !s.board; selector.disabled = locked || !s.boards.length;
    root.querySelectorAll(".whiteboard-export-actions button").forEach((control) => { control.disabled = locked || !s.board; });
    welcome.classList.toggle("hidden", Boolean(s.board)); if (s.frame) s.frame.classList.toggle("hidden", !s.board);
    loading.classList.toggle("hidden", !s.board || (s.ready && !s.frameError));
    statusBox.classList.toggle("error", Boolean(s.error)); statusBox.classList.toggle("conflict", s.conflict); statusBox.setAttribute("role", s.error ? "alert" : "status");
    statusText.textContent = s.error || (s.saving ? "正在保存…" : s.dirty ? "有未保存的更改，稍后自动保存" : s.board ? `已保存${s.board.updatedAt && Number.isFinite(Date.parse(s.board.updatedAt)) ? ` · ${new Date(s.board.updatedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}` : ""}` : "白板仅保存在当前账号与工作文件夹中");
    recovery.replaceChildren();
    if (s.error && s.board) {
      if (!s.conflict) recovery.append(button(s.frameError ? "重新加载编辑器" : "重试保存", () => void runAction(s.frameError ? reloadEditor : () => flush())));
      recovery.append(button("下载未保存副本", () => void runAction(exportJson)), button("另存为新白板", () => void runAction(saveAsNew)));
      recovery.querySelectorAll("button").forEach((control) => { control.disabled = locked; });
    } else if (s.error) recovery.append(button("重试", () => void open()));
    ai?.contextChanged(s.board ? { workspace: s.workspace, id: s.board.id, name: s.name, revision: s.board.revision, token: s.token, canvasVersion: s.canvasVersion } : null);
  }
  function fail(error) { s.conflict = isConflict(error); s.error = s.conflict ? "这块白板已在其他页面更新。当前更改已保留，请下载副本或另存为新白板。" : (error?.message || "操作未完成，请重试。") + (s.dirty ? " 当前更改仍保留在画布中。" : ""); render(); }
  function setScene(scene) { s.scene = scene; s.sceneKey = JSON.stringify(scene); }
  function changed(scene, canvasVersion) { if (!sceneObject(scene)) return; if (Number.isSafeInteger(canvasVersion) && canvasVersion >= 0) s.canvasVersion = canvasVersion; const key = JSON.stringify(scene); if (key === s.sceneKey) { render(); return; } s.scene = scene; s.sceneKey = key; markDirty(); }
  function markDirty() { if (!s.board) return; s.dirty = true; s.edits++; clearTimeout(s.timer); if (!s.conflict) s.timer = setTimeout(() => { if (s.busy || s.freezing) { markDirty(); return; } void flush({ capture: false }); }, 800); render(); }
  function post(message) { s.frame?.contentWindow?.postMessage({ type: MESSAGE_TYPE, channel: s.channel, ...message }, window.location.origin); }
  async function ensureFrame() {
    if (s.framePromise) return s.framePromise;
    mounted(); s.channel = nonce(); s.ready = false; s.frameError = false;
    const frame = node("iframe", "whiteboard-editor-frame hidden"); frame.id = "whiteboard-editor-frame"; frame.title = "Excalidraw 白板编辑器";
    frame.setAttribute("sandbox", "allow-scripts allow-same-origin allow-downloads"); frame.referrerPolicy = "no-referrer"; frame.src = `/whiteboard-editor.html#channel=${encodeURIComponent(s.channel)}`; s.frame = frame;
    s.framePromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { if (s.frame === frame) { s.frameError = true; reject(new Error("白板编辑器加载超时，请点击重新加载编辑器。")); render(); } }, 45000);
      frame._whiteboardReady = () => { clearTimeout(timeout); if (s.frame === frame) { s.ready = true; resolve(); render(); } };
      frame._whiteboardCancel = () => { clearTimeout(timeout); reject(new Error("编辑器正在重新加载。")); };
      frame.addEventListener("error", () => { clearTimeout(timeout); if (s.frame === frame) { s.frameError = true; reject(new Error("白板编辑器未能加载，请重试。")); render(); } }, { once: true });
    }); stage.prepend(frame); render(); return s.framePromise;
  }
  async function rpc(method, payload = {}) {
    await ensureFrame(); const id = String(++requestId);
    return new Promise((resolve, reject) => { const timer = setTimeout(() => { pending.delete(id); reject(new Error("白板编辑器响应超时，当前画布仍保留。")); }, 45000); pending.set(id, { resolve, reject, timer }); post({ kind: "request", id, method, payload }); });
  }
  window.addEventListener("message", (event) => {
    if (event.origin !== window.location.origin || event.source !== s.frame?.contentWindow) return;
    const message = event.data;
    if (!message || message.type !== MESSAGE_TYPE || message.channel !== s.channel) return;
    if (message.kind === "ready") { s.frame?._whiteboardReady?.(); return; }
    if (message.kind === "response" && typeof message.id === "string") { const request = pending.get(message.id); if (!request) return; clearTimeout(request.timer); pending.delete(message.id); message.error ? request.reject(new Error(String(message.error))) : request.resolve(message.payload); return; }
    if (message.kind === "change" && s.board && message.payload?.token === s.token && s.workspace === getWorkspace()) changed(message.payload.scene, message.payload.canvasVersion);
    if (message.kind === "intent" && message.payload?.action === "save" && s.board) void runAction(() => flush());
    if (message.kind === "error") { s.frameError = true; fail(new Error(String(message.error || "白板编辑器未能加载。"))); }
  });
  async function snapshot() {
    if (!s.board || !s.ready || s.frameError) return;
    const generation = s.generation, token = s.token, result = await rpc("getScene");
    if (generation === s.generation && result?.token === token && token === s.token) {
      if (Number.isSafeInteger(result.canvasVersion) && result.canvasVersion >= 0) s.canvasVersion = result.canvasVersion;
      if (result.hasChanges === false && !s.dirty && sceneObject(result.scene)) setScene(result.scene);
      else changed(result.scene, result.canvasVersion);
    }
  }
  async function request(action, body = {}, workspace = s.workspace) { return api(`/api/whiteboards/${action}`, { method: "POST", body: JSON.stringify({ ...body, workspace }) }); }
  function remember(board) { s.boards = [board, ...s.boards.filter((item) => item.id !== board.id)]; }
  async function flush({ capture = true } = {}) {
    clearTimeout(s.timer);
    try { if (capture) await snapshot(); } catch (error) { fail(error); return false; }
    if (s.saving) { const saved = await s.saving; if (!saved) return false; }
    if (!s.board || !s.dirty) return true;
    if (s.conflict) { render(); return false; }
    const generation = s.generation, workspace = s.workspace, id = s.board.id, token = s.token;
    const saving = (async () => {
      while (s.dirty && valid(generation, workspace) && s.board?.id === id && s.token === token) {
        const edits = s.edits, name = s.name.trim() || "未命名白板", scene = s.scene, revision = s.board.revision;
        try {
          const result = await request("save", { id, revision, name, scene }, workspace);
          if (!valid(generation, workspace) || s.board?.id !== id || s.token !== token) return false;
          if (!result?.board || result.workspace !== workspace) throw new Error("保存结果不属于当前工作文件夹，请重新打开白板。");
          s.board = result.board; remember(result.board); s.error = ""; s.conflict = false;
          if (s.edits === edits) { s.dirty = false; s.name = name; }
          render();
        } catch (error) { if (valid(generation, workspace)) fail(error); return false; }
      }
      return !s.dirty;
    })();
    s.saving = saving; render(); const result = await saving;
    if (s.saving === saving) { s.saving = null; render(); } return result;
  }
  async function runAction(action) {
    mounted(); if (s.action || s.freezing) return false;
    s.busy = true; render(); const current = Promise.resolve().then(action); s.action = current;
    try { return (await current) !== false; } catch (error) { fail(error); return false; }
    finally { if (s.action === current) { s.action = null; s.busy = false; render(); } }
  }
  async function adopt(board, generation = s.generation, workspace = s.workspace) {
    if (!valid(generation, workspace)) return false;
    if (!board || typeof board.id !== "string" || !sceneObject(board.scene)) throw new Error("白板数据无效，请重试。");
    s.board = board; s.name = board.name; s.token = nonce(); setScene(board.scene); s.dirty = false; s.edits = 0; s.canvasVersion = 0; s.error = ""; s.conflict = false; remember(board); render();
    const token = s.token, loaded = await rpc("load", { scene: board.scene, token });
    if (valid(generation, workspace) && token === s.token && loaded?.token === token && sceneObject(loaded.scene)) { setScene(loaded.scene); s.canvasVersion = loaded.canvasVersion || 0; render(); return true; }
    return false;
  }
  async function listBoards() {
    const generation = s.generation, workspace = s.workspace, result = await api(`/api/whiteboards?workspace=${encodeURIComponent(workspace)}`);
    if (!valid(generation, workspace)) return false;
    if (result.workspace !== workspace || !Array.isArray(result.boards)) throw new Error("未能读取当前工作文件夹的白板列表。");
    s.boards = result.boards; render(); return true;
  }
  async function chooseBoard(id) {
    await ai?.beforeLeave();
    if (!(await flush())) return false;
    const generation = s.generation, workspace = s.workspace, result = await request("open", { id });
    if (result.workspace !== workspace) throw new Error("工作文件夹已变化，请重新打开白板。");
    return adopt(result.board, generation, workspace);
  }
  async function createBoard() {
    await ai?.beforeLeave();
    if (!(await flush())) return false;
    const generation = s.generation, workspace = s.workspace, result = await request("create", { name: "未命名白板" });
    if (result.workspace !== workspace) throw new Error("工作文件夹已变化，请重新打开白板。");
    return adopt(result.board, generation, workspace);
  }
  async function importBoard(file) {
    if (!/\.excalidraw$/i.test(file.name) || !file.size || file.size > MAX_IMPORT_BYTES) throw new Error("请选择不超过 10 MB 的 .excalidraw 文件。");
    let scene; try { scene = JSON.parse(await file.text()); } catch { throw new Error("白板文件不是有效的 JSON，请重新选择。"); }
    if (scene?.type !== "excalidraw" || !sceneObject(scene)) throw new Error("请选择有效的 .excalidraw 白板文件。");
    await ai?.beforeLeave();
    if (!(await flush())) return false;
    const generation = s.generation, workspace = s.workspace, result = await request("create", { name: file.name.replace(/\.excalidraw$/i, "").slice(0, 100) || "导入的白板", scene });
    if (result.workspace !== workspace) throw new Error("工作文件夹已变化，请重新打开白板。");
    return adopt(result.board, generation, workspace);
  }
  async function exportJson() { if (!s.board) return; try { await snapshot(); } catch { /* Preserve the latest parent snapshot even if the editor stopped responding. */ } download(new Blob([JSON.stringify(s.scene || EMPTY_SCENE, null, 2)], { type: "application/json" }), `${filename(s.name)}.excalidraw`); }
  async function exportImage(format) {
    if (!s.board) return;
    const result = await rpc("export", { format });
    if (result?.token !== s.token || !(result.blob instanceof Blob)) throw new Error("图片导出未完成，请重试。");
    download(result.blob, `${filename(s.name)}.${format}`); toast(`已导出 ${format.toUpperCase()} 图片。`);
  }
  async function saveAsNew() {
    if (!s.board) return false;
    await ai?.beforeLeave();
    try { await snapshot(); } catch { /* Use the retained scene when the editor is unavailable. */ }
    const generation = s.generation, workspace = s.workspace, result = await request("create", { name: `${s.name.trim() || "未命名白板"} 副本`.slice(0, 100), scene: s.scene });
    if (result.workspace !== workspace) throw new Error("工作文件夹已变化，请重新打开白板。");
    return adopt(result.board, generation, workspace);
  }
  async function reloadEditor() {
    await ai?.beforeLeave();
    if (s.board) { try { await snapshot(); } catch { /* Retained content will be restored into the new editor. */ } }
    const scene = s.scene || EMPTY_SCENE, token = s.token;
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error("编辑器正在重新加载。")); } pending.clear();
    s.frame?._whiteboardCancel?.();
    s.frame?.remove(); s.frame = null; s.framePromise = null; s.ready = false; s.frameError = false; s.error = "";
    if (!s.board) { await ensureFrame(); render(); return true; }
    const result = await rpc("load", { scene, token });
    if (result?.token === token && token === s.token && sceneObject(result.scene)) { setScene(result.scene); render(); return true; } return false;
  }
  async function aiContext() {
    if (!s.board) throw new Error("请先创建或选择一块白板。");
    if (s.action || s.freezing || s.frameError) throw new Error("请等待当前白板操作完成后再绘图。");
    if (!(await flush())) throw new Error("当前白板尚未保存，请先处理上方保存提示。");
    return { workspace: s.workspace, id: s.board.id, name: s.name, revision: s.board.revision, token: s.token, canvasVersion: s.canvasVersion };
  }
  function matchingContext(context) { return context && context.workspace === s.workspace && context.workspace === getWorkspace() && context.id === s.board?.id && context.token === s.token && context.name === s.name && context.canvasVersion === s.canvasVersion; }
  async function canvasAction(action) {
    if (s.action || s.freezing || s.frameError) throw new Error("白板正忙，请稍后重新生成。");
    s.busy = true; const task = Promise.resolve().then(action); s.action = task; render();
    try { return await task; } finally { if (s.action === task) { s.action = null; s.busy = false; render(); } }
  }
  async function applyAIDrawing(drawings, context, isCurrent = () => true) {
    return canvasAction(async () => {
      await snapshot();
      if (!isCurrent() || !matchingContext(context)) throw new Error("画布在生成期间已经变化，本次绘图未应用。请基于当前画布重新生成。");
      if (!Array.isArray(drawings) || drawings.length !== 1) throw new Error("绘图结果格式无效，未修改当前画布。");
      const result = await rpc("applyDrawing", { token: s.token, expectedCanvasVersion: s.canvasVersion, patch: drawings[0] });
      if (result?.token !== s.token || !sceneObject(result.scene) || !Number.isSafeInteger(result.canvasVersion) || typeof result.operationId !== "string") throw new Error("未收到有效的绘图结果，请检查画布。");
      changed(result.scene, result.canvasVersion);
      const saved = await flush({ capture: false });
      return { operationId: result.operationId, canvasVersion: result.canvasVersion, saved };
    });
  }
  async function undoAIDrawing(operation) {
    return canvasAction(async () => {
      await snapshot(); const context = { ...operation.context, canvasVersion: operation.canvasVersion };
      if (!matchingContext(context)) throw new Error("画布已有后续编辑，请使用画布的撤销功能逐步撤回。");
      const result = await rpc("undoDrawing", { token: s.token, operationId: operation.operationId, expectedCanvasVersion: operation.canvasVersion });
      if (result?.token !== s.token || !sceneObject(result.scene) || !Number.isSafeInteger(result.canvasVersion)) throw new Error("撤销未完成，请检查当前画布。");
      changed(result.scene, result.canvasVersion); const saved = await flush({ capture: false }); return { canvasVersion: result.canvasVersion, saved };
    });
  }
  async function beforeLeave() {
    if (!root || !s.board) return true;
    await ai?.beforeLeave();
    if (s.action) { try { await s.action; } catch { /* A failed action retains the existing scene. */ } }
    s.freezing = true; render();
    try { const saved = await flush(); if (!saved) toast("白板更改尚未保存，请重试、下载副本或另存为新白板后再离开。"); return saved; }
    finally { s.freezing = false; render(); }
  }
  async function workspaceChanged(workspace) {
    if (workspace === s.workspace) return false;
    await ai?.beforeLeave();
    if (s.workspace && s.dirty && !(await beforeLeave())) return false;
    clearTimeout(s.timer); s.generation++; s.workspace = workspace; s.boards = []; s.board = null; s.name = ""; s.scene = null; s.sceneKey = ""; s.dirty = false; s.conflict = false; s.error = ""; s.token = nonce();
    if (s.ready && !s.frameError) void rpc("load", { scene: EMPTY_SCENE, token: s.token }).catch(() => {});
    render(); return true;
  }
  async function open() {
    mounted(); const workspace = getWorkspace();
    if (workspace !== s.workspace) { const changedWorkspace = await workspaceChanged(workspace); if (!changedWorkspace && workspace !== s.workspace) return false; }
    return runAction(async () => { if (!(await listBoards())) return false; if (s.frameError) await reloadEditor(); if (!s.board && s.boards.length) return chooseBoard(s.boards[0].id); void ensureFrame().catch(fail); s.error = ""; render(); return true; });
  }
  return { open, refresh: open, workspaceChanged, beforeLeave };
}
