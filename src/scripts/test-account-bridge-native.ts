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
const fixture = await startAccountFixture(home, { handleService: async (request, response, user) => {
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
  const login = await post("/api/account/login", { email: fixture.users[0]!.email, password: fixture.password });
  assert.equal(login.status, 200); cookie = login.headers.getSetCookie()[0]!.split(";", 1)[0]!;
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
  await test("native client rejects changed account and unsafe or expired upstream replies", async () => {
    await assert.rejects(() => fixture.nativeClient.issueAccountBridge(state, fixture.users[1]!.id), error => error instanceof AccountError && error.code === "account_changed");
    try {
      for (reply of [{ ticket: "long-session-secret", expiresAt: new Date(Date.now() + 60000).toISOString() }, { ticket, expiresAt: new Date(0).toISOString() }, { ticket, expiresAt: new Date(Date.now() + 600000).toISOString() }, { ticket }]) {
        await assert.rejects(() => fixture.nativeClient.issueAccountBridge(state, fixture.users[0]!.id), error => error instanceof AccountError && error.code === "invalid_response");
      }
    } finally { reply = undefined; }
  });
  await test("a retained browser session can bridge immediately after a local server restart", async () => {
    const stopped = new Promise<void>(resolve => server.once("close", () => resolve())); server.send?.("ccagent:shutdown"); await stopped;
    server = startServer();
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(origin + "/api/health")).ok) break; } catch { /* restart */ }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const result = await post("/api/account/bridge", { state }); assert.equal(result.status, 200);
    assert.equal((await result.json() as { userId: string }).userId, fixture.users[0]!.id);
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
  release?.();
  if (server.exitCode === null && server.signalCode === null) {
    const stopped = new Promise<void>(resolve => server.once("close", () => resolve())); server.send?.("ccagent:shutdown");
    const timeout = setTimeout(() => server.kill(), 6000); await stopped; clearTimeout(timeout);
  }
  await fixture.close();
  assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir())); assert.ok(path.basename(temporary).startsWith("ccagent-bridge-"));
  await rm(temporary, { recursive: true, force: true });
}
