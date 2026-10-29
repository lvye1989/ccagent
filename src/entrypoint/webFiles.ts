import { createReadStream } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { inflateRawSync } from "node:zlib";
import type { IncomingMessage, ServerResponse } from "node:http";
import he from "he";

const TEXT_EXT = new Set("txt md markdown json jsonl yaml yml csv tsv ts tsx js jsx mjs cjs py html htm css scss xml svg toml ini log sql sh ps1 bat cmd c cpp h hpp cs java go rs rb php vue svelte gitignore gitattributes env.example".split(" "));
const MEDIA: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp", ico: "image/x-icon", pdf: "application/pdf", mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", m4a: "audio/mp4", mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime" };
const OFFICE = new Set(["docx", "xlsx", "pptx", "odt", "ods", "odp"]);
const PRIVATE = /^(?:\.env(?:\..*)?|.*(?:secret|password|credential|private[-_.]?key).*)$/i;
const MAX_TEXT = 1024 * 1024;
export const MAX_UPLOAD = 10 * 1024 * 1024;

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
function allowed(relative: string): boolean {
  const parts = relative.split(/[\\/]/);
  if (parts.some((part) => part === ".git" || PRIVATE.test(part))) return false;
  return !parts.includes(".ccagent") || (parts[0] === ".ccagent" && parts[1] === "attachments" && parts.length >= 4);
}
export async function resolveWorkspaceFile(workspace: string, relative = "", directory = false) {
  if (typeof relative !== "string" || relative.includes("\0") || path.isAbsolute(relative)) throw new Error("请使用工作文件夹内的相对路径。");
  const root = await realpath(workspace);
  const target = path.resolve(root, relative);
  if (!inside(root, target) || !allowed(path.relative(root, target))) throw new Error("该路径不能通过文件面板访问。");
  const canonical = await realpath(target);
  if (!inside(root, canonical) || !allowed(path.relative(root, canonical))) throw new Error("链接指向不可访问的位置。");
  const info = await stat(canonical);
  if (directory ? !info.isDirectory() : !info.isFile()) throw new Error(directory ? "这不是文件夹。" : "这不是普通文件。");
  return { filePath: canonical, relative: path.relative(root, target).replaceAll("\\", "/"), info };
}
export function describeFile(name: string) {
  const ext = path.extname(name).slice(1).toLowerCase();
  const mime = MEDIA[ext] || "application/octet-stream";
  const format = OFFICE.has(ext) ? "office" : mime === "application/pdf" ? "pdf" : mime.startsWith("image/") ? "image" : mime.startsWith("audio/") ? "audio" : mime.startsWith("video/") ? "video" : TEXT_EXT.has(ext) || !ext ? "text" : "binary";
  return { extension: ext, format, mime };
}
export async function browseWorkspaceFiles(workspace: string, relative: string, query: string, hidden: boolean, offset = 0) {
  if (query.length > 200 || !Number.isSafeInteger(offset) || offset < 0) throw new Error("无效的文件筛选参数。");
  const folder = await resolveWorkspaceFile(workspace, relative, true);
  const root = await realpath(workspace);
  const entries = (await readdir(folder.filePath, { withFileTypes: true }))
    .filter((entry) => (hidden || !entry.name.startsWith(".")) && allowed([folder.relative, entry.name].filter(Boolean).join("/")) && entry.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name, "zh-CN", { numeric: true }));
  const files = await Promise.all(entries.slice(offset, offset + 250).map(async (entry) => {
    const relativePath = [folder.relative, entry.name].filter(Boolean).join("/");
    try {
      const full = path.join(folder.filePath, entry.name);
      const canonical = await realpath(full);
      if (!inside(root, canonical) || !allowed(path.relative(root, canonical))) return null;
      const info = await stat(canonical);
      if (!info.isFile() && !info.isDirectory()) return null;
      return { path: relativePath, name: entry.name, directory: info.isDirectory(), size: info.size, updatedAt: info.mtime.toISOString(), ...describeFile(entry.name) };
    } catch { return null; }
  }));
  return { workspace, path: folder.relative, parent: folder.relative ? path.posix.dirname(folder.relative) === "." ? "" : path.posix.dirname(folder.relative) : null, entries: files.filter(Boolean), total: entries.length, nextOffset: offset + 250 < entries.length ? offset + 250 : null };
}

