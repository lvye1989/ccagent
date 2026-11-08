/** Offline guards only: no SketchUp, Ruby, screenshot, export or model edit runs. */
import assert from "node:assert/strict";
import path from "node:path";
import { runSketchupWebTest } from "../entrypoint/webSketchup.js";
import type { Tool, ToolResult } from "../tools/Tool.js";

const workspace = path.resolve("output", "offline-sketchup-fixture");
const privatePath = "C:\\PrivateSketchUpUser\\Confidential\\model.skp";
const secret = "SKETCHUP_PRIVATE_TOKEN-do-not-return";
const compatibility = {
  python_version: "0.4.0", ruby_version: "0.4.0", min_compatible_ruby: "0.4.0",
  ruby_min_compatible_python: "0.4.0", compatible: true, error: null,
};
const emptyModel = { path: "", title: "", units: "mm", bounding_box_mm: null, entity_count: 0, layers: ["Untagged"] };
const model = { ...emptyModel, path: privatePath, title: secret, entity_count: 6, bounding_box_mm: { min: [-5, 0, 10], max: [20, 30, 50] } };
const json = (value: unknown): ToolResult => ({ content: JSON.stringify(value) });
type Reply = (name: "get_version" | "get_model_info") => ToolResult | Promise<ToolResult>;
type Call = { name: string; input: Record<string, unknown>; cwd: string };
function fixture(reply: Reply = (name) => json(name === "get_version" ? compatibility : model), enabled = true) {
  const calls: Call[] = [];
  const tools = (["get_version", "get_model_info"] as const).map((name): Tool => ({
    name: `mcp__app-sketchup__${name}`, description: "Offline SketchUp fixture", inputSchema: { type: "object" },
    // Upstream FastMCP lacks readOnlyHint: the fixed allowlist must still work.
    isReadOnly: () => false, isEnabled: () => enabled,
    async call(input, context) { calls.push({ name, input, cwd: context.cwd }); return reply(name); },
  }));
  for (const name of ["mcp__app-sketchup__eval_ruby", "mcp__app-sketchup__create_component", "mcp__app-sketchup__get_viewport_screenshot", "mcp__app-sketchup__export_scene", "mcp__other_server__get_version", "mcp__other_server__get_model_info"]) {
    tools.push({ ...tools[0]!, name, async call() { throw new Error("Non-allowlisted tool must never execute"); } });
  }
  return { tools, calls };
}
function safeResult(result: unknown) {
  const text = JSON.stringify(result);
  assert.ok(!text.includes("PrivateSketchUpUser"), "machine/model paths must not leave the backend probe");
  assert.ok(!text.includes(secret), "upstream diagnostics and private model metadata must not leave the probe");
}
async function probe(reply: Reply) {
  const test = fixture(reply);
  const result = await runSketchupWebTest(workspace, test.tools);
  safeResult(result);
  assert.ok(test.calls.every((call) => call.cwd === workspace && Object.keys(call.input).length === 0));
  return { result, calls: test.calls };
}

const connected = fixture();
const result = await runSketchupWebTest(workspace, connected.tools);
assert.equal(result.ok, true); assert.equal(result.mcpConnected, true); assert.equal(result.sketchupConnected, true);
assert.equal(result.pluginVersion, "0.4.0"); assert.equal(result.version, undefined); assert.ok(result.warning);
assert.equal(result.toolCount, connected.tools.length); safeResult(result);
assert.deepEqual(connected.calls, ["get_version", "get_model_info"].map((name) => ({ name, input: {}, cwd: workspace })));
assert.equal((await probe((name) => json(name === "get_version" ? compatibility : emptyModel))).result.ok, true, "empty unsaved model is a real model");

for (const wrap of [
  (value: unknown) => value,
  (value: unknown) => JSON.stringify(value),
  (value: unknown) => ({ result: value }),
  (value: unknown) => ({ result: { content: [{ type: "text", text: JSON.stringify(value) }], isError: false } }),
  (value: unknown) => ({ structuredContent: value }),
]) {
  const actual = await probe((name) => json(wrap(name === "get_version" ? compatibility : model)));
  assert.equal(actual.result.ok, true, "upstream JSON string and explicit wrapper variants must work");
}
const blocks = await probe((name) => ({ content: [{ type: "text", text: JSON.stringify(name === "get_version" ? compatibility : model) }] }));
assert.equal(blocks.result.ok, true);
const explicitVersion = await probe((name) => json(name === "get_version" ? compatibility : { ...model, sketchup_version: "25.0.634" }));
assert.equal(explicitVersion.result.version, "25.0.634"); assert.equal(explicitVersion.result.warning, undefined);

for (const version of [null, "", "0.4.0", "2025", "25.0.634 " + secret, privatePath, 2025, true, "25.0..3", "25.0\n634"]) {
  const actual = await probe((name) => json(name === "get_version" ? compatibility : { ...model, sketchup_version: version }));
  assert.equal(actual.result.ok, false, "invalid claimed application version must not pass");
  assert.equal(actual.result.version, undefined); assert.equal(actual.result.sketchupConnected, false);
}
const conflictingVersions = await probe((name) => json(name === "get_version" ? { ...compatibility, sketchup_version: "25.0.634" } : { ...model, sketchup_version: "26.0.428" }));
assert.equal(conflictingVersions.result.ok, false);

