import type { Tool, ToolContext, ToolResult } from "./Tool.js";
import {
  cancelWorkfriendSchedule,
  createWorkfriendSchedule,
  listWorkfriendSchedules,
} from "../workfriend/scheduler.js";

function requiredText(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${key} must be a non-empty string.`);
  }
  return value.trim();
}

export const workfriendScheduleTool: Tool = {
  name: "WorkfriendSchedule",
  description:
    "Create, list, or cancel a persistent Workfriend end-of-day check-in. " +
    "For schedule, collect today's work, current office mood, and local workday end first. " +
    "The reminder fires one hour before workday_end (or promptly if already inside the last hour), " +
    "survives app restarts, and starts the progress/bottleneck questionnaire in the active CCAGENT session.",
  inputSchema: {
    type: "object" as const,
    properties: {
      action: {
        type: "string",
        enum: ["schedule", "list", "cancel"],
        description: "Operation to perform.",
      },
      workday_end: {
        type: "string",
        description: "Local workday end in 24-hour HH:mm format, for example 18:00.",
      },
      work_summary: {
        type: "string",
        description: "What the user plans to work on today, preserving their own wording.",
      },
      mood_summary: {
        type: "string",
        description: "How the user describes their recent work mood.",
      },
      assessment_summary: {
        type: "string",
        description: "Concise WorkfriendAssess scores, state, and recommended action; do not include the full questionnaire.",
      },
      context_summary: {
        type: "string",
        description: "Concise relevant summary of the current conversation so a reminder restored after restart still has context.",
      },
      schedule_id: {
        type: "string",
        description: "Schedule id required by cancel.",
      },
    },
    required: ["action"],
  },

  async call(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    try {
      const action = requiredText(input, "action");
      if (action === "schedule") {
        const schedule = await createWorkfriendSchedule({
          workdayEnd: requiredText(input, "workday_end"),
          workSummary: requiredText(input, "work_summary"),
          moodSummary: requiredText(input, "mood_summary"),
          assessmentSummary: typeof input.assessment_summary === "string" ? input.assessment_summary : undefined,
          contextSummary: typeof input.context_summary === "string" ? input.context_summary : undefined,
          cwd: context.cwd,
        });
        return {
          content: [
            "Workfriend check-in scheduled.",
            `Schedule id: ${schedule.id}`,
            `Check-in: ${new Date(schedule.checkInAt).toLocaleString()}`,
            `Workday end: ${schedule.workdayEnd}`,
            "The reminder is persisted under ~/.ccagent/workfriend and will be restored on the next app launch if needed.",
          ].join("\n"),
        };
      }
      if (action === "list") {
        const schedules = await listWorkfriendSchedules();
        if (schedules.length === 0) return { content: "No Workfriend schedules found." };
        return {
          content: schedules
            .slice(-20)
            .map(
              (item) =>
                `${item.id} | ${item.status} | ${new Date(item.checkInAt).toLocaleString()} | end ${item.workdayEnd}`,
            )
            .join("\n"),
        };
      }
      if (action === "cancel") {
        const id = requiredText(input, "schedule_id");
        const cancelled = await cancelWorkfriendSchedule(id);
        return {
          content: cancelled
            ? `Cancelled Workfriend schedule ${id}.`
            : `No pending Workfriend schedule found for ${id}.`,
          isError: !cancelled,
        };
      }
      return { content: "Error: action must be schedule, list, or cancel.", isError: true };
    } catch (error) {
      return {
        content: `Workfriend schedule error: ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      };
    }
  },

  isReadOnly(): boolean {
    return false;
  },

  isEnabled(): boolean {
    return true;
  },
};
