import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Dirent } from "node:fs";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages.js";
import type { Usage } from "../types/message.js";
import { getProjectPathInfo } from "../context/memory/memdir.js";
import { getCCAgentHome } from "../utils/paths.js";
import { withFileTransaction, writeJsonAtomically } from "../utils/fileTransaction.js";
import { createMemoryExecutionJournal, executionHash, foldUnresolvedExecutions, recoverToolResults, type ExecutionEvent, type ExecutionRecorder, type ExecutionScope, type UnresolvedToolExecution } from "./execution.js";

const MAX_SESSIONS = 20;

/** Default transcript retention when `cleanupPeriodDays` is unset. */
export const DEFAULT_CLEANUP_PERIOD_DAYS = 30;

// ─── persistence policy (set once at startup) ────────────────────────────
//
// `cleanupPeriodDays: 0` disables session persistence entirely: no transcripts
// are written and existing ones are deleted at startup. We gate the write
// primitives on this module-level flag so every call site (queryEngine, hooks,
// compaction) honors it without threading a parameter through each one.

let persistenceEnabled = true;
const ephemeralExecutions = new Map<string, ReturnType<typeof createMemoryExecutionJournal>>();
function ephemeralJournal(cwd: string, sessionId: string) {
  const key = `${getCCAgentHome()}\0${path.resolve(cwd)}\0${sessionId}`;
  let journal = ephemeralExecutions.get(key);
  if (!journal) { journal = createMemoryExecutionJournal(); ephemeralExecutions.set(key, journal); }
  return journal;
}

/** Enable/disable transcript writes for this session (driven by cleanupPeriodDays). */
export function configureSessionPersistence(enabled: boolean): void {
  persistenceEnabled = enabled;
}

export function isSessionPersistenceEnabled(): boolean {
  return persistenceEnabled;
}

export interface SessionPaths {
  rootDir: string;
  projectDir: string;
  transcriptPath: string;
  latestPath: string;
}

export interface SessionMetadata {
  sessionId: string;
  cwd: string;
  startedAt: string;
  updatedAt: string;
  model: string;
}

export interface SessionSummary {
  sessionId: string;
  cwd: string;
  startedAt: string;
  updatedAt: string;
  model: string;
  messageCount: number;
  totalUsage: Usage;
  /** The first user prompt, used as a human-readable label (may be empty). */
  firstPrompt: string;
}

/**
 * Stage 26: serialized file-history snapshot persisted to the transcript so
 * `/rewind` survives `--resume`. Structurally matches fileHistory.ts's
 * FileHistoryBackup / FileHistorySnapshot (kept local here to avoid a
 * session↔session import cycle).
 */
export interface FileHistoryBackupRecord {
  backupFileName: string | null;
  version: number;
  backupTime: string;
}
export interface FileHistorySnapshotRecord {
  messageId: string;
  trackedFileBackups: Record<string, FileHistoryBackupRecord>;
  timestamp: string;
}

export type TranscriptEntry =
  | { type: "session_meta"; sessionId: string; cwd: string; startedAt: string; model: string }
  | { type: "message"; timestamp: string; role: "user" | "assistant"; message: MessageParam; messageId?: string; executionScope?: ExecutionScope }
  | { type: "tool_event"; timestamp: string; name: string; phase: "start" | "done"; resultLength?: number; isError?: boolean }
  | { type: "usage"; timestamp: string; turn: Usage; total: Usage }
  | { type: "model_change"; timestamp: string; model: string }
  | { type: "system"; timestamp: string; level: "info" | "error"; message: string }
  | { type: "compaction"; timestamp: string; trigger: "auto" | "manual" }
  | { type: "compaction_snapshot"; timestamp: string; trigger: "auto" | "manual"; messages: MessageParam[]; checksum: string }
  | { type: "execution"; event: ExecutionEvent }
  | { type: "file_history_snapshot"; timestamp: string; snapshot: FileHistorySnapshotRecord };

export interface RestoredSession {
  summary: SessionSummary;
  messages: MessageParam[];
  /** Reconstructed file-history snapshots (chronological), if any. */
  fileHistorySnapshots: FileHistorySnapshotRecord[];
  /** Tools with no durable result are shown as unknown; they are never replayed. */
  unknownToolIds: string[];
}

function createEmptyUsage(): Usage {
  return {
    input_tokens: 0,
    output_tokens: 0,
  };
}

