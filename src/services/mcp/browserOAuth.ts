import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import path from "node:path";
import { UnauthorizedError, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { OAuthTokensSchema, type OAuthClientInformationMixed, type OAuthClientMetadata, type OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { McpAuthOptions, McpBrowserOAuthConfig, McpOAuthConfig } from "../../types/mcp.js";
import { SecureCredentialStore } from "../../platform/secureStore.js";
import { getCCAgentHome } from "../../utils/paths.js";
import { abortable } from "./cancellation.js";
import { GoogleWorkspaceOAuthProvider, McpAuthorizationRequiredError } from "./googleOAuth.js";

const AUTH_TIMEOUT_MS = 5 * 60_000;
let browserAuthTail: Promise<void> = Promise.resolve();
type Runtime = { homeDir?: string; openExternal?: (url: string) => Promise<boolean> };

function loopback(url: URL): boolean {
  return ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
}

export function isValidBrowserMcpRedirectUri(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" && loopback(url) && !!url.port
      && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}

function normalizedServerUrl(value: string): string {
  const url = new URL(value);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback(url))) || url.username || url.password || url.hash) {
    throw new Error("Browser MCP OAuth requires HTTPS or an HTTP loopback server.");
  }
  return url.href;
}

function tokenStore(serverUrl: string, config: McpBrowserOAuthConfig, homeDir = getCCAgentHome()) {
  if (!isValidBrowserMcpRedirectUri(config.redirectUri)) throw new Error("MCP OAuth callback must be a loopback HTTP URL with an explicit port and no query.");
  const clientId = process.env[config.clientIdEnv]?.trim();
  if (!clientId) throw new Error(`MCP OAuth requires the configured ${config.clientIdEnv} client ID.`);
  const identity = createHash("sha256").update(JSON.stringify([normalizedServerUrl(serverUrl), clientId, config.redirectUri])).digest("hex");
  return new SecureCredentialStore<OAuthTokens>(path.join(homeDir, "oauth", "browser", `${identity}.json`));
}

/** Clear this account's local login only; this does not revoke the remote user's consent. */
export async function clearBrowserMcpOAuthCredentials(serverUrl: string, config: McpBrowserOAuthConfig, homeDir?: string): Promise<void> {
  await tokenStore(serverUrl, config, homeDir).clear();
}

function openExternal(url: string): Promise<boolean> {
  const [command, args] = process.platform === "win32" ? ["rundll32.exe", ["url.dll,FileProtocolHandler", url]]
    : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  return new Promise((resolve) => {
    const child = spawn(command!, args!, { detached: true, stdio: "ignore", windowsHide: true });
    child.once("error", () => resolve(false));
    child.once("spawn", () => { child.unref(); resolve(true); });
  });
}

async function receiveCode(redirectUrl: string, expectedState: string) {
  const redirect = new URL(redirectUrl);
  let settled = false;
  let resolveCode!: (value: string) => void;
  let rejectCode!: (reason: Error) => void;
  const code = new Promise<string>((resolve, reject) => { resolveCode = resolve; rejectCode = reject; });
  void code.catch(() => undefined);
  const settle = (error?: Error, value?: string) => {
    if (settled) return;
    settled = true;
    if (error) rejectCode(error); else resolveCode(value!);
  };
  const server = createServer((request, response) => {
    const reply = (status: number, message: string) => {
      response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
      response.end(message);
    };
    if (request.method !== "GET" || request.headers.host !== redirect.host) return reply(400, "Invalid callback request.");
    let incoming: URL;
    try { incoming = new URL(request.url ?? "/", redirect.origin); } catch { return reply(400, "Invalid callback request."); }
    if (incoming.origin !== redirect.origin || incoming.pathname !== redirect.pathname) return reply(404, "Not found.");
    // Unrelated/forged callbacks cannot cancel or complete a pending authorization.
    if (incoming.searchParams.get("state") !== expectedState) return reply(400, "Invalid authorization state.");
    if (incoming.searchParams.has("error")) {
      reply(400, "Authorization was declined. Return to CCAGENT.");
      settle(new Error("MCP OAuth authorization was declined."));
      return;
    }
    const value = incoming.searchParams.get("code");
    if (!value || value.length > 8192) return reply(400, "Missing authorization code.");
    reply(200, "CCAGENT authorization complete. You can close this window.");
    settle(undefined, value);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(Number(redirect.port), redirect.hostname.replace(/^\[|\]$/g, ""), () => { server.off("error", reject); resolve(); });
  });
  const timer = setTimeout(() => settle(new Error("MCP OAuth authorization timed out.")), AUTH_TIMEOUT_MS);
  return { code, close: async () => {
    clearTimeout(timer);
    if (!server.listening) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  } };
}

/** Registered-client OAuth. The SDK discovers metadata, generates PKCE and selects token authentication. */
export class BrowserMcpOAuthProvider implements OAuthClientProvider {
  readonly redirectUrl: string;
  readonly clientMetadata: OAuthClientMetadata;
  private readonly store: SecureCredentialStore<OAuthTokens>;
  private readonly lifetime = new AbortController();
  private authorizationUrl?: URL;
  private expectedState?: string;
  private verifier?: string;
  private requestTail: Promise<void> = Promise.resolve();
  private readonly tokenWrites = new Set<Promise<void>>();
  private readonly clientId: string;

