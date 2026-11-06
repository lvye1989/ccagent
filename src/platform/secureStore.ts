import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

/** Windows credentials are encrypted for the current OS user with DPAPI. */
async function dpapi(value: string, decrypt: boolean): Promise<string> {
  const operation = decrypt ? "Unprotect" : "Protect";
  const script = `Add-Type -AssemblyName System.Security; $bytes = [Convert]::FromBase64String([Console]::In.ReadToEnd()); $result = [Security.Cryptography.ProtectedData]::${operation}($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($result))`;
  const executable = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return new Promise((resolve, reject) => {
    const child = execFile(executable, ["-NoProfile", "-NonInteractive", "-Command", script], {
      windowsHide: true, timeout: 10_000, maxBuffer: 256 * 1024,
    }, (error, stdout) => {
      if (error || !/^[A-Za-z0-9+/]*={0,2}$/.test(stdout.trim())) {
        reject(new Error("无法访问当前 Windows 用户的安全凭据存储。"));
      } else resolve(stdout.trim());
    });
    child.stdin?.on("error", () => { /* execFile completion reports failure without echoing input. */ });
    child.stdin?.end(value);
  });
}

async function regularFile(file: string): Promise<boolean> {
  const info = await lstat(file).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
  if (info && (!info.isFile() || info.isSymbolicLink())) throw new Error("凭据存储必须为普通文件。");
  if (info && info.size > 256 * 1024) throw new Error("凭据文件格式错误。");
  return Boolean(info);
}

/** File location must be an application-owned, non-workspace user directory. */
export class SecureCredentialStore<T> {
  private cached?: { revision: string; plain: string };
  constructor(readonly file: string) {}

  async revision(): Promise<string | null> {
    if (!(await regularFile(this.file))) return null;
    const info = await lstat(this.file, { bigint: true });
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("凭据存储必须为普通文件。");
    return [info.ino, info.size, info.mtimeNs, info.ctimeNs].join(":");
  }

  async read(): Promise<T | null> {
    const revision = await this.revision();
    if (revision === null) { this.cached = undefined; return null; }
    try {
      if (this.cached?.revision === revision) return JSON.parse(this.cached.plain) as T;
      const envelope = JSON.parse(await readFile(this.file, "utf8")) as Record<string, unknown>;
      if (envelope.version !== 1 || typeof envelope.payload !== "string") throw new Error("version");
      let payload: string;
      if (process.platform === "win32") {
        if (envelope.protection !== "windows-dpapi") throw new Error("protection");
        payload = Buffer.from(await dpapi(envelope.payload, true), "base64").toString("utf8");
      } else {
        if (envelope.protection !== "private-file") throw new Error("protection");
        const info = await lstat(this.file);
        if ((info.mode & 0o077) !== 0) throw new Error("permissions");
        payload = envelope.payload;
      }
      const value = JSON.parse(payload) as T;
      this.cached = { revision, plain: payload };
      return value;
    } catch {
      // Neither secret input, ciphertext, filename nor child-process stderr is exposed.
      throw new Error("登录凭据无法读取，请重新登录。");
    }
  }

  async write(value: T): Promise<void> {
    this.cached = undefined;
    await regularFile(this.file);
    const plain = JSON.stringify(value);
    if (Buffer.byteLength(plain) > 64 * 1024) throw new Error("登录凭据过大。");
    const windows = process.platform === "win32";
    const payload = windows ? await dpapi(Buffer.from(plain).toString("base64"), false) : plain;
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = this.file + "." + randomUUID() + ".tmp";
    try {
      await writeFile(temporary, JSON.stringify({ version: 1, protection: windows ? "windows-dpapi" : "private-file", payload }), { mode: 0o600, flag: "wx" });
      await rename(temporary, this.file);
      if (!windows) await chmod(this.file, 0o600);
    } finally {
      await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
    }
  }

  async clear(): Promise<void> {
    this.cached = undefined;
    if (await regularFile(this.file)) await unlink(this.file);
  }
}
