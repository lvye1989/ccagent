/**
 * Tool Registry — Central registry for all available tools.
 *
 * Stage 16: MCP tools are registered at startup via `registerMcpTools()`.
 * Built-in tools live in BUILTIN_TOOLS (compile-time list); MCP tools are
 * collected separately so they can be reset/refreshed independently when
 * the user runs `/mcp reconnect`.
 */

import type Anthropic from "@anthropic-ai/sdk";
import type { Tool, ToolDecisionPolicy } from "./Tool.js";
import { toolToApiParam } from "./Tool.js";
import { resolveToolDecisionPolicy } from "./decisionPolicy.js";
import { bashTool } from "./bashTool.js";
import { fileEditTool } from "./fileEditTool.js";
import { multiEditTool } from "./multiEditTool.js";
import { fileReadTool } from "./fileReadTool.js";
import { fileWriteTool } from "./fileWriteTool.js";
import { globTool } from "./globTool.js";
import { grepTool } from "./grepTool.js";
import { webFetchTool } from "./webFetchTool.js";
import { webSearchTool } from "./webSearchTool.js";
import { classicWordsTool } from "./classicWordsTool.js";
import { listMcpResourcesTool } from "./listMcpResourcesTool.js";
import { readMcpResourceTool } from "./readMcpResourceTool.js";
import { powerShellTool } from "./powerShellTool.js";
import { browserSearchTool } from "./browserSearchTool.js";
import {
  computerActionGroupTool,
  computerActionTool,
  computerNavigateTool,
  computerObserveTool,
} from "./computerUseTools.js";
import {
  markdownToPdfTool,
  pdfToMarkdownTool,
  pdfToWordTool,
  wordToPdfTool,
} from "./documentConversionTools.js";
import { memoryWriteTool } from "./memoryWriteTool.js";
import { enterPlanModeTool } from "./enterPlanModeTool.js";
import { exitPlanModeTool } from "./exitPlanModeTool.js";
import { todoWriteTool } from "./todoWriteTool.js";
import { taskCreateTool } from "./taskCreateTool.js";
import { taskUpdateTool } from "./taskUpdateTool.js";
import { taskGetTool } from "./taskGetTool.js";
import { taskListTool } from "./taskListTool.js";
import { skillTool } from "./skillTool.js";
import { askUserQuestionTool } from "./askUserQuestionTool.js";
import { agentTool } from "./agentTool.js";
import { teamCreateTool } from "./teamCreateTool.js";
import { teamDeleteTool } from "./teamDeleteTool.js";
import { sendMessageTool } from "./sendMessageTool.js";
import { workfriendScheduleTool } from "./workfriendScheduleTool.js";
import { workfriendAssessTool } from "./workfriendAssessTool.js";
import { workfriendDeliverTool } from "./workfriendDeliverTool.js";
import { agentTeamModeTool } from "./agentTeamModeTool.js";
import { rhinoActionTool, rhinoObserveTool, rhinoInspectTool } from "./rhinoTools.js";
import { rhinoSequenceTool } from "./rhinoSequence.js";
import type { PermissionMode } from "../permissions/permissions.js";

const BUILTIN_TOOLS: Tool[] = [
  fileReadTool,
  fileWriteTool,
  fileEditTool,
  multiEditTool,
  globTool,
  grepTool,
  bashTool,
  powerShellTool,
  browserSearchTool,
  computerObserveTool,
  computerActionGroupTool,
  computerActionTool,
  computerNavigateTool,
  rhinoObserveTool,
  rhinoInspectTool,
  rhinoActionTool,
  rhinoSequenceTool,
  markdownToPdfTool,
  wordToPdfTool,
  pdfToWordTool,
  pdfToMarkdownTool,
  webFetchTool,
  webSearchTool,
  classicWordsTool,
  listMcpResourcesTool,
  readMcpResourceTool,
  memoryWriteTool,
  todoWriteTool,
  taskCreateTool,
  taskUpdateTool,
  taskGetTool,
  taskListTool,
  enterPlanModeTool,
  exitPlanModeTool,
  skillTool,
  askUserQuestionTool,
  workfriendAssessTool,
  workfriendScheduleTool,
  workfriendDeliverTool,
  agentTeamModeTool,
  agentTool,
  // Stage 21 — Agent Teams. The three tools below all gate themselves
  // on isAgentTeamsEnabled() in their `isEnabled()` methods, so when
  // the feature flag is off they're filtered out by `getAllTools()`
  // before the model sees the schema. No prompt-side branching needed.
  teamCreateTool,
  teamDeleteTool,
  sendMessageTool,
];

