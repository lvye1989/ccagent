import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Tool, ToolContext } from "./Tool.js";
import { ensureRealPathInsideAllowedRoots, resolveWorkspacePath } from "./pathUtils.js";
import { assertApplicationProtection } from "../permissions/applicationProtection.js";
import { generateDesignImage, resumeDesignImage, validateDesignRaster, validateImageGenerationOptions, KIE_ASPECT_RATIOS } from "../services/images/designImageProvider.js";

type Dependencies = { generate: typeof generateDesignImage; resume: typeof resumeDesignImage };
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function requestIdentity(context: ToolContext): string {
  if (!context.sessionId || !context.toolUseId) return randomUUID();
  const digest = createHash("sha256").update(JSON.stringify([context.sessionId, context.messageId, context.toolUseId, "GenerateImage"])).digest("hex");
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

export function createGenerateImageTool(dependencies: Dependencies = { generate: generateDesignImage, resume: resumeDesignImage }): Tool {
  return {
    name: "GenerateImage",
    description: "Generate or edit an image using the application's official 彩云间多模态大模型 image service. Use for text-to-image, image-to-image and image edits instead of shell/API scripts or describing an image without producing it. Pass original local image paths in input_images for edits/references; omit for text-to-image. The backend selects the appropriate configured image model, never ask for API keys. Returns saved image paths and a request_id. If interrupted/unknown, use operation=resume with that request_id; never create another paid task to retry the same unfinished request. Original files are preserved.",
    inputSchema: { type: "object", properties: {
      operation: { type: "string", enum: ["generate", "resume"], description: "Default generate; resume only queries the original task without generating again." },
      prompt: { type: "string", description: "Required for generation. Describe the desired image or precise edits, keeping unchanged regions explicit.", maxLength: 20000 },
      input_images: { type: "array", items: { type: "string" }, maxItems: 16, description: "Local PNG/JPEG/WebP paths. First image is the original/base, remaining images are references. Required for image-to-image/edit; do not invent paths." },
      aspect_ratio: { type: "string", enum: [...KIE_ASPECT_RATIOS] },
      resolution: { type: "string", enum: ["1K", "2K", "4K"], description: "Default 1K. Higher resolutions only when requested." },
      background: { type: "string", enum: ["auto", "opaque", "transparent"], description: "Default auto; transparency requires 1K." },
      output_directory: { type: "string", description: "Directory within the current project, default output/images. Each request saves a separate folder; originals are never overwritten." },
      request_id: { type: "string", description: "Required for resume. Use the exact request_id from a previous GenerateImage result." },
    } },
    decisionPolicy: "permission_only",
    isEnabled: () => true, isReadOnly: () => false, isConcurrencySafe: () => false,
    async call(input, context) {
      let requestId = "", submitted = false;
      const progress = (detail: string) => { if (context.toolUseId) context.onToolProgress?.({ id: context.toolUseId, name: "GenerateImage", detail }); };
      try {
        const operation = input.operation ?? "generate";
        if (!["generate", "resume"].includes(String(operation))) throw new Error("operation 必须为 generate 或 resume。");
        if (operation === "resume") {
          if (typeof input.request_id !== "string" || !uuid.test(input.request_id)) throw new Error("继续查询需要原任务的 request_id。");
          if (input.prompt !== undefined || input.input_images !== undefined) throw new Error("继续查询无需重新提交提示词或图片；使用原 request_id 即可。");
          requestId = input.request_id;
        } else {
          if (input.request_id !== undefined) throw new Error("已有请求请使用 operation=resume；新任务的编号由应用生成。");
          if (typeof input.prompt !== "string" || !input.prompt.trim() || input.prompt.length > 20000) throw new Error("请提供不超过 20000 字的绘图或编辑要求。");
          requestId = requestIdentity(context);
        }
        const directory = input.output_directory ?? "output/images";
        if (typeof directory !== "string" || !directory.trim()) throw new Error("输出文件夹无效。");
        const output = resolveWorkspacePath(path.join(directory, requestId), context.cwd);
        const relative = path.relative(context.cwd, output);
        if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("图像成果必须保存到当前项目文件夹内。");
        await ensureRealPathInsideAllowedRoots(output, context.cwd);
        await assertApplicationProtection("GenerateImage", { output_directory: output }, context);
        const signal = AbortSignal.any([AbortSignal.timeout(240000), ...(context.abortSignal ? [context.abortSignal] : [])]);
        signal.throwIfAborted();
        const references = [];
        if (operation === "generate") {
          const paths = input.input_images ?? [];
          if (!Array.isArray(paths) || paths.length > 16 || paths.some(file => typeof file !== "string" || !file.trim())) throw new Error("input_images 必须为不超过 16 张本地图片路径。");
          progress("正在检查参考图片");
          for (const file of paths) {
            const source = resolveWorkspacePath(file, context.cwd);
            await ensureRealPathInsideAllowedRoots(source, context.cwd);
            const info = await stat(source);
            if (!info.isFile() || info.size > 30 * 1024 * 1024) throw new Error("每张参考图必须为不超过 30 MB 的普通文件。");
            const mime = ({ ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" } as Record<string, string>)[path.extname(source).toLowerCase()];
            if (!mime) throw new Error("参考图支持 PNG、JPEG、WebP。");
            references.push(validateDesignRaster({ dataURL: `data:${mime};base64,${(await readFile(source)).toString("base64")}` }));
          }
        }
        const options = validateImageGenerationOptions(input as Parameters<typeof validateImageGenerationOptions>[0]);
        await mkdir(output, { recursive: true });
        await ensureRealPathInsideAllowedRoots(output, context.cwd);
        submitted = true;
        const generated = operation === "resume"
          ? await dependencies.resume(requestId, signal, progress)
          : await dependencies.generate({ prompt: input.prompt as string, kind: "architecture", references, requestId, signal, ...options, onProgress: progress }, context.cwd);
        progress("正在保存生成图片");
        const files = [];
        for (const [index, value] of generated.images.entries()) {
          const image = validateDesignRaster(value, "output");
          const extension = image.mimeType === "image/jpeg" ? "jpg" : image.mimeType.split("/")[1];
          const file = path.join(output, `image-${index + 1}.${extension}`), bytes = Buffer.from(image.dataURL.split(",")[1]!, "base64");
          await ensureRealPathInsideAllowedRoots(file, context.cwd);
          await assertApplicationProtection("GenerateImage", { output_path: file }, context);
          try { await writeFile(file, bytes, { flag: "wx" }); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !(await readFile(file)).equals(bytes)) throw error; }
          files.push({ path: file, relativePath: path.relative(context.cwd, file).replaceAll("\\", "/"), name: path.basename(file), width: image.width, height: image.height });
        }
        if (!files.length) throw new Error("图像服务没有返回可保存的图片。");
        return { content: `已生成并保存图片。采用的是彩云间多模态大模型。请向用户展示结果并提供下列真实文件链接。\n\n\`\`\`ccagent-image-result\n${JSON.stringify({ request_id: requestId, files })}\n\`\`\`` };
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
        const terminal = code === "DESIGN_IMAGE_FAILED";
        const notSubmitted = ["DESIGN_IMAGE_UNAVAILABLE", "DESIGN_IMAGE_NOT_CONFIGURED", "DESIGN_IMAGE_INVALID", "SERVICE_NOT_CONFIGURED", "DESIGN_IMAGE_NOT_SUBMITTED", "DESIGN_IMAGE_NOT_FOUND"].includes(code);
        return { isError: true, content: `GenerateImage：${error instanceof Error ? error.message : String(error)}${requestId ? `\nrequest_id: ${requestId}` : ""}${terminal ? "\n原任务已明确失败，无需 resume。先解决上述原因，再由用户决定是否重新生成。" : submitted && !notSubmitted ? "\n若任务结果待确认或本地保存失败，使用 GenerateImage(operation=resume, request_id=以上编号) 继续查询和保存；不要重新生成同一任务。" : "\n尚未提交图像生成。"}` };
      }
    },
  };
}
export const generateImageTool = createGenerateImageTool();
