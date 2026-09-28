import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages.js";
import type { Tool, ToolContext, ToolResult } from "./Tool.js";
import { listComputerWindows, type ComputerWindow } from "./computerUseBackend.js";
import { ensureComputerUseIndicatorSession } from "./computerUseIndicator.js";
import { getComputerUseJevConfig } from "./computerUseJev.js";
import {
  decideBrowserSearchWithJev,
  type BrowserSearchEngine,
  type BrowserSearchJevDecision,
  type BrowserSearchPlan,
} from "./browserSearchJev.js";

const SEARCH_ENGINES: Readonly<Record<BrowserSearchEngine, { base: string; parameter: string }>> = Object.freeze({
  baidu: { base: "https://www.baidu.com/s", parameter: "wd" },
  bing: { base: "https://www.bing.com/search", parameter: "q" },
  google: { base: "https://www.google.com/search", parameter: "q" },
  duckduckgo: { base: "https://duckduckgo.com/", parameter: "q" },
});

const BROWSER_PROCESS_NAMES = new Set(["brave", "chrome", "firefox", "msedge", "opera", "vivaldi"]);
const MAX_QUERY_CHARS = 500;
const MAX_URL_CHARS = 2_048;
const GRANT_TTL_MS = 30_000;

export type BrowserSearchFinalPermission =
  | "auto_allowed"
  | "full_access"
  | "allow_once"
  | "allow_always";

const ALLOWED_FINAL_PERMISSIONS: ReadonlySet<string> = new Set([
  "auto_allowed",
  "full_access",
  "allow_once",
  "allow_always",
]);

export interface BrowserSearchExecutionApproval {
  /** Trace label supplied by the central permission gate after it allows. */
  finalPermission: string;
  /** Required when Jev was unavailable/uncertain or explicitly asked. */
  independentlyReviewed?: boolean;
  /**
   * Session for direct/test callers. The central path normally derives this
   * from the exact decision object returned by preflightBrowserSearchWithJev.
   */
  sessionId?: string;
}

interface BrowserSearchGrant {
  sessionId: string;
  toolUseId: string;
  digest: string;
  expiresAt: number;
  decisionSummary: string;
  finalPermission: BrowserSearchFinalPermission;
}

interface BrowserSearchDecisionBinding {
  sessionId: string;
  digest: string;
}

export interface BrowserSearchRuntime {
  openExternalUrl(url: string, signal?: AbortSignal): Promise<boolean>;
  listWindows(signal?: AbortSignal): Promise<ComputerWindow[]>;
  ensureIndicator(sessionId: string | undefined, targetLabel: string): Promise<unknown>;
  wait(ms: number, signal?: AbortSignal): Promise<void>;
}

const grants = new Map<string, BrowserSearchGrant>();
const decisionBindings = new WeakMap<BrowserSearchJevDecision, BrowserSearchDecisionBinding>();

function normalizedSessionId(value: string | undefined): string | null {
  const sessionId = value?.trim();
  return sessionId ? sessionId : null;
}

function grantKey(sessionId: string, toolUseId: string): string {
  return JSON.stringify([sessionId, toolUseId]);
}

function isAllowedFinalPermission(value: string): value is BrowserSearchFinalPermission {
  return ALLOWED_FINAL_PERMISSIONS.has(value);
}

function isLoopback(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "[::1]" || normalized === "::1";
}

function hasControlCharacters(value: string): boolean {
  return /[\u0000-\u001f\u007f]/.test(value);
}

function validateQuery(value: unknown): string {
  if (typeof value !== "string") throw new Error("query is required for action=search.");
  const query = value.trim();
  if (!query) throw new Error("query must not be empty.");
  if (query.length > MAX_QUERY_CHARS) throw new Error(`query may contain at most ${MAX_QUERY_CHARS} characters.`);
  if (hasControlCharacters(query)) throw new Error("query must not contain control characters.");
  return query;
}

function validateDirectUrl(value: unknown): URL {
  if (typeof value !== "string") throw new Error("url is required for action=open_url.");
  const raw = value.trim();
  if (!raw) throw new Error("url must not be empty.");
  if (raw.length > MAX_URL_CHARS) throw new Error(`url may contain at most ${MAX_URL_CHARS} characters.`);
  if (hasControlCharacters(raw)) throw new Error("url must not contain control characters.");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("url must be an absolute HTTP(S) URL.");
  }
  if (url.username || url.password) throw new Error("URLs containing embedded credentials are prohibited.");
  if (url.protocol === "http:" && !isLoopback(url.hostname)) {
    throw new Error("Public direct navigation requires HTTPS; HTTP is allowed only for loopback development URLs.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Only HTTPS URLs and loopback HTTP URLs are allowed.");
  }
  if (!url.hostname) throw new Error("url must contain a hostname.");
  return url;
}

