import { spawn } from "node:child_process";
import type { Tool, ToolContext, ToolResult } from "./Tool.js";
import { resolveBashExecutable } from "../utils/bashExecutable.js";
import {
  annotateStderrWithSandboxFailures,
  buildSandboxProfile,
  loadSandboxSettings,
  shouldUseSandbox,
  wrapWithSandbox,
  type ResolvedSandboxSettings,
} from "../sandbox/index.js";
import {
  appendBashProgress,
  completeBashProgress,
  startBashProgress,
} from "../state/bashProgressStore.js";
import { readMergedEnv } from "../utils/settings.js";
import {
  BoundedTextBuffer,
  terminateProcessTree,
  validateCommandTimeout,
} from "../utils/subprocess.js";
import { prepareToolTempEnvironment } from "../utils/toolTemp.js";

interface BashInput {
  command: string;
  timeout?: number;
  /**
   * Per-call escape: if true AND the user's policy allows model escapes
   * (`sandbox.allowUnsandboxedCommands`), this command runs OUTSIDE the
   * sandbox even when sandboxing is enabled. The model is encouraged to
   * leave this off — see the description below.
   */
  dangerouslyDisableSandbox?: boolean;
}

/**
 * Build the SandboxProfile to feed to wrapWithSandbox(). We re-load
 * sandbox settings + permission rules on every call so that the user
 * approving a permission rule mid-session takes effect on the next
 * Bash command — no restart required (matches source code's
 * settingsChangeDetector + refreshConfig pattern).
 */
async function buildProfileForCwd(
  cwd: string,
  settings: ResolvedSandboxSettings,
) {
  // Dynamic import: bashTool ⇄ permissions form a static-import cycle
  // (permissions wants `isReadOnlyCommand` from us). We break it here
  // — this path only runs when sandboxing is on, so the extra import
  // cost is negligible.
  const { loadPermissionSettings } = await import("../permissions/permissions.js");
  const permissionSettings = await loadPermissionSettings(cwd);
  return buildSandboxProfile({
    cwd,
    settings,
    permissions: { allow: permissionSettings.allow, deny: permissionSettings.deny },
  });
}

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_CHARS = 30_000;
const READ_ONLY_COMMANDS = new Set([
  "ls",
  "cat",
  "grep",
  "rg",
  "fd",
  "pwd",
  "which",
  "git status",
  "git log",
  "git diff",
  "git show",
  "head",
  "tail",
  "wc",
]);

