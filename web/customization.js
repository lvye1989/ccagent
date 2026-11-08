import { openAccountCenter } from './account-center.js';

const $ = (id) => document.getElementById(id);
function el(tag, cls = "", value = "") { const n = document.createElement(tag); n.className = cls; n.textContent = value; return n; }
function button(label, action, cls = "") { const n = el("button", cls, label); n.type = "button"; n.addEventListener("click", action); return n; }
function field(parent, label, id, value = "", options = {}) {
  const wrap = el("label", "editor-field", label);
  const input = el(options.rows ? "textarea" : options.choices ? "select" : "input");
  input.id = id; input.name = id;
  if (options.choices) for (const [v, text] of options.choices) { const option = el("option", "", text); option.value = v; input.append(option); }
  if (options.rows) input.rows = options.rows;
  else if (!options.choices) input.type = options.type || "text";
  if (options.type === "checkbox") input.checked = Boolean(value); else input.value = value ?? "";
  if (options.placeholder) input.placeholder = options.placeholder;
  if (options.required) input.required = true;
  if (options.disabled) input.disabled = true;
  if (options.type === "password") input.autocomplete = "new-password";
  wrap.append(input); parent.append(wrap); return input;
}
const scopeChoices = [["project", "当前项目"], ["user", "所有工作区"]];

