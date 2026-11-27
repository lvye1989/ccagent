import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { buildSandboxProfile, getShellSandboxStatus, loadSandboxSettings, resolveSandboxSettings } from "../sandbox/index.js";
import { buildDockerSandboxCreateArgs, getDockerSandboxStatus, getDockerSandboxStatusAsync, prepareDockerSandboxMounts, runDockerSandboxCommand, type DockerSandboxRuntime } from "../sandbox/docker.js";
import { resetSettingsCache, setFlagSettings, getFlagSettings } from "../config/sources.js";
import { bashTool } from "../tools/bashTool.js";
import { powerShellTool } from "../tools/powerShellTool.js";
import { toolResultText } from "../tools/Tool.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "ccagent-isolation-test-"));
const workspace = path.join(root, "project"), home = path.join(root, "profile");
const priorHome = process.env.CCAGENT_HOME, priorFlags = getFlagSettings();
process.env.CCAGENT_HOME = home;
await fs.mkdir(workspace); await fs.mkdir(home);
const settings = resolveSandboxSettings({ enabled: true }, {});
const profile = buildSandboxProfile({ cwd: workspace, settings, permissions: { allow: [], deny: [] } });
const imageId = "sha256:" + "a".repeat(64);
const base = { command: "printf isolated", shell: "bash" as const, cwd: workspace, settings, profile, timeoutMs: 3000 };

function fixture(options: { script?: string; noDaemon?: boolean; noImage?: boolean; cleanupFails?: boolean; created?: () => void | Promise<void> } = {}) {
  const calls: string[][] = [];
  const runtime: DockerSandboxRuntime = {
    async run(args) {
      calls.push(args);
      if (args[0] === "version") { if (options.noDaemon) throw new Error("fixture-offline"); return "linux"; }
      if (args[0] === "image") { if (options.noImage) throw new Error("fixture-missing-image"); return imageId; }
      if (args[0] === "create") { await options.created?.(); return "fixture-container-id"; }
      if (args[0] === "inspect") return JSON.stringify({ Running: false, ExitCode: 0, OOMKilled: false });
      if (args[0] === "rm") { if (options.cleanupFails) throw new Error("fixture-offline"); return args.at(-1)!; }
      throw new Error("Unexpected fixture operation");
    },
    start(args) { calls.push(args); return spawn(process.execPath, ["-e", options.script ?? "process.stdout.write('fixture result')"], { windowsHide: true }); },
  };
  return { runtime, calls };
}

