/** Real local account + HTTP + private uploads; no external request or provider Key. */
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, realpath, rm, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startAccountFixture } from "./helpers/accountFixture.js";
import { enterPlatformAccount } from "../platform/account.js";
import { saveOfficialServices, getPlatformGatewayClient, forgetOfficialKey, refreshOfficialImageCatalog } from "../platform/gatewayClient.js";
import { servicePaths } from "../platform/serviceState.js";
import { generateDesignImage, resumeDesignImage, getDesignImageConfig, validateDesignRaster, validateImageGenerationOptions, KIE_ASPECT_RATIOS, DesignImageError } from "../services/images/designImageProvider.js";
import { createDesignAssets } from "../entrypoint/webDesignAssets.js";
import { createWhiteboardDesignManager } from "../entrypoint/webWhiteboardDesign.js";
import { handleWhiteboard } from "../entrypoint/webWhiteboards.js";

const oldEnv = { ...process.env }, root = await realpath(await mkdtemp(path.join(await realpath(os.tmpdir()), "ccagent-kie-native-"))), base = path.join(root, "profile"), workspace = path.join(root, "workspace");
await mkdir(workspace); process.env.CCAGENT_PLATFORM_HOME = base; process.env.CCAGENT_HOME = base;
for (const name of ["CCAGENT_ACCOUNT_ID", "CCAGENT_AUTH_SESSION_FILE", "NODE_TLS_REJECT_UNAUTHORIZED"]) delete process.env[name];
const key = "ccagent_" + randomBytes(32).toString("base64url");
const raster = validateDesignRaster({ dataURL: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aFe0AAAAASUVORK5CYII=" });
const routes = ["flare", "sunburst"].flatMap(variant => ["text-to-image", "image-to-image"].map(mode => ({ id: `${variant}-${mode}`, name: `${variant} ${mode}`, service: "image", protocol: "kie-images", upstreamModel: `gpt-image-2-5-${variant}-${mode}`,
  pricing: { currency: "CNY", definition: { tariff: { kind: "constant" }, rates: ["1k", "2k", "4k"].map(resolution => ({ metric: `output_images_${resolution}`, price: "0.2", unitQuantity: "1" })) }, markup: "1.3", version: 1, sourceUrl: "https://kie.ai/gpt-image-2-5", fingerprint: "1".repeat(64) },
  limits: { contextWindow: 20000, maxOutputTokens: 1, maxImages: 16 } })));
const files = new Map<string, { owner: string; bytes: Buffer; ready: boolean; mime: string; token: string }>();
let publishedRoutes = routes, publishedDefault: string | undefined, catalogReads = 0;
const tasks = new Map<string, { owner: string; state: string; polls: number; fileId: string }>();
const creates: Record<string, unknown>[] = []; let polls = 0, puts = 0, mode = "normal";
let fixture: Awaited<ReturnType<typeof startAccountFixture>>;
fixture = await startAccountFixture(base, { handleService: async (req, res, user) => {
  const url = new URL(req.url!, fixture.origin), reply = (status: number, value: unknown) => { res.writeHead(status); res.end(JSON.stringify(value)); return true; };
  const body = async () => { const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk)); return Buffer.concat(chunks); };
  if (req.method === "PUT" && url.pathname.startsWith("/ccagent/users/")) {
    const id = path.posix.basename(url.pathname).split(".")[0]!, file = files.get(id); assert(file); assert.equal(url.searchParams.get("token"), file.token);
    assert.equal(req.headers.cookie, undefined); assert.equal(req.headers.authorization, undefined); assert.equal(req.headers["content-type"], file.mime);
    file.bytes = await body(); puts++; return reply(200, {});
  }
  if (!user) return reply(401, {});
  if (url.pathname === "/v1/models") { catalogReads++; assert.equal(req.headers.authorization, `Bearer ${key}`); return reply(200, { data: publishedRoutes, defaults: { image: publishedDefault ?? null } }); }
  if (url.pathname === "/api/files" && req.method === "POST") {
    const input = JSON.parse((await body()).toString()); assert.equal(input.purpose, "image"); const id = randomUUID(), token = randomUUID();
    files.set(id, { owner: user.id, mime: input.contentType, ready: false, bytes: Buffer.alloc(0), token });
    const prefix = createHash("sha256").update(user.id).digest("hex").slice(0, 32);
    return reply(201, { id, upload: { url: `${fixture.origin}/ccagent/users/${prefix}/image/${id}.png?token=${token}`, method: "PUT", validUntil: Date.now() + 60000, headers: { "content-type": input.contentType, "x-content-type": input.contentType } } });
  }
  if (url.pathname.startsWith("/api/files/")) {
    const id = url.pathname.split("/").at(-1)!, file = files.get(id); if (!file || file.owner !== user.id) return reply(404, {});
    if (req.method === "POST") { file.ready = true; return reply(200, { id }); }
    res.writeHead(200, { "content-type": file.mime }); res.end(file.bytes); return true;
  }
  if (url.pathname === "/v1/images/tasks" && req.method === "POST") {
    assert.equal(req.headers.authorization, `Bearer ${key}`); assert.equal(req.headers["x-ccagent-price-version"], "1"); assert.equal(req.headers["x-ccagent-price-fingerprint"], "1".repeat(64));
    const input = JSON.parse((await body()).toString()); creates.push(input);
    for (const value of input.input_images ?? []) { const file = files.get(value.replace("ccagent-file:", "")); assert(file?.ready && file.owner === user.id); }
    const id = String(req.headers["idempotency-key"]), fileId = randomUUID(); assert(!tasks.has(id));
    files.set(fileId, { owner: user.id, bytes: Buffer.from(raster.dataURL.split(",")[1]!, "base64"), mime: "image/png", ready: true, token: "" });
    tasks.set(id, { owner: user.id, state: mode === "unknown" ? "unknown" : "processing", polls: 0, fileId });
    if (mode === "lost") { res.destroy(); return true; }
    return reply(202, { id, call_id: id, status: mode === "upload-failed" ? "failed" : mode === "unknown" ? "unknown" : "queued", ...(mode === "upload-failed" ? { code: "IMAGE_INPUT_UPLOAD_FAILED", message: "untrusted upstream detail" } : {}), poll_after_ms: 1, images: [] });
  }
  if (url.pathname.startsWith("/v1/images/tasks/")) {
    const id = url.pathname.split("/").at(-1)!, task = tasks.get(id); if (!task || task.owner !== user.id) return reply(404, {}); polls++; task.polls++;
    return reply(200, { id, call_id: id, status: "succeeded", images: [{ file_id: task.fileId, mime_type: "image/png", expires_at: new Date(Date.now() + 60000).toISOString() }] });
  }
  if (url.pathname.startsWith("/api/account/calls/")) { const id = url.pathname.split("/").at(-1)!, task = tasks.get(id); return task?.owner === user.id ? reply(200, { id, status: "awaiting_usage", resultAvailable: false }) : reply(404, {}); }
  return false;
} });
let assetWorkspace = workspace; const assets = createDesignAssets(() => assetWorkspace);
try {
  await fixture.nativeClient.signIn(fixture.users[0]!.email, fixture.password); await enterPlatformAccount();
  await saveOfficialServices({ apiKey: key, roles: {}, auxiliaryEnabled: false });
  const localConfigurationBefore = await readFile(servicePaths().state, "utf8");
  process.env.IMAGE_EDIT_PROVIDER = "openai"; process.env.IMAGE_EDIT_BASE_URL = "https://legacy.invalid"; process.env.IMAGE_EDIT_API_KEY = "ignored-legacy-environment-key";
  await writeFile(path.join(process.env.CCAGENT_HOME!, "settings.json"), JSON.stringify({ whiteboardDesignImage: { disabled: true, provider: "openai", baseURL: "https://legacy.invalid", model: "legacy-model", apiKey: "ignored-legacy-user-key" } }));
  const config = await getDesignImageConfig(workspace); assert.equal(config.provider, "official"); assert.equal(config.routes?.length, 4); assert.equal(config.configured, true);
  assert.deepEqual(config.modes, { textToImage: true, imageToImage: true }); assert.equal(await readFile(servicePaths().state, "utf8"), localConfigurationBefore);
  const input = (model: string, extra = {}) => ({ model, kind: "architecture" as const, prompt: "Create an isolated architectural diagram.", references: [], requestId: randomUUID(), signal: new AbortController().signal, ...extra });
  for (const variant of ["flare", "sunburst"]) {
    const text = await generateDesignImage(input(`${variant}-text-to-image`, { generationMode: "text-to-image", background: "transparent" }), workspace);
    assert.equal(text.images[0]!.dataURL, raster.dataURL); assert.equal(creates.at(-1)!.input_images, undefined);
    await generateDesignImage(input(`${variant}-image-to-image`, { generationMode: "image-to-image", base: raster, annotated: raster, references: [raster], resolution: "4K", background: "auto", aspect_ratio: "16:9" }), workspace);
    assert.equal((creates.at(-1)!.input_images as string[]).length, 3); assert.equal(creates.at(-1)!.background, undefined);
  }
  await generateDesignImage(input("flare-image-to-image", { references: Array(16).fill(raster), generationMode: "image-to-image", prompt: "x".repeat(20000) }), workspace);
  assert.equal((creates.at(-1)!.input_images as string[]).length, 16); assert.equal((creates.at(-1)!.prompt as string).length, 20000);
  const before = creates.length;
  await assert.rejects(generateDesignImage(input("flare-image-to-image", { references: Array(17).fill(raster) }), workspace), /16/);
  await assert.rejects(generateDesignImage(input("flare-text-to-image", { references: [raster] }), workspace), /模式暂未开放/);
  for (const aspect_ratio of KIE_ASPECT_RATIOS) assert.equal(validateImageGenerationOptions({ aspect_ratio }).aspect_ratio, aspect_ratio);
  for (const ratio of ["27:16", "16:27", "9:8", "8:9"]) assert.throws(() => validateImageGenerationOptions({ aspect_ratio: ratio, resolution: "2K" }), /仅支持 1K/);
  assert.throws(() => validateImageGenerationOptions({ resolution: "4K", background: "transparent" }), /仅支持 1K/); assert.equal(creates.length, before);
  mode = "unknown"; const uncertain = input("flare-text-to-image"); await assert.rejects(generateDesignImage(uncertain, workspace), error => error instanceof DesignImageError && error.code === "DESIGN_IMAGE_UNKNOWN"); assert.equal(creates.length, before + 1); mode = "normal";
  await resumeDesignImage(uncertain.requestId, new AbortController().signal); assert.equal(creates.length, before + 1);
  mode = "lost"; const lost = input("flare-text-to-image"); await assert.rejects(generateDesignImage(lost, workspace), /未确认|尚未确认|连接未完成/); assert.equal(creates.length, before + 2); mode = "normal";
  await resumeDesignImage(lost.requestId, new AbortController().signal); assert.equal(creates.length, before + 2);
  const abort = new AbortController(), interrupted = input("flare-text-to-image", { signal: abort.signal }), pending = generateDesignImage(interrupted, workspace); while (creates.length < before + 3) await new Promise(resolve => setTimeout(resolve, 10)); abort.abort(); await assert.rejects(pending, /停止本地等待/); assert.equal(creates.length, before + 3);
  await resumeDesignImage(interrupted.requestId, new AbortController().signal); assert.equal(creates.length, before + 3);
  const repeat = input("flare-image-to-image", { references: [raster] }); await generateDesignImage(repeat, workspace); const createsBeforeResume = creates.length, putsBeforeResume = puts;
  await generateDesignImage(repeat, workspace); assert.equal(creates.length, createsBeforeResume); assert.equal(puts, putsBeforeResume);
  await assert.rejects(generateDesignImage({ ...repeat, prompt: "changed" }, workspace), /不同图片/); assert.equal(creates.length, createsBeforeResume);
  const asset = await assets.upload(workspace, raster); assert.equal((await assets.read(workspace, [asset.assetId]))[0]!.dataURL, raster.dataURL);
  assetWorkspace = workspace + "-other"; await assert.rejects(assets.read(workspace, [asset.assetId]), /工作文件夹/); assetWorkspace = workspace;
  await assert.rejects(assets.read(workspace, ["../../not-an-asset"]), /不存在/);
  await assets.remove(workspace, asset.assetId); await assert.rejects(assets.read(workspace, [asset.assetId]), /不存在/);
  const board = await handleWhiteboard("create", { name: "Text-to-image fixture" }, workspace); assert("board" in board);
  let busy = false, captured: unknown; const manager = createWhiteboardDesignManager({ getWorkspace: () => workspace, isBusy: () => busy, onBusy: () => { busy = true; }, onIdle: () => { busy = false; }, getConfiguration: async () => config, generate: async value => { captured = value; return { provider: "official", model: value.model!, images: [raster] }; } });
  const boardInput = { workspace, id: board.board.id, revision: board.board.revision, kind: "architecture", prompt: "Draw a city diagram", baseImageId: "", canvasVersion: 0, requestId: randomUUID() };
  const accepted = await manager.start(boardInput);
  while (busy) await new Promise(resolve => setTimeout(resolve, 10)); assert.equal((await manager.status(accepted.runId, workspace)).status, "completed"); assert.equal((captured as { base?: unknown }).base, undefined); manager.dispose();
  let resumed = 0; const recreated = createWhiteboardDesignManager({ getWorkspace: () => workspace, isBusy: () => busy, onBusy: () => { busy = true; }, onIdle: () => { busy = false; }, generate: async () => { assert.fail("Restored manager must never dispatch generation"); }, resume: async requestId => { assert.equal(requestId, boardInput.requestId); resumed++; return { provider: "official", model: "flare-text-to-image", images: [raster] }; } });
  assert.equal((await recreated.lookup(boardInput.requestId, workspace)).runId, accepted.runId);
  assert.equal((await recreated.start(boardInput)).runId, accepted.runId);
  await assert.rejects(recreated.start({ ...boardInput, prompt: "mutated" }), /不能用于不同/);
  await recreated.resume(accepted.runId, workspace); while (busy) await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(resumed, 1); assert.equal((await recreated.status(accepted.runId, workspace)).status, "completed"); recreated.dispose();
  const savedReference = (id: string, baseImageId: string) => ({ id, type: "image", fileId: "saved-ref-file", x: 0, y: 0, width: 1, height: 1, angle: 0, isDeleted: false, customData: { ccagentDesign: { version: 1, role: "reference", width: 1, height: 1, baseImageId } } });
  const refOnlyBoard = await handleWhiteboard("create", { name: "Persisted references without a base", scene: { type: "excalidraw", version: 2, appState: {}, elements: [savedReference("saved-reference", ""), savedReference("unrelated-reference", "another-base")], files: { "saved-ref-file": { id: "saved-ref-file", mimeType: raster.mimeType, dataURL: raster.dataURL, created: Date.now() } } } }, workspace); assert("board" in refOnlyBoard);
  let canonicalInput: import("../services/images/designImageProvider.js").DesignImageInput | undefined;
  const canonical = createWhiteboardDesignManager({ getWorkspace: () => workspace, isBusy: () => busy, onBusy: () => { busy = true; }, onIdle: () => { busy = false; }, getConfiguration: async () => config, generate: async value => { canonicalInput = value; return { provider: "official", model: value.model!, images: [raster] }; } });
  const refAccepted = await canonical.start({ ...boardInput, id: refOnlyBoard.board.id, revision: refOnlyBoard.board.revision, requestId: randomUUID(), assetIds: [] });
  while (busy) await new Promise(resolve => setTimeout(resolve, 10)); assert.equal((await canonical.status(refAccepted.runId, workspace)).status, "completed");
  assert.equal(canonicalInput?.base, undefined); assert.equal(canonicalInput?.annotated, undefined); assert.equal(canonicalInput?.references.length, 1); assert.equal(canonicalInput?.references[0]!.dataURL, raster.dataURL); assert.equal(canonicalInput?.generationMode, "image-to-image"); assert(canonicalInput?.model?.endsWith("image-to-image")); canonical.dispose();
  await assert.rejects(fixture.nativeClient.serviceRequest("/v1/images/tasks/not-an-id", fixture.users[0]!.id), /接口无效/);
  await assert.rejects((await getPlatformGatewayClient()).imageTaskStatus("../../invalid"), /标识无效/);
  assert.equal(puts, 23); assert.equal(polls, 10);
  const automatic = (extra = {}) => ({ kind: "architecture" as const, prompt: "Automatic gateway mode", references: [], requestId: randomUUID(), signal: new AbortController().signal, ...extra });
  publishedDefault = "sunburst-image-to-image";
  await generateDesignImage(automatic(), workspace); assert.equal(creates.at(-1)!.model, "sunburst-text-to-image");
  await generateDesignImage(automatic({ references: [raster] }), workspace); assert.equal(creates.at(-1)!.model, "sunburst-image-to-image");
  publishedRoutes = [...routes, { ...routes.find(route => route.id === "sunburst-text-to-image")!, id: "new-admin-default" }]; publishedDefault = "new-admin-default";
  assert.equal((await getDesignImageConfig(workspace)).model, "new-admin-default");
  await generateDesignImage(automatic(), workspace); assert.equal(creates.at(-1)!.model, "new-admin-default", "Fresh image snapshot is used even though the saved catalog has no new route");
  assert.equal(await readFile(servicePaths().state, "utf8"), localConfigurationBefore, "Main/Qwen, auxiliary, fallback, Key revision and old price choices are unchanged");
  publishedRoutes = routes; publishedDefault = "sunburst-image-to-image";
  await saveOfficialServices({ roles: { imageGeneration: "flare-image-to-image" } });
  await generateDesignImage(automatic(), workspace); assert.equal(creates.at(-1)!.model, "flare-text-to-image", "Saved unified model choice takes precedence over the catalog recommendation");
  await generateDesignImage(automatic({ references: [raster] }), workspace); assert.equal(creates.at(-1)!.model, "flare-image-to-image");
  const noAutomaticCalls = creates.length;
  await saveOfficialServices({ automaticAuxiliary: true, roles: {}, auxiliaryEnabled: false });
  const automaticState = await readFile(servicePaths().state, "utf8");
  publishedDefault = "flare-image-to-image";
  assert.equal((await refreshOfficialImageCatalog()).configuration.roles.imageGeneration, "flare-image-to-image", "Automatic image snapshots follow the current backend default instead of an older saved choice");
  publishedDefault = undefined;
  const unavailableDefault = await refreshOfficialImageCatalog();
  assert.equal(unavailableDefault.configuration.roles.imageGeneration, undefined, "No backend image default means no automatic role even when image routes exist");
  assert.equal(unavailableDefault.configuration.auxiliaryEnabled, false, "Refreshing a default never enables the auxiliary checkbox");
  assert.equal(await readFile(servicePaths().state, "utf8"), automaticState, "Image catalog snapshots do not rewrite saved account configuration");
  assert.equal(creates.length, noAutomaticCalls, "Automatic configuration and image snapshots never create a paid task");
  await saveOfficialServices({ automaticAuxiliary: false, roles: {} });
  publishedRoutes = routes.filter(route => route.id !== "sunburst-text-to-image"); publishedDefault = "sunburst-image-to-image";
  assert.deepEqual((await getDesignImageConfig(workspace)).modes, { textToImage: false, imageToImage: true });
  const noNewCalls = creates.length; await assert.rejects(generateDesignImage(automatic(), workspace), /暂未开放/); assert.equal(creates.length, noNewCalls);
  mode = "upload-failed";
  await assert.rejects(generateDesignImage(automatic({ references: [raster] }), workspace), (error: unknown) => {
    assert(error instanceof DesignImageError); assert.equal(error.code, "DESIGN_IMAGE_FAILED");
    assert.match(error.message, /参考图上传失败.*尚未提交生成.*预留额度已释放.*调用编号/);
    assert(!error.message.includes("untrusted upstream detail")); return true;
  });
  const failedReceipt = JSON.parse(await readFile(path.join(process.env.CCAGENT_HOME!, "platform/image-task-receipts.json"), "utf8")).at(-1);
  assert.equal(failedReceipt.state, "failed"); mode = "normal";
  const afterFailedCall = creates.length;
  publishedRoutes = []; publishedDefault = undefined; const closed = await getDesignImageConfig(workspace); assert.equal(closed.configured, false); assert.deepEqual(closed.modes, { textToImage: false, imageToImage: false });
  await assert.rejects(generateDesignImage(automatic(), workspace), /暂未开放/); assert.equal(creates.length, afterFailedCall);
  assert(catalogReads > 8); await forgetOfficialKey(); await assert.rejects(getDesignImageConfig(workspace), /账户服务暂不可用/); assert.equal(creates.length, afterFailedCall);
  console.log("Kie native images passed: four exact variants, private original/annotation/reference uploads, 16 images, 20k prompt, 13 ratios, 1K/2K/4K and background gates, single create/unknown/abort, owned task download, transient asset isolation and no-base whiteboard generation. Loopback fixtures only.");
} finally {
  assets.dispose(); await fixture.close();
  for (const name of Object.keys(process.env)) if (!(name in oldEnv)) delete process.env[name]; Object.assign(process.env, oldEnv);
  if (path.dirname(root) !== await realpath(os.tmpdir()) || !path.basename(root).startsWith("ccagent-kie-native-")) throw new Error("Unsafe fixture cleanup");
  await rm(root, { recursive: true, force: true });
}
