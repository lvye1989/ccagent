/** DeepSeek's OpenAI-compatible stream has a mandatory reasoning replay field.
 * Keep this adapter scoped to the actual supplier, not every OpenAI model.
 * Contract: https://api-docs.deepseek.com/guides/thinking_mode/
 */
import type { UniversalStreamEvent } from "llm-bridge";

export interface DeepSeekProfileIdentity {
  protocol: string;
  model: string;
  baseURL?: string;
  provider?: string;
  upstreamProvider?: string;
  platformService?: string;
}

export function isDeepSeekProfile(profile: DeepSeekProfileIdentity): boolean {
  if (profile.protocol !== "openai-chat" || profile.provider === "ollama") return false;
  // This metadata is supplied by the authenticated official catalog. A named
  // route can use an arbitrary application handle such as deepseek-main.
  if (profile.upstreamProvider !== undefined) return profile.upstreamProvider.toLowerCase() === "deepseek";
  // Older saved official catalogs did not carry supplier metadata. Their
  // explicit DeepSeek route names remain usable until the directory refreshes.
  if (profile.platformService) return /^deepseek(?:[-/:]|$)/i.test(profile.platformService);
  try { if (new URL(profile.baseURL ?? "").hostname.toLowerCase() === "api.deepseek.com") return true; }
  catch { /* Model identity below also supports a personal compatible proxy. */ }
  return /^deepseek(?:[-/:]|$)/i.test(profile.model);
}

export function deepseekReasoningEndpoint(profile: DeepSeekProfileIdentity): string {
  let endpoint = (profile.baseURL ?? "").replace(/\/+$/, "");
  try {
    const url = new URL(endpoint);
    url.username = ""; url.password = ""; url.search = ""; url.hash = "";
    endpoint = url.toString().replace(/\/+$/, "");
  } catch { /* The normal profile validator reports invalid endpoints. */ }
  return `${endpoint}|${profile.model}`;
}

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Preserve exact same-provider, same-endpoint thinking, including plain final
 * assistant turns. Never copy Anthropic/Gemini thinking into another supplier.
 * An old session may predate reasoning capture: an empty field expresses that
 * absence without inventing text, and satisfies the upstream message schema.
 */
export function applyDeepSeekHistory<T extends { role?: unknown; reasoning_content?: unknown }>(
  messages: T[], originalMessages: readonly unknown[], profile: DeepSeekProfileIdentity,
): void {
  if (!isDeepSeekProfile(profile)) return;
  const originals = originalMessages.map(record).filter(message => message.role === "assistant");
  const assistants = messages.filter(message => message.role === "assistant");
  if (originals.length !== assistants.length) throw new Error("DeepSeek 对话记录不完整，请重新打开对话后重试。");
  const endpoint = deepseekReasoningEndpoint(profile);
  assistants.forEach((message, index) => {
    const blocks = Array.isArray(originals[index]!.content) ? originals[index]!.content as unknown[] : [];
    message.reasoning_content = blocks.map(record).filter(block =>
      block.type === "thinking" && block.reasoningProvider === "deepseek" && block.reasoningEndpoint === endpoint && typeof block.thinking === "string",
    ).map(block => block.thinking as string).join("");
  });
}

/** Native SSE framing is needed because llm-bridge drops reasoning_content.
 * It does not expose raw supplier error strings, credentials, or prompt text.
 */
