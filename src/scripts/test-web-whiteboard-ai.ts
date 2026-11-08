/** Real QueryEngine + loopback tool-calling provider; never a production model/account. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { loginForTest } from "./helpers/accountFixture.js";
import { resetSettingsCache } from "../config/sources.js";
import { runTools } from "../core/agenticLoop.js";
import { createWhiteboardAIManager, WhiteboardAIError, type WhiteboardAIRun } from "../entrypoint/webWhiteboardAI.js";
import { handleWhiteboard, type Whiteboard } from "../entrypoint/webWhiteboards.js";
import type { Tool } from "../tools/Tool.js";

const temporaryParent = await fs.realpath(os.tmpdir());
const temp = await fs.realpath(await fs.mkdtemp(path.join(temporaryParent, "ccagent-whiteboard-agent-")));
const workspace = path.join(temp, "workspace"), otherWorkspace = path.join(temp, "other-workspace");
await fs.mkdir(workspace); await fs.mkdir(otherWorkspace);
const account = await loginForTest(path.join(temp, "platform"));
type Message = { role: string; content?: unknown; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> };
const requests: Array<{ messages: Message[]; tools: string[]; caseName: string }> = [];
let held = 0, serial = 0;
const drawing = { nodes: [{ id: "start", type: "rectangle", label: "需求收集" }, { id: "review", type: "diamond", label: "方案评审" }], edges: [{ id: "flow", from: "start", to: "review" }], layout: "right" };
const provider = createServer(async (req, res) => {
  try {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw) as { messages: Message[]; tools?: Array<{ function: { name: string } }> };
    const messages = body.messages;
    let lastUser = messages.length - 1;
    while (lastUser >= 0 && messages[lastUser]!.role !== "user") lastUser--;
    const prompt = String(messages[lastUser]?.content ?? ""), caseName = /CASE_[A-Z_]+/.exec(prompt)?.[0] ?? "CASE_UNKNOWN";
    const calls = messages.slice(lastUser + 1).flatMap((message) => message.tool_calls ?? []);
    requests.push({ messages, tools: (body.tools ?? []).map((tool) => tool.function.name), caseName });
    serial++;
    if (caseName === "CASE_ERROR") { res.writeHead(402, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { message: "fixture insufficient balance", type: "insufficient_quota" } })); return; }
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (caseName === "CASE_HOLD") {
      held++; res.flushHeaders();
      const heartbeat = setInterval(() => res.write(": waiting\n\n"), 100);
      res.on("close", () => { clearInterval(heartbeat); held--; }); return;
    }
    let name = "", input: Record<string, unknown> = {}, text = "草稿已准备好，等待画布应用。";
    if (caseName === "CASE_REPAIR") {
      if (!calls.length) { name = "WhiteboardDraw"; input = { nodes: [{ id: "invalid", type: "iframe" }] }; }
      else if (calls.length === 1) { name = "WhiteboardDraw"; input = drawing; }
    } else if (caseName === "CASE_LIMIT") { name = "WhiteboardRead"; }
    else if (caseName === "CASE_TEXT") text = "可以先说明流程的起点、节点和判断条件。";
    else if (!calls.some((call) => call.function.name === "WhiteboardRead")) name = "WhiteboardRead";
    else if (!calls.some((call) => call.function.name === "WhiteboardDraw")) {
      name = "WhiteboardDraw";
      input = caseName === "CASE_CONTINUE" ? { nodes: [{ id: "existing", type: "rectangle", label: "已更新当前保存节点" }] } : drawing;
    }
    const emit = (delta: unknown, finish: string | null) => res.write(`data: ${JSON.stringify({ id: `fixture-${serial}`, choices: [{ index: 0, delta, finish_reason: finish }], ...(finish ? { usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } } : {}) })}\n\n`);
    if (name) { emit({ role: "assistant", tool_calls: [{ index: 0, id: `fixture-tool-${serial}`, type: "function", function: { name, arguments: JSON.stringify(input) } }] }, null); emit({}, "tool_calls"); }
    else { emit({ role: "assistant", content: text }, null); emit({}, "stop"); }
    res.end("data: [DONE]\n\n");
  } catch { if (!res.headersSent) res.writeHead(500); res.end("fixture request failed"); }
});
await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
const providerAddress = provider.address(); assert.ok(providerAddress && typeof providerAddress !== "string");
const settings = { mode: "default", disableAllHooks: true, defaultModel: "whiteboard-test", models: { "whiteboard-test": { protocol: "openai-chat", model: "whiteboard-test", baseURL: `http://127.0.0.1:${providerAddress.port}/v1`, apiKey: "fixture-only-key" } } };
await fs.writeFile(path.join(account.home, "settings.json"), JSON.stringify(settings)); resetSettingsCache();
let selectedWorkspace = workspace, busy: string | undefined;
const busyEvents: string[] = [], idleEvents: string[] = [];
const options = {
  getWorkspace: () => selectedWorkspace, getDefaultModel: () => "whiteboard-test", validateModel: async (model: string) => model === "whiteboard-test",
  isBusy: () => !!busy, onBusy: (id: string) => { assert.equal(busy, undefined); busy = id; busyEvents.push(id); },
  onIdle: (id: string) => { if (busy === id) busy = undefined; idleEvents.push(id); },
};
const manager = createWhiteboardAIManager(options);
const delay = (milliseconds = 10) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
async function waitIdle(): Promise<void> { for (let count = 0; count < 300 && busy; count++) await delay(); assert.equal(busy, undefined, "all completed/failed/stopped tasks must release the shared worker guard"); }
async function completed(runId: string, target = manager): Promise<WhiteboardAIRun> {
  for (let count = 0; count < 500; count++) { const run = await target.status(runId, selectedWorkspace); if (run.status !== "running") { await waitIdle(); return run; } await delay(); }
  assert.fail("Isolated whiteboard agent did not finish");
}
async function rejectedStart(input: Record<string, unknown>, status: number) {
  await assert.rejects(manager.start(input), (error: unknown) => error instanceof WhiteboardAIError && error.status === status);
  await waitIdle();
}

try {
  // Scope enforcement is independent of permission mode, including Full Mode.
  let executions = 0, enabled = true;
  const local: Tool = { name: "ScopedFixture", description: "Local fixture", inputSchema: { type: "object" }, isReadOnly: () => false,
    isEnabled: () => enabled, isConcurrencySafe: () => true, async call() { executions++; return { content: "local fixture" }; } };
  const forbidden = path.join(workspace, "scope-must-not-write.txt");
  const blocks = [
    { type: "tool_use" as const, id: "local", name: local.name, input: {} },
    { type: "tool_use" as const, id: "forged-write", name: "Write", input: { file_path: forbidden, content: "forbidden" } },
  ];
  const scoped = await runTools(blocks, { cwd: workspace, scopedTools: [local] }, { permissionMode: "full" });
  assert.equal(executions, 1); assert.equal(scoped.executions[0]!.result.isError, undefined); assert.equal(scoped.executions[1]!.result.isError, true);
  assert.equal(await fs.stat(forbidden).catch(() => null), null);
  for (const tools of [[], [local, local]]) {
    const result = await runTools(blocks, { cwd: workspace, scopedTools: tools }, { permissionMode: "full" });
    assert.ok(result.executions.every((execution) => execution.result.isError));
  }
  const lateDisabled = await runTools([blocks[0]!], { cwd: workspace, scopedTools: [local] }, {
    permissionMode: "default", permissionSettings: { mode: "default", allow: [], deny: [] }, onPermissionRequest: async () => { enabled = false; return "allow_once"; },
  });
  assert.equal(lateDisabled.executions[0]!.result.isError, true); assert.equal(executions, 1, "final dispatch must recheck the same scoped tool");
  enabled = true;
  const abort = new AbortController();
  const cancelled = await runTools([blocks[0]!], { cwd: workspace, scopedTools: [local], abortSignal: abort.signal }, {
    permissionMode: "default", permissionSettings: { mode: "default", allow: [], deny: [] }, onPermissionRequest: async () => { abort.abort(); return "allow_once"; },
  });
  assert.equal(cancelled.executions[0]!.result.isError, true); assert.equal(executions, 1);

  const created = await handleWhiteboard("create", { name: "Agent fixture" }, workspace);
  assert.ok("board" in created && "scene" in created.board);
  const initial = created.board;
  const body = { workspace, id: initial.id, revision: 1, prompt: "CASE_REPAIR 绘制两步流程" };
  const requestCount = requests.length;
  await rejectedStart({ ...body, revision: 99 }, 409);
  await rejectedStart({ ...body, prompt: "/config set mode full" }, 400);
  await rejectedStart({ ...body, revision: 0 }, 400);
  await rejectedStart({ ...body, model: "unconfigured" }, 400);
  assert.equal(requests.length, requestCount, "invalid version/model requests must not invoke a model");
  const first = await manager.start(body);
  const repaired = await completed(first.runId);
  assert.equal(repaired.status, "completed"); assert.equal(repaired.drawings.length, 1); assert.match(repaired.text, /草稿/);
  assert.ok((repaired.usage?.input_tokens ?? 0) > 0 && (repaired.usage?.output_tokens ?? 0) > 0, "usage comes from the real engine/tool loop");
  const repairRequests = requests.filter((request) => request.caseName === "CASE_REPAIR");
  assert.equal(repairRequests.length, 3); assert.ok(JSON.stringify(repairRequests[1]!.messages).includes("invalid_drawing"), "model sees the actual rejected tool result before repairing it");
  for (const request of requests) assert.deepEqual([...request.tools].sort(), ["WhiteboardDraw", "WhiteboardRead"], "the provider receives only the closed whiteboard tool schemas");
  const afterDraft = await handleWhiteboard("open", { id: initial.id }, workspace);
  assert.ok("board" in afterDraft && "scene" in afterDraft.board); assert.deepEqual(afterDraft.board, initial, "preparing an AI draft never applies/saves the board on the server");

  // The next turn must see current persisted content, not an earlier draft.
  const persistedScene = { type: "excalidraw", version: 2, elements: [{ id: "existing", type: "rectangle", x: 1, y: 2, width: 100, height: 70, angle: 0, isDeleted: false }], appState: {}, files: {} };
  await handleWhiteboard("save", { id: initial.id, revision: 1, scene: persistedScene }, workspace);
  const second = await manager.start({ ...body, revision: 2, prompt: "CASE_CONTINUE 修改保存的节点", conversationId: first.conversationId });
  const continued = await completed(second.runId);
  assert.equal(continued.conversationId, first.conversationId); assert.equal(continued.status, "completed"); assert.equal(continued.drawings.length, 1);
  assert.equal(continued.drawings[0]!.skeletons[0]!.id, "existing", "fresh saved scene enables edits to actual ids");
  const continuationRequests = requests.filter((request) => request.caseName === "CASE_CONTINUE");
  assert.ok(continuationRequests[0]!.messages.some((message) => message.role === "user" && String(message.content).includes("CASE_REPAIR")), "the engine retains conversation history between runs");
  assert.ok(continuationRequests.some((request) => request.messages.some((message) => message.role === "tool" && String(message.content).includes('"revision":2'))), "WhiteboardRead reports the fresh persisted revision");

  const freeText = await manager.start({ ...body, revision: 2, prompt: "CASE_TEXT 画流程图要先考虑什么" });
  const answer = await completed(freeText.runId); assert.equal(answer.status, "completed"); assert.deepEqual(answer.drawings, []);
  const other = await handleWhiteboard("create", {}, workspace); assert.ok("board" in other);
  await rejectedStart({ ...body, revision: 2, id: other.board.id, conversationId: first.conversationId }, 409);

  // Startup must reserve the worker before its first asynchronous validation.
  let releaseValidation!: () => void;
  const gate = new Promise<void>((resolve) => { releaseValidation = resolve; });
  const racing = createWhiteboardAIManager({ ...options, validateModel: async () => { await gate; return true; } });
  const pending = racing.start({ ...body, revision: 2, prompt: "CASE_TEXT reserved start" });
  assert.ok(busy, "reservation exists before start() yields to the caller");
  await assert.rejects(racing.start({ ...body, revision: 2 }), (error: unknown) => error instanceof WhiteboardAIError && error.code === "busy");
  releaseValidation(); const raced = await pending; await completed(raced.runId, racing); racing.dispose();

  const heldRun = await manager.start({ ...body, revision: 2, prompt: "CASE_HOLD 停止中的草稿" });
  for (let count = 0; count < 100 && held === 0; count++) await delay(); assert.equal(held, 1);
  const stopped = await manager.stop(heldRun.runId, workspace);
  assert.equal(stopped.status, "stopped"); assert.deepEqual(stopped.drawings, []); await waitIdle();
  assert.equal((await manager.status(heldRun.runId, workspace)).status, "stopped");
  const timeoutManager = createWhiteboardAIManager({ ...options, timeoutMs: 150 });
  const timed = await timeoutManager.start({ ...body, revision: 2, prompt: "CASE_HOLD timeout" });
  const timeoutResult = await completed(timed.runId, timeoutManager);
  assert.equal(timeoutResult.status, "failed"); assert.deepEqual(timeoutResult.drawings, []); assert.match(timeoutResult.error!, /超时/); timeoutManager.dispose();

  const modelError = await manager.start({ ...body, revision: 2, prompt: "CASE_ERROR fixture failure" });
  assert.equal((await completed(modelError.runId)).status, "failed", "model_error must never become completed");
  const looping = await manager.start({ ...body, revision: 2, prompt: "CASE_LIMIT repeated read" });
  const loopResult = await completed(looping.runId);
  assert.equal(loopResult.status, "failed"); assert.deepEqual(loopResult.drawings, []); assert.equal(requests.filter((request) => request.caseName === "CASE_LIMIT").length, 10);
  selectedWorkspace = otherWorkspace;
  await assert.rejects(manager.status(first.runId, workspace), (error: unknown) => error instanceof WhiteboardAIError && error.code === "workspace_changed");
  selectedWorkspace = workspace;
  await assert.rejects(manager.status(randomUUID(), workspace), (error: unknown) => error instanceof WhiteboardAIError && error.status === 404);
  manager.dispose(); await rejectedStart({ ...body, revision: 2 }, 503);
  assert.equal(busyEvents.length, idleEvents.length, "every reservation, including validation failures, is released exactly once");
  console.log("Whiteboard Agent tests passed: real QueryEngine tool roundtrips, invalid DSL repair, scoped schemas/closed dispatch, final disabled/abort guards, fresh-snapshot conversation continuation, no server drawing persistence, usage, startup reservation, stop/timeout, model errors and bounded turns. Only isolated account and loopback model fixtures were used.");
} finally {
  manager.dispose();
  provider.closeAllConnections(); await new Promise<void>((resolve) => provider.close(() => resolve()));
  await account.close();
  const relative = path.relative(temporaryParent, temp); assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
  await fs.rm(temp, { recursive: true, force: true });
}
