import type { Tool, ToolContext, ToolResult } from "./Tool.js";

const DEFAULT_BASE_URL = "https://api.cnkgraph.com";
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESULTS = 10;
const DEFAULT_MAX_CONTENT_CHARS = 12_000;

const ACTIONS = [
  "search_writings",
  "get_writing",
  "author_writings",
  "same_rhymes",
  "couplets",
  "writing_tones",
  "writing_book_links",
  "search_books",
  "get_book",
  "get_volume",
  "search_allusions",
  "get_glossary",
  "search_people",
  "get_person",
] as const;

export type ClassicWordsAction = (typeof ACTIONS)[number];

interface ClassicWordsInput {
  action: ClassicWordsAction;
  query?: string;
  writing_id?: number;
  dynasty?: string;
  author?: string;
  author_id?: number;
  writing_type?: string;
  clause_index?: string;
  exact_match?: boolean;
  show_matched_clause_only?: boolean;
  author_search_scope?: string;
  rhyme?: string;
  label_key?: string;
  page?: number;
  book_id?: string | number;
  volume_id?: string;
  glossary_type?: "词典" | "典故" | "佛典";
  entry_id?: number;
  char_index?: "begin" | "end";
  person_scope?: "Xing" | "Zi" | "Hao" | "ShiHao" | "FengJue" | "HomeTown";
  person_id?: number;
  begin_year?: number;
  end_year?: number;
  language?: "simplified" | "traditional";
  max_results?: number;
  max_content_chars?: number;
}

export interface ClassicWordsRequest {
  action: ClassicWordsAction;
  url: string;
  init: RequestInit;
  language: "simplified" | "traditional";
  maxResults: number;
  maxContentChars: number;
}

class InputError extends Error {}

function hasOwn(input: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(input, key);
}

function requiredText(input: Record<string, unknown>, key: string, maxLength = 5_000): string {
  const value = input[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new InputError(`${key} is required and must be a non-empty string`);
  }
  const trimmed = value.trim();
  if (trimmed.length > maxLength) throw new InputError(`${key} must be at most ${maxLength} characters`);
  return trimmed;
}

function optionalText(input: Record<string, unknown>, key: string, maxLength = 500): string | undefined {
  if (!hasOwn(input, key) || input[key] === undefined || input[key] === null) return undefined;
  return requiredText(input, key, maxLength);
}

function optionalBoolean(input: Record<string, unknown>, key: string): boolean | undefined {
  if (!hasOwn(input, key) || input[key] === undefined) return undefined;
  if (typeof input[key] !== "boolean") throw new InputError(`${key} must be a boolean`);
  return input[key] as boolean;
}

function integer(
  input: Record<string, unknown>,
  key: string,
  options: { required?: boolean; min?: number; max?: number } = {},
): number | undefined {
  const value = input[key];
  if (value === undefined || value === null) {
    if (options.required) throw new InputError(`${key} is required and must be an integer`);
    return undefined;
  }
  if (!Number.isSafeInteger(value)) throw new InputError(`${key} must be an integer`);
  const number = value as number;
  if (options.min !== undefined && number < options.min) {
    throw new InputError(`${key} must be at least ${options.min}`);
  }
  if (options.max !== undefined && number > options.max) {
    throw new InputError(`${key} must be at most ${options.max}`);
  }
  return number;
}

function oneOf<T extends string>(
  input: Record<string, unknown>,
  key: string,
  values: readonly T[],
  fallback?: T,
): T | undefined {
  const value = input[key];
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value !== "string" || !values.includes(value as T)) {
    throw new InputError(`${key} must be one of: ${values.join(", ")}`);
  }
  return value as T;
}

