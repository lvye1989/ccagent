import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { lstat, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { QueryEngine } from "../core/queryEngine.js";
import type { QueryEngineEvent } from "../core/queryEngine.js";
import { classifyUserInput } from "../ui/hooks/useAgentSession/inputClassification.js";
import {
  appendTranscriptEntry,
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
import { resolveApiKeyFromHelper } from "../services/api/apiKeyHelper.js";
import { cleanupOldFileHistoryBackups } from "../session/fileHistory.js";
import { refreshHookDisableFromSettings } from "../hooks/settings.js";
import { loadSettingSources, getScalarSetting } from "../config/sources.js";
import { configureThinkingDefaults } from "../utils/thinking.js";
import { setAdditionalAllowedRoots } from "../tools/pathUtils.js";
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
import { isMcpServerEnabled, loadMcpPreferences } from "../services/mcp/preferences.js";
import { loadMcpConfigs } from "../services/mcp/config.js";
import { clearServerCache } from "../services/mcp/client.js";
import { VERSION } from "../version.js";
import { getCCAgentPath } from "../utils/paths.js";
import { listWorkspaceDocuments, resolveWorkspaceDocument } from "./webLibrary.js";
import { loadMemoryHeaders } from "../context/memory/memdir.js";
import { WebScheduleStore, type WebScheduledTask } from "./webSchedules.js";
import { handleCustomization, readSessionTeam, saveSessionTeam, sessionTeamInstructions } from "./webCustomization.js";
import { getActiveTeam } from "../state/teamContext.js";
import { pendingNotificationCount } from "../state/notificationStore.js";
import { getRunningAsyncAgents } from "../state/asyncAgentStore.js";
import { browseWorkingFolders, listFolderLocations, pickNativeWorkingFolder, resolveWorkingFolder } from "./webWorkspaces.js";

const execFileAsync = promisify(execFile);
const MAX_BODY_BYTES = 64 * 1024;
const MIME: Record<string, string> = {
  "/": "text/html; charset=utf-8",
  "/index.html": "text/html; charset=utf-8",
  "/app.js": "text/javascript; charset=utf-8",
  "/plugins.js": "text/javascript; charset=utf-8",
  "/voice.js": "text/javascript; charset=utf-8",
  "/browser-panel.js": "text/javascript; charset=utf-8",
  "/library.js": "text/javascript; charset=utf-8",
  "/memory.js": "text/javascript; charset=utf-8",
  "/schedules.js": "text/javascript; charset=utf-8",
  "/customization.js": "text/javascript; charset=utf-8",
  "/customization.css": "text/css; charset=utf-8",
  "/workspace-picker.js": "text/javascript; charset=utf-8",
  "/workspace-picker.css": "text/css; charset=utf-8",
  "/styles.css": "text/css; charset=utf-8",
  "/codex-layout.css": "text/css; charset=utf-8",
  "/plugins.css": "text/css; charset=utf-8",
  "/chatgpt-web.css": "text/css; charset=utf-8",
  "/voice.css": "text/css; charset=utf-8",
  "/browser-panel.css": "text/css; charset=utf-8",
  "/workspace-features.css": "text/css; charset=utf-8",
  "/favicon.svg": "image/svg+xml",
};

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
  pending?: PendingInteraction;
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

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!req.headers["content-type"]?.startsWith("application/json")) throw new Error("Expected application/json");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_BODY_BYTES) throw new Error("Request body is too large");
    chunks.push(bytes);
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf-8") || "{}");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a JSON object");
  return value as Record<string, unknown>;
}

