import path from "node:path";
import os from "node:os";
import { randomUUID, createHash } from "node:crypto";
import { lstat, mkdir, open, realpath, stat, unlink } from "node:fs/promises";
import { getCCAgentHome } from "../../utils/paths.js";
import type { McpServerConfig, McpStdioServerConfig } from "../../types/mcp.js";

export const AUTOCAD_MCP_VERSION = "0.3.1";
export const AUTOCAD_MCP_COMMIT = "2966d7f05523386b1b55582260e958ecb6f288d1";
export const AUTOCAD_MCP_SOURCE = `git+https://github.com/C48H74/autocad-mcp.git@${AUTOCAD_MCP_COMMIT}`;
export const DEFAULT_AUTOCAD_PROG_ID = "AutoCAD.Application.25";
const MANAGED_NAME = /^autocad-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.toml$/;

function same(a: string, b: string): boolean {
  return process.platform === "win32" ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);
}

function contains(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function localAbsolute(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 8192 || /[\x00-\x1f\x7f]/.test(value)) throw new Error(`${label}无效，请填写本机绝对路径。`);
  const result = value.trim();
  // Network shares/device paths are outside this deliberately local connector.
  if (!path.isAbsolute(result) || /^[\\/]{2}/.test(result) || (process.platform === "win32" && /[;:]/.test(result.slice(2)))) throw new Error(`${label}必须是本机磁盘的绝对路径，不支持网络共享或特殊设备路径。`);
  return result;
}

async function optionalCanonical(file: string): Promise<string> {
  return realpath(file).catch(() => path.resolve(file));
}

async function workingDirectory(value: unknown): Promise<string> {
  const supplied = localAbsolute(value, "CAD 工作目录");
  if (supplied.includes(path.delimiter)) throw new Error("CAD 工作目录不能包含路径列表分隔符。");
  const directory = await realpath(supplied).catch(() => { throw new Error("CAD 工作目录不存在，请先创建一个专用文件夹。"); });
  localAbsolute(directory, "CAD 工作目录");
  if (directory.includes(path.delimiter) || !(await stat(directory)).isDirectory()) throw new Error("CAD 工作目录必须是已存在的专用文件夹。");
  const home = os.homedir();
  const blocked = await Promise.all([
    path.parse(directory).root, home, process.cwd(), getCCAgentHome(),
    ...["Desktop", "Documents", "Downloads", "Pictures", "Videos", "Music"].map((name) => path.join(home, name)),
  ].map(optionalCanonical));
  if (blocked.some((candidate) => same(directory, candidate))) throw new Error("请选择专用 CAD 子文件夹，不能直接授权磁盘、用户目录、桌面或应用根目录。");
  const privateHome = await optionalCanonical(getCCAgentHome());
  if (contains(privateHome, directory) || contains(directory, privateHome)) throw new Error("CAD 工作目录不能包含账户配置，或位于账户配置中。");
  return directory;
}

async function executable(value: unknown, label: string, basename?: string): Promise<string | undefined> {
  if (value === undefined || value === "") return undefined;
  const selected = localAbsolute(value, label);
  const file = await realpath(selected).catch(() => { throw new Error(`${label}不存在。`); });
  localAbsolute(file, label);
  if (path.extname(file).toLowerCase() !== ".exe" || (basename && path.basename(file).toLowerCase() !== `${basename}.exe`) || !(await stat(file)).isFile()) throw new Error(`${label}须指向已安装的本机 .exe 程序。`);
  return file;
}

export function normalizeAutocadProgId(value: unknown): string {
  if (value === undefined || value === "") return DEFAULT_AUTOCAD_PROG_ID;
  if (typeof value !== "string" || !/^AutoCAD\.Application\.[0-9]{1,3}(?:\.[0-9]{1,3})?$/.test(value)) throw new Error("AutoCAD 版本标识无效，例如 AutoCAD.Application.25。");
  return value;
}

