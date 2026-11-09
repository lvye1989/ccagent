import { appIcon } from "./app-icons.js";
const $ = (id) => document.getElementById(id);
function node(tag, className = "", value = "") {
  const element = document.createElement(tag); element.className = className; element.textContent = value; return element;
}
const statusLabels = { available: "未安装", connected: "已连接", degraded: "工具加载异常", pending: "连接中", failed: "连接失败", disabled: "已断开", conflict: "配置已变更" };
function status(app) {
  if (["canva", "figma", "autocad"].includes(app.id) && app.state === "available") return app.auth === "local" ? "未配置" : "未连接";
  if (app.auth === "oauth" && app.state === "pending") return "待授权 / 连接中";
  if (app.auth === "local" && app.state === "connected") return "MCP 已连接";
  return ["google", "oauth"].includes(app.auth) && app.state === "failed" ? "待授权 / 连接失败" : statusLabels[app.state] || "待连接";
}
function external(label, href) {
  try {
    if (typeof href !== "string" || !(/^[a-z][a-z0-9+.-]*:/i.test(href) || /^\/(?!\/)/.test(href))) return node("span", "app-external-link", label);
    const url = new URL(href, window.location.href);
    const local = /^\/(?!\/)/.test(href) && url.origin === window.location.origin;
    if (url.username || url.password || (!local && url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) return node("span", "app-external-link", label);
  } catch { return node("span", "app-external-link", label); }
  const link = node("a", "app-external-link", label);
  link.href = href; link.target = "_blank"; link.rel = "noopener noreferrer"; link.referrerPolicy = "no-referrer"; return link;
}
function comfyLocalUrl(value) {
  if (typeof value !== "string" || value.length > 256 || !/^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]+)?\/?$/i.test(value)) return undefined;
  try {
    const url = new URL(value);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    return loopback && url.protocol === "http:" && url.port !== "0" && url.pathname === "/" && !url.username && !url.password && !url.search && !url.hash ? url.href : undefined;
  } catch { return undefined; }
}
function figmaLocalUrl(value) {
  if (typeof value !== "string" || value.length > 256 || !/^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]+)?\/mcp$/i.test(value)) return undefined;
  try {
    const url = new URL(value);
    return url.port !== "0" && url.pathname === "/mcp" && !url.username && !url.password && !url.search && !url.hash ? url.href : undefined;
  } catch { return undefined; }
}

