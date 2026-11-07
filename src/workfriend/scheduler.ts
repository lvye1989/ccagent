import { randomUUID } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { enqueuePendingNotification } from "../state/notificationStore.js";
import { getCCAgentPath } from "../utils/paths.js";
import { isAgentEnabled, onAgentStatesChanged } from "../agents/preferences.js";
import { withFileTransaction, writeJsonAtomically } from "../utils/fileTransaction.js";

export interface WorkfriendSchedule {
  id: string;
  createdAt: string;
  checkInAt: string;
  workdayEnd: string;
  workSummary: string;
  moodSummary: string;
  assessmentSummary?: string;
  contextSummary?: string;
  cwd: string;
  status: "pending" | "fired" | "cancelled";
}

interface ScheduleFile {
  version: 1;
  schedules: WorkfriendSchedule[];
}

const timers = new Map<string, NodeJS.Timeout>();
const MAX_TIMER_DELAY = 2_147_000_000;
let schedulerStarted = false;
let wasEnabled = isAgentEnabled("workfriend");

onAgentStatesChanged(() => {
  const enabled = isAgentEnabled("workfriend");
  if (enabled === wasEnabled) return;
  wasEnabled = enabled;
  if (!enabled) clearWorkfriendTimers();
  else if (schedulerStarted) void bootstrapWorkfriendScheduler().catch((error) => {
    console.warn(`[ccagent] Workfriend reminders could not resume: ${(error as Error).message}`);
  });
});

export function getWorkfriendSchedulePath(): string {
  return getCCAgentPath("workfriend", "schedules.json");
}

async function readSchedules(): Promise<WorkfriendSchedule[]> {
  try {
    if (!(await lstat(getWorkfriendSchedulePath())).isFile()) throw new Error("Not a regular file");
    const raw = JSON.parse(await readFile(getWorkfriendSchedulePath(), "utf-8")) as Partial<ScheduleFile>;
    if (raw.version !== 1 || !Array.isArray(raw.schedules) || raw.schedules.some(item => !item ||
      typeof item.id !== "string" || typeof item.cwd !== "string" || typeof item.workdayEnd !== "string" ||
      typeof item.workSummary !== "string" || typeof item.moodSummary !== "string" ||
      typeof item.checkInAt !== "string" || !Number.isFinite(Date.parse(item.checkInAt)) ||
      !["pending", "fired", "cancelled"].includes(item.status)) || new Set(raw.schedules.map(item => item.id)).size !== raw.schedules.length) {
      throw new Error("Invalid schedules");
    }
    return raw.schedules;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error("Workfriend schedules could not be read; existing schedules were left untouched");
  }
}

