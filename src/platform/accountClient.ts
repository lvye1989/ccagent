import http, { type IncomingHttpHeaders } from "node:http";
import https from "node:https";
import { SecureCredentialStore } from "./secureStore.js";

export interface AccountUser { id: string; email: string; name: string }
export interface AccountSession { user: AccountUser; expiresAt: string }
export interface StoredAccountSession extends AccountSession { origin: string; cookie: string }

export class AccountError extends Error {
  constructor(message: string, readonly code: string, readonly status = 0) { super(message); this.name = "AccountError"; }
}

export function normalizePlatformOrigin(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new AccountError("请配置有效的 CCAGENT 官方服务地址。", "configuration"); }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) || url.username || url.password ||
      url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    throw new AccountError("官方服务须使用 HTTPS；本机开发服务仅允许回环 HTTP 地址。", "configuration");
  }
  return url.origin;
}

function userIdentity(value: unknown): AccountUser {
  if (!value || typeof value !== "object") throw new AccountError("登录服务返回的账户信息无效。", "invalid_response");
  const user = value as Record<string, unknown>;
  if (typeof user.id !== "string" || !user.id || user.id.length > 200 || typeof user.email !== "string" || !user.email.includes("@") || user.email.length > 320) {
    throw new AccountError("登录服务返回的账户信息无效。", "invalid_response");
  }
  return { id: user.id, email: user.email, name: typeof user.name === "string" ? user.name.slice(0, 200) : "" };
}

function validCookie(value: string): boolean {
  return /^(?:__Secure-)?(?:ccagent|better-auth)\.session_token=[^;\s\r\n]{1,8192}$/.test(value);
}

function extractCookie(headers: IncomingHttpHeaders): string {
  const candidates = headers["set-cookie"] ?? [];
  for (const candidate of candidates) {
    const cookie = candidate.split(";", 1)[0]!.trim();
    if (validCookie(cookie) && !/max-age=0(?:;|$)/i.test(candidate)) return cookie;
  }
  throw new AccountError("登录服务未返回有效会话。", "invalid_response");
}

type JsonReply = { status: number; headers: IncomingHttpHeaders; value: unknown };

/** Dedicated HTTPS transport always verifies TLS, even with an insecure inherited Node environment. */
function requestJson(origin: string, route: string, body?: Record<string, unknown>, cookie?: string): Promise<JsonReply> {
  const url = new URL(route, origin);
  const bytes = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const transport = url.protocol === "https:" ? https : http;
    const request = transport.request(url, {
      method: bytes ? "POST" : "GET", rejectUnauthorized: true,
      ...(url.hostname === "localhost" && url.protocol === "http:" ? { hostname: "127.0.0.1" } : {}),
      headers: { accept: "application/json", origin, "cache-control": "no-store", ...(cookie ? { cookie } : {}),
        ...(bytes ? { "content-type": "application/json", "content-length": bytes.length } : {}) },
    }, response => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 256 * 1024) response.destroy(new Error("limit"));
        else chunks.push(chunk);
      });
      response.on("error", () => reject(new AccountError("账户服务响应中断，请重试。", "network")));
      response.on("end", () => {
        const status = response.statusCode ?? 503;
        if (status >= 300 && status < 400) { reject(new AccountError("账户服务返回了不允许的跳转。", "invalid_response", status)); return; }
        try { resolve({ status, headers: response.headers, value: JSON.parse(Buffer.concat(chunks).toString("utf8")) }); }
        catch { reject(new AccountError("账户服务返回格式错误。", "invalid_response", status)); }
      });
    });
    request.setTimeout(15_000, () => request.destroy(new Error("timeout")));
    request.on("error", () => reject(new AccountError("暂时无法连接账户服务，请检查网络后重试。", "network")));
    request.end(bytes);
  });
}

