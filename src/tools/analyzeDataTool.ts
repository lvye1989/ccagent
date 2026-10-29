import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { Tool } from "./Tool.js";
import { ensureRealPathInsideAllowedRoots, resolveWorkspacePath } from "./pathUtils.js";
import { analyzeData, MAX_DATA_BYTES, parseData } from "../services/data/analysis.js";
import { loadDataSet } from "../services/data/store.js";

export const analyzeDataTool: Tool = {
  name: "AnalyzeData",
  description: "Analyze Excel/xls/xlsx, CSV/TSV or JSON using the same deterministic statistics as the Web Data Visualization dashboard. Read a local file or a Web dataset_id in the current workspace. Returns exact aggregates, quality notes, trends and source row numbers; does not modify source files. Field mappings accept header names or c0/c1 column IDs. Use this for numeric evidence instead of guessing from previews or writing ad hoc spreadsheet scripts.",
  inputSchema: { type: "object", properties: {
    file_path: { type: "string" }, dataset_id: { type: "string" }, sheet: { type: "string" }, header_row: { type: "integer", minimum: 1 },
    fields: { type: "object", description: "Optional dimension, metric, status, time, label, latitude, longitude (header name or column ID), aggregation sum/avg/count/min/max, interval day/month/year" },
    filters: { type: "object", description: "Optional query, dimension, status, from/to (YYYY-MM-DD), excludeTotals" },
  } },
  async call(input, context) {
    try {
      context.abortSignal?.throwIfAborted();
      let dataset;
      if (typeof input.dataset_id === "string") dataset = await loadDataSet(context.cwd, input.dataset_id);
      else {
        if (typeof input.file_path !== "string" || !input.file_path.trim()) throw new Error("file_path 或 dataset_id 至少提供一个。");
        const file = resolveWorkspacePath(input.file_path, context.cwd); await ensureRealPathInsideAllowedRoots(file, context.cwd);
        if ((await stat(file)).size > MAX_DATA_BYTES) throw new Error("数据文件超过 10 MB。");
        dataset = { table: parseData(await readFile(file), path.basename(file), { sheet: typeof input.sheet === "string" ? input.sheet : undefined, headerRow: typeof input.header_row === "number" ? input.header_row : undefined }), config: undefined, filters: undefined };
      }
      const fields = input.fields && typeof input.fields === "object" && !Array.isArray(input.fields) ? { ...input.fields } as Record<string, unknown> : {};
      for (const key of ["dimension", "metric", "status", "time", "label", "latitude", "longitude"]) if (typeof fields[key] === "string") fields[key] = dataset.table.columns.find((c) => c.name === fields[key] || c.id === fields[key])?.id ?? fields[key];
      const result = analyzeData(dataset.table, { ...dataset.config, ...fields }, (input.filters ?? dataset.filters) as Parameters<typeof analyzeData>[2]);
      context.abortSignal?.throwIfAborted();
      const { matchingRows, options, allDistribution, ...evidence } = result;
      return { content: JSON.stringify({ source: input.file_path || input.dataset_id, name: dataset.table.name, sheet: dataset.table.sheet, ...evidence, preview: evidence.preview.slice(0, 10) }) };
    } catch (e) { return { content: `AnalyzeData error: ${e instanceof Error ? e.message : String(e)}`, isError: true }; }
  },
  isReadOnly: () => true, isEnabled: () => true, isConcurrencySafe: () => true,
};