async function withSchedules<T>(action: (schedules: WorkfriendSchedule[]) => T): Promise<T> {
  const filePath = getWorkfriendSchedulePath();
  return withFileTransaction(filePath, async () => {
    const schedules = await readSchedules(), before = JSON.stringify(schedules);
    const result = action(schedules);
    if (JSON.stringify(schedules) !== before) await writeJsonAtomically(filePath, { version: 1, schedules });
    return result;
  });
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function formatCheckIn(schedule: WorkfriendSchedule): string {
  return [
    "<workfriend-check-in>",
    `  <schedule_id>${schedule.id}</schedule_id>`,
    `  <workday_end>${escapeXml(schedule.workdayEnd)}</workday_end>`,
    `  <today_work>${escapeXml(schedule.workSummary)}</today_work>`,
    `  <starting_mood>${escapeXml(schedule.moodSummary)}</starting_mood>`,
    ...(schedule.assessmentSummary
      ? [`  <starting_jev_assessment>${escapeXml(schedule.assessmentSummary)}</starting_jev_assessment>`]
      : []),
    ...(schedule.contextSummary
      ? [`  <conversation_context_summary>${escapeXml(schedule.contextSummary)}</conversation_context_summary>`]
      : []),
    "  <instructions>",
    "You are Workfriend, continuing the current conversation and using the persisted context summary when a restart removed older turns. Check in warmly now, about one hour before the user's workday ends. First ask for current progress and the concrete bottlenecks or problems encountered. Then use AskUserQuestion to present a focused diagnostic card with no more than 9 questions; use 2-4 practical options per question and avoid repeating facts already known from context. After the answers, call WorkfriendAssess with phase end_of_day and only relevant user-provided evidence. Treat its Jev recommendation as the primary plan when Decision authority is jev, then give prioritized concrete suggestions plus sincere, non-judgmental encouragement. Finally use one AskUserQuestion item to let the user choose Voice or Word document, so the check-in contains no more than 10 card questions in total; call WorkfriendDeliver with the complete final report. Scores are non-clinical. If the user signals immediate danger/self-harm or WorkfriendAssess returns Safety override: yes, stop the normal workflow and encourage urgent local professional/emergency support.",
    "  </instructions>",
    "</workfriend-check-in>",
  ].join("\n");
}

async function fireSchedule(id: string): Promise<void> {
  timers.delete(id);
  const schedule = await withSchedules(schedules => {
    const item = schedules.find(item => item.id === id && item.status === "pending");
    if (!item || !isAgentEnabled("workfriend")) return null;
    item.status = "fired";
    return item;
  });
  if (!schedule) return;
  enqueuePendingNotification({
    mode: "workfriend-notification",
    text: formatCheckIn(schedule),
  });
}

function armSchedule(schedule: WorkfriendSchedule): void {
  if (!isAgentEnabled("workfriend")) return;
  if (schedule.status !== "pending" || timers.has(schedule.id)) return;
  const delay = Math.max(0, new Date(schedule.checkInAt).getTime() - Date.now());
  const timer = setTimeout(() => {
    if (delay > MAX_TIMER_DELAY) {
      timers.delete(schedule.id);
      armSchedule(schedule);
      return;
    }
    void fireSchedule(schedule.id).catch(() => console.warn("[ccagent] Workfriend reminder could not be claimed; check its schedule file."));
  }, Math.min(delay, MAX_TIMER_DELAY));
  timers.set(schedule.id, timer);
}

function parseWorkdayEnd(value: string, now = new Date()): Date {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) throw new Error("workday_end must use 24-hour HH:mm format, for example 18:00.");
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) throw new Error("workday_end is not a valid local time.");
  const end = new Date(now);
  end.setHours(hours, minutes, 0, 0);
  if (end.getTime() <= now.getTime()) end.setDate(end.getDate() + 1);
  return end;
}

export async function createWorkfriendSchedule(input: {
  workdayEnd: string;
  workSummary: string;
  moodSummary: string;
  assessmentSummary?: string;
  contextSummary?: string;
  cwd: string;
  now?: Date;
}): Promise<WorkfriendSchedule> {
  schedulerStarted = true;
  const now = input.now ?? new Date();
  const end = parseWorkdayEnd(input.workdayEnd, now);
  let checkIn = new Date(end.getTime() - 60 * 60 * 1000);
  // If the user starts Workfriend inside the last hour, check in promptly
  // instead of silently missing today's check-in.
  if (checkIn.getTime() <= now.getTime() && end.getTime() > now.getTime()) {
    checkIn = new Date(now.getTime() + 1_000);
  }
  const schedule: WorkfriendSchedule = {
    id: randomUUID(),
    createdAt: now.toISOString(),
    checkInAt: checkIn.toISOString(),
    workdayEnd: input.workdayEnd.trim(),
    workSummary: input.workSummary.trim(),
    moodSummary: input.moodSummary.trim(),
    ...(input.assessmentSummary?.trim() ? { assessmentSummary: input.assessmentSummary.trim() } : {}),
    ...(input.contextSummary?.trim() ? { contextSummary: input.contextSummary.trim() } : {}),
    cwd: input.cwd,
    status: "pending",
  };
  await withSchedules(schedules => { schedules.push(schedule); });
  armSchedule(schedule);
  return schedule;
}

export async function listWorkfriendSchedules(): Promise<WorkfriendSchedule[]> {
  return withSchedules(schedules => schedules);
}

export async function cancelWorkfriendSchedule(id: string): Promise<boolean> {
  const cancelled = await withSchedules(schedules => {
    const schedule = schedules.find(item => item.id === id && item.status === "pending");
    if (!schedule) return false;
    schedule.status = "cancelled";
    return true;
  });
  if (!cancelled) return false;
  const timer = timers.get(id);
  if (timer) clearTimeout(timer);
  timers.delete(id);
  return true;
}

export async function bootstrapWorkfriendScheduler(): Promise<number> {
  schedulerStarted = true;
  const schedules = await withSchedules(schedules => schedules);
  let pending = 0;
  for (const schedule of schedules) {
    if (schedule.status !== "pending") continue;
    pending++;
    armSchedule(schedule);
  }
  return pending;
}

/** Test-only cleanup for in-process timers. */
export function clearWorkfriendTimers(): void {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
}
