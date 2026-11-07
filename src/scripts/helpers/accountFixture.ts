import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { PlatformAccountClient, type AccountUser, type StoredAccountSession } from "../../platform/accountClient.js";
import { SecureCredentialStore } from "../../platform/secureStore.js";
import { enterPlatformAccount } from "../../platform/account.js";

/** Real loopback HTTP + DPAPI fixture; production authentication has no test bypass. */
export async function startAccountFixture(base: string, options: { handleService?: (request: IncomingMessage, response: ServerResponse, user: AccountUser | undefined) => Promise<boolean> } = {}) {
  const users: AccountUser[] = [
    { id: "fixture-account-a", email: "account-a@example.invalid", name: "Account A" },
    { id: "fixture-account-b", email: "account-b@example.invalid", name: "Account B" },
  ];
  const password = "Fixture-" + randomBytes(16).toString("hex");
  const sessions = new Map<string, AccountUser>(), disabled = new Set<string>();
  let sessionChecks = 0, signIns = 0, unavailable = false;
  const server = createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    const reply = (status: number, value: unknown) => { res.writeHead(status); res.end(JSON.stringify(value)); };
    if (unavailable) return reply(503, { code: "FIXTURE_UNAVAILABLE" });
    if (req.url === "/api/auth/sign-in/email" && req.method === "POST") {
      let data = ""; for await (const chunk of req) data += chunk;
      const input = JSON.parse(data) as Record<string, unknown>, user = users.find(user => user.email === input.email);
      if (!user || input.password !== password || disabled.has(user.id)) return reply(401, { code: "INVALID_EMAIL_OR_PASSWORD" });
      const token = randomBytes(24).toString("hex"); sessions.set(token, user); signIns++;
      res.setHeader("set-cookie", `ccagent.session_token=${token}; Path=/; HttpOnly; SameSite=Lax`);
      return reply(200, { user });
    }
    const token = /^ccagent\.session_token=([a-f0-9]+)$/.exec(req.headers.cookie ?? "")?.[1];
    const user = token ? sessions.get(token) : undefined;
    if (req.url === "/api/auth/get-session") {
      sessionChecks++;
      if (!user) return reply(200, null);
      if (disabled.has(user.id)) return reply(403, { code: "USER_BANNED" });
      return reply(200, { user, session: { expiresAt: new Date(Date.now() + 3600_000).toISOString() } });
    }
    if (req.url === "/api/auth/sign-out" && req.method === "POST") { if (token) sessions.delete(token); return reply(200, { success: true }); }
    if (["/api/auth/sign-up/email", "/api/auth/request-password-reset"].includes(req.url ?? "")) return reply(200, { success: true });
    if (options.handleService && await options.handleService(req, res, user && !disabled.has(user.id) ? user : undefined)) return;
    return reply(404, {});
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  await new SecureCredentialStore<{ origin: string }>(path.join(base, "platform", "configuration.json")).write({ origin });
  const nativeClient = new PlatformAccountClient(origin, new SecureCredentialStore<StoredAccountSession>(path.join(base, "platform", "session.json")));
  return {
    users, password, origin, nativeClient,
    disable(userId: string) { disabled.add(userId); }, enable(userId: string) { disabled.delete(userId); },
    counters() { return { sessionChecks, signIns }; },
    setUnavailable(value: boolean) { unavailable = value; },
    async close() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}

/** Bind a suite to a real fixture login; production guards remain enabled. */
export async function loginForTest(base: string) {
  const keys = ["CCAGENT_HOME", "CCAGENT_PLATFORM_HOME", "CCAGENT_ACCOUNT_ID", "CCAGENT_AUTH_SESSION_FILE"];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  process.env.CCAGENT_HOME = base; process.env.CCAGENT_PLATFORM_HOME = base;
  delete process.env.CCAGENT_ACCOUNT_ID; delete process.env.CCAGENT_AUTH_SESSION_FILE;
  const fixture = await startAccountFixture(base);
  await fixture.nativeClient.signIn(fixture.users[0]!.email, fixture.password);
  const { home } = await enterPlatformAccount();
  return { ...fixture, home, async close() {
    await fixture.close();
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  } };
}

export async function withTestAccount<T>(run: () => Promise<T>): Promise<T> {
  const base = await mkdtemp(path.join(os.tmpdir(), "ccagent-auth-suite-"));
  const fixture = await loginForTest(base);
  try { return await run(); }
  finally {
    await fixture.close();
    if (path.dirname(path.resolve(base)) !== path.resolve(os.tmpdir()) || !path.basename(base).startsWith("ccagent-auth-suite-")) throw new Error("Unsafe account suite cleanup");
    await rm(base, { recursive: true, force: true });
  }
}
