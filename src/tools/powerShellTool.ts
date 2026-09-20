import { spawn } from "node:child_process";
import type { Tool, ToolContext, ToolResult } from "./Tool.js";
import { readMergedEnv } from "../utils/settings.js";
import {
  BoundedTextBuffer,
  terminateProcessTree,
  validateCommandTimeout,
} from "../utils/subprocess.js";

/**
 * PowerShell — execute a PowerShell command on Windows.
 *
 * Reference: claude-code-source-code/src/tools/PowerShellTool/. It mirrors
 * Bash but for the Windows shell. This tool registers ONLY on Windows
 * (isEnabled gates on process.platform), so non-Windows tool lists never see
 * it. The macOS sandbox does not apply here (Windows sandboxing is out of
 * scope, consistent with the project's macOS-only sandbox), which the
 * description and prompt make explicit.
 */
interface PowerShellInput {
  command: string;
  timeout?: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_CHARS = 30_000;

function resolveExecutable(): string {
  // pwsh (PowerShell 7+) if explicitly requested; default to Windows PowerShell.
  return process.env.CCAGENT_POWERSHELL || "powershell.exe";
}

export const powerShellTool: Tool = {
  name: "PowerShell",
  description:
    "Execute a PowerShell command on Windows and return stdout/stderr. Use this instead of Bash on Windows. Note: not sandboxed.",
  inputSchema: {
    type: "object" as const,
    properties: {
      command: { type: "string", description: "PowerShell command to execute" },
      timeout: {
        type: "number",
        minimum: 1,
        maximum: 86_400_000,
        description: "Timeout in milliseconds (default 120000)",
      },
    },
    required: ["command"],
  },
  async call(rawInput: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const input = rawInput as unknown as PowerShellInput;
    if (typeof input.command !== "string" || !input.command.trim()) {
      return { content: "Error: command is required", isError: true };
    }
    const timeout = validateCommandTimeout(input.timeout, DEFAULT_TIMEOUT_MS);
    if (!timeout.ok) return { content: `Error: ${timeout.error}`, isError: true };
    const timeoutMs = timeout.value;
    if (context.abortSignal?.aborted) {
      return { content: "Command aborted before start", isError: true };
    }

    let settingsEnv: Record<string, string> = {};
    try {
      settingsEnv = await readMergedEnv(context.cwd);
    } catch {
      settingsEnv = {};
    }

    const exe = resolveExecutable();
    return await new Promise<ToolResult>((resolve) => {
      const child = spawn(
        exe,
        ["-NoProfile", "-NonInteractive", "-Command", input.command],
        { cwd: context.cwd, env: { ...process.env, ...settingsEnv }, windowsHide: true },
      );

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

      child.stdout.on("data", (c: Buffer | string) => {
        stdout.append(c);
      });
      child.stderr.on("data", (c: Buffer | string) => {
        stderr.append(c);
      });
      child.on("error", (error) => {
        if (terminating) return;
        finish({ content: `Failed to start PowerShell: ${error.message}`, isError: true });
      });
      child.on("close", (code) => {
        if (terminating) return;
        const stdoutText = stdout.toString();
        const stderrText = stderr.toString();
        const output = [
          `Command: ${input.command}`,
          `Exit code: ${code ?? -1}`,
          stdoutText ? `\nSTDOUT:\n${stdoutText}` : "",
          stderrText ? `\nSTDERR:\n${stderrText}` : "",
        ].filter(Boolean).join("\n");
        finish({ content: output, isError: (code ?? 1) !== 0 });
      });
    });
  },
  isReadOnly(): boolean {
    return false;
  },
  isEnabled(): boolean {
    return process.platform === "win32";
  },
};
