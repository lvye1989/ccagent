/** Isolated config/path tests. Does not install or execute Python, MCP packages, or AutoCAD. */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildAutocadMcpConfig, removeAutocadMcpConfig, normalizeAutocadProgId, AUTOCAD_MCP_SOURCE } from "../services/mcp/autocad.js";
import type { McpStdioServerConfig } from "../types/mcp.js";

const temporary = await realpath(os.tmpdir());
const root = await realpath(await mkdtemp(path.join(temporary, "ccagent-autocad-config-")));
const keys = ["CCAGENT_HOME", "CCAGENT_UVX_EXECUTABLE", "AUTOCAD_MCP_CONFIG", "AUTOCAD_MCP_ALLOWED_DIRS", "AUTOCAD_MCP_READ_ONLY", "PYTHONPATH"] as const;
const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
let checks = 0;
const check = (name: string) => { checks++; console.log(`PASS ${name}`); };
const missing = async (value: string) => assert.equal(await stat(value).then(() => true, () => false), false);
const configFile = (value: McpStdioServerConfig) => value.env!.AUTOCAD_MCP_CONFIG!;
try {
  const account = path.join(root, "account-a");
  const work = path.join(root, "城市设计 CAD 交付");
  await mkdir(work);
  const sentinel = path.join(work, "existing.dwg");
  await writeFile(sentinel, "user drawing sentinel");
  const runner = path.join(root, "uvx.exe");
  await writeFile(runner, "offline sentinel, must not execute");
  process.env.CCAGENT_HOME = account;
  process.env.CCAGENT_UVX_EXECUTABLE = runner;
  process.env.AUTOCAD_MCP_CONFIG = path.join(root, "unsafe.toml");
  process.env.AUTOCAD_MCP_ALLOWED_DIRS = path.parse(root).root;
  process.env.AUTOCAD_MCP_READ_ONLY = "true";
  process.env.PYTHONPATH = "untrusted-parent-location";

  for (const workingDirectory of [undefined, null, 0, "", "relative/cad", "https://remote.invalid/cad", "\\\\remote.invalid\\cad", "//remote.invalid/cad", "\\\\?\\C:\\cad", path.parse(root).root, os.homedir(), process.cwd(), sentinel, path.join(root, "missing")]) {
    await assert.rejects(buildAutocadMcpConfig({ workingDirectory }));
  }
  await missing(account);
  await missing(path.join(root, "missing"));
  check("invalid, missing, broad, remote and file paths are refused before any account config is created");

  const config = await buildAutocadMcpConfig({ workingDirectory: work });
  assert.equal(config.type, "stdio");
  assert.equal(config.command, runner);
  assert.deepEqual(config.args, ["--no-config", "--python", "3.11", "--from", AUTOCAD_MCP_SOURCE, "autocad-mcp"]);
  assert.match(AUTOCAD_MCP_SOURCE, /github\.com\/C48H74\/autocad-mcp\.git@2966d7f05523386b1b55582260e958ecb6f288d1$/);
  assert.equal(config.env?.AUTOCAD_MCP_ALLOWED_DIRS, await realpath(work));
  assert.equal(config.env?.AUTOCAD_MCP_WORKSPACE, await realpath(work));
  assert.equal(config.env?.AUTOCAD_MCP_READ_ONLY, "0");
  assert.equal(config.env?.PYTHONPATH, "");
  assert.equal(process.env.PYTHONPATH, "untrusted-parent-location");
  assert.equal(config.connectTimeoutMs, 180_000);
  assert.equal(config.toolTimeoutMs, 90_000);
  const managed = path.join(await realpath(account), "mcp-local", "autocad");
  assert.equal(path.dirname(configFile(config)), managed);
  const content = await readFile(configFile(config), "utf8");
  for (const line of ["allow_launch = false", "enable_lisp = false", "allow_any = false", 'prog_id = "AutoCAD.Application.25"', `allowed_dirs = [${JSON.stringify(await realpath(work))}]`]) assert.ok(content.split("\n").includes(line));
  assert.deepEqual(await readdir(work), ["existing.dwg"]);
  assert.equal(await readFile(sentinel, "utf8"), "user drawing sentinel");
  check("pinned stdio config enforces one canonical Chinese/space path and safe TOML over inherited settings");

  const local = path.join(root, "separate runtime", "custom-server.exe");
  await mkdir(path.dirname(local));
  await writeFile(local, "fake executable not executed");
  const custom = await buildAutocadMcpConfig({ workingDirectory: work, mcpExecutable: local, progId: "AutoCAD.Application.23.1" });
  assert.equal(custom.command, local);
  assert.deepEqual(custom.args, []);
  assert.notEqual(configFile(custom), configFile(config));
  assert.match(await readFile(configFile(custom), "utf8"), /prog_id = "AutoCAD\.Application\.23\.1"/);
  assert.equal(await readFile(configFile(config), "utf8"), content);
  assert.equal(await readFile(local, "utf8"), "fake executable not executed");
  check("custom local executable and version retain original config and do not execute the program");

  for (const progId of [null, false, {}, "WScript.Shell", "AutoCAD.Application.25;evil", "AutoCAD.Application.25\n", "AutoCAD.Application.1000", "AutoCAD.Application.-1"]) await assert.rejects(buildAutocadMcpConfig({ workingDirectory: work, progId }));
  assert.equal(normalizeAutocadProgId(undefined), "AutoCAD.Application.25");
  assert.throws(() => normalizeAutocadProgId("AutoCAD.Application"), /版本标识/);
  const script = path.join(root, "unsafe.cmd"); await writeFile(script, "not executed");
  for (const mcpExecutable of [false, null, "relative.exe", "https://remote.invalid/autocad.exe", "\\\\remote.invalid\\autocad.exe", work, script, path.join(root, "missing.exe")]) await assert.rejects(buildAutocadMcpConfig({ workingDirectory: work, mcpExecutable }));
  const privateChild = path.join(account, "private"); await mkdir(privateChild);
  await assert.rejects(buildAutocadMcpConfig({ workingDirectory: account }));
  await assert.rejects(buildAutocadMcpConfig({ workingDirectory: privateChild }));
  await assert.rejects(buildAutocadMcpConfig({ workingDirectory: root }));
  assert.equal((await readdir(managed)).filter((name) => name.endsWith(".toml")).length, 2);
  check("COM class injection, executable scripts and account-data exposure are rejected without leftover configs");

  process.env.CCAGENT_HOME = path.join(root, "account-b");
  await removeAutocadMcpConfig(config);
  assert.equal(await readFile(configFile(config), "utf8"), content);
  const other = await buildAutocadMcpConfig({ workingDirectory: work });
  assert.notEqual(other.env?.UV_CACHE_DIR, config.env?.UV_CACHE_DIR);
  await removeAutocadMcpConfig(other);
  await missing(configFile(other));
  await missing(path.join(process.env.CCAGENT_HOME, "settings.json"));
  check("another account cannot remove this account's config and caches remain isolated");

  process.env.CCAGENT_HOME = account;
  const outside = path.join(root, path.basename(configFile(config)));
  await writeFile(outside, "external config sentinel");
  await removeAutocadMcpConfig({ ...config, env: { AUTOCAD_MCP_CONFIG: outside } });
  const unrelated = path.join(managed, "user-config.toml"); await writeFile(unrelated, "user config sentinel");
  await removeAutocadMcpConfig({ ...config, env: { AUTOCAD_MCP_CONFIG: unrelated } });
  await removeAutocadMcpConfig({ type: "http", url: "https://remote.invalid/mcp" });
  await removeAutocadMcpConfig(config);
  await removeAutocadMcpConfig(config);
  await removeAutocadMcpConfig(custom);
  assert.equal(await readFile(unrelated, "utf8"), "user config sentinel");
  assert.equal(await readFile(outside, "utf8"), "external config sentinel");
  assert.equal(await readFile(sentinel, "utf8"), "user drawing sentinel");
  await missing(configFile(config)); await missing(configFile(custom));
  check("cleanup removes only owned UUID TOML; unrelated files and drawings are preserved");

  const redirectedAccount = path.join(root, "redirected-account");
  const externalDirectory = path.join(root, "external-directory");
  await mkdir(redirectedAccount); await mkdir(externalDirectory);
  try {
    await symlink(externalDirectory, path.join(redirectedAccount, "mcp-local"), process.platform === "win32" ? "junction" : "dir");
    process.env.CCAGENT_HOME = redirectedAccount;
    await assert.rejects(buildAutocadMcpConfig({ workingDirectory: work }), /不能重定向/);
    assert.deepEqual(await readdir(externalDirectory), []);
    check("managed-directory redirection is rejected before external directories or files are created");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && ["EPERM", "EACCES"].includes(String(error.code)))) throw error;
    console.log("SKIP managed-directory junction creation unavailable in this environment");
  }
  console.log(`AutoCAD isolated configuration: ${checks} checks passed. No CAD, package runtime, or installer executed.`);
} finally {
  for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  assert.equal(path.dirname(root).toLowerCase(), temporary.toLowerCase());
  assert.equal(await realpath(root), root);
  await rm(root, { recursive: true, force: true });
}
