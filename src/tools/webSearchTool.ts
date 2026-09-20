import type { Tool, ToolContext, ToolResult } from "./Tool.js";
import {
  createAdapter,
  createFallbackAdapters,
  type SearchProvider,
  type SearchResult,
} from "./webSearch/adapters.js";
import { rerankSearchResultsWithJev } from "../services/jev/searchReranker.js";

/**
 * WebSearch — direct built-in web search.
 *
 * Tavily and Bocha are called directly over REST when configured; neither path
 * uses a Skill or MCP server. Bocha supplements Tavily on errors/no results,
 * while Anthropic server-side search and Bing remain available.
 */
interface WebSearchInput {
  query: string;
  allowed_domains?: string[];
  blocked_domains?: string[];
  max_results?: number;
  topic?: "general" | "news" | "finance";
  time_range?: "day" | "week" | "month" | "year";
  provider?: SearchProvider;
}

function formatResults(
  query: string,
  results: SearchResult[],
  provider: string,
  fallbackFrom?: string,
  jevSummary?: string,
): string {
  const providerLine = `Provider: ${provider}${fallbackFrom ? ` (fallback from ${fallbackFrom})` : ""}`;
  const rankingLine = jevSummary ? `\nRanking: ${jevSummary}` : "";
  if (results.length === 0) {
    return `Web search results for "${query}":\n${providerLine}${rankingLine}\n\nNo results found.`;
  }
  const lines = results.map((result) => {
    const base = `  - [${result.title}](${result.url})`;
    return result.snippet ? `${base}: ${result.snippet}` : base;
  });
  return (
    `Web search results for "${query}":\n${providerLine}${rankingLine}\n\nLinks:\n${lines.join("\n")}\n\n` +
    "REMINDER: cite the sources above as markdown links when you use them."
  );
}

export const webSearchTool: Tool = {
  name: "WebSearch",
  description:
    "Search the public web directly and return relevant links with snippets. Use it whenever an answer depends on current or external information. Tavily is the preferred configured provider; Bocha is a direct supplementary provider and is recommended for Chinese-language or China-specific queries. No Skill or MCP is involved.",
  inputSchema: {
    type: "object" as const,
    properties: {
      query: { type: "string", description: "The search query (at least 2 characters)" },
      allowed_domains: {
        type: "array",
        items: { type: "string" },
        description: "Only include results from these domains",
      },
      blocked_domains: {
        type: "array",
        items: { type: "string" },
        description: "Never include results from these domains",
      },
      max_results: {
        type: "integer",
        minimum: 1,
        maximum: 20,
        description: "Maximum number of results (default 10)",
      },
      topic: {
        type: "string",
        enum: ["general", "news", "finance"],
        description: "Search category; use news for current events",
      },
      time_range: {
        type: "string",
        enum: ["day", "week", "month", "year"],
        description: "Optional recency filter",
      },
      provider: {
        type: "string",
        enum: ["auto", "tavily", "bocha", "bing"],
        description: "Optional direct provider; use bocha for Chinese or China-specific queries",
      },
    },
    required: ["query"],
  },
  maxResultSizeChars: 100_000,
  async call(rawInput: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const input = rawInput as unknown as WebSearchInput;
    if (!input.query || typeof input.query !== "string" || input.query.trim().length < 2) {
      return { content: "Error: query must be at least 2 characters", isError: true };
    }
    if (input.allowed_domains?.length && input.blocked_domains?.length) {
      return {
        content: "Error: cannot specify both allowed_domains and blocked_domains",
        isError: true,
      };
    }
    if (
      input.max_results !== undefined &&
      (!Number.isInteger(input.max_results) || input.max_results < 1 || input.max_results > 20)
    ) {
      return { content: "Error: max_results must be an integer from 1 to 20", isError: true };
    }
    if (
      input.provider !== undefined &&
      !["auto", "tavily", "bocha", "bing"].includes(input.provider)
    ) {
      return { content: "Error: provider must be auto, tavily, bocha, or bing", isError: true };
    }

    const searchOptions = {
      allowedDomains: input.allowed_domains,
      blockedDomains: input.blocked_domains,
      signal: context.abortSignal,
      maxResults: input.max_results,
      topic: input.topic,
      timeRange: input.time_range,
    };

    const adapter = await createAdapter(context.defaultModel, input.provider ?? "auto");
    const candidates = [adapter, ...createFallbackAdapters(adapter.name)];
    let firstError: unknown;
    let lastEmptyProvider = adapter.name;
    let hadSuccessfulSearch = false;

    for (const candidate of candidates) {
      try {
        const results = await candidate.search(input.query, searchOptions);
        hadSuccessfulSearch = true;
        if (results.length > 0) {
          const ranked = await rerankSearchResultsWithJev(input.query, results, context.abortSignal);
          return {
            content: formatResults(
              input.query,
              ranked.results,
              candidate.name,
              candidate.name === adapter.name ? undefined : adapter.name,
              ranked.summary,
            ),
          };
        }
        lastEmptyProvider = candidate.name;
      } catch (error) {
        firstError ??= error;
        if (context.abortSignal?.aborted) break;
      }
    }

    if (hadSuccessfulSearch) {
      return {
        content: formatResults(
          input.query,
          [],
          lastEmptyProvider,
          lastEmptyProvider === adapter.name ? undefined : adapter.name,
        ),
      };
    }
    return {
      content: `WebSearch (${adapter.name}) failed: ${firstError instanceof Error ? firstError.message : String(firstError)}`,
      isError: true,
    };
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
