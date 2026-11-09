import http, { type IncomingHttpHeaders } from "node:http";
import https from "node:https";
import { SecureCredentialStore } from "./secureStore.js";
import { platformRequest } from "./transport.js";

export interface AccountUser { id: string; email: string; name: string }
export interface AccountSession { user: AccountUser; expiresAt: string }
export interface StoredAccountSession extends AccountSession { origin: string; cookie: string }
export interface AccountBridgeTicket { ticket: string; expiresAt: string }
export interface AccountAccess { origin: string; user: AccountUser; permissions: string[] }
/** Native-only capability. Its captured session and newly issued secret never enter browser responses. */
export interface ApplicationKeySession {
  assertCurrent(): Promise<void>;
  create(): Promise<{ id: string; secret: string }>;
  revoke(id: string): Promise<void>;
}

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

function responseCode(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return;
  const body = value as { code?: unknown; error?: { code?: unknown } };
  return typeof body.code === "string" ? body.code : typeof body.error?.code === "string" ? body.error.code : undefined;
}

function protectedDeployment(): AccountError {
  return new AccountError("当前账户服务是受访问保护的测试部署，请联系管理员设置公开的正式账户服务地址。", "deployment_protected", 503);
}

// Never display an arbitrary upstream message: authentication responses may contain secrets.
const safeAccountErrors = new Map<string, readonly [string, string, number]>([
  ["INVALID_EMAIL", ["请输入有效的邮箱地址。", "invalid_input", 400]],
  ["INVALID_PASSWORD", ["请检查密码是否符合要求。", "invalid_input", 400]],
  ["PASSWORD_TOO_SHORT", ["密码至少需要 8 位。", "invalid_input", 400]],
  ["PASSWORD_TOO_LONG", ["密码不能超过 128 位。", "invalid_input", 400]],
  ["USER_ALREADY_EXISTS", ["该邮箱已注册，请直接登录或找回密码。", "account_exists", 422]],
  ["USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL", ["该邮箱已注册，请直接登录或找回密码。", "account_exists", 422]],
  ["EMAIL_NOT_VERIFIED", ["请先完成邮箱验证，再登录。", "email_not_verified", 403]],
  ["BANNED_USER", ["账户已被禁用，请联系管理员。", "forbidden", 403]],
  ["ACCOUNT_DISABLED", ["账户已被禁用，请联系管理员。", "forbidden", 403]],
  ["INVALID_ORIGIN", ["账户服务地址与正式服务配置不一致，请联系管理员检查连接设置。", "configuration", 503]],
  ["EMAIL_PASSWORD_SIGN_UP_DISABLED", ["当前账户服务暂未开放注册，请联系管理员。", "registration_disabled", 503]],
  ["MAIL_NOT_CONFIGURED", ["账户邮件服务尚未配置，请联系管理员。", "mail_unavailable", 503]],
  ["MAIL_DELIVERY_UNAVAILABLE", ["账户邮件服务暂不可用，请稍后重试或联系管理员。", "mail_unavailable", 503]],
]);

