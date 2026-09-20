import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import type { Tool, ToolContext, ToolResult } from "./Tool.js";
import { ensureRealPathInsideAllowedRoots, resolveWorkspacePath } from "./pathUtils.js";
import { readMergedBooleanSetting } from "../utils/settings.js";
import { matchesGlob, walkFiles } from "../utils/fileSearch.js";
import { validateCommandTimeout } from "../utils/subprocess.js";

const execFileAsync = promisify(execFile);
const DEFAULT_SEARCH_TIMEOUT_MS = 30_000;
const MAX_BUFFER_BYTES = 4 * 1024 * 1024;

interface GlobInput {
  pattern: string;
  path?: string;
  timeout?: number;
}

const COMMAND_PROBE_TTL_MS = 60_000;
const commandAvailability = new Map<string, { checkedAt: number; result: Promise<boolean> }>();

function resolveRipgrepExecutable(): string {
  return process.env.CCAGENT_RG?.trim() || "rg";
}

function hasCommand(command: string): Promise<boolean> {
  const cached = commandAvailability.get(command);
  if (cached && Date.now() - cached.checkedAt < COMMAND_PROBE_TTL_MS) return cached.result;
  const probe = execFileAsync(command, ["--version"], {
    windowsHide: true,
    timeout: 2_000,
  }).then(() => true, () => false);
  commandAvailability.set(command, { checkedAt: Date.now(), result: probe });
  return probe;
}

function isAbortError(error: unknown): boolean {
  const value = error as { name?: string; code?: string };
  return value?.name === "AbortError" || value?.code === "ABORT_ERR";
}

export const globTool: Tool = {
  name: "Glob",
  description: "Find files by glob pattern. Prefer this over Bash for file discovery.",
  inputSchema: {
    type: "object" as const,
    properties: {
      pattern: { type: "string", description: "Glob pattern to match, e.g. **/*.ts" },
      path: { type: "string", description: "Base directory to search from" },
      timeout: {
        type: "number",
        minimum: 1,
        maximum: 86_400_000,
        description: "Search timeout in milliseconds (default 30000)",
      },
    },
    required: ["pattern"],
  },
  async call(rawInput: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const input = rawInput as unknown as GlobInput;
    if (typeof input.pattern !== "string" || input.pattern.length === 0) {
      return { content: "Error: pattern is required", isError: true };
    }
    const timeout = validateCommandTimeout(input.timeout, DEFAULT_SEARCH_TIMEOUT_MS);
    if (!timeout.ok) return { content: `Error: ${timeout.error}`, isError: true };
    if (context.abortSignal?.aborted) {
      return { content: "Glob search aborted before start", isError: true };
    }
    const timeoutSignal = AbortSignal.timeout(timeout.value);
    const operationSignal = context.abortSignal
      ? AbortSignal.any([context.abortSignal, timeoutSignal])
      : timeoutSignal;

    let basePath: string;
    try {
      basePath = resolveWorkspacePath(input.path ?? ".", context.cwd);
      await ensureRealPathInsideAllowedRoots(basePath, context.cwd);
    } catch (error: unknown) {
      return {
        content: error instanceof Error ? `Error: ${error.message}` : `Error: ${String(error)}`,
        isError: true,
      };
    }

    try {
      const info = await fs.stat(basePath);
      if (!info.isDirectory()) {
        return { content: `Error: Glob base path must be a directory: ${basePath}`, isError: true };
      }
    } catch {
      return { content: `Error: Glob base path does not exist: ${basePath}`, isError: true };
    }

    const respectGitignore = (await readMergedBooleanSetting(
      context.cwd,
      "respectGitignore",
    ).catch(() => undefined)) !== false;

    try {
      const ripgrep = resolveRipgrepExecutable();
      let matches: string[];
      if (await hasCommand(ripgrep)) {
        const args = ["--files", "--hidden", "--color", "never", "-g", input.pattern];
        if (!respectGitignore) args.push("--no-ignore");
        const { stdout } = await execFileAsync(ripgrep, args, {
          cwd: basePath,
          maxBuffer: MAX_BUFFER_BYTES,
          timeout: timeout.value,
          signal: operationSignal,
          windowsHide: true,
        });
        matches = stdout.trim() ? stdout.trim().split(/\r?\n/) : [];
      } else {
        const files = await walkFiles(basePath, {
          signal: operationSignal,
          respectGitignore,
        });
        matches = files
          .map((file) => path.relative(basePath, file))
          .filter((file) => matchesGlob(file, input.pattern));
      }

      return {
        content: matches.length > 0
          ? `Matched files under ${basePath}:\n${matches.join("\n")}`
          : `No files matched ${input.pattern}`,
      };
    } catch (error: unknown) {
      if ((error as { code?: unknown })?.code === 1) {
        return { content: `No files matched ${input.pattern}` };
      }
      if (isAbortError(error)) {
        return context.abortSignal?.aborted
          ? { content: "Glob search aborted", isError: true }
          : { content: `Glob search timed out after ${timeout.value}ms`, isError: true };
      }
      const value = error as { killed?: boolean; signal?: string; message?: string };
      if (value?.killed || value?.signal) {
        return { content: `Glob search timed out after ${timeout.value}ms`, isError: true };
      }
      return {
        content: `Error running glob search: ${value?.message ?? String(error)}`,
        isError: true,
      };
    }
  },
  isReadOnly(): boolean {
    return true;
  },
  isEnabled(): boolean {
    return true;
  },
  isConcurrencySafe(): boolean {
    return true;
  },
};