function checked(reply: JsonReply): unknown {
  if (reply.status >= 200 && reply.status < 300) return reply.value;
  if (reply.status === 401) throw new AccountError("邮箱密码不正确或登录已失效，请重新登录。", "unauthorized", 401);
  if (reply.status === 403) throw new AccountError("账户尚未验证、已被禁用或没有访问权限。", "forbidden", 403);
  if (reply.status === 429) throw new AccountError("操作过于频繁，请稍后重试。", "rate_limited", 429);
  throw new AccountError("账户服务暂时无法完成操作，请稍后重试。", "service_unavailable", reply.status);
}

function validateCredentials(email: string, password: string): void {
  if (email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 8 || password.length > 128) {
    throw new AccountError("请输入有效邮箱及 8 至 128 位密码。", "invalid_input");
  }
}

/** Shared native client: passwords are sent once and never saved. */
export class PlatformAccountClient {
  readonly origin: string;
  constructor(origin: string, private readonly store: SecureCredentialStore<StoredAccountSession>) {
    this.origin = normalizePlatformOrigin(origin);
  }

  private async resolveSession(cookie: string): Promise<AccountSession> {
    if (!validCookie(cookie)) throw new AccountError("登录凭据格式错误，请重新登录。", "unauthorized", 401);
    const value = checked(await requestJson(this.origin, "/api/auth/get-session", undefined, cookie));
    if (!value || typeof value !== "object") throw new AccountError("登录已失效，请重新登录。", "unauthorized", 401);
    const result = value as { user?: unknown; session?: { expiresAt?: unknown } };
    const expiresAt = result.session?.expiresAt;
    if (typeof expiresAt !== "string" || !Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.now()) {
      throw new AccountError("登录已失效，请重新登录。", "unauthorized", 401);
    }
    return { user: userIdentity(result.user), expiresAt };
  }

  async signIn(email: string, password: string): Promise<AccountSession> {
    validateCredentials(email, password);
    const reply = await requestJson(this.origin, "/api/auth/sign-in/email", { email, password });
    checked(reply);
    const cookie = extractCookie(reply.headers);
    const session = await this.resolveSession(cookie);
    await this.store.write({ ...session, origin: this.origin, cookie });
    return session;
  }

  async signUp(email: string, password: string, name: string): Promise<void> {
    validateCredentials(email, password);
    if (!name.trim() || name.length > 100) throw new AccountError("请输入 1 至 100 位昵称。", "invalid_input");
    checked(await requestJson(this.origin, "/api/auth/sign-up/email", { email, password, name: name.trim() }));
  }

  async requestPasswordReset(email: string): Promise<void> {
    if (email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AccountError("请输入有效邮箱。", "invalid_input");
    checked(await requestJson(this.origin, "/api/auth/request-password-reset", { email, redirectTo: this.origin + "/reset-password" }));
  }

  async requireSession(): Promise<AccountSession> {
    const stored = await this.store.read();
    if (!stored) throw new AccountError("请先使用邮箱和密码登录 CCAGENT。", "unauthorized", 401);
    if (typeof stored.origin !== "string" || typeof stored.cookie !== "string" || !validCookie(stored.cookie) ||
        !stored.user || typeof stored.user.id !== "string" || !stored.user.id) {
      await this.store.clear();
      throw new AccountError("登录凭据格式错误，请重新登录。", "unauthorized", 401);
    }
    if (stored.origin !== this.origin) throw new AccountError("服务地址已改变，请明确新服务地址后重新登录。", "origin_changed");
    try {
      const session = await this.resolveSession(stored.cookie);
      if (session.user.id !== stored.user.id) throw new AccountError("登录账户已改变，请重新登录。", "unauthorized", 401);
      return session;
    } catch (error) {
      if (error instanceof AccountError && [401, 403].includes(error.status)) await this.store.clear();
      throw error;
    }
  }

  async signOut(): Promise<{ remoteRevoked: boolean }> {
    let remoteRevoked = false;
    try {
      const stored = await this.store.read();
      if (stored && stored.origin === this.origin && validCookie(stored.cookie)) {
        try { checked(await requestJson(this.origin, "/api/auth/sign-out", {}, stored.cookie)); remoteRevoked = true; } catch { /* Local logout still succeeds; report remote uncertainty. */ }
      }
    } finally { await this.store.clear(); }
    return { remoteRevoked };
  }
}
