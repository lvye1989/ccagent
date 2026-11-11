/** Official text-only image routing with injected dependencies; no network or credentials. */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages.js";
import type { ModelProfile } from "../services/api/providers/profile.js";
import type { OfficialServiceRoute, ServiceConfiguration } from "../platform/serviceState.js";
import type { ImageBlock } from "../types/message.js";
import { prepareOfficialImageReferences } from "../services/vision/officialImageReferences.js";
import { startAccountFixture } from "./helpers/accountFixture.js";
import { enterPlatformAccount } from "../platform/account.js";
import { saveOfficialServices } from "../platform/gatewayClient.js";
import { QueryEngine, type QueryEngineEvent } from "../core/queryEngine.js";
import { readImageTool } from "../tools/readImageTool.js";
import { fileReadTool } from "../tools/fileReadTool.js";
import { addPastedImage, imageRefToken } from "../core/pastedImages.js";

type Dependencies = NonNullable<Parameters<typeof prepareOfficialImageReferences>[4]>;
const main = "ccagent:deepseek-main", selected = "ccagent:deepseek-selected", native = "ccagent:native-vision";
const cwd = "C:/offline-image-fixture";
const pixels = (value: string): ImageBlock => ({ type: "image", source: { type: "base64", media_type: "image/png", data: Buffer.from(value).toString("base64") } });
const photo = pixels("offline-original-pixels"), secondPhoto = pixels("offline-second-pixels");
const user = (text: string, ...images: ImageBlock[]): MessageParam => ({ role: "user", content: [{ type: "text", text }, ...images] } as MessageParam);

function route(id: string, service: "chat" | "vision", maxImages: number): OfficialServiceRoute {
  return {
    id, name: id, service, protocol: "openai-chat", provider: "fixture",
    pricing: { currency: "CNY", definition: { rates: [{ metric: "requests", price: "1", unitQuantity: "1" }], tariff: { kind: "constant" } }, markup: "1.3", version: 1, sourceUrl: "https://fixture.invalid/pricing" },
    limits: { contextWindow: 131072, maxOutputTokens: 8000, maxImages, fallbackEnabled: false },
  };
}

function fixture(options: {
  auxiliaryEnabled?: boolean;
  visionRoute?: OfficialServiceRoute | null;
  saveAttachment?: Dependencies["saveAttachment"];
} = {}) {
  const visionRoute = options.visionRoute === undefined ? route("official-vision", "vision", 20) : options.visionRoute;
  const configuration: ServiceConfiguration = {
    version: 1, revision: "11111111-1111-4111-8111-111111111111", userId: "fixture-account", origin: "https://fixture.invalid",
    auxiliaryEnabled: options.auxiliaryEnabled ?? true, automaticAuxiliary: false, fallbackEnabled: false,
    roles: { main: "deepseek-main", ...(visionRoute ? { image: visionRoute.id } : {}) },
    routes: [route("deepseek-main", "chat", 0), route("deepseek-selected", "chat", 0), route("native-vision", "chat", 20), ...(visionRoute ? [visionRoute] : [])],
    updatedAt: "2026-11-10T00:00:00.000Z",
  };
  const calls = { configuration: 0, profile: [] as string[], vision: 0, save: [] as Array<{ name: string; base64: string }> };
  const dependencies: Dependencies = {
    configuration: async () => { calls.configuration++; return configuration; },
    profile: async (model, workingDirectory): Promise<ModelProfile> => {
      assert.equal(workingDirectory, cwd); calls.profile.push(model);
      const id = model.startsWith("ccagent:") ? model.slice("ccagent:".length) : undefined;
      return { id: model, protocol: "openai-chat", model: id ?? model, ...(id ? { platformService: id } : {}) };
    },
    vision: async () => { calls.vision++; return visionRoute; },
    saveAttachment: async (workingDirectory, name, base64) => {
      assert.equal(workingDirectory, cwd); calls.save.push({ name, base64 });
      return options.saveAttachment ? options.saveAttachment(workingDirectory, name, base64) : { path: `.ccagent/attachments/fixture-${calls.save.length}/${name}` };
    },
  };
  return { configuration, dependencies, calls };
}

