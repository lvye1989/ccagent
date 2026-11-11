import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import dotenv from "dotenv";
import { getCCAgentPath } from "./paths.js";
import { withFileTransaction } from "./fileTransaction.js";

export const WEB_SECRET_FILE = "web-secrets.env";
export const WEB_SECRET_PREFIX = "CCAGENT_WEB_KEY_";
const generatedSecret = /^CCAGENT_WEB_KEY_[A-F0-9]{24}$/;
const synchronizing = new Map<string, Promise<void>>();

/** Refresh only account-owned generated credentials in a retained project Worker. */
export async function syncWebSecrets(): Promise<void> {
  const file = getCCAgentPath(WEB_SECRET_FILE);
  const current = synchronizing.get(file);
  if (current) return current;
  const pending = withFileTransaction(file, async () => {
    const info = await lstat(file).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
    if (info && (!info.isFile() || info.isSymbolicLink())) throw new Error("Secret store must be a regular file.");
    const parsed = dotenv.parse(info ? await readFile(file) : Buffer.alloc(0));
    const values = Object.fromEntries(Object.entries(parsed).filter(([key]) => generatedSecret.test(key)));
    // Validate the entire snapshot before changing the running environment.
    for (const value of Object.values(values)) {
      if (!value.trim() || value.length > 8192 || /[\r\n\0]/.test(value)) throw new Error("API key must be a single nonempty line.");
    }
    for (const key of Object.keys(process.env)) {
      if (generatedSecret.test(key) && !Object.hasOwn(values, key)) delete process.env[key];
    }
    for (const [key, value] of Object.entries(values)) process.env[key] = value;
  }).finally(() => { synchronizing.delete(file); });
  synchronizing.set(file, pending);
  return pending;
}

/** Secrets live outside workspaces; settings store only environment references. */
export async function storeWebSecret(identity: string, value: string): Promise<string> {
  if (!value.trim() || value.length > 8192 || /[\r\n\0]/.test(value)) throw new Error("API key must be a single nonempty line.");
  const variable = WEB_SECRET_PREFIX + createHash("sha256").update(identity).digest("hex").slice(0, 24).toUpperCase();
  const file = getCCAgentPath(WEB_SECRET_FILE);
  return withFileTransaction(file, async () => {
    const info = await lstat(file).catch((e: NodeJS.ErrnoException) => { if (e.code === "ENOENT") return null; throw e; });
    if (info && (!info.isFile() || info.isSymbolicLink())) throw new Error("Secret store must be a regular file.");
    const values = dotenv.parse(info ? await readFile(file) : Buffer.alloc(0));
    values[variable] = value.trim();
    await mkdir(path.dirname(file), { recursive: true });
    const temporary = file + "." + randomUUID() + ".tmp";
    try {
      await writeFile(temporary, Object.entries(values).map(([key, secret]) => `${key}=${JSON.stringify(secret)}`).join("\n") + "\n", { mode: 0o600, flag: "wx" });
      await rename(temporary, file);
    } finally { await rm(temporary, { force: true }); }
    process.env[variable] = value.trim();
    return "${" + variable + "}";
  });
}

export function resolveWebSecret(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^\$\{([A-Z_][A-Z0-9_]*)\}$/.exec(value);
  return match ? process.env[match[1]!] : undefined;
}

/** Removes only a generated Web credential, never an arbitrary environment variable. */
export async function removeWebSecret(reference: string): Promise<void> {
  const variable = /^\$\{(CCAGENT_WEB_KEY_[A-F0-9]{24})\}$/.exec(reference)?.[1];
  if (!variable) return;
  const file = getCCAgentPath(WEB_SECRET_FILE);
  await withFileTransaction(file, async () => {
    const info = await lstat(file).catch((e: NodeJS.ErrnoException) => { if (e.code === "ENOENT") return null; throw e; });
    if (info && (!info.isFile() || info.isSymbolicLink())) throw new Error("Secret store must be a regular file.");
    const values = dotenv.parse(info ? await readFile(file) : Buffer.alloc(0));
    delete values[variable];
    const temporary = file + "." + randomUUID() + ".tmp";
    try {
      await writeFile(temporary, Object.entries(values).map(([key, secret]) => `${key}=${JSON.stringify(secret)}`).join("\n") + "\n", { mode: 0o600, flag: "wx" });
      await rename(temporary, file);
    } finally { await rm(temporary, { force: true }); }
    delete process.env[variable];
  });
}
