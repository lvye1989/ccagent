import { getSandboxUnavailableReason } from "./availability.js";
import { assertDockerSandboxPolicy, dockerSandboxImage, getDockerSandboxStatusAsync, type DockerSandboxStatus } from "./docker.js";
import { loadSandboxSettings } from "./settings.js";

export interface ShellSandboxStatus {
  enabled: boolean | null;
  backend: "docker" | "sandbox-exec" | "unsupported";
  state: "disabled" | "ready" | "blocked" | "invalid";
  message: string;
  image?: string;
  scope: string;
}

const dockerStatus = new Map<string, { checkedAt: number; value: DockerSandboxStatus }>();
const pendingStatus = new Map<string, Promise<DockerSandboxStatus>>();
function probeDockerStatus(image: string, settings: Awaited<ReturnType<typeof loadSandboxSettings>>): Promise<DockerSandboxStatus> {
  const cached = dockerStatus.get(image);
  if (cached && Date.now() - cached.checkedAt < 3000) return Promise.resolve(cached.value);
  const pending = pendingStatus.get(image);
  if (pending) return pending;
  const request = getDockerSandboxStatusAsync(settings).then(value => {
    dockerStatus.set(image, { checkedAt: Date.now(), value });
    return value;
  }).finally(() => { pendingStatus.delete(image); });
  pendingStatus.set(image, request);
  return request;
}

/** The same truthful status for CLI diagnostics and the Web/desktop status API. */
export async function getShellSandboxStatus(cwd: string): Promise<ShellSandboxStatus> {
  const backend = process.platform === "win32" ? "docker" : process.platform === "darwin" ? "sandbox-exec" : "unsupported";
  const scope = backend === "docker"
    ? "Bash and PowerShell only; Linux containers; /workspace read-only; /output = project output/sandbox; no network. File tools, MCP and desktop automation are outside this isolation."
    : "Shell execution only; other tools are outside this isolation.";
  try {
    const settings = await loadSandboxSettings(cwd);
    if (!settings.enabled) return { enabled: false, backend, state: "disabled", message: "Process isolation is disabled; shell commands run on the host.", scope };
    if (backend === "docker") {
      try { assertDockerSandboxPolicy(settings); }
      catch (error) { return { enabled: true, backend, state: "blocked", message: (error as Error).message, scope }; }
    }
    const reason = backend === "docker" ? (await probeDockerStatus(dockerSandboxImage(settings), settings)).reason : getSandboxUnavailableReason(true, settings);
    return { enabled: true, backend, state: reason ? "blocked" : "ready", message: reason ?? `${backend === "docker" ? "Docker Linux" : "sandbox-exec"} isolation runtime is ready; workspace policy is checked for each command.`, scope,
      ...(backend === "docker" ? { image: dockerSandboxImage(settings) } : {}) };
  } catch {
    return { enabled: null, backend, state: "invalid", message: "Sandbox settings are invalid; shell execution is blocked until settings are repaired.", scope };
  }
}
