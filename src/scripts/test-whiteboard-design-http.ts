/** Actual login -> account worker -> image-edit HTTP transport, using only isolated loopback fixtures. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { deflateSync } from "node:zlib";
import { accountHome } from "../platform/account.js";
import { startAccountFixture } from "./helpers/accountFixture.js";

const repository = path.resolve(import.meta.dirname, "../.."), parent = await fs.realpath(os.tmpdir());
const temporary = await fs.realpath(await fs.mkdtemp(path.join(parent, "ccagent-design-http-")));
const workspace = path.join(temporary, "workspace"), otherWorkspace = path.join(temporary, "other-workspace"), base = path.join(temporary, "profile");
await Promise.all([fs.mkdir(workspace), fs.mkdir(otherWorkspace)]);
const account = await startAccountFixture(base);
const pause = (ms = 60) => new Promise(resolve => setTimeout(resolve, ms));
const key = "fixture-image-edit-secret-not-for-a-real-service";
function crc32(bytes: Buffer): number { let value = 0xffffffff; for (const byte of bytes) { value ^= byte; for (let index = 0; index < 8; index++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0); } return (value ^ 0xffffffff) >>> 0; }
function png(red: number): Buffer {
  const chunk = (type: string, data: Buffer) => { const size = Buffer.alloc(4), checksum = Buffer.alloc(4), name = Buffer.from(type); size.writeUInt32BE(data.length); checksum.writeUInt32BE(crc32(Buffer.concat([name, data]))); return Buffer.concat([size, name, data, checksum]); };
  const header = Buffer.alloc(13); header.writeUInt32BE(64); header.writeUInt32BE(48, 4); header[8] = 8; header[9] = 2;
  const pixels = Buffer.alloc((64 * 3 + 1) * 48); for (let y = 0; y < 48; y++) for (let x = 0; x < 64; x++) { const offset = y * (64 * 3 + 1) + 1 + x * 3; pixels[offset] = red; pixels[offset + 1] = 96; pixels[offset + 2] = 128; }
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk("IHDR", header), chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))]);
}
const original = png(20), annotation = png(230), reference = png(90), unrelated = png(150), result = png(65);
const dataURL = (bytes: Buffer) => "data:image/png;base64," + bytes.toString("base64");
type SupplierRequest = { imageCount: number; prompt: string; original: boolean; annotated: boolean; reference: boolean; unrelated: boolean };
const supplierRequests: SupplierRequest[] = [], supplierErrors: string[] = [];
let held = 0;
const supplier = createServer(async (req, res) => {
  try {
    assert.equal(req.url, "/v1/images/edits"); assert.equal(req.method, "POST"); assert.equal(req.headers.authorization, "Bearer " + key);
    assert.ok(req.headers["content-type"]?.startsWith("multipart/form-data; boundary="));
    const chunks: Buffer[] = []; let size = 0;
    for await (const value of req) { const bytes = Buffer.from(value); size += bytes.length; assert.ok(size < 1024 * 1024); chunks.push(bytes); }
    const bytes = Buffer.concat(chunks), text = bytes.toString("latin1");
    const record: SupplierRequest = { imageCount: [...text.matchAll(/name="image\[\]"; filename=/g)].length,
      prompt: text, original: bytes.includes(original), annotated: bytes.includes(annotation), reference: bytes.includes(reference), unrelated: bytes.includes(unrelated) };
    supplierRequests.push(record);
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    if (text.includes("HOLD_DESIGN_HTTP")) {
      held++; res.flushHeaders(); const pulse = setInterval(() => res.write(" "), 100);
      res.on("close", () => { held--; clearInterval(pulse); }); return;
    }
    res.end(JSON.stringify({ data: [{ b64_json: result.toString("base64") }] }));
  } catch (error) { supplierErrors.push(error instanceof Error ? error.message : "supplier fixture error"); if (!res.headersSent) res.writeHead(500); res.end("fixture failed"); }
});
await new Promise<void>(resolve => supplier.listen(0, "127.0.0.1", resolve));
const supplierAddress = supplier.address(); assert.ok(supplierAddress && typeof supplierAddress !== "string");
const supplierBaseURL = `http://127.0.0.1:${supplierAddress.port}/v1`;
for (const user of account.users) {
  const home = accountHome(base, user.id); await fs.mkdir(home, { recursive: true });
  await fs.writeFile(path.join(home, "settings.json"), JSON.stringify({ defaultModel: "image-http-fixture", models: { "image-http-fixture": { protocol: "openai-chat", model: "image-http-fixture", baseURL: supplierBaseURL, apiKey: "fixture-unused-chat-key" } }, mcpServers: {}, disableAllHooks: true }));
}
const emptyEnv = path.join(temporary, "empty.env"); await fs.writeFile(emptyEnv, "");
const probe = createServer(); await new Promise<void>(resolve => probe.listen(0, "127.0.0.1", resolve));
const probeAddress = probe.address(); assert.ok(probeAddress && typeof probeAddress !== "string");
const port = probeAddress.port, origin = `http://127.0.0.1:${port}`; await new Promise<void>(resolve => probe.close(() => resolve()));
const environment: NodeJS.ProcessEnv = { ...process.env, CCAGENT_HOME: base, CCAGENT_PLATFORM_HOME: base, CCAGENT_ENV_FILE: emptyEnv };
for (const name of ["CCAGENT_ACCOUNT_ID", "CCAGENT_AUTH_SESSION_FILE", "CCAGENT_DESKTOP_TOKEN", "CCAGENT_WEB_WORKER_TOKEN", "CCAGENT_DESKTOP_APP", "NODE_TLS_REJECT_UNAUTHORIZED", "IMAGE_EDIT_PROVIDER", "IMAGE_EDIT_MODEL", "IMAGE_EDIT_BASE_URL", "IMAGE_EDIT_API_KEY", "DASHSCOPE_API_KEY", "QWEN_API_KEY"]) delete environment[name];
// Exercise current source; the private worker inherits this exact TS loader.
const child: ChildProcess = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), path.join(repository, "src/entrypoint/cli.ts"), "web", "--workspace", workspace, "--port", String(port)], {
  cwd: temporary, env: environment, windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"],
});
let logs = "", passed = 0;
child.stdout!.on("data", bytes => { logs = (logs + String(bytes)).slice(-8000); }); child.stderr!.on("data", bytes => { logs = (logs + String(bytes)).slice(-8000); });
const test = async (name: string, action: () => Promise<void>) => { await action(); passed++; console.log("PASS " + name); };
async function request(route: string, cookie = "", body?: Record<string, unknown>) {
  return fetch(origin + route, { method: body ? "POST" : "GET", headers: { ...(cookie ? { cookie } : {}), ...(body ? { "content-type": "application/json", "x-ccagent-web": "1", origin } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20_000) });
}
async function login(index: number): Promise<string> { const response = await request("/api/account/login", "", { email: account.users[index]!.email, password: account.password }); assert.equal(response.status, 200, await response.clone().text()); return response.headers.get("set-cookie")!.split(";")[0]!; }
const query = (route: string, extra: Record<string, string> = {}) => route + "?" + new URLSearchParams({ workspace, ...extra });
async function jsonResponse(response: Response, expected = 200): Promise<any> { assert.equal(response.status, expected, await response.clone().text()); return response.json(); }
async function finished(runId: string, cookie: string): Promise<any> {
  for (let index = 0; index < 150; index++) { const value = await jsonResponse(await request(query("/api/whiteboards/design/run", { runId }), cookie)); if (value.status !== "running") return value; await pause(); }
  throw new Error("Isolated design generation did not finish");
}
function image(id: string, role: string, fileId: string, baseImageId?: string) { return { id, type: "image", x: 0, y: 0, width: 64, height: 48, angle: 0, fileId, scale: [1, 1], isDeleted: false, customData: { ccagentDesign: { version: 1, role, width: 64, height: 48, ...(baseImageId ? { baseImageId } : {}) } } }; }
const scene = { type: "excalidraw", version: 2, appState: {}, elements: [image("original-image", "base", "original-file"), image("reference-image", "reference", "reference-file", "original-image"), image("unrelated-reference", "reference", "unrelated-file", "another-base")],
  files: Object.fromEntries([["original-file", original], ["reference-file", reference], ["unrelated-file", unrelated]].map(([id, bytes]) => [id, { id, mimeType: "image/png", created: Date.now(), dataURL: dataURL(bytes as Buffer) }])) };
try {
  let ready = false;
  for (let index = 0; index < 150; index++) { if (child.exitCode !== null) throw new Error(logs); try { if ((await fetch(origin + "/api/health", { signal: AbortSignal.timeout(500) })).ok) { ready = true; break; } } catch { /* Own isolated server starts asynchronously. */ } await pause(100); }
  assert.ok(ready, logs);
  const cookie = await login(0);
  await test("actual authenticated worker serves the three design assets and protects anonymous requests", async () => {
    for (const asset of ["/whiteboard-design.js", "/whiteboard-design-canvas.js", "/whiteboard-design.css"]) { assert.equal((await request(asset)).status, 401); assert.equal((await request(asset, cookie)).status, 200); }
    assert.equal((await request(query("/api/whiteboards/design/config"))).status, 401);
    const blocked = await fetch(origin + "/api/whiteboards/design/config", { method: "POST", headers: { cookie, "content-type": "application/json", origin }, body: JSON.stringify({ workspace, clear: true }) });
    assert.equal(blocked.status, 403);
  });
  await test("personal image configuration persists through HTTP and never returns a credential", async () => {
    const initial = await jsonResponse(await request(query("/api/whiteboards/design/config"), cookie)); assert.equal(initial.config.configured, false);
    const configured = await jsonResponse(await request("/api/whiteboards/design/config", cookie, { workspace, provider: "openai", model: "image-fixture", baseURL: supplierBaseURL, apiKey: key }));
    assert.equal(configured.config.configured, true); assert.equal(configured.config.maxReferences, 2); assert.equal(configured.config.source, "user"); assert.equal(JSON.stringify(configured).includes(key), false);
    const file = await fs.readFile(path.join(accountHome(base, account.users[0]!.id), "settings.json"), "utf8"); assert.equal(file.includes(key), false);
    assert.equal((await request("/api/whiteboards/design/config", cookie, { workspace: otherWorkspace, clear: true })).status, 409);
  });
  await test("temporary full-resolution image uploads are account/workspace bound and accept only validated raster bytes", async () => {
    const accepted = await jsonResponse(await request("/api/whiteboards/design/assets", cookie, { workspace, image: { dataURL: dataURL(original), mimeType: "image/png" } }), 201);
    assert.match(accepted.assetId, /^[a-f0-9-]{36}$/); assert.equal(accepted.dataURL, undefined); assert.equal(accepted.path, undefined);
    assert.equal((await request("/api/whiteboards/design/assets", cookie, { workspace: otherWorkspace, image: { dataURL: dataURL(original) } })).status, 409);
    assert.equal((await request("/api/whiteboards/design/assets", cookie, { workspace, image: { dataURL: "file:///private.png" } })).status, 400);
    const foreign = await login(1);
    const remove = (who: string) => fetch(origin + "/api/whiteboards/design/assets", { method: "DELETE", headers: { cookie: who, origin, "x-ccagent-web": "1", "content-type": "application/json" }, body: JSON.stringify({ workspace, assetId: accepted.assetId }) });
    assert.equal((await remove(foreign)).status, 404); assert.equal((await remove(cookie)).status, 200);
  });
  const created = await jsonResponse(await request("/api/whiteboards/create", cookie, { workspace, name: "建筑与城市设计 HTTP 验收", scene }), 201), id = created.board.id;
  const start = { workspace, id, revision: 1, kind: "architecture", prompt: "增加公共建筑入口并保留现有道路", baseImageId: "original-image", canvasVersion: 10, annotated: { dataURL: dataURL(annotation), mimeType: "image/png", width: 64, height: 48 }, requestId: randomUUID() };
  await test("version, base/reference, unsupported-field and workspace guards reject before provider dispatch", async () => {
    assert.equal((await request("/api/whiteboards/design/start", "", start)).status, 401);
    assert.equal((await request("/api/whiteboards/design/start", cookie, { ...start, revision: 99 })).status, 409);
    assert.equal((await request("/api/whiteboards/design/start", cookie, { ...start, baseImageId: "reference-image" })).status, 409);
    assert.equal((await request("/api/whiteboards/design/start", cookie, { ...start, workspace: otherWorkspace })).status, 409);
    assert.equal((await request("/api/whiteboards/design/start", cookie, { ...start, apiKey: "renderer-key-must-not-select-credentials" })).status, 400);
    const unsupported = await jsonResponse(await request("/api/whiteboards/design/unknown", cookie, { workspace }), 404); assert.equal(unsupported.error, "Unknown design action");
    assert.equal(supplierRequests.length, 0);
  });
  let runId = "";
  await test("real image-edit multipart contains original, annotation and only the bound reference; lookup recovers a single dispatch", async () => {
    const accepted = await jsonResponse(await request("/api/whiteboards/design/start", cookie, start), 202); runId = accepted.runId;
    const recovered = await jsonResponse(await request(query("/api/whiteboards/design/request", { requestId: start.requestId }), cookie)); assert.equal(recovered.runId, runId);
    const completed = await finished(runId, cookie); assert.equal(completed.status, "completed", JSON.stringify(completed)); assert.equal(completed.images[0]?.dataURL, dataURL(result)); assert.equal(completed.provider, "openai"); assert.equal(completed.model, "image-fixture"); assert.equal(completed.canvasVersion, 10);
    const duplicate = await jsonResponse(await request("/api/whiteboards/design/start", cookie, start), 202); assert.equal(duplicate.runId, runId);
    assert.equal((await request("/api/whiteboards/design/start", cookie, { ...start, prompt: "changed demand" })).status, 409);
    assert.equal(supplierRequests.length, 1); assert.deepEqual(supplierRequests.map(({ prompt: _prompt, ...record }) => record), [{ imageCount: 3, original: true, annotated: true, reference: true, unrelated: false }]);
    const opened = await jsonResponse(await request("/api/whiteboards/open", cookie, { workspace, id })); assert.equal(opened.board.revision, 1); assert.deepEqual(opened.board.scene, scene, "generation drafts must not rewrite a saved/live canvas");
  });
  await test("a second real login cannot read another account's board, run, receipt or image configuration", async () => {
    const cookieB = await login(1);
    assert.equal((await request(query("/api/whiteboards/design/run", { runId }), cookieB)).status, 404);
    assert.equal((await request(query("/api/whiteboards/design/request", { requestId: start.requestId }), cookieB)).status, 404);
    assert.equal((await request("/api/whiteboards/design/stop", cookieB, { workspace, runId })).status, 404);
    assert.equal((await request("/api/whiteboards/open", cookieB, { workspace, id })).status, 404);
    const config = await jsonResponse(await request(query("/api/whiteboards/design/config"), cookieB)); assert.equal(config.config.configured, false); assert.equal(JSON.stringify(config).includes(key), false);
  });
  await test("active generation blocks workspace/config changes; cancellation stops the real provider connection", async () => {
    const accepted = await jsonResponse(await request("/api/whiteboards/design/start", cookie, { ...start, prompt: "HOLD_DESIGN_HTTP", requestId: randomUUID() }), 202);
    for (let index = 0; index < 100 && !held; index++) await pause(); assert.equal(held, 1);
    assert.equal((await request("/api/workspaces/select", cookie, { path: otherWorkspace })).status, 409);
    assert.equal((await request("/api/whiteboards/design/config", cookie, { workspace, clear: true })).status, 409);
    assert.equal((await request("/api/whiteboards/design/start", cookie, { ...start, requestId: randomUUID() })).status, 409);
    const stopped = await jsonResponse(await request("/api/whiteboards/design/stop", cookie, { workspace, runId: accepted.runId })); assert.equal(stopped.status, "stopped"); assert.equal(stopped.images.length, 0);
    assert.equal((await finished(accepted.runId, cookie)).status, "stopped");
    for (let index = 0; index < 100 && held; index++) await pause(); assert.equal(held, 0);
    assert.equal(supplierRequests.length, 2);
  });
  await test("unknown runs and rejected credential edits expose only safe API errors", async () => {
    const missing = await jsonResponse(await request(query("/api/whiteboards/design/run", { runId: randomUUID() }), cookie), 404); assert.equal(missing.code, "not_found");
    const changed = await request("/api/whiteboards/design/config", cookie, { workspace, provider: "openai", model: "image-fixture", baseURL: "https://different.example.invalid/v1" });
    const rejected = await jsonResponse(changed, 400); assert.equal(JSON.stringify(rejected).includes(key), false); assert.equal(JSON.stringify(rejected).includes(homePath()), false);
    function homePath() { return accountHome(base, account.users[0]!.id); }
    const config = await jsonResponse(await request(query("/api/whiteboards/design/config"), cookie)); assert.equal(config.config.configured, true);
    const malformed = await fetch(origin + "/api/whiteboards/design/config", {
      method: "POST", headers: { cookie, "content-type": "application/json", "x-ccagent-web": "1", origin },
      body: `{"workspace":${JSON.stringify(workspace)},"apiKey":${key}}`, signal: AbortSignal.timeout(20_000),
    });
    const malformedError = await jsonResponse(malformed, 400);
    assert.equal(malformedError.error, "Invalid JSON body"); assert.equal(JSON.stringify(malformedError).includes(key), false);
    assert.deepEqual(supplierErrors, []);
  });
  console.log(`Whiteboard design HTTP: ${passed} checks passed with real account workers and loopback multipart; no production model calls.`);
} finally {
  if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise<void>(resolve => child.once("close", () => resolve()));
    if (child.connected) child.send("ccagent:shutdown", () => {});
    const deadline = setTimeout(() => { if (process.platform === "win32" && child.pid) { try { execFileSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); } catch { child.kill(); } } else child.kill(); }, 5000);
    await exited; clearTimeout(deadline);
  }
  supplier.closeAllConnections(); await new Promise<void>(resolve => supplier.close(() => resolve())); await account.close();
  const relative = path.relative(parent, temporary); assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative) && path.basename(temporary).startsWith("ccagent-design-http-"));
  await fs.rm(temporary, { recursive: true, force: true });
}
