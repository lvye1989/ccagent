import type { MessageParam } from "@anthropic-ai/sdk/resources/messages.js";
import type { Usage } from "../types/message.js";

export const MODEL_CONTEXT_WINDOW_DEFAULT = 200_000;
export const MAX_OUTPUT_TOKENS_FOR_SUMMARY = 20_000;
export const AUTOCOMPACT_BUFFER_TOKENS = 13_000;
export const WARNING_THRESHOLD_BUFFER_TOKENS = 20_000;
export const MANUAL_COMPACT_BUFFER_TOKENS = 3_000;

const TEXT_CHARS_PER_TOKEN = 4;
const JSON_CHARS_PER_TOKEN = 2;
const MESSAGE_OVERHEAD_TOKENS = 12;
const TOOL_BLOCK_OVERHEAD_TOKENS = 24;
const FIXED_BINARY_BLOCK_TOKENS = 2_000;

const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  // DeepSeek V4 API models expose a 1 Mi-token context window. Keep the
  // concrete model names here; named profiles can override this explicitly
  // with models.<id>.contextWindow.
  "deepseek-flash": 1_048_576,
  "deepseek-v4-flash": 1_048_576,
  "deepseek-v4-pro": 1_048_576,
  "claude-opus-4-20250514": 200_000,
  "claude-sonnet-4-20250514": 200_000,
  "claude-haiku-3-20250307": 200_000,
  "claude-3-5-sonnet-20241022": 200_000,
  "claude-3-5-haiku-20241022": 200_000,
  "claude-3-opus-20240229": 200_000,
};

export function getContextWindowForModel(model: string, configuredContextWindow?: number): number {
  // CCAGENT_MAX_CONTEXT_TOKENS is the project name; CLAUDE_CODE_MAX_CONTEXT_TOKENS
  // is honored too for parity with source (matches getMaxRetries' alias pattern).
  const envOverride =
    process.env.CCAGENT_MAX_CONTEXT_TOKENS ?? process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS;
  if (envOverride) {
    const parsed = parseInt(envOverride, 10);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }

  if (
    configuredContextWindow !== undefined &&
    Number.isFinite(configuredContextWindow) &&
    configuredContextWindow > 0
  ) {
    return Math.floor(configuredContextWindow);
  }

  if (MODEL_CONTEXT_WINDOWS[model]) {
    return MODEL_CONTEXT_WINDOWS[model];
  }

  for (const [key, value] of Object.entries(MODEL_CONTEXT_WINDOWS)) {
    if (model.includes(key) || key.includes(model)) return value;
  }

  return MODEL_CONTEXT_WINDOW_DEFAULT;
}

export function getEffectiveContextWindowSize(model: string, configuredContextWindow?: number): number {
  const contextWindow = getContextWindowForModel(model, configuredContextWindow);
  const reserved = Math.min(MAX_OUTPUT_TOKENS_FOR_SUMMARY, Math.floor(contextWindow * 0.2));
  return contextWindow - reserved;
}

function roughTokenCountEstimation(content: string, charsPerToken = TEXT_CHARS_PER_TOKEN): number {
  // The four-ASCII-character heuristic severely undercounts Chinese and
  // other non-ASCII text before a provider usage anchor exists (notably
  // after resume). Count non-ASCII code units conservatively; surrogate
  // pairs retain two units because emoji/supplementary scripts can use
  // multiple tokens. English/JSON/base64 estimates remain unchanged.
  let nonAscii = 0;
  for (let index = 0; index < content.length; index++) {
    if (content.charCodeAt(index) > 0x7f) nonAscii++;
  }
  return Math.max(1, Math.round((content.length - nonAscii) / charsPerToken + nonAscii));
}

function estimateUnknownObjectTokens(value: unknown): number {
  return roughTokenCountEstimation(JSON.stringify(value ?? ""), JSON_CHARS_PER_TOKEN);
}

function estimateContentBlockTokens(content: MessageParam["content"]): number {
  if (typeof content === "string") {
    return roughTokenCountEstimation(content);
  }

  if (!Array.isArray(content)) {
    return 0;
  }

  return content.reduce((total, block) => {
    switch (block.type) {
      case "text":
        return total + roughTokenCountEstimation(block.text);
      case "tool_use":
        return (
          total +
          TOOL_BLOCK_OVERHEAD_TOKENS +
          roughTokenCountEstimation(block.name) +
          estimateUnknownObjectTokens(block.input)
        );
      case "tool_result": {
        const serialized = typeof block.content === "string" ? block.content : JSON.stringify(block.content);
        return total + TOOL_BLOCK_OVERHEAD_TOKENS + roughTokenCountEstimation(serialized, JSON_CHARS_PER_TOKEN);
      }
      case "image":
      case "document":
        return total + FIXED_BINARY_BLOCK_TOKENS;
      default:
        return total + estimateUnknownObjectTokens(block);
    }
  }, 0);
}

export function estimateMessageTokens(message: MessageParam): number {
  return MESSAGE_OVERHEAD_TOKENS + estimateContentBlockTokens(message.content);
}

export function roughTokenCountEstimationForMessages(messages: readonly MessageParam[]): number {
  const rawEstimate = messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
  return Math.ceil((rawEstimate * 4) / 3);
}

