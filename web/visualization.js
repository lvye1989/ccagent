import { chartOptions, formatNumber, standaloneReport } from "./visualization-model.js";

const $ = (id) => document.getElementById(id);
function node(tag, cls = "", text) { const n = document.createElement(tag); n.className = cls; if (text !== undefined) n.textContent = text; return n; }
function button(text, action, cls = "viz-button") { const b = node("button", cls, text); b.type = "button"; b.addEventListener("click", action); return b; }
function select(label, entries, value, change, id) {
  const wrap = node("label", "viz-field"); wrap.append(node("span", "", label)); const input = node("select"); if (id) input.id = id;
  for (const [key, title] of entries) { const option = node("option", "", title); option.value = key; input.append(option); } input.value = value || "";
  input.addEventListener("change", () => change(input.value)); wrap.append(input); return wrap;
}
function download(content, name, type) {
  const url = URL.createObjectURL(new Blob([content], { type })), a = node("a"); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function createVisualizationUI({ api, toast, getWorkspace, onAnalyze, loadCharts = () => import("/charts.js") }) {
  const root = $("visualization-root");
  const s = { workspace: "", datasets: [], dataset: null, config: {}, filters: {}, analysis: null, page: 0, generation: 0, request: 0, busy: false, charts: [], queryTimer: null };
  let engine;
  function dispose() { for (const chart of s.charts) chart.dispose(); s.charts = []; }
  const resize = () => s.charts.forEach((c) => c.resize());
  if (globalThis.ResizeObserver) new ResizeObserver(resize).observe(root);
  window.addEventListener("resize", resize);
  function valid(generation, workspace) { return generation === s.generation && workspace === getWorkspace(); }
  function status(message, error = false) { const box = $("viz-status"); if (box) { box.textContent = message; box.classList.toggle("error", error); box.setAttribute("role", error ? "alert" : "status"); } }
  async function request(action, body = {}) { return api(`/api/visualization/${action}`, { method: "POST", body: JSON.stringify({ ...body, workspace: s.workspace }) }); }
  function markBusy(busy) { s.busy = busy; root.setAttribute("aria-busy", String(busy)); root.querySelectorAll("[data-viz-import]").forEach((b) => b.disabled = busy); }
  async function action(fn) { if (s.busy) return; const g = s.generation, workspace = s.workspace; markBusy(true); status("正在处理数据…"); try { await fn(); if (valid(g, workspace) && !$("viz-status")?.classList.contains("error")) status(""); } catch (e) { if (valid(g, workspace)) status(e.message, true); } finally { if (valid(g, workspace)) markBusy(false); } }

  function toolbar() {
    const header = node("div", "viz-header"), title = node("div"); title.append(node("div", "viz-eyebrow", "DATA VISUALIZATION"), node("h1", "", "数据可视化"), node("p", "", "让数据呈现趋势，让分析成为行动。"));
    const tools = node("div", "viz-actions");
    const input = node("input", "sr-only"); input.id = "viz-file"; input.type = "file"; input.accept = ".xlsx,.xls,.xlsm,.ods,.csv,.tsv,.json,.txt";
    input.addEventListener("change", () => { if (input.files?.[0]) void importFile(input.files[0]); input.value = ""; });
    const upload = button("＋ 导入数据", () => input.click(), "viz-button primary"); upload.dataset.vizImport = "1";
    if (s.dataset && onAnalyze) tools.append(button("深入分析", () => { if (s.analysis) onAnalyze({ dataset: s.dataset, analysis: s.analysis }); }));
    tools.append(upload, button("刷新", () => void open())); header.append(title, tools, input); root.append(header);
    const source = node("div", "viz-source");
    source.append(select("数据集", [["", "导入其他数据…"], ...s.datasets.map((d) => [d.id, `${d.name} · ${d.sheet} (${d.rows} 行)`])], s.dataset?.id, (id) => { if (id) void action(() => choose(id)); else { s.request++; Object.assign(s, { dataset: null, analysis: null, config: {}, filters: {} }); frame(); } }, "viz-dataset"));
    if (s.dataset) {
      source.append(select("工作表", s.dataset.sheets.map((name) => [name, name]), s.dataset.sheet, (sheet) => void action(() => importPath(s.dataset.sourcePath, { sheet, headerRow: undefined })), "viz-sheet"));
      const headerLabel = node("label", "viz-field"); headerLabel.append(node("span", "", "表头行")); const n = node("input"); n.type = "number"; n.min = "1"; n.max = "50000"; n.value = String(s.dataset.headerRow); n.id = "viz-header-row"; headerLabel.append(n); source.append(headerLabel, button("重新读取", () => void action(() => importPath(s.dataset.sourcePath, { sheet: s.dataset.sheet, headerRow: Number(n.value) }))));
      const exports = node("div", "viz-actions viz-export"); exports.append(button("保存看板", () => void action(async () => { await request("save", { id: s.dataset.id, config: s.config, filters: s.filters }); toast("字段映射、筛选与图表设置已保存到当前工作文件夹"); })), button("导出 CSV", () => void action(async () => { const result = await request("export", { id: s.dataset.id, config: s.config, filters: s.filters }); download(result.csv, result.name, "text/csv;charset=utf-8"); })), button("导出交互报告", () => void action(exportReport))); source.append(exports);
    }
    root.append(source); const notice = node("div", "viz-status"); notice.id = "viz-status"; notice.setAttribute("aria-live", "polite"); root.append(notice);
  }
  function frame() {
    dispose(); root.replaceChildren(); toolbar();
    if (!s.dataset) { emptyState(); return; }
    const source = node("p", "viz-source-note"); source.textContent = `${s.dataset.name} / ${s.dataset.sheet} · ${formatNumber(s.dataset.rows)} 行 · ${s.dataset.columns.length} 个字段 · 导入快照 · ${s.dataset.sourcePath}`; root.append(source);
    const mapping = node("details", "viz-mapping"), summary = node("summary", "", "字段映射与统计设置"); mapping.append(summary);
    const fields = node("div", "viz-mapping-grid");
    for (const [key, label] of [["dimension", "分类维度"], ["status", "状态字段"], ["metric", "数值指标"], ["time", "日期字段"], ["label", "记录名称"], ["latitude", "纬度"], ["longitude", "经度"]]) {
      fields.append(select(label, [["", "未选择"], ...s.dataset.columns.filter((c) => key !== "metric" || c.numeric > 0).map((c) => [c.id, c.name])], s.config[key], (value) => { s.config[key] = value; if (key === "dimension" || key === "status") delete s.filters[key]; if (key === "time") { delete s.filters.from; delete s.filters.to; } filters(); void query(); }, `viz-field-${key}`));
    }
    fields.append(select("统计方式", [["sum", "合计"], ["avg", "均值"], ["count", "记录数"], ["min", "最小值"], ["max", "最大值"]], s.config.aggregation, (value) => { s.config.aggregation = value; void query(); }, "viz-aggregation"), select("时间粒度", [["month", "按月"], ["year", "按年"], ["day", "按日"]], s.config.interval, (value) => { s.config.interval = value; void query(); }, "viz-interval"));
    mapping.append(fields, node("p", "viz-muted", "数值沿用原表单位；空值不按零计算。合计、均值等口径可在此切换。")); root.append(mapping);
    const filterHost = node("div"); filterHost.id = "viz-filters"; const result = node("div"); result.id = "viz-results"; root.append(filterHost, result); filters();
  }
  function emptyState() {
    const drop = node("div", "viz-dropzone"); drop.id = "viz-dropzone"; drop.tabIndex = 0; drop.setAttribute("role", "button"); drop.setAttribute("aria-label", "上传数据文件");
    drop.append(node("div", "viz-upload-mark", "↥"), node("h2", "", "把数据拖到这里，开始探索"), node("p", "", "支持 Excel、CSV、TSV、JSON · 单文件 10 MB 以内"), node("span", "viz-drop-cta", "或点击选择文件"));
    drop.addEventListener("click", () => $("viz-file").click()); drop.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $("viz-file").click(); } });
    drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("dragging"); }); drop.addEventListener("dragleave", () => drop.classList.remove("dragging")); drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("dragging"); if (e.dataTransfer.files[0]) void importFile(e.dataTransfer.files[0]); }); root.append(drop);
    const paste = node("details", "viz-paste"); paste.append(node("summary", "", "也可以粘贴表格数据")); const text = node("textarea"); text.id = "viz-paste-data"; text.rows = 6; text.placeholder = '项目,区域,状态,日期,投资（万元）\n项目 A,华东,建设中,2026-01-01,1200'; const b = button("生成可视化", () => void action(async () => { const result = await request("import", { text: text.value }); await imported(result.dataset); }), "viz-button primary"); b.dataset.vizImport = "1"; paste.append(text, b); root.append(paste);
    const existing = node("details", "viz-paste"); existing.append(node("summary", "", "读取工作文件夹中的数据")); const pathInput = node("input"); pathInput.id = "viz-existing-path"; pathInput.placeholder = "例如：资料/项目统计.xlsx"; existing.append(pathInput, button("读取并分析", () => void action(() => importPath(pathInput.value)))); root.append(existing);
    const features = node("div", "viz-feature-cards"); for (const [label, description] of [["01 · 指标总览", "从真实数据计算合计、均值与数据完整率"], ["02 · 联动探索", "分类、日期筛选与图表点击联动"], ["03 · 分析与导出", "追溯源数据行，保存看板和交互报告"]]) { const card = node("article"); card.append(node("strong", "", label), node("p", "", description)); features.append(card); } root.append(features);
  }
  function filters() {
    const host = $("viz-filters"); if (!host) return; const focused = document.activeElement?.id === "viz-search", caret = focused ? document.activeElement.selectionStart : null; host.replaceChildren(); const bar = node("div", "viz-filter-bar");
    const search = node("input"); search.type = "search"; search.id = "viz-search"; search.placeholder = "搜索项目、地区或任意数据…"; search.value = s.filters.query || ""; search.setAttribute("aria-label", "搜索数据"); search.addEventListener("input", () => { s.filters.query = search.value; clearTimeout(s.queryTimer); s.queryTimer = setTimeout(() => void query(), 250); }); bar.append(search);
    const options = s.analysis?.options;
    for (const [key, label, choices] of [["dimension", "全部分类", options?.dimensions || []], ["status", "全部状态", options?.statuses || []]]) if (s.config[key]) bar.append(select(label, [["", label], ...choices.map((v) => [v, v])], s.filters[key], (v) => { s.filters[key] = v; void query(); }, `viz-filter-${key}`));
    if (s.config.time) for (const [key, label] of [["from", "开始日期"], ["to", "结束日期"]]) { const wrap = node("label", "viz-field"); wrap.append(node("span", "", label)); const input = node("input"); input.type = "date"; input.id = "viz-" + key; input.value = s.filters[key] || ""; input.addEventListener("change", () => { s.filters[key] = input.value; void query(); }); wrap.append(input); bar.append(wrap); }
    const totalLabel = node("label", "viz-checkbox"), check = node("input"); check.type = "checkbox"; check.id = "viz-exclude-totals"; check.checked = Boolean(s.filters.excludeTotals); check.addEventListener("change", () => { s.filters.excludeTotals = check.checked; void query(); }); totalLabel.append(check, document.createTextNode("排除汇总行")); bar.append(totalLabel, button("重置筛选", () => { s.filters = {}; filters(); void query(); })); host.append(bar);
    const active = Object.entries(s.filters).filter(([_, value]) => value && value !== false); if (active.length) { const chips = node("div", "viz-filter-chips"); for (const [key, value] of active) chips.append(button(`${{ query: "搜索", dimension: "分类", status: "状态", from: "开始", to: "结束", excludeTotals: "排除汇总行" }[key]}${value === true ? "" : "：" + value} ×`, () => { delete s.filters[key]; filters(); void query(); }, "viz-chip")); host.append(chips); }
    if (focused) { search.focus(); search.setSelectionRange(caret, caret); }
  }
  async function choose(id) { const g = s.generation, workspace = s.workspace, result = await request("open", { id }); if (valid(g, workspace)) await imported(result.dataset); }
  async function imported(dataset) {
    const g = s.generation, workspace = s.workspace, listed = await api(`/api/visualization?workspace=${encodeURIComponent(workspace)}`); if (!valid(g, workspace)) return;
    s.dataset = dataset; s.config = { ...dataset.config }; s.filters = { ...dataset.filters }; s.analysis = null; s.page = 0;
    s.datasets = listed.datasets;
    frame(); await query();
  }
  async function importPath(path, options = {}) { const g = s.generation, workspace = s.workspace, result = await request("import", { path, ...options }); if (valid(g, workspace)) await imported(result.dataset); }
  async function importFile(file) {
    if (file.size > 10 * 1024 * 1024 || !file.size) { status("请选择非空且不超过 10 MB 的数据文件。", true); return; }
    if (!/\.(xlsx|xls|xlsm|ods|csv|tsv|json|txt)$/i.test(file.name)) { status("请选择 Excel、CSV、TSV 或 JSON 数据。", true); return; }
    await action(async () => {
      const g = s.generation, workspace = s.workspace, bytes = new Uint8Array(await file.arrayBuffer()); let binary = "";
      for (let start = 0; start < bytes.length; start += 32768) binary += String.fromCharCode(...bytes.subarray(start, start + 32768));
      if (!valid(g, workspace)) return;
      const attachment = await api("/api/files/upload", { method: "POST", body: JSON.stringify({ workspace, name: file.name, base64: btoa(binary) }) });
      if (valid(g, workspace)) await importPath(attachment.path);
    });
  }
  async function query(page = 0) {
    if (!s.dataset) return; const g = s.generation, workspace = s.workspace, token = ++s.request; s.page = page; status("正在更新图表…");
    try {
      const result = await request("query", { id: s.dataset.id, config: s.config, filters: s.filters, page });
      if (!valid(g, workspace) || token !== s.request) return;
      s.analysis = result.analysis; filters(); await renderResult(g, token); if (valid(g, workspace) && token === s.request) status("");
    } catch (e) { if (valid(g, workspace) && token === s.request) { dispose(); $("viz-results")?.replaceChildren(node("div", "viz-empty-result", "当前筛选未能生成图表，请检查上方错误并调整设置。")); status(e.message, true); } }
  }
  function card(title, cls = "") { const c = node("article", `viz-card ${cls}`); c.append(node("h2", "", title)); return c; }
  function filterChart(key, value) { s.filters[key] = s.filters[key] === value ? "" : value; filters(); void query(); }
  async function renderResult(generation, token) {
    const a = s.analysis, host = $("viz-results"); if (!a || !host) return; dispose(); host.replaceChildren();
    const kpis = node("div", "viz-kpis"), metric = a.primary;
    for (const [i, [label, value, hint]] of [["数据记录", a.filteredRows, `共 ${formatNumber(a.totalRows)} 行`], [metric ? `${metric.name} · 合计` : "数值合计", metric?.sum, metric ? `${metric.count} 个有效数值` : "请在字段映射中选择数值指标"], [metric ? `${metric.name} · 均值` : "数值均值", metric?.mean, metric ? `中位数 ${formatNumber(metric.median)}` : "支持自定义统计方式"], ["数据完整率", a.quality.completeness === null ? null : a.quality.completeness * 100, `${a.quality.missing} 个空值 · ${a.quality.duplicates} 行重复`]].entries()) {
      const box = node("article", `viz-kpi tone-${i}`); box.append(node("span", "viz-kpi-icon", ["▥", "◉", "▤", "◌"][i]), node("span", "viz-kpi-label", label), node("strong", "", formatNumber(value) + (i === 3 && value !== null ? "%" : "")), node("small", "", hint)); kpis.append(box);
    }
    host.append(kpis);
    if (!a.filteredRows) { host.append(node("div", "viz-empty-result", "没有符合筛选条件的数据。请调整筛选或点击重置。")); table(a, host); return; }
    const grid = node("div", "viz-chart-grid"); host.append(grid); const specs = [
      ["distribution", a.points.length ? "地理坐标分布" : "分类分布", "viz-distribution"], ["status", s.config.status ? "状态占比" : "记录总量", "viz-status-card"], ["trend", "时间趋势", "viz-trend"], ["stacked", "分类与状态对比", "viz-stacked"],
    ]; const hosts = {};
    for (const [key, title, cls] of specs) {
      const c = card(title, cls), caption = key === "distribution" ? a.points.length ? "拖动平移 / 滚轮缩放 · 离线陆地轮廓：Natural Earth" : "点击分类联动筛选 · 拖动滑块查看更多" : key === "status" ? "按记录数统计 · 点击扇区筛选" : key === "trend" ? "双轴分别展示指标与记录数 · 点击时间段筛选" : "点击分组与图例探索";
      c.append(node("p", "viz-chart-caption", caption)); const canvas = node("div", "viz-chart"); canvas.id = `viz-chart-${key}`; canvas.setAttribute("role", "img"); canvas.setAttribute("aria-label", title); c.append(canvas); grid.append(c); hosts[key] = canvas;
      if (key === "trend" && !s.config.time) canvas.append(node("div", "viz-chart-empty", "请在“字段映射”中选择日期或年份字段"));
      if (key === "stacked" && !s.config.status) canvas.append(node("div", "viz-chart-empty", "选择状态字段后，可查看分类与状态交叉分析"));
    }
    const quality = card("关键指标与数据质量", "viz-quality");
    for (const column of a.columns.slice(0, 8)) {
      const statistic = a.stats.find((x) => x.id === column.id); const row = node("div", "viz-indicator"); const name = node("span", "", column.name); name.title = column.name;
      const ratio = 1 - column.missing / a.totalRows, bar = node("div", "viz-progress"), fill = node("i"); fill.style.width = `${Math.max(0, ratio * 100)}%`; bar.append(fill); row.append(name, bar, node("strong", "", `${(ratio * 100).toFixed(0)}%`)); quality.append(row);
      if (statistic) quality.append(node("small", "viz-stat-detail", `当前筛选：最小 ${formatNumber(statistic.min)} · 最大 ${formatNumber(statistic.max)}`));
    }
    quality.append(node("p", "viz-chart-caption", "进度条表示整张表各字段的非空率；数值范围来自当前筛选。")); grid.append(quality);
    const ranking = card("数值排行 · TOP 10", "viz-ranking");
    if (!a.rank.length) ranking.append(node("p", "viz-muted", "选择数值指标后显示排行"));
    for (const [i, item] of a.rank.entries()) {
      const row = button("", () => filterChart("query", item.name), "viz-rank-row"), label = node("span", "viz-rank-name"); label.append(node("strong", "", item.name), node("small", "", `${item.dimension} · 源数据第 ${item.row} 行`)); row.append(node("b", "", String(i + 1)), label, node("span", "viz-rank-value", formatNumber(item.value))); ranking.append(row);
    } grid.append(ranking);
    const insight = card("数据分析", "viz-insights"); for (const text of a.insights) insight.append(node("p", "", text)); for (const text of a.notes) insight.append(node("p", "viz-note", text)); host.append(insight); table(a, host);
    engine ||= await loadCharts(); if (!valid(generation, s.workspace) || token !== s.request) return;
    const options = chartOptions(a);
    for (const [key] of specs) {
      if ((key === "trend" && !s.config.time) || (key === "stacked" && !s.config.status)) continue;
      const chart = engine.init(hosts[key], null, { renderer: "svg" }); s.charts.push(chart); chart.setOption(options[key]);
      chart.on("click", (p) => {
        if (key === "status" && s.config.status) { if (p.data?.other) toast("其余分组包含多个状态，请用状态筛选选择具体值"); else filterChart("status", p.name); }
        if (key === "distribution" && s.config.dimension) { if (!a.points.length || p.data?.dimension) filterChart("dimension", a.points.length ? p.data.dimension : p.name); }
        if (key === "stacked") { s.filters.dimension = p.name; if (!a.statuses.find((v) => v.name === p.seriesName)?.other) s.filters.status = p.seriesName; filters(); void query(); }
        if (key === "trend") { const date = String(p.name); if (!/^\d{4}(-\d{2}){0,2}$/.test(date)) return; s.filters.from = date.length === 4 ? `${date}-01-01` : date.length === 7 ? `${date}-01` : date; s.filters.to = date.length === 4 ? `${date}-12-31` : date.length === 7 ? `${date}-${new Date(Date.UTC(+date.slice(0, 4), +date.slice(5, 7), 0)).getUTCDate()}` : date; filters(); void query(); }
      });
    }
  }
  function table(a, parent) {
    const c = card("源数据", "viz-table-card"), scroll = node("div", "viz-table-scroll"), table = node("table"), head = node("thead"), tr = node("tr"); tr.append(node("th", "", "源行")); for (const column of a.columns) tr.append(node("th", "", column.name)); head.append(tr); table.append(head);
    const body = node("tbody"); for (const r of a.preview) { const line = node("tr"); line.append(node("td", "", String(r.row))); for (const value of r.cells) line.append(node("td", "", value === null ? "—" : String(value))); body.append(line); } table.append(body); scroll.append(table); c.append(scroll);
    const pages = node("div", "viz-pagination"); const previous = button("上一页", () => void query(a.page - 1)), next = button("下一页", () => void query(a.page + 1)); previous.disabled = !a.page; next.disabled = (a.page + 1) * 50 >= a.filteredRows; pages.append(node("span", "", `${a.filteredRows ? a.page * 50 + 1 : 0}–${Math.min((a.page + 1) * 50, a.filteredRows)} / ${formatNumber(a.filteredRows)} 行 · 每页 50 行`), previous, next); c.append(pages); parent.append(c);
  }
  async function exportReport() {
    if (!s.analysis) return; const [engineCode, model, styles] = await Promise.all(["/charts.js", "/visualization-model.js", "/visualization.css"].map(async (url) => { const r = await fetch(url); if (!r.ok) throw new Error("报告资源加载失败，请重试。"); return r.text(); }));
    const html = standaloneReport({ dataset: s.dataset, analysis: s.analysis, engine: engineCode, model, styles }); download(html, `${s.dataset.name.replace(/\.[^.]+$/, "")}-数据分析.html`, "text/html;charset=utf-8");
  }
  function workspaceChanged(workspace) { if (s.workspace === workspace) return false; s.generation++; s.request++; clearTimeout(s.queryTimer); dispose(); Object.assign(s, { workspace, datasets: [], dataset: null, analysis: null, filters: {}, config: {}, page: 0, busy: false }); root.replaceChildren(); return true; }
  async function open() {
    workspaceChanged(getWorkspace()); const g = s.generation, workspace = s.workspace; frame(); status("正在加载数据集…");
    try { const result = await api(`/api/visualization?workspace=${encodeURIComponent(workspace)}`); if (!valid(g, workspace)) return; s.datasets = result.datasets; if (s.dataset) { frame(); await query(); } else if (s.datasets[0]) await choose(s.datasets[0].id); else { frame(); status(""); } }
    catch (e) { if (valid(g, workspace)) status(e.message, true); }
  }
  return { open, workspaceChanged };
}