function assertNoCrossActionFields(
  input: Record<string, unknown>,
  action: "search" | "open_url",
): void {
  if (action === "search" && input.url !== undefined) {
    throw new Error("url is not allowed for action=search.");
  }
  if (action === "open_url" && (input.query !== undefined || input.engine !== undefined)) {
    throw new Error("query and engine are not allowed for action=open_url.");
  }
}

export function prepareBrowserSearchInput(rawInput: Record<string, unknown>): BrowserSearchPlan {
  const action = rawInput.action;
  if (action !== "search" && action !== "open_url") {
    throw new Error("action must be search or open_url.");
  }
  assertNoCrossActionFields(rawInput, action);
  if (action === "search") {
    const query = validateQuery(rawInput.query);
    const engine = rawInput.engine;
    if (typeof engine !== "string" || !Object.hasOwn(SEARCH_ENGINES, engine)) {
      throw new Error("engine must be baidu, bing, google, or duckduckgo.");
    }
    const typedEngine = engine as BrowserSearchEngine;
    const definition = SEARCH_ENGINES[typedEngine];
    const url = new URL(definition.base);
    url.searchParams.set(definition.parameter, query);
    return {
      action,
      query,
      engine: typedEngine,
      canonicalUrl: url.toString(),
      destinationHost: url.hostname,
      urlQueryKeys: [definition.parameter],
    };
  }

  const url = validateDirectUrl(rawInput.url);
  return {
    action,
    canonicalUrl: url.toString(),
    destinationHost: url.hostname,
    urlQueryKeys: [...new Set(url.searchParams.keys())].slice(0, 40),
  };
}

