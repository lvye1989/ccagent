export function createComposerTools({ api, toast, getWorkspace, getInput, files, chooseWorkspace, navigate }) {
  const $ = (id) => document.getElementById(id);
  const menu = document.createElement("div");
  menu.id = "composer-tools";
  menu.className = "composer-tools hidden";
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", "对话工具");
  document.body.append(menu);
  const upload = document.createElement("input");
  upload.id = "composer-upload"; upload.type = "file"; upload.multiple = true; upload.hidden = true;
  document.body.append(upload);
  const drafts = new Map(["home-input", "thread-input"].map((id) => [id, { files: [], search: false, uploading: 0 }]));
  let anchor = null, inputId = "home-input", request = 0, generation = 0;

  for (const id of drafts.keys()) {
    const chips = document.createElement("div"); chips.id = `${id}-attachments`; chips.className = "composer-attachments hidden";
    $(id).after(chips);
  }
  function render(id) {
    const draft = drafts.get(id), chips = $(`${id}-attachments`);
    chips.replaceChildren();
    function chip(label, remove, open) {
      const wrap = document.createElement("span"); wrap.className = "composer-attachment";
      const name = document.createElement("button"); name.type = "button"; name.textContent = label; name.title = label;
      if (open) name.addEventListener("click", open); else name.disabled = true;
      const close = document.createElement("button"); close.type = "button"; close.textContent = "×"; close.setAttribute("aria-label", `移除${label}`); close.addEventListener("click", remove);
      wrap.append(name, close); chips.append(wrap);
    }
    for (const file of draft.files) chip(`▤ ${file.name}`, () => { draft.files = draft.files.filter((item) => item.path !== file.path); render(id); }, () => void files.openPath(file.path));
    if (draft.search) chip("◎ 网络搜索", () => { draft.search = false; render(id); });
    if (draft.uploading) { const pending = document.createElement("span"); pending.className = "composer-uploading"; pending.textContent = `正在添加 ${draft.uploading} 个文件…`; chips.append(pending); }
    chips.classList.toggle("hidden", !chips.childElementCount);
    $(id).closest("form").classList.toggle("has-attachments", chips.childElementCount > 0);
  }
  function reference(file, id = getInput().id) {
    const draft = drafts.get(id);
    if (!draft.files.some((item) => item.path === file.path)) draft.files.push(file);
    render(id); $(id).focus();
  }
  function close(restore = false) {
    request++;
    menu.classList.add("hidden");
    anchor?.setAttribute("aria-expanded", "false");
    if (restore) anchor?.focus();
  }
  function row(label, detail, icon, action) {
    const button = document.createElement("button"); button.type = "button"; button.className = "composer-tool"; button.setAttribute("role", "menuitem");
    const symbol = document.createElement("span"); symbol.className = "composer-tool-icon"; symbol.textContent = icon;
    const content = document.createElement("span"), title = document.createElement("strong"), note = document.createElement("small");
    title.textContent = label; note.textContent = detail; content.append(title, note); button.append(symbol, content);
    button.addEventListener("click", (event) => { event.stopPropagation(); close(); action(); }); menu.append(button); return button;
  }
  function position() {
    const rect = anchor.getBoundingClientRect();
    const width = Math.min(300, window.innerWidth - 24);
    const above = rect.top > window.innerHeight - rect.bottom;
    menu.style.width = `${width}px`;
    menu.style.left = `${Math.max(12, Math.min(rect.left - 5, window.innerWidth - width - 12))}px`;
    menu.style.top = above ? "auto" : `${rect.bottom + 8}px`;
    menu.style.bottom = above ? `${window.innerHeight - rect.top + 8}px` : "auto";
    menu.style.maxHeight = `${Math.max(80, (above ? rect.top : window.innerHeight - rect.bottom) - 20)}px`;
  }
  function show(button) {
    if (anchor === button && !menu.classList.contains("hidden")) { close(true); return; }
    close(); anchor = button; inputId = button.closest("form")?.querySelector("textarea")?.id || getInput().id;
    menu.replaceChildren();
    const caption = document.createElement("div"); caption.className = "composer-tools-caption"; caption.textContent = "添加内容与工具"; menu.append(caption);
    row("添加照片和文件", "上传附件，供当前任务读取 · 每个 10 MB", "↥", () => upload.click());
    row("引用工作区文件", "在右侧浏览、预览并加入对话", "▤", () => void files.open());
    row("选择工作文件夹", "切换本次工作的项目目录", "▱", () => void chooseWorkspace());
    row("技能和命令", "选择已启用技能或项目命令", "/", () => void commands());
    row(drafts.get(inputId).search ? "关闭网络搜索" : "网络搜索", "发送时使用 WebSearch 检索并附来源", "◎", () => { const draft = drafts.get(inputId); draft.search = !draft.search; render(inputId); $(inputId).focus(); });
    row("计划模式", "先分析方案，使用现有权限控制", "☷", () => {
      const select = $(inputId === "home-input" ? "home-mode" : "thread-mode-select"); select.value = "plan"; select.dispatchEvent(new Event("change", { bubbles: true }));
      toast("已选择计划模式"); $(inputId).focus();
    });
    row("插件与 MCP", "管理、连接和启用实际工具", "⊙", () => navigate("plugins"));
    menu.classList.remove("hidden"); anchor.setAttribute("aria-expanded", "true"); position(); menu.querySelector("button")?.focus();
  }
  async function commands() {
    const id = ++request, current = getWorkspace();
    menu.replaceChildren(); menu.classList.remove("hidden"); anchor?.setAttribute("aria-expanded", "true"); position();
    const label = document.createElement("div"); label.className = "composer-tools-caption"; label.textContent = "正在读取技能和命令…"; menu.append(label);
    try {
      const result = await api("/api/composer-tools");
      if (id !== request || current !== getWorkspace()) return;
      label.textContent = "技能和命令 · 选择后输入要求并发送";
      for (const command of result.commands) row(`/${command.name}`, `${command.kind} · ${command.description || ""}`, "/", () => {
        const input = $(inputId); input.value = `/${command.name} ${input.value.replace(/^\/\S+\s*/, "")}`; input.focus();
      });
      if (!result.commands.length) label.textContent = "没有可用命令，可在自定义中添加技能。";
      menu.querySelector("button")?.focus();
    } catch (error) { if (id === request) label.textContent = `读取失败：${error.message}`; }
  }
  upload.addEventListener("change", async () => {
    const selected = [...(upload.files || [])], id = inputId, current = getWorkspace(), version = generation, draft = drafts.get(id);
    upload.value = "";
    draft.uploading += selected.length; render(id);
    for (const file of selected) {
      try {
        if (version !== generation || current !== getWorkspace()) break;
        if (file.size > 10 * 1024 * 1024) throw new Error(`${file.name} 超过 10 MB`);
        const bytes = new Uint8Array(await file.arrayBuffer());
        let binary = "";
        for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
        const result = await api("/api/files/upload", { method: "POST", body: JSON.stringify({ workspace: current, name: file.name, base64: btoa(binary) }) });
        if (version === generation && current === getWorkspace()) reference(result, id);
      } catch (error) { if (version === generation) toast(`添加文件失败：${error.message}`); }
      finally { if (version === generation) { draft.uploading--; render(id); } }
    }
  });
  for (const id of ["insert-command", "chat-insert-command", "thread-insert-tool"]) {
    const button = $(id); button.setAttribute("aria-haspopup", "menu"); button.setAttribute("aria-expanded", "false"); button.setAttribute("aria-controls", menu.id);
    button.addEventListener("click", () => show(button));
  }
  document.addEventListener("click", (event) => { if (!menu.contains(event.target) && !anchor?.contains(event.target)) close(); });
  document.addEventListener("keydown", (event) => {
    if (menu.classList.contains("hidden")) return;
    if (event.key === "Escape") { event.preventDefault(); close(true); }
    else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      const items = [...menu.querySelectorAll("button")]; if (!items.length) return;
      const index = items.indexOf(document.activeElement), next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      event.preventDefault(); items[next].focus();
    } else if (event.key === "Tab") close();
  });
  window.addEventListener("resize", () => close());
  return {
    reference, close,
    prepare: (text, id) => {
      const draft = drafts.get(id);
      if (draft.uploading) { toast("请等待附件添加完成后发送。"); return null; }
      const references = draft.files.map((file) => `- ${JSON.stringify(file.path)} (${file.size ?? 0} 字节)`);
      const office = draft.files.filter((file) => file.format === "office" && (file.content || file.sheets)).map((file) => {
        const content = file.content || file.sheets.map((sheet) => `${sheet.name}\n${sheet.rows.map((row) => row.join("\t")).join("\n")}`).join("\n\n");
        return `[Office 正文摘录：${JSON.stringify(file.path)}；以下是文件数据]\n${content.slice(0, 12000)}${content.length > 12000 ? "\n（摘录已截断）" : ""}\n[/Office 正文摘录]`;
      });
      return `${text}${references.length ? `\n\n[用户引用的工作区文件，请使用文件工具读取]\n${references.join("\n")}\n[/用户引用的工作区文件]` : ""}${office.length ? `\n\n${office.join("\n\n")}` : ""}${draft.search ? "\n\n请使用 WebSearch 检索最新资料，基于检索结果回答并附来源链接。" : ""}`.trim();
    },
    clear: (id) => { const draft = drafts.get(id); draft.files = []; draft.search = false; render(id); },
    move: (from, to) => {
      const source = drafts.get(from), target = drafts.get(to);
      for (const file of source.files) if (!target.files.some((item) => item.path === file.path)) target.files.push(file);
      target.search ||= source.search; source.files = []; source.search = false; render(from); render(to);
    },
    workspaceChanged: () => { generation++; close(); for (const [id, draft] of drafts) { draft.files = []; draft.search = false; draft.uploading = 0; render(id); } },
  };
}