function isUsage(value: unknown): value is Usage {
  if (!value || typeof value !== "object") return false;
  const usage = value as Record<string, unknown>;
  return typeof usage.input_tokens === "number" && typeof usage.output_tokens === "number";
}

function isMessageParam(value: unknown): value is MessageParam {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (record.role === "user" || record.role === "assistant") && "content" in record;
}

function parseJsonLine(line: string): TranscriptEntry | null {
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;

    if (parsed.type === "execution") {
      const event = parsed.event as ExecutionEvent | undefined;
      if (event && typeof event.id === "string" && typeof event.timestamp === "string"
        && typeof event.turnId === "string" && typeof event.phase === "string" && typeof event.step === "number") {
        return { type: "execution", event };
      }
      return null;
    }
    if (parsed.type === "compaction_snapshot") {
      if (typeof parsed.timestamp === "string" && (parsed.trigger === "auto" || parsed.trigger === "manual")
        && Array.isArray(parsed.messages) && parsed.messages.every(isMessageParam)
        && parsed.checksum === executionHash(parsed.messages)) {
        return { type: "compaction_snapshot", timestamp: parsed.timestamp, trigger: parsed.trigger,
          messages: parsed.messages, checksum: parsed.checksum as string };
      }
      return null;
    }

    if (parsed.type === "session_meta") {
      if (
        typeof parsed.sessionId === "string" &&
        typeof parsed.cwd === "string" &&
        typeof parsed.startedAt === "string" &&
        typeof parsed.model === "string"
      ) {
        return {
          type: "session_meta",
          sessionId: parsed.sessionId,
          cwd: parsed.cwd,
          startedAt: parsed.startedAt,
          model: parsed.model,
        };
      }
      return null;
    }

    if (parsed.type === "message") {
      if (
        typeof parsed.timestamp === "string" &&
        (parsed.role === "user" || parsed.role === "assistant") &&
        isMessageParam(parsed.message)
      ) {
        return {
          type: "message",
          timestamp: parsed.timestamp,
          role: parsed.role,
          message: parsed.message,
          // Optional for back-compat: transcripts written before stage 26
          // (file history) have no per-message id. Snapshots bind to this
          // id, so resume relies on it being preserved when present.
          ...(typeof parsed.messageId === "string" ? { messageId: parsed.messageId } : {}),
          ...(parsed.executionScope && typeof (parsed.executionScope as ExecutionScope).turnId === "string" ? { executionScope: parsed.executionScope as ExecutionScope } : {}),
        };
      }
      return null;
    }

    if (parsed.type === "tool_event") {
      if (
        typeof parsed.timestamp === "string" &&
        typeof parsed.name === "string" &&
        (parsed.phase === "start" || parsed.phase === "done")
      ) {
        return {
          type: "tool_event",
          timestamp: parsed.timestamp,
          name: parsed.name,
          phase: parsed.phase,
          ...(typeof parsed.resultLength === "number" ? { resultLength: parsed.resultLength } : {}),
          ...(typeof parsed.isError === "boolean" ? { isError: parsed.isError } : {}),
        };
      }
      return null;
    }

    if (parsed.type === "usage") {
      if (typeof parsed.timestamp === "string" && isUsage(parsed.turn) && isUsage(parsed.total)) {
        return {
          type: "usage",
          timestamp: parsed.timestamp,
          turn: parsed.turn,
          total: parsed.total,
        };
      }
      return null;
    }

    if (parsed.type === "model_change") {
      if (typeof parsed.timestamp === "string" && typeof parsed.model === "string" && parsed.model.trim()) {
        return { type: "model_change", timestamp: parsed.timestamp, model: parsed.model };
      }
      return null;
    }

    if (parsed.type === "system") {
      if (
        typeof parsed.timestamp === "string" &&
        (parsed.level === "info" || parsed.level === "error") &&
        typeof parsed.message === "string"
      ) {
        return {
          type: "system",
          timestamp: parsed.timestamp,
          level: parsed.level,
          message: parsed.message,
        };
      }
      return null;
    }

    if (parsed.type === "compaction") {
      if (
        typeof parsed.timestamp === "string" &&
        (parsed.trigger === "auto" || parsed.trigger === "manual")
      ) {
        return {
          type: "compaction",
          timestamp: parsed.timestamp,
          trigger: parsed.trigger,
        };
      }
      return null;
    }

    if (parsed.type === "file_history_snapshot") {
      const snap = parsed.snapshot as Record<string, unknown> | undefined;
      if (
        typeof parsed.timestamp === "string" &&
        snap &&
        typeof snap === "object" &&
        typeof snap.messageId === "string" &&
        typeof snap.trackedFileBackups === "object" &&
        snap.trackedFileBackups !== null &&
        typeof snap.timestamp === "string"
      ) {
        return {
          type: "file_history_snapshot",
          timestamp: parsed.timestamp,
          snapshot: snap as unknown as FileHistorySnapshotRecord,
        };
      }
      return null;
    }

    return null;
  } catch {
    return null;
  }
}

