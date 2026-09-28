/**
 * Auto Mode AI classifier.
 *
 * Reference: claude-code-source-code/src/utils/permissions/yoloClassifier.ts
 *
 * Given the conversation transcript and a single proposed tool action, the
 * classifier makes ONE lightweight, non-streaming API call and returns a
 * binary verdict: `shouldBlock` true (needs human confirmation) or false
 * (auto-approve). The tri-state allow/deny/ask seen by callers is derived in
 * the permission layer — this module only produces the block/allow signal
 * plus an `unavailable` flag for graceful degradation.
 *
 * NOTE (Stage 1): this module is standalone and is NOT yet wired into
 * `checkPermission`. It can be exercised directly (see step snapshot /
 * verification script) without affecting any existing permission path.
 */

import type Anthropic from "@anthropic-ai/sdk";
import type {
  MessageParam,
  ContentBlockParam,
} from "@anthropic-ai/sdk/resources/messages.js";
import { createMessage } from "../services/api/streaming.js";
import { debugLog } from "../utils/log.js";
import {
  buildAutoClassifierSystemPrompt,
  type AutoClassifierPromptOptions,
} from "./autoClassifierPrompt.js";

/** Max characters of a single tool input we embed before truncating. */
const MAX_INPUT_CHARS = 2000;
/** Max characters of a transcript entry's text before truncating. */
const MAX_ENTRY_CHARS = 1500;
/** Output budget for the classifier call — it only emits a small verdict. */
const CLASSIFIER_MAX_TOKENS = 1024;

export interface AutoClassifierInput extends AutoClassifierPromptOptions {
  /** Full conversation so far (used to infer user intent). */
  messages: MessageParam[];
  /** The tool the agent wants to call. */
  toolName: string;
  /** The proposed tool input. */
  toolInput: Record<string, unknown>;
  /** Override classifier model; defaults to env / main model. */
  model?: string;
}

export interface AutoClassifierResult {
  /** true → require human confirmation; false → auto-approve. */
  shouldBlock: boolean;
  /** Short justification for the verdict (shown to the user / agent). */
  reason: string;
  /** The classifier's private reasoning, when provided. */
  thinking?: string;
  /**
   * Set when the classifier could not produce a usable verdict (API error,
   * no structured tool_use in the response, malformed fields). Callers MUST
   * treat this as "do not auto-allow" and fall back to manual confirmation.
   */
  unavailable?: boolean;
  /** Model actually used for the classification. */
  model: string;
}

/** Structured tool the classifier is forced to call. */
const CLASSIFY_RESULT_TOOL: Anthropic.Tool = {
  name: "classify_result",
  description:
    "Report your security classification of the agent's proposed action.",
  input_schema: {
    type: "object",
    properties: {
      thinking: {
        type: "string",
        description:
          "Your step-by-step reasoning: the action's practical effect, whether the user requested it, and which decision category it matches.",
      },
      shouldBlock: {
        type: "boolean",
        description:
          "true if the action requires explicit human confirmation; false if it is safe to auto-approve.",
      },
      reason: {
        type: "string",
        description:
          "A one-sentence explanation of the verdict, suitable for showing the user.",
      },
    },
    required: ["thinking", "shouldBlock", "reason"],
  },
};

