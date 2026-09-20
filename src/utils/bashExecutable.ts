import { existsSync } from "node:fs";
import path from "node:path";

/**
 * Resolve a Bash implementation that understands CCAGENT's native paths.
 * Windows' System32/bash.exe is a WSL launcher, so prefer Git Bash there.
 */
export function resolveBashExecutable(): string {
  const configured = process.env.CCAGENT_BASH?.trim();
  if (configured) return configured;

  if (process.platform !== "win32") {
    return process.env.SHELL?.trim() || "bash";
  }

  const shell = process.env.SHELL?.trim();
  const shellLooksLikeWslLauncher = shell
    ? /(?:^|[/\\])Windows[/\\]System32[/\\]bash\.exe$/i.test(shell) || shell.toLowerCase() === "bash"
    : false;
  if (shell && !shell.startsWith("/") && !shellLooksLikeWslLauncher) return shell;

  const candidates = [
    path.join(process.env.ProgramFiles || "C:\\Program Files", "Git", "bin", "bash.exe"),
    process.env["ProgramFiles(x86)"]
      ? path.join(process.env["ProgramFiles(x86)"]!, "Git", "bin", "bash.exe")
      : "",
    process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, "Programs", "Git", "bin", "bash.exe")
      : "",
  ].filter(Boolean);

  return candidates.find((candidate) => existsSync(candidate)) || "bash";
}
