import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { AccountError, normalizePlatformOrigin, PlatformAccountClient, type StoredAccountSession } from "../platform/accountClient.js";
import { SecureCredentialStore } from "../platform/secureStore.js";
import { runAccountCommand } from "../entrypoint/account.js";
import { Writable } from "node:stream";

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
let user = { ...identity };
let passwordRequests = 0;
let requests = 0;
const server = createServer(async (req, res) => {
  requests++;
  res.setHeader("content-type", "application/json");
  assert.equal(req.headers.origin, origin);
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
process.env.CCAGENT_HOME = path.join(directory, "user-home");
let passed = 0;
async function test(name: string, run: () => Promise<void> | void): Promise<void> { await run(); passed++; console.log(`PASS ${name}`); }

try {
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
  console.log(`\n${passed} account transport and credential checks passed. This fixture does not replace Better Auth or a production database.`);
} finally {
  if (previousHome === undefined) delete process.env.CCAGENT_HOME;
  else process.env.CCAGENT_HOME = previousHome;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  // Recursive cleanup is restricted to the newly created child of the known workspace temp directory.
  const target = path.resolve(directory);
  assert.equal(path.dirname(target), temporaryParent);
  assert.ok(path.basename(target).startsWith("platform-account-"));
  await rm(target, { recursive: true, force: true });
}
