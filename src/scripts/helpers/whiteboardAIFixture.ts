/** Isolated real Web/auth/Agent transport fixture. Never used by production code. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createServer } from "node:http";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { startAccountFixture } from "./accountFixture.js";
import { accountHome } from "../../platform/account.js";

export async function startWhiteboardAIFixture() {
  const root = path.resolve(import.meta.dirname, "../../.."), parent = await fs.realpath(os.tmpdir());
  const temp = await fs.realpath(await fs.mkdtemp(path.join(parent, "ccagent-whiteboard-ai-")));
  const workspace = path.join(temp, "workspace"), secondWorkspace = path.join(temp, "other-workspace"), base = path.join(temp, "profile");
  await fs.mkdir(workspace); await fs.mkdir(secondWorkspace);
  const account = await startAccountFixture(base);
  const requests: Array<{ tools: string[]; lastUser: string; toolNames: string[] }> = [];
  let held = 0, calls = 0;
  const modelServer = createServer(async (req, res) => {
    try {
      let raw = ""; for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw) as { messages: Array<{ role: string; content?: unknown; tool_calls?: Array<{ function: { name: string } }> }>; tools?: Array<{ function: { name: string } }> };
      const messages = body.messages ?? [];
      let lastIndex = messages.length - 1;
      while (lastIndex >= 0 && messages[lastIndex]!.role !== "user") lastIndex--;
      const lastUser = String(messages[lastIndex]?.content ?? ""), recent = messages.slice(lastIndex + 1);
      const toolNames = recent.flatMap(m => m.tool_calls ?? []).map(t => t.function.name);
      requests.push({ tools: (body.tools ?? []).map(t => t.function.name), lastUser, toolNames }); calls++;
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
      if (lastUser.includes("HOLD_WEB_RESPONSE") || lastUser.includes("HOLD_WEB_TOOL")) {
        held++;
        const delta = lastUser.includes("HOLD_WEB_TOOL")
          ? { role: "assistant", tool_calls: [{ index: 0, id: "interrupted-write", type: "function", function: { name: "Write", arguments: JSON.stringify({ file_path: path.join(workspace, "must-not-exist.txt"), content: "forbidden interrupted tool" }) } }] }
          : { role: "assistant", content: "PARTIAL_WEB_RESPONSE" };
        res.write(`data: ${JSON.stringify({ id: `fixture-${calls}`, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
        const pulse = setInterval(() => res.write(": waiting\n\n"), 1000);
        res.on("close", () => { clearInterval(pulse); held--; }); return;
      }
      if (lastUser.includes("WEB_RESPONSE_COMPLETE")) {
        res.write(`data: ${JSON.stringify({ id: `fixture-${calls}`, choices: [{ index: 0, delta: { role: "assistant", content: "WEB_RESUMED_EXPLICITLY" }, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 } })}\n\ndata: [DONE]\n\n`);
        res.end(); return;
      }
      if (lastUser.includes("WAIT_WEB_PERMISSION")) {
        const delta = { role: "assistant", tool_calls: [{ index: 0, id: "permission-write", type: "function", function: { name: "Write", arguments: JSON.stringify({ file_path: path.join(workspace, "permission-must-not-exist.txt"), content: "Never approve this isolated fixture write" }) } }] };
        res.write(`data: ${JSON.stringify({ id: `fixture-${calls}`, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
        res.end(`data: ${JSON.stringify({ id: `fixture-${calls}`, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 } })}\n\ndata: [DONE]\n\n`);
        return;
      }
      if (lastUser.includes("HOLD_AI_DRAWING")) {
        held++; res.flushHeaders(); const pulse = setInterval(() => res.write(": waiting\n\n"), 1000);
        res.on("close", () => { clearInterval(pulse); held--; }); return;
      }
      let name = "", args: Record<string, unknown> = {}, text = "已准备好绘图方案，可以继续描述需要调整的内容。";
      if (lastUser.includes("HOSTILE_AI_TOOL") && !toolNames.includes("Bash")) {
        name = "Bash"; args = { command: "echo unexpected > must-not-exist.txt", description: "scope regression fixture" };
      } else if (!toolNames.includes("WhiteboardRead")) name = "WhiteboardRead";
      else if (!toolNames.includes("WhiteboardDraw")) {
        name = "WhiteboardDraw";
        args = lastUser.includes("SECOND_AI_EDIT")
          ? { nodes: [{ id: "public-participation", type: "rectangle", label: "公众参与", backgroundColor: "#fff3bf" }], edges: [], layout: "right" }
          : { nodes: [{ id: "intake", type: "rectangle", label: "需求收集", backgroundColor: "#dbe4ff" }, { id: "review", type: "diamond", label: "方案评估", backgroundColor: "#fff3bf" }, { id: "delivery", type: "rectangle", label: "实施更新", backgroundColor: "#d3f9d8" }], edges: [{ id: "review-flow", from: "intake", to: "review" }, { id: "delivery-flow", from: "review", to: "delivery" }], layout: "right" };
      }
      const chunk = (delta: unknown, finish: string | null) => res.write(`data: ${JSON.stringify({ id: `fixture-${calls}`, object: "chat.completion.chunk", model: "whiteboard-fixture", choices: [{ index: 0, delta, finish_reason: finish }], ...(finish ? { usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } } : {}) })}\n\n`);
      if (name) { chunk({ role: "assistant", tool_calls: [{ index: 0, id: `tool-${calls}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, null); chunk({}, "tool_calls"); }
      else { chunk({ role: "assistant", content: text }, null); chunk({}, "stop"); }
      res.end("data: [DONE]\n\n");
    } catch (error) { if (!res.headersSent) res.writeHead(500); res.end(String(error)); }
  });
  await new Promise<void>(resolve => modelServer.listen(0, "127.0.0.1", resolve));
  const modelAddress = modelServer.address(); assert.ok(modelAddress && typeof modelAddress !== "string");
  const profile = { defaultModel: "whiteboard-fixture", models: { "whiteboard-fixture": { protocol: "openai-chat", model: "whiteboard-fixture", baseURL: `http://127.0.0.1:${modelAddress.port}/v1`, apiKey: "fixture-only-not-a-provider-key" } }, mcpServers: {}, disableAllHooks: true };
  for (const user of account.users) { const home = accountHome(base, user.id); await fs.mkdir(home, { recursive: true }); await fs.writeFile(path.join(home, "settings.json"), JSON.stringify(profile)); }
  const emptyEnv = path.join(temp, "empty.env"); await fs.writeFile(emptyEnv, "");
  const reservation = createServer(); await new Promise<void>(resolve => reservation.listen(0, "127.0.0.1", resolve));
  const address = reservation.address(); assert.ok(address && typeof address !== "string"); const port = address.port;
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  const origin = `http://127.0.0.1:${port}`;
  const env: NodeJS.ProcessEnv = { ...process.env, CCAGENT_HOME: base, CCAGENT_PLATFORM_HOME: base, CCAGENT_ENV_FILE: emptyEnv };
  for (const key of ["CCAGENT_ACCOUNT_ID", "CCAGENT_AUTH_SESSION_FILE", "CCAGENT_DESKTOP_TOKEN", "CCAGENT_WEB_WORKER_TOKEN", "CCAGENT_DESKTOP_APP"]) delete env[key];
  const child: ChildProcess = spawn(process.execPath, [path.join(root, "dist/ccagent.js"), "web", "--workspace", workspace, "--port", String(port)], { cwd: temp, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let logs = "", closed = false;
  child.stdout!.on("data", data => { logs = (logs + data).slice(-8000); }); child.stderr!.on("data", data => { logs = (logs + data).slice(-8000); });
  async function close() {
    if (closed) return; closed = true;
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>(resolve => child.once("close", () => resolve()));
      if (child.connected) child.send("ccagent:shutdown", () => {});
      const force = setTimeout(() => { if (process.platform === "win32" && child.pid) { try { execFileSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); } catch { child.kill(); } } else child.kill(); }, 5000);
      await exited; clearTimeout(force);
    }
    modelServer.closeAllConnections(); await new Promise<void>(resolve => modelServer.close(() => resolve())); await account.close();
    const relative = path.relative(parent, temp); assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative)); await fs.rm(temp, { recursive: true, force: true });
  }
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) throw new Error(logs);
      try { if ((await fetch(origin + "/api/health")).ok) { ready = true; break; } } catch { /* Wait for own supervisor. */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(ready, logs);
  } catch (error) { await close(); throw error; }
  return { origin, workspace, secondWorkspace, temp, base, account, requests, held: () => held, close };
}
