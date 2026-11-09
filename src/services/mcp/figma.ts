import type { McpHTTPServerConfig } from "../../types/mcp.js";

export const DEFAULT_FIGMA_MCP_URL = "http://127.0.0.1:3845/mcp";

/** The official desktop server only: never forward local design context to a remote URL. */
export function normalizeFigmaMcpUrl(value: unknown): string {
  const supplied = value === undefined || value === "" ? DEFAULT_FIGMA_MCP_URL : value;
  if (typeof supplied !== "string" || !/^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::[1-9]\d{0,4})?\/mcp\/?$/.test(supplied)) {
    throw new Error("Figma 桌面 MCP 地址须为本机 HTTP 地址，例如 http://127.0.0.1:3845/mcp。");
  }
  let url: URL;
  try { url = new URL(supplied); } catch { throw new Error("Figma 桌面 MCP 地址或端口无效。"); }
  return `${url.origin}/mcp`;
}

export function buildFigmaMcpConfig(credentials: Record<string, unknown> = {}): McpHTTPServerConfig {
  return { type: "http", url: normalizeFigmaMcpUrl(credentials.localUrl) };
}
