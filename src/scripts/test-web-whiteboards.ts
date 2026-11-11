/** Real local-store regressions. No browser, network, account data or mock store. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { link, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { handleWhiteboard, WhiteboardConflictError, WhiteboardError, type Whiteboard, type WhiteboardMetadata } from "../entrypoint/webWhiteboards.js";

const temporaryParent = await realpath(os.tmpdir());
const testRoot = await realpath(await mkdtemp(path.join(temporaryParent, "ccagent-whiteboards-")));
const savedHome = process.env.CCAGENT_HOME;
const fixtureLinks: string[] = [];
const accountA = path.join(testRoot, "account-a"), accountB = path.join(testRoot, "account-b");
const workspaceA = path.join(testRoot, "workspace-a"), workspaceB = path.join(testRoot, "workspace-b");
const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==";
const rectangle = { id: "rect-1", type: "rectangle", x: 12, y: -8, width: 200, height: 90, angle: 0, isDeleted: false, strokeColor: "#1e1e1e", backgroundColor: "transparent", version: 1, seed: 55 };
const image = { id: "image-element", type: "image", x: 22, y: 5, width: 40, height: 40, angle: 0, isDeleted: false, fileId: "image-file", status: "saved", scale: [1, 1] };
const scene = {
  type: "excalidraw", version: 2,
  elements: [rectangle, { ...rectangle, id: "text-1", type: "text", text: "中文画布：完整保存", originalText: "中文画布：完整保存", link: "https://example.com/path" }, image],
  appState: { viewBackgroundColor: "#ffffff", currentItemStrokeColor: "#123456", currentItemFillStyle: "solid", gridSize: 20, gridStep: 5, gridModeEnabled: true, scrollX: -20, scrollY: 100, zoom: { value: 1.25 }, theme: "dark",
    selectedElementIds: { "rect-1": true }, collaborators: {}, openDialog: { name: "help" }, width: 1920, height: 1080 },
  files: { "image-file": { id: "image-file", mimeType: "image/png", dataURL: png, created: 100, lastRetrieved: 101 } },
};
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
type Response = Awaited<ReturnType<typeof handleWhiteboard>>;
function board(response: Response): Whiteboard | WhiteboardMetadata { assert.ok("board" in response); return response.board; }
function opened(response: Response): Whiteboard { const value = board(response); assert.ok("scene" in value); return value; }
function listed(response: Response): WhiteboardMetadata[] { assert.ok("boards" in response); return response.boards; }
async function failure(action: string, input: Record<string, unknown>, workspace = workspaceA, status = 400) {
  await assert.rejects(handleWhiteboard(action, input, workspace), (error: unknown) => error instanceof WhiteboardError && error.status === status);
}
function directory(home: string, workspace: string): string { return path.join(home, "whiteboards", createHash("sha256").update(workspace).digest("hex")); }

try {
  await mkdir(workspaceA); await mkdir(workspaceB);
  process.env.CCAGENT_HOME = accountA;
  assert.deepEqual(listed(await handleWhiteboard("list", {}, workspaceA)), []);
  const blank = opened(await handleWhiteboard("create", {}, workspaceA));
  assert.equal(blank.name, "未命名画布"); assert.equal(blank.revision, 1); assert.equal(blank.elementCount, 0);
  assert.deepEqual(blank.scene, { type: "excalidraw", version: 2, elements: [], appState: {}, files: {} });
  const createdResponse = await handleWhiteboard("create", { name: " 产品流程图 ", scene }, workspaceA);
  const created = opened(createdResponse);
  assert.equal(createdResponse.workspace, await realpath(workspaceA));
  assert.equal(created.name, "产品流程图"); assert.equal(created.revision, 1); assert.equal(created.elementCount, 3);
  assert.deepEqual(created.scene.elements, scene.elements, "editable text, image references and geometry must survive");
  assert.deepEqual(created.scene.files, scene.files, "embedded raster image bytes must survive");
  for (const key of ["selectedElementIds", "collaborators", "openDialog", "width", "height"]) assert.ok(!(key in created.scene.appState), "transient UI fields must be removed");
  for (const key of ["viewBackgroundColor", "currentItemStrokeColor", "gridSize", "gridStep", "gridModeEnabled", "scrollX", "scrollY", "zoom", "theme"]) assert.deepEqual(created.scene.appState[key], scene.appState[key as keyof typeof scene.appState]);
  assert.deepEqual(opened(await handleWhiteboard("open", { id: created.id }, workspaceA)), created);
  const catalog = listed(await handleWhiteboard("list", {}, workspaceA));
  assert.equal(catalog.length, 2); assert.ok(catalog.every((item) => !("scene" in item)), "list must contain metadata only");

  const canonicalA = await realpath(workspaceA);
  const file = path.join(directory(accountA, canonicalA), `${created.id}.json`);
  assert.equal((JSON.parse(await readFile(file, "utf8")) as Whiteboard).scene.elements.length, 3, "the real account-private file must contain the scene");
  const alias = path.join(testRoot, "workspace-alias");
  await symlink(workspaceA, alias, process.platform === "win32" ? "junction" : "dir");
  fixtureLinks.push(alias);
  assert.deepEqual(opened(await handleWhiteboard("open", { id: created.id }, alias)), created, "canonical workspace aliases must share the same private store");
  assert.deepEqual(listed(await handleWhiteboard("list", {}, workspaceB)), []);
  await failure("open", { id: created.id }, workspaceB, 404);
  process.env.CCAGENT_HOME = accountB;
  assert.deepEqual(listed(await handleWhiteboard("list", {}, workspaceA)), []);
  await failure("open", { id: created.id }, workspaceA, 404);
  const otherAccount = opened(await handleWhiteboard("create", { name: "独立账号" }, workspaceA));
  assert.notEqual(otherAccount.id, created.id);
  process.env.CCAGENT_HOME = accountA;
  assert.equal(listed(await handleWhiteboard("list", {}, workspaceA)).length, 2);

  const concurrentCreates = await Promise.all(Array.from({ length: 6 }, (_, index) => handleWhiteboard("create", { name: `并发-${index}` }, workspaceA)));
  assert.equal(new Set(concurrentCreates.map((response) => board(response).id)).size, 6);
  assert.equal(listed(await handleWhiteboard("list", {}, workspaceA)).length, 8, "concurrent real file creates must not lose catalog entries");
  const edits = ["窗口一", "窗口二"].map((name) => handleWhiteboard("save", { id: created.id, revision: 1, name, scene }, workspaceA));
  const saves = await Promise.allSettled(edits);
  assert.equal(saves.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = saves.find((result) => result.status === "rejected");
  assert.ok(rejected?.status === "rejected" && rejected.reason instanceof WhiteboardConflictError);
  assert.equal(rejected.reason.status, 409); assert.equal(rejected.reason.code, "conflict");
  const winner = opened(await handleWhiteboard("open", { id: created.id }, workspaceA));
  assert.equal(winner.revision, 2); assert.equal(winner.createdAt, created.createdAt);
  const changed = copy(scene); changed.elements[0]!.width = 250; changed.elements[1]!.isDeleted = true;
  const saved = board(await handleWhiteboard("save", { id: created.id, revision: 2, scene: changed }, workspaceA));
  assert.equal(saved.revision, 3); assert.equal(saved.name, winner.name); assert.equal(saved.elementCount, 2); assert.ok(!("scene" in saved));
  assert.deepEqual(opened(await handleWhiteboard("open", { id: created.id }, workspaceA)).scene.elements, changed.elements);

  const beforeInvalid = await readFile(file, "utf8");
  const badScenes: unknown[] = [null, [], { ...scene, type: "other" }, { ...scene, version: 1 }, { ...scene, elements: {} }, { ...scene, files: [] }, { ...scene, appState: [] },
    { ...scene, elements: [{ ...rectangle, type: "iframe", link: "https://example.com" }] },
    { ...scene, elements: [{ ...rectangle, type: "embeddable", link: "https://example.com" }] },
    { ...scene, elements: [{ ...rectangle, x: "12" }] }, { ...scene, elements: [{ ...rectangle, width: -5 }] },
    { ...scene, elements: [{ ...rectangle, x: Number.POSITIVE_INFINITY }] }, { ...scene, elements: [{ ...rectangle, angle: Number.NaN }] },
    { ...scene, elements: [rectangle, rectangle] }, { ...scene, elements: [{ ...rectangle, type: "line", points: [[0, 0], ["1", 3]] }] },
    { ...scene, elements: [{ ...image, fileId: "missing" }] }, { ...scene, appState: { zoom: { value: 0 } } },
    { ...scene, appState: { currentItemOpacity: 200 } },
    JSON.parse('{"type":"excalidraw","version":2,"elements":[],"appState":{"__proto__":{"polluted":true}},"files":{}}'),
    { ...scene, elements: [{ ...rectangle, customData: JSON.parse('{"constructor":{"prototype":{"polluted":true}}}') }] },
  ];
  for (const link of ["javascript:alert(1)", "data:text/html;base64,PHNjcmlwdD4=", "file:///C:/private.txt", "//example.com", " https://example.com", "https://example.com\nattack"]) badScenes.push({ ...scene, elements: [{ ...rectangle, link }] });
  for (const changes of [
    { dataURL: "https://example.com/a.png" }, { dataURL: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=", mimeType: "image/svg+xml" },
    { dataURL: "data:image/png;base64,PHN2Zz48L3N2Zz4=" }, { dataURL: "data:image/png;base64,!!!!" },
    { dataURL: "data:image/png;base64,aGVsbG8=" }, { id: "different-id" }, { created: "100" }, { mimeType: "image/jpeg" },
  ]) badScenes.push({ ...scene, files: { "image-file": { ...scene.files["image-file"], ...changes } } });
  for (const bad of badScenes) {
    await failure("save", { id: created.id, revision: 3, scene: bad });
    assert.equal(await readFile(file, "utf8"), beforeInvalid, "every invalid save must preserve the previous document byte for byte");
  }
  await failure("save", { id: created.id, revision: 3, scene: { ...scene, elements: Array.from({ length: 10_001 }, (_, index) => ({ ...rectangle, id: `r-${index}` })) } }, workspaceA, 413);
  await failure("save", { id: created.id, revision: 3, scene: { ...scene, appState: { oversized: "x".repeat(10 * 1024 * 1024) } } }, workspaceA, 413);
  for (const id of ["../secrets", "..\\secrets", file, created.id + "/other", created.id.toUpperCase(), "00000000-0000-0000-0000-000000000000"]) await failure("open", { id });
  for (const revision of [undefined, null, 0, -1, 1.5, "3"]) {
    const input: Record<string, unknown> = { id: created.id, scene };
    if (revision !== undefined) input.revision = revision;
    await failure("save", input);
  }
  await failure("delete", { id: created.id });
  assert.equal(await readFile(file, "utf8"), beforeInvalid);
  assert.equal(({} as { polluted?: boolean }).polluted, undefined);
  for (const link of ["http://example.com", "https://example.com/path?q=1", "mailto:user@example.com"]) {
    const safe = opened(await handleWhiteboard("create", { scene: { ...scene, elements: [{ ...rectangle, link }] } }, workspaceA));
    assert.equal(safe.scene.elements[0]!.link, link);
  }

  // File hard links need no elevated symlink privilege on Windows. Neither a
  // board nor its transaction sentinel may alias a file outside the store.
  const guarded = opened(await handleWhiteboard("create", { scene }, workspaceB));
  const guardedFile = path.join(directory(accountA, await realpath(workspaceB)), `${guarded.id}.json`);
  const guardedOriginal = guardedFile + "-original";
  const externalFile = path.join(testRoot, "outside-private-file.txt");
  await writeFile(externalFile, "external-file-must-stay-unchanged");
  await rename(guardedFile, guardedOriginal);
  await link(externalFile, guardedFile);
  await failure("open", { id: guarded.id }, workspaceB, 500);
  await failure("save", { id: guarded.id, revision: 1, scene }, workspaceB, 500);
  assert.equal(await readFile(externalFile, "utf8"), "external-file-must-stay-unchanged");
  await rm(guardedFile); await rename(guardedOriginal, guardedFile);
  const sentinel = guardedFile + ".transaction", savedSentinel = sentinel + "-original";
  await rename(sentinel, savedSentinel); await link(externalFile, sentinel);
  await failure("save", { id: guarded.id, revision: 1, scene }, workspaceB, 500);
  assert.equal(await readFile(externalFile, "utf8"), "external-file-must-stay-unchanged");
  await rm(sentinel); await rename(savedSentinel, sentinel);
  assert.deepEqual(opened(await handleWhiteboard("open", { id: guarded.id }, workspaceB)), guarded);

  // A malicious private-store junction must never redirect reads or writes.
  const privateDirectory = directory(accountA, canonicalA);
  const backupDirectory = privateDirectory + "-original";
  const outside = path.join(testRoot, "outside-store"); await mkdir(outside);
  const outsideFile = path.join(outside, `${created.id}.json`);
  await writeFile(outsideFile, "outside-file-must-stay-unchanged");
  await rename(privateDirectory, backupDirectory);
  await symlink(outside, privateDirectory, process.platform === "win32" ? "junction" : "dir");
  fixtureLinks.push(privateDirectory);
  assert.equal((await lstat(privateDirectory)).isSymbolicLink(), true);
  await failure("list", {}, workspaceA, 500);
  await failure("create", { name: "不得写出" }, workspaceA, 500);
  await failure("open", { id: created.id }, workspaceA, 500);
  await failure("save", { id: created.id, revision: 3, scene }, workspaceA, 500);
  assert.equal(await readFile(outsideFile, "utf8"), "outside-file-must-stay-unchanged");
  assert.equal(await readFile(path.join(backupDirectory, `${created.id}.json`), "utf8"), beforeInvalid);
  console.log("Whiteboard real-store tests passed: account/workspace isolation, canonical aliases, atomic concurrent creates/saves, revision conflicts, full editable scenes/images, transient-state stripping, limits, unsafe scenes/links/files, path and junction guards. No account data was used.");
} finally {
  if (savedHome === undefined) delete process.env.CCAGENT_HOME; else process.env.CCAGENT_HOME = savedHome;
  const relative = path.relative(temporaryParent, testRoot);
  assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
  // Windows must unlink fixture junctions before recursively removing targets.
  for (const file of fixtureLinks) await unlink(file).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
  await rm(testRoot, { recursive: true, force: true });
}
