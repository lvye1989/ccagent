import * as path from "node:path";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { getCCAgentHome } from "../utils/paths.js";

// Extra roots beyond cwd + ~/.ccagent, from the `additionalDirectories`
// setting. Resolved to absolute paths and installed once at startup (see
// cli.ts). Kept module-level so the sync path guards below stay sync — the
// file tools call them on a hot path and shouldn't await a settings read each
// time. Trust-gating happens at load time (untrusted project/local dirs are
// dropped before they reach here).
let additionalAllowedRoots: string[] = [];

/** Install the resolved `additionalDirectories` (absolute paths). */
export function setAdditionalAllowedRoots(roots: string[]): void {
  additionalAllowedRoots = roots.map((root) => path.resolve(root));
}

export function getAdditionalAllowedRoots(): string[] {
  return additionalAllowedRoots;
}

export function getToolAllowedRoots(cwd: string): string[] {
  return [
    path.resolve(cwd),
    path.resolve(getCCAgentHome()),
    ...additionalAllowedRoots,
  ];
}

export function describeAllowedRoots(cwd: string): string {
  return getToolAllowedRoots(cwd).join(", ");
}

export function expandHome(filePath: string): string {
  if (filePath === "~") return homedir();
  if (filePath.startsWith("~/") || filePath.startsWith("~\\")) {
    return path.join(homedir(), filePath.slice(2));
  }
  // `~someone` is not supported; leave it literal instead of accidentally
  // rewriting it to the current user's home directory.
  return filePath;
}

export function resolveSafePath(filePath: string, cwd: string): string {
  return path.resolve(cwd, expandHome(filePath));
}

export function ensureInsideAllowedRoots(resolvedPath: string, cwd: string): void {
  const normalizedPath = path.resolve(resolvedPath);
  for (const root of getToolAllowedRoots(cwd)) {
    const relative = path.relative(root, normalizedPath);
    if (relative === "" || relative === ".") return;
    if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
      return;
    }
  }
  throw new Error(
    `Path is outside the allowed roots: ${resolvedPath}. Allowed roots: ${describeAllowedRoots(cwd)}`,
  );
}

export function resolveWorkspacePath(filePath: string, cwd: string): string {
  const resolvedPath = resolveSafePath(filePath, cwd);
  ensureInsideAllowedRoots(resolvedPath, cwd);
  return resolvedPath;
}

async function resolveThroughExistingAncestor(targetPath: string): Promise<string> {
  let probe = targetPath;
  while (true) {
    try {
      const canonicalAncestor = await realpath(probe);
      const suffix = path.relative(probe, targetPath);
      return path.resolve(canonicalAncestor, suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(probe);
      if (parent === probe) return path.resolve(targetPath);
      probe = parent;
    }
  }
}

/**
 * Resolve symlinks in the target (or its nearest existing parent) before I/O.
 * The lexical guard alone can be bypassed by a workspace symlink that points
 * outside every approved root.
 */
export async function ensureRealPathInsideAllowedRoots(
  resolvedPath: string,
  cwd: string,
): Promise<void> {
  const canonicalPath = await resolveThroughExistingAncestor(resolvedPath);
  const canonicalRoots = await Promise.all(
    getToolAllowedRoots(cwd).map(async (root) => {
      try { return await realpath(root); } catch { return path.resolve(root); }
    }),
  );

  for (const root of canonicalRoots) {
    const relative = path.relative(root, canonicalPath);
    if (relative === "" || relative === ".") return;
    if (!relative.startsWith("..") && !path.isAbsolute(relative)) return;
  }

  throw new Error(
    `Path resolves outside the allowed roots: ${resolvedPath}. Allowed roots: ${describeAllowedRoots(cwd)}`,
  );
}
