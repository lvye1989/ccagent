import * as fs from "node:fs/promises";
import * as path from "node:path";

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

/** Match the common `*`, `**`, and `?` glob forms used by Grep/Glob. */
export function matchesGlob(filePath: string, rawPattern: string): boolean {
  const normalizedPath = filePath.replace(/\\/g, "/");
  const pattern = rawPattern.replace(/\\/g, "/").replace(/^\.\//, "");
  let source = pattern.includes("/") ? "^" : "^(?:.*/)?";

  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        index += 1;
        if (pattern[index + 1] === "/") {
          index += 1;
          source += "(?:.*/)?";
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += escapeRegex(char);
    }
  }

  return new RegExp(`${source}$`, process.platform === "win32" ? "i" : "").test(normalizedPath);
}

export interface WalkFilesOptions {
  signal?: AbortSignal;
  /** Skip VCS internals when the caller asked to respect ignore rules. */
  respectGitignore?: boolean;
  maxFiles?: number;
}

/**
 * Cross-platform fallback used when ripgrep is unavailable. Symlinks are not
 * traversed, which keeps a search rooted inside the approved directory.
 */
export async function walkFiles(
  root: string,
  options: WalkFilesOptions = {},
): Promise<string[]> {
  const maxFiles = options.maxFiles ?? 100_000;
  const results: string[] = [];
  const pending = [root];

  while (pending.length > 0) {
    options.signal?.throwIfAborted();
    const directory = pending.pop()!;
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      options.signal?.throwIfAborted();
      if (options.respectGitignore && entry.isDirectory() && entry.name === ".git") continue;
      if (entry.isSymbolicLink()) continue;

      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(absolute);
      } else if (entry.isFile()) {
        results.push(absolute);
        if (results.length >= maxFiles) return results;
      }
    }
  }

  return results.sort((a, b) => a.localeCompare(b));
}