/** Dedicated HTTPS transport always verifies TLS, even with an insecure inherited Node environment. */
function requestJson(origin: string, route: string, body?: Record<string, unknown>, cookie?: string, method?: "POST" | "DELETE"): Promise<JsonReply> {
  const url = new URL(route, origin);
  const bytes = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const transport = url.protocol === "https:" ? https : http;
    const request = transport.request(url, {
      method: method ?? (bytes ? "POST" : "GET"), rejectUnauthorized: true,
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
        if (status >= 300 && status < 400) {
          let target: URL | undefined;
          try { if (response.headers.location) target = new URL(response.headers.location, origin); } catch { /* Invalid redirects remain rejected. */ }
          const protectedPreview = target && ["vercel.com", "www.vercel.com"].includes(target.hostname) && /^\/sso-api(?:\/|$)/.test(target.pathname);
          reject(protectedPreview ? protectedDeployment() : new AccountError("账户服务返回了不允许的跳转。", "invalid_response", status)); return;
        }
        const raw = Buffer.concat(chunks).toString("utf8");
        let value: unknown;
        try { value = JSON.parse(raw); } catch { /* Classify known deployment errors before rejecting non-JSON responses. */ }
        if (status >= 400 && (response.headers["x-vercel-error"] === "DEPLOYMENT_NOT_FOUND" || responseCode(value) === "DEPLOYMENT_NOT_FOUND")) {
          reject(new AccountError("账户服务部署不存在，请联系管理员恢复公开的正式账户服务。", "deployment_not_found", 503)); return;
        }
        if ([401, 403].includes(status) && (response.headers["x-vercel-id"] || response.headers.server === "Vercel") && /<title[^>]*>\s*(?:Authentication Required|Vercel Authentication)\s*<\/title>/i.test(raw)) {
          reject(protectedDeployment()); return;
        }
        if (status === 404) { reject(new AccountError("账户服务接口不存在，请联系管理员检查正式服务的部署和地址。", "service_not_found", 503)); return; }
        if (value === undefined) {
          const unavailable = status >= 500;
          reject(new AccountError(unavailable ? "账户服务暂不可用，请稍后重试或联系管理员。" : "账户服务返回格式错误。", unavailable ? "service_unavailable" : "invalid_response", status)); return;
        }
        resolve({ status, headers: response.headers, value });
      });
    });
    request.setTimeout(15_000, () => request.destroy(new Error("timeout")));
    request.on("error", () => reject(new AccountError("暂时无法连接账户服务，请检查网络后重试。", "network")));
    request.end(bytes);
  });
}

