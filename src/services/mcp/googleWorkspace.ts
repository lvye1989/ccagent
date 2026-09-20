import type { McpHTTPServerConfig } from "../../types/mcp.js";

export const GOOGLE_MCP_CLIENT_ID_ENV = "GOOGLE_MCP_CLIENT_ID";
export const GOOGLE_MCP_CLIENT_SECRET_ENV = "GOOGLE_MCP_CLIENT_SECRET";
export const DEFAULT_GOOGLE_MCP_REDIRECT_URI = "http://127.0.0.1:53682/oauth/callback";

/** Official Google Workspace remote MCP servers (Developer Preview). */
export const GOOGLE_WORKSPACE_MCP_ENDPOINTS = {
  "google-gmail": "https://gmailmcp.googleapis.com/mcp/v1",
  "google-drive": "https://drivemcp.googleapis.com/mcp/v1",
  "google-docs": "https://docsmcp.googleapis.com/mcp/v1",
  "google-sheets": "https://sheetsmcp.googleapis.com/mcp/v1",
  "google-slides": "https://slidesmcp.googleapis.com/mcp/v1",
  "google-calendar": "https://calendarmcp.googleapis.com/mcp/v1",
  "google-chat": "https://chatmcp.googleapis.com/mcp/v1",
  "google-people": "https://people.googleapis.com/mcp/v1",
} as const;

export type GoogleWorkspaceMcpServerName = keyof typeof GOOGLE_WORKSPACE_MCP_ENDPOINTS;

export function isValidGoogleMcpRedirectUri(value: string): boolean {
  try {
    const redirect = new URL(value);
    return redirect.protocol === "http:"
      && ["127.0.0.1", "localhost", "::1"].includes(redirect.hostname)
      && Boolean(redirect.port);
  } catch {
    return false;
  }
}

export function buildGoogleWorkspaceMcpServers(
  redirectUri = DEFAULT_GOOGLE_MCP_REDIRECT_URI,
): Record<GoogleWorkspaceMcpServerName, McpHTTPServerConfig> {
  return Object.fromEntries(
    Object.entries(GOOGLE_WORKSPACE_MCP_ENDPOINTS).map(([name, url]) => [
      name,
      {
        type: "http",
        url,
        oauth: {
          provider: "google",
          clientIdEnv: GOOGLE_MCP_CLIENT_ID_ENV,
          clientSecretEnv: GOOGLE_MCP_CLIENT_SECRET_ENV,
          redirectUri,
        },
      } satisfies McpHTTPServerConfig,
    ]),
  ) as Record<GoogleWorkspaceMcpServerName, McpHTTPServerConfig>;
}