  constructor(serverUrl: string, private readonly config: McpBrowserOAuthConfig, private readonly runtime: Runtime = {}) {
    this.store = tokenStore(serverUrl, config, runtime.homeDir);
    this.clientId = process.env[config.clientIdEnv]!.trim();
    this.redirectUrl = config.redirectUri;
    this.clientMetadata = { client_name: "CCAGENT", redirect_uris: [config.redirectUri],
      grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] };
  }

  clientInformation(): OAuthClientInformationMixed {
    const clientId = process.env[this.config.clientIdEnv]?.trim();
    const clientSecret = process.env[this.config.clientSecretEnv]?.trim();
    if (!clientId || !clientSecret) throw new Error("MCP OAuth requires the registered application's client ID and client secret.");
    if (clientId !== this.clientId) throw new Error("MCP OAuth client configuration changed; reconnect the application.");
    // No forced token_endpoint_auth_method: SDK uses the authorization server metadata.
    return { client_id: clientId, client_secret: clientSecret };
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    const saved = await this.store.read();
    if (!saved) return undefined;
    const parsed = OAuthTokensSchema.safeParse(saved);
    if (!parsed.success) throw new Error("MCP OAuth credentials are invalid; reconnect this application.");
    return parsed.data;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    const task = (async () => {
      this.lifetime.signal.throwIfAborted();
      const parsed = OAuthTokensSchema.parse(tokens);
      const existing = parsed.refresh_token ? undefined : await this.tokens();
      this.lifetime.signal.throwIfAborted();
      await this.store.write({ ...parsed, ...(parsed.refresh_token ? {} : existing?.refresh_token ? { refresh_token: existing.refresh_token } : {}) });
    })();
    this.tokenWrites.add(task);
    try { await task; } finally { this.tokenWrites.delete(task); }
  }

  state(): string { return this.expectedState = randomBytes(24).toString("base64url"); }
  redirectToAuthorization(url: URL): void {
    if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback(url))) || url.username || url.password || url.hash) {
      throw new Error("MCP OAuth returned an invalid authorization URL.");
    }
    if (!this.expectedState || url.searchParams.get("state") !== this.expectedState) throw new Error("MCP OAuth authorization state is missing.");
    this.authorizationUrl = new URL(url);
  }
  saveCodeVerifier(verifier: string): void { this.verifier = verifier; }
  codeVerifier(): string { if (!this.verifier) throw new Error("MCP OAuth PKCE verifier is unavailable."); return this.verifier; }

  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): Promise<void> {
    this.lifetime.signal.throwIfAborted();
    if (scope === "all" || scope === "tokens") await this.store.clear();
    if (scope === "all" || scope === "verifier") this.verifier = undefined;
  }

  private async authorize(signal: AbortSignal): Promise<string> {
    const previous = browserAuthTail;
    const task = (async () => {
      await abortable(previous, signal);
      signal.throwIfAborted();
      if (!this.authorizationUrl || !this.expectedState) throw new Error("MCP OAuth server did not provide an authorization challenge.");
      const receiver = await receiveCode(this.redirectUrl, this.expectedState);
      try {
        signal.throwIfAborted();
        if (!(await abortable((this.runtime.openExternal ?? openExternal)(this.authorizationUrl.href), signal))) {
          throw new Error("Cannot open the authorization browser. Check the default browser and retry authorization.");
        }
        return await abortable(receiver.code, signal);
      } finally { await receiver.close(); }
    })();
    // Keep the port lock until both the preceding authorization and this job finish.
    browserAuthTail = previous.then(() => task).then(() => undefined, () => undefined);
    try { return await task; } finally { this.authorizationUrl = undefined; this.expectedState = undefined; }
  }

  async runWithAuth<T>(transport: StreamableHTTPClientTransport, operation: () => Promise<T>, options: McpAuthOptions = {}): Promise<T> {
    const signal = options.signal ? AbortSignal.any([this.lifetime.signal, options.signal]) : this.lifetime.signal;
    const task = this.requestTail.then(async () => {
      signal.throwIfAborted();
      try { return await abortable(operation(), signal); }
      catch (error) {
        signal.throwIfAborted();
        if (!(error instanceof UnauthorizedError)) throw error;
        if (!options.interactive) throw new McpAuthorizationRequiredError();
        const code = await this.authorize(signal);
        signal.throwIfAborted();
        await abortable(transport.finishAuth(code), signal);
        signal.throwIfAborted();
        return await abortable(operation(), signal);
      }
    });
    this.requestTail = task.then(() => undefined, () => undefined);
    return abortable(task, signal);
  }

  async cancel(): Promise<void> {
    this.lifetime.abort(new Error("MCP server closed; authorization cancelled."));
    await this.requestTail;
    // A DPAPI write may already be in flight. Let it finish before uninstall clears the store.
    await Promise.allSettled(this.tokenWrites);
    this.verifier = undefined;
  }
}

export function createMcpOAuthProvider(serverUrl: string, config: McpOAuthConfig, runtime: Runtime = {}) {
  return config.provider === "google" ? new GoogleWorkspaceOAuthProvider(new URL(serverUrl).hostname, config, runtime)
    : new BrowserMcpOAuthProvider(serverUrl, config, runtime);
}
