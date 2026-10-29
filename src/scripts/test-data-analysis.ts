import assert from "node:assert/strict";
import * as XLSX from "xlsx";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { analyzeData, dateValue, defaultConfig, exportDataCsv, numberValue, parseData } from "../services/data/analysis.js";
import { importDataSet, listDataSets, loadDataSet } from "../services/data/store.js";
import { analyzeDataTool } from "../tools/analyzeDataTool.js";

const matrix = [
  ["项目统计"], [], ["项目", "区域", "状态", "日期", "投资（万元）", "纬度", "经度"],
  ["项目 A", "华东", "规划", new Date("2026-01-02T00:00:00Z"), 100, 31.2, 121.5],
  ["项目 B", "华东", "建设中", new Date("2026-02-01T00:00:00Z"), 200, 30.2, 120.5],
  ["项目 C", "华南", "完成", new Date("2026-02-15T00:00:00Z"), -50, 23.1, 113.3],
  ["项目 D", "华南", "完成", new Date("2026-02-18T00:00:00Z"), 0, 22.5, 114.1],
  ["项目 E", "华北", "建设中", new Date("2026-03-01T00:00:00Z"), 300, 39.9, 116.4],
  ["项目 F", "华东", "规划", new Date("2026-03-02T00:00:00Z"), "待确认", null, null],
  ["项目 G", "华北", "规划", "未知", null, 95, 300],
  ["项目 A", "华东", "规划", new Date("2026-01-02T00:00:00Z"), 100, 31.2, 121.5],
  ["合计", null, null, null, 650, null, null],
];
const book = XLSX.utils.book_new(), sheet = XLSX.utils.aoa_to_sheet(matrix); sheet["!rows"] = Array.from({ length: 12 }, (_, i) => ({ hidden: i === 5 }));
XLSX.utils.book_append_sheet(book, sheet, "项目明细"); XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([["年份", "投资"], [2026, 650]]), "年度汇总");
const bytes = XLSX.write(book, { type: "buffer", bookType: "xlsx" }) as Buffer;
const table = parseData(bytes, "项目统计.xlsx", { headerRow: 3 });
assert.equal(parseData(bytes, "自动表头.xlsx").headerRow, 3, "Auto header skips a report title and blank row");
assert.equal(table.rows.length, 9); assert.equal(table.sourceRows[0], 4); assert.equal(table.headerRow, 3); assert.deepEqual(table.sheets, ["项目明细", "年度汇总"]);
const cfg = defaultConfig(table); assert.equal(cfg.metric, "c4"); assert.equal(cfg.time, "c3");
const a = analyzeData(table, cfg, { excludeTotals: true });
assert.equal(a.filteredRows, 8); assert.equal(a.primary?.sum, 650); assert.equal(a.primary?.count, 6); assert.equal(a.primary?.median, 100); assert.equal(a.primary?.min, -50); assert.equal(a.primary?.invalid, 1); assert.equal(a.primary?.missing, 1);
assert.equal(a.quality.duplicates, 1); assert.equal(a.quality.totals, 1); assert.equal(a.quality.invalidDates, 1); assert.equal(a.points.length, 6);
assert.equal(a.distribution.find((r) => r.name === "华东")?.value, 400); assert.equal(a.trend.find((r) => r.name === "2026-02")?.value, 150);
assert.equal(analyzeData(table).primary?.sum, 1300); assert(analyzeData(table).notes.some((t) => t.includes("汇总") || t.includes("合计")));
const narrowed = analyzeData(table, cfg, { dimension: "华东", from: "2026-02-01", to: "2026-03-31", excludeTotals: true });
assert.equal(narrowed.filteredRows, 2); assert.equal(narrowed.primary?.sum, 200); assert.deepEqual(narrowed.matchingRows, [5, 9]);
assert.equal(analyzeData(table, { ...cfg, aggregation: "avg" }, { excludeTotals: true }).distribution.find((r) => r.name === "华东")?.value, 400 / 3);
assert.equal(analyzeData(table, { ...cfg, aggregation: "count" }, { dimension: "华东" }).distribution[0].value, 4);
assert.equal(analyzeData(table, cfg, { query: "不存在" }).primary?.sum, null);
assert.throws(() => analyzeData(table, cfg, { from: "2026-03-01", to: "2026-01-01" }), /开始日期/);
assert.throws(() => analyzeData(table, cfg, { from: "2026-02-30" }), /日期筛选/);
assert.throws(() => analyzeData(table, { ...cfg, metric: "unknown" }), /字段映射/);
assert.equal(parseData(bytes, "data.xlsx", { sheet: "年度汇总" }).rows.length, 1);
assert.equal(parseData(XLSX.write(book, { type: "buffer", bookType: "biff8" }), "legacy.xls", { headerRow: 3 }).rows.length, 9);
assert.equal(parseData(Buffer.from('类别,金额\n"包含,逗号",1\n"多\n行",2'), "quoted.csv").rows.length, 2);
assert.deepEqual(parseData(Buffer.from('[{"__proto__":"safe","值":1},{"值":2}]'), "data.json").columns.map((c) => c.name), ["__proto__", "值"]);
assert.equal(numberValue("￥1,234.50"), 1234.5); assert.equal(numberValue("(2,000)"), -2000); assert.equal(numberValue("25%"), 0.25); assert.equal(numberValue("1,2"), null); assert.equal(dateValue("2026-02-30"), null);
const states = parseData(Buffer.from(JSON.stringify(Array.from({ length: 26 }, (_, n) => ({ 区域: "华东", 状态: "状态" + n, 金额: n })))), "states.json");
const allStates = analyzeData(states); assert.equal(allStates.statuses.length, 20); assert.equal(allStates.statuses.reduce((n, r) => n + r.count, 0), 26); assert.equal(allStates.stacked[0].values.reduce<number>((n, v) => n + (v || 0), 0), 325);
const injection = parseData(Buffer.from('名称,数值\n"=HYPERLINK(恶意)",1\n普通,2'), "inject.csv");
assert(exportDataCsv(injection, analyzeData(injection)).includes("'=HYPERLINK")); assert.equal(JSON.stringify(injection.rows).includes("'=HYPERLINK"), false, "Export must not mutate source data");
const many = parseData(Buffer.from("名称,金额\n" + Array.from({ length: 125 }, (_, i) => `项目${i},${i}`).join("\n")), "many.csv");
assert.equal(exportDataCsv(many, analyzeData(many)).split("\r\n").length, 126, "CSV export includes every matching source row, beyond the preview page");
assert.throws(() => parseData(Buffer.alloc(0), "empty.csv"), /非空/); assert.throws(() => parseData(bytes, "data.exe"), /支持 Excel/);
assert.throws(() => parseData(Buffer.from("名称,金额\n" + "x,1\n".repeat(50_001)), "big.csv"), /50,000/);
const bomb = Buffer.from(bytes), central = bomb.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])); bomb.writeUInt32LE(200 * 1024 * 1024, central + 24); assert.throws(() => parseData(bomb, "bomb.xlsx"), /解压后过大/);
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "ccagent-data-")));
try {
  const workspace = path.join(temp, "另一个 工作目录"), other = path.join(temp, "其他目录"); await fs.mkdir(workspace); await fs.mkdir(other);
  const source = path.join(workspace, "项目.xlsx"); await fs.writeFile(source, bytes);
  const dataset = await importDataSet(workspace, bytes, "项目.xlsx", "项目.xlsx", { headerRow: 3 });
  assert.equal((await listDataSets(workspace)).length, 1); assert.equal((await listDataSets(other)).length, 0); assert.equal((await loadDataSet(workspace, dataset.id)).table.rows.length, 9);
  await assert.rejects(loadDataSet(other, dataset.id)); await assert.rejects(loadDataSet(workspace, "../outside"));
  const tool = await analyzeDataTool.call({ dataset_id: dataset.id, filters: { excludeTotals: true } }, { cwd: workspace });
  assert(!tool.isError); const evidence = JSON.parse(String(tool.content)); assert.equal(evidence.primary.sum, a.primary?.sum); assert.equal(evidence.filteredRows, a.filteredRows); assert.equal(evidence.quality.duplicates, 1);
  assert(!(await analyzeDataTool.call({ file_path: "项目.xlsx", header_row: 3 }, { cwd: workspace })).isError);
  assert((await analyzeDataTool.call({ file_path: path.join(other, "secret.xlsx") }, { cwd: workspace })).isError);
  assert((await fs.readFile(source)).equals(bytes), "Analysis never rewrites the original workbook bytes");
  const escaped = path.join(other, ".ccagent"); await fs.symlink(workspace, escaped, process.platform === "win32" ? "junction" : "dir"); await assert.rejects(listDataSets(other), /工作文件夹之外/);
  console.log("Data analysis: real XLSX/XLS, sheet/header selection, exact totals and filtering, dates, missing/invalid values, duplicates, state grouping, full CSV export, injection/ZIP limits, CLI evidence and workspace isolation passed.");
} finally { const relative = path.relative(await fs.realpath(os.tmpdir()), temp); if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Unsafe cleanup"); await fs.rm(temp, { recursive: true, force: true }); }
