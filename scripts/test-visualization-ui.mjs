import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseData, analyzeData, defaultConfig, exportDataCsv } from "../src/services/data/analysis.ts";
import { createVisualizationUI } from "../web/visualization.js";
import { chartOptions, standaloneReport } from "../web/visualization-model.js";

const root = path.resolve(import.meta.dirname, ".."), { Window } = await import(process.argv[2] ? pathToFileURL(path.resolve(process.argv[2])).href : "happy-dom");
const w = new Window({ url: "http://offline-ui.test/", settings: { disableJavaScriptFileLoading: true, enableJavaScriptEvaluation: false, enableCSSFileLoading: false, enableImageFileLoading: false } });
w.document.write('<div id="visualization-root"></div>');
for (const k of ["window", "document", "Event", "File", "HTMLElement"]) globalThis[k] = k === "window" ? w : w[k];
const datasets = new Map(), calls = [], instances = [], toasts = []; let workspace = "C:\\另一个 工作文件夹", upload, deferred;
const source = "项目,区域,状态,日期,投资\n甲,华东,规划,2026-01-01,100\n乙,华南,建设中,2026-02-01,200\n\"</script><img src=x>\",华东,完成,2026-02-05,300";
async function api(route, options = {}) {
  const input = options.body ? JSON.parse(options.body) : {}; calls.push({ route, input });
  if (route.startsWith("/api/visualization?")) return { datasets: [...datasets.values()].filter((d) => d.workspace === workspace).map((d) => ({ ...d, rows: d.table.rows.length })) };
  if (input.workspace !== workspace) throw new Error("Stale workspace");
  if (route === "/api/files/upload") { upload = input; return { path: ".ccagent/attachments/upload/项目.csv" }; }
  const action = route.split("/").at(-1);
  if (action === "import") { const table = parseData(Buffer.from(input.text || Buffer.from(upload.base64, "base64").toString()), "项目.csv"); const d = { id: String(datasets.size + 1), name: table.name, workspace, table, columns: table.columns, config: defaultConfig(table), sheet: table.sheet, sheets: table.sheets, headerRow: table.headerRow, sourcePath: ".ccagent/attachments/upload/项目.csv", rows: table.rows.length }; datasets.set(d.id, d); return { dataset: d }; }
  const d = datasets.get(input.id); assert(d && d.workspace === workspace);
  if (action === "open") return { dataset: d };
  if (action === "save") { d.config = input.config; return { dataset: d }; }
  if (action === "export") return { csv: exportDataCsv(d.table, analyzeData(d.table, input.config, input.filters)), name: "result.csv" };
  if (action === "query") { if (deferred) { const wait = deferred; deferred = undefined; await wait.promise; } return { dataset: d, analysis: analyzeData(d.table, input.config, input.filters, input.page) }; }
  throw new Error("Unexpected route " + route);
}
const engine = { init(host) { const obj = { host, disposed: false, handlers: {}, dispose() { this.disposed = true; }, resize() {}, setOption(option) { this.option = option; }, on(event, fn) { this.handlers[event] = fn; } }; instances.push(obj); return obj; } };
let analyzed;
const ui = createVisualizationUI({ api, toast: (s) => toasts.push(s), getWorkspace: () => workspace, loadCharts: async () => engine, onAnalyze: (data) => { analyzed = data; } });
const $ = (id) => document.getElementById(id), settle = async () => { for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 0)); };
const clickText = (text) => { const b = [...document.querySelectorAll("button")].find((b) => b.textContent === text); assert(b, text); b.click(); return settle(); };
const change = async (id, value) => { $(id).value = value; $(id).dispatchEvent(new Event("change", { bubbles: true })); await settle(); };
try {
  await ui.open(); assert($("viz-dropzone")); assert(!document.querySelector(".viz-kpi"), "Empty dashboard must not invent KPI data");
  const file = new File([source], "真实 上传.csv", { type: "text/csv" }); Object.defineProperty($("viz-file"), "files", { value: [file], configurable: true }); $("viz-file").dispatchEvent(new Event("change")); await settle();
  assert.equal(Buffer.from(upload.base64, "base64").toString(), source); assert.equal(upload.workspace, workspace); assert.equal(document.querySelectorAll(".viz-kpi").length, 4); assert.equal(instances.filter((c) => !c.disposed).length, 4); assert.equal(document.querySelectorAll("#visualization-root img, #visualization-root script").length, 0);
  assert.equal(instances.filter((c) => !c.disposed).find((c) => c.host.id === "viz-chart-trend").option.series[0].data.reduce((x, y) => x + y), 600);
  await change("viz-filter-dimension", "华东"); assert.equal(document.querySelectorAll("tbody tr").length, 2); assert.equal(calls.at(-1).input.filters.dimension, "华东");
  const donut = instances.filter((c) => !c.disposed).find((c) => c.host.id === "viz-chart-status"); donut.handlers.click({ name: "规划", data: {} }); await settle(); assert.equal(document.querySelectorAll("tbody tr").length, 1);
  await clickText("重置筛选"); await change("viz-aggregation", "avg"); await clickText("保存看板"); assert.equal(datasets.get("1").config.aggregation, "avg");
  await clickText("深入分析"); assert.equal(analyzed.dataset.id, "1"); assert.equal(analyzed.analysis.filteredRows, 3);
  await change("viz-from", "2026-03-01"); assert.match($("viz-results").textContent, /没有符合筛选条件/); assert.equal(instances.filter((c) => !c.disposed).length, 0);
  await change("viz-to", "2026-01-01"); assert.match($("viz-status").textContent, /开始日期/); assert(!document.querySelector(".viz-kpi"), "A failed query must not show stale statistics as current");
  await clickText("重置筛选");
  const all = analyzeData(datasets.get("1").table); const escaped = standaloneReport({ dataset: datasets.get("1"), analysis: all, engine: "export const init=()=>{}", model: "export const chartOptions=()=>({})", styles: "" });
  assert.equal((escaped.match(/<script/g) || []).length, 1); assert(!escaped.includes("</script><img")); assert(escaped.includes("\\u003c/script\\u003e")); assert(!/src=["']https?:/.test(escaped));
  // Exercise the actual bundled SVG engine as well as UI callbacks.
  const realEngine = await import(pathToFileURL(path.join(root, "dist/charts.js")).href); const options = chartOptions(all);
  for (const [name, option] of Object.entries(options)) { const c = realEngine.init(null, null, { renderer: "svg", ssr: true, width: 750, height: 350 }); c.setOption({ ...option, aria: { enabled: false } }); const svg = c.renderToSVGString(); assert(svg.includes("<svg")); assert(svg.includes("<path"), name + " contains real rendered chart paths"); assert(!svg.includes("<img src=x>")); c.dispose(); }
  const geoData = analyzeData(parseData(Buffer.from("项目,区域,状态,日期,投资,纬度,经度\n上海,华东,规划,2026-01-01,100,31.2,121.5\n杭州,华东,建设,2026-02-01,200,30.2,120.2\n广州,华南,完成,2026-02-01,300,23.1,113.3"), "geo.csv"));
  const geo = realEngine.init(null, null, { renderer: "svg", ssr: true, width: 750, height: 550 }); geo.setOption({ ...chartOptions(geoData).distribution, aria: { enabled: false } }); const geoSVG = geo.renderToSVGString(); assert(geoSVG.includes("<path")); assert.equal(geo.getOption().series[0].coordinateSystem, "geo"); geo.dispatchAction({ type: "geoRoam", componentType: "geo", geoIndex: 0, zoom: 1.2, originX: 350, originY: 250 }); assert(geo.getOption().geo[0].zoom > 1); geo.dispose();
  const report = standaloneReport({ dataset: datasets.get("1"), analysis: all, engine: await fs.readFile(path.join(root, "dist/charts.js"), "utf8"), model: await fs.readFile(path.join(root, "web/visualization-model.js"), "utf8"), styles: await fs.readFile(path.join(root, "web/visualization.css"), "utf8") });
  const reportWindow = new Window({ settings: { disableJavaScriptFileLoading: true, enableJavaScriptEvaluation: false } }); reportWindow.document.write(report);
  Object.defineProperty(reportWindow.HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 750 }); Object.defineProperty(reportWindow.HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 350 });
  const originalBlob = globalThis.Blob, originalCreate = URL.createObjectURL; globalThis.window = reportWindow; globalThis.document = reportWindow.document; globalThis.reportCharts = [];
  try {
    globalThis.Blob = class { constructor(parts) { this.source = parts.join(""); } }; URL.createObjectURL = (blob) => "data:text/javascript;base64," + Buffer.from(blob.source).toString("base64");
    const originalScript = reportWindow.document.querySelector("script").textContent, marker = "c.setOption(options[key]);", index = originalScript.lastIndexOf(marker); assert(index >= 0);
    const script = originalScript.slice(0, index) + marker + "globalThis.reportCharts.push(c);" + originalScript.slice(index + marker.length);
    await import("data:text/javascript;base64," + Buffer.from(script).toString("base64"));
    assert.equal(reportWindow.document.querySelectorAll("#charts svg").length, 4, "Standalone report executes its embedded engine without a server or CDN"); assert.equal(reportWindow.document.querySelectorAll("#kpi .viz-kpi").length, 4); assert(reportWindow.document.querySelector("#notes").textContent.includes("600"));
    const legacy = reportWindow.document.createElement("style"); legacy.textContent = await fs.readFile(path.join(root, "web/styles.css"), "utf8"); reportWindow.document.head.append(legacy); const chartStyle = reportWindow.getComputedStyle(reportWindow.document.querySelector("#charts svg")); assert.notEqual(chartStyle.width, "19px", "Legacy icon SVG rules must not shrink chart SVGs"); assert.equal(chartStyle.stroke, "none", "Legacy icon strokes must not outline chart bars and text");
    reportCharts[1].dispatchAction({ type: "legendToggleSelect", name: "规划" }); assert.equal(reportCharts[1].getOption().legend[0].selected["规划"], false, "Exported chart legend is interactive");
  } finally { for (const chart of globalThis.reportCharts) chart.dispose(); globalThis.Blob = originalBlob; URL.createObjectURL = originalCreate; globalThis.window = w; globalThis.document = w.document; delete globalThis.reportCharts; reportWindow.happyDOM.abort(); }
  let release; const promise = new Promise((r) => { release = r; }); deferred = { promise }; const pending = ui.open(); await settle(); workspace = "C:\\切换后的 文件夹"; ui.workspaceChanged(workspace); release(); await pending; assert.equal($("visualization-root").textContent, "", "Late responses from the previous folder must not redraw its data"); await ui.open(); assert($("viz-dropzone"));
  console.log("Visualization UI: real upload bytes, empty state, mappings, filters and chart drill-down, saved config, analysis handoff, zero/error states, literal rendering, standalone report escaping, actual ECharts SVG rendering and stale-workspace cancellation passed.");
} finally { w.happyDOM.abort(); }
