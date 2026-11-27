import { createHash, randomUUID } from "node:crypto";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages.js";
import type { ToolResult } from "../tools/Tool.js";
import type { Usage } from "../types/message.js";
import type { PlatformCallReceipt } from "../platform/gatewayClient.js";

/** Runtime identities are supplied by the harness, never by model arguments. */
export interface ExecutionScope {
  turnId: string;
  requestId?: string;
  step: number;
  agentSessionId?: string;
}

export interface ExecutionEvent extends ExecutionScope {
  id: string;
  timestamp: string;
  phase: "turn_preparing" | "turn_start" | "turn_end" | "request_start" | "request_end" | "tool_call" | "tool_approval" | "tool_start" | "tool_result" | "tool_settled" | "billing_receipt";
  toolUseId?: string;
  toolName?: string;
  model?: string;
  status?: string;
  decision?: string;
  durationMs?: number;
  inputHash?: string;
  contextHash?: string;
  systemHash?: string;
  toolsHash?: string;
  messageCount?: number;
  usage?: Usage;
  result?: ToolResult;
  billingStatus?: PlatformCallReceipt["status"];
  platformReceipt?: PlatformCallReceipt;
  reviewedExecutionKeys?: string[];
  timings?: import("../core/turnTimings.js").TurnTimings;
}

export interface UnresolvedToolExecution {
  key: string;
  toolName: string;
  inputHash: string;
  toolUseId: string;
}

export function executionKey(event: ExecutionScope & { toolUseId?: string }): string {
  return [event.agentSessionId, event.turnId, event.requestId, event.toolUseId].join("/");
}

export function foldUnresolvedExecutions(pending: UnresolvedToolExecution[], event: ExecutionEvent): UnresolvedToolExecution[] {
  if (event.reviewedExecutionKeys?.length && event.decision === "allow_once") {
    return pending.filter(item => !event.reviewedExecutionKeys!.includes(item.key));
  }
  const key = executionKey(event);
  if (event.phase === "tool_start" && event.toolName && event.toolUseId && event.inputHash) {
    return [...pending.filter(item => item.key !== key), { key, toolName: event.toolName, toolUseId: event.toolUseId, inputHash: event.inputHash }];
  }
  if ((event.phase === "tool_result" || event.phase === "tool_settled") && event.status !== "unknown" && event.result?.executionOutcome !== "unknown") {
    return pending.filter(item => item.key !== key);
  }
  return pending;
}

export type ExecutionRecorder = (event: ExecutionEvent) => Promise<void>;

/** Temporary chats retain the same in-process replay protection without disk writes. */
export function createMemoryExecutionJournal(): {
  recordExecutionEvent: ExecutionRecorder;
  findUnresolvedExecutions: (toolName: string, inputHash: string) => Promise<UnresolvedToolExecution[]>;
} {
  let pending: UnresolvedToolExecution[] = [];
  return {
    recordExecutionEvent: async event => { pending = foldUnresolvedExecutions(pending, event); },
    findUnresolvedExecutions: async (toolName, inputHash) => pending.filter(item => item.toolName === toolName && item.inputHash === inputHash),
  };
}

export function executionHash(value: unknown): string {
  const hash = createHash("sha256");
  // Hash canonical JSON incrementally; do not clone a long history or create
  // another whole-history JSON string just to fingerprint its request.
  const visit = (item: any): void => {
    if (item && typeof item.toJSON === "function") item = item.toJSON();
    if (Array.isArray(item)) {
      hash.update("[");
      for (let index = 0; index < item.length; index++) { if (index) hash.update(","); visit(item[index]); }
      hash.update("]");
    } else if (item && typeof item === "object") {
      hash.update("{"); let first = true;
      for (const key of Object.keys(item).sort()) {
        if (["undefined", "function", "symbol"].includes(typeof item[key])) continue;
        if (!first) hash.update(","); first = false;
        hash.update(JSON.stringify(key)); hash.update(":"); visit(item[key]);
      }
      hash.update("}");
    } else hash.update(JSON.stringify(item) ?? "null");
  };
  visit(value); return hash.digest("hex");
}

export async function recordExecution(
  context: { executionScope?: ExecutionScope; recordExecutionEvent?: ExecutionRecorder },
  event: Omit<ExecutionEvent, keyof ExecutionScope | "id" | "timestamp">,
): Promise<void> {
  if (!context.recordExecutionEvent || !context.executionScope) return;
  await context.recordExecutionEvent({ ...context.executionScope, ...event, id: randomUUID(), timestamp: new Date().toISOString() });
}

/** Repair protocol pairing only. Recovery never dispatches or replays a tool. */
export function recoverToolResults(messages: MessageParam[], events: ExecutionEvent[], sessionId: string, scopes: Array<ExecutionScope | undefined> = []): {
  messages: MessageParam[]; unknownToolIds: string[];
} {
  const results = new Map<string, ExecutionEvent>();
  for (const event of events) {
    if (event.agentSessionId === sessionId && event.toolUseId && event.result
      && (event.phase === "tool_result" || event.phase === "tool_settled")) {
      // A later hook failure cannot erase the already durable native receipt.
      const key = executionKey(event);
      if (event.status !== "unknown" || !results.has(key)) results.set(key, event);
    }
  }
  const unknownToolIds: string[] = [];
  const repaired: MessageParam[] = [];
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!;
    repaired.push(message);
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    const calls = message.content.filter(block => block.type === "tool_use");
    if (!calls.length) continue;
    const following = messages[index + 1];
    const content = following?.role === "user" && Array.isArray(following.content) ? following.content : [];
    const existing = new Set(content.filter(block => block.type === "tool_result").map(block => block.tool_use_id));
    const missing = calls.filter(call => !existing.has(call.id));
    if (!missing.length) continue;
    const recovered = missing.map(call => {
      const scope = scopes[index];
      const candidates = scope ? [] : [...results.values()].filter(event => event.toolUseId === call.id);
      // Legacy entries without request identities are safe only when the ID
      // has exactly one matching request. Never use another turn's receipt.
      const event = scope ? results.get(executionKey({ ...scope, toolUseId: call.id })) : candidates.length === 1 ? candidates[0] : undefined;
      const known = event?.result && event.status !== "unknown" && event.result.executionOutcome !== "unknown";
      if (!known) unknownToolIds.push(call.id);
      const note = `Execution outcome unknown after interruption for ${call.name} (${call.id}). This call was NOT replayed. It may have produced external side effects. Inspect the target state or receipt before taking any further action; do not repeat the operation automatically.`;
      const previous = event?.result?.content;
      const unknownContent = Array.isArray(previous) ? [...previous, { type: "text" as const, text: note }]
        : previous ? `${previous}\n\n${note}` : note;
      return {
        type: "tool_result" as const, tool_use_id: call.id,
        content: known ? event.result!.content as any : unknownContent as any,
        ...(!known || event.result!.isError ? { is_error: true } : {}),
      };
    });
    if (content.some(block => block.type === "tool_result")) {
      repaired.push({ ...following!, content: [...content, ...recovered] });
      index++;
    } else repaired.push({ role: "user", content: recovered });
  }
  return { messages: repaired, unknownToolIds };
}
