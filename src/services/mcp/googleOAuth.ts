import * as fs from "node:fs/promises";
import { createServer, type Server } from "node:http";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import type { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { McpGoogleOAuthConfig, McpAuthOptions } from "../../types/mcp.js";
import { abortable } from "./cancellation.js";
import { getCCAgentHome } from "../../utils/paths.js";
import { logWarn } from "../../utils/log.js";

const AUTH_TIMEOUT_MS = 5 * 60_000;

let browserAuthTail: Promise<void> = Promise.resolve();

async function serializeBrowserAuth<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  const previous = browserAuthTail;
  const task = (async () => {
    await abortable(previous, signal);
    signal.throwIfAborted();
    return operation();
  })();
  // A cancelled queued job may finish early but must not release the port lock
  // while the preceding job still owns it.
  browserAuthTail = previous.then(() => task).then(() => undefined, () => undefined);
  return task;
}

export class McpAuthorizationRequiredError extends Error {
  constructor() {
    super("Authorization required. Use /mcp auth <serverName>; background browser authorization is disabled.");
    this.name = "McpAuthorizationRequiredError";
  }
}

async function openExternal(url: string): Promise<boolean> {
  const command = process.platform === "win32"
    ? { file: "rundll32.exe", args: ["url.dll,FileProtocolHandler", url] }
    : process.platform === "darwin"
      ? { file: "open", args: [url] }
      : { file: "xdg-open", args: [url] };

  return await new Promise<boolean>((resolve) => {
    const child = spawn(command.file, command.args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", () => resolve(false));
    child.once("spawn", () => {
      child.unref();
      resolve(true);
    });
  });
}

interface CallbackReceiver {
  code: Promise<string>;
  close: () => Promise<void>;
}

async function startCallbackReceiver(
  redirectUri: string,
  expectedState: string,
): Promise<CallbackReceiver> {
  const redirect = new URL(redirectUri);
  const port = Number(redirect.port);
  let server: Server;
  let settled = false;
  let resolveCode!: (code: string) => void;
  let rejectCode!: (error: Error) => void;
  const code = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  // A callback may arrive before openExternal resolves.
  void code.catch(() => undefined);

  const settle = (error: Error | null, authorizationCode?: string): void => {
    if (settled) return;
    settled = true;
    if (error) rejectCode(error);
    else resolveCode(authorizationCode!);
  };

  server = createServer((request, response) => {
    const incoming = new URL(request.url ?? "/", redirect.origin);
    if (incoming.pathname !== redirect.pathname) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }

    const oauthError = incoming.searchParams.get("error");
    const authorizationCode = incoming.searchParams.get("code");
    const state = incoming.searchParams.get("state");
    if (oauthError) {
      response.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
      response.end("<h1>Google authorization failed</h1><p>Return to CCAGENT for details.</p>");
      settle(new Error(`Google OAuth authorization failed: ${oauthError}`));
      return;
    }
    if (!authorizationCode || state !== expectedState) {
      response.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
      response.end("<h1>Invalid OAuth callback</h1><p>Return to CCAGENT and try again.</p>");
      settle(new Error("Google OAuth callback is missing a code or has an invalid state"));
      return;
    }

    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end("<h1>CCAGENT authorization complete</h1><p>You can close this window and return to the terminal.</p>");
    settle(null, authorizationCode);
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(port, redirect.hostname, () => {
      server.off("error", onError);
      resolve();
    });
  });

  const timer = setTimeout(() => {
    settle(new Error(`Google OAuth authorization timed out after ${AUTH_TIMEOUT_MS / 60_000} minutes`));
  }, AUTH_TIMEOUT_MS);

  return {
    code,
    close: async () => {
      clearTimeout(timer);
      if (!server.listening) return;
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function safeServerName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, "_");
}

function isOAuthTokens(value: unknown): value is OAuthTokens {
  if (!value || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  return typeof obj.access_token === "string" && typeof obj.token_type === "string";
}

/** Persistent OAuth provider for one official Google Workspace MCP endpoint. */
export class GoogleWorkspaceOAuthProvider implements OAuthClientProvider {
  readonly redirectUrl: string;
  readonly clientMetadata: OAuthClientMetadata;
  private authorizationUrl?: URL;
  private expectedState?: string;
  private verifier?: string;
  private authorizationPromise?: Promise<string>;
  private requestTail: Promise<void> = Promise.resolve();
  private readonly tokenPath: string;
  private readonly lifetime = new AbortController();

  async cancel(): Promise<void> {
    this.lifetime.abort(new Error("MCP server closed; Google authorization cancelled"));
    await this.authorizationPromise?.catch(() => undefined);
  }

  constructor(
    private readonly serverName: string,
    private readonly config: McpGoogleOAuthConfig,
    private readonly runtime: {
      homeDir?: string;
      openExternal?: (url: string) => Promise<boolean>;
    } = {},
  ) {
    this.redirectUrl = config.redirectUri;
    this.clientMetadata = {
      client_name: "CCAGENT",
      redirect_uris: [config.redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "client_secret_post",
    };
    this.tokenPath = path.join(
      runtime.homeDir ?? getCCAgentHome(),
      "oauth",
      "google-workspace",
      `${safeServerName(serverName)}.json`,
    );
  }

  clientInformation(): OAuthClientInformationMixed {
    const clientId = process.env[this.config.clientIdEnv]?.trim();
    const clientSecret = process.env[this.config.clientSecretEnv]?.trim();
    if (!clientId || !clientSecret) {
      throw new Error(
        `Google Workspace MCP requires ${this.config.clientIdEnv} and ${this.config.clientSecretEnv}; run 'ccagent init' to configure them`,
      );
    }
    return { client_id: clientId, client_secret: clientSecret };
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(this.tokenPath, "utf-8"));
      return isOAuthTokens(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    this.lifetime.signal.throwIfAborted();
    // Google normally returns a refresh token only on the initial offline
    // authorization.  Subsequent refresh responses omit it, so retain the
    // previously stored value instead of silently turning a persistent login
    // into a short-lived one.
    let tokensToSave = tokens;
    if (!tokens.refresh_token) {
      const existing = await this.tokens();
      if (existing?.refresh_token) {
        tokensToSave = { ...tokens, refresh_token: existing.refresh_token };
      }
    }
    this.lifetime.signal.throwIfAborted();
    await fs.mkdir(path.dirname(this.tokenPath), { recursive: true });
    await fs.writeFile(this.tokenPath, JSON.stringify(tokensToSave, null, 2) + "\n", {
      encoding: "utf-8",
      mode: 0o600,
    });
    if (process.platform !== "win32") await fs.chmod(this.tokenPath, 0o600);
  }

  state(): string {
    this.expectedState = randomBytes(24).toString("base64url");
    return this.expectedState;
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    // Google issues a refresh token only for offline access. `prompt=consent`
    // also makes a replacement refresh token available when the user has
    // previously approved the same client. This method is reached only after
    // the MCP endpoint has returned 401, not on every normal request.
    const googleAuthorizationUrl = new URL(authorizationUrl);
    googleAuthorizationUrl.searchParams.set("access_type", "offline");
    googleAuthorizationUrl.searchParams.set("prompt", "consent");
    googleAuthorizationUrl.searchParams.set("include_granted_scopes", "true");
    this.authorizationUrl = googleAuthorizationUrl;
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.verifier = codeVerifier;
  }

  codeVerifier(): string {
    if (!this.verifier) throw new Error("Google OAuth PKCE verifier is unavailable");
    return this.verifier;
  }

  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): Promise<void> {
    this.lifetime.signal.throwIfAborted();
    if (scope === "all" || scope === "tokens") {
      await fs.rm(this.tokenPath, { force: true }).catch(() => undefined);
    }
    if (scope === "all" || scope === "verifier") this.verifier = undefined;
  }

  private async authorizeInBrowser(signal: AbortSignal): Promise<string> {
    if (this.authorizationPromise) return await this.authorizationPromise;
    const promise = serializeBrowserAuth(async () => {
      if (!this.authorizationUrl || !this.expectedState) {
        throw new Error("Google OAuth server did not provide a valid authorization challenge");
      }
      const receiver = await startCallbackReceiver(this.redirectUrl, this.expectedState);
      try {
        signal.throwIfAborted();
        const url = this.authorizationUrl.toString();
        logWarn(`[mcp] ${this.serverName}: Google authorization required. Opening the browser.`);
        const opened = await abortable((this.runtime.openExternal ?? openExternal)(url), signal);
        if (!opened) logWarn(`[mcp] Browser launch failed. For this explicitly requested authorization, visit: ${url}`);
        return await abortable(receiver.code, signal);
      } finally {
        await receiver.close();
      }
    }, signal);
    this.authorizationPromise = promise;
    try {
      return await promise;
    } finally {
      if (this.authorizationPromise === promise) this.authorizationPromise = undefined;
      this.authorizationUrl = undefined;
      this.expectedState = undefined;
    }
  }

  /** Serialize requests so concurrent 401 challenges cannot overwrite PKCE state. */
  async runWithAuth<T>(
    transport: StreamableHTTPClientTransport,
    operation: () => Promise<T>,
    options: McpAuthOptions = {},
  ): Promise<T> {
    const signal = options.signal
      ? AbortSignal.any([this.lifetime.signal, options.signal]) : this.lifetime.signal;
    const task = this.requestTail.then(async () => {
      signal.throwIfAborted();
      try {
        return await abortable(operation(), signal);
      } catch (error) {
        signal.throwIfAborted();
        if (!(error instanceof UnauthorizedError)) throw error;
        if (!options.interactive) throw new McpAuthorizationRequiredError();
        const code = await this.authorizeInBrowser(signal);
        signal.throwIfAborted();
        await abortable(transport.finishAuth(code), signal);
        signal.throwIfAborted();
        return await abortable(operation(), signal);
      }
    });
    this.requestTail = task.then(() => undefined, () => undefined);
    return abortable(task, signal);
  }
}