async function execute(messages: MessageParam[], model = main, f = fixture(), signal = new AbortController().signal) {
  return prepareOfficialImageReferences(messages, model, cwd, signal, f.dependencies);
}

function assertTextOnly(messages: MessageParam[]): void {
  const serialized = JSON.stringify(messages);
  assert(!serialized.includes('"type":"image"'), "The text-only main model cannot receive images, including nested tool results");
  assert(!serialized.includes(photo.source.type === "base64" ? photo.source.data : "unreachable"), "Original pixels cannot survive in the text-model history");
}

async function runEngineFixture() {
  const parent = await fs.realpath(os.tmpdir()), temporary = await fs.mkdtemp(path.join(parent, "ccagent-real-image-tool-"));
  const base = path.join(temporary, "platform"), workspace = path.join(temporary, "workspace");
  await fs.mkdir(base); await fs.mkdir(workspace);
  const environmentNames = ["CCAGENT_HOME", "CCAGENT_PLATFORM_HOME", "CCAGENT_ACCOUNT_ID", "CCAGENT_AUTH_SESSION_FILE", "CCAGENT_CLOUD_URL", "CCAGENT_ENV_FILE", "QWEN_MODEL", "QWEN_PROTOCOL", "QWEN_BASE_URL", "QWEN_API_KEY", "DASHSCOPE_BASE_URL", "DASHSCOPE_API_KEY"];
  const previous = Object.fromEntries(environmentNames.map(name => [name, process.env[name]]));
  process.env.CCAGENT_HOME = base; process.env.CCAGENT_PLATFORM_HOME = base;
  for (const name of environmentNames.filter(name => !["CCAGENT_HOME", "CCAGENT_PLATFORM_HOME"].includes(name))) delete process.env[name];
  // A mistaken personal fallback must fail the suite's network guard.
  process.env.QWEN_MODEL = "private-fallback-must-not-run"; process.env.QWEN_BASE_URL = "https://personal.invalid/v1";
  process.env.QWEN_API_KEY = "fixture-only-not-a-real-key";
  const key = "ccagent_" + randomBytes(32).toString("base64url"), roles = { main: "deepseek-main", image: "official-vision" };
  const routes = [route("deepseek-main", "chat", 0), route("deepseek-selected", "chat", 0), route("official-vision", "vision", 20)];
  const requests: Array<{ body: any; taskId: string }> = [];
  let visionMode: "ok" | "fail" | "hold" = "ok", visionArrived: (() => void) | undefined, held = 0, disableBeforeTool = false;
  const account = await startAccountFixture(base, { handleService: async (request, response, owner) => {
    const url = new URL(request.url!, "http://127.0.0.1");
    const reply = (status: number, value: unknown) => { response.writeHead(status); response.end(JSON.stringify(value)); return true; };
    if (!owner) return reply(401, { code: "UNAUTHORIZED" });
    if (url.pathname === "/api/account/me") return reply(200, { user: owner, permissions: [] });
    if (url.pathname === "/api/account/wallet") return reply(200, { wallet: { available: "1000000", frozen: "0" }, entries: [] });
    if (url.pathname.startsWith("/api/account/calls/")) return reply(404, { code: "CALL_NOT_FOUND" });
    if (!url.pathname.startsWith("/v1/")) return false;
    assert.equal(request.headers.authorization, `Bearer ${key}`);
    if (url.pathname === "/v1/models") return reply(200, { data: routes, defaults: { chat: roles.main, vision: roles.image } });
    assert.equal(url.pathname, "/v1/chat/completions");
    let raw = ""; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw), taskId = String(request.headers["x-ccagent-task-id"]); requests.push({ body, taskId });
    assert(taskId && taskId !== "undefined");
    if (body.model === "official-vision") {
      assert(JSON.stringify(body).includes("data:image/png;base64,"), "The real ReadImage transport sends pixels to official vision");
      assert(!body.tools?.length, "The vision extraction has no native tools");
      if (visionMode === "fail") return reply(400, { code: "UNPRICED_CAPABILITY" });
      if (visionMode === "hold") {
        held++; response.writeHead(200, { "content-type": "text/event-stream" }); response.flushHeaders();
        response.once("close", () => { held--; }); visionArrived?.(); return true;
      }
    } else {
      assert(["deepseek-main", "deepseek-selected"].includes(body.model));
      assert(!JSON.stringify(body).includes("data:image/"), "DeepSeek never receives current or historical pixels");
      assert(body.tools.some((tool: any) => tool.function.name === "ReadImage"), "The actual dispatcher tool is offered to the main model");
    }
    if (body.model !== "official-vision" && disableBeforeTool && !(body.messages ?? []).some((message: any) => message.role === "tool")) {
      disableBeforeTool = false;
      await saveOfficialServices({ roles, auxiliaryEnabled: false });
    }
    response.writeHead(200, { "content-type": "text/event-stream", "x-ccagent-call-id": randomUUID() });
    const toolResults = (body.messages ?? []).filter((message: any) => message.role === "tool");
    const allText = body.messages.flatMap((message: any) => typeof message.content === "string" ? [message.content] : (message.content ?? []).map((part: any) => part.text ?? "")).join("\n");
    const toolNames = (body.messages ?? []).flatMap((message: any) => (message.tool_calls ?? []).map((tool: any) => tool.function.name));
    let delta: Record<string, unknown>, finish: string;
    if (body.model === "official-vision") { delta = { role: "assistant", content: "TOOL_VISION_EVIDENCE: EXIT arrow points right." }; finish = "stop"; }
    else if (allText.includes("READ_IMAGE_FROM_TOOL") && !toolNames.includes("Read")) {
      delta = { role: "assistant", tool_calls: [{ index: 0, id: `read-file-${requests.length}`, type: "function", function: { name: "Read", arguments: JSON.stringify({ file_path: "source.png" }) } }] }; finish = "tool_calls";
    } else if (toolResults.length > 0 && (!allText.includes("READ_IMAGE_FROM_TOOL") || toolNames.includes("ReadImage"))) {
      delta = { role: "assistant", content: JSON.stringify(toolResults).includes("ReadImage error:") ? "MAIN_SAW_TOOL_FAILURE" : "MAIN_USED_TOOL_VISION_EVIDENCE" }; finish = "stop";
    } else {
      const imagePath = /"(\.ccagent\/attachments\/[^"\n]+\.png)"/.exec(allText)?.[1];
      assert(imagePath, "The actual main request contains the saved local ReadImage path");
      delta = { role: "assistant", tool_calls: [{ index: 0, id: `read-${requests.length}`, type: "function", function: { name: "ReadImage", arguments: JSON.stringify({ file_path: imagePath, prompt: "Read the EXIT arrow direction." }) } }] }; finish = "tool_calls";
    }
    response.write(`data: ${JSON.stringify({ id: randomUUID(), model: body.model, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 3 } })}\n\ndata: [DONE]\n\n`);
    return true;
  } });
  const collect = async (engine: QueryEngine, prompt: string) => {
    const events: QueryEngineEvent[] = [], iterator = engine.submitMessage(prompt);
    while (true) { const item = await iterator.next(); if (item.done) return { events, result: item.value }; events.push(item.value); }
  };
  const makeEngine = (id: string, extra: Partial<ConstructorParameters<typeof QueryEngine>[0]> = {}) => new QueryEngine({
    model: main, toolContext: { cwd: workspace, sessionId: id, scopedTools: [readImageTool] }, ...extra,
  });
  try {
    await account.nativeClient.signIn(account.users[0]!.email, account.password); const entered = await enterPlatformAccount();
    await fs.writeFile(path.join(entered.home, "settings.json"), JSON.stringify({ disableAllHooks: true }));
    await saveOfficialServices({ apiKey: key, roles, auxiliaryEnabled: true });
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jr4kAAAAASUVORK5CYII=", "base64");
    await fs.writeFile(path.join(workspace, "source.png"), png);
    for (const model of [main, selected]) {
      const engine = makeEngine(`image-${model.replaceAll(":", "-")}`); if (model === selected) engine.selectSessionModel(model);
      const before = requests.length, result = await collect(engine, "请读取出口方向 @source.png");
      assert.equal(result.result.reason, "completed");
      assert.deepEqual(requests.slice(before).map(item => item.body.model), [model.slice("ccagent:".length), "official-vision", model.slice("ccagent:".length)]);
      assert(result.events.some(event => event.type === "tool_use_start" && event.name === "ReadImage"));
      assert(result.events.some(event => event.type === "tool_use_done" && event.name === "ReadImage" && !event.result.isError));
      assert(result.events.some(event => event.type === "text" && event.text.includes("MAIN_USED_TOOL_VISION_EVIDENCE")));
      assert.equal(engine.getState().model, model); assertTextOnly(engine.getState().messages);
      assert(requests.slice(before).every(item => item.taskId === `image-${model.replaceAll(":", "-")}`));
      const followupBefore = requests.length; await collect(engine, "请用一句中文复述。");
      assert.deepEqual(requests.slice(followupBefore).map(item => item.body.model), [model.slice("ccagent:".length)]);
      assertTextOnly(engine.getState().messages);
    }
    pass("real QueryEngine default and selected DeepSeek execute ReadImage, official vision, then the original main model; text follow-ups retain evidence");
    {
      const clipboard = addPastedImage({ block: { type: "image", source: { type: "base64", media_type: "image/png", data: png.toString("base64") } }, mediaType: "image/png", bytes: png.byteLength, filename: "clipboard-only.png" });
      const engine = makeEngine("clipboard-image"), before = requests.length;
      const result = await collect(engine, `请读取剪贴板出口图 ${imageRefToken(clipboard)}`);
      assert.equal(result.result.reason, "completed");
      assert.deepEqual(requests.slice(before).map(item => item.body.model), ["deepseek-main", "official-vision", "deepseek-main"]);
      assert(result.events.some(event => event.type === "tool_use_done" && event.name === "ReadImage" && !event.result.isError));
      assertTextOnly(engine.getState().messages);
      pass("a clipboard image without a source path becomes a saved reference and uses the actual ReadImage tool chain");
    }
    {
      const engine = makeEngine("read-image-tool-result", { toolContext: { cwd: workspace, sessionId: "read-image-tool-result", scopedTools: [fileReadTool, readImageTool] } });
      const before = requests.length, result = await collect(engine, "READ_IMAGE_FROM_TOOL: Read source.png, then extract the EXIT direction.");
      assert.equal(result.result.reason, "completed");
      assert.deepEqual(requests.slice(before).map(item => item.body.model), ["deepseek-main", "deepseek-main", "official-vision", "deepseek-main"]);
      assert(result.events.some(event => event.type === "tool_use_done" && event.name === "Read" && !event.result.isError));
      assert(result.events.some(event => event.type === "tool_use_done" && event.name === "ReadImage" && !event.result.isError));
      assertTextOnly(engine.getState().messages);
      pass("image blocks returned by a real Read tool are converted within the same agent loop before another DeepSeek request");
    }
    {
      const engine = makeEngine("restored-image", { initialMessages: [user("An old failed screenshot", { type: "image", source: { type: "base64", media_type: "image/png", data: png.toString("base64") } })] });
      const before = requests.length; await collect(engine, "继续读取历史图片。");
      assert.deepEqual(requests.slice(before).map(item => item.body.model), ["deepseek-main", "official-vision", "deepseek-main"]); assertTextOnly(engine.getState().messages);
      pass("a restored failed image turn goes through the real ReadImage dispatcher before the main model answers");
    }
    {
      visionMode = "fail"; const engine = makeEngine("failed-image"), before = requests.length;
      const result = await collect(engine, "读取失败场景 @source.png");
      assert.equal(result.result.reason, "completed");
      assert.equal(requests.slice(before).filter(item => item.body.model === "official-vision").length, 1);
      assert(result.events.some(event => event.type === "tool_use_done" && event.name === "ReadImage" && event.result.isError));
      assert(result.events.some(event => event.type === "text" && event.text.includes("MAIN_SAW_TOOL_FAILURE")));
      pass("a deterministic official vision failure is a real tool error and is not retried or sent to a private provider");
    }
    {
      visionMode = "ok"; disableBeforeTool = true; const engine = makeEngine("aux-disabled-before-tool"), before = requests.length;
      const result = await collect(engine, "请求发出后关闭读图辅助 @source.png");
      assert.equal(result.result.reason, "completed");
      assert.deepEqual(requests.slice(before).map(item => item.body.model), ["deepseek-main", "deepseek-main"]);
      assert(result.events.some(event => event.type === "tool_use_done" && event.name === "ReadImage" && event.result.isError));
      await saveOfficialServices({ roles, auxiliaryEnabled: true });
      pass("disabling auxiliaries between main selection and actual ReadImage execution cannot trigger a private-provider fallback");
    }
    {
      visionMode = "hold"; const engine = makeEngine("cancelled-image"), before = requests.length;
      const arrived = new Promise<void>(resolve => { visionArrived = resolve; });
      const running = collect(engine, "取消读取图片 @source.png");
      await Promise.race([arrived, new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("Vision fixture did not start")), 10000).unref())]);
      assert.equal(held, 1); assert.equal(engine.interrupt(), true);
      const result = await running; assert.equal(result.result.reason, "aborted");
      for (let index = 0; index < 50 && held; index++) await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(held, 0, "Interrupt closes the actual vision HTTP connection");
      assert.deepEqual(requests.slice(before).map(item => item.body.model), ["deepseek-main", "official-vision"]);
      pass("interrupt during actual ReadImage vision aborts its connection and prevents another main-model request");
    }
    {
      visionMode = "ok"; await saveOfficialServices({ roles, auxiliaryEnabled: false });
      const before = requests.length, result = await collect(makeEngine("aux-off"), "辅助关闭 @source.png");
      assert.equal(result.result.reason, "model_error"); assert.equal(requests.length, before);
      assert(result.events.some(event => event.type === "error"));
      await saveOfficialServices({ roles, auxiliaryEnabled: true });
      const scoped = makeEngine("read-image-out-of-scope", { toolContext: { cwd: workspace, sessionId: "read-image-out-of-scope", scopedTools: [] } });
      const scopeResult = await collect(scoped, "工具范围关闭 @source.png");
      assert.equal(scopeResult.result.reason, "model_error"); assert.equal(requests.length, before);
      pass("disabled official auxiliaries and missing ReadImage scope both block before any main or vision model request");
    }
  } finally {
    await account.close();
    for (const [name, value] of Object.entries(previous)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    const relative = path.relative(parent, await fs.realpath(temporary));
    assert(relative && !relative.startsWith("..") && !path.isAbsolute(relative)); await fs.rm(temporary, { recursive: true, force: true });
  }
}