function getLastUpdatedAt(entries: TranscriptEntry[], fallback: string): string {
  const latest = [...entries]
    .reverse()
    .find((entry): entry is Extract<TranscriptEntry, { timestamp: string }> => "timestamp" in entry);

  return latest?.timestamp ?? fallback;
}

/**
 * The first user prompt of a session, used as its human-readable label in the
 * `/resume` picker (mirrors source's per-session firstPrompt). XML command/skill
 * markers are stripped so a `/foo` invocation shows its text, not raw tags.
 */
function extractFirstPrompt(messages: MessageParam[]): string {
  const firstUser = messages.find((m) => m.role === "user");
  if (!firstUser) return "";
  const content = firstUser.content;
  let text = "";
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .filter((block) => (block as { type?: string }).type === "text")
      .map((block) => (block as { text?: string }).text ?? "")
      .join(" ");
  }
  return text
    .replace(/<[^>]+>/g, " ")
    .replace(/^\[(?:skill|command)_invocation:[^\]]*\]\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function createSessionId(): string {
  return crypto.randomUUID();
}

export async function getProjectHash(cwd: string): Promise<string> {
  const info = await getProjectPathInfo(cwd);
  return info.projectKey;
}

export async function getSessionPaths(cwd: string, sessionId: string): Promise<SessionPaths> {
  const info = await getProjectPathInfo(cwd);
  return {
    rootDir: getCCAgentHome(),
    projectDir: info.projectDir,
    transcriptPath: path.join(info.projectDir, `${sessionId}.jsonl`),
    latestPath: path.join(info.projectDir, "latest"),
  };
}

const PINNED_FILE = "pinned-sessions.json";
const SESSION_ID_PATTERN = /^[0-9a-f-]{36}$/;

export async function listPinnedSessionIds(cwd: string): Promise<string[]> {
  const { projectDir } = await getSessionPaths(cwd, "placeholder");
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(path.join(projectDir, PINNED_FILE), "utf8"));
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string" && SESSION_ID_PATTERN.test(value)) : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function setSessionPinned(cwd: string, sessionId: string, pinned: boolean): Promise<void> {
  if (!SESSION_ID_PATTERN.test(sessionId)) throw new Error("Invalid session id");
  const { projectDir, transcriptPath } = await getSessionPaths(cwd, sessionId);
  if (!(await fs.stat(transcriptPath)).isFile()) throw new Error("Session transcript not found");
  const ids = new Set(await listPinnedSessionIds(cwd));
  if (pinned) ids.add(sessionId);
  else ids.delete(sessionId);
  await fs.writeFile(path.join(projectDir, PINNED_FILE), JSON.stringify([...ids], null, 2) + "\n", "utf8");
}

export async function deleteStoredSession(cwd: string, sessionId: string, allowMissing = false): Promise<void> {
  if (!SESSION_ID_PATTERN.test(sessionId)) throw new Error("Invalid session id");
  const { transcriptPath, latestPath } = await getSessionPaths(cwd, sessionId);
  await fs.unlink(transcriptPath).catch((error: NodeJS.ErrnoException) => {
    if (!allowMissing || error.code !== "ENOENT") throw error;
  });
  await fs.rm(summaryPath(transcriptPath), { force: true });
  const pinned = new Set(await listPinnedSessionIds(cwd));
  if (pinned.delete(sessionId)) {
    await fs.writeFile(path.join(path.dirname(transcriptPath), PINNED_FILE), JSON.stringify([...pinned], null, 2) + "\n", "utf8");
  }
  const latest = await fs.readFile(latestPath, "utf8").then((value) => value.trim(), () => "");
  if (latest === sessionId) {
    const next = (await listProjectSessions(cwd, 1))[0]?.sessionId;
    if (next) await fs.writeFile(latestPath, `${next}\n`, "utf8");
    else await fs.rm(latestPath, { force: true });
  }
}