function checked(reply: JsonReply): unknown {
  if (reply.status >= 200 && reply.status < 300) return reply.value;
  const safeError = safeAccountErrors.get(responseCode(reply.value) ?? "");
  if (safeError) throw new AccountError(...safeError);
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

// Share only a verification that is still in flight for this exact native store.
// Never retain a successful login or permission result between requests.
const sessionChecks = new WeakMap<SecureCredentialStore<StoredAccountSession>, Map<string, Promise<AccountSession>>>();

/** Shared native client: passwords are sent once and never saved. */
export class PlatformAccountClient {
  readonly origin: string;
  constructor(origin: string, private readonly store: SecureCredentialStore<StoredAccountSession>) {
    this.origin = normalizePlatformOrigin(origin);
  }

  /** Live account permissions need only this browser's native session, never a model Key or worker. */
  async accountAccess(): Promise<AccountAccess> {
    const stored = await this.store.read();
    const valid = (value: StoredAccountSession | null): value is StoredAccountSession => Boolean(value && value.user?.id
      && value.origin === this.origin && validCookie(value.cookie) && Number.isFinite(Date.parse(value.expiresAt)) && Date.parse(value.expiresAt) > Date.now());
    if (!valid(stored)) throw new AccountError("请先使用邮箱和密码登录 CCAGENT。", "unauthorized", 401);
    const result = checked(await requestJson(this.origin, "/api/account/me", undefined, stored.cookie));
    if (!result || typeof result !== "object") throw new AccountError("账户权限响应无效，请重新打开设置。", "invalid_response", 502);
    const value = result as { user?: unknown; permissions?: unknown };
    let user: AccountUser;
    try { user = userIdentity(value.user); }
    catch { throw new AccountError("账户权限响应无效，请重新打开设置。", "invalid_response", 502); }
    if (user.id !== stored.user.id) throw new AccountError("当前账户已改变，请重新登录。", "account_changed", 401);
    if (!Array.isArray(value.permissions) || value.permissions.length > 256 || value.permissions.some(permission => typeof permission !== "string" || !/^[a-z][a-z0-9._:-]{0,79}$/.test(permission))) {
      throw new AccountError("账户权限响应无效，请重新打开设置。", "invalid_response", 502);
    }
    // Discard a response that raced logout, login replacement, or session rotation.
    const current = await this.store.read();
    if (!valid(current) || current.user.id !== stored.user.id || current.cookie !== stored.cookie) throw new AccountError("当前账户已改变，请重新打开设置。", "account_changed", 401);
    return { origin: this.origin, user, permissions: [...new Set(value.permissions as string[])].sort() };
  }

  /** Fixed-purpose device Key management; never widens the generic service route allowlist. */
  async applicationKeySession(expectedUserId: string): Promise<ApplicationKeySession> {
    const stored = await this.store.read();
    const valid = (value: StoredAccountSession | null): value is StoredAccountSession => Boolean(value && value.user?.id === expectedUserId
      && value.origin === this.origin && validCookie(value.cookie) && Number.isFinite(Date.parse(value.expiresAt)) && Date.parse(value.expiresAt) > Date.now());
    if (!valid(stored)) throw new AccountError("当前账户已改变，请重新登录。", "account_changed", 401);
    const assertCurrent = async () => {
      const current = await this.store.read();
      if (!valid(current) || current.cookie !== stored.cookie) throw new AccountError("当前账户已改变，请重新连接官方服务。", "account_changed", 401);
    };
    const revoke = async (id: string) => {
      if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)) throw new AccountError("应用 Key 标识无效。", "invalid_response", 502);
      // Compensation deliberately uses the original account, even if the local session changed.
      checked(await requestJson(this.origin, "/api/account/keys", { id }, stored.cookie, "DELETE"));
    };
    return { assertCurrent, revoke, create: async () => {
      await assertCurrent();
      let reply: JsonReply;
      try { reply = await requestJson(this.origin, "/api/account/keys", { name: "CCAGENT 应用专用 Key" }, stored.cookie, "POST"); }
      catch { throw new AccountError("应用 Key 创建结果尚未确认，请先在用户中心核对，勿重复创建；也可手动关联已有 Key。", "application_key_result_unknown", 503); }
      if (reply.status >= 500) throw new AccountError("应用 Key 创建结果尚未确认，请先在用户中心核对，勿重复创建；也可手动关联已有 Key。", "application_key_result_unknown", 503);
      const result = checked(reply) as { key?: { id?: unknown; prefix?: unknown }; secret?: unknown } | null;
      const id = typeof result?.key?.id === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(result.key.id) ? result.key.id : null;
      if (!id || typeof result?.secret !== "string" || !/^ccagent_[A-Za-z0-9_-]{43}$/.test(result.secret) || result.key?.prefix !== result.secret.slice(0, 16)) {
        if (id) await revoke(id).catch(() => {});
        throw new AccountError("应用 Key 创建响应未能确认，请先在用户中心核对，再手动关联。", "application_key_result_unknown", 502);
      }
      return { id, secret: result.secret };
    } };
  }

  /** Exchange a browser-bound state using the native credential, never expose that credential. */
  async issueAccountBridge(state: string, expectedUserId: string): Promise<AccountBridgeTicket> {
    if (typeof state !== "string" || state.length > 8192 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(state)) {
      throw new AccountError("账户中心授权请求无效，请重新点击入口。", "invalid_input", 400);
    }
    const stored = await this.store.read();
    if (!stored || stored.user.id !== expectedUserId || stored.origin !== this.origin || !validCookie(stored.cookie)
      || !Number.isFinite(Date.parse(stored.expiresAt)) || Date.parse(stored.expiresAt) <= Date.now()) {
      throw new AccountError("当前账户已改变，请重新登录。", "account_changed", 401);
    }
    const value = checked(await requestJson(this.origin, "/api/account/bridge/issue", { state }, stored.cookie));
    const reply = value as Partial<AccountBridgeTicket> | null;
    const expires = typeof reply?.expiresAt === "string" ? Date.parse(reply.expiresAt) : NaN;
    if (typeof reply?.ticket !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(reply.ticket)
      || !Number.isFinite(expires) || expires <= Date.now() || expires > Date.now() + 120_000) {
      throw new AccountError("账户中心授权响应无效，请重新点击入口。", "invalid_response", 502);
    }
    // Logout or account switching while the exchange is in flight must discard the ticket.
    const current = await this.store.read();
    if (current?.origin !== stored.origin || current.user.id !== expectedUserId || current.cookie !== stored.cookie) {
      throw new AccountError("当前账户已改变，请重新点击入口。", "account_changed", 401);
    }
    return { ticket: reply.ticket, expiresAt: reply.expiresAt! };
  }

  /** Server-side only: a platform Key is always accompanied by this verified email session. */
  async serviceRequest(route: string, expectedUserId: string, options: {
    method?: string; headers?: Record<string, string>; body?: Uint8Array; signal?: AbortSignal;
    timeoutMs?: number; maximumBytes?: number;
  } = {}): Promise<Response> {
    if (!/^\/(?:v1\/(?:models|responses|chat\/completions|decisions|search|voice|images\/tasks(?:\/[a-f0-9-]{36})?)|api\/(?:account\/(?:me|wallet|calls\/[A-Za-z0-9][A-Za-z0-9._:-]{0,199})|files(?:\/[a-f0-9-]{36})?))$/.test(route)) {
      throw new AccountError("官方服务接口无效。", "invalid_route");
    }
    // Each destination endpoint performs authoritative session validation. Avoid
    // a second remote login lookup before every chunk/file request.
    const stored = await this.store.read();
    if (stored?.user.id !== expectedUserId || stored.origin !== this.origin || !validCookie(stored.cookie) || !Number.isFinite(Date.parse(stored.expiresAt)) || Date.parse(stored.expiresAt) <= Date.now()) {
      throw new AccountError("当前账户已改变，请重新登录。", "account_changed", 401);
    }
    const headers = { ...options.headers, origin: this.origin, cookie: stored.cookie, "cache-control": "no-store" };
    return platformRequest(new URL(route, this.origin), { ...options, headers });
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

  async resendVerification(email: string): Promise<void> {
    if (email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AccountError("请输入有效邮箱。", "invalid_input");
    // Anonymous delivery preserves the platform's generic response for unknown/already verified emails.
    checked(await requestJson(this.origin, "/api/auth/send-verification-email", { email, callbackURL: this.origin + "/login?verified=1" }));
  }

  async requireSession(): Promise<AccountSession> {
    const revision = await this.store.revision();
    const stored = await this.store.read();
    if (!stored) throw new AccountError("请先使用邮箱和密码登录 CCAGENT。", "unauthorized", 401);
    if (typeof stored.origin !== "string" || typeof stored.cookie !== "string" || !validCookie(stored.cookie) ||
        !stored.user || typeof stored.user.id !== "string" || !stored.user.id) {
      await this.store.clearIfRevision(revision);
      throw new AccountError("登录凭据格式错误，请重新登录。", "unauthorized", 401);
    }
    if (stored.origin !== this.origin) throw new AccountError("服务地址已改变，请明确新服务地址后重新登录。", "origin_changed");
    if (await this.store.revision() !== revision) throw new AccountError("当前账户已改变，请重新登录。", "account_changed", 401);
    let checks = sessionChecks.get(this.store);
    if (!checks) { checks = new Map(); sessionChecks.set(this.store, checks); }
    const key = JSON.stringify([this.origin, revision, stored.user.id, stored.cookie]);
    let check = checks.get(key);
    if (!check) {
      check = (async () => {
        try {
          const session = await this.resolveSession(stored.cookie);
          if (session.user.id !== stored.user.id) throw new AccountError("登录账户已改变，请重新登录。", "unauthorized", 401);
          // An old response must not restore a login replaced or cleared in flight.
          if (await this.store.revision() !== revision) throw new AccountError("当前账户已改变，请重新登录。", "account_changed", 401);
          return session;
        } catch (error) {
          // A rejected old credential must never clear a newer login.
          if (error instanceof AccountError && [401, 403].includes(error.status)) await this.store.clearIfRevision(revision);
          throw error;
        }
      })().finally(() => { checks.delete(key); });
      checks.set(key, check);
    }
    return structuredClone(await check);
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
