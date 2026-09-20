import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { enqueuePendingNotification } from "../state/notificationStore.js";
import { getCCAgentPath } from "../utils/paths.js";

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

export function getWorkfriendSchedulePath(): string {
  return getCCAgentPath("workfriend", "schedules.json");
}

async function readSchedules(): Promise<WorkfriendSchedule[]> {
  try {
    const raw = JSON.parse(await readFile(getWorkfriendSchedulePath(), "utf-8")) as Partial<ScheduleFile>;
    return Array.isArray(raw.schedules) ? raw.schedules : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error(`Could not read Workfriend schedules: ${(error as Error).message}`);
  }
}

async function writeSchedules(schedules: WorkfriendSchedule[]): Promise<void> {
  const filePath = getWorkfriendSchedulePath();
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify({ version: 1, schedules }, null, 2) + "\n", {
    encoding: "utf-8",
    mode: 0o600,
  });
  if (process.platform !== "win32") await chmod(filePath, 0o600);
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
  const schedules = await readSchedules();
  const schedule = schedules.find((item) => item.id === id);
  if (!schedule || schedule.status !== "pending") return;
  schedule.status = "fired";
  await writeSchedules(schedules);
  enqueuePendingNotification({
    mode: "workfriend-notification",
    text: formatCheckIn(schedule),
  });
}

function armSchedule(schedule: WorkfriendSchedule): void {
  if (schedule.status !== "pending" || timers.has(schedule.id)) return;
  const delay = Math.max(0, new Date(schedule.checkInAt).getTime() - Date.now());
  const timer = setTimeout(() => {
    if (delay > MAX_TIMER_DELAY) {
      timers.delete(schedule.id);
      armSchedule(schedule);
      return;
    }
    void fireSchedule(schedule.id);
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
  const schedules = await readSchedules();
  schedules.push(schedule);
  await writeSchedules(schedules);
  armSchedule(schedule);
  return schedule;
}

export async function listWorkfriendSchedules(): Promise<WorkfriendSchedule[]> {
  return await readSchedules();
}

export async function cancelWorkfriendSchedule(id: string): Promise<boolean> {
  const schedules = await readSchedules();
  const schedule = schedules.find((item) => item.id === id && item.status === "pending");
  if (!schedule) return false;
  schedule.status = "cancelled";
  const timer = timers.get(id);
  if (timer) clearTimeout(timer);
  timers.delete(id);
  await writeSchedules(schedules);
  return true;
}

export async function bootstrapWorkfriendScheduler(): Promise<number> {
  const schedules = await readSchedules();
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
