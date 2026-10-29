import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import * as XLSX from "xlsx";

const root = path.resolve(import.meta.dirname, "../.."), output = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "ccagent-data-package-")));
const runtime = path.join(output, "smoke-runtime"), unpack = path.join(runtime, "unpacked"), home = path.join(runtime, "home"), workspace = path.join(runtime, "可写的 工作文件夹");
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
const env = { ...process.env, CCAGENT_HOME: home, CCAGENT_ENV_FILE: emptyEnv, PACK_FIXTURE_KEY: "fixture-package-key", CCAGENT_DISABLE_STREAM_LOG: "1" };
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
try {
  const npmCli = process.env.npm_execpath || path.join(path.dirname(process.execPath), "node_modules/npm/bin/npm-cli.js");
  const packed = JSON.parse(execFileSync(process.execPath, [npmCli, "pack", "--ignore-scripts", "--json", "--pack-destination", output], { cwd: root, encoding: "utf8" }))[0];
  assert(packed.files.some((f: any) => f.path === "dist/charts.js")); for (const f of packed.files) assert(f.path === ".env.example" || !/(^|\/)(?:\.env(?:\.|$)|\.ccagent\/|node_modules\/|deliverables\/)/.test(f.path), "Private/generated source must not enter the package: " + f.path);
  const tarball = path.join(output, packed.filename); execFileSync("tar", ["-xf", tarball, "-C", unpack]);
  const entry = path.join(unpack, "package/dist/ccagent.js"); assert.equal(await fs.stat(path.join(unpack, "package/node_modules")).then(() => true, () => false), false);
  const reserve = createServer(); await new Promise<void>((r) => reserve.listen(0, "127.0.0.1", r)); const port = (reserve.address() as { port: number }).port; await new Promise<void>((r) => reserve.close(() => r())); const base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, [entry, "web", "--workspace", workspace, "--port", String(port)], { cwd: workspace, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }); server.stdout!.on("data", (b) => { logs += b; }); server.stderr!.on("data", (b) => { logs += b; });
  let ready = false; for (let n = 0; n < 100; n++) { try { ready = (await fetch(base + "/api/health")).ok; if (ready) break; } catch {} if (server.exitCode !== null) throw new Error(logs); await delay(50); } assert(ready, "Packed server starts without node_modules");
  for (const file of ["/charts.js", "/visualization.js", "/visualization-model.js", "/visualization.css"]) assert.equal((await fetch(base + file)).status, 200, file);
  assert.match(await (await fetch(base + "/")).text(), /data-view="visualization"/);
  async function post(action: string, body: object) { const response = await fetch(base + action, { method: "POST", headers: { "content-type": "application/json", "x-ccagent-web": "1" }, body: JSON.stringify({ workspace, ...body }) }); const result = await response.json() as any; assert(response.ok, JSON.stringify(result)); return result; }
  const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([["项目", "区域", "投资"], ["甲", "华东", 11], ["乙", "华南", 22]]), "明细"); const bytes = XLSX.write(book, { type: "buffer", bookType: "xlsx" }) as Buffer;
  const uploaded = await post("/api/files/upload", { name: "安装包 验证.xlsx", base64: bytes.toString("base64") }); const imported = await post("/api/visualization/import", { path: uploaded.path }); datasetId = imported.dataset.id;
  const result = await post("/api/visualization/query", { id: datasetId }); assert.equal(result.analysis.primary.sum, 33); assert.equal(result.analysis.filteredRows, 2);
  const cli = spawn(process.execPath, [entry, "--permission-mode", "plan", "--output-format", "json", "-p", "Analyze the uploaded dataset"], { cwd: workspace, env, windowsHide: true, timeout: 20_000, stdio: ["ignore", "pipe", "pipe"] }); let stdout = "", stderr = ""; cli.stdout!.setEncoding("utf8").on("data", (b) => { stdout += b; }); cli.stderr!.setEncoding("utf8").on("data", (b) => { stderr += b; });
  await new Promise<void>((resolve, reject) => { cli.once("error", reject); cli.once("close", (code) => code === 0 ? resolve() : reject(new Error(stderr))); }); assert.equal(JSON.parse(stdout).result, "PACKED_CLI_ANALYZED_33"); assert(sawEvidence);
  server.kill(); await new Promise<void>((r) => server!.once("close", () => r()));
  server = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), path.join(root, "src/entrypoint/cli.ts"), "web", "--workspace", workspace, "--port", String(port)], { cwd: workspace, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }); server.stdout!.on("data", (b) => { logs += b; }); server.stderr!.on("data", (b) => { logs += b; });
  let sourceReady = false; for (let n = 0; n < 100; n++) { try { sourceReady = (await fetch(base + "/api/health")).ok; if (sourceReady) break; } catch {} if (server.exitCode !== null) throw new Error(logs); await delay(50); } assert(sourceReady, "Source-mode Web starts from a different working folder");
  assert.equal((await fetch(base + "/charts.js")).status, 200, "Source-mode entrypoint resolves built browser charts"); assert.equal((await post("/api/visualization/query", { id: datasetId })).analysis.primary.sum, 33);
  console.log(`Packed/source Web/CLI: no node_modules in package, local chart assets in both entrypoints, real XLSX upload/statistics and shared CLI dataset evidence passed. Tarball: ${tarball}`);
} finally {
  if (server?.exitCode === null) { server.kill(); await Promise.race([new Promise<void>((r) => server!.once("close", () => r())), delay(3000)]); }
  mock.closeAllConnections(); await new Promise<void>((r) => mock.close(() => r()));
  const relative = path.relative(output, await fs.realpath(runtime)); if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Unsafe package-test cleanup"); await fs.rm(runtime, { recursive: true, force: true });
}