async function ensureSessionDir(paths: SessionPaths): Promise<void> {
  await fs.mkdir(paths.projectDir, { recursive: true });
}

export async function initSessionStorage(metadata: SessionMetadata): Promise<SessionPaths> {
  const paths = await getSessionPaths(metadata.cwd, metadata.sessionId);
  // Persistence disabled (cleanupPeriodDays:0): return valid paths so the UI
  // keeps working, but never touch disk — no dir, no transcript, no pointer.
  if (!persistenceEnabled) return paths;
  await ensureSessionDir(paths);

  const metaEntry: TranscriptEntry = {
    type: "session_meta",
    sessionId: metadata.sessionId,
    cwd: metadata.cwd,
    startedAt: metadata.startedAt,
    model: metadata.model,
  };

  await appendJournalEntries(paths, [metaEntry]);
  await fs.writeFile(paths.latestPath, `${metadata.sessionId}\n`, "utf-8");
  return paths;
}

/**
 * Stage 26: persist a file-history snapshot to the transcript. Called by
 * fileHistory.ts whenever a snapshot is created (makeSnapshot) or updated
 * (trackEdit). On `--resume`, restoreSession folds these back into the
 * in-memory FileHistoryState so `/rewind` keeps working. No-op when
 * persistence is disabled (handled by appendTranscriptEntry).
 */
export async function recordFileHistorySnapshot(
  cwd: string,
  sessionId: string,
  snapshot: FileHistorySnapshotRecord,
): Promise<void> {
  await appendTranscriptEntry(cwd, sessionId, {
    type: "file_history_snapshot",
    timestamp: new Date().toISOString(),
    snapshot,
  });
}

export async function appendTranscriptEntry(cwd: string, sessionId: string, entry: TranscriptEntry): Promise<void> {
  if (!persistenceEnabled) return;
  const paths = await getSessionPaths(cwd, sessionId);
  await ensureSessionDir(paths);
  await appendJournalEntries(paths, [entry]);
  await fs.writeFile(paths.latestPath, `${sessionId}\n`, "utf-8");
}

async function readTranscriptEntries(filePath: string): Promise<TranscriptEntry[]> {
  const raw = await fs.readFile(filePath, "utf-8");
  const lines = raw.split(/\r?\n/);
  const entries: TranscriptEntry[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!.trim();
    if (!line) continue;
    try { JSON.parse(line); }
    catch {
      // Only a torn final write is recoverable. Interior corruption must be
      // reported instead of silently hiding arbitrary parts of a conversation.
      if (index === lines.length - 1) break;
      throw new Error(`Session transcript contains invalid JSON at line ${index + 1}. The original file was retained.`);
    }
    const entry = parseJsonLine(line);
    if (entry) entries.push(entry);
  }
  return entries;
}

interface SessionIndex {
  version: 2;
  size: number;
  mtimeMs: number;
  summary: SessionSummary;
  pendingExecutions: UnresolvedToolExecution[];
}
const summaryPath = (file: string) => `${file}.summary.json`;

function legacyUnresolvedExecutions(entries: TranscriptEntry[]): UnresolvedToolExecution[] {
  const messages = entries.filter((entry): entry is Extract<TranscriptEntry, { type: "message" }> => entry.type === "message");
  const pending: UnresolvedToolExecution[] = [];
  for (let index = 0; index < messages.length; index++) {
    const entry = messages[index]!;
    if (entry.executionScope || entry.message.role !== "assistant" || !Array.isArray(entry.message.content)) continue;
    const next = messages[index + 1]?.message;
    const paired = new Set(next?.role === "user" && Array.isArray(next.content)
      ? next.content.filter(block => block.type === "tool_result").map(block => block.tool_use_id) : []);
    for (const call of entry.message.content) if (call.type === "tool_use" && !paired.has(call.id)) pending.push({
      key: `legacy/${index}/${call.id}`, toolName: call.name, toolUseId: call.id, inputHash: executionHash(call.input),
    });
  }
  return pending;
}

