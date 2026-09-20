/** Live MCP startup, per-server switches, and generation-safe reconciliation. */
import type { McpServerConnection, ScopedMcpServerConfig, McpAuthOptions } from "../../types/mcp.js";
import { registerMcpTools } from "../../tools/index.js";
import { loadMcpConfigs } from "./config.js";
import { connectToServer, registerMcpProcessCleanup, clearServerCache } from "./client.js";
import { fetchToolsForConnection } from "./fetchTools.js";
import { getMcpRegistry, getMcpRegistryEntry, setMcpRegistryEntry } from "./registry.js";
import { isMcpServerEnabled, loadMcpPreferences, saveMcpServerState } from "./preferences.js";
import { logWarn } from "../../utils/log.js";

export interface McpBootstrapResult {
  connections: McpServerConnection[];
  toolCount: number;
  configErrors: string[];
}

export function refreshGlobalToolRegistry(): void {
  registerMcpTools(getMcpRegistry().flatMap((entry) => entry.tools));
}

function placeholder(name: string, config: ScopedMcpServerConfig): McpServerConnection {
  return isMcpServerEnabled(name, config)
    ? { name, config, type: "pending", startedAt: Date.now() }
    : { name, config, type: "disabled" };
}

async function finishConnection(
  expected: McpServerConnection,
  options: McpAuthOptions = {},
  isCurrent: () => boolean = () => true,
): Promise<McpServerConnection> {
  const { name, config } = expected;
  const connection = await connectToServer(name, config, options);
  const tools = connection.type === "connected" ? await fetchToolsForConnection(connection, options) : [];
  // A late startup, plugin refresh, or OAuth result cannot resurrect a closed
  // server or replace the result of a newer Open/reconnect command.
  if (getMcpRegistryEntry(name)?.connection !== expected || !isCurrent()) {
    const current = getMcpRegistryEntry(name)?.connection;
    // Two plugin refreshes can share the client's cached handshake. The stale
    // refresh must not dispose a connection still owned by the newer refresh.
    const shared = connection.type === "connected" && (
      (current?.type === "connected" && current.client === connection.client) ||
      (current?.type === "pending" && current !== expected && JSON.stringify(current.config) === JSON.stringify(config))
    );
    if (connection.type === "connected" && !shared) await connection.cleanup();
    return getMcpRegistryEntry(name)?.connection ?? connection;
  }
  const next = !isMcpServerEnabled(name, config) ? { name, config, type: "disabled" as const } : connection;
  setMcpRegistryEntry(name, next, next.type === "connected" && !next.signal?.aborted ? tools : []);
  refreshGlobalToolRegistry();
  return next;
}

/** Shared by settings and plugin MCPs, including pending entries in the menu. */
export async function startMcpServer(
  name: string,
  config: ScopedMcpServerConfig,
  isCurrent: () => boolean = () => true,
): Promise<McpServerConnection> {
  await loadMcpPreferences();
  const next = placeholder(name, config);
  if (!isCurrent()) return next;
  setMcpRegistryEntry(name, next, []);
  refreshGlobalToolRegistry();
  return finishConnection(next, {}, isCurrent);
}

export async function bootstrapMcp(cwd: string): Promise<McpBootstrapResult> {
  const [{ servers, errors: configErrors }] = await Promise.all([loadMcpConfigs(cwd), loadMcpPreferences()]);
  registerMcpProcessCleanup();
  // Do not clear the whole registry here: plugin startup runs concurrently.
  const results = await Promise.allSettled(Object.entries(servers).map(([name, config]) => startMcpServer(name, config)));
  return {
    connections: results.flatMap((r) => r.status === "fulfilled" ? [r.value] : []),
    toolCount: Object.keys(servers).reduce((count, name) => count + (getMcpRegistryEntry(name)?.tools.length ?? 0), 0),
    configErrors,
  };
}

export async function reconnectMcpServer(name: string, options: McpAuthOptions = {}): Promise<McpServerConnection | null> {
  await loadMcpPreferences();
  const entry = getMcpRegistryEntry(name);
  if (!entry) return null;
  const next = placeholder(name, entry.connection.config);
  setMcpRegistryEntry(name, next, []);
  refreshGlobalToolRegistry();
  await clearServerCache(name, next.config);
  if (getMcpRegistryEntry(name)?.connection !== next) return getMcpRegistryEntry(name)?.connection ?? null;
  if (next.type === "disabled") return next;
  return finishConnection(next, options);
}

/** Start asynchronously so a pending authorization never blocks a Close command. */
export function requestMcpReconnect(name: string, interactive = false): void {
  void reconnectMcpServer(name, { interactive }).catch((error) => {
    logWarn(`MCP server '${name}' reconnect failed: ${(error as Error).message}`);
  });
}

export async function setMcpServerOpen(name: string, open: boolean): Promise<void> {
  const entry = getMcpRegistryEntry(name);
  if (!entry) throw new Error(`MCP server '${name}' is not configured or has not been approved.`);
  if (open && entry.connection.config.scope === "policy" && entry.connection.config.enabled === false) {
    throw new Error(`MCP server '${name}' is disabled by managed policy.`);
  }
  await saveMcpServerState(name, open ? "open" : "close");
  if (open) {
    if (entry.connection.type !== "connected" && entry.connection.type !== "pending") requestMcpReconnect(name);
    return;
  }
  setMcpRegistryEntry(name, { name, config: entry.connection.config, type: "disabled" }, []);
  refreshGlobalToolRegistry();
  await clearServerCache(name, entry.connection.config);
}
