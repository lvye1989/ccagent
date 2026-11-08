/** Data-only drawing compiler guards; actual SDK conversion/undo require browser acceptance. */
import assert from "node:assert/strict";
import { compileWhiteboardDrawing, summarizeWhiteboardElements, WhiteboardDrawingError, WHITEBOARD_DRAWING_GUIDE, WHITEBOARD_DRAWING_SCHEMA } from "../entrypoint/whiteboardDrawing.js";

type Element = Record<string, unknown>;
const manual: Element = { id: "manual", type: "freedraw", x: -30, y: 25, width: 40, height: 60, angle: 0, points: [[0, 0], [40, 60]], customData: { user: "keep exactly" } };
const box: Element = { id: "box", type: "rectangle", x: 10, y: 20, width: 200, height: 90, angle: 0, strokeColor: "#123456", backgroundColor: "#aabbcc", strokeWidth: 4, roughness: 0, version: 7, seed: 99, boundElements: [{ id: "label", type: "text" }, { id: "existing-arrow", type: "arrow" }], customData: { user: "preserve" } };
const label: Element = { id: "label", type: "text", text: "手动标签", originalText: "手动标签", containerId: "box", x: 25, y: 45, width: 140, height: 28, angle: 0, fontSize: 24, fontFamily: 3, strokeColor: "#112233" };
const end: Element = { id: "end", type: "ellipse", x: 450, y: 200, width: 180, height: 80, angle: 0, backgroundColor: "#ffffff" };
const arrow: Element = { id: "existing-arrow", type: "arrow", x: 215, y: 65, width: 230, height: 170, angle: 0, points: [[0, 0], [230, 170]], strokeColor: "#102030", startBinding: { elementId: "box", focus: 0, gap: 6 }, endBinding: { elementId: "end", focus: 0, gap: 6 }, version: 3 };
const scene = [manual, box, label, end, arrow];
const original = JSON.stringify(scene);
const context = { requestId: "req-1", elements: scene };
const skeleton = (patch: ReturnType<typeof compileWhiteboardDrawing>, id: string): Element => { const found = patch.skeletons.find((item) => item.id === id); assert.ok(found, `missing skeleton ${id}`); return found; };
function failure(input: unknown, elements = scene): void {
  assert.throws(() => compileWhiteboardDrawing(input, { requestId: "bad-case", elements }), (error: unknown) => error instanceof WhiteboardDrawingError && error.status === 400 && error.code === "invalid_whiteboard_drawing");
  assert.equal(JSON.stringify(scene), original, "rejected inputs must not mutate the current scene");
}

const flow = compileWhiteboardDrawing({ layout: "right", nodes: [
  { id: "start", type: "ellipse", label: "开始", backgroundColor: "#abc" },
  { id: "decision", type: "diamond", label: "通过？" },
  { id: "finish", type: "rectangle", label: "完成" },
], edges: [{ id: "first", from: "start", to: "decision", label: "继续" }, { id: "second", from: "decision", to: "finish" }] }, context);
assert.equal(flow.version, 1); assert.equal(flow.requestId, "req-1");
assert.equal(Object.keys(flow.aliases).length, 5); assert.equal(new Set(Object.values(flow.aliases)).size, 5);
assert.ok(Object.values(flow.aliases).every((id) => /^ai_[a-f0-9]{32}$/.test(id)));
assert.equal(skeleton(flow, flow.aliases.start!).backgroundColor, "#aabbcc");
assert.ok((skeleton(flow, flow.aliases.start!).x as number) > 630, "automatic additions belong beside existing manual content");
assert.ok((skeleton(flow, flow.aliases.finish!).x as number) > (skeleton(flow, flow.aliases.decision!).x as number));
assert.equal(skeleton(flow, flow.aliases.first!).start && (skeleton(flow, flow.aliases.first!).start as Element).id, flow.aliases.start);
assert.equal((skeleton(flow, flow.aliases.first!).end as Element).id, flow.aliases.decision);
assert.equal((skeleton(flow, flow.aliases.start!).label as Element).id, flow.labelIds[flow.aliases.start!]);
assert.equal(flow.contextIds.length, 0); assert.deepEqual(flow.deleteIds, []);
assert.equal(JSON.stringify(scene), original, "compilation must leave manual data immutable");
assert.ok(!flow.skeletons.some((item) => item.id === "manual" || item.id === "box" || item.id === "existing-arrow"));

