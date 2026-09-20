import { createMessage } from "../services/api/streaming.js";
import { debugLog } from "../utils/log.js";
import {
  buildTokenBudgetSnapshot,
  estimateMessageTokens,
} from "../utils/tokens.js";
import type { MessageParam, ContentBlockParam } from "@anthropic-ai/sdk/resources/messages.js";
import type { Usage } from "../types/message.js";

export const OLD_TOOL_RESULT_PLACEHOLDER = "[Old tool result content cleared]";
const MICROCOMPACT_MIN_MESSAGES = 10;
const MICROCOMPACT_KEEP_RECENT_MESSAGES = 8;
const COMPACTABLE_TOOLS = new Set(["Read", "Grep", "Glob", "Bash", "Edit", "Write"]);

const NO_TOOLS_PREAMBLE = `CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.

- Do NOT use Read, Bash, Grep, Glob, Edit, Write, or ANY other tool.
- You already have all the context you need in the conversation above.
- Tool calls will be REJECTED and will waste your only turn — you will fail the task.
- Return only the durable continuation summary. Do not include hidden analysis,
  preambles, or an <analysis> section.
`;

const BASE_COMPACT_PROMPT = `Your task is to create a detailed summary of the conversation so far, paying close attention to the user's explicit requests and your previous actions.
This summary should be thorough in capturing technical details, code patterns, and architectural decisions that would be essential for continuing development work without losing context.

Your summary should include the following sections:

1. Primary Request and Intent: Capture all of the user's explicit requests and intents in detail
2. Key Technical Concepts: List all important technical concepts, technologies, and frameworks discussed.
3. Files and Code Sections: Enumerate specific files and important symbols examined, modified, or created. Include only short code excerpts essential for continuation.
4. Errors and fixes: List all errors that you ran into, and how you fixed them. Pay special attention to specific user feedback that you received, especially if the user told you to do something differently.
5. Problem Solving: Document problems solved and any ongoing troubleshooting efforts.
6. All user messages: List ALL user messages that are not tool results. These are critical for understanding the users' feedback and changing intent.
7. Pending Tasks: Outline any pending tasks that you have explicitly been asked to work on.
8. Current Work: Describe in detail precisely what was being worked on immediately before this summary request, paying special attention to the most recent messages from both user and assistant. Include file names and code snippets where applicable.
9. Optional Next Step: List the next step that you will take that is related to the most recent work you were doing.

Keep the summary concise but complete. Prefer exact paths, decisions, test
results, and pending work over narration. Target 2,000-4,000 tokens and never
exceed 6,000 tokens.`;

export interface CompactBoundaryMetadata {
  compactType: "auto" | "manual" | "micro";
  reason?: string;
  originalMessageCount: number;
  compactedToolIds?: string[];
}

export interface CompactBoundaryMessage {
  role: "assistant";
  content: string;
}

export interface CompactionResult {
  messages: MessageParam[];
  summary?: string;
  didCompact: boolean;
  didMicroCompact: boolean;
}

export interface CompactionCheckOptions {
  usage?: Usage;
  usageAnchorIndex?: number;
  systemPrompt?: string;
  force?: boolean;
  /** Clear old tool payloads without making a summarization API call. */
  microOnly?: boolean;
  /** Model handle used for the summarization call. Falls back to the default model when omitted. */
  model?: string;
  /** Resolved provider context window for named model profiles. */
  contextWindow?: number;
}

function isContentBlocks(content: unknown): content is ContentBlockParam[] {
  return Array.isArray(content);
}

function collectToolIdsFromMessage(message: MessageParam): string[] {
  if (!isContentBlocks(message.content)) return [];
  return message.content
    .filter((block): block is Extract<ContentBlockParam, { type: "tool_use" }> => block.type === "tool_use")
    .map((block) => block.id);
}

function collectToolResultIdsFromMessage(message: MessageParam): string[] {
  if (!isContentBlocks(message.content)) return [];
  return message.content
    .filter((block): block is Extract<ContentBlockParam, { type: "tool_result" }> => block.type === "tool_result")
    .map((block) => block.tool_use_id);
}

