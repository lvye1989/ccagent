/** Offline guard regressions only. Fake tools never execute Photoshop or claim real Photoshop acceptance. */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parsePhotoshopResult, runPhotoshopWebTest, verifyPhotoshopOutputs } from "../entrypoint/webPhotoshop.js";
import { COMMON_APPS } from "../entrypoint/webApps.js";
import { buildPhotoshopMcpConfig, PHOTOSHOP_MCP_PACKAGE, PHOTOSHOP_MCP_VERSION } from "../services/mcp/photoshop.js";
import type { Tool, ToolResult } from "../tools/Tool.js";

const temporaryParent = await realpath(os.tmpdir());
const root = await realpath(await mkdtemp(path.join(temporaryParent, "ccagent-web-photoshop-")));
const envNames = ["CCAGENT_HOME", "CCAGENT_PHOTOSHOP_MCP_ENTRY", "PHOTOSHOP_PATH", "ProgramFiles", "npm_config_cache", "TEMP", "TMP", "TMPDIR"] as const;
const savedEnvironment = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
const runtimeTemp = path.join(root, "runtime-tmp");
await mkdir(runtimeTemp);
process.env.CCAGENT_HOME = path.join(root, "account");
process.env.ProgramFiles = path.join(root, "no-system-programs");
process.env.TEMP = runtimeTemp; process.env.TMP = runtimeTemp; process.env.TMPDIR = runtimeTemp;
delete process.env.CCAGENT_PHOTOSHOP_MCP_ENTRY;
delete process.env.PHOTOSHOP_PATH;
delete process.env.npm_config_cache;