const edited = compileWhiteboardDrawing({ nodes: [{ id: "box", type: "rectangle", label: "更新后的可编辑文字", strokeColor: "#fed" }] }, context);
assert.equal(edited.aliases.box, "box"); assert.equal(edited.labelIds.box, "label");
const editedBox = skeleton(edited, "box"); assert.equal(editedBox.x, box.x); assert.equal(editedBox.y, box.y); assert.equal(editedBox.width, box.width);
assert.equal(editedBox.strokeColor, "#ffeedd"); assert.equal(editedBox.backgroundColor, box.backgroundColor); assert.equal(editedBox.strokeWidth, 4); assert.equal(editedBox.version, 7);
assert.deepEqual(editedBox.customData, box.customData); assert.deepEqual(editedBox.boundElements, [{ id: "existing-arrow", type: "arrow" }]);
assert.equal((editedBox.label as Element).text, "更新后的可编辑文字"); assert.equal((editedBox.label as Element).fontFamily, 3);
assert.ok(!edited.skeletons.some((item) => item.id === "manual"));
const untouchedLabel = compileWhiteboardDrawing({ nodes: [{ id: "box", type: "rectangle", x: 30 }] }, context);
assert.equal((skeleton(untouchedLabel, "box").label as Element).text, "手动标签");
const erasedLabel = compileWhiteboardDrawing({ nodes: [{ id: "box", type: "rectangle", label: "" }] }, context);
assert.equal(skeleton(erasedLabel, "box").label, undefined); assert.deepEqual(erasedLabel.deleteIds, ["label"]);

const bound = compileWhiteboardDrawing({ edges: [{ id: "existing-arrow", from: "box", to: "end", label: "重新连接" }] }, context);
assert.deepEqual(new Set(bound.contextIds), new Set(["box", "end"]));
assert.equal((skeleton(bound, "existing-arrow").start as Element).id, "box");
assert.equal((skeleton(bound, "existing-arrow").end as Element).id, "end");
assert.equal(skeleton(bound, "existing-arrow").strokeColor, "#102030");
assert.deepEqual(skeleton(bound, "box").boundElements, box.boundElements, "binding context preserves the old label and manual bindings");
assert.ok(!bound.skeletons.some((item) => item.id === "manual"));

const line = compileWhiteboardDrawing({ edges: [{ id: "association", from: "box", to: "end", type: "line", label: "普通连线" }] }, context);
const lineId = line.aliases.association!, lineElement = skeleton(line, lineId), lineText = skeleton(line, line.labelIds[lineId]!);
assert.equal(lineElement.start, undefined); assert.equal(lineElement.end, undefined); assert.equal(lineText.type, "text"); assert.equal(lineText.containerId, null);
assert.equal((lineText.customData as Element).ccagentWhiteboardLabelFor, lineId);
assert.deepEqual((lineElement.customData as Element).ccagentWhiteboardEndpoints, { from: "box", to: "end" });
const relabeledLine = compileWhiteboardDrawing({ edges: [{ id: lineId, from: "box", to: "end", type: "line", label: "更改后" }] }, { requestId: "next", elements: [...scene, lineElement, lineText] });
assert.equal(relabeledLine.labelIds[lineId], lineText.id); assert.equal(skeleton(relabeledLine, String(lineText.id)).text, "更改后");
const deleteLine = compileWhiteboardDrawing({ deleteIds: [lineId] }, { requestId: "next", elements: [...scene, lineElement, lineText] });
assert.deepEqual(new Set(deleteLine.deleteIds), new Set([lineId, String(lineText.id)]));
const deleted = compileWhiteboardDrawing({ deleteIds: ["box"] }, context);
assert.deepEqual(new Set(deleted.deleteIds), new Set(["box", "label"])); assert.deepEqual(deleted.skeletons, []);
assert.ok(!deleted.deleteIds.includes("existing-arrow"), "a connected manual edge is not an implicit deletion target");
const inconsistentBinding = compileWhiteboardDrawing({ deleteIds: ["other-box"] }, { requestId: "ownership", elements: [
  { ...box, id: "other-box", boundElements: [{ id: "label", type: "text" }] }, label,
] });
assert.deepEqual(inconsistentBinding.deleteIds, ["other-box"], "an inconsistent imported binding cannot claim an unrelated manual text element");