function foldSummary(summary: SessionSummary | null, entry: TranscriptEntry): SessionSummary | null {
  if (entry.type === "session_meta") return summary ?? {
    sessionId: entry.sessionId, cwd: entry.cwd, startedAt: entry.startedAt, updatedAt: entry.startedAt,
    model: entry.model, messageCount: 0, totalUsage: createEmptyUsage(), firstPrompt: "",
  };
  if (!summary) return null;
  const next = { ...summary };
  if ("timestamp" in entry) next.updatedAt = entry.timestamp;
  if (entry.type === "execution") next.updatedAt = entry.event.timestamp;
  if (entry.type === "model_change") next.model = entry.model;
  if (entry.type === "usage") next.totalUsage = entry.total;
  const messages = entry.type === "message" ? [entry.message] : entry.type === "compaction_snapshot" ? entry.messages : [];
  next.messageCount += messages.length;
  if (!next.firstPrompt) next.firstPrompt = extractFirstPrompt(messages).slice(0, 500);
  return next;
}

async function cachedIndex(file: string, stat: { size: number; mtimeMs: number }): Promise<SessionIndex | null> {
  try {
    const index = JSON.parse(await fs.readFile(summaryPath(file), "utf8")) as SessionIndex;
    if (index.version === 2 && index.size === stat.size && index.mtimeMs === stat.mtimeMs && Array.isArray(index.pendingExecutions)
      && index.summary && typeof index.summary.sessionId === "string" && typeof index.summary.updatedAt === "string"
      && typeof index.summary.messageCount === "number" && isUsage(index.summary.totalUsage)) return index;
  } catch { /* Old/missing/stale indexes are rebuilt once from the journal. */ }
  return null;
}

async function cachedSummary(file: string, stat: { size: number; mtimeMs: number }): Promise<SessionSummary | null> {
  return (await cachedIndex(file, stat))?.summary ?? null;
}

async function publishSummary(file: string, summary: SessionSummary | null, pendingExecutions: UnresolvedToolExecution[] = []): Promise<void> {
  if (!summary) return;
  const stat = await fs.stat(file);
  await writeJsonAtomically(summaryPath(file), { version: 2, size: stat.size, mtimeMs: stat.mtimeMs, summary, pendingExecutions } satisfies SessionIndex);
}

/** Preserve the torn bytes for diagnostics, then append only at a complete boundary. */
async function repairTranscriptTail(file: string): Promise<void> {
  const handle = await fs.open(file, "r+").catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return fs.open(file, "wx+", 0o600);
  });
  try {
    const { size } = await handle.stat();
    if (!size) return;
    const last = Buffer.alloc(1);
    await handle.read(last, 0, 1, size - 1);
    if (last[0] === 10) return;
    let offset = size;
    const chunks: Buffer[] = [];
    while (offset > 0) {
      const length = Math.min(offset, 64 * 1024);
      offset -= length;
      const chunk = Buffer.alloc(length);
      await handle.read(chunk, 0, length, offset);
      const newline = chunk.lastIndexOf(10);
      if (newline >= 0) { chunks.unshift(chunk.subarray(newline + 1)); offset += newline + 1; break; }
      chunks.unshift(chunk);
    }
    const tail = Buffer.concat(chunks);
    let complete = false;
    try { JSON.parse(tail.toString("utf8")); complete = true; } catch { /* Torn JSON suffix. */ }
    if (complete) await handle.write(Buffer.from("\n"), 0, 1, size);
    else {
      await fs.writeFile(`${file}.interrupted-${crypto.randomUUID()}.tail`, tail, { mode: 0o600, flag: "wx" });
      await handle.truncate(offset);
    }
    await handle.sync();
  } finally { await handle.close(); }
}

