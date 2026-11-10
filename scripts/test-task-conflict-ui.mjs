/** Offline VM/DOM checks of the production conflict, submit and navigation paths. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { Window } from "happy-dom";

const app = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
const html = await readFile(new URL("../web/index.html", import.meta.url), "utf8");
const source = app.slice(0, app.indexOf("const pluginUI = createPluginUI(")).replace(/^import .*;\r?\n/gm, "");
assert(source.includes("function showTaskConflict("), "Exercise the actual application functions");
const ownId = "11111111-1111-4111-8111-111111111111", occupiedId = "22222222-2222-4222-8222-222222222222";
const conflictBody = (extra = {}) => ({ error: "另一个任务正在执行", code: "TASK_BUSY", reason: "waiting_permission", activeSessionId: occupiedId, canInterrupt: true, ...extra });
const reply = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

function harness() {
  const window = new Window({ url: "http://offline-ui.test/", settings: { disableJavaScriptFileLoading: true, enableJavaScriptEvaluation: false, enableCSSFileLoading: false, enableImageFileLoading: false } });
  window.document.write(html);
  const homeTeam = window.document.createElement("select"); homeTeam.id = "home-team"; window.document.body.append(homeTeam);
  // Feature factories normally add these containers during application startup.
  for (const [, id] of source.matchAll(/\$\("([a-z0-9-]+)"\)/g)) {
    if (!window.document.getElementById(id)) { const node = window.document.createElement("div"); node.id = id; window.document.body.append(node); }
  }
  let clock = 0, sequence = 0, handler;
  const timers = new Map(), calls = [], attachments = new Map([["home-input", ["fixture-attachment"]]]);
  const $ = id => window.document.getElementById(id);
  const snapshot = id => ({ sessionId: id, model: "fixture", mode: "default", team: "off", messages: [], busy: false });
  const noop = () => {};
  const context = vm.createContext({
    console, window, document: window.document, location: window.location, history: window.history,
    URL, URLSearchParams, AbortController, Date, Event: window.Event,
    setTimeout(fn, delay) { const id = ++sequence; timers.set(id, { fn, at: clock + delay }); return id; },
    clearTimeout(id) { timers.delete(id); }, setInterval: () => 0, clearInterval: noop,
    EventSource: class { close() {} },
    voiceUI: { stop: noop, stopDictation: noop }, browserUI: { restore: noop },
    customizationUI: { syncBusy: noop, setSessionTeam: noop, open: noop },
    workspaceFiles: { setView: noop }, pluginUI: { open: noop },
    libraryUI: { open: noop }, memoryUI: { open: noop }, schedulesUI: { open: noop },
    cloudTVUI: { open: noop }, visualizationUI: { open: noop },
    whiteboardUI: { beforeLeave: async () => true, open: noop },
    composerTools: {
      prepare: value => value, sync: noop, close: noop,
      clear(id) { attachments.delete(id); },
      move(from, to) { attachments.set(to, attachments.get(from)); attachments.delete(from); },
    },
    async fetch(route, options = {}) {
      calls.push({ route, method: options.method || "GET", options });
      const result = await handler?.(route, options);
      if (result) return result;
      if (route === "/api/sessions") return reply(200, { sessionId: ownId, snapshot: snapshot(ownId) });
      if (route === `/api/sessions/${ownId}/messages`) return reply(409, conflictBody());
      if (route === `/api/sessions/${occupiedId}/interrupt`) return reply(200, { interrupted: true });
      if (route === `/api/sessions/${occupiedId}`) return reply(200, { sessionId: occupiedId, busy: false });
      if (route === `/api/sessions/${ownId}`) return reply(200, snapshot(ownId));
      throw new Error("Unexpected offline request: " + route);
    },
  });
  vm.runInContext(source + "\nglobalThis.test = { state, api, submit, newTask, openSession, setView, clearTaskConflict };", context, { filename: "web/app.js" });
  const test = context.test;
  test.state.availableModels = [{ id: "fixture", available: true, label: "Fixture" }];
  test.state.model = test.state.selectedModel = "fixture";
  async function advance(ms) {
    const end = clock + ms;
    for (let count = 0; count < 500; count++) {
      await settle();
      const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) { clock = end; await settle(); return; }
      timers.delete(next[0]); clock = next[1].at; next[1].fn();
    }
    assert.fail("Unbounded timer loop");
  }
  const card = () => $("task-conflict");
  const stop = () => card()?.querySelector("button");
  const messageCalls = () => calls.filter(call => call.route.endsWith("/messages"));
  const interruptCalls = () => calls.filter(call => call.route.endsWith("/interrupt"));
  const occupiedReads = () => calls.filter(call => call.route === `/api/sessions/${occupiedId}`);
  return { $, test, context, calls, attachments, card, stop, messageCalls, interruptCalls, occupiedReads, advance, setHandler(fn) { handler = fn; }, close() { timers.clear(); window.happyDOM.abort(); } };
}

let passed = 0;
async function check(name, run) { const h = harness(); try { await run(h); passed++; console.log("PASS " + name); } finally { h.close(); } }
async function blocked(h, extra) {
  if (extra) h.setHandler(route => route.endsWith("/messages") ? reply(409, conflictBody(extra)) : undefined);
  h.$("home-input").value = "请继续处理我的草稿 <img src=x onerror=alert(1)>";
  assert.equal(await h.test.submit(h.$("home-input").value, "default"), false);
  assert(h.card(), `Missing conflict card: ${h.$("toast").textContent}; view=${h.test.state.view}; routes=${h.calls.map(call => call.route).join(",")}`);
}

await check("validated conflict preserves text and attachment drafts without interrupting", async h => {
  await blocked(h);
  assert.match(h.$("thread-input").value, /我的草稿 <img/);
  assert.deepEqual(h.attachments.get("thread-input"), ["fixture-attachment"]);
  assert.equal(h.interruptCalls().length, 0);
  const link = h.card().querySelector("a");
  assert.equal(link.getAttribute("href"), `/?session=${occupiedId}`);
  assert.equal(link.target, "_blank"); assert.equal(link.rel, "noopener noreferrer");
  assert.match(h.card().textContent, /等待你的授权/);
  assert.equal(h.card().querySelector("img"), null);
  await h.test.submit(h.$("thread-input").value);
  assert.equal(h.$("thread-form").parentElement.querySelectorAll("#task-conflict").length, 1);
});

await check("only an explicit stop click interrupts; idle polling never resubmits", async h => {
  await blocked(h);
  let reads = 0;
  h.setHandler(route => route === `/api/sessions/${occupiedId}` ? reply(200, { sessionId: occupiedId, busy: ++reads < 2 }) : undefined);
  h.stop().click(); await settle();
  assert.equal(h.interruptCalls().length, 1); assert.equal(reads, 1);
  assert.match(h.card().textContent, /确认状态/);
  await h.advance(250);
  assert.equal(reads, 2); assert.match(h.card().textContent, /请点击发送重新提交/);
  assert.equal(h.messageCalls().length, 1); assert.match(h.$("thread-input").value, /我的草稿/);
  h.setHandler(route => route.endsWith("/messages") ? reply(200, { accepted: true }) : undefined);
  assert.equal(await h.test.submit(h.$("thread-input").value), true);
  assert.equal(h.card(), null); assert.equal(h.$("thread-input").value, "");
});

await check("whiteboard conflicts expose only the fixed whiteboard link", async h => {
  await blocked(h, { reason: "whiteboard_running", canInterrupt: true });
  assert.equal(h.stop(), null);
  assert.equal(h.card().querySelector("a").getAttribute("href"), "/?view=whiteboard");
  assert.equal(h.interruptCalls().length, 0);
});

await check("noninterruptible and sessionless conflicts do not offer stop", async h => {
  await blocked(h, { reason: "configuration_busy", activeSessionId: null, canInterrupt: false });
  assert.equal(h.stop(), null); assert.equal(h.card().querySelector("a"), null);
});

await check("untrusted conflict fields cannot become an action or link", async h => {
  for (const extra of [{ activeSessionId: "javascript:alert(1)" }, { reason: "<img src=x>" }, { canInterrupt: "true" }, { activeSessionId: undefined }]) {
    h.setHandler(() => reply(409, conflictBody(extra)));
    await assert.rejects(h.test.api("/fixture"), error => !error.conflict);
  }
  h.setHandler(() => reply(400, conflictBody()));
  await assert.rejects(h.test.api("/fixture"), error => !error.conflict);
  assert.equal(h.interruptCalls().length, 0); assert.equal(h.card(), null);
});

await check("a failed interrupt leaves drafts intact and allows explicit retry", async h => {
  await blocked(h);
  h.setHandler(route => route.endsWith("/interrupt") ? reply(503, { error: "Fixture stop unavailable" }) : undefined);
  h.stop().click(); await settle();
  assert.match(h.card().textContent, /暂时无法停止/); assert.equal(h.stop().disabled, false);
  assert.equal(h.occupiedReads().length, 0); assert.equal(h.messageCalls().length, 1);
  assert.match(h.$("thread-input").value, /我的草稿/);
});

await check("the ten second deadline aborts an interrupt that never completes", async h => {
  await blocked(h);
  h.setHandler((route, options) => route.endsWith("/interrupt") ? new Promise((resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })) : undefined);
  h.stop().click(); await settle(); await h.advance(10000);
  assert.match(h.card().textContent, /停止确认超时/); assert.equal(h.stop().disabled, false);
  assert(h.interruptCalls()[0].options.signal.aborted); assert.equal(h.messageCalls().length, 1);
});

await check("busy polling is bounded and never approves a pending action", async h => {
  await blocked(h, { reason: "waiting_question" });
  h.setHandler(route => route === `/api/sessions/${occupiedId}` ? reply(200, { sessionId: occupiedId, busy: true }) : undefined);
  h.stop().click(); await settle(); await h.advance(11000);
  assert(h.occupiedReads().length <= 40); assert(h.occupiedReads().length > 1);
  const reads = h.occupiedReads().length; await h.advance(30000); assert.equal(h.occupiedReads().length, reads);
  assert.equal(h.calls.filter(call => call.route.endsWith("/respond")).length, 0);
  assert.equal(h.messageCalls().length, 1); assert.match(h.card().textContent, /未停止|超时/);
});

await check("a foreign or malformed idle snapshot cannot confirm a stop", async h => {
  await blocked(h);
  h.setHandler(route => route === `/api/sessions/${occupiedId}` ? reply(200, { sessionId: ownId, busy: false }) : undefined);
  h.stop().click(); await settle();
  assert.match(h.card().textContent, /暂时无法停止/); assert.doesNotMatch(h.card().textContent, /占用任务已停止/);
});

await check("navigation clears the card and late interrupt completion cannot touch a new draft", async h => {
  await blocked(h);
  const pending = deferred();
  h.setHandler(route => route.endsWith("/interrupt") ? pending.promise : undefined);
  h.stop().click(); await settle();
  await h.test.newTask(); h.$("home-input").value = "新页面草稿";
  assert.equal(h.card(), null); assert(h.interruptCalls()[0].options.signal.aborted);
  pending.resolve(reply(200, { interrupted: true })); await settle(); await h.advance(11000);
  assert.equal(h.card(), null); assert.equal(h.$("home-input").value, "新页面草稿"); assert.equal(h.occupiedReads().length, 0);
});

await check("late failed and successful submits cannot alter the next conversation", async h => {
  await blocked(h);
  for (const status of [409, 200]) {
    const pending = deferred();
    h.setHandler(route => route.endsWith("/messages") ? pending.promise : undefined);
    h.$("thread-input").value = "旧提交";
    const sending = h.test.submit("旧提交"); await settle();
    await h.test.newTask(); h.$("home-input").value = "下一条草稿";
    pending.resolve(reply(status, status === 409 ? conflictBody() : { accepted: true }));
    assert.equal(await sending, false); assert.equal(h.card(), null); assert.equal(h.$("home-input").value, "下一条草稿");
    if (status === 409) await h.test.openSession(ownId);
  }
});

await check("late session creation cannot navigate away from a new task", async h => {
  const pending = deferred(); h.setHandler(route => route === "/api/sessions" ? pending.promise : undefined);
  h.$("home-input").value = "旧草稿";
  const sending = h.test.submit("旧草稿", "default"); await settle();
  await h.test.newTask(); h.$("home-input").value = "新草稿";
  pending.resolve(reply(200, { sessionId: ownId }));
  assert.equal(await sending, false); assert.equal(h.test.state.view, "tasks"); assert.equal(h.test.state.sessionId, null);
  assert.equal(h.$("home-input").value, "新草稿"); assert.equal(h.messageCalls().length, 0);
});

await check("view and conversation changes remove stale conflict controls", async h => {
  await blocked(h); await h.test.setView("settings"); assert.equal(h.card(), null);
  await h.test.openSession(ownId); await h.test.submit("继续"); assert(h.card());
  await h.test.openSession(occupiedId, { sessionId: occupiedId, model: "fixture", mode: "default", messages: [], busy: false });
  assert.equal(h.card(), null);
});

console.log(`Task conflict UI: ${passed} offline VM/DOM checks passed; no external services or paid calls.`);
