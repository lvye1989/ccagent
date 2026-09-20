/**
 * WebSearch provider adapters.
 *
 * Reference: claude-code-source-code/src/tools/WebSearchTool/adapters/
 *   - adapters/index.ts   → createAdapter (provider selection)
 *   - adapters/apiAdapter.ts → Anthropic server-side `web_search_20250305` tool
 *   - adapters/bingAdapter.ts → Bing HTML scrape (no API key)
 *
 * Tavily and Bocha are integrated as direct REST backends. The Anthropic and
 * Bing adapters remain available as fallbacks; neither requires a third-party
 * search key.
 *
 * Selection (mirrors the source's intended logic):
 *   - env WEB_SEARCH_ADAPTER=tavily|bocha|api|bing forces a backend
 *   - TAVILY_API_KEY present              → Tavily REST API
 *   - bocha_API_KEY present               → Bocha REST API
 *   - first-party Anthropic endpoint → API server-side search
 *   - otherwise                      → Bing scrape fallback
 */

import Anthropic from "@anthropic-ai/sdk";
import he from "he";
import { getAnthropicClientForProfile } from "../../services/api/client.js";
import { resolveProfile } from "../../services/api/providers/profile.js";

export interface SearchResult {
  title: string;
  url: string;
  snippet?: string;
}

export interface SearchOptions {
  allowedDomains?: string[];
  blockedDomains?: string[];
  signal?: AbortSignal;
  maxResults?: number;
  topic?: "general" | "news" | "finance";
  timeRange?: "day" | "week" | "month" | "year";
}

export interface WebSearchAdapter {
  readonly name: string;
  search(query: string, options: SearchOptions): Promise<SearchResult[]>;
}

const DEFAULT_MAX_RESULTS = 10;
const TAVILY_ENDPOINT = "https://api.tavily.com/search";
const DEFAULT_TAVILY_TIMEOUT_MS = 20_000;
const BOCHA_ENDPOINT = "https://api.bochaai.com/v1/web-search";
const DEFAULT_BOCHA_TIMEOUT_MS = 20_000;

export type SearchProvider = "auto" | "tavily" | "bocha" | "anthropic" | "bing";

function clampMaxResults(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_MAX_RESULTS;
  return Math.min(20, Math.max(1, Math.trunc(value!)));
}

function tavilyApiKey(): string | undefined {
  return process.env.TAVILY_API_KEY?.trim() || process.env.WEB_SEARCH_API_KEY?.trim() || undefined;
}

function bochaApiKey(): string | undefined {
  return process.env.bocha_API_KEY?.trim() || process.env.BOCHA_API_KEY?.trim() || undefined;
}

