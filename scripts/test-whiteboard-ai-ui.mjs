/** Offline AI panel contracts with simulated transport; no provider or real drawing SDK. */
import assert from "node:assert/strict";
import { Window } from "happy-dom";
const browser = new Window({ url: "http://whiteboard-ai.test/" }); browser.document.write('<main><div id="host"></div></main>');
const originals = new Map(); for (const key of ["window", "document", "Event", "KeyboardEvent"]) { originals.set(key, globalThis[key]); globalThis[key] = key === "window" ? browser : browser[key]; }
const calls = [], applied = [], undone = [], notices = [], runs = new Map();
let serial = 0, defaultModel = "model-a", modelBAvailable = true, current = { workspace: "C:\\ai-workspace", id: "board-a", name: "流程图", revision: 2, token: "scope-a", canvasVersion: 0 };
let holdStart = false, releaseStart, holdPoll = false, releasePoll, holdStop = false, releaseStop, applyError, startFailure, saved = true, ui;
const patch = { version: 1, requestId: "drawing-fixture", skeletons: [], deleteIds: [], contextIds: [], aliases: {}, labelIds: {}, summary: "模拟绘图" };
const api = async (route, options) => {
  const body = options?.body ? JSON.parse(options.body) : undefined; calls.push({ route, body });
  if (route === "/api/models") return { defaultModel, models: [{ id: "model-a", label: "已配置模型 A", available: true }, { id: "model-b", label: "已配置模型 B", available: modelBAvailable }, { id: "offline", label: "已停用模型", available: false }] };
  if (route === "/api/whiteboards/ai/start") {
    if (startFailure) { const error = startFailure; startFailure = undefined; throw error; }
    if (holdStart) await new Promise((resolve) => { releaseStart = resolve; });
    const runId = `run-${++serial}`, conversationId = body.conversationId || `conversation-${serial}`;
    runs.set(runId, { runId, conversationId, workspace: body.workspace, id: body.id, status: "running", text: "<img src=x onerror=alert(1)>真实状态文本（模拟）", drawings: [] });
    return { runId, conversationId };
  }
  if (route.startsWith("/api/whiteboards/ai/run?")) {
    const runId = new URL(route, "http://whiteboard-ai.test").searchParams.get("runId");
    if (holdPoll) return new Promise((resolve) => { releasePoll = (result) => resolve(structuredClone(result || runs.get(runId))); });
    return structuredClone(runs.get(runId));
  }
  if (route === "/api/whiteboards/ai/stop") { if (holdStop) await new Promise((resolve) => { releaseStop = resolve; }); const run = runs.get(body.runId); if (run) { run.status = "stopped"; run.drawings = []; } return { ok: true }; }
  throw new Error(`Unexpected fixture route ${route}`);
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
async function until(test, description) { for (let i = 0; i < 250; i++) { if (test()) return; await new Promise((resolve) => setTimeout(resolve, 5)); } assert.fail(description); }
const $ = (id) => document.getElementById(id);
const latest = () => runs.get(`run-${serial}`);
function submit(text) { $("whiteboard-ai-input").value = text; $("whiteboard-ai-send").click(); }
function complete(run = latest()) { Object.assign(run, { status: "completed", text: "绘图已准备好（模拟）", drawings: [patch] }); }
try {
  const { createWhiteboardAI, reconcileWhiteboardBindings } = await import("../web/whiteboard-ai.js");
  const original = [
    { id: "X", type: "rectangle", x: 10, y: 20, boundElements: [{ id: "A", type: "arrow" }, { id: "label-X", type: "text" }] },
    { id: "Y", type: "rectangle", boundElements: [{ id: "A", type: "arrow" }] },
    { id: "U", type: "rectangle", boundElements: null }, { id: "V", type: "rectangle", boundElements: null },
    { id: "A", type: "arrow", startBinding: { elementId: "U" }, endBinding: { elementId: "V" } },
    { id: "label-X", type: "text", containerId: "X", text: "保留标签" },
    { id: "old-frame", type: "frame", isDeleted: true }, { id: "manual-child", type: "rectangle", x: 87, y: 94, width: 120, height: 60, frameId: "old-frame" },
  ];
  const repaired = reconcileWhiteboardBindings(original, ["old-frame"], (item, changes) => ({ ...item, ...changes, version: (item.version || 0) + 1 }));
  assert.deepEqual(repaired.find((item) => item.id === "X").boundElements, [{ id: "label-X", type: "text" }]);
  assert.equal(repaired.find((item) => item.id === "Y").boundElements, null);
  for (const id of ["U", "V"]) assert.deepEqual(repaired.find((item) => item.id === id).boundElements, [{ id: "A", type: "arrow" }]);
  assert.equal(repaired.find((item) => item.id === "manual-child").frameId, null);
  assert.deepEqual(Object.fromEntries(["x", "y", "width", "height"].map((key) => [key, repaired.find((item) => item.id === "manual-child")[key]])), { x: 87, y: 94, width: 120, height: 60 }, "Deleting a frame detaches a manual child without changing its geometry");
  assert.deepEqual(original[0].boundElements, [{ id: "A", type: "arrow" }, { id: "label-X", type: "text" }], "Reference repair is immutable");
  ui = createWhiteboardAI({ api, toast: (text) => notices.push(text), host: $("host"), getContext: async () => ({ ...current }), applyDrawing: async (drawings, expected, isCurrent) => {
    if (!isCurrent() || expected.canvasVersion !== current.canvasVersion || expected.name !== current.name || expected.token !== current.token) throw new Error("画布已变化，本次绘图未应用，请重新生成。");
    if (applyError) throw applyError;
    applied.push({ drawings, expected }); current = { ...current, canvasVersion: current.canvasVersion + 1, revision: current.revision + (saved ? 1 : 0) }; ui.contextChanged(current);
    return { operationId: `operation-${applied.length}`, canvasVersion: current.canvasVersion, saved };
  }, undoDrawing: async (operation) => { assert.equal(operation.canvasVersion, current.canvasVersion); undone.push(operation); current = { ...current, canvasVersion: current.canvasVersion + 1 }; ui.contextChanged(current); return { canvasVersion: current.canvasVersion, saved: true }; } });
  ui.contextChanged(current); await tick();
  assert.equal(calls.filter((call) => call.route === "/api/models").length, 1, "Desktop panel loads existing configured models on whiteboard mount");
  assert.ok(!$("whiteboard-ai").classList.contains("collapsed"));
  assert.equal($("whiteboard-ai-model").querySelector('option[value="offline"]').disabled, true);
  assert.equal($("whiteboard-ai-model").querySelector('option[value=""]').textContent, "应用默认模型");
  submit("请画一个审批流程"); await until(() => latest(), "A real start request is issued"); await tick();
  assert.deepEqual(calls.find((call) => call.route.endsWith("/start")).body, { workspace: current.workspace, id: current.id, revision: 2, prompt: "请画一个审批流程" });
  assert.ok($("whiteboard-ai-history").textContent.includes("<img src=x onerror=alert(1)>")); assert.equal($("whiteboard-ai-history").querySelector("img"), null, "Agent output is literal text");
  assert.equal($("whiteboard-ai-model").disabled, true); assert.equal($("whiteboard-ai-send").disabled, true); assert.equal($("whiteboard-ai-stop").disabled, false);
  ui.contextChanged({ ...current, revision: 3 }); assert.equal($("whiteboard-ai-model").disabled, true, "Background metadata refresh cannot re-enable running controls");
  complete(); await until(() => applied.length === 1, "Completed result is applied once"); await until(() => $("whiteboard-ai-status").textContent.includes("应用并保存"), "Actual saved result is shown");
  assert.ok($("whiteboard-ai-undo")); $("whiteboard-ai-undo").click(); await until(() => undone.length === 1, "Guarded undo uses the actual operation"); await tick();
  assert.match($("whiteboard-ai-status").textContent, /已撤销/);

  submit("继续补充归档节点"); await until(() => serial === 2, "A continuation starts"); await tick();
  assert.equal(calls.filter((call) => call.route.endsWith("/start")).at(-1).body.conversationId, "conversation-1");
  Object.assign(latest(), { status: "failed", text: "模型未完成", error: "模拟模型请求失败", drawings: [patch] });
  await until(() => $("whiteboard-ai-status").textContent.includes("模拟模型请求失败"), "Provider failure is shown");
  assert.equal(applied.length, 1, "Failed runs never apply drawings");
  defaultModel = "model-b"; document.dispatchEvent(new Event("ccagent:models-changed")); await tick();
  assert.ok(!$("whiteboard-ai-history").textContent.includes("继续补充归档节点"), "Application default changes reset the scoped conversation");
  $("whiteboard-ai-model").value = "model-b"; $("whiteboard-ai-model").dispatchEvent(new Event("change"));
  submit("换个模型绘制"); await until(() => serial === 3, "Selected existing model starts"); await tick();
  const selectedStart = calls.filter((call) => call.route.endsWith("/start")).at(-1).body; assert.equal(selectedStart.model, "model-b"); assert.ok(!selectedStart.conversationId, "Changing model begins a separate conversation");
  current = { ...current, canvasVersion: current.canvasVersion + 1 }; ui.contextChanged(current); complete();
  await until(() => $("whiteboard-ai-status").textContent.includes("画布已变化"), "Manual interleaving rejects stale drawing"); assert.equal(applied.length, 1);
  assert.ok($("whiteboard-ai-history").textContent.includes("绘图已准备好"), "Stale replies remain available to the user");

  submit("测试停止"); await until(() => serial === 4, "Cancelable run starts"); await tick();
  holdPoll = true; await until(() => releasePoll, "Poll can be delayed across cancellation");
  $("whiteboard-ai-stop").click(); await tick(); const cancelled = { ...latest(), status: "completed", drawings: [patch] }; holdPoll = false; releasePoll(cancelled); releasePoll = undefined;
  await until(() => $("whiteboard-ai-status").textContent.includes("取消后的结果未应用"), "Completed response arriving after stop is not applied"); assert.equal(applied.length, 1);

  saved = false; submit("测试保存恢复提示"); await until(() => serial === 5, "Another run starts"); await tick(); complete();
  await until(() => applied.length === 2, "Drawing can be applied while save reports a recoverable failure"); await until(() => $("whiteboard-ai-status").textContent.includes("保存尚未完成"), "UI does not falsely claim a failed save succeeded");
  assert.ok(!$("whiteboard-ai-status").textContent.includes("应用并保存")); saved = true;
  current = { ...current, canvasVersion: current.canvasVersion + 1 }; ui.contextChanged(current); assert.equal($("whiteboard-ai-undo").disabled, true, "AI undo cannot erase subsequent manual edits");
  modelBAvailable = false; defaultModel = "model-a"; document.dispatchEvent(new Event("ccagent:models-changed")); await tick();
  assert.equal($("whiteboard-ai-model").value, "", "Unavailable selected profile is replaced by application default");

  holdStart = true; submit("正在启动时离开"); await until(() => releaseStart, "Start response can be delayed");
  let left = false; const leave = ui.beforeLeave().then(() => { left = true; }); await tick(); assert.equal(left, false, "Leaving waits for in-flight start to reveal its run id");
  holdStart = false; holdStop = true; releaseStart(); await until(() => releaseStop, "Leaving waits for stop acknowledgment");
  assert.equal($("whiteboard-ai-send").disabled, true); const startsDuringLeave = calls.filter((call) => call.route.endsWith("/start")).length;
  $("whiteboard-ai-input").value = "离开时不应启动"; $("whiteboard-ai-send").dispatchEvent(new Event("click")); await tick();
  assert.equal(calls.filter((call) => call.route.endsWith("/start")).length, startsDuringLeave, "New tasks cannot slip into an in-flight departure");
  holdStop = false; releaseStop(); await leave; assert.equal(latest().status, "stopped"); assert.ok(calls.filter((call) => call.route.endsWith("/stop")).some((call) => call.body.runId === latest().runId));
  const restarted = calls.filter((call) => call.route.endsWith("/start")).at(-1).body;
  assert.ok(!restarted.model && !restarted.conversationId, "Removed profile and its conversation are never reused");
  const appliesBeforeSwitch = applied.length; current = { ...current, workspace: "C:\\other-workspace", id: "board-b", token: "scope-b", canvasVersion: 0 }; ui.contextChanged(current); await tick();
  assert.ok(!$("whiteboard-ai-history").textContent.includes("请画一个审批流程"), "Board/workspace switch does not leak another chat history"); assert.equal(applied.length, appliesBeforeSwitch);
  const freshSerial = serial + 1; submit("新画布第一次绘图"); await until(() => serial === freshSerial, "New board can start a fresh conversation"); await tick();
  assert.equal($("whiteboard-ai-new-chat").disabled, true, "Reset cannot discard a running task");
  complete(); await until(() => !$("whiteboard-ai-send").disabled, "New board drawing finishes");
  startFailure = Object.assign(new Error("对话已过期，请开始新对话。"), { code: "not_found" }); submit("过期后新的绘图需求");
  await until(() => $("whiteboard-ai-status").textContent.includes("已过期"), "Expired conversation is shown");
  [...document.querySelectorAll(".whiteboard-ai-recovery button")].find(button => button.textContent === "重新生成").click();
  await until(() => serial === freshSerial + 1, "Retry recovers from expiry"); await tick();
  const recovered = calls.filter(call => call.route.endsWith("/start")).at(-1).body;
  assert.equal(recovered.prompt, "过期后新的绘图需求", "Retry keeps the latest failed request, not an older successful prompt"); assert.ok(!recovered.conversationId, "Expired conversation is not reused");
  complete(); await until(() => !$("whiteboard-ai-send").disabled, "Recovered task finishes");
  $("whiteboard-ai-new-chat").click(); assert.ok(!$("whiteboard-ai-history").textContent.includes("过期后新的绘图需求"), "New chat clears previous messages without touching the canvas");
  window.innerWidth = 390; const mobileHost = document.createElement("div"); document.body.append(mobileHost); const beforeModels = calls.filter((call) => call.route === "/api/models").length;
  const mobile = createWhiteboardAI({ api, toast() {}, host: mobileHost, getContext: async () => current, applyDrawing() {}, undoDrawing() {} }); mobile.contextChanged(current); await tick();
  assert.ok(mobileHost.classList.contains("collapsed")); assert.equal(calls.filter((call) => call.route === "/api/models").length, beforeModels, "Collapsed mobile panel loads models only when opened"); mobile.open(); await tick(); assert.equal(calls.filter((call) => call.route === "/api/models").length, beforeModels + 1); await mobile.beforeLeave();
  console.log("Offline whiteboard AI UI passed: configured models, literal replies, real-status contract, scoped continuation, one-shot apply, guarded undo, stale/cancel/no-overwrite, save recovery wording, in-flight start cancellation, board isolation and mobile lazy panel. No model provider or real SDK drawing was invoked.");
} finally { await ui?.beforeLeave(); await browser.happyDOM.close(); for (const [key, value] of originals) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; } }
