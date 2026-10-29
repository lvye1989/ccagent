import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getCCAgentPath } from "../utils/paths.js";
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

const FILE = getCCAgentPath("web-schedules.json");

export class WebScheduleStore {
  private tasks: WebScheduledTask[] = [];
  private queue: Promise<unknown> = Promise.resolve();

  async load(): Promise<void> {
    let raw: string;
    try { raw = await readFile(FILE, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") { this.tasks = []; return; }
      throw error;
    }
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.some((item) => !item || typeof item !== "object" ||
      typeof item.id !== "string" || typeof item.workspace !== "string" || typeof item.title !== "string" ||
      typeof item.prompt !== "string" || typeof item.model !== "string" || typeof item.nextRunAt !== "string" ||
      !Number.isFinite(new Date(item.nextRunAt).getTime()) ||
      !["none", "daily", "weekly"].includes(item.repeat) ||
      !["active", "running", "paused", "completed"].includes(item.status) ||
      !["default", "plan", "auto"].includes(item.mode))) {
      throw new Error("web-schedules.json is invalid; existing schedules were left untouched");
    }
    const loaded = parsed as WebScheduledTask[];
    if (loaded.some((task) => task.status === "running")) {
      const recovered = loaded.map((task) => task.status === "running"
        ? { ...task, status: "paused" as const, lastError: "Web 服务重启时任务仍在执行；请检查结果后手动继续。" }
        : task);
      await this.save(recovered);
      this.tasks = recovered;
    } else this.tasks = loaded;
  }

  list(workspace: string): WebScheduledTask[] {
    return this.tasks.filter((task) => task.workspace === workspace).map((task) => ({ ...task }))
      .sort((a, b) => a.nextRunAt.localeCompare(b.nextRunAt));
  }

  private async save(tasks: WebScheduledTask[]): Promise<void> {
    await mkdir(path.dirname(FILE), { recursive: true });
    const temporary = `${FILE}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(tasks, null, 2) + "\n", "utf8");
      await rename(temporary, FILE);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  }

  private exclusive<T>(action: () => Promise<T>): Promise<T> {
    const result = this.queue.then(action);
    this.queue = result.catch(() => {});
    return result;
  }

  add(input: Omit<WebScheduledTask, "id" | "status" | "createdAt">): Promise<WebScheduledTask> {
    return this.exclusive(async () => {
      const task: WebScheduledTask = { ...input, id: randomUUID(), status: "active", createdAt: new Date().toISOString() };
      const next = [...this.tasks, task];
      await this.save(next);
      this.tasks = next;
      return { ...task };
    });
  }

  change(id: string, workspace: string, action: "pause" | "resume" | "delete" | "run-now"): Promise<WebScheduledTask | null> {
    return this.exclusive(async () => {
      const next = this.tasks.map((task) => ({ ...task }));
      const index = next.findIndex((task) => task.id === id && task.workspace === workspace);
      if (index < 0) throw new Error("Scheduled task not found");
      if (next[index]!.status === "running") throw new Error("Wait for the scheduled task to finish");
      if (action === "delete") { next.splice(index, 1); await this.save(next); this.tasks = next; return null; }
      const task = next[index]!;
      if (action === "pause") task.status = "paused";
      if (action === "resume") task.status = "active";
      if (action === "run-now") { task.status = "active"; task.nextRunAt = new Date().toISOString(); }
      await this.save(next);
      this.tasks = next;
      return { ...task };
    });
  }

  claimDue(workspace: string, now = new Date()): Promise<WebScheduledTask | null> {
    return this.exclusive(async () => {
      const nextTasks = this.tasks.map((task) => ({ ...task }));
      const task = nextTasks.find((item) => item.workspace === workspace && item.status === "active" && new Date(item.nextRunAt).getTime() <= now.getTime());
      if (!task) return null;
      task.lastRunAt = now.toISOString();
      task.lastError = undefined;
      task.status = "running";
      if (task.repeat !== "none") {
        const period = task.repeat === "daily" ? 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000;
        let next = new Date(task.nextRunAt).getTime();
        while (next <= now.getTime()) next += period;
        task.nextRunAt = new Date(next).toISOString();
      }
      await this.save(nextTasks);
      this.tasks = nextTasks;
      return { ...task };
    });
  }

  recordResult(id: string, update: { sessionId?: string; error?: string; finished?: boolean }): Promise<void> {
    return this.exclusive(async () => {
      const next = this.tasks.map((item) => ({ ...item }));
      const task = next.find((item) => item.id === id);
      if (!task) return;
      if (update.sessionId) task.lastSessionId = update.sessionId;
      if (update.finished) {
        if (update.error) { task.lastError = update.error; task.status = "paused"; }
        else task.status = task.repeat === "none" ? "completed" : "active";
      }
      await this.save(next);
      this.tasks = next;
    });
  }
}
