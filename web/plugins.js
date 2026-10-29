const $ = (id) => document.getElementById(id);

function node(tag, className = "", value = "") {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (value) element.textContent = value;
  return element;
}

function actionButton(label, onClick, className = "") {
  const button = node("button", className, label);
  button.type = "button";
  button.addEventListener("click", onClick);
  return button;
}

const componentLabels = {
  skills: "Skills", agents: "Agents", commands: "Commands",
  outputStyles: "Output styles", hooks: "Hooks", mcpServers: "MCP servers",
};

function accentFor(name) {
  const palette = ["#4d62d9", "#14a073", "#e56d4b", "#8758c8", "#3479ad", "#cf8d25"];
  let sum = 0;
  for (const character of name) sum = (sum * 31 + character.charCodeAt(0)) >>> 0;
  return palette[sum % palette.length];
}

function iconFor(name, compact = false) {
  const icon = node("span", compact ? "installed-sidebar-icon" : "plugin-icon");
  const letter = [...name.trim()][0]?.toLocaleUpperCase() || "P";
  if (compact) {
    icon.style.background = accentFor(name);
    icon.textContent = letter;
  } else {
    const inner = node("span", "", letter);
    inner.style.background = accentFor(name);
    icon.append(inner);
  }
  return icon;
}

export function createPluginUI({ api, toast, navigate, editAgent }) {
  const state = { view: "plugins", tab: "public", data: null, skills: [], skillsEnabled: true, agents: [], mcp: null, query: "", loading: false };

  function closeDialog() { $("plugin-dialog-overlay").classList.add("hidden"); }

  function dialog(title, eyebrow, fillBody, actions = []) {
    $("plugin-dialog-title").textContent = title;
    $("plugin-dialog-eyebrow").textContent = eyebrow;
    const body = $("plugin-dialog-body");
    const footer = $("plugin-dialog-actions");
    body.replaceChildren();
    footer.replaceChildren();
    fillBody(body);
    for (const item of actions) footer.append(actionButton(item.label, item.onClick, item.className || ""));
    $("plugin-dialog-overlay").classList.remove("hidden");
  }

  function detail(body, label, value) {
    const line = node("div", "");
    const strong = node("strong", "", `${label}：`);
    line.append(strong, document.createTextNode(value));
    body.append(line);
  }

  async function runMutation(payload, success) {
    if (state.loading) return;
    state.loading = true;
    try {
      await api("/api/plugins/action", { method: "POST", body: JSON.stringify(payload) });
      closeDialog();
      await refreshPlugins();
      if (state.view === "skills") await refreshSkills();
      toast(success);
    } catch (error) { toast(error.message); }
    finally { state.loading = false; }
  }

  async function refreshPlugins() {
    try {
      state.data = await api("/api/plugins");
      renderSidebar();
      if (state.view === "plugins") renderCatalog();
    } catch (error) { toast(`插件列表读取失败：${error.message}`); }
  }

  async function refreshSkills() {
    try {
      const data = await api("/api/skills"); state.skills = data.skills; state.skillsEnabled = data.globallyEnabled;
      if (state.view === "skills") renderSkills();
    } catch (error) { toast(`技能列表读取失败：${error.message}`); }
  }

  async function refreshAgents() {
    try {
      state.agents = (await api("/api/agents")).agents;
      if (state.view === "agents") renderAgents();
    } catch (error) { toast(`Agent 列表读取失败：${error.message}`); }
  }

  async function refreshMcp() {
    try {
      const fresh = await api("/api/mcp");
      const changed = JSON.stringify(fresh) !== JSON.stringify(state.mcp);
      state.mcp = fresh;
      if (state.view === "mcp" && changed) renderMcp();
    } catch (error) { toast(`MCP 状态读取失败：${error.message}`); }
  }

  async function syncAll() {
    if (state.loading) return;
    state.loading = true;
    try {
      await api("/api/integrations/sync", { method: "POST", body: "{}" });
      const [plugins, skills, agents, mcp] = await Promise.all([api("/api/plugins"), api("/api/skills"), api("/api/agents"), api("/api/mcp")]);
      state.data = plugins;
      state.skills = skills.skills;
      state.agents = agents.agents;
      state.mcp = mcp;
      renderSidebar();
      if (state.view === "plugins") renderCatalog();
      else if (state.view === "skills") renderSkills();
      else if (state.view === "agents") renderAgents();
      else renderMcp();
      toast("插件、技能、Agents 和 MCP 状态已同步");
    } catch (error) { toast(error.message); }
    finally { state.loading = false; }
  }

  async function runMcpAction(name, op) {
    if (state.loading) return;
    state.loading = true;
    try {
      state.mcp = await api("/api/mcp/action", { method: "POST", body: JSON.stringify({ name, op }) });
      renderMcp();
      toast(`${name}：${({ open: "正在连接", close: "已关闭", reconnect: "正在重连", auth: "已启动授权" })[op]}`);
    } catch (error) { toast(error.message); }
    finally { state.loading = false; }
  }

  function matches(row) {
    if (!state.query) return true;
    return [row.name, row.pluginId, row.description, row.marketplace].some((value) =>
      typeof value === "string" && value.toLocaleLowerCase().includes(state.query));
  }

  function renderSidebar() {
    const list = $("installed-sidebar-list");
    list.replaceChildren();
    const installed = state.data?.installed || [];
    $("plugin-installed-count").textContent = installed.length ? String(installed.length) : "";
    if (!installed.length) {
      list.append(node("div", "installed-sidebar-empty", "还没有安装的插件。可从已注册的市场发现插件。"));
      return;
    }
    for (const item of installed) {
      const button = actionButton("", () => { navigate("plugins"); showInstalled(item); }, "installed-sidebar-item");
      button.append(iconFor(item.name, true), node("span", "", item.name));
      button.title = item.pluginId;
      list.append(button);
    }
  }

  function card(item, installed) {
    const row = node("div", "plugin-card");
    row.append(iconFor(item.name));
    const copy = node("div", "plugin-card-copy");
    const title = node("strong", "", item.name);
    const description = node("small", "", item.description || (installed ? `${item.version} · ${item.enabled ? "已启用" : "已停用"}` : `来自 ${item.marketplace}`));
    copy.append(title, description);
    const control = actionButton(installed ? "···" : "+", () => installed ? showInstalled(item) : previewInstall(item, "install"), "plugin-card-action");
    control.setAttribute("aria-label", installed ? `管理 ${item.name}` : `安装 ${item.name}`);
    row.append(copy, control);
    return row;
  }

  function section(container, title, items, installed) {
    if (!items.length) return;
    const block = node("section", "plugin-section");
    const heading = node("div", "plugin-section-title", title);
    heading.append(node("span", "", "›"));
    const grid = node("div", "plugin-grid");
    for (const item of items) grid.append(card(item, installed));
    block.append(heading, grid);
    container.append(block);
  }

  function empty(container, message, addAction = false) {
    const box = node("div", "plugin-empty", message);
    if (addAction) box.append(actionButton("添加插件市场", showAddMarketplace));
    container.append(box);
  }

  function renderCatalog() {
    const content = $("plugin-catalog");
    content.replaceChildren();
    const data = state.data;
    if (!data) return empty(content, "正在载入插件…");
    const installed = data.installed.filter(matches);
    const available = data.available.filter(matches);
    document.querySelectorAll(".plugin-tab").forEach((tab) => {
      const active = tab.dataset.pluginTab === state.tab;
      tab.classList.toggle("selected", active);
      tab.setAttribute("aria-selected", String(active));
    });
    if (state.tab === "personal") {
      section(content, "已安装", installed, true);
      if (!installed.length) empty(content, state.query ? "没有匹配的已安装插件。" : "当前没有已安装插件。", !state.query);
      renderMarketplaces(content, data.marketplaces);
      return;
    }
    section(content, "已安装", installed, true);
    const groups = new Map();
    for (const item of available) {
      if (!groups.has(item.marketplace)) groups.set(item.marketplace, []);
      groups.get(item.marketplace).push(item);
    }
    for (const [marketplace, entries] of groups) section(content, marketplace, entries, false);
    if (!installed.length && !available.length) {
      empty(content, state.query ? "没有找到匹配的插件。" :
        data.marketplaces.length ? "已注册市场中暂无可安装插件。" : "尚未添加插件市场。添加本地目录或 Git 市场后即可发现插件。", !state.query);
    }
  }

  function renderMarketplaces(container, marketplaces) {
    const group = node("section", "plugin-section");
    group.append(node("div", "plugin-section-title", "插件市场"));
    const list = node("div", "plugin-marketplace-list");
    if (!marketplaces.length) empty(list, "尚未添加插件市场。", true);
    for (const item of marketplaces) {
      const row = node("div", "marketplace-card");
      const copy = node("div", "marketplace-card-copy");
      copy.append(node("strong", "", item.name), node("small", "", `${item.kind === "git" ? "Git" : "本地"} · ${item.pluginCount ?? "?"} 个插件 · ${item.location}`));
      row.append(copy, actionButton("管理", () => showMarketplace(item)));
      list.append(row);
    }
    group.append(list);
    container.append(group);
  }

  function showInstalled(item) {
    const defaultScope = item.scope || item.installationScopes?.[0] || "user";
    dialog(item.name, item.enabled ? "INSTALLED · ENABLED" : "INSTALLED · DISABLED", (body) => {
      body.append(node("p", "", item.description || "此插件已安装在本机。"));
      const list = node("div", "plugin-detail-list");
      detail(list, "ID", item.pluginId);
      detail(list, "版本", item.version);
      detail(list, "市场", item.marketplace);
      detail(list, "作用范围", item.scope || "当前未启用");
      for (const [key, label] of Object.entries(componentLabels)) {
        if (item.components?.[key]) detail(list, label, String(item.components[key]));
      }
      body.append(list);
      if (item.hasExecutableComponents && !item.executablesTrusted) body.append(node("div", "plugin-dialog-note", "当前工作区尚未信任，Hooks 和 MCP 组件不会在此运行。"));
      if (item.errorCount) body.append(node("div", "plugin-dialog-note", `检测到 ${item.errorCount} 个插件加载问题。`));
    }, [
      { label: item.enabled ? "停用" : "启用", onClick: () => runMutation({ op: item.enabled ? "disable" : "enable", pluginId: item.pluginId, scope: defaultScope }, item.enabled ? "插件已停用" : "插件已启用") },
      { label: "检查更新", onClick: () => previewInstall(item, "update") },
      { label: "卸载…", className: "danger", onClick: () => confirmUninstall(item) },
    ]);
  }

  function confirmUninstall(item) {
    const allowed = item.installationScopes || [];
    dialog(`卸载 ${item.name}`, "CONFIRM REMOVAL", (body) => {
      body.append(node("p", "", "将移除所选范围的安装，并保留插件数据。其他项目的安装不会被删除。"));
      if (!allowed.length) body.append(node("div", "plugin-dialog-note", "此插件安装在其他项目，当前工作区不能卸载。"));
      else {
        const label = node("label", "", "卸载范围");
        label.htmlFor = "plugin-remove-scope";
        const select = node("select");
        select.id = "plugin-remove-scope";
        for (const scope of allowed) {
          const option = node("option", "", scope);
          option.value = scope;
          select.append(option);
        }
        body.append(label, select);
      }
    }, [
      { label: "取消", onClick: closeDialog },
      { label: "保留数据并卸载", className: "danger", onClick: () => {
        const scope = $("plugin-remove-scope")?.value;
        if (scope) runMutation({ op: "uninstall", pluginId: item.pluginId, scope }, "插件安装已移除，数据已保留");
      } },
    ]);
  }

  async function previewInstall(item, op) {
    if (state.loading) return;
    state.loading = true;
    toast("正在检查插件内容…");
    try {
      const { preview, token } = await api("/api/plugins/preview", { method: "POST", body: JSON.stringify({ pluginId: item.pluginId }) });
      dialog(`${op === "update" ? "更新" : "安装"} ${item.name}`, "REVIEW PLUGIN", (body) => {
        body.append(node("p", "", preview.description || item.description || "请核对插件组件后继续。"));
        const list = node("div", "plugin-detail-list");
        detail(list, "ID", preview.pluginId);
        detail(list, "版本", preview.version);
        for (const [key, label] of Object.entries(componentLabels)) {
          const names = preview.components[key];
          if (names?.length) detail(list, label, names.join(", "));
        }
        body.append(list);
        if (preview.hasExecutableComponents) body.append(node("div", "plugin-dialog-note", "此插件包含 Hooks 或 MCP 服务，启用后可能在本机执行进程。"));
        for (const warning of preview.warnings) body.append(node("div", "plugin-dialog-note", warning));
        const label = node("label", "", "安装范围");
        label.htmlFor = "plugin-install-scope";
        const select = node("select");
        select.id = "plugin-install-scope";
        for (const scope of ["user", "project", "local"]) {
          const option = node("option", "", scope === "user" ? "所有工作区（user）" : scope === "project" ? "当前项目（project）" : "本地设置（local）");
          option.value = scope;
          if (scope === (item.scope || "user")) option.selected = true;
          select.append(option);
        }
        body.append(label, select);
      }, [
        { label: "取消", onClick: closeDialog },
        { label: op === "update" ? "确认更新" : "确认安装", className: "primary", onClick: () => runMutation({ op, pluginId: preview.pluginId, scope: $("plugin-install-scope").value, token }, op === "update" ? "插件已更新" : "插件已安装") },
      ]);
    } catch (error) { toast(error.message); }
    finally { state.loading = false; }
  }

  function showAddMarketplace() {
    dialog("添加插件市场", "ADD MARKETPLACE", (body) => {
      body.append(node("p", "", "输入包含 .ccagent-plugin/marketplace.json 的本地目录，或 HTTPS Git 仓库地址。"));
      const label = node("label", "", "本地路径或 Git URL");
      label.htmlFor = "plugin-marketplace-source";
      const input = node("input");
      input.id = "plugin-marketplace-source";
      input.placeholder = "C:\\path\\to\\marketplace 或 https://...";
      body.append(label, input);
    }, [
      { label: "取消", onClick: closeDialog },
      { label: "添加", className: "primary", onClick: () => {
        const source = $("plugin-marketplace-source").value.trim();
        if (!source) return toast("请输入插件市场路径或 URL");
        runMutation({ op: "marketplace-add", source }, "插件市场已添加");
      } },
    ]);
  }

  function showAddMenu() {
    dialog("添加插件", "ADD", (body) => body.append(node("p", "", "先添加插件市场，再从 Public 列表选择插件安装。")), [
      { label: "添加市场", className: "primary", onClick: showAddMarketplace },
      { label: "通过 ID 安装", onClick: showInstallById },
    ]);
  }

  function showInstallById() {
    dialog("通过 ID 安装", "INSTALL PLUGIN", (body) => {
      body.append(node("p", "", "输入已注册市场中的插件 ID，例如 example@my-marketplace。"));
      const input = node("input");
      input.id = "plugin-id-input";
      input.placeholder = "name@marketplace";
      body.append(input);
    }, [
      { label: "取消", onClick: closeDialog },
      { label: "检查插件", className: "primary", onClick: () => {
        const pluginId = $("plugin-id-input").value.trim();
        if (!pluginId) return toast("请输入插件 ID");
        previewInstall({ pluginId, name: pluginId.split("@")[0] }, "install");
      } },
    ]);
  }

  function showMarketplace(item) {
    dialog(item.name, "MARKETPLACE", (body) => {
      const list = node("div", "plugin-detail-list");
      detail(list, "来源", item.kind === "git" ? "Git" : "本地目录");
      detail(list, "路径", item.location);
      detail(list, "插件数", String(item.pluginCount ?? "未知"));
      if (item.error) detail(list, "错误", item.error);
      body.append(list);
    }, [
      { label: "刷新市场", onClick: () => runMutation({ op: "marketplace-update", name: item.name }, "市场已刷新") },
      { label: "移除市场…", className: "danger", onClick: () => dialog(`移除 ${item.name}`, "CONFIRM REMOVAL", (body) => body.append(node("p", "", "此操作从列表中移除市场。已安装插件不会被卸载。")), [
        { label: "取消", onClick: closeDialog },
        { label: "确认移除", className: "danger", onClick: () => runMutation({ op: "marketplace-remove", name: item.name }, "市场已移除") },
      ]) },
    ]);
  }

  function showMarketplaces() {
    state.tab = "personal";
    renderCatalog();
    $("plugin-catalog").querySelector(".plugin-marketplace-list")?.scrollIntoView({ block: "nearest" });
  }

  function renderSkills() {
    const list = $("skills-list");
    list.replaceChildren();
    if (!state.skillsEnabled) {
      const banner = node("div", "plugin-empty", "技能总开关已关闭；已安装的技能会保留。");
      banner.append(actionButton("启用技能", async () => { try { await api("/api/skills/global", { method: "POST", body: JSON.stringify({ enabled: true }) }); await refreshSkills(); } catch (error) { toast(error.message); } })); list.append(banner);
    }
    const query = $("skill-search-input").value.trim().toLocaleLowerCase();
    const skills = state.skills.filter((skill) => [skill.name, skill.description, skill.pluginId].some((value) =>
      typeof value === "string" && value.toLocaleLowerCase().includes(query)));
    if (!skills.length) return empty(list, query ? "没有匹配的技能。" : "当前工作区没有可调用的技能。");
    for (const skill of skills) {
      const card = node("div", "skill-card");
      const footer = node("div", "skill-card-footer");
      footer.append(node("span", "", skill.pluginId ? `来自插件 ${skill.pluginId}` : skill.source === "project" ? "当前项目" : "用户技能"));
      footer.append(actionButton(skill.enabled ? "关闭" : "启用", async () => {
        try { await api("/api/skills/state", { method: "POST", body: JSON.stringify({ name: skill.name, state: skill.enabled ? "close" : "open" }) }); await refreshSkills(); }
        catch (error) { toast(error.message); }
      }, "skill-use-button"));
      if (skill.enabled && state.skillsEnabled) footer.append(actionButton("使用技能", () => {
        navigate("tasks");
        const input = $("home-input");
        input.value = `/${skill.name} `;
        input.focus();
      }, "skill-use-button"));
      card.append(node("strong", "", `${skill.name}${skill.enabled ? "" : " · 已关闭"}`), node("p", "", skill.description), footer);
      list.append(card);
    }
  }

  function renderAgents() {
    const list = $("agents-list");
    list.replaceChildren();
    const query = $("agent-search-input").value.trim().toLocaleLowerCase();
    const agents = state.agents.filter((agent) => [agent.name, agent.description, agent.source, agent.pluginId]
      .some((value) => typeof value === "string" && value.toLocaleLowerCase().includes(query)));
    if (!agents.length) return empty(list, query ? "没有匹配的 Agent。" : "没有可用的 Agent。");
    for (const agent of agents) {
      const card = node("article", "skill-card");
      const footer = node("div", "skill-card-footer");
      const origin = agent.pluginId ? `插件 ${agent.pluginId}` : ({ "built-in": "内置", user: "用户", project: "当前项目" })[agent.source] || agent.source;
      footer.append(node("span", "", `${origin} · ${agent.enabled ? "已启用" : "已关闭"}`));
      const toggle = actionButton(agent.enabled ? "关闭" : "启用", async () => {
        try {
          await api("/api/agents/state", { method: "POST", body: JSON.stringify({ name: agent.name, state: agent.enabled ? "close" : "open" }) });
          await refreshAgents();
        } catch (error) { toast(error.message); }
      }, "skill-use-button");
      footer.append(toggle);
      if (agent.editable) footer.append(actionButton("编辑", () => editAgent(agent), "skill-use-button"));
      if (agent.enabled) footer.append(actionButton("使用 Agent", () => {
        navigate("tasks");
        const input = $("home-input");
        input.value = `请使用 Agent 工具并指定 subagent_type="${agent.name}" 完成以下任务：\n`;
        input.focus();
      }, "skill-use-button"));
      const description = node("p", "", agent.description);
      const details = node("small", "agent-details", [agent.model ? `模型：${agent.model}` : "", agent.tools?.length ? `工具：${agent.tools.join("、")}` : ""].filter(Boolean).join(" · "));
      card.append(node("strong", "", agent.name), description, details, footer);
      list.append(card);
    }
  }

  async function importSkillFile(file) {
    if (file.size > 60 * 1024) return toast("SKILL.md 不能超过 60 KB。");
    let content;
    try { content = await file.text(); } catch (error) { return toast(`无法读取文件：${error.message}`); }
    if (!content.trim()) return toast("SKILL.md 不能为空。");
    const declaredName = content.match(/^name:\s*['\"]?([a-zA-Z0-9_-]+)['\"]?\s*$/m)?.[1];
    const fallbackName = file.name === "SKILL.md" ? "" : file.name.replace(/\.md$/i, "");
    dialog("添加本地技能", "SKILL.md", (body) => {
      body.append(node("p", "", "将本地 SKILL.md 安装到当前项目或用户技能目录，安装后 CLI 与 Web 都可调用。"));
      const nameLabel = node("label", "", "技能名称");
      const nameInput = node("input"); nameInput.id = "skill-import-name"; nameInput.value = declaredName || fallbackName;
      nameLabel.append(nameInput);
      const scopeLabel = node("label", "", "安装位置");
      const scope = node("select"); scope.id = "skill-import-scope";
      for (const [value, label] of [["project", "当前项目"], ["user", "所有项目"]]) {
        const option = node("option", "", label); option.value = value; scope.append(option);
      }
      scopeLabel.append(scope);
      body.append(nameLabel, scopeLabel, node("p", "plugin-dialog-note", `文件：${file.name} · ${file.size} 字节`));
    }, [
      { label: "取消", onClick: closeDialog },
      { label: "添加技能", className: "primary", onClick: async () => {
        try {
          const name = $("skill-import-name").value.trim();
          const scope = $("skill-import-scope").value;
          await api("/api/skills/import", { method: "POST", body: JSON.stringify({ name, scope, content }) });
          closeDialog();
          await refreshSkills();
          toast(`技能 ${name} 已添加`);
        } catch (error) { toast(error.message); }
      } },
    ]);
  }

  function renderMcp() {
    const list = $("mcp-list");
    list.replaceChildren();
    const query = $("mcp-search-input").value.trim().toLocaleLowerCase();
    const all = state.mcp?.servers || [];
    if (state.mcp?.configErrorCount) list.append(node("p", "mcp-error", `MCP 配置有 ${state.mcp.configErrorCount} 个错误；请检查 CLI 日志或 settings.json。`));
    const servers = all.filter((server) => [server.name, server.scope, server.transport, ...server.tools.map((tool) => `${tool.name} ${tool.description}`)]
      .some((value) => value.toLocaleLowerCase().includes(query)));
    if (!servers.length && !(state.mcp?.pending || []).length) {
      return empty(list, query ? "没有匹配的 MCP 服务或工具。" : "尚未配置 MCP 服务。可在用户或项目 settings.json 的 mcpServers 中添加。 ");
    }
    for (const server of servers) {
      const card = node("article", "mcp-card");
      const head = node("div", "mcp-card-head");
      const copy = node("div", "mcp-card-copy");
      const title = node("strong", "", server.name);
      const status = node("span", `mcp-status mcp-${server.state}`,
        ({ connected: "已连接", degraded: server.authAvailable ? "需授权或重连" : "工具不可用", pending: "连接中", failed: "连接失败", disabled: "已关闭" })[server.state] || server.state);
      copy.append(title, status, node("small", "", `${server.scope} · ${server.transport} · ${server.tools.length} 个工具`));
      head.append(copy);
      const actions = node("div", "mcp-actions");
      if (server.state === "disabled") {
        actions.append(actionButton("开启", () => runMcpAction(server.name, "open")));
      } else {
        actions.append(actionButton("关闭", () => runMcpAction(server.name, "close")));
        actions.append(actionButton("重连", () => runMcpAction(server.name, "reconnect")));
        if (server.authAvailable) actions.append(actionButton("授权", () => runMcpAction(server.name, "auth")));
      }
      head.append(actions);
      card.append(head);
      if (server.error) card.append(node("p", "mcp-error", server.error));
      if (server.tools.length) {
        const details = node("details", "mcp-tools");
        const summary = node("summary", "", `查看 ${server.tools.length} 个工具`);
        details.append(summary);
        for (const tool of server.tools) {
          const row = node("div", "mcp-tool");
          row.append(node("strong", "", tool.name), node("span", "", tool.description));
          details.append(row);
        }
        card.append(details);
      }
      list.append(card);
    }
    for (const name of state.mcp?.pending || []) {
      if (query && !name.toLocaleLowerCase().includes(query)) continue;
      const card = node("article", "mcp-card");
      card.append(node("strong", "", name), node("p", "mcp-error", "项目 .mcp.json 中的服务等待批准；请在 CCAGENT 设置中批准后刷新。"));
      list.append(card);
    }
  }

  async function open(view) {
    state.view = view;
    const searchLabel = view === "mcp" ? "搜索 MCP 服务" : view === "skills" ? "搜索技能" : view === "agents" ? "搜索 Agent" : "搜索插件";
    $("customize-search").title = searchLabel;
    $("customize-search").setAttribute("aria-label", searchLabel);
    document.querySelectorAll(".customize-nav-item").forEach((item) => item.classList.toggle("selected", item.dataset.customizeView === view));
    if (view === "plugins") await refreshPlugins();
    else if (view === "skills") { if (!state.data) await refreshPlugins(); await refreshSkills(); }
    else if (view === "agents") { if (!state.data) await refreshPlugins(); await refreshAgents(); }
    else { if (!state.data) await refreshPlugins(); await refreshMcp(); }
  }

  $("plugin-dialog-close").addEventListener("click", closeDialog);
  $("plugin-dialog-overlay").addEventListener("click", (event) => { if (event.target === $("plugin-dialog-overlay")) closeDialog(); });
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") closeDialog(); });
  $("plugin-search-input").addEventListener("input", (event) => { state.query = event.target.value.trim().toLocaleLowerCase(); renderCatalog(); });
  $("skill-search-input").addEventListener("input", renderSkills);
  $("agent-search-input").addEventListener("input", renderAgents);
  $("mcp-search-input").addEventListener("input", renderMcp);
  document.querySelectorAll(".plugin-tab").forEach((button) => button.addEventListener("click", () => { state.tab = button.dataset.pluginTab; renderCatalog(); }));
  document.querySelectorAll(".customize-nav-item").forEach((button) => button.addEventListener("click", () => navigate(button.dataset.customizeView)));
  $("plugin-refresh").addEventListener("click", syncAll);
  $("skill-refresh").addEventListener("click", syncAll);
  $("agent-refresh").addEventListener("click", syncAll);
  $("skill-import").addEventListener("click", () => $("skill-file-input").click());
  $("skill-file-input").addEventListener("change", (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) void importSkillFile(file);
  });
  $("mcp-refresh").addEventListener("click", syncAll);
  $("plugin-marketplaces").addEventListener("click", showMarketplaces);
  $("plugin-add").addEventListener("click", showAddMenu);
  $("customize-search").addEventListener("click", () => $(state.view === "skills" ? "skill-search-input" : state.view === "agents" ? "agent-search-input" : state.view === "mcp" ? "mcp-search-input" : "plugin-search-input").focus());

  setInterval(() => { if (!$('mcp-view').classList.contains("hidden") && !document.hidden && !state.loading) void refreshMcp(); }, 5000);

  return { open, refresh: syncAll };
}
