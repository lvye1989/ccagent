import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { startAccountFixture } from "./helpers/accountFixture.js";
import { AccountError } from "../platform/accountClient.js";

const root = path.resolve(import.meta.dirname, "../.."), temporary = await mkdtemp(path.join(os.tmpdir(), "ccagent-bridge-"));
const workspace = path.join(temporary, "workspace"), home = path.join(temporary, "home");
await mkdir(workspace); await mkdir(home);
const ticket = "t".repeat(43), state = "signedState.signature";
let reply: unknown, gate: Promise<void> | undefined, entered: (() => void) | undefined, release: (() => void) | undefined;
let exchanges = 0;
let accessRequests = 0, accessReply: unknown, accessGate: Promise<void> | undefined, accessEntered: (() => void) | undefined, accessRelease: (() => void) | undefined;
const permissions = new Map<string, string[]>([["fixture-account-a", ["admin.read"]], ["fixture-account-b", []]]);
const fixture = await startAccountFixture(home, { handleService: async (request, response, user) => {
  if (request.url === "/api/account/me") {
    assert.equal(request.method, "GET"); assert.equal(request.headers.origin, fixture.origin);
    assert.equal(request.headers.authorization, undefined, "permissions require no model API Key");
    assert.equal(request.headers["cache-control"], "no-store");
    if (!user) { response.writeHead(401); response.end("{}"); return true; }
    accessRequests++; accessEntered?.(); await accessGate;
    response.end(JSON.stringify(accessReply ?? { user: { ...user, privateField: "must-not-be-returned" }, permissions: permissions.get(user.id), expiresAt: new Date(Date.now() + 60000).toISOString(), secret: "must-not-be-returned" }));
    return true;
  }
  if (request.url !== "/api/account/bridge/issue") return false;
  assert.equal(request.method, "POST");
  assert.equal(request.headers.origin, fixture.origin);
  let body = ""; for await (const chunk of request) body += chunk;
  assert.equal(JSON.parse(body).state, state);
  if (!user) { response.writeHead(401); response.end("{}"); return true; }
  exchanges++; entered?.(); await gate;
  response.end(JSON.stringify(reply ?? { ticket, expiresAt: new Date(Date.now() + 60000).toISOString() }));
  return true;
} });
const probe = createServer(); await new Promise<void>(resolve => probe.listen(0, "127.0.0.1", resolve));
const address = probe.address(); assert.ok(address && typeof address !== "string"); const port = address.port;
await new Promise<void>(resolve => probe.close(() => resolve())); const origin = `http://127.0.0.1:${port}`;
const env: NodeJS.ProcessEnv = { ...process.env, CCAGENT_HOME: home, CCAGENT_PLATFORM_HOME: home, CCAGENT_CLOUD_URL: fixture.origin };
delete env.CCAGENT_DESKTOP_TOKEN; delete env.CCAGENT_ACCOUNT_ID; delete env.CCAGENT_AUTH_SESSION_FILE; delete env.NODE_TLS_REJECT_UNAUTHORIZED;
const startServer = () => spawn(process.execPath, [path.join(root, "dist/ccagent.js"), "web", "--port", String(port), "--workspace", workspace], { env, windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"] });
let server = startServer();
let passed = 0;
async function test(name: string, run: () => Promise<void>) { await run(); console.log(`PASS ${++passed} ${name}`); }
let cookie = "";
function post(route: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(origin + route, { method: "POST", headers: { origin, "x-ccagent-web": "1", "content-type": "application/json", cookie, ...headers }, body: JSON.stringify(body) });
}
function access(headers: Record<string, string> = {}) { return fetch(origin + "/api/account/access", { headers: { cookie, ...headers } }); }
function holdAccess() {
  const reached = new Promise<void>(resolve => { accessEntered = resolve; });
  accessGate = new Promise<void>(resolve => { accessRelease = resolve; });
  return Promise.race([reached, new Promise((_, reject) => setTimeout(() => reject(new Error("ACCESS_NOT_REACHED")), 5000))]);
}
function releaseAccess() { accessRelease?.(); accessGate = undefined; accessEntered = undefined; accessRelease = undefined; }
async function loginUser(index = 0) {
  const result = await post("/api/account/login", { email: fixture.users[index]!.email, password: fixture.password });
  assert.equal(result.status, 200); cookie = result.headers.getSetCookie()[0]!.split(";", 1)[0]!;
}
try {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(origin + "/api/health")).ok) break; } catch { /* startup */ }
    if (server.exitCode !== null) throw new Error("BRIDGE_FIXTURE_SERVER_FAILED");
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  await test("anonymous, cross-origin and missing CSRF header cannot issue a ticket", async () => {
    assert.equal((await post("/api/account/bridge", { state })).status, 401);
    assert.equal((await post("/api/account/bridge", { state }, { origin: "https://attacker.example" })).status, 403);
    assert.equal((await post("/api/account/bridge", { state }, { "x-ccagent-web": "" })).status, 403);
    assert.equal(exchanges, 0);
  });
  await test("anonymous or cross-origin callers cannot read account permissions", async () => {
    assert.equal((await access()).status, 401);
    assert.equal((await access({ cookie: "ccagent.local_session=" + "a".repeat(64) })).status, 401);
    assert.equal((await access({ origin: "https://attacker.example" })).status, 403);
    assert.equal(accessRequests, 0);
  });
  await loginUser();
  await test("account access returns live safe identity and permissions without a worker or model Key", async () => {
    const result = await access(); assert.equal(result.status, 200); assert.equal(result.headers.get("cache-control"), "no-store");
    const value = await result.json();
    assert.deepEqual(value, { origin: fixture.origin, user: fixture.users[0], permissions: ["admin.read"] });
    assert.equal(result.headers.get("set-cookie"), null); assert(!JSON.stringify(value).includes("must-not-be-returned"));
    permissions.set(fixture.users[0]!.id, []);
    assert.deepEqual((await (await access()).json() as { permissions: string[] }).permissions, []);
    permissions.set(fixture.users[0]!.id, ["admin.read"]);
  });
  await test("another user's identity or malformed permission response never reaches the browser", async () => {
    try {
      accessReply = { user: fixture.users[1], permissions: ["admin.read"] };
      const mismatch = await access(); assert.equal(mismatch.status, 401);
      const text = await mismatch.text(); assert(!text.includes(fixture.users[1]!.email) && !text.includes("admin.read"));
      for (const invalid of [null, "admin.read", ["admin.read", {}], ["admin.read", "unexpected secret content"]]) {
        accessReply = { user: fixture.users[0], permissions: invalid };
        const response = await access(); assert.equal(response.status, 502); assert(!(await response.text()).includes("unexpected secret content"));
      }
    } finally { accessReply = undefined; }
  });
  await test("authenticated local HTTP exposes only a short ticket for its own user", async () => {
    const result = await post("/api/account/bridge", { state }); assert.equal(result.status, 200);
    assert.equal(result.headers.get("cache-control"), "no-store");
    const value = await result.json() as Record<string, unknown>;
    assert.deepEqual(Object.keys(value).sort(), ["expiresAt", "origin", "ticket", "userId"]);
    assert.equal(value.ticket, ticket); assert.equal(value.origin, fixture.origin); assert.equal(value.userId, fixture.users[0]!.id);
    assert.equal(result.headers.get("set-cookie"), null);
  });
  await test("malformed and oversized state fail before issuing, GET cannot issue", async () => {
    const before = exchanges;
    for (const invalid of [null, "", "https://attacker.example", "a".repeat(8193), "a.b c"]) assert.equal((await post("/api/account/bridge", { state: invalid })).status, 400);
    assert.equal((await fetch(origin + "/api/account/bridge", { headers: { cookie } })).status, 404);
    assert.equal(exchanges, before);
  });
  await fixture.nativeClient.signIn(fixture.users[0]!.email, fixture.password);
  await test("native permission reads reject session replacement while a cloud response is in flight", async () => {
    const reached = holdAccess(), pending = fixture.nativeClient.accountAccess();
    const refused = assert.rejects(pending, error => error instanceof AccountError && error.code === "account_changed");
    try { await reached; await fixture.nativeClient.signIn(fixture.users[0]!.email, fixture.password); releaseAccess(); await refused; }
    finally { releaseAccess(); await refused; }
  });
  await test("native client rejects changed account and unsafe or expired upstream replies", async () => {
    await assert.rejects(() => fixture.nativeClient.issueAccountBridge(state, fixture.users[1]!.id), error => error instanceof AccountError && error.code === "account_changed");
    try {
      for (reply of [{ ticket: "long-session-secret", expiresAt: new Date(Date.now() + 60000).toISOString() }, { ticket, expiresAt: new Date(0).toISOString() }, { ticket, expiresAt: new Date(Date.now() + 600000).toISOString() }, { ticket }]) {
        await assert.rejects(() => fixture.nativeClient.issueAccountBridge(state, fixture.users[0]!.id), error => error instanceof AccountError && error.code === "invalid_response");
      }
    } finally { reply = undefined; }
  });
  await test("a retained browser session can read permissions and bridge immediately after a local server restart", async () => {
    const stopped = new Promise<void>(resolve => server.once("close", () => resolve())); server.send?.("ccagent:shutdown"); await stopped;
    server = startServer();
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(origin + "/api/health")).ok) break; } catch { /* restart */ }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const accessResult = await access(); assert.equal(accessResult.status, 200);
    assert.equal((await accessResult.json() as { user: { id: string } }).user.id, fixture.users[0]!.id);
    const result = await post("/api/account/bridge", { state }); assert.equal(result.status, 200);
    assert.equal((await result.json() as { userId: string }).userId, fixture.users[0]!.id);
  });
  await test("account switching rejects in-flight permissions and isolates the replacement browser session", async () => {
    const reached = holdAccess(), pending = access();
    try {
      await reached; await loginUser(1); releaseAccess();
      const result = await pending; assert.equal(result.status, 401);
      const text = await result.text(); assert(!text.includes("admin.read") && !text.includes(fixture.users[0]!.email));
      assert.deepEqual(await (await access()).json(), { origin: fixture.origin, user: fixture.users[1], permissions: [] });
    } finally { releaseAccess(); await pending; await loginUser(); }
  });
  await test("service-address changes reject in-flight permission results", async () => {
    const reached = holdAccess(), pending = access();
    try {
      await reached; assert.equal((await post("/api/account/setup", { origin: "http://127.0.0.1:1" })).status, 200); releaseAccess();
      const result = await pending; assert.equal(result.status, 401); assert(!(await result.text()).includes("admin.read"));
    } finally {
      releaseAccess(); await pending;
      assert.equal((await post("/api/account/setup", { origin: fixture.origin })).status, 200); await loginUser();
    }
  });
  await test("logout rejects in-flight account permissions and subsequent reads", async () => {
    const reached = holdAccess(), pending = access();
    try {
      await reached; assert.equal((await post("/api/account/logout", {})).status, 200); releaseAccess();
      const result = await pending; assert.equal(result.status, 401); assert(!(await result.text()).includes("admin.read"));
      assert.equal((await access()).status, 401);
    } finally { releaseAccess(); await pending; await loginUser(); }
  });
  await test("logout during exchange discards the in-flight ticket", async () => {
    const reached = new Promise<void>(resolve => { entered = resolve; });
    gate = new Promise<void>(resolve => { release = resolve; });
    const pending = post("/api/account/bridge", { state });
    await Promise.race([reached, new Promise((_, reject) => setTimeout(() => reject(new Error("EXCHANGE_NOT_REACHED")), 5000))]);
    assert.equal((await post("/api/account/logout", {})).status, 200);
    release!(); gate = undefined;
    const result = await pending; assert.equal(result.status, 401);
    assert.ok(!(await result.text()).includes(ticket));
  });
  console.log(`${passed} account bridge native/HTTP checks passed; fixture transport only, no production account or mail.`);
} finally {
  release?.(); releaseAccess();
  if (server.exitCode === null && server.signalCode === null) {
    const stopped = new Promise<void>(resolve => server.once("close", () => resolve())); server.send?.("ccagent:shutdown");
    const timeout = setTimeout(() => server.kill(), 6000); await stopped; clearTimeout(timeout);
  }
  await fixture.close();
  assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir())); assert.ok(path.basename(temporary).startsWith("ccagent-bridge-"));
  await rm(temporary, { recursive: true, force: true });
}
