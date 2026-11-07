import { lstat, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { getCCAgentPath } from "../utils/paths.js";
import { withFileTransaction, writeJsonAtomically } from "../utils/fileTransaction.js";
import type { PermissionMode } from "../permissions/permissions.js";

export type WebScheduleRepeat = "none" | "daily" | "weekly";
export type WebScheduleStatus = "active" | "running" | "paused" | "completed";
export interface WebScheduledTask {
  id: string;
  workspace: string;
  title: string;
  prompt: string;
  nextRunAt: string;
  repeat: WebScheduleRepeat;
  status: WebScheduleStatus;
  model: string;
  mode: PermissionMode;
  createdAt: string;
  lastRunAt?: string;
  lastSessionId?: string;
  lastError?: string;
}

interface ClaimedWebTask extends WebScheduledTask { runId: string }

type RunOwner = { processId: number; instance: string; claim: string };
type StoredTask = WebScheduledTask & { runOwner?: RunOwner };
const localInstances = new Set<string>();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function publicTask(task: StoredTask): WebScheduledTask {
  const { runOwner: _owner, ...result } = task;
  return result;
}

function ownerAlive(owner: RunOwner | undefined): boolean {
  if (!owner) return false;
  if (owner.processId === process.pid) return localInstances.has(owner.instance);
  try { process.kill(owner.processId, 0); return true; }
  catch (error) {
    // Permission errors or uncertain OS results cannot authorize another execution.
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

export class WebScheduleStore {
  private readonly file = getCCAgentPath("web-schedules.json");
  private readonly instance = randomUUID();
  private queue: Promise<unknown> = Promise.resolve();

  constructor() { localInstances.add(this.instance); }

  private async read(): Promise<StoredTask[]> {
    let raw: string;
    try {
      if (!(await lstat(this.file)).isFile()) throw new Error("Schedule target must be a regular file");
      raw = await readFile(this.file, "utf8");
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.some((item) => !item || typeof item !== "object" ||
      typeof item.id !== "string" || !uuid.test(item.id) || typeof item.workspace !== "string" || typeof item.title !== "string" ||
      typeof item.prompt !== "string" || typeof item.model !== "string" || typeof item.nextRunAt !== "string" ||
      !Number.isFinite(new Date(item.nextRunAt).getTime()) ||
      !["none", "daily", "weekly"].includes(item.repeat) ||
      !["active", "running", "paused", "completed"].includes(item.status) ||
      !["default", "plan", "auto"].includes(item.mode) ||
      (item.runOwner !== undefined && (!item.runOwner || !Number.isSafeInteger(item.runOwner.processId) || item.runOwner.processId <= 0 ||
        typeof item.runOwner.instance !== "string" || !uuid.test(item.runOwner.instance) || typeof item.runOwner.claim !== "string" || !uuid.test(item.runOwner.claim)))) ||
      new Set(parsed.map(item => item.id)).size !== parsed.length) {
      throw new Error("web-schedules.json is invalid; existing schedules were left untouched");
    }
    return parsed as StoredTask[];
  }

  async load(): Promise<void> { await this.exclusive(() => {}); }

  list(workspace: string): Promise<WebScheduledTask[]> {
    return this.exclusive(tasks => tasks.filter(task => task.workspace === workspace).map(publicTask)
      .sort((a, b) => a.nextRunAt.localeCompare(b.nextRunAt)));
  }

  private exclusive<T>(action: (tasks: StoredTask[]) => T | Promise<T>): Promise<T> {
    const result = this.queue.then(() => withFileTransaction(this.file, async () => {
      const tasks = await this.read(), before = JSON.stringify(tasks);
      for (const task of tasks) {
        if (task.status === "running" && !ownerAlive(task.runOwner)) {
          task.status = "paused";
          task.lastError = "执行实例已关闭或任务来自旧版本；请检查结果后手动继续，不会自动重复执行。";
          delete task.runOwner;
        }
      }
      const value = await action(tasks);
      if (JSON.stringify(tasks) !== before) await writeJsonAtomically(this.file, tasks);
      return value;
    }));
    this.queue = result.catch(() => {});
    return result;
  }

  add(input: Omit<WebScheduledTask, "id" | "status" | "createdAt">): Promise<WebScheduledTask> {
    return this.exclusive(tasks => {
      const task: WebScheduledTask = { ...input, id: randomUUID(), status: "active", createdAt: new Date().toISOString() };
      tasks.push(task);
      return { ...task };
    });
  }

  change(id: string, workspace: string, action: "pause" | "resume" | "delete" | "run-now"): Promise<WebScheduledTask | null> {
    return this.exclusive(next => {
      const index = next.findIndex((task) => task.id === id && task.workspace === workspace);
      if (index < 0) throw new Error("Scheduled task not found");
      if (next[index]!.status === "running") throw new Error("Wait for the scheduled task to finish in its current window");
      if (action === "delete") { next.splice(index, 1); return null; }
      const task = next[index]!;
      if (action === "pause") task.status = "paused";
      if (action === "resume") task.status = "active";
      if (action === "run-now") { task.status = "active"; task.nextRunAt = new Date().toISOString(); }
      return publicTask(task);
    });
  }

  async claimDue(workspace: string, now = new Date()): Promise<ClaimedWebTask | null> {
    const claim = randomUUID();
    const claimed = await this.exclusive(nextTasks => {
      if (nextTasks.some(item => item.workspace === workspace && item.status === "running")) return null;
      const task = nextTasks.filter(item => item.workspace === workspace && item.status === "active" && new Date(item.nextRunAt).getTime() <= now.getTime())
        .sort((a, b) => a.nextRunAt.localeCompare(b.nextRunAt))[0];
      if (!task) return null;
      task.lastRunAt = now.toISOString();
      task.lastError = undefined;
      task.status = "running";
      task.runOwner = { processId: process.pid, instance: this.instance, claim };
      if (task.repeat !== "none") {
        const period = task.repeat === "daily" ? 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000;
        const previous = new Date(task.nextRunAt).getTime();
        task.nextRunAt = new Date(previous + (Math.floor((now.getTime() - previous) / period) + 1) * period).toISOString();
      }
      return publicTask(task);
    });
    return claimed ? { ...claimed, runId: claim } : null;
  }

  async recordResult(id: string, runId: string, update: { sessionId?: string; error?: string; finished?: boolean }): Promise<void> {
    await this.exclusive(tasks => {
      const task = tasks.find(item => item.id === id);
      if (!task) return;
      if (task.status !== "running" || task.runOwner?.instance !== this.instance || task.runOwner.claim !== runId) {
        throw new Error("Only the instance that claimed this scheduled task can update its result");
      }
      if (update.sessionId) task.lastSessionId = update.sessionId;
      if (update.finished) {
        if (update.error) { task.lastError = update.error; task.status = "paused"; }
        else task.status = task.repeat === "none" ? "completed" : "active";
        delete task.runOwner;
      }
    });
  }
}
