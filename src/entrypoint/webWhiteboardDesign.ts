import { createHash, randomUUID } from "node:crypto";
import { requirePlatformScope } from "../platform/account.js";
import { DesignImageError, generateDesignImage, resumeDesignImage, getDesignImageConfig, validateDesignRaster, validateImageGenerationOptions, selectDesignImageRoute, type DesignRaster } from "../services/images/designImageProvider.js";
import { lstat, readFile } from "node:fs/promises";
import { getCCAgentPath } from "../utils/paths.js";
import { withFileTransaction, writeJsonAtomically } from "../utils/fileTransaction.js";
import { createDesignAssets } from "./webDesignAssets.js";
import { handleWhiteboard, type Whiteboard } from "./webWhiteboards.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ELEMENT_ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_RUNS = 8, MAX_RECEIPTS = 2048, MAX_RESULT_BYTES = 96 * 1024 * 1024, RETENTION_MS = 30 * 60_000;
const INPUT_KEYS = new Set(["workspace", "id", "revision", "kind", "prompt", "baseImageId", "canvasVersion", "annotated", "requestId", "aspect_ratio", "resolution", "background", "assetIds", "baseAssetId"]);
type Kind = "architecture" | "urban-analysis";
type Status = "running" | "completed" | "failed" | "stopped";
type ObjectValue = Record<string, unknown>;
type GenerateInput = Parameters<typeof generateDesignImage>[0];
type Generated = Awaited<ReturnType<typeof generateDesignImage>>;
type Configuration = Awaited<ReturnType<typeof getDesignImageConfig>>;
export type WhiteboardDesignRun = {
  runId: string; requestId: string; workspace: string; id: string; revision: number; canvasVersion: number; baseImageId: string;
  kind: Kind; status: Status; images: DesignRaster[]; startedAt: number; elapsedMs: number;
  provider?: string; model?: string; error?: string;
  canResume?: boolean;
};
export class WhiteboardDesignError extends Error {
  constructor(message: string, public readonly status = 400, public readonly code = "invalid_design_request") { super(message); this.name = "WhiteboardDesignError"; }
}
export type WhiteboardDesignManagerOptions = {
  getWorkspace: () => string;
  isBusy: () => boolean;
  onBusy: (runId: string) => void;
  onIdle: (runId: string) => void;
  /** Runtime/test options only; renderer requests cannot select implementations or timeouts. */
  timeoutMs?: number;
  generate?: (input: GenerateInput, workspace: string) => Promise<Generated>;
  getConfiguration?: (workspace: string) => Promise<Configuration>;
  resume?: typeof resumeDesignImage;
};
type Run = Omit<WhiteboardDesignRun, "elapsedMs"> & { owner: string; controller: AbortController; finishedAt?: number };
type Request = { workspace: string; id: string; revision: number; kind: Kind; prompt: string; baseImageId: string; canvasVersion: number; annotated?: DesignRaster; requestId: string; fingerprint: string; model?: string; generationMode?: "text-to-image" | "image-to-image"; aspect_ratio?: string; resolution?: string; background?: string; assetIds?: string[]; baseAssetId?: string };
type Receipt = { owner: string; workspace: string; fingerprint: string; runId: string };
type DurableRun = Pick<Run, "runId" | "requestId" | "workspace" | "id" | "revision" | "canvasVersion" | "baseImageId" | "kind" | "owner" | "startedAt"> & { fingerprint: string; completedAt?: number };
const object = (value: unknown): value is ObjectValue => value !== null && typeof value === "object" && !Array.isArray(value);
function invalid(message: string, status = 400, code = "invalid_design_request"): never { throw new WhiteboardDesignError(message, status, code); }