// Read ZIP entries without executing Office macros or fetching external resources.
function officeEntries(bytes: Buffer): Map<string, string> {
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) if (bytes.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  if (end < 0) throw new Error("无法读取此 Office 文件，请下载后打开。");
  const count = bytes.readUInt16LE(end + 10);
  let cursor = bytes.readUInt32LE(end + 16), total = 0;
  const entries = new Map<string, string>();
  for (let n = 0; n < count; n++) {
    if (cursor + 46 > bytes.length || bytes.readUInt32LE(cursor) !== 0x02014b50) throw new Error("文档压缩结构无效。");
    const method = bytes.readUInt16LE(cursor + 10), compressed = bytes.readUInt32LE(cursor + 20), expanded = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28), extra = bytes.readUInt16LE(cursor + 30), comment = bytes.readUInt16LE(cursor + 32), local = bytes.readUInt32LE(cursor + 42);
    const name = bytes.toString("utf8", cursor + 46, cursor + 46 + nameLength);
    cursor += 46 + nameLength + extra + comment;
    if (!/^(word\/document\.xml|xl\/sharedStrings\.xml|xl\/worksheets\/sheet\d+\.xml|ppt\/slides\/slide\d+\.xml|content\.xml)$/.test(name)) continue;
    if (expanded > 4 * MAX_TEXT || total + expanded > 8 * MAX_TEXT) throw new Error("文档内容过大，请下载后查看。");
    if (local + 30 > bytes.length || bytes.readUInt32LE(local) !== 0x04034b50) throw new Error("文档结构无效。");
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    if (start + compressed > bytes.length) throw new Error("文档数据不完整。");
    const raw = bytes.subarray(start, start + compressed);
    const content = method === 0 ? raw : method === 8 ? inflateRawSync(raw, { maxOutputLength: 4 * MAX_TEXT }) : null;
    if (!content || content.length !== expanded) throw new Error("文档压缩格式不受支持。");
    total += content.length;
    entries.set(name, content.toString("utf8"));
  }
  return entries;
}
function xmlText(xml: string): string {
  return he.decode(xml.replace(/<[^>]*>/g, ""));
}
function paragraphText(xml: string): string {
  return xmlText(xml.replace(/<\/(?:w:p|a:p|text:p|text:h|table:table-row)>/g, "\n").replace(/<(?:w:tab|w:br|a:br)\b[^>]*\/?\s*>/g, "\t")).trim();
}
export async function previewWorkspaceFile(workspace: string, relative: string) {
  const file = await resolveWorkspaceFile(workspace, relative);
  const description = describeFile(relative);
  const result = { path: file.relative, name: path.basename(file.filePath), size: file.info.size, updatedAt: file.info.mtime.toISOString(), ...description };
  if (description.format === "text") {
    const handle = await open(file.filePath, "r");
    try {
      const bytes = Buffer.alloc(Math.min(file.info.size, MAX_TEXT));
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      const content = bytes.subarray(0, bytesRead).toString("utf8");
      if (content.includes("\0")) return { ...result, format: "binary" };
      return { ...result, content, truncated: file.info.size > MAX_TEXT };
    } finally { await handle.close(); }
  }
  if (description.format === "office") {
    if (file.info.size > 20 * MAX_TEXT) throw new Error("Office 预览支持 20 MB 以内的文件，请下载查看原文件。");
    const handle = await open(file.filePath, "r");
    let entries: Map<string, string>;
    try { entries = officeEntries(await handle.readFile()); } finally { await handle.close(); }
    if (description.extension === "xlsx") {
      const shared = [...(entries.get("xl/sharedStrings.xml") ?? "").matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((match) => xmlText(match[1]));
      const sheets = [...entries].filter(([name]) => name.startsWith("xl/worksheets/")).sort(([a], [b]) => a.localeCompare(b, "en", { numeric: true })).slice(0, 20).map(([name, xml]) => {
        const rows = [...xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)].slice(0, 200).map((row) => {
          const cells: string[] = [];
          for (const cell of row[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
            const ref = /\br="([A-Z]+)\d+"/.exec(cell[1])?.[1];
            const column = ref ? [...ref].reduce((value, char) => value * 26 + char.charCodeAt(0) - 64, 0) - 1 : cells.length;
            if (column > 49) continue;
            const raw = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(cell[2])?.[1];
            cells[column] = /\bt="s"/.test(cell[1]) ? shared[Number(raw)] ?? "" : /\bt="inlineStr"/.test(cell[1]) ? xmlText(cell[2]) : he.decode(raw ?? "");
          }
          return Array.from({ length: cells.length }, (_, index) => cells[index] ?? "");
        });
        return { name: `工作表 ${/sheet(\d+)/.exec(name)?.[1] ?? ""}`, rows };
      });
      return { ...result, sheets, note: "表格预览显示前 20 张表、每表前 200 行和 50 列；下载可查看原始格式。" };
    }
    const content = [...entries].filter(([name]) => name === "word/document.xml" || name === "content.xml" || name.startsWith("ppt/slides/")).sort(([a], [b]) => a.localeCompare(b, "en", { numeric: true })).map(([name, xml]) => `${name.startsWith("ppt/") ? `幻灯片 ${/slide(\d+)/.exec(name)?.[1]}\n` : ""}${paragraphText(xml)}`).join("\n\n");
    return { ...result, content: content.slice(0, MAX_TEXT), truncated: content.length > MAX_TEXT, note: "正文预览；图片、排版和嵌入对象请下载原文件查看。" };
  }
  return result;
}
export async function serveWorkspaceFile(req: IncomingMessage, res: ServerResponse, workspace: string, relative: string, download: boolean) {
  const file = await resolveWorkspaceFile(workspace, relative);
  const { mime, format } = describeFile(relative);
  const inline = !download && ["image", "pdf", "audio", "video"].includes(format);
  const headers: Record<string, string | number> = {
    "content-type": inline ? mime : "application/octet-stream", "content-disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(path.basename(file.filePath))}`,
    "x-content-type-options": "nosniff", "cache-control": "no-store", "content-security-policy": "default-src 'none'; frame-ancestors 'self'", "accept-ranges": "bytes",
  };
  let start = 0, end = file.info.size - 1;
  if (req.headers.range) {
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    if (!range || (!range[1] && !range[2])) { res.writeHead(416, { "content-range": `bytes */${file.info.size}` }); res.end(); return; }
    start = range[1] ? Number(range[1]) : Math.max(0, file.info.size - Number(range[2]));
    end = range[1] && range[2] ? Math.min(Number(range[2]), end) : end;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= file.info.size) { res.writeHead(416, { "content-range": `bytes */${file.info.size}` }); res.end(); return; }
    headers["content-range"] = `bytes ${start}-${end}/${file.info.size}`;
  }
  headers["content-length"] = Math.max(0, end - start + 1);
  res.writeHead(req.headers.range ? 206 : 200, headers);
  if (!file.info.size) { res.end(); return; }
  const stream = createReadStream(file.filePath, { start, end });
  stream.on("error", () => res.destroy());
  res.on("close", () => stream.destroy());
  stream.pipe(res);
}
export async function saveWorkspaceAttachment(workspace: string, name: unknown, base64: unknown) {
  if (typeof name !== "string" || typeof base64 !== "string" || !name.trim() || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64) || base64.length % 4 || base64.length > Math.ceil(MAX_UPLOAD / 3) * 4) throw new Error("文件无效，单个附件最大 10 MB。");
  const safeName = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/[. ]+$/, "").slice(0, 150);
  if (!safeName || PRIVATE.test(safeName)) throw new Error("该附件名称不受支持。");
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length > MAX_UPLOAD || bytes.toString("base64") !== base64) throw new Error("附件内容无效或超过 10 MB。");
  const root = await realpath(workspace);
  for (const parent of [path.join(root, ".ccagent"), path.join(root, ".ccagent", "attachments")]) {
    const info = await lstat(parent).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
    if (info && (info.isSymbolicLink() || !info.isDirectory() || !inside(root, await realpath(parent)))) throw new Error("附件目录不能使用外部链接。");
  }
  const destination = path.join(root, ".ccagent", "attachments", randomUUID());
  await mkdir(destination, { recursive: true });
  if (!inside(root, await realpath(destination))) throw new Error("附件目录必须位于工作文件夹内。");
  const target = path.join(destination, safeName);
  await writeFile(target, bytes, { flag: "wx" });
  return { workspace, path: path.relative(root, target).replaceAll("\\", "/"), name: safeName, size: bytes.length, ...describeFile(safeName) };
}