for (const state of [
  { ...compatibility, compatible: false }, { ...compatibility, compatible: "true" },
  { ...compatibility, ruby_version: privatePath }, { ...compatibility, python_version: null },
  { ...compatibility, ruby_version: "0.3.1" }, { ...compatibility, ruby_min_compatible_python: "0.5.0" },
  { ...compatibility, min_compatible_ruby: "invalid" }, { ...compatibility, ruby_min_compatible_python: false },
  { ...compatibility, error: privatePath + secret }, { compatible: true, version: "2025" },
]) {
  const actual = await probe((name) => json(name === "get_version" ? state : model));
  assert.equal(actual.result.ok, false); assert.equal(actual.result.sketchupConnected, false);
  assert.deepEqual(actual.calls.map((call) => call.name), ["get_version"], "incompatible/unconfirmed extension must stop before model access");
}
const stopped = await probe(() => json({ ...compatibility, ruby_version: null, ruby_min_compatible_python: null, compatible: false, error: "SketchUp not running or extension not started: " + privatePath }));
assert.equal(stopped.result.ok, false); assert.equal(stopped.result.mcpConnected, true); assert.equal(stopped.result.sketchupConnected, false);

for (const state of [
  {}, { ok: true }, { ...model, entity_count: "6" }, { ...model, entity_count: -1 }, { ...model, entity_count: 1.5 },
  { ...model, units: "inch" }, { ...model, title: null }, { ...model, path: 42 }, { ...model, layers: [1] },
  { ...model, bounding_box_mm: undefined }, { ...model, bounding_box_mm: { min: [0, 1], max: [2, 3, 4] } },
  { ...model, bounding_box_mm: { min: [2, 1, 0], max: [1, 2, 3] } },
]) {
  const actual = await probe((name) => json(name === "get_version" ? compatibility : state));
  assert.equal(actual.result.ok, false, "handshake-only or malformed model info must never pass");
  assert.equal(actual.result.mcpConnected, true); assert.equal(actual.result.sketchupConnected, false);
}

for (const badReply of [
  { content: privatePath + secret, isError: true },
  { content: "SketchUp not running or extension not started: " + privatePath + secret },
  json(null), json([]), json("connected"), json({ result: { isError: true, content: JSON.stringify(model) } }),
  json({ error: { code: -32000, message: privatePath + secret }, result: model }),
  json({ ok: false, result: model }), json({ content: [{ type: "image", data: secret }] }),
  { content: "x".repeat(1_000_001) },
]) {
  for (const failingTool of ["get_version", "get_model_info"] as const) {
    const actual = await probe((name) => name === failingTool ? badReply : json(compatibility));
    assert.equal(actual.result.ok, false); assert.equal(actual.result.sketchupConnected, false);
  }
}
const thrown = await probe(() => { throw new Error(privatePath + secret); });
assert.equal(thrown.result.ok, false); assert.equal(thrown.result.mcpConnected, false);

const disabledVersion = fixture(undefined, false);
const disabledModel = fixture();
disabledModel.tools[1] = { ...disabledModel.tools[1]!, isEnabled: () => false };
const wrongServer = fixture();
wrongServer.tools[0] = { ...wrongServer.tools[0]!, name: "mcp__other__get_version" };
const unprefixed = fixture();
unprefixed.tools[0] = { ...unprefixed.tools[0]!, name: "get_version" };
const suffixImpostor = fixture();
suffixImpostor.tools[0] = { ...suffixImpostor.tools[0]!, name: "mcp__app-sketchup-extra__get_version" };
const enableFailure = fixture();
enableFailure.tools[0] = { ...enableFailure.tools[0]!, isEnabled: () => { throw new Error(privatePath + secret); } };
for (const test of [disabledVersion, disabledModel, wrongServer, unprefixed, suffixImpostor, enableFailure]) {
  const actual = await runSketchupWebTest(workspace, test.tools);
  assert.equal(actual.ok, false); assert.equal(actual.mcpConnected, false); assert.equal(test.calls.length, 0);
  safeResult(actual);
}
const disabledDuringProbe = fixture();
disabledDuringProbe.tools[1] = { ...disabledDuringProbe.tools[1]!, isEnabled: () => disabledDuringProbe.calls.length === 0 };
assert.equal((await runSketchupWebTest(workspace, disabledDuringProbe.tools)).ok, false);
assert.deepEqual(disabledDuringProbe.calls.map((call) => call.name), ["get_version"]);
const missingModel = fixture();
assert.equal((await runSketchupWebTest(workspace, missingModel.tools.filter((tool) => !tool.name.endsWith("__get_model_info")))).ok, false);
assert.equal(missingModel.calls.length, 0);
const duplicate = fixture();
assert.equal((await runSketchupWebTest(workspace, [...duplicate.tools, duplicate.tools[0]!])).ok, false);
assert.equal(duplicate.calls.length, 0);
const missing = await runSketchupWebTest(workspace, []);
assert.equal(missing.ok, false); assert.equal(missing.toolCount, 0);

console.log("SketchUp Web offline guards passed: exact read-only tools, workspace binding, actual model validation, separate extension/application versions, safe diagnostics, disabled/error states. No real SketchUp acceptance was performed.");
