/** Real login -> source Web worker -> official image gateway, isolated loopback only. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { accountHome } from "../platform/account.js";
import { SecureCredentialStore } from "../platform/secureStore.js";
import { startAccountFixture } from "./helpers/accountFixture.js";

const repository = path.resolve(import.meta.dirname, "../.."), parent = await fs.realpath(os.tmpdir());
const temporary = await fs.realpath(await fs.mkdtemp(path.join(parent, "ccagent-design-http-"))), workspace = path.join(temporary, "workspace"), base = path.join(temporary, "profile");
await fs.mkdir(workspace);
const image = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aFe0AAAAASUVORK5CYII=", png = Buffer.from(image.split(",")[1]!, "base64");
const key = "ccagent_" + randomBytes(32).toString("base64url"), fresh = randomUUID();
let published = true, creates = 0, uploads = 0, hold = false;
const files = new Map<string, { owner: string; bytes: Buffer; ready: boolean; token: string }>(), tasks = new Map<string, { owner: string; input: any; file: string }>();
const routes = ["text-to-image", "image-to-image"].map(mode => ({ id: `fixture-${mode}`, name: mode, service: "image", protocol: "kie-images", upstreamModel: `gpt-image-2-5-sunburst-${mode}`,
  pricing: { currency: "CNY", definition: { rates: ["1k", "2k", "4k"].map(resolution => ({ metric: `output_images_${resolution}`, price: "0.2", unitQuantity: "1" })), tariff: { kind: "constant" } }, markup: "1.3", version: 1, sourceUrl: "https://kie.ai/gpt-image-2-5", fingerprint: "1".repeat(64) }, limits: { contextWindow: 20000, maxOutputTokens: 1, maxImages: 16 } }));
let account: Awaited<ReturnType<typeof startAccountFixture>>;
account = await startAccountFixture(base, { handleService: async (req, res, user) => {
  const url = new URL(req.url!, account.origin), reply = (status: number, value: unknown) => { res.writeHead(status); res.end(JSON.stringify(value)); return true; };
  const bytes = async () => { const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk)); return Buffer.concat(chunks); };
  if (req.method === "PUT" && url.pathname.startsWith("/ccagent/users/")) {
    const id = path.posix.basename(url.pathname, ".png"), file = files.get(id); assert(file && file.token === url.searchParams.get("token")); assert(!req.headers.authorization && !req.headers.cookie);
    file.bytes = await bytes(); uploads++; return reply(200, {});
  }
  if (!user) return reply(401, {});
  if (url.pathname === "/v1/models") { assert.equal(req.headers.authorization, `Bearer ${key}`); return reply(200, { data: published ? routes : [], defaults: { image: published ? "fixture-image-to-image" : null } }); }
  if (url.pathname === "/api/files" && req.method === "POST") {
    const input = JSON.parse((await bytes()).toString()); assert.equal(input.purpose, "image"); assert.equal(input.contentType, "image/png");
    const id = randomUUID(), token = randomUUID(), prefix = createHash("sha256").update(user.id).digest("hex").slice(0, 32); files.set(id, { owner: user.id, token, bytes: Buffer.alloc(0), ready: false });
    return reply(201, { id, upload: { url: `${account.origin}/ccagent/users/${prefix}/image/${id}.png?token=${token}`, method: "PUT", validUntil: Date.now() + 60000, headers: { "content-type": "image/png", "x-content-type": "image/png" } } });
  }
  if (url.pathname.startsWith("/api/files/")) {
    const id = url.pathname.split("/").at(-1)!, file = files.get(id); if (!file || file.owner !== user.id) return reply(404, {});
    if (req.method === "POST") { file.ready = true; return reply(200, {}); }
    res.writeHead(200, { "content-type": "image/png" }); res.end(file.bytes); return true;
  }
  if (url.pathname === "/v1/images/tasks" && req.method === "POST") {
    assert.equal(req.headers.authorization, `Bearer ${key}`); const input = JSON.parse((await bytes()).toString()), id = String(req.headers["idempotency-key"]); assert(!tasks.has(id));
    for (const reference of input.input_images ?? []) { const file = files.get(reference.replace("ccagent-file:", "")); assert(file?.owner === user.id && file.ready && file.bytes.equals(png)); }
    const file = randomUUID(); files.set(file, { owner: user.id, bytes: png, ready: true, token: "" }); tasks.set(id, { owner: user.id, input, file }); creates++;
    return reply(202, { id, call_id: id, status: "queued", poll_after_ms: 500, images: [] });
  }
  if (url.pathname.startsWith("/v1/images/tasks/")) {
    const id = url.pathname.split("/").at(-1)!, task = tasks.get(id); if (!task || task.owner !== user.id) return reply(404, {});
    return reply(200, { id, call_id: id, status: hold ? "processing" : "succeeded", poll_after_ms: 500, images: hold ? [] : [{ file_id: task.file, mime_type: "image/png", expires_at: new Date(Date.now() + 60000).toISOString() }] });
  }
  return false;
} });
for (const user of account.users) {
  const home = accountHome(base, user.id); await fs.mkdir(home, { recursive: true });
  await fs.writeFile(path.join(home, "settings.json"), JSON.stringify({ defaultModel: "fixture", models: { fixture: { protocol: "openai-chat", model: "fixture", baseURL: account.origin + "/v1", apiKey: "unused-fixture-chat-key" } }, whiteboardDesignImage: { provider: "openai", model: "legacy", baseURL: "https://must-not-call.invalid", apiKey: "ignored-legacy-key" }, mcpServers: {}, disableAllHooks: true }));
  if (user !== account.users[0]) continue;
  await fs.mkdir(path.join(home, "platform"), { recursive: true });
  await fs.writeFile(path.join(home, "platform", "services.json"), JSON.stringify({ version: 1, revision: fresh, userId: user.id, origin: account.origin, roles: {}, routes: [], auxiliaryEnabled: false, fallbackEnabled: false, updatedAt: new Date().toISOString() }));
  await new SecureCredentialStore(path.join(home, "platform", "service-key.json")).write({ revision: fresh, userId: user.id, origin: account.origin, apiKey: key });
}
const noEnv = path.join(temporary, "empty.env"); await fs.writeFile(noEnv, "");
const probe = createServer(); await new Promise<void>(resolve => probe.listen(0, "127.0.0.1", resolve)); const address = probe.address(); assert(address && typeof address !== "string"); const port = address.port; await new Promise<void>(resolve => probe.close(() => resolve()));
const origin = `http://127.0.0.1:${port}`, environment = { ...process.env, CCAGENT_HOME: base, CCAGENT_PLATFORM_HOME: base, CCAGENT_ENV_FILE: noEnv, IMAGE_EDIT_PROVIDER: "openai", IMAGE_EDIT_BASE_URL: "https://must-not-call.invalid", IMAGE_EDIT_API_KEY: "ignored-env-key" };
for (const name of ["CCAGENT_ACCOUNT_ID", "CCAGENT_AUTH_SESSION_FILE", "CCAGENT_DESKTOP_TOKEN", "CCAGENT_WEB_WORKER_TOKEN", "CCAGENT_DESKTOP_APP", "NODE_TLS_REJECT_UNAUTHORIZED"]) delete environment[name as keyof typeof environment];
const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), path.join(repository, "src/entrypoint/cli.ts"), "web", "--workspace", workspace, "--port", String(port)], { cwd: temporary, env: environment, windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"] });
let logs = ""; child.stdout!.on("data", bytes => { logs = (logs + bytes).slice(-8000); }); child.stderr!.on("data", bytes => { logs = (logs + bytes).slice(-8000); });
const pause = (ms = 40) => new Promise(resolve => setTimeout(resolve, ms));
async function request(route: string, cookie = "", body?: Record<string, unknown>, method = body ? "POST" : "GET") { return fetch(origin + route, { method, headers: { ...(cookie ? { cookie } : {}), ...(body ? { origin, "x-ccagent-web": "1", "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20000) }); }
async function json(response: Response, status = 200): Promise<any> { assert.equal(response.status, status, await response.clone().text()); return response.json(); }
const query = (action: string, fields: Record<string, string> = {}) => `/api/whiteboards/design/${action}?` + new URLSearchParams({ workspace, ...fields });
async function login(index: number) { const response = await request("/api/account/login", "", { email: account.users[index]!.email, password: account.password }); await json(response); return response.headers.get("set-cookie")!.split(";")[0]!; }
async function finished(id: string, cookie: string) { for (let index = 0; index < 100; index++) { const run = await json(await request(query("run", { runId: id }), cookie)); if (run.status !== "running") return run; await pause(); } throw new Error("Fixture image did not finish"); }
try {
  let ready = false; for (let i = 0; i < 150; i++) { if (child.exitCode !== null) throw new Error(logs); try { if ((await fetch(origin + "/api/health", { signal: AbortSignal.timeout(500) })).ok) { ready = true; break; } } catch {} await pause(100); } assert(ready, logs);
  const cookie = await login(0); assert.equal((await request(query("config"))).status, 401);
  const config = await json(await request(query("config"), cookie)); assert.equal(config.config.provider, "official"); assert.equal(config.config.model, "fixture-image-to-image"); assert.equal(config.config.configured, true);
  assert.equal((await request("/api/whiteboards/design/config", cookie, { workspace, provider: "openai", apiKey: "ignored-user-key" })).status, 405);
  const created = await json(await request("/api/whiteboards/create", cookie, { workspace, name: "Automatic gateway fixture" }), 201), id = created.board.id;
  const input = { workspace, id, revision: 1, canvasVersion: 0, baseImageId: "", kind: "architecture", prompt: "Draw a building", requestId: randomUUID() };
  assert.equal((await request("/api/whiteboards/design/start", cookie, { ...input, model: "forbidden-user-selection" })).status, 400);
  const text = await json(await request("/api/whiteboards/design/start", cookie, input), 202); const result = await finished(text.runId, cookie); assert.equal(result.status, "completed"); assert.equal(result.model, "fixture-text-to-image"); assert.equal(result.images[0].dataURL, image); assert.equal(creates, 1);
  assert.equal((await json(await request("/api/whiteboards/design/start", cookie, input), 202)).runId, text.runId); assert.equal(creates, 1);
  const asset = await json(await request("/api/whiteboards/design/assets", cookie, { workspace, image: { dataURL: image } }), 201);
  const refInput = { ...input, requestId: randomUUID(), assetIds: [asset.assetId] }, ref = await json(await request("/api/whiteboards/design/start", cookie, refInput), 202);
  assert.equal((await finished(ref.runId, cookie)).status, "completed"); assert.equal(tasks.get(refInput.requestId)!.input.model, "fixture-image-to-image"); assert.equal(tasks.get(refInput.requestId)!.input.input_images.length, 1); assert.equal(uploads, 1);
  published = false; assert.equal((await json(await request(query("config"), cookie))).config.configured, false); assert.equal((await request("/api/whiteboards/design/start", cookie, { ...input, requestId: randomUUID() })).status, 503); assert.equal(creates, 2); published = true;
  hold = true; const slowInput = { ...input, requestId: randomUUID() }, slow = await json(await request("/api/whiteboards/design/start", cookie, slowInput), 202); while (!tasks.has(slowInput.requestId)) await pause();
  assert.equal((await json(await request("/api/whiteboards/design/stop", cookie, { workspace, runId: slow.runId }))).status, "stopped"); await pause(80); hold = false;
  const resumed = await json(await request("/api/whiteboards/design/resume", cookie, { workspace, runId: slow.runId }), 202); assert.equal((await finished(resumed.runId, cookie)).status, "completed"); assert.equal(creates, 3);
  const other = await login(1); assert.equal((await request(query("config"), other)).status, 503); assert.equal((await request(query("run", { runId: text.runId }), other)).status, 404);
  assert.equal((await request("/api/whiteboards/design/assets", cookie, { workspace, image: { dataURL: "file:///private.png" } })).status, 400);
  console.log("Whiteboard gateway HTTP passed: actual account workers, managed-only config, legacy/env ignored, automatic no-base and reference modes, live admin catalog, no model fields, owned private uploads, single submission, stop/resume and account isolation. No external calls.");
} finally {
  if (child.exitCode === null && child.signalCode === null) { const exited = new Promise<void>(resolve => child.once("close", () => resolve())); if (child.connected) child.send("ccagent:shutdown", () => {}); const deadline = setTimeout(() => { if (process.platform === "win32" && child.pid) { try { execFileSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); } catch { child.kill(); } } else child.kill(); }, 5000); await exited; clearTimeout(deadline); }
  await account.close(); assert(path.dirname(temporary) === parent && path.basename(temporary).startsWith("ccagent-design-http-")); await fs.rm(temporary, { recursive: true, force: true });
}