function microCompactToolResultContent(content: unknown): string | null {
  if (Array.isArray(content)) {
    const hasOnlyBinary = content.every(
      (b: any) => b.type === "image" || b.type === "document",
    );
    if (hasOnlyBinary) return "[image]";
  }
  return null;
}

function microCompactMessage(message: MessageParam): { message: MessageParam; compactedToolIds: string[] } {
  if (!isContentBlocks(message.content)) {
    return { message, compactedToolIds: [] };
  }

  const compactedToolIds: string[] = [];
  const nextContent = message.content.map((block) => {
    // Historical images (e.g. a screenshot the user pasted, or an old Read
    // of an image) are heavy. Outside the recent-message window we collapse
    // them to a `[image]` text marker so the conversation stays coherent
    // without re-sending the bytes every turn.
    if (block.type === "image") {
      return { type: "text" as const, text: "[image]" };
    }

    if (block.type !== "tool_result") {
      return block;
    }

    const binaryReplacement = microCompactToolResultContent(block.content);
    if (binaryReplacement) {
      compactedToolIds.push(block.tool_use_id);
      return { ...block, content: binaryReplacement };
    }

    if (typeof block.content !== "string") {
      return block;
    }

    const toolName = block.content.match(/^([A-Za-z0-9_-]+):/)?.[1] ?? null;
    if (!toolName || !COMPACTABLE_TOOLS.has(toolName)) {
      return block;
    }

    compactedToolIds.push(block.tool_use_id);
    return { ...block, content: OLD_TOOL_RESULT_PLACEHOLDER };
  });

  return {
    message: { ...message, content: nextContent },
    compactedToolIds,
  };
}

export function microCompactMessages(messages: MessageParam[]): { messages: MessageParam[]; compactedToolIds: string[] } {
  if (messages.length < MICROCOMPACT_MIN_MESSAGES) {
    return { messages, compactedToolIds: [] };
  }

  const compactedToolIds: string[] = [];
  const nextMessages = messages.map((message, index) => {
    if (index >= messages.length - MICROCOMPACT_KEEP_RECENT_MESSAGES) {
      return message;
    }

    const result = microCompactMessage(message);
    compactedToolIds.push(...result.compactedToolIds);
    return result.message;
  });

  return { messages: nextMessages, compactedToolIds };
}

function makeCompactBoundary(metadata: CompactBoundaryMetadata): CompactBoundaryMessage {
  return {
    role: "assistant",
    content: [
      "[CompactBoundary]",
      `type=${metadata.compactType}`,
      `messages=${metadata.originalMessageCount}`,
      metadata.reason ? `reason=${metadata.reason}` : "",
      metadata.compactedToolIds?.length ? `compacted_tool_ids=${metadata.compactedToolIds.join(",")}` : "",
    ].filter(Boolean).join(" "),
  };
}

export function getMessagesAfterCompactBoundary(messages: MessageParam[]): MessageParam[] {
  const boundaryIndex = [...messages].reverse().findIndex((message) =>
    typeof message.content === "string" && message.content.startsWith("[CompactBoundary]"),
  );

  if (boundaryIndex === -1) return messages;
  const absoluteIndex = messages.length - boundaryIndex - 1;
  return messages.slice(absoluteIndex + 1);
}

function findPreservedTailStart(messages: MessageParam[], desiredCount: number): number {
  let start = Math.max(0, messages.length - desiredCount);

  while (start > 0) {
    const tail = messages.slice(start);
    const toolUses = new Set(tail.flatMap(collectToolIdsFromMessage));
    const toolResults = new Set(tail.flatMap(collectToolResultIdsFromMessage));
    const hasDanglingResult = [...toolResults].some((toolUseId) => !toolUses.has(toolUseId));
    if (!hasDanglingResult) {
      return start;
    }
    start -= 1;
  }

  return 0;
}

/**
 * Preserve recent messages only while they fit a bounded token budget.
 * Previously, a very large Read/Bash result could survive solely because it
 * was among the last eight messages and immediately refill compacted context.
 */
export function selectCompactionTail(
  messages: MessageParam[],
  desiredCount: number,
  maxTailTokens: number,
): MessageParam[] {
  for (let count = Math.min(desiredCount, messages.length); count > 0; count--) {
    const start = findPreservedTailStart(messages, count);
    const tail = messages.slice(start);
    const tokens = tail.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
    if (tokens <= maxTailTokens) return tail;
  }
  return [];
}

