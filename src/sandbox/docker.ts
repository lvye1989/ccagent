import { execFile, execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { ToolResult } from "../tools/Tool.js";
import { getCCAgentHome } from "../utils/paths.js";
import { BoundedTextBuffer, terminateProcessTree } from "../utils/subprocess.js";
import type { ResolvedSandboxSettings } from "./settings.js";
import type { SandboxProfile } from "./types.js";

export const DEFAULT_DOCKER_SANDBOX_IMAGE = "mcr.microsoft.com/powershell:lts-debian-12";
const LOCAL_ENGINE = "npipe:////./pipe/dockerDesktopLinuxEngine";
const execFileAsync = promisify(execFile);
const PROBE_TIMEOUT = 5_000;

export function dockerSandboxExecutable(): string {
  return path.join(process.env.ProgramFiles || "C:\\Program Files", "Docker", "Docker", "resources", "bin", "docker.exe");
}

function dockerArgs(args: string[]): string[] { return ["--host", LOCAL_ENGINE, ...args]; }

export function dockerSandboxImage(settings?: ResolvedSandboxSettings): string {
  const image = settings?.docker?.image ?? DEFAULT_DOCKER_SANDBOX_IMAGE;
  if (!/^[a-z0-9][a-z0-9._/:@-]{0,255}$/.test(image)) throw new Error("sandbox.docker.image must be a valid local image name or digest.");
  return image;
}

export interface DockerSandboxStatus { ready: boolean; reason?: string; imageId?: string }
type SyncProbe = (args: string[]) => string;

/** Nonblocking status checks for Web/desktop; execution performs its own fresh checks. */
export async function getDockerSandboxStatusAsync(settings?: ResolvedSandboxSettings, probe: (args: string[]) => Promise<string> = args => nativeRuntime.run(args, 1500)): Promise<DockerSandboxStatus> {
  let image: string;
  try { image = dockerSandboxImage(settings); } catch (error) { return { ready: false, reason: (error as Error).message }; }
  try {
    if ((await probe(["version", "--format", "{{.Server.Os}}"])).trim() !== "linux") return { ready: false, reason: "Windows shell isolation requires Docker Desktop's local Linux engine." };
  } catch { return { ready: false, reason: "Docker Desktop Linux engine is unavailable. Start Docker Desktop; isolated shell commands are blocked." }; }
  try {
    const imageId = (await probe(["image", "inspect", "--format", "{{.Id}}", image])).trim();
    if (!/^sha256:[a-f0-9]{64}$/.test(imageId)) throw new Error("image");
    return { ready: true, imageId };
  } catch { return { ready: false, reason: `Sandbox image is not available locally: ${image}. Prepare this trusted image before running isolated shell commands.` }; }
}

/** Local engine and local image only: never starts Docker, downloads an image, or uses a remote context. */
export function getDockerSandboxStatus(settings?: ResolvedSandboxSettings, probe: SyncProbe = args =>
  execFileSync(dockerSandboxExecutable(), dockerArgs(args), { encoding: "utf8", timeout: PROBE_TIMEOUT, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim(),
): DockerSandboxStatus {
  let image: string;
  try { image = dockerSandboxImage(settings); } catch (error) { return { ready: false, reason: (error as Error).message }; }
  try {
    if (probe(["version", "--format", "{{.Server.Os}}"] ).trim() !== "linux") {
      return { ready: false, reason: "Windows shell isolation requires Docker Desktop's local Linux engine." };
    }
  } catch {
    return { ready: false, reason: "Docker Desktop Linux engine is unavailable. Start Docker Desktop; isolated shell commands are blocked." };
  }
  try {
    const imageId = probe(["image", "inspect", "--format", "{{.Id}}", image]).trim();
    if (!/^sha256:[a-f0-9]{64}$/.test(imageId)) throw new Error("image");
    return { ready: true, imageId };
  } catch {
    return { ready: false, reason: `Sandbox image is not available locally: ${image}. Prepare this trusted image before running isolated shell commands.` };
  }
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export function assertDockerSandboxPolicy(settings: ResolvedSandboxSettings): void {
  if (Object.values(settings.filesystem).some(values => values.length) || settings.network.allowedDomains.length) {
    throw new Error("Docker isolation uses a read-only /workspace, writable /output, and no network. Custom filesystem rules and allowedDomains are unsupported; remove them or use another backend.");
  }
}

/** Fixed, deliberately narrow policy; unsupported policy options are rejected rather than ignored. */
export async function prepareDockerSandboxMounts(cwd: string, settings: ResolvedSandboxSettings, profile: SandboxProfile): Promise<{ workspace: string; output: string }> {
  assertDockerSandboxPolicy(settings);
  const workspace = await realpath(cwd);
  const home = await realpath(getCCAgentHome()).catch(() => path.resolve(getCCAgentHome()));
  if (workspace === path.parse(workspace).root || workspace === homedir() || inside(workspace, home) || inside(home, workspace)) {
    throw new Error("Select a dedicated project folder for Docker isolation; a drive root, user home, or application credential folder cannot be mounted.");
  }
  if (/[\r\n,]/.test(workspace)) throw new Error("Docker isolation does not support commas or newlines in the project path.");
  const output = path.join(workspace, "output", "sandbox");
  if (profile.filesystem.denyRead.length || profile.filesystem.denyWrite.some(target => inside(output, target) || inside(target, output))) {
    throw new Error("Docker isolation cannot satisfy the configured file deny rules for this workspace/output. Shell execution is blocked.");
  }
  // Check each existing component before mkdir: a junction must never cause an
  // output mount outside the project. The container cannot replace these parents
  // because its entire /workspace mount is read-only.
  for (const folder of [path.join(workspace, "output"), output]) {
    const info = await lstat(folder).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
    if (info && (!info.isDirectory() || info.isSymbolicLink())) throw new Error("Sandbox output must be a real project directory, not a symbolic link or junction.");
    if (info && !inside(workspace, await realpath(folder))) throw new Error("Sandbox output resolves outside the project.");
  }
  await mkdir(output, { recursive: true });
  if (!inside(workspace, await realpath(output))) throw new Error("Sandbox output resolves outside the project.");
  return { workspace, output: await realpath(output) };
}

export function buildDockerSandboxCreateArgs(input: { name: string; imageId: string; workspace: string; output: string; shell: "bash" | "powershell"; command: string }): string[] {
  if (!/^ccagent-sandbox-[a-f0-9-]{36}$/.test(input.name) || !/^sha256:[a-f0-9]{64}$/.test(input.imageId)) throw new Error("Invalid sandbox container identity.");
  if (input.command.length > 16_000) throw new Error("Isolated commands are limited to 16000 characters. Put a longer script in the project first.");
  return ["create", "--name", input.name, "--label", "ccagent.sandbox=true", "--pull=never",
    "--network=none", "--ipc=private", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges:true",
    "--user=65534:65534", "--pids-limit=128", "--memory=1g", "--cpus=2",
    "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=256m,mode=1777", "--workdir", "/workspace",
    "--mount", `type=bind,src=${input.workspace},dst=/workspace,readonly`,
    "--mount", `type=bind,src=${input.output},dst=/output`,
    "--env", "HOME=/tmp", "--env", "TMPDIR=/tmp", "--env", "TEMP=/tmp", "--env", "TMP=/tmp", "--env", "CCAGENT_TMPDIR=/tmp",
    "--env", "DOTNET_CLI_HOME=/tmp", "--env", "POWERSHELL_TELEMETRY_OPTOUT=1", "--env", "TERM=dumb",
    "--entrypoint", input.shell === "bash" ? "/bin/bash" : "pwsh", input.imageId,
    ...(input.shell === "bash" ? ["--noprofile", "--norc", "-c", input.command] : ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", input.command])];
}

/** Dependency seam keeps lifecycle tests deterministic without pretending a fixture is a real container. */
export interface DockerSandboxRuntime {
  run(args: string[], timeout: number): Promise<string>;
  start(args: string[]): ChildProcessWithoutNullStreams;
}
const nativeRuntime: DockerSandboxRuntime = {
  async run(args, timeout) {
    try {
      const result = await execFileAsync(dockerSandboxExecutable(), dockerArgs(args), { windowsHide: true, timeout, maxBuffer: 64 * 1024 });
      return result.stdout.trim();
    } catch (error) {
      // A failed create may never have published a container. Only this exact
      // daemon response confirms there is nothing left to remove.
      if (args[0] === "rm" && /No such container/i.test(String((error as { stderr?: unknown }).stderr ?? ""))) return "";
      throw error;
    }
  },
  start(args) { return spawn(dockerSandboxExecutable(), dockerArgs(args), { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] }); },
};

export async function runDockerSandboxCommand(input: {
  command: string; shell: "bash" | "powershell"; cwd: string; settings: ResolvedSandboxSettings; profile: SandboxProfile;
  timeoutMs: number; signal?: AbortSignal; onOutput?: (chunk: string) => void;
}, runtime: DockerSandboxRuntime = nativeRuntime): Promise<ToolResult> {
  const name = `ccagent-sandbox-${randomUUID()}`;
  const deadline = Date.now() + input.timeoutMs;
  const remaining = () => Math.max(1, Math.min(PROBE_TIMEOUT, deadline - Date.now()));
  const stopped = () => input.signal?.aborted || Date.now() >= deadline;
  let created = false;
  let executionStarted = false;
  let result: ToolResult;
  try {
    if (stopped()) return { content: "Isolated command cancelled before start.", isError: true };
    const image = dockerSandboxImage(input.settings);
    try {
      if ((await runtime.run(["version", "--format", "{{.Server.Os}}"], remaining())).trim() !== "linux") throw new Error("not-linux");
    } catch { throw new Error("Docker Desktop Linux engine is unavailable. Isolated command was not run; there is no host fallback."); }
    let imageId: string;
    try {
      imageId = (await runtime.run(["image", "inspect", "--format", "{{.Id}}", image], remaining())).trim();
      if (!/^sha256:[a-f0-9]{64}$/.test(imageId)) throw new Error("image");
    } catch { throw new Error(`Sandbox image is not available locally: ${image}. Prepare the trusted image first; the command was not run.`); }
    if (stopped()) return { content: "Isolated command cancelled before container creation.", isError: true };
    const mounts = await prepareDockerSandboxMounts(input.cwd, input.settings, input.profile);
    const args = buildDockerSandboxCreateArgs({ ...mounts, name, imageId, shell: input.shell, command: input.command });
    // Do not interrupt create mid-flight: await its bounded completion, then
    // observe cancellation and remove by our known unique name before returning.
    created = true;
    await runtime.run(args, remaining());
    if (stopped()) result = { content: "Isolated command cancelled before execution.", isError: true };
    else result = await new Promise<ToolResult>(resolve => {
      executionStarted = true;
      const child = runtime.start(["start", "--attach", name]);
      child.stdin.on("error", () => { /* The process error/close path reports attachment failures. */ });
      child.stdin.end();
      const stdout = new BoundedTextBuffer(30_000), stderr = new BoundedTextBuffer(30_000);
      let settled = false, terminating = false;
      const finish = (value: ToolResult) => {
        if (settled) return;
        settled = true; clearTimeout(timer); input.signal?.removeEventListener("abort", abort); resolve(value);
      };
      const abort = () => {
        if (settled || terminating) return;
        terminating = true;
        // Kill the local attached client, then the finally block removes the
        // container itself. Killing only docker.exe does not stop its workload.
        void terminateProcessTree(child).catch(() => undefined).then(() => finish({ content: input.signal?.aborted ? "Isolated command aborted." : `Isolated command timed out after ${input.timeoutMs}ms.`, isError: true, executionOutcome: "unknown" }));
      };
      const timer = setTimeout(abort, Math.max(1, deadline - Date.now()));
      input.signal?.addEventListener("abort", abort, { once: true });
      child.stdout.on("data", chunk => { const text = stdout.append(chunk); input.onOutput?.(text); });
      child.stderr.on("data", chunk => { const text = stderr.append(chunk); input.onOutput?.(text); });
      child.on("error", () => { if (!terminating) finish({ content: "Could not attach to the isolated command. Host execution was not attempted.", isError: true, executionOutcome: "unknown" }); });
      child.on("close", code => {
        if (terminating) return;
        finish({ content: [`Command: ${input.command}`, "Sandbox: enabled (Docker Linux; /workspace read-only; /output = project output/sandbox; network disabled)", `Exit code: ${code ?? -1}`,
          stdout.toString() ? `\nSTDOUT:\n${stdout.toString()}` : "", stderr.toString() ? `\nSTDERR:\n${stderr.toString()}` : ""].filter(Boolean).join("\n"), isError: code !== 0 });
      });
      if (stopped()) abort();
    });
    if (!stopped() && !result.isError) {
      const state = JSON.parse(await runtime.run(["inspect", "--format", "{{json .State}}", name], PROBE_TIMEOUT)) as { Running?: unknown; ExitCode?: unknown; OOMKilled?: unknown };
      if (state.Running !== false || !Number.isSafeInteger(state.ExitCode)) throw new Error("Container exit state could not be verified. The container will be removed.");
      result = { content: String(result.content).replace(/Exit code: -?\d+/, `Exit code: ${state.ExitCode}`), isError: state.ExitCode !== 0 || state.OOMKilled === true };
    }
  } catch (error) {
    result = { content: `Sandbox: blocked. ${error instanceof Error ? error.message : "Isolation setup failed."}`, isError: true,
      ...(executionStarted ? { executionOutcome: "unknown" as const } : {}) };
  } finally {
    if (created) {
      // Await daemon-side removal on every exit, including timeout/cancellation.
      // A failure is surfaced: it must never be reported as successful cleanup.
      try { await runtime.run(["rm", "--force", name], PROBE_TIMEOUT); }
      catch { result = { content: "Sandbox cleanup could not be confirmed. Check Docker Desktop for a container labelled ccagent.sandbox=true before continuing.", isError: true, executionOutcome: "unknown" }; }
    }
  }
  return result!;
}
