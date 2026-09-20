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
const MAX_FALLBACK_FILE_BYTES = 20 * 1024 * 1024;
const MAX_FALLBACK_OUTPUT_CHARS = 1_000_000;

interface GrepInput {
  pattern: string;
  path?: string;
  include?: string;
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

async function getPathKind(filePath: string): Promise<"file" | "directory" | null> {
  try {
    const info = await fs.stat(filePath);
    if (info.isDirectory()) return "directory";
    if (info.isFile()) return "file";
    return null;
  } catch {
    return null;
  }
}

function isNoMatchesError(error: unknown): boolean {
  return (error as { code?: unknown })?.code === 1;
}

function isAbortError(error: unknown): boolean {
  const value = error as { name?: string; code?: string };
  return value?.name === "AbortError" || value?.code === "ABORT_ERR";
}

async function grepWithoutRipgrep(
  input: GrepInput,
  targetPath: string,
  targetKind: "file" | "directory",
  respectGitignore: boolean,
  signal: AbortSignal | undefined,
): Promise<ToolResult> {
  let expression: RegExp;
  try {
    expression = new RegExp(input.pattern);
  } catch (error) {
    return {
      content: `Error: invalid regular expression: ${(error as Error).message}`,
      isError: true,
    };
  }

  const files = targetKind === "file"
    ? [targetPath]
    : await walkFiles(targetPath, { signal, respectGitignore });
  const matches: string[] = [];
  let outputChars = 0;

  for (const file of files) {
    signal?.throwIfAborted();
    const relative = targetKind === "directory" ? path.relative(targetPath, file) : path.basename(file);
    if (input.include && !matchesGlob(relative, input.include)) continue;

    const info = await fs.stat(file);
    if (info.size > MAX_FALLBACK_FILE_BYTES) continue;
    const buffer = await fs.readFile(file);
    if (buffer.includes(0)) continue;

    const lines = buffer.toString("utf8").split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      expression.lastIndex = 0;
      if (!expression.test(lines[index])) continue;
      const match = `${relative}:${index + 1}:${lines[index]}`;
      matches.push(match);
      outputChars += match.length + 1;
      if (outputChars >= MAX_FALLBACK_OUTPUT_CHARS) {
        matches.push("...[search output truncated; narrow the path, pattern, or include filter]");
        return { content: matches.join("\n") };
      }
    }
  }

  return {
    content: matches.length > 0
      ? matches.join("\n")
      : `No matches found for pattern: ${input.pattern}`,
  };
}

export const grepTool: Tool = {
  name: "Grep",
  description: "Search file contents by regex pattern. Prefer this over Bash for code search.",
  inputSchema: {
    type: "object" as const,
    properties: {
      pattern: { type: "string", description: "Regex pattern to search for" },
      path: { type: "string", description: "Directory or file path to search within" },
      include: { type: "string", description: "Optional glob filter, e.g. *.ts" },
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
    const input = rawInput as unknown as GrepInput;
    if (typeof input.pattern !== "string" || input.pattern.length === 0) {
      return { content: "Error: pattern is required", isError: true };
    }
    const timeout = validateCommandTimeout(input.timeout, DEFAULT_SEARCH_TIMEOUT_MS);
    if (!timeout.ok) return { content: `Error: ${timeout.error}`, isError: true };
    if (context.abortSignal?.aborted) {
      return { content: "Grep search aborted before start", isError: true };
    }
    const timeoutSignal = AbortSignal.timeout(timeout.value);
    const operationSignal = context.abortSignal
      ? AbortSignal.any([context.abortSignal, timeoutSignal])
      : timeoutSignal;

    let targetPath: string;
    try {
      targetPath = resolveWorkspacePath(input.path ?? ".", context.cwd);
      await ensureRealPathInsideAllowedRoots(targetPath, context.cwd);
    } catch (error: unknown) {
      return {
        content: error instanceof Error ? `Error: ${error.message}` : `Error: ${String(error)}`,
        isError: true,
      };
    }

    const targetKind = await getPathKind(targetPath);
    if (!targetKind) {
      return { content: `Error: search path does not exist or is not a regular file/directory: ${targetPath}`, isError: true };
    }

    const respectGitignore = (await readMergedBooleanSetting(
      context.cwd,
      "respectGitignore",
    ).catch(() => undefined)) !== false;

    try {
      const ripgrep = resolveRipgrepExecutable();
      if (await hasCommand(ripgrep)) {
        const args = ["-n", "--hidden", "--color", "never"];
        if (!respectGitignore) args.push("--no-ignore");
        if (input.include) args.push("-g", input.include);
        // Prevent user regexes such as `--version` or `-e` from becoming
        // ripgrep options. The old `-e` path could hang waiting on stdin.
        args.push("--", input.pattern, targetKind === "directory" ? "." : targetPath);
        const { stdout } = await execFileAsync(ripgrep, args, {
          cwd: targetKind === "directory" ? targetPath : undefined,
          maxBuffer: MAX_BUFFER_BYTES,
          timeout: timeout.value,
          signal: operationSignal,
          windowsHide: true,
        });
        const output = stdout.trim();
        return { content: output || `No matches found for pattern: ${input.pattern}` };
      }

      return await grepWithoutRipgrep(
        input,
        targetPath,
        targetKind,
        respectGitignore,
        operationSignal,
      );
    } catch (error: unknown) {
      if (isNoMatchesError(error)) {
        return { content: `No matches found for pattern: ${input.pattern}` };
      }
      if (isAbortError(error)) {
        return context.abortSignal?.aborted
          ? { content: "Grep search aborted", isError: true }
          : { content: `Grep search timed out after ${timeout.value}ms`, isError: true };
      }
      const value = error as { killed?: boolean; signal?: string; message?: string };
      if (value?.killed || value?.signal) {
        return { content: `Grep search timed out after ${timeout.value}ms`, isError: true };
      }
      return {
        content: `Error running grep search: ${value?.message ?? String(error)}`,
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