export function validateBrowserSearchInput(rawInput: Record<string, unknown>): string | null {
  try {
    prepareBrowserSearchInput(rawInput);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function secretLike(value: string): boolean {
  return /\b(?:sk-or-[A-Za-z0-9_-]+|sk-[A-Za-z0-9_-]{16,})\b/.test(value)
    || /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(value)
    || /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|secret)\s*[:=]/i.test(value);
}

function resultUrl(plan: BrowserSearchPlan): string {
  if (plan.action === "search") return plan.canonicalUrl;
  const sanitized = new URL(plan.canonicalUrl);
  for (const key of [...sanitized.searchParams.keys()]) {
    sanitized.searchParams.set(key, "<redacted-value>");
  }
  return sanitized.toString();
}

function recentUserIntent(messages?: MessageParam[]): string {
  if (!messages?.length) return "No user intent was supplied.";
  const collected: string[] = [];
  for (let index = messages.length - 1; index >= 0 && collected.length < 4; index--) {
    const message = messages[index];
    if (!message || message.role !== "user") continue;
    const text = typeof message.content === "string"
      ? message.content
      : Array.isArray(message.content)
        ? message.content
            .filter((block): block is Extract<(typeof message.content)[number], { type: "text" }> => block.type === "text")
            .map((block) => block.text)
            .join("\n")
        : "";
    if (text.trim()) collected.unshift(text.trim().slice(0, 1_500));
  }
  return collected.join("\n---\n").slice(0, 4_500) || "No textual user intent was supplied.";
}

/**
 * Validate and obtain the typed Jev decision. This never opens a browser and
 * deliberately does not issue the one-time execution grant.
 */
export async function preflightBrowserSearchWithJev(
  rawInput: Record<string, unknown>,
  context: ToolContext,
  messages?: MessageParam[],
): Promise<BrowserSearchJevDecision> {
  const sessionId = normalizedSessionId(context.sessionId);
  if (!sessionId) {
    const config = getComputerUseJevConfig();
    return {
      configured: Boolean(config.apiKey),
      available: false,
      mode: config.mode,
      model: config.model,
      forceDeny: true,
      summary: "BrowserSearch requires a non-empty session id before review or execution.",
    };
  }
  let plan: BrowserSearchPlan;
  try {
    plan = prepareBrowserSearchInput(rawInput);
  } catch (error) {
    const config = getComputerUseJevConfig();
    return {
      configured: Boolean(config.apiKey),
      available: false,
      mode: config.mode,
      model: config.model,
      forceDeny: true,
      summary: `BrowserSearch rejected locally before Jev: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const contentForSensitivityCheck = plan.query ?? plan.canonicalUrl;
  if (secretLike(contentForSensitivityCheck)) {
    const config = getComputerUseJevConfig();
    const decision: BrowserSearchJevDecision = {
      configured: Boolean(config.apiKey),
      available: false,
      mode: config.mode,
      model: config.model,
      permissionBehavior: "ask",
      requiresFallbackReview: true,
      sensitiveInputWithheld: true,
      summary:
        "BrowserSearch contains secret-like material. It was withheld from remote decision models and requires user confirmation before any external navigation.",
    };
    decisionBindings.set(decision, { sessionId, digest: planDigest(plan) });
    return decision;
  }
  const decision = await decideBrowserSearchWithJev(plan, recentUserIntent(messages), context.abortSignal);
  decisionBindings.set(decision, { sessionId, digest: planDigest(plan) });
  return decision;
}

function planDigest(plan: BrowserSearchPlan): string {
  return createHash("sha256")
    .update(JSON.stringify({ action: plan.action, canonicalUrl: plan.canonicalUrl }))
    .digest("hex");
}

function pruneGrants(now: number): void {
  for (const [key, grant] of grants) {
    if (grant.expiresAt <= now) grants.delete(key);
  }
}

/**
 * Called only by the central loop after hooks and permission checks pass.
 * BrowserSearch.call consumes the grant once and binds it to the exact input.
 */
export function grantBrowserSearchExecution(
  toolUseId: string,
  rawInput: Record<string, unknown>,
  decision: BrowserSearchJevDecision,
  approval: BrowserSearchExecutionApproval,
): void {
  if (!toolUseId.trim()) throw new Error("BrowserSearch grant requires a tool_use id.");
  if (!isAllowedFinalPermission(approval.finalPermission)) {
    throw new Error("BrowserSearch grant requires a final allow decision.");
  }
  if (decision.forceDeny) throw new Error("BrowserSearch cannot grant an action denied by local/Jev policy.");
  const needsIndependentReview =
    !decision.available ||
    decision.mode !== "enforce" ||
    decision.permissionBehavior !== "allow";
  if (needsIndependentReview && approval.independentlyReviewed !== true) {
    throw new Error("BrowserSearch requires an independent fallback or user review before execution.");
  }
  const plan = prepareBrowserSearchInput(rawInput);
  const digest = planDigest(plan);
  const binding = decisionBindings.get(decision);
  const approvalSessionId = normalizedSessionId(approval.sessionId);
  if (binding && approvalSessionId && binding.sessionId !== approvalSessionId) {
    throw new Error("BrowserSearch grant session does not match its preflight decision.");
  }
  if (binding && binding.digest !== digest) {
    throw new Error("BrowserSearch grant input does not match its preflight decision.");
  }
  const sessionId = binding?.sessionId ?? approvalSessionId;
  if (!sessionId) {
    throw new Error("BrowserSearch grant requires a non-empty session id.");
  }
  const now = Date.now();
  pruneGrants(now);
  grants.set(grantKey(sessionId, toolUseId), {
    sessionId,
    toolUseId,
    digest,
    expiresAt: now + GRANT_TTL_MS,
    decisionSummary: decision.summary,
    finalPermission: approval.finalPermission,
  });
  decisionBindings.delete(decision);
}

export function revokeBrowserSearchExecution(toolUseId: string, sessionId?: string): void {
  const normalizedSession = normalizedSessionId(sessionId);
  if (normalizedSession) {
    grants.delete(grantKey(normalizedSession, toolUseId));
    return;
  }
  for (const [key, grant] of grants) {
    if (grant.toolUseId === toolUseId) grants.delete(key);
  }
}

function consumeGrant(
  toolUseId: string | undefined,
  sessionId: string | undefined,
  plan: BrowserSearchPlan,
): BrowserSearchGrant | null {
  const normalizedSession = normalizedSessionId(sessionId);
  if (!toolUseId || !normalizedSession) return null;
  const key = grantKey(normalizedSession, toolUseId);
  const grant = grants.get(key);
  grants.delete(key);
  if (!grant || grant.expiresAt <= Date.now() || grant.digest !== planDigest(plan)) return null;
  return grant;
}

function waitWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("BrowserSearch aborted."));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(signal?.reason ?? new Error("BrowserSearch aborted."));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function openExternalUrl(url: string, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) throw signal.reason ?? new Error("BrowserSearch aborted before launch.");
  const command = process.platform === "win32"
    ? { file: "rundll32.exe", args: ["url.dll,FileProtocolHandler", url] }
    : process.platform === "darwin"
      ? { file: "open", args: [url] }
      : process.platform === "linux"
        ? { file: "xdg-open", args: [url] }
        : null;
  if (!command) throw new Error(`BrowserSearch is unsupported on ${process.platform}.`);

  return new Promise<boolean>((resolve, reject) => {
    let settled = false;
    const child = spawn(command.file, command.args, {
      detached: true,
      shell: false,
      stdio: "ignore",
      windowsHide: true,
    });
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => {
      if (child.exitCode === null) child.kill();
      finish(() => reject(signal?.reason ?? new Error("BrowserSearch aborted before launch.")));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    child.once("error", (error) => finish(() => reject(error)));
    child.once("spawn", () => finish(() => {
      child.unref();
      resolve(true);
    }));
  });
}

const DEFAULT_RUNTIME: BrowserSearchRuntime = {
  openExternalUrl,
  listWindows: async (signal) => process.platform === "win32" ? listComputerWindows(signal) : [],
  ensureIndicator: ensureComputerUseIndicatorSession,
  wait: waitWithAbort,
};

function browserProcess(window: ComputerWindow): boolean {
  return BROWSER_PROCESS_NAMES.has(window.processName.toLowerCase().replace(/\.exe$/i, ""));
}

export function createBrowserSearchTool(runtime: BrowserSearchRuntime): Tool {
  return {
    name: "BrowserSearch",
    decisionPolicy: "specialized_jev",
    description:
      "Fast one-shot path for an ordinary public search or direct URL. It needs no ComputerObserve snapshot: CCAGENT validates a fixed search-engine/HTTPS destination, Jev reviews the complete operation once, then the OS opens it in the default browser. Use WebSearch instead when the user needs facts, sources, or a summary. Use ComputerObserve/ComputerActionGroup/ComputerAction only when interaction is needed after the page opens. Never use this tool for login, CAPTCHA, forms, uploads, communication, purchases, account changes, or secret-bearing queries.",
    inputSchema: {
      type: "object" as const,
      properties: {
        action: {
          type: "string",
          enum: ["search", "open_url"],
          description: "search opens an allowlisted search-results page; open_url opens one explicit HTTP(S) URL.",
        },
        query: {
          type: "string",
          maxLength: MAX_QUERY_CHARS,
          description: "Required only for search. Public search text; never include credentials or private secrets.",
        },
        engine: {
          type: "string",
          enum: ["baidu", "bing", "google", "duckduckgo"],
          description: "Required only for search. Search URLs are generated from a fixed allowlist.",
        },
        url: {
          type: "string",
          maxLength: MAX_URL_CHARS,
          description: "Required only for open_url. HTTPS is required except for loopback development URLs.",
        },
      },
      required: ["action"],
      additionalProperties: false,
    },
    async call(rawInput: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
      let plan: BrowserSearchPlan;
      try {
        plan = prepareBrowserSearchInput(rawInput);
      } catch (error) {
        return {
          content: `BrowserSearch rejected locally: ${error instanceof Error ? error.message : String(error)} No browser was opened.`,
          isError: true,
        };
      }

      if (context.abortSignal?.aborted) {
        return { content: "BrowserSearch was cancelled before launch. No browser was opened.", isError: true };
      }
      const grant = consumeGrant(context.toolUseId, context.sessionId, plan);
      if (!grant) {
        return {
          content:
            "BrowserSearch was not executed because its exact input and session lack a fresh one-time grant from the central Jev/permission gate. No browser was opened.",
          isError: true,
        };
      }

      try {
        await runtime.ensureIndicator(context.sessionId, `BrowserSearch: ${plan.destinationHost}`);
        const accepted = await runtime.openExternalUrl(plan.canonicalUrl, context.abortSignal);
        if (!accepted) throw new Error("The operating system did not accept the browser launch request.");
        await runtime.wait(750, context.abortSignal);
        const windows = await runtime.listWindows(context.abortSignal).catch(() => []);
        const detected = windows.find(browserProcess);
        return {
          content: [
            "[BrowserSearch]",
            `action=${plan.action}`,
            ...(plan.engine ? [`engine=${plan.engine}`] : []),
            `destination_host=${plan.destinationHost}`,
            `requested_url=${resultUrl(plan)}`,
            "launch_status=accepted",
            `browser_window=${detected ? `${detected.processName} detected` : "not independently detected"}`,
            "page_load=not independently verified; no screenshot, accessibility scan, or vision model was used",
            `gate=${grant.decisionSummary}`,
            `final_permission=${grant.finalPermission}`,
          ].join("\n"),
        };
      } catch (error) {
        return {
          content: `BrowserSearch failed before completion: ${error instanceof Error ? error.message : String(error)}`,
          isError: true,
        };
      }
    },
    isReadOnly(): boolean {
      // Opening/focusing an external application and transmitting a query is
      // an observable side effect even though no file is modified.
      return false;
    },
    isEnabled(): boolean {
      const config = getComputerUseJevConfig();
      return ["win32", "darwin", "linux"].includes(process.platform)
        && config.enabled
        && config.mode === "enforce";
    },
  };
}

export const browserSearchTool = createBrowserSearchTool(DEFAULT_RUNTIME);
