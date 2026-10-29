import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdir, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const exec = promisify(execFile);
export interface FolderLocation { name: string; path: string; kind: "home" | "desktop" | "documents" | "downloads" | "drive" }
let locationsCache: { expires: number; locations: FolderLocation[] } | undefined;

function powershell(): string {
  return path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

export function expandFolderPath(input: string): string {
  let value = input.trim().replace(/^"(.*)"$/, "$1");
  if (value === "~" || /^~[/\\]/.test(value)) value = path.join(os.homedir(), value.slice(2));
  if (!value || value.length > 4096 || value.includes("\0") || !path.isAbsolute(value)) throw new Error("请选择已有文件夹，或输入完整的文件夹路径。");
  return path.resolve(value);
}

export async function resolveWorkingFolder(input: string): Promise<string> {
  const absolute = expandFolderPath(input);
  try {
    if (!(await stat(absolute)).isDirectory()) throw new Error("NOT_DIRECTORY");
    return await realpath(absolute);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM") throw new Error("没有权限访问这个文件夹，请选择其他文件夹。");
    throw new Error("文件夹不存在或不可访问，请检查路径或重新选择。");
  }
}

export async function listFolderLocations(): Promise<FolderLocation[]> {
  if (locationsCache && locationsCache.expires > Date.now()) return locationsCache.locations;
  let locations: FolderLocation[] = [];
  if (process.platform === "win32") {
    try {
      // Known folders may be redirected to OneDrive or another drive.
      const script = "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $items=@(@{name='用户目录';path=[Environment]::GetFolderPath('UserProfile');kind='home'},@{name='桌面';path=[Environment]::GetFolderPath('Desktop');kind='desktop'},@{name='文档';path=[Environment]::GetFolderPath('MyDocuments');kind='documents'},@{name='下载';path=(Join-Path ([Environment]::GetFolderPath('UserProfile')) 'Downloads');kind='downloads'}); foreach($drive in [IO.DriveInfo]::GetDrives()){if($drive.IsReady){$items+=@{name=$drive.Name;path=$drive.RootDirectory.FullName;kind='drive'}}}; ConvertTo-Json -InputObject $items -Compress";
      const result = await exec(powershell(), ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, timeout: 7000, maxBuffer: 64 * 1024, encoding: "utf8" });
      locations = JSON.parse(result.stdout.replace(/^\uFEFF/, "")) as FolderLocation[];
    } catch { /* A directory browser remains available without the helper. */ }
  }
  if (!locations.length) {
    locations = [
      { name: "用户目录", path: os.homedir(), kind: "home" },
      { name: "桌面", path: path.join(os.homedir(), "Desktop"), kind: "desktop" },
      { name: "文档", path: path.join(os.homedir(), "Documents"), kind: "documents" },
      { name: "下载", path: path.join(os.homedir(), "Downloads"), kind: "downloads" },
      { name: "文件系统", path: path.parse(os.homedir()).root, kind: "drive" },
    ];
  }
  const available = await Promise.all(locations.map(async (item) => {
    if (!item.path || !path.isAbsolute(item.path)) return null;
    return await stat(item.path).then((info) => info.isDirectory() ? item : null, () => null);
  }));
  const unique = new Map<string, FolderLocation>();
  for (const item of available) if (item) unique.set(process.platform === "win32" ? item.path.toLowerCase() : item.path, item);
  const result = [...unique.values()];
  locationsCache = { expires: Date.now() + 30000, locations: result };
  return result;
}

export async function browseWorkingFolders(input: string, query = "", showHidden = false) {
  if (query.length > 100) throw new Error("搜索内容不能超过 100 个字符。");
  const directory = await resolveWorkingFolder(input);
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch { throw new Error("无法读取此文件夹。可以选择其他位置，或使用系统文件夹选择器。"); }
  const candidates = entries.filter((item) => (item.isDirectory() || item.isSymbolicLink()) && (showHidden || !item.name.startsWith(".")) && item.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const folders = (await Promise.all(candidates.map(async (entry) => {
    const folder = path.join(directory, entry.name);
    if (entry.isSymbolicLink() && !(await stat(folder).then((info) => info.isDirectory(), () => false))) return null;
    return { name: entry.name, path: folder, linked: entry.isSymbolicLink() };
  }))).filter((item) => item !== null).sort((a, b) => a.name.localeCompare(b.name, "zh-CN", { numeric: true, sensitivity: "base" }));
  const crumbs: Array<{ name: string; path: string }> = [];
  let cursor = directory;
  for (let i = 0; i < 128; i++) {
    crumbs.unshift({ name: path.basename(cursor) || cursor, path: cursor });
    const parent = path.dirname(cursor); if (parent === cursor) break; cursor = parent;
  }
  return { path: directory, parent: path.dirname(directory) === directory ? null : path.dirname(directory), breadcrumbs: crumbs, folders: folders.slice(0, 500), total: folders.length, truncated: folders.length > 500 };
}

export async function pickNativeWorkingFolder(webRoot: string, initialPath: string): Promise<string | null> {
  if (process.platform !== "win32") throw new Error("当前系统请使用下方目录列表选择文件夹。");
  const result = await exec(powershell(), ["-NoLogo", "-NoProfile", "-STA", "-File", path.join(webRoot, "select-folder.ps1")], {
    windowsHide: true, timeout: 180000, maxBuffer: 16 * 1024, encoding: "utf8",
    env: { ...process.env, CCAGENT_FOLDER_PICKER_INITIAL: initialPath, CCAGENT_FOLDER_PICKER_TITLE: "选择工作文件夹" },
  }).catch(() => { throw new Error("系统选择器未能完成，请使用目录列表选择文件夹。"); });
  let selected: unknown;
  try { selected = JSON.parse(result.stdout.replace(/^\uFEFF/, "").trim()); }
  catch { throw new Error("系统选择器返回异常，请使用目录列表。"); }
  if (selected === null) return null;
  if (typeof selected !== "string") throw new Error("系统选择器未返回文件夹。");
  return resolveWorkingFolder(selected);
}