async function summarizeMessages(messages: MessageParam[], focus?: string, model?: string): Promise<string> {
  const extraInstruction = focus ? `\n\n## Compact Instructions\n${focus}` : "";
  debugLog("compact", "summary_request", { messageCount: messages.length, focus: focus ?? null, model: model ?? null });

  const response = await createMessage({
    model: model ?? process.env.ANTHROPIC_MODEL,
    maxTokens: 6000,
    system: NO_TOOLS_PREAMBLE + BASE_COMPACT_PROMPT + extraInstruction,
    messages: [
      {
        role: "user",
        content: `Conversation to summarize:\n${JSON.stringify(messages, null, 2)}`,
      },
    ],
  });

  const text = response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();

  if (!text) {
    throw new Error("Compaction model returned an empty summary.");
  }

  debugLog("compact", "summary_response", {
    stopReason: response.stopReason,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    summaryLength: text.length,
  });

  return text;
}

export async function compactMessages(
  messages: MessageParam[],
  focus?: string,
  options: CompactionCheckOptions = {},
): Promise<CompactionResult> {
  const microcompactResult = microCompactMessages(messages);
  const microCompacted = microcompactResult.messages;
  const microChanged = JSON.stringify(microCompacted) !== JSON.stringify(messages);

  const budget = buildTokenBudgetSnapshot(microCompacted, {
    usage: options.usage,
    usageAnchorIndex: options.usageAnchorIndex,
    systemPrompt: options.systemPrompt,
    model: options.model,
    contextWindow: options.contextWindow,
  });

  debugLog("compact", "budget_check", {
    originalMessageCount: messages.length,
    microMessageCount: microCompacted.length,
    didMicroCompact: microChanged,
    compactedToolIds: microcompactResult.compactedToolIds,
    usageAnchorIndex: options.usageAnchorIndex ?? null,
    estimatedConversationTokens: budget.estimatedConversationTokens,
    autoCompactThreshold: budget.autoCompactThreshold,
    manualCompactThreshold: budget.manualCompactThreshold,
  });

  if (
    options.microOnly ||
    (!options.force && budget.estimatedConversationTokens < budget.autoCompactThreshold)
  ) {
    debugLog("compact", "skip_full_compact", {
      reason: options.microOnly ? "micro_only" : "below_auto_threshold",
      estimatedConversationTokens: budget.estimatedConversationTokens,
      autoCompactThreshold: budget.autoCompactThreshold,
    });

    return {
      messages: microChanged
        ? [
            ...microCompacted,
            makeCompactBoundary({
              compactType: "micro",
              originalMessageCount: messages.length,
              compactedToolIds: microcompactResult.compactedToolIds,
            }),
          ]
        : microCompacted,
      didCompact: false,
      didMicroCompact: microChanged,
    };
  }

  const summary = await summarizeMessages(microCompacted, focus, options.model);
  const desiredTailCount = 8;
  const maxTailTokens = Math.max(
    2_000,
    Math.min(20_000, Math.floor(budget.effectiveContextWindow * 0.1)),
  );
  const tail = microCompacted.length <= desiredTailCount
    ? [] // short conversation: the summary covers everything
    : selectCompactionTail(microCompacted, desiredTailCount, maxTailTokens);
  const compacted: MessageParam[] = [
    {
      role: "user",
      content: `This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\n${summary}${tail.length > 0 ? "\n\nRecent messages are preserved verbatim." : ""}`,
    },
    makeCompactBoundary({
      compactType: focus ? "manual" : "auto",
      reason: focus,
      originalMessageCount: microCompacted.length,
      compactedToolIds: microcompactResult.compactedToolIds,
    }),
    ...tail,
  ];

  debugLog("compact", "full_compact_applied", {
    focus: focus ?? null,
    preservedTailCount: tail.length,
    preservedTailTokens: tail.reduce((sum, message) => sum + estimateMessageTokens(message), 0),
    originalMessageCount: messages.length,
    compactedMessageCount: compacted.length,
  });

  return {
    messages: compacted,
    summary,
    didCompact: true,
    didMicroCompact: microChanged,
  };
}