function configuredBaseUrl(): string {
  const candidate = process.env.CLASSIC_WORDS_BASE_URL?.trim() || DEFAULT_BASE_URL;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new InputError("CLASSIC_WORDS_BASE_URL must be a valid HTTPS URL");
  }
  const host = parsed.hostname.toLowerCase();
  if (parsed.protocol !== "https:" || (host !== "cnkgraph.com" && !host.endsWith(".cnkgraph.com"))) {
    throw new InputError("CLASSIC_WORDS_BASE_URL must use HTTPS on cnkgraph.com");
  }
  parsed.pathname = "/";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

function endpoint(baseUrl: string, segments: Array<string | number>): URL {
  const path = segments.map((segment) => encodeURIComponent(String(segment))).join("/");
  return new URL(`/api/${path}`, `${baseUrl}/`);
}

function addPage(url: URL, page: number): void {
  url.searchParams.set("pageNo", String(page));
}

function requestBody(body: Record<string, unknown> | unknown[]): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

/** Build and validate a CNKGraph request without performing network I/O. */
export function buildClassicWordsRequest(
  rawInput: Record<string, unknown>,
  baseUrl = configuredBaseUrl(),
): ClassicWordsRequest {
  const action = oneOf(rawInput, "action", ACTIONS);
  if (!action) throw new InputError(`action is required (${ACTIONS.join(", ")})`);
  const language = oneOf(rawInput, "language", ["simplified", "traditional"] as const, "simplified")!;
  const page = integer(rawInput, "page", { min: 0, max: 10_000 }) ?? 0;
  const maxResults = integer(rawInput, "max_results", { min: 1, max: 50 }) ?? DEFAULT_MAX_RESULTS;
  const maxContentChars =
    integer(rawInput, "max_content_chars", { min: 500, max: 60_000 }) ?? DEFAULT_MAX_CONTENT_CHARS;

  let url: URL;
  let init: RequestInit = { method: "GET" };

  switch (action) {
    case "search_writings": {
      const query = optionalText(rawInput, "query", 500);
      const author = optionalText(rawInput, "author", 100);
      const dynasty = optionalText(rawInput, "dynasty", 100);
      const writingType = optionalText(rawInput, "writing_type", 100);
      const rhyme = optionalText(rawInput, "rhyme", 20);
      const labelKey = optionalText(rawInput, "label_key", 100);
      if (!query && !author && !dynasty && !writingType && !rhyme && !labelKey) {
        throw new InputError(
          "search_writings requires at least one of query, author, dynasty, writing_type, rhyme, or label_key",
        );
      }
      const body: Record<string, unknown> = { pageNo: page };
      if (query) body.key = query;
      if (author) body.author = author;
      if (dynasty) body.dynasty = dynasty;
      if (writingType) body.writingType = writingType;
      if (rhyme) body.rhyme = rhyme;
      if (labelKey) body.labelKey = labelKey;
      const clauseIndex = optionalText(rawInput, "clause_index", 20);
      const authorScope = optionalText(rawInput, "author_search_scope", 20);
      if (clauseIndex) body.clauseIndex = clauseIndex;
      if (authorScope) body.authorSearchScope = authorScope;
      const exactlyMatch = optionalBoolean(rawInput, "exact_match");
      const matchedOnly = optionalBoolean(rawInput, "show_matched_clause_only");
      if (exactlyMatch !== undefined) body.exactlyMatch = exactlyMatch;
      if (matchedOnly !== undefined) body.showMatchedClauseOnly = matchedOnly;
      url = endpoint(baseUrl, ["writing", "find"]);
      init = requestBody(body);
      break;
    }
    case "get_writing":
      url = endpoint(baseUrl, ["writing", integer(rawInput, "writing_id", { required: true, min: 1 })!]);
      break;
    case "author_writings": {
      const dynasty = requiredText(rawInput, "dynasty", 100);
      const author = requiredText(rawInput, "author", 100);
      const authorId = integer(rawInput, "author_id", { min: 1 });
      const writingType = optionalText(rawInput, "writing_type", 100);
      if (writingType && authorId === undefined) {
        throw new InputError("author_writings with writing_type also requires author_id");
      }
      const segments: Array<string | number> = ["writing", dynasty, author];
      if (authorId !== undefined) segments.push(authorId);
      if (writingType) segments.push(writingType);
      url = endpoint(baseUrl, segments);
      addPage(url, page);
      break;
    }
    case "same_rhymes": {
      const key = rawInput.writing_id !== undefined
        ? String(integer(rawInput, "writing_id", { required: true, min: 1 }))
        : requiredText(rawInput, "query", 5_000);
      url = endpoint(baseUrl, ["writing", "SameRhymes", key]);
      break;
    }
    case "couplets":
      url = endpoint(baseUrl, ["writing", "Couplet", requiredText(rawInput, "query", 100)]);
      break;
    case "writing_tones":
      url = endpoint(baseUrl, ["writing", integer(rawInput, "writing_id", { required: true, min: 1 })!, "tones"]);
      break;
    case "writing_book_links":
      url = endpoint(baseUrl, ["writing", integer(rawInput, "writing_id", { required: true, min: 1 })!, "bookLinks"]);
      addPage(url, page);
      break;
    case "search_books":
      url = endpoint(baseUrl, ["book", "find"]);
      init = requestBody({ key: requiredText(rawInput, "query", 500), pageNo: page });
      break;
    case "get_book": {
      const bookId = rawInput.book_id;
      if ((typeof bookId !== "string" && typeof bookId !== "number") || !String(bookId).trim()) {
        throw new InputError("book_id is required and must be a string or number");
      }
      url = endpoint(baseUrl, ["book", String(bookId).trim()]);
      break;
    }
    case "get_volume":
      url = endpoint(baseUrl, ["book", "volume", requiredText(rawInput, "volume_id", 200)]);
      break;
    case "search_allusions": {
      const charIndex = oneOf(rawInput, "char_index", ["begin", "end"] as const);
      url = endpoint(baseUrl, ["glossary", "典故", "find"]);
      init = requestBody({
        key: requiredText(rawInput, "query", 200),
        ...(charIndex ? { charIndex } : {}),
      });
      break;
    }
    case "get_glossary": {
      const type = oneOf(rawInput, "glossary_type", ["词典", "典故", "佛典"] as const);
      if (!type) throw new InputError("glossary_type is required (词典, 典故, or 佛典)");
      url = endpoint(baseUrl, ["glossary", type, integer(rawInput, "entry_id", { required: true, min: 1 })!]);
      break;
    }
    case "search_people": {
      const scope = oneOf(
        rawInput,
        "person_scope",
        ["Xing", "Zi", "Hao", "ShiHao", "FengJue", "HomeTown"] as const,
      );
      if (!scope) throw new InputError("person_scope is required for search_people");
      const body: Record<string, unknown> = {
        scope,
        key: requiredText(rawInput, "query", 200),
      };
      const begin = integer(rawInput, "begin_year", { min: -5000, max: 5000 });
      const end = integer(rawInput, "end_year", { min: -5000, max: 5000 });
      if (begin !== undefined) body.begin = begin;
      if (end !== undefined) body.end = end;
      url = endpoint(baseUrl, ["people", "find"]);
      init = requestBody(body);
      break;
    }
    case "get_person":
      url = endpoint(baseUrl, ["people", integer(rawInput, "person_id", { required: true, min: 1 })!]);
      break;
  }

  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  headers.set("Accept-Language", language === "traditional" ? "zh-hant" : "zh-CN");
  headers.set("User-Agent", "ccagent/0.1.1 classic_words");
  init.headers = headers;

  return { action, url: url.toString(), init, language, maxResults, maxContentChars };
}

