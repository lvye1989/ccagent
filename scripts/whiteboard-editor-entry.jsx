import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import "@excalidraw/excalidraw/index.css";
import { reconcileWhiteboardBindings } from "../web/whiteboard-ai.js";
import { DESIGN_BASE_MAX_EDGE, validateDesignImage, designMetadata, selectDesignBase, buildDesignImageSkeleton, designExportPlan, assertDesignSceneSize } from "../web/whiteboard-design-canvas.js";

// Excalidraw reads this when its module initializes. Fonts and code remain local.
window.EXCALIDRAW_ASSET_PATH = "/whiteboard-assets/";
const TYPE = "ccagent-whiteboard";
const channel = new URLSearchParams(window.location.hash.slice(1)).get("channel");
const origin = window.location.origin;
const rootElement = document.getElementById("whiteboard-editor-root");
const empty = { type: "excalidraw", version: 2, source: "CCAGENT", elements: [], appState: {}, files: {} };
let library, api, currentToken = "", currentKey = 0, loading = true, lastJson = "", versionJson = "", canvasVersion = 0, publishTimer, replaceBoard, activeLoad, userInteracted = false, hasChanges = false, applying = false, lastOperation;
let appliedRequests = new Set();
function post(message) { if (channel && window.parent !== window) window.parent.postMessage({ type: TYPE, channel, ...message }, origin); }
function response(id, payload, error) { post({ kind: "response", id, payload, ...(error ? { error } : {}) }); }
function isScene(value) { return value && typeof value === "object" && !Array.isArray(value) && Array.isArray(value.elements) && (!value.appState || (typeof value.appState === "object" && !Array.isArray(value.appState))) && (!value.files || (typeof value.files === "object" && !Array.isArray(value.files))); }
function snapshot() {
  if (!api) throw new Error("白板编辑器尚未准备好。");
  const json = library.serializeAsJSON(api.getSceneElementsIncludingDeleted(), api.getAppState(), api.getFiles(), "local");
  const scene = JSON.parse(json);
  const content = JSON.stringify({ elements: scene.elements, files: scene.files, background: scene.appState?.viewBackgroundColor });
  if (!loading && userInteracted && content !== versionJson) { hasChanges = true; canvasVersion++; }
  versionJson = content;
  return { scene, json, token: currentToken, hasChanges, canvasVersion };
}
function publish() {
  clearTimeout(publishTimer); if (loading || !api || !currentToken) return;
  try { const result = snapshot(); if (result.json !== lastJson) { lastJson = result.json; if (result.hasChanges) post({ kind: "change", payload: { scene: result.scene, token: result.token, canvasVersion: result.canvasVersion } }); } }
  catch { post({ kind: "error", error: "无法读取当前画布，更改仍保留在编辑器中。" }); }
}
function onChange() { if (!loading) { clearTimeout(publishTimer); publishTimer = setTimeout(publish, 80); } }
function onApiReady(instance, key, token) {
  if (key !== currentKey) return; api = instance;
  if (!token) { loading = false; lastJson = snapshot().json; post({ kind: "ready" }); return; }
  // Initial onChange is not an edit. Normalize after the initial scene is mounted.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (key !== currentKey) return;
    try {
      const result = snapshot(); lastJson = result.json; loading = false; api.history.clear();
      if (activeLoad?.key === key) { response(activeLoad.id, { scene: result.scene, token, hasChanges: false, canvasVersion }); activeLoad = undefined; }
    } catch { if (activeLoad?.key === key) { response(activeLoad.id, undefined, "白板文件未能加载，请检查文件后重试。"); activeLoad = undefined; } }
  }));
}
function normalized(scene) {
  const restored = library.restore(scene, null, null);
  return { elements: restored.elements, files: restored.files, appState: { ...restored.appState, theme: "light", openDialog: null, openMenu: null, openSidebar: null, showWelcomeScreen: false, isLoading: false } };
}
async function load(id, payload) {
  if (!isScene(payload?.scene) || typeof payload?.token !== "string" || payload.token.length > 100) throw new Error("白板数据无效。");
  if (activeLoad) response(activeLoad.id, undefined, "已切换到另一块白板。");
  clearTimeout(publishTimer); loading = true; userInteracted = false; hasChanges = false; canvasVersion = 0; versionJson = ""; lastOperation = undefined; appliedRequests = new Set(); api = undefined; currentToken = payload.token; currentKey++;
  const initialData = normalized(payload.scene); activeLoad = { id, key: currentKey };
  // Remount instead of resetScene: Excalidraw's reset retains cached image IDs.
  replaceBoard({ key: currentKey, token: currentToken, initialData });
}
function cleanedSvg(svg) {
  svg.querySelectorAll("foreignObject,script").forEach((element) => element.remove());
  svg.querySelectorAll("a").forEach((element) => element.replaceWith(...element.childNodes));
  for (const element of svg.querySelectorAll("*")) {
    for (const attribute of [...element.attributes]) {
      if (/^on/i.test(attribute.name)) element.removeAttribute(attribute.name);
      if (["href", "xlink:href", "src"].includes(attribute.name) && !/^(?:#|data:image\/)/i.test(attribute.value)) element.removeAttribute(attribute.name);
    }
  }
  return svg.outerHTML;
}
async function exportImage(format) {
  if (!api || loading || !["png", "svg"].includes(format)) throw new Error("请选择 PNG 或 SVG 导出。");
  const token = currentToken;
  const elements = api.getSceneElements().filter((element) => !["embeddable", "iframe"].includes(element.type));
  if (!elements.length) throw new Error("画布还是空的，添加一些内容后再导出图片。");
  const appState = { ...api.getAppState(), exportBackground: true, exportWithDarkMode: false };
  const files = api.getFiles();
  if (format === "png") {
    const blob = await library.exportToBlob({ elements, appState, files, mimeType: "image/png", maxWidthOrHeight: 4096, exportPadding: 16 });
    return { token, blob };
  }
  const svg = await library.exportToSvg({ elements, appState, files, exportPadding: 16, renderEmbeddables: false });
  return { token, blob: new Blob([cleanedSvg(svg)], { type: "image/svg+xml;charset=utf-8" }) };
}
function drawingPatch(value) {
  if (!value || value.version !== 1 || typeof value.requestId !== "string" || !value.requestId || value.requestId.length > 160 || !Array.isArray(value.skeletons) || value.skeletons.length > 1000 || !Array.isArray(value.deleteIds) || value.deleteIds.length > 1000 || !Array.isArray(value.contextIds) || !value.labelIds || typeof value.labelIds !== "object") throw new Error("绘图结果格式无效，当前画布未修改。");
  if (JSON.stringify(value).length > 2 * 1024 * 1024) throw new Error("绘图结果过大，当前画布未修改。");
  const ids = new Set();
  for (const item of value.skeletons) {
    if (!item || typeof item !== "object" || typeof item.id !== "string" || !item.id || ids.has(item.id) || ["embeddable", "iframe"].includes(item.type)) throw new Error("绘图元素无效，当前画布未修改。"); ids.add(item.id);
  }
  if (!value.deleteIds.every((id) => typeof id === "string") || !value.contextIds.every((id) => typeof id === "string") || !Object.values(value.labelIds).every((id) => typeof id === "string")) throw new Error("绘图引用无效。");
  return value;
}
function comparable(value) { const result = { ...value }; for (const key of ["version", "versionNonce", "updated", "index"]) delete result[key]; return JSON.stringify(result); }
function replaceElement(before, after) {
  const updates = { ...after }; for (const key of ["version", "versionNonce", "updated"]) delete updates[key]; updates.index = before.index;
  return comparable(before) === comparable({ ...before, ...updates }) ? before : library.newElementWith(before, updates);
}
function mergePatch(elements, patch) {
  const known = new Map(elements.map((item) => [item.id, item])); const deleted = new Set(patch.deleteIds);
  if (patch.deleteIds.some((id) => !known.has(id)) || patch.contextIds.some((id) => !known.has(id))) throw new Error("绘图引用的元素已经变化，请重新生成。");
  const allowed = new Set([...patch.skeletons.map((item) => item.id), ...Object.values(patch.labelIds)]);
  const converted = library.convertToExcalidrawElements(patch.skeletons, { regenerateIds: false });
  if (converted.some((item) => !allowed.has(item.id) || ["embeddable", "iframe"].includes(item.type))) throw new Error("绘图转换产生了无效引用，当前画布未修改。");
  const replacements = new Map(converted.map((item) => [item.id, item]));
  const merged = elements.map((item) => deleted.has(item.id) ? library.newElementWith(item, { isDeleted: true }) : replacements.has(item.id) ? replaceElement(item, replacements.get(item.id)) : item);
  for (const item of converted) if (!known.has(item.id) && !deleted.has(item.id)) merged.push(item);
  return reconcileWhiteboardBindings(merged, patch.deleteIds, (item, changes) => library.newElementWith(item, changes));
}
async function applyElements(elements) {
  applying = true; userInteracted = true;
  const boardKey = currentKey, boardApi = api;
  try {
    boardApi.updateScene({ elements, captureUpdate: library.CaptureUpdateAction.IMMEDIATELY });
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await document.fonts?.ready;
    if (currentKey !== boardKey || api !== boardApi) throw new Error("画布已切换，本次操作未应用到新画布。");
    const result = snapshot(); lastJson = result.json; clearTimeout(publishTimer); return result;
  } finally { applying = false; }
}
async function applyDrawing(payload) {
  if (!api || loading || applying || payload?.token !== currentToken || payload?.expectedCanvasVersion !== snapshot().canvasVersion) throw new Error("画布在生成期间已经变化，本次绘图未应用。请重新生成。");
  const patch = drawingPatch(payload.patch); if (appliedRequests.has(patch.requestId)) throw new Error("这次绘图已经应用，无需重复执行。");
  const before = structuredClone(api.getSceneElementsIncludingDeleted()); const result = await applyElements(mergePatch(api.getSceneElementsIncludingDeleted(), patch));
  api.scrollToContent(undefined, { fitToContent: true, maxZoom: 1 });
  appliedRequests.add(patch.requestId); lastOperation = { id: crypto.randomUUID(), before, canvasVersion: result.canvasVersion };
  return { scene: result.scene, token: currentToken, canvasVersion: result.canvasVersion, operationId: lastOperation.id };
}
async function undoDrawing(payload) {
  if (!api || loading || applying || payload?.token !== currentToken || !lastOperation || lastOperation.id !== payload?.operationId || payload.expectedCanvasVersion !== snapshot().canvasVersion || lastOperation.canvasVersion !== canvasVersion) throw new Error("画布已有后续编辑，请使用画布的撤销功能逐步撤回。");
  const previous = new Map(lastOperation.before.map((item) => [item.id, item])); const current = api.getSceneElementsIncludingDeleted();
  const restored = current.map((item) => previous.has(item.id) ? replaceElement(item, previous.get(item.id)) : library.newElementWith(item, { isDeleted: true }));
  for (const item of lastOperation.before) if (!current.some((value) => value.id === item.id)) restored.push(item);
  const result = await applyElements(restored); lastOperation = undefined;
  return { scene: result.scene, token: currentToken, canvasVersion: result.canvasVersion };
}
function requireDesignContext(payload, checkVersion = false) {
  if (!api || loading || applying || !currentToken || payload?.token !== currentToken) throw new Error("画布已切换，请在当前画布重试。");
  const current = snapshot();
  if (checkVersion && payload.expectedCanvasVersion !== current.canvasVersion) throw new Error("画布已经变化，本次图片未导入，请重新操作。");
  return current;
}
function decodeDesignImage(image) {
  return new Promise((resolve, reject) => {
    const decoded = new Image();
    const timer = setTimeout(() => { decoded.src = ""; reject(new Error("图片解码超时，请缩小图片后重试。")); }, 15000);
    decoded.onload = () => {
      clearTimeout(timer);
      if (decoded.naturalWidth !== image.width || decoded.naturalHeight !== image.height) reject(new Error("图片方向或尺寸不符，请重新导出图片后再导入。"));
      else resolve();
    };
    decoded.onerror = () => { clearTimeout(timer); reject(new Error("图片无法解码，请重新导出图片后再导入。")); };
    decoded.src = image.dataURL;
  });
}
async function importDesignImage(payload) {
  requireDesignContext(payload, true);
  const requestId = payload.requestId ?? crypto.randomUUID();
  if (typeof requestId !== "string" || !requestId || requestId.length > 160) throw new Error("图片请求编号无效。");
  if (appliedRequests.has(`design:${requestId}`)) throw new Error("这张图片已经导入，无需重复操作。");
  const image = validateDesignImage(payload.image);
  if (payload.role === "base" && Math.max(image.width, image.height) > DESIGN_BASE_MAX_EDGE) throw new Error("原图边长不能超过 2048 像素，请缩小图片后重新导入。");
  await decodeDesignImage(image);
  const current = requireDesignContext(payload, true);
  if (appliedRequests.has(`design:${requestId}`)) throw new Error("这张图片已经导入，无需重复操作。");
  const imageId = `design_${crypto.randomUUID()}`, fileId = `design_file_${crypto.randomUUID()}`;
  const skeleton = buildDesignImageSkeleton(api.getSceneElementsIncludingDeleted(), image, payload.role, { imageId, fileId, baseImageId: payload.baseImageId, requestId });
  const converted = library.convertToExcalidrawElements([skeleton], { regenerateIds: false });
  if (converted.length !== 1 || converted[0].id !== imageId || converted[0].type !== "image") throw new Error("图片元素未能创建，画布未修改。");
  const file = { id: fileId, mimeType: image.mimeType, dataURL: image.dataURL, created: Date.now() };
  const elements = [...api.getSceneElementsIncludingDeleted(), converted[0]];
  assertDesignSceneSize(JSON.parse(library.serializeAsJSON(elements, api.getAppState(), { ...api.getFiles(), [fileId]: file }, "local")));
  api.addFiles([file]);
  const result = await applyElements(elements);
  api.scrollToContent(converted, { fitToContent: true, maxZoom: 1 });
  appliedRequests.add(`design:${requestId}`); lastOperation = undefined;
  return { scene: result.scene, token: currentToken, canvasVersion: result.canvasVersion, imageId, fileId };
}
async function blobDataURL(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader(); reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("勾画图片读取失败，请重试。")); reader.readAsDataURL(blob);
  });
}
async function designSnapshot(payload) {
  const current = requireDesignContext(payload);
  const plan = designExportPlan(current.scene.elements, current.scene.files, payload.baseImageId);
  const [convertedFrame] = library.convertToExcalidrawElements([plan.frame], { regenerateIds: false });
  // 0.18.1's skeleton converter treats x/y = 0 as absent and adds frame padding.
  // Restore exact bounds explicitly so markup and original pixels stay aligned.
  const frame = { ...convertedFrame, x: plan.frame.x, y: plan.frame.y, width: plan.frame.width, height: plan.frame.height, angle: 0 };
  const blob = await library.exportToBlob({
    elements: plan.elements, files: current.scene.files,
    appState: { ...api.getAppState(), exportBackground: true, viewBackgroundColor: "#ffffff", exportWithDarkMode: false, exportEmbedScene: false, exportScale: 1 },
    exportingFrame: frame, exportPadding: 0, mimeType: "image/png",
    getDimensions: () => ({ width: plan.width, height: plan.height, scale: plan.scale }),
  });
  const dataURL = await blobDataURL(blob);
  const after = requireDesignContext(payload);
  if (after.canvasVersion !== current.canvasVersion) throw new Error("导出期间画布已变化，请重新生成以使用最新勾画。");
  const annotated = validateDesignImage({ dataURL, mimeType: "image/png", width: plan.width, height: plan.height });
  return { token: current.token, canvasVersion: current.canvasVersion, base: plan.base, annotated: { dataURL: annotated.dataURL, mimeType: annotated.mimeType, width: annotated.width, height: annotated.height }, references: plan.references, hasMarkup: plan.hasMarkup };
}
function designSketch(payload) {
  const current = requireDesignContext(payload);
  const base = selectDesignBase(api.getSceneElements(), payload.baseImageId);
  api.scrollToContent([base], { fitToContent: true, maxZoom: 1 });
  api.updateScene({ appState: { currentItemStrokeColor: "#e03131", currentItemStrokeWidth: 2, currentItemOpacity: 100, currentItemRoughness: 0, selectedElementIds: {} }, captureUpdate: library.CaptureUpdateAction.NEVER });
  api.setActiveTool({ type: "freedraw", locked: true });
  return { token: current.token, canvasVersion: current.canvasVersion };
}
async function removeDesignImage(payload) {
  requireDesignContext(payload, true);
  const image = api.getSceneElements().find((element) => element.id === payload.imageId && !element.isDeleted && element.type === "image");
  if (!["reference", "result"].includes(designMetadata(image)?.role)) throw new Error("只能通过此入口移除参考图或生成结果，原图不会被删除。");
  const deleted = api.getSceneElementsIncludingDeleted().map((element) => element.id === image.id ? library.newElementWith(element, { isDeleted: true }) : element);
  const elements = reconcileWhiteboardBindings(deleted, [image.id], (element, changes) => library.newElementWith(element, changes));
  const result = await applyElements(elements); lastOperation = undefined;
  return { scene: result.scene, token: currentToken, canvasVersion: result.canvasVersion };
}
window.addEventListener("message", async (event) => {
  if (event.origin !== origin || event.source !== window.parent || !channel) return;
  const message = event.data;
  if (!message || message.type !== TYPE || message.channel !== channel || message.kind !== "request" || typeof message.id !== "string" || message.id.length > 100) return;
  try {
    if (!library || !replaceBoard) throw new Error("白板编辑器尚未准备好。");
    if (message.method === "load") { await load(message.id, message.payload); return; }
    if (message.method === "getScene") { const result = snapshot(); lastJson = result.json; clearTimeout(publishTimer); response(message.id, { scene: result.scene, token: result.token, hasChanges: result.hasChanges, canvasVersion: result.canvasVersion }); return; }
    if (message.method === "export") { response(message.id, await exportImage(message.payload?.format)); return; }
    if (message.method === "applyDrawing") { response(message.id, await applyDrawing(message.payload)); return; }
    if (message.method === "undoDrawing") { response(message.id, await undoDrawing(message.payload)); return; }
    if (message.method === "importDesignImage") { response(message.id, await importDesignImage(message.payload)); return; }
    if (message.method === "designSnapshot") { response(message.id, await designSnapshot(message.payload)); return; }
    if (message.method === "designSketch") { response(message.id, designSketch(message.payload)); return; }
    if (message.method === "removeDesignImage") { response(message.id, await removeDesignImage(message.payload)); return; }
    throw new Error("不支持的白板操作。");
  } catch (error) { response(message.id, undefined, error?.message || "白板操作未完成。"); }
});
// Parent-owned import/export controls keep browser files and navigation explicit.
document.addEventListener("click", (event) => { if (event.target instanceof Element && event.target.closest("a[href]")) { event.preventDefault(); event.stopImmediatePropagation(); } }, true);
for (const kind of ["pointerdown", "keydown", "paste", "drop"]) document.addEventListener(kind, (event) => { if (applying) { event.preventDefault(); event.stopImmediatePropagation(); } else if (!loading) userInteracted = true; }, true);
document.addEventListener("keydown", (event) => {
  if (!(event.ctrlKey || event.metaKey)) return;
  if (["s", "o"].includes(event.key.toLowerCase())) { event.preventDefault(); event.stopImmediatePropagation(); if (event.key.toLowerCase() === "s") post({ kind: "intent", payload: { action: "save" } }); }
}, true);
class EditorBoundary extends React.Component {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch() { post({ kind: "error", error: "白板编辑器遇到问题。更改快照仍保留，可下载副本或重新加载编辑器。" }); }
  render() { return this.state.failed ? <div className="whiteboard-editor-boot" role="alert">编辑器未能继续运行，请使用上方工具栏下载副本后重试。</div> : this.props.children; }
}
try {
  library = await import("@excalidraw/excalidraw");
  const { Excalidraw, MainMenu } = library;
  function Editor() {
    const [board, setBoard] = useState({ key: 0, token: "", initialData: normalized(empty) }); replaceBoard = setBoard;
    return <EditorBoundary key={board.key}><div className="whiteboard-editor-canvas"><Excalidraw
      key={board.key}
      initialData={board.initialData}
      excalidrawAPI={(instance) => onApiReady(instance, board.key, board.token)}
      onChange={onChange}
      langCode="zh-CN"
      theme="light"
      aiEnabled={false}
      isCollaborating={false}
      handleKeyboardGlobally={false}
      autoFocus={false}
      validateEmbeddable={() => false}
      renderEmbeddable={() => null}
      onLinkOpen={(_, event) => event.preventDefault()}
      UIOptions={{ canvasActions: { loadScene: false, saveToActiveFile: false, saveAsImage: false, export: false, toggleTheme: false } }}
    ><MainMenu><MainMenu.Item onSelect={() => api?.scrollToContent()}>居中显示画布</MainMenu.Item><MainMenu.ItemCustom><div className="whiteboard-editor-menu-note">使用上方工具栏保存白板、导入文件或导出图片。</div></MainMenu.ItemCustom></MainMenu></Excalidraw></div></EditorBoundary>;
  }
  if (!channel || window.parent === window) throw new Error("请从 CCAGENT 白板入口打开编辑器。");
  createRoot(rootElement).render(<Editor />);
} catch {
  rootElement.replaceChildren(Object.assign(document.createElement("div"), { className: "whiteboard-editor-boot", textContent: "白板编辑器未能加载，请返回应用重试。" }));
  post({ kind: "error", error: "白板编辑器资源未能加载，请重试。" });
}
