import type { Tool, ToolContext, ToolResult } from "./Tool.js";
import {
  assessWorkfriendWithJev,
  type WorkfriendAssessmentPhase,
} from "../workfriend/jevAssessment.js";

function requiredText(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${key} must be a non-empty string.`);
  }
  return value.trim();
}

export const workfriendAssessTool: Tool = {
  name: "WorkfriendAssess",
  description:
    "Use OpenRouter Jev to score non-clinical workplace mood strain and stress load from 0-4, classify the work state, and choose the next Workfriend action. " +
    "Call after the user has answered the relevant Workfriend questions, before giving recommendations. " +
    "Only the fields supplied to this tool are sent to OpenRouter; do not include credentials, unrelated private data, or full hidden conversation history. " +
    "In decision mode, follow Jev's recommended_action unless the fixed safety override requires urgent human support.",
  inputSchema: {
    type: "object" as const,
    properties: {
      phase: {
        type: "string",
        enum: ["start_of_day", "end_of_day"],
        description: "Which Workfriend check-in is being assessed.",
      },
      work_summary: {
        type: "string",
        description: "Concise work being attempted, using only user-provided facts.",
      },
      mood_evidence: {
        type: "string",
        description: "The user's mood answer and relevant selected card answers, preserving uncertainty.",
      },
      stress_evidence: {
        type: "string",
        description: "The user's stress answer and stated workload or deadline evidence.",
      },
      progress_and_bottlenecks: {
        type: "string",
        description: "Progress and concrete blockers shared by the user, if available.",
      },
      context_summary: {
        type: "string",
        description: "Optional minimal relevant context; never send secrets or unrelated conversation history.",
      },
    },
    required: ["phase", "work_summary", "mood_evidence", "stress_evidence"],
  },

  async call(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    try {
      const phase = requiredText(input, "phase");
      if (phase !== "start_of_day" && phase !== "end_of_day") {
        return { content: "Workfriend assessment error: phase must be start_of_day or end_of_day.", isError: true };
      }
      const assessment = await assessWorkfriendWithJev({
        phase: phase as WorkfriendAssessmentPhase,
        workSummary: requiredText(input, "work_summary"),
        moodEvidence: requiredText(input, "mood_evidence"),
        stressEvidence: requiredText(input, "stress_evidence"),
        ...(typeof input.progress_and_bottlenecks === "string" && input.progress_and_bottlenecks.trim()
          ? { progressAndBottlenecks: input.progress_and_bottlenecks.trim() }
          : {}),
        ...(typeof input.context_summary === "string" && input.context_summary.trim()
          ? { contextSummary: input.context_summary.trim() }
          : {}),
      }, context.abortSignal);

      return {
        content: [
          "Workfriend Jev assessment",
          `Available: ${assessment.available ? "yes" : "no"}`,
          `Decision authority: ${assessment.decisionAuthority}`,
          `Mood strain: ${assessment.moodStrainScore ?? "unknown"}/4 (higher means more strain)`,
          `Stress load: ${assessment.stressLoadScore ?? "unknown"}/4 (higher means more load)`,
          `Work state: ${assessment.workState ?? "unknown"}`,
          `Recommended action: ${assessment.recommendedAction ?? "LLM fallback"}`,
          `Decision confidence: ${assessment.decisionConfidence?.toFixed(2) ?? "unknown"}`,
          `Urgent-support probability: ${assessment.urgentSupportProbability?.toFixed(2) ?? "unknown"}`,
          `Safety override: ${assessment.safetyOverride ? "yes" : "no"}`,
          `Trace: ${assessment.summary}`,
          assessment.safetyOverride
            ? "MANDATORY: Stop the normal questionnaire and productivity coaching. Encourage immediate contact with local emergency services or a trusted nearby person. Do not leave the user alone with only automated advice."
            : assessment.decisionAuthority === "jev"
              ? "DECISION: Use the recommended action as the primary plan. The main LLM may explain and personalize it, but must not silently replace it."
              : "FALLBACK: Use the main LLM conservatively and tell the user that Jev did not make the decision.",
          "Boundary: This is a non-clinical workplace reflection, not a medical or mental-health diagnosis.",
        ].join("\n"),
        isError: !assessment.available,
      };
    } catch (error) {
      return {
        content: `Workfriend assessment error: ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      };
    }
  },

  // The call transmits user-provided work/wellbeing text to OpenRouter, so it
  // deliberately goes through the normal mutation/confirmation path.
  isReadOnly(): boolean {
    return false;
  },

  isEnabled(): boolean {
    return true;
  },
};