function timeoutMs(): number {
  const configured = Number(process.env.CLASSIC_WORDS_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0
    ? Math.min(60_000, Math.trunc(configured))
    : DEFAULT_TIMEOUT_MS;
}

const LIMITED_ARRAY_KEYS = new Set([
  "Writings",
  "Result",
  "Summary",
  "Books",
  "Volumes",
  "Pages",
  "Couplets",
  "Links",
  "BookLinks",
  "People",
  "Persons",
  "Items",
  "SimilarClauses",
]);

interface PrunedResult {
  value: unknown;
  notes: string[];
}

function prunePayload(value: unknown, maxResults: number, maxContentChars: number): PrunedResult {
  const notes: string[] = [];

  function visit(current: unknown, path: string, parentKey?: string): unknown {
    if (typeof current === "string") {
      if (current.length <= maxContentChars) return current;
      notes.push(`${path}: text truncated from ${current.length} to ${maxContentChars} characters`);
      return `${current.slice(0, maxContentChars)}\n[文本已截断]`;
    }
    if (Array.isArray(current)) {
      const shouldLimit = path === "$" || (parentKey !== undefined && LIMITED_ARRAY_KEYS.has(parentKey));
      const selected = shouldLimit ? current.slice(0, maxResults) : current;
      if (selected.length < current.length) {
        notes.push(`${path}: showing ${selected.length} of ${current.length} items`);
      }
      return selected.map((item, index) => visit(item, `${path}[${index}]`));
    }
    if (!current || typeof current !== "object") return current;
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(current as Record<string, unknown>)) {
      output[key] = visit(child, `${path}.${key}`, key);
    }
    return output;
  }

  return { value: visit(value, "$"), notes };
}

