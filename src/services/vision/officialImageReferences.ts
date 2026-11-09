import { createHash } from "node:crypto";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages.js";
import { readServiceConfiguration, type ServiceConfiguration, type OfficialServiceRoute } from "../../platform/serviceState.js";
import { officialRole } from "../../platform/gatewayClient.js";
import { resolveProfile, type ModelProfile } from "../api/providers/profile.js";
import { saveWorkspaceAttachment } from "../../entrypoint/webFiles.js";

type Dependencies = {
  configuration: () => Promise<ServiceConfiguration | null>;
  profile: (model: string, cwd: string) => Promise<ModelProfile>;
  vision: () => Promise<OfficialServiceRoute | null>;
  saveAttachment: (cwd: string, name: string, base64: string) => Promise<{ path: string }>;
};
type Block = Record<string, unknown>;
const object = (value: unknown): value is Block => value !== null && typeof value === "object" && !Array.isArray(value);
const extensions: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };

function containsImage(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsImage);
  return object(value) && (value.type === "image" || (value.type === "tool_result" && containsImage(value.content)));
}

/** Keep pixels away from a route which has explicitly disabled image input.
 * This does not call a model: the main agent must execute the real ReadImage
 * tool, with its normal permission checks, official vision role and events.
 */
export async function prepareOfficialImageReferences(
  messages: MessageParam[], model: string, cwd: string, signal?: AbortSignal,
  dependencies: Dependencies = { configuration: readServiceConfiguration, profile: resolveProfile,
    vision: () => officialRole("image"), saveAttachment: saveWorkspaceAttachment },
  requireAuxiliary = true,
): Promise<{ messages: MessageParam[]; imageCount: number }> {
  signal?.throwIfAborted();
  if (!messages.some(message => containsImage(message.content)) || !model.startsWith("ccagent:")) return { messages, imageCount: 0 };
  const profile = await dependencies.profile(model, cwd);
  const configuration = await dependencies.configuration();
  const route = configuration?.routes.find(item => item.id === profile.platformService);
  if (!profile.platformService || !route || route.limits.maxImages !== 0) return { messages, imageCount: 0 };
  if (requireAuxiliary) {
    if (!configuration!.auxiliaryEnabled) throw new Error("当前主模型路由未开放图片输入。请先在官方服务中启用读图辅助服务，再读取图片。");
    const vision = await dependencies.vision();
    if (!vision || vision.service !== "vision" || vision.limits.maxImages < 1) throw new Error("当前主模型路由未开放图片输入，请先选择可用的官方读图辅助服务。");
  }
  signal?.throwIfAborted();
  const paths = new Map<string, string>();
  let imageCount = 0;
  async function convert(value: unknown): Promise<unknown> {
    signal?.throwIfAborted();
    if (Array.isArray(value)) {
      const converted = [];
      for (const block of value) converted.push(await convert(block));
      return converted;
    }
    if (!object(value)) return value;
    if (value.type === "tool_result") return { ...value, content: await convert(value.content) };
    if (value.type !== "image") return value;
    const source = object(value.source) ? value.source : {};
    const extension = typeof source.media_type === "string" ? extensions[source.media_type] : undefined;
    if (!requireAuxiliary && source.type === "url" && typeof source.url === "string") {
      imageCount++;
      return { type: "text", text: `[历史图片远程引用：${JSON.stringify(source.url)}]\n历史图片未发送给当前主模型。已有文字证据时直接使用；需要重新读图时，请用户将图片作为本地附件提供，不要抓取此远程地址或猜测图片内容。` };
    }
    if (source.type !== "base64" || !extension || typeof source.data !== "string") {
      throw new Error("当前主模型路由未开放图片输入。请将远程图片保存为本地附件，再使用 ReadImage 读取。");
    }
    const digest = createHash("sha256").update(source.media_type as string).update(source.data).digest("hex");
    let filePath = paths.get(digest);
    if (!filePath) {
      const saved = await dependencies.saveAttachment(cwd, `vision-${digest.slice(0, 16)}.${extension}`, source.data);
      signal?.throwIfAborted();
      filePath = saved.path; paths.set(digest, filePath);
    }
    imageCount++;
    const instruction = requireAuxiliary
      ? "必须先调用 ReadImage 工具读取该本地图片，由已选择的官方读图模型返回文字证据，再根据工具结果回答用户。"
      : "这是历史图片引用。仅在当前要求需要重新读图且没有已有文字证据时调用 ReadImage；普通文字续问无需重新读取图片。";
    return { type: "text", text: `[图片引用：${JSON.stringify(filePath)}]\n当前主模型路由未开放图片输入。${instruction}不要根据文件名猜测图片内容，不要用脚本代替读图，不要重复已失败且输入未改变的读图请求。已有成功的 ReadImage 结果时直接使用其证据。` };
  }
  const prepared: MessageParam[] = [];
  for (const message of messages) prepared.push({ ...message, content: await convert(message.content) } as MessageParam);
  signal?.throwIfAborted();
  return { messages: prepared, imageCount };
}
