import type { MessageParam } from "@anthropic-ai/sdk/resources/messages.js";
import { compactMessages, type CompactionResult } from "./compaction.js";
import {
  tokenCountWithEstimation,
  getContextWindowForModel,
  getEffectiveContextWindowSize,
  AUTOCOMPACT_BUFFER_TOKENS,
  WARNING_THRESHOLD_BUFFER_TOKENS,
  MANUAL_COMPACT_BUFFER_TOKENS,
} from "../utils/tokens.js";
import { debugLog } from "../utils/log.js";
import type { Usage } from "../types/message.js";

export const MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3;

export type TokenWarningState = "normal" | "warning" | "error" | "blocking";

export interface TokenWarningResult {
  state: TokenWarningState;
  estimatedTokens: number;
  threshold: number;
  blockingLimit: number;
  contextWindow: number;
}

export interface AutoCompactState {
  consecutiveFailures: number;
}

/** A Web worker hosts multiple engines; one session must not disable another's recovery. */
export function createAutoCompactState(): AutoCompactState {
  return { consecutiveFailures: 0 };
}

// Retain the public helper's legacy default for callers outside QueryEngine.
const defaultAutoCompactState = createAutoCompactState();

export function resetAutoCompactFailures(state = defaultAutoCompactState): void {
  state.consecutiveFailures = 0;
}

function scaleBuffer(buffer: number, effectiveWindow: number): number {
  // Scale for both small and large windows so a 1M-token model does not wait
  // until the final ~1% before attempting compaction.
  const referenceWindow = 180_000; // effectiveContextWindow at 200K
  return Math.max(1, Math.round(buffer * (effectiveWindow / referenceWindow)));
}

export function getAutoCompactThreshold(model: string, contextWindow?: number): number {
  const effective = getEffectiveContextWindowSize(model, contextWindow);
  return Math.max(0, effective - scaleBuffer(AUTOCOMPACT_BUFFER_TOKENS, effective));
}

export function getBlockingLimit(model: string, contextWindow?: number): number {
  const effective = getEffectiveContextWindowSize(model, contextWindow);
  return Math.max(0, effective - scaleBuffer(MANUAL_COMPACT_BUFFER_TOKENS, effective));
}

export function calculateTokenWarningState(
  estimatedTokens: number,
  model: string,
  configuredContextWindow?: number,
): TokenWarningResult {
  const contextWindow = getContextWindowForModel(model, configuredContextWindow);
  const effective = getEffectiveContextWindowSize(model, configuredContextWindow);
  const blockingLimit = getBlockingLimit(model, configuredContextWindow);
  const autoCompactThreshold = getAutoCompactThreshold(model, configuredContextWindow);
  const warningThreshold = Math.max(0, effective - scaleBuffer(WARNING_THRESHOLD_BUFFER_TOKENS, effective));

  let state: TokenWarningState = "normal";
  if (estimatedTokens >= blockingLimit) {
    state = "blocking";
  } else if (estimatedTokens >= autoCompactThreshold) {
    state = "error";
  } else if (estimatedTokens >= warningThreshold) {
    state = "warning";
  }

  return {
    state,
    estimatedTokens,
    threshold: autoCompactThreshold,
    blockingLimit,
    contextWindow,
  };
}

export function isAtBlockingLimit(estimatedTokens: number, model: string, contextWindow?: number): boolean {
  return estimatedTokens >= getBlockingLimit(model, contextWindow);
}

export function shouldAutoCompact(
  estimatedTokens: number,
  model: string,
  querySource?: string,
  contextWindow?: number,
  state: AutoCompactState = defaultAutoCompactState,
): boolean {
  if (querySource === "compact" || querySource === "session_memory") {
    return false;
  }
  if (state.consecutiveFailures >= MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES) {
    debugLog("autoCompact", "circuit_breaker", {
      consecutiveFailures: state.consecutiveFailures,
    });
    return false;
  }
  return estimatedTokens >= getAutoCompactThreshold(model, contextWindow);
}

export async function autoCompactIfNeeded(
  messages: MessageParam[],
  model: string,
  options: {
    usage?: Usage;
    usageAnchorIndex?: number;
    usageSystemPromptTokens?: number;
    systemPrompt?: string;
    querySource?: string;
    contextWindow?: number;
    signal?: AbortSignal;
    state?: AutoCompactState;
    toolDefinitions?: readonly unknown[];
    usageToolDefinitionTokens?: number;
  },
): Promise<{ result: CompactionResult; didAutoCompact: boolean; didAttemptAutoCompact: boolean }> {
  options.signal?.throwIfAborted();
  const state = options.state ?? defaultAutoCompactState;
  const estimatedTokens = tokenCountWithEstimation(messages, options);

  if (!shouldAutoCompact(estimatedTokens, model, options.querySource, options.contextWindow, state)) {
    return {
      result: { messages, didCompact: false, didMicroCompact: false },
      didAutoCompact: false,
      didAttemptAutoCompact: false,
    };
  }

  debugLog("autoCompact", "triggering", {
    estimatedTokens,
    threshold: getAutoCompactThreshold(model, options.contextWindow),
    consecutiveFailures: state.consecutiveFailures,
  });

  try {
    const result = await compactMessages(messages, undefined, {
      usage: options.usage,
      usageAnchorIndex: options.usageAnchorIndex,
      usageSystemPromptTokens: options.usageSystemPromptTokens,
      usageToolDefinitionTokens: options.usageToolDefinitionTokens,
      systemPrompt: options.systemPrompt,
      toolDefinitions: options.toolDefinitions,
      model,
      contextWindow: options.contextWindow,
      force: true,
      signal: options.signal,
    });
    state.consecutiveFailures = 0;
    return { result, didAutoCompact: result.didCompact, didAttemptAutoCompact: true };
  } catch (error) {
    // Cancellation is a user action, not a supplier failure or a circuit-breaker strike.
    if (options.signal?.aborted) throw error;
    state.consecutiveFailures++;
    debugLog("autoCompact", "failure", {
      error: error instanceof Error ? error.message : String(error),
      consecutiveFailures: state.consecutiveFailures,
    });
    return {
      result: { messages, didCompact: false, didMicroCompact: false },
      didAutoCompact: false,
      didAttemptAutoCompact: true,
    };
  }
}
