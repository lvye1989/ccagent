/** Offline image rules + real editor RPC control paths. No provider calls or browser install. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { randomUUID } from "node:crypto";
import * as helpers from "../web/whiteboard-design-canvas.js";
import { reconcileWhiteboardBindings } from "../web/whiteboard-ai.js";

const { validateDesignImage, designMetadata, buildDesignImageSkeleton, designExportPlan, assertDesignSceneSize } = helpers;
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6dV8AAAAASUVORK5CYII=", "base64");
const tiny = { dataURL: `data:image/png;base64,${png.toString("base64")}`, mimeType: "image/png", width: 1, height: 1, name: "原图.png" };
function fakePng(width, height) { const bytes = Buffer.from(png); bytes.writeUInt32BE(width, 16); bytes.writeUInt32BE(height, 20); return { ...tiny, width, height, dataURL: `data:image/png;base64,${bytes.toString("base64")}` }; }
const originalImage = fakePng(1600, 800), referenceImage = fakePng(800, 1200);
assert.deepEqual(validateDesignImage(tiny), tiny);
assert.equal(validateDesignImage({ ...tiny, name: "\0设计\n图.png" }).name, "设计图.png");
for (const invalid of [
  { ...tiny, dataURL: "https://example.test/private.png" }, { ...tiny, mimeType: "image/svg+xml" },
  { ...tiny, width: 9 }, { ...tiny, dataURL: tiny.dataURL + "=" }, { ...tiny, dataURL: "data:image/png;base64,PHN2Zz48L3N2Zz4=" },
  fakePng(65536, 65536), fakePng(0, 1), { ...tiny, dataURL: `data:image/png;base64,${"A".repeat(15 * 1024 * 1024)}` },
]) assert.throws(() => validateDesignImage(invalid));

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 8, 8, 0, 10, 0, 20, 0, 0xff, 0xd9]);
assert.equal(validateDesignImage({ dataURL: `data:image/jpeg;base64,${jpeg.toString("base64")}`, mimeType: "image/jpeg", width: 20, height: 10 }).height, 10);
const webp = Buffer.alloc(30); webp.write("RIFF"); webp.writeUInt32LE(22, 4); webp.write("WEBPVP8X", 8); webp.writeUInt32LE(10, 16); webp[24] = 49; webp[27] = 24;
assert.equal(validateDesignImage({ dataURL: `data:image/webp;base64,${webp.toString("base64")}`, mimeType: "image/webp", width: 50, height: 25 }).width, 50);

const manual = { id: "manual", type: "rectangle", x: 20, y: 30, width: 100, height: 80, angle: 0 };
const base = buildDesignImageSkeleton([manual], originalImage, "base", { imageId: "base", fileId: "base_file", requestId: "import-base" });
assert.equal(base.locked, true); assert.equal(base.x, 216); assert.equal(base.width, 960); assert.equal(base.height, 480); assert.equal(base.angle, 0);
const reference = buildDesignImageSkeleton([manual, base], referenceImage, "reference", { imageId: "reference", fileId: "reference_file", baseImageId: "base" });
assert.equal(reference.customData.ccagentDesign.baseImageId, "base"); assert.equal(reference.x, base.x + base.width + 64); assert.equal(reference.locked, false);
const reference2 = buildDesignImageSkeleton([base, reference], referenceImage, "reference", { imageId: "reference2", fileId: "reference_file2" });
assert.ok(reference2.y > reference.y + reference.height);
assert.throws(() => buildDesignImageSkeleton([base, reference, reference2], tiny, "reference", { imageId: "third", fileId: "third_file" }), /最多/);
assert.doesNotThrow(() => buildDesignImageSkeleton([base, { ...reference, isDeleted: true }, reference2], tiny, "reference", { imageId: "third", fileId: "third_file" }));
const result = buildDesignImageSkeleton([base, reference], originalImage, "result", { imageId: "result", fileId: "result_file", baseImageId: "base" });
const noBaseResult = buildDesignImageSkeleton([], originalImage, "result", { imageId: "text_result", fileId: "text_result_file" });
assert.equal(noBaseResult.customData.ccagentDesign.baseImageId, undefined); assert.equal(noBaseResult.x, 0);
assert.equal(result.y, base.y + base.height + 96); assert.equal(result.x, base.x);
const result2 = buildDesignImageSkeleton([base, result], originalImage, "result", { imageId: "result2", fileId: "result2_file" });
assert.ok(result2.x > result.x + result.width);
assert.throws(() => buildDesignImageSkeleton([], tiny, "reference", { imageId: "ref", fileId: "file" }), /原图/);
assert.throws(() => buildDesignImageSkeleton([], tiny, "anything", { imageId: "ref", fileId: "file" }));
assert.throws(() => buildDesignImageSkeleton([], fakePng(4000, 2000), "base", { imageId: "base", fileId: "file" }), /2048/);
assert.equal(designMetadata({ customData: { ccagentDesign: { version: 2, role: "base" } } }), undefined);

const files = { base_file: { ...originalImage, id: "base_file", created: 1 }, reference_file: { ...referenceImage, id: "reference_file", created: 1 } };
const mark = { id: "mark", type: "freedraw", x: base.x + 20, y: base.y + 25, width: 100, height: 60, angle: 0, frameId: "existing_frame", strokeWidth: 2, points: [[0, 0], [100, 60]] };
const crossing = { id: "crossing", type: "line", x: base.x - 100, y: base.y + 20, width: 200, height: 0, angle: 0, points: [[0, 0], [200, 0]] };
const otherBase = { ...base, id: "other_base", fileId: "other_file" };
const unrelatedReference = { ...reference, id: "other_ref", customData: { ccagentDesign: { ...designMetadata(reference), baseImageId: "other_base" } } };
const overlappingReference = { ...reference, x: base.x + 20, y: base.y + 20 };
const overlappingResult = { ...result, x: base.x + 30, y: base.y + 30 };
const sceneElements = [manual, base, mark, crossing, overlappingReference, overlappingResult, otherBase, unrelatedReference, { ...mark, id: "deleted", isDeleted: true }, { ...mark, id: "far", x: 99999 }, { ...mark, id: "frame", type: "frame" }];
const before = structuredClone(sceneElements);
const plan = designExportPlan(sceneElements, files, "base");
assert.deepEqual(plan.elements.map((element) => element.id), ["base", "mark", "crossing"]);
assert.equal(plan.elements.find((element) => element.id === "mark").frameId, null);
assert.deepEqual(sceneElements, before, "Export planning preserves every live element and its frame binding");
assert.equal(plan.references.length, 1); assert.equal(plan.references[0].elementId, "reference"); assert.equal(plan.hasMarkup, true);
assert.equal(plan.width, 1600); assert.equal(plan.height, 800); assert.equal(plan.scale, 1600 / 960); assert.equal(plan.frame.x, base.x); assert.equal(plan.frame.width, base.width);
assert.equal(designExportPlan([base], files).hasMarkup, false);
for (const edit of [{ angle: 0.2 }, { crop: { x: 1 } }, { scale: [-1, 1] }, { width: 80 }, { height: 0 }]) assert.throws(() => designExportPlan([{ ...base, ...edit }], files), /原图/);
assert.throws(() => designExportPlan([base], {}));
assert.throws(() => assertDesignSceneSize({ large: "x".repeat(11 * 1024 * 1024) }), /10MB/);
assert.doesNotThrow(() => assertDesignSceneSize({ elements: [base], files }));

// Execute the actual parent-message handler with an isolated SDK double. Real
// rendering is exercised by the app browser check; these assertions target races,
// stale guards, deduplication, strict RPC scope, and undo capture semantics.
const entry = await readFile(new URL("./whiteboard-editor-entry.jsx", import.meta.url), "utf8");
const controlSource = entry.slice(0, entry.indexOf("// Parent-owned import/export controls")).replace(/^import .*;\r?\n/gm, "");
const replies = [], listeners = new Map(), writes = [], eventOrigin = "http://whiteboard.test";
const parent = { postMessage(message, target) { assert.equal(target, eventOrigin); replies.push(message); } };
const state = { elements: [], files: {}, appState: { viewBackgroundColor: "#ffffff" }, adds: 0, exportGate: undefined, decodeGate: undefined };
const api = {
  getSceneElementsIncludingDeleted: () => state.elements, getSceneElements: () => state.elements.filter((element) => !element.isDeleted),
  getFiles: () => state.files, getAppState: () => state.appState, scrollToContent: (elements) => { state.scrollTarget = elements; },
  updateScene(value) { writes.push(value); if (value.elements) state.elements = value.elements; if (value.appState) state.appState = { ...state.appState, ...value.appState }; },
  addFiles(values) { state.adds++; for (const value of values) state.files[value.id] = value; },
  setActiveTool(value) { state.activeTool = value; }, history: { clear() {} },
};
const library = {
  serializeAsJSON(elements, appState, allFiles) { const files = {}; for (const element of elements) if (!element.isDeleted && element.fileId && allFiles[element.fileId]) files[element.fileId] = allFiles[element.fileId]; return JSON.stringify({ type: "excalidraw", version: 2, source: "CCAGENT", elements: elements.filter((element) => !element.isDeleted), appState, files }); },
  convertToExcalidrawElements: (skeletons) => skeletons.map((value) => ({ version: 1, versionNonce: 0, updated: 1, ...value, ...(value.type === "frame" ? { x: value.x || -10, y: value.y || -10 } : {}) })),
  newElementWith: (element, updates) => ({ ...element, ...updates, version: (element.version || 0) + 1 }),
  CaptureUpdateAction: { IMMEDIATELY: "IMMEDIATELY", NEVER: "NEVER" },
  async exportToBlob(options) { state.exportOptions = options; if (state.exportGate) await state.exportGate; return new Blob([png], { type: "image/png" }); },
};
class TestImage {
  naturalWidth = 1; naturalHeight = 1;
  set src(value) { if (value) Promise.resolve(state.decodeGate).then(() => this.onload?.()); }
}
class TestFileReader {
  readAsDataURL(blob) { blob.arrayBuffer().then((buffer) => { this.result = `data:${blob.type};base64,${Buffer.from(buffer).toString("base64")}`; this.onload(); }); }
}
const context = vm.createContext({ ...helpers, reconcileWhiteboardBindings, console, Image: TestImage, FileReader: TestFileReader, Blob, TextEncoder, URLSearchParams, structuredClone, crypto: { randomUUID }, setTimeout, clearTimeout,
  requestAnimationFrame: (callback) => queueMicrotask(callback), document: { getElementById: () => ({}), fonts: { ready: Promise.resolve() } },
  window: { location: { origin: eventOrigin, hash: "#channel=channel-a" }, parent, addEventListener: (kind, listener) => listeners.set(kind, listener) }, __api: api, __library: library,
});
vm.runInContext(`${controlSource}\nlibrary = __library; api = __api; currentToken = 'board-a'; currentKey = 1; loading = false; replaceBoard = () => {}; snapshot();`, context);
let serial = 0;
async function request(method, payload, overrides = {}) {
  const id = `request-${++serial}`;
  await listeners.get("message")({ origin: eventOrigin, source: parent, data: { type: "ccagent-whiteboard", channel: "channel-a", kind: "request", id, method, payload }, ...overrides });
  return replies.find((reply) => reply.id === id);
}
const payload = (extra = {}) => ({ token: "board-a", expectedCanvasVersion: vm.runInContext("canvasVersion", context), ...extra });
assert.equal(await request("importDesignImage", payload({ role: "base", image: tiny }), { origin: "https://hostile.test" }), undefined);
assert.equal(await request("importDesignImage", payload({ role: "base", image: tiny }), { source: {} }), undefined);
assert.equal(state.elements.length, 0, "Foreign windows cannot invoke raster import");
const imported = await request("importDesignImage", payload({ role: "base", image: tiny, requestId: "first" }));
assert.ok(!imported.error, imported.error); assert.equal(state.elements.length, 1); assert.equal(state.elements[0].locked, true); assert.equal(state.adds, 1);
assert.equal(imported.payload.canvasVersion, 1); const baseId = imported.payload.imageId;
assert.equal(writes.at(-1).captureUpdate, "IMMEDIATELY", "Image import is in real editor undo history");
assert.match((await request("importDesignImage", payload({ role: "base", image: tiny, requestId: "first" }))).error, /已经导入/);
assert.match((await request("importDesignImage", payload({ expectedCanvasVersion: 0, role: "base", image: tiny }))).error, /变化/);
assert.equal(state.adds, 1, "Duplicate and stale requests never add binary files");
const oversizedScenePng = Buffer.concat([png, Buffer.alloc(8 * 1024 * 1024)]);
const oversizedSceneImage = { ...tiny, dataURL: `data:image/png;base64,${oversizedScenePng.toString("base64")}` };
assert.match((await request("importDesignImage", payload({ role: "base", image: oversizedSceneImage, requestId: "too-large" }))).error, /画布将超过 10MB/);
assert.equal(state.adds, 1, "Scene size failure does not leave binary files in the editor");
const importedRef = await request("importDesignImage", payload({ role: "reference", baseImageId: baseId, image: tiny, requestId: "reference" }));
assert.ok(!importedRef.error, importedRef.error); assert.equal(state.elements.length, 2);
assert.match((await request("removeDesignImage", payload({ imageId: baseId }))).error, /原图不会/);
const removedRef = await request("removeDesignImage", payload({ imageId: importedRef.payload.imageId }));
assert.ok(!removedRef.error, removedRef.error); assert.equal(state.elements.find((value) => value.id === importedRef.payload.imageId).isDeleted, true);
assert.equal(writes.at(-1).captureUpdate, "IMMEDIATELY");
assert.match((await request("designSketch", payload({ baseImageId: "not-an-original" }))).error, /原图/);
const sketch = await request("designSketch", payload({ baseImageId: baseId }));
assert.ok(!sketch.error, sketch.error); assert.equal(state.activeTool.type, "freedraw"); assert.equal(state.activeTool.locked, true); assert.equal(state.appState.currentItemStrokeColor, "#e03131"); assert.equal(state.elements[0].locked, true);
assert.equal(state.scrollTarget.length, 1); assert.equal(state.scrollTarget[0].id, baseId, "Sketch mode focuses the selected original after a reference import");
const preview = await request("designSnapshot", payload({ baseImageId: baseId }));
assert.ok(!preview.error, preview.error); assert.equal(preview.payload.base.elementId, baseId); assert.equal(preview.payload.references.length, 0); assert.equal(preview.payload.annotated.width, 1);
assert.equal(state.exportOptions.exportingFrame.width, 1); assert.equal(state.exportOptions.exportingFrame.x, 0); assert.equal(state.exportOptions.exportingFrame.y, 0); assert.equal(state.exportOptions.exportPadding, 0); assert.equal(state.exportOptions.appState.exportEmbedScene, false);

let releaseExport;
state.exportGate = new Promise((resolve) => { releaseExport = resolve; });
const oldPreview = request("designSnapshot", payload({ baseImageId: baseId }));
await new Promise((resolve) => setTimeout(resolve, 0));
state.elements = [...state.elements, { id: "manual_during_export", type: "rectangle", x: 0, y: 0, width: 1, height: 1, angle: 0 }];
releaseExport(); assert.match((await oldPreview).error, /期间画布已变化/); state.exportGate = undefined;

state.exportGate = new Promise((resolve) => { releaseExport = resolve; });
const switchedPreview = request("designSnapshot", payload({ baseImageId: baseId }));
await new Promise((resolve) => setTimeout(resolve, 0));
vm.runInContext("currentToken = 'other-board'; currentKey++;", context);
releaseExport(); assert.match((await switchedPreview).error, /画布已切换/); state.exportGate = undefined;
vm.runInContext("currentToken = 'board-a'; currentKey++;", context);

let releaseDecode;
state.decodeGate = new Promise((resolve) => { releaseDecode = resolve; });
const inFlight = request("importDesignImage", payload({ role: "base", image: tiny, requestId: "decoding" }));
vm.runInContext("currentToken = 'board-b'; currentKey++;", context);
releaseDecode(); assert.match((await inFlight).error, /画布已切换/); assert.equal(state.adds, 2, "Decoded image never crosses a board switch"); state.decodeGate = undefined;

assert.match((await request("designSnapshot", { token: "board-a", baseImageId: baseId })).error, /画布已切换/);
assert.equal((await request("arbitraryExec", { token: "board-b", command: "anything" })).error, "不支持的白板操作。");
console.log("whiteboard design canvas: raster validation, layout, crop isolation, strict RPC, stale guards, undo and dedup passed");