function parseRequest(input: Record<string, unknown>, workspace: string): Request {
  if (!object(input) || Object.keys(input).some((key) => !INPUT_KEYS.has(key))) invalid("绘图请求含有不支持的字段。");
  if (typeof input.workspace !== "string" || input.workspace !== workspace) invalid("工作文件夹已切换，请重新打开画布。", 409, "workspace_changed");
  if (typeof input.id !== "string" || !UUID.test(input.id) || !Number.isSafeInteger(input.revision) || (input.revision as number) < 1) invalid("请先保存有效的画布，再开始图像生成。");
  if (input.kind !== "architecture" && input.kind !== "urban-analysis") invalid("请选择建筑绘制或城市设计分析图。");
  if (typeof input.prompt !== "string" || !input.prompt.trim() || input.prompt.length > 20000) invalid("请填写 20000 字以内的绘制要求。");
  if (typeof input.baseImageId !== "string" || (input.baseImageId !== "" && !ELEMENT_ID.test(input.baseImageId))) invalid("请选择画布中有效的原图。");
  if (!Number.isSafeInteger(input.canvasVersion) || (input.canvasVersion as number) < 0) invalid("画布快照版本无效，请重新生成。");
  if (typeof input.requestId !== "string" || !UUID.test(input.requestId)) invalid("本次生成请求编号无效，请重新打开绘图面板。");
  let annotated: DesignRaster | undefined;
  try { if (input.annotated !== undefined) annotated = validateDesignRaster(input.annotated); }
  catch { return invalid("勾画快照不是有效的 PNG、JPEG 或 WEBP 图片。"); }
  if (annotated && (annotated.width > 2048 || annotated.height > 2048)) invalid("勾画快照不能超过 2048 像素，请缩小后再试。");
  for (const key of ["aspect_ratio", "resolution", "background"] as const) if (input[key] !== undefined && typeof input[key] !== "string") invalid("图像生成参数无效。");
  validateImageGenerationOptions(input as Request);
  if (input.assetIds !== undefined && (!Array.isArray(input.assetIds) || input.assetIds.length > 16 || input.assetIds.some(id => typeof id !== "string" || !UUID.test(id)))) invalid("临时参考图编号无效。");
  if (input.baseAssetId !== undefined && (typeof input.baseAssetId !== "string" || !UUID.test(input.baseAssetId))) invalid("临时原图编号无效。");
  if (input.baseImageId && !annotated) invalid("请重新获取原图勾画快照。");
  const data: Omit<Request, "fingerprint"> = { workspace, id: input.id, revision: input.revision as number, kind: input.kind, prompt: input.prompt.trim(), baseImageId: input.baseImageId,
    canvasVersion: input.canvasVersion as number, annotated, requestId: input.requestId,
    ...(input.aspect_ratio ? { aspect_ratio: input.aspect_ratio as string } : {}), ...(input.resolution ? { resolution: input.resolution as string } : {}), ...(input.background ? { background: input.background as string } : {}),
    ...(input.assetIds ? { assetIds: input.assetIds as string[] } : {}), ...(input.baseAssetId ? { baseAssetId: input.baseAssetId as string } : {}) };
  // A retry is identical only when every generation input is identical. Neither a
  // changed prompt nor a changed raster may reuse an already submitted request ID.
  const fingerprint = createHash("sha256").update(JSON.stringify(data)).digest("hex");
  return { ...data, fingerprint };
}

function savedImages(board: Whiteboard, baseImageId: string, maxReferences = 2): { base?: DesignRaster; references: DesignRaster[] } {
  const elements = board.scene.elements.filter((element) => element.type === "image" && !element.isDeleted);
  const metadata = (element: ObjectValue): ObjectValue | undefined => object(element.customData) && object(element.customData.ccagentDesign) ? element.customData.ccagentDesign : undefined;
  const original = elements.find((element) => element.id === baseImageId);
  if (baseImageId && (!original || metadata(original)?.role !== "base" || metadata(original)?.version !== 1)) invalid("所选原图不在已保存的画布中，请重新导入或保存原图。", 409, "base_image_missing");
  if (original && (typeof original.width !== "number" || typeof original.height !== "number" || original.width <= 0 || original.height <= 0)) invalid("原图显示尺寸无效，请恢复图片大小后保存。", 400, "base_image_transformed");
  if (original && (original.angle !== 0 || (original.crop !== undefined && original.crop !== null) || (Array.isArray(original.scale) && (original.scale[0] !== 1 || original.scale[1] !== 1)))) {
    invalid("请先恢复原图的旋转、裁剪和翻转，再在原图上勾画。", 400, "base_image_transformed");
  }
  function raster(element: ObjectValue): DesignRaster {
    const file = typeof element.fileId === "string" ? board.scene.files[element.fileId] : undefined;
    const meta = metadata(element);
    if (!object(file)) invalid("画布中的原图或参考图文件缺失，请重新导入。", 409, "image_missing");
    try { return validateDesignRaster({ mimeType: file.mimeType, dataURL: file.dataURL, width: meta?.width, height: meta?.height }); }
    catch { return invalid("画布中的原图或参考图格式无效，请重新导入 PNG、JPEG 或 WEBP 图片。", 400, "invalid_saved_image"); }
  }
  const references = elements.filter((element) => {
    const meta = metadata(element);
    return meta?.version === 1 && meta.role === "reference" && meta.baseImageId === baseImageId;
  });
  if (references.length > maxReferences) invalid(`一张原图最多使用 ${maxReferences} 张参考图，请移除多余参考图后保存。`, 400, "reference_limit");
  return { ...(original ? { base: raster(original) } : {}), references: references.map(raster) };
}

