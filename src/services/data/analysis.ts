import * as XLSX from "xlsx";
import path from "node:path";

export type Cell = string | number | boolean | null;
export type Column = { id: string; name: string; kind: "number" | "date" | "text"; missing: number; numeric: number; distinct: number };
export type DataTable = { name: string; sheet: string; sheets: string[]; headerRow: number; columns: Column[]; rows: Cell[][]; sourceRows: number[]; warnings: string[] };
export type ChartConfig = { dimension: string; status: string; metric: string; time: string; latitude: string; longitude: string; label: string; aggregation: "sum" | "avg" | "count" | "min" | "max"; interval: "day" | "month" | "year" };
export type DataFilters = { query?: string; dimension?: string; status?: string; from?: string; to?: string; excludeTotals?: boolean };
export const MAX_DATA_BYTES = 10 * 1024 * 1024;
const MAX_ROWS = 50_000, MAX_COLUMNS = 200, MAX_CELLS = 1_000_000;
const empty = (v: Cell | undefined) => v === null || v === undefined || (typeof v === "string" && !v.trim());

export function numberValue(v: Cell | undefined): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string" || !v.trim()) return null;
  let s = v.trim().replaceAll("，", ",").replace(/^[¥￥$€£]\s*/, "");
  const negative = /^\(.*\)$/.test(s); if (negative) s = s.slice(1, -1);
  const percent = s.endsWith("%"); if (percent) s = s.slice(0, -1);
  // Accept grouped thousands, never silently turn arbitrary punctuation into a number.
  if (s.includes(",") && !/^[+-]?\d{1,3}(,\d{3})*(\.\d+)?$/.test(s)) return null;
  s = s.replaceAll(",", "");
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(s)) return null;
  const n = Number(s) * (negative ? -1 : 1) / (percent ? 100 : 1);
  return Number.isFinite(n) ? n : null;
}

export function dateValue(v: Cell | undefined): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim().replace(/年|\//g, "-").replace(/月/g, "-").replace(/日/g, "");
  const m = /^(\d{4})(?:-(\d{1,2})(?:-(\d{1,2}))?)?(?:[T ]\d{2}:.*)?$/.exec(s);
  if (!m || +m[1] < 1900 || +m[1] > 2200) return null;
  const y = +m[1], month = +(m[2] || 1), day = +(m[3] || 1), d = new Date(Date.UTC(y, month - 1, day));
  return d.getUTCFullYear() === y && d.getUTCMonth() === month - 1 && d.getUTCDate() === day ? d.toISOString().slice(0, 10) : null;
}

function textBuffer(bytes: Buffer): string {
  if (bytes[0] === 255 && bytes[1] === 254) return new TextDecoder("utf-16le").decode(bytes);
  if (bytes[0] === 254 && bytes[1] === 255) return new TextDecoder("utf-16be").decode(bytes);
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { return new TextDecoder("gb18030").decode(bytes); }
}

// Bound ZIP expansion before the spreadsheet parser allocates decompressed XML.
function checkArchive(bytes: Buffer) {
  if (bytes.readUInt16LE(0) !== 0x4b50) return;
  let end = -1;
  for (let p = bytes.length - 22; p >= Math.max(0, bytes.length - 65557); p--) if (bytes.readUInt32LE(p) === 0x06054b50) { end = p; break; }
  if (end < 0) throw new Error("表格压缩结构不完整。");
  let p = bytes.readUInt32LE(end + 16), total = 0;
  const count = bytes.readUInt16LE(end + 10);
  if (count > 4000) throw new Error("工作簿内部文件过多。");
  for (let n = 0; n < count; n++) {
    if (p + 46 > bytes.length || bytes.readUInt32LE(p) !== 0x02014b50) throw new Error("工作簿压缩目录无效。");
    const size = bytes.readUInt32LE(p + 24); total += size;
    if (size > 64 * 1024 * 1024 || total > 128 * 1024 * 1024) throw new Error("工作簿解压后过大，请拆分后导入。");
    p += 46 + bytes.readUInt16LE(p + 28) + bytes.readUInt16LE(p + 30) + bytes.readUInt16LE(p + 32);
  }
}