function tavilyTimeoutMs(): number {
  const configured = Number(process.env.TAVILY_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0
    ? Math.min(configured, 120_000)
    : DEFAULT_TAVILY_TIMEOUT_MS;
}

function bochaTimeoutMs(): number {
  const configured = Number(process.env.BOCHA_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0
    ? Math.min(configured, 120_000)
    : DEFAULT_BOCHA_TIMEOUT_MS;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/** Apply allowed/blocked domain filters to a result list. */
export function filterByDomains(results: SearchResult[], options: SearchOptions): SearchResult[] {
  const allowed = options.allowedDomains?.map((d) => d.toLowerCase());
  const blocked = options.blockedDomains?.map((d) => d.toLowerCase());
  return results.filter((r) => {
    const host = hostOf(r.url);
    if (!host) return false;
    if (allowed && allowed.length > 0) {
      if (!allowed.some((d) => host === d || host.endsWith(`.${d}`))) return false;
    }
    if (blocked && blocked.length > 0) {
      if (blocked.some((d) => host === d || host.endsWith(`.${d}`))) return false;
    }
    return true;
  });
}

// ─── Tavily Search API (preferred when TAVILY_API_KEY is configured) ───────

interface TavilyResultPayload {
  title?: unknown;
  url?: unknown;
  content?: unknown;
}

/** Validate and normalize Tavily's response before it enters the model context. */
export function parseTavilyResponse(payload: unknown): SearchResult[] {
  if (!payload || typeof payload !== "object" || !Array.isArray((payload as { results?: unknown }).results)) {
    throw new Error("Tavily returned an invalid response: results must be an array");
  }

  const results: SearchResult[] = [];
  for (const raw of (payload as { results: unknown[] }).results) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as TavilyResultPayload;
    if (typeof item.url !== "string" || typeof item.title !== "string") continue;
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(item.url);
    } catch {
      continue;
    }
    if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") continue;
    const title = item.title.trim() || item.url;
    const snippet = typeof item.content === "string" ? item.content.trim().slice(0, 1_500) : undefined;
    results.push({ title, url: parsedUrl.toString(), ...(snippet ? { snippet } : {}) });
  }
  return results;
}

function tavilyErrorMessage(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const detail = (payload as { detail?: unknown }).detail;
  if (typeof detail === "string") return detail.slice(0, 300);
  if (detail && typeof detail === "object") {
    const error = (detail as { error?: unknown }).error;
    if (typeof error === "string") return error.slice(0, 300);
  }
  return undefined;
}

export class TavilySearchAdapter implements WebSearchAdapter {
  readonly name = "tavily";

  constructor(
    private readonly apiKey: string | undefined = tavilyApiKey(),
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
  ) {}

  async search(query: string, options: SearchOptions): Promise<SearchResult[]> {
    if (!this.apiKey) {
      throw new Error("TAVILY_API_KEY is not configured");
    }

    const timeoutMs = tavilyTimeoutMs();
    const controller = new AbortController();
    const abortFromParent = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", abortFromParent, { once: true });
    const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
    const maxResults = clampMaxResults(options.maxResults);

    try {
      const response = await this.fetchImpl(TAVILY_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query: query.trim(),
          search_depth: process.env.TAVILY_SEARCH_DEPTH?.trim() || "basic",
          max_results: maxResults,
          topic: options.topic ?? "general",
          ...(options.timeRange ? { time_range: options.timeRange } : {}),
          include_answer: false,
          include_raw_content: false,
          include_images: false,
          safe_search: true,
          ...(options.allowedDomains?.length ? { include_domains: options.allowedDomains } : {}),
          ...(options.blockedDomains?.length ? { exclude_domains: options.blockedDomains } : {}),
        }),
        signal: controller.signal,
      });

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new Error(`Tavily returned ${response.status} with invalid JSON`);
      }
      if (!response.ok) {
        const detail = tavilyErrorMessage(payload);
        throw new Error(`Tavily returned ${response.status}${detail ? `: ${detail}` : ""}`);
      }

      return filterByDomains(parseTavilyResponse(payload), options).slice(0, maxResults);
    } catch (error) {
      if (controller.signal.aborted && !options.signal?.aborted) {
        throw new Error(`Tavily search timed out after ${timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abortFromParent);
    }
  }
}

// ─── Bocha Web Search API (supplementary direct backend) ─────────────────

interface BochaResultPayload {
  name?: unknown;
  url?: unknown;
  snippet?: unknown;
  summary?: unknown;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/** Validate both documented `webPages` and API `data.webPages` responses. */
export function parseBochaResponse(payload: unknown): SearchResult[] {
  const root = objectValue(payload);
  const data = objectValue(root?.["data"]) ?? root;
  const webPages = objectValue(data?.["webPages"]);
  const values = webPages?.["value"];
  if (!Array.isArray(values)) {
    throw new Error("Bocha returned an invalid response: webPages.value must be an array");
  }

  const results: SearchResult[] = [];
  for (const raw of values) {
    const item = objectValue(raw) as BochaResultPayload | undefined;
    if (!item || typeof item.url !== "string" || typeof item.name !== "string") continue;
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(item.url);
    } catch {
      continue;
    }
    if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") continue;
    const title = item.name.trim() || item.url;
    const text = typeof item.summary === "string" && item.summary.trim()
      ? item.summary
      : typeof item.snippet === "string"
        ? item.snippet
        : undefined;
    const snippet = text?.trim().slice(0, 1_500);
    results.push({ title, url: parsedUrl.toString(), ...(snippet ? { snippet } : {}) });
  }
  return results;
}

function bochaErrorMessage(payload: unknown): string | undefined {
  const root = objectValue(payload);
  const message = root?.["message"] ?? root?.["msg"];
  return typeof message === "string" ? message.slice(0, 300) : undefined;
}

function bochaFreshness(timeRange: SearchOptions["timeRange"]): string {
  switch (timeRange) {
    case "day": return "oneDay";
    case "week": return "oneWeek";
    case "month": return "oneMonth";
    case "year": return "oneYear";
    default: return "noLimit";
  }
}

/** Direct Bocha REST adapter; no Skill or MCP transport is involved. */
export class BochaSearchAdapter implements WebSearchAdapter {
  readonly name = "bocha";

  constructor(
    private readonly apiKey: string | undefined = bochaApiKey(),
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
  ) {}

  async search(query: string, options: SearchOptions): Promise<SearchResult[]> {
    if (!this.apiKey) {
      throw new Error("bocha_API_KEY is not configured");
    }

    const timeoutMs = bochaTimeoutMs();
    const controller = new AbortController();
    const abortFromParent = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", abortFromParent, { once: true });
    const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
    const maxResults = clampMaxResults(options.maxResults);

    try {
      const response = await this.fetchImpl(BOCHA_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query: query.trim(),
          freshness: bochaFreshness(options.timeRange),
          summary: true,
          count: maxResults,
          ...(options.allowedDomains?.length ? { include: options.allowedDomains.join("|") } : {}),
          ...(options.blockedDomains?.length ? { exclude: options.blockedDomains.join("|") } : {}),
        }),
        signal: controller.signal,
      });

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new Error(`Bocha returned ${response.status} with invalid JSON`);
      }
      const root = objectValue(payload);
      const applicationCode = root?.["code"];
      if (!response.ok || (applicationCode !== undefined && String(applicationCode) !== "200")) {
        const detail = bochaErrorMessage(payload);
        throw new Error(`Bocha returned ${response.status}${detail ? `: ${detail}` : ""}`);
      }

      return filterByDomains(parseBochaResponse(payload), options).slice(0, maxResults);
    } catch (error) {
      if (controller.signal.aborted && !options.signal?.aborted) {
        throw new Error(`Bocha search timed out after ${timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abortFromParent);
    }
  }
}

