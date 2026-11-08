/** Parent-controller regression with a simulated editor transport; not real canvas/browser acceptance. */
import assert from "node:assert/strict";
import { Window } from "happy-dom";

const browser = new Window({ url: "http://whiteboard.test/", settings: { disableJavaScriptFileLoading: true, enableJavaScriptEvaluation: false, enableCSSFileLoading: false, enableImageFileLoading: false, disableIframePageLoading: true } });
browser.document.write('<!doctype html><main id="content"><section id="whiteboard-view" class="hidden"></section></main>');
const savedGlobals = new Map();
for (const key of ["window", "document", "Event", "MessageEvent", "HTMLElement"]) { savedGlobals.set(key, globalThis[key]); globalThis[key] = key === "window" ? browser : browser[key]; }
const originalCreate = URL.createObjectURL, originalRevoke = URL.revokeObjectURL;
const blobs = new Map(), downloads = [], calls = [], messages = [];
URL.createObjectURL = (blob) => { const url = `blob:fixture-${blobs.size}`; blobs.set(url, blob); return url; }; URL.revokeObjectURL = () => {};
browser.HTMLAnchorElement.prototype.click = function () { downloads.push({ name: this.download, blob: blobs.get(this.href) }); };
// The fixture injects its transport; Happy DOM's deliberately disabled loader emits an unrelated error.
const iframeListener = browser.HTMLIFrameElement.prototype.addEventListener;
browser.HTMLIFrameElement.prototype.addEventListener = function (kind, ...args) { if (kind !== "error") return iframeListener.call(this, kind, ...args); };
const empty = { type: "excalidraw", version: 2, source: "fixture", elements: [], appState: {}, files: {} };
const scene = (label) => ({ ...structuredClone(empty), elements: [{ id: label, type: "rectangle", x: 0, y: 0, width: 100, height: 80, version: 1 }] });
let workspace = "C:\\whiteboard-fixture", failure, delaySave = false, releaseSave, nextId = 3;
let editorScene = structuredClone(empty), editorToken = "", editorChanged = false, frame, childWindow;
const stores = new Map(); stores.set(workspace, new Map([["board-1", { id: "board-1", name: "第一块白板", revision: 1, createdAt: "2026-11-07T00:00:00.000Z", updatedAt: "2026-11-07T00:00:00.000Z", elementCount: 0, scene: structuredClone(empty) }], ["board-2", { id: "board-2", name: "第二块白板", revision: 1, createdAt: "2026-11-07T00:00:00.000Z", updatedAt: "2026-11-07T00:00:00.000Z", elementCount: 0, scene: structuredClone(empty) }]]));
function store(path) { if (!stores.has(path)) stores.set(path, new Map()); return stores.get(path); }
function metadata(board) { const { scene: ignored, ...result } = board; return result; }
function response(data, overrides = {}) { window.dispatchEvent(new MessageEvent("message", { origin: window.location.origin, source: frame.contentWindow, data: { type: "ccagent-whiteboard", channel: new URLSearchParams(frame.src.split("#")[1]).get("channel"), ...data }, ...overrides })); }
function edit(value) { editorScene = value; editorChanged = true; response({ kind: "change", payload: { token: editorToken, scene: value } }); }
const api = async (route, options) => {
  const body = options?.body ? JSON.parse(options.body) : undefined; calls.push({ route, body });
  if (route.startsWith("/api/whiteboards?")) { const path = new URL(route, "http://whiteboard.test").searchParams.get("workspace"); return { workspace: path, boards: [...store(path).values()].map(metadata) }; }
  const records = store(body.workspace);
  if (route === "/api/whiteboards/open") return { workspace: body.workspace, board: structuredClone(records.get(body.id)) };
  if (route === "/api/whiteboards/create") {
    const board = { id: `board-${nextId++}`, name: body.name, revision: 1, createdAt: "2026-11-07T01:00:00.000Z", updatedAt: "2026-11-07T01:00:00.000Z", elementCount: (body.scene || empty).elements.length, scene: structuredClone(body.scene || empty) };
    records.set(board.id, board); return { workspace: body.workspace, board: structuredClone(board) };
  }
  if (route === "/api/whiteboards/save") {
    if (delaySave) await new Promise((resolve) => { releaseSave = resolve; });
    if (failure) throw failure;
    const board = records.get(body.id);
    if (board.revision !== body.revision) throw Object.assign(new Error("版本冲突"), { status: 409 });
    Object.assign(board, { name: body.name, revision: board.revision + 1, scene: structuredClone(body.scene), elementCount: body.scene.elements.length, updatedAt: "2026-11-07T02:00:00.000Z" });
    return { workspace: body.workspace, board: metadata(board) };
  }
  throw new Error(`Unexpected fixture API ${route}`);
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
async function until(check, message) { for (let i = 0; i < 80; i++) { if (check()) return; await new Promise((resolve) => setTimeout(resolve, 5)); } assert.fail(message); }
function click(text) { const item = [...document.querySelectorAll("#whiteboard-view button")].find((item) => item.textContent === text); assert.ok(item, text); item.click(); }
const saveCalls = () => calls.filter((call) => call.route === "/api/whiteboards/save");
try {
  const { createWhiteboardUI } = await import("../web/whiteboard.js");
  const ui = createWhiteboardUI({ api, toast: (text) => messages.push(text), getWorkspace: () => workspace });
  assert.equal(document.querySelector("iframe"), null, "Editor is not loaded during application startup");
  const opening = ui.open(); await until(() => document.querySelector("iframe"), "Editor iframe created lazily"); frame = document.querySelector("iframe");
  childWindow = new Window({ url: "http://whiteboard.test/whiteboard-editor.html" }); Object.defineProperty(frame, "contentWindow", { configurable: true, value: childWindow });
  assert.equal(new URL(frame.src).origin, window.location.origin);
  assert.equal(new URL(frame.src).pathname, "/whiteboard-editor.html");
  assert.ok(frame.getAttribute("sandbox").includes("allow-scripts"));
  frame.contentWindow.postMessage = (message, targetOrigin) => {
    assert.equal(targetOrigin, window.location.origin);
    if (message.kind !== "request") return;
    queueMicrotask(() => {
      if (message.method === "load") { editorScene = structuredClone(message.payload.scene); editorToken = message.payload.token; editorChanged = false; response({ kind: "response", id: message.id, payload: { scene: editorScene, token: editorToken, hasChanges: false } }); }
      else if (message.method === "getScene") response({ kind: "response", id: message.id, payload: { scene: editorScene, token: editorToken, hasChanges: editorChanged } });
      else if (message.method === "export") response({ kind: "response", id: message.id, payload: { blob: new Blob([message.payload.format], { type: message.payload.format === "png" ? "image/png" : "image/svg+xml" }), token: editorToken } });
      else assert.fail(`Unexpected editor method ${message.method}`);
    });
  };
  response({ kind: "ready" }); assert.equal(await opening, true, document.getElementById("whiteboard-status").textContent);
  assert.equal(document.getElementById("whiteboard-name").value, "第一块白板");
  assert.equal(await ui.beforeLeave(), true); assert.equal(saveCalls().length, 0, "Initial editor callbacks do not create writes");
  const hostile = scene("hostile");
  response({ kind: "change", payload: { token: editorToken, scene: hostile } }, { origin: "https://hostile.test" });
  response({ kind: "change", payload: { token: editorToken, scene: hostile } }, { source: window });
  response({ kind: "change", channel: "wrong-channel", payload: { token: editorToken, scene: hostile } });
  response({ kind: "change", payload: { token: "wrong-document", scene: hostile } });
  assert.equal(await ui.beforeLeave(), true); assert.equal(saveCalls().length, 0, "Origin, source, nonce and document token reject foreign edits");

  edit(scene("autosaved")); await new Promise((resolve) => setTimeout(resolve, 900));
  assert.equal(saveCalls().length, 1); assert.equal(saveCalls()[0].body.scene.elements[0].id, "autosaved");
  assert.match(document.getElementById("whiteboard-status").textContent, /已保存/);
  edit(scene("during-save-one")); delaySave = true; const leaving = ui.beforeLeave();
  await until(() => releaseSave, "Pending save is awaited before leaving");
  edit(scene("during-save-two")); delaySave = false; releaseSave(); assert.equal(await leaving, true);
  assert.deepEqual(saveCalls().slice(-2).map((call) => call.body.revision), [2, 3]);
  assert.equal(store(workspace).get("board-1").scene.elements[0].id, "during-save-two", "Edits arriving during a save are serialized at the next revision");

  edit(scene("retained-after-error")); failure = new Error("模拟磁盘写入失败");
  assert.equal(await ui.beforeLeave(), false); assert.match(document.getElementById("whiteboard-status").textContent, /当前更改仍保留/);
  const openCount = calls.filter((call) => call.route.endsWith("/open")).length;
  const select = document.getElementById("whiteboard-select"); select.value = "board-2"; select.dispatchEvent(new Event("change")); await tick(); await tick();
  assert.equal(calls.filter((call) => call.route.endsWith("/open")).length, openCount, "Board switch is blocked when pending edits cannot be saved");
  failure = Object.assign(new Error("模拟版本冲突"), { status: 409 }); assert.equal(await ui.beforeLeave(), false);
  assert.match(document.getElementById("whiteboard-status").textContent, /其他页面更新/);
  assert.ok(![...document.querySelectorAll(".whiteboard-recovery button")].some((button) => button.textContent === "重试保存"), "Conflict never offers a blind overwrite retry");
  const conflictedSaves = saveCalls().length; click("＋ 新建白板"); await tick(); await tick(); assert.equal(saveCalls().length, conflictedSaves);
  click("下载未保存副本"); await until(() => downloads.length, "Unsaved JSON can be recovered without a successful write");
  assert.ok(downloads.at(-1).name.endsWith(".excalidraw")); assert.equal(JSON.parse(await downloads.at(-1).blob.text()).elements[0].id, "retained-after-error");
  failure = undefined; click("另存为新白板"); await until(() => document.getElementById("whiteboard-name").value.endsWith("副本"), "Conflict can be resolved by creating a separate board"); await tick();
  assert.equal(store(workspace).get("board-3").scene.elements[0].id, "retained-after-error"); assert.equal(saveCalls().length, conflictedSaves);
  assert.equal(await ui.beforeLeave(), true);
  document.getElementById("whiteboard-export-png").click(); await until(() => downloads.some((item) => item.name.endsWith(".png")), "PNG export downloads its Blob");
  document.getElementById("whiteboard-export-svg").click(); await until(() => downloads.some((item) => item.name.endsWith(".svg")), "SVG export downloads its Blob");

  const fileInput = document.getElementById("whiteboard-import");
  const importFile = (file) => { Object.defineProperty(fileInput, "files", { configurable: true, value: [file] }); fileInput.dispatchEvent(new Event("change")); };
  const creates = calls.filter((call) => call.route.endsWith("/create")).length;
  importFile(new browser.File(["not JSON"], "bad.excalidraw", { type: "application/json" })); await tick(); await tick();
  assert.equal(calls.filter((call) => call.route.endsWith("/create")).length, creates); assert.match(document.getElementById("whiteboard-status").textContent, /有效的 JSON/);
  importFile(new browser.File([JSON.stringify(scene("imported"))], "导入草图.excalidraw", { type: "application/json" }));
  await until(() => document.getElementById("whiteboard-name").value === "导入草图", "Valid scene imports as a separate board"); await tick();
  assert.equal(store(workspace).get("board-4").scene.elements[0].id, "imported");
  const oldToken = editorToken; edit(scene("before-workspace-change")); failure = new Error("模拟工作区保存失败");
  assert.equal(await ui.workspaceChanged("C:\\other-whiteboard"), false, "Workspace switch is blocked if current content cannot be saved");
  failure = undefined; assert.equal(await ui.beforeLeave(), true); workspace = "C:\\other-whiteboard";
  assert.equal(await ui.workspaceChanged(workspace), true);
  response({ kind: "change", payload: { token: oldToken, scene: hostile } }); await tick();
  assert.equal(await ui.open(), true); assert.match(document.getElementById("whiteboard-status").textContent, /当前账号与工作文件夹/);
  click("＋ 新建白板"); await until(() => store(workspace).size === 1, "New board is isolated in the selected workspace"); await tick();
  assert.ok(calls.filter((call) => call.route.endsWith("/save")).every((call) => call.body.workspace === "C:\\whiteboard-fixture"), "Late old-token events cannot write into the new workspace");
  assert.equal(await ui.beforeLeave(), true);
  console.log("Offline whiteboard controller passed: lazy local iframe, initial no-write normalization, origin/source/nonce/token checks, autosave, serialized revision saves, blocked loss, conflict recovery, JSON/PNG/SVG downloads, import validation and workspace isolation. Real Excalidraw rendering is not exercised by this suite.");
} finally {
  URL.createObjectURL = originalCreate; URL.revokeObjectURL = originalRevoke;
  for (const [key, value] of savedGlobals) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; }
  await childWindow?.happyDOM.close();
  await browser.happyDOM.close();
}
