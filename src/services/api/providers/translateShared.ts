/**
 * Shared, side-effect-free helpers used by more than one provider translator.
 *
 * Extracted from providerStream.ts (二期 A) so the per-provider translation
 * modules (openaiTranslate / geminiTranslate) and the streaming orchestrator
 * can all depend on them without importing one another. Behavior is unchanged.
 */

/**
 * Flatten a tool result (string | content-block array | object) to text.
 * The textual result retains an image marker. Provider translators also
 * forward toolResultImages() as user image parts beside the tool response;
 * an OpenAI tool message itself only accepts text.
 */
export function resultToString(result: unknown): string {
  if (result == null) return "";
  if (typeof result === "string") return result;
  if (Array.isArray(result)) {
    return result
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object") {
          const obj = part as { type?: string; text?: unknown };
          if (typeof obj.text === "string") return obj.text;
          if (obj.type === "image") return "[image]";
        }
        return JSON.stringify(part);
      })
      .join("\n");
  }
  return JSON.stringify(result);
}

export function toolResultImages(result: unknown): Array<{ data?: string; mimeType?: string; url?: string }> {
  if (!Array.isArray(result)) return [];
  return result.flatMap((part) => {
    if (!part || typeof part !== "object" || part.type !== "image") return [];
    const source = part.source;
    if (source?.type === "base64" && typeof source.data === "string" && source.data) return [{ data: source.data, mimeType: source.media_type || "image/png" }];
    if (source?.type === "url" && typeof source.url === "string") return [{ url: source.url }];
    if (part.media && typeof part.media === "object") return [part.media];
    return [];
  });
}

/** Normalize a provider/universal stop reason to the Anthropic vocabulary. */
export function normalizeStopReason(raw: string | undefined): string {
  // Providers disagree on casing — Gemini emits uppercase (STOP, MAX_TOKENS),
  // OpenAI lowercase (stop, length). Fold to lowercase before matching.
  switch (raw?.toLowerCase()) {
    case "tool_use":
    case "tool_calls":
      return "tool_use";
    case "max_tokens":
    case "length":
      return "max_tokens";
    case "stop_sequence":
      return "stop_sequence";
    case "end_turn":
    case "stop":
    case undefined:
    case "":
      return "end_turn";
    default:
      return raw ?? "end_turn";
  }
}
