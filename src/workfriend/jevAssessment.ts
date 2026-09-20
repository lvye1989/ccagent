import {
  callOpenRouterJev,
  DEFAULT_OPENROUTER_JEV_ENDPOINT,
  DEFAULT_OPENROUTER_JEV_MODEL,
  type JevChoiceAnswer,
  type JevDecisionRequest,
  type JevDecisionResponse,
  type JevNoulAnswer,
  type JevScoreAnswer,
} from "../services/jev/openRouterJev.js";

export type WorkfriendAssessmentPhase = "start_of_day" | "end_of_day";
export type WorkfriendJevMode = "decision" | "advisory" | "off";

export interface WorkfriendAssessmentInput {
  phase: WorkfriendAssessmentPhase;
  workSummary: string;
  moodEvidence: string;
  stressEvidence: string;
  progressAndBottlenecks?: string;
  contextSummary?: string;
}

export interface WorkfriendJevConfig {
  enabled: boolean;
  mode: WorkfriendJevMode;
  apiKey: string;
  endpoint: string;
  model: string;
  timeoutMs: number;
}

export interface WorkfriendAssessment {
  configured: boolean;
  available: boolean;
  mode: WorkfriendJevMode;
  model: string;
  decisionAuthority: "jev" | "advisory" | "llm_fallback";
  moodStrainScore: number | undefined;
  stressLoadScore: number | undefined;
  workState: string | undefined;
  recommendedAction: string | undefined;
  decisionConfidence: number | undefined;
  urgentSupportProbability: number | undefined;
  safetyOverride: boolean;
  summary: string;
}

const WORK_STATES = new Set(["on_track", "overloaded", "blocked", "depleted", "unclear"]);
const NEXT_ACTIONS = new Set([
  "continue_current_plan",
  "reduce_scope",
  "take_recovery_break",
  "solve_primary_blocker",
  "seek_colleague_or_manager_support",
  "seek_urgent_human_support",
]);

function envBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || !value.trim()) return fallback;
  return !["0", "false", "no", "off"].includes(value.trim().toLowerCase());
}

function envNumber(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function safeEndpoint(value: string | undefined): string {
  if (!value?.trim()) return DEFAULT_OPENROUTER_JEV_ENDPOINT;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" || !(url.hostname === "openrouter.ai" || url.hostname.endsWith(".openrouter.ai"))) {
      return DEFAULT_OPENROUTER_JEV_ENDPOINT;
    }
    return url.toString();
  } catch {
    return DEFAULT_OPENROUTER_JEV_ENDPOINT;
  }
}

function safeModel(value: string | undefined): string {
  const model = value?.trim();
  return model && /^(~)?typesafe\/jev[-/]/i.test(model)
    ? model
    : DEFAULT_OPENROUTER_JEV_MODEL;
}

export function getWorkfriendJevConfig(): WorkfriendJevConfig {
  const apiKey = process.env.OPENROUTER_API_KEY?.trim() || "";
  const modeValue = process.env.WORKFRIEND_JEV_MODE?.trim().toLowerCase();
  const mode: WorkfriendJevMode = modeValue === "off" || modeValue === "advisory" || modeValue === "decision"
    ? modeValue
    : "decision";
  return {
    enabled: Boolean(apiKey) && mode !== "off" && envBoolean(process.env.CCAGENT_WORKFRIEND_JEV, true),
    mode,
    apiKey,
    endpoint: safeEndpoint(process.env.JEV_BASE_URL),
    model: safeModel(process.env.JEV_MODEL),
    timeoutMs: envNumber(process.env.JEV_TIMEOUT_MS, 5_000, 500, 30_000),
  };
}