export function estimateSystemPromptTokens(systemPrompt: string): number {
  return roughTokenCountEstimation(systemPrompt) + MESSAGE_OVERHEAD_TOKENS;
}

/** Schemas are mostly descriptions/JSON; use the same conservative margin as message estimates. */
export function estimateToolDefinitionTokens(tools?: readonly unknown[]): number {
  if (!tools?.length) return 0;
  return Math.ceil(roughTokenCountEstimation(JSON.stringify(tools)) * 4 / 3);
}

export function getTokenCountFromUsage(usage: Usage): number {
  return (
    usage.input_tokens +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0) +
    usage.output_tokens
  );
}

export function tokenCountWithEstimation(
  messages: readonly MessageParam[],
  options?: { usage?: Usage; usageAnchorIndex?: number; usageSystemPromptTokens?: number; usageToolDefinitionTokens?: number; systemPrompt?: string; toolDefinitions?: readonly unknown[] },
): number {
  const systemPromptTokens = options?.systemPrompt ? estimateSystemPromptTokens(options.systemPrompt) : 0;
  const toolDefinitionTokens = estimateToolDefinitionTokens(options?.toolDefinitions);

  const usage = options?.usage;
  const promptTokens = usage ? usage.input_tokens + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) : 0;
  // A restored transcript has no per-request usage. Its zero-valued placeholder
  // must not hide the history; cached-only prompts, however, are real usage.
  if (usage && [usage.input_tokens, usage.output_tokens, usage.cache_creation_input_tokens ?? 0, usage.cache_read_input_tokens ?? 0].every(value => Number.isFinite(value) && value >= 0)
    && promptTokens > 0 && options?.usageAnchorIndex !== undefined
    && Number.isInteger(options.usageAnchorIndex) && options.usageAnchorIndex >= 0 && options.usageAnchorIndex < messages.length) {
    const suffix = messages.slice(options.usageAnchorIndex + 1);
    // Provider prompt usage already includes the system prompt and tool
    // definitions. Only count messages added after its assistant response and
    // growth of the dynamic system prompt since that same request.
    const measuredTokens = getTokenCountFromUsage(usage) + roughTokenCountEstimationForMessages(suffix);
    if (options.usageSystemPromptTokens !== undefined && Number.isFinite(options.usageSystemPromptTokens) && options.usageSystemPromptTokens >= 0) {
      const toolBaseline = options.usageToolDefinitionTokens;
      const hasToolBaseline = toolBaseline !== undefined && Number.isFinite(toolBaseline) && toolBaseline >= 0;
      const dynamicToolGrowth = hasToolBaseline
        ? Math.max(0, toolDefinitionTokens - toolBaseline)
        : 0;
      const measuredWithGrowth = measuredTokens + Math.max(0, systemPromptTokens - options.usageSystemPromptTokens) + dynamicToolGrowth;
      // A legacy usage anchor cannot establish which schemas it already paid
      // for. Use a visible-context floor instead of adding all tools twice.
      return !hasToolBaseline
        ? Math.max(measuredWithGrowth, roughTokenCountEstimationForMessages(messages) + systemPromptTokens + toolDefinitionTokens)
        : measuredWithGrowth;
    }
    // Older callers lack the system snapshot. Keep the current visible prompt
    // as a floor without adding its entire system prompt a second time.
    return Math.max(measuredTokens, roughTokenCountEstimationForMessages(messages) + systemPromptTokens + toolDefinitionTokens);
  }

  return roughTokenCountEstimationForMessages(messages) + systemPromptTokens + toolDefinitionTokens;
}

export interface TokenBudgetSnapshot {
  estimatedConversationTokens: number;
  contextWindow: number;
  effectiveContextWindow: number;
  autoCompactThreshold: number;
  manualCompactThreshold: number;
}

function scaleBuffer(buffer: number, effectiveWindow: number): number {
  const referenceWindow = 180_000;
  // Scale in both directions. Fixed 13K/20K buffers become dangerously small
  // on 1M-token models, leaving too little room for estimation error, tool
  // schemas, and the compaction request itself.
  return Math.max(1, Math.round(buffer * (effectiveWindow / referenceWindow)));
}

export function buildTokenBudgetSnapshot(
  messages: readonly MessageParam[],
  options?: {
    usage?: Usage;
    usageAnchorIndex?: number;
    usageSystemPromptTokens?: number;
    usageToolDefinitionTokens?: number;
    systemPrompt?: string;
    toolDefinitions?: readonly unknown[];
    model?: string;
    contextWindow?: number;
  },
): TokenBudgetSnapshot {
  const estimatedConversationTokens = tokenCountWithEstimation(messages, options);
  const model = options?.model ?? process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-20250514";
  const contextWindow = getContextWindowForModel(model, options?.contextWindow);
  const effectiveContextWindow = getEffectiveContextWindowSize(model, options?.contextWindow);
  return {
    estimatedConversationTokens,
    contextWindow,
    effectiveContextWindow,
    autoCompactThreshold: Math.max(0, effectiveContextWindow - scaleBuffer(AUTOCOMPACT_BUFFER_TOKENS, effectiveContextWindow)),
    manualCompactThreshold: Math.max(0, effectiveContextWindow - scaleBuffer(MANUAL_COMPACT_BUFFER_TOKENS, effectiveContextWindow)),
  };
}
