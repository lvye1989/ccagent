import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import net from "node:net";
import { createHash } from "node:crypto";
import { startAccountFixture } from "./helpers/accountFixture.js";
import { accountHome, enterPlatformAccount, OFFICIAL_ACCOUNT_ORIGIN } from "../platform/account.js";
import { QueryEngine } from "../core/queryEngine.js";
import { query, runTools } from "../core/agenticLoop.js";
import { AccountError } from "../platform/accountClient.js";

const root = path.resolve(import.meta.dirname, "../.."), entry = path.join(root, "dist/ccagent.js");
const temporary = await mkdtemp(path.join(os.tmpdir(), "ccagent-auth-enforcement-"));
const base = path.join(temporary, "home"), workspace = path.join(temporary, "workspace");
await mkdir(base); await mkdir(workspace);
const fixture = await startAccountFixture(base);
const previous = Object.fromEntries(["CCAGENT_HOME", "CCAGENT_PLATFORM_HOME", "CCAGENT_ACCOUNT_ID", "CCAGENT_AUTH_SESSION_FILE"].map(key => [key, process.env[key]]));
process.env.CCAGENT_HOME = base; process.env.CCAGENT_PLATFORM_HOME = base; delete process.env.CCAGENT_ACCOUNT_ID; delete process.env.CCAGENT_AUTH_SESSION_FILE;
const env: NodeJS.ProcessEnv = { ...process.env, CCAGENT_HOME: base, CCAGENT_PLATFORM_HOME: base, ANTHROPIC_API_KEY: "fixture-personal-key", DEEPSEEK_API_KEY: "fixture-custom-key" };
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
let child: ReturnType<typeof spawn> | undefined, passed = 0;
async function test(label: string, run: () => Promise<void>) { await run(); console.log(`PASS ${++passed} ${label}`); }
async function consume(generator: AsyncGenerator<unknown, unknown>) { for await (const _ of generator) { /* Exercise real guards, never call a model. */ } }
try {
  await test("unauthenticated CLI blocks personal keys, settings, print mode, and prompt dumping", async () => {
    for (const args of [["-p", "hello"], ["--dump-system-prompt"], ["init"], ["--settings", "does-not-exist.json", "-p", "hello"]]) {
      await assert.rejects(() => promisify(execFile)(process.execPath, [entry, ...args], { cwd: workspace, env, windowsHide: true, timeout: 15000 }), error => {
        const result = error as { stderr?: string }; return /先使用邮箱和密码登录/.test(result.stderr ?? "");
      });
    }
    assert.equal(fixture.counters().signIns, 0);
  });
  await test("CLI help remains public and private worker cannot be started as a public command", async () => {
    assert.match((await promisify(execFile)(process.execPath, [entry, "--help"], { cwd: workspace, env, windowsHide: true })).stdout, /ccagent account/);
    await assert.rejects(() => promisify(execFile)(process.execPath, [entry, "web-worker"], { cwd: workspace, env, windowsHide: true }), error => /private account worker/.test((error as { stderr?: string }).stderr ?? ""));
  });
  await test("direct QueryEngine and agent loop cannot bypass login", async () => {
    const engine = new QueryEngine({ model: "fixture", toolContext: { cwd: workspace } });
    await assert.rejects(() => consume(engine.submitMessage("/help")), error => error instanceof AccountError && error.status === 401);
    await assert.rejects(() => consume(query({ messages: [], model: "fixture", toolContext: { cwd: workspace } })), error => error instanceof AccountError && error.status === 401);
    await assert.rejects(() => runTools([{ type: "tool_use", id: "forbidden-write", name: "Write", input: { file_path: path.join(workspace, "must-not-exist.txt"), content: "forbidden" } }], { cwd: workspace }, { permissionMode: "full" }), error => error instanceof AccountError && error.status === 401);
    assert.equal(await stat(path.join(workspace, "must-not-exist.txt")).catch(() => null), null);
  });
  await test("real HTTP login and account home permit local engine commands", async () => {
    await fixture.nativeClient.signIn(fixture.users[0]!.email, fixture.password);
    await enterPlatformAccount();
    await consume(new QueryEngine({ model: "fixture", toolContext: { cwd: workspace } }).submitMessage("/help"));
  });
  await test("account revoked while a tool waits for permission cannot execute the tool", async () => {
    const file = path.join(workspace, "revoked-write.txt");
    const result = await runTools([{ type: "tool_use", id: "revoke-at-confirmation", name: "Write", input: { file_path: file, content: "forbidden" } }], { cwd: workspace }, {
      permissionMode: "default", permissionSettings: { allow: [], deny: [], mode: "default" },
      onPermissionRequest: async () => { fixture.disable(fixture.users[0]!.id); return "allow_once"; },
    });
    assert.equal(result.executions[0]?.result.isError, true);
    assert.equal(await stat(file).catch(() => null), null);
    fixture.enable(fixture.users[0]!.id);
  });
  await fixture.nativeClient.signIn(fixture.users[0]!.email, fixture.password);
  await writeFile(path.join(base, "legacy-sentinel.txt"), "legacy data remains untouched");
  // A disabled, loopback-only installation exercises the real app catalog
  // without reaching a third-party service or starting a desktop application.
  const catalogSecret = "fixture-app-secret-not-for-other-accounts";
  const catalogReference = "${CCAGENT_WEB_KEY_" + "A".repeat(24) + "}";
  const catalogServer = { type: "http", url: "http://127.0.0.1:1/mcp", enabled: false, headers: { Authorization: `Bearer ${catalogReference}` } };
  const catalogHome = accountHome(base, fixture.users[0]!.id);
  const catalogSettingsFile = path.join(catalogHome, "settings.json");
  const catalogSettings = JSON.parse(await readFile(catalogSettingsFile, "utf8").catch(error => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "{}";
    throw error;
  }));
  await writeFile(catalogSettingsFile, JSON.stringify({ ...catalogSettings,
    mcpServers: { ...catalogSettings.mcpServers, "app-github": catalogServer },
    webAppConnections: { ...catalogSettings.webAppConnections, github: {
      serverName: "app-github", fingerprint: createHash("sha256").update(JSON.stringify(catalogServer)).digest("hex"), secrets: [catalogReference],
    } },
  }));
  await writeFile(path.join(catalogHome, "web-secrets.env"), `${catalogReference.slice(2, -1)}=${JSON.stringify(catalogSecret)}\n`);
  const port = await new Promise<number>((resolve, reject) => { const probe = net.createServer(); probe.once("error", reject); probe.listen(0, "127.0.0.1", () => { const address = probe.address(); probe.close(() => address && typeof address !== "string" ? resolve(address.port) : reject(new Error("port"))); }); });
  const origin = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [entry, "web", "--workspace", workspace, "--port", String(port)], { cwd: workspace, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let logs = ""; child.stdout?.on("data", chunk => { logs += String(chunk); }); child.stderr?.on("data", chunk => { logs += String(chunk); });
  for (let i = 0; i < 100; i++) { if (await fetch(origin + "/api/health").then(response => response.ok, () => false)) break; if (child.exitCode !== null) throw new Error(logs); await delay(100); }
  const post = (route: string, body: unknown, cookie?: string, extra: Record<string, string> = {}) => fetch(origin + route, { method: "POST", headers: { origin, "x-ccagent-web": "1", "content-type": "application/json", ...(cookie ? { cookie } : {}), ...extra }, body: JSON.stringify(body) });
  const appMutations = ["/api/apps/action", "/api/apps/comfyui/test", "/api/apps/photoshop/test", "/api/apps/sketchup/test"];
  async function login(index: number) { const response = await post("/api/account/login", { email: fixture.users[index]!.email, password: fixture.password }); assert.equal(response.status, 200, await response.text()); const cookie = response.headers.get("set-cookie")?.split(";")[0]; assert.ok(cookie); return cookie; }
  await test("fresh browsers cannot inherit the desktop/CLI login; login assets are public", async () => {
    assert.equal((await fetch(origin, { redirect: "manual" })).status, 303);
    for (const route of ["/api/bootstrap", "/api/sessions", "/api/apps", "/app.js", "/app-catalog.js", "/promotion.js"]) assert.equal((await fetch(origin + route)).status, 401, route);
    for (const route of appMutations) assert.equal((await post(route, {})).status, 401, route);
    assert.equal((await fetch(origin + "/login")).status, 200);
    assert.equal((await post("/api/account/login", { email: fixture.users[0]!.email, password: fixture.password }, undefined, { origin: "https://evil.example" })).status, 403);
  });
  await test("a first launch opens login with the preset official account service", async () => {
    const configuration = path.join(base, "platform", "configuration.json"), saved = configuration + ".fixture-saved";
    await rename(configuration, saved);
    try {
      assert.equal((await fetch(origin, { redirect: "manual" })).status, 303);
      assert.equal((await fetch(origin + "/login")).status, 200);
      const config = await (await fetch(origin + "/api/account/config")).json() as { configured: boolean; origin: string };
      assert.equal(config.configured, true);
      assert.equal(config.origin, env.CCAGENT_CLOUD_URL?.trim() || OFFICIAL_ACCOUNT_ORIGIN);
    } finally { await rename(saved, configuration); }
  });
  await test("advanced connection settings reject every alias of this local Web origin", async () => {
    for (const selectedOrigin of [origin, `http://localhost:${port}`, `http://[::1]:${port}`]) {
      const response = await post("/api/account/setup", { origin: selectedOrigin });
      assert.equal(response.status, 400);
      assert.match((await response.json() as { error: string }).error, /本机应用地址/);
    }
    assert.equal((await (await fetch(origin + "/api/account/config")).json() as { origin: string }).origin, fixture.origin);
  });
  const cookieA = await login(0), cookieB = await login(1);
  const get = (route: string, cookie: string) => fetch(origin + route, { headers: { cookie } });
  await test("verification resend validates email and enforces the same local request origin", async () => {
    assert.equal((await post("/api/account/resend-verification", { email: "invalid" })).status, 400);
    assert.equal((await post("/api/account/resend-verification", { email: fixture.users[0]!.email }, undefined, { origin: "https://evil.example" })).status, 403);
    const reply = await post("/api/account/resend-verification", { email: fixture.users[0]!.email });
    assert.equal(reply.status, 200);
    assert.match((await reply.json() as { message: string }).message, /如果该邮箱已注册且尚未验证/);
  });
  await test("app catalog installations stay account-scoped and never expose credentials", async () => {
    const responseA = await get("/api/apps", cookieA), responseB = await get("/api/apps", cookieB);
    assert.equal(responseA.status, 200); assert.equal(responseB.status, 200);
    const textA = await responseA.text(), textB = await responseB.text();
    for (const text of [textA, textB]) {
      assert.ok(!text.includes(catalogSecret)); assert.ok(!text.includes(catalogReference));
      assert.ok(!text.includes(catalogServer.url));
    }
    type Catalog = { apps: Array<{ id: string; installed: boolean; state: string }> };
    const appA = (JSON.parse(textA) as Catalog).apps.find(app => app.id === "github");
    const appB = (JSON.parse(textB) as Catalog).apps.find(app => app.id === "github");
    assert.ok(appA); assert.ok(appB);
    assert.equal(appA.installed, true); assert.equal(appA.state, "disabled");
    assert.equal(appB.installed, false); assert.equal(appB.state, "available");
    const beforeOtherUninstall = await readFile(catalogSettingsFile, "utf8");
    const otherUninstall = await post("/api/apps/action", { id: "github", op: "uninstall" }, cookieB);
    assert.equal(otherUninstall.status, 400);
    assert.equal(await readFile(catalogSettingsFile, "utf8"), beforeOtherUninstall);
    const stillOwned = await (await get("/api/apps", cookieA)).json() as Catalog;
    assert.equal(stillOwned.apps.find(app => app.id === "github")?.installed, true);
  });
  await test("different browser logins run the real engine with isolated sessions", async () => {
    assert.equal((await get("/api/bootstrap", cookieA)).status, 200);
    const createdResponse = await post("/api/sessions", {}, cookieA); assert.equal(createdResponse.status, 201, await createdResponse.clone().text());
    const created = await createdResponse.json() as { sessionId: string };
    assert.equal((await get(`/api/sessions/${created.sessionId}`, cookieA)).status, 200);
    const crossAccount = await get(`/api/sessions/${created.sessionId}`, cookieB);
    assert.equal(crossAccount.status, 404, await crossAccount.text());
    assert.equal((await post("/api/account/resend-verification", { email: fixture.users[0]!.email }, cookieA)).status, 200);
    assert.equal((await get(`/api/sessions/${created.sessionId}`, cookieA)).status, 200, "Resending verification must preserve the existing local worker and session");
    assert.notEqual(accountHome(base, fixture.users[0]!.id), accountHome(base, fixture.users[1]!.id));
    assert.equal(await readFile(path.join(base, "legacy-sentinel.txt"), "utf8"), "legacy data remains untouched");
  });
  await test("an authentication outage blocks work and a fresh online session check recovers access", async () => {
    fixture.setUnavailable(true);
    try {
      assert.equal((await get("/api/apps", cookieA)).status, 503);
      // The first failed verification closes the worker. Further business
      // requests stay blocked until an online account/status check recovers it.
      assert.equal((await get("/api/bootstrap", cookieA)).status, 401);
      for (const route of appMutations) assert.equal((await post(route, {}, cookieA)).status, 401, route);
    }
    finally { fixture.setUnavailable(false); }
    assert.equal((await get("/api/account/status", cookieA)).status, 200);
    assert.equal((await get("/api/bootstrap", cookieA)).status, 200);
    assert.equal((await get("/api/apps", cookieA)).status, 200);
  });
  await test("logout and account disable immediately block business APIs without affecting the other login", async () => {
    assert.equal((await post("/api/account/logout", {}, cookieA)).status, 200);
    assert.equal((await get("/api/bootstrap", cookieA)).status, 401);
    assert.equal((await get("/api/apps", cookieA)).status, 401);
    for (const route of appMutations) assert.equal((await post(route, {}, cookieA)).status, 401, route);
    assert.equal((await get("/api/bootstrap", cookieB)).status, 200);
    fixture.disable(fixture.users[1]!.id);
    assert.equal((await get("/api/apps", cookieB)).status, 403);
    assert.equal((await get("/api/bootstrap", cookieB)).status, 401);
    for (const route of appMutations) assert.equal((await post(route, {}, cookieB)).status, 401, route);
  });
  // Exercise the exact private-header path used by Electron, with a real login.
  if (child.connected) { const closed = new Promise<void>(resolve => child!.once("exit", () => resolve())); child.send("ccagent:shutdown", () => {}); await closed; }
  const desktopHeader = { "x-ccagent-desktop-token": "b".repeat(64) };
  child = spawn(process.execPath, [entry, "web", "--workspace", workspace, "--port", String(port)], { cwd: workspace, env: { ...env, CCAGENT_DESKTOP_TOKEN: desktopHeader["x-ccagent-desktop-token"] }, windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  child.stdout?.resume(); child.stderr?.resume();
  for (let i = 0; i < 100; i++) { if (await fetch(origin + "/api/health", { headers: desktopHeader }).then(response => response.ok, () => false)) break; await delay(100); }
  await test("desktop private token and email login are both required, and native logout revokes access", async () => {
    assert.equal((await fetch(origin + "/api/health")).status, 403);
    assert.equal((await fetch(origin + "/api/account/status", { headers: desktopHeader })).status, 200);
    assert.equal((await fetch(origin + "/api/bootstrap", { headers: desktopHeader })).status, 200);
    assert.equal((await post("/api/account/logout", {}, undefined, desktopHeader)).status, 200);
    assert.equal((await fetch(origin + "/api/bootstrap", { headers: desktopHeader })).status, 401);
    assert.equal((await post("/api/account/login", { email: fixture.users[0]!.email, password: fixture.password }, undefined, desktopHeader)).status, 200);
    assert.equal((await fetch(origin + "/api/bootstrap", { headers: desktopHeader })).status, 200);
  });
  await test("switching the shared native login clears the previous engine before serving the new account", async () => {
    fixture.enable(fixture.users[1]!.id);
    await fixture.nativeClient.signIn(fixture.users[1]!.email, fixture.password);
    assert.equal((await fetch(origin + "/api/bootstrap", { headers: desktopHeader })).status, 401);
    const status = await (await fetch(origin + "/api/account/status", { headers: desktopHeader })).json() as { user: { id: string } };
    assert.equal(status.user.id, fixture.users[1]!.id);
    assert.equal((await fetch(origin + "/api/bootstrap", { headers: desktopHeader })).status, 200);
  });
  console.log(`${passed} authentication enforcement checks passed (real local HTTP and DPAPI; no production email or provider request).`);
} finally {
  if (child && child.exitCode === null && child.signalCode === null) { const closed = new Promise<void>(resolve => child!.once("exit", () => resolve())); child.send?.("ccagent:shutdown", () => {}); const timeout = setTimeout(() => child?.kill(), 6000); await closed; clearTimeout(timeout); }
  await fixture.close();
  for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  const target = path.resolve(temporary); assert.equal(path.dirname(target), path.resolve(os.tmpdir())); assert.ok(path.basename(target).startsWith("ccagent-auth-enforcement-"));
  await rm(target, { recursive: true, force: true });
}
