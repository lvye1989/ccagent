import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { buildUserMessageContent } from "../core/attachImages.js";
import { fileReadTool } from "../tools/fileReadTool.js";
import { readImageTool } from "../tools/readImageTool.js";
import { prepareRequest } from "../services/api/providers/providerStream.js";
import { findToolByName } from "../tools/index.js";
import { getBuiltInAgents } from "../agents/builtIn/index.js";
import type { ModelProfile } from "../services/api/providers/profile.js";
import type { StreamRequestParams } from "../services/api/streaming.js";
import { checkPermission } from "../permissions/permissions.js";

const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "ccagent-image-pipeline-")));
const workspace = path.join(temp, "workspace"), home = path.join(temp, "home");
await fs.mkdir(workspace); await fs.mkdir(home);
const names = ["CCAGENT_HOME", "QWEN_MODEL", "QWEN_PROTOCOL", "QWEN_BASE_URL", "QWEN_API_KEY", "DASHSCOPE_BASE_URL", "DASHSCOPE_API_KEY"];
const oldEnv = new Map(names.map((name) => [name, process.env[name]]));
for (const name of names) delete process.env[name];
process.env.CCAGENT_HOME = home;
const imageName = "中文 图片.png", bytes = Buffer.from("fixture-image-bytes");
await fs.writeFile(path.join(workspace, imageName), bytes);
const requests: Record<string, any>[] = [];
const server = createServer(async (req, res) => {
  let raw = ""; for await (const part of req) raw += part;
  const body = JSON.parse(raw); requests.push(body);
  if (JSON.stringify(body).includes("FAIL_VISION")) { res.writeHead(401, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { message: "Fixture denied" } })); return; }
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "图像文字：共享视觉证据" }, finish_reason: null }] })}\n\n`);
  res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 4, completion_tokens: 4 } })}\n\ndata: [DONE]\n\n`);
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const baseURL = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
await fs.writeFile(path.join(home, "settings.json"), JSON.stringify({ models: { vision: { protocol: "openai-chat", model: "fixture-vision", baseURL } }, modelRoles: { image: "vision" } }));
try {
  for (const reference of [`@${JSON.stringify(imageName)}`, `@'${imageName}'`, `@${JSON.stringify(path.join(workspace, imageName))}`]) {
    const built = await buildUserMessageContent(`OCR ${reference}`, workspace);
    assert.equal(built.attached.length, 1, reference); assert.equal(built.errors.length, 0);
    assert(Array.isArray(built.content));
    const image = built.content.find((part) => part.type === "image"); assert(image?.type === "image" && image.source.type === "base64"); assert.equal(image.source.data, bytes.toString("base64"));
  }
  await fs.writeFile(path.join(workspace, "plain.jpg"), bytes);
  assert.equal((await buildUserMessageContent("OCR @plain.jpg.", workspace)).attached.length, 1);
  const outside = path.join(temp, "outside.jpg"); await fs.writeFile(outside, bytes);
  const rejected = await buildUserMessageContent(`OCR @${JSON.stringify(outside)}`, workspace); assert.equal(rejected.attached.length, 0); assert.equal(rejected.errors.length, 1);

  const result = await fileReadTool.call({ file_path: imageName }, { cwd: workspace }); assert(!result.isError);
  const messages = [
    { role: "assistant", content: [{ type: "tool_use", id: "read-image-1", name: "Read", input: { file_path: imageName } }, { type: "tool_use", id: "read-text-2", name: "Read", input: { file_path: "notes.txt" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "read-image-1", content: result.content }, { type: "tool_result", tool_use_id: "read-text-2", content: "notes" }] },
  ] as StreamRequestParams["messages"];
  for (const protocol of ["openai-chat", "openai-responses", "gemini"] as const) {
    const profile: ModelProfile = { id: "fixture", protocol, model: "fixture", baseURL };
    const prepared = prepareRequest(profile, { model: "fixture", messages, maxTokens: 50 });
    const serialized = JSON.stringify(prepared.body);
    assert(serialized.includes(bytes.toString("base64")), `${protocol} retains actual image bytes from Read`);
    assert(serialized.includes("read-image-1") && serialized.includes("read-text-2"), "Parallel tool call IDs survive");
    if (protocol === "openai-chat") {
      const outgoing = prepared.body.messages as any[];
      assert.deepEqual(outgoing.filter((msg) => msg.role === "tool").map((msg) => msg.tool_call_id), ["read-image-1", "read-text-2"]);
      assert.equal(outgoing.at(-1).role, "user"); assert(outgoing.at(-1).content.some((part: any) => part.type === "image_url"));
    }
    if (protocol === "openai-responses") {
      const outgoing = prepared.body.input as any[];
      assert.deepEqual(outgoing.filter((item) => item.type === "function_call_output").map((item) => item.call_id), ["read-image-1", "read-text-2"]);
      assert(outgoing.at(-1).content.some((part: any) => part.type === "input_image"));
    }
  }
  assert.equal(findToolByName("ReadImage"), readImageTool);
  assert.equal((await checkPermission({ tool: readImageTool, input: { file_path: imageName }, cwd: workspace, mode: "plan", settings: { mode: "plan", allow: [], deny: [] } })).behavior, "allow", "ReadImage works in read-only planning mode");
  assert(getBuiltInAgents().some((agent) => agent.agentType === "image_reader" && agent.tools?.includes("ReadImage")));
  const evidence = await readImageTool.call({ file_path: imageName }, { cwd: workspace });
  assert(!evidence.isError); assert.match(String(evidence.content), /共享视觉证据/); assert.match(String(evidence.content), /Vision model: vision/);
  assert(JSON.stringify(requests[0]).includes(bytes.toString("base64")), "Vision endpoint received pixels");
  assert.equal(requests[0].max_tokens, 8000, "OCR has enough output budget");
  const before = requests.length;
  assert((await readImageTool.call({ file_path: outside }, { cwd: workspace })).isError); assert.equal(requests.length, before, "Outside images are rejected before any request");
  assert((await readImageTool.call({ file_path: imageName, prompt: "FAIL_VISION" }, { cwd: workspace })).isError); assert.equal(requests.length, before + 1, "Deterministic vision failures are not looped");
  const aborted = new AbortController(); aborted.abort();
  assert((await readImageTool.call({ file_path: imageName }, { cwd: workspace, abortSignal: aborted.signal })).isError); assert.equal(requests.length, before + 1);
  console.log("Image pipeline: quoted/spaced/Unicode paths, CLI/Web attachment grammar, all provider tool-result image bytes, call-ID pairing, shared ReadImage model, registered reader agent, path boundaries, deterministic failure and cancellation passed.");
} finally {
  server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const [name, value] of oldEnv) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  const relative = path.relative(await fs.realpath(os.tmpdir()), temp); if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Unsafe test cleanup");
  await fs.rm(temp, { recursive: true, force: true });
}