const branch = compileWhiteboardDrawing({ nodes: [{ id: "a", type: "rectangle" }, { id: "b", type: "rectangle" }, { id: "c", type: "rectangle" }], edges: [{ id: "ab", from: "a", to: "b" }, { id: "ac", from: "a", to: "c" }] }, { requestId: "branch", elements: [] });
assert.equal(skeleton(branch, branch.aliases.b!).y, skeleton(branch, branch.aliases.c!).y);
assert.notEqual(skeleton(branch, branch.aliases.b!).x, skeleton(branch, branch.aliases.c!).x);
assert.ok((skeleton(branch, branch.aliases.b!).y as number) > (skeleton(branch, branch.aliases.a!).y as number));
const collision = compileWhiteboardDrawing({ nodes: [{ id: "start", type: "rectangle" }] }, { requestId: "req-1", elements: [skeleton(flow, flow.aliases.start!)] });
assert.notEqual(collision.aliases.start, flow.aliases.start, "request-derived IDs must still check actual scene collisions");
const inheritedName = compileWhiteboardDrawing({ nodes: [{ id: "toString", type: "text", label: "安全别名" }, { id: "hasOwnProperty", type: "rectangle" }], edges: [{ id: "safe", from: "toString", to: "hasOwnProperty" }] }, { requestId: "names", elements: [] });
assert.equal(typeof inheritedName.aliases.toString, "string"); assert.ok(inheritedName.skeletons.length >= 3);
const tombstone = { ...box, id: "gone", isDeleted: true };
const fresh = compileWhiteboardDrawing({ nodes: [{ id: "gone", type: "rectangle" }] }, { requestId: "fresh", elements: [tombstone] });
assert.notEqual(fresh.aliases.gone, "gone", "a deleted element cannot be silently resurrected");