/** Account/workspace-bound raster drafts. Generation never writes a saved board. */
export function createWhiteboardDesignManager(options: WhiteboardDesignManagerOptions) {
  const assets = createDesignAssets(options.getWorkspace);
  const runs = new Map<string, Run>(), receipts = new Map<string, Receipt>();
  const pending = new Map<string, { fingerprint: string; promise: Promise<{ runId: string }> }>();
  const generate = options.generate ?? generateDesignImage, configuration = options.getConfiguration ?? getDesignImageConfig;
  const resume = options.resume ?? resumeDesignImage;
  const timeoutMs = options.timeoutMs ?? 300_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 300_000) throw new Error("Invalid whiteboard design timeout");
  let disposed = false;
  const durableFile = () => getCCAgentPath("platform", "whiteboard-image-runs.json");
  async function durableRuns(): Promise<DurableRun[]> {
    const info = await lstat(durableFile()).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
    if (!info) return [];
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 2 * 1024 * 1024) invalid("绘图恢复记录无效。", 409);
    const data: unknown = JSON.parse(await readFile(durableFile(), "utf8"));
    if (!Array.isArray(data) || data.length > 512 || data.some(item => !item || !UUID.test(item.runId) || !UUID.test(item.requestId) || !UUID.test(item.id) || typeof item.workspace !== "string" || typeof item.owner !== "string" || !Number.isSafeInteger(item.revision) || !Number.isSafeInteger(item.canvasVersion))) invalid("绘图恢复记录格式无效。", 409);
    return data as DurableRun[];
  }
  async function rememberRun(run: Run, fingerprint: string) {
    if (!run.canResume) return;
    await withFileTransaction(durableFile(), async () => {
      const data = (await durableRuns()).filter(item => !item.completedAt || Date.now() - item.completedAt < 24 * 60 * 60_000);
      if (data.length >= 512) invalid("本地图像恢复记录已满，请先归档原调用记录。", 409);
      const { runId, requestId, workspace, id, revision, canvasVersion, baseImageId, kind, owner, startedAt } = run;
      data.push({ runId, requestId, workspace, id, revision, canvasVersion, baseImageId, kind, owner, startedAt, fingerprint });
      await writeJsonAtomically(durableFile(), data);
    });
  }
  async function markCompleted(run: Run) {
    if (!run.canResume || run.status !== "completed") return;
    await withFileTransaction(durableFile(), async () => { const data = await durableRuns(), saved = data.find(item => item.runId === run.runId); if (saved) { saved.completedAt = Date.now(); await writeJsonAtomically(durableFile(), data); } });
  }
  async function restoreRun(owner: string, workspace: string, key: string): Promise<Run | undefined> {
    const saved = (await durableRuns()).find(item => (item.runId === key || item.requestId === key) && item.owner === owner && item.workspace === workspace);
    if (!saved) return;
    const existing = runs.get(saved.runId); if (existing) return existing;
    const restored: Run = { ...saved, status: "stopped", images: [], controller: new AbortController(), canResume: true, error: "本地等待已结束，可继续查询原图像任务。" };
    runs.set(restored.runId, restored); return restored;
  }

  const bytes = (run: Run): number => run.images.reduce((total, image) => total + Buffer.byteLength(image.dataURL), 0);
  function prune(): void {
    const finished = [...runs.values()].filter((run) => run.status !== "running").sort((left, right) => (left.finishedAt ?? left.startedAt) - (right.finishedAt ?? right.startedAt));
    let total = [...runs.values()].reduce((sum, run) => sum + bytes(run), 0);
    for (const run of finished) {
      if (runs.size < MAX_RUNS && total <= MAX_RESULT_BYTES && Date.now() - (run.finishedAt ?? run.startedAt) < RETENTION_MS) continue;
      runs.delete(run.runId); total -= bytes(run);
    }
  }
  function view(run: Run): WhiteboardDesignRun {
    return { runId: run.runId, requestId: run.requestId, workspace: run.workspace, id: run.id, revision: run.revision, canvasVersion: run.canvasVersion,
      baseImageId: run.baseImageId, kind: run.kind, status: run.status, images: structuredClone(run.images), startedAt: run.startedAt,
      elapsedMs: Math.max(0, (run.finishedAt ?? Date.now()) - run.startedAt), canResume: run.canResume, ...(run.provider ? { provider: run.provider } : {}),
      ...(run.model ? { model: run.model } : {}), ...(run.error ? { error: run.error } : {}) };
  }
  async function checkedRun(runId: string, workspace: string): Promise<Run> {
    const account = await requirePlatformScope(0);
    if (workspace !== options.getWorkspace()) invalid("工作文件夹已切换，请重新打开绘图面板。", 409, "workspace_changed");
    const run = runs.get(runId) ?? await restoreRun(account.user.id, workspace, runId);
    if (!UUID.test(runId) || !run || run.owner !== account.user.id || run.workspace !== workspace) invalid("绘图任务不存在或结果已过期。", 404, "not_found");
    return run;
  }
  function stopRun(run: Run, timeout = false): void {
    if (run.status !== "running") return;
    run.status = timeout ? "failed" : "stopped";
    run.images = [];
    run.error = timeout ? "图像生成等待已超时；已发送的供应商请求可能继续处理，请先核对供应商状态再决定是否重新生成。"
      : "已停止本地图像生成等待；已发送的请求仍可能由供应商处理，重新生成前请先核对供应商状态。";
    run.finishedAt = Date.now(); run.controller.abort();
  }
  async function drive(run: Run, request: Request | undefined, images: { base?: DesignRaster; references: DesignRaster[] }, recovering = false): Promise<void> {
    const timer = setTimeout(() => stopRun(run, true), timeoutMs); timer.unref();
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(new Error("design-aborted"));
      run.controller.signal.addEventListener("abort", onAbort, { once: true });
      if (run.controller.signal.aborted) onAbort();
    });
    void aborted.catch(() => {}); // Cancellation may arrive while a scope check is still pending.
    try {
      if (disposed || run.controller.signal.aborted || options.getWorkspace() !== run.workspace) { stopRun(run); return; }
      const account = await Promise.race([requirePlatformScope(0), aborted]);
      if (account.user.id !== run.owner || disposed || run.controller.signal.aborted || options.getWorkspace() !== run.workspace) { stopRun(run); return; }
      const result = await Promise.race([recovering ? resume(run.requestId, run.controller.signal) : generate({ prompt: request!.prompt, kind: request!.kind, ...images, annotated: request!.annotated,
        signal: run.controller.signal, requestId: run.requestId, model: request!.model, generationMode: request!.generationMode, aspect_ratio: request!.aspect_ratio, resolution: request!.resolution, background: request!.background }, run.workspace), aborted]);
      if (run.status !== "running" || run.controller.signal.aborted || disposed) return;
      const current = await Promise.race([requirePlatformScope(0), aborted]);
      if (current.user.id !== run.owner || options.getWorkspace() !== run.workspace) { stopRun(run); return; }
      if (!Array.isArray(result.images) || result.images.length < 1 || result.images.length > 4) throw new Error("invalid-design-result");
      const output = result.images.map((image) => validateDesignRaster(image, "output"));
      if (output.reduce((total, image) => total + Buffer.byteLength(image.dataURL), 0) > MAX_RESULT_BYTES) throw new Error("design-result-too-large");
      // Cancellation during the final scope check must not resurrect a stopped run.
      if (run.status !== "running" || run.controller.signal.aborted || disposed) return;
      run.images = output; run.provider = result.provider; run.model = result.model; run.status = "completed";
    } catch (error) {
      if (run.status === "running") { run.status = "failed"; run.error = error instanceof DesignImageError ? error.message : "图像生成未完成，请检查图像模型配置、服务额度及网络；不会自动重试。"; }
    } finally {
      clearTimeout(timer);
      if (onAbort) run.controller.signal.removeEventListener("abort", onAbort);
      if (run.status === "running") { run.status = "failed"; run.error = "图像生成未完成，请重新提交。"; }
      if (run.status !== "completed") run.images = [];
      run.finishedAt ??= Date.now(); await markCompleted(run).catch(() => {}); options.onIdle(run.runId); prune();
    }
  }
  async function reuse(request: Request, promise?: Promise<{ runId: string }>): Promise<{ runId: string }> {
    const account = await requirePlatformScope(0);
    if (request.workspace !== options.getWorkspace()) invalid("工作文件夹已切换，请重新打开绘图面板。", 409, "workspace_changed");
    if (promise) await promise;
    const receipt = receipts.get(request.requestId);
    if (!receipt || receipt.owner !== account.user.id || receipt.workspace !== request.workspace) invalid("绘图请求不属于当前账户。", 404, "not_found");
    if (receipt.fingerprint !== request.fingerprint) invalid("同一生成请求编号不能用于不同的图片或要求，请重新提交。", 409, "request_mismatch");
    prune();
    if (!runs.has(receipt.runId)) invalid("本次请求已经提交过，结果已过期；不会重复调用模型。请重新点击生成以创建新请求。", 410, "result_expired");
    return { runId: receipt.runId };
  }
  async function prepare(request: Request, runId: string): Promise<{ runId: string }> {
    let launched = false;
    try {
      const account = await requirePlatformScope(0);
      const previous = (await durableRuns()).find(item => item.requestId === request.requestId && item.owner === account.user.id && item.workspace === request.workspace);
      if (previous) {
        if (previous.fingerprint !== request.fingerprint) invalid("同一生成请求编号不能用于不同的图片或要求。", 409, "request_mismatch");
        const restored = await restoreRun(account.user.id, request.workspace, previous.runId);
        if (restored) { receipts.set(request.requestId, { owner: account.user.id, workspace: request.workspace, fingerprint: request.fingerprint, runId: restored.runId }); return { runId: restored.runId }; }
      }
      if (receipts.size >= MAX_RECEIPTS) invalid("本次应用运行已达到绘图请求上限，请保存画布后重新打开应用。", 503, "request_capacity");
      prune();
      const response = await handleWhiteboard("open", { id: request.id }, request.workspace);
      if (!("board" in response) || !("scene" in response.board)) invalid("已保存的画布暂时无法读取。", 409, "board_unavailable");
      if (response.board.revision !== request.revision) invalid("画布已被其他窗口更新，请重新打开后再生成。", 409, "conflict");
      const config = await configuration(request.workspace);
      const images = savedImages(response.board, request.baseImageId, config.maxReferences);
      if (request.baseAssetId) {
        if (!request.baseImageId) invalid("高清原图需要对应的画布原图。");
        images.base = (await assets.read(request.workspace, [request.baseAssetId]))[0];
      }
      if (request.assetIds?.length) images.references.push(...await assets.read(request.workspace, request.assetIds));
      if (config.provider !== "official" && (!images.base || !request.annotated)) invalid("当前绘图输入不完整，请重新导入图片。");
      if (config.provider === "official" && ((images.base ? 1 : 0) + (request.annotated ? 1 : 0) + images.references.length > 16)) invalid("最多使用 16 张输入图（含原图和勾画）。");
      if (!config.configured) invalid("图像生成服务暂未开放，请稍后重试。", 503, "DESIGN_IMAGE_UNAVAILABLE");
      if (config.provider === "official") {
        const imageCount = (images.base ? 1 : 0) + (request.annotated ? 1 : 0) + images.references.length;
        request.model = selectDesignImageRoute(config, imageCount).id;
        request.generationMode = imageCount > 0 ? "image-to-image" : "text-to-image";
      }
      const referenceLimit = config.provider === "official" ? 16 - (images.base ? 1 : 0) - (request.annotated ? 1 : 0) : config.maxReferences;
      if (images.references.length > referenceLimit) invalid(`当前图像模型最多使用 ${referenceLimit} 张参考图，请移除多余参考图后保存。`, 400, "reference_limit");
      if (disposed) invalid("图像绘制服务正在退出，请重新打开应用。", 503, "unavailable");
      if (request.workspace !== options.getWorkspace()) invalid("工作文件夹已切换，请重新打开画布。", 409, "workspace_changed");
      const current = await requirePlatformScope(0);
      if (current.user.id !== account.user.id) invalid("当前账户已切换，请重新打开画布。", 409, "account_changed");
      if (disposed || request.workspace !== options.getWorkspace()) invalid("绘图服务或工作文件夹已改变，请重新打开画布。", 409, "workspace_changed");
      // Configuration and authentication reads can yield to another canvas save.
      // Reject that stale snapshot before registering any paid generation receipt.
      const latest = await handleWhiteboard("open", { id: request.id }, request.workspace);
      if (!("board" in latest) || latest.board.revision !== request.revision) invalid("画布已被更新，请重新保存并获取勾画快照后再生成。", 409, "conflict");
      if (disposed || request.workspace !== options.getWorkspace()) invalid("绘图服务或工作文件夹已改变，请重新打开画布。", 409, "workspace_changed");
      const run: Run = { runId, requestId: request.requestId, workspace: request.workspace, id: request.id, revision: request.revision,
        canvasVersion: request.canvasVersion, baseImageId: request.baseImageId, kind: request.kind, owner: account.user.id,
        status: "running", images: [], startedAt: Date.now(), controller: new AbortController(), canResume: config.provider === "official" };
      await rememberRun(run, request.fingerprint);
      runs.set(runId, run); receipts.set(request.requestId, { owner: run.owner, workspace: run.workspace, fingerprint: request.fingerprint, runId });
      launched = true; void drive(run, request, images);
      return { runId };
    } finally { if (!launched) options.onIdle(runId); }
  }

  return {
    uploadAsset: (workspace: string, value: unknown) => assets.upload(workspace, value),
    removeAsset: (workspace: string, id: string) => assets.remove(workspace, id),
    async start(input: Record<string, unknown>): Promise<{ runId: string }> {
      if (disposed) invalid("图像绘制服务正在退出，请重新打开应用。", 503, "unavailable");
      const request = parseRequest(input, options.getWorkspace());
      if (receipts.has(request.requestId)) return reuse(request);
      const existing = pending.get(request.requestId);
      if (existing) {
        if (existing.fingerprint !== request.fingerprint) invalid("同一生成请求编号不能用于不同的图片或要求，请重新提交。", 409, "request_mismatch");
        return reuse(request, existing.promise);
      }
      if (options.isBusy()) invalid("请先结束当前任务，再开始图像生成。", 409, "busy");
      const runId = randomUUID();
      // Reserve before the first await: ordinary turns and workspace switching
      // share the worker's same busy guard, including preparation/config reads.
      options.onBusy(runId);
      const promise = prepare(request, runId);
      pending.set(request.requestId, { fingerprint: request.fingerprint, promise });
      try { return await promise; }
      finally { if (pending.get(request.requestId)?.promise === promise) pending.delete(request.requestId); }
    },
    async status(runId: string, workspace: string): Promise<WhiteboardDesignRun> { prune(); return view(await checkedRun(runId, workspace)); },
    /** Read-only recovery after a lost start response. This never dispatches a model. */
    async lookup(requestId: string, workspace: string): Promise<WhiteboardDesignRun> {
      const account = await requirePlatformScope(0);
      if (workspace !== options.getWorkspace()) invalid("工作文件夹已切换，请重新打开绘图面板。", 409, "workspace_changed");
      if (!UUID.test(requestId)) invalid("绘图请求编号无效。");
      const preparing = pending.get(requestId);
      if (preparing) await preparing.promise.catch(() => {});
      const receipt = receipts.get(requestId);
      if (!receipt) { const restored = await restoreRun(account.user.id, workspace, requestId); if (restored) return view(restored); }
      if (!receipt || receipt.owner !== account.user.id || receipt.workspace !== workspace) invalid("绘图请求尚未提交或已过期。", 404, "not_found");
      prune();
      return view(await checkedRun(receipt.runId, workspace));
    },
    async stop(runId: string, workspace: string): Promise<WhiteboardDesignRun> { const run = await checkedRun(runId, workspace); stopRun(run); return view(run); },
    async resume(runId: string, workspace: string): Promise<{ runId: string }> {
      const run = await checkedRun(runId, workspace);
      if (!run.canResume) invalid("此任务不支持官方图像查询恢复。", 409);
      if (run.status === "running") return { runId: run.runId };
      if (options.isBusy()) invalid("请先结束当前任务，再查询原图像任务。", 409, "busy");
      options.onBusy(run.runId);
      run.controller = new AbortController(); run.status = "running"; run.images = []; run.error = undefined; run.startedAt = Date.now(); run.finishedAt = undefined;
      void drive(run, undefined, { references: [] }, true); return { runId: run.runId };
    },
    dispose(): void { disposed = true; assets.dispose(); for (const run of runs.values()) stopRun(run); },
  };
}