/** Build one typed Jev request; higher scores mean more strain/load. */
export function buildWorkfriendJevRequest(input: WorkfriendAssessmentInput): JevDecisionRequest {
  return {
    state: {
      privacy_note: "This record contains only work and wellbeing evidence the user chose to share for this assessment.",
      safety_note: "Classify workplace wellbeing signals only. Do not diagnose a medical or mental-health condition.",
      phase: input.phase,
      work_summary: input.workSummary,
      mood_evidence: input.moodEvidence,
      stress_evidence: input.stressEvidence,
      progress_and_bottlenecks: input.progressAndBottlenecks || "Not provided.",
      relevant_context: input.contextSummary || "Not provided.",
    },
    questions: {
      mood_strain: {
        type: "score",
        instructions: "Score the degree of negative workplace emotional strain explicitly supported by the record. This is a non-clinical work check-in, not a diagnosis.",
        criteria: [
          "0 - Positive, energized, or calm with no meaningful emotional strain stated.",
          "1 - Mostly steady with mild tiredness, concern, or temporary frustration.",
          "2 - Mixed mood or noticeable strain that is affecting comfort but remains manageable.",
          "3 - Strong frustration, discouragement, anxiety, or exhaustion that is materially affecting work.",
          "4 - Acute distress or explicit immediate-safety concern; ordinary productivity coaching should stop.",
        ],
      },
      stress_load: {
        type: "score",
        instructions: "Score the current work-related stress load explicitly supported by deadlines, workload, uncertainty, blockers, conflict, or fatigue in the record.",
        criteria: [
          "0 - Low stress; capacity and workload appear comfortable.",
          "1 - Mild pressure with adequate control and capacity.",
          "2 - Moderate pressure requiring prioritization or a small adjustment.",
          "3 - High pressure, overload, persistent blockage, or depleted capacity requiring immediate scope or support changes.",
          "4 - Extreme pressure or explicit immediate-safety concern; stop ordinary productivity coaching and prioritize human support.",
        ],
      },
      work_state: {
        type: "choice",
        instructions: "Choose the single work state best supported by the record.",
        criteria: {
          on_track: "Progress and capacity are adequate; no major blocker is stated.",
          overloaded: "The amount, urgency, or fragmentation of work exceeds current capacity.",
          blocked: "A concrete dependency, decision, access issue, or unresolved problem prevents useful progress.",
          depleted: "Fatigue or emotional strain is the main constraint, even if tasks are clear.",
          unclear: "The evidence is insufficient or conflicting.",
        },
      },
      next_action: {
        type: "choice",
        instructions: "Choose the safest and most useful immediate Workfriend action. Prefer the least disruptive option that addresses the strongest supported constraint.",
        criteria: {
          continue_current_plan: "The user is on track with manageable pressure; continue with a clear next step.",
          reduce_scope: "Overload or time pressure calls for dropping, deferring, or narrowing work.",
          take_recovery_break: "Depletion or emotional strain is the primary constraint; pause briefly before deciding or continuing.",
          solve_primary_blocker: "A specific blocker should be isolated and resolved first.",
          seek_colleague_or_manager_support: "The issue needs coordination, escalation, help, or boundary-setting with another person.",
          seek_urgent_human_support: "The record explicitly indicates immediate danger, self-harm, or inability to stay safe.",
        },
      },
      urgent_support_signal: {
        type: "noul",
        instructions: "Does the record explicitly indicate immediate danger, self-harm, intent to harm someone, or inability to stay safe? Do not infer this merely from ordinary stress, fatigue, frustration, or low mood.",
        criteria: {
          true: "The user's own words explicitly indicate an immediate safety risk or intent.",
          false: "There is no explicit immediate safety signal; ordinary work stress or low mood alone is not enough.",
        },
      },
    },
  };
}

function scoreAnswer(response: JevDecisionResponse, key: string): JevScoreAnswer | undefined {
  const answer = response.answers[key];
  return answer?.type === "score" ? answer : undefined;
}

function choiceAnswer(response: JevDecisionResponse, key: string): JevChoiceAnswer | undefined {
  const answer = response.answers[key];
  return answer?.type === "choice" ? answer : undefined;
}

function noulAnswer(response: JevDecisionResponse, key: string): JevNoulAnswer | undefined {
  const answer = response.answers[key];
  return answer?.type === "noul" ? answer : undefined;
}

function boundedLevel(answer: JevScoreAnswer | undefined): number | undefined {
  if (!answer) return undefined;
  return Math.max(0, Math.min(4, Math.round(answer.score)));
}

function choiceConfidence(answer: JevChoiceAnswer | undefined): number | undefined {
  if (!answer) return undefined;
  return answer.confidence ?? answer.probabilities?.[answer.choice];
}

