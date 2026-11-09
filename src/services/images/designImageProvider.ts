import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { randomUUID } from "node:crypto";
import { readJsonSettingsFile, updateUserSettings } from "../../utils/settings.js";
import { getCCAgentPath, getUserSettingsPath } from "../../utils/paths.js";
import { withFileTransaction } from "../../utils/fileTransaction.js";
import { SecureCredentialStore } from "../../platform/secureStore.js";
import { getPlatformGatewayClient, PlatformServiceError } from "../../platform/gatewayClient.js";
import { runOfficialImageTask, resumeOfficialImageTask } from "./officialImageTasks.js";
import { readServiceConfiguration } from "../../platform/serviceState.js";

export type DesignImageProvider = "dashscope" | "openai" | "official";
export interface DesignRaster { dataURL: string; mimeType: "image/png" | "image/jpeg" | "image/webp"; width: number; height: number; name?: string }
export type Raster = DesignRaster;
export interface DesignImageConfig { configured: boolean; provider: DesignImageProvider; model: string; baseURL: string; source: "user" | "environment" | "none" | "official"; hasKey: boolean; maxReferences: number; routes?: { id: string; name: string; upstreamModel?: string }[] }
type PrivateConfig = DesignImageConfig & { key?: string; revision?: string };
type DesignCredential = { version: 1; provider: DesignImageProvider; baseURL: string; revision: string; apiKey: string };
type ObjectValue = Record<string, unknown>;
export interface DesignImageInput { prompt: string; kind: "architecture" | "urban-analysis"; base?: DesignRaster; annotated?: DesignRaster; references: DesignRaster[]; signal: AbortSignal; requestId: string; model?: string; generationMode?: "text-to-image" | "image-to-image"; aspect_ratio?: string; resolution?: string; background?: string }
/** Injection is confined to code callers/tests; Web requests cannot set network implementations. */
export interface DesignImageDependencies {
  fetch?: typeof fetch;
  lookup?: (hostname: string) => Promise<{ address: string; family: number }[]>;
  download?: (url: URL, addresses: { address: string; family: number }[], signal: AbortSignal) => Promise<{ bytes: Buffer; contentType: string }>;
  gateway?: Pick<Awaited<ReturnType<typeof getPlatformGatewayClient>>, "uploadPrivateImage" | "call" | "callStatus" | "imageTaskStatus" | "download">;
}
export const KIE_ASPECT_RATIOS = ["auto", "1:1", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16", "21:9", "27:16", "16:27", "9:8", "8:9"] as const;
export function validateImageGenerationOptions(input: Pick<DesignImageInput, "aspect_ratio" | "resolution" | "background">) {
  const aspect_ratio = input.aspect_ratio ?? "auto", resolution = input.resolution ?? "1K", background = input.background ?? "auto";
  if (!(KIE_ASPECT_RATIOS as readonly string[]).includes(aspect_ratio) || !["1K", "2K", "4K"].includes(resolution) || !["transparent", "opaque", "auto"].includes(background)) return problem("请选择受支持的图像比例、分辨率和背景。");
  if (resolution !== "1K" && ["27:16", "16:27", "9:8", "8:9"].includes(aspect_ratio)) return problem("当前宽高比仅支持 1K 分辨率。");
  if (resolution !== "1K" && background !== "auto") return problem("透明或不透明背景参数仅支持 1K；2K/4K 请使用自动背景。");
  return { aspect_ratio, resolution, ...(resolution === "1K" ? { background } : {}) };
}
const MAX_BYTES = 30 * 1024 * 1024, MAX_TOTAL_BYTES = 30 * 1024 * 1024, MAX_PIXELS = 16_777_216;
const SETTING = "whiteboardDesignImage", DASH_URL = "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation";
const DASH_MODEL = "qwen-image-2.0-pro", OPENAI_MODEL = "gpt-image-1.5";
// The private worker imports this module before loadEnv considers project files.
// Do not let workspace switching redirect an already-owned personal credential.
const inheritedEnvironment = Object.fromEntries(["IMAGE_EDIT_PROVIDER", "IMAGE_EDIT_MODEL", "IMAGE_EDIT_BASE_URL", "IMAGE_EDIT_API_KEY", "DASHSCOPE_API_KEY", "QWEN_API_KEY"].map(name => [name, process.env[name]]));
const object = (value: unknown): ObjectValue => value && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : {};
export class DesignImageError extends Error {
  constructor(message: string, readonly status = 400, readonly code = "DESIGN_IMAGE_INVALID") { super(message); this.name = "DesignImageError"; }
}
const problem = (message: string, status = 400, code = "DESIGN_IMAGE_INVALID"): never => { throw new DesignImageError(message, status, code); };
const credentialStore = () => new SecureCredentialStore<DesignCredential>(getCCAgentPath("credentials", "design-image.json"));

function provider(value: unknown): DesignImageProvider {
  if (value !== "dashscope" && value !== "openai" && value !== "official") return problem("请选择官方、DashScope 或 OpenAI 兼容图像服务。");
  return value;
}
function modelName(value: unknown, kind: DesignImageProvider): string {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name || name.length > 160 || /[\s\x00-\x1f\x7f]/.test(name)) return problem("请填写有效的图像编辑模型名称。");
  if (kind === "dashscope" && !/^qwen-image-(?:edit(?:-plus)?(?:-[\w.-]+)?|[23]\.0(?:-pro)?(?:-[\w.-]+)?)$/.test(name)) return problem("DashScope 需要支持多图编辑的 Qwen Image 编辑模型，不能使用视觉读图或纯文生图模型。");
  return name;
}
function endpoint(value: unknown, kind: DesignImageProvider): string {
  let url: URL;
  try { url = new URL(typeof value === "string" && value.trim() ? value.trim() : kind === "dashscope" ? DASH_URL : "https://api.openai.com/v1"); }
  catch { return problem("服务地址必须是完整的 HTTPS 地址。"); }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname.toLowerCase());
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) || url.username || url.password || url.search || url.hash) return problem("服务地址须使用 HTTPS；仅显式配置的本机测试服务允许 HTTP，不能包含凭据、查询或片段。");
  let pathname = url.pathname.replace(/\/+$/, "");
  if (kind === "dashscope") {
    if (!pathname || pathname === "/api/v1") pathname = "/api/v1/services/aigc/multimodal-generation/generation";
    if (!pathname.endsWith("/services/aigc/multimodal-generation/generation")) return problem("DashScope 地址须为 multimodal-generation/generation 图像编辑接口。");
  } else {
    if (!pathname) pathname = "/v1";
    if (!pathname.endsWith("/images/edits")) pathname += "/images/edits";
  }
  url.pathname = pathname;
  return url.toString();
}
function safe(config: PrivateConfig): DesignImageConfig {
  const { configured, provider, model, baseURL, source, hasKey, maxReferences, routes } = config;
  return { configured, provider, model, baseURL, source, hasKey, maxReferences, ...(routes ? { routes } : {}) };
}
async function officialConfiguration(): Promise<PrivateConfig | null> {
  if (!process.env.CCAGENT_ACCOUNT_ID) return null;
  const state = await readServiceConfiguration();
  const routes = state?.routes.filter(route => route.service === "image" && route.protocol === "kie-images" && /^gpt-image-2-5-(?:flare|sunburst)-(?:text-to-image|image-to-image)$/.test(route.upstreamModel ?? "")) ?? [];
  if (!state?.auxiliaryEnabled || !routes.length) return null;
  const model = state.roles.imageGeneration && routes.some(route => route.id === state.roles.imageGeneration) ? state.roles.imageGeneration : routes[0]!.id;
  return { configured: true, provider: "official", model, baseURL: state.origin + "/v1/images/tasks", source: "official", hasKey: true, maxReferences: 14,
    routes: routes.map(({ id, name, upstreamModel }) => ({ id, name, upstreamModel })) };
}
async function loadConfig(_workspace: string): Promise<PrivateConfig> {
  // Deliberately read USER settings only. Repositories cannot override a personal image endpoint/key.
  const { raw, parseError } = await readJsonSettingsFile<ObjectValue>(getUserSettingsPath());
  if (parseError) return problem("无法读取本账户的图像模型设置，请修复设置文件后重试。");
  const stored = object(raw?.[SETTING]);
  if (stored.disabled === true) return { configured: false, provider: "dashscope", model: DASH_MODEL, baseURL: DASH_URL, source: "none", hasKey: false, maxReferences: 1 };
  if (Object.keys(stored).length) {
    if (stored.provider === "official") return await officialConfiguration() ?? { configured: false, provider: "official", model: "", baseURL: "", source: "none", hasKey: false, maxReferences: 14, routes: [] };
    const kind = provider(stored.provider), model = modelName(stored.model, kind), baseURL = endpoint(stored.baseURL, kind);
    let credential: DesignCredential | null;
    try { credential = await credentialStore().read(); }
    catch { return problem("无法读取本账户的图像模型凭据，请重新保存个人 API Key。", 409, "DESIGN_IMAGE_CREDENTIAL"); }
    const revision = typeof stored.revision === "string" ? stored.revision : undefined;
    const key = credential?.version === 1 && credential.provider === kind && credential.baseURL === baseURL && credential.revision === revision && typeof credential.apiKey === "string" ? credential.apiKey.trim() : undefined;
    return { configured: Boolean(key), provider: kind, model, baseURL, source: "user", hasKey: Boolean(key), maxReferences: kind === "dashscope" ? 1 : 2, key, revision };
  }
  const official = await officialConfiguration();
  if (official) return official;
  const kind = provider(inheritedEnvironment.IMAGE_EDIT_PROVIDER?.trim() || "dashscope");
  // QWEN_MODEL/QWEN_BASE_URL and general OPENAI_API_KEY are intentionally never reused.
  const key = (inheritedEnvironment.IMAGE_EDIT_API_KEY || (kind === "dashscope" && !inheritedEnvironment.IMAGE_EDIT_BASE_URL ? inheritedEnvironment.DASHSCOPE_API_KEY || inheritedEnvironment.QWEN_API_KEY : ""))?.trim();
  const model = modelName(inheritedEnvironment.IMAGE_EDIT_MODEL?.trim() || (kind === "dashscope" ? DASH_MODEL : OPENAI_MODEL), kind);
  const baseURL = endpoint(inheritedEnvironment.IMAGE_EDIT_BASE_URL, kind);
  return { configured: Boolean(key), provider: kind, model, baseURL, source: key ? "environment" : "none", hasKey: Boolean(key), maxReferences: kind === "dashscope" ? 1 : 2, key };
}