/** One cross-process journal transaction; metadata is an invalidatable cache. */
async function appendJournalEntries(paths: SessionPaths, entries: TranscriptEntry[]): Promise<void> {
  await withFileTransaction(paths.transcriptPath, async () => {
    await repairTranscriptTail(paths.transcriptPath);
    let before = await fs.stat(paths.transcriptPath);
    let cached = await cachedIndex(paths.transcriptPath, before);
    // Old writers could stop after their standalone compaction marker. Drop
    // that uncommitted boundary before a new user message can follow it.
    if (!cached) {
    const tailHandle = await fs.open(paths.transcriptPath, "r+");
    try {
      const { size } = await tailHandle.stat();
      const length = Math.min(size, 64 * 1024), tail = Buffer.alloc(length);
      await tailHandle.read(tail, 0, length, size - length);
      let end = tail.length;
      while (end && (tail[end - 1] === 10 || tail[end - 1] === 13)) end--;
      const start = tail.lastIndexOf(10, end - 1) + 1;
      if (end && (start > 0 || size === length)) {
        let danglingMarker = false;
        try { danglingMarker = (JSON.parse(tail.subarray(start, end).toString("utf8")) as { type?: string }).type === "compaction"; }
        catch { /* The damaged suffix was repaired above. */ }
        if (danglingMarker) { await tailHandle.truncate(size - length + start); await tailHandle.sync(); }
      }
    } finally { await tailHandle.close(); }
    before = await fs.stat(paths.transcriptPath);
    cached = await cachedIndex(paths.transcriptPath, before);
    }
    let summary = cached?.summary ?? null;
    let pending = cached?.pendingExecutions ?? [];
    const handle = await fs.open(paths.transcriptPath, "a", 0o600);
    try {
      await handle.appendFile(entries.map(entry => JSON.stringify(entry)).join("\n") + "\n", "utf8");
      await handle.sync();
    } finally { await handle.close(); }
    const updates = summary ? entries : await readTranscriptEntries(paths.transcriptPath);
    if (!cached) pending = legacyUnresolvedExecutions(updates);
    for (const entry of updates) {
      summary = foldSummary(summary, entry);
      if (entry.type === "execution") pending = foldUnresolvedExecutions(pending, entry.event);
    }
    // The journal is authoritative. Index failure must not duplicate a
    // successfully appended side effect record when an entrypoint retries.
    await publishSummary(paths.transcriptPath, summary, pending).catch(() => {});
  });
}

export function createExecutionRecorder(cwd: string, sessionId: string): ExecutionRecorder {
  return event => persistenceEnabled ? appendTranscriptEntry(cwd, sessionId, { type: "execution", event })
    : ephemeralJournal(cwd, sessionId).recordExecutionEvent(event);
}

export function createExecutionReplayFence(cwd: string, sessionId: string): NonNullable<import("../tools/Tool.js").ToolContext["findUnresolvedExecutions"]> {
  return async (toolName, inputHash) => {
    if (!persistenceEnabled) return ephemeralJournal(cwd, sessionId).findUnresolvedExecutions(toolName, inputHash);
    const { transcriptPath } = await getSessionPaths(cwd, sessionId);
    const cached = await cachedIndex(transcriptPath, await fs.stat(transcriptPath));
    let pending = cached?.pendingExecutions;
    if (!pending) {
      pending = [];
      const entries = await readTranscriptEntries(transcriptPath);
      pending = legacyUnresolvedExecutions(entries);
      for (const entry of entries) if (entry.type === "execution") pending = foldUnresolvedExecutions(pending, entry.event);
    }
    return pending.filter(item => item.toolName === toolName && item.inputHash === inputHash);
  };
}

export async function readSessionExecutionEvents(cwd: string, sessionId: string): Promise<ExecutionEvent[]> {
  const paths = await getSessionPaths(cwd, sessionId);
  return (await readTranscriptEntries(paths.transcriptPath))
    .filter((entry): entry is Extract<TranscriptEntry, { type: "execution" }> => entry.type === "execution").map(entry => entry.event);
}