export function interpretWorkfriendJevResponse(
  response: JevDecisionResponse,
  config: Pick<WorkfriendJevConfig, "mode" | "model">,
): WorkfriendAssessment {
  const moodStrainScore = boundedLevel(scoreAnswer(response, "mood_strain"));
  const stressLoadScore = boundedLevel(scoreAnswer(response, "stress_load"));
  const workStateAnswer = choiceAnswer(response, "work_state");
  const nextActionAnswer = choiceAnswer(response, "next_action");
  const urgentSupportProbability = noulAnswer(response, "urgent_support_signal")?.noul;
  const workState = workStateAnswer && WORK_STATES.has(workStateAnswer.choice)
    ? workStateAnswer.choice
    : undefined;
  let recommendedAction = nextActionAnswer && NEXT_ACTIONS.has(nextActionAnswer.choice)
    ? nextActionAnswer.choice
    : undefined;

  // This deterministic floor is intentionally outside Jev. A model decision
  // can never downgrade an explicit immediate-safety signal into productivity advice.
  const safetyOverride = urgentSupportProbability !== undefined && urgentSupportProbability >= 0.5;
  if (safetyOverride) recommendedAction = "seek_urgent_human_support";

  const decisionAuthority = config.mode === "decision" && recommendedAction
    ? "jev"
    : config.mode === "advisory"
      ? "advisory"
      : "llm_fallback";
  const decisionConfidence = safetyOverride
    ? urgentSupportProbability
    : choiceConfidence(nextActionAnswer);
  const fields = [
    `model=${response.model || config.model}`,
    `authority=${decisionAuthority}`,
    moodStrainScore !== undefined ? `mood_strain=${moodStrainScore}/4` : "mood_strain=unknown",
    stressLoadScore !== undefined ? `stress_load=${stressLoadScore}/4` : "stress_load=unknown",
    `work_state=${workState ?? "unknown"}`,
    `next_action=${recommendedAction ?? "unknown"}`,
    decisionConfidence !== undefined ? `confidence=${decisionConfidence.toFixed(2)}` : "",
    safetyOverride ? "safety_override=true" : "",
  ].filter(Boolean);

  return {
    configured: true,
    available: true,
    mode: config.mode,
    model: response.model || config.model,
    decisionAuthority,
    moodStrainScore,
    stressLoadScore,
    workState,
    recommendedAction,
    decisionConfidence,
    urgentSupportProbability,
    safetyOverride,
    summary: fields.join(", "),
  };
}

function cleanError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/sk-or-[A-Za-z0-9_-]+/g, "<redacted>")
    .replace(/Bearer\s+\S+/gi, "Bearer <redacted>")
    .replace(/\s+/g, " ")
    .slice(0, 300);
}

export async function assessWorkfriendWithJev(
  input: WorkfriendAssessmentInput,
  signal?: AbortSignal,
): Promise<WorkfriendAssessment> {
  const config = getWorkfriendJevConfig();
  if (!config.enabled) {
    return {
      configured: false,
      available: false,
      mode: config.mode,
      model: config.model,
      decisionAuthority: "llm_fallback",
      moodStrainScore: undefined,
      stressLoadScore: undefined,
      workState: undefined,
      recommendedAction: undefined,
      decisionConfidence: undefined,
      urgentSupportProbability: undefined,
      safetyOverride: false,
      summary: "Jev assessment is disabled; Workfriend must use the main LLM and clearly label scores as qualitative estimates.",
    };
  }
  try {
    const response = await callOpenRouterJev(buildWorkfriendJevRequest(input), {
      apiKey: config.apiKey,
      endpoint: config.endpoint,
      model: config.model,
      timeoutMs: config.timeoutMs,
      signal,
    });
    return interpretWorkfriendJevResponse(response, config);
  } catch (error: unknown) {
    return {
      configured: true,
      available: false,
      mode: config.mode,
      model: config.model,
      decisionAuthority: "llm_fallback",
      moodStrainScore: undefined,
      stressLoadScore: undefined,
      workState: undefined,
      recommendedAction: undefined,
      decisionConfidence: undefined,
      urgentSupportProbability: undefined,
      safetyOverride: false,
      summary: `Jev unavailable; Workfriend must use the main LLM and disclose the fallback (${cleanError(error)}).`,
    };
  }
}
