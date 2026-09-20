/**
 * MCP (Model Context Protocol) types — Stage 16.
 *
 * Reference: claude-code-source-code/src/services/mcp/types.ts
 *
 * The source supports 8 transport types (stdio/sse/http/ws/sse-ide/ws-ide/sdk/
 * claudeai-proxy). CCAGENT supports the three that cover the public MCP
 * ecosystem: `stdio` (local subprocess), `http` (Streamable HTTP), and `sse`
 * (legacy SSE-only servers). WebSocket / IDE / SDK / Claude.ai proxy stay
 * out of scope. Streamable HTTP additionally supports Google OAuth for the
 * official Google Workspace remote MCP suite.
 */
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { ServerCapabilities } from "@modelcontextprotocol/sdk/types.js";

// ─── Configuration ───────────────────────────────────────────────────

/**
 * stdio MCP server configuration. The `type` field is optional for backwards
 * compatibility with the de-facto standard `mcpServers` shape used by the
 * MCP ecosystem (Claude Desktop, Cursor, etc.) — when missing, we treat the
 * config as stdio.
 */
export interface McpStdioServerConfig {
  enabled?: boolean;
  type?: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** Timeout for one tools/call request. Defaults to MCP_TOOL_TIMEOUT_MS or 5 minutes. */
  toolTimeoutMs?: number;
}

/**
 * Streamable HTTP MCP server (the recommended remote transport).
 *
 * Equivalent to source's `McpHTTPServerConfigSchema`. Static `headers` support
 * bearer-token APIs, while `oauth` enables the official Google Workspace MCP
 * browser flow without placing credentials in settings.json.
 */
export interface McpHTTPServerConfig {
  enabled?: boolean;
  type: "http";
  url: string;
  headers?: Record<string, string>;
  /** Browser OAuth used by Google's official Workspace MCP servers. */
  oauth?: McpGoogleOAuthConfig;
  toolTimeoutMs?: number;
}

/**
 * OAuth credentials stay environment-backed. `clientIdEnv` and
 * `clientSecretEnv` are variable NAMES, never the credential values.
 */
export interface McpGoogleOAuthConfig {
  provider: "google";
  clientIdEnv: string;
  clientSecretEnv: string;
  redirectUri: string;
}

/**
 * Legacy SSE MCP server. Many older MCP servers (and most of the public
 * `@modelcontextprotocol/server-*` packages from before Streamable HTTP
 * landed) speak this. The transport opens one long-lived GET that streams
 * server→client messages and POSTs each client→server JSON-RPC envelope.
 */
export interface McpSSEServerConfig {
  enabled?: boolean;
  type: "sse";
  url: string;
  headers?: Record<string, string>;
  toolTimeoutMs?: number;
}

export type McpServerConfig =
  | McpStdioServerConfig
  | McpHTTPServerConfig
  | McpSSEServerConfig;

/** Top-level config shape inside settings.json. */
export interface McpJsonConfig {
  mcpServers: Record<string, McpServerConfig>;
}

/** A server config tagged with the scope it came from (later sources override earlier). */
export type ScopedMcpServerConfig = McpServerConfig & {
  scope: import("../config/sources.js").SettingSource;
};

// ─── Connection State ────────────────────────────────────────────────

export interface ConnectedMcpServer {
  name: string;
  type: "connected";
  client: Client;
  capabilities: ServerCapabilities | undefined;
  serverInfo?: { name: string; version: string };
  config: ScopedMcpServerConfig;
  /** Serialize OAuth challenges, complete browser consent, then retry once. */
  runWithAuth?<T>(operation: () => Promise<T>, options?: McpAuthOptions): Promise<T>;
  /** Invalidates even tool adapters captured before Close/reconnect. */
  signal?: AbortSignal;
  discoveryError?: string;
  cleanup: () => Promise<void>;
}

export interface McpAuthOptions {
  /** Only an explicit /mcp auth command may open a browser. */
  interactive?: boolean;
  signal?: AbortSignal;
}

export interface FailedMcpServer {
  name: string;
  type: "failed";
  config: ScopedMcpServerConfig;
  error: string;
}

export interface DisabledMcpServer {
  name: string;
  type: "disabled";
  config: ScopedMcpServerConfig;
}

/**
 * Placeholder used while a server is still being spawned / handshaking.
 * The registry seeds one of these per configured server BEFORE any IO
 * happens, so `/mcp` always reflects intended state — even during a slow
 * `npx -y …` cold start. Replaced atomically when the connection resolves.
 */
export interface PendingMcpServer {
  name: string;
  type: "pending";
  config: ScopedMcpServerConfig;
  startedAt: number;
}

export type McpServerConnection =
  | ConnectedMcpServer
  | FailedMcpServer
  | DisabledMcpServer
  | PendingMcpServer;
