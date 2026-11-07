import { lstat, mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import lockfile from "proper-lockfile";

/** Short filesystem transaction shared by every local process using this data file. */
export async function withFileTransaction<T>(file: string, action: () => Promise<T>): Promise<T> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const sentinel = `${file}.transaction`;
  const handle = await open(sentinel, "a", 0o600);
  await handle.close();
  if (!(await lstat(sentinel)).isFile()) throw new Error("Transaction target must be a regular file");
  const release = await lockfile.lock(sentinel, {
    retries: { retries: 30, factor: 1.2, minTimeout: 10, maxTimeout: 150 },
    stale: 60_000,
    update: 10_000,
  });
  try { return await action(); }
  finally { await release(); }
}

/** Call only inside the corresponding transaction; an interrupted write keeps the old file. */
export async function writeJsonAtomically(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
}