export function parseData(bytes: Buffer, name: string, options: { sheet?: string; headerRow?: number } = {}): DataTable {
  if (!bytes.length || bytes.length > MAX_DATA_BYTES) throw new Error("请选择非空且不超过 10 MB 的数据文件。");
  const ext = path.extname(name).toLowerCase();
  if (![".xlsx", ".xls", ".xlsm", ".ods", ".csv", ".tsv", ".json", ".txt"].includes(ext)) throw new Error("支持 Excel（xlsx/xls/xlsm）、ODS、CSV、TSV 或 JSON 数据。");
  let matrix: unknown[][], sheet = "数据", sheets = [sheet]; const warnings: string[] = [];
  if (ext === ".json") {
    const value: unknown = JSON.parse(textBuffer(bytes).replace(/^\uFEFF/, ""));
    if (!Array.isArray(value) || !value.length) throw new Error("JSON 需要非空对象数组或二维数组。");
    if (value.every(Array.isArray)) matrix = value;
    else if (value.every((r) => r && typeof r === "object" && !Array.isArray(r))) {
      const keys = [...new Set(value.flatMap((r) => Object.keys(r)))];
      matrix = [keys, ...value.map((r) => keys.map((k) => (r as Record<string, unknown>)[k] ?? null))];
    } else throw new Error("JSON 需要统一的对象数组或二维数组。");
  } else {
    if (bytes.length > 2) checkArchive(bytes);
    const isText = [".csv", ".tsv", ".txt"].includes(ext);
    const book = XLSX.read(isText ? textBuffer(bytes) : Buffer.from(bytes), { type: isText ? "string" : "buffer", cellDates: true, raw: true, sheetRows: MAX_ROWS + 2, cellFormula: true, ...(ext === ".tsv" ? { FS: "\t" } : {}) });
    sheets = book.SheetNames;
    sheet = options.sheet || sheets[0];
    if (!sheet || !sheets.includes(sheet)) throw new Error("找不到选择的工作表。");
    const ws = book.Sheets[sheet];
    const range = XLSX.utils.decode_range(ws["!fullref"] || ws["!ref"] || "A1");
    if (range.e.r > MAX_ROWS || range.e.c >= MAX_COLUMNS || (range.e.r + 1) * (range.e.c + 1) > MAX_CELLS) throw new Error("每张表最多 50,000 行、200 列、1,000,000 个单元格，请拆分数据。");
    matrix = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, blankrows: true, raw: true, range: 0 });
    let uncached = 0;
    for (const [key, cell] of Object.entries(ws)) if (!key.startsWith("!") && cell && typeof cell === "object" && cell.f && cell.v === undefined) uncached++;
    if (uncached) warnings.push(`${uncached} 个公式没有缓存结果，按空值处理；请用 Excel 重算并保存后重新导入。`);
    if (sheets.length > 1) warnings.push("当前仅分析选择的工作表，可通过工作表菜单切换。");
    if (ws["!rows"]?.some((r) => r?.hidden)) warnings.push("导入保留了工作表隐藏行，图表默认包含这些记录。");
  }
  if (!matrix.length) throw new Error("这张工作表没有数据。");
  const occupied = (r: unknown[]) => r.filter((v) => v !== null && v !== undefined && String(v).trim());
  const firstRows = matrix.slice(0, 20), density = Math.max(1, ...firstRows.map((r) => occupied(r).length));
  let automaticHeader = firstRows.findIndex((r) => { const cells = occupied(r); return cells.length >= density * 0.6 && cells.filter((v) => typeof v === "string").length >= cells.length * 0.8; });
  if (automaticHeader < 0) automaticHeader = matrix.findIndex((r) => occupied(r).length);
  const header = options.headerRow === undefined ? automaticHeader : options.headerRow - 1;
  if (!Number.isInteger(header) || header < 0 || header >= matrix.length) throw new Error("表头行超出工作表范围。");
  const width = Math.max(...matrix.map((r) => r.length));
  if (width > MAX_COLUMNS || matrix.length > MAX_ROWS + 1 || matrix.length * width > MAX_CELLS) throw new Error("数据超过 50,000 行、200 列或 1,000,000 个单元格限制。");
  const seen = new Map<string, number>();
  const columns: Column[] = Array.from({ length: width }, (_, i) => {
    const base = String(matrix[header][i] ?? "").trim() || `列 ${i + 1}`, n = (seen.get(base) || 0) + 1; seen.set(base, n);
    return { id: `c${i}`, name: base + (n > 1 ? ` (${n})` : ""), kind: "text", missing: 0, numeric: 0, distinct: 0 };
  });
  const sourceRows: number[] = [], rows: Cell[][] = [];
  for (let r = header + 1; r < matrix.length; r++) {
    const values = Array.from({ length: width }, (_, c): Cell => {
      const v = matrix[r][c];
      if (v instanceof Date) return Number.isFinite(v.getTime()) ? v.toISOString().slice(0, 10) : null;
      if (v === null || v === undefined || (typeof v === "number" && !Number.isFinite(v))) return null;
      return typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? v : JSON.stringify(v);
    });
    if (values.every(empty)) continue;
    rows.push(values); sourceRows.push(r + 1);
  }
  if (!rows.length) throw new Error("表头后没有可分析的数据行，请检查表头行。");
  for (let c = 0; c < width; c++) {
    const column = columns[c], values = rows.map((r) => r[c]).filter((v) => !empty(v));
    column.missing = rows.length - values.length;
    column.numeric = values.filter((v) => numberValue(v) !== null).length;
    column.distinct = new Set(values.map(String)).size;
    const dates = values.filter((v) => dateValue(v) !== null).length;
    if (values.length && dates / values.length >= 0.8 && (/日期|时间|年份|年度|date|time|year/i.test(column.name) || values.some((v) => typeof v === "string" && /^\d{4}[-/年]/.test(v)))) column.kind = "date";
    else if (values.length && column.numeric / values.length >= 0.8) column.kind = "number";
  }
  return { name, sheet, sheets, headerRow: header + 1, columns, rows, sourceRows, warnings };
}

