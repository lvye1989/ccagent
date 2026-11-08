function element(tag, className = "", text) { const node = document.createElement(tag); node.className = className; if (text !== undefined) node.textContent = text; return node; }
function button(label, action, className = "whiteboard-ai-button") { const node = element("button", className, label); node.type = "button"; node.addEventListener("click", action); return node; }
const sameBoard = (a, b) => Boolean(a && b && a.workspace === b.workspace && a.id === b.id && a.token === b.token);

/** Keep reciprocal references consistent while retaining text bindings and geometry. */
export function reconcileWhiteboardBindings(elements, deleteIds, updateElement) {
  const deleted = new Set(deleteIds), live = new Map(elements.filter((item) => !item.isDeleted && !deleted.has(item.id)).map((item) => [item.id, item]));
  const references = new Map();
  for (const arrow of live.values()) if (arrow.type === "arrow") {
    for (const target of new Set([arrow.startBinding?.elementId, arrow.endBinding?.elementId])) {
      if (!target || !live.has(target)) continue;
      if (!references.has(target)) references.set(target, []); references.get(target).push({ id: arrow.id, type: "arrow" });
    }
  }
  return elements.map((item) => {
    if (item.isDeleted) return item;
    const changes = {}, bound = item.boundElements || [], text = bound.filter((value) => value.type !== "arrow" && !deleted.has(value.id));
    const arrows = bound.filter((value) => value.type === "arrow"), expected = references.get(item.id) || [], expectedIds = new Set(expected.map((value) => value.id));
    if (arrows.length !== expected.length || new Set(arrows.map((value) => value.id)).size !== expectedIds.size || arrows.some((value) => !expectedIds.has(value.id)) || text.length + arrows.length !== bound.length) changes.boundElements = text.length + expected.length ? [...text, ...expected] : null;
    if (item.startBinding && deleted.has(item.startBinding.elementId)) changes.startBinding = null;
    if (item.endBinding && deleted.has(item.endBinding.elementId)) changes.endBinding = null;
    if (item.containerId && deleted.has(item.containerId)) changes.containerId = null;
    if (item.frameId && deleted.has(item.frameId)) changes.frameId = null;
    return Object.keys(changes).length ? updateElement(item, changes) : item;
  });
}

