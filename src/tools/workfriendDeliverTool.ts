import { mkdir, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";
import type { Tool, ToolContext, ToolResult } from "./Tool.js";
import { ensureRealPathInsideAllowedRoots, resolveWorkspacePath } from "./pathUtils.js";
import { writeWorkfriendDocx } from "../workfriend/docx.js";

const MAX_TTS_TEXT = 10_000;
const MAX_AUDIO_BYTES = 50 * 1024 * 1024;

function requiredText(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key} must be a non-empty string.`);
  return value.trim();
}

function dateStamp(): string {
  const now = new Date();
  const two = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}`;
}

function fileStamp(): string {
  const now = new Date();
  const two = (n: number) => String(n).padStart(2, "0");
  return `${dateStamp()}-${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`;
}

async function assertWritableOutput(outputPath: string, cwd: string, overwrite: boolean): Promise<void> {
  await ensureRealPathInsideAllowedRoots(outputPath, cwd);
  await mkdir(path.dirname(outputPath), { recursive: true });
  try {
    await stat(outputPath);
    if (!overwrite) throw new Error(`Output already exists: ${outputPath}. Set overwrite=true to replace it.`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function resolveTtsEndpoint(): string {
  const explicit = process.env.DASHSCOPE_TTS_URL?.trim();
  if (explicit) return explicit;
  const configured = process.env.DASHSCOPE_BASE_URL?.trim() || process.env.QWEN_BASE_URL?.trim();
  if (configured) {
    const url = new URL(configured);
    return `${url.origin}/api/v1/services/audio/tts/SpeechSynthesizer`;
  }
  return "https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer";
}

async function synthesizeVoice(
  content: string,
  outputPath: string,
  context: ToolContext,
  voiceOverride?: string,
): Promise<{ bytes: number; model: string; voice: string }> {
  if (content.length > MAX_TTS_TEXT) {
    throw new Error(`Voice content exceeds ${MAX_TTS_TEXT} characters; shorten the spoken summary.`);
  }
  const apiKey = process.env.DASHSCOPE_API_KEY?.trim() || process.env.QWEN_API_KEY?.trim();
  if (!apiKey) throw new Error("DASHSCOPE_API_KEY (or QWEN_API_KEY) is not configured in ~/.ccagent/.env.");
  const model = process.env.QWEN_TTS_MODEL?.trim() || "qwen-audio-3.1-tts-flash";
  const voice = voiceOverride?.trim() || process.env.QWEN_TTS_VOICE?.trim() || "longanhuan_v3.1";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);
  const abort = () => controller.abort();
  context.abortSignal?.addEventListener("abort", abort, { once: true });
  try {
    const response = await fetch(resolveTtsEndpoint(), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        input: {
          text: content,
          voice,
          format: "wav",
          sample_rate: 24_000,
          language_hints: ["zh"],
          enable_aigc_tag: true,
        },
      }),
      signal: controller.signal,
    });
    const raw = await response.text();
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      payload = undefined;
    }
    if (!response.ok) {
      const detail = raw.replaceAll(apiKey, "[redacted]").slice(0, 1_000);
      throw new Error(`DashScope TTS returned HTTP ${response.status}: ${detail}`);
    }
    const audioUrl = (payload as { output?: { audio?: { url?: unknown } } })?.output?.audio?.url;
    if (typeof audioUrl !== "string" || !/^https?:\/\//i.test(audioUrl)) {
      throw new Error("DashScope TTS succeeded but did not return output.audio.url.");
    }
    const audioResponse = await fetch(audioUrl, { signal: controller.signal });
    if (!audioResponse.ok) throw new Error(`Could not download generated audio (HTTP ${audioResponse.status}).`);
    const declared = Number(audioResponse.headers.get("content-length") ?? 0);
    if (declared > MAX_AUDIO_BYTES) throw new Error("Generated audio exceeds the 50 MB safety limit.");
    const audio = Buffer.from(await audioResponse.arrayBuffer());
    if (audio.length === 0 || audio.length > MAX_AUDIO_BYTES) {
      throw new Error("Generated audio is empty or exceeds the 50 MB safety limit.");
    }
    await writeFile(outputPath, audio);
    return { bytes: audio.length, model, voice };
  } finally {
    clearTimeout(timeout);
    context.abortSignal?.removeEventListener("abort", abort);
  }
}

export const workfriendDeliverTool: Tool = {
  name: "WorkfriendDeliver",
  description:
    "Deliver a completed Workfriend reflection as an editable Word .docx or a Qwen-generated WAV voice file. " +
    "Use only after the user chooses the format. Voice sends the supplied report text to DashScope TTS; Word stays local.",
  inputSchema: {
    type: "object" as const,
    properties: {
      format: { type: "string", enum: ["word", "voice"], description: "Requested output format." },
      content: { type: "string", description: "Complete final Workfriend report or spoken summary." },
      title: { type: "string", description: "Optional document title." },
      output_path: { type: "string", description: "Optional destination under an allowed root." },
      voice: { type: "string", description: "Optional DashScope voice id; defaults to QWEN_TTS_VOICE." },
      overwrite: { type: "boolean", description: "Replace an existing destination. Defaults to false." },
    },
    required: ["format", "content"],
  },

  async call(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    try {
      const format = requiredText(input, "format");
      if (format !== "word" && format !== "voice") throw new Error("format must be word or voice.");
      const content = requiredText(input, "content");
      const title = typeof input.title === "string" && input.title.trim()
        ? input.title.trim()
        : `Workfriend 工作复盘 ${dateStamp()}`;
      const rawOutput = typeof input.output_path === "string" && input.output_path.trim()
        ? input.output_path.trim()
        : `workfriend-${fileStamp()}.${format === "word" ? "docx" : "wav"}`;
      const expectedExt = format === "word" ? ".docx" : ".wav";
      if (path.extname(rawOutput).toLowerCase() !== expectedExt) {
        throw new Error(`output_path must end with ${expectedExt}.`);
      }
      const outputPath = resolveWorkspacePath(rawOutput, context.cwd);
      await assertWritableOutput(outputPath, context.cwd, input.overwrite === true);
      if (format === "word") {
        const bytes = await writeWorkfriendDocx(outputPath, title, content);
        return { content: `Workfriend Word document created.\nOutput: ${outputPath}\nBytes: ${bytes}` };
      }
      const voice = typeof input.voice === "string" ? input.voice : undefined;
      const result = await synthesizeVoice(content, outputPath, context, voice);
      return {
        content: [
          "Workfriend voice file created.",
          `Output: ${outputPath}`,
          `Model: ${result.model}`,
          `Voice: ${result.voice}`,
          `Bytes: ${result.bytes}`,
        ].join("\n"),
      };
    } catch (error) {
      return {
        content: `Workfriend delivery error: ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      };
    }
  },

  isReadOnly(): boolean {
    return false;
  },

  isEnabled(): boolean {
    return true;
  },
};
