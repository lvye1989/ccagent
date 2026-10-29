const $ = (id) => document.getElementById(id);
function node(tag, cls = "", text = "") { const n = document.createElement(tag); n.className = cls; n.textContent = text; return n; }
function samePath(a, b) { const normalize = (p) => /^[a-z]:|^\\\\/i.test(p || "") ? p.replace(/\//g, "\\").replace(/\\$/, "").toLowerCase() : p; return normalize(a) === normalize(b); }
function folderIcon(cls = "") {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg"); svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("class", `workspace-folder-icon ${cls}`); svg.setAttribute("aria-hidden", "true");
  const p = document.createElementNS(svg.namespaceURI, "path"); p.setAttribute("d", "M3 7V5a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Zm0 0h7l2 2h9"); svg.append(p); return svg;
}

export function createWorkspacePicker({ api, onSelect, getWorkspace }) {
  const state = { path: "", parent: null, selected: "", folders: [], loading: false, switching: false, nativePending: false, request: 0, open: false, error: false, focus: null };
  let searchTimer;

  function status(message = "", error = false) {
    $("workspace-message").textContent = message;
    $("workspace-message").classList.toggle("is-error", error);
    state.error = error;
    updateControls();
  }
  function updateControls() {
    const busy = state.loading || state.switching || state.nativePending;
    $("workspace-use").disabled = busy || !state.selected || state.error;
    $("workspace-use").textContent = state.switching ? "正在切换…" : "在此文件夹工作";
    $("workspace-up").disabled = busy || !state.parent;
    $("workspace-reload").disabled = busy;
    $("workspace-native").disabled = busy;
    $("workspace-go").disabled = busy;
    $("workspace-input").disabled = state.switching || state.nativePending;
    $("workspace-search").disabled = state.switching || state.nativePending;
    $("workspace-close").disabled = state.switching || state.nativePending;
    $("workspace-cancel").disabled = state.switching || state.nativePending;
    $("workspace-folders").setAttribute("aria-busy", String(state.loading));
    $("workspace-selection-name").textContent = state.selected.split(/[\\/]/).filter(Boolean).pop() || state.selected || "选择一个文件夹";
    $("workspace-selection-path").textContent = state.selected;
    $("workspace-selection-path").title = state.selected;
  }
  function select(folder) {
    state.selected = folder;
    for (const row of $("workspace-folders").querySelectorAll("[data-folder]")) {
      const selected = samePath(row.dataset.folder, folder); row.classList.toggle("selected", selected); row.setAttribute("aria-selected", String(selected));
    }
    updateControls();
  }
  function close() {
    if (!state.open || state.switching || state.nativePending) return;
    state.open = false; state.request++; clearTimeout(searchTimer);
    $("workspace-overlay").classList.add("hidden");
    state.focus?.focus();
  }
  async function choose(folder = state.selected) {
    if (!folder || state.loading || state.switching || state.nativePending) return;
    state.switching = true; status("正在切换工作文件夹…"); updateControls();
    try {
      await onSelect(folder);
      state.switching = false; close();
    } catch (error) { status(error.message, true); }
    finally { state.switching = false; updateControls(); }
  }
  function renderFolders(data) {
    const list = $("workspace-folders"); list.replaceChildren();
    if (!data.folders.length) {
      const empty = node("div", "workspace-folder-empty"); empty.append(folderIcon(), node("strong", "", $("workspace-search").value ? "没有匹配的文件夹" : "此文件夹没有子文件夹"), node("span", "", "可以直接使用当前文件夹，或选择其他位置。")); list.append(empty);
    }
    for (const folder of data.folders) {
      const row = node("div", "workspace-folder-row"); row.dataset.folder = folder.path; row.tabIndex = 0; row.setAttribute("role", "option"); row.setAttribute("aria-label", folder.name); row.setAttribute("aria-selected", "false");
      const copy = node("span", "workspace-folder-copy"); copy.append(node("strong", "", folder.name), node("small", "", folder.linked ? "链接文件夹" : "文件夹"));
      const enter = node("button", "workspace-enter-folder", "›"); enter.type = "button"; enter.title = `打开 ${folder.name}`; enter.setAttribute("aria-label", `打开文件夹 ${folder.name}`);
      enter.addEventListener("click", (event) => { event.stopPropagation(); void navigate(folder.path); });
      row.append(folderIcon(), copy, enter);
      row.addEventListener("click", () => select(folder.path));
      row.addEventListener("dblclick", () => void navigate(folder.path));
      row.addEventListener("keydown", (event) => {
        if (event.target !== row) return;
        if (event.key === "Enter") { event.preventDefault(); void navigate(folder.path); }
        else if (event.key === " ") { event.preventDefault(); select(folder.path); }
        else if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); const rows = [...list.querySelectorAll("[data-folder]")]; const target = rows[rows.indexOf(row) + (event.key === "ArrowDown" ? 1 : -1)]; if (target) { target.focus(); select(target.dataset.folder); } }
      });
      list.append(row);
    }
    if (data.truncated) list.append(node("p", "workspace-list-note", `共 ${data.total} 个文件夹，显示前 500 个。输入名称可继续筛选。`));
    select(state.selected);
  }
  async function navigate(folder, preserveQuery = false) {
    if (state.switching || state.nativePending) return;
    clearTimeout(searchTimer);
    const request = ++state.request;
    if (!preserveQuery) $("workspace-search").value = "";
    state.loading = true; status("正在读取文件夹…"); updateControls();
    try {
      const data = await api(`/api/workspaces/browse?path=${encodeURIComponent(folder)}&query=${encodeURIComponent($("workspace-search").value)}&hidden=${$("workspace-show-hidden").checked ? "1" : "0"}`);
      if (request !== state.request || !state.open) return;
      state.path = data.path; state.parent = data.parent; state.selected = data.path; state.folders = data.folders;
      $("workspace-input").value = data.path;
      const crumbs = $("workspace-breadcrumbs"); crumbs.replaceChildren();
      for (const item of data.breadcrumbs) {
        const b = node("button", "", item.name); b.type = "button"; b.title = item.path; b.addEventListener("click", () => void navigate(item.path)); crumbs.append(b);
      }
      renderFolders(data); status(`${data.total} 个子文件夹 · 单击选择，双击进入`);
    } catch (error) { if (request === state.request && state.open) status(error.message, true); }
    finally { if (request === state.request) { state.loading = false; updateControls(); } }
  }
  function locationButton(name, folder, current = false) {
    const b = node("button", `workspace-location${current ? " current" : ""}`); b.type = "button"; b.title = folder; b.setAttribute("aria-label", `${name}，${folder}`);
    const copy = node("span"); copy.append(node("strong", "", name), node("small", "", folder)); b.append(folderIcon(), copy); b.addEventListener("click", () => void navigate(folder)); return b;
  }
  async function open() {
    if (state.open) return;
    state.open = true; state.focus = document.activeElement; state.selected = "";
    const opening = ++state.request;
    $("workspace-overlay").classList.remove("hidden"); $("workspace-folders").replaceChildren();
    $("workspace-search").value = ""; $("workspace-show-hidden").checked = false;
    $("workspace-input").value = getWorkspace();
    status("正在读取常用位置…"); state.loading = true; updateControls();
    try {
      const data = await api("/api/workspaces");
      if (!state.open || opening !== state.request) return;
      $("workspace-current").textContent = data.current; $("workspace-current").title = data.current;
      $("workspace-locations").replaceChildren(...data.locations.map((p) => locationButton(p.name, p.path)));
      $("workspace-recent").replaceChildren(...data.recent.map((p) => locationButton(p.split(/[\\/]/).filter(Boolean).pop() || p, p, samePath(p, data.current))));
      $("workspace-native").classList.toggle("hidden", !data.nativePickerAvailable);
      await navigate(data.current);
      if (state.open) $("workspace-search").focus();
    } catch (error) { state.loading = false; status(error.message, true); }
  }
  $("workspace-native").addEventListener("click", async () => {
    if (state.loading || state.switching || state.nativePending) return;
    state.nativePending = true; status("已打开系统文件夹选择器，请在系统窗口中选择。取消不会更改工作区。"); updateControls();
    try {
      const result = await api("/api/workspaces/pick", { method: "POST", body: JSON.stringify({ initialPath: state.path }) });
      state.nativePending = false;
      if (result.path) { state.selected = result.path; await choose(result.path); }
      else status("已取消选择，当前工作文件夹未更改。");
    } catch (error) { status(error.message, true); }
    finally { state.nativePending = false; updateControls(); }
  });
  $("workspace-form").addEventListener("submit", (event) => { event.preventDefault(); void navigate($("workspace-input").value); });
  $("workspace-search").addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => void navigate(state.path, true), 180); });
  $("workspace-show-hidden").addEventListener("change", () => void navigate(state.path, true));
  $("workspace-up").addEventListener("click", () => { if (state.parent) void navigate(state.parent); });
  $("workspace-reload").addEventListener("click", () => void navigate(state.path, true));
  $("workspace-use").addEventListener("click", async () => {
    const typed = $("workspace-input").value.trim();
    if (typed && !samePath(typed, state.path)) { await navigate(typed); if (state.error) return; }
    await choose();
  });
  $("workspace-cancel").addEventListener("click", close); $("workspace-close").addEventListener("click", close);
  $("workspace-overlay").addEventListener("click", (event) => { if (event.target === $("workspace-overlay")) close(); });
  $("workspace-overlay").addEventListener("keydown", (event) => {
    if (event.key === "Escape") { event.stopPropagation(); close(); }
    if (event.key === "Tab") {
      const focusable = [...$("workspace-overlay").querySelectorAll("button,input,[tabindex='0']")].filter((n) => !n.disabled && !n.closest(".hidden"));
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  });
  return { open, close };
}
