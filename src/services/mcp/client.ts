/**
 * MCP client connection management.
 *
 * Reference: claude-code-source-code/src/services/mcp/client.ts (3351 lines).
 *
 * What we keep (the educational core):
 *   - connectToServer()           — create transport + Client + handshake
 *   - 30s connect timeout (Promise.race)
 *   - In-memory connection cache  — same config key reuses the same Promise
 *   - SIGINT → SIGTERM → SIGKILL  cleanup escalation for stdio child procs
 *   - Promise.allSettled           — one server's failure doesn't kill the rest
 *
 * What remains out of scope:
 *   - WebSocket transport and arbitrary-provider OAuth
 *   - Roots reverse-RPC (Claude exposes cwd via file://; not needed yet)
 *   - Connection drop detection + auto-reconnect (consecutive error counter)
 *   - In-process transport for Chrome / Computer Use
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { execFile } from "node:child_process";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type {
  ConnectedMcpServer,
  McpHTTPServerConfig,
  McpSSEServerConfig,
  McpServerConnection,
  ScopedMcpServerConfig,
  McpAuthOptions,
} from "../../types/mcp.js";
import { debugLog, logWarn } from "../../utils/log.js";
import { CLIENT_NAME, USER_AGENT, VERSION } from "../../version.js";
import { GoogleWorkspaceOAuthProvider } from "./googleOAuth.js";
import { isMcpServerEnabled, loadMcpPreferences } from "./preferences.js";
import { abortable } from "./cancellation.js";

// ─── Connect timeout ─────────────────────────────────────────────────

const CONNECT_TIMEOUT_MS = 30_000;

function getConnectTimeoutMs(): number {
  const env = parseInt(process.env.MCP_CONNECT_TIMEOUT || "", 10);
  return Number.isFinite(env) && env > 0 ? env : CONNECT_TIMEOUT_MS;
}

// ─── Connection cache ────────────────────────────────────────────────

/**
 * Cache key includes the full config so a `/mcp reconnect` after editing
 * settings.json picks up the new command/args. Same as the source's
 * `getServerCacheKey(name, JSON.stringify(config))` pattern.
 */
function getCacheKey(name: string, config: ScopedMcpServerConfig): string {
  // Stringify the entire transport-specific config so that *any* edit
  // (command, args, env, url, headers, type-switch) yields a fresh cache
  // entry on next `connectToServer`. Order matters for stable hashing —
  // we list the fields explicitly per transport rather than JSON-stringify
  // the whole object to avoid spuriously busting the cache when scope
  // metadata (which doesn't affect the connection) changes.
  if (config.type === "http" || config.type === "sse") {
    return `${name}:${JSON.stringify({
      type: config.type,
      url: config.url,
      headers: config.headers,
      oauth: config.type === "http" ? config.oauth : undefined,
      toolTimeoutMs: config.toolTimeoutMs,
    })}`;
  }
  return `${name}:${JSON.stringify({
    type: "stdio",
    command: config.command,
    args: config.args,
    env: config.env,
    toolTimeoutMs: config.toolTimeoutMs,
  })}`;
}

const connectionCache = new Map<string, Promise<McpServerConnection>>();
const connectionControllers = new Map<string, AbortController>();

/** Track active connections for shutdown cleanup. */
const activeConnections = new Map<string, ConnectedMcpServer>();

// ─── Cleanup helpers ─────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Stdio cleanup escalation: SIGINT (100ms) → SIGTERM (400ms) → SIGKILL.
 * Total cap ~500ms so CLI exit isn't held up by a misbehaving server.
 *
 * Direct port of source code's escalation strategy
 * (client.ts:1431-1559) but flattened — no need for the resolved/timer
 * juggling because we await inline.
 */