async function managedDirectory(create: boolean): Promise<string | undefined> {
  if (create) await mkdir(getCCAgentHome(), { recursive: true, mode: 0o700 });
  let current = await realpath(getCCAgentHome()).catch(() => undefined);
  if (!current) return undefined;
  for (const segment of ["mcp-local", "autocad"]) {
    const next: string = path.join(current, segment);
    if (create) await mkdir(next, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
    const info = await lstat(next).catch(() => undefined);
    if (!info) return undefined;
    if (!info.isDirectory() || info.isSymbolicLink() || !same(await realpath(next), next)) {
      if (!create) return undefined;
      throw new Error("CAD 私有配置目录不能重定向到其他位置。");
    }
    current = next;
  }
  return current;
}

/** Only writes a fresh account-private config; never installs, starts CAD, or touches drawings. */
export async function buildAutocadMcpConfig(credentials: Record<string, unknown> = {}): Promise<McpStdioServerConfig> {
  const directory = await workingDirectory(credentials.workingDirectory);
  const entry = await executable(credentials.mcpExecutable, "AutoCAD MCP 程序");
  const progId = normalizeAutocadProgId(credentials.progId);
  const suppliedRunner = entry ? undefined : await executable(process.env.CCAGENT_UVX_EXECUTABLE, "uvx 程序", "uvx");
  const standalone = path.join(os.homedir(), ".local", "bin", "uvx.exe");
  const runner = suppliedRunner || (process.platform === "win32" && await stat(standalone).then((info) => info.isFile(), () => false) ? standalone : "uvx");
  const managed = (await managedDirectory(true))!;
  const file = path.join(managed, `autocad-${randomUUID()}.toml`);
  const text = [
    "# CCAGENT managed connection. Do not widen paths or enable code execution.",
    "[server]", "read_only = false", "allow_launch = false", "enable_lisp = false",
    `prog_id = ${JSON.stringify(progId)}`, 'com_binding = "dynamic"', "com_timeout_s = 60.0", 'profile = "core"', "audit_log = true",
    "[paths]", `allowed_dirs = [${JSON.stringify(directory)}]`, "allow_any = false",
    "[log]", `dir = ${JSON.stringify(path.join(managed, "logs"))}`, 'level = "WARN"', "",
  ].join("\n");
  const handle = await open(file, "wx", 0o600);
  try { await handle.writeFile(text, "utf8"); }
  catch (error) { await handle.close(); await unlink(file).catch(() => {}); throw error; }
  await handle.close();
  return {
    type: "stdio", command: entry || runner,
    args: entry ? [] : ["--no-config", "--python", "3.11", "--from", AUTOCAD_MCP_SOURCE, "autocad-mcp"],
    connectTimeoutMs: 180_000, toolTimeoutMs: 90_000,
    env: {
      AUTOCAD_MCP_CONFIG: file, AUTOCAD_MCP_ALLOWED_DIRS: directory,
      AUTOCAD_MCP_WORKSPACE: directory, AUTOCAD_MCP_READ_ONLY: "0",
      PYTHONPATH: "", PYTHONHOME: "", PYTHONSAFEPATH: "1", PYTHONNOUSERSITE: "1", PYTHONUTF8: "1", DO_NOT_TRACK: "1",
      UV_NO_CONFIG: "1", UV_CONCURRENT_DOWNLOADS: "1", UV_CONCURRENT_INSTALLS: "1",
      UV_CACHE_DIR: path.join(os.tmpdir(), "cc-cad", createHash("sha256").update(managed).digest("hex").slice(0, 16)),
    },
  };
}

/** Removes only a generated regular TOML belonging to this account. Does not remove logs/runtime/user data. */
export async function removeAutocadMcpConfig(config: McpServerConfig): Promise<void> {
  if (config.type === "http" || config.type === "sse") return;
  const candidate = config.env?.AUTOCAD_MCP_CONFIG;
  if (typeof candidate !== "string" || !MANAGED_NAME.test(path.basename(candidate))) return;
  const managed = await managedDirectory(false);
  if (!managed || !same(path.dirname(candidate), managed)) return;
  const info = await lstat(candidate).catch(() => undefined);
  if (!info?.isFile() || info.isSymbolicLink()) return;
  const canonical = await realpath(candidate);
  if (!same(path.dirname(canonical), managed)) return;
  await unlink(candidate);
}
