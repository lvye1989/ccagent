/** Offline guard tests only: these fixtures never launch ComfyUI or run a workflow. */
import assert from "node:assert/strict";
import path from "node:path";
import { runComfyuiWebTest } from "../entrypoint/webComfyui.js";
import type { Tool, ToolResult } from "../tools/Tool.js";

const workspace = path.resolve("output", "offline-comfyui-fixture");
const secret = "private-api-key-should-never-be-returned";
const privatePath = "C:\\PrivateUser\\ComfyUI\\models";
const runningState = {
  server: { running: true, url: "http://127.0.0.1:8188" },
  compatibility: { comfy_cli_version: "1.18.0", warnings: [] },
  workspace: { path: privatePath },
  config: { secret },
};
const json = (value: unknown): ToolResult => ({ content: JSON.stringify(value) });
type Reply = () => ToolResult | Promise<ToolResult>;
function fixture(reply: Reply, enabled = true, name = "mcp__offline_comfyui_guard__server_info") {
  const calls: Array<{ name: string; input: Record<string, unknown>; cwd: string }> = [];
  const tool: Tool = {
    name, description: "Offline test fixture", inputSchema: { type: "object" },
    isEnabled: () => enabled, isReadOnly: () => true,
    async call(input, context) { calls.push({ name, input, cwd: context.cwd }); return reply(); },
  };
  const mutationTrap: Tool = {
    ...tool, name: "mcp__offline_comfyui_guard__run_workflow", isReadOnly: () => false,
    async call() { throw new Error("Read-only tests must never call generation, installation or launch tools"); },
  };
  return { tools: [tool, mutationTrap], calls };
}
function safeResult(result: unknown) {
  const text = JSON.stringify(result);
  assert.ok(!text.includes(secret), "raw credentials must not leave the backend probe");
  assert.ok(!text.includes("PrivateUser"), "machine paths must not leave the backend probe");
  assert.ok(!text.includes("COMFY_API_KEY"), "raw environment diagnostics must not leave the backend probe");
}
async function probe(state: unknown) {
  const test = fixture(() => json(state));
  const result = await runComfyuiWebTest(workspace, test.tools);
  safeResult(result);
  assert.deepEqual(test.calls, [{ name: test.tools[0]!.name, input: {}, cwd: workspace }]);
  return result;
}

const connected = await probe(runningState);
assert.equal(connected.ok, true); assert.equal(connected.mcpConnected, true); assert.equal(connected.serverRunning, true);
assert.equal(connected.toolCount, 2); assert.equal(connected.url, "http://127.0.0.1:8188"); assert.equal(connected.version, "1.18.0");

for (const url of ["http://localhost:8188/", "http://[::1]:8189/", "http://127.0.0.1:80"]) {
  const result = await probe({ ...runningState, server: { running: true, url } });
  assert.equal(result.ok, true, `explicit loopback origin must work: ${url}`);
}
const blocks = fixture(() => ({ content: [{ type: "text", text: JSON.stringify(runningState) }] }));
assert.equal((await runComfyuiWebTest(workspace, blocks.tools)).ok, true);
assert.equal((await probe({ result: runningState })).ok, true, "one standard result wrapper is supported");

const stopped = await probe({ ...runningState, server: { running: false, url: null } });
assert.equal(stopped.ok, false); assert.equal(stopped.mcpConnected, true); assert.equal(stopped.serverRunning, false);
assert.equal(stopped.url, undefined); assert.match(stopped.message, /尚未运行/);

for (const server of [null, [], {}, { running: "true", url: "http://127.0.0.1:8188" }, { running: 1, url: "http://127.0.0.1:8188" }, { running: true }, { running: true, url: null }]) {
  const result = await probe({ ...runningState, server });
  assert.equal(result.ok, false, "missing or non-boolean state must never pass");
  assert.equal(result.serverRunning, false);
}
for (const url of [
  "http://192.168.1.2:8188", "https://127.0.0.1:8188", "http://localhost.example.com:8188", "http://127.0.0.2:8188",
  "http://127.1:8188", "http://2130706433:8188", "http://0x7f000001:8188", "http://127.000.000.001:8188",
  "http://127.0.0.1:8188/proxy", "http://127.0.0.1:8188/?token=" + secret, "http://localhost:8188/#private",
  "http://user:password@localhost:8188", "http://127.0.0.1:0", "http://[::ffff:127.0.0.1]:8188", "file:///C:/PrivateUser/ComfyUI",
  "http://127.0.0.1:8188/../", "http://localhost:8188/?", "http://localhost:8188/#", "garbage",
]) {
  const result = await probe({ ...runningState, server: { running: true, url } });
  assert.equal(result.ok, false, `non-canonical or nonlocal URL must not pass: ${url}`);
  assert.equal(result.url, undefined); assert.equal(result.serverRunning, false);
}