async function escalatedKill(name: string, pid: number | undefined): Promise<void> {
  if (!pid) return;
  if (process.platform === "win32") {
    // npx may own a server grandchild. Killing only the wrapper leaves it alive.
    await new Promise<void>((resolve) => {
      execFile("taskkill.exe", ["/PID", String(pid), "/T", "/F"],
        { windowsHide: true, timeout: 2_000 }, () => resolve());
    });
    return;
  }
  const aliveCheck = (): boolean => {
    try {
      // signal 0 = "is the process still alive?"
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  try {
    process.kill(pid, "SIGINT");
  } catch (error) {
    debugLog("mcp", `[${name}] SIGINT failed: ${(error as Error).message}`);
    return;
  }
  await sleep(100);
  if (!aliveCheck()) return;

  debugLog("mcp", `[${name}] SIGINT didn't exit; sending SIGTERM`);
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  await sleep(400);
  if (!aliveCheck()) return;

  debugLog("mcp", `[${name}] SIGTERM didn't exit; sending SIGKILL`);
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* already dead */
  }
}

// ─── connectToServer ─────────────────────────────────────────────────

/**
 * Connect to a single MCP server. Cached per (name + config) — concurrent
 * callers share the same in-flight Promise. Failures are also cached briefly
 * but are dropped from `activeConnections`, so a follow-up `/mcp reconnect`
 * still triggers a real retry by clearing the cache key first.
 */
export async function connectToServer(
  name: string,
  config: ScopedMcpServerConfig,
  options: McpAuthOptions = {},
): Promise<McpServerConnection> {
  await loadMcpPreferences();
  if (!isMcpServerEnabled(name, config)) return { name, type: "disabled", config };
  const key = getCacheKey(name, config);
  const cached = connectionCache.get(key);
  if (cached && !connectionControllers.get(key)?.signal.aborted) return cached;

  const controller = new AbortController();
  connectionControllers.set(key, controller);
  const promise = doConnect(name, config, controller, options);
  connectionCache.set(key, promise);

  // If the connection ultimately resolves to a `connected` server, register
  // it for shutdown cleanup. Failed/disabled placeholders don't need cleanup.
  void promise.then((conn) => {
    if (conn.type === "connected" && connectionCache.get(key) === promise && !controller.signal.aborted) {
      activeConnections.set(name, conn);
    }
  });

  return promise;
}

/**
 * Per-transport-type "factory" — returns a Transport plus a per-transport
 * cleanup that the connection wrapper composes with `client.close()`.
 *
 * Splitting this out keeps `doConnect` focused on the parts that are
 * universal (handshake, timeout, capabilities introspection, error wrapping)
 * while letting stdio carry its child-process baggage and remote transports
 * stay delightfully minimal.
 */
interface TransportBundle {
  transport: Transport;
  /** Diagnostic prefix for this transport (e.g. "stdio: npx -y …"). */
  describe: string;
  /** Buffered stderr — only stdio populates this. */
  collectStderrTail: () => string;
  /**
   * Transport-specific shutdown step run BEFORE `client.close()`. For stdio
   * this is the SIGINT→SIGTERM→SIGKILL escalation; for remote it's a no-op
   * because the SDK's transport.close() already terminates the connection.
   */
  preCleanup: () => Promise<void>;
  /** OAuth-aware request wrapper. Present only on authenticated HTTP transports. */
  runWithAuth?<T>(operation: () => Promise<T>, options?: McpAuthOptions): Promise<T>;
  handshakeCompleted?: () => void;
}

function createStdioTransport(
  name: string,
  config: import("../../types/mcp.js").McpStdioServerConfig & { scope: string },
): TransportBundle {
  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args ?? [],
    env: {
      // Inherit parent env first, then layer per-server overrides.
      ...(process.env as Record<string, string>),
      ...(config.env ?? {}),
    },
    stderr: "pipe", // keep server stderr off our terminal UI
  });

  let stderrBuf = "";
  if (transport.stderr) {
    transport.stderr.on("data", (chunk: Buffer) => {
      if (stderrBuf.length < 64 * 1024) {
        stderrBuf += chunk.toString();
      }
    });
  }

  return {
    transport,
    describe: `stdio: ${config.command} ${(config.args ?? []).join(" ")}`.trim(),
    collectStderrTail: () => stderrBuf,
    preCleanup: async () => {
      const pid: number | undefined = (transport as { pid?: number }).pid;
      await escalatedKill(name, pid);
    },
  };
}

function createHttpTransport(config: McpHTTPServerConfig & { scope: string }, options: McpAuthOptions): TransportBundle {
  const oauthProvider = config.oauth
    ? new GoogleWorkspaceOAuthProvider(new URL(config.url).hostname, config.oauth)
    : undefined;
  const transport = new StreamableHTTPClientTransport(new URL(config.url), {
    ...(oauthProvider ? { authProvider: oauthProvider } : {}),
    // The SDK also uses this fetch for OAuth metadata/token requests. Closing
    // only the MCP stream would otherwise leave those HTTP requests running.
    fetch: (input, init) => fetch(input, {
      ...init,
      signal: AbortSignal.any([options.signal, init?.signal].filter((s): s is AbortSignal => !!s)),
    }),
    requestInit: {
      headers: {
        "User-Agent": USER_AGENT,
        ...(config.headers ?? {}),
      },
    },
  });
  // initialize can itself challenge OAuth. Wrap sends only during the handshake;
  // afterwards requests are wrapped as a whole (otherwise the serial queue deadlocks).
  const send = transport.send.bind(transport);
  if (oauthProvider) {
    transport.send = (message, sendOptions) => {
      // Restore BEFORE calling send: SDK token-refresh retries call this.send
      // recursively and must not enter the same serialized OAuth queue twice.
      transport.send = send;
      return oauthProvider.runWithAuth(transport, () => send(message, sendOptions), options);
    };
  }
  return {
    transport,
    describe: `http: ${config.url}`,
    collectStderrTail: () => "",
    preCleanup: async () => { await oauthProvider?.cancel(); },
    handshakeCompleted: () => { transport.send = send; },
    ...(oauthProvider
      ? { runWithAuth: <T>(operation: () => Promise<T>, authOptions?: McpAuthOptions) => oauthProvider.runWithAuth(transport, operation, authOptions) }
      : {}),
  };
}

