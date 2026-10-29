import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";

const DOCUMENT_TYPES: Record<string, { kind: string; mime: string; text: boolean }> = {
  ".md": { kind: "文档", mime: "text/markdown", text: true },
  ".txt": { kind: "文档", mime: "text/plain", text: true },
  ".pdf": { kind: "PDF", mime: "application/pdf", text: false },
  ".docx": { kind: "Word", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", text: false },
  ".pptx": { kind: "演示", mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation", text: false },
  ".xlsx": { kind: "表格", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", text: false },
  ".csv": { kind: "表格", mime: "text/csv", text: true },
  ".html": { kind: "网页", mime: "text/html", text: true },
  ".xmind": { kind: "思维导图", mime: "application/octet-stream", text: false },
  ".png": { kind: "图片", mime: "image/png", text: false },
  ".jpg": { kind: "图片", mime: "image/jpeg", text: false },
  ".jpeg": { kind: "图片", mime: "image/jpeg", text: false },
  ".webp": { kind: "图片", mime: "image/webp", text: false },
};
const SKIP_DIRS = new Set([".git", ".ccagent", "node_modules", "dist", "build", "coverage", ".next", ".venv", "venv", "__pycache__"]);
const PRIVATE_NAME = /(^\.env(?:\.|$)|secret|token|password|credential|private[-_.]?key)/i;
const MAX_VISITED = 5000;

export interface WebDocument {
  path: string;
  name: string;
  kind: string;
  size: number;
  updatedAt: string;
  previewable: boolean;
}

function classify(relativePath: string) {
  if (relativePath.split(/[\\/]/).some((part) => PRIVATE_NAME.test(part))) return null;
  return DOCUMENT_TYPES[path.extname(relativePath).toLowerCase()] ?? null;
}

export async function listWorkspaceDocuments(workspace: string, query = "", kind = "all"): Promise<WebDocument[]> {
  const matches: WebDocument[] = [];
  const needle = query.trim().toLocaleLowerCase();
  let visited = 0;
  async function walk(directory: string, depth: number): Promise<void> {
    if (depth > 8 || visited >= MAX_VISITED) return;
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
      if (++visited > MAX_VISITED) break;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) await walk(path.join(directory, entry.name), depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const filePath = path.join(directory, entry.name);
      const relativePath = path.relative(workspace, filePath).replaceAll("\\", "/");
      const type = classify(relativePath);
      if (!type || (kind !== "all" && kind !== type.kind)) continue;
      if (needle && !relativePath.toLocaleLowerCase().includes(needle)) {
        if (!type.text) continue;
        const info = await stat(filePath).catch(() => null);
        if (!info || info.size > 256 * 1024) continue;
        const content = await readFile(filePath, "utf8").catch(() => "");
        if (!content.toLocaleLowerCase().includes(needle)) continue;
      }
      const info = await stat(filePath).catch(() => null);
      if (!info) continue;
      matches.push({ path: relativePath, name: entry.name, kind: type.kind, size: info.size,
        updatedAt: info.mtime.toISOString(), previewable: type.text && info.size <= 1024 * 1024 });
    }
  }
  await walk(workspace, 0);
  return matches.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 300);
}

export async function resolveWorkspaceDocument(workspace: string, relativePath: string): Promise<{ filePath: string; mime: string; previewable: boolean; size: number }> {
  if (!relativePath || path.isAbsolute(relativePath) || relativePath.includes("\0")) throw new Error("Invalid document path");
  const filePath = path.resolve(workspace, relativePath);
  const relative = path.relative(workspace, filePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Document is outside the workspace");
  const type = classify(relative);
  if (!type) throw new Error("File is not a document in this workspace");
  const root = await realpath(workspace);
  const real = await realpath(filePath);
  const realRelative = path.relative(root, real);
  if (!realRelative || realRelative.startsWith("..") || path.isAbsolute(realRelative)) throw new Error("Document is outside the workspace");
  const info = await lstat(filePath);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("File is not a regular document");
  return { filePath, mime: type.mime, previewable: type.text && info.size <= 1024 * 1024, size: info.size };
}
