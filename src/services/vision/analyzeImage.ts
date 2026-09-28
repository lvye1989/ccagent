import type { MessageParam } from "@anthropic-ai/sdk/resources/messages.js";
import type { ContentBlock } from "../../types/message.js";
import { createMessage } from "../api/streaming.js";
import { collectViaProvider } from "../api/providers/providerStream.js";
import {
  loadModelRoles,
  loadProfiles,
  type ModelProfile,
  type ModelProtocol,
} from "../api/providers/profile.js";
import { readImageAsBlock } from "../../tools/imageUtils.js";

function envVisionProfile(): ModelProfile | null {
  const model = process.env.QWEN_MODEL?.trim();
  const rawProtocol = process.env.QWEN_PROTOCOL?.trim() || "openai-chat";
  // Keep the direct QWEN_* path aligned with Computer Use and the documented
  // DashScope-compatible protocols. Anthropic profiles remain supported via a
  // declared modelRoles.image profile, where createMessage can resolve the
  // profile id. An ad-hoc env profile is not present in the profile registry,
  // so routing one through createMessage would otherwise resolve its id as a
  // literal Anthropic model name and silently lose the configured endpoint.
  if (!model || !["openai-chat", "openai-responses", "gemini"].includes(rawProtocol)) {
    return null;
  }
  const baseURL = process.env.QWEN_BASE_URL?.trim() || process.env.DASHSCOPE_BASE_URL?.trim();
  const apiKey = process.env.QWEN_API_KEY?.trim() || process.env.DASHSCOPE_API_KEY?.trim();
  return {
    id: "qwen-vision",
    protocol: rawProtocol as ModelProtocol,
    model,
    ...(baseURL ? { baseURL } : {}),
    ...(apiKey ? { apiKey } : {}),
  };
}

export async function resolveVisionProfile(cwd: string): Promise<ModelProfile | null> {
  const fromEnv = envVisionProfile();
  if (fromEnv) return fromEnv;
  const roles = await loadModelRoles(cwd);
  const handle = roles.image || roles.multimodal || roles.vision || roles.computerUse || roles.computer_use;
  if (!handle) return null;
  const { profiles } = await loadProfiles(cwd);
  return profiles[handle] ?? null;
}

export async function analyzeImageFile(
  filePath: string,
  prompt: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<{ model: string; text: string }> {
  const profile = await resolveVisionProfile(cwd);
  if (!profile) {
    throw new Error("No Qwen/vision profile is configured (QWEN_* / DASHSCOPE_* or modelRoles.image).");
  }
  const image = await readImageAsBlock(filePath);
  if (!image.ok) throw new Error(image.error);
  const messages = [{
    role: "user",
    content: [{ type: "text", text: prompt }, image.block],
  }] as unknown as MessageParam[];
  const params = {
    messages,
    model: profile.id,
    maxTokens: 2_000,
    signal,
    querySource: "background" as const,
    thinking: { type: "disabled" as const },
  };
  const result = profile.protocol === "anthropic"
    ? await createMessage(params)
    : await collectViaProvider(profile, params);
  const text = result.content
    .filter((block): block is Extract<ContentBlock, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
  if (!text) throw new Error("The configured vision model returned no text evidence.");
  return { model: profile.id, text };
}