export function defaultConfig(table: DataTable): ChartConfig {
  const find = (re: RegExp, kind?: string) => table.columns.find((c) => re.test(c.name) && (!kind || c.kind === kind))?.id || "";
  const dimensions = table.columns.filter((c) => c.kind === "text");
  return { dimension: find(/地区|区域|分类|类别|类型|部门|region|category|type|department/i) || dimensions[0]?.id || "", status: find(/状态|阶段|status|stage/i), metric: find(/金额|投资|收入|营收|支出|销售|回款|amount|investment|revenue|sales|value/i, "number") || table.columns.find((c) => c.kind === "number" && !/编号|序号|经度|纬度|longitude|latitude|^id$/i.test(c.name))?.id || "", time: table.columns.find((c) => c.kind === "date")?.id || "", latitude: find(/纬度|latitude|^lat$/i), longitude: find(/经度|longitude|^lng$|^lon$/i), label: find(/名称|项目|name|project/i) || dimensions[0]?.id || "", aggregation: "sum", interval: "month" };
}

export function validateConfig(table: DataTable, input: unknown): ChartConfig {
  if (!input || typeof input !== "object" || Array.isArray(input)) return defaultConfig(table);
  const cfg = { ...defaultConfig(table), ...input } as ChartConfig;
  for (const key of ["dimension", "status", "metric", "time", "latitude", "longitude", "label"] as const) {
    if (typeof cfg[key] !== "string" || (cfg[key] && !table.columns.some((c) => c.id === cfg[key]))) throw new Error(`无效的字段映射：${key}`);
  }
  if (!["sum", "avg", "count", "min", "max"].includes(cfg.aggregation) || !["day", "month", "year"].includes(cfg.interval)) throw new Error("无效的统计方式或时间粒度。");
  return cfg;
}

function summarize(values: number[]) {
  if (!values.length) return { count: 0, sum: null, mean: null, min: null, max: null, median: null };
  const sorted = [...values].sort((a, b) => a - b), sum = values.reduce((a, b) => a + b, 0), mid = Math.floor(sorted.length / 2);
  return { count: values.length, sum, mean: sum / values.length, min: sorted[0], max: sorted.at(-1)!, median: sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2 };
}