function createSseTransport(config: McpSSEServerConfig & { scope: string }): TransportBundle {
  // SSE has TWO request paths and headers must be supplied to BOTH:
  //   1. requestInit  → POSTs (every JSON-RPC envelope sent client→server)
  //   2. eventSourceInit → the long-lived GET that streams server→client
  //
  // The source code (client.ts:644-672) is explicit that the eventSourceInit
  // fetch must NOT inherit any timeout wrapper, otherwise the SSE stream
  // dies after 60s. We don't have a timeout wrapper to begin with, so we
  // just ensure both header sets are present.
  const headers = {
    "User-Agent": USER_AGENT,
    ...(config.headers ?? {}),
  };
  const transport = new SSEClientTransport(new URL(config.url), {
    requestInit: { headers },
    eventSourceInit: {
      fetch: (url, init) =>
        fetch(url, {
          ...init,
          headers: {
            ...(init?.headers as Record<string, string> | undefined),
            ...headers,
            Accept: "text/event-stream",
          },
        }),
    },
  });
  return {
    transport,
    describe: `sse: ${config.url}`,
    collectStderrTail: () => "",
    preCleanup: async () => { /* sse: client.close() handles it */ },
  };
}

async function doConnect(
  name: string,
  config: ScopedMcpServerConfig,
  controller: AbortController,
  options: McpAuthOptions,
): Promise<McpServerConnection> {
  const summary =
    config.type === "http" || config.type === "sse"
      ? `${config.type} ${config.url}`
      : `stdio ${config.command} ${(config.args ?? []).join(" ")}`.trim();
  debugLog("mcp", `[${name}] connecting (${summary})`);

  let bundle: TransportBundle;
  try {
    if (config.type === "http") {
      bundle = createHttpTransport(config, { ...options, signal: controller.signal });
    } else if (config.type === "sse") {
      bundle = createSseTransport(config);
    } else {
      bundle = createStdioTransport(name, config);
    }
  } catch (error) {
    const err = (error as Error).message;
    logWarn(`MCP server '${name}' failed to initialize transport: ${err}`);
    return { name, type: "failed", config, error: err };
  }

  const client = new Client(
    { name: CLIENT_NAME, version: VERSION },
    {
      capabilities: {
        // We declare empty `roots` — CCAGENT doesn't yet expose project
        // roots back to the server (that needs setRequestHandler with
        // ListRootsRequestSchema). Declaring the capability is harmless.
        roots: {},
      },
    },
  );

  let cleaned = false;
  let cleaning: Promise<void> | undefined;
  const cleanup = (): Promise<void> => {
    if (cleaned) return cleaning ?? Promise.resolve();
    cleaned = true;
    controller.signal.removeEventListener("abort", onAbort);
    controller.abort(new Error(`MCP server '${name}' closed`));
    if (activeConnections.get(name)?.client === client) activeConnections.delete(name);
    cleaning = (async () => {
      await bundle.preCleanup();
      await client.close().catch(() => undefined);
    })();
    return cleaning;
  };
  const onAbort = (): void => { void cleanup().catch(() => undefined); };
  controller.signal.addEventListener("abort", onAbort, { once: true });
  const timeoutMs = options.interactive && config.type === "http" && config.oauth
    ? 5 * 60_000 + getConnectTimeoutMs() : getConnectTimeoutMs();
  const connectPromise = client.connect(bundle.transport, { timeout: timeoutMs, signal: controller.signal });

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error(`MCP server '${name}' connection timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    await abortable(Promise.race([connectPromise, timeoutPromise]), controller.signal);
  } catch (error) {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    const errMsg = (error as Error).message;
    const stderrTail = bundle.collectStderrTail();
    const detail = stderrTail ? `${errMsg} (stderr: ${stderrTail.slice(0, 200).trim()})` : errMsg;
    const cancelled = controller.signal.aborted;
    if (!cancelled) logWarn(`MCP server '${name}' failed to connect: ${detail}`);
    await cleanup();
    if (cancelled) return { name, type: "disabled", config };
    return { name, type: "failed", config, error: detail };
  }
  if (timeoutHandle) clearTimeout(timeoutHandle);
  bundle.handshakeCompleted?.();

  const capabilities = client.getServerCapabilities();
  const serverVersion = client.getServerVersion();
  debugLog(
    "mcp",
    `[${name}] connected via ${bundle.describe} (server=${serverVersion?.name ?? "?"} v${serverVersion?.version ?? "?"} caps=${JSON.stringify({
      tools: !!capabilities?.tools,
      resources: !!capabilities?.resources,
      prompts: !!capabilities?.prompts,
    })})`,
  );

  return {
    name,
    type: "connected",
    client,
    capabilities,
    serverInfo: serverVersion ? { name: serverVersion.name ?? name, version: serverVersion.version ?? "?" } : undefined,
    config,
    signal: controller.signal,
    ...(bundle.runWithAuth ? { runWithAuth: bundle.runWithAuth } : {}),
    cleanup,
  };
}

// ─── Reconnect / disconnect ─────────────────────────────────────────

/**
 * Drop the cache entry and (if connected) clean up the existing connection,
 * so the next `connectToServer` call re-spawns. Used by `/mcp reconnect`.
 */
export async function clearServerCache(
  name: string,
  config: ScopedMcpServerConfig,
): Promise<void> {
  const key = getCacheKey(name, config);
  const pending = connectionCache.get(key);
  connectionCache.delete(key);
  const controller = connectionControllers.get(key);
  connectionControllers.delete(key);
  controller?.abort(new Error(`MCP server '${name}' closed`));
  const existing = activeConnections.get(name);
  if (existing && getCacheKey(name, existing.config) === key) {
    if (activeConnections.get(name) === existing) activeConnections.delete(name);
    try {
      await existing.cleanup();
    } catch (error) {
      debugLog("mcp", `[${name}] cleanup during reconnect failed: ${(error as Error).message}`);
    }
  }

  // Deleting the cache alone is insufficient when the connection handshake is
  // still in flight: its completion callback would otherwise register a child
  // process after the plugin was disabled. Await and dispose that exact stale
  // instance without touching a newer connection with the same server name.
  if (pending) {
    const resolved = await pending.catch(() => undefined);
    if (resolved?.type === "connected" && resolved !== existing) {
      if (activeConnections.get(name) === resolved) activeConnections.delete(name);
      try {
        await resolved.cleanup();
      } catch (error) {
        debugLog("mcp", `[${name}] cleanup of in-flight connection failed: ${(error as Error).message}`);
      }
    }
  }
}

// ─── Process-level cleanup ──────────────────────────────────────────

let cleanupRegistered = false;

/**
 * Register a single SIGINT/SIGTERM/exit handler that cleans up every MCP
 * stdio child process. Without this, a Ctrl+C on the CLI leaves zombie
 * `npx @mcp/server-foo` processes running.
 */
export function registerMcpProcessCleanup(): void {
  if (cleanupRegistered) return;
  cleanupRegistered = true;

  const runCleanup = async (): Promise<void> => {
    for (const controller of connectionControllers.values()) controller.abort(new Error("MCP shutdown"));
    connectionControllers.clear();
    const conns = Array.from(activeConnections.values());
    activeConnections.clear();
    await Promise.allSettled(conns.map((c) => c.cleanup()));
  };

  // Fire-and-forget: SIGINT/SIGTERM listeners must be sync, but we still
  // want our async cleanup to start running. Worst case the process exits
  // before SIGKILL arrives (which is fine — that's the point).
  const onSignal = (signal: NodeJS.Signals) => {
    debugLog("mcp", `received ${signal}, cleaning up MCP servers`);
    void runCleanup();
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  process.once("beforeExit", () => {
    void runCleanup();
  });
}

/** Public for tests + `/mcp` command. */
export function getActiveMcpConnections(): readonly ConnectedMcpServer[] {
  return Array.from(activeConnections.values());
}

/**
 * Test-only: blow away the connection Promise cache and the active-connection
 * map. Used by hermetic smoke tests so one test's leftover Promise doesn't
 * fast-path another test's `connectToServer`.
 *
 * NOT exposed to the runtime UI — the user-facing equivalent is
 * `clearServerCache(name, config)` per server.
 */
export function _resetMcpClientForTesting(): void {
  for (const controller of connectionControllers.values()) controller.abort(new Error("MCP test reset"));
  connectionControllers.clear();
  connectionCache.clear();
  activeConnections.clear();
}

// (Batch-connect helper removed — bootstrap.ts now drives parallelism
// directly so it can update the registry incrementally as each connection
// resolves, instead of waiting for the whole batch to settle.)