function resolveClassifierModel(override?: string): string {
  return (
    override ??
    process.env.CCAGENT_AUTO_MODE_MODEL ??
    process.env.ANTHROPIC_MODEL ??
    "claude-3-5-haiku-latest"
  );
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}… [truncated ${text.length - max} chars]`;
}

function redactSensitiveText(text: string): string {
  return text
    .replace(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g, "<redacted-private-key>")
    .replace(/\b(sk-or-[A-Za-z0-9_-]+|sk-[A-Za-z0-9_-]{16,})\b/g, "<redacted-key>")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+\/-]+/gi, "$1<redacted>")
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|secret|credential|authorization|cookie|session[_-]?id)\s*[:=]\s*)[^\s,;&]+/gi, "$1<redacted>")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "<redacted-email>")
    .replace(/(?<!\d)(?:\+?\d{1,3}[ -]?)?(?:1[3-9]\d{9}|\(?\d{3}\)?[ -]\d{3,4}[ -]\d{4})(?!\d)/g, "<redacted-phone>");
}

function summarizeUrlForClassifier(value: string): unknown {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return { protocol: url.protocol, destination: "withheld-non-http-url" };
    }
    return {
      origin: url.origin,
      path: truncate(redactSensitiveText(url.pathname), 500),
      query_keys: [...new Set(url.searchParams.keys())].slice(0, 40),
      query_values_withheld: url.search.length > 0,
      fragment_present: Boolean(url.hash),
    };
  } catch {
    return truncate(redactSensitiveText(value), 500);
  }
}

function summarizeValueForClassifier(key: string, value: unknown): unknown {
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") {
    const lower = key.toLowerCase();
    if (/password|secret|token|api.?key|credential|authorization|cookie|session.?id/.test(lower)) return "<redacted>";
    if (lower === "url" || lower.endsWith("_url")) return summarizeUrlForClassifier(value);
    if (["content", "new_string", "old_string", "text"].includes(lower)) {
      return {
        kind: "withheld-content",
        length: value.length,
        multiline: /[\r\n]/.test(value),
      };
    }
    return truncate(redactSensitiveText(value), 1_200);
  }
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => summarizeValueForClassifier(key, item));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 40)
        .map(([nestedKey, nestedValue]) => [nestedKey, summarizeValueForClassifier(nestedKey, nestedValue)]),
    );
  }
  return String(value);
}

/** Bounded, secret-redacted representation used by every fallback reviewer. */
export function sanitizeClassifierToolInput(
  input: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input)
      .slice(0, 60)
      .map(([key, value]) => [key, summarizeValueForClassifier(key, value)]),
  );
}

function extractText(content: ContentBlockParam[]): string {
  return content
    .filter(
      (block): block is Extract<ContentBlockParam, { type: "text" }> =>
        block.type === "text",
    )
    .map((block) => block.text)
    .join("\n")
    .trim();
}

/**
 * Build a compact transcript focused on what matters for intent inference:
 * the user's own messages and the tool calls the agent has already made.
 * Free-form assistant prose is intentionally omitted — per the prompt's
 * anti-injection heuristic, the agent's narration must not sway the verdict.
 */
function buildTranscript(messages: MessageParam[]): string {
  const entries: string[] = [];

  for (const message of messages) {
    const content = message.content;

    if (typeof content === "string") {
      if (message.role === "user" && content.trim()) {
        entries.push(`USER: ${truncate(redactSensitiveText(content.trim()), MAX_ENTRY_CHARS)}`);
      }
      continue;
    }

    if (!Array.isArray(content)) continue;

    if (message.role === "user") {
      const text = extractText(content);
      if (text) {
        entries.push(`USER: ${truncate(redactSensitiveText(text), MAX_ENTRY_CHARS)}`);
      }
      // Tool results are the environment's output, not user intent — note
      // them tersely so the action sequence stays legible.
      const toolResults = content.filter(
        (block): block is Extract<ContentBlockParam, { type: "tool_result" }> =>
          block.type === "tool_result",
      );
      if (toolResults.length > 0) {
        entries.push(`(tool results: ${toolResults.length})`);
      }
      continue;
    }

    // assistant: keep only the tool calls (the actions), drop the narration.
    const toolUses = content.filter(
      (block): block is Extract<ContentBlockParam, { type: "tool_use" }> =>
        block.type === "tool_use",
    );
    for (const block of toolUses) {
      entries.push(
        `AGENT CALLED ${block.name}: ${truncate(
          JSON.stringify(sanitizeClassifierToolInput(
            block.input && typeof block.input === "object"
              ? block.input as Record<string, unknown>
              : {},
          )),
          MAX_ENTRY_CHARS,
        )}`,
      );
    }
  }

  if (entries.length === 0) return "(empty transcript)";
  return entries.join("\n");
}

export function formatActionForClassifier(
  toolName: string,
  toolInput: Record<string, unknown>,
): string {
  const inputJson = truncate(
    JSON.stringify(sanitizeClassifierToolInput(toolInput ?? {})),
    MAX_INPUT_CHARS,
  );
  return `The agent now wants to call the tool \`${toolName}\` with this input:\n${inputJson}`;
}

/**
 * Classify a single proposed action. Never throws — on any failure it returns
 * `{ unavailable: true, shouldBlock: true }` so callers degrade safely.
 */
export async function classifyAutoModeAction(
  input: AutoClassifierInput,
): Promise<AutoClassifierResult> {
  const model = resolveClassifierModel(input.model);
  const systemPrompt = buildAutoClassifierSystemPrompt({
    allowRules: input.allowRules,
    denyRules: input.denyRules,
  });

  const transcript = buildTranscript(input.messages);
  const action = formatActionForClassifier(input.toolName, input.toolInput);
  const userContent = `## Transcript\n${transcript}\n\n## Action to classify\n${action}`;

  debugLog("autoClassifier", "request", {
    model,
    toolName: input.toolName,
    transcriptChars: transcript.length,
  });

  try {
    const response = await createMessage({
      model,
      maxTokens: CLASSIFIER_MAX_TOKENS,
      system: systemPrompt,
      messages: [{ role: "user", content: userContent }],
      tools: [CLASSIFY_RESULT_TOOL],
      toolChoice: { type: "tool", name: "classify_result" },
      querySource: "background",
    });

    const toolUse = response.content.find(
      (block) => block.type === "tool_use" && block.name === "classify_result",
    );

    if (!toolUse || toolUse.type !== "tool_use") {
      debugLog("autoClassifier", "no_tool_use", { stopReason: response.stopReason });
      return {
        shouldBlock: true,
        unavailable: true,
        reason: "Classifier returned no structured verdict.",
        model,
      };
    }

    const raw = toolUse.input as Record<string, unknown>;
    if (typeof raw.shouldBlock !== "boolean") {
      debugLog("autoClassifier", "malformed_verdict", { raw });
      return {
        shouldBlock: true,
        unavailable: true,
        reason: "Classifier verdict was malformed.",
        model,
      };
    }

    const result: AutoClassifierResult = {
      shouldBlock: raw.shouldBlock,
      reason:
        typeof raw.reason === "string" && raw.reason.trim()
          ? raw.reason.trim()
          : raw.shouldBlock
            ? "Action requires confirmation."
            : "Action classified as safe.",
      thinking: typeof raw.thinking === "string" ? raw.thinking : undefined,
      model,
    };

    debugLog("autoClassifier", "verdict", {
      shouldBlock: result.shouldBlock,
      reason: result.reason,
    });

    return result;
  } catch (error) {
    debugLog("autoClassifier", "error", {
      message: error instanceof Error ? error.message : String(error),
    });
    return {
      shouldBlock: true,
      unavailable: true,
      reason: "Classifier API call failed.",
      model,
    };
  }
}
