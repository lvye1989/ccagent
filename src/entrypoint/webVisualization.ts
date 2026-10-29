import { readFile } from "node:fs/promises";
import path from "node:path";
import { analyzeData, exportDataCsv, MAX_DATA_BYTES, validateConfig } from "../services/data/analysis.js";
import { importDataSet, listDataSets, loadDataSet, saveDataSet, type DataSet } from "../services/data/store.js";
import { resolveWorkspaceFile, saveWorkspaceAttachment } from "./webFiles.js";

const describe = (data: DataSet) => ({ id: data.id, name: data.table.name, sheet: data.table.sheet, sheets: data.table.sheets, headerRow: data.table.headerRow, columns: data.table.columns, rows: data.table.rows.length, createdAt: data.createdAt, sourcePath: data.sourcePath, config: data.config, filters: data.filters || {}, warnings: data.table.warnings });
export async function handleVisualization(action: string, input: Record<string, unknown>, workspace: string) {
  if (action === "list") return { workspace, datasets: await listDataSets(workspace) };
  if (action === "import") {
    let bytes: Buffer, name: string, sourcePath: string;
    if (typeof input.path === "string") {
      const file = await resolveWorkspaceFile(workspace, input.path);
      if (file.info.size > MAX_DATA_BYTES) throw new Error("数据文件超过 10 MB。");
      bytes = await readFile(file.filePath); name = path.basename(file.filePath); sourcePath = file.relative;
    } else {
      if (typeof input.text !== "string" || !input.text.trim() || Buffer.byteLength(input.text) > MAX_DATA_BYTES) throw new Error("请上传文件，或粘贴不超过 10 MB 的 CSV/TSV/JSON 数据。");
      name = typeof input.name === "string" ? input.name : input.text.trim().startsWith("[") ? "粘贴数据.json" : input.text.includes("\t") ? "粘贴数据.tsv" : "粘贴数据.csv";
      bytes = Buffer.from(input.text);
      const attachment = await saveWorkspaceAttachment(workspace, name, bytes.toString("base64")); sourcePath = attachment.path;
    }
    if (input.sheet !== undefined && typeof input.sheet !== "string") throw new Error("工作表名称无效。");
    if (input.headerRow !== undefined && (!Number.isInteger(input.headerRow) || Number(input.headerRow) < 1)) throw new Error("表头行需要正整数。");
    const data = await importDataSet(workspace, bytes, name, sourcePath, { sheet: input.sheet as string | undefined, headerRow: input.headerRow as number | undefined });
    return { workspace, dataset: describe(data) };
  }
  if (typeof input.id !== "string") throw new Error("请选择数据集。");
  const data = await loadDataSet(workspace, input.id);
  if (action === "open") return { workspace, dataset: describe(data) };
  if (action === "save") {
    data.config = validateConfig(data.table, input.config);
    data.filters = analyzeData(data.table, data.config, (input.filters || {}) as Parameters<typeof analyzeData>[2]).filters;
    await saveDataSet(workspace, data); return { workspace, dataset: describe(data) };
  }
  const analysis = analyzeData(data.table, input.config || data.config, (input.filters ?? data.filters) as Parameters<typeof analyzeData>[2], Number(input.page || 0));
  if (action === "export") return { workspace, name: `${path.parse(data.table.name).name}-筛选结果.csv`, csv: exportDataCsv(data.table, analysis) };
  if (action === "query") {
    const { matchingRows, allDistribution, ...result } = analysis;
    return { workspace, dataset: describe(data), analysis: result };
  }
  throw new Error("未知的数据可视化操作。");
}