function responseErrorSnippet(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 500);
}

function formatResult(request: ClassicWordsRequest, payload: unknown): string {
  const pruned = prunePayload(payload, request.maxResults, request.maxContentChars);
  const notes = pruned.notes.length > 0
    ? `\nTruncation:\n${pruned.notes.map((note) => `- ${note}`).join("\n")}`
    : "";
  return (
    `CNKGraph classic literature result\n` +
    `Action: ${request.action}\n` +
    `Source API: ${request.url}\n` +
    `Script: ${request.language}\n` +
    `Usage: CNKGraph open resources are for research and learning; confirm permission before commercial use.` +
    `${notes}\n\n${JSON.stringify(pruned.value, null, 2)}`
  );
}

export function createClassicWordsTool(fetchImpl: typeof fetch = globalThis.fetch): Tool {
  return {
    name: "classic_words",
    description:
      "Query CNKGraph's classical Chinese literature databases directly (built-in REST tool; no Skill or MCP). " +
      "Use whenever the user asks to find poems, ci, prose, authors, exact works, same-rhyme works, antithetical couplets, tonal patterns, classical-book sources, ancient-book passages, allusions, or historical people. " +
      "Prefer search_writings for poetry/article queries and search_books for passages in ancient books; then use get_writing/get_book/get_volume for details.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ACTIONS,
          description: "CNKGraph operation to perform",
        },
        query: { type: "string", description: "Keyword, poem text, rhyme text, couplet words, allusion, or person query" },
        writing_id: { type: "integer", minimum: 1, description: "Poetry/prose work ID" },
        dynasty: { type: "string", description: "Dynasty or literary period, e.g. 唐朝, 中唐, 宋朝" },
        author: { type: "string", description: "Author name" },
        author_id: { type: "integer", minimum: 1, description: "Author ID when known" },
        writing_type: { type: "string", description: "Writing type code, e.g. QiJue, WuLv, Ci, Fu, GuFeng" },
        clause_index: { type: "string", description: "Search location: title, content, sentence, couplet, or sentence index 0-8" },
        exact_match: { type: "boolean", description: "Whether keyword matching must be exact" },
        show_matched_clause_only: { type: "boolean", description: "Return only matching clauses when supported" },
        author_search_scope: { type: "string", description: "Author field: Xing, Zi, Hao, ShiHao, or FengJue" },
        rhyme: { type: "string", description: "Rhyme category or Cilin Zhengyun index" },
        label_key: { type: "string", description: "Only search writings containing this knowledge-graph label" },
        page: { type: "integer", minimum: 0, maximum: 10000, description: "Zero-based page number; default 0" },
        book_id: { description: "Ancient-book ID", anyOf: [{ type: "string" }, { type: "integer" }] },
        volume_id: { type: "string", description: "Ancient-book volume ID, e.g. KR4h0140_024" },
        glossary_type: { type: "string", enum: ["词典", "典故", "佛典"], description: "Glossary database" },
        entry_id: { type: "integer", minimum: 1, description: "Glossary entry ID" },
        char_index: { type: "string", enum: ["begin", "end"], description: "Allusion keyword position" },
        person_scope: {
          type: "string",
          enum: ["Xing", "Zi", "Hao", "ShiHao", "FengJue", "HomeTown"],
          description: "Historical-person search field",
        },
        person_id: { type: "integer", minimum: 1, description: "Historical person ID" },
        begin_year: { type: "integer", minimum: -5000, maximum: 5000 },
        end_year: { type: "integer", minimum: -5000, maximum: 5000 },
        language: {
          type: "string",
          enum: ["simplified", "traditional"],
          description: "Response script; traditional requests unconverted original text with Accept-Language: zh-hant",
        },
        max_results: { type: "integer", minimum: 1, maximum: 50, description: "Maximum items retained per major result list; default 10" },
        max_content_chars: { type: "integer", minimum: 500, maximum: 60000, description: "Maximum characters retained for one long text field; default 12000" },
      },
      required: ["action"],
      additionalProperties: false,
    },
    maxResultSizeChars: 80_000,
    async call(rawInput: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
      let request: ClassicWordsRequest;
      try {
        request = buildClassicWordsRequest(rawInput);
      } catch (error) {
        return {
          content: `classic_words input error: ${error instanceof Error ? error.message : String(error)}`,
          isError: true,
        };
      }

      const controller = new AbortController();
      const duration = timeoutMs();
      const abortFromParent = () => controller.abort(context.abortSignal?.reason);
      if (context.abortSignal?.aborted) {
        controller.abort(context.abortSignal.reason);
      } else {
        context.abortSignal?.addEventListener("abort", abortFromParent, { once: true });
      }
      const timer = setTimeout(() => controller.abort(new Error("timeout")), duration);

      try {
        const response = await fetchImpl(request.url, { ...request.init, signal: controller.signal });
        const text = await response.text();
        if (!response.ok) {
          const detail = responseErrorSnippet(text);
          return {
            content: `classic_words CNKGraph request failed with HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
            isError: true,
          };
        }
        let payload: unknown;
        try {
          payload = JSON.parse(text);
        } catch {
          const contentType = response.headers.get("content-type") ?? "unknown";
          return {
            content:
              `classic_words expected JSON but CNKGraph returned ${contentType}. ` +
              `The endpoint may have changed or routed to an HTML page.`,
            isError: true,
          };
        }
        if (!payload || typeof payload !== "object") {
          return {
            content: "classic_words expected a JSON object or array from CNKGraph, but received a primitive value.",
            isError: true,
          };
        }
        return { content: formatResult(request, payload) };
      } catch (error) {
        if (controller.signal.aborted && !context.abortSignal?.aborted) {
          return { content: `classic_words timed out after ${duration}ms`, isError: true };
        }
        if (context.abortSignal?.aborted) {
          return { content: "classic_words was cancelled", isError: true };
        }
        return {
          content: `classic_words CNKGraph request failed: ${error instanceof Error ? error.message : String(error)}`,
          isError: true,
        };
      } finally {
        clearTimeout(timer);
        context.abortSignal?.removeEventListener("abort", abortFromParent);
      }
    },
    isReadOnly(): boolean {
      return true;
    },
    isEnabled(): boolean {
      return true;
    },
    isConcurrencySafe(): boolean {
      return true;
    },
  };
}

export const classicWordsTool = createClassicWordsTool();