// ─── Anthropic server-side search ─────────────────────────────────────────
// A secondary message attaches the `web_search_20250305` server tool. The
// response carries `web_search_tool_result` blocks that we normalize below.

export class AnthropicApiSearchAdapter implements WebSearchAdapter {
  readonly name = "anthropic";
  constructor(private readonly modelHandle?: string) {}

  async search(query: string, options: SearchOptions): Promise<SearchResult[]> {
    const profile = await resolveProfile(this.modelHandle ?? "");
    const client = getAnthropicClientForProfile(profile);

    const webSearchTool = {
      type: "web_search_20250305",
      name: "web_search",
      max_uses: 5,
      ...(options.allowedDomains?.length ? { allowed_domains: options.allowedDomains } : {}),
      ...(options.blockedDomains?.length ? { blocked_domains: options.blockedDomains } : {}),
    };

    const response = await client.messages.create(
      {
        model: profile.model,
        max_tokens: 2048,
        system: "You are an assistant performing a web search. Use the web_search tool to answer the query.",
        messages: [{ role: "user", content: `Perform a web search for the query: ${query}` }],
        tools: [webSearchTool] as unknown as Anthropic.MessageCreateParamsNonStreaming["tools"],
      },
      options.signal ? { signal: options.signal } : undefined,
    );

    const results: SearchResult[] = [];
    for (const block of response.content as Array<{ type: string; content?: unknown }>) {
      if (block.type !== "web_search_tool_result" || !Array.isArray(block.content)) continue;
      for (const r of block.content as Array<{ type?: string; title?: string; url?: string }>) {
        if (r.type === "web_search_result" && r.url) {
          results.push({ title: r.title ?? r.url, url: r.url });
        }
      }
    }
    return filterByDomains(results, options);
  }
}

// ─── Bing scrape (fallback, no key) ──────────────────────────────────────
//
// Mirrors BingSearchAdapter: fetch the Bing results page with browser-like
// headers and extract organic results via regex on the `b_algo` blocks.

const BING_TIMEOUT_MS = 30_000;
const BROWSER_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Cache-Control": "no-cache",
  Pragma: "no-cache",
};

export class BingSearchAdapter implements WebSearchAdapter {
  readonly name = "bing";

