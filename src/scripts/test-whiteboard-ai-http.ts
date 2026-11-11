/** Real HTTP acceptance with the actual QueryEngine and an isolated tool-calling model. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { startWhiteboardAIFixture } from "./helpers/whiteboardAIFixture.js";

const fixture = await startWhiteboardAIFixture();
const { origin, workspace } = fixture;
const pause = () => new Promise(resolve => setTimeout(resolve, 60));
try {
  async function request(route: string, cookie = "", body?: Record<string, unknown>) {
    return fetch(origin + route, { method: body ? "POST" : "GET", headers: { ...(cookie ? { cookie } : {}), ...(body ? { "content-type": "application/json", "x-ccagent-web": "1", origin } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15_000) });
  }
  async function login(index: number) { const response = await request("/api/account/login", "", { email: fixture.account.users[index]!.email, password: fixture.account.password }); assert.equal(response.status, 200); return response.headers.get("set-cookie")!.split(";")[0]!; }
  const cookie = await login(0);
  for (const asset of ["/whiteboard-ai.js", "/whiteboard-ai.css"]) { assert.equal((await request(asset)).status, 401); assert.equal((await request(asset, cookie)).status, 200); }
  const created = await (await request("/api/whiteboards/create", cookie, { workspace, name: "AI HTTP 验收" })).json() as any;
  const id = created.board.id;
  const startBody = { workspace, id, revision: 1, prompt: "生成城市更新流程图", model: "whiteboard-fixture" };
  assert.equal((await request("/api/whiteboards/ai/start", "", startBody)).status, 401);
  assert.equal((await request("/api/whiteboards/ai/start", cookie, { ...startBody, revision: 99 })).status, 409);
  assert.equal((await request("/api/whiteboards/ai/start", cookie, { ...startBody, prompt: "/config set mode full" })).status, 400);
  const start = await request("/api/whiteboards/ai/start", cookie, startBody); assert.equal(start.status, 202, await start.clone().text());
  const run = await start.json() as { runId: string; conversationId: string };
  async function completed(runId: string) {
    for (let i = 0; i < 200; i++) { const response = await request(`/api/whiteboards/ai/run?workspace=${encodeURIComponent(workspace)}&runId=${runId}`, cookie); assert.equal(response.status, 200); const status = await response.json() as any; if (status.status !== "running") return status; await pause(); }
    throw new Error("AI fixture did not finish");
  }
  const result = await completed(run.runId); assert.equal(result.status, "completed", JSON.stringify(result)); assert.ok(result.text); assert.equal(result.drawings.length, 1); assert.ok(result.drawings[0].skeletons.length >= 5);
  assert.equal((await (await request("/api/whiteboards/open", cookie, { workspace, id })).json() as any).board.scene.elements.length, 0, "backend agent drafts never overwrite a live editor");
  assert.ok(fixture.requests.length >= 3); assert.ok(fixture.requests.every(r => r.tools.length === 2 && r.tools.includes("WhiteboardRead") && r.tools.includes("WhiteboardDraw")), "only scoped drawing tools reach the model");
  const cookieB = await login(1);
  assert.equal((await request(`/api/whiteboards/ai/run?workspace=${encodeURIComponent(workspace)}&runId=${run.runId}`, cookieB)).status, 404, "run buffers are account-private");
  const second = await request("/api/whiteboards/ai/start", cookie, { ...startBody, prompt: "SECOND_AI_EDIT 增加公众参与", conversationId: run.conversationId }); assert.equal(second.status, 202);
  const secondRun = await second.json() as typeof run; const secondResult = await completed(secondRun.runId); assert.equal(secondResult.status, "completed"); assert.equal(secondRun.conversationId, run.conversationId); assert.ok(JSON.stringify(secondResult.drawings).includes("公众参与"));
  const hostile = await (await request("/api/whiteboards/ai/start", cookie, { ...startBody, prompt: "HOSTILE_AI_TOOL 验证绘图工具域" })).json() as typeof run;
  assert.equal((await completed(hostile.runId)).status, "completed"); assert.equal(await fs.stat(path.join(workspace, "must-not-exist.txt")).then(() => true, () => false), false, "out-of-scope Bash cannot dispatch");
  const held = await (await request("/api/whiteboards/ai/start", cookie, { ...startBody, prompt: "HOLD_AI_DRAWING" })).json() as typeof run;
  for (let i = 0; i < 100 && !fixture.held(); i++) await pause(); assert.ok(fixture.held());
  assert.equal((await request("/api/workspaces/select", cookie, { path: fixture.secondWorkspace })).status, 200, "another project can open while this project's AI keeps running");
  assert.ok(fixture.held(), "switching projects preserves the original model connection");
  const heldRoute = `/api/whiteboards/ai/run?workspace=${encodeURIComponent(workspace)}&runId=${held.runId}`;
  const background = await request(heldRoute, cookie); assert.equal(background.status, 200);
  assert.equal((await background.json() as { status: string }).status, "running", "an explicit workspace query reads the background AI run");
  assert.equal((await request("/api/whiteboards/ai/stop", cookie, { workspace: fixture.secondWorkspace, runId: held.runId })).status, 404, "project B cannot stop project A's run");
  assert.ok(fixture.held(), "a foreign project's rejected stop leaves the original run active");
  assert.equal((await request("/api/workspaces/select", cookie, { path: workspace })).status, 200);
  assert.equal((await (await request(heldRoute, cookie)).json() as { status: string }).status, "running", "returning to the original project preserves its run");
  assert.equal((await request("/api/customize/settings", cookie, { effortLevel: "low" })).status, 409, "the running project's own configuration mutations remain blocked");
  const stopping = await request("/api/whiteboards/ai/stop", cookie, { workspace, runId: held.runId }); assert.equal(stopping.status, 200);
  const stopped = await completed(held.runId); assert.equal(stopped.status, "stopped"); assert.equal(stopped.drawings.length, 0);
  assert.equal((await request("/api/whiteboards/ai/start", cookie, { ...startBody, workspace: fixture.secondWorkspace })).status, 409);
  console.log("Whiteboard AI HTTP passed: actual QueryEngine tool round trips, scoped tools, draft isolation, continuation, account/workspace guards, slash rejection, cancellation and authenticated assets; no production model calls.");
} finally { await fixture.close(); }
