import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, stat } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { accountHome, configurePlatform, getDefaultPlatformOrigin, getPlatformAccountClient, getPlatformHome, getPlatformSessionFile, OFFICIAL_ACCOUNT_ORIGIN } from "../platform/account.js";
import { AccountError, normalizePlatformOrigin, type AccountSession, type PlatformAccountClient } from "../platform/accountClient.js";
import { VERSION } from "../version.js";

const COOKIE = "ccagent.local_session";
const publicAssets: Record<string, [string, string]> = {
  "/login": ["login.html", "text/html; charset=utf-8"],
  "/login.js": ["login.js", "text/javascript; charset=utf-8"],
  "/login.css": ["login.css", "text/css; charset=utf-8"],
  "/favicon.svg": ["favicon.svg", "image/svg+xml"],
};
type Worker = { child: ChildProcess; port: number; token: string; userId: string; sessionFile: string };
type LocalClient = { id: string; client: PlatformAccountClient; sessionFile: string; revision: number; closing: boolean; loggingOut?: boolean; worker?: Worker; starting?: Promise<Worker> };

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(JSON.stringify(value));
}
function tokenEquals(supplied: unknown, expected: string | undefined): boolean {
  return Boolean(expected && typeof supplied === "string" && Buffer.byteLength(supplied) === Buffer.byteLength(expected) && timingSafeEqual(Buffer.from(supplied), Buffer.from(expected)));
}
function browserId(req: IncomingMessage): string | undefined {
  const matches = (req.headers.cookie ?? "").split(";").map(item => item.trim()).filter(item => item.startsWith(COOKIE + "="));
  if (matches.length !== 1) return;
  const id = matches[0]!.slice(COOKIE.length + 1);
  return /^[a-f0-9]{64}$/.test(id) ? id : undefined;
}
function setCookie(res: ServerResponse, id?: string): void {
  // The loopback server is HTTP. Cloud credentials stay DPAPI-encrypted on disk.
  res.setHeader("set-cookie", `${COOKIE}=${id ?? ""}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${id ? 30 * 24 * 3600 : 0}`);
}
async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16 * 1024) throw new AccountError("请求内容过大。", "invalid_input", 413);
    chunks.push(chunk);
  }
  try {
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
    return body as Record<string, unknown>;
  } catch { throw new AccountError("请求格式错误。", "invalid_input", 400); }
}
function text(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || value.length > 2048) throw new AccountError("请检查输入内容。", "invalid_input", 400);
  return value;
}
function isLocalWebOrigin(origin: string, port: number): boolean {
  const url = new URL(origin);
  return ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    && url.protocol === "http:" && Number(url.port || 80) === port;
}
async function stopWorker(worker?: Worker): Promise<void> {
  if (!worker || worker.child.exitCode !== null || worker.child.signalCode !== null) return;
  const child = worker.child;
  const ended = new Promise<void>(resolve => child.once("exit", () => resolve()));
  if (child.connected) child.send("ccagent:shutdown", () => {});
  const deadline = setTimeout(() => { child.kill(); }, 5000);
  deadline.unref();
  await ended;
  clearTimeout(deadline);
}
async function startWorker(local: LocalClient, session: AccountSession, workspace: string): Promise<Worker> {
  if (local.closing) throw new AccountError("当前登录正在退出，请重新登录。", "account_changed", 401);
  if (local.worker && local.worker.userId === session.user.id && local.worker.child.exitCode === null && local.worker.child.signalCode === null) return local.worker;
  if (local.starting) return local.starting;
  local.starting = (async () => {
    const revision = local.revision;
    await stopWorker(local.worker);
    const port = await new Promise<number>((resolve, reject) => {
      const probe = net.createServer(); probe.once("error", reject);
      probe.listen(0, "127.0.0.1", () => { const address = probe.address(); probe.close(() => address && typeof address !== "string" ? resolve(address.port) : reject(new Error("No loopback port"))); });
    });
    const token = randomBytes(32).toString("hex"), base = getPlatformHome();
    await mkdir(accountHome(base, session.user.id), { recursive: true, mode: 0o700 });
    let selectedWorkspace = workspace;
    if (process.env.CCAGENT_DESKTOP_APP === "1") {
      // A fresh desktop account must not open the previous account's folder.
      selectedWorkspace = path.join(accountHome(base, session.user.id), "workspace");
      await mkdir(selectedWorkspace, { recursive: true, mode: 0o700 });
      const recent: unknown = await readFile(path.join(accountHome(base, session.user.id), "web-workspaces.json"), "utf8").then(value => { try { return JSON.parse(value) as unknown; } catch { return []; } }, () => []);
      if (Array.isArray(recent)) {
        for (const folder of recent) {
          if (typeof folder === "string" && path.isAbsolute(folder) && (await stat(folder).catch(() => null))?.isDirectory()) { selectedWorkspace = folder; break; }
        }
      }
    }
    const env: NodeJS.ProcessEnv = { ...process.env, CCAGENT_PLATFORM_HOME: base, CCAGENT_HOME: accountHome(base, session.user.id),
      CCAGENT_ACCOUNT_ID: session.user.id, CCAGENT_AUTH_SESSION_FILE: local.sessionFile,
      CCAGENT_WEB_WORKER_TOKEN: token, CCAGENT_DESKTOP_TOKEN: token };
    // TLS verification is mandatory for account and model traffic.
    delete env.NODE_TLS_REJECT_UNAUTHORIZED;
    const child = spawn(process.execPath, [...process.execArgv, path.resolve(process.argv[1]!), "web-worker", "--workspace", selectedWorkspace, "--port", String(port)], {
      cwd: selectedWorkspace, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    // Forward no raw worker output: extensions may log private user content.
    child.stdout?.resume(); child.stderr?.resume();
    const worker = { child, port, token, userId: session.user.id, sessionFile: local.sessionFile };
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new AccountError("账户工作区启动超时，请重试。", "worker_unavailable", 503)), 90_000);
        const fail = () => { clearTimeout(timeout); reject(new AccountError("账户工作区启动失败，请检查配置。", "worker_unavailable", 503)); };
        child.once("exit", fail); child.once("error", fail);
        child.on("message", message => {
          if (message && typeof message === "object" && "type" in message && message.type === "ccagent:worker-ready") {
            clearTimeout(timeout); child.off("exit", fail); child.off("error", fail); resolve();
          }
        });
      });
      const current = await local.client.requireSession();
      if (local.closing || revision !== local.revision || current.user.id !== session.user.id) throw new AccountError("账户状态已改变，请重新登录。", "account_changed", 401);
      local.worker = worker; return worker;
    } catch (error) { await stopWorker(worker); throw error; }
  })().finally(() => { local.starting = undefined; });
  return local.starting;
}
async function stopLocal(local: LocalClient): Promise<void> {
  local.closing = true;
  local.revision++;
  if (local.starting) await local.starting.catch(() => {});
  await stopWorker(local.worker); local.worker = undefined;
}
function proxy(req: IncomingMessage, res: ServerResponse, worker: Worker): void {
  const headers = { ...req.headers, host: `127.0.0.1:${worker.port}`, "x-ccagent-desktop-token": worker.token };
  if (headers.origin) headers.origin = `http://127.0.0.1:${worker.port}`;
  delete headers.cookie; delete headers.authorization;
  const upstream = httpRequest({ host: "127.0.0.1", port: worker.port, path: req.url, method: req.method, headers }, response => {
    // Workers cannot set the outer login cookie or weaken local framing rules.
    const responseHeaders = { ...response.headers }; delete responseHeaders["set-cookie"];
    res.writeHead(response.statusCode ?? 502, responseHeaders); response.pipe(res);
  });
  upstream.on("error", () => { if (!res.headersSent) json(res, 502, { error: "账户工作区连接中断，请重试。" }); else res.destroy(); });
  res.once("close", () => upstream.destroy()); req.pipe(upstream);
}

