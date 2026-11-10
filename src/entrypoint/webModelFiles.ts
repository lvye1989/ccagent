import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, realpath, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { getCCAgentPath } from "../utils/paths.js";

export interface ModelFile {
  id: string;
  name: string;
  path: string;
  createdAt: string;
  openUrl: string;
  persistent: boolean;
}
interface ModelFileRecord extends ModelFile { sessionId: string; root: string; realRoot: string; realFile: string; }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const comparable = (value: string) => process.platform === "win32" ? value.toLowerCase() : value;
function inside(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return Boolean(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
function view(record: ModelFileRecord): ModelFile {
  const { id, name, path: file, createdAt, openUrl, persistent } = record;
  return { id, name, path: file, createdAt, openUrl, persistent };
}

/** Only native verified exports can register a file. Model-authored links never grant access. */
export class WebModelFiles {
  private cache = new Map<string, ModelFileRecord[]>();
  constructor(private directory = getCCAgentPath("model-files")) {}
  private sessionDirectory(sessionId: string): string {
    if (!uuid.test(sessionId)) throw new Error("无效的会话编号。");
    return path.join(this.directory, sessionId);
  }
  private async records(sessionId: string): Promise<ModelFileRecord[]> {
    const directory = this.sessionDirectory(sessionId);
    if (!this.cache.has(sessionId)) {
      const records: ModelFileRecord[] = [];
      const files = await readdir(directory).catch(error => {
        if (error.code === "ENOENT") return [];
        throw error;
      });
      for (const name of files) {
        if (!name.endsWith(".json") || !uuid.test(name.slice(0, -5))) continue;
        const record = JSON.parse(await readFile(path.join(directory, name), "utf8")) as ModelFileRecord;
        if (record.sessionId === sessionId && record.id === name.slice(0, -5)
          && [record.path, record.root, record.realRoot, record.realFile].every(value => typeof value === "string" && path.isAbsolute(value))
          && record.openUrl === `/api/sessions/${sessionId}/model-files/${record.id}/open`) records.push(record);
      }
      this.cache.set(sessionId, records);
    }
    return this.cache.get(sessionId)!;
  }
  async list(sessionId: string): Promise<ModelFile[]> {
    return (await this.records(sessionId)).map(view).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  private async verify(record: Pick<ModelFileRecord, "root" | "realRoot" | "path" | "realFile">): Promise<void> {
    try {
      const [rootStat, fileStat, realRoot, realFile] = await Promise.all([
        lstat(record.root), lstat(record.path), realpath(record.root), realpath(record.path),
      ]);
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || !fileStat.isFile() || fileStat.isSymbolicLink()
        || path.extname(record.path).toLowerCase() !== ".3dm" || !inside(record.root, record.path)
        || !inside(realRoot, realFile) || comparable(realRoot) !== comparable(record.realRoot)
        || comparable(realFile) !== comparable(record.realFile)) throw new Error("文件位置已改变");
      const file = await open(record.path, "r");
      try {
        const header = Buffer.alloc(24);
        await file.read(header, 0, header.length, 0);
        if (!header.toString("ascii").startsWith("3D Geometry File Format ")) throw new Error("不是 Rhino 模型文件");
      } finally { await file.close(); }
    } catch {
      throw new Error("模型文件不存在、已移动或格式已改变。请检查显示的保存地址。");
    }
  }
  async register(sessionId: string, file: string, root: string, temporary = false): Promise<ModelFile> {
    this.sessionDirectory(sessionId);
    if (!path.isAbsolute(file) || !path.isAbsolute(root)) throw new Error("模型导出需要完整保存地址。");
    const record: ModelFileRecord = {
      id: randomUUID(), sessionId, name: path.basename(file), path: path.resolve(file), root: path.resolve(root),
      realRoot: await realpath(root), realFile: await realpath(file), createdAt: new Date().toISOString(),
      openUrl: "", persistent: !temporary,
    };
    await this.verify(record);
    record.openUrl = `/api/sessions/${sessionId}/model-files/${record.id}/open`;
    const records = await this.records(sessionId);
    if (!temporary) {
      try {
        const directory = this.sessionDirectory(sessionId);
        await mkdir(directory, { recursive: true });
        const target = path.join(directory, record.id + ".json");
        const temp = target + ".tmp";
        await writeFile(temp, JSON.stringify(record), { flag: "wx", mode: 0o600 });
        await rename(temp, target);
      } catch { record.persistent = false; }
    }
    records.push(record);
    return view(record);
  }
  async open(sessionId: string, id: string, launch = openModelFile): Promise<void> {
    if (!uuid.test(id)) throw new Error("模型文件不存在。");
    const record = (await this.records(sessionId)).find(item => item.id === id);
    if (!record) throw new Error("当前对话中没有这个模型文件。");
    await this.verify(record);
    await launch(record.path);
  }
}

async function openModelFile(file: string): Promise<void> {
  const run = promisify(execFile);
  // File paths are data, never interpolated into shell code. Open only after an explicit UI click.
  try {
    if (process.platform === "win32") {
      await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference='Stop'; Start-Process -FilePath $env:CCAGENT_MODEL_FILE"], {
        windowsHide: true, timeout: 15000, env: { ...process.env, CCAGENT_MODEL_FILE: file },
      });
    } else await run(process.platform === "darwin" ? "open" : "xdg-open", [file], { timeout: 15000 });
  } catch { throw new Error("无法打开模型文件。请安装 Rhino 或设置 .3dm 的默认打开应用，也可以复制保存地址后手动打开。"); }
}