for (const target of [
  { host: "192.168.1.20", port: 8188 }, { error: privatePath }, "127.0.0.1", {},
  { host: "localhost", port: "8188" }, { host: "127.0.0.1", port: 0 },
  { host: "[::1", port: 8188 }, { host: "::1]", port: 8188 },
  { host: "127.0.0.1", port: 8189 }, { host: "localhost", port: 8188 },
]) {
  const result = await probe({ ...runningState, comfy_target: target });
  assert.equal(result.ok, false, "remote, malformed or mismatched execution targets must fail the local probe");
  assert.equal(result.serverRunning, false);
}
assert.equal((await probe({ ...runningState, comfy_target: { host: "127.0.0.1", port: 8188 } })).ok, true);
const stoppedRemote = await probe({ ...runningState, server: { running: false, url: null }, comfy_target: { host: "10.0.0.1", port: 8188 } });
assert.equal(stoppedRemote.ok, false); assert.doesNotMatch(stoppedRemote.message, /尚未运行/);

for (const response of [
  { content: privatePath + " " + secret + " COMFY_API_KEY", isError: true },
  { content: "not JSON " + privatePath }, json({ ok: false, error: secret }), json({ error: privatePath }),
  json(null), json([]), json("connected"), json({ result: { ...runningState, error: secret } }),
]) {
  const test = fixture(() => response);
  const result = await runComfyuiWebTest(workspace, test.tools);
  assert.equal(result.ok, false); assert.equal(result.mcpConnected, false); assert.equal(result.serverRunning, false);
  safeResult(result);
}
const thrown = fixture(() => { throw new Error(privatePath + " " + secret + " COMFY_API_KEY"); });
const thrownResult = await runComfyuiWebTest(workspace, thrown.tools);
assert.equal(thrownResult.ok, false); assert.equal(thrownResult.mcpConnected, false); safeResult(thrownResult);

for (const test of [fixture(() => { throw new Error("Disabled tool must not run"); }, false), fixture(() => json(runningState), true, "server_info")]) {
  const result = await runComfyuiWebTest(workspace, test.tools);
  assert.equal(result.ok, false); assert.equal(result.mcpConnected, false); assert.equal(test.calls.length, 0);
}
const missing = await runComfyuiWebTest(workspace, []);
assert.equal(missing.ok, false); assert.equal(missing.toolCount, 0);
const ambiguous = fixture(() => { throw new Error("Ambiguous tool must not run"); });
assert.equal((await runComfyuiWebTest(workspace, [...ambiguous.tools, ambiguous.tools[0]!])).ok, false);
assert.equal(ambiguous.calls.length, 0);

const freshnessFailure = await probe({ ...runningState, freshness: { error: privatePath + " " + secret } });
assert.equal(freshnessFailure.ok, true); assert.match(freshnessFailure.warning!, /更新检查暂不可用/);
const outdated = await probe({ ...runningState, freshness: { core: { outdated: true } } });
assert.equal(outdated.ok, true); assert.match(outdated.warning!, /可用更新/);
const unknownVersion = await probe({ ...runningState, compatibility: { comfy_cli_version: privatePath + secret, warnings: [secret] } });
assert.equal(unknownVersion.ok, true); assert.equal(unknownVersion.version, undefined); safeResult(unknownVersion);

console.log("ComfyUI Web offline guards passed: fixed read-only adapter, workspace binding, truthful stopped state, strict loopback targets, safe diagnostics and disabled/error handling. No real ComfyUI or generation was used.");
