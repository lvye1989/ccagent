/** Offline configuration checks; no SketchUp or third-party program is executed. */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildSketchupMcpConfig, getInstalledSketchupMcpExecutable, normalizeSketchupMcpPort } from "../services/mcp/sketchup.js";

const parent = await realpath(os.tmpdir()), root = await realpath(await mkdtemp(path.join(parent, "ccagent-sketchup-config-")));
const keys = ["CCAGENT_HOME", "LOCALAPPDATA", "XDG_DATA_HOME", "CCAGENT_SKETCHUP_MCP_EXECUTABLE", "CCAGENT_UVX_EXECUTABLE", "SKETCHUP_MCP_HOST"] as const;
const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
try {
  process.env.CCAGENT_HOME = path.join(root, "account"); process.env.LOCALAPPDATA = root; process.env.XDG_DATA_HOME = root;
  delete process.env.CCAGENT_SKETCHUP_MCP_EXECUTABLE;
  process.env.SKETCHUP_MCP_HOST = "remote.invalid";
  const uvx = path.join(root, process.platform === "win32" ? "uvx.exe" : "uvx");
  await writeFile(uvx, "offline sentinel"); process.env.CCAGENT_UVX_EXECUTABLE = uvx;
  assert.equal(normalizeSketchupMcpPort(undefined), 9876); assert.equal(normalizeSketchupMcpPort(" 9877 "), 9877);
  for (const value of [null, false, [], {}, 0, 65536, 98.76, "-1", "9876;command", "1e3"]) assert.throws(() => normalizeSketchupMcpPort(value));
  const config = await buildSketchupMcpConfig();
  assert.equal(config.command, uvx); assert.deepEqual(config.args, ["--no-config", "--from", "sketchup-mcp2==0.4.0", "sketchup-mcp2"]);
  assert.equal(config.env?.SKETCHUP_MCP_HOST, "127.0.0.1"); assert.equal(config.env?.SKETCHUP_MCP_PORT, "9876");
  assert.equal(config.env?.SKETCHUP_MCP_TIMEOUT, "60"); assert.equal(config.connectTimeoutMs, 180_000); assert.equal(config.toolTimeoutMs, 90_000);
  assert.equal(config.env?.UV_CONCURRENT_DOWNLOADS, "1"); assert.equal(config.env?.UV_CONCURRENT_INSTALLS, "1");
  process.env.CCAGENT_HOME = path.join(root, "other-account");
  assert.notEqual((await buildSketchupMcpConfig()).env?.UV_CACHE_DIR, config.env?.UV_CACHE_DIR);
  for (const options of [{mcpExecutable:false},{mcpExecutable:root},{mcpExecutable:"relative/sketchup-mcp2.exe"},{mcpExecutable:path.join(root,"missing/sketchup-mcp2.exe")},{port:"remote.invalid"}]) await assert.rejects(buildSketchupMcpConfig(options));
  const installed = getInstalledSketchupMcpExecutable(); await mkdir(path.dirname(installed), {recursive:true}); await writeFile(installed, "offline sentinel");
  assert.equal((await buildSketchupMcpConfig()).command, installed); assert.deepEqual((await buildSketchupMcpConfig()).args, []);
  const ownFolder = path.join(root, "separate runtime with spaces"); await mkdir(ownFolder);
  const custom = path.join(ownFolder, process.platform === "win32" ? "sketchup-mcp2.exe" : "sketchup-mcp2"); await writeFile(custom, "offline sentinel");
  const selected = await buildSketchupMcpConfig({mcpExecutable:custom,port:9878});
  assert.equal(selected.command, custom); assert.equal(selected.env?.SKETCHUP_MCP_PORT, "9878");
  process.env.CCAGENT_SKETCHUP_MCP_EXECUTABLE = custom;
  assert.equal((await buildSketchupMcpConfig()).command, custom);
  assert.equal(await readFile(custom,"utf8"), "offline sentinel");
  console.log("SketchUp offline configuration passed: fixed pin, local host, port bounds, executable selection, isolated cache and no third-party execution.");
} finally {
  for (const [key,value] of Object.entries(saved)) { if(value===undefined)delete process.env[key];else process.env[key]=value; }
  assert.equal(path.dirname(root).toLowerCase(),parent.toLowerCase()); await rm(root,{recursive:true,force:true});
}
