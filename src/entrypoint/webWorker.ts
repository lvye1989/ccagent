import { WEB_ASSET_MIME as MIME } from "./webAssets.js";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { lstat, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { QueryEngine } from "../core/queryEngine.js";
import type { QueryEngineEvent } from "../core/queryEngine.js";
import { classifyUserInput } from "../ui/hooks/useAgentSession/inputClassification.js";
import {
  appendTranscriptEntry,
  appendCompactionSnapshot,
  applySessionRetentionPolicy,
  createSessionId,
  initSessionStorage,
  listProjectSessions,
  listPinnedSessionIds,
  setSessionPinned,
  deleteStoredSession,
  restoreSession,
  type FileHistorySnapshotRecord,
  type TranscriptEntry,
} from "../session/storage.js";
import { configureFileHistory, restoreFileHistorySnapshots } from "../session/fileHistory.js";
import { loadPermissionSettings, type PermissionDecision, type PermissionMode, type PermissionRequest } from "../permissions/permissions.js";
import type { UserQuestionRequest, UserQuestionResponse } from "../tools/Tool.js";
import { DEFAULT_MODEL } from "../services/api/client.js";
import { loadProfiles } from "../services/api/providers/profile.js";
import { prepareBrowserSearchInput } from "../tools/browserSearchTool.js";
import { readMergedStringSetting, readTrustedStringArraySetting } from "../utils/settings.js";
import { loadEnv } from "../utils/loadEnv.js";
import { syncWebSecrets } from "../utils/webSecrets.js";
import { resolveApiKeyFromHelper } from "../services/api/apiKeyHelper.js";
import { cleanupOldFileHistoryBackups } from "../session/fileHistory.js";
import { refreshHookDisableFromSettings } from "../hooks/settings.js";
import { loadSettingSources, getScalarSetting } from "../config/sources.js";
import { configureThinkingDefaults, resetSessionThinkingState } from "../utils/thinking.js";
import { resolveSafePath, setAdditionalAllowedRoots } from "../tools/pathUtils.js";
import { bootstrapAgentTeams } from "../utils/agentTeamsEnabled.js";
import { bootstrapAgentSkills } from "../utils/agentSkillsEnabled.js";
import { bootstrapAgentStates } from "../agents/preferences.js";
import { bootstrapSkills } from "../services/skills/bootstrap.js";
import { bootstrapAgents } from "../agents/bootstrap.js";
import { bootstrapOutputStyles } from "../styles/bootstrap.js";
import { bootstrapUserCommands } from "../commands/userCommands/bootstrap.js";
import { refreshActivePlugins } from "../plugins/runtime.js";
import { buildPluginView } from "../core/queryEngine/commands/pluginView.js";
import {
  addMarketplace, inspectPlugin, installPlugin, listMarketplaces,
  readInstalledPlugins, removeMarketplace, setPluginEnabled,
  uninstallPlugin, updateMarketplace, updatePlugin,
  type MarketplaceSource, type PluginScope,
} from "../plugins/index.js";
import { getAllSkills } from "../services/skills/registry.js";
import { isSkillEnabled, setSkillState } from "../services/skills/preferences.js";
import { isAgentSkillsEnabled, setAgentSkillsEnabled } from "../utils/agentSkillsEnabled.js";
import { getProjectSkillsDir, getUserSkillsDir } from "../services/skills/loadSkillsDir.js";
import { normalizeFrontmatter, splitFrontmatter } from "../services/skills/parseFrontmatter.js";
import { getAllAgents } from "../agents/registry.js";
import { isAgentEnabled, setAgentState } from "../agents/preferences.js";
import { bootstrapMcp, startMcpServer, refreshGlobalToolRegistry, requestMcpReconnect, setMcpServerOpen } from "../services/mcp/bootstrap.js";
import { deleteMcpRegistryEntry, getMcpRegistry, getMcpRegistryEntry } from "../services/mcp/registry.js";
import { isMcpServerEnabled, loadMcpPreferences, saveMcpServerState } from "../services/mcp/preferences.js";
import { GoogleWorkspaceOAuthProvider } from "../services/mcp/googleOAuth.js";
import { loadMcpConfigs } from "../services/mcp/config.js";
import { clearServerCache, getActiveMcpConnections } from "../services/mcp/client.js";
import { VERSION } from "../version.js";
import { getCCAgentPath } from "../utils/paths.js";
import { WebModelFiles, type ModelFile } from "./webModelFiles.js";
import { listWorkspaceDocuments, resolveWorkspaceDocument } from "./webLibrary.js";
import { loadMemoryHeaders } from "../context/memory/memdir.js";
import { WebScheduleStore, type WebScheduledTask } from "./webSchedules.js";
import { handleCustomization, readSessionTeam, saveSessionTeam, sessionTeamInstructions } from "./webCustomization.js";
import { getActiveTeam } from "../state/teamContext.js";
import { clearPendingNotifications } from "../state/notificationStore.js";
import { createWebNotificationDispatcher } from "./webNotifications.js";
import { getRunningAsyncAgents } from "../state/asyncAgentStore.js";
import { browseWorkingFolders, listFolderLocations, pickNativeWorkingFolder, resolveWorkingFolder } from "./webWorkspaces.js";
import { browseWorkspaceFiles, previewWorkspaceFile, serveWorkspaceFile, saveWorkspaceAttachment, MAX_UPLOAD } from "./webFiles.js";
import { handleVisualization } from "./webVisualization.js";
import { getAllUserCommands } from "../commands/userCommands/registry.js";
import { isBuiltinCommandName } from "../commands/builtinCommandNames.js";
import { requirePlatformScope, withVerifiedPlatformRequest } from "../platform/account.js";
import { AccountError } from "../platform/accountClient.js";
import { readServiceConfiguration } from "../platform/serviceState.js";
import { changeWebApp, webAppsView } from "./webApps.js";
import { runPhotoshopWebTest } from "./webPhotoshop.js";
import { runComfyuiWebTest } from "./webComfyui.js";
import { runSketchupWebTest } from "./webSketchup.js";
import { handleWhiteboard, WhiteboardError } from "./webWhiteboards.js";
import { serveWhiteboardAsset, WHITEBOARD_EDITOR_CSP } from "./webWhiteboardAssets.js";
import { createWhiteboardAIManager, WhiteboardAIError } from "./webWhiteboardAI.js";
import { createWhiteboardDesignManager, WhiteboardDesignError } from "./webWhiteboardDesign.js";
import { getDesignImageConfig, saveDesignImageConfig, DesignImageError } from "../services/images/designImageProvider.js";
import { bootstrapWorkfriendScheduler, clearWorkfriendTimers } from "../workfriend/scheduler.js";

const execFileAsync = promisify(execFile);
const MAX_BODY_BYTES = 64 * 1024;


type GitChange = { status: string; path: string; displayPath: string; previousPath?: string };

async function listGitChanges(workspace: string): Promise<GitChange[]> {
  const { stdout } = await execFileAsync("git", ["-c", "core.quotePath=false", "status", "--porcelain=v1", "-z", "--untracked-files=all"], {
    cwd: workspace, maxBuffer: 1024 * 1024,
  });
  const records = stdout.split("\0");
  const changes: GitChange[] = [];
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (!record || record.length < 4) continue;
    const status = record.slice(0, 2);
    const file = record.slice(3);
    const renamed = /[RC]/.test(status);
    const previousPath = renamed ? records[++index] : undefined;
    changes.push({
      status, path: file,
      displayPath: previousPath ? `${previousPath} → ${file}` : file,
      ...(previousPath ? { previousPath } : {}),
    });
  }
  return changes;
}

type PendingInteraction = {
  id: string;
  kind: "permission" | "question";
  payload: PermissionRequest | UserQuestionRequest;
  resolve: (value: never) => void;
};

type WebExecution = {
  id: string;
  startedAt: string;
  completedAt: string | null;
  reason: string | null;
  tools: Array<{ id: string; name: string; startedAt: string; completedAt: string | null; phase?: "preparing" | "running"; isError?: boolean; outcome?: "handoff"; detail?: string }>;
};

type WebSession = {
  id: string;
  model: string;
  temporary: boolean;
  scheduled: boolean;
  team: string;
  engine: QueryEngine;
  busy: boolean;
  restoredSnapshots: FileHistorySnapshotRecord[];
  clients: Set<ServerResponse>;
  events: Array<{ id: number; data: Record<string, unknown> }>;
  nextEventId: number;
  persistenceUnavailable: boolean;
  browserUrl?: string;
  lastTurnReason?: string;
  execution?: WebExecution;
  pending?: PendingInteraction;
  modelFiles?: ModelFile[];
};

function isSessionStorageError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code;
  return code === "EPERM" || code === "EACCES" || code === "EISDIR" || code === "ENOTDIR" || code === "EEXIST" || code === "EROFS" || code === "ENOSPC";
}

