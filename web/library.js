export function createLibraryUI({ api, toast }) {
  const $ = (id) => document.getElementById(id);
  const state = { kind: "all", files: [], selected: null, request: 0 };
  let searchTimer;

  function renderList() {
    const list = $("library-list");
    list.replaceChildren();
    if (!state.files.length) {
      const empty = document.createElement("div");
      empty.className = "library-empty";
      empty.textContent = "当前文件夹没有匹配的文档。";
      list.append(empty);
      return;
    }
    for (const file of state.files) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = `library-row${state.selected === file.path ? " selected" : ""}`;
      row.title = file.path;
      const name = document.createElement("span");
      name.textContent = file.name;
      const kind = document.createElement("span");
      kind.textContent = file.kind;
      const date = document.createElement("span");
      date.textContent = new Date(file.updatedAt).toLocaleDateString("zh-CN");
      row.append(name, kind, date);
      row.addEventListener("click", () => void preview(file));
      list.append(row);
    }
  }

  async function preview(file) {
    state.selected = file.path;
    renderList();
    const pane = $("library-preview");
    pane.replaceChildren();
    const heading = document.createElement("h2"); heading.textContent = file.name;
    const path = document.createElement("p"); path.className = "library-file-path"; path.textContent = file.path;
    const meta = document.createElement("p"); meta.textContent = `${file.kind} · ${(file.size / 1024).toFixed(1)} KB · ${new Date(file.updatedAt).toLocaleString("zh-CN")}`;
    const download = document.createElement("a");
    download.className = "library-download";
    download.href = `/api/library/download?path=${encodeURIComponent(file.path)}`;
    download.download = file.name;
    download.textContent = "下载文件";
    pane.append(heading, path, meta, download);
    if (!file.previewable) return;
    const content = document.createElement("pre");
    content.className = "library-text-preview";
    content.textContent = "正在加载预览…";
    pane.append(content);
    try {
      const result = await api(`/api/library/file?path=${encodeURIComponent(file.path)}`);
      if (state.selected === file.path) content.textContent = result.content;
    } catch (error) { content.textContent = error.message; }
  }

  async function refresh() {
    const request = ++state.request;
    const query = $("library-query").value.trim();
    try {
      const result = await api(`/api/library?kind=${encodeURIComponent(state.kind)}&query=${encodeURIComponent(query)}`);
      if (request !== state.request) return;
      state.files = result.files;
      if (!state.files.some((item) => item.path === state.selected)) {
        state.selected = null;
        $("library-preview").innerHTML = '<div class="library-preview-empty">选择文档查看详情</div>';
      }
      renderList();
    } catch (error) { toast(`资料空间读取失败：${error.message}`); }
  }

  async function openPath(path) {
    state.kind = "all";
    $("library-filters").querySelectorAll("button").forEach((item) => item.classList.toggle("selected", item.dataset.kind === "all"));
    $("library-query").value = path.split("/").pop();
    await refresh();
    const file = state.files.find((item) => item.path.toLowerCase() === path.toLowerCase());
    if (file) await preview(file);
    else toast("资料空间中未找到该文件");
  }

  $("library-query").addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => void refresh(), 250); });
  $("library-refresh").addEventListener("click", () => void refresh());
  $("library-filters").querySelectorAll("button").forEach((button) => button.addEventListener("click", () => {
    state.kind = button.dataset.kind;
    $("library-filters").querySelectorAll("button").forEach((item) => item.classList.toggle("selected", item === button));
    void refresh();
  }));
  return { open: refresh, refresh, openPath };
}