function publish(session: WebSession, data: Record<string, unknown>): void {
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

function summarizeEvent(event: QueryEngineEvent): Record<string, unknown> | null {
  switch (event.type) {
    case "text": return { type: "text", text: event.text };
    case "tool_use_start": return { type: "tool_start", id: event.id, name: event.name };
    case "tool_use_done": return { type: "tool_done", id: event.id, name: event.name, input: event.input, isError: event.result.isError === true };
    case "assistant_message": return { type: "assistant", message: event.message };
    case "tool_result_message": return { type: "tool_result", message: event.message };
    case "messages_updated": return { type: "messages", messages: event.messages };
    case "usage_updated": return { type: "usage", usage: event.totalUsage };
    case "mode_changed": return { type: "mode", mode: event.mode };
    case "command": return { type: "notice", tone: event.kind, message: event.message };
    case "notice": return { type: "notice", tone: event.tone, message: `${event.title}: ${event.body}` };
    case "api_retry": return { type: "notice", tone: "info", message: event.message };
    case "error": return { type: "notice", tone: "error", message: event.error.message };
    case "model_changed": return { type: "model", model: event.model, source: event.source };
    case "stream_restart": return { type: "stream_restart" };
    default: return null;
  }
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
  setAdditionalAllowedRoots(additional.map((dir) => path.resolve(workspace, dir.startsWith("~") ? dir.replace("~", os.homedir()) : dir)));
  await applySessionRetentionPolicy(workspace);
  await cleanupOldFileHistoryBackups(workspace).catch(() => {});
  await refreshHookDisableFromSettings(workspace).catch(() => {});
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

export async function runWebServer(args: string[]): Promise<void> {
  const { port, workspace: initialWorkspace } = parseArgs(args);
  let workspace = await resolveWorkingFolder(initialWorkspace);
  process.chdir(workspace);
  // The CLI initially loads env from its launch directory; --workspace may
  // select a different trusted project, so re-evaluate the same trust rules.
  await loadEnv();
  let model = await bootstrap(workspace);
  let permissions = await loadPermissionSettings(workspace);
  const sessions = new Map<string, WebSession>();
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
  const workspaceListPath = getCCAgentPath("web-workspaces.json");
  async function listWebWorkspaces(): Promise<string[]> {
    let saved: unknown = [];
    try { saved = JSON.parse(await readFile(workspaceListPath, "utf8")); }
    catch { /* The default workspace is always available. */ }
    return [...new Set([workspace, ...(Array.isArray(saved) ? saved.filter((item): item is string => typeof item === "string" && path.isAbsolute(item)) : [])])].slice(0, 20);
  }
  async function rememberWorkspace(selected: string, previous: string): Promise<void> {
    const recent = [selected, previous, ...(await listWebWorkspaces()).filter((item) => item !== selected && item !== previous)].slice(0, 20);
    await mkdir(path.dirname(workspaceListPath), { recursive: true });
    const temporary = workspaceListPath + "." + randomUUID() + ".tmp";
    await writeFile(temporary, JSON.stringify(recent, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
    await rename(temporary, workspaceListPath);
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

  async function openSession(id: string): Promise<WebSession> {
    const existing = sessions.get(id);
    if (existing) return existing;
    const restored = await restoreSession(workspace, id);
    let session!: WebSession;
    const engine = new QueryEngine({
      model: restored.summary.model,
      toolContext: {
        cwd: workspace, sessionId: id,
        requestUserQuestion: (request) => waitForQuestion(session, request),
        openUrlInWebPanel: (url, signal) => openBrowserFromAgent(session, url, signal),
      },
      initialMessages: restored.messages,
      initialUsage: restored.summary.totalUsage,
      permissionMode: permissions.mode,
      permissionSettings: permissions,
      onPermissionRequest: (request) => waitForPermission(session, request),
    });
    session = {
      id, model: restored.summary.model, temporary: false, scheduled: false, team: await readSessionTeam(workspace, id), engine, busy: false,
      restoredSnapshots: restored.fileHistorySnapshots,
      clients: new Set(), events: [], nextEventId: 1, persistenceUnavailable: false,
    };
    sessions.set(id, session);
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
        requestUserQuestion: (request) => waitForQuestion(session, request),
        openUrlInWebPanel: (url, signal) => openBrowserFromAgent(session, url, signal),
      },
      permissionMode: mode ?? permissions.mode,
      permissionSettings: permissions,
      onPermissionRequest: (request) => waitForPermission(session, request),
    });
    session = { id, model: selectedModel, temporary, scheduled, team, engine, busy: false, restoredSnapshots: [], clients: new Set(), events: [], nextEventId: 1, persistenceUnavailable };
    if (!temporary) await saveSessionTeam(workspace, id, team);
    sessions.set(id, session);
    if (persistenceUnavailable) publish(session, {
      type: "notice", tone: "error",
      message: "会话记录暂时无法写入。当前对话可以继续，但重启后新增内容无法恢复。请检查 .ccagent 会话目录的访问权限。",
    });
    return session;
  }

  async function openBrowserFromAgent(session: WebSession, url: string, signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted || ![...session.clients].some((client) => !client.destroyed)) return false;
    session.browserUrl = url;
    publish(session, { type: "browser_open", url, source: "agent" });
    return true;
  }

  async function persistTranscript(session: WebSession, entry: TranscriptEntry): Promise<void> {
    if (session.temporary || session.persistenceUnavailable) return;
    try {
      await retrySessionWrite(() => appendTranscriptEntry(workspace, session.id, entry));
    } catch (error) {
      if (!isSessionStorageError(error)) throw error;
      session.persistenceUnavailable = true;
      publish(session, {
        type: "notice", tone: "error",
        message: "会话记录暂时无法写入。当前对话可以继续，但重启后新增内容无法恢复。请检查 .ccagent 会话目录的访问权限。",
      });
    }
  }

  async function webModels() {
    const { profiles } = await loadProfiles(workspace);
    return Object.values(profiles).map((profile) => ({
      id: profile.id, label: ({ deepseek: "DeepSeek", "qwen-plus": "Qwen Plus" } as Record<string, string>)[profile.id] || profile.id,
      model: profile.model, configured: true,
      available: Boolean(profile.apiKey) || Boolean(profile.baseURL && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(new URL(profile.baseURL).hostname)),
    }));
  }

  async function validateWebModel(id: string): Promise<boolean> {
    return (await webModels()).some((item) => item.id === id && item.available);
  }

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

  async function runTurn(session: WebSession, input: string): Promise<boolean> {
    session.busy = true;
    activeTurn = session.id;
    publish(session, { type: "turn_started" });
    let succeeded = true;
    try {
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
          publish(session, { type: "turn_complete", reason: value.reason ?? "completed" });
          break;
        }
        const outgoing = summarizeEvent(value);
        if (outgoing) publish(session, outgoing);
        if (value.type === "model_changed") {
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
    }
    return succeeded;
  }

  async function dispatchScheduledTask(): Promise<void> {
    if (!schedulesReady || scheduleDispatching || activeTurn || pluginMutationBusy) return;
    scheduleDispatching = true;
    try {
      const due = await scheduleStore.claimDue(workspace);
      if (!due) return;
      try {
        if (!(await validateWebModel(due.model))) throw new Error("Scheduled task model is unavailable");
        const session = await createSession(due.mode, due.model, false, true);
        await scheduleStore.recordResult(due.id, { sessionId: session.id });
        activeTurn = session.id;
        void runTurn(session, due.prompt).then((succeeded) => scheduleStore.recordResult(due.id, {
          finished: true, ...(succeeded ? {} : { error: "任务执行失败，请检查结果对话。" }),
        })).catch((error) => console.warn(`[ccagent web] Scheduled task completion: ${String(error)}`));
      } catch (error) {
        await scheduleStore.recordResult(due.id, { finished: true, error: error instanceof Error ? error.message : String(error) });
      }
    } finally { scheduleDispatching = false; }
  }

  const server = createServer(async (req, res) => {
    try {
      const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
      if (!allowedHosts.has(req.headers.host ?? "")) return json(res, 403, { error: "Invalid host" });
      if (req.headers.origin && !allowedHosts.has(new URL(req.headers.origin).host)) return json(res, 403, { error: "Invalid origin" });
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
      const route = url.pathname;
      if (req.method === "POST" && req.headers["x-ccagent-web"] !== "1") return json(res, 403, { error: "Missing local request header" });

      if (req.method === "GET" && route === "/api/health") return json(res, 200, { ok: true, version: VERSION });
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
            if (resource === "models" || resource === "settings") {
              permissions = await loadPermissionSettings(workspace);
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
      if (req.method === "GET" && route === "/api/models") return json(res, 200, { defaultModel: model, models: await webModels() });
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
        if (req.method === "GET") return json(res, 200, { tasks: scheduleStore.list(workspace), running: activeTurn });
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
          if (activeTurn || sessions.get(id)?.busy) return json(res, 409, { error: "Wait for the active task to finish" });
          const body = await readJson(req);
          if (body.action === "pin" || body.action === "unpin") {
            await setSessionPinned(workspace, id, body.action === "pin");
            return json(res, 200, { pinned: body.action === "pin" });
          }
          if (body.action === "delete") {
            await deleteStoredSession(workspace, id);
            const active = sessions.get(id);
            if (active) { for (const client of active.clients) client.end(); sessions.delete(id); }
            return json(res, 200, { deleted: true });
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
        if (activeTurn || scheduleDispatching || pluginMutationBusy || getActiveTeam() || getRunningAsyncAgents().length) return json(res, 409, { error: "请先等待当前任务、后台 Agent 或团队结束，再切换工作文件夹。" });
        pluginMutationBusy = true;
        try {
        const body = await readJson(req);
        const target = await resolveWorkingFolder(typeof body.path === "string" ? body.path : "");
        const previousWorkspace = workspace;
        if (target !== workspace) {
          const previous = workspace;
          try {
            process.chdir(target);
            await loadEnv();
            const nextConfigs = await loadMcpConfigs(target);
            for (const name of configuredMcpNames) {
              if (Object.hasOwn(nextConfigs.servers, name)) continue;
              const old = getMcpRegistryEntry(name); if (!old) continue;
              deleteMcpRegistryEntry(name); refreshGlobalToolRegistry();
              await clearServerCache(name, old.connection.config);
            }
            model = await bootstrap(target);
            permissions = await loadPermissionSettings(target);
            workspace = target;
            configuredMcpNames = new Set(Object.keys(nextConfigs.servers));
          } catch (error) {
            process.chdir(previous);
            await loadEnv();
            model = await bootstrap(previous);
            permissions = await loadPermissionSettings(previous);
            throw error;
          }
          for (const session of sessions.values()) for (const client of session.clients) client.end();
          sessions.clear();
        }
        let warning: string | undefined;
        try { await rememberWorkspace(target, previousWorkspace); }
        catch { warning = "工作文件夹已切换，但最近项目列表暂时无法保存。"; }
        return json(res, 200, { workspace: target, ...(warning ? { warning } : {}) });
        } finally { pluginMutationBusy = false; }
      }
      if (req.method === "GET" && route === "/api/bootstrap") {
        let stored: Awaited<ReturnType<typeof listProjectSessions>>;
        let storageUnavailable = false;
        try { stored = await listProjectSessions(workspace); }
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
        return json(res, 201, { sessionId: session.id, model: session.model, temporary: session.temporary, team: session.team });
      }

      const match = /^\/api\/sessions\/([0-9a-f-]{36})(?:\/(events|messages|interrupt|respond|model|mode|browser|team))?$/.exec(route);
      if (match) {
        const session = await openSession(match[1]!);
        const action = match[2];
        if (req.method === "GET" && !action) {
          const state = session.engine.getState();
          return json(res, 200, {
            sessionId: session.id, model: state.model, mode: session.engine.getPermissionMode(), temporary: session.temporary, browserUrl: session.browserUrl ?? null,
            messages: state.messages, usage: state.totalUsage, busy: session.busy, team: session.team,
            lastEventId: session.nextEventId - 1,
            recentNotices: session.events.map((item) => item.data).filter((item) => item.type === "notice").slice(-5),
            pending: session.pending ? { id: session.pending.id, kind: session.pending.kind, request: session.pending.payload } : null,
          });
        }
        if (req.method === "GET" && action === "events") {
          res.writeHead(200, {
            "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform",
            connection: "keep-alive", "x-accel-buffering": "no",
          });
          res.write(": connected\n\n");
          const lastId = Number(req.headers["last-event-id"] ?? url.searchParams.get("lastEventId") ?? 0);
          for (const item of session.events) {
            if (item.id > lastId) res.write(`id: ${item.id}\ndata: ${JSON.stringify(item.data)}\n\n`);
          }
          session.clients.add(res);
          const heartbeat = setInterval(() => { if (!res.destroyed) res.write(": heartbeat\n\n"); }, 15000);
          req.on("close", () => { clearInterval(heartbeat); session.clients.delete(res); });
          return;
        }
        if (req.method === "POST" && action === "messages") {
          const body = await readJson(req);
          const input = typeof body.text === "string" ? body.text.trim() : "";
          if (!input || input.length > 50000) return json(res, 400, { error: "Message must be 1–50000 characters" });
          if (/^\/(resume|clear)\b/i.test(input)) return json(res, 400, { error: "Use the task list or New task button to switch conversations" });
          if (activeTurn || scheduleDispatching || session.busy || pluginMutationBusy || (teamOwner && teamOwner !== session.id)) return json(res, 409, { error: "Another task, team or configuration operation is currently running" });
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
        const bytes = await readFile(path.join(webRoot, file));
        res.writeHead(200, {
          "content-type": MIME[route], "cache-control": "no-store",
          "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-src https: http://127.0.0.1:* http://localhost:*; object-src 'none'; base-uri 'none'",
          "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer",
        });
        return res.end(bytes);
      }
      return json(res, 404, { error: "Not found" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return json(res, message.includes("Session ") ? 404 : 400, { error: message });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  if (schedulesReady) {
    setInterval(() => { void dispatchScheduledTask().catch((error) => console.warn(`[ccagent web] Scheduled task: ${String(error)}`)); }, 10_000).unref();
    void dispatchScheduledTask();
  }
  console.log(`CCAGENT Web: http://127.0.0.1:${port}`);
  setInterval(() => {
    if (activeTurn || pluginMutationBusy || scheduleDispatching || !teamOwner || pendingNotificationCount() === 0) return;
    const session = sessions.get(teamOwner);
    if (session && !session.busy) { activeTurn = session.id; void runTurn(session, ""); }
  }, 1000).unref();
  console.log(`Workspace: ${workspace}`);
}
