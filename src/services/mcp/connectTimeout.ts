import type { McpServerConfig } from "../../types/mcp.js";

export const DEFAULT_MCP_CONNECT_TIMEOUT_MS = 30_000;

export function isValidMcpConnectTimeoutMs(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1_000 && value <= 600_000;
}

/** Resolve without reading process state, preserving the legacy environment fallback. */
export function resolveMcpConnectTimeoutMs(
  config: McpServerConfig,
  environmentTimeout: string | undefined,
  interactive = false,
): number {
  const parsedEnvironment = Number.parseInt(environmentTimeout || "", 10);
  const base = isValidMcpConnectTimeoutMs(config.connectTimeoutMs)
    ? config.connectTimeoutMs
    : Number.isFinite(parsedEnvironment) && parsedEnvironment > 0
      ? parsedEnvironment
      : DEFAULT_MCP_CONNECT_TIMEOUT_MS;
  // Browser consent retains its existing five-minute allowance.
  return interactive && config.type === "http" && config.oauth ? base + 5 * 60_000 : base;
}
