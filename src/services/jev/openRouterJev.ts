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
  /** Local transport attempts used to obtain this response (not provider data). */
  attempts?: number;
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
  /**
   * Total request attempts. Decisions are read-only and safe to retry, but the
   * default remains one so callers opt in only for latency-sensitive paths.
   */
  maxAttempts?: number;
  /** Delay before a retry of a transient transport/HTTP failure. */
  retryDelayMs?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

export type OpenRouterJevErrorKind =
  | "timeout"
  | "network"
  | "http"
  | "protocol"
  | "aborted";

/** Structured failure used to distinguish safe transient retries from hard failures. */
export class OpenRouterJevError extends Error {
  readonly kind: OpenRouterJevErrorKind;
  readonly retryable: boolean;
  readonly status?: number;
  readonly attempts: number;

  constructor(
    message: string,
    options: {
      kind: OpenRouterJevErrorKind;
      retryable: boolean;
      status?: number;
      attempts?: number;
      cause?: unknown;
    },
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "OpenRouterJevError";
    this.kind = options.kind;
    this.retryable = options.retryable;
    this.status = options.status;
    this.attempts = options.attempts ?? 1;
  }
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

function retryableHttpStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  return Number.isInteger(value) && (value as number) >= min && (value as number) <= max
    ? value as number
    : fallback;
}

function waitForRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(abortError(signal));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function finalAttemptError(error: OpenRouterJevError, attempts: number): OpenRouterJevError {
  if (attempts <= 1) return error;
  const base = error.message.replace(/[.]$/, "");
  return new OpenRouterJevError(`${base} after ${attempts} attempts.`, {
    kind: error.kind,
    retryable: error.retryable,
    status: error.status,
    attempts,
    cause: error,
  });
}

/** Call OpenRouter's Decisions endpoint with privacy-preserving routing. */
export async function callOpenRouterJev(
  request: JevDecisionRequest,
  options: OpenRouterJevOptions,
): Promise<JevDecisionResponse> {
  const apiKey = options.apiKey.trim();
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not configured.");
  const timeoutMs = options.timeoutMs ?? 8_000;
  const maxAttempts = boundedInteger(options.maxAttempts, 1, 1, 3);
  const retryDelayMs = boundedInteger(options.retryDelayMs, 250, 0, 2_000);
  const fetchImpl = options.fetchImpl ?? fetch;
  const endpoint = options.endpoint ?? DEFAULT_OPENROUTER_JEV_ENDPOINT;
  const body = JSON.stringify({
    model: options.model ?? DEFAULT_OPENROUTER_JEV_MODEL,
    state: request.state,
    questions: request.questions,
    provider: {
      zdr: true,
      data_collection: "deny",
    },
  });

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (options.signal?.aborted) {
      throw new OpenRouterJevError(abortError(options.signal).message, {
        kind: "aborted",
        retryable: false,
        attempts: attempt - 1,
      });
    }

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error("Jev request timed out."));
    }, timeoutMs);
    const onAbort = () => controller.abort(abortError(options.signal));
    options.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://github.com/lvye1989/ccagent",
          "X-OpenRouter-Title": "CCAGENT",
        },
        body,
        signal: controller.signal,
      });

      const text = await response.text();
      let decoded: unknown = null;
      if (text) {
        try {
          decoded = JSON.parse(text);
        } catch (error) {
          if (!response.ok) {
            throw new OpenRouterJevError(`OpenRouter Jev returned non-JSON HTTP ${response.status}.`, {
              kind: "http",
              retryable: retryableHttpStatus(response.status),
              status: response.status,
              cause: error,
            });
          }
          throw new OpenRouterJevError(`OpenRouter Jev returned non-JSON HTTP ${response.status}.`, {
            kind: "protocol",
            retryable: false,
            status: response.status,
            cause: error,
          });
        }
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
        throw new OpenRouterJevError(`OpenRouter Jev request failed: ${message.slice(0, 300)}`, {
          kind: "http",
          retryable: retryableHttpStatus(response.status),
          status: response.status,
        });
      }
      try {
        return { ...parseJevDecisionResponse(decoded), attempts: attempt };
      } catch (error) {
        throw new OpenRouterJevError(
          error instanceof Error ? error.message : String(error),
          { kind: "protocol", retryable: false, status: response.status, cause: error },
        );
      }
    } catch (error) {
      let classified: OpenRouterJevError;
      if (error instanceof OpenRouterJevError) {
        classified = error;
      } else if (options.signal?.aborted) {
        classified = new OpenRouterJevError(abortError(options.signal).message, {
          kind: "aborted",
          retryable: false,
          attempts: attempt,
          cause: error,
        });
      } else if (timedOut) {
        classified = new OpenRouterJevError("Jev request timed out.", {
          kind: "timeout",
          retryable: true,
          attempts: attempt,
          cause: error,
        });
      } else {
        classified = new OpenRouterJevError(
          `OpenRouter Jev network request failed: ${error instanceof Error ? error.message : String(error)}`,
          { kind: "network", retryable: true, attempts: attempt, cause: error },
        );
      }

      if (!classified.retryable || attempt >= maxAttempts) {
        throw finalAttemptError(classified, attempt);
      }
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    }

    await waitForRetry(retryDelayMs, options.signal);
  }

  throw new OpenRouterJevError("OpenRouter Jev request failed.", {
    kind: "network",
    retryable: false,
    attempts: maxAttempts,
  });
}