async function retrySessionWrite(action: () => Promise<unknown>): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try { await action(); return; }
    catch (error) {
      if (!isSessionStorageError(error) || attempt >= 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, 75 * (attempt + 1)));
    }
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<Record<string, unknown>> {
  if (!req.headers["content-type"]?.startsWith("application/json")) throw new Error("Expected application/json");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > maxBytes) throw new Error("Request body is too large");
    chunks.push(bytes);
  }
  // JSON syntax errors can contain submitted credential fragments. Keep parse
  // failures independent of the request bytes returned to the browser.
  let value: unknown;
  try { value = JSON.parse(Buffer.concat(chunks).toString("utf-8") || "{}"); }
  catch { throw new Error("Invalid JSON body"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a JSON object");
  return value as Record<string, unknown>;
}

function publish(session: WebSession, data: Record<string, unknown>): void {
  const timestamp = new Date().toISOString();
  if (data.type === "turn_started") {
    session.lastTurnReason = undefined;
    session.execution = { id: randomUUID(), startedAt: timestamp, completedAt: null, reason: null, tools: [] };
    data = { ...data, startedAt: timestamp };
  }
  const execution = session.execution;
  if (execution && ["tool_preparing", "tool_start", "tool_done"].includes(String(data.type)) && typeof data.id === "string" && typeof data.name === "string") {
    let tool = execution.tools.find(item => item.id === data.id);
    if (!tool) {
      // The timestamp describes when this worker observed the tool call, not CPU execution time.
      tool = { id: data.id, name: data.name, startedAt: timestamp, completedAt: null };
      execution.tools.push(tool);
    }
    tool.phase = data.type === "tool_preparing" ? "preparing" : "running";
    if (data.type === "tool_done") {
      tool.completedAt = timestamp; tool.isError = data.isError === true;
      if (data.outcome === "handoff") tool.outcome = "handoff";
      if (typeof data.detail === "string") tool.detail = data.detail;
    }
  }
  if (data.type === "turn_complete") {
    session.lastTurnReason = String(data.reason || "completed");
    if (execution) {
      execution.completedAt = timestamp; execution.reason = session.lastTurnReason;
    }
    data = { ...data, completedAt: timestamp };
  }
  data = { ...data, timestamp, ...(execution ? { turnId: execution.id } : {}) };
  const event = { id: session.nextEventId++, data };
  session.events.push(event);
  if (session.events.length > 500) session.events.shift();
  const line = `id: ${event.id}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of session.clients) {
    if (!client.destroyed) client.write(line);
    else session.clients.delete(client);
  }
}

function waitForPermission(session: WebSession, request: PermissionRequest): Promise<PermissionDecision> {
  if (session.scheduled && session.clients.size === 0) return Promise.resolve("deny");
  return new Promise((resolve) => {
    const id = randomUUID();
    session.pending = { id, kind: "permission", payload: request, resolve: resolve as (value: never) => void };
    publish(session, { type: "interaction", id, kind: "permission", request });
  });
}

function waitForQuestion(session: WebSession, request: UserQuestionRequest): Promise<UserQuestionResponse | null> {
  if (session.scheduled && session.clients.size === 0) return Promise.resolve(null);
  return new Promise((resolve) => {
    const id = randomUUID();
    session.pending = { id, kind: "question", payload: request, resolve: resolve as (value: never) => void };
    publish(session, { type: "interaction", id, kind: "question", request });
  });
}

export function summarizeEvent(event: QueryEngineEvent): Record<string, unknown> | null {
  switch (event.type) {
    case "text": return { type: "text", text: event.text };
    case "tool_use_start": return { type: "tool_preparing", id: event.id, name: event.name };
    case "tool_use_ready": return { type: "tool_start", id: event.id, name: event.name };
    case "tool_use_done": {
      let detail = "", outcome: "handoff" | undefined;
      if (event.result.isError) {
        detail = typeof event.result.content === "string" ? event.result.content : "工具返回错误，请核对执行记录。";
        if (event.name === "RhinoSequence") {
          try {
            const report = JSON.parse(detail);
            if (report.status === "handoff") {
              outcome = "handoff";
              detail = `批量执行已暂停。已执行 ${Array.isArray(report.executed_steps) ? report.executed_steps.length : 0} 步，请检查原因后继续剩余步骤。\n${typeof report.reason === "string" ? report.reason : ""}`;
            }
          } catch { /* Keep the bounded original error. */ }
        }
      }
      return { type: "tool_done", id: event.id, name: event.name, input: event.input, isError: event.result.isError === true,
        ...(outcome ? { outcome } : {}), ...(detail ? { detail: detail.slice(0, 2500) } : {}) };
    }
    case "assistant_message": return { type: "assistant", message: event.message };
    case "tool_result_message": return { type: "tool_result", message: event.message };
    // The Web client consumes incremental events and restores history with
    // GET /api/sessions/:id. Re-sending the entire history here is unused and
    // repeatedly copies image attachments and large tool results into SSE.
    case "messages_updated": return null;
    case "usage_updated": return { type: "usage", usage: event.totalUsage };
    case "mode_changed": return { type: "mode", mode: event.mode };
    case "command": return { type: "notice", tone: event.kind, message: event.message };
    case "notice": return { type: "notice", tone: event.tone, message: `${event.title}: ${event.body}` };
    case "api_retry": return { type: "notice", tone: "info", message: event.message };
    case "error": return { type: "notice", tone: "error", message: event.error.message };
    case "model_changed": return { type: "model", model: event.model, source: event.source };
    case "stream_restart": return { type: "stream_restart" };
    case "compacted": return { type: "notice", tone: "info", message: "上下文已压缩，将继续执行当前任务。" };
    default: return null;
  }
}

function sessionSnapshot(session: WebSession) {
  const state = session.engine.getState();
  return {
    sessionId: session.id, model: state.model, mode: session.engine.getPermissionMode(), temporary: session.temporary, browserUrl: session.browserUrl ?? null,
    messages: state.messages, usage: state.totalUsage, busy: session.busy, team: session.team,
    modelFiles: session.modelFiles ?? [],
    execution: session.execution ?? null, serverTime: new Date().toISOString(),
    lastEventId: session.nextEventId - 1, lastTurnReason: session.lastTurnReason ?? null,
    recentNotices: session.events.map((item) => item.data).filter((item) => item.type === "notice").slice(-5),
    pending: session.pending ? { id: session.pending.id, kind: session.pending.kind, request: session.pending.payload } : null,
  };
}

function parseArgs(args: string[]): { port: number; workspace: string } {
  let port = 4173;
  let workspace = process.cwd();
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--port") {
      if (!args[i + 1]) throw new Error("--port requires a number");
      port = Number(args[++i]);
    } else if (args[i] === "--workspace") {
      if (!args[i + 1]) throw new Error("--workspace requires a path");
      workspace = path.resolve(args[++i]!);
    } else {
      throw new Error(`Unknown web option: ${args[i]}`);
    }
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("--port must be 1–65535");
  return { port, workspace };
}

async function bootstrap(workspace: string): Promise<string> {
  const tryBootstrap = async (name: string, action: () => Promise<unknown>) => {
    try { await action(); }
    catch (error) { console.warn(`[ccagent web] ${name}: ${String(error)}`); }
  };
  await tryBootstrap("Agent Teams", () => bootstrapAgentTeams());
  await tryBootstrap("Agent Skills", () => bootstrapAgentSkills());
  await tryBootstrap("Agent preferences", () => bootstrapAgentStates());
  await tryBootstrap("Workfriend reminders", () => bootstrapWorkfriendScheduler());
  await tryBootstrap("Skills", () => bootstrapSkills(workspace));
  await tryBootstrap("Agents", () => bootstrapAgents(workspace));
  await tryBootstrap("Output styles", () => bootstrapOutputStyles(workspace));
  await tryBootstrap("Commands", () => bootstrapUserCommands(workspace));
  await tryBootstrap("Plugins", () => refreshActivePlugins(workspace, { applyMcp: false }));
  if (!process.env.ANTHROPIC_AUTH_TOKEN) {
    const token = await resolveApiKeyFromHelper(workspace).catch(() => null);
    if (token) process.env.ANTHROPIC_AUTH_TOKEN = token;
  }
  const additional = await readTrustedStringArraySetting(workspace, "additionalDirectories").catch(() => []);
  setAdditionalAllowedRoots(additional.map(directory => resolveSafePath(directory, workspace)));
  await applySessionRetentionPolicy(workspace);
  await cleanupOldFileHistoryBackups(workspace).catch(() => {});
  await refreshHookDisableFromSettings(workspace).catch(() => {});
  resetSessionThinkingState();
  try {
    const sources = await loadSettingSources(workspace);
    const alwaysThinkingEnabled = getScalarSetting<boolean>(sources, "alwaysThinkingEnabled", {
      predicate: (value) => typeof value === "boolean",
    });
    const effortLevel = getScalarSetting<string>(sources, "effortLevel", {
      predicate: (value) => value === "low" || value === "medium" || value === "high" || value === "max",
    });
    configureThinkingDefaults({
      ...(alwaysThinkingEnabled !== undefined ? { alwaysThinkingEnabled } : {}),
      ...(effortLevel !== undefined ? { effortLevel: effortLevel as "low" | "medium" | "high" | "max" } : {}),
    });
  } catch { /* Keep built-in thinking defaults. */ }
  void bootstrapMcp(workspace).catch((error) => console.warn(`[ccagent web] MCP: ${String(error)}`));
  void refreshActivePlugins(workspace).catch((error) => console.warn(`[ccagent web] Plugins: ${String(error)}`));
  return (await readMergedStringSetting(workspace, "model").catch(() => undefined))
    ?? (await readMergedStringSetting(workspace, "defaultModel").catch(() => undefined))
    ?? DEFAULT_MODEL;
}

export async function runWebWorker(args: string[]): Promise<void> {
  await requirePlatformScope(0);
  const { port, workspace: initialWorkspace } = parseArgs(args);
  const workspace = await resolveWorkingFolder(initialWorkspace);
  process.chdir(workspace);
  // The CLI initially loads env from its launch directory; --workspace may
  // select a different trusted project, so re-evaluate the same trust rules.
  await loadEnv();
  let model = await bootstrap(workspace);
  let permissions = await loadPermissionSettings(workspace);
  const sessions = new Map<string, WebSession>();
  const modelFiles = new WebModelFiles();
  const deletedSessions = new Set<string>();
  let activeTurn: string | null = null;
  let teamOwner: string | null = null;
  let pluginMutationBusy = false;
  let folderPickerBusy = false;
  let configuredMcpNames = new Set(Object.keys((await loadMcpConfigs(workspace)).servers));
  const pluginPreviews = new Map<string, { pluginId: string; fingerprint: string; expires: number }>();
  const scheduleStore = new WebScheduleStore();
  let schedulesReady = true;
  try { await scheduleStore.load(); }
  catch (error) { schedulesReady = false; console.warn(`[ccagent web] Scheduled tasks: ${String(error)}`); }
  let scheduleDispatching = false;
  let schedulePoll: Promise<void> | null = null;
  let shuttingDown = false;
  let notificationDispatcher: ReturnType<typeof createWebNotificationDispatcher<WebSession>> | undefined;
  const workspaceListPath = getCCAgentPath("web-workspaces.json");
  async function listWebWorkspaces(): Promise<string[]> {
    let saved: unknown = [];
    try { saved = JSON.parse(await readFile(workspaceListPath, "utf8")); }
    catch { /* The default workspace is always available. */ }
    return [...new Set([workspace, ...(Array.isArray(saved) ? saved.filter((item): item is string => typeof item === "string" && path.isAbsolute(item)) : [])])].slice(0, 20);
  }
  const entryDir = path.dirname(path.resolve(process.argv[1] ?? ""));
  const webRoots = [path.resolve(entryDir, "../web"), path.resolve(entryDir, "../../web")];
  let webRoot = "";
  for (const candidate of webRoots) {
    if (await stat(path.join(candidate, "index.html")).then(() => true, () => false)) {
      webRoot = candidate;
      break;
    }
  }
  if (!webRoot) throw new Error("Web assets are missing. Run npm run build or reinstall CCAGENT.");
  // Source-mode entrypoints and the packaged binary have different parents.
  const chartsPath = path.join(webRoot, "../dist/charts.js");

  async function deliverModelFile(session: WebSession, filePath: string, projectDirectory: string): Promise<void> {
    if (deletedSessions.has(session.id)) return;
    const file = await modelFiles.register(session.id, filePath, projectDirectory, session.temporary);
    (session.modelFiles ??= []).push(file);
    publish(session, { type: "model_file", file });
    if (!file.persistent && !session.temporary) publish(session, {
      type: "notice", tone: "error", message: "模型文件已保存，但文件入口暂时无法写入聊天记录。请复制卡片中的保存地址。",
    });
  }

  async function openSession(id: string): Promise<WebSession> {
    if (deletedSessions.has(id)) throw new Error("Session not found");
    const existing = sessions.get(id);
    if (existing) return existing;
    const sessionWorkspace = workspace;
    const restored = await restoreSession(sessionWorkspace, id).catch(error => {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT" || (error instanceof Error && error.message === "No saved session found for this project.")) throw new Error("Session not found");
      throw error;
    });
    let session!: WebSession;
    const engine = new QueryEngine({
      model: restored.summary.model,
      toolContext: {
        cwd: sessionWorkspace, sessionId: id,
        applicationProtection: true,
        onModelExport: (filePath, projectDirectory) => deliverModelFile(session, filePath, projectDirectory),
        strictNotificationScope: true,
        requestUserQuestion: (request) => waitForQuestion(session, request),
      },
      initialMessages: restored.messages,
      initialUsage: restored.summary.totalUsage,
      permissionMode: permissions.mode,
      permissionSettings: permissions,
      onPermissionRequest: (request) => waitForPermission(session, request),
    });
    session = {
      id, model: restored.summary.model, temporary: false, scheduled: false, team: await readSessionTeam(sessionWorkspace, id), engine, busy: false,
      restoredSnapshots: restored.fileHistorySnapshots,
      modelFiles: await modelFiles.list(id),
      clients: new Set(), events: [], nextEventId: 1, persistenceUnavailable: false,
    };
    if (workspace !== sessionWorkspace || deletedSessions.has(id)) throw new Error("Session not found");
    const opened = sessions.get(id);
    if (opened) return opened;
    sessions.set(id, session);
    if (process.connected) process.send?.({ type: "ccagent:session-owned", sessionId: id }, () => {});
    return session;
  }

  async function createSession(mode?: PermissionMode, selectedModel = model, temporary = false, scheduled = false, team = "off"): Promise<WebSession> {
    await sessionTeamInstructions(team);
    const id = createSessionId();
    const now = new Date().toISOString();
    let persistenceUnavailable = false;
    if (!temporary) {
      try {
        await retrySessionWrite(() => initSessionStorage({ sessionId: id, cwd: workspace, startedAt: now, updatedAt: now, model: selectedModel }));
      } catch (error) {
        if (!isSessionStorageError(error)) throw error;
        persistenceUnavailable = true;
      }
    }
    let session!: WebSession;
    const engine = new QueryEngine({
      model: selectedModel,
      toolContext: {
        cwd: workspace, sessionId: id, temporaryChat: temporary,
        applicationProtection: true,
        onModelExport: (filePath, projectDirectory) => deliverModelFile(session, filePath, projectDirectory),
        strictNotificationScope: true,
        requestUserQuestion: (request) => waitForQuestion(session, request),
      },
      permissionMode: mode ?? permissions.mode,
      permissionSettings: permissions,
      onPermissionRequest: (request) => waitForPermission(session, request),
    });
    session = { id, model: selectedModel, temporary, scheduled, team, engine, busy: false, restoredSnapshots: [], clients: new Set(), events: [], nextEventId: 1, persistenceUnavailable };
    if (!temporary) await saveSessionTeam(workspace, id, team);
    sessions.set(id, session);
    if (process.connected) process.send?.({ type: "ccagent:session-owned", sessionId: id }, () => {});
    if (persistenceUnavailable) publish(session, {
      type: "notice", tone: "error",
      message: "会话记录暂时无法写入。当前对话可以继续，但重启后新增内容无法恢复。请检查 .ccagent 会话目录的访问权限。",
    });
    return session;
  }

  async function persistSessionChange(session: WebSession, action: () => Promise<void>): Promise<void> {
    if (session.temporary || session.persistenceUnavailable) return;
    try {
      await retrySessionWrite(action);
    } catch (error) {
      if (!isSessionStorageError(error)) throw error;
      session.persistenceUnavailable = true;
      publish(session, {
        type: "notice", tone: "error",
        message: "会话记录暂时无法写入。当前对话可以继续，但重启后新增内容无法恢复。请检查 .ccagent 会话目录的访问权限。",
      });
    }
  }

  async function persistTranscript(session: WebSession, entry: TranscriptEntry): Promise<void> {
    await persistSessionChange(session, () => appendTranscriptEntry(workspace, session.id, entry));
  }

  async function webModels() {
    const { profiles } = await loadProfiles(workspace);
    const official = await readServiceConfiguration().catch(() => null);
    return Object.values(profiles).map((profile) => ({
      id: profile.id, label: profile.provider === "ollama" ? `Ollama · ${profile.model}` : ({ deepseek: "DeepSeek", "qwen-plus": "Qwen Plus" } as Record<string, string>)[profile.id] || profile.id,
      model: profile.model, configured: true,
      // Keep auxiliary profiles available to tools and existing sessions, but
      // expose only the configured official main route in the chat picker.
      mainModelSelectable: !profile.platformService || Boolean(official?.roles.main === profile.platformService
        && official.routes.some(route => route.id === profile.platformService && route.service === "chat")),
      available: Boolean(profile.apiKey || profile.platformService) || Boolean(profile.baseURL && (profile.provider === "ollama" || /^(localhost|127\.0\.0\.1|\[::1\])$/.test(new URL(profile.baseURL).hostname))),
    }));
  }

  async function validateWebModel(id: string): Promise<boolean> {
    return (await webModels()).some((item) => item.id === id && item.available);
  }

  const whiteboardAI = createWhiteboardAIManager({
    getWorkspace: () => workspace,
    getDefaultModel: () => model,
    validateModel: validateWebModel,
    isBusy: () => Boolean(activeTurn || scheduleDispatching || pluginMutationBusy || teamOwner || getActiveTeam() || getRunningAsyncAgents().length),
    onBusy: (runId) => {
      if (activeTurn || scheduleDispatching || pluginMutationBusy || teamOwner || getActiveTeam() || getRunningAsyncAgents().length) throw new WhiteboardAIError("请先结束当前任务，再开始 AI 绘图。", 409, "busy");
      activeTurn = runId;
    },
    onIdle: (runId) => { if (activeTurn === runId) activeTurn = null; },
  });
  const whiteboardDesign = createWhiteboardDesignManager({
    getWorkspace: () => workspace,
    isBusy: () => Boolean(activeTurn || scheduleDispatching || pluginMutationBusy || teamOwner || getActiveTeam() || getRunningAsyncAgents().length),
    onBusy: runId => {
      if (activeTurn || scheduleDispatching || pluginMutationBusy || teamOwner || getActiveTeam() || getRunningAsyncAgents().length) throw new WhiteboardDesignError("请先结束当前任务，再开始图像生成。", 409, "busy");
      activeTurn = runId;
    },
    onIdle: runId => { if (activeTurn === runId) activeTurn = null; },
  });

  async function mcpView() {
    const configs = await loadMcpConfigs(workspace);
    return {
      servers: getMcpRegistry().map(({ connection, tools }) => ({
        name: connection.name,
        state: connection.type === "connected" && connection.discoveryError ? "degraded" : connection.type,
        scope: connection.config.scope,
        transport: connection.config.type ?? "stdio",
        enabled: isMcpServerEnabled(connection.name, connection.config),
        authAvailable: connection.config.type === "http" && Boolean(connection.config.oauth),
        ...(connection.type === "failed" ? { error: connection.error } : {}),
        ...(connection.type === "connected" ? {
          serverInfo: connection.serverInfo,
          ...(connection.discoveryError ? { error: connection.discoveryError } : {}),
        } : {}),
        tools: tools.map((tool) => ({ name: tool.name, description: tool.description })),
      })).sort((a, b) => a.name.localeCompare(b.name)),
      pending: configs.pending ?? [],
      configErrorCount: configs.errors.length,
    };
  }

  async function syncIntegrations() {
    const configs = await loadMcpConfigs(workspace);
    if (configs.errors.length) throw new Error(`MCP configuration has ${configs.errors.length} error(s); fix settings before synchronizing`);
    const nextNames = new Set(Object.keys(configs.servers));
    for (const name of configuredMcpNames) {
      if (nextNames.has(name)) continue;
      const previous = getMcpRegistryEntry(name);
      if (!previous) continue;
      deleteMcpRegistryEntry(name);
      refreshGlobalToolRegistry();
      await clearServerCache(name, previous.connection.config);
    }
    configuredMcpNames = nextNames;
    await loadMcpPreferences(true);
    await bootstrapMcp(workspace);
    await refreshActivePlugins(workspace);
  }

  function taskConflict(session: WebSession) {
    // Report only the owning conversation and fixed state, never tool inputs
    // or the pending permission payload. Each worker belongs to one account.
    const owner = activeTurn ? sessions.get(activeTurn) : session.busy ? session : teamOwner ? sessions.get(teamOwner) : undefined;
    if (owner) {
      const reason = owner.pending?.kind === "permission" ? "waiting_permission"
        : owner.pending?.kind === "question" ? "waiting_question" : owner.busy ? "task_running" : "team_active";
      const message = reason === "waiting_permission" ? "另一个任务正在等待工具授权，请查看该任务或停止后再发送。"
        : reason === "waiting_question" ? "另一个任务正在等待你的回答，请查看该任务或停止后再发送。"
        : reason === "team_active" ? "另一个对话的 Agent 团队仍在使用工作区，请先返回该对话结束团队。"
        : "另一个任务正在执行，请查看该任务或停止后再发送。";
      return { error: message, code: "TASK_BUSY", reason, activeSessionId: owner.id, canInterrupt: owner.busy };
    }
    if (activeTurn) return { error: "白板任务正在执行，请在白板中查看或停止后再发送。", code: "TASK_BUSY", reason: "whiteboard_running", activeSessionId: null, canInterrupt: false };
    return { error: "工作区或配置操作正在进行，请稍后再发送。", code: "TASK_BUSY", reason: "configuration_busy", activeSessionId: null, canInterrupt: false };
  }

  async function runTurn(session: WebSession, input: string): Promise<boolean> {
    session.busy = true;
    activeTurn = session.id;
    publish(session, { type: "turn_started" });
    let succeeded = true;
    try {
      await syncWebSecrets();
      session.engine.selectSessionTeam(session.team !== "off", await sessionTeamInstructions(session.team));
      await configureFileHistory(workspace, session.id, session.temporary);
      if (session.restoredSnapshots.length) restoreFileHistorySnapshots(session.restoredSnapshots);
      session.restoredSnapshots = [];
      if (classifyUserInput(input).isLlmTriggering) {
        const messageId = session.engine.beginUserTurn();
        await persistTranscript(session, {
          type: "message", timestamp: new Date().toISOString(), role: "user",
          message: { role: "user", content: input }, messageId,
        });
      }
      if (input) publish(session, { type: "user", text: input });
      const run = session.engine.submitMessage(input);
      while (true) {
        const { value, done } = await run.next();
        if (done) {
          succeeded = value.reason === undefined || value.reason === "completed";
          publish(session, { type: "turn_complete", reason: value.reason ?? "completed" });
          break;
        }
        const outgoing = summarizeEvent(value);
        if (outgoing) publish(session, outgoing);
        if (value.type === "compacted") {
          if (value.trigger === "micro") {
            await persistTranscript(session, { type: "system", timestamp: new Date().toISOString(), level: "info", message: "compaction:micro" });
          } else {
            await persistSessionChange(session, () => appendCompactionSnapshot(workspace, session.id, value.trigger as "auto" | "manual", session.engine.getState().messages));
          }
        } else if (value.type === "model_changed") {
          session.model = value.model;
          await persistTranscript(session, { type: "model_change", timestamp: new Date().toISOString(), model: value.model });
        } else if (value.type === "assistant_message" || value.type === "tool_result_message") {
          await persistTranscript(session, {
            type: "message", timestamp: new Date().toISOString(),
            role: value.type === "assistant_message" ? "assistant" : "user",
            message: value.message,
            ...(session.engine.getCurrentMessageId() ? { messageId: session.engine.getCurrentMessageId()! } : {}),
          });
        } else if (value.type === "tool_use_start" || value.type === "tool_use_done") {
          await persistTranscript(session, {
            type: "tool_event", timestamp: new Date().toISOString(), name: value.name,
            phase: value.type === "tool_use_start" ? "start" : "done",
            ...(value.type === "tool_use_done" ? { isError: value.result.isError === true } : {}),
          });
        } else if (value.type === "usage_updated") {
          await persistTranscript(session, {
            type: "usage", timestamp: new Date().toISOString(), turn: value.turnUsage, total: value.totalUsage,
          });
        }
      }
    } catch (error) {
      succeeded = false;
      publish(session, { type: "notice", tone: "error", message: error instanceof Error ? error.message : String(error) });
      publish(session, { type: "turn_complete", reason: "error" });
    } finally {
      session.busy = false;
      activeTurn = null;
      teamOwner = getActiveTeam() ? session.id : null;
      notificationDispatcher?.request();
    }
    return succeeded;
  }

  async function dispatchScheduledTask(): Promise<void> {
    await requirePlatformScope(0);
    if (!schedulesReady || scheduleDispatching || activeTurn || pluginMutationBusy) return;
    scheduleDispatching = true;
    let finishPoll!: () => void;
    schedulePoll = new Promise(resolve => { finishPoll = resolve; });
    try {
      const due = await scheduleStore.claimDue(workspace);
      if (!due) return;
      try {
        if (!(await validateWebModel(due.model))) throw new Error("Scheduled task model is unavailable");
        const session = await createSession(due.mode, due.model, false, true);
        await scheduleStore.recordResult(due.id, due.runId, { sessionId: session.id });
        activeTurn = session.id;
        void runTurn(session, due.prompt).then((succeeded) => scheduleStore.recordResult(due.id, due.runId, {
          finished: true, ...(succeeded ? {} : { error: "任务执行失败，请检查结果对话。" }),
        })).catch((error) => console.warn(`[ccagent web] Scheduled task completion: ${String(error)}`));
      } catch (error) {
        await scheduleStore.recordResult(due.id, due.runId, { finished: true, error: error instanceof Error ? error.message : String(error) });
      }
    } finally { scheduleDispatching = false; schedulePoll = null; finishPoll(); }
  }

  const server = createServer((req, res) => withVerifiedPlatformRequest(req.headers["x-ccagent-verified-account"], async () => {
    try {
      // Desktop owns a private service instance. Its token is added by the
      // Electron main process, never exposed through a renderer bridge.
      const desktopToken = process.env.CCAGENT_DESKTOP_TOKEN;
      if (desktopToken) {
        const supplied = req.headers["x-ccagent-desktop-token"];
        if (typeof supplied !== "string" || Buffer.byteLength(supplied) !== Buffer.byteLength(desktopToken) ||
            !timingSafeEqual(Buffer.from(supplied), Buffer.from(desktopToken))) {
          return json(res, 403, { error: "Desktop authorization required" });
        }
      }
      const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
      if (!allowedHosts.has(req.headers.host ?? "")) return json(res, 403, { error: "Invalid host" });
      if (req.headers.origin && !allowedHosts.has(new URL(req.headers.origin).host)) return json(res, 403, { error: "Invalid origin" });
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
      const route = url.pathname;
      if (req.method === "POST" && req.headers["x-ccagent-web"] !== "1") return json(res, 403, { error: "Missing local request header" });

      if (req.method === "GET" && route === "/api/health") return json(res, 200, { ok: true, version: VERSION });
      await requirePlatformScope();
      // Other project processes may have saved account-level credentials.
      // Refresh only the generated credential namespace between turns; static
      // assets/status polling never contend on the credential transaction.
      if (!activeTurn && !scheduleDispatching && !pluginMutationBusy && (req.method === "POST" || route === "/api/models"
        || route.startsWith("/api/customize/") || route === "/api/whiteboards/design/config")) await syncWebSecrets();
      // Polling the shared schedule file is a short transaction, not a running
      // user task. Wait for it before deciding whether a mutation must be blocked.
      if (schedulePoll && (req.method === "POST" || route === "/api/desktop/status")) {
        await schedulePoll;
        await requirePlatformScope(0);
      }
      if (req.method === "GET" && route === "/api/desktop/status" && desktopToken) {
        const owner = activeTurn ? sessions.get(activeTurn) : teamOwner ? sessions.get(teamOwner) : undefined;
        return json(res, 200, {
          busy: Boolean(activeTurn || scheduleDispatching || pluginMutationBusy || getActiveTeam() || getRunningAsyncAgents().length),
          activeSessionId: owner?.id ?? null, pending: owner?.pending?.kind ?? null,
        });
      }
      if (route.startsWith("/api/customize/")) {
        const resource = route.slice("/api/customize/".length);
        if (req.method === "GET") return json(res, 200, await handleCustomization(resource, "GET", {}, { workspace, defaultModel: model }));
        if (req.method === "POST") {
          if (activeTurn || scheduleDispatching || pluginMutationBusy) return json(res, 409, { error: "Wait for the active task or configuration operation" });
          pluginMutationBusy = true;
          try {
            const body = await readJson(req);
            const result = await handleCustomization(resource, "POST", body, { workspace, defaultModel: model });
            if (["agents", "local-skill"].includes(resource)) await refreshActivePlugins(workspace, { applyMcp: false });
            if (resource === "mcp") {
              const name = (result as { name: string }).name;
              const config = (await loadMcpConfigs(workspace)).servers[name];
              if (!config) throw new Error("MCP saved but could not be loaded; check the configuration.");
              configuredMcpNames.add(name);
              void startMcpServer(name, config).catch(() => {});
            }
            if (resource === "teams") await bootstrapAgentTeams();
            if (resource === "models" || resource === "settings" || resource === "official-services") {
              permissions = await loadPermissionSettings(workspace);
              const additional = await readTrustedStringArraySetting(workspace, "additionalDirectories");
              setAdditionalAllowedRoots(additional.map(directory => resolveSafePath(directory, workspace)));
              model = (await readMergedStringSetting(workspace, "model")) ?? (await readMergedStringSetting(workspace, "defaultModel")) ?? model;
              const sources = await loadSettingSources(workspace);
              configureThinkingDefaults({
                alwaysThinkingEnabled: getScalarSetting<boolean>(sources, "alwaysThinkingEnabled", { predicate: (v) => typeof v === "boolean" }),
                effortLevel: getScalarSetting<string>(sources, "effortLevel", { predicate: (v) => ["low", "medium", "high", "max"].includes(String(v)) }) as "low" | "medium" | "high" | "max" | undefined,
              });
              await bootstrapOutputStyles(workspace);
            }
            return json(res, 200, result);
          } finally { pluginMutationBusy = false; }
        }
      }
      if (route === "/api/visualization" || route.startsWith("/api/visualization/")) {
        const body = req.method === "GET" ? Object.fromEntries(url.searchParams) : await readJson(req, Math.ceil(MAX_UPLOAD / 3) * 4 + 4096);
        if (body.workspace !== workspace || pluginMutationBusy) return json(res, 409, { error: "工作文件夹已切换或正在配置，请重新打开数据可视化。" });
        const selected = workspace;
        if (req.method === "GET" && route === "/api/visualization") return json(res, 200, await handleVisualization("list", body, selected));
        const action = route.slice("/api/visualization/".length);
        if (req.method !== "POST" || !["import", "open", "query", "save", "export"].includes(action)) return json(res, 404, { error: "Unknown visualization action" });
        const mutating = action === "import" || action === "save";
        if (mutating) pluginMutationBusy = true;
        try { return json(res, action === "import" ? 201 : 200, await handleVisualization(action, body, selected)); }
        finally { if (mutating) pluginMutationBusy = false; }
      }
      if (req.method === "GET" && route.startsWith("/whiteboard-assets/")) return await serveWhiteboardAsset(res, route, webRoot);
      if (route.startsWith("/api/whiteboards/design/")) {
        const body = req.method === "GET" ? Object.fromEntries(url.searchParams) : await readJson(req, route.endsWith("/assets") ? 44 * 1024 * 1024 : route.endsWith("/start") ? 12 * 1024 * 1024 : MAX_BODY_BYTES);
        if (body.workspace !== workspace) return json(res, 409, { error: "工作文件夹已切换，请重新打开画布。", code: "workspace_changed" });
        if (route === "/api/whiteboards/design/assets") {
          if (req.method === "POST") return json(res, 201, await whiteboardDesign.uploadAsset(workspace, body.image));
          if (req.method === "DELETE" && typeof body.assetId === "string") return json(res, 200, await whiteboardDesign.removeAsset(workspace, body.assetId));
        }
        if (route === "/api/whiteboards/design/config") {
          if (req.method === "GET") return json(res, 200, { workspace, config: await getDesignImageConfig(workspace) });
          if (req.method === "POST") {
            if (activeTurn || pluginMutationBusy) return json(res, 409, { error: "请等待当前任务完成后再修改图像模型。", code: "busy" });
            pluginMutationBusy = true;
            try { const { workspace: ignored, ...config } = body; return json(res, 200, { workspace, config: await saveDesignImageConfig(config, workspace) }); }
            finally { pluginMutationBusy = false; }
          }
        }
        if (req.method === "POST" && route === "/api/whiteboards/design/start") return json(res, 202, await whiteboardDesign.start(body));
        if (req.method === "GET" && route === "/api/whiteboards/design/request" && typeof body.requestId === "string") return json(res, 200, await whiteboardDesign.lookup(body.requestId, workspace));
        if (typeof body.runId === "string") {
          if (req.method === "GET" && route === "/api/whiteboards/design/run") return json(res, 200, await whiteboardDesign.status(body.runId, workspace));
          if (req.method === "POST" && route === "/api/whiteboards/design/stop") return json(res, 200, await whiteboardDesign.stop(body.runId, workspace));
          if (req.method === "POST" && route === "/api/whiteboards/design/resume") return json(res, 202, await whiteboardDesign.resume(body.runId, workspace));
        }
        return json(res, 404, { error: "Unknown design action" });
      }
      if (route.startsWith("/api/whiteboards/ai/")) {
        const body = req.method === "GET" ? Object.fromEntries(url.searchParams) : await readJson(req);
        if (body.workspace !== workspace) return json(res, 409, { error: "工作文件夹已切换，请重新打开画布。", code: "workspace_changed" });
        if (req.method === "POST" && route === "/api/whiteboards/ai/start") return json(res, 202, await whiteboardAI.start(body));
        if ((req.method === "GET" && route === "/api/whiteboards/ai/run") || (req.method === "POST" && route === "/api/whiteboards/ai/stop")) {
          if (typeof body.runId !== "string") return json(res, 400, { error: "Invalid drawing run id" });
          return json(res, 200, route.endsWith("/stop") ? await whiteboardAI.stop(body.runId, workspace) : await whiteboardAI.status(body.runId, workspace));
        }
        return json(res, 404, { error: "Unknown whiteboard AI action" });
      }
      if (route === "/api/whiteboards" || route.startsWith("/api/whiteboards/")) {
        const body = req.method === "GET" ? Object.fromEntries(url.searchParams) : await readJson(req, 12 * 1024 * 1024);
        if (body.workspace !== workspace) return json(res, 409, { error: "工作文件夹已切换，请重新打开画布。", code: "workspace_changed" });
        if (req.method === "GET" && route === "/api/whiteboards") return json(res, 200, await handleWhiteboard("list", body, workspace));
        const action = route.slice("/api/whiteboards/".length);
        if (req.method !== "POST" || !["create", "open", "save"].includes(action)) return json(res, 404, { error: "Unknown whiteboard action" });
        const mutating = action !== "open";
        if (mutating && pluginMutationBusy) return json(res, 409, { error: "当前配置或画布正在保存，请稍后重试。", code: "busy" });
        if (mutating) pluginMutationBusy = true;
        try { return json(res, action === "create" ? 201 : 200, await handleWhiteboard(action, body, workspace)); }
        finally { if (mutating) pluginMutationBusy = false; }
      }
      if (req.method === "GET" && route === "/api/models") return json(res, 200, { defaultModel: model, models: await webModels() });
      if (req.method === "GET" && route === "/api/composer-tools") {
        const commands = [
          { name: "init", description: "分析项目并生成项目说明", kind: "命令" },
          { name: "help", description: "查看可用命令", kind: "命令" },
          { name: "cost", description: "查看本次对话用量", kind: "命令" },
          ...getAllUserCommands().filter((item) => !isBuiltinCommandName(item.name)).map((item) => ({ name: item.name, description: item.description, kind: "自定义命令" })),
          ...(isAgentSkillsEnabled() ? getAllSkills().filter((item) => isSkillEnabled(item.name) && !isBuiltinCommandName(item.name)).map((item) => ({ name: item.name, description: item.description, kind: "技能" })) : []),
        ];
        return json(res, 200, { workspace, commands: [...new Map(commands.map((item) => [item.name, item])).values()] });
      }
      if (route.startsWith("/api/files")) {
        const expected = url.searchParams.get("workspace");
        if (pluginMutationBusy || (expected !== null && expected !== workspace)) return json(res, 409, { error: "工作文件夹已切换，请刷新文件面板。" });
        const relative = url.searchParams.get("path") ?? "";
        if (req.method === "GET" && route === "/api/files") return json(res, 200, await browseWorkspaceFiles(workspace, relative, url.searchParams.get("query") ?? "", url.searchParams.get("hidden") === "1", Number(url.searchParams.get("offset") ?? 0)));
        if (req.method === "GET" && route === "/api/files/preview") return json(res, 200, { workspace, ...await previewWorkspaceFile(workspace, relative) });
        if (req.method === "GET" && (route === "/api/files/content" || route === "/api/files/download")) return await serveWorkspaceFile(req, res, workspace, relative, route.endsWith("download"));
        if (req.method === "POST" && route === "/api/files/upload") {
          const body = await readJson(req, Math.ceil(MAX_UPLOAD / 3) * 4 + 4096);
          if (body.workspace !== workspace || pluginMutationBusy) return json(res, 409, { error: "工作文件夹已切换，请重新添加附件。" });
          const attachment = await saveWorkspaceAttachment(workspace, body.name, body.base64);
          if (attachment.format === "office") {
            try { return json(res, 201, { ...attachment, ...await previewWorkspaceFile(attachment.workspace, attachment.path) }); }
            catch { /* The original attachment remains usable even without a preview. */ }
          }
          return json(res, 201, attachment);
        }
      }
      if (req.method === "GET" && route === "/api/workspaces") return json(res, 200, { current: workspace, recent: await listWebWorkspaces(), locations: await listFolderLocations(), nativePickerAvailable: process.platform === "win32" });
      if (req.method === "GET" && route === "/api/workspaces/browse") return json(res, 200, await browseWorkingFolders(url.searchParams.get("path") || workspace, url.searchParams.get("query") ?? "", url.searchParams.get("hidden") === "1"));
      if (req.method === "POST" && route === "/api/workspaces/pick") {
        if (folderPickerBusy) return json(res, 409, { error: "系统文件夹选择器已经打开，请先完成或取消选择。" });
        folderPickerBusy = true;
        try {
          const body = await readJson(req);
          const initial = typeof body.initialPath === "string" ? await resolveWorkingFolder(body.initialPath) : workspace;
          return json(res, 200, { path: await pickNativeWorkingFolder(webRoot, initial) });
        } finally { folderPickerBusy = false; }
      }
      if (req.method === "GET" && route === "/api/library") {
        const query = url.searchParams.get("query") ?? "";
        const kind = url.searchParams.get("kind") ?? "all";
        if (query.length > 100 || !["all", "文档", "PDF", "Word", "演示", "表格", "网页", "思维导图", "图片"].includes(kind)) return json(res, 400, { error: "Invalid library filter" });
        return json(res, 200, { workspace, files: await listWorkspaceDocuments(workspace, query, kind) });
      }
      if (req.method === "GET" && route === "/api/memory") {
        const [saved, pinned, documents] = await Promise.all([
          listProjectSessions(workspace, 200), listPinnedSessionIds(workspace), loadMemoryHeaders(workspace),
        ]);
        return json(res, 200, {
          sessions: saved.map((item) => ({ ...item, pinned: pinned.includes(item.sessionId) })),
          memories: documents.map((item) => ({ name: item.title, description: item.hook, type: item.frontmatter.type, fileName: item.fileName })),
        });
      }
      if (route === "/api/schedules") {
        if (!schedulesReady) return json(res, 503, { error: "Scheduled task store could not be read; check web-schedules.json" });
        if (req.method === "GET") return json(res, 200, { tasks: await scheduleStore.list(workspace), running: activeTurn });
        if (req.method === "POST") {
          const body = await readJson(req);
          const title = typeof body.title === "string" ? body.title.trim() : "";
          const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
          const nextRunAt = typeof body.nextRunAt === "string" ? body.nextRunAt : "";
          const repeat = body.repeat;
          const mode = body.mode === undefined ? "default" : body.mode;
          const selectedModel = body.model === undefined ? model : body.model;
          if (!title || title.length > 100 || !prompt || prompt.length > 50000) return json(res, 400, { error: "Title and prompt are required" });
          if (!["none", "daily", "weekly"].includes(String(repeat))) return json(res, 400, { error: "Invalid repeat interval" });
          if (mode !== "default" && mode !== "plan" && mode !== "auto") return json(res, 400, { error: "Scheduled tasks support default, plan, or auto mode" });
          if (typeof selectedModel !== "string" || !(await validateWebModel(selectedModel))) return json(res, 400, { error: "Model profile is not configured or available" });
          const runTime = new Date(nextRunAt).getTime();
          if (!Number.isFinite(runTime) || runTime < Date.now() - 5000) return json(res, 400, { error: "Choose a future run time" });
          const task = await scheduleStore.add({ workspace, title, prompt, nextRunAt: new Date(runTime).toISOString(), repeat: repeat as WebScheduledTask["repeat"], model: selectedModel, mode });
          return json(res, 201, { task });
        }
      }
      const scheduleMatch = /^\/api\/schedules\/([0-9a-f-]{36})$/.exec(route);
      if (scheduleMatch && req.method === "POST") {
        if (!schedulesReady) return json(res, 503, { error: "Scheduled task store could not be read" });
        const body = await readJson(req);
        const action = body.action;
        if (action !== "pause" && action !== "resume" && action !== "delete" && action !== "run-now") return json(res, 400, { error: "Unknown scheduled task action" });
        const task = await scheduleStore.change(scheduleMatch[1]!, workspace, action);
        if (action === "run-now") void dispatchScheduledTask();
        return json(res, 200, { task });
      }
      const memorySessionMatch = /^\/api\/memory\/sessions\/([0-9a-f-]{36})$/.exec(route);
      if (memorySessionMatch) {
        const id = memorySessionMatch[1]!;
        if (req.method === "GET") {
          const restored = await restoreSession(workspace, id);
          return json(res, 200, { summary: restored.summary, messages: restored.messages });
        }
        if (req.method === "POST") {
          const body = await readJson(req);
          if (body.workspace !== undefined && body.workspace !== workspace) return json(res, 409, { error: "工作文件夹已切换，请刷新任务列表。" });
          if (activeTurn || scheduleDispatching || pluginMutationBusy || sessions.get(id)?.busy) return json(res, 409, { error: "请等待当前任务或工作区操作完成。" });
          if (body.action === "pin" || body.action === "unpin") {
            await setSessionPinned(workspace, id, body.action === "pin");
            return json(res, 200, { pinned: body.action === "pin" });
          }
          if (body.action === "delete") {
            if (deletedSessions.has(id)) return json(res, 200, { deleted: true });
            if (teamOwner === id || getRunningAsyncAgents().length) return json(res, 409, { error: "请先等待后台 Agent 或团队结束，再删除聊天记录。" });
            pluginMutationBusy = true;
            try {
              const active = sessions.get(id);
              await deleteStoredSession(workspace, id, Boolean(active && !active.temporary));
              deletedSessions.add(id);
              clearPendingNotifications({ sessionId: id });
              sessions.delete(id);
              if (active) {
                publish(active, { type: "session_deleted" });
                for (const client of active.clients) client.end();
              }
              return json(res, 200, { deleted: true });
            } finally { pluginMutationBusy = false; }
          }
          return json(res, 400, { error: "Unknown memory action" });
        }
      }
      if (req.method === "GET" && (route === "/api/library/file" || route === "/api/library/download")) {
        const relativePath = url.searchParams.get("path") ?? "";
        const document = await resolveWorkspaceDocument(workspace, relativePath);
        if (route === "/api/library/file") {
          if (!document.previewable) return json(res, 415, { error: "This document cannot be previewed as text" });
          return json(res, 200, { path: relativePath, content: await readFile(document.filePath, "utf8") });
        }
        if (document.size > 50 * 1024 * 1024) return json(res, 413, { error: "Document exceeds the 50 MB download limit" });
        const filename = path.basename(document.filePath);
        res.writeHead(200, {
          "content-type": document.mime,
          "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
          "content-security-policy": "default-src 'none'",
          "x-content-type-options": "nosniff", "cache-control": "no-store",
        });
        return res.end(await readFile(document.filePath));
      }
      if (req.method === "POST" && route === "/api/workspaces/select") {
        const body = await readJson(req);
        const target = await resolveWorkingFolder(typeof body.path === "string" ? body.path : "");
        if (target !== workspace) return json(res, 409, { error: "请通过项目列表打开工作文件夹。", code: "workspace_bound" });
        return json(res, 200, { workspace });
      }
      if (req.method === "GET" && route === "/api/bootstrap") {
        let stored: Awaited<ReturnType<typeof listProjectSessions>>;
        let storageUnavailable = false;
        try { stored = (await listProjectSessions(workspace)).filter((item) => !deletedSessions.has(item.sessionId)); }
        catch (error) {
          if (!isSessionStorageError(error)) throw error;
          stored = [];
          storageUnavailable = true;
        }
        const activeOnly = [...sessions.values()].filter((item) => !item.temporary && !stored.some((row) => row.sessionId === item.id));
        return json(res, 200, {
          version: VERSION, workspace, model, defaultMode: permissions.mode, activeTurn, storageUnavailable,
          sessions: [...activeOnly.map((item) => ({ sessionId: item.id, firstPrompt: "", updatedAt: new Date().toISOString(), model: item.model })), ...stored],
        });
      }
      if (req.method === "GET" && route === "/api/plugins") {
        const view = await buildPluginView(workspace);
        const records = (await readInstalledPlugins()).plugins;
        return json(res, 200, {
          ...view,
          installed: view.installed.map((item) => ({
            ...item,
            installationScopes: (records[item.pluginId]?.installations ?? [{ scope: "user" }])
              .filter((entry) => entry.scope === "user" || entry.projectPath === workspace)
              .map((entry) => entry.scope),
          })),
        });
      }
      if (req.method === "GET" && route === "/api/apps") return json(res, 200, await webAppsView(workspace));
      if (req.method === "POST" && route === "/api/apps/sketchup/test") {
        if (activeTurn || scheduleDispatching || pluginMutationBusy || getActiveTeam() || getRunningAsyncAgents().length) return json(res, 409, { error: "请先等待当前任务、后台 Agent 或团队结束，再测试 SketchUp。" });
        pluginMutationBusy = true;
        try {
          const body = await readJson(req);
          if (Object.keys(body).length) throw new Error("SketchUp 连接测试不接受 Ruby、脚本或模型修改参数。");
          const app = (await webAppsView(workspace)).apps.find((item) => item.id === "sketchup");
          if (!app?.installed || app.state !== "connected") throw new Error("请先安装并连接 SketchUp MCP；配置变更或断开后需要重新连接。");
          const entry = getMcpRegistryEntry(app.serverName!);
          if (!entry || entry.connection.type !== "connected") throw new Error("SketchUp MCP 尚未连接。");
          return json(res, 200, await runSketchupWebTest(workspace, entry.tools));
        } finally { pluginMutationBusy = false; }
      }
      if (req.method === "POST" && route === "/api/apps/comfyui/test") {
        if (activeTurn || scheduleDispatching || pluginMutationBusy || getActiveTeam() || getRunningAsyncAgents().length) return json(res, 409, { error: "请先等待当前任务、后台 Agent 或团队结束，再测试 ComfyUI。" });
        pluginMutationBusy = true;
        try {
          const body = await readJson(req);
          if (Object.keys(body).length) throw new Error("ComfyUI 连接测试不接受脚本、工作流或其他参数。");
          const app = (await webAppsView(workspace)).apps.find((item) => item.id === "comfyui");
          if (!app?.installed || app.state !== "connected") throw new Error("请先安装并连接 ComfyUI MCP；配置变更或断开后需要重新连接。");
          const entry = getMcpRegistryEntry(app.serverName!);
          if (!entry || entry.connection.type !== "connected") throw new Error("ComfyUI MCP 尚未连接。");
          return json(res, 200, await runComfyuiWebTest(workspace, entry.tools));
        } finally { pluginMutationBusy = false; }
      }
      if (req.method === "POST" && route === "/api/apps/photoshop/test") {
        if (activeTurn || scheduleDispatching || pluginMutationBusy || getActiveTeam() || getRunningAsyncAgents().length) return json(res, 409, { error: "请先等待当前任务、后台 Agent 或团队结束，再测试 Photoshop。" });
        pluginMutationBusy = true;
        try {
          const body = await readJson(req);
          if (body.mode !== "connection" && body.mode !== "sample") throw new Error("请选择连接测试或样例导出测试。");
          const app = (await webAppsView(workspace)).apps.find((item) => item.id === "photoshop");
          if (!app?.installed || app.state !== "connected") throw new Error("请先安装并连接 Photoshop MCP；配置变更或断开后需要重新连接。");
          const entry = getMcpRegistryEntry(app.serverName!);
          if (!entry || entry.connection.type !== "connected") throw new Error("Photoshop MCP 尚未连接。");
          return json(res, 200, await runPhotoshopWebTest(workspace, body.mode, entry.tools));
        } finally { pluginMutationBusy = false; }
      }
      if (req.method === "POST" && route === "/api/apps/action") {
        if (activeTurn || scheduleDispatching || pluginMutationBusy || getActiveTeam() || getRunningAsyncAgents().length) return json(res, 409, { error: "请先等待当前任务、后台 Agent 或团队结束，再修改应用连接。" });
        pluginMutationBusy = true;
        try {
          const result = await changeWebApp(workspace, await readJson(req), async (name, oldConfig) => {
            const entry = getMcpRegistryEntry(name);
            deleteMcpRegistryEntry(name);
            refreshGlobalToolRegistry();
            await clearServerCache(name, entry?.connection.config ?? { ...oldConfig, scope: "user" });
            configuredMcpNames.delete(name);
            if (oldConfig.type === "http" && oldConfig.oauth?.provider === "google") {
              const host = new URL(oldConfig.url).hostname;
              const others = Object.values((await loadMcpConfigs(workspace)).servers);
              if (!others.some((item) => item.type === "http" && item.oauth?.provider === "google" && new URL(item.url).hostname === host)) {
                await new GoogleWorkspaceOAuthProvider(host, oldConfig.oauth).invalidateCredentials("tokens");
              }
            }
          });
          if (!result.removed) {
            const config = (await loadMcpConfigs(workspace)).servers[result.serverName];
            if (config) {
              await saveMcpServerState(result.serverName, "open");
              configuredMcpNames.add(result.serverName);
              void startMcpServer(result.serverName, config).catch(() => {});
            }
          }
          return json(res, 200, await webAppsView(workspace));
        } finally { pluginMutationBusy = false; }
      }
      if (req.method === "GET" && route === "/api/skills") {
        return json(res, 200, {
          globallyEnabled: isAgentSkillsEnabled(),
          skills: getAllSkills().map((skill) => ({
            name: skill.name, description: skill.description, source: skill.source,
            enabled: isSkillEnabled(skill.name),
            ...(skill.pluginId ? { pluginId: skill.pluginId } : {}),
          })).sort((a, b) => a.name.localeCompare(b.name)),
        });
      }
      if (req.method === "POST" && route === "/api/skills/global") {
        if (activeTurn || pluginMutationBusy) return json(res, 409, { error: "Wait for the active task or configuration operation" });
        pluginMutationBusy = true;
        try {
          const body = await readJson(req);
          if (typeof body.enabled !== "boolean") throw new Error("Invalid skills state.");
          await setAgentSkillsEnabled(body.enabled);
          return json(res, 200, { enabled: isAgentSkillsEnabled() });
        } finally { pluginMutationBusy = false; }
      }
      if (req.method === "POST" && route === "/api/skills/state") {
        if (activeTurn || pluginMutationBusy) return json(res, 409, { error: "Wait for the active task or configuration operation" });
        pluginMutationBusy = true;
        try {
          const body = await readJson(req);
          if (typeof body.name !== "string" || !getAllSkills().some((s) => s.name === body.name)) throw new Error("Skill not found.");
          if (body.state !== "open" && body.state !== "close") throw new Error("Invalid skill state.");
          await setSkillState(body.name, body.state);
          return json(res, 200, { name: body.name, enabled: isSkillEnabled(body.name) });
        } finally { pluginMutationBusy = false; }
      }
      if (req.method === "POST" && route === "/api/skills/import") {
        if (activeTurn || pluginMutationBusy) return json(res, 409, { error: "Wait for the active task or integration operation" });
        const body = await readJson(req);
        const name = typeof body.name === "string" ? body.name.trim() : "";
        const content = typeof body.content === "string" ? body.content : "";
        const scope = body.scope;
        if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(name) || name.endsWith(".") || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name)) return json(res, 400, { error: "Skill name must be a safe folder name of 1–64 characters" });
        if (scope !== "user" && scope !== "project") return json(res, 400, { error: "Choose user or project scope" });
        if (!content.trim() || Buffer.byteLength(content, "utf8") > 60 * 1024 || content.includes("\0")) return json(res, 400, { error: "SKILL.md must be nonempty UTF-8 text up to 60 KB" });
        const parsed = splitFrontmatter(content);
        if (parsed.parseError) return json(res, 400, { error: `Invalid SKILL.md frontmatter: ${parsed.parseError}` });
        const frontmatter = normalizeFrontmatter(parsed.raw, parsed.body);
        if (!parsed.body.trim()) return json(res, 400, { error: "SKILL.md needs instructions after its frontmatter" });
        if (frontmatter.name && frontmatter.name !== name) return json(res, 400, { error: "Skill name must match the SKILL.md frontmatter name" });
        pluginMutationBusy = true;
        try {
          const parent = scope === "user" ? getUserSkillsDir() : getProjectSkillsDir(workspace);
          await mkdir(parent, { recursive: true });
          const directory = path.join(parent, name);
          await mkdir(directory);
          try { await writeFile(path.join(directory, "SKILL.md"), content, { encoding: "utf8", flag: "wx" }); }
          catch (error) { await import("node:fs/promises").then((fs) => fs.rmdir(directory)).catch(() => {}); throw error; }
          await refreshActivePlugins(workspace, { applyMcp: false });
          return json(res, 201, { name, scope });
        } finally { pluginMutationBusy = false; }
      }
      if (req.method === "GET" && route === "/api/agents") {
        return json(res, 200, { agents: getAllAgents().map((agent) => ({
          name: agent.agentType, description: agent.whenToUse, source: agent.source,
          enabled: isAgentEnabled(agent.agentType),
          editable: agent.source === "user" || agent.source === "project",
          ...((agent.source === "user" || agent.source === "project") ? { prompt: agent.getSystemPrompt() } : {}),
          ...(agent.pluginId ? { pluginId: agent.pluginId } : {}),
          ...(agent.tools ? { tools: agent.tools } : {}),
          ...(agent.model ? { model: agent.model } : {}),
        })).sort((a, b) => a.name.localeCompare(b.name)) });
      }
      if (req.method === "POST" && route === "/api/agents/state") {
        if (activeTurn || pluginMutationBusy) return json(res, 409, { error: "Wait for the active task or integration operation" });
        const body = await readJson(req);
        const name = typeof body.name === "string" ? body.name.trim() : "";
        if (!getAllAgents().some((agent) => agent.agentType === name)) return json(res, 404, { error: "Agent not found" });
        if (body.state !== "open" && body.state !== "close") return json(res, 400, { error: "State must be open or close" });
        await setAgentState(name, body.state);
        return json(res, 200, { name, enabled: isAgentEnabled(name) });
      }
      if (req.method === "GET" && route === "/api/mcp") return json(res, 200, await mcpView());
      if (req.method === "POST" && route === "/api/integrations/sync") {
        if (activeTurn || pluginMutationBusy) return json(res, 409, { error: "Wait for the active task or integration operation" });
        pluginMutationBusy = true;
        try {
          await syncIntegrations();
          return json(res, 200, { ok: true });
        } finally { pluginMutationBusy = false; }
      }
      if (req.method === "POST" && route === "/api/mcp/action") {
        if (activeTurn || pluginMutationBusy) return json(res, 409, { error: "Wait for the active task or integration operation" });
        const body = await readJson(req);
        const name = typeof body.name === "string" ? body.name.trim() : "";
        const op = body.op;
        const entry = getMcpRegistryEntry(name);
        if (!name || !entry) return json(res, 404, { error: "MCP server is not configured or approved" });
        if (op !== "open" && op !== "close" && op !== "reconnect" && op !== "auth") {
          return json(res, 400, { error: "Unknown MCP action" });
        }
        if (op === "auth" && !(entry.connection.config.type === "http" && entry.connection.config.oauth)) {
          return json(res, 400, { error: "Browser authorization is not configured for this server" });
        }
        if ((op === "auth" || op === "reconnect") && !isMcpServerEnabled(name, entry.connection.config)) {
          return json(res, 409, { error: "Open this MCP server first" });
        }
        pluginMutationBusy = true;
        try {
          if (op === "open" || op === "close") await setMcpServerOpen(name, op === "open");
          else requestMcpReconnect(name, op === "auth");
          return json(res, 200, await mcpView());
        } finally { pluginMutationBusy = false; }
      }
      if (req.method === "POST" && route === "/api/plugins/preview") {
        if (activeTurn || pluginMutationBusy) return json(res, 409, { error: "Wait for the active task or plugin operation" });
        const body = await readJson(req);
        const pluginId = typeof body.pluginId === "string" ? body.pluginId.trim() : "";
        if (!pluginId || pluginId.length > 200 || !pluginId.includes("@")) return json(res, 400, { error: "Invalid plugin id" });
        const preview = await inspectPlugin(pluginId);
        if (preview.errors.length) return json(res, 400, { error: preview.errors.join("; ") });
        for (const [key, value] of pluginPreviews) if (value.expires < Date.now()) pluginPreviews.delete(key);
        const token = randomUUID();
        pluginPreviews.set(token, { pluginId: preview.pluginId, fingerprint: preview.fingerprint, expires: Date.now() + 5 * 60_000 });
        return json(res, 200, { preview, token });
      }
      if (req.method === "POST" && route === "/api/plugins/action") {
        if (activeTurn || pluginMutationBusy) return json(res, 409, { error: "Wait for the active task or plugin operation" });
        const body = await readJson(req);
        const op = body.op;
        const pluginId = typeof body.pluginId === "string" ? body.pluginId.trim() : "";
        const scope = body.scope === undefined ? "user" : body.scope;
        if (scope !== "user" && scope !== "project" && scope !== "local") return json(res, 400, { error: "Invalid plugin scope" });
        const pluginScope = scope as PluginScope;
        const requiresPlugin = ["install", "update", "enable", "disable", "uninstall"].includes(String(op));
        if (requiresPlugin && (!pluginId || pluginId.length > 200 || !pluginId.includes("@"))) return json(res, 400, { error: "Invalid plugin id" });
        if (activeTurn || pluginMutationBusy) return json(res, 409, { error: "Wait for the active task or plugin operation" });
        pluginMutationBusy = true;
        try {
          if (op === "install" || op === "update") {
            const token = typeof body.token === "string" ? body.token : "";
            const preview = pluginPreviews.get(token);
            pluginPreviews.delete(token);
            if (!preview || preview.pluginId !== pluginId || preview.expires < Date.now()) {
              return json(res, 409, { error: "Review this plugin again before installing" });
            }
            const options = { allowExecutableComponents: true, expectedFingerprint: preview.fingerprint };
            if (op === "install") await installPlugin(pluginId, pluginScope, workspace, options);
            else await updatePlugin(pluginId, pluginScope, workspace, options);
          } else if (op === "enable" || op === "disable" || op === "uninstall") {
            const installed = (await readInstalledPlugins()).plugins[pluginId];
            if (!installed) return json(res, 404, { error: "Plugin is not installed" });
            if (op === "uninstall") {
              const owned = installed.installations ? installed.installations.some((entry) =>
                entry.scope === pluginScope && (pluginScope === "user" ||
                  (entry.projectPath !== undefined && path.resolve(entry.projectPath) === workspace))) : pluginScope === "user";
              if (!owned) return json(res, 404, { error: "Plugin is not installed in this scope" });
              await uninstallPlugin(pluginId, { scope: pluginScope, cwd: workspace, keepData: true });
            }
            else await setPluginEnabled(workspace, pluginId, op === "enable", pluginScope);
          } else if (op === "marketplace-add") {
            const source = typeof body.source === "string" ? body.source.trim() : "";
            if (!source || source.length > 2048) return json(res, 400, { error: "Invalid marketplace source" });
            let marketplaceSource: MarketplaceSource;
            if (/^https:\/\//i.test(source) || /^git@/.test(source)) marketplaceSource = { kind: "git", url: source };
            else if (/^[a-z]+:\/\//i.test(source)) return json(res, 400, { error: "Use an HTTPS Git URL or a local path" });
            else marketplaceSource = { kind: "local", path: path.resolve(workspace, source) };
            await addMarketplace(marketplaceSource);
          } else if (op === "marketplace-update" || op === "marketplace-remove") {
            const name = typeof body.name === "string" ? body.name.trim() : "";
            if (!name || !(await listMarketplaces()).some((entry) => entry.name === name)) return json(res, 404, { error: "Marketplace not found" });
            if (op === "marketplace-update") await updateMarketplace(name);
            else await removeMarketplace(name);
          } else if (op !== "reload") {
            return json(res, 400, { error: "Unknown plugin action" });
          }
          await refreshActivePlugins(workspace);
          return json(res, 200, await buildPluginView(workspace));
        } finally { pluginMutationBusy = false; }
      }
      if (req.method === "POST" && route === "/api/sessions") {
        if (pluginMutationBusy) return json(res, 409, { error: "工作区或配置正在切换，请稍后再创建对话。" });
        const body = await readJson(req);
        const mode = body.mode;
        if (mode !== undefined && !["default", "plan", "auto", "full"].includes(String(mode))) return json(res, 400, { error: "Invalid mode" });
        const requestedModel = body.model;
        if (body.temporary !== undefined && typeof body.temporary !== "boolean") return json(res, 400, { error: "temporary must be a boolean" });
        if (requestedModel !== undefined && (typeof requestedModel !== "string" || !(await validateWebModel(requestedModel)))) {
          return json(res, 400, { error: "Model profile is not configured or available" });
        }
        if (body.team !== undefined && typeof body.team !== "string") throw new Error("Invalid team selection.");
        const session = await createSession(mode as PermissionMode | undefined, requestedModel as string | undefined, body.temporary === true, false, typeof body.team === "string" ? body.team : "off");
        return json(res, 201, { sessionId: session.id, model: session.model, temporary: session.temporary, team: session.team, snapshot: sessionSnapshot(session) });
      }

      const modelFileMatch = /^\/api\/sessions\/([0-9a-f-]{36})\/model-files\/([0-9a-f-]{36})\/open$/.exec(route);
      if (modelFileMatch && req.method === "POST") {
        await openSession(modelFileMatch[1]!);
        if (activeTurn || getRunningAsyncAgents().length) return json(res, 409, { error: "请等待当前建模任务完成后再打开模型，以免切换正在操作的文档。" });
        await modelFiles.open(modelFileMatch[1]!, modelFileMatch[2]!);
        return json(res, 200, { opened: true });
      }
      const match = /^\/api\/sessions\/([0-9a-f-]{36})(?:\/(events|messages|interrupt|respond|model|mode|browser|team))?$/.exec(route);
      if (match) {
        const session = await openSession(match[1]!);
        const action = match[2];
        if (req.method === "GET" && !action) {
          return json(res, 200, sessionSnapshot(session));
        }
        if (req.method === "GET" && action === "events") {
          res.writeHead(200, {
            "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform",
            connection: "keep-alive", "x-accel-buffering": "no",
          });
          res.write(": connected\n\n");
          const lastId = Number(req.headers["last-event-id"] ?? url.searchParams.get("lastEventId") ?? 0);
          const earliest = session.events[0]?.id ?? session.nextEventId;
          const replayUnavailable = !Number.isSafeInteger(lastId) || lastId < 0 || lastId < earliest - 1 || lastId >= session.nextEventId;
          if (replayUnavailable) {
            // Partial replay cannot restore lost assistant text or an approval
            // prompt. Ask the client to fetch the authoritative session once.
            res.write(`data: ${JSON.stringify({ type: "session_snapshot_required" })}\n\n`);
          } else {
            for (const item of session.events) {
              if (item.id > lastId) res.write(`id: ${item.id}\ndata: ${JSON.stringify(item.data)}\n\n`);
            }
          }
          // A reconnect may outlive the bounded event buffer. Snapshot after replay so old starts cannot reset its clock.
          const serverTime = new Date().toISOString();
          res.write(`data: ${JSON.stringify({ type: "execution_state", timestamp: serverTime, serverTime,
            ...(session.execution ? { turnId: session.execution.id } : {}), execution: session.execution ?? null })}\n\n`);
          session.clients.add(res);
          const heartbeat = setInterval(() => { if (!res.destroyed) res.write(": heartbeat\n\n"); }, 15000);
          req.on("close", () => { clearInterval(heartbeat); session.clients.delete(res); });
          return;
        }
        if (req.method === "POST" && action === "messages") {
          const body = await readJson(req);
          if (sessions.get(session.id) !== session) return json(res, 404, { error: "聊天记录已删除或工作文件夹已切换。" });
          const input = typeof body.text === "string" ? body.text.trim() : "";
          if (!input || input.length > 50000) return json(res, 400, { error: "Message must be 1–50000 characters" });
          if (/^\/(resume|clear)\b/i.test(input)) return json(res, 400, { error: "Use the task list or New task button to switch conversations" });
          if (activeTurn || scheduleDispatching || session.busy || pluginMutationBusy || (teamOwner && teamOwner !== session.id)) return json(res, 409, taskConflict(session));
          // Reserve the process-wide file-history store before returning 202.
          activeTurn = session.id;
          void runTurn(session, input);
          return json(res, 202, { accepted: true });
        }
        if (req.method === "POST" && action === "browser") {
          const body = await readJson(req);
          const plan = prepareBrowserSearchInput({ action: "open_url", url: body.url });
          session.browserUrl = plan.canonicalUrl;
          publish(session, { type: "browser_open", url: plan.canonicalUrl, source: "user" });
          return json(res, 200, { url: plan.canonicalUrl });
        }
        if (req.method === "DELETE" && action === "browser") {
          session.browserUrl = undefined;
          publish(session, { type: "browser_close" });
          return json(res, 200, { closed: true });
        }
        if (req.method === "POST" && action === "team") {
          if (activeTurn || session.busy || pluginMutationBusy || getActiveTeam()) return json(res, 409, { error: "Finish the current task and team before changing the team selection" });
          const body = await readJson(req);
          if (typeof body.team !== "string") throw new Error("Invalid team selection.");
          await sessionTeamInstructions(body.team);
          if (!session.temporary) await saveSessionTeam(workspace, session.id, body.team);
          session.team = body.team;
          publish(session, { type: "team", team: session.team });
          return json(res, 200, { team: session.team });
        }
        if (req.method === "POST" && action === "model") {
          if (activeTurn || session.busy) return json(res, 409, { error: "Wait for the current task to finish" });
          const body = await readJson(req);
          const selected = body.model;
          if (typeof selected !== "string" || !(await validateWebModel(selected))) {
            return json(res, 400, { error: "Model profile is not configured or available" });
          }
          session.engine.selectSessionModel(selected);
          session.model = selected;
          await persistTranscript(session, { type: "model_change", timestamp: new Date().toISOString(), model: selected });
          publish(session, { type: "model", model: selected, source: "session" });
          return json(res, 200, { model: selected });
        }
        if (req.method === "POST" && action === "mode") {
          if (activeTurn || session.busy) return json(res, 409, { error: "Wait for the current task to finish" });
          const body = await readJson(req);
          if (body.mode !== "default" && body.mode !== "plan" && body.mode !== "auto" && body.mode !== "full") return json(res, 400, { error: "Invalid permission mode" });
          session.engine.selectSessionPermissionMode(body.mode);
          publish(session, { type: "mode", mode: body.mode });
          return json(res, 200, { mode: body.mode });
        }
        if (req.method === "POST" && action === "interrupt") {
          if (session.pending) {
            session.pending.resolve(session.pending.kind === "permission" ? "deny" as never : null as never);
            session.pending = undefined;
          }
          const interrupted = session.engine.interrupt();
          return json(res, 200, { interrupted });
        }
        if (req.method === "POST" && action === "respond") {
          const body = await readJson(req);
          const pending = session.pending;
          if (!pending || body.id !== pending.id) return json(res, 409, { error: "No matching request" });
          if (pending.kind === "permission") {
            if (body.decision !== "allow_once" && body.decision !== "deny") return json(res, 400, { error: "Invalid decision" });
            pending.resolve(body.decision as never);
          } else {
            const answers = body.answers;
            if (answers !== null && (!answers || typeof answers !== "object" || Array.isArray(answers))) return json(res, 400, { error: "Invalid answers" });
            pending.resolve((answers === null ? null : { answers }) as never);
          }
          session.pending = undefined;
          publish(session, { type: "interaction_resolved", id: pending.id });
          return json(res, 200, { ok: true });
        }
      }

      if (req.method === "GET" && route === "/api/changes") {
        try {
          return json(res, 200, { files: await listGitChanges(workspace) });
        } catch { return json(res, 200, { files: [] }); }
      }
      if (req.method === "GET" && route === "/api/diff") {
        const file = url.searchParams.get("file") ?? "";
        const absolute = path.resolve(workspace, file);
        if (!file || !(absolute === workspace || absolute.startsWith(workspace + path.sep))) return json(res, 400, { error: "Invalid path" });
        const change = (await listGitChanges(workspace)).find((item) => item.path === file);
        if (!change) return json(res, 200, { file, diff: "" });
        const paths = change.previousPath ? [change.previousPath, file] : [file];
        const [staged, unstaged] = await Promise.all([
          execFileAsync("git", ["diff", "--cached", "--no-ext-diff", "--", ...paths], { cwd: workspace, maxBuffer: 1024 * 1024 }),
          execFileAsync("git", ["diff", "--no-ext-diff", "--", ...paths], { cwd: workspace, maxBuffer: 1024 * 1024 }),
        ]);
        let diff = [staged.stdout, unstaged.stdout].filter(Boolean).join("\n");
        if (!diff && change.status === "??") {
          const fileInfo = await lstat(absolute).catch(() => null);
          if (fileInfo?.isFile()) {
            if (fileInfo.size > 256 * 1024) diff = "未跟踪文件超过 256 KB，无法在此预览。";
            else {
              const bytes = await readFile(absolute);
              diff = bytes.includes(0) ? "未跟踪的二进制文件，无法在此预览。" : `未跟踪文件：${file}\n\n${bytes.toString("utf-8")}`;
            }
          }
        }
        return json(res, 200, { file, diff });
      }

      if (req.method === "GET" && route in MIME) {
        const file = route === "/" ? "index.html" : route.slice(1);
        const bytes = await readFile(route === "/charts.js" ? chartsPath : path.join(webRoot, file));
        res.writeHead(200, {
          "content-type": MIME[route], "cache-control": "no-store",
          "content-security-policy": route === "/whiteboard-editor.html" ? WHITEBOARD_EDITOR_CSP : "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-src 'self' https: http://127.0.0.1:* http://localhost:*; object-src 'none'; base-uri 'none'",
          "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer",
        });
        return res.end(bytes);
      }
      return json(res, 404, { error: "Not found" });
    } catch (error) {
      if (error instanceof WhiteboardDesignError || error instanceof DesignImageError) return json(res, error.status, { error: error.message, code: error.code });
      if (error instanceof WhiteboardAIError) return json(res, error.status, { error: error.message, code: error.code });
      if (error instanceof WhiteboardError) return json(res, error.status, { error: error.message, code: error.code });
      if (error instanceof AccountError) return json(res, error.status || 503, { error: error.message, code: error.code });
      const message = error instanceof Error ? error.message : String(error);
      return json(res, message.includes("Session ") ? 404 : 400, { error: message });
    } finally {
      // Loading a reminder's owner or releasing a configuration lock is also
      // an idle transition; do not make it wait for the fallback poll.
      notificationDispatcher?.request();
    }
  }));

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  process.send?.({ type: "ccagent:worker-ready" });
  notificationDispatcher = createWebNotificationDispatcher({
    sessions: () => sessions.values(), teamOwner: () => teamOwner,
    blocked: () => shuttingDown || Boolean(activeTurn || pluginMutationBusy || scheduleDispatching),
    start: session => { activeTurn = session.id; void runTurn(session, ""); },
  });
  const notificationFallback = setInterval(() => notificationDispatcher?.request(), 1000);
  notificationFallback.unref();
  server.once("close", () => { notificationDispatcher?.dispose(); clearInterval(notificationFallback); });
  if (process.env.CCAGENT_DESKTOP_TOKEN && process.send) {
    let stopping = false;
    const shutdownDesktopService = async () => {
      if (stopping) return;
      stopping = true;
      shuttingDown = true;
      notificationDispatcher?.dispose();
      clearInterval(notificationFallback);
      server.close();
      clearWorkfriendTimers();
      whiteboardAI.dispose();
      whiteboardDesign.dispose();
      for (const session of sessions.values()) {
        session.engine.interrupt();
        for (const client of session.clients) client.end();
      }
      await Promise.allSettled(getActiveMcpConnections().map(connection => connection.cleanup()));
      // Give interrupted turns a short opportunity to finish transcript writes.
      const deadline = Date.now() + 3000;
      while ([...sessions.values()].some(session => session.busy) && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      server.closeAllConnections();
      process.exit(0);
    };
    process.on("message", message => { if (message === "ccagent:shutdown") void shutdownDesktopService(); });
    process.once("disconnect", () => { void shutdownDesktopService(); });
    let checkingAccount = false;
    setInterval(() => {
      if (checkingAccount || stopping) return;
      checkingAccount = true;
      void requirePlatformScope(0).catch(() => shutdownDesktopService()).finally(() => { checkingAccount = false; });
    }, 5000).unref();
  }
  if (schedulesReady) {
    setInterval(() => { void dispatchScheduledTask().catch((error) => console.warn(`[ccagent web] Scheduled task: ${String(error)}`)); }, 10_000).unref();
    void dispatchScheduledTask().catch(error => console.warn(`[ccagent web] Scheduled task: ${String(error)}`));
  }
  console.log(`CCAGENT Web: http://127.0.0.1:${port}`);
  // Startup may have queued restored reminders before the subscription existed.
  notificationDispatcher.request();
  console.log(`Workspace: ${workspace}`);
}