/** Skip message bodies when looking up billing metadata in a long transcript. */
export async function findSessionBillingEvent(cwd: string, sessionId: string, requestId?: string): Promise<ExecutionEvent | undefined> {
  if (!persistenceEnabled) return undefined;
  const { transcriptPath } = await getSessionPaths(cwd, sessionId);
  let handle;
  try { handle = await fs.open(transcriptPath, "r"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  let selected: ExecutionEvent | undefined;
  try {
    for await (const line of handle.readLines()) {
      if (!line.includes('"platformReceipt":')) continue;
      const entry = parseJsonLine(line);
      if (entry?.type !== "execution" || !entry.event.platformReceipt) continue;
      const { logicalRequestId, actualRequestId } = entry.event.platformReceipt;
      if (requestId ? requestId === logicalRequestId || requestId === actualRequestId : entry.event.status !== "reconciled") {
        selected = entry.event;
      }
    }
    return selected;
  } finally { await handle.close(); }
}

export async function getLatestSessionId(cwd: string): Promise<string | null> {
  const { latestPath } = await getSessionPaths(cwd, "placeholder");
  try {
    const value = (await fs.readFile(latestPath, "utf-8")).trim();
    return value || null;
  } catch (error: unknown) {
    const err = error as NodeJS.ErrnoException;
    if (err?.code === "ENOENT") return null;
    throw error;
  }
}

export async function restoreSession(cwd: string, sessionId?: string): Promise<RestoredSession> {
  const resolvedSessionId = sessionId ?? (await getLatestSessionId(cwd));
  if (!resolvedSessionId) {
    throw new Error("No saved session found for this project.");
  }

  const { transcriptPath } = await getSessionPaths(cwd, resolvedSessionId);
  const entries = await readTranscriptEntries(transcriptPath);
  if (entries.length === 0) {
    throw new Error(`Session ${resolvedSessionId} is empty or unreadable.`);
  }

  const meta = entries.find((entry): entry is Extract<TranscriptEntry, { type: "session_meta" }> => entry.type === "session_meta");
  if (!meta) {
    throw new Error(`Session ${resolvedSessionId} is missing session metadata.`);
  }

  let messages: MessageParam[] = [];
  let messageScopes: Array<ExecutionScope | undefined> = [];
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!;
    if (entry.type === "compaction_snapshot") { messages = [...entry.messages]; messageScopes = entry.messages.map(() => undefined); }
    // Legacy journals used multi-line checkpoints. A marker without any
    // complete following message is not a committed replacement history.
    else if (entry.type === "compaction" && entries[index + 1]?.type === "message") { messages = []; messageScopes = []; }
    else if (entry.type === "message") { messages.push(entry.message); messageScopes.push(entry.executionScope); }
  }
  const executionEvents = entries.filter((entry): entry is Extract<TranscriptEntry, { type: "execution" }> => entry.type === "execution").map(entry => entry.event);
  const recovered = recoverToolResults(messages, executionEvents, meta.sessionId, messageScopes);
  messages = recovered.messages;

  const latestUsage = [...entries]
    .reverse()
    .find((entry): entry is Extract<TranscriptEntry, { type: "usage" }> => entry.type === "usage");
  const latestModel = [...entries]
    .reverse()
    .find((entry): entry is Extract<TranscriptEntry, { type: "model_change" }> => entry.type === "model_change");

  // Rebuild the file-history snapshot chain: keep the LAST record per
  // messageId (trackEdit appends updated copies of the most-recent snapshot
  // after makeSnapshot creates it), preserving first-appearance order so the
  // snapshots array stays chronological. Mirrors source's
  // buildFileHistorySnapshotChain.
  const fhMap = new Map<string, FileHistorySnapshotRecord>();
  for (const entry of entries) {
    if (entry.type === "file_history_snapshot") {
      fhMap.set(entry.snapshot.messageId, entry.snapshot);
    }
  }

  return {
    summary: {
      sessionId: meta.sessionId,
      cwd: meta.cwd,
      startedAt: meta.startedAt,
      updatedAt: getLastUpdatedAt(entries, meta.startedAt),
      model: latestModel?.model ?? meta.model,
      messageCount: messages.length,
      totalUsage: latestUsage?.total ?? createEmptyUsage(),
      firstPrompt: extractFirstPrompt(messages),
    },
    messages,
    fileHistorySnapshots: [...fhMap.values()],
    unknownToolIds: [...new Set([...recovered.unknownToolIds, ...executionEvents.reduce(foldUnresolvedExecutions, [] as UnresolvedToolExecution[]).map(item => item.toolUseId)])],
  };
}

export async function appendCompactionSnapshot(
  cwd: string,
  sessionId: string,
  trigger: "auto" | "manual",
  messages: MessageParam[],
): Promise<void> {
  if (!persistenceEnabled) return;
  const paths = await getSessionPaths(cwd, sessionId);
  await ensureSessionDir(paths);
  // A checkpoint is one checksummed record. A torn write cannot publish its
  // boundary separately from its messages and hide the previous history.
  await appendJournalEntries(paths, [{ type: "compaction_snapshot", timestamp: new Date().toISOString(),
    trigger, messages, checksum: executionHash(messages) }]);
}

/**
 * Apply the `cleanupPeriodDays` retention policy at startup. Reads the merged
 * setting (default 30), sets the persistence flag, and prunes this project's
 * transcript directory:
 *
 *   - `0`             → persistence OFF. Delete ALL transcripts + the `latest`
 *                       pointer for this project; future writes no-op.
 *   - `N > 0`         → delete `*.jsonl` whose mtime is older than N days.
 *   - unset / invalid → default 30 days.
 *
 * Best-effort: a read/delete failure never blocks startup.
 */
export async function applySessionRetentionPolicy(cwd: string): Promise<{ periodDays: number; enabled: boolean }> {
  let periodDays = DEFAULT_CLEANUP_PERIOD_DAYS;
  try {
    const { readMergedNumberSetting } = await import("../utils/settings.js");
    const configured = await readMergedNumberSetting(cwd, "cleanupPeriodDays");
    if (typeof configured === "number" && Number.isFinite(configured) && configured >= 0) {
      periodDays = Math.floor(configured);
    }
  } catch {
    // keep default
  }

  const enabled = periodDays !== 0;
  configureSessionPersistence(enabled);

  try {
    const { projectDir, latestPath } = await getSessionPaths(cwd, "placeholder");
    let entries: Dirent[];
    try {
      entries = await fs.readdir(projectDir, { withFileTypes: true });
    } catch (error: unknown) {
      const err = error as NodeJS.ErrnoException;
      if (err?.code === "ENOENT") return { periodDays, enabled };
      throw error;
    }

    const cutoffMs = Date.now() - periodDays * 24 * 60 * 60 * 1000;
    const pinned = periodDays === 0 ? new Set<string>() : new Set(await listPinnedSessionIds(cwd));
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      if (pinned.has(entry.name.slice(0, -6))) continue;
      const filePath = path.join(projectDir, entry.name);
      if (periodDays === 0) {
        await fs.rm(filePath, { force: true }).catch(() => {});
        await fs.rm(summaryPath(filePath), { force: true }).catch(() => {});
        continue;
      }
      try {
        const stat = await fs.stat(filePath);
        if (stat.mtimeMs < cutoffMs) {
          await fs.rm(filePath, { force: true }).catch(() => {});
          await fs.rm(summaryPath(filePath), { force: true }).catch(() => {});
        }
      } catch {
        // skip files we can't stat
      }
    }

    // With persistence off, drop the dangling `latest` pointer too so a stray
    // --resume doesn't try to restore a transcript we just deleted.
    if (periodDays === 0) {
      await fs.rm(latestPath, { force: true }).catch(() => {});
    }
  } catch {
    // best-effort cleanup
  }

  return { periodDays, enabled };
}

