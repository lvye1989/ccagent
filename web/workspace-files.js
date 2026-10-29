export function createWorkspaceFiles({ api, toast, getWorkspace, reference }) {
  const $ = (id) => document.getElementById(id);
  const body = document.createElement("div");
  body.className = "workbench-body";
  $("content").before(body);
  body.append($("content"));
  const panel = document.createElement("aside");
  panel.id = "workspace-files";
  panel.className = "workspace-files hidden";
  panel.setAttribute("aria-label", "工作区文件");
  panel.innerHTML = `
    <div class="files-heading"><div><strong>工作区文件</strong><small id="files-workspace"></small></div><button type="button" id="files-close" aria-label="关闭文件面板">×</button></div>
    <div class="files-toolbar"><button type="button" id="files-up" aria-label="上一级文件夹">↑</button><nav id="files-breadcrumbs" aria-label="文件路径"></nav><button type="button" id="files-refresh" aria-label="刷新文件列表">↻</button></div>
    <div class="files-filters"><input id="files-query" type="search" placeholder="搜索当前文件夹" aria-label="搜索当前文件夹"><label><input id="files-hidden" type="checkbox">隐藏项</label></div>
    <div id="files-list" class="files-list" aria-label="文件列表"></div>
    <div id="files-status" class="files-status" role="status"></div>
    <section id="files-preview" class="files-preview" aria-label="文件预览"><p class="files-empty">选择文件查看内容<br>支持代码、图片、PDF、Office 和音视频</p></section>`;
  body.append(panel);
  const toggle = document.createElement("button");
  toggle.id = "workspace-files-toggle";
  toggle.type = "button";
  toggle.className = "files-toggle";
  toggle.textContent = "▤ 文件";
  toggle.setAttribute("aria-controls", panel.id);
  toggle.setAttribute("aria-expanded", "false");
  document.querySelector(".topbar-tools").prepend(toggle);
  let workspace = "", directory = "", selected = null, nextOffset = null, request = 0, previewRequest = 0, opened = false, view = "tasks", timer;
  const fileUrl = (action, file) => `/api/files/${action}?workspace=${encodeURIComponent(workspace)}&path=${encodeURIComponent(file)}`;
  const element = (tag, className, text) => { const node = document.createElement(tag); node.className = className; if (text !== undefined) node.textContent = text; return node; };
  const formatSize = (size) => size < 1024 ? `${size} B` : size < 1024 * 1024 ? `${(size / 1024).toFixed(1)} KB` : `${(size / 1024 / 1024).toFixed(1)} MB`;

  function sync() {
    const visible = opened && ["tasks", "thread"].includes(view);
    panel.classList.toggle("hidden", !visible);
    body.classList.toggle("files-open", visible);
    toggle.classList.toggle("hidden", !["tasks", "thread"].includes(view));
    toggle.setAttribute("aria-expanded", String(visible));
  }
  function crumbs() {
    $("files-breadcrumbs").replaceChildren();
    const parts = directory.split("/").filter(Boolean);
    for (const [index, label] of [workspace.split(/[\\/]/).pop() || "工作区", ...parts].entries()) {
      const button = element("button", "files-crumb", label);
      button.type = "button";
      button.title = index ? parts.slice(0, index).join("/") : workspace;
      button.addEventListener("click", () => { $("files-query").value = ""; void browse(parts.slice(0, index).join("/")); });
      $("files-breadcrumbs").append(button);
    }
    $("files-up").disabled = !directory;
  }
  async function browse(folder = directory, offset = 0) {
    if (!workspace) return;
    const id = ++request, current = workspace;
    if (!offset) {
      $("files-list").replaceChildren();
      $("files-status").textContent = "正在读取文件…";
    }
    try {
      const result = await api(`/api/files?workspace=${encodeURIComponent(current)}&path=${encodeURIComponent(folder)}&query=${encodeURIComponent($("files-query").value.trim())}&hidden=${$("files-hidden").checked ? 1 : 0}&offset=${offset}`);
      if (id !== request || current !== workspace) return;
      directory = result.path;
      nextOffset = result.nextOffset;
      crumbs();
      $("files-list").querySelector(".files-more")?.remove();
      for (const file of result.entries) {
        const row = element("button", `files-row${selected === file.path ? " selected" : ""}`);
        row.type = "button";
        row.title = file.path;
        row.dataset.path = file.path;
        const icon = element("span", `files-icon ${file.directory ? "folder" : file.format}`, file.directory ? "▱" : ({ image: "▧", pdf: "PDF", office: (file.extension || "DOC").toUpperCase(), audio: "♪", video: "▷", text: "≡" })[file.format] || "◇");
        const name = element("span", "files-name", file.name);
        const meta = element("small", "files-meta", file.directory ? "文件夹" : formatSize(file.size));
        row.append(icon, name, meta);
        row.addEventListener("click", () => { if (file.directory) { $("files-query").value = ""; void browse(file.path); } else void preview(file.path); });
        $("files-list").append(row);
      }
      if (nextOffset !== null) {
        const more = element("button", "files-more", "加载更多文件");
        more.type = "button";
        more.addEventListener("click", () => { more.disabled = true; void browse(directory, nextOffset); });
        $("files-list").append(more);
      }
      $("files-status").textContent = result.total ? `${result.total} 个项目${nextOffset !== null ? " · 可加载更多" : ""}` : "此文件夹没有匹配的文件";
    } catch (error) { if (id === request) { $("files-status").textContent = `读取失败：${error.message}`; $("files-list").querySelector(".files-more")?.removeAttribute("disabled"); } }
  }
  async function preview(filePath) {
    const id = ++previewRequest, current = workspace;
    selected = filePath;
    $("files-list").querySelectorAll(".files-row").forEach((row) => row.classList.toggle("selected", row.dataset.path === filePath));
    const pane = $("files-preview");
    pane.replaceChildren(element("p", "files-empty", "正在加载预览…"));
    try {
      const file = await api(fileUrl("preview", filePath));
      if (id !== previewRequest || current !== workspace) return;
      pane.replaceChildren();
      const heading = element("h2", "files-preview-title", file.name);
      const meta = element("p", "files-preview-meta", `${file.path} · ${formatSize(file.size)}`);
      const actions = element("div", "files-preview-actions");
      const add = element("button", "", "引用到对话"); add.type = "button";
      add.addEventListener("click", () => reference(file));
      const download = element("a", "", "下载原文件"); download.href = fileUrl("download", file.path); download.download = file.name;
      actions.append(add, download);
      pane.append(heading, meta, actions);
      if (file.note) pane.append(element("p", "files-note", file.note));
      if (file.format === "image") {
        const image = element("img", "files-image"); image.alt = file.name; image.src = fileUrl("content", file.path); pane.append(image);
      } else if (file.format === "pdf") {
        const frame = element("iframe", "files-pdf"); frame.title = file.name; frame.src = fileUrl("content", file.path); pane.append(frame);
      } else if (file.format === "audio" || file.format === "video") {
        const player = element(file.format, "files-media"); player.controls = true; player.preload = "metadata"; player.src = fileUrl("content", file.path); pane.append(player);
      } else if (file.sheets) {
        for (const sheet of file.sheets) {
          pane.append(element("h3", "files-sheet-title", sheet.name));
          const scroll = element("div", "files-table-scroll"), table = element("table", "files-table");
          for (const row of sheet.rows) { const tr = document.createElement("tr"); for (const cell of row) tr.append(element("td", "", cell)); table.append(tr); }
          scroll.append(table); pane.append(scroll);
        }
      } else if (typeof file.content === "string") pane.append(element("pre", "files-text", file.content || "（空文件）"));
      else pane.append(element("p", "files-empty", "此格式暂不支持内嵌预览，可下载原文件查看，也可引用到对话处理。"));
      if (file.truncated) pane.append(element("p", "files-note", "预览已截断，下载可查看完整内容。"));
    } catch (error) {
      if (id !== previewRequest || current !== workspace) return;
      const download = element("a", "files-download", "下载原文件"); download.href = fileUrl("download", filePath); download.download = filePath.split("/").pop();
      pane.replaceChildren(element("p", "files-empty", `预览失败：${error.message}`), download);
    }
  }
  async function show() { opened = true; sync(); await browse(); }
  function close() { opened = false; sync(); toggle.focus(); }
  async function workspaceChanged(next, forceOpen = false) {
    if (next !== workspace) {
      workspace = next; directory = ""; selected = null; request++; previewRequest++;
      $("files-query").value = "";
      $("files-list").replaceChildren();
      $("files-preview").replaceChildren(element("p", "files-empty", "选择文件查看内容"));
      $("files-workspace").textContent = next;
      $("files-workspace").title = next;
      opened = forceOpen || window.innerWidth >= 1180;
      sync();
      if (opened) await browse();
    } else if (forceOpen) await show();
  }
  toggle.addEventListener("click", () => { if (opened) close(); else void show(); });
  $("files-close").addEventListener("click", close);
  $("files-refresh").addEventListener("click", () => { void browse(); if (selected) void preview(selected); });
  $("files-up").addEventListener("click", () => { $("files-query").value = ""; void browse(directory.split("/").slice(0, -1).join("/")); });
  $("files-query").addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(() => void browse(), 200); });
  $("files-hidden").addEventListener("change", () => void browse());
  return { open: show, close, refresh: () => browse(), workspaceChanged, setView: (next) => { view = next; sync(); }, openPath: async (file) => { if (getWorkspace() !== workspace) await workspaceChanged(getWorkspace()); opened = true; sync(); await preview(file); } };
}