type Call = { name: string; input: Record<string, unknown> };
type Reply = (name: string, input: Record<string, unknown>, calls: readonly Call[]) => Promise<ToolResult> | ToolResult;
function fakeTools(reply: Reply, enabled = true) {
  const calls: Call[] = [];
  const tools = ["photoshop_ping", "photoshop_execute_script"].map((name): Tool => ({
    name: `mcp__offline_guard_fixture__${name}`, description: "Offline assertion fixture; no Photoshop process is contacted.",
    inputSchema: { type: "object" }, isEnabled: () => enabled, isReadOnly: () => name === "photoshop_ping",
    async call(input, context) {
      assert.ok(path.resolve(context.cwd).startsWith(root + path.sep));
      calls.push({ name, input: structuredClone(input) });
      return reply(name, input, calls);
    },
  }));
  return { tools, calls };
}
const textResult = (value: unknown): ToolResult => ({ content: JSON.stringify(value) });
const validState = { version: "27.2.0", documents: [11, 24], activeDocumentId: 24 };
const goodReadOnlyReply: Reply = (name) => name === "photoshop_ping" ? textResult({ ok: true }) : textResult(validState);
async function workspace(name: string) { const folder = path.join(root, name); await mkdir(folder); return folder; }
async function readReport(folder: string, result: Awaited<ReturnType<typeof runPhotoshopWebTest>>) {
  assert.equal(path.isAbsolute(result.reportPath), false);
  const file = await realpath(path.join(folder, result.reportPath));
  assert.ok(file.startsWith((await realpath(folder)) + path.sep));
  return JSON.parse(await readFile(file, "utf8")) as {
    ok: boolean; mode: string; message: string; version?: string; reportPath: string;
    output?: unknown; events: { tool: string; ok: boolean; ms: number }[];
  };
}
function isWriteScript(input: Record<string, unknown>) {
  return typeof input.code === "string" && /documents\.add\(|saveAs\(|\.close\(/.test(input.code);
}

try {
  assert.deepEqual(parsePhotoshopResult('{"ok":true,"version":"27.2.0"}'), { ok: true, version: "27.2.0" });
  assert.deepEqual(parsePhotoshopResult('Script executed successfully.\nResult: {"version":"27.2.0"}'), { version: "27.2.0" });
  assert.equal(parsePhotoshopResult("plain upstream diagnostic"), "plain upstream diagnostic");
  assert.throws(() => parsePhotoshopResult("MCP transport error", true), /MCP transport error/);
  assert.throws(() => parsePhotoshopResult('{"ok":false,"error":"bridge refused"}'), /bridge refused/);
  assert.throws(() => parsePhotoshopResult('Script completed.\nResult: {"ok":false,"error":"Photoshop unavailable"}'), /Photoshop unavailable/);

  const connectedWorkspace = await workspace("readonly-connection");
  const connected = fakeTools(goodReadOnlyReply);
  const connection = await runPhotoshopWebTest(connectedWorkspace, "connection", connected.tools);
  assert.equal(connection.ok, true); assert.equal(connection.version, "27.2.0");
  assert.deepEqual(connection.documents, { count: 2, activeDocumentId: 24 });
  assert.equal(connection.output, undefined);
  assert.deepEqual(connected.calls.map((call) => call.name), ["photoshop_ping", "photoshop_execute_script"]);
  assert.ok(connected.calls.every((call) => !isWriteScript(call.input)));
  const stateCall = connected.calls[1]!;
  assert.equal(stateCall.input.timeout_ms, 15_000); assert.equal(stateCall.input.document_id, null);
  assert.match(String(stateCall.input.code), /app\.version/);
  const connectionReport = await readReport(connectedWorkspace, connection);
  assert.equal(connectionReport.ok, true); assert.equal(connectionReport.events.length, 2);
  assert.ok(connectionReport.events.every((event) => event.ok && event.ms >= 0));
  assert.equal(connectionReport.output, undefined);

  for (const [label, state] of [
    ["missing-version", { documents: [], activeDocumentId: null }],
    ["empty-version", { version: "", documents: [], activeDocumentId: null }],
    ["non-version-ping", "pong"],
    ["invalid-documents", { version: "27.2.0", documents: ["11"], activeDocumentId: null }],
  ] as const) {
    const folder = await workspace(label);
    const fixture = fakeTools((name) => name === "photoshop_ping" ? textResult({ ok: true }) : textResult(state));
    const result = await runPhotoshopWebTest(folder, "sample", fixture.tools);
    assert.equal(result.ok, false, `${label} must not be reported as a real Photoshop connection`);
    assert.match(result.message, /版本和文档状态/);
    assert.equal(result.output, undefined);
    assert.ok(fixture.calls.every((call) => !isWriteScript(call.input)), `${label} must stop before the sample write script`);
    assert.equal((await readReport(folder, result)).ok, false);
  }

  for (const [label, failure] of [
    ["ping-is-error", { content: "Bridge rejected the ping", isError: true }],
    ["ping-application-error", textResult({ ok: false, error: "Photoshop not running" })],
  ] as const) {
    const folder = await workspace(label);
    const fixture = fakeTools(() => failure);
    const result = await runPhotoshopWebTest(folder, "sample", fixture.tools);
    assert.equal(result.ok, false); assert.equal(fixture.calls.length, 1);
    assert.ok(!fixture.calls.some((call) => call.name === "photoshop_execute_script"));
    const report = await readReport(folder, result);
    assert.deepEqual(report.events.map(({ tool, ok }) => ({ tool, ok })), [{ tool: "photoshop_ping", ok: false }]);
  }
  const failedStateWorkspace = await workspace("state-application-error");
  const failedState = fakeTools((name) => name === "photoshop_ping" ? textResult({ ok: true }) : textResult({ ok: false, error: "scripting unavailable" }));
  const failedStateResult = await runPhotoshopWebTest(failedStateWorkspace, "sample", failedState.tools);
  assert.equal(failedStateResult.ok, false); assert.match(failedStateResult.message, /scripting unavailable/);
  assert.equal(failedState.calls.length, 2); assert.ok(failedState.calls.every((call) => !isWriteScript(call.input)));
  assert.deepEqual((await readReport(failedStateWorkspace, failedStateResult)).events.map(({ ok }) => ok), [true, false]);

  const disabledWorkspace = await workspace("disabled-tools");
  const disabled = fakeTools(() => { throw new Error("Disabled tool must never be called"); }, false);
  const disabledResult = await runPhotoshopWebTest(disabledWorkspace, "sample", disabled.tools);
  assert.equal(disabledResult.ok, false); assert.match(disabledResult.message, /不可用/); assert.equal(disabled.calls.length, 0);

  const timeoutWorkspace = await workspace("timeout-report");
  const timeout = fakeTools((name) => {
    if (name === "photoshop_ping") return textResult({ ok: true });
    throw new Error("MCP request timed out after 15000 ms");
  });
  const timedOut = await runPhotoshopWebTest(timeoutWorkspace, "sample", timeout.tools);
  assert.equal(timedOut.ok, false); assert.match(timedOut.message, /脚本可能仍在运行/);
  assert.equal(timedOut.output, undefined); assert.ok(timeout.calls.every((call) => !isWriteScript(call.input)));
  const timeoutReport = await readReport(timeoutWorkspace, timedOut);
  assert.equal(timeoutReport.message, timedOut.message); assert.equal(timeoutReport.events.at(-1)?.ok, false);

  // Synthetic headers exercise rejection guards, not Photoshop output generation or acceptance.
  const headerFolder = await workspace("header-rejection-fixtures");
  const pngPath = path.join(headerFolder, "fixture.png"), psdPath = path.join(headerFolder, "fixture.psd");
  const png = Buffer.alloc(24); Buffer.from("89504e470d0a1a0a", "hex").copy(png); png.writeUInt32BE(960, 16); png.writeUInt32BE(540, 20);
  const psd = Buffer.alloc(48); psd.write("8BPS"); psd.writeUInt16BE(1, 4); psd.writeUInt32BE(540, 14); psd.writeUInt32BE(960, 18);
  psd.writeUInt32BE(10, 34); psd.writeUInt32BE(6, 38); psd.writeInt16BE(2, 42);
  await writeFile(pngPath, "not a PNG"); await writeFile(psdPath, psd);
  await assert.rejects(verifyPhotoshopOutputs(pngPath, psdPath), /PNG 文件头/);
  await writeFile(pngPath, png); await writeFile(psdPath, "not a PSD");
  await assert.rejects(verifyPhotoshopOutputs(pngPath, psdPath), /PSD 文件头/);
  await writeFile(psdPath, psd);
  await assert.rejects(verifyPhotoshopOutputs(pngPath, psdPath), /预期的可编辑图层/);
  png.writeUInt32BE(1024, 16); await writeFile(pngPath, png);
  await assert.rejects(verifyPhotoshopOutputs(pngPath, psdPath), /PNG 尺寸/);

  const escapedWorkspace = await workspace("junction-workspace"), outside = await workspace("outside-workspace");
  await writeFile(path.join(outside, "sentinel.txt"), "preserve outside data");
  await symlink(outside, path.join(escapedWorkspace, "output"), process.platform === "win32" ? "junction" : "dir");
  const beforeOutside = await readdir(outside);
  const escaped = fakeTools(() => { throw new Error("Escaping output must reject before calling any tools"); });
  await assert.rejects(runPhotoshopWebTest(escapedWorkspace, "sample", escaped.tools), /工作文件夹之外/);
  assert.equal(escaped.calls.length, 0); assert.deepEqual(await readdir(outside), beforeOutside);
  assert.equal(await readFile(path.join(outside, "sentinel.txt"), "utf8"), "preserve outside data");

  assert.equal(COMMON_APPS.find((app) => app.id === "photoshop")?.auth, "local");
  const defaultConfig = await buildPhotoshopMcpConfig();
  assert.equal(defaultConfig.command, "npx");
  assert.deepEqual(defaultConfig.args, ["--yes", `${PHOTOSHOP_MCP_PACKAGE}@${PHOTOSHOP_MCP_VERSION}`]);
  assert.equal(defaultConfig.connectTimeoutMs, 180_000); assert.equal(defaultConfig.toolTimeoutMs, 90_000);
  assert.equal(defaultConfig.env?.ANALYTICS_DISABLED, "1"); assert.equal(defaultConfig.env?.POSTHOG_DISABLED, "1");
  assert.equal(defaultConfig.env?.PSMCP_FEEDBACK, "0"); assert.equal(defaultConfig.env?.PSMCP_UPDATE_CHECK, "0");
  assert.equal(defaultConfig.env?.PHOTOSHOP_MCP_API, "extendscript"); assert.equal(defaultConfig.env?.PHOTOSHOP_UXP_BRIDGE_PORT, "0");
  assert.equal(defaultConfig.env?.PHOTOSHOP_PATH, undefined, "fixture must not depend on a host Photoshop installation");
  assert.ok(!Object.keys(defaultConfig.env ?? {}).some((key) => /api_?key|secret|token/i.test(key)));
  assert.equal(defaultConfig.env?.PHOTOSHOP_MCP_HOME, path.join(root, "account", "integrations", "photoshop"));

  const packageRoot = await workspace("preinstalled-package"); await mkdir(path.join(packageRoot, "dist"));
  const entry = path.join(packageRoot, "dist", "index.js"), manifest = path.join(packageRoot, "package.json");
  await writeFile(entry, "throw new Error('Offline fixture must never execute');\n");
  await writeFile(manifest, JSON.stringify({ name: PHOTOSHOP_MCP_PACKAGE, version: PHOTOSHOP_MCP_VERSION }));
  process.env.CCAGENT_PHOTOSHOP_MCP_ENTRY = entry;
  const preinstalled = await buildPhotoshopMcpConfig();
  assert.equal(preinstalled.command, process.execPath); assert.deepEqual(preinstalled.args, [entry]);
  await writeFile(manifest, JSON.stringify({ name: PHOTOSHOP_MCP_PACKAGE, version: "0.0.0-wrong-version" }));
  await assert.rejects(buildPhotoshopMcpConfig(), /预安装版本必须/);
  await writeFile(manifest, JSON.stringify({ name: "unrelated-package", version: PHOTOSHOP_MCP_VERSION }));
  await assert.rejects(buildPhotoshopMcpConfig(), /预安装版本必须/);
  process.env.CCAGENT_PHOTOSHOP_MCP_ENTRY = "relative/index.js";
  await assert.rejects(buildPhotoshopMcpConfig(), /预安装入口不存在/);
  process.env.CCAGENT_PHOTOSHOP_MCP_ENTRY = path.join(packageRoot, "missing.js");
  await assert.rejects(buildPhotoshopMcpConfig(), /预安装入口不存在/);

  console.log("Photoshop Web offline guards passed: result errors, read-only probe, truthful version handling, fail-before-write, timeout reports, output validation, junction containment and pinned local MCP configuration. No Photoshop process or real MCP tool was used.");
} finally {
  for (const name of envNames) {
    const previous = savedEnvironment[name];
    if (previous === undefined) delete process.env[name]; else process.env[name] = previous;
  }
  // Verify the absolute cleanup boundary before removing any fixture tree (including its junction).
  const resolvedRoot = await realpath(root);
  assert.equal(path.dirname(resolvedRoot).toLowerCase(), temporaryParent.toLowerCase());
  assert.ok(path.basename(resolvedRoot).startsWith("ccagent-web-photoshop-"));
  await rm(resolvedRoot, { recursive: true, force: true });
}
