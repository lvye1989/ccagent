import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { AccountError, normalizePlatformOrigin, PlatformAccountClient, type StoredAccountSession } from "../platform/accountClient.js";
import { SecureCredentialStore } from "../platform/secureStore.js";
import { runAccountCommand } from "../entrypoint/account.js";
import { Writable } from "node:stream";
import { accountHome, configurePlatform, enterPlatformAccount, getPlatformAccountClient, getPlatformSessionFile, OFFICIAL_ACCOUNT_ORIGIN, requirePlatformScope } from "../platform/account.js";

const temporaryParent = path.resolve(".tmp");
const { mkdir } = await import("node:fs/promises");
await mkdir(temporaryParent, { recursive: true });
const directory = await mkdtemp(path.join(temporaryParent, "platform-account-"));
const token = "fixture-session-token.signature";
const password = "fixture-password-123";
const identity = { id: "user-one", email: "first@example.invalid", name: "测试账户" };
let revoked = false;
let disabled = false;
let outage = false;
let missingDeployment = false;
let disconnected = false;
let failureReply: { status: number; headers?: Record<string, string | undefined>; value?: unknown; raw?: string } | undefined;
let user = { ...identity };
let passwordRequests = 0;
const verificationRequests: { body: Record<string, unknown>; cookie?: string }[] = [];
let requests = 0;
const server = createServer(async (req, res) => {
  requests++;
  res.setHeader("content-type", "application/json");
  assert.equal(req.headers.origin, origin);
  if (disconnected) { req.socket.destroy(); return; }
  if (failureReply) { res.writeHead(failureReply.status, failureReply.headers); res.end(failureReply.raw ?? JSON.stringify(failureReply.value)); return; }
  if (missingDeployment) { res.writeHead(404, { "content-type": "text/plain" }); res.end("DEPLOYMENT_NOT_FOUND"); return; }
  if (outage) { res.writeHead(503); res.end(JSON.stringify({ error: password })); return; }
  if (req.url === "/api/auth/sign-in/email") {
    const parts: Buffer[] = [];
    for await (const part of req) parts.push(Buffer.from(part));
    const value = JSON.parse(Buffer.concat(parts).toString()) as Record<string, string>;
    assert.equal(value.password, password);
    passwordRequests++;
    if (disabled) { res.writeHead(403); res.end("{}"); return; }
    revoked = false;
    res.setHeader("set-cookie", `ccagent.session_token=${token}; Path=/; HttpOnly; SameSite=Lax`);
    res.end(JSON.stringify({ user, token: "must-not-be-returned-or-persisted" }));
    return;
  }
  if (req.url === "/api/auth/get-session") {
    if (disabled) { res.writeHead(403); res.end("{}"); return; }
    if (revoked || req.headers.cookie !== `ccagent.session_token=${token}`) { res.end("null"); return; }
    res.end(JSON.stringify({ user, session: { expiresAt: new Date(Date.now() + 3_600_000).toISOString() } }));
    return;
  }
  if (req.url === "/api/auth/sign-out") {
    assert.equal(req.headers.cookie, `ccagent.session_token=${token}`);
    revoked = true;
    res.end("{}");
    return;
  }
  if (req.url === "/api/auth/request-password-reset") { res.end("{}"); return; }
  if (req.url === "/api/auth/send-verification-email") {
    const parts: Buffer[] = []; for await (const part of req) parts.push(Buffer.from(part));
    verificationRequests.push({ body: JSON.parse(Buffer.concat(parts).toString()) as Record<string, unknown>, cookie: req.headers.cookie });
    res.end(JSON.stringify({ status: true })); return;
  }
  res.writeHead(404); res.end("{}");
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert.ok(address && typeof address !== "string");
const origin = `http://127.0.0.1:${address.port}`;
const file = path.join(directory, "credentials.json");
const store = new SecureCredentialStore<StoredAccountSession>(file);
const client = new PlatformAccountClient(origin, store);
const previousHome = process.env.CCAGENT_HOME;
const previousPlatformHome = process.env.CCAGENT_PLATFORM_HOME, previousAccountId = process.env.CCAGENT_ACCOUNT_ID, previousSessionFile = process.env.CCAGENT_AUTH_SESSION_FILE;
const previousCloudUrl = process.env.CCAGENT_CLOUD_URL;
delete process.env.CCAGENT_PLATFORM_HOME; delete process.env.CCAGENT_ACCOUNT_ID; delete process.env.CCAGENT_AUTH_SESSION_FILE;
delete process.env.CCAGENT_CLOUD_URL;
process.env.CCAGENT_HOME = path.join(directory, "user-home");
let passed = 0;
async function test(name: string, run: () => Promise<void> | void): Promise<void> { await run(); passed++; console.log(`PASS ${name}`); }

try {
  await test("a fresh account uses the bundled official origin without setup or network access", async () => {
    assert.equal((await getPlatformAccountClient()).origin, OFFICIAL_ACCOUNT_ORIGIN);
    assert.equal(requests, 0);
    assert.equal(await stat(path.join(process.env.CCAGENT_HOME!, "platform", "configuration.json")).catch(() => null), null);
  });
  await test("an explicit environment origin overrides the bundled default without being persisted", async () => {
    process.env.CCAGENT_CLOUD_URL = origin;
    try { assert.equal((await getPlatformAccountClient()).origin, origin); }
    finally { delete process.env.CCAGENT_CLOUD_URL; }
    assert.equal((await getPlatformAccountClient()).origin, OFFICIAL_ACCOUNT_ORIGIN);
    assert.equal(requests, 0);
  });
  await test("platform address validates HTTPS, credentials, origin and local development boundary", () => {
    assert.equal(normalizePlatformOrigin("https://service.example/"), "https://service.example");
    assert.equal(normalizePlatformOrigin(origin), origin);
    for (const bad of ["http://public.example", "https://user:pass@service.example", "https://service.example/api", "https://service.example?token=1", "file:///tmp/test"]) assert.throws(() => normalizePlatformOrigin(bad));
  });
  await test("anonymous caller is rejected before any business request", async () => {
    await assert.rejects(() => client.requireSession(), (error: unknown) => error instanceof AccountError && error.status === 401);
    assert.equal(requests, 0);
  });
  await test("email password login verifies the returned cookie with the real HTTP session route", async () => {
    const session = await client.signIn(identity.email, password);
    assert.deepEqual(session.user, identity);
    assert.equal(JSON.stringify(session).includes(token), false);
    assert.equal(passwordRequests, 1);
    assert.equal((await client.requireSession()).user.id, identity.id);
  });
  await test("password and response token are never saved; Windows session token is DPAPI encrypted", async () => {
    const raw = await readFile(file, "utf8");
    assert.equal(raw.includes(password), false);
    assert.equal(raw.includes("must-not-be-returned-or-persisted"), false);
    if (process.platform === "win32") { assert.equal(raw.includes(token), false); assert.match(raw, /windows-dpapi/); }
    else assert.equal((await stat(file)).mode & 0o077, 0);
    assert.equal((await store.read())?.cookie, `ccagent.session_token=${token}`);
  });
  await test("stored credentials are not sent to a changed service origin", async () => {
    const before = requests;
    const other = new PlatformAccountClient("https://other.example", store);
    await assert.rejects(() => other.requireSession(), (error: unknown) => error instanceof AccountError && error.code === "origin_changed");
    assert.equal(requests, before);
  });
  await test("explicit verification resend uses only email and a fixed callback without forwarding session credentials", async () => {
    const before = await readFile(file);
    for (const email of [identity.email, "unknown@example.invalid"]) {
      await client.resendVerification(email);
      assert.deepEqual(verificationRequests.at(-1), { body: { email, callbackURL: origin + "/login?verified=1" }, cookie: undefined });
    }
    assert.equal(verificationRequests.length, 2);
    assert.deepEqual(await readFile(file), before, "Resend cannot change the signed-in identity or credentials");
    const beforeRequests = requests;
    for (const invalid of ["", "not-an-email", "a".repeat(321) + "@example.invalid"]) await assert.rejects(() => client.resendVerification(invalid),
      (error: unknown) => error instanceof AccountError && error.code === "invalid_input");
    assert.equal(requests, beforeRequests, "Invalid resend emails never reach the service");
  });
  await test("service outage blocks access but preserves encrypted credentials and hides response secrets", async () => {
    outage = true;
    try { await client.requireSession(); assert.fail("Expected outage"); } catch (error) {
      assert.ok(error instanceof AccountError);
      assert.equal(String(error).includes(password), false);
      assert.equal(error.code, "service_unavailable");
    }
    assert.ok(await store.read());
    outage = false;
  });
  await test("a missing account route is reported as a deployment/address problem rather than an account restriction", async () => {
    missingDeployment = true;
    try {
      await assert.rejects(() => client.signIn(identity.email, password), (error: unknown) => error instanceof AccountError
        && error.code === "service_not_found" && error.status === 503 && /接口不存在/.test(error.message));
      assert.ok(await store.read());
    } finally { missingDeployment = false; }
  });
  await test("missing deployment headers and known JSON codes are preserved without exposing upstream details", async () => {
    const before = await readFile(file);
    try {
      for (const reply of [
        { status: 404, headers: { "x-vercel-error": "DEPLOYMENT_NOT_FOUND" }, value: { error: { code: "404", message: password } } },
        { status: 404, value: { code: "DEPLOYMENT_NOT_FOUND", message: password } },
        { status: 404, headers: { "x-vercel-error": "DEPLOYMENT_NOT_FOUND", "content-type": "text/plain" }, raw: password },
      ]) {
        failureReply = reply;
        await assert.rejects(() => client.requireSession(), (error: unknown) => error instanceof AccountError && error.code === "deployment_not_found"
          && error.status === 503 && /部署不存在/.test(error.message) && !error.message.includes(password));
      }
      assert.deepEqual(await readFile(file), before, "Infrastructure failures must preserve the saved session");
    } finally { failureReply = undefined; }
  });
  await test("protected Preview redirects and Vercel authentication pages are distinguished and never followed", async () => {
    const before = await readFile(file), beforeRequests = requests;
    try {
      for (const reply of [
        { status: 302, headers: { location: "https://vercel.com/sso-api?secret=" + password }, value: {} },
        { status: 401, headers: { "x-vercel-id": "test-protection", "content-type": "text/html" }, raw: "<title>Authentication Required</title>" + password },
      ]) {
        failureReply = reply;
        await assert.rejects(() => client.requireSession(), (error: unknown) => error instanceof AccountError && error.code === "deployment_protected"
          && error.status === 503 && /受访问保护.*正式账户服务地址/.test(error.message) && !error.message.includes(password));
      }
      assert.equal(requests, beforeRequests + 2, "Deployment protection redirects cannot trigger another request");
      assert.deepEqual(await readFile(file), before, "Deployment protection cannot revoke an account session");
    } finally { failureReply = undefined; }
  });
  await test("known registration and verification codes have safe actionable messages", async () => {
    try {
      for (const [upstreamCode, status, code, description] of [
        ["USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL", 422, "account_exists", /已注册/],
        ["USER_ALREADY_EXISTS", 400, "account_exists", /已注册/],
        ["INVALID_EMAIL", 400, "invalid_input", /邮箱/],
        ["PASSWORD_TOO_SHORT", 400, "invalid_input", /至少.*8/],
        ["EMAIL_NOT_VERIFIED", 403, "email_not_verified", /邮箱验证/],
        ["INVALID_ORIGIN", 403, "configuration", /地址.*配置不一致/],
        ["MAIL_NOT_CONFIGURED", 503, "mail_unavailable", /邮件服务尚未配置/],
        ["MAIL_DELIVERY_UNAVAILABLE", 503, "mail_unavailable", /邮件服务暂不可用/],
      ] as const) {
        failureReply = { status, headers: { "x-vercel-id": "real-api-response" }, value: { code: upstreamCode, message: password } };
        await assert.rejects(() => client.signUp(identity.email, password, identity.name), (error: unknown) => error instanceof AccountError
          && error.code === code && description.test(error.message) && !error.message.includes(password));
      }
      failureReply = { status: 400, value: { code: "UNKNOWN_ERROR", message: password } };
      await assert.rejects(() => client.signUp(identity.email, password, identity.name), (error: unknown) => error instanceof AccountError
        && error.code === "service_unavailable" && !error.message.includes(password));
    } finally { failureReply = undefined; }
  });
  await test("connection failures remain distinct from registration errors and preserve saved credentials", async () => {
    const before = await readFile(file); disconnected = true;
    try {
      await assert.rejects(() => client.requireSession(), (error: unknown) => error instanceof AccountError
        && error.code === "network" && /无法连接账户服务/.test(error.message) && !error.message.includes(password));
      assert.deepEqual(await readFile(file), before);
    } finally { disconnected = false; }
  });
  await test("disabled accounts lose their saved session", async () => {
    disabled = true;
    await assert.rejects(() => client.requireSession(), (error: unknown) => error instanceof AccountError && error.status === 403);
    assert.equal(await store.read(), null);
    disabled = false;
  });
  await test("server-side account substitution is rejected", async () => {
    await client.signIn(identity.email, password);
    user = { ...identity, id: "another-user" };
    await assert.rejects(() => client.requireSession());
    assert.equal(await store.read(), null);
    user = { ...identity };
  });
  await test("malformed stored identity is rejected before contacting the server", async () => {
    await store.write({ origin, cookie: `ccagent.session_token=${token}` } as StoredAccountSession);
    const before = requests;
    await assert.rejects(() => client.requireSession(), (error: unknown) => error instanceof AccountError && error.status === 401);
    assert.equal(requests, before);
    assert.equal(await store.read(), null);
  });
  await test("sign-out revokes remote session and clears local credentials", async () => {
    await client.signIn(identity.email, password);
    assert.deepEqual(await client.signOut(), { remoteRevoked: true });
    assert.equal(revoked, true);
    assert.equal(await store.read(), null);
  });
  await test("offline logout clears local credentials and reports remote revocation as unconfirmed", async () => {
    await client.signIn(identity.email, password);
    outage = true;
    assert.deepEqual(await client.signOut(), { remoteRevoked: false });
    assert.equal(await store.read(), null);
    outage = false;
  });
  await test("corrupted or downgraded credential envelope fails closed", async () => {
    await writeFile(file, JSON.stringify({ version: 0, payload: "secret" }));
    await assert.rejects(() => store.read(), /重新登录/);
  });
  await test("invalid credentials do not reach the login service", async () => {
    const before = requests;
    await assert.rejects(() => client.signIn("bad", "short"));
    assert.equal(requests, before);
  });
  await test("CLI account setup, interactive login and status use the shared credential client", async () => {
    let text = "";
    const output = new Writable({ write(chunk, _encoding, callback) { text += chunk.toString(); callback(); } });
    let closed = false;
    const prompter = { ask: async () => identity.email, secret: async () => password, close() { closed = true; } };
    assert.equal(await runAccountCommand(["setup", "--server", origin], { output }), 0);
    process.env.CCAGENT_CLOUD_URL = "https://other.example";
    try { assert.equal((await getPlatformAccountClient()).origin, origin); }
    finally { delete process.env.CCAGENT_CLOUD_URL; }
    assert.equal(await runAccountCommand(["login"], { output, prompter }), 0);
    assert.equal(closed, true);
    assert.equal(await runAccountCommand(["status"], { output }), 0);
    assert.ok(text.includes(identity.email));
    assert.equal(text.includes(password), false);
    assert.equal(text.includes(token), false);
    assert.equal(await runAccountCommand(["logout"], { output }), 0);
    assert.equal(await runAccountCommand(["status"], { output }), 1);
  });
  await test("CLI rejects command-line password values without printing or transmitting them", async () => {
    let text = "";
    const output = new Writable({ write(chunk, _encoding, callback) { text += chunk.toString(); callback(); } });
    const before = requests;
    assert.equal(await runAccountCommand(["login", "--password", password], { output }), 1);
    assert.equal(text.includes(password), false);
    assert.equal(requests, before);
  });
  await test("account-scoped engine home preserves legacy data and rejects another account's directory", async () => {
    const base = process.env.CCAGENT_HOME!;
    const legacy = path.join(base, "legacy-marker.txt");
    await writeFile(legacy, "preserve existing local data");
    await configurePlatform(origin);
    await (await getPlatformAccountClient()).signIn(identity.email, password);
    await assert.rejects(() => requirePlatformScope(0), (error: unknown) => error instanceof AccountError && error.code === "account_scope_required");
    const entered = await enterPlatformAccount();
    assert.equal(entered.home, accountHome(base, identity.id));
    assert.equal((await requirePlatformScope(0)).user.id, identity.id);
    assert.equal(await readFile(legacy, "utf8"), "preserve existing local data");
    const ownHome = process.env.CCAGENT_HOME;
    process.env.CCAGENT_HOME = base;
    await assert.rejects(() => requirePlatformScope(0), (error: unknown) => error instanceof AccountError && error.code === "account_scope_mismatch");
    process.env.CCAGENT_HOME = ownHome;
  });
  await test("worker session files cannot escape the managed credential directories", async () => {
    const base = process.env.CCAGENT_PLATFORM_HOME!;
    for (const unsafe of [path.join(base, "settings.json"), path.join(base, "platform", "..", "other", "session.json"), path.join(base, "platform", "worker-sessions", "not-an-account", "session.json")]) {
      process.env.CCAGENT_AUTH_SESSION_FILE = unsafe;
      assert.throws(() => getPlatformSessionFile(), (error: unknown) => error instanceof AccountError && error.code === "configuration");
    }
    delete process.env.CCAGENT_AUTH_SESSION_FILE;
  });
  console.log(`\n${passed} account transport and credential checks passed. This fixture does not replace Better Auth or a production database.`);
} finally {
  if (previousHome === undefined) delete process.env.CCAGENT_HOME;
  else process.env.CCAGENT_HOME = previousHome;
  if (previousCloudUrl === undefined) delete process.env.CCAGENT_CLOUD_URL;
  else process.env.CCAGENT_CLOUD_URL = previousCloudUrl;
  for (const [key, value] of [["CCAGENT_PLATFORM_HOME", previousPlatformHome], ["CCAGENT_ACCOUNT_ID", previousAccountId], ["CCAGENT_AUTH_SESSION_FILE", previousSessionFile]] as const) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  // Recursive cleanup is restricted to the newly created child of the known workspace temp directory.
  const target = path.resolve(directory);
  assert.equal(path.dirname(target), temporaryParent);
  assert.ok(path.basename(target).startsWith("platform-account-"));
  await rm(target, { recursive: true, force: true });
}
