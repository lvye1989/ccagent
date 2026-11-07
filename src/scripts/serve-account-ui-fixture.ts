import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from 'node:fs';
import { startAccountFixture } from "./helpers/accountFixture.js";
import { accountHome } from "../platform/account.js";
import { officialUiHandler } from "./helpers/officialUiFixture.js";
import { createLegacyFixture } from "./helpers/legacyFixture.js";

const directory = await mkdtemp(path.join(os.tmpdir(), "ccagent-login-ui-"));
const stopFile = path.join(directory, "stop-fixture");
const priceChangeFile = path.join(directory, 'change-fallback-price');
const base = path.join(directory, "home"), workspace = path.join(directory, "workspace");
await mkdir(workspace);
if (process.argv.includes("--legacy")) await createLegacyFixture(base, workspace, path.join(directory, "external", "provider.env"));
const fallback = process.argv.includes('--fallback'), official = process.argv.includes("--official") || fallback, fixtureKey = "ccagent_" + randomBytes(32).toString("base64url");
const fixture = await startAccountFixture(base, { ...(official ? { handleService: officialUiHandler(fixtureKey, { fallback, priceRevision: () => existsSync(priceChangeFile) ? 2 : 1 }) } : {}) });
for (const user of fixture.users) {
  const home = accountHome(base, user.id); await mkdir(home, { recursive: true });
  await writeFile(path.join(home, "settings.json"), JSON.stringify({ model: "fixture", models: { fixture: { protocol: "openai-chat", model: "fixture", baseURL: "https://example.invalid/v1", apiKey: "fixture-not-used" } } }));
}
const port = await new Promise<number>((resolve, reject) => { const probe = net.createServer(); probe.once("error", reject); probe.listen(0, "127.0.0.1", () => { const address = probe.address(); probe.close(() => address && typeof address !== "string" ? resolve(address.port) : reject(new Error("port"))); }); });
const env: NodeJS.ProcessEnv = { ...process.env, CCAGENT_HOME: base, CCAGENT_PLATFORM_HOME: base, CCAGENT_CLOUD_URL: fixture.origin };
for (const name of ["CCAGENT_ACCOUNT_ID", "CCAGENT_AUTH_SESSION_FILE", "CCAGENT_DESKTOP_TOKEN", "NODE_TLS_REJECT_UNAUTHORIZED"]) delete env[name];
const child = spawn(process.execPath, [path.resolve(import.meta.dirname, "../../dist/ccagent.js"), "web", "--workspace", workspace, "--port", String(port)], { env, cwd: workspace, windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"] });
child.stdout?.resume(); child.stderr?.resume();
let stopping = false;
async function stop() {
  if (stopping) return; stopping = true;
  if (child.exitCode === null && child.signalCode === null) { const closed = new Promise<void>(resolve => child.once("exit", () => resolve())); child.send("ccagent:shutdown", () => {}); const timeout = setTimeout(() => child.kill(), 6000); await closed; clearTimeout(timeout); }
  await fixture.close();
  if (path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith("ccagent-login-ui-")) throw new Error("Unsafe fixture cleanup");
  await rm(directory, { recursive: true, force: true });
  process.exit(0);
}
process.stdin.setEncoding("utf8"); process.stdin.on("data", value => { if (String(value).trim() === "stop") void stop(); });
process.once("SIGINT", () => { void stop(); }); process.once("SIGTERM", () => { void stop(); });
setTimeout(() => { void stop(); }, 15 * 60_000).unref();
setInterval(() => { void stat(stopFile).then(() => stop(), () => {}); }, 500).unref();
console.log(JSON.stringify({ origin: `http://127.0.0.1:${port}`, email: fixture.users[0]!.email, ...(official ? { ordinaryEmail: fixture.users[1]!.email, fixtureKey } : {}), testPassword: fixture.password, stopFile, fixtureOnly: true, ...(process.argv.includes('--fallback') ? { priceChangeFile } : {}), ...(process.argv.includes("--legacy") ? { legacySource: base } : {}) }));