function splitCommandSegments(command: string): string[] {
  return command
    .split(/&&|\|\||[|;\r\n]|&(?!&)/)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

export function isReadOnlyCommand(command: string): boolean {
  // Stay conservative around shell constructs that can hide a mutating
  // command inside an otherwise read-only prefix, or redirect output.
  if (/[><`]/.test(command) || /\$\(|\$\{/.test(command)) return false;
  const segments = splitCommandSegments(command);
  if (segments.length === 0) return false;
  return segments.every((segment) => {
    const normalized = segment.replace(/\s+/g, " ").trim();
    if (READ_ONLY_COMMANDS.has(normalized)) return true;
    const firstTwo = normalized.split(" ").slice(0, 2).join(" ");
    if (READ_ONLY_COMMANDS.has(firstTwo)) return true;
    const first = normalized.split(" ")[0];
    return READ_ONLY_COMMANDS.has(first);
  });
}

export const bashTool: Tool = {
  name: "Bash",
  description: "Execute a shell command in the current working directory and return stdout/stderr.",
  inputSchema: {
    type: "object" as const,
    properties: {
      command: { type: "string", description: "Shell command to execute" },
      timeout: {
        type: "number",
        minimum: 1,
        maximum: 86_400_000,
        description: "Timeout in milliseconds (default 120000)",
      },
      dangerouslyDisableSandbox: {
        type: "boolean",
        description:
          "If true, run this command OUTSIDE the sandbox even when sandboxing is enabled. Only use this when the command genuinely needs unrestricted access (e.g. installing system packages, running docker, accessing devices). Most commands should run inside the sandbox.",
      },
    },
    required: ["command"],
  },
  async call(rawInput: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const input = rawInput as unknown as BashInput;
    if (typeof input.command !== "string" || !input.command.trim()) {
      return { content: "Error: command is required", isError: true };
    }

    const timeout = validateCommandTimeout(input.timeout, DEFAULT_TIMEOUT_MS);
    if (!timeout.ok) return { content: `Error: ${timeout.error}`, isError: true };
    const timeoutMs = timeout.value;
    if (context.abortSignal?.aborted) {
      return { content: "Command aborted before start", isError: true };
    }

    // Decide sandbox wrapping. We swallow load errors and proceed with
    // sandboxing OFF — settings.json being unparseable shouldn't block
    // command execution; the permission system already surfaces those
    // errors loudly elsewhere.
    let sandboxSettings: ResolvedSandboxSettings | null = null;
    try {
      sandboxSettings = await loadSandboxSettings(context.cwd);
    } catch {
      sandboxSettings = null;
    }

    const willSandbox = sandboxSettings
      ? shouldUseSandbox(
          {
            command: input.command,
            dangerouslyDisableSandbox: input.dangerouslyDisableSandbox,
          },
          sandboxSettings,
        )
      : false;

    let executedCommand = input.command;
    if (willSandbox && sandboxSettings) {
      const profile = await buildProfileForCwd(context.cwd, sandboxSettings);
      const wrap = wrapWithSandbox(input.command, profile);
      executedCommand = wrap.wrappedCommand;
    }

    // Live progress: publish stdout/stderr chunks keyed by this call's
    // tool_use id so the UI can show the command's tail while it runs. Only
    // active when an interactive frontend supplied a toolUseId.
    const progressId = context.toolUseId;
    if (progressId) startBashProgress(progressId, timeoutMs);

    // Inject the merged `env` setting (trusted sources only) on top of the
    // process environment. Lets users/projects export vars (PATH additions,
    // tokens, etc.) into every command without a wrapper script. Untrusted
    // project/local env is dropped by readMergedEnv's trust gate. A bad read
    // must not block execution, so we degrade to the bare process env.
    let settingsEnv: Record<string, string> = {};
    try {
      settingsEnv = await readMergedEnv(context.cwd);
    } catch {
      settingsEnv = {};
    }

    let toolTempEnv: Record<string, string>;
    try {
      toolTempEnv = await prepareToolTempEnvironment();
    } catch (error) {
      if (progressId) completeBashProgress(progressId);
      return {
        content: `Failed to prepare CCAGENT temporary directory: ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      };
    }

    return await new Promise<ToolResult>((resolve) => {
      const child = spawn(resolveBashExecutable(), ["-lc", executedCommand], {
        cwd: context.cwd,
        env: { ...process.env, ...settingsEnv, ...toolTempEnv },
        windowsHide: true,
      });

      const stdout = new BoundedTextBuffer(MAX_OUTPUT_CHARS);
      const stderr = new BoundedTextBuffer(MAX_OUTPUT_CHARS);
      let finished = false;
      let terminating = false;
      let timeoutId: ReturnType<typeof setTimeout> | undefined;

      const finish = (result: ToolResult) => {
        if (finished) return;
        finished = true;
        if (timeoutId) clearTimeout(timeoutId);
        context.abortSignal?.removeEventListener("abort", onAbort);
        if (progressId) completeBashProgress(progressId);
        resolve(result);
      };

      const terminate = (result: ToolResult) => {
        if (finished || terminating) return;
        terminating = true;
        if (timeoutId) clearTimeout(timeoutId);
        context.abortSignal?.removeEventListener("abort", onAbort);
        void terminateProcessTree(child).finally(() => finish(result));
      };

      timeoutId = setTimeout(() => {
        terminate({ content: `Command timed out after ${timeoutMs}ms`, isError: true });
      }, timeoutMs);

      const onAbort = () => {
        terminate({ content: "Command aborted", isError: true });
      };

      context.abortSignal?.addEventListener("abort", onAbort, { once: true });
      if (context.abortSignal?.aborted) onAbort();

      child.stdout.on("data", (chunk: Buffer | string) => {
        const text = stdout.append(chunk);
        if (progressId) appendBashProgress(progressId, text);
      });
      child.stderr.on("data", (chunk: Buffer | string) => {
        const text = stderr.append(chunk);
        if (progressId) appendBashProgress(progressId, text);
      });
      child.on("error", (error) => {
        if (terminating) return;
        finish({ content: `Failed to start command: ${error.message}`, isError: true });
      });
      child.on("close", (code) => {
        if (terminating) return;

        // Tag stderr with <sandbox_violations>...</sandbox_violations>
        // when the failure smells like a sandbox denial. The model uses
        // this signal to decide whether to retry, ask for permission,
        // or back off. The UI strips the tag before rendering.
        const stderrText = stderr.toString();
        const annotatedStderr = willSandbox
          ? annotateStderrWithSandboxFailures(stderrText, code)
          : stderrText;
        const stdoutText = stdout.toString();

        const output = [
          `Command: ${input.command}`,
          `Read-only: ${isReadOnlyCommand(input.command)}`,
          `Sandbox: ${willSandbox ? "enabled" : "disabled"}`,
          `Exit code: ${code ?? -1}`,
          stdoutText ? `\nSTDOUT:\n${stdoutText}` : "",
          annotatedStderr ? `\nSTDERR:\n${annotatedStderr}` : "",
        ].filter(Boolean).join("\n");

        finish({ content: output, isError: (code ?? 1) !== 0 });
      });
    });
  },
  isReadOnly(): boolean {
    return false;
  },
  isEnabled(): boolean {
    return true;
  },
};
