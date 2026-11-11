import { getPlatformGatewayClient, refreshOfficialImageCatalog, PlatformServiceError } from "../../platform/gatewayClient.js";
import { runOfficialImageTask, resumeOfficialImageTask } from "./officialImageTasks.js";

export type DesignImageProvider = "dashscope" | "openai" | "official";
export interface DesignRaster { dataURL: string; mimeType: "image/png" | "image/jpeg" | "image/webp"; width: number; height: number; name?: string }
export type Raster = DesignRaster;
export interface DesignImageConfig { configured: boolean; provider: DesignImageProvider; model: string; baseURL: string; source: "user" | "environment" | "none" | "official"; hasKey: boolean; maxReferences: number; routes?: { id: string; name: string; upstreamModel?: string }[]; modes?: { textToImage: boolean; imageToImage: boolean }; defaultExplicit?: boolean }
type PrivateConfig = DesignImageConfig;
type ObjectValue = Record<string, unknown>;
export interface DesignImageInput { prompt: string; kind: "architecture" | "urban-analysis"; base?: DesignRaster; annotated?: DesignRaster; references: DesignRaster[]; signal: AbortSignal; requestId: string; /** Frozen by trusted backend selection; never accepted from the whiteboard renderer. */ model?: string; generationMode?: "text-to-image" | "image-to-image"; aspect_ratio?: string; resolution?: string; background?: string; onProgress?: (detail: string) => void }
export interface DesignImageDependencies {
  gateway?: Pick<Awaited<ReturnType<typeof getPlatformGatewayClient>>, "uploadPrivateImage" | "call" | "callStatus" | "imageTaskStatus" | "download">;
}
const INPUT_RASTER_LIMITS = { maxBytes: 30 * 1024 * 1024, maxPixels: 16_777_216, maxEdge: 8192 } as const;
const OUTPUT_RASTER_LIMITS = { maxBytes: 64 * 1024 * 1024, maxPixels: 8192 * 8192, maxEdge: 8192 } as const;
const object = (value: unknown): ObjectValue => value && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : {};
export class DesignImageError extends Error {
  constructor(message: string, readonly status = 400, readonly code = "DESIGN_IMAGE_INVALID") { super(message); this.name = "DesignImageError"; }
}
const problem = (message: string, status = 400, code = "DESIGN_IMAGE_INVALID"): never => { throw new DesignImageError(message, status, code); };
const KIE_MODEL = /^gpt-image-2-5-(?:flare|sunburst)-(?:text-to-image|image-to-image)$/;
async function loadConfig(_workspace: string, snapshot?: { gateway?: DesignImageDependencies["gateway"] }): Promise<PrivateConfig> {
  // Whiteboard always uses the account gateway. Never inspect personal settings,
  // personal credentials, inherited IMAGE_EDIT_* or workspace .env overrides.
  try {
    const fresh = await refreshOfficialImageCatalog(), state = fresh.configuration;
    if (snapshot) snapshot.gateway = fresh.client;
    const routes = state.routes.filter(route => route.service === "image" && route.protocol === "kie-images" && KIE_MODEL.test(route.upstreamModel ?? "")).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const model = routes.some(route => route.id === state.roles.imageGeneration) ? state.roles.imageGeneration! : routes[0]?.id ?? "";
    const config: DesignImageConfig = { configured: routes.length > 0, provider: "official", model, baseURL: "", source: "official", hasKey: true, maxReferences: 16, defaultExplicit: Boolean(state.roles.imageGeneration), routes: routes.map(({ id, name, upstreamModel }) => ({ id, name, upstreamModel })) };
    const available = (imageCount: number) => { try { selectDesignImageRoute(config, imageCount); return true; } catch { return false; } };
    return { ...config, modes: { textToImage: available(0), imageToImage: available(1) } };
  } catch (error) {
    if (error instanceof PlatformServiceError && error.code !== "SERVICE_NOT_CONFIGURED") return problem(error.message, error.status || 503, error.code);
    return problem("账户服务暂不可用，请稍后重试。", 503, "DESIGN_IMAGE_ACCOUNT_UNAVAILABLE");
  }
}
export async function getDesignImageConfig(workspace: string): Promise<DesignImageConfig> { return loadConfig(workspace); }
/** Stale clients cannot restore the removed personal-provider configuration. */
export async function saveDesignImageConfig(_body: unknown, _workspace: string): Promise<DesignImageConfig> {
  return problem("图像服务由管理员统一管理，请直接开始绘图。", 405, "DESIGN_IMAGE_MANAGED");
}
export function selectDesignImageRoute(config: DesignImageConfig, imageCount: number) {
  const mode = imageCount > 0 ? "image-to-image" : "text-to-image", routes = config.routes ?? [];
  const primary = routes.find(route => route.id === config.model);
  if (primary?.upstreamModel?.endsWith(`-${mode}`)) return primary;
  if (primary?.upstreamModel) {
    const pairedModel = primary.upstreamModel.replace(/-(?:text-to-image|image-to-image)$/, `-${mode}`);
    const paired = routes.find(route => route.upstreamModel === pairedModel); if (paired) return paired;
    if (config.defaultExplicit) return problem("图像生成服务暂未开放，请稍后重试。", 503, "DESIGN_IMAGE_UNAVAILABLE");
  }
  const matching = routes.find(route => route.upstreamModel?.endsWith(`-${mode}`));
  if (matching) return matching;
  return problem("图像生成服务暂未开放，请稍后重试。", 503, "DESIGN_IMAGE_UNAVAILABLE");
}

