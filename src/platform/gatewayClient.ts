import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, rm } from "node:fs/promises";
import { requirePlatformScope, getPlatformAccountClient, getPlatformSessionFile } from "./account.js";
import { AccountError, type PlatformAccountClient } from "./accountClient.js";
import { withFileTransaction, writeJsonAtomically } from "../utils/fileTransaction.js";
import { platformRequest, PlatformTransportError } from "./transport.js";
import { recoverableResponseBody } from "./recoverableResponse.js";
import { currentPlatformTaskId } from "./taskScope.js";
import { platformKeyPattern, readServiceBinding, readServiceConfiguration, serviceConfigurationSchema, serviceCredentialStore, servicePaths, serviceRouteSchema,
  validateServiceRoles, catalogDefaultRoles, type OfficialRole, type ServiceConfiguration, type ServiceCredential, type OfficialServiceRoute, type ServiceRoles } from "./serviceState.js";

type Endpoint = "responses" | "chat/completions" | "decisions" | "search" | "voice" | "images/tasks";
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
export function authorizedPrivateUploadUrl(url: URL, expected: string, accountOrigin: string): boolean {
  if (url.username || url.password || url.hash) return false;
  if (["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) && url.origin === accountOrigin) return url.pathname === expected;
  // @vercel/blob presigned PUT URLs use the API endpoint, with the object path in its query.
  return url.origin === "https://vercel.com" && url.pathname === "/api/blob/" &&
    url.searchParams.getAll("pathname").length === 1 && url.searchParams.get("pathname") === expected.slice(1);
}
export class PlatformServiceError extends Error {
  constructor(message: string, readonly code: string, readonly status = 0, readonly requestId?: string) { super(message); this.name = "PlatformServiceError"; }
}

async function checked(response: Response): Promise<Response> {
  if (response.ok) return response;
  let code = "SERVICE_UNAVAILABLE";
  try { const value = await response.json() as { code?: unknown }; if (typeof value.code === "string" && /^[A-Z_]{1,80}$/.test(value.code)) code = value.code; }
  catch { /* HTML/proxy errors and upstream content never become credential-bearing messages. */ }
  const messages: Record<number, string> = {
    400: "官方服务请求格式或协议不受支持，请核对服务配置。", 401: "登录已失效，请重新使用邮箱密码登录。",
    402: "余额或平台 Key 额度不足，请充值或调整限额。", 403: "平台 Key 不可用，或不属于当前登录账户。",
    404: "官方服务或调用记录不存在，请刷新服务目录。", 409: "该调用正在执行、等待核验或请求标识存在冲突，请查看调用记录。",
    410: "调用结果或临时文件已过期，请查看调用记录。", 413: "请求超过官方服务允许的大小。", 429: "官方服务请求过于频繁，请稍后重试。",
  };
  const specific: Record<string, string> = { PRICE_CHANGED: "官方服务价格、限制或汇率已更新，请刷新服务目录并核对后再调用。", ACCOUNT_DISABLED: "账户已被禁用，请联系管理员。",
    TOO_MANY_IMAGES: "本次图片数量超出所选官方路由的限制，请减少图片，或使用已配置的读图工具处理。",
    PROTOCOL_MISMATCH: "所选官方模型与本次请求协议不匹配，请刷新服务目录并重新选择模型。",
    UNPRICED_CAPABILITY: "本次请求使用了官方服务尚未开放的能力，请使用本地工具或普通文本请求。",
    FALLBACK_CHANGED: "管理员备用配置已改变，请刷新目录并重新确认备用价格。", FALLBACK_PRICE_CHANGED: "备用价格或汇率已更新，请刷新目录并重新开启备用。", FALLBACK_NOT_READY: "已确认的备用服务暂不可用，请刷新目录核对或关闭备用。" };
  throw new PlatformServiceError(specific[code] ?? messages[response.status] ?? "官方服务暂未完成请求，请查看调用状态后再重试。", code, response.status);
}

function canonical(value: unknown, depth = 0): unknown {
  if (depth > 40) throw new PlatformServiceError("请求嵌套层级过深。", "INPUT_TOO_DEEP");
  if (Array.isArray(value)) return value.map(item => canonical(item, depth + 1));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item, depth + 1)]));
  return value;
}

