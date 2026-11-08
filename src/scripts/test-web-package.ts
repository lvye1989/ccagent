import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import * as XLSX from "xlsx";
import { startAccountFixture } from "./helpers/accountFixture.js";
import { accountHome } from "../platform/account.js";

const root = path.resolve(import.meta.dirname, "../.."), output = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "ccagent-data-package-")));
const runtime = path.join(output, "smoke-runtime"), unpack = path.join(runtime, "unpacked"), platformBase = path.join(runtime, "home"), workspace = path.join(runtime, "可写的 工作文件夹");
const accountFixture = await startAccountFixture(platformBase);
await accountFixture.nativeClient.signIn(accountFixture.users[0]!.email, accountFixture.password);
const home = accountHome(platformBase, accountFixture.users[0]!.id);
for (const folder of [unpack, home, workspace]) await fs.mkdir(folder, { recursive: true });
let server: ChildProcess | undefined, datasetId = "", sawEvidence = false, logs = "";
const mock = createServer(async (req, res) => {
  let text = ""; for await (const b of req) text += b; const body = JSON.parse(text);
  const evidence = body.messages.findLast((m: any) => m.role === "tool");
  const choice = evidence ? (() => { const parsed = JSON.parse(evidence.content); assert.equal(parsed.primary.sum, 33); sawEvidence = true; return { delta: { content: "PACKED_CLI_ANALYZED_33" }, finish_reason: "stop" }; })() : { delta: { tool_calls: [{ index: 0, id: "packed-call", type: "function", function: { name: "AnalyzeData", arguments: JSON.stringify({ dataset_id: datasetId }) } }] }, finish_reason: "tool_calls" };
  res.writeHead(200, { "content-type": "text/event-stream" }); res.end(`data: ${JSON.stringify({ choices: [{ index: 0, ...choice }] })}\n\ndata: [DONE]\n\n`);
});
await new Promise<void>((r) => mock.listen(0, "127.0.0.1", r)); const mockPort = (mock.address() as { port: number }).port;
const emptyEnv = path.join(home, "empty.env"); await fs.writeFile(emptyEnv, "");
await fs.writeFile(path.join(home, "settings.json"), JSON.stringify({ model: "fixture", defaultModel: "fixture", models: { fixture: { protocol: "openai-chat", model: "fixture", baseURL: `http://127.0.0.1:${mockPort}/v1`, apiKey: "${PACK_FIXTURE_KEY}" } }, agentTeams: false }));
const desktopToken = "c".repeat(64);
const env: NodeJS.ProcessEnv = { ...process.env, CCAGENT_HOME: platformBase, CCAGENT_PLATFORM_HOME: platformBase, CCAGENT_ENV_FILE: emptyEnv, CCAGENT_DESKTOP_TOKEN: desktopToken, PACK_FIXTURE_KEY: "fixture-package-key", CCAGENT_DISABLE_STREAM_LOG: "1" };
delete env.CCAGENT_ACCOUNT_ID; delete env.CCAGENT_AUTH_SESSION_FILE;
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const authorizedFetch: typeof fetch = (input, options) => { const headers = new Headers(options?.headers); headers.set("x-ccagent-desktop-token", desktopToken); return globalThis.fetch(input, { ...options, headers }); };
async function stopServer() {
  if (!server || server.exitCode !== null || server.signalCode !== null) return;
  const closed = new Promise<void>(resolve => server!.once("close", () => resolve()));
  server.send?.("ccagent:shutdown", () => {}); const timeout = setTimeout(() => server?.kill(), 6000); await closed; clearTimeout(timeout);
}
async function checkPackagedApps(origin: string) {
  for (const asset of ["/app-catalog.js", "/app-icons.js", "/promotion.js", "/promotion.css"]) {
    const response = await authorizedFetch(origin + asset);
    assert.equal(response.status, 200, asset);
    assert.match(response.headers.get("content-type") ?? "", asset.endsWith(".css") ? /text\/css/ : /(?:text|application)\/javascript/, asset);
    assert.ok((await response.text()).length > 0, asset);
  }
  const response = await authorizedFetch(origin + "/api/apps");
  assert.equal(response.status, 200, "The packaged app catalog works without node_modules");
  const catalog = await response.json() as { apps: Array<{ id: string; installed: boolean }> };
  for (const id of ["photoshop", "comfyui", "sketchup"]) assert.ok(catalog.apps.some(app => app.id === id && !app.installed), id);
}
try {
  const npmCli = process.env.npm_execpath || path.join(path.dirname(process.execPath), "node_modules/npm/bin/npm-cli.js");
  const packed = JSON.parse(execFileSync(process.execPath, [npmCli, "pack", "--ignore-scripts", "--json", "--pack-destination", output], { cwd: root, encoding: "utf8" }))[0];
  assert(packed.files.some((f: any) => f.path === "dist/charts.js")); for (const f of packed.files) assert(f.path === ".env.example" || !/(^|\/)(?:\.env(?:\.|$)|\.ccagent\/|node_modules\/|deliverables\/)/.test(f.path), "Private/generated source must not enter the package: " + f.path);
  const tarball = path.join(output, packed.filename); execFileSync("tar", ["-xf", tarball, "-C", unpack]);
  const entry = path.join(unpack, "package/dist/ccagent.js"); assert.equal(await fs.stat(path.join(unpack, "package/node_modules")).then(() => true, () => false), false);
  const reserve = createServer(); await new Promise<void>((r) => reserve.listen(0, "127.0.0.1", r)); const port = (reserve.address() as { port: number }).port; await new Promise<void>((r) => reserve.close(() => r())); const base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, [entry, "web", "--workspace", workspace, "--port", String(port)], { cwd: workspace, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"] }); server.stdout!.on("data", (b) => { logs += b; }); server.stderr!.on("data", (b) => { logs += b; });
  let ready = false; for (let n = 0; n < 100; n++) { try { ready = (await authorizedFetch(base + "/api/health")).ok; if (ready) break; } catch {} if (server.exitCode !== null) throw new Error(logs); await delay(50); } assert(ready, "Packed server starts without node_modules");
  for (const file of ["/charts.js", "/visualization.js", "/visualization-model.js", "/visualization.css", "/whiteboard.js", "/whiteboard.css", "/whiteboard-ai.js", "/whiteboard-ai.css", "/whiteboard-editor.html", "/whiteboard-editor-shell.css", "/whiteboard-assets/whiteboard-editor.js", "/whiteboard-assets/whiteboard-editor.css", "/whiteboard-assets/licenses/Excalidraw.txt", "/whiteboard-assets/licenses/Excalidraw-fonts.txt"]) assert.equal((await authorizedFetch(base + file)).status, 200, file);
  await checkPackagedApps(base);
  assert.match(await (await authorizedFetch(base + "/")).text(), /data-view="visualization"/);
  async function post(action: string, body: object) { const response = await authorizedFetch(base + action, { method: "POST", headers: { "content-type": "application/json", "x-ccagent-web": "1" }, body: JSON.stringify({ workspace, ...body }) }); const result = await response.json() as any; assert(response.ok, JSON.stringify(result)); return result; }
  const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([["项目", "区域", "投资"], ["甲", "华东", 11], ["乙", "华南", 22]]), "明细"); const bytes = XLSX.write(book, { type: "buffer", bookType: "xlsx" }) as Buffer;
  const uploaded = await post("/api/files/upload", { name: "安装包 验证.xlsx", base64: bytes.toString("base64") }); const imported = await post("/api/visualization/import", { path: uploaded.path }); datasetId = imported.dataset.id;
  const result = await post("/api/visualization/query", { id: datasetId }); assert.equal(result.analysis.primary.sum, 33); assert.equal(result.analysis.filteredRows, 2);
  const cli = spawn(process.execPath, [entry, "--permission-mode", "plan", "--output-format", "json", "-p", "Analyze the uploaded dataset"], { cwd: workspace, env, windowsHide: true, timeout: 20_000, stdio: ["ignore", "pipe", "pipe"] }); let stdout = "", stderr = ""; cli.stdout!.setEncoding("utf8").on("data", (b) => { stdout += b; }); cli.stderr!.setEncoding("utf8").on("data", (b) => { stderr += b; });
  await new Promise<void>((resolve, reject) => { cli.once("error", reject); cli.once("close", (code) => code === 0 ? resolve() : reject(new Error(stderr))); }); assert.equal(JSON.parse(stdout).result, "PACKED_CLI_ANALYZED_33"); assert(sawEvidence);
  await stopServer();
  server = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), path.join(root, "src/entrypoint/cli.ts"), "web", "--workspace", workspace, "--port", String(port)], { cwd: workspace, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"] }); server.stdout!.on("data", (b) => { logs += b; }); server.stderr!.on("data", (b) => { logs += b; });
  let sourceReady = false; for (let n = 0; n < 100; n++) { try { sourceReady = (await authorizedFetch(base + "/api/health")).ok; if (sourceReady) break; } catch {} if (server.exitCode !== null) throw new Error(logs); await delay(50); } assert(sourceReady, "Source-mode Web starts from a different working folder");
  assert.equal((await authorizedFetch(base + "/charts.js")).status, 200, "Source-mode entrypoint resolves built browser charts"); assert.equal((await post("/api/visualization/query", { id: datasetId })).analysis.primary.sum, 33);
  assert.equal((await authorizedFetch(base + "/whiteboard-assets/whiteboard-editor.js")).status, 200, "Source-mode entrypoint resolves the bundled Excalidraw editor");
  await checkPackagedApps(base);
  console.log(`Packed/source Web/CLI: no node_modules in package, chart/app catalog/promotion assets and real app API in both entrypoints, real XLSX upload/statistics and shared CLI dataset evidence passed. Tarball: ${tarball}`);
} finally {
  await stopServer(); await accountFixture.close();
  mock.closeAllConnections(); await new Promise<void>((r) => mock.close(() => r()));
  const relative = path.relative(output, await fs.realpath(runtime)); if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Unsafe package-test cleanup"); await fs.rm(runtime, { recursive: true, force: true });
}