export function analyzeData(table: DataTable, configInput?: unknown, filters: DataFilters = {}, page = 0) {
  const config = validateConfig(table, configInput), columnIndex = (id: string) => table.columns.findIndex((c) => c.id === id);
  const di = columnIndex(config.dimension), si = columnIndex(config.status), mi = columnIndex(config.metric), ti = columnIndex(config.time), li = columnIndex(config.label), lat = columnIndex(config.latitude), lon = columnIndex(config.longitude);
  if (!Number.isInteger(page) || page < 0 || page > Math.ceil(table.rows.length / 50)) throw new Error("无效的数据页码。");
  if (!filters || typeof filters !== "object" || Array.isArray(filters)) throw new Error("无效的筛选条件。");
  for (const [key, value] of Object.entries(filters)) {
    if (!["query", "dimension", "status", "from", "to", "excludeTotals"].includes(key) || (key === "excludeTotals" ? typeof value !== "boolean" : typeof value !== "string") || (typeof value === "string" && value.length > (key === "query" ? 200 : 1000))) throw new Error("无效的筛选条件。");
  }
  for (const key of ["from", "to"] as const) if (filters[key] && (!/^\d{4}-\d{2}-\d{2}$/.test(filters[key]!) || dateValue(filters[key]) !== filters[key])) throw new Error("日期筛选格式无效。");
  if (filters.from && filters.to && filters.from > filters.to) throw new Error("开始日期不能晚于结束日期。");
  if ((filters.from || filters.to) && ti < 0) throw new Error("请先选择日期字段，再使用日期筛选。");
  const category = (r: Cell[], i: number) => i < 0 ? "全部" : empty(r[i]) ? "（空值）" : String(r[i]);
  const isTotal = (r: Cell[]) => r.slice(0, 3).some((v) => typeof v === "string" && /^(?:合计|总计|小计|总额|total|subtotal)$/i.test(v.trim()));
  const query = (filters.query || "").toLocaleLowerCase();
  const indexed = table.rows.map((r, i) => ({ r, row: table.sourceRows[i] }));
  const filtered = indexed.filter(({ r }) => {
    if (query && !r.some((v) => String(v ?? "").toLocaleLowerCase().includes(query))) return false;
    if (filters.dimension && category(r, di) !== filters.dimension) return false;
    if (filters.status && category(r, si) !== filters.status) return false;
    if (filters.excludeTotals && isTotal(r)) return false;
    const date = ti < 0 ? null : dateValue(r[ti]);
    return !(filters.from && (!date || date < filters.from)) && !(filters.to && (!date || date > filters.to));
  });
  const stats = table.columns.filter((c) => c.kind === "number" || (c.id === config.metric && c.numeric > 0)).map((c) => {
    const i = columnIndex(c.id), values = filtered.map(({ r }) => numberValue(r[i])).filter((v): v is number => v !== null);
    return { ...c, ...summarize(values), missing: filtered.filter(({ r }) => empty(r[i])).length, invalid: filtered.filter(({ r }) => !empty(r[i]) && numberValue(r[i]) === null).length };
  });
  const aggregate = (items: { r: Cell[] }[]) => {
    if (config.aggregation === "count" || mi < 0) return items.length;
    const values = items.map(({ r }) => numberValue(r[mi])).filter((v): v is number => v !== null), s = summarize(values);
    return config.aggregation === "avg" ? s.mean : config.aggregation === "min" ? s.min : config.aggregation === "max" ? s.max : s.sum;
  };
  const groups = (i: number, key: (r: Cell[]) => string = (r) => category(r, i)) => {
    const map = new Map<string, typeof filtered>();
    for (const item of filtered) { const k = key(item.r); if (!map.has(k)) map.set(k, []); map.get(k)!.push(item); }
    return [...map].map(([name, items]) => ({ name, value: aggregate(items), count: items.length }));
  };
  const distributionAll = groups(di).sort((a, b) => (b.value ?? -Infinity) - (a.value ?? -Infinity));
  const statusAll = groups(si).sort((a, b) => b.count - a.count);
  const trendAll = ti < 0 ? [] : groups(ti, (r) => { const d = dateValue(r[ti]); return d ? d.slice(0, config.interval === "year" ? 4 : config.interval === "month" ? 7 : 10) : "（日期无效）"; });
  const invalidDates = trendAll.find((d) => d.name === "（日期无效）")?.count || 0;
  const trend = trendAll.filter((d) => d.name !== "（日期无效）").sort((a, b) => a.name.localeCompare(b.name));
  const distribution = distributionAll.slice(0, 30);
  const statuses: { name: string; value: number | null; count: number; other?: boolean }[] = statusAll.length <= 20 ? statusAll : [...statusAll.slice(0, 19), { name: `其余 ${statusAll.length - 19} 组`, value: null, count: statusAll.slice(19).reduce((n, s) => n + s.count, 0), other: true }];
  const mainStatuses = new Set(statusAll.slice(0, 19).map((s) => s.name));
  const stacked = distribution.slice(0, 12).map((group) => ({ name: group.name, values: statuses.map((status) => aggregate(filtered.filter(({ r }) => category(r, di) === group.name && (status.other ? !mainStatuses.has(category(r, si)) : category(r, si) === status.name)))) }));
  const rank = filtered.filter(({ r }) => mi >= 0 && numberValue(r[mi]) !== null).sort((a, b) => numberValue(b.r[mi])! - numberValue(a.r[mi])!).slice(0, 10).map(({ r, row }) => ({ name: li >= 0 ? category(r, li) : `第 ${row} 行`, value: numberValue(r[mi])!, dimension: category(r, di), status: category(r, si), row }));
  const points = lat < 0 || lon < 0 ? [] : filtered.flatMap(({ r, row }) => { const y = numberValue(r[lat]), x = numberValue(r[lon]); return x !== null && y !== null && Math.abs(x) <= 180 && Math.abs(y) <= 90 ? [{ name: li >= 0 ? category(r, li) : `第 ${row} 行`, value: [x, y, mi >= 0 ? numberValue(r[mi]) : null], dimension: category(r, di), status: category(r, si), row }] : []; });
  const missing = filtered.reduce((n, { r }) => n + r.filter(empty).length, 0), totalCells = filtered.length * table.columns.length;
  const duplicates = filtered.length - new Set(filtered.map(({ r }) => JSON.stringify(r))).size;
  const totals = table.rows.filter(isTotal).length;
  const notes = [...table.warnings];
  if (totals) notes.push(`发现 ${totals} 行疑似合计/小计。当前${filters.excludeTotals ? "已排除" : "包含"}这些行，可用“排除汇总行”调整口径。`);
  if (invalidDates) notes.push(`${invalidDates} 行日期为空或无效，未进入趋势图。`);
  if (distributionAll.length > distribution.length) notes.push(`分布图仅展示前 ${distribution.length} 组，统计和导出仍包含全部 ${distributionAll.length} 组。`);
  if (statusAll.length > 20) notes.push("状态图将第 20 组起合并为其余分组，记录数和占比包含全部记录。");
  if (points.length > 2000) notes.push("坐标图展示前 2,000 个点，统计包含全部记录。");
  if (lat >= 0 && lon >= 0 && filtered.length > points.length) notes.push(`${filtered.length - points.length} 行经纬度为空或超出范围，未在地图显示。`);
  const primary = stats.find((s) => s.id === config.metric);
  if (primary?.invalid) notes.push(`${primary.invalid} 行指标无法转成数字，未参与数值计算，未按零填充。`);
  const insights = [`当前筛选得到 ${filtered.length.toLocaleString("zh-CN")} / ${table.rows.length.toLocaleString("zh-CN")} 行数据，${table.columns.length} 个字段。`];
  if (primary?.count) insights.push(`${primary.name}：合计 ${primary.sum!.toLocaleString("zh-CN", { maximumFractionDigits: 4 })}，均值 ${primary.mean!.toLocaleString("zh-CN", { maximumFractionDigits: 4 })}，中位数 ${primary.median!.toLocaleString("zh-CN", { maximumFractionDigits: 4 })}。`);
  if (distribution[0]) insights.push(`${table.columns[di]?.name || "分组"}中“${distribution[0].name}”的当前统计值最高，包含 ${distribution[0].count} 行。`);
  if (duplicates) insights.push(`存在 ${duplicates} 行完全重复记录，当前保留，建议核对来源。`);
  if (missing) insights.push(`筛选结果有 ${missing} 个空单元格，完整率 ${(100 * (1 - missing / totalCells)).toFixed(1)}%。`);
  return { config, filters, totalRows: table.rows.length, filteredRows: filtered.length, matchingRows: filtered.map((r) => r.row), columns: table.columns, stats, primary: primary || null, distribution, allDistribution: distributionAll, statuses, trend, stacked, rank, points: points.slice(0, 2000), quality: { missing, totalCells, duplicates, totals, invalidDates, completeness: totalCells ? 1 - missing / totalCells : null }, options: { dimensions: [...new Set(table.rows.map((r) => category(r, di)))].sort().slice(0, 500), statuses: [...new Set(table.rows.map((r) => category(r, si)))].sort().slice(0, 500) }, insights, notes, page, preview: filtered.slice(page * 50, (page + 1) * 50).map(({ r, row }) => ({ row, cells: r })) };
}

export function exportDataCsv(table: DataTable, analysis: ReturnType<typeof analyzeData>): string {
  // Formula injection protection for exported user text; source remains unchanged.
  const quote = (value: Cell) => { let s = String(value ?? ""); if (typeof value === "string" && /^[=+\-@\t\r]/.test(s)) s = "'" + s; return `"${s.replaceAll('"', '""')}"`; };
  const wanted = new Set(analysis.matchingRows);
  return "\uFEFF" + [table.columns.map((c) => quote(c.name)).join(","), ...table.rows.flatMap((r, i) => wanted.has(table.sourceRows[i]) ? [r.map(quote).join(",")] : [])].join("\r\n");
}