export const KIE_ASPECT_RATIOS = ["auto", "1:1", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16", "21:9", "27:16", "16:27", "9:8", "8:9"] as const;
export function validateImageGenerationOptions(input: Pick<DesignImageInput, "aspect_ratio" | "resolution" | "background">) {
  const aspect_ratio = input.aspect_ratio ?? "auto", resolution = input.resolution ?? "1K", background = input.background ?? "auto";
  if (!(KIE_ASPECT_RATIOS as readonly string[]).includes(aspect_ratio) || !["1K", "2K", "4K"].includes(resolution) || !["transparent", "opaque", "auto"].includes(background)) return problem("请选择受支持的图像比例、分辨率和背景。");
  if (resolution !== "1K" && ["27:16", "16:27", "9:8", "8:9"].includes(aspect_ratio)) return problem("当前宽高比仅支持 1K 分辨率。");
  if (resolution !== "1K" && background !== "auto") return problem("透明或不透明背景参数仅支持 1K；2K/4K 请使用自动背景。");
  return { aspect_ratio, resolution, ...(resolution === "1K" ? { background } : {}) };
}

function dimensions(bytes: Buffer, mime: string): { width: number; height: number } {
  if (mime === "image/png") {
    if (bytes.length < 45 || !bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || bytes.readUInt32BE(8) !== 13 || bytes.toString("ascii", 12, 16) !== "IHDR") return problem("PNG 图像内容无效。");
    let offset = 8, data = false, ended = false;
    while (offset + 12 <= bytes.length) {
      const length = bytes.readUInt32BE(offset), type = bytes.toString("ascii", offset + 4, offset + 8);
      if (length > bytes.length - offset - 12) return problem("PNG 图像内容不完整。");
      if (type === "IDAT") data = true;
      offset += length + 12;
      if (type === "IEND") { ended = length === 0 && offset === bytes.length; break; }
    }
    if (!data || !ended) return problem("PNG 图像缺少完整像素数据。");
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (mime === "image/jpeg") {
    if (bytes.length < 10 || bytes[0] !== 255 || bytes[1] !== 216 || bytes[bytes.length - 2] !== 255 || bytes[bytes.length - 1] !== 217) return problem("JPEG 图像内容无效。");
    let offset = 2;
    while (offset + 4 < bytes.length) {
      if (bytes[offset++] !== 255) return problem("JPEG 图像内容无效。");
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++]!;
      if (marker === 217 || marker === 218) break;
      if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
      if (offset + 2 > bytes.length) break;
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if ([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker) && length >= 8) return { width: bytes.readUInt16BE(offset + 5), height: bytes.readUInt16BE(offset + 3) };
      offset += length;
    }
    return problem("无法读取 JPEG 图像尺寸。");
  }
  if (bytes.length < 26 || bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WEBP" || bytes.readUInt32LE(4) + 8 !== bytes.length) return problem("WebP 图像内容无效。");
  const type = bytes.toString("ascii", 12, 16), length = bytes.readUInt32LE(16);
  if (length > bytes.length - 20) return problem("WebP 图像内容不完整。");
  if (type === "VP8X" && length >= 10 && bytes.length >= 30) return { width: bytes.readUIntLE(24, 3) + 1, height: bytes.readUIntLE(27, 3) + 1 };
  if (type === "VP8 " && length >= 10 && bytes.length >= 30 && bytes.subarray(23, 26).equals(Buffer.from([157,1,42]))) return { width: bytes.readUInt16LE(26) & 16383, height: bytes.readUInt16LE(28) & 16383 };
  if (type === "VP8L" && length >= 5 && bytes[20] === 47) { const bits = bytes.readUInt32LE(21); return { width: (bits & 16383) + 1, height: ((bits >>> 14) & 16383) + 1 }; }
  return problem("无法读取 WebP 图像尺寸。");
}
export function validateDesignRaster(input: unknown, purpose: "input" | "output" = "input"): DesignRaster {
  const limits = purpose === "output" ? OUTPUT_RASTER_LIMITS : INPUT_RASTER_LIMITS, maximumBytes = limits.maxBytes;
  const value = object(input);
  if (typeof value.dataURL !== "string" || value.dataURL.length > Math.ceil(maximumBytes / 3) * 4 + 100) return problem(`每张图片不得超过 ${Math.floor(maximumBytes / 1024 / 1024)} MB。`);
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(value.dataURL);
  if (!match || (value.mimeType !== undefined && value.mimeType !== match[1])) return problem("请导入 PNG、JPEG 或 WebP 图像。");
  const bytes = Buffer.from(match[2]!, "base64");
  if (!bytes.length || bytes.length > maximumBytes || bytes.toString("base64") !== match[2]) return problem(`图像的 Base64 内容无效或超过 ${Math.floor(maximumBytes / 1024 / 1024)} MB。`);
  const { width, height } = dimensions(bytes, match[1]!);
  if (width < 1 || height < 1 || width > limits.maxEdge || height > limits.maxEdge || width * height > limits.maxPixels) return problem(purpose === "output" ? "生成图片尺寸不得超过 8192 像素或 6710 万总像素。" : "输入图片尺寸不得超过 8192 像素或 1677 万总像素。");
  if ((value.width !== undefined && value.width !== width) || (value.height !== undefined && value.height !== height)) return problem("图片声明尺寸与实际内容不一致。");
  return { dataURL: value.dataURL, mimeType: match[1] as DesignRaster["mimeType"], width, height,
    ...(typeof value.name === "string" ? { name: value.name.replace(/[\x00-\x1f\x7f]/g, "").slice(0, 128) } : {}) };
}

function designPrompt(input: DesignImageInput, referenceCount: number): string {
  return [input.kind === "architecture" ? "请完成建筑设计绘图。" : "请完成城市设计分析图。", "图1是未经修改的原图，图2是同一原图上的用户勾画与标注。必须以图1为基础，按图2定位用户要求的修改；不得忽略原图另画无关图。", referenceCount ? `其后${referenceCount}张仅作风格、材质或表达参考，不得替换原图的场地。` : "", "保留未要求修改区域的构图、边界及主要建筑道路关系。勾画线是编辑说明，除非用户要求保留，否则不要出现在最终图中。建筑尺寸和分析结论只按用户提供内容表达，不编造实测数据。", "用户要求：", input.prompt.trim()].filter(Boolean).join("\n");
}
async function generateOfficialImage(input: DesignImageInput, config: PrivateConfig, dependencies: DesignImageDependencies) {
  const model = input.model ?? config.model, route = config.routes?.find(item => item.id === model);
  if (!route) return problem("图像服务已更新，请稍后重试。", 409, "DESIGN_IMAGE_NOT_CONFIGURED");
  const imageMode = route.upstreamModel!.endsWith("-image-to-image");
  if (input.generationMode && imageMode !== (input.generationMode === "image-to-image")) return problem("当前绘图模式暂未开放，请稍后重试。");
  const options = validateImageGenerationOptions(input);
  const images = [...(input.base ? [input.base] : []), ...(input.annotated ? [input.annotated] : []), ...input.references].map(image => validateDesignRaster(image));
  if (imageMode ? images.length < 1 || images.length > 16 : images.length !== 0) return problem(imageMode ? "图生图需要 1 至 16 张输入图片（含原图、勾画和参考图）。" : "当前绘图模式暂未开放，请稍后重试。");
  let prompt = input.prompt.trim();
  if (input.base && input.annotated) { const contextual = designPrompt(input, input.references.length); if (contextual.length <= 20000) prompt = contextual; }
  const result = await runOfficialImageTask({ requestId: input.requestId, model, prompt, images, options, signal: input.signal, onProgress: input.onProgress }, dependencies.gateway);
  return { images: result.images.map(image => validateDesignRaster({ dataURL: `data:${image.mimeType};base64,${Buffer.from(image.bytes).toString("base64")}` }, "output")), provider: "official" as const, model: result.model };
}
export async function resumeDesignImage(requestId: string, signal: AbortSignal, onProgress?: (detail: string) => void): Promise<{ images: DesignRaster[]; provider: DesignImageProvider; model: string }> {
  try {
    const result = await resumeOfficialImageTask(requestId, signal, undefined, onProgress);
    return { images: result.images.map(image => validateDesignRaster({ dataURL: `data:${image.mimeType};base64,${Buffer.from(image.bytes).toString("base64")}` }, "output")), provider: "official", model: result.model };
  } catch (error) {
    if (signal.aborted) return problem("已停止本地等待，原图像任务可能继续执行，可稍后继续查询。", 409, "DESIGN_IMAGE_STOPPED");
    if (error instanceof PlatformServiceError) return problem(error.message, error.status || 503, error.code);
    throw error;
  }
}

export async function generateDesignImage(input: DesignImageInput, workspace: string, dependencies: DesignImageDependencies = {}): Promise<{ images: DesignRaster[]; provider: DesignImageProvider; model: string }> {
  if (!input || !["architecture", "urban-analysis"].includes(input.kind) || typeof input.prompt !== "string" || !input.prompt.trim() || input.prompt.length > 20000) return problem("请填写不超过 20000 字的绘图要求。");
  if (!input.signal || typeof input.signal.addEventListener !== "function" || typeof input.requestId !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(input.requestId)) return problem("生成请求标识无效。");
  if (!Array.isArray(input.references)) return problem("输入参考图格式无效。");
  const snapshot: { gateway?: DesignImageDependencies["gateway"] } = {}, config = await loadConfig(workspace, snapshot);
  input.onProgress?.("已连接后台图像服务");
  const imageCount = (input.base ? 1 : 0) + (input.annotated ? 1 : 0) + input.references.length;
  const selected = input.model ? config.routes?.find(route => route.id === input.model) : selectDesignImageRoute(config, imageCount);
  if (!selected) return problem("图像生成服务暂未开放，请稍后重试。", 503, "DESIGN_IMAGE_UNAVAILABLE");
  try { return await generateOfficialImage({ ...input, model: selected.id, generationMode: imageCount > 0 ? "image-to-image" : "text-to-image" }, config, { gateway: dependencies.gateway ?? snapshot.gateway }); }
  catch (error) {
    if (error instanceof DesignImageError) throw error;
    if (input.signal.aborted) return problem("已停止本地等待，供应商任务可能仍会完成并计费；请查询原调用记录。", 409, "DESIGN_IMAGE_STOPPED");
    if (error instanceof PlatformServiceError) return problem(error.message, error.status || 503, error.code);
    return problem("图像服务结果未确认，请先继续查询原任务，不会自动重新生成。", 503, "DESIGN_IMAGE_UNKNOWN");
  }
}