export function createAppCatalog({ api, toast, dialog, closeDialog, state, render: renderAll }) {
  let shownApp;
  let photoshopTest;
  let photoshopRequestPending = false, photoshopGeneration = 0;
  let comfyTest, comfyRequestPending = false, comfyGeneration = 0;
  let sketchupTest, sketchupRequestPending = false, sketchupGeneration = 0;
  const workspaceNode = $("workspace-path");
  let photoshopWorkspace = workspaceNode?.textContent || "";
  const appIsVisible = (app) => !$('plugin-dialog-overlay').classList.contains('hidden') && $('plugin-dialog-title').textContent === app.name;
  function syncPhotoshopWorkspace() {
    const next = workspaceNode?.textContent || "";
    if (next === photoshopWorkspace) return false;
    photoshopWorkspace = next; photoshopGeneration++; photoshopTest = undefined;
    comfyGeneration++; comfyTest = undefined;
    sketchupGeneration++; sketchupTest = undefined;
    return true;
  }
  if (workspaceNode) new window.MutationObserver(() => {
    if (syncPhotoshopWorkspace() && ["photoshop", "comfyui", "sketchup"].includes(shownApp?.id) && appIsVisible(shownApp)) show(state.apps.find((item) => item.id === shownApp.id) || shownApp);
  }).observe(workspaceNode, { childList: true, characterData: true, subtree: true });
  function setDialogBusy(busy) {
    for (const button of document.querySelectorAll('#plugin-dialog-actions button, .app-test-actions button')) button.disabled = busy;
  }
  async function refresh() {
    try {
      const data = await api("/api/apps");
      if (JSON.stringify(data.apps) !== JSON.stringify(state.apps)) {
        state.apps = data.apps; renderAll();
        if (shownApp?.installed && !$("plugin-dialog-overlay").classList.contains("hidden") && $("plugin-dialog-title").textContent === shownApp.name) show(state.apps.find((app) => app.id === shownApp.id));
      }
    } catch { /* Keep existing cards on a transient polling failure. */ }
  }
  async function mutate(app, op, credentials) {
    if (state.loading) return;
    state.loading = true;
    const buttons = [...$("plugin-dialog-actions").querySelectorAll("button")];
    for (const button of buttons) button.disabled = true;
    try {
      state.apps = (await api("/api/apps/action", { method: "POST", body: JSON.stringify({ id: app.id, op, credentials }) })).apps;
      $("plugin-dialog-body").querySelectorAll("input").forEach((input) => { input.value = ""; });
      renderAll();
      if (op === "install") {
        if (app.id === "photoshop") photoshopTest = undefined;
        if (app.id === "comfyui") comfyTest = undefined;
        if (app.id === "sketchup") sketchupTest = undefined;
        show(state.apps.find((item) => item.id === app.id));
        toast(app.auth === "local" ? ["figma", "autocad"].includes(app.id) ? `已添加 ${app.name} MCP 配置；请准备本机运行环境后重新检测连接。` : `已添加本机 MCP 配置；请点击‘测试连接’检查 ${app.name} 是否可用。` : ["google", "oauth"].includes(app.auth) ? "已添加 MCP 配置；请点击‘授权连接’，在浏览器中完成授权。" : "已添加 MCP 配置，正在检测连接。");
      } else { if (app.id === "photoshop") photoshopTest = undefined; if (app.id === "comfyui") comfyTest = undefined; if (app.id === "sketchup") sketchupTest = undefined; closeDialog(); toast(`${app.name} 已卸载。${app.auth === "local" ? "本机应用和工作文件保留。" : "远端资料保留。"}`); }
    } catch (error) { toast(error.message); }
    finally { state.loading = false; for (const button of buttons) button.disabled = false; }
  }
  async function connection(app, op) {
    if (state.loading) return;
    state.loading = true;
    if (app.id === "comfyui") comfyTest = undefined;
    if (app.id === "sketchup") sketchupTest = undefined;
    try {
      await api("/api/mcp/action", { method: "POST", body: JSON.stringify({ name: app.serverName, op }) });
      await refresh(); show(state.apps.find((item) => item.id === app.id));
      toast(op === "auth" ? "已启动浏览器授权，请在浏览器中完成连接。" : op === "close" ? "已断开应用连接。" : "正在重新连接应用。");
    } catch (error) { toast(error.message); }
    finally { state.loading = false; }
  }
  async function testComfy(app) {
    if (state.loading) return;
    syncPhotoshopWorkspace();
    const generation = comfyGeneration;
    state.loading = true; comfyRequestPending = true; comfyTest = { pending: true };
    show(app);
    try {
      const result = await api("/api/apps/comfyui/test", { method: "POST", body: JSON.stringify({}) });
      syncPhotoshopWorkspace();
      if (generation === comfyGeneration) comfyTest = { result };
    } catch (error) {
      syncPhotoshopWorkspace();
      if (generation === comfyGeneration) comfyTest = { result: { ok: false, message: error.message || "测试请求失败，请重试。" } };
    } finally {
      state.loading = false; comfyRequestPending = false;
      if (appIsVisible(app)) show(state.apps.find((item) => item.id === app.id) || app);
    }
  }
  function comfyTesting(body, app) {
    const panel = node("section", "app-test-panel"); panel.setAttribute("aria-label", "ComfyUI 实机测试");
    panel.append(node("h3", "", "ComfyUI 实机测试"), node("p", "app-test-hint", "‘测试连接’仅读取 MCP 和 ComfyUI 服务状态，不会启动服务、下载模型或生成图片。请先在运行 CCAGENT 的电脑上启动 ComfyUI。"));
    const actions = node("div", "app-test-actions");
    const button = node("button", "", "测试连接"); button.type = "button"; button.dataset.comfyuiTest = "connection";
    button.addEventListener("click", () => testComfy(app)); actions.append(button); panel.append(actions);
    const output = node("div", "app-test-result"); output.setAttribute("role", "status"); output.setAttribute("aria-live", "polite");
    if (!comfyTest) output.append(node("p", "", "尚未执行实机测试。MCP 已连接仅表示工具服务可访问，ComfyUI 是否正在运行需另行测试。"));
    else if (comfyTest.pending) {
      output.setAttribute("aria-busy", "true"); output.append(node("p", "", "正在读取本机 MCP 和 ComfyUI 服务状态…"));
    } else {
      const result = comfyTest.result;
      const ok = result?.ok === true && result?.mcpConnected === true && result?.serverRunning === true;
      output.classList.add(ok ? "app-test-success" : "app-test-error");
      output.append(node("strong", "", ok ? "ComfyUI 连接测试通过" : "ComfyUI 尚未就绪"));
      output.append(node("p", "", String(result?.message || result?.error || "未收到有效的服务状态，请检查本机配置后重试。")));
      output.append(node("p", "app-test-detail", `MCP 服务：${result?.mcpConnected === true ? "已连接" : "未确认连接"}`));
      output.append(node("p", "app-test-detail", `ComfyUI 服务：${result?.serverRunning === true ? "正在运行" : "未确认运行"}`));
      if (Number.isSafeInteger(result?.toolCount) && result.toolCount >= 0) output.append(node("p", "app-test-detail", `MCP 工具数：${result.toolCount}`));
      if (typeof result?.version === "string" && /^[\w.+-]{1,80}$/.test(result.version)) output.append(node("p", "app-test-detail", `comfy-cli 版本：${result.version}`));
      if (typeof result?.warning === "string" && result.warning) output.append(node("p", "app-test-hint", result.warning));
      const url = comfyLocalUrl(result?.url);
      if (ok && url) output.append(external("打开 ComfyUI（服务所在电脑） ↗", url));
    }
    panel.append(output); body.append(panel);
  }
  async function testSketchup(app) {
    if (state.loading) return;
    syncPhotoshopWorkspace();
    const generation = sketchupGeneration;
    state.loading = true; sketchupRequestPending = true; sketchupTest = { pending: true };
    show(app);
    try {
      const result = await api("/api/apps/sketchup/test", { method: "POST", body: JSON.stringify({}) });
      syncPhotoshopWorkspace();
      if (generation === sketchupGeneration) sketchupTest = { result };
    } catch (error) {
      syncPhotoshopWorkspace();
      if (generation === sketchupGeneration) sketchupTest = { result: { ok: false, message: error.message || "测试请求失败，请重试。" } };
    } finally {
      state.loading = false; sketchupRequestPending = false;
      if (appIsVisible(app)) show(state.apps.find((item) => item.id === app.id) || app);
    }
  }
  function sketchupTesting(body, app) {
    const panel = node("section", "app-test-panel"); panel.setAttribute("aria-label", "SketchUp 实机测试");
    panel.append(node("h3", "", "SketchUp 实机测试"), node("p", "app-test-hint", "‘测试连接’仅读取版本与模型信息，不会创建、修改或保存模型。请先打开 SketchUp，并启动本机 Ruby 扩展的 MCP 服务。"));
    const actions = node("div", "app-test-actions");
    const button = node("button", "", "测试连接"); button.type = "button"; button.dataset.sketchupTest = "connection";
    button.addEventListener("click", () => testSketchup(app)); actions.append(button); panel.append(actions);
    const output = node("div", "app-test-result"); output.setAttribute("role", "status"); output.setAttribute("aria-live", "polite");
    if (!sketchupTest) output.append(node("p", "", "尚未执行实机测试。MCP 已连接仅表示工具服务可访问，SketchUp 与本机扩展是否可用需另行测试。"));
    else if (sketchupTest.pending) {
      output.setAttribute("aria-busy", "true"); output.append(node("p", "", "正在读取 SketchUp 版本与模型信息…"));
    } else {
      const result = sketchupTest.result;
      const ok = result?.ok === true && result?.mcpConnected === true && result?.sketchupConnected === true;
      output.classList.add(ok ? "app-test-success" : "app-test-error");
      output.append(node("strong", "", ok ? "SketchUp 连接测试通过" : "SketchUp 尚未就绪"));
      output.append(node("p", "", String(result?.message || result?.error || "未收到有效的连接状态，请检查 SketchUp 与扩展后重试。")));
      output.append(node("p", "app-test-detail", `MCP 服务：${result?.mcpConnected === true ? "已连接" : "未确认连接"}`));
      output.append(node("p", "app-test-detail", `SketchUp 与本机扩展：${result?.sketchupConnected === true ? "已连接" : "未确认连接"}`));
      if (Number.isSafeInteger(result?.toolCount) && result.toolCount >= 0) output.append(node("p", "app-test-detail", `MCP 工具数：${result.toolCount}`));
      for (const [key, label] of [["version", "SketchUp 版本"], ["pluginVersion", "Ruby 扩展版本"]]) {
        if (typeof result?.[key] === "string" && /^[\w.+-]{1,80}$/.test(result[key])) output.append(node("p", "app-test-detail", `${label}：${result[key]}`));
      }
      if (typeof result?.warning === "string" && result.warning) output.append(node("p", "app-test-hint", result.warning));
    }
    panel.append(output); body.append(panel);
  }
  async function testPhotoshop(app, mode) {
    if (state.loading) return;
    syncPhotoshopWorkspace();
    const generation = photoshopGeneration, workspace = photoshopWorkspace;
    state.loading = true;
    photoshopRequestPending = true;
    photoshopTest = { pending: true, mode };
    show(app);
    try {
      const result = await api("/api/apps/photoshop/test", { method: "POST", body: JSON.stringify({ mode }) });
      syncPhotoshopWorkspace();
      if (generation === photoshopGeneration) photoshopTest = { mode, result, workspace: typeof result?.workspace === "string" ? result.workspace : workspace };
    } catch (error) {
      syncPhotoshopWorkspace();
      if (generation === photoshopGeneration) photoshopTest = { mode, workspace, result: { ok: false, message: error.message || "测试请求失败，请重试。" } };
    } finally {
      state.loading = false;
      photoshopRequestPending = false;
      if (appIsVisible(app)) show(state.apps.find((item) => item.id === app.id) || app);
    }
  }
  function photoshopTesting(body, app) {
    const panel = node("section", "app-test-panel"); panel.setAttribute("aria-label", "Photoshop 实机测试");
    panel.append(node("h3", "", "Photoshop 实机测试"), node("p", "app-test-hint", "‘测试连接’仅读取版本、打开的文档和工具状态。‘创建测试图并导出’会新建独立测试文档并导出 PNG / PSD 副本，不修改已有文档。"));
    const actions = node("div", "app-test-actions");
    for (const [mode, label] of [["connection", "测试连接"], ["sample", "创建测试图并导出"]]) {
      const button = node("button", "", label); button.type = "button"; button.dataset.photoshopTest = mode;
      button.addEventListener("click", () => testPhotoshop(app, mode)); actions.append(button);
    }
    panel.append(actions);
    const output = node("div", "app-test-result"); output.setAttribute("role", "status"); output.setAttribute("aria-live", "polite");
    if (!photoshopTest) output.append(node("p", "", "尚未执行实机测试。MCP 已连接仅表示工具服务可访问，Photoshop 是否可用需另行测试。"));
    else if (photoshopTest.pending) {
      output.setAttribute("aria-busy", "true");
      output.append(node("p", "", photoshopTest.mode === "sample" ? "正在创建独立测试图并导出，请等待 Photoshop 完成操作…" : "正在读取 Photoshop 版本与文档信息…"));
    } else {
      const result = photoshopTest.result;
      const ok = result?.ok === true;
      output.classList.add(ok ? "app-test-success" : "app-test-error");
      output.append(node("strong", "", ok ? (photoshopTest.mode === "sample" ? "测试图创建与导出通过" : "Photoshop 连接测试通过") : "Photoshop 测试未通过"));
      output.append(node("p", "", String(result?.message || result?.error || (ok ? "已收到实机测试结果。" : "未收到有效的测试结果，请检查本机 Photoshop 和 MCP 服务后重试。"))));
      const detail = (label, value, fileRoute, linkLabel) => {
        if (value === undefined || value === null) return;
        const row = node("p", "app-test-detail"); row.append(node("span", "", `${label}：`));
        // Only link files produced under the dedicated test folder. Other values remain plain text.
        const safePath = typeof value === "string" && value.startsWith("output/photoshop-mcp-tests/") && value.split("/").every((part) => /^[a-z\d._-]+$/i.test(part) && part !== "." && part !== "..");
        if (fileRoute && safePath) {
          const workspace = photoshopTest.workspace;
          const link = external(linkLabel || value.split("/").at(-1), `${fileRoute}?path=${encodeURIComponent(value)}${workspace ? `&workspace=${encodeURIComponent(workspace)}` : ""}`);
          link.title = value;
          link.classList.add("app-test-file-link"); row.append(link);
        } else row.append(node("code", "", typeof value === "string" ? value : JSON.stringify(value)));
        output.append(row);
      };
      const documents = result?.documents;
      detail("Photoshop 版本", result?.version); detail("MCP 工具数", result?.toolCount);
      detail("打开的文档", Number.isSafeInteger(documents?.count) && documents.count >= 0 ? `${documents.count} 个` : documents);
      if (ok) { detail("PNG 文件", result?.output?.png, "/api/files/content", "预览 PNG"); detail("PSD 文件", result?.output?.psd, "/api/files/download", "下载 PSD"); }
      detail("测试报告", result?.reportPath, "/api/files/download", "下载测试报告");
    }
    panel.append(output); body.append(panel);
  }
  function render(container, apps, title) {
    if (!apps.length) return;
    const block = node("section", "plugin-section common-apps");
    block.append(node("h2", "plugin-section-title", title), node("p", "app-section-description", "连接你常用的工具，让 CCAGENT 在授权范围内协助工作。"));
    const grid = node("div", "app-grid");
    for (const app of apps) {
      const card = node("button", "app-card"); card.type = "button"; card.dataset.appId = app.id;
      card.setAttribute("aria-label", `${app.name}，${status(app)}，${app.installed ? "管理连接" : ["canva", "figma", "autocad"].includes(app.id) ? "查看并连接" : "查看并安装"}`);
      card.addEventListener("click", () => show(app));
      const top = node("span", "app-card-top");
      top.append(appIcon(app.id), node("span", `app-status app-status-${app.state}`, status(app)));
      card.append(top, node("strong", "app-card-name", app.name), node("span", "app-card-description", app.description));
      const bottom = node("span", "app-card-bottom");
      bottom.append(node("span", "", app.category), node("span", "app-card-cta", app.installed ? "管理连接 ↗" : ["canva", "figma", "autocad"].includes(app.id) ? "添加连接 +" : "连接并安装 +"));
      card.append(bottom); grid.append(card);
    }
    block.append(grid); container.append(block);
  }
  function show(app) {
    if (!app) return;
    syncPhotoshopWorkspace();
    shownApp = app;
    const fields = {};
    const input = (body, key, label, optional = false, type = "password", value = "") => {
      const wrapper = node("label", "app-credential-field"); wrapper.append(node("span", "", label + (optional ? "（可选）" : "")));
      const control = node("input"); control.type = type; control.name = key; control.value = value; control.autocomplete = "off"; control.spellcheck = false; control.maxLength = 8192;
      control.setAttribute("aria-label", label); fields[key] = control; wrapper.append(control); body.append(wrapper);
    };
    const actions = app.installed ? [
      ...(app.state === "conflict" ? [] : [
        ...(["google", "oauth"].includes(app.auth) && app.state !== "disabled" ? [{ label: "授权连接", className: "primary", onClick: () => connection(app, "auth") }] : []),
        { label: app.state === "disabled" ? "重新连接" : "重新检测", onClick: () => connection(app, app.state === "disabled" ? "open" : "reconnect") },
        ...(app.state !== "disabled" ? [{ label: "断开连接", onClick: () => connection(app, "close") }] : []),
        { label: "卸载", className: "danger", onClick: () => dialog(`卸载 ${app.name}？`, "UNINSTALL", (body) => {
          body.append(node("p", "", app.id === "sketchup" ? "将移除当前账号中的应用入口和 MCP 配置。本机 SketchUp、模型文件和已安装的 RBZ 扩展会保留；如需移除原生扩展，请在 SketchUp 扩展管理器中操作。" : app.id === "comfyui" ? "将移除当前账号中的应用入口和 MCP 配置。本机 ComfyUI、模型和工作流会保留。" : app.id === "autocad" ? "将移除当前账号中的应用入口和 MCP 配置。本机 AutoCAD、MCP 程序及 DWG / DXF 图纸会保留。" : app.id === "figma" ? "将移除当前账号中的应用入口和 MCP 配置。本机 Figma、设计文件及桌面版 MCP 设置会保留。" : app.auth === "local" ? "将移除当前账号中的应用入口和 MCP 配置。本机 Photoshop、已有文档和导出的测试文件会保留。" : "将移除当前账号中的应用入口、MCP 配置和专用令牌。远端资料不会删除；第三方授权可在对应平台的账号设置中撤销。"));
        }, [{ label: "取消", onClick: () => show(app) }, { label: "确认卸载", className: "danger", onClick: () => mutate(app, "uninstall") }]) },
      ]), { label: "完成", onClick: closeDialog },
    ] : [{ label: "取消", onClick: closeDialog }, { label: ["canva", "figma", "autocad"].includes(app.id) ? "添加并连接" : "安装并连接", className: "primary", onClick: () => {
      const credentials = Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, value.value.trim()]));
      if (app.auth === "token" && !credentials.token) return toast("请先填写应用令牌。");
      if (app.auth === "google" && ((!app.googleConfigured && (!credentials.clientId || !credentials.clientSecret)) || (!!credentials.clientId !== !!credentials.clientSecret))) return toast("请同时填写 Google 客户端 ID 和客户端密钥。");
      if (app.id === "canva" && ((!app.oauthConfigured && (!credentials.clientId || !credentials.clientSecret)) || (!!credentials.clientId !== !!credentials.clientSecret))) return toast("请同时填写 Canva 客户端 ID 和客户端密钥。");
      if (app.id === "canva" && !credentials.redirectUri) return toast("请填写 Canva OAuth 回调地址。");
      if (app.id === "figma" && !figmaLocalUrl(credentials.localUrl)) return toast("请填写本机 Figma MCP 地址，例如 http://127.0.0.1:3845/mcp。");
      if (app.id === "autocad" && !credentials.workingDirectory) return toast("请填写专用 CAD 工作目录的绝对路径。");
      if (app.id === "autocad" && credentials.progId && !/^AutoCAD\.Application\.\d+(?:\.\d+)?$/.test(credentials.progId)) return toast("请填写有效的 AutoCAD COM 标识，例如 AutoCAD.Application.25。");
      if (app.id === "comfyui" && !credentials.localUrl) return toast("请填写本机 ComfyUI 地址。");
      if (app.id === "sketchup" && (!/^[1-9]\d{0,4}$/.test(credentials.port) || Number(credentials.port) > 65535)) return toast("请填写 1 至 65535 之间的 SketchUp 扩展端口。");
      void mutate(app, "install", credentials);
    } }];
    dialog(app.name, "应用连接", (body) => {
      const hero = node("div", "app-dialog-summary"); hero.append(appIcon(app.id), node("p", "", app.description)); body.append(hero);
      body.append(node("p", "", app.note));
      const links = node("div", "app-dialog-links"); links.append(external("访问官网 ↗", app.url), external(["google", "oauth"].includes(app.auth) ? "授权配置指南 ↗" : app.auth === "local" ? "MCP 项目说明 ↗" : "获取令牌 ↗", app.help)); body.append(links);
      if (app.id === "photoshop") body.append(node("p", "app-connection-note", "需要本机安装并运行 Photoshop；MCP 是社区开源桥接工具，Photoshop 本体需自行获得授权。纯云端 Web 需要本地连接器，无需填写 API Key。"));
      if (app.id === "comfyui") body.append(node("p", "app-connection-note", "ComfyUI 必须运行在托管 CCAGENT 的同一台电脑上；纯云端部署无法通过浏览器的 localhost 访问你的电脑。无需填写 API Key。"));
      if (app.id === "sketchup") body.append(node("p", "app-connection-note", "需要在托管 CCAGENT 的同一台电脑上安装并打开 SketchUp，再按 MCP 项目说明手动安装 RBZ 扩展。扩展需监听本机回环地址，端口与 MCP 配置一致；纯云端 Web 需要本地连接器。无需填写 API Key。"));
      if (app.id === "figma") body.append(node("p", "app-connection-note", "需要在托管 CCAGENT 的同一台电脑上打开 Figma 桌面版，按官方说明启用本地 MCP。本入口用于读取设计上下文，不提供直接写入云端 Figma 的能力；纯云端 Web 需要本地连接器。无需填写 API Key。"));
      if (app.id === "autocad") body.append(node("p", "app-connection-note", "使用社区 AutoCAD MCP，需要本机 Windows、AutoCAD 和 MCP 运行环境。所有图纸操作请使用专用工作目录；请先用副本验证。添加入口不会安装 AutoCAD，也不会自动执行图纸命令。"));
      if (app.installed) {
        body.append(node("p", "", `连接状态：${status(app)} · 可用工具：${app.tools}`));
        if (app.state === "failed" || app.state === "degraded") body.append(node("p", "app-connection-note", app.auth === "local" ? ["autocad", "figma"].includes(app.id) ? `请检查 ${app.name} 与 MCP 运行环境、本机地址或程序路径及当前账号访问权限，再重新检测。MCP 已连接表示工具服务可用，实际操作结果将在对话中反馈。` : `请检查本机 MCP 是否已准备就绪、${app.name} 是否正在运行，再重新检测；MCP 连接与实机测试会分别显示结果。` : app.auth === "oauth" ? "请点击‘授权连接’并在浏览器中完成授权；若仍无法连接，请检查平台账号权限和网络后重新检测。" : app.auth === "google" ? "请完成浏览器授权。若仍无法连接，请检查 Google 客户端、组织权限或网络后重新检测。" : "请检查令牌权限和网络；如需更换令牌，可卸载后重新连接。"));
        if (app.state === "conflict") body.append(node("p", "app-connection-note", "配置已由其他设置修改或覆盖。请前往 MCP 服务检查，避免删除其他配置。"));
        if (app.id === "photoshop" && app.state !== "conflict") photoshopTesting(body, app);
        if (app.id === "comfyui" && app.state !== "conflict") comfyTesting(body, app);
        if (app.id === "sketchup" && app.state !== "conflict") sketchupTesting(body, app);
      } else {
        if (app.auth === "google") {
          body.append(node("p", "", app.googleConfigured ? "已检测到服务端 Google OAuth 客户端，可直接安装；也可填写自己的客户端。" : "请填写 Google OAuth Web 客户端，重定向 URI 设置为 http://127.0.0.1:53682/oauth/callback。安装后点击‘授权连接’。"));
          input(body, "clientId", "Google Client ID", app.googleConfigured); input(body, "clientSecret", "Google Client Secret", app.googleConfigured);
        } else if (app.auth === "oauth") {
          body.append(node("p", "app-connection-note", app.oauthConfigured ? "已检测到服务端 Canva OAuth 客户端；也可填写自己的客户端。添加后点击‘授权连接’，在浏览器中确认权限。" : "请先在 Canva 开发者平台创建并启用 MCP 应用，将下方回调地址登记到应用中；填写客户端信息后添加入口，再点击‘授权连接’完成浏览器授权。"));
          input(body, "clientId", "Canva Client ID", app.oauthConfigured);
          input(body, "clientSecret", "Canva Client Secret", app.oauthConfigured);
          input(body, "redirectUri", "Canva OAuth 回调地址", false, "text", "http://127.0.0.1:53683/oauth/callback");
        }
        else if (app.auth === "token") input(body, "token", app.tokenLabel);
        else if (app.id === "figma") input(body, "localUrl", "本机 Figma MCP 地址", false, "text", "http://127.0.0.1:3845/mcp");
        else if (app.id === "autocad") {
          input(body, "workingDirectory", "专用 CAD 工作目录绝对路径", false, "text");
          input(body, "progId", "AutoCAD COM 标识", true, "text", "AutoCAD.Application.25");
          input(body, "mcpExecutable", "已安装的 autocad-mcp 可执行文件绝对路径", true, "text");
          body.append(node("p", "app-credential-hint", "AutoCAD 2025 使用 AutoCAD.Application.25，2020 使用 AutoCAD.Application.23.1。请先手动启动对应版本；连接配置关闭自动启动和 Lisp，并限制图纸操作在所选工作目录内。"));
          body.append(node("p", "app-credential-hint", "留空 MCP 路径时使用 uvx 运行固定提交的 autocad-mcp，需要 uv 和 Python 3.11；首次连接可能下载依赖。AutoCAD 本体需另行安装，本机版本兼容性需实机验证。文件导出限所选目录，原生 COM 命令直接操作当前打开的图纸。"));
        }
        else if (app.id === "comfyui") {
          input(body, "localUrl", "本机 ComfyUI 地址", false, "text", "http://127.0.0.1:8188");
          input(body, "mcpExecutable", "已安装的 comfy-mcp 可执行文件绝对路径", true, "text");
          input(body, "comfyExecutable", "comfy CLI 可执行文件绝对路径", true, "text");
          body.append(node("p", "app-credential-hint", "留空 MCP 路径时使用 uvx 运行 comfy-mcp 0.10.0 和 comfy-cli 1.18.0，需要已安装 uv；首次连接可能下载这些工具。可填写已安装的 comfy-mcp 和 comfy CLI 的绝对路径。ComfyUI、模型和工作流由你本机管理。"));
        }
        else if (app.id === "sketchup") {
          input(body, "port", "SketchUp 扩展端口", false, "text", "9876");
          input(body, "mcpExecutable", "已安装的 sketchup-mcp2 可执行文件绝对路径", true, "text");
          body.append(node("p", "app-credential-hint", "留空 MCP 路径时优先复用本机已安装的专用运行环境，否则使用 uvx 运行 sketchup-mcp2 0.4.0。使用 uvx 需要已安装 uv 和 Python 3.10 以上，首次连接可能下载 MCP 工具。端口默认为 9876，可填写已安装的 sketchup-mcp2.exe 绝对路径。安装此入口不会自动安装 SketchUp 的 RBZ 扩展。"));
        }
        body.append(node("p", "app-credential-hint", app.auth === "local" ? ["figma", "autocad"].includes(app.id) ? "添加入口会在当前账号中登记本机 MCP 服务；桌面软件和 MCP 运行环境需按项目说明另行准备。工具调用继续遵循当前权限设置。" : "安装会在当前账号中登记本机 MCP 服务。工具调用继续遵循当前权限设置；安装完成后可单独执行实机测试。" : app.auth === "oauth" ? "授权由对应平台确认，连接配置和客户端凭据保存在当前账号的本机私有配置目录。工具调用继续遵循当前权限设置。" : "凭据仅保存在当前账号的本机私有配置目录，不写入工作文件夹。连接后，工具调用继续遵循当前权限设置。"));
      }
    }, actions);
    if ((photoshopRequestPending && app.id === "photoshop") || (comfyRequestPending && app.id === "comfyui") || (sketchupRequestPending && app.id === "sketchup")) setDialogBusy(true);
  }
  return { render, show, refresh };
}
