/** Real CLI/Web startup regressions using isolated encrypted stores. All outbound HTTPS is blocked. */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { OFFICIAL_ACCOUNT_ORIGIN } from "../platform/account.js";
import type { StoredAccountSession } from "../platform/accountClient.js";
import { SecureCredentialStore } from "../platform/secureStore.js";

const root = path.resolve(import.meta.dirname, "../.."), entry = path.join(root, "dist/ccagent.js");
const temporaryParent = path.resolve(os.tmpdir()), directory = await mkdtemp(path.join(temporaryParent, "ccagent-default-startup-"));
const preload = path.join(directory, "startup-guard.mjs");
await writeFile(preload, `import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
https.request = https.get = () => { console.error("UNEXPECTED_OUTBOUND_HTTPS"); throw new Error("Outbound HTTPS forbidden in startup test"); };
const rename = fs.promises.rename;
fs.promises.rename = async (from, to) => {
  if (process.env.CCAGENT_STARTUP_TEST_DENY_WRITE && path.resolve(String(to)) === process.env.CCAGENT_STARTUP_TEST_DENY_WRITE) {
    const error = new Error("Synthetic configuration write failure"); error.code = "EACCES"; throw error;
  }
  return rename(from, to);
};
syncBuiltinESMExports();
`);
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function waitBounded(ended: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([ended, new Promise<void>(resolve => { timer = setTimeout(resolve, ms); })]); }
  finally { if (timer) clearTimeout(timer); }
}
async function stop(child: ChildProcess, ended: Promise<void>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (child.connected) child.send("ccagent:shutdown", () => {});
  await waitBounded(ended, 4000);
  if (child.exitCode === null && child.signalCode === null) child.kill();
  await waitBounded(ended, 2000);
  assert.ok(child.exitCode !== null || child.signalCode !== null, "Startup fixture must stop within the IPC/kill deadline");
}
async function availablePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve, reject) => { probe.once("error", reject); probe.listen(0, "127.0.0.1", resolve); });
  const address = probe.address(); assert.ok(address && typeof address !== "string");
  await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  return address.port;
}

let passed = 0;
async function checkStartup(label: string, options: { custom?: boolean; invalidEnvironment?: boolean; denyWrite?: boolean } = {}): Promise<void> {
  const home = path.join(directory, "case-" + ++passed), workspace = path.join(home, "workspace");
  await mkdir(workspace, { recursive: true });
  const port = await availablePort(), localOrigin = `http://127.0.0.1:${port}`;
  const selectedOrigin = options.custom ? "https://private.example.invalid" : localOrigin;
  const configurationFile = path.join(home, "platform/configuration.json"), browserId = "a".repeat(64);
  const sessionFile = path.join(home, "platform/web-sessions", browserId, "session.json");
  await new SecureCredentialStore<{ origin: string }>(configurationFile).write({ origin: selectedOrigin });
  await new SecureCredentialStore<StoredAccountSession>(sessionFile).write({
    origin: localOrigin, cookie: "ccagent.session_token=synthetic-old-session.signature",
    user: { id: "startup-fixture", email: "startup@example.invalid", name: "Startup fixture" }, expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  });
  const oldSession = await readFile(sessionFile), oldConfiguration = await readFile(configurationFile);
  const env: NodeJS.ProcessEnv = { ...process.env, CCAGENT_HOME: home, CCAGENT_PLATFORM_HOME: home };
  for (const name of ["CCAGENT_ACCOUNT_ID", "CCAGENT_AUTH_SESSION_FILE", "CCAGENT_CLOUD_URL", "CCAGENT_ENV_FILE", "CCAGENT_DESKTOP_TOKEN", "CCAGENT_DESKTOP_APP", "NODE_OPTIONS", "CCAGENT_STARTUP_TEST_DENY_WRITE"]) delete env[name];
  if (options.invalidEnvironment) env.CCAGENT_CLOUD_URL = "not-a-valid-platform-url";
  if (options.custom) env.CCAGENT_CLOUD_URL = "https://environment.example.invalid";
  if (options.denyWrite) env.CCAGENT_STARTUP_TEST_DENY_WRITE = configurationFile;
  const child = spawn(process.execPath, ["--import", pathToFileURL(preload).href, entry, "web", "--workspace", workspace, "--port", String(port)], { cwd: workspace, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let logs = "", spawnError: Error | undefined;
  child.stdout?.on("data", chunk => { logs = (logs + String(chunk)).slice(-4000); }); child.stderr?.on("data", chunk => { logs = (logs + String(chunk)).slice(-4000); });
  child.once("error", error => { spawnError = error; });
  const ended = new Promise<void>(resolve => child.once("exit", () => resolve()));
  const get = (route: string, headers?: Record<string, string>) => fetch(localOrigin + route, { headers, redirect: "manual", signal: AbortSignal.timeout(2500) });
  try {
    const deadline = Date.now() + 20_000;
    let ready = false;
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null || child.signalCode !== null) assert.fail("Web exited before listening: " + logs);
      if (await get("/api/health").then(reply => reply.ok, () => false)) { ready = true; break; }
      await delay(100);
    }
    assert.ok(ready, "Web health must become available: " + logs);
    assert.equal((await get("/login")).status, 200, "Login assets stay publicly accessible");
    const configReply = await get("/api/account/config"), config = await configReply.json() as { configured?: boolean; origin?: string; error?: string; code?: string };
    if (options.denyWrite) {
      assert.equal(configReply.status, 503); assert.equal(config.code, "configuration"); assert.match(config.error ?? "", /本机应用.*高级连接设置/);
      assert.deepEqual(await readFile(configurationFile), oldConfiguration, "A failed migration cannot damage the saved configuration");
    } else {
      assert.equal(configReply.status, 200); assert.equal(config.configured, true);
      const expectedOrigin = options.custom ? selectedOrigin : OFFICIAL_ACCOUNT_ORIGIN;
      assert.equal(config.origin, expectedOrigin);
      assert.equal((await new SecureCredentialStore<{ origin: string }>(configurationFile).read())?.origin, expectedOrigin, "Migration is persisted for the next launch");
      if (options.custom) assert.deepEqual(await readFile(configurationFile), oldConfiguration, "Valid private configuration must remain byte-for-byte unchanged");
      const sessionReply = await get("/api/account/status", { cookie: "ccagent.local_session=" + browserId });
      assert.equal((await sessionReply.json() as { code: string }).code, "origin_changed", "Old credentials are rejected before any remote request");
    }
    assert.deepEqual(await readFile(sessionFile), oldSession, "Migration cannot rebind or rewrite an old session");
    assert.doesNotMatch(logs, /UNEXPECTED_OUTBOUND_HTTPS/, "Startup/session checks must not attempt external HTTPS");
    console.log("PASS " + label);
  } finally { await stop(child, ended); }
}

try {
  await checkStartup("saved self address migrates to the bundled official account origin");
  await checkStartup("valid private account origin overrides environment defaults and remains untouched", { custom: true });
  await checkStartup("saved self address with invalid environment falls back to bundled official origin", { invalidEnvironment: true });
  await checkStartup("failed migration write keeps health/login available and config reports actionable 503", { denyWrite: true });
  console.log("Account startup regressions passed: real CLI/Web, isolated DPAPI stores, default/private origins, failed-write recovery and unchanged origin-bound sessions. No external service was contacted.");
} finally {
  const cleanupTarget = path.resolve(directory);
  assert.equal(path.dirname(cleanupTarget), temporaryParent); assert.ok(path.basename(cleanupTarget).startsWith("ccagent-default-startup-"));
  await rm(cleanupTarget, { recursive: true, force: true });
}