  async search(query: string, options: SearchOptions): Promise<SearchResult[]> {
    const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&setmkt=en-US`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), BING_TIMEOUT_MS);
    options.signal?.addEventListener("abort", () => controller.abort(), { once: true });

    let html: string;
    try {
      const response = await fetch(url, { headers: BROWSER_HEADERS, signal: controller.signal });
      if (!response.ok) throw new Error(`Bing returned ${response.status} ${response.statusText}`);
      html = await response.text();
    } finally {
      clearTimeout(timer);
    }

    return filterByDomains(extractBingResults(html), options).slice(
      0,
      clampMaxResults(options.maxResults),
    );
  }
}

export function extractBingResults(html: string): SearchResult[] {
  const results: SearchResult[] = [];
  const algoBlockRegex = /<li\s+class="b_algo"[^>]*>([\s\S]*?)<\/li>/gi;
  let blockMatch: RegExpExecArray | null;
  while ((blockMatch = algoBlockRegex.exec(html)) !== null) {
    const block = blockMatch[1];
    const linkMatch = /<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
    if (!linkMatch) continue;
    const url = resolveBingUrl(he.decode(linkMatch[1]));
    if (!url) continue;
    const title = he.decode(linkMatch[2].replace(/<[^>]+>/g, "").trim());
    const snippet = extractBingSnippet(block);
    results.push({ title, url, snippet });
  }
  return results;
}

function extractBingSnippet(block: string): string | undefined {
  const lineclamp = /<p[^>]*class="b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/i.exec(block);
  if (lineclamp) return he.decode(lineclamp[1].replace(/<[^>]+>/g, "").trim());
  const captionP = /<div[^>]*class="b_caption[^"]*"[^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i.exec(block);
  if (captionP) return he.decode(captionP[1].replace(/<[^>]+>/g, "").trim());
  return undefined;
}

/**
 * Resolve a Bing redirect URL (bing.com/ck/a?...&u=a1<base64>) to its target,
 * or return undefined for Bing-internal / relative links.
 */
export function resolveBingUrl(rawUrl: string): string | undefined {
  if (rawUrl.startsWith("/") || rawUrl.startsWith("#")) return undefined;
  const uMatch = rawUrl.match(/[?&]u=([a-zA-Z0-9+/_=-]+)/);
  if (uMatch && uMatch[1].length >= 3) {
    const b64 = uMatch[1].slice(2).replace(/-/g, "+").replace(/_/g, "/");
    try {
      const decoded = Buffer.from(b64, "base64").toString("utf-8");
      if (decoded.startsWith("http")) return decoded;
    } catch {
      // not a valid base64 redirect
    }
  }
  if (!rawUrl.includes("bing.com")) return rawUrl;
  return undefined;
}

// ─── Adapter selection ───────────────────────────────────────────────────

function isFirstPartyAnthropic(baseURL: string | undefined): boolean {
  const url = baseURL ?? process.env.ANTHROPIC_BASE_URL ?? "";
  if (!url) return true; // default endpoint is api.anthropic.com
  try {
    return new URL(url).hostname.endsWith("anthropic.com");
  } catch {
    return false;
  }
}

/**
 * Select a search adapter. `modelHandle` is the active model (so the Anthropic
 * API adapter rides on the user's configured profile/endpoint). Tavily wins
 * when its key is configured, then Bocha; otherwise a keyless adapter remains
 * available.
 */
export async function createAdapter(
  modelHandle?: string,
  preferredProvider: SearchProvider = "auto",
): Promise<WebSearchAdapter> {
  const envOverride = process.env.WEB_SEARCH_ADAPTER?.trim().toLowerCase();
  const selected = preferredProvider !== "auto" ? preferredProvider : envOverride;
  if (selected === "tavily") return new TavilySearchAdapter();
  if (selected === "bocha") return new BochaSearchAdapter();
  if (selected === "bing") return new BingSearchAdapter();
  if (selected === "api" || selected === "anthropic") return new AnthropicApiSearchAdapter(modelHandle);

  // A configured Tavily key makes direct REST search the default regardless
  // of the active text model. No Skill or MCP server is involved.
  if (tavilyApiKey()) return new TavilySearchAdapter();
  if (bochaApiKey()) return new BochaSearchAdapter();

  if (modelHandle) {
    try {
      const profile = await resolveProfile(modelHandle);
      if (profile.protocol === "anthropic" && isFirstPartyAnthropic(profile.baseURL)) {
        return new AnthropicApiSearchAdapter(modelHandle);
      }
    } catch {
      // fall through to Bing
    }
  }
  return new BingSearchAdapter();
}

/** Ordered secondary providers used for errors and empty-result isolation. */
export function createFallbackAdapters(primaryName: string): WebSearchAdapter[] {
  const fallbacks: WebSearchAdapter[] = [];
  if (primaryName !== "tavily" && tavilyApiKey()) fallbacks.push(new TavilySearchAdapter());
  if (primaryName !== "bocha" && bochaApiKey()) fallbacks.push(new BochaSearchAdapter());
  if (primaryName !== "bing") fallbacks.push(new BingSearchAdapter());
  return fallbacks;
}

export { DEFAULT_MAX_RESULTS };