export function createWhiteboardAI({ api, toast, host, getContext, applyDrawing, undoDrawing }) {
  const state = { expanded: window.innerWidth > 850, context: null, models: [], modelsLoaded: false, defaultModel: undefined, model: "", conversationId: undefined, messages: [], run: null, generation: 0, starting: false, applying: false, undo: null, lastPrompt: "", error: "", phase: "", timer: null, startTask: null, leaving: 0 };
  host.classList.add("whiteboard-ai"); host.id = "whiteboard-ai";
  const collapsed = button("✦", () => toggle(true), "whiteboard-ai-collapsed"); collapsed.title = "打开 AI 绘图助手"; collapsed.setAttribute("aria-label", "打开 AI 绘图助手");
  const panel = element("aside", "whiteboard-ai-panel"); panel.setAttribute("aria-label", "AI 绘图助手");
  const header = element("header", "whiteboard-ai-header"); const identity = element("div"); identity.append(element("strong", "", "✦ AI 绘图助手"), element("small", "", "描述想法，让 Agent 帮你画出来"));
  const fresh = button("新对话", () => {
    if (state.starting || state.run || state.applying || state.leaving) return;
    state.conversationId = undefined; state.messages = []; state.undo = null; state.lastPrompt = ""; state.error = ""; state.phase = "";
    input.value = ""; render(); input.focus();
  }); fresh.id = "whiteboard-ai-new-chat"; fresh.setAttribute("aria-label", "开始新的绘图对话");
  const close = button("×", () => toggle(false), "whiteboard-ai-close"); close.setAttribute("aria-label", "收起 AI 绘图助手"); header.append(identity, fresh, close);
  const models = element("label", "whiteboard-ai-model"); models.append(element("span", "", "模型")); const modelSelect = element("select"); modelSelect.id = "whiteboard-ai-model"; modelSelect.setAttribute("aria-label", "绘图模型"); models.append(modelSelect);
  modelSelect.addEventListener("change", () => { if (state.run || state.starting || state.applying || state.leaving) return; state.model = modelSelect.value; state.conversationId = undefined; state.messages = []; state.phase = "已切换模型，下一次绘图将从当前画布开始。"; render(); });
  const history = element("div", "whiteboard-ai-history"); history.id = "whiteboard-ai-history"; history.setAttribute("role", "log"); history.setAttribute("aria-live", "polite"); history.setAttribute("aria-relevant", "additions text");
  const status = element("p", "whiteboard-ai-status"); status.id = "whiteboard-ai-status"; status.setAttribute("role", "status");
  const recovery = element("div", "whiteboard-ai-recovery");
  const form = element("form", "whiteboard-ai-composer"); const input = element("textarea"); input.id = "whiteboard-ai-input"; input.rows = 3; input.maxLength = 6000; input.placeholder = "例如：画一个项目审批流程图，包含申请、审核和归档"; input.setAttribute("aria-label", "描述你希望绘制或修改的内容");
  input.addEventListener("keydown", (event) => { if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); void start(input.value); } });
  const footer = element("div", "whiteboard-ai-composer-footer"); footer.append(element("small", "", "Enter 发送 · Shift+Enter 换行"));
  const send = button("发送", () => void start(input.value), "whiteboard-ai-button primary"); send.id = "whiteboard-ai-send";
  const stop = button("停止", () => void stopRun(), "whiteboard-ai-button stop"); stop.id = "whiteboard-ai-stop"; footer.append(send, stop); form.append(input, footer);
  form.addEventListener("submit", (event) => { event.preventDefault(); void start(input.value); });
  panel.append(header, models, history, status, recovery, form); host.append(collapsed, panel);

  function active(generation, run) { return generation === state.generation && state.run === run && sameBoard(run.context, state.context); }
  function render() {
    host.classList.toggle("collapsed", !state.expanded); collapsed.setAttribute("aria-expanded", String(state.expanded)); panel.classList.toggle("hidden", !state.expanded); collapsed.classList.toggle("hidden", state.expanded);
    const selected = state.model; modelSelect.replaceChildren(); const inherited = element("option", "", "应用默认模型"); inherited.value = ""; modelSelect.append(inherited);
    for (const model of state.models) { const option = element("option", "", model.label || model.id); option.value = model.id; option.disabled = model.available === false; modelSelect.append(option); } modelSelect.value = selected;
    const busy = state.starting || Boolean(state.run) || state.applying || state.leaving > 0;
    modelSelect.disabled = busy; fresh.disabled = busy; input.disabled = busy || !state.context?.id;
    send.disabled = busy || !state.context?.id || (state.modelsLoaded && !state.models.some((model) => model.available !== false)); send.classList.toggle("hidden", Boolean(state.run));
    stop.classList.toggle("hidden", !state.run); stop.disabled = !state.run || state.run.cancelled || state.applying;
    const stayAtBottom = history.scrollHeight - history.scrollTop - history.clientHeight < 70; history.replaceChildren();
    if (!state.messages.length) {
      const intro = element("div", "whiteboard-ai-intro"); intro.append(element("span", "whiteboard-ai-spark", "✦"), element("h2", "", "一起把想法变成图"), element("p", "", "可以生成流程图、整理结构，也可以继续修改已有图形。"));
      for (const suggestion of ["画一个从需求到交付的项目流程图", "把当前内容整理成清晰的层级结构"]) intro.append(button(suggestion, () => { input.value = suggestion; input.focus(); }, "whiteboard-ai-suggestion")); history.append(intro);
    } else for (const message of state.messages) {
      const row = element("article", `whiteboard-ai-message ${message.role}`); row.append(element("span", "whiteboard-ai-message-role", message.role === "user" ? "你" : "绘图助手"), element("div", "whiteboard-ai-message-text", message.text || (message.role === "assistant" && state.run ? "Agent 正在思考…" : "")));
      if (message.note) row.append(element("small", "whiteboard-ai-message-note", message.note)); history.append(row);
    }
    if (stayAtBottom) history.scrollTop = history.scrollHeight;
    status.textContent = state.error || state.phase || (!state.context?.id ? "先创建或选择一块白板，再开始绘图。" : state.modelsLoaded && !state.models.some((model) => model.available !== false) ? "暂无可用模型，请先在设置中接入模型。" : "绘制结果会自动保存，可撤销本次 AI 绘制。");
    status.classList.toggle("error", Boolean(state.error)); status.setAttribute("role", state.error ? "alert" : "status"); recovery.replaceChildren();
    if (!busy && state.lastPrompt) recovery.append(button("重新生成", () => void start(state.lastPrompt)));
    if (!busy && state.undo) {
      const undo = button("撤销 AI 绘制", () => void undoLast()); undo.id = "whiteboard-ai-undo";
      undo.disabled = !sameBoard(state.undo.context, state.context) || state.undo.canvasVersion !== state.context?.canvasVersion || state.undo.context.name !== state.context?.name;
      if (undo.disabled) undo.title = "画布已有后续编辑，可使用画布的撤销功能逐步撤回。"; recovery.append(undo);
    }
  }
  async function loadModels() {
    try {
      const data = await api("/api/models"); state.models = Array.isArray(data.models) ? data.models : [];
      const unavailable = state.model && !state.models.some((item) => item.id === state.model && item.available !== false);
      const defaultChanged = state.modelsLoaded && !state.model && state.defaultModel !== data.defaultModel;
      if (unavailable || defaultChanged) { if (unavailable) state.model = ""; state.conversationId = undefined; state.messages = []; }
      state.defaultModel = data.defaultModel; state.modelsLoaded = true; render();
    }
    catch (error) { state.error = `无法读取模型：${error.message}`; render(); }
  }
  function toggle(expanded = !state.expanded) { state.expanded = expanded; render(); if (expanded) { if (!state.modelsLoaded) void loadModels(); input.focus(); } }
  function start(value) {
    if (state.startTask) return state.startTask;
    const task = executeStart(value); state.startTask = task;
    void task.finally(() => { if (state.startTask === task) state.startTask = null; }); return task;
  }
  async function executeStart(value) {
    const prompt = value.trim(); if (!prompt || state.starting || state.run || state.applying || state.leaving) return;
    state.starting = true; state.lastPrompt = prompt; state.error = ""; state.phase = "正在保存当前画布…"; render();
    const generation = state.generation;
    try {
      const context = await getContext(); if (!context?.id) throw new Error("请先创建或选择一块白板。");
      if (generation !== state.generation || !sameBoard(context, state.context)) return;
      state.context = context;
      const result = await api("/api/whiteboards/ai/start", { method: "POST", body: JSON.stringify({ workspace: context.workspace, id: context.id, revision: context.revision, prompt, ...(state.model ? { model: state.model } : {}), ...(state.conversationId ? { conversationId: state.conversationId } : {}) }) });
      if (generation !== state.generation || !sameBoard(context, state.context)) { if (result.runId) await api("/api/whiteboards/ai/stop", { method: "POST", body: JSON.stringify({ workspace: context.workspace, runId: result.runId }) }).catch(() => { toast("停止请求尚未确认；该任务的结果不会应用到其他白板。"); }); return; }
      if (typeof result.runId !== "string" || !result.runId) throw new Error("Agent 未返回有效的任务编号，请重试。");
      state.conversationId = result.conversationId; state.lastPrompt = prompt; input.value = ""; state.messages.push({ role: "user", text: prompt }); const reply = { role: "assistant", text: "" }; state.messages.push(reply);
      const run = { id: result.runId, context, reply, cancelled: false }; state.run = run; state.phase = "Agent 正在绘图…"; render(); void poll(generation, run);
    } catch (error) { if (generation === state.generation) {
      if (["not_found", "conversation_limit", "conversation_mismatch"].includes(error.code)) state.conversationId = undefined;
      state.error = error.message || "绘图任务未能启动。"; state.phase = "";
    } }
    finally { if (generation === state.generation) { state.starting = false; render(); } }
  }
  async function poll(generation, run) {
    if (!active(generation, run)) return;
    try {
      const result = await api(`/api/whiteboards/ai/run?runId=${encodeURIComponent(run.id)}&workspace=${encodeURIComponent(run.context.workspace)}`);
      if (!active(generation, run)) return;
      if (result.runId !== run.id || result.workspace !== run.context.workspace || result.id !== run.context.id) throw new Error("绘图结果不属于当前白板，未应用任何更改。");
      if (typeof result.text === "string") run.reply.text = result.text.slice(0, 100000);
      if (result.status === "running") { state.phase = run.cancelled ? "正在停止，返回的结果不会应用到画布。" : "Agent 正在绘图…"; render(); state.timer = setTimeout(() => void poll(generation, run), 450); return; }
      if (result.status === "stopped" || run.cancelled) { run.reply.note = result.status === "stopped" ? "任务已停止，未应用绘图。" : "任务已结束，取消后的结果未应用。"; state.phase = run.reply.note; }
      else if (result.status === "failed") { state.error = result.error || "Agent 执行失败，请重试。"; run.reply.note = "绘图未应用。"; state.phase = ""; }
      else if (result.status === "completed") {
        if (Array.isArray(result.drawings) && result.drawings.length) {
          state.applying = true; state.phase = "正在将绘图应用到画布…"; render();
          try {
            const applied = await applyDrawing(result.drawings, run.context, () => active(generation, run) && !run.cancelled);
            if (!active(generation, run)) return;
            state.undo = { operationId: applied.operationId, canvasVersion: applied.canvasVersion, context: { ...run.context, canvasVersion: applied.canvasVersion } };
            state.context = { ...state.context, canvasVersion: Math.max(state.context?.canvasVersion || 0, applied.canvasVersion) };
            run.reply.note = applied.saved === false ? "绘图已应用，保存尚未完成，请使用白板上方的恢复选项。" : "绘图已应用并保存。"; state.phase = run.reply.note;
          } catch (error) { if (active(generation, run)) { state.error = error.message || "画布已变化，本次结果未应用，请重新生成。"; run.reply.note = "绘图未应用，已有内容保留。"; state.phase = ""; } }
          finally { if (generation === state.generation) { state.applying = false; render(); } }
        } else state.phase = "Agent 已完成回复，画布内容保持不变。";
      } else throw new Error("Agent 返回了无法识别的任务状态。");
      if (active(generation, run)) { state.run = null; render(); }
    } catch (error) {
      if (active(generation, run)) { state.error = `无法读取执行状态：${error.message}。任务状态尚未确认，可停止后重试。`; state.phase = ""; render(); state.timer = setTimeout(() => void poll(generation, run), 1500); }
    }
  }
  async function stopRun() {
    const run = state.run; if (!run || run.cancelled || state.applying) return;
    run.cancelled = true; state.phase = "正在请求停止…"; state.error = ""; render();
    try { await api("/api/whiteboards/ai/stop", { method: "POST", body: JSON.stringify({ runId: run.id, workspace: run.context.workspace }) }); }
    catch (error) { if (state.run === run) { state.error = `停止请求未确认：${error.message}。返回结果不会应用到画布。`; render(); } }
  }
  async function undoLast() {
    if (!state.undo || state.run || state.starting || state.applying || state.leaving) return;
    const generation = state.generation;
    state.applying = true; state.error = ""; render();
    try { const result = await undoDrawing(state.undo); if (generation !== state.generation) return; state.context = { ...state.context, canvasVersion: Math.max(state.context?.canvasVersion || 0, result.canvasVersion) }; state.undo = null; state.phase = result.saved === false ? "已撤销绘图，保存尚未完成。" : "已撤销 AI 绘制并保存。"; }
    catch (error) { if (generation === state.generation) state.error = error.message || "画布已有后续编辑，请使用画布撤销功能。"; }
    finally { if (generation === state.generation) { state.applying = false; render(); } }
  }
  async function beforeLeave() {
    state.leaving++; const run = state.run; state.generation++; clearTimeout(state.timer); state.starting = false; state.applying = false; render();
    try {
      if (state.startTask) { try { await state.startTask; } catch { /* Startup failure does not affect the current canvas. */ } }
      if (run) { run.cancelled = true; state.run = null; try { await api("/api/whiteboards/ai/stop", { method: "POST", body: JSON.stringify({ runId: run.id, workspace: run.context.workspace }) }); if (sameBoard(run.context, state.context)) state.phase = "任务已请求停止，结果不会应用到其他白板。"; } catch { toast("停止请求尚未确认；该任务的结果不会应用到其他白板。"); } }
      return true;
    } finally { state.leaving--; render(); }
  }
  function contextChanged(context) {
    if (!sameBoard(context, state.context)) { void beforeLeave(); state.context = context?.id ? context : null; state.messages = []; state.conversationId = undefined; state.undo = null; state.error = ""; state.phase = ""; state.lastPrompt = ""; }
    else state.context = { ...state.context, ...context };
    render();
  }
  document.addEventListener("ccagent:models-changed", () => { if (!state.run && !state.starting) void loadModels(); });
  render(); if (state.expanded) void loadModels();
  return { toggle, open: () => toggle(true), contextChanged, beforeLeave };
}