function catalogConsent(routes: OfficialServiceRoute[]) {
  return digest(JSON.stringify(canonical([...routes].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).map(route => ({ id: route.id, service: route.service, protocol: route.protocol,
    pricing: route.pricing, fallbackRouteId: route.limits.fallbackRouteId, fallbackEnabled: route.limits.fallbackEnabled })))));
}
type ServiceSaveGuard = { assertCurrent(): Promise<void>; expectedRevision: string | null };
export async function saveOfficialServices(input: { apiKey?: unknown; roles?: unknown; auxiliaryEnabled?: unknown; fallbackEnabled?: unknown; catalogRevision?: unknown }, guard?: ServiceSaveGuard): Promise<void> {
  const session = await requirePlatformScope(0), account = await getPlatformAccountClient();
  const old = await readServiceBinding().catch(error => { if (typeof input.apiKey === "string" && input.apiKey.trim()) return null; throw error; });
  const apiKey = typeof input.apiKey === "string" && input.apiKey.trim() ? input.apiKey.trim() : old?.credential.apiKey;
  if (!apiKey || !platformKeyPattern.test(apiKey)) throw new PlatformServiceError("请输入个人 CCAGENT API Key；上游供应商 Key 不能用于此处。", "INVALID_PLATFORM_KEY");
  const response = await checked(await account.serviceRequest("/v1/models", session.user.id, { headers: { authorization: `Bearer ${apiKey}` }, maximumBytes: 1024 * 1024 }));
  const data = await response.json() as { data?: unknown; defaults?: unknown };
  let routes: OfficialServiceRoute[], defaults: ServiceRoles;
  try {
    if (!Array.isArray(data.data) || data.data.length > 100) throw new Error("catalog");
    routes = data.data.map(item => serviceRouteSchema.parse(item));
    if (new Set(routes.map(route => route.id)).size !== routes.length) throw new Error("duplicates");
    defaults = catalogDefaultRoles(data.defaults, routes);
  } catch { throw new PlatformServiceError("官方服务目录格式无效，请稍后重新验证。", "INVALID_CATALOG"); }
  if (input.auxiliaryEnabled !== undefined && typeof input.auxiliaryEnabled !== "boolean") throw new Error("请选择是否启用官方辅助服务。");
  if (input.fallbackEnabled !== undefined && typeof input.fallbackEnabled !== 'boolean') throw new Error('请选择是否允许管理员备用服务。');
  const store = serviceCredentialStore(), paths = servicePaths();
  await guard?.assertCurrent();
  await withFileTransaction(paths.state, async () => {
    await guard?.assertCurrent();
    const current = await readServiceBinding().catch(error => { if (typeof input.apiKey === "string" && input.apiKey.trim()) return null; throw error; });
    if (guard && (await readServiceConfiguration())?.revision !== (guard.expectedRevision ?? undefined)) {
      throw new PlatformServiceError("其他窗口已更新官方服务，请刷新后重新连接。", "SERVICE_CONFIGURATION_CHANGED", 409);
    }
    if (!(typeof input.apiKey === "string" && input.apiKey.trim()) && current?.credential.apiKey !== apiKey) {
      throw new PlatformServiceError("其他窗口已更新平台 Key，请重新载入后再保存。", "SERVICE_CONFIGURATION_CHANGED");
    }
    const kinds = { main: "chat", image: "vision", decision: "decision", search: "search", voice: "voice", imageGeneration: "image" };
    const retained = Object.fromEntries(Object.entries(current?.configuration.roles ?? {}).filter(([role, id]) => routes.some(route => route.id === id && route.service === kinds[role as OfficialRole])));
    const roles = validateServiceRoles(input.roles ?? (current ? retained : defaults), routes);
    const sameCatalog = !!current && catalogConsent(current.configuration.routes) === catalogConsent(routes);
    if (input.fallbackEnabled === true) {
      if (!current || input.catalogRevision !== current.configuration.revision || !sameCatalog) throw new PlatformServiceError('目录或选择已更新，请先刷新、核对备用价格，再重新开启备用。', 'FALLBACK_CONFIRMATION_REQUIRED', 409);
      if (!routes.some(route => route.limits.fallbackEnabled && routes.some(target => target.id === route.limits.fallbackRouteId && target.service === route.service && target.protocol === route.protocol && target.pricing.fingerprint && route.pricing.fingerprint))) {
        throw new PlatformServiceError('管理员尚未配置可用且价格可确认的备用路由。', 'FALLBACK_NOT_CONFIGURED', 409);
      }
    }
    const fallbackEnabled = input.fallbackEnabled ?? (sameCatalog && current?.configuration.fallbackEnabled) ?? false;
    const configuration = serviceConfigurationSchema.parse({ version: 1, revision: randomUUID(), userId: session.user.id, origin: account.origin, routes, roles,
      auxiliaryEnabled: input.auxiliaryEnabled ?? current?.configuration.auxiliaryEnabled ?? false, fallbackEnabled, updatedAt: new Date().toISOString() });
    const before = await store.read();
    const beforeState = await readFile(paths.state, "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
    await guard?.assertCurrent();
    try {
      await store.write({ apiKey, userId: session.user.id, origin: account.origin, revision: configuration.revision });
      await guard?.assertCurrent();
      await writeJsonAtomically(paths.state, configuration);
      await guard?.assertCurrent();
    } catch (error) {
      if (before) await store.write(before); else await store.clear();
      if (beforeState !== null) await writeJsonAtomically(paths.state, JSON.parse(beforeState));
      else await rm(paths.state, { force: true });
      throw error;
    }
  });
}

type ConnectionAttempt = { version: 1; userId: string; origin: string; state: "pending" | "unknown" | "failed" | "complete"; completedAt?: number };

/** Explicit POST only. A separate lock serializes callers without nesting the configuration lock. */
export async function connectOfficialServices() {
  const beganAt = Date.now();
  try {
    const session = await requirePlatformScope(0), account = await getPlatformAccountClient();
    const source = getPlatformSessionFile(), paths = servicePaths(), connectionFile = paths.state + ".connect";
    const keySession = await account.applicationKeySession(session.user.id);
    const assertCurrent = async () => {
      await keySession.assertCurrent();
      if (getPlatformSessionFile() !== source || servicePaths().state !== paths.state || (await getPlatformAccountClient()).origin !== account.origin
        || (await requirePlatformScope(0)).user.id !== session.user.id) throw new AccountError("当前账户或服务地址已改变，请重新连接官方服务。", "account_changed", 401);
      await keySession.assertCurrent();
    };
    return await withFileTransaction(connectionFile, async () => {
      await assertCurrent();
      const binding = await readServiceBinding();
      const expectedRevision = (await readServiceConfiguration())?.revision ?? null;
      if (binding && binding.configuration.userId === session.user.id && binding.configuration.origin === account.origin) {
        try {
          await saveOfficialServices({ fallbackEnabled: false }, { assertCurrent, expectedRevision });
          const view = await officialServicesView(); await assertCurrent(); return view;
        } catch (error) {
          // Only an authoritative Key rejection permits replacement. Network/account errors do not.
          if (!(error instanceof PlatformServiceError) || !["INVALID_API_KEY", "API_KEY_REQUIRED"].includes(error.code)) throw error;
        }
      }
      let previous: ConnectionAttempt | null = null;
      const info = await lstat(connectionFile).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
      if (info) {
        if (!info.isFile() || info.isSymbolicLink() || info.size > 4096) throw new Error("Invalid connection state");
        const value = JSON.parse(await readFile(connectionFile, "utf8")) as ConnectionAttempt;
        if (value.version !== 1 || typeof value.userId !== "string" || typeof value.origin !== "string" || !["pending", "unknown", "failed", "complete"].includes(value.state)) throw new Error("Invalid connection state");
        previous = value;
      }
      if (previous?.userId === session.user.id && previous.origin === account.origin && (["pending", "unknown"].includes(previous.state)
        || previous.state === "failed" && (!Number.isFinite(previous.completedAt) || previous.completedAt! >= beganAt))) {
        throw new PlatformServiceError("上一次应用 Key 关联尚未完成或结果待核对，请先查看用户中心的 Key，勿重复创建；也可手动关联已有 Key。", "APPLICATION_KEY_REVIEW_REQUIRED", 409);
      }
      const attempt = (state: ConnectionAttempt["state"]): ConnectionAttempt => ({ version: 1, userId: session.user.id, origin: account.origin, state,
        ...(state === "pending" ? {} : { completedAt: Date.now() }) });
      await writeJsonAtomically(connectionFile, attempt("pending"));
      let created: { id: string; secret: string } | undefined;
      try {
        await assertCurrent();
        created = await keySession.create();
        await assertCurrent();
        await saveOfficialServices({ apiKey: created.secret, fallbackEnabled: false }, { assertCurrent, expectedRevision });
      } catch (error) {
        let compensated = false;
        if (created) { try { await keySession.revoke(created.id); compensated = true; } catch { /* Original-session cleanup is best effort, never retried blindly. */ } }
        const unknown = created ? !compensated : error instanceof AccountError && error.code === "application_key_result_unknown";
        await writeJsonAtomically(connectionFile, attempt(unknown ? "unknown" : "failed"));
        if (unknown) throw new PlatformServiceError("应用 Key 关联未完成，创建或撤销结果待核对，请在用户中心检查后手动关联，勿重复创建。", "APPLICATION_KEY_REVIEW_REQUIRED", 503);
        throw error;
      }
      await writeJsonAtomically(connectionFile, attempt("complete"));
      const view = await officialServicesView(); await assertCurrent(); return view;
    });
  } catch (error) {
    if (error instanceof AccountError || error instanceof PlatformServiceError) throw error;
    throw new PlatformServiceError("官方服务关联暂未完成，请稍后重试或在用户中心手动管理 Key。", "APPLICATION_KEY_CONNECT_FAILED", 503);
  }
}

export async function forgetOfficialKey(): Promise<void> {
  const session = await requirePlatformScope(0), account = await getPlatformAccountClient(), file = servicePaths().state;
  await withFileTransaction(file, async () => {
    await serviceCredentialStore().clear();
    await writeJsonAtomically(file, { version: 1, revision: randomUUID(), userId: session.user.id, origin: account.origin,
      auxiliaryEnabled: false, roles: {}, routes: [], updatedAt: new Date().toISOString() });
  });
}

const imageCatalogRefreshes = new Map<string, Promise<{ configuration: ServiceConfiguration; client: PlatformGatewayClient }>>();
/** Fetch an image-only catalog snapshot without rewriting any saved account choices. */
export async function refreshOfficialImageCatalog(): Promise<{ configuration: ServiceConfiguration; client: PlatformGatewayClient }> {
  const session = await requirePlatformScope(0), account = await getPlatformAccountClient(), binding = await readServiceBinding();
  if (!binding || binding.configuration.origin !== account.origin || binding.configuration.userId !== session.user.id) throw new PlatformServiceError("账户服务暂不可用，请稍后重试。", "SERVICE_NOT_CONFIGURED", 503);
  const paths = servicePaths(), identity = paths.state + ":" + digest(binding.credential.apiKey);
  const pending = imageCatalogRefreshes.get(identity); if (pending) return pending;
  const operation = (async () => {
    const response = await checked(await account.serviceRequest("/v1/models", session.user.id, { headers: { authorization: `Bearer ${binding.credential.apiKey}` }, maximumBytes: 1024 * 1024, timeoutMs: 20000 }));
    const data = await response.json() as { data?: unknown; defaults?: unknown };
    let routes: OfficialServiceRoute[], defaults: ServiceRoles;
    try {
      if (!Array.isArray(data.data) || data.data.length > 100) throw new Error("catalog");
      routes = data.data.map(item => serviceRouteSchema.parse(item));
      if (new Set(routes.map(route => route.id)).size !== routes.length) throw new Error("duplicates");
      defaults = catalogDefaultRoles(data.defaults, routes);
    } catch { throw new PlatformServiceError("图像服务目录暂不可用，请稍后重试。", "INVALID_CATALOG", 503); }
    const current = await readServiceBinding();
    if (!current || current.configuration.userId !== session.user.id || current.configuration.origin !== account.origin || current.credential.apiKey !== binding.credential.apiKey || current.configuration.revision !== binding.configuration.revision || (await getPlatformAccountClient()).origin !== account.origin || process.env.CCAGENT_ACCOUNT_ID !== session.user.id) throw new PlatformServiceError("账户服务已更新，请稍后重试。", "SERVICE_CONFIGURATION_CHANGED", 409);
    const images = routes.filter(route => route.service === "image"), otherRoutes = current.configuration.routes.filter(route => route.service !== "image");
    if (images.some(image => otherRoutes.some(route => route.id === image.id))) throw new PlatformServiceError("图像目录编号冲突，请联系管理员。", "INVALID_CATALOG", 503);
    const { imageGeneration: savedImage, ...otherRoles } = current.configuration.roles;
    const imageGeneration = images.some(route => route.id === savedImage) ? savedImage : defaults.imageGeneration;
    const roles: ServiceRoles = { ...otherRoles, ...(imageGeneration ? { imageGeneration } : {}) };
    const configuration = serviceConfigurationSchema.parse({ ...current.configuration, roles, routes: [...otherRoutes, ...images] });
    return { configuration, client: new PlatformGatewayClient(account, configuration, current.credential) };
  })();
  imageCatalogRefreshes.set(identity, operation);
  try { return await operation; } finally { if (imageCatalogRefreshes.get(identity) === operation) imageCatalogRefreshes.delete(identity); }
}

export async function officialServicesView() {
  const session = await requirePlatformScope(0), account = await getPlatformAccountClient(), binding = await readServiceBinding().catch(() => null);
  const configured = Boolean(binding && binding.configuration.origin === account.origin);
  const me = await checked(await account.serviceRequest("/api/account/me", session.user.id, { maximumBytes: 256 * 1024 }));
  const identity = await me.json() as { permissions?: unknown };
  const wallet = await checked(await account.serviceRequest("/api/account/wallet", session.user.id, { maximumBytes: 256 * 1024 }));
  const balance = await wallet.json() as { wallet?: unknown };
  return { origin: account.origin, configured, keyPrefix: configured ? binding!.credential.apiKey.slice(0, 16) : "", wallet: balance.wallet,
    permissions: Array.isArray(identity.permissions) ? identity.permissions.filter(value => typeof value === "string") : [],
    ...(configured ? { routes: binding!.configuration.routes, roles: binding!.configuration.roles, auxiliaryEnabled: binding!.configuration.auxiliaryEnabled,
      fallbackEnabled: binding!.configuration.fallbackEnabled, catalogRevision: binding!.configuration.revision, updatedAt: binding!.configuration.updatedAt }
      : { routes: [], roles: {}, auxiliaryEnabled: false, fallbackEnabled: false, catalogRevision: null }) };
}

type CallRecord = { requestId: string; taskId: string; endpoint: Endpoint; model: string; hash: string; keyHash: string;
  state: "sending" | "received" | "unknown" | "rejected"; createdAt: string; callId?: string; requestFileId?: string; priceVersion?: number; priceFingerprint?: string;
  fallback?: { routeId: string; version: number; fingerprint: string } };
const fingerprintPattern = /^[a-f0-9]{64}$/, routePattern = /^[a-z0-9][a-z0-9._:-]{0,79}$/;

async function journal<T>(action: (records: CallRecord[]) => T): Promise<T> {
  const file = servicePaths().journal;
  return withFileTransaction(file, async () => {
    let records: CallRecord[] = [];
    try {
      const info = await lstat(file);
      if (!info.isFile() || info.size > 1024 * 1024) throw new Error("invalid");
      const value: unknown = JSON.parse(await readFile(file, "utf8"));
      if (!Array.isArray(value) || value.some(item => !item || typeof item.requestId !== "string" || !uuid.test(item.requestId) ||
        typeof item.hash !== "string" || !/^[a-f0-9]{64}$/.test(item.hash) || typeof item.keyHash !== "string" || !/^[a-f0-9]{64}$/.test(item.keyHash) ||
        typeof item.taskId !== "string" || typeof item.model !== "string" || !["sending", "received", "unknown", "rejected"].includes(item.state)
        || item.priceVersion !== undefined && (!Number.isInteger(item.priceVersion) || item.priceVersion < 1)
        || item.priceFingerprint !== undefined && (typeof item.priceFingerprint !== 'string' || !fingerprintPattern.test(item.priceFingerprint))
        || item.fallback !== undefined && (!item.fallback || !routePattern.test(item.fallback.routeId) || !Number.isInteger(item.fallback.version) || item.fallback.version < 1 || !fingerprintPattern.test(item.fallback.fingerprint)
          || !item.priceVersion || !item.priceFingerprint))) throw new Error("invalid");
      records = value as CallRecord[];
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new PlatformServiceError("本机调用记录需要核验，请保留该文件并联系管理员。", "INVALID_CALL_JOURNAL"); }
    const result = action(records);
    // Retain every unresolved operation; dropping it could turn a retry into a new paid call.
    const unresolved = records.filter(record => ["sending", "unknown"].includes(record.state));
    if (unresolved.length > 1000) throw new PlatformServiceError("待核验调用较多，请先在用户中心核对调用记录。", "TOO_MANY_UNRESOLVED_CALLS");
    const terminal = records.filter(record => !["sending", "unknown"].includes(record.state)).slice(-200);
    await writeJsonAtomically(file, [...unresolved, ...terminal]);
    return result;
  });
}

export class PlatformGatewayClient {
  constructor(private readonly account: PlatformAccountClient, private readonly configuration: ServiceConfiguration, private readonly credential: ServiceCredential) {}

  private async assertBinding() {
    const session = await requirePlatformScope(), account = await getPlatformAccountClient();
    if (session.user.id !== this.configuration.userId || account.origin !== this.configuration.origin) throw new PlatformServiceError("运行实例所属账户或官方服务地址已改变，请重新打开应用。", "ACCOUNT_CHANGED", 401);
  }

  private async request(route: string, options: Parameters<PlatformAccountClient["serviceRequest"]>[2] = {}) {
    await this.assertBinding();
    return this.account.serviceRequest(route, this.configuration.userId, { ...options, headers: { ...options.headers, authorization: `Bearer ${this.credential.apiKey}` } });
  }

  async callStatus(requestId: string): Promise<Record<string, unknown> | null> {
    if (!uuid.test(requestId)) throw new PlatformServiceError("调用标识无效。", "INVALID_CALL_ID");
    const response = await this.request(`/api/account/calls/${requestId}`, { maximumBytes: 128 * 1024, timeoutMs: 15000 });
    if (response.status === 404) { await response.body?.cancel(); return null; }
    return await (await checked(response)).json() as Record<string, unknown>;
  }

  private async upload(bytes: Uint8Array, signal?: AbortSignal, purpose: "request" | "image" = "request", contentType = "application/json"): Promise<string> {
    const response = await checked(await this.request("/api/files", { method: "POST", body: Buffer.from(JSON.stringify({ purpose, contentType, size: bytes.byteLength })), headers: { "content-type": "application/json" }, maximumBytes: 128 * 1024, signal }));
    const value = await response.json() as { id: string; upload: { url: string; method: string; validUntil: number; headers: Record<string, string> } };
    const extension = ({ "application/json": "json", "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" } as Record<string, string>)[contentType];
    const url = new URL(value.upload.url), expected = `/ccagent/users/${digest(this.configuration.userId).slice(0, 32)}/${purpose}/${value.id}.${extension}`;
    if (!uuid.test(value.id) || !authorizedPrivateUploadUrl(url, expected, this.account.origin) ||
      value.upload.method !== "PUT" || !Number.isFinite(value.upload.validUntil) || value.upload.validUntil <= Date.now() || value.upload.validUntil > Date.now() + 3 * 60_000 ||
      Object.keys(value.upload.headers).some(name => !["content-type", "x-content-type"].includes(name)) ||
      !extension || value.upload.headers["content-type"] !== contentType || value.upload.headers["x-content-type"] !== contentType) {
      throw new PlatformServiceError("私有文件上传授权无效。", "INVALID_UPLOAD_AUTHORIZATION");
    }
    await (await checked(await platformRequest(url, { method: "PUT", headers: value.upload.headers, body: bytes, maximumBytes: 128 * 1024, timeoutMs: 120000, signal }))).arrayBuffer();
    await (await checked(await this.request(`/api/files/${value.id}`, { method: "POST", maximumBytes: 128 * 1024, signal }))).json();
    return value.id;
  }

  async uploadPrivateImage(bytes: Uint8Array, contentType: "image/png" | "image/jpeg" | "image/webp", signal?: AbortSignal): Promise<string> {
    if (!bytes.byteLength || bytes.byteLength > 30 * 1024 * 1024) throw new PlatformServiceError("图片不得超过 30 MB。", "REQUEST_TOO_LARGE", 413);
    return this.upload(bytes, signal, "image", contentType);
  }

  async imageTaskStatus(id: string, signal?: AbortSignal): Promise<Response> {
    if (!uuid.test(id)) throw new PlatformServiceError("图像任务标识无效。", "INVALID_CALL_ID");
    return checked(await this.request(`/v1/images/tasks/${id}`, { signal, timeoutMs: 60000, maximumBytes: 256 * 1024 }));
  }

  async download(fileId: string, signal?: AbortSignal): Promise<Uint8Array> {
    if (!uuid.test(fileId)) throw new PlatformServiceError("结果文件标识无效。", "INVALID_FILE_ID");
    const response = await checked(await this.request(`/api/files/${fileId}`, { signal, maximumBytes: 64 * 1024 * 1024, timeoutMs: 30000 }));
    return new Uint8Array(await response.arrayBuffer());
  }

  async call(endpoint: Endpoint, input: Record<string, unknown>, options: { requestId?: string; taskId?: string; signal?: AbortSignal } = {}): Promise<Response> {
    await this.assertBinding(); options.signal?.throwIfAborted();
    const model = typeof input.model === "string" ? input.model : "";
    const route = this.configuration.routes.find(item => item.id === model);
    const protocol = { responses: "openai-responses", "chat/completions": "openai-chat", decisions: "jev-decisions", voice: "dashscope-tts", "images/tasks": "kie-images" }[endpoint as "responses" | "chat/completions" | "decisions" | "voice" | "images/tasks"];
    if (!route || (endpoint === "search" ? !["tavily", "bocha"].includes(route.protocol) : route.protocol !== protocol)) throw new PlatformServiceError("未选择可用的官方服务，或服务协议不匹配。", "SERVICE_NOT_CONFIGURED");
    const text = JSON.stringify(input);
    if (Buffer.byteLength(text) > 32 * 1024 * 1024) throw new PlatformServiceError("请求超过 32 MiB，请减少本次输入。", "REQUEST_TOO_LARGE");
    const hash = digest(JSON.stringify(canonical(JSON.parse(text)))), keyHash = digest(this.credential.apiKey);
    const requestedId = options.requestId ?? randomUUID(), taskId = options.taskId ?? currentPlatformTaskId() ?? requestedId;
    if (!uuid.test(requestedId) || !/^[A-Za-z0-9._:-]{1,200}$/.test(taskId)) throw new PlatformServiceError("调用或任务标识无效。", "INVALID_CALL_ID");
    const record = await journal(records => {
      const existing = records.find(item => item.requestId === requestedId) ?? records.find(item => ["sending", "unknown"].includes(item.state) && item.taskId === taskId && item.endpoint === endpoint && item.model === model && item.hash === hash && item.keyHash === keyHash);
      if (existing) {
        if (existing.taskId !== taskId || existing.endpoint !== endpoint || existing.model !== model || existing.hash !== hash || existing.keyHash !== keyHash) throw new PlatformServiceError("同一调用标识不能用于不同的请求。", "IDEMPOTENCY_CONFLICT", 409);
        return { ...existing, reused: true };
      }
      let fallback: CallRecord['fallback'];
      if (this.configuration.fallbackEnabled && route.limits.fallbackEnabled) {
        const target = this.configuration.routes.find(item => item.id === route.limits.fallbackRouteId);
        if (!target || target.service !== route.service || target.protocol !== route.protocol || !target.pricing.fingerprint || !route.pricing.fingerprint || target.id === route.id) {
          throw new PlatformServiceError('备用路由当前不可用或价格未确认，请刷新目录并重新核对。', 'FALLBACK_NOT_READY', 409);
        }
        fallback = { routeId: target.id, version: target.pricing.version, fingerprint: target.pricing.fingerprint };
      }
      const next: CallRecord = { requestId: requestedId, taskId, endpoint, model, hash, keyHash, state: "sending", createdAt: new Date().toISOString(),
        priceVersion: route.pricing.version, priceFingerprint: route.pricing.fingerprint, ...(fallback ? { fallback } : {}) };
      records.push(next); return { ...next, reused: false };
    });
    const mark = (update: Partial<CallRecord>) => journal(records => { const current = records.find(item => item.requestId === record.requestId); if (current) Object.assign(current, update); });
    let requestFile: string | undefined, sent = false;
    const cleanup = async () => {
      if (!requestFile) return;
      try { await (await checked(await this.request(`/api/files/${requestFile}`, { method: "DELETE", timeoutMs: 15000, maximumBytes: 128 * 1024 }))).json(); }
      catch { /* The authenticated TTL maintenance job retries actual deletion. */ }
    };
    const status = () => this.callStatus(record.requestId);
    try {
      if (record.reused) {
        const previous = await status();
        if (previous && !["settled", "released"].includes(String(previous.status))) throw new PlatformServiceError("原调用仍在执行或等待用量核验，请先查看用户中心。", "CALL_IN_PROGRESS", 409, record.requestId);
        if (previous && previous.resultAvailable !== true) throw new PlatformServiceError("原调用已处理，但结果暂不可重放，请查看用户中心。", "RESULT_UNAVAILABLE", 409, record.requestId);
      }
      let bytes = Buffer.from(text);
      if (bytes.byteLength > 3 * 1024 * 1024) { requestFile = await this.upload(bytes, options.signal); await mark({ requestFileId: requestFile }); bytes = Buffer.from(JSON.stringify({ request_file_id: requestFile })); }
      const send = () => this.request(`/v1/${endpoint}`, { method: "POST", body: bytes, signal: options.signal,
        headers: { "content-type": "application/json", "idempotency-key": record.requestId, "x-ccagent-task-id": taskId, "x-ccagent-price-version": String(record.priceVersion ?? route.pricing.version),
          ...(record.priceFingerprint ? { 'x-ccagent-price-fingerprint': record.priceFingerprint } : {}), ...(record.fallback ? { 'x-ccagent-fallback-route': record.fallback.routeId,
            'x-ccagent-fallback-price-version': String(record.fallback.version), 'x-ccagent-fallback-price-fingerprint': record.fallback.fingerprint } : {}) }, timeoutMs: 185000 });
      sent = true;
      let response: Response;
      try { response = await send(); }
      catch (error) {
        // A connection failure never authorizes a new paid operation. Query first;
        // only a completed, replayable result may be fetched using the SAME id.
        const status = await this.callStatus(record.requestId).catch(() => null);
        if (endpoint !== "images/tasks" && status && ["settled", "released"].includes(String(status.status)) && status.resultAvailable === true && !options.signal?.aborted) response = await send();
        else throw error;
      }
      await checked(response);
      const callId = response.headers.get("x-ccagent-call-id");
      if (callId && uuid.test(callId)) await mark({ callId });
      if (!response.body) throw new PlatformTransportError();
      const body = recoverableResponseBody(response, {
        signal: options.signal,
        replay: async () => {
          if (endpoint === "images/tasks" || options.signal?.aborted) return null;
          const previous = await status().catch(() => null);
          if (!previous || !["settled", "released"].includes(String(previous.status)) || previous.resultAvailable !== true || options.signal?.aborted) return null;
          // Same identity, body and price pins: this fetches stored bytes only.
          return checked(await send());
        },
        complete: async () => { await mark({ state: "received" }); await cleanup(); },
        interrupted: async () => {
          await mark({ state: "unknown" }).catch(() => {});
          return new PlatformServiceError(`模型回复接收中断，尚未取回完整结果。已完成的工具操作会保留，请先核对原调用状态。请求编号：${record.requestId}`, "CALL_RESULT_UNKNOWN", 0, record.requestId);
        },
        cancelled: async () => { await mark({ state: "unknown" }).catch(() => {}); },
      });
      return new Response(body, { status: response.status, headers: response.headers });
    } catch (error) {
      const pending = (sent || record.reused) && (!(error instanceof PlatformServiceError) || error.status >= 500 || error.status === 0 || error.code === "CALL_IN_PROGRESS");
      await mark({ state: pending ? "unknown" : "rejected" }).catch(() => {});
      if (!pending) await cleanup();
      if (error instanceof PlatformServiceError) throw error;
      throw new PlatformServiceError(`官方服务连接未完成，请先查看调用状态。请求编号：${record.requestId}`, "CALL_RESULT_UNKNOWN", 0, record.requestId);
    }
  }
}

export async function getPlatformGatewayClient(): Promise<PlatformGatewayClient> {
  const session = await requirePlatformScope(), account = await getPlatformAccountClient(), binding = await readServiceBinding();
  if (!binding || binding.configuration.origin !== account.origin || binding.configuration.userId !== session.user.id) throw new PlatformServiceError("请先在设置中验证本账户的 CCAGENT 平台 Key。", "SERVICE_NOT_CONFIGURED");
  return new PlatformGatewayClient(account, binding.configuration, binding.credential);
}

export async function officialRole(role: OfficialRole): Promise<OfficialServiceRoute | null> {
  if (!process.env.CCAGENT_ACCOUNT_ID) return null;
  const configuration = await readServiceConfiguration();
  if (!configuration?.auxiliaryEnabled) return null;
  const binding = await readServiceBinding();
  if (!binding) throw new PlatformServiceError("官方辅助服务的平台 Key 需要重新验证。", "SERVICE_NOT_CONFIGURED");
  const id = binding.configuration.roles[role], route = binding.configuration.routes.find(item => item.id === id);
  if (!route) throw new PlatformServiceError("尚未选择对应的官方辅助服务，请在设置中配置。", "SERVICE_NOT_CONFIGURED");
  return route;
}