export async function getDesignImageConfig(workspace: string): Promise<DesignImageConfig> { return safe(await loadConfig(workspace)); }
export async function saveDesignImageConfig(body: unknown, workspace: string): Promise<DesignImageConfig> {
  return withFileTransaction(getCCAgentPath("credentials", "design-image-configuration.lock"), () => saveConfiguration(body, workspace));
}
async function saveConfiguration(body: unknown, workspace: string): Promise<DesignImageConfig> {
  const input = object(body);
  if (input.clear === true) {
    // Disable fallback before deleting the key, so an interrupted clear cannot re-enable an environment credential.
    await updateUserSettings({ [SETTING]: { disabled: true } }); await credentialStore().clear(); return getDesignImageConfig(workspace);
  }
  if (input.provider === "official") {
    const config = await officialConfiguration();
    if (!config) return problem("请先刷新官方服务目录并启用已配置的图像生成服务。", 409, "DESIGN_IMAGE_NOT_CONFIGURED");
    await updateUserSettings({ [SETTING]: { provider: "official" } });
    return config;
  }
  const kind = provider(input.provider), baseURL = endpoint(input.baseURL, kind), model = modelName(input.model, kind);
  // A fresh key must allow recovery from an unreadable/damaged previous credential.
  const previous = await loadConfig(workspace).catch(error => {
    if (typeof input.apiKey === "string" && input.apiKey.trim()) return null;
    throw error;
  });
  if (input.apiKey !== undefined && typeof input.apiKey !== "string") return problem("API Key 必须为单行文本。");
  const key = typeof input.apiKey === "string" ? input.apiKey.trim() : "";
  if (key.length > 8192 || /[\r\n\0]/.test(key)) return problem("API Key 必须是有效的单行文本。");
  const retainedKey = previous?.source === "user" && previous.provider === kind && previous.baseURL === baseURL ? previous.key : undefined;
  if (!key && !retainedKey) return problem("请填写该图像编辑服务的个人 API Key；更换地址后需要重新填写。");
  const revision = randomUUID();
  await credentialStore().write({ version: 1, provider: kind, baseURL, revision, apiKey: key || retainedKey! });
  // A revision mismatch fails closed if either of the two durable writes is interrupted.
  await updateUserSettings({ [SETTING]: { provider: kind, baseURL, model, revision } });
  return getDesignImageConfig(workspace);
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
export function validateDesignRaster(input: unknown, maximumBytes = MAX_BYTES): DesignRaster {
  const value = object(input);
  if (typeof value.dataURL !== "string" || value.dataURL.length > Math.ceil(maximumBytes / 3) * 4 + 100) return problem(`每张图片不得超过 ${Math.floor(maximumBytes / 1024 / 1024)} MB。`);
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(value.dataURL);
  if (!match || (value.mimeType !== undefined && value.mimeType !== match[1])) return problem("请导入 PNG、JPEG 或 WebP 图像。");
  const bytes = Buffer.from(match[2]!, "base64");
  if (!bytes.length || bytes.length > maximumBytes || bytes.toString("base64") !== match[2]) return problem(`图像的 Base64 内容无效或超过 ${Math.floor(maximumBytes / 1024 / 1024)} MB。`);
  const { width, height } = dimensions(bytes, match[1]!);
  if (width < 1 || height < 1 || width > 8192 || height > 8192 || width * height > MAX_PIXELS) return problem("图片尺寸不得超过 8192 像素或 1677 万总像素。");
  if ((value.width !== undefined && value.width !== width) || (value.height !== undefined && value.height !== height)) return problem("图片声明尺寸与实际内容不一致。");
  return { dataURL: value.dataURL, mimeType: match[1] as DesignRaster["mimeType"], width, height,
    ...(typeof value.name === "string" ? { name: value.name.replace(/[\x00-\x1f\x7f]/g, "").slice(0, 128) } : {}) };
}

function publicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a = 0, b = 0, c = 0] = address.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
  }
  // Only native global unicast IPv6, excluding transition/documentation ranges.
  if (isIP(address) === 6) {
    const [first = 0, second = 0] = address.split(":").map(part => Number.parseInt(part || "0", 16));
    return first >= 0x2000 && first <= 0x3ffe && first !== 0x2002 && !(first === 0x2001 && (second < 0x200 || second === 0xdb8));
  }
  return false;
}
async function boundedBody(response: Response, maximum: number): Promise<Buffer> {
  if (Number(response.headers.get("content-length")) > maximum) { await response.body?.cancel(); return problem("图像服务返回内容过大。"); }
  const reader = response.body?.getReader();
  if (!reader) return problem("图像服务未返回内容。");
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) { const next = await reader.read(); if (next.done) break; size += next.value.length; if (size > maximum) { await reader.cancel(); return problem("图像服务返回内容过大。"); } chunks.push(next.value); }
    return Buffer.concat(chunks);
  } finally { reader.releaseLock(); }
}
async function pinnedDownload(url: URL, addresses: { address: string; family: number }[], signal: AbortSignal): Promise<{ bytes: Buffer; contentType: string }> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(url, { method: "GET", signal, headers: { accept: "image/png,image/jpeg,image/webp" },
      lookup: (_host, options, callback) => {
        const candidate = addresses.find(item => !options.family || item.family === options.family) ?? addresses[0]!;
        if (options.all) callback(null, addresses as never); else callback(null, candidate.address, candidate.family);
      } }, response => {
      if (response.statusCode !== 200) { response.destroy(); reject(new Error("无法下载图像服务的结果，请重新生成；下载不接受重定向。")); return; }
      if (Number(response.headers["content-length"]) > MAX_BYTES) { response.destroy(); reject(new Error("生成图像超过 10 MB。")); return; }
      const chunks: Buffer[] = []; let size = 0;
      response.on("data", (chunk: Buffer) => { size += chunk.length; if (size > MAX_BYTES) response.destroy(new Error("生成图像超过 10 MB。")); else chunks.push(chunk); });
      response.on("error", reject); response.on("end", () => resolve({ bytes: Buffer.concat(chunks), contentType: String(response.headers["content-type"] ?? "").split(";")[0]!.trim() }));
    });
    request.on("error", reject); request.end();
  });
}
async function whileActive<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let stop: (() => void) | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      stop = () => reject(signal.reason); signal.addEventListener("abort", stop, { once: true });
      if (signal.aborted) stop();
    })]);
  } finally { if (stop) signal.removeEventListener("abort", stop); }
}
async function resultRaster(value: unknown, signal: AbortSignal, dependencies: DesignImageDependencies): Promise<DesignRaster> {
  if (typeof value !== "string") return problem("图像服务未返回有效图片。");
  if (value.startsWith("data:")) return validateDesignRaster({ dataURL: value });
  let url: URL;
  try { url = new URL(value); } catch { return problem("图像服务返回的下载地址无效。"); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash || (url.port && url.port !== "443")) return problem("生成图像只允许从公开 HTTPS 地址下载。");
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) return problem("生成图像地址不能指向本机或内网。");
  const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await whileActive((dependencies.lookup ?? (host => dnsLookup(host, { all: true })))(hostname), signal);
  if (!addresses.length || addresses.some(item => !publicAddress(item.address))) return problem("生成图像地址不能指向本机、保留地址或内网。");
  // Pin the validated DNS answers to the TLS connection; do not forward supplier Authorization.
  const result = await whileActive((dependencies.download ?? pinnedDownload)(url, addresses, signal), signal);
  if (result.bytes.length > MAX_BYTES) return problem("生成图像超过 10 MB。");
  const type = result.contentType || (result.bytes[0] === 137 ? "image/png" : result.bytes[0] === 255 ? "image/jpeg" : "image/webp");
  return validateDesignRaster({ dataURL: `data:${type};base64,${result.bytes.toString("base64")}` });
}
function designPrompt(input: DesignImageInput, referenceCount: number): string {
  return [input.kind === "architecture" ? "请完成建筑设计绘图。" : "请完成城市设计分析图。", "图1是未经修改的原图，图2是同一原图上的用户勾画与标注。必须以图1为基础，按图2定位用户要求的修改；不得忽略原图另画无关图。", referenceCount ? `其后${referenceCount}张仅作风格、材质或表达参考，不得替换原图的场地。` : "", "保留未要求修改区域的构图、边界及主要建筑道路关系。勾画线是编辑说明，除非用户要求保留，否则不要出现在最终图中。建筑尺寸和分析结论只按用户提供内容表达，不编造实测数据。", "用户要求：", input.prompt.trim()].filter(Boolean).join("\n");
}
function dashScopeSize(base: DesignRaster): string {
  // A reference photo must not set the result's aspect ratio (DashScope otherwise
  // uses the last input image). Aim at one megapixel within the documented cap.
  const ratio = base.width / base.height;
  const width = Math.max(16, Math.round(Math.sqrt(1_048_576 * ratio) / 16) * 16);
  const height = Math.max(16, Math.round(Math.sqrt(1_048_576 / ratio) / 16) * 16);
  if (width > 8192 || height > 8192 || width * height < 262_144 || width * height > 4_194_304) return problem("原图宽高比过于极端，请先裁切为适合建筑或城市设计表达的画面。");
  return `${width}*${height}`;
}
async function generateOfficialImage(input: DesignImageInput, config: PrivateConfig, dependencies: DesignImageDependencies) {
  const model = input.model ?? config.model, route = config.routes?.find(item => item.id === model);
  if (!route) return problem("所选图像生成模型已不可用，请刷新官方目录。", 409, "DESIGN_IMAGE_NOT_CONFIGURED");
  const imageMode = route.upstreamModel!.endsWith("-image-to-image");
  if (input.generationMode && imageMode !== (input.generationMode === "image-to-image")) return problem("所选模型与文生图/图生图模式不匹配。");
  const options = validateImageGenerationOptions(input);
  const images = [...(input.base ? [input.base] : []), ...(input.annotated ? [input.annotated] : []), ...input.references].map(image => validateDesignRaster(image));
  if (imageMode ? images.length < 1 || images.length > 16 : images.length !== 0) return problem(imageMode ? "图生图需要 1 至 16 张输入图片（含原图、勾画和参考图）。" : "文生图不接收图片，请切换图生图模型。");
  let prompt = input.prompt.trim();
  if (input.base && input.annotated) { const contextual = designPrompt(input, input.references.length); if (contextual.length <= 20000) prompt = contextual; }
  const result = await runOfficialImageTask({ requestId: input.requestId, model, prompt, images, options, signal: input.signal }, dependencies.gateway);
  return { images: result.images.map(image => validateDesignRaster({ dataURL: `data:${image.mimeType};base64,${Buffer.from(image.bytes).toString("base64")}` }, 64 * 1024 * 1024)), provider: "official" as const, model: result.model };
}
export async function resumeDesignImage(requestId: string, signal: AbortSignal): Promise<{ images: DesignRaster[]; provider: DesignImageProvider; model: string }> {
  try {
    const result = await resumeOfficialImageTask(requestId, signal);
    return { images: result.images.map(image => validateDesignRaster({ dataURL: `data:${image.mimeType};base64,${Buffer.from(image.bytes).toString("base64")}` }, 64 * 1024 * 1024)), provider: "official", model: result.model };
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
  const config = await loadConfig(workspace); // Capture endpoint/model/key together before any request.
  if (config.provider === "official") {
    if (!config.configured) return problem("请先启用官方图像生成服务。", 409, "DESIGN_IMAGE_NOT_CONFIGURED");
    try { return await generateOfficialImage(input, config, dependencies); }
    catch (error) {
      if (error instanceof DesignImageError) throw error;
      if (input.signal.aborted) return problem("已停止本地等待，供应商任务可能仍会完成并计费；请查询原调用记录。", 409, "DESIGN_IMAGE_STOPPED");
      if (error instanceof PlatformServiceError) return problem(error.message, error.status || 503, error.code);
      return problem("图像服务结果未确认，请先查看原调用记录，不会自动重新生成。", 503, "DESIGN_IMAGE_UNKNOWN");
    }
  }
  if (!input.base || !input.annotated || input.prompt.length > 6000) return problem("个人图像编辑服务需要原图与勾画，并且要求不超过 6000 字。");
  if (!config.configured || !config.key) return problem("请先配置个人图像编辑模型及 API Key；此功能不使用平台余额自动扣费。", 409, "DESIGN_IMAGE_NOT_CONFIGURED");
  if (!Array.isArray(input.references) || input.references.length > config.maxReferences) return problem(`当前图像服务最多支持 ${config.maxReferences} 张参考图（此外会同时发送原图与勾画图）。`);
  const images = [validateDesignRaster(input.base), validateDesignRaster(input.annotated), ...input.references.map(image => validateDesignRaster(image))];
  if (images[0]!.width !== images[1]!.width || images[0]!.height !== images[1]!.height) return problem("勾画图必须与原图尺寸一致，请重新选定原图区域。");
  if (images.reduce((total, image) => total + Buffer.byteLength(image.dataURL.split(",")[1]!, "base64"), 0) > MAX_TOTAL_BYTES) return problem("本次输入图片总量不得超过 30 MB。");
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(180_000)]), prompt = designPrompt(input, input.references.length);
  let body: string | FormData, headers: Record<string, string> = { authorization: `Bearer ${config.key}` };
  if (config.provider === "dashscope") {
    headers["content-type"] = "application/json";
    body = JSON.stringify({ model: config.model, input: { messages: [{ role: "user", content: [...images.map(image => ({ image: image.dataURL })), { text: prompt }] }] }, parameters: { n: 1, prompt_extend: false, watermark: false,
      ...(/^qwen-image-[23]\.0/.test(config.model) ? { size: dashScopeSize(images[0]!) } : {}) } });
  } else {
    body = new FormData(); body.set("model", config.model); body.set("prompt", prompt); body.set("n", "1");
    for (const [index, image] of images.entries()) { const bytes = Uint8Array.from(Buffer.from(image.dataURL.split(",")[1]!, "base64")); body.append("image[]", new Blob([bytes], { type: image.mimeType }), `${index === 0 ? "original" : index === 1 ? "annotated" : "reference-" + (index - 1)}.${image.mimeType === "image/jpeg" ? "jpg" : image.mimeType.split("/")[1]}`); }
  }
  try {
    signal.throwIfAborted();
    const response = await (dependencies.fetch ?? fetch)(config.baseURL, { method: "POST", headers, body, signal, redirect: "error" });
    if (!response.ok) { await response.body?.cancel(); return problem(`图像编辑服务返回 HTTP ${response.status}。请检查模型、地址、额度与 API Key；不会自动重试。`); }
    const bytes = await boundedBody(response, 16 * 1024 * 1024);
    let raw: ObjectValue;
    try { raw = object(JSON.parse(bytes.toString("utf8"))); } catch { return problem("图像服务返回了无效 JSON；不会自动重试。"); }
    if (raw.code || raw.error) return problem("图像服务拒绝了本次编辑，请检查模型支持、输入图和服务额度；不会自动重试。");
    const values: unknown[] = [];
    if (config.provider === "dashscope") {
      const choices = object(raw.output).choices;
      for (const choice of Array.isArray(choices) ? choices : []) { const content = object(object(choice).message).content; for (const item of Array.isArray(content) ? content : []) if (object(item).image) values.push(object(item).image); }
    } else {
      for (const item of Array.isArray(raw.data) ? raw.data : []) { const value = object(item); values.push(typeof value.b64_json === "string" ? "data:image/png;base64," + value.b64_json : value.url); }
    }
    if (values.length !== 1) return problem("图像服务应返回一张编辑结果，请检查接口与模型配置。");
    const result = await resultRaster(values[0], signal, dependencies);
    signal.throwIfAborted();
    return { images: [result], provider: config.provider, model: config.model };
  } catch (error) {
    if (input.signal.aborted) return problem("已取消本地图像生成等待；已发送的服务端请求仍可能产生供应商费用。");
    if (signal.aborted) return problem("图像生成等待超过 180 秒；请先到供应商核对请求状态，避免重复费用。");
    // Never surface fetch/TLS exception text or supplier body: either may include URLs, keys or images.
    if (error instanceof DesignImageError && !error.message.includes(config.key)) throw error;
    return problem("图像编辑服务连接或结果校验失败，请检查配置与网络；不会自动重试。");
  }
}
