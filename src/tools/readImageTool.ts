import type { Tool } from "./Tool.js";
import { ensureRealPathInsideAllowedRoots, resolveWorkspacePath } from "./pathUtils.js";
import { analyzeImageFile } from "../services/vision/analyzeImage.js";

export const readImageTool: Tool = {
  name: "ReadImage",
  description: "Read text (OCR) or analyze a local image with the configured vision model (modelRoles.image / QWEN_*). Returns text evidence to the current model, including text-only models. Prefer this over writing OCR/API scripts. Uses the same model configuration in CLI and Web; never requires API keys in tool arguments.",
  inputSchema: {
    type: "object", properties: {
      file_path: { type: "string", description: "Absolute or workspace-relative image path" },
      prompt: { type: "string", description: "What to extract. For OCR, specify reading order and preserving line breaks." },
    }, required: ["file_path"],
  },
  async call(input, context) {
    if (typeof input.file_path !== "string" || !input.file_path.trim()) return { content: "ReadImage error: file_path is required.", isError: true };
    if (input.prompt !== undefined && (typeof input.prompt !== "string" || input.prompt.length > 10000)) return { content: "ReadImage error: prompt must be at most 10000 characters.", isError: true };
    try {
      const file = resolveWorkspacePath(input.file_path, context.cwd);
      await ensureRealPathInsideAllowedRoots(file, context.cwd);
      const prompt = typeof input.prompt === "string" && input.prompt.trim() ? input.prompt : "Extract all visible text in reading order, preserving line breaks. Describe relevant visual details only if needed. Mark unclear text explicitly; do not invent missing characters.";
      const evidence = await analyzeImageFile(file, prompt, context.cwd, context.abortSignal, 8_000);
      return { content: `Image: ${input.file_path}\nVision model: ${evidence.model}\n\n${evidence.text}` };
    } catch (error) {
      return { content: `ReadImage error: ${error instanceof Error ? error.message : String(error)}. Check the shared vision profile; do not repeat an unchanged failed request or generate shell OCR scripts.`, isError: true };
    }
  },
  isReadOnly: () => true,
  isEnabled: () => true,
  isConcurrencySafe: () => true,
};
