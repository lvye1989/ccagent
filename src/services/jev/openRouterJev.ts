/**
 * OpenRouter Jev Decisions client.
 *
 * Jev is not a chat-completions model. OpenRouter exposes it through the
 * Decisions API, which accepts TypeSafe's `state` + typed `questions` shape.
 * This module intentionally uses the platform `fetch` implementation so the
 * published CCAGENT bundle keeps its zero-runtime-dependency contract.
 */

export const DEFAULT_OPENROUTER_JEV_ENDPOINT =
  "https://openrouter.ai/api/alpha/decisions";
export const DEFAULT_OPENROUTER_JEV_MODEL = "~typesafe/jev-latest";

export type JevQuestion =
  | {
      type: "choice";
      instructions: string;
      criteria: Record<string, string>;
    }
  | {
      type: "score";
      instructions: string;
      criteria: string[];
    }
  | {
      type: "noul";
      instructions: string;
      criteria?: { true: string; false: string };
    };

export interface JevDecisionRequest {
  state: string | Record<string, unknown> | unknown[];
  questions: Record<string, JevQuestion>;
}

export interface JevChoiceAnswer {
  type: "choice";
  choice: string;
  probabilities?: Record<string, number>;
  confidence?: number;
}

export interface JevScoreAnswer {
  type: "score";
  score: number;
  probabilities?: Record<string, number>;
  confidence?: number;
  legend?: Record<string, string>;
}

export interface JevNoulAnswer {
  type: "noul";
  noul: number;
  confidence?: number;
}

export type JevAnswer = JevChoiceAnswer | JevScoreAnswer | JevNoulAnswer;

export interface JevDecisionResponse {
  model: string;
  answers: Record<string, JevAnswer>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cost?: number;
  };
}

export interface OpenRouterJevOptions {
  apiKey: string;
  endpoint?: string;
  model?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

function finiteProbability(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : undefined;
}

function parseAnswer(value: unknown): JevAnswer | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.type === "choice" && typeof raw.choice === "string") {
    const probabilities = raw.probabilities && typeof raw.probabilities === "object"
      ? Object.fromEntries(
          Object.entries(raw.probabilities as Record<string, unknown>)
            .filter((entry): entry is [string, number] => finiteProbability(entry[1]) !== undefined),
        )
      : undefined;
    return {
      type: "choice",
      choice: raw.choice,
      ...(probabilities ? { probabilities } : {}),
      ...(finiteProbability(raw.confidence) !== undefined
        ? { confidence: raw.confidence as number }
        : {}),
    };
  }
  if (raw.type === "score" && typeof raw.score === "number" && Number.isFinite(raw.score)) {
    const probabilities = raw.probabilities && typeof raw.probabilities === "object"
      ? Object.fromEntries(
          Object.entries(raw.probabilities as Record<string, unknown>)
            .filter((entry): entry is [string, number] => finiteProbability(entry[1]) !== undefined),
        )
      : undefined;
    const legend = raw.legend && typeof raw.legend === "object"
      ? Object.fromEntries(
          Object.entries(raw.legend as Record<string, unknown>)
            .filter((entry): entry is [string, string] => typeof entry[1] === "string"),
        )
      : undefined;
    return {
      type: "score",
      score: raw.score,
      ...(probabilities ? { probabilities } : {}),
      ...(finiteProbability(raw.confidence) !== undefined
        ? { confidence: raw.confidence as number }
        : {}),
      ...(legend ? { legend } : {}),
    };
  }
  if (raw.type === "noul" && finiteProbability(raw.noul) !== undefined) {
    return {
      type: "noul",
      noul: raw.noul as number,
      ...(finiteProbability(raw.confidence) !== undefined
        ? { confidence: raw.confidence as number }
        : {}),
    };
  }
  return null;
}

export function parseJevDecisionResponse(value: unknown): JevDecisionResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Jev returned a non-object response.");
  }
  const raw = value as Record<string, unknown>;
  if (!raw.answers || typeof raw.answers !== "object" || Array.isArray(raw.answers)) {
    throw new Error("Jev response is missing typed answers.");
  }
  const answers: Record<string, JevAnswer> = {};
  for (const [key, answer] of Object.entries(raw.answers as Record<string, unknown>)) {
    const parsed = parseAnswer(answer);
    if (parsed) answers[key] = parsed;
  }
  if (Object.keys(answers).length === 0) {
    throw new Error("Jev response contains no usable typed answers.");
  }
  return {
    model: typeof raw.model === "string" ? raw.model : "unknown",
    answers,
    ...(raw.usage && typeof raw.usage === "object"
      ? { usage: raw.usage as JevDecisionResponse["usage"] }
      : {}),
  };
}

function abortError(signal?: AbortSignal): Error {
  if (signal?.reason instanceof Error) return signal.reason;
  return new Error("Jev request aborted.");
}

/** Call OpenRouter's Decisions endpoint with privacy-preserving routing. */
export async function callOpenRouterJev(
  request: JevDecisionRequest,
  options: OpenRouterJevOptions,
): Promise<JevDecisionResponse> {
  const apiKey = options.apiKey.trim();
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not configured.");
  const timeoutMs = options.timeoutMs ?? 5_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("Jev request timed out.")), timeoutMs);
  const onAbort = () => controller.abort(abortError(options.signal));
  options.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const response = await (options.fetchImpl ?? fetch)(
      options.endpoint ?? DEFAULT_OPENROUTER_JEV_ENDPOINT,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://github.com/lvye1989/ccagent",
          "X-OpenRouter-Title": "CCAGENT",
        },
        body: JSON.stringify({
          model: options.model ?? DEFAULT_OPENROUTER_JEV_MODEL,
          state: request.state,
          questions: request.questions,
          provider: {
            zdr: true,
            data_collection: "deny",
          },
        }),
        signal: controller.signal,
      },
    );

    const text = await response.text();
    let decoded: unknown;
    try {
      decoded = text ? JSON.parse(text) : null;
    } catch {
      throw new Error(`OpenRouter Jev returned non-JSON HTTP ${response.status}.`);
    }
    if (!response.ok) {
      const raw = decoded && typeof decoded === "object"
        ? decoded as Record<string, unknown>
        : {};
      const nested = raw.error && typeof raw.error === "object"
        ? raw.error as Record<string, unknown>
        : {};
      const message = typeof nested.message === "string"
        ? nested.message
        : typeof raw.message === "string"
          ? raw.message
          : `HTTP ${response.status}`;
      throw new Error(`OpenRouter Jev request failed: ${message.slice(0, 300)}`);
    }
    return parseJevDecisionResponse(decoded);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}
