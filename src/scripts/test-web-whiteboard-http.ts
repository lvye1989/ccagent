/** Isolated built-server acceptance: real HTTP/auth/assets/private whiteboards. */
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { startAccountFixture } from "./helpers/accountFixture.js";
import { accountHome } from "../platform/account.js";
import type { Whiteboard, WhiteboardMetadata } from "../entrypoint/webWhiteboards.js";

const root = path.resolve(import.meta.dirname, "../..");
const entry = path.join(root, "dist", "ccagent.js");
const assets = path.join(root, "dist", "whiteboard");
await fs.access(entry);
await fs.access(path.join(assets, "whiteboard-editor.js"));
await fs.access(path.join(assets, "whiteboard-editor.css"));
const temporaryParent = await fs.realpath(os.tmpdir());
const temp = await fs.realpath(await fs.mkdtemp(path.join(temporaryParent, "ccagent-whiteboard-http-")));
const platformBase = path.join(temp, "isolated-platform");
const workspaceA = path.join(temp, "中文 画布项目"), workspaceB = path.join(temp, "第二个 项目");
let child: ChildProcess | undefined;
let fixture: Awaited<ReturnType<typeof startAccountFixture>> | undefined;
let logs = "";
const delay = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
async function freePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const reservation = net.createServer(); reservation.once("error", reject);
    reservation.listen(0, "127.0.0.1", () => {
      const address = reservation.address();
      reservation.close(() => address && typeof address !== "string" ? resolve(address.port) : reject(new Error("No isolated HTTP test port")));
    });
  });
}
async function stopOwnedServer(): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const owned = child;
  const exited = new Promise<void>((resolve) => owned.once("close", () => resolve()));
  if (owned.connected) owned.send("ccagent:shutdown", () => {});
  const force = setTimeout(() => {
    // Scope fallback termination to this test's exact owned process tree.
    if (process.platform === "win32" && owned.pid) {
      try { execFileSync("taskkill", ["/PID", String(owned.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); } catch { owned.kill(); }
    } else owned.kill("SIGTERM");
  }, 8000);
  try { await exited; } finally { clearTimeout(force); }
}

try {
  await fs.mkdir(workspaceA); await fs.mkdir(workspaceB);
  fixture = await startAccountFixture(platformBase);
  const homeA = accountHome(platformBase, fixture.users[0]!.id), homeB = accountHome(platformBase, fixture.users[1]!.id);
  for (const home of [homeA, homeB]) {
    await fs.mkdir(home, { recursive: true });
    await fs.writeFile(path.join(home, "settings.json"), JSON.stringify({ mcpServers: {} }));
  }
  const emptyEnv = path.join(temp, "empty.env"); await fs.writeFile(emptyEnv, "");
  const env: NodeJS.ProcessEnv = { ...process.env, CCAGENT_HOME: platformBase, CCAGENT_PLATFORM_HOME: platformBase, CCAGENT_ENV_FILE: emptyEnv };
  for (const key of ["CCAGENT_ACCOUNT_ID", "CCAGENT_AUTH_SESSION_FILE", "CCAGENT_DESKTOP_TOKEN", "CCAGENT_WEB_WORKER_TOKEN", "CCAGENT_DESKTOP_APP"]) delete env[key];
  const port = await freePort(), origin = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [entry, "web", "--workspace", workspaceA, "--port", String(port)], {
    cwd: temp, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let launchError: Error | undefined;
  child.on("error", (error) => { launchError = error; });
  child.stdout!.on("data", (chunk: Buffer) => { logs = (logs + chunk.toString()).slice(-8000); });
  child.stderr!.on("data", (chunk: Buffer) => { logs = (logs + chunk.toString()).slice(-8000); });
  let ready = false;
  for (let attempt = 0; attempt < 150; attempt++) {
    if (launchError || child.exitCode !== null) throw new Error(`Isolated whiteboard server failed: ${launchError?.message ?? logs}`);
    try { if ((await fetch(origin + "/api/health", { signal: AbortSignal.timeout(1000) })).ok) { ready = true; break; } } catch { /* Wait for the owned server only. */ }
    await delay(100);
  }
  assert.ok(ready, `Isolated whiteboard server did not start: ${logs}`);

  async function request(route: string, cookie = "", body?: Record<string, unknown>, extraHeaders?: Record<string, string>): Promise<Response> {
    const headers = new Headers(extraHeaders);
    if (cookie) headers.set("cookie", cookie);
    if (body !== undefined) { headers.set("content-type", "application/json"); headers.set("x-ccagent-web", "1"); headers.set("origin", origin); }
    return await fetch(origin + route, { method: body === undefined ? "GET" : "POST", headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: "manual", signal: AbortSignal.timeout(30_000) });
  }
  async function login(index: number): Promise<string> {
    const response = await request("/api/account/login", "", { email: fixture!.users[index]!.email, password: fixture!.password });
    assert.equal(response.status, 200, "fixture account login must use the real account endpoint");
    const cookie = response.headers.get("set-cookie")?.split(";")[0]; assert.ok(cookie); return cookie;
  }
  const protectedRoutes = ["/whiteboard.js", "/whiteboard.css", "/whiteboard-editor.html", "/whiteboard-editor-shell.css", "/whiteboard-assets/whiteboard-editor.js", "/whiteboard-assets/whiteboard-editor.css", `/api/whiteboards?workspace=${encodeURIComponent(workspaceA)}`];
  for (const route of protectedRoutes) assert.equal((await request(route)).status, 401, `anonymous whiteboard content must be denied: ${route}`);
  const cookieA = await login(0);
  const bootstrapResponse = await request("/api/bootstrap", cookieA);
  assert.equal(bootstrapResponse.status, 200);
  const bootstrap = await bootstrapResponse.json() as { workspace: string };
  assert.equal(bootstrap.workspace, workspaceA);
  const canonicalA = await fs.realpath(workspaceA), canonicalB = await fs.realpath(workspaceB);

  const editor = await request("/whiteboard-editor.html", cookieA);
  assert.equal(editor.status, 200); assert.match(editor.headers.get("content-type") ?? "", /text\/html/);
  const csp = editor.headers.get("content-security-policy") ?? "";
  for (const directive of ["default-src 'none'", "script-src 'self' 'wasm-unsafe-eval'", "connect-src 'self'", "frame-src 'none'", "frame-ancestors 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'none'"]) assert.ok(csp.includes(directive), `editor CSP must include ${directive}`);
  assert.ok(!csp.includes("'unsafe-eval'"), "editor cannot allow arbitrary eval");
  const editorHtml = await editor.text();
  assert.match(editorHtml, /src="\/whiteboard-assets\/whiteboard-editor\.js"/);
  assert.match(editorHtml, /href="\/whiteboard-assets\/whiteboard-editor\.css"/);
  assert.doesNotMatch(editorHtml, /(?:src|href)="https?:\/\//, "editor entry uses only local assets");
  const main = await request("/", cookieA);
  assert.equal(main.status, 200);
  const mainCsp = main.headers.get("content-security-policy") ?? "";
  assert.ok(!mainCsp.includes("wasm-unsafe-eval") && !mainCsp.includes("unsafe-inline"), "editor allowances must not weaken the main document CSP");
  for (const [asset, contentType] of [["whiteboard-editor.js", "javascript"], ["whiteboard-editor.css", "text/css"]]) {
    const response = await request(`/whiteboard-assets/${asset}`, cookieA);
    assert.equal(response.status, 200); assert.ok((response.headers.get("content-type") ?? "").includes(contentType!));
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("cross-origin-resource-policy"), "same-origin");
    assert.ok((await response.arrayBuffer()).byteLength > 1000, "serve real built editor content");
  }
  const font = (await fs.readdir(path.join(assets, "fonts"), { recursive: true })).find((name) => name.endsWith(".woff2"));
  assert.ok(font, "the built editor must contain local fonts");
  const fontResponse = await request("/whiteboard-assets/fonts/" + font.split(path.sep).map(encodeURIComponent).join("/"), cookieA);
  assert.equal(fontResponse.status, 200); assert.equal(fontResponse.headers.get("content-type"), "font/woff2");
  assert.ok((await fontResponse.arrayBuffer()).byteLength > 100);
  for (const route of ["/whiteboard-assets/%2e%2e%2fccagent.js", "/whiteboard-assets/%2e%2e%2f..%2fpackage.json", "/whiteboard-assets/%5c..%5cpackage.json", "/whiteboard-assets/C:%5cprivate.txt", "/whiteboard-assets/%00secret.txt", "/whiteboard-assets/whiteboard-editor.js.map", "/whiteboard-assets/missing.js"]) {
    const response = await request(route, cookieA);
    assert.equal(response.status, 404, `asset escape/unsupported request must fail: ${route}`);
  }

  const listRoute = (workspace: string) => `/api/whiteboards?workspace=${encodeURIComponent(workspace)}`;
  type BoardResponse = { workspace: string; board: Whiteboard };
  type ListResponse = { workspace: string; boards: WhiteboardMetadata[] };
  const emptyList = await request(listRoute(workspaceA), cookieA);
  assert.equal(emptyList.status, 200); assert.deepEqual((await emptyList.json() as ListResponse).boards, []);
  const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==";
  const rectangle = { id: "http-rect", type: "rectangle", x: 10, y: -5, width: 200, height: 80, angle: 0, isDeleted: false, version: 1 };
  const scene = { type: "excalidraw", version: 2, elements: [rectangle, { ...rectangle, id: "http-image", type: "image", fileId: "http-png", scale: [1, 1], status: "saved" }],
    appState: { viewBackgroundColor: "#ffffff", scrollX: 12, scrollY: -7, zoom: { value: 1.5 }, theme: "light", selectedElementIds: { "http-rect": true } },
    files: { "http-png": { id: "http-png", mimeType: "image/png", dataURL: png, created: 100 } } };
  const createdResponse = await request("/api/whiteboards/create", cookieA, { workspace: workspaceA, name: "HTTP 中文画布", scene });
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json() as BoardResponse;
  assert.equal(created.workspace, canonicalA); assert.equal(created.board.revision, 1); assert.equal(created.board.elementCount, 2);
  assert.deepEqual(created.board.scene.elements, scene.elements); assert.deepEqual(created.board.scene.files, scene.files);
  assert.ok(!("selectedElementIds" in created.board.scene.appState));
  const readResponse = await request("/api/whiteboards/open", cookieA, { workspace: workspaceA, id: created.board.id });
  assert.equal(readResponse.status, 200); assert.deepEqual(await readResponse.json(), created);
  const list = await (await request(listRoute(workspaceA), cookieA)).json() as ListResponse;
  assert.equal(list.boards.length, 1); assert.ok(!("scene" in list.boards[0]!));
  const editedScene = { ...scene, elements: [{ ...rectangle, width: 275 }, scene.elements[1]!] };
  const saveResponse = await request("/api/whiteboards/save", cookieA, { workspace: workspaceA, id: created.board.id, revision: 1, name: "HTTP 已编辑画布", scene: editedScene });
  assert.equal(saveResponse.status, 200);
  const saved = await saveResponse.json() as { workspace: string; board: WhiteboardMetadata };
  assert.equal(saved.board.revision, 2); assert.equal(saved.board.name, "HTTP 已编辑画布"); assert.ok(!("scene" in saved.board));
  const staleSave = await request("/api/whiteboards/save", cookieA, { workspace: workspaceA, id: created.board.id, revision: 1, scene });
  assert.equal(staleSave.status, 409); assert.equal((await staleSave.json() as { code: string }).code, "conflict");
  const persisted = await (await request("/api/whiteboards/open", cookieA, { workspace: workspaceA, id: created.board.id })).json() as BoardResponse;
  assert.equal(persisted.board.revision, 2); assert.deepEqual(persisted.board.scene.elements, editedScene.elements);
  const storedFile = path.join(homeA, "whiteboards", createHash("sha256").update(canonicalA).digest("hex"), `${created.board.id}.json`);
  assert.deepEqual((JSON.parse(await fs.readFile(storedFile, "utf8")) as Whiteboard).scene.elements, editedScene.elements, "HTTP saves must reach the real account-private store");
  const badPath = await request("/api/whiteboards/open", cookieA, { workspace: workspaceA, id: "../../settings.json" });
  assert.equal(badPath.status, 400);
  const missingRevision = await request("/api/whiteboards/save", cookieA, { workspace: workspaceA, id: created.board.id, scene });
  assert.equal(missingRevision.status, 400);
  const missingWorkspace = await request("/api/whiteboards", cookieA);
  assert.equal(missingWorkspace.status, 409); assert.equal((await missingWorkspace.json() as { code: string }).code, "workspace_changed");

  const switchResponse = await request("/api/workspaces/select", cookieA, { path: workspaceB });
  assert.equal(switchResponse.status, 200); assert.equal((await switchResponse.json() as { workspace: string }).workspace, canonicalB);
  const backgroundList = await request(listRoute(workspaceA), cookieA);
  assert.equal(backgroundList.status, 200, "an explicit workspace query routes to the retained background project");
  assert.deepEqual((await backgroundList.json() as ListResponse).boards.map((item) => item.id), [created.board.id]);
  const backgroundBoard = await request("/api/whiteboards/open", cookieA, { workspace: workspaceA, id: created.board.id }, { "x-ccagent-workspace": encodeURIComponent(workspaceA) });
  assert.equal(backgroundBoard.status, 200, "an explicit workspace header routes to the retained background project");
  assert.equal((await backgroundBoard.json() as BoardResponse).board.revision, 2);
  for (const [route, body] of [["/api/whiteboards/open", { workspace: workspaceA, id: created.board.id }], ["/api/whiteboards/save", { workspace: workspaceA, id: created.board.id, revision: 2, scene }]] as const) {
    const response = await request(route, cookieA, body);
    assert.equal(response.status, 409); assert.equal((await response.json() as { code: string }).code, "workspace_changed", "a stale request body cannot retarget the selected project's worker");
  }
  assert.deepEqual((await (await request(listRoute(workspaceB), cookieA)).json() as ListResponse).boards, []);
  assert.equal((await request("/api/whiteboards/open", cookieA, { workspace: workspaceB, id: created.board.id })).status, 404);
  const boardB = await (await request("/api/whiteboards/create", cookieA, { workspace: workspaceB, name: "第二工作区画布" })).json() as BoardResponse;
  assert.equal(boardB.workspace, canonicalB);
  assert.equal((await request("/api/workspaces/select", cookieA, { path: workspaceA })).status, 200);
  const originalList = await (await request(listRoute(workspaceA), cookieA)).json() as ListResponse;
  assert.deepEqual(originalList.boards.map((item) => item.id), [created.board.id]);
  const unchanged = await (await request("/api/whiteboards/open", cookieA, { workspace: workspaceA, id: created.board.id })).json() as BoardResponse;
  assert.equal(unchanged.board.revision, 2); assert.deepEqual(unchanged.board.scene.elements, editedScene.elements);

  const cookieB = await login(1);
  assert.deepEqual((await (await request(listRoute(workspaceA), cookieB)).json() as ListResponse).boards, [], "same workspace must remain private to each authenticated account");
  assert.equal((await request("/api/whiteboards/open", cookieB, { workspace: workspaceA, id: created.board.id })).status, 404);
  const otherAccountResponse = await request("/api/whiteboards/create", cookieB, { workspace: workspaceA, name: "另一账号画布" });
  assert.equal(otherAccountResponse.status, 201);
  const otherAccount = await otherAccountResponse.json() as BoardResponse;
  assert.equal((await request("/api/whiteboards/open", cookieA, { workspace: workspaceA, id: otherAccount.board.id })).status, 404);
  assert.deepEqual((await (await request(listRoute(workspaceA), cookieA)).json() as ListResponse).boards.map((item) => item.id), [created.board.id]);
  assert.equal((await request("/api/account/logout", cookieB, {})).status, 200);
  assert.equal((await request("/whiteboard-assets/whiteboard-editor.js", cookieB)).status, 401, "logged-out clients must lose bundle access");
  console.log("Whiteboard built-server HTTP acceptance passed: real fixture login, protected local editor/JS/CSS/fonts, isolated CSP, asset/path guards, durable create/open/save, revision conflict, stale workspace protection, workspace and account isolation. No production account or model service was used.");
} finally {
  await stopOwnedServer();
  await fixture?.close();
  const relative = path.relative(temporaryParent, temp);
  assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative), "cleanup is confined to this isolated fixture directory");
  await fs.rm(temp, { recursive: true, force: true });
}