try {
  assert.equal(getDockerSandboxStatus(settings, () => { throw new Error("offline"); }).ready, false);
  assert.equal(getDockerSandboxStatus(settings, args => args[0] === "version" ? "windows" : imageId).ready, false);
  assert.equal(getDockerSandboxStatus(settings, args => args[0] === "version" ? "linux" : imageId).imageId, imageId);
  assert.equal(getDockerSandboxStatus(settings, args => { if (args[0] === "version") return "linux"; throw new Error("missing"); }).ready, false);
  assert.equal((await getDockerSandboxStatusAsync(settings, async args => args[0] === "version" ? "linux" : imageId)).ready, true);
  console.log("PASS runtime readiness: offline engine, wrong engine, missing local image, ready fixture");

  const mounts = await prepareDockerSandboxMounts(workspace, settings, profile);
  const command = "Write-Output 'argument stays literal'; Get-Date";
  const args = buildDockerSandboxCreateArgs({ ...mounts, name: `ccagent-sandbox-${randomUUID()}`, imageId, shell: "powershell", command });
  for (const flag of ["--pull=never", "--network=none", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges:true", "--user=65534:65534", "--pids-limit=128", "--memory=1g", "--cpus=2"]) assert.ok(args.includes(flag), flag);
  assert.ok(args.some(arg => arg.endsWith("dst=/workspace,readonly")));
  assert.ok(args.some(arg => arg.endsWith("dst=/output")));
  assert.equal(args.filter(arg => arg.startsWith("type=bind")).length, 2, "only project and dedicated output are exposed");
  assert.equal(args.at(-1), command, "command is a single argv value, never a host shell command");
  assert.ok(!args.some(arg => /TOKEN|KEY|SECRET|DOCKER_HOST|\.sock/i.test(arg)), "no host secrets or daemon socket passed to workload");
  await assert.rejects(prepareDockerSandboxMounts(workspace, { ...settings, network: { allowedDomains: ["example.test"], deniedDomains: [] } }, profile));
  await assert.rejects(prepareDockerSandboxMounts(workspace, settings, { ...profile, filesystem: { ...profile.filesystem, denyRead: [path.join(workspace, "private.txt")] } }));
  await assert.rejects(prepareDockerSandboxMounts(workspace, settings, { ...profile, filesystem: { ...profile.filesystem, denyWrite: [mounts.output] } }));
  await assert.rejects(prepareDockerSandboxMounts(home, settings, profile));
  await fs.mkdir(path.join(home, "nested"));
  await assert.rejects(prepareDockerSandboxMounts(path.join(home, "nested"), settings, profile));
  console.log("PASS fixed container policy, literal argv, restricted mounts, incompatible policies blocked");

  const linkedProject = path.join(root, "linked-project"), external = path.join(root, "outside");
  await fs.mkdir(linkedProject); await fs.mkdir(external);
  await fs.symlink(external, path.join(linkedProject, "output"), process.platform === "win32" ? "junction" : "dir");
  try { await assert.rejects(prepareDockerSandboxMounts(linkedProject, settings, profile), /symbolic link|junction/); }
  finally { await fs.rm(path.join(linkedProject, "output"), { recursive: true, force: true }); }
  console.log("PASS output junction cannot widen host filesystem access");

  const unavailable = fixture({ noDaemon: true });
  assert.equal((await runDockerSandboxCommand(base, unavailable.runtime)).isError, true);
  assert.equal(unavailable.calls.some(args => args[0] === "create" || args[0] === "start"), false);
  const missing = fixture({ noImage: true });
  assert.equal((await runDockerSandboxCommand(base, missing.runtime)).isError, true);
  assert.equal(missing.calls.some(args => args[0] === "create" || args[0] === "start"), false);
  const normal = fixture();
  const normalResult = await runDockerSandboxCommand(base, normal.runtime);
  assert.equal(normalResult.isError, false);
  assert.ok(toolResultText(normalResult.content).includes("fixture result"));
  assert.equal(normal.calls.at(-1)![0], "rm");
  assert.equal(normal.calls.at(-1)!.at(-1), normal.calls.find(args => args[0] === "create")![2]);

  const cancellation = new AbortController();
  const duringCreate = fixture({ created: () => { cancellation.abort(); } });
  assert.equal((await runDockerSandboxCommand({ ...base, signal: cancellation.signal }, duringCreate.runtime)).isError, true);
  assert.equal(duringCreate.calls.some(args => args[0] === "start"), false);
  assert.equal(duringCreate.calls.at(-1)![0], "rm");

  const runningCancellation = new AbortController();
  const running = fixture({ script: "setInterval(()=>{},1000)" });
  const cancelTimer = setTimeout(() => runningCancellation.abort(), 200);
  const cancelledResult = await runDockerSandboxCommand({ ...base, signal: runningCancellation.signal }, running.runtime);
  assert.equal(cancelledResult.isError, true); assert.equal(cancelledResult.executionOutcome, "unknown");
  clearTimeout(cancelTimer);
  assert.equal(running.calls.at(-1)![0], "rm");
  const timeout = fixture({ script: "setInterval(()=>{},1000)" });
  const timedOutResult = await runDockerSandboxCommand({ ...base, timeoutMs: 200 }, timeout.runtime);
  assert.equal(timedOutResult.isError, true); assert.equal(timedOutResult.executionOutcome, "unknown");
  assert.equal(timeout.calls.at(-1)![0], "rm");
  const cleanupFailure = fixture({ cleanupFails: true });
  const cleanupResult = await runDockerSandboxCommand(base, cleanupFailure.runtime);
  assert.equal(cleanupResult.executionOutcome, "unknown");
  assert.equal(cleanupResult.isError, true);
  assert.match(toolResultText(cleanupResult.content), /cleanup could not be confirmed/);
  console.log("PASS lifecycle fixtures: no host fallback, daemon cleanup after completion/cancel/timeout, cleanup failure is visible");

  setFlagSettings(null);
  await fs.writeFile(path.join(home, "settings.json"), JSON.stringify({ sandbox: { enabled: true } }));
  await fs.mkdir(path.join(workspace, ".ccagent"));
  await fs.writeFile(path.join(workspace, ".ccagent", "settings.json"), JSON.stringify({ sandbox: { enabled: false, docker: { image: "untrusted-image" }, excludedCommands: ["*"] } }));
  resetSettingsCache();
  const protectedSettings = await loadSandboxSettings(workspace);
  assert.equal(protectedSettings.enabled, true);
  assert.equal(protectedSettings.docker?.image, undefined);
  assert.deepEqual(protectedSettings.excludedCommands, []);
  await fs.writeFile(path.join(home, "settings.json"), JSON.stringify({ sandbox: { enabled: "yes" } }));
  resetSettingsCache();
  await assert.rejects(loadSandboxSettings(workspace));
  assert.equal((await getShellSandboxStatus(workspace)).state, "invalid");
  assert.equal((await bashTool.call({ command: "printf should-not-run" }, { cwd: workspace })).isError, true);
  assert.equal((await powerShellTool.call({ command: "Write-Output should-not-run" }, { cwd: workspace })).isError, true);
  console.log("PASS project settings cannot weaken isolation; invalid settings block both shell tools");

  // Real tools, real installed CLI, deliberately absent image: no image pulls or
  // host command execution. This covers both daemon-offline and image-missing states.
  if (process.platform === "win32") {
    await fs.writeFile(path.join(home, "settings.json"), JSON.stringify({ sandbox: { enabled: true, docker: { image: `ccagent-isolation-fixture:missing-${randomUUID()}` } } }));
    resetSettingsCache();
    for (const tool of [bashTool, powerShellTool]) {
      const result = await tool.call({ command: "should-not-run-on-host" }, { cwd: workspace });
      assert.equal(result.isError, true);
      assert.match(toolResultText(result.content), /engine is unavailable|image is not available locally/);
    }
    console.log("PASS installed Docker unavailable/missing-image path blocks both tools without host fallback");
  }

  // Explicit optional live test: only owned fixture files, no network or host
  // directories beyond the temporary project are exposed. No image is pulled.
  if (process.argv.includes("--live")) {
    const image = process.env.CCAGENT_ISOLATION_TEST_IMAGE;
    const liveSettings = resolveSandboxSettings({ enabled: true, docker: image ? { image } : {} }, {});
    const status = getDockerSandboxStatus(liveSettings);
    assert.equal(status.ready, true, status.reason);
    await fs.writeFile(path.join(workspace, "input.txt"), "owned fixture");
    const live = await runDockerSandboxCommand({ ...base, settings: liveSettings, timeoutMs: 15000,
      command: "test -r /workspace/input.txt && test ! -w /workspace/input.txt && printf verified > /output/verified.txt && printf live-isolation-ok" });
    assert.equal(live.isError, false, toolResultText(live.content));
    assert.equal(await fs.readFile(path.join(workspace, "output", "sandbox", "verified.txt"), "utf8"), "verified");
    await fs.writeFile(path.join(home, "settings.json"), JSON.stringify({ sandbox: { enabled: true, docker: image ? { image } : {} } }));
    resetSettingsCache();
    const pwsh = await powerShellTool.call({ command:
      "if (-not $IsLinux) { exit 2 }; [IO.File]::WriteAllText('/output/pwsh.txt', [IO.File]::ReadAllText('/workspace/input.txt'))" },
      { cwd: workspace });
    assert.equal(pwsh.isError, false, toolResultText(pwsh.content));
    assert.equal(await fs.readFile(path.join(workspace, "output", "sandbox", "pwsh.txt"), "utf8"), "owned fixture");
    console.log("PASS LIVE Bash and PowerShell container isolation and output delivery");
  }
} finally {
  setFlagSettings(priorFlags); resetSettingsCache();
  if (priorHome === undefined) delete process.env.CCAGENT_HOME; else process.env.CCAGENT_HOME = priorHome;
  if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith("ccagent-isolation-test-")) throw new Error("Unsafe cleanup");
  await fs.rm(root, { recursive: true, force: true });
}
