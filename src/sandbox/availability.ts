/**
 * Detect whether the sandbox can actually run on the current host.
 *
 * macOS uses sandbox-exec. Windows uses Docker Desktop's local Linux
 * engine and a preinstalled image. Execution fails closed if an enabled
 * backend is unavailable; availability reporting never selects host execution.
 */

import { execFileSync } from "node:child_process";
import { getDockerSandboxStatus } from "./docker.js";
import type { ResolvedSandboxSettings } from "./settings.js";

let cachedSupported: boolean | undefined;
let cachedReason: string | undefined;

export function isPlatformSupported(): boolean {
  return process.platform === "darwin" || process.platform === "win32";
}

function isSandboxExecAvailable(): boolean {
  // `which sandbox-exec` is fast (~5ms) and avoids spawning the binary
  // itself. We synchronously check once at startup; if the user ever
  // installs/removes sandbox-exec mid-session they need to restart.
  try {
    execFileSync("/usr/bin/which", ["sandbox-exec"], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns a reason string if the user enabled the sandbox but it
 * cannot run; returns undefined otherwise. Caller should print this
 * once at CLI startup, NOT on every Bash command (it would spam).
 *
 * macOS availability is cached; Windows checks the live daemon and image so
 * starting Docker Desktop after application startup does not require a restart.
 */
export function getSandboxUnavailableReason(
  enabledInSettings: boolean,
  settings?: ResolvedSandboxSettings,
): string | undefined {
  if (!enabledInSettings) return undefined;
  if (process.platform === "win32") return getDockerSandboxStatus(settings).reason;

  if (cachedReason !== undefined) return cachedReason || undefined;
  if (cachedSupported === true) return undefined;

  if (!isPlatformSupported()) {
    cachedSupported = false;
    cachedReason = `Sandbox is enabled but ${process.platform} has no supported isolation backend. Shell execution is blocked.`;
    return cachedReason;
  }

  if (!isSandboxExecAvailable()) {
    cachedSupported = false;
    cachedReason = "sandbox.enabled is true but /usr/bin/sandbox-exec is not available on this Mac.";
    return cachedReason;
  }

  cachedSupported = true;
  cachedReason = "";
  return undefined;
}

/**
 * "Can the sandbox actually run right now?" Readiness is separate from the
 * policy decision in shouldUseSandbox; an unavailable backend must not bypass it.
 */
export function isSandboxRuntimeReady(settings?: ResolvedSandboxSettings): boolean {
  if (process.platform === "win32") return getDockerSandboxStatus(settings).ready;
  if (cachedSupported !== undefined) return cachedSupported;
  cachedSupported = isPlatformSupported() && isSandboxExecAvailable();
  return cachedSupported;
}

/** Test-only — reset memoization. */
export function _resetAvailabilityCache(): void {
  cachedSupported = undefined;
  cachedReason = undefined;
}