export function createCustomizationUI({ api, toast, navigate, changed, getModel, getSessionId, getBusy }) {
  function addButton(afterId, id, label) { const b = button(label, () => {}, "plugin-add-button"); b.id = id; $(afterId).after(b); }
  addButton("agent-refresh", "agent-create", "＋ 创建 Agent");
  addButton("mcp-refresh", "mcp-add", "＋ 添加 MCP");
  addButton("skill-import", "skill-local-path", "加载技能目录");
  addButton("library-refresh", "library-rag", "外接 RAG 知识库");
  const homeTeamRow = el("div", "home-team-choice"); document.querySelector(".composer-context").after(homeTeamRow);
  for (const [id, parent] of [["home-team", homeTeamRow], ["thread-team", document.querySelector(".thread-context")]]) {
    const wrap = el("label", "context-team", "Agent Team"); const select = el("select"); select.id = id; select.setAttribute("aria-label", id === "home-team" ? "新对话 Agent Team" : "当前对话 Agent Team");
    const off = el("option", "", "不启用团队"); off.value = "off"; select.append(off); wrap.append(select); parent.append(wrap);
  }
  const initialSetting = new URLSearchParams(location.search).get("setting");
  let selectedSettings = ["general", "official", "models", "execution", "import"].includes(initialSetting) ? initialSetting : "general", modalRequest = 0, modalBusy = false, teamsData = { teams: [], enabled: true };
  const request = (resource, body) => api(`/api/customize/${resource}`, body === undefined ? {} : { method: "POST", body: JSON.stringify(body) });
  function close() { if (!modalBusy) { modalRequest++; $("editor-overlay").classList.add("hidden"); } }
  function openDialog(title, subtitle) {
    modalRequest++; modalBusy = false;
    $("editor-title").textContent = title; $("editor-subtitle").textContent = subtitle;
    $("editor-body").replaceChildren(); $("editor-actions").replaceChildren(); $("editor-error").textContent = "";
    $("editor-overlay").classList.remove("hidden");
    return $("editor-body");
  }
  async function action(fn, success, dismiss = false) {
    if (modalBusy) return;
    modalBusy = true;
    const generation = modalRequest;
    $("editor-error").textContent = "";
    $("editor-progress").textContent = "正在处理…";
    $("editor-overlay").setAttribute("aria-busy", "true");
    $("editor-actions").querySelectorAll("button").forEach((b) => b.disabled = true);
    try {
      await fn();
      if (generation !== modalRequest) return;
      if (success) toast(success);
      if (dismiss) $("editor-overlay").classList.add("hidden");
    } catch (error) { if (generation === modalRequest) $("editor-error").textContent = error.message; }
    finally {
      if (generation === modalRequest) {
        modalBusy = false; $("editor-progress").textContent = ""; $("editor-overlay").setAttribute("aria-busy", "false");
        $("editor-actions").querySelectorAll("button").forEach((b) => b.disabled = false);
      }
    }
  }
  function actions(saveLabel, save) { $("editor-actions").append(button("取消", close), button(saveLabel, () => action(save, "配置已保存", true), "primary")); }
  function requirements(body, kind, fill) {
    const box = el("div", "editor-generator");
    const input = field(box, "描述你的需求", "editor-requirements", "", { rows: 3, placeholder: kind === "mcp" ? "粘贴 MCP 配置、服务 URL，或描述需要接入的服务及安装命令" : "例如：负责检索资料、核对来源并撰写中文报告" });
    box.append(button(kind === "mcp" ? "解析并填写配置" : "生成可编辑配置", () => action(async () => {
      const result = await request("draft", { kind, request: input.value, model: getModel() });
      fill(result);
    }, "配置已生成，可继续编辑"), "editor-generate"));
    body.append(box);
  }

  async function agentEditor(agent) {
    const body = openDialog(agent ? `编辑 ${agent.name}` : "创建 Agent", "用自然语言描述需求，再编辑角色说明。保存后 CLI 和 Web 共用此 Agent。");
    let name, description, prompt, tools;
    if (!agent) requirements(body, "agent", (d) => { name.value = d.name || ""; description.value = d.description || ""; prompt.value = d.prompt || ""; tools.value = Array.isArray(d.tools) ? d.tools.join(",") : d.tools || ""; });
    const grid = el("div", "editor-grid"); body.append(grid);
    name = field(grid, "Agent 名称（英文标识）", "edit-agent-name", agent?.name, { disabled: Boolean(agent), placeholder: "researcher" });
    const scope = field(grid, "保存范围", "edit-agent-scope", agent?.source || "project", { choices: scopeChoices, disabled: Boolean(agent) });
    description = field(body, "使用场景", "edit-agent-description", agent?.description, { rows: 2 });
    prompt = field(body, "角色与工作要求", "edit-agent-prompt", agent?.prompt, { rows: 7 });
    const advanced = el("details", "editor-advanced"); advanced.append(el("summary", "", "高级选项")); body.append(advanced);
    tools = field(advanced, "工具（逗号分隔，留空继承）", "edit-agent-tools", agent?.tools?.join(",") || "", { placeholder: "Read,Glob,Grep,WebSearch,KnowledgeSearch" });
    const model = field(advanced, "模型配置 ID（留空继承对话模型）", "edit-agent-model", agent?.model || "");
    actions("保存 Agent", async () => {
      await request("agents", { name: name.value, scope: scope.value, description: description.value, prompt: prompt.value, tools: tools.value, model: model.value, edit: Boolean(agent) });
      await changed("agents");
    });
  }

  function mcpEditor() {
    const body = openDialog("添加 MCP", "输入服务信息，核对配置后点击添加。程序会保存并连接服务。");
    let name, config;
    requirements(body, "mcp", (d) => { name.value = d.name || ""; config.value = JSON.stringify(d.config, null, 2); });
    name = field(body, "服务名称", "edit-mcp-name", "", { placeholder: "my-mcp" });
    config = field(body, "MCP 配置（JSON）", "edit-mcp-config", "", { rows: 9, placeholder: '{"type":"http","url":"https://example.com/mcp"}' });
    const note = el("p", "editor-hint", "支持 stdio、Streamable HTTP 和 SSE。stdio 配置会启动 command 对应的本机程序；添加前请核对命令和参数。"); body.append(note);
    actions("添加并连接", async () => {
      let parsed; try { parsed = JSON.parse(config.value); } catch { throw new Error("MCP 配置需要有效的 JSON。"); }
      await request("mcp", { name: name.value, config: parsed }); await changed("mcp");
    });
  }

  function localSkillEditor() {
    const body = openDialog("加载本地技能", "导入完整技能目录，会保留 scripts、references 等附属文件。");
    const path = field(body, "本地技能目录或 SKILL.md 路径", "edit-skill-path", "", { placeholder: "C:\\path\\to\\my-skill" });
    const scope = field(body, "保存范围", "edit-skill-scope", "project", { choices: scopeChoices });
    body.append(el("p", "editor-hint", "导入后可在技能列表中启用或关闭。已有同名技能不会被覆盖。"));
    actions("导入完整技能", async () => { await request("local-skill", { path: path.value, scope: scope.value }); await changed("skills"); });
  }

  async function modelEditor(profile) {
    const body = openDialog(profile ? `编辑 ${profile.id}` : "接入大模型", "保存后模型会出现在首页与对话的模型列表。密钥不会回显到浏览器。");
    const grid = el("div", "editor-grid"); body.append(grid);
    const id = field(grid, "配置名称", "edit-model-id", profile?.id, { disabled: Boolean(profile), placeholder: "my-model" });
    const protocol = field(grid, "API 协议", "edit-model-protocol", profile?.protocol || "openai-chat", { choices: [["openai-chat", "OpenAI 兼容 Chat Completions"], ["openai-responses", "OpenAI 兼容 Responses"], ["anthropic", "Anthropic 兼容 Messages"], ["gemini", "Gemini"]] });
    const url = field(body, "API 地址", "edit-model-url", profile?.baseURL, { placeholder: "https://your-provider.example/v1" });
    const model = field(body, "模型名称", "edit-model-name", profile?.model, { placeholder: "服务商提供的模型名称" });
    const key = field(body, "API 密钥", "edit-model-key", "", { type: "password", placeholder: profile?.hasKey ? "已配置，留空保留原密钥" : "输入密钥；本地免密服务可留空" });
    const advanced = el("details", "editor-advanced"); advanced.append(el("summary", "", "Token 限制")); body.append(advanced);
    const maxTokens = field(advanced, "最大输出 Token", "edit-model-max", profile?.maxTokens || "", { type: "number" });
    const contextWindow = field(advanced, "上下文窗口 Token", "edit-model-context", profile?.contextWindow || "", { type: "number" });
    const makeDefault = field(body, "设为新对话的默认模型", "edit-model-default", !profile, { type: "checkbox" });
    actions("保存模型", async () => {
      await request("models", { id: id.value, protocol: protocol.value, baseURL: url.value, model: model.value, apiKey: key.value, maxTokens: maxTokens.value, contextWindow: contextWindow.value, makeDefault: makeDefault.checked });
      key.value = ""; await changed("models"); await renderSettings();
    });
  }

  let settingsRevision = 0, settingsQueue = Promise.resolve();
  function renderSettings() {
    const revision = ++settingsRevision;
    const render = settingsQueue.then(() => revision === settingsRevision ? renderSettingsContent() : undefined);
    settingsQueue = render.catch(() => {});
    return render;
  }
  async function renderSettingsContent() {
    const url = new URL(location.href); url.searchParams.set("setting", selectedSettings); history.replaceState({}, "", url);
    const root = $("settings-content"); root.replaceChildren(el("p", "editor-hint", "正在读取设置…"));
    try {
      const data = await request("settings");
      root.replaceChildren();
      const head = el("header", "settings-head"); head.append(el("div", "page-eyebrow", "PREFERENCES"), el("h1", "", selectedSettings === "import" ? "导入原有数据" : selectedSettings === "official" ? "CCAGENT 官方服务" : selectedSettings === "models" ? "模型接入" : selectedSettings === "execution" ? "权限与执行" : "通用设置"));
      root.append(head);
      $("settings-nav").querySelectorAll("button").forEach((b) => b.classList.toggle("selected", b.dataset.setting === selectedSettings));
      if (selectedSettings === "import") { await renderLegacyImport(root); return; }
      if (selectedSettings === "official") {
        const service = await request("official-services");
        const form = el("form", "settings-form");
        const money = value => { try { const amount = BigInt(value); return `${amount / 1000000n}.${(amount % 1000000n).toString().padStart(6, "0").slice(0, 4)}`; } catch { return "—"; } };
        if (service.wallet) form.append(el("p", "editor-hint", `余额 ¥${money(service.wallet.available ?? service.wallet.balance)} · 冻结 ¥${money(service.wallet.frozen)}`));
        const links = el("div", "settings-row-actions");
        for (const [label, route] of [["余额与充值", "/account/billing"], ["创建管理平台APIkey", "/account/keys"]]) {
          const link = el("a", "settings-secondary", label); link.href = new URL(route, service.origin).href; link.target = "_blank"; link.rel = "noopener noreferrer"; links.append(link);
          const open = event => {
            if (event.type === 'auxclick' && event.button !== 1) return;
            event.preventDefault();
            void openAccountCenter({ origin: service.origin, target: route }).catch(error => toast(error.message));
          };
          link.addEventListener('click', open); link.addEventListener('auxclick', open);
        }
        form.append(links);
        if (!service.configured) form.append(el("p", "editor-hint", "首次连接会创建应用专用 API Key。"));
        const keyOptions = el("details", "editor-advanced");
        keyOptions.append(el("summary", "", "使用已有 API Key"));
        const key = field(keyOptions, "平台 API Key", "official-api-key", "", { type: "password", placeholder: service.configured ? "已连接，留空保留" : "粘贴已有的平台 API Key" });
        form.append(keyOptions);
        const selections = {};
        if (service.routes.length) {
          for (const [role, label, kind] of [["main", "主模型", "chat"], ["image", "读图", "vision"], ["decision", "Jev 决策", "decision"], ["search", "联网搜索", "search"], ["voice", "语音合成", "voice"]]) {
            selections[role] = field(form, label, `official-role-${role}`, service.roles[role] || "", { choices: [["", "未选择"], ...service.routes.filter(item => item.service === kind).map(item => [item.id, `${item.name} · ${item.protocol}`])] });
          }
        } else if (service.configured) form.append(el("p", "editor-hint", "暂无已开放且价格配置完整的服务，请联系管理员。"));
        const auxiliary = field(form, "读图、决策、搜索和语音使用所选官方服务", "official-auxiliary", service.auxiliaryEnabled, { type: "checkbox" });
        const makeDefault = field(form, "将所选官方主模型设为新对话的默认模型", "official-default", false, { type: "checkbox" });
        auxiliary.disabled = makeDefault.disabled = !service.configured;
        const save = el("button", "settings-primary", service.configured ? "保存选择并刷新目录" : "连接官方服务"); save.type = "submit"; form.append(save);
        form.addEventListener("submit", async event => {
          event.preventDefault(); save.disabled = true;
          try {
            const roles = Object.fromEntries(Object.entries(selections).filter(([, input]) => input.value).map(([role, input]) => [role, input.value]));
            await request("official-services", { ...(!service.configured && !key.value.trim() ? { op: "connect" } : { apiKey: key.value }), ...(service.configured ? { roles, auxiliaryEnabled: auxiliary.checked, makeDefault: makeDefault.checked,
              fallbackEnabled: false, catalogRevision: service.catalogRevision } : { fallbackEnabled: false }) });
            key.value = ""; await changed("models"); await renderSettings(); toast("官方服务配置已保存");
          } catch (error) { toast(error.message); } finally { save.disabled = false; }
        });
        if (service.configured) form.append(button("刷新服务目录", async () => { await request("official-services", { fallbackEnabled: false }); await changed("models"); await renderSettings(); toast("目录已刷新，停止提供的服务已取消选择"); }, "settings-secondary"), button("移除 Key 并停用官方辅助服务", async () => { await request("official-services", { op: "forget" }); key.value = ""; await changed("models"); await renderSettings(); toast("本机 Key 已移除，云端 Key 可在用户中心撤销"); }, "settings-secondary"));
        root.append(form);
        for (const route of service.routes) {
          const row = el("article", "settings-row"), copy = el("div");
          copy.append(el("strong", "", route.name), el("p", "", `${route.id} · 价格 v${route.pricing.version}`));
          const labels = { input_tokens: "输入 Token", cached_input_tokens: "缓存输入 Token", output_tokens: "输出 Token", audio_input_tokens: "音频输入 Token", audio_output_tokens: "音频输出 Token", input_characters: "输入字符", requests: "次请求", search_credits: "搜索 credit" };
          const policy = route.pricing.definition.tariff;
          if (policy.kind === "qwen-input-tiers") copy.append(el("p", "editor-hint", `按整次输入总量（含缓存）选择档位；默认${policy.defaultThinking ? "开启" : "关闭"}思考；预算计入最大思考长度 ${policy.maxThinkingTokens} Token。`));
          for (const rate of route.pricing.definition.rates || []) {
            if (Array.isArray(rate.tiers)) for (const [index, tier] of rate.tiers.entries()) copy.append(el("p", "editor-hint", `输入 ${index ? rate.tiers[index - 1].upToInputTokens : 0} < Token ≤ ${tier.upToInputTokens}，每 ${rate.unitQuantity} ${labels[rate.metric] || rate.metric}：${route.pricing.currency} ${tier.price}${tier.thinkingPrice !== undefined ? `（思考 ${tier.thinkingPrice}）` : ""}`));
            else copy.append(el("p", "editor-hint", `每 ${rate.unitQuantity} ${labels[rate.metric] || rate.metric}：${route.pricing.currency} ${rate.price}${rate.offPeakPrice !== undefined ? `（低峰 ${rate.offPeakPrice}）` : ""}`));
          }
          copy.append(el("p", "editor-hint", `收费倍率 1.3${route.pricing.currency === "USD" ? ` · 结算汇率 ${route.pricing.usdCny} 元/美元` : ""}；最终按实际用量结算并释放未使用的冻结额度。`));
          const source = el("a", "settings-secondary", "供应商公开价格"); source.href = route.pricing.sourceUrl; source.target = "_blank"; source.rel = "noopener noreferrer"; copy.append(source);
          row.append(copy); root.append(row);
        }
        return;
      }
      if (selectedSettings === "models") {
        const models = await request("models");
        head.append(el("p", "editor-hint", "所有已配置模型与 CLI 共享。"), button("＋ 接入大模型", () => modelEditor(), "settings-primary"));
        if (!models.models.length) root.append(el("p", "settings-empty", "还没有模型，点击接入大模型开始。"));
        for (const item of models.models) {
          const row = el("article", "settings-row");
          const copy = el("div"); copy.append(el("strong", "", item.id + (item.id === data.defaultModel ? " · 默认" : "")), el("p", "", `${item.model} · ${item.protocol}`), el("small", "", `${item.baseURL || "协议默认地址"} · ${item.hasKey ? "密钥已配置" : "未配置密钥"}`));
          const controls = el("div", "settings-row-actions");
          if (item.setupRequired) copy.append(el("p", "editor-hint", "从旧数据导入，需补全地址或凭据后保存启用。"));
          controls.append(item.managedByPlatform ? button("官方服务设置", () => { selectedSettings = "official"; void renderSettings(); }) : button("编辑", () => modelEditor(item)));
          if (!item.setupRequired) controls.append(button("测试连接", async (event) => {
            const b = event.currentTarget; b.disabled = true; b.textContent = "测试中…";
            try { const result = await request("model-test", { id: item.id }); toast(`连接成功：${result.reply}`); }
            catch (error) { toast(error.message); }
            finally { b.disabled = false; b.textContent = "测试连接"; }
          }));
          row.append(copy, controls); root.append(row);
        }
        return;
      }
      const form = el("form", "settings-form"); const settings = data.settings;
      let language, thinking, effort, retention, motion, mode;
      if (selectedSettings === "general") {
        language = field(form, "回答语言", "settings-language", settings.language || "中文");
        retention = field(form, "聊天记录保留天数（0 关闭持久化）", "settings-retention", settings.cleanupPeriodDays ?? 30, { type: "number" });
        motion = field(form, "减少动态效果", "settings-motion", settings.prefersReducedMotion ?? false, { type: "checkbox" });
      } else {
        mode = field(form, "新对话的默认权限", "settings-mode", settings.mode || "default", { choices: [["default", "默认：工具执行按规则确认"], ["plan", "计划：先分析并制定方案"], ["auto", "自动：使用现有自动审批"], ["full", "完全访问权益"]] });
        thinking = field(form, "启用模型思考", "settings-thinking", settings.alwaysThinkingEnabled ?? false, { type: "checkbox" });
        effort = field(form, "思考强度", "settings-effort", settings.effortLevel || "high", { choices: [["low", "低"], ["medium", "中"], ["high", "高"], ["max", "最高"]] });
        form.append(el("p", "editor-hint", "权限默认值用于新对话；现有对话可在输入框旁单独修改。模型对思考参数的支持取决于服务商。"));
      }
      const save = el("button", "settings-primary", "保存设置"); save.type = "submit"; form.append(save);
      form.addEventListener("submit", async (event) => {
        event.preventDefault(); save.disabled = true;
        try {
          await request("settings", selectedSettings === "general" ? { language: language.value, cleanupPeriodDays: Number(retention.value), prefersReducedMotion: motion.checked } : { mode: mode.value, alwaysThinkingEnabled: thinking.checked, effortLevel: effort.value });
          await changed("settings"); toast("设置已保存");
        } catch (error) { toast(error.message); } finally { save.disabled = false; }
      });
      root.append(form, el("p", "settings-path", `用户配置：${data.settingsPath}`));
    } catch (error) { root.replaceChildren(el("p", "editor-error", error.message)); }
  }

  async function renderLegacyImport(root) {
    const defaults = await request("legacy-source"), labels = { configuration: "偏好、模型、MCP 与 RAG 配置", history: "会话、记忆、任务与文件历史", extensions: "Agent、Skill、命令与 Rhino 定义", credentials: "个人供应商凭据与 Google / MCP 授权" };
    const form = el("form", "settings-form"), review = el("div", "settings-form"), status = el("p", "editor-hint"); status.setAttribute("role", "status");
    form.append(el("p", "editor-hint", "先扫描来源并核对类别，再复制到当前账户。原文件保留，当前同名文件与配置优先。工作区中的项目文件继续保存在原位置。"));
    const source = field(form, "原 CCAGENT 数据目录", "import-source", defaults.source);
    const scan = el("button", "settings-primary", "扫描并预览"); scan.type = "submit"; form.append(scan); root.append(form, review, status);
    form.addEventListener("submit", async event => {
      event.preventDefault(); scan.disabled = true; status.textContent = "正在扫描文件目录…"; review.replaceChildren();
      try {
        const preview = await request("legacy-preview", { source: source.value });
        status.textContent = "预览已生成，请核对来源与当前账户。";
        review.append(el("p", "settings-path", `来源：${preview.source}`), el("p", "settings-path", `目标：${preview.destination}`));
        const choices = {}, environment = [];
        for (const item of preview.categories) {
          choices[item.id] = field(review, `${labels[item.id]} · ${item.files} 个文件 · ${(item.bytes / 1048576).toFixed(2)} MiB`, "import-" + item.id, item.id !== "credentials" && item.files > 0 && !(item.id === "configuration" && preview.configurationError), { type: "checkbox" });
          choices[item.id].disabled = !item.files || (item.id === "configuration" && preview.configurationError);
        }
        if (preview.configurationError) review.append(el("p", "editor-hint", "来源 settings.json 需修复；仍可选择其他类别。"));
        if (preview.canonicalEnvironmentMissing) review.append(el("p", "editor-hint", "来源指定的凭据文件缺失或不可用，依赖它的模型会保持待补全；不会改用其他文件中的旧 Key。"));
        if (preview.environmentFiles.length) {
          review.append(el("p", "editor-hint", "选择凭据类别后会读取原目录中的环境文件。引用的外部文件须逐项勾选，值不会显示在预览中。"));
          for (const file of preview.environmentFiles) {
            if (file.external) environment.push([file.id, field(review, file.path, "import-env-" + file.id, false, { type: "checkbox" })]);
            else review.append(el("p", "settings-path", file.path));
          }
        }
        review.append(el("p", "editor-hint", `跳过 ${preview.skippedLinks} 个链接、${preview.skippedCaches} 个缓存目录。来源中的 ${preview.executionFields} 项执行权限/脚本设置保留在原处，导入后需复核；定时任务暂停，新扩展关闭。`));
        const enableHistory = preview.historyDisabled ? field(review, "开启 30 天会话保存，以保留导入的历史", "import-enable-history", false, { type: "checkbox" }) : null;
        const owned = field(review, "确认这些原有数据属于当前登录账户", "import-owned", false, { type: "checkbox" });
        const apply = el("button", "settings-primary", "复制到当前账户"); apply.type = "button"; apply.disabled = true; review.append(apply);
        const eligible = () => { apply.disabled = !owned.checked || !Object.values(choices).some(input => input.checked); };
        owned.addEventListener("change", eligible); Object.values(choices).forEach(input => input.addEventListener("change", eligible));
        apply.addEventListener("click", async () => {
          if (getBusy()) { status.textContent = "请先等待当前任务结束。"; return; }
          apply.disabled = true; scan.disabled = true; status.textContent = "正在复制并保存到当前账户，请保持应用开启…";
          try {
            const report = await request("legacy-import", { id: preview.id, confirmOwned: owned.checked, categories: Object.entries(choices).filter(([, input]) => input.checked).map(([id]) => id), environmentFiles: environment.filter(([, input]) => input.checked).map(([id]) => id), enableHistory: Boolean(enableHistory?.checked) });
            status.textContent = `${report.state === "complete" ? "导入完成" : "导入尚未全部完成"}：复制 ${report.copied} 个文件/记录，新增 ${report.settingsAdded} 项配置，保留 ${report.conflicts} 项同名内容；${report.missingCredentials} 项凭据待补全。${report.restartRequired ? "请重新打开应用以完整加载配置和授权。" : "可刷新会话列表查看。"}`;
            review.replaceChildren(); await changed("models"); await changed("settings"); await changed("history");
          } catch (error) { status.textContent = error.message; eligible(); }
          finally { scan.disabled = false; }
        });
      } catch (error) { status.textContent = error.message; }
      finally { scan.disabled = false; }
    });
  }

  async function refreshTeams() {
    teamsData = await request("teams");
    for (const id of ["home-team", "thread-team"]) {
      const select = $(id); const selected = select.value || "off";
      select.replaceChildren();
      const choices = [["off", "不启用团队"], ...(teamsData.enabled ? [["auto", "根据任务自动组队"], ...teamsData.teams.filter((t) => t.enabled).map((t) => [t.id, t.name])] : [])];
      for (const [value, label] of choices) { const option = el("option", "", label); option.value = value; select.append(option); }
      if (!choices.some(([v]) => v === selected) && selected !== "off" && id === "thread-team") { const option = el("option", "", "原团队已关闭"); option.value = selected; option.disabled = true; select.append(option); }
      select.value = choices.some(([v]) => v === selected) || id === "thread-team" ? selected : "off";
    }
    if ($("teams-view").classList.contains("hidden")) return;
    $("teams-status").textContent = teamsData.enabled ? "Agent Teams 已启用" : "Agent Teams 已关闭";
    $("teams-global").textContent = teamsData.enabled ? "关闭 Agent Teams" : "启用 Agent Teams";
    const list = $("teams-list"); list.replaceChildren();
    if (teamsData.activeTeam) list.append(el("p", "editor-hint", `当前运行团队：${teamsData.activeTeam}`));
    if (!teamsData.teams.length) list.append(el("p", "settings-empty", "创建角色团队，或在首页选择“根据任务自动组队”。"));
    for (const team of teamsData.teams) {
      const row = el("article", "team-card");
      row.append(el("h2", "", team.name), el("p", "", team.description));
      const tags = el("div", "team-roles"); for (const role of team.roles) tags.append(el("span", "", role.name)); row.append(tags);
      const footer = el("div", "settings-row-actions"); footer.append(el("span", "editor-hint", team.enabled ? "已启用" : "已关闭"), button("编辑角色", () => teamEditor(team)), button(team.enabled ? "关闭" : "启用", async () => {
        try { await request("teams", { op: "state", id: team.id, enabled: !team.enabled }); await refreshTeams(); } catch (error) { toast(error.message); }
      }));
      if (team.enabled && teamsData.enabled) footer.append(button("用于新对话", () => { $("home-team").value = team.id; navigate("tasks"); $("home-input").focus(); }));
      row.append(footer); list.append(row);
    }
  }

  async function teamEditor(team) {
    const agents = (await api("/api/agents")).agents;
    const body = openDialog(team ? `编辑 ${team.name}` : "创建 Agent Team", "手动编辑各个角色，或描述任务，让模型先组成团队。保存配置后可在首页启用。");
    let id, name, description; const roles = el("div", "team-role-editor");
    function addRole(role = {}) {
      const row = el("div", "team-role-row");
      field(row, "角色名称（英文标识）", `role-name-${roles.children.length}-${Date.now()}`, role.name || "");
      field(row, "执行 Agent", `role-agent-${roles.children.length}-${Date.now()}`, role.agentType || "general-purpose", { choices: agents.filter((a) => a.enabled).map((a) => [a.name, a.name]) });
      field(row, "角色职责", `role-prompt-${roles.children.length}-${Date.now()}`, role.prompt || "", { rows: 3 });
      row.append(button("移除此角色", () => row.remove(), "editor-remove")); roles.append(row);
    }
    if (!team) requirements(body, "team", (d) => { id.value = d.id || ""; name.value = d.name || ""; description.value = d.description || ""; roles.replaceChildren(); for (const role of d.roles || []) addRole(role); });
    const grid = el("div", "editor-grid"); body.append(grid);
    id = field(grid, "团队标识", "edit-team-id", team?.id, { disabled: Boolean(team), placeholder: "research-team" });
    name = field(grid, "团队名称", "edit-team-name", team?.name, { placeholder: "研究与核验团队" });
    description = field(body, "团队任务", "edit-team-description", team?.description, { rows: 2 });
    body.append(el("h3", "", "团队角色"), roles, button("＋ 添加角色", () => addRole(), "editor-generate"));
    for (const role of team?.roles || [{}]) addRole(role);
    actions("保存团队", async () => {
      const values = [...roles.children].map((row) => { const fields = row.querySelectorAll("input,select,textarea"); return { name: fields[0].value, agentType: fields[1].value, prompt: fields[2].value }; });
      await request("teams", { id: id.value, name: name.value, description: description.value, roles: values, edit: Boolean(team) }); await refreshTeams();
    });
  }

  async function ragManager() {
    const data = await request("rag");
    const body = openDialog("外接 RAG 知识库", "配置检索端口后，对话可通过 KnowledgeSearch 检索来源片段。");
    body.append(el("p", "editor-hint", "通用接口：POST { query, topK, collection? }，返回 { results: [{ text, source?, title?, score? }] }。可通过适配服务连接现有知识库。"));
    for (const c of data.connections) {
      const row = el("article", "rag-row");
      row.append(el("strong", "", `${c.name} · ${c.enabled ? "已启用" : "已关闭"}`), el("small", "", c.url));
      const controls = el("div", "settings-row-actions"); controls.append(button("编辑", () => ragEditor(c)), button(c.enabled ? "关闭" : "启用", () => action(async () => { await request("rag", { op: "state", id: c.id, enabled: !c.enabled }); modalBusy = false; await ragManager(); })), button("测试检索", () => ragTest(c))); row.append(controls); body.append(row);
    }
    if (!data.connections.length) body.append(el("p", "settings-empty", "还没有知识库连接。"));
    $("editor-actions").append(button("关闭", close), button("＋ 添加知识库", () => ragEditor(), "primary"));
  }
  function ragEditor(c) {
    const body = openDialog(c ? `编辑 ${c.name}` : "添加知识库连接", "填写你自己的检索 API。密钥仅在本机保存。");
    const id = field(body, "连接标识", "edit-rag-id", c?.id || "", { disabled: Boolean(c) });
    const name = field(body, "知识库名称", "edit-rag-name", c?.name || "");
    const url = field(body, "检索端口 URL", "edit-rag-url", c?.url || "", { placeholder: "http://127.0.0.1:8000/retrieve" });
    const key = field(body, "API 密钥（Bearer，可选）", "edit-rag-key", "", { type: "password", placeholder: c?.hasKey ? "留空保留原密钥" : "" });
    const collection = field(body, "集合标识（可选）", "edit-rag-collection", c?.collection || "");
    const topK = field(body, "每次返回片段数（1–20）", "edit-rag-topk", c?.topK || 5, { type: "number" });
    actions("保存知识库", async () => { await request("rag", { id: id.value, name: name.value, url: url.value, apiKey: key.value, collection: collection.value, topK: Number(topK.value) }); key.value = ""; });
  }
  function ragTest(c) {
    const body = openDialog(`测试检索 · ${c.name}`, "输入查询，查看端口实际返回的片段。");
    const query = field(body, "检索问题", "rag-test-query", "", { rows: 2 });
    const results = el("div", "rag-test-results"); body.append(results);
    $("editor-actions").append(button("返回", ragManager), button("检索", () => action(async () => {
      const response = await request("rag", { op: "search", id: c.id, query: query.value }); results.replaceChildren();
      for (const doc of response.documents) { const row = el("article", "rag-row"); row.append(el("strong", "", doc.title || doc.source || "来源片段"), el("p", "", doc.text)); results.append(row); }
      if (!response.documents.length) results.append(el("p", "", "本次检索没有返回片段。"));
    }), "primary"));
  }

  $("editor-close").addEventListener("click", close);
  $("editor-overlay").addEventListener("click", (event) => { if (event.target === $("editor-overlay")) close(); });
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") close(); });
  $("agent-create").addEventListener("click", () => agentEditor());
  $("mcp-add").addEventListener("click", mcpEditor);
  $("skill-local-path").addEventListener("click", localSkillEditor);
  $("teams-create").addEventListener("click", () => teamEditor().catch((e) => toast(e.message)));
  $("teams-global").addEventListener("click", async () => { try { await request("teams", { op: "global", enabled: !teamsData.enabled }); await refreshTeams(); } catch (error) { toast(error.message); } });
  $("library-rag").addEventListener("click", () => ragManager().catch((e) => toast(e.message)));
  $("settings-nav").querySelectorAll("button").forEach((b) => b.addEventListener("click", () => { selectedSettings = b.dataset.setting; void renderSettings(); }));
  $("thread-team").addEventListener("change", async (event) => {
    if (getBusy() || !getSessionId()) return;
    try { await api(`/api/sessions/${getSessionId()}/team`, { method: "POST", body: JSON.stringify({ team: event.target.value }) }); toast("当前对话的团队设置已更新"); }
    catch (error) { toast(error.message); await changed("session"); }
  });
  let currentEffort = "", effortBusy = false;
  async function refreshPreferences({ preserveMode = false } = {}) {
    const data = await request("settings");
    if (!preserveMode) $("home-mode").value = data.settings.mode || "default";
    currentEffort = data.settings.effortLevel || "";
    for (const id of ["home-effort", "thread-effort"]) $(id).value = currentEffort;
    document.body.classList.toggle("reduce-motion", data.settings.prefersReducedMotion === true);
  }
  for (const id of ["home-effort", "thread-effort"]) $(id).addEventListener("change", async (event) => {
    if (effortBusy || getBusy()) { event.target.value = currentEffort; return; }
    effortBusy = true;
    for (const selectId of ["home-effort", "thread-effort"]) $(selectId).disabled = true;
    try { await request("settings", { effortLevel: event.target.value }); await refreshPreferences({ preserveMode: true }); }
    catch (error) { for (const selectId of ["home-effort", "thread-effort"]) $(selectId).value = currentEffort; toast(error.message); }
    finally { effortBusy = false; for (const selectId of ["home-effort", "thread-effort"]) $(selectId).disabled = getBusy(); }
  });
  return { agentEditor, refreshTeams, refreshPreferences, openOfficial() { selectedSettings = "official"; navigate("settings"); }, open: async (view) => { if (view === "settings") await renderSettings(); else if (view === "teams") await refreshTeams(); }, setSessionTeam: (team) => {
    const select = $("thread-team");
    if (team && ![...select.options].some((o) => o.value === team)) { const option = el("option", "", "原团队已关闭"); option.value = team; option.disabled = true; select.append(option); }
    select.value = team || "off";
  }, syncBusy: (busy) => { $("thread-team").disabled = busy; } };
}