let mcpTools: Tool[] = [];
let toolRegistryRevision = 1;
let lastEnabledManifestFingerprint: string | undefined;

export interface EnabledToolManifestEntry {
  name: string;
  description: string;
  inputSchema: Tool["inputSchema"];
  decisionPolicy: ToolDecisionPolicy;
}

export interface EnabledToolManifest {
  revision: number;
  tools: EnabledToolManifestEntry[];
}

function markToolRegistryChanged(): void {
  toolRegistryRevision++;
  lastEnabledManifestFingerprint = undefined;
}

/**
 * Replace the registry of MCP-provided tools. Called once at startup after
 * connecting to all MCP servers, and again after `/mcp reconnect`.
 */
export function registerMcpTools(tools: Tool[]): void {
  mcpTools = [...tools];
  markToolRegistryChanged();
}

/** Drop the MCP-provided tools — used before re-registering after reconnect. */
export function clearMcpTools(): void {
  mcpTools = [];
  markToolRegistryChanged();
}

export function getAllTools(): Tool[] {
  return [...BUILTIN_TOOLS, ...mcpTools].filter((tool) => tool.isEnabled());
}

export function findToolByName(name: string): Tool | undefined {
  return [...BUILTIN_TOOLS, ...mcpTools].find((tool) => tool.name === name);
}

/**
 * Resolve a tool for dispatch only when it is enabled at execution time.
 * Callers must use this instead of trusting an earlier model-visible list,
 * because MCP/agent controls may close a tool while a model turn is running.
 */
export function findEnabledToolByName(name: string): Tool | undefined {
  const tool = findToolByName(name);
  return tool?.isEnabled() ? tool : undefined;
}

/**
 * Return the current in-process tool catalogue. This is registry metadata,
 * not a model-callable ToolsList tool, so reading it adds no LLM/network turn.
 */
export function getEnabledToolManifest(): EnabledToolManifest {
  const tools = getAllTools().map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    decisionPolicy: resolveToolDecisionPolicy(tool),
  }));
  const fingerprint = JSON.stringify(tools);
  if (
    lastEnabledManifestFingerprint !== undefined &&
    lastEnabledManifestFingerprint !== fingerprint
  ) {
    toolRegistryRevision++;
  }
  lastEnabledManifestFingerprint = fingerprint;
  return { revision: toolRegistryRevision, tools };
}

export function getToolRegistryRevision(): number {
  // Refresh first so dynamic built-in isEnabled() changes are reflected even
  // when no MCP registration event occurred.
  return getEnabledToolManifest().revision;
}

/**
 * Get tool API params with mode-aware Enter/Exit visibility.
 *
 * The model always sees all tools (Write, Edit, Bash, etc.) regardless
 * of mode. Enforcement happens in checkPermission at execution time.
 * Only the plan mode transition tools are toggled:
 * - In plan mode: hide EnterPlanMode, show ExitPlanMode
 * - Outside plan mode: show EnterPlanMode, hide ExitPlanMode
 *
 * MCP tools are always included; their visibility-in-plan is handled by
 * `checkPermission()` reading `tool.isReadOnly()` (which maps to MCP's
 * `annotations.readOnlyHint`).
 */
export function getToolsApiParams(mode?: PermissionMode): Anthropic.Tool[] {
  const tools = getAllTools();
  if (mode === "plan") {
    return tools.filter((t) => t.name !== "EnterPlanMode").map(toolToApiParam);
  }
  return tools.filter((t) => t.name !== "ExitPlanMode").map(toolToApiParam);
}
