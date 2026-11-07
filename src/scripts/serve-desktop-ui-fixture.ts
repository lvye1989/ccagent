import { mkdtemp, mkdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from 'node:fs';
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { startAccountFixture } from "./helpers/accountFixture.js";
import { officialUiHandler } from "./helpers/officialUiFixture.js";
import { accountHome } from "../platform/account.js";
const require = createRequire(import.meta.url);
const { freePort } = require("../../desktop/runtime.cjs");
const root = await realpath(os.tmpdir()), directory = await mkdtemp(path.join(root, "ccagent-electron-ui-"));
const base = path.join(directory, "home"), workspace = path.join(directory, "workspace"), stopFile = path.join(directory, "stop-fixture"), restartFile = path.join(directory, "restart-fixture");
const priceChangeFile = path.join(directory, 'change-fallback-price');
await mkdir(workspace);
const fixtureKey = "ccagent_" + randomBytes(32).toString("base64url");
const fixture = await startAccountFixture(base, { handleService: officialUiHandler(fixtureKey, { fallback: process.argv.includes('--fallback'), priceRevision: () => existsSync(priceChangeFile) ? 2 : 1 }) });
for (const user of fixture.users) {
  const home = accountHome(base, user.id); await mkdir(home, { recursive: true });
  await writeFile(path.join(home, "settings.json"), JSON.stringify({ model: "fixture", models: { fixture: { protocol: "openai-chat", model: "fixture", baseURL: "https://example.invalid/v1", apiKey: "fixture-not-used" } } }));
}
const env = { ...process.env, CCAGENT_HOME: base, CCAGENT_PLATFORM_HOME: base, CCAGENT_CLOUD_URL: fixture.origin, CCAGENT_DESKTOP_USER_DATA: path.join(directory, "electron"), CCAGENT_DESKTOP_WORKSPACE: workspace };
for (const name of ["CCAGENT_ACCOUNT_ID", "CCAGENT_AUTH_SESSION_FILE", "CCAGENT_DESKTOP_TOKEN", "NODE_TLS_REJECT_UNAUTHORIZED", "ELECTRON_RUN_AS_NODE", "NODE_OPTIONS"]) delete (env as NodeJS.ProcessEnv)[name];
const cdpPort = await freePort(), inspectPort = await freePort();
let child: ChildProcess, stopping = false;
async function inspector(expression: string) {
  const targets = await (await fetch(`http://127.0.0.1:${inspectPort}/json/list`)).json() as { webSocketDebuggerUrl: string }[];
  const socket = new WebSocket(targets[0]!.webSocketDebuggerUrl);
  return new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => { socket.close(); reject(new Error("INSPECTOR_TIMEOUT")); }, 5000);
    socket.addEventListener("open", () => socket.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, returnByValue: true } })));
    socket.addEventListener("message", event => { const value = JSON.parse(String(event.data)); if (value.id === 1) { clearTimeout(timer); socket.close(); resolve(value.result); } });
    socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("INSPECTOR_UNAVAILABLE")); });
    socket.addEventListener("close", () => { clearTimeout(timer); resolve(undefined); });
  });
}
async function launch() {
  child = spawn(require("electron"), [path.resolve("desktop/main.cjs"), `--remote-debugging-port=${cdpPort}`, "--remote-debugging-address=127.0.0.1", `--inspect=127.0.0.1:${inspectPort}`], { env, cwd: process.cwd(), windowsHide: true, stdio: ["ignore", "ignore", "ignore"] });
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error("ELECTRON_EXITED");
    try { if ((await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).ok) return; } catch { /* Owned process is starting. */ }
    await delay(200);
  }
  throw new Error("ELECTRON_CDP_NOT_READY");
}
async function closeElectron() {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
  await inspector("process.getBuiltinModule('module').createRequire(process.cwd() + '/package.json')('electron').app.quit()");
  await Promise.race([exited, delay(12000).then(() => { throw new Error("ELECTRON_DID_NOT_EXIT"); })]);
}
async function stop() {
  if (stopping) return; stopping = true;
  await closeElectron(); await fixture.close();
  if (path.dirname(directory) !== root || !path.basename(directory).startsWith("ccagent-electron-ui-")) throw new Error("UNSAFE_FIXTURE_CLEANUP");
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  console.log("Desktop UI fixture stopped and cleaned."); process.exit(0);
}
await launch();
console.log(JSON.stringify({ cdp: `http://127.0.0.1:${cdpPort}`, email: fixture.users[0]!.email, ordinaryEmail: fixture.users[1]!.email, fixtureKey, testPassword: fixture.password, stopFile, restartFile, stateFile: path.join(directory, "electron", "desktop-state.json"), fixtureOnly: true, ...(process.argv.includes('--fallback') ? { priceChangeFile } : {}) }));
setInterval(() => { if (!stopping) void stat(stopFile).then(() => stop(), () => {}); }, 500).unref();
let restarting = false;
setInterval(() => { if (stopping || restarting) return; void stat(restartFile).then(async () => { restarting = true; await closeElectron(); await rm(restartFile); await launch(); restarting = false; console.log("Desktop UI fixture restarted."); }, () => {}); }, 500).unref();
process.on("SIGINT", () => { void stop(); }); process.on("SIGTERM", () => { void stop(); });
setTimeout(() => { void stop(); }, 30 * 60_000).unref();