export async function listProjectSessions(cwd: string, limit = MAX_SESSIONS): Promise<SessionSummary[]> {
  const projectDir = (await getSessionPaths(cwd, "placeholder")).projectDir;
  let entries: Dirent[];

  try {
    entries = await fs.readdir(projectDir, { withFileTypes: true });
  } catch (error: unknown) {
    const err = error as NodeJS.ErrnoException;
    if (err?.code === "ENOENT") return [];
    throw error;
  }

  const sessionFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => path.join(projectDir, entry.name));

  const sessions: Array<SessionSummary | null> = [];
  // Bound IO even for legacy projects with many sessions. Normal listing
  // reads only small summary files; a changed/legacy journal rebuilds once.
  for (let offset = 0; offset < sessionFiles.length; offset += 8) {
    sessions.push(...await Promise.all(sessionFiles.slice(offset, offset + 8).map(async filePath => {
      try {
        const cached = await cachedSummary(filePath, await fs.stat(filePath));
        if (cached) return cached;
        return await withFileTransaction(filePath, async () => {
          const current = await cachedSummary(filePath, await fs.stat(filePath));
          if (current) return current;
          let summary: SessionSummary | null = null;
          let pending: UnresolvedToolExecution[] = [];
          const entries = await readTranscriptEntries(filePath);
          pending = legacyUnresolvedExecutions(entries);
          for (const entry of entries) {
            summary = foldSummary(summary, entry);
            if (entry.type === "execution") pending = foldUnresolvedExecutions(pending, entry.event);
          }
          await publishSummary(filePath, summary, pending).catch(() => {});
          return summary;
        });
      } catch { return null; } // One locked/corrupt transcript cannot hide all tasks.
    })));
  }

  return sessions
    .filter((session): session is SessionSummary => session !== null)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, limit);
}
