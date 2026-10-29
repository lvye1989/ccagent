import { mkdir, readFile, readdir, realpath, rename, stat, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { defaultConfig, parseData, validateConfig, type ChartConfig, type DataTable, type DataFilters } from "./analysis.js";

export type DataSet = { version: 1; id: string; createdAt: string; sourcePath: string; table: DataTable; config: ChartConfig; filters?: DataFilters };
const validId = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id);
async function directory(workspace: string, create = false) {
  const root = await realpath(workspace), target = path.join(root, ".ccagent", "data-visualization");
  // Check every existing ancestor before mkdir, including junctions on Windows.
  for (const folder of [path.join(root, ".ccagent"), target]) {
    try {
      const resolved = await realpath(folder), rel = path.relative(root, resolved);
      if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error("数据目录链接指向工作文件夹之外。");
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  if (create) await mkdir(target, { recursive: true });
  return target;
}
const metadata = (d: DataSet) => ({ id: d.id, name: d.table.name, sheet: d.table.sheet, rows: d.table.rows.length, columns: d.table.columns.length, createdAt: d.createdAt, sourcePath: d.sourcePath });
async function atomic(file: string, value: unknown) {
  const temp = file + "." + randomUUID() + ".tmp";
  try { await writeFile(temp, JSON.stringify(value), { flag: "wx" }); await rename(temp, file); }
  finally { await unlink(temp).catch(() => {}); }
}
export async function listDataSets(workspace: string) {
  const dir = await directory(workspace);
  let names: string[]; try { names = await readdir(dir); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return []; throw e; }
  const results = await Promise.all(names.filter((n) => n.endsWith(".meta.json") && validId(n.slice(0, -10))).map(async (name) => {
    const file = path.join(dir, name); const info = await stat(file); if (info.size > 16_384) return null;
    // Never follow dataset files that were replaced with symlinks.
    if (path.dirname(await realpath(file)) !== await realpath(dir)) return null;
    try { const data = JSON.parse(await readFile(file, "utf8")); return validId(data.id) ? data as ReturnType<typeof metadata> : null; } catch { return null; }
  }));
  return results.filter((d): d is ReturnType<typeof metadata> => !!d).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
export async function saveDataSet(workspace: string, data: DataSet) {
  if (!validId(data.id)) throw new Error("无效的数据集 ID。");
  const dir = await directory(workspace, true);
  const serialized = JSON.stringify(data);
  if (Buffer.byteLength(serialized) > 40 * 1024 * 1024) throw new Error("数据集过大，请拆分后导入。");
  await atomic(path.join(dir, data.id + ".json"), data);
  await atomic(path.join(dir, data.id + ".meta.json"), metadata(data));
  return data;
}
export async function loadDataSet(workspace: string, id: string): Promise<DataSet> {
  if (!validId(id)) throw new Error("无效的数据集 ID。");
  const dir = await directory(workspace), file = path.join(dir, id + ".json");
  if (path.dirname(await realpath(file)) !== await realpath(dir)) throw new Error("数据集链接不在当前工作文件夹内。");
  const info = await stat(file); if (info.size > 40 * 1024 * 1024) throw new Error("数据集超出大小限制。");
  const data = JSON.parse(await readFile(file, "utf8")) as DataSet;
  if (data.version !== 1 || data.id !== id || !Array.isArray(data.table?.rows) || !Array.isArray(data.table?.columns) || !Array.isArray(data.table?.sourceRows)) throw new Error("数据集结构无效，请重新导入原文件。");
  data.config = validateConfig(data.table, data.config);
  return data;
}
export async function importDataSet(workspace: string, bytes: Buffer, name: string, sourcePath: string, options: { sheet?: string; headerRow?: number } = {}) {
  const table = parseData(bytes, name, options);
  return saveDataSet(workspace, { version: 1, id: randomUUID(), createdAt: new Date().toISOString(), sourcePath, table, config: defaultConfig(table) });
}