let checks = 0;
const pass = (label: string) => console.log(`PASS ${++checks} ${label}`);
const originalFetch = globalThis.fetch;
let networkAttempts = 0;
globalThis.fetch = async () => { networkAttempts++; throw new Error("This offline suite forbids all network requests"); };
try {
  {
    const f = fixture(), messages = [{ role: "user", content: "Plain follow-up" }] as MessageParam[];
    const result = await execute(messages, main, f);
    assert.equal(result.messages, messages); assert.equal(result.imageCount, 0); assert.equal(f.calls.save.length, 0);
    pass("plain text preserves its history and does not create an image reference");
  }
  {
    for (const model of ["personal-text-model", native]) {
      const f = fixture({ auxiliaryEnabled: false }), messages = [user("An existing model path", photo)], original = structuredClone(messages);
      const result = await execute(messages, model, f);
      assert.equal(result.messages, messages); assert.deepEqual(messages, original); assert.equal(result.imageCount, 0); assert.equal(f.calls.save.length, 0);
    }
    pass("personal models and official models with image support preserve their existing image path");
  }
  {
    for (const model of [main, selected]) {
      const f = fixture(), messages = [user("请判断这张图的出口方向", photo)], original = structuredClone(messages);
      const result = await execute(messages, model, f);
      assert.equal(result.imageCount, 1); assert.equal(f.calls.save.length, 1);
      assert.equal(f.calls.save[0]!.base64, photo.source.type === "base64" ? photo.source.data : "unreachable");
      assert.match(f.calls.save[0]!.name, /\.png$/i); assert(f.calls.profile.includes(model));
      assertTextOnly(result.messages); assert.match(JSON.stringify(result.messages), /ReadImage/);
      assert.match(JSON.stringify(result.messages), /fixture-1/); assert.match(JSON.stringify(result.messages), /出口方向/);
      assert.deepEqual(messages, original, "Preparing text references cannot mutate the original history");
    }
    pass("default and explicitly selected official text models receive local references with ReadImage instructions");
  }
  {
    const f = fixture(), result = await execute([user("Compare the two arrows", photo, secondPhoto)], main, f);
    assert.equal(result.imageCount, 2); assert.equal(f.calls.save.length, 2);
    assert.notEqual(f.calls.save[0]!.base64, f.calls.save[1]!.base64); assertTextOnly(result.messages);
    assert.match(JSON.stringify(result.messages), /fixture-1/); assert.match(JSON.stringify(result.messages), /fixture-2/);
    pass("multiple attachments retain a distinct local ReadImage reference for each image");
  }
  {
    const f = fixture(), messages: MessageParam[] = [
      user("Previously failed screenshot", photo),
      { role: "assistant", content: "Please continue." },
      user("The same screenshot", structuredClone(photo)),
      { role: "user", content: "Now answer in Chinese." },
    ];
    const result = await execute(messages, main, f);
    assertTextOnly(result.messages); assert.equal(f.calls.save.length, 1, "Identical history images share a single persisted local attachment");
    assert.equal(result.messages.length, messages.length); assert.match(JSON.stringify(result.messages), /Now answer in Chinese/);
    const followup = fixture(), next = await execute(result.messages, main, followup);
    assert.equal(next.messages, result.messages); assert.equal(next.imageCount, 0); assert.equal(followup.calls.save.length, 0);
    pass("failed image histories are converted once and subsequent text turns reuse their saved references");
  }
  {
    const f = fixture(), messages: MessageParam[] = [
      { role: "assistant", content: [{ type: "tool_use", id: "read-screenshot", name: "Read", input: { file_path: "old.png" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "read-screenshot", is_error: false, content: [{ type: "text", text: "File: old.png" }, photo] }] } as MessageParam,
      { role: "user", content: "Summarize the Read result." },
    ];
    const original = structuredClone(messages), result = await execute(messages, main, f);
    assert.equal(f.calls.save.length, 1); assertTextOnly(result.messages); assert.deepEqual(messages, original);
    const block = (result.messages[1]!.content as Array<{ type: string; tool_use_id?: string; is_error?: boolean; content?: unknown }>)[0]!;
    assert.equal(block.type, "tool_result"); assert.equal(block.tool_use_id, "read-screenshot"); assert.equal(block.is_error, false);
    assert.match(JSON.stringify(block.content), /File: old\.png/); assert.match(JSON.stringify(block.content), /ReadImage/);
    pass("nested Read images become local references without losing tool-call pairing or sibling text");
  }
  {
    const f = fixture({ auxiliaryEnabled: false }), messages = [user("Do not use a private fallback", photo)], original = structuredClone(messages);
    await assert.rejects(() => execute(messages, main, f), /辅助|关闭|auxiliary|disabled/i);
    assert.equal(f.calls.save.length, 0); assert.deepEqual(messages, original);
    pass("disabled official auxiliaries fail before persistence or private-provider fallback");
  }
  {
    for (const visionRoute of [null, route("no-image-vision", "vision", 0), route("wrong-service", "chat", 20)]) {
      const f = fixture({ visionRoute });
      await assert.rejects(() => execute([user("Missing or incapable vision route", photo)], main, f));
      assert.equal(f.calls.save.length, 0);
    }
    pass("missing, image-incapable, or non-vision auxiliary routes fail before creating references");
  }
  {
    const f = fixture({ saveAttachment: async () => { throw new Error("FIXTURE_SAVE_FAILURE"); } });
    const messages = [user("Keep the request after persistence failure", photo)], original = structuredClone(messages);
    await assert.rejects(() => execute(messages, main, f), /FIXTURE_SAVE_FAILURE/);
    assert.equal(f.calls.save.length, 1); assert.deepEqual(messages, original);
    pass("attachment persistence failures propagate once while preserving the original request");
  }
  {
    const f = fixture(), remote: ImageBlock = { type: "image", source: { type: "url", url: "https://fixture.invalid/private-image.png" } };
    await assert.rejects(() => execute([user("Remote history must not fetch", remote)], main, f));
    assert.equal(f.calls.save.length, 0);
    pass("URL image history is rejected without a network fetch");
  }
  {
    const f = fixture({ auxiliaryEnabled: false, visionRoute: null });
    const remote: ImageBlock = { type: "image", source: { type: "url", url: "https://fixture.invalid/old-image.png" } };
    const messages = [user("Historical image, already discussed", photo), user("Historical remote image", remote)];
    const original = structuredClone(messages);
    const result = await prepareOfficialImageReferences(messages, main, cwd, new AbortController().signal, f.dependencies, false);
    assertTextOnly(result.messages); assert.equal(result.imageCount, 2); assert.equal(f.calls.save.length, 1);
    assert.equal(f.calls.vision, 0); assert.deepEqual(messages, original);
    assert.match(JSON.stringify(result.messages), /old-image\.png/);
    pass("historical images remain text-safe for follow-ups after auxiliaries are disabled, including remote references without fetching");
  }
  {
    const controller = new AbortController(); controller.abort(); const f = fixture();
    await assert.rejects(() => execute([user("Already cancelled", photo)], main, f, controller.signal));
    assert.equal(f.calls.save.length, 0);
    pass("already cancelled turns cannot create image references");
  }
  {
    const controller = new AbortController(); let release!: () => void, arrived!: () => void;
    const started = new Promise<void>(resolve => { arrived = resolve; });
    const f = fixture({ saveAttachment: async () => {
      arrived(); await new Promise<void>(resolve => { release = resolve; });
      return { path: ".ccagent/attachments/late/image.png" };
    } });
    const messages = [user("Cancel during persistence", photo)], original = structuredClone(messages);
    const running = execute(messages, main, f, controller.signal), rejected = assert.rejects(running);
    await started; controller.abort(); release(); await rejected;
    assert.equal(f.calls.save.length, 1); assert.deepEqual(messages, original);
    pass("mid-persistence cancellation rejects late results without modifying message history");
  }
  assert.equal(networkAttempts, 0, "All reference tests must remain fully offline");
  await runEngineFixture();
  assert.equal(networkAttempts, 0, "No personal-provider fallback or external fetch is allowed");
  console.log(`${checks} official image checks passed (pure dependency fixtures plus real QueryEngine, ReadImage dispatcher, and loopback official account/model transport; no external provider or charge).`);
} finally {
  globalThis.fetch = originalFetch;
}