/** Login shell has no engine/configuration imports. Each login owns a separate engine process. */
export async function runWebServer(args: string[]): Promise<void> {
  let port = 4173, workspace = process.cwd();
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--port" && args[i + 1]) port = Number(args[++i]);
    else if (args[i] === "--workspace" && args[i + 1]) workspace = path.resolve(args[++i]!);
    else throw new Error("Usage: ccagent web [--port 4173] [--workspace <folder>]");
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid port");
  if (!(await stat(workspace)).isDirectory()) throw new Error("Workspace must be a folder");
  process.env.CCAGENT_PLATFORM_HOME = getPlatformHome();
  // Repair the old first-run mistake without forwarding any existing session to the new origin.
  const account = await getPlatformAccountClient().catch(() => null);
  if (account && isLocalWebOrigin(account.origin, port)) {
    let defaultOrigin = OFFICIAL_ACCOUNT_ORIGIN;
    try { defaultOrigin = getDefaultPlatformOrigin(); } catch { /* An invalid override must not prevent repairing a known self-reference. */ }
    try { await configurePlatform(isLocalWebOrigin(defaultOrigin, port) ? OFFICIAL_ACCOUNT_ORIGIN : defaultOrigin); }
    catch { console.warn("无法自动修正账户服务设置，请在登录页的高级连接设置中重新保存地址。"); }
  }
  const entryDir = path.dirname(path.resolve(process.argv[1]!));
  let webRoot = "";
  for (const candidate of [path.resolve(entryDir, "../web"), path.resolve(entryDir, "../../web")]) {
    if (await stat(path.join(candidate, "login.html")).catch(() => null)) { webRoot = candidate; break; }
  }
  if (!webRoot) throw new Error("Login assets are missing. Rebuild or reinstall CCAGENT.");
  const locals = new Map<string, LocalClient>(), loginBusy = new Set<string>();
  let stopping = false;
  const desktopToken = process.env.CCAGENT_DESKTOP_TOKEN;
  async function accountClient(sessionFile?: string): Promise<PlatformAccountClient> {
    const client = await getPlatformAccountClient(sessionFile);
    if (isLocalWebOrigin(client.origin, port)) throw new AccountError("账户服务仍指向本机应用，无法自动修正。请在高级连接设置中保存官方账户服务地址，或联系管理员。", "configuration", 503);
    return client;
  }
  async function localClient(req: IncomingMessage, fresh = false): Promise<LocalClient> {
    const native = tokenEquals(req.headers["x-ccagent-desktop-token"], desktopToken);
    const id = native ? "native" : (!fresh && browserId(req)) || randomBytes(32).toString("hex");
    let local = locals.get(id);
    if (local && local.client.origin !== (await accountClient()).origin) {
      await stopLocal(local); locals.delete(id); local = undefined;
    }
    if (!local) {
      if (locals.size > 64) throw new AccountError("本地会话过多，请重新启动应用。", "rate_limited", 429);
      const sessionFile = native ? getPlatformSessionFile() : path.join(getPlatformHome(), "platform", "web-sessions", id, "session.json");
      local = { id, sessionFile, revision: 0, closing: false, client: await accountClient(native ? undefined : sessionFile) };
      if (native) locals.set(id, local);
    }
    return local;
  }
  const server = createServer(async (req, res) => {
    res.setHeader("x-frame-options", "DENY");
    const native = tokenEquals(req.headers["x-ccagent-desktop-token"], desktopToken);
    try {
      if (stopping) return json(res, 503, { error: "应用正在退出。" });
      if (desktopToken && !native) return json(res, 403, { error: "Desktop authorization required" });
      const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
      if (!hosts.has(req.headers.host ?? "")) return json(res, 403, { error: "Invalid host" });
      if (req.headers.origin && ![`http://127.0.0.1:${port}`, `http://localhost:${port}`].includes(req.headers.origin)) return json(res, 403, { error: "Invalid origin" });
      if (!["GET", "HEAD"].includes(req.method ?? "") && (req.headers["x-ccagent-web"] !== "1" || (!native && !req.headers.origin))) return json(res, 403, { error: "Local origin and request header required" });
      const route = new URL(req.url ?? "/", `http://127.0.0.1:${port}`).pathname;
      if (req.method === "GET" && route === "/api/health") return json(res, 200, { ok: true, version: VERSION });
      if (req.method === "GET" && publicAssets[route]) {
        const [file, mime] = publicAssets[route]!;
        res.writeHead(200, { "content-type": mime, "cache-control": "no-store", "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'" });
        return res.end(await readFile(path.join(webRoot, file)));
      }
      if (req.method === "GET" && route === "/api/account/config") {
        const origin = (await accountClient()).origin;
        return json(res, 200, { origin, configured: true });
      }
      if (req.method === "POST" && route === "/api/account/setup") {
        const body = await readBody(req), selectedOrigin = normalizePlatformOrigin(text(body, "origin"));
        if (isLocalWebOrigin(selectedOrigin, port)) throw new AccountError("这是本机应用地址，不能用作账户服务地址。请使用官方账户服务地址，或独立部署的账户服务地址。", "invalid_input", 400);
        const origin = await configurePlatform(selectedOrigin);
        for (const local of locals.values()) await stopLocal(local);
        locals.clear(); setCookie(res); return json(res, 200, { origin });
      }
      if (route.startsWith("/api/account/")) {
        if (req.method === "POST" && ["login", "register", "forgot", "resend-verification"].includes(route.slice(13))) {
          const body = await readBody(req), action = route.slice(13);
          const lockKey = native ? "native" : browserId(req) || "anonymous";
          if (loginBusy.has(lockKey)) return json(res, 409, { error: "请等待当前登录操作完成。" });
          const local = await localClient(req, action === "login");
          if (local.loggingOut) return json(res, 409, { error: "请等待退出登录完成。" });
          loginBusy.add(lockKey);
          let signedIn = false;
          try {
            if (action === "register") { await local.client.signUp(text(body, "email"), text(body, "password"), text(body, "name")); return json(res, 200, { message: "请检查邮箱并完成验证，再返回登录。" }); }
            if (action === "forgot") { await local.client.requestPasswordReset(text(body, "email")); return json(res, 200, { message: "如果该邮箱已注册，系统将发送密码重置邮件。" }); }
            if (action === "resend-verification") { await local.client.resendVerification(text(body, "email")); return json(res, 200, { message: "如果该邮箱已注册且尚未验证，系统将发送验证邮件，请查收。" }); }
            // Stop this browser's previous engine before changing its identity.
            const previousId = browserId(req), previous = native ? local : previousId ? locals.get(previousId) : undefined;
            const session = await local.client.signIn(text(body, "email"), text(body, "password"));
            signedIn = true;
            locals.set(local.id, local);
            if (previous) { await stopLocal(previous); if (previous !== local) { await previous.client.signOut(); locals.delete(previous.id); } }
            local.closing = false;
            if (!native) setCookie(res, local.id);
            return json(res, 200, { ...session, origin: local.client.origin });
          } finally { loginBusy.delete(lockKey); if (action === "login" && !signedIn && !native) locals.delete(local.id); }
        }
        const local = await localClient(req);
        if (req.method === "POST" && route === "/api/account/logout") {
          local.loggingOut = true;
          try {
            await stopLocal(local);
            const result = await local.client.signOut(); locals.delete(local.id); setCookie(res);
            return json(res, 200, result);
          } finally { local.loggingOut = false; }
        }
        if (req.method === "GET" && route === "/api/account/status") {
          if (local.loggingOut) throw new AccountError("当前登录正在退出。", "account_changed", 401);
          try { const session = await local.client.requireSession(); local.closing = false; return json(res, 200, { ...session, origin: local.client.origin }); }
          catch (error) { await stopLocal(local); throw error; }
        }
        return json(res, 404, { error: "Not found" });
      }
      const local = await localClient(req);
      if (local.closing) throw new AccountError("当前登录已退出，请重新登录。", "account_changed", 401);
      let session: AccountSession;
      try { session = await local.client.requireSession(); }
      catch (error) {
        await stopLocal(local);
        if (error instanceof AccountError && error.status === 401 && ["/", "/index.html"].includes(route)) { res.writeHead(303, { location: "/login", "cache-control": "no-store" }); return res.end(); }
        throw error;
      }
      if (local.worker && local.worker.userId !== session.user.id) {
        await stopLocal(local); local.closing = false;
        throw new AccountError("当前账户已改变，请重新打开工作区。", "account_changed", 401);
      }
      locals.set(local.id, local);
      const worker = await startWorker(local, session, workspace);
      if (local.closing || loginBusy.has(local.id) || stopping) throw new AccountError("账户状态正在改变，请重试。", "account_changed", 401);
      proxy(req, res, worker);
    } catch (error) {
      if (res.headersSent) { res.destroy(); return; }
      const known = error instanceof AccountError;
      if (known && req.method === "GET" && /^\/(?:index\.html)?(?:\?|$)/.test(req.url ?? "/")) {
        res.writeHead(303, { location: "/login", "cache-control": "no-store" }); return res.end();
      }
      json(res, known ? error.status || (["configuration", "network", "service_unavailable"].includes(error.code) ? 503 : 400) : 500, { error: known ? error.message : "本地账户服务暂时不可用，请重试。", ...(known ? { code: error.code } : {}) });
    }
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  async function shutdown() {
    if (stopping) return; stopping = true; server.close();
    await Promise.allSettled([...locals.values()].map(stopLocal));
    server.closeAllConnections(); process.exit(0);
  }
  process.once("SIGINT", () => { void shutdown(); }); process.once("SIGTERM", () => { void shutdown(); });
  if (process.send) { process.on("message", message => { if (message === "ccagent:shutdown") void shutdown(); }); process.once("disconnect", () => { void shutdown(); }); }
  console.log(`CCAGENT Web: http://127.0.0.1:${port}`);
}
