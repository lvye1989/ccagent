/** Project outputs must never depend on the CLI's launch/installation directory. */
import { AsyncLocalStorage } from "node:async_hooks";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const scopes = new AsyncLocalStorage<string>();
const defaults = new Map<string, string>();
const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(moduleDir, moduleDir.endsWith(`${path.sep}tools`) ? "../.." : "..");
let desktopCache: string | undefined;

export function isRhinoPathWithin(root: string, file: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(file));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export function rhinoDesktopDirectory(): string {
  if (desktopCache) return desktopCache;
  if (process.platform === "win32") {
    // Known Folder respects OneDrive/redirection and localized Windows accounts.
    const value = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; [Environment]::GetFolderPath('Desktop')"],
      { encoding: "utf8", windowsHide: true, timeout: 10_000 }).trim();
    if (value && path.isAbsolute(value)) return desktopCache = value;
    throw new Error("Cannot resolve the Desktop folder; set CCAGENT_RHINO_OUTPUT_ROOT to an absolute output directory.");
  }
  return desktopCache = path.join(os.homedir(), "Desktop");
}

function assertUnlinked(dir: string): void {
  let cursor = path.resolve(dir);
  while (cursor !== path.dirname(cursor)) {
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) throw new Error(`Rhino project refuses a linked output directory: ${cursor}`);
    cursor = path.dirname(cursor);
  }
}

function validateProject(dir: string): string {
  if (!path.isAbsolute(dir)) throw new Error("Rhino project directory must be absolute.");
  dir = path.resolve(dir);
  assertUnlinked(dir);
  const prohibited = [path.parse(dir).root, os.homedir(), rhinoDesktopDirectory()];
  if (prohibited.some(root => path.relative(root, dir) === "") || isRhinoPathWithin(packageRoot, dir)) {
    throw new Error("Rhino project must be a dedicated output folder outside the application repository, not a drive/home/Desktop root.");
  }
  return dir;
}

export function createRhinoProject(): string {
  const configured = process.env.CCAGENT_RHINO_PROJECT_DIR?.trim();
  const base = process.env.CCAGENT_RHINO_OUTPUT_ROOT?.trim() || path.join(rhinoDesktopDirectory(), "CCAGENT-Rhino");
  if (!path.isAbsolute(base)) throw new Error("CCAGENT_RHINO_OUTPUT_ROOT must be absolute.");
  const dir = validateProject(configured || path.join(base, `Rhino-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`));
  mkdirSync(dir, { recursive: true });
  for (const name of ["models", "previews", "snapshots", "reports", "inputs"]) {
    const subdir = path.join(dir, name); assertUnlinked(subdir); mkdirSync(subdir, { recursive: true });
  }
  return realpathSync(dir);
}

export function getRhinoProjectDirectory(): string {
  const scoped = scopes.getStore();
  if (scoped) return validateProject(scoped);
  const key = JSON.stringify([process.env.CCAGENT_RHINO_PROJECT_DIR, process.env.CCAGENT_RHINO_OUTPUT_ROOT]);
  let dir = defaults.get(key);
  if (!dir) { dir = createRhinoProject(); defaults.set(key, dir); }
  return validateProject(dir);
}

export function rhinoProjectPath(...parts: string[]): string {
  const root = getRhinoProjectDirectory();
  const file = path.resolve(root, ...parts);
  if (!isRhinoPathWithin(root, file)) throw new Error("Rhino output cannot escape its project directory.");
  assertUnlinked(path.dirname(file));
  return file;
}

/** Resolves before the permission prompt; execution must use the same path. */
export function resolveRhinoExportPath(value: string): string {
  const root = getRhinoProjectDirectory();
  const file = path.resolve(root, value);
  if (!isRhinoPathWithin(root, file) || file === root) {
    throw new Error(`Export must be inside the Rhino project folder: ${root}. Use a relative file_path, or configure CCAGENT_RHINO_PROJECT_DIR before starting the task.`);
  }
  const relative = path.relative(root, file);
  if (relative.split(path.sep).some(part => /[<>:"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new Error("Invalid or ambiguous Rhino export filename.");
  }
  assertUnlinked(file);
  return file;
}

export async function withRhinoProject<T>(operation: (directory: string) => Promise<T>): Promise<T> {
  const dir = scopes.getStore() ?? createRhinoProject();
  return scopes.run(dir, () => operation(dir));
}

export function writeRhinoProjectReport(name: string, value: unknown): string {
  const file = rhinoProjectPath("reports", name);
  writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  return file;
}