export async function* parseDeepSeekChatStream(
  stream: ReadableStream<Uint8Array>, options: { waitForEOF?: boolean } = {},
): AsyncGenerator<UniversalStreamEvent> {
  const reader = stream.getReader(), decoder = new TextDecoder("utf-8", { fatal: true });
  let pending = "", started = false, terminal = false, readComplete = false, finishReason: string | undefined;
  let usage: { input_tokens: number; output_tokens: number } | undefined;
  const calls = new Map<number, { id: string; name: string; started: boolean; arguments: string }>();
  function fail(code: string): never { throw Object.assign(new Error("DeepSeek 响应未完整结束，请检查原调用状态后重试。"), { code }); }
  const flushCalls = function* (): Generator<UniversalStreamEvent> {
    // A syntactically complete first command is still part of an unfinished
    // tool turn when later output hits the limit. Do not execute partial plans
    // or persist tool calls that cannot yet be paired with their results.
    if (finishReason === "length" && calls.size > 0) fail("DEEPSEEK_TOOL_TURN_TRUNCATED");
    if (finishReason === "tool_calls" && calls.size === 0) fail("DEEPSEEK_TOOL_CALL_MISSING");
    for (const call of calls.values()) {
      if (!call.started) fail("DEEPSEEK_TOOL_CALL_INCOMPLETE");
      // Executing an incomplete JSON command would be unsafe. The provider
      // assembler sees the complete string through the deltas below.
      if (call.arguments.trim()) {
        try { const value = JSON.parse(call.arguments); if (!value || typeof value !== "object" || Array.isArray(value)) fail("DEEPSEEK_TOOL_ARGUMENTS_INVALID"); }
        catch { fail("DEEPSEEK_TOOL_ARGUMENTS_INVALID"); }
      }
      yield { type: "tool_call_end", tool_call: { id: call.id } };
    }
  };
  const frame = function* (raw: string): Generator<UniversalStreamEvent> {
    const data = raw.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).replace(/^ /, "")).join("\n");
    if (!data.trim()) return;
    if (terminal) fail("DEEPSEEK_DATA_AFTER_TERMINAL");
    if (data.trim() === "[DONE]") {
      if (!started || !finishReason) fail("DEEPSEEK_STREAM_INCOMPLETE");
      yield* flushCalls(); terminal = true;
      yield { type: "message_end", stop_reason: finishReason, ...(usage ? { usage } : {}) };
      return;
    }
    let payload: Record<string, unknown>;
    try { payload = record(JSON.parse(data)); } catch { fail("DEEPSEEK_STREAM_INVALID_JSON"); }
    if (payload!.error) fail("DEEPSEEK_STREAM_ERROR");
    if (!started) {
      started = true;
      yield { type: "message_start", id: typeof payload!.id === "string" ? payload!.id : "", model: typeof payload!.model === "string" ? payload!.model : "" };
    }
    const choice = record(Array.isArray(payload!.choices) ? payload!.choices[0] : undefined), delta = record(choice.delta);
    if (typeof delta.reasoning_content === "string" && delta.reasoning_content) yield { type: "content_delta", delta: { thinking: delta.reasoning_content } };
    if (typeof delta.content === "string" && delta.content) yield { type: "content_delta", delta: { text: delta.content } };
    if (Array.isArray(delta.tool_calls)) {
      for (const item of delta.tool_calls) {
        const tool = record(item), fn = record(tool.function), index = tool.index ?? 0;
        if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0 || index >= 200) fail("DEEPSEEK_TOOL_INDEX_INVALID");
        let call = calls.get(index);
        if (!call) { call = { id: "", name: "", started: false, arguments: "" }; calls.set(index, call); }
        if (typeof tool.id === "string" && tool.id) {
          if (call.id && call.id !== tool.id) fail("DEEPSEEK_TOOL_ID_CHANGED");
          if (Array.from(calls.entries()).some(([otherIndex, other]) => otherIndex !== index && other.id === tool.id)) fail("DEEPSEEK_TOOL_ID_DUPLICATED");
          call.id = tool.id;
        }
        if (typeof fn.name === "string" && fn.name) {
          if (call.name && call.name !== fn.name) fail("DEEPSEEK_TOOL_NAME_CHANGED");
          call.name = fn.name;
        }
        const fragment = typeof fn.arguments === "string" ? fn.arguments : "";
        call.arguments += fragment;
        if (call.arguments.length > 16 * 1024 * 1024) fail("DEEPSEEK_TOOL_ARGUMENTS_TOO_LARGE");
        if (!call.started && call.id && call.name) {
          call.started = true;
          yield { type: "tool_call_start", tool_call: { id: call.id, name: call.name } };
          if (call.arguments) yield { type: "tool_call_delta", tool_call: { id: call.id, arguments_delta: call.arguments } };
        } else if (call.started && fragment) yield { type: "tool_call_delta", tool_call: { id: call.id, arguments_delta: fragment } };
      }
    }
    if (typeof choice.finish_reason === "string" && choice.finish_reason) {
      finishReason = choice.finish_reason;
      if (!["stop", "length", "tool_calls"].includes(finishReason)) fail("DEEPSEEK_FINISH_ERROR");
    }
    if (payload!.usage) {
      const actual = record(payload!.usage);
      if (typeof actual.prompt_tokens !== "number" || !Number.isSafeInteger(actual.prompt_tokens) || actual.prompt_tokens < 0 ||
          typeof actual.completion_tokens !== "number" || !Number.isSafeInteger(actual.completion_tokens) || actual.completion_tokens < 0) fail("DEEPSEEK_USAGE_INVALID");
      usage = { input_tokens: actual.prompt_tokens, output_tokens: actual.completion_tokens };
    }
  };
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) { readComplete = true; break; }
      // The official gateway finishes accounting after the supplier's DONE
      // marker and closes its wrapped body afterward. Drain that body naturally
      // so its receipt journal can distinguish success from cancellation.
      if (terminal && options.waitForEOF) continue;
      pending += decoder.decode(chunk.value, { stream: true });
      let match: RegExpExecArray | null;
      while ((match = /\r?\n\r?\n/.exec(pending))) {
        const raw = pending.slice(0, match.index);
        pending = pending.slice(match.index + match[0].length);
        if (raw.length > 2 * 1024 * 1024) fail("DEEPSEEK_FRAME_TOO_LARGE");
        yield* frame(raw);
        if (terminal) {
          if (!options.waitForEOF) return;
          pending = "";
          break;
        }
      }
      if (pending.length > 2 * 1024 * 1024) fail("DEEPSEEK_FRAME_TOO_LARGE");
    }
    if (terminal) return;
    pending += decoder.decode();
    if (pending.trim()) yield* frame(pending);
    if (!terminal) {
      if (!started || !finishReason) fail("DEEPSEEK_STREAM_INCOMPLETE");
      yield* flushCalls();
      yield { type: "message_end", stop_reason: finishReason, ...(usage ? { usage } : {}) };
    }
  } finally {
    // Ensure aborts and parser failures close the HTTP body as well as release
    // its lock. No retry or new paid request is initiated by this adapter.
    if (!readComplete) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
