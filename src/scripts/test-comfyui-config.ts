/** Offline configuration guards; never installs packages or starts ComfyUI. */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildComfyuiMcpConfig, normalizeLocalComfyuiUrl, DEFAULT_COMFYUI_URL } from "../services/mcp/comfyui.js";

const parent = await realpath(os.tmpdir());
const root = await realpath(await mkdtemp(path.join(parent, "ccagent-comfy-config-")));
const keys = ["CCAGENT_HOME", "CCAGENT_COMFY_MCP_EXECUTABLE", "CCAGENT_COMFY_CLI_EXECUTABLE", "CCAGENT_UVX_EXECUTABLE", "COMFYUI_URL", "COMFYUI_HOST", "COMFYUI_PORT", "COMFY_BIN"] as const;
const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
try {
  process.env.CCAGENT_HOME = path.join(root, "account");
  delete process.env.CCAGENT_COMFY_MCP_EXECUTABLE; delete process.env.CCAGENT_COMFY_CLI_EXECUTABLE;
  const uvx = path.join(root, process.platform === "win32" ? "uvx.exe" : "uvx");
  await writeFile(uvx, "offline sentinel - never execute"); process.env.CCAGENT_UVX_EXECUTABLE = uvx;
  process.env.COMFYUI_URL = "http://remote.invalid:8188"; process.env.COMFYUI_HOST = "remote.invalid";
  process.env.COMFYUI_PORT = "9999"; process.env.COMFY_BIN = "unexpected-parent-command";
  assert.equal(normalizeLocalComfyuiUrl(undefined), DEFAULT_COMFYUI_URL);
  assert.equal(normalizeLocalComfyuiUrl(" http://localhost:8190/ "), "http://localhost:8190");
  assert.equal(normalizeLocalComfyuiUrl("http://[::1]:8188"), "http://[::1]:8188");
  for (const url of [null, false, 8188, "https://127.0.0.1:8188", "http://remote.invalid:8188", "http://127.0.0.1.evil.invalid:8188", "http://0.0.0.0:8188", "http://user:pass@localhost:8188", "http://localhost:8188/path", "http://localhost:8188/?token=x", "http://localhost:8188/#anchor", "http://localhost:0", "http://localhost:65536"]) {
    assert.throws(() => normalizeLocalComfyuiUrl(url), String(url));
  }
  const config = await buildComfyuiMcpConfig();
  assert.equal(config.command, uvx);
  assert.deepEqual(config.args, ["--no-config", "--from", "comfy-mcp==0.10.0", "--with", "comfy-cli==1.18.0", "comfy-mcp"]);
  assert.equal(config.connectTimeoutMs, 180_000); assert.equal(config.toolTimeoutMs, 120_000);
  const env = { ...process.env, ...config.env };
  assert.equal(env.COMFYUI_URL, ""); assert.equal(env.COMFYUI_HOST, ""); assert.equal(env.COMFYUI_PORT, "");
  assert.equal(env.COMFY_LOCAL_URL, DEFAULT_COMFYUI_URL); assert.equal(env.COMFY_BIN, "comfy");
  assert.equal(env.DO_NOT_TRACK, "1"); assert.equal(env.COMFY_NO_TELEMETRY, "1");
  assert.equal(path.dirname(config.env!.UV_CACHE_DIR!), path.join(os.tmpdir(), "cc-comfy"));
  assert.equal(config.env?.UV_CONCURRENT_DOWNLOADS, "1"); assert.equal(config.env?.UV_CONCURRENT_INSTALLS, "1");
  process.env.CCAGENT_HOME = path.join(root, "other-account");
  assert.notEqual((await buildComfyuiMcpConfig()).env?.UV_CACHE_DIR, config.env?.UV_CACHE_DIR);
  process.env.CCAGENT_HOME = path.join(root, "account");
  for (const options of [{ mcpExecutable: false }, { comfyExecutable: 1 }, { mcpExecutable: "relative/comfy-mcp.exe" }, { mcpExecutable: path.join(root, "missing/comfy-mcp.exe") }, { mcpExecutable: root }]) await assert.rejects(buildComfyuiMcpConfig(options));

  const runtime = path.join(root, "existing runtime with spaces"); await mkdir(runtime);
  const exe = (name: string) => path.join(runtime, name + (process.platform === "win32" ? ".exe" : ""));
  const mcp = exe("comfy-mcp"), cli = exe("comfy");
  await writeFile(mcp, "offline sentinel - never execute");
  await assert.rejects(buildComfyuiMcpConfig({ mcpExecutable: mcp }), /同时填写/);
  await writeFile(cli, "offline sentinel - never execute");
  const existing = await buildComfyuiMcpConfig({ mcpExecutable: mcp, localUrl: "http://localhost:8189/" });
  assert.equal(existing.command, mcp); assert.deepEqual(existing.args, []);
  assert.equal(existing.env?.COMFY_BIN, cli); assert.equal(existing.env?.COMFY_LOCAL_URL, "http://localhost:8189");
  process.env.CCAGENT_COMFY_MCP_EXECUTABLE = mcp; process.env.CCAGENT_COMFY_CLI_EXECUTABLE = cli;
  assert.equal((await buildComfyuiMcpConfig()).command, mcp);
  const unrelated = path.join(runtime, "other.exe"); await writeFile(unrelated, "offline sentinel");
  await assert.rejects(buildComfyuiMcpConfig({ mcpExecutable: unrelated }), /绝对路径/);
  assert.equal(await import("node:fs/promises").then((fs) => fs.readFile(mcp, "utf8")), "offline sentinel - never execute");
  console.log("ComfyUI offline configuration: pinned isolated runner, local-only URL, inherited remote overrides, telemetry opt-out, existing executables and no execution passed.");
} finally {
  for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  assert.equal(path.dirname(root).toLowerCase(), parent.toLowerCase());
  await rm(root, { recursive: true, force: true });
}
