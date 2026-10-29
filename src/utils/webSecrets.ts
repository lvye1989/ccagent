import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import dotenv from "dotenv";
import { getCCAgentPath } from "./paths.js";

export const WEB_SECRET_FILE = "web-secrets.env";
export const WEB_SECRET_PREFIX = "CCAGENT_WEB_KEY_";

/** Secrets live outside workspaces; settings store only environment references. */
export async function storeWebSecret(identity: string, value: string): Promise<string> {
  if (!value.trim() || value.length > 8192 || /[\r\n\0]/.test(value)) throw new Error("API key must be a single nonempty line.");
  const variable = WEB_SECRET_PREFIX + createHash("sha256").update(identity).digest("hex").slice(0, 24).toUpperCase();
  const file = getCCAgentPath(WEB_SECRET_FILE);
  const info = await lstat(file).catch((e: NodeJS.ErrnoException) => { if (e.code === "ENOENT") return null; throw e; });
  if (info && (!info.isFile() || info.isSymbolicLink())) throw new Error("Secret store must be a regular file.");
  const values = dotenv.parse(info ? await readFile(file) : Buffer.alloc(0));
  values[variable] = value.trim();
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = file + "." + randomUUID() + ".tmp";
  await writeFile(temporary, Object.entries(values).map(([key, secret]) => `${key}=${JSON.stringify(secret)}`).join("\n") + "\n", { mode: 0o600, flag: "wx" });
  await rename(temporary, file);
  process.env[variable] = value.trim();
  return "${" + variable + "}";
}

export function resolveWebSecret(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^\$\{([A-Z_][A-Z0-9_]*)\}$/.exec(value);
  return match ? process.env[match[1]!] : undefined;
}