for (const input of [null, [], {}, { layout: "diagonal" }, { script: "alert(1)" }, { elements: [] }, { nodes: "bad" }, { nodes: [{ id: "x", type: "image", url: "https://remote/image" }] },
  { nodes: [{ id: "x", type: "rectangle", html: "<b>bad</b>" }] }, { nodes: [{ id: "x", type: "text", label: "<script>alert(1)</script>" }] },
  { nodes: [{ id: "x", type: "text" }] }, { nodes: [{ id: "x", type: "text", label: "\u0000" }] }, { nodes: [{ id: "x", type: "text", label: "x".repeat(2001) }] },
  { nodes: [{ id: "x", type: "rectangle", x: NaN }] }, { nodes: [{ id: "x", type: "rectangle", y: Infinity }] },
  { nodes: [{ id: "x", type: "rectangle", width: 0 }] }, { nodes: [{ id: "x", type: "rectangle", width: 2001 }] },
  { nodes: [{ id: "x", type: "rectangle", x: 1_000_001 }] }, { nodes: [{ id: "x", type: "rectangle", strokeColor: "url(https://evil)" }] },
  { nodes: [{ id: "x", type: "rectangle", fontSize: 100 }] }, { nodes: [{ id: "constructor", type: "rectangle" }] },
  { nodes: [{ id: "x", type: "rectangle" }, { id: "x", type: "rectangle" }] }, { nodes: [{ id: "x", type: "rectangle" }], edges: [{ id: "x", from: "x", to: "end" }] },
  { nodes: [{ id: "box", type: "ellipse" }] }, { edges: [{ id: "e", from: "missing", to: "box" }] }, { edges: [{ id: "e", from: "box", to: "box" }] },
  { edges: [{ id: "e", from: "box", to: "manual" }] }, { edges: [{ id: "e", from: "box", to: "end", type: "iframe" }] },
  { deleteIds: ["../box"] }, { deleteIds: ["missing"] }, { deleteIds: ["box", "box"] }, { deleteIds: ["box"], nodes: [{ id: "box", type: "rectangle" }] },
  { deleteIds: ["box"], edges: [{ id: "e", from: "box", to: "end" }] }, { deleteIds: ["label"], nodes: [{ id: "box", type: "rectangle", label: "conflict" }] },
  { nodes: [{ id: "box", type: "rectangle", label: "box label" }, { id: "label", type: "text", label: "competing label" }] },
  { nodes: [{ id: "box", type: "rectangle", label: "" }, { id: "label", type: "text", label: "competing label" }] },
  { nodes: Array.from({ length: 101 }, (_, index) => ({ id: `n${index}`, type: "rectangle" })) },
  { edges: Array.from({ length: 201 }, (_, index) => ({ id: `e${index}`, from: "box", to: "end" })) },
  { nodes: Array.from({ length: 100 }, (_, index) => ({ id: `n${index}`, type: "rectangle", label: "中".repeat(1000) })) },
  JSON.parse('{"__proto__":{"polluted":true},"nodes":[]}'), { nodes: undefined },
]) failure(input);
const circular: Record<string, unknown> = {}; circular.self = circular; failure(circular);
failure({ nodes: [{ id: "x", type: "rectangle", toJSON: () => ({}) }] });
failure({ deleteIds: ["gone"] }, [tombstone]);
failure({ nodes: [{ id: "x", type: "rectangle" }] }, [box, { ...box }]);
assert.equal(({} as Record<string, unknown>).polluted, undefined);

const image: Element = { id: "image", type: "image", x: 2, y: 3, width: 50, height: 60, fileId: "SECRET_FILE_ID", dataURL: "data:image/png;base64,SECRET_BYTES", customData: { secret: "PRIVATE_MARKER" }, link: "https://SECRET_URL" };
const inventory = summarizeWhiteboardElements([...scene, image, tombstone]);
assert.equal(inventory.total, 6); assert.equal(inventory.truncated, false);
assert.equal(inventory.elements.find((item) => item.id === "box")?.label, "手动标签");
assert.equal(inventory.elements.find((item) => item.id === "existing-arrow")?.from, "box");
assert.equal(inventory.elements.find((item) => item.id === "existing-arrow")?.to, "end");
assert.ok(!/SECRET|PRIVATE_MARKER|dataURL|fileId|customData|https:/.test(JSON.stringify(inventory)));
const largeInventory = summarizeWhiteboardElements(Array.from({ length: 300 }, (_, index) => ({ id: `text${index}`, type: "text", text: "长文字".repeat(1000), x: index, y: 0, width: 50, height: 20 })));
assert.equal(largeInventory.total, 300); assert.equal(largeInventory.truncated, true); assert.ok(largeInventory.elements.length <= 160);
assert.ok(Buffer.byteLength(JSON.stringify(largeInventory), "utf8") < 50 * 1024); assert.ok(largeInventory.elements.every((item) => String(item.label).length <= 500));
const lineInventory = summarizeWhiteboardElements([lineElement, lineText]);
assert.equal(lineInventory.elements.find((item) => item.id === lineId)?.from, "box");
assert.equal(lineInventory.elements.find((item) => item.id === lineId)?.to, "end");
assert.equal(WHITEBOARD_DRAWING_SCHEMA.additionalProperties, false); assert.match(WHITEBOARD_DRAWING_GUIDE, /实际id/);
assert.equal(JSON.stringify(scene), original);
console.log("Whiteboard drawing compiler: validation, scoped aliases, targeted edits, labels, bindings, immutable manual content, graph layout and bounded inventory passed (offline; no SDK/browser claim).");
