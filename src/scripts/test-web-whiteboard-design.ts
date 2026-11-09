/** Isolated account + persisted canvas + injected raster provider; no paid calls. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { enterPlatformAccount } from "../platform/account.js";
import { createWhiteboardDesignManager, WhiteboardDesignError, type WhiteboardDesignRun } from "../entrypoint/webWhiteboardDesign.js";
import { handleWhiteboard, type Whiteboard } from "../entrypoint/webWhiteboards.js";
import { validateDesignRaster, type DesignImageConfig, type DesignImageInput } from "../services/images/designImageProvider.js";
import { loginForTest } from "./helpers/accountFixture.js";

const parent = await fs.realpath(os.tmpdir()), temp = await fs.realpath(await fs.mkdtemp(path.join(parent, "ccagent-design-runs-")));
const workspace = path.join(temp, "workspace"), otherWorkspace = path.join(temp, "other-workspace");
await fs.mkdir(workspace); await fs.mkdir(otherWorkspace);
const account = await loginForTest(path.join(temp, "platform"));
const raster = validateDesignRaster({ dataURL: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aFe0AAAAASUVORK5CYII=", width: 1, height: 1 });
const calls: DesignImageInput[] = [], busyEvents: string[] = [], idleEvents: string[] = [];
let selected = workspace, busy: string | undefined, releaseHeld: (() => void) | undefined;
const baseConfig: DesignImageConfig = { configured: true, provider: "openai", model: "fixture-image-edit", baseURL: "https://images.example.invalid/v1/images/edits", source: "user", hasKey: true, maxReferences: 2 };
let config = { ...baseConfig };
const options = {
  getWorkspace: () => selected, isBusy: () => !!busy,
  onBusy: (id: string) => { assert.equal(busy, undefined); busy = id; busyEvents.push(id); },
  onIdle: (id: string) => { assert.equal(busy, id); busy = undefined; idleEvents.push(id); },
  getConfiguration: async () => ({ ...config }),
  async generate(input: DesignImageInput) {
    calls.push(input);
    if (input.prompt.startsWith("HOLD")) await new Promise<void>((resolve) => { releaseHeld = resolve; });
    if (input.prompt.startsWith("ERROR")) throw new Error("private supplier response must not be returned: fixture-secret");
    if (input.prompt.startsWith("INVALID")) return { images: [], provider: "openai" as const, model: "fixture-image-edit" };
    return { images: [{ ...raster, name: "Generated fixture" }], provider: "openai" as const, model: "fixture-image-edit" };
  },
};
const manager = createWhiteboardDesignManager(options);
const delay = (ms = 10) => new Promise<void>((resolve) => setTimeout(resolve, ms));
function releaseHeldProvider(): void { releaseHeld?.(); releaseHeld = undefined; }
async function waitIdle(): Promise<void> { for (let i = 0; i < 300 && busy; i++) await delay(); assert.equal(busy, undefined, "all reservations must release, including ignored provider cancellation"); }
async function done(runId: string, target = manager): Promise<WhiteboardDesignRun> {
  for (let i = 0; i < 300; i++) { const run = await target.status(runId, selected); if (run.status !== "running") { await waitIdle(); return run; } await delay(); }
  assert.fail("Raster fixture did not finish");
}
function scene(referenceCount = 2) {
  const image = (id: string, role: string, baseImageId?: string) => ({ id, type: "image", fileId: id + "-file", x: 0, y: 0, width: 100, height: 100,
    angle: 0, scale: [1, 1], isDeleted: false, customData: { ccagentDesign: { version: 1, role, width: 1, height: 1, ...(baseImageId ? { baseImageId } : {}) } } });
  const elements = [image("original", "base"), ...Array.from({ length: referenceCount }, (_, index) => image("reference-" + index, "reference", "original")), image("unrelated-reference", "reference", "another-original"), image("previous-output", "result", "original")];
  const files = Object.fromEntries(elements.map((element) => [element.fileId, { id: element.fileId, dataURL: raster.dataURL, mimeType: raster.mimeType, created: Date.now() }]));
  return { type: "excalidraw", version: 2, elements, appState: {}, files };
}
const created = await handleWhiteboard("create", { name: "设计图像隔离测试", scene: scene() }, workspace);
assert.ok("board" in created && "scene" in created.board);
const board = created.board;
const body = { workspace, id: board.id, revision: board.revision, kind: "architecture", prompt: "优化建筑立面并保留原有视角", baseImageId: "original", canvasVersion: 10, annotated: raster, requestId: randomUUID() };
async function rejected(input: Record<string, unknown>, code: string) {
  const before = calls.length;
  await assert.rejects(manager.start(input), (error: unknown) => error instanceof WhiteboardDesignError && error.code === code);
  await waitIdle(); assert.equal(calls.length, before, "invalid requests cannot invoke the provider");
}
async function open(): Promise<Whiteboard> { const value = await handleWhiteboard("open", { id: board.id }, workspace); assert.ok("board" in value && "scene" in value.board); return value.board; }

try {
  await rejected({ ...body, references: [raster] }, "invalid_design_request");
  await rejected({ ...body, baseURL: "https://untrusted.example.invalid" }, "invalid_design_request");
  await rejected({ ...body, annotated: { ...raster, dataURL: "https://example.invalid/image.png" } }, "invalid_design_request");
  await rejected({ ...body, annotated: { ...raster, width: 2 } }, "invalid_design_request");
  await rejected({ ...body, requestId: "invalid" }, "invalid_design_request");
  await rejected({ ...body, prompt: " " }, "invalid_design_request");
  await rejected({ ...body, kind: "arbitrary" }, "invalid_design_request");
  await rejected({ ...body, canvasVersion: -1 }, "invalid_design_request");
  await rejected({ ...body, revision: 99 }, "conflict");
  await rejected({ ...body, workspace: otherWorkspace }, "workspace_changed");
  await rejected({ ...body, baseImageId: "reference-0" }, "base_image_missing");
  await rejected({ ...body, baseImageId: "previous-output" }, "base_image_missing");
  config = { ...baseConfig, configured: false, hasKey: false };
  await rejected(body, "config_not_ready");
  config = { ...baseConfig, maxReferences: 1 };
  await rejected(body, "reference_limit");
  config = { ...baseConfig };

  const startingFirst = manager.start(body); assert.ok(busy, "shared worker is reserved before awaiting preparation");
  const first = await startingFirst;
  const completed = await done(first.runId);
  assert.equal(completed.status, "completed"); assert.equal(completed.images.length, 1); assert.equal(completed.canvasVersion, 10); assert.equal(completed.baseImageId, "original");
  assert.equal(calls.length, 1); assert.equal(calls[0]!.references.length, 2); assert.equal(calls[0]!.base!.dataURL, raster.dataURL);
  assert.equal(calls[0]!.annotated!.dataURL, raster.dataURL); assert.equal(calls[0]!.requestId, body.requestId);
  assert.deepEqual(await open(), board, "generation must never overwrite the saved scene, original or references");
  completed.images[0]!.dataURL = "tampered consumer copy";
  assert.equal((await manager.status(first.runId, workspace)).images[0]!.dataURL, raster.dataURL, "status results are owned copies");
  assert.deepEqual(await manager.start({ ...body }), first); assert.equal(calls.length, 1, "network retry cannot generate twice");
  assert.equal((await manager.lookup(body.requestId, workspace)).runId, first.runId);
  await assert.rejects(manager.lookup(randomUUID(), workspace), (error: unknown) => error instanceof WhiteboardDesignError && error.code === "not_found");
  assert.equal(calls.length, 1, "request lookup is strictly read only");
  await rejected({ ...body, prompt: "different request" }, "request_mismatch");
  await rejected({ ...body, canvasVersion: 11 }, "request_mismatch");

  let releaseConfig!: () => void;
  const gate = new Promise<void>((resolve) => { releaseConfig = resolve; });
  const racing = createWhiteboardDesignManager({ ...options, getConfiguration: async () => { await gate; return { ...baseConfig }; } });
  const racingBody = { ...body, requestId: randomUUID() };
  const pending = racing.start(racingBody); assert.ok(busy, "the worker is reserved synchronously before authentication/file/config awaits");
  const coalesced = racing.start({ ...racingBody });
  const recovering = racing.lookup(racingBody.requestId, workspace);
  await assert.rejects(racing.start({ ...racingBody, prompt: "changed while pending" }), (error: unknown) => error instanceof WhiteboardDesignError && error.code === "request_mismatch");
  await assert.rejects(racing.start({ ...racingBody, requestId: randomUUID() }), (error: unknown) => error instanceof WhiteboardDesignError && error.code === "busy");
  releaseConfig(); const raced = await pending; assert.deepEqual(await coalesced, raced); assert.equal((await recovering).runId, raced.runId); await done(raced.runId, racing); racing.dispose();
  assert.equal(calls.length, 2, "concurrent identical requests dispatch exactly once");

  const concurrentBoard = await handleWhiteboard("create", { scene: scene() }, workspace); assert.ok("board" in concurrentBoard);
  let unlockConfig!: () => void, configEntered = false;
  const configGate = new Promise<void>((resolve) => { unlockConfig = resolve; });
  const stale = createWhiteboardDesignManager({ ...options, getConfiguration: async () => { configEntered = true; await configGate; return { ...baseConfig }; } });
  const staleStart = stale.start({ ...body, id: concurrentBoard.board.id, requestId: randomUUID() });
  for (let i = 0; i < 100 && !configEntered; i++) await delay(); assert.ok(configEntered);
  await handleWhiteboard("save", { id: concurrentBoard.board.id, revision: 1, scene: scene() }, workspace);
  unlockConfig(); await assert.rejects(staleStart, (error: unknown) => error instanceof WhiteboardDesignError && error.code === "conflict");
  await waitIdle(); stale.dispose(); assert.equal(calls.length, 2, "a save during async preparation is rejected before dispatch");

  const held = await manager.start({ ...body, requestId: randomUUID(), prompt: "HOLD cancellation fixture" });
  for (let i = 0; i < 100 && !releaseHeld; i++) await delay(); assert.ok(releaseHeld);
  assert.equal((await manager.stop(held.runId, workspace)).status, "stopped"); await waitIdle();
  const release = releaseHeld!; releaseHeld = undefined; release(); await delay();
  assert.deepEqual((await manager.status(held.runId, workspace)).images, [], "late provider completion cannot resurrect a cancelled draft");

  const timeout = createWhiteboardDesignManager({ ...options, timeoutMs: 150 });
  const timed = await timeout.start({ ...body, requestId: randomUUID(), prompt: "HOLD timeout fixture" });
  const timeoutResult = await done(timed.runId, timeout); assert.equal(timeoutResult.status, "failed"); assert.match(timeoutResult.error!, /超时/);
  releaseHeldProvider(); timeout.dispose();
  const failed = await manager.start({ ...body, requestId: randomUUID(), prompt: "ERROR supplier fixture" });
  const failure = await done(failed.runId); assert.equal(failure.status, "failed"); assert.deepEqual(failure.images, []); assert.ok(!JSON.stringify(failure).includes("fixture-secret"));
  const invalidResult = await manager.start({ ...body, requestId: randomUUID(), prompt: "INVALID empty raster fixture" });
  assert.equal((await done(invalidResult.runId)).status, "failed");

  selected = otherWorkspace;
  await assert.rejects(manager.status(first.runId, workspace), (error: unknown) => error instanceof WhiteboardDesignError && error.code === "workspace_changed");
  selected = workspace;
  await assert.rejects(manager.status(randomUUID(), workspace), (error: unknown) => error instanceof WhiteboardDesignError && error.status === 404);
  account.disable(account.users[0]!.id);
  await assert.rejects(manager.status(first.runId, workspace)); account.enable(account.users[0]!.id);
  await account.nativeClient.signIn(account.users[1]!.email, account.password); delete process.env.CCAGENT_ACCOUNT_ID; await enterPlatformAccount();
  await assert.rejects(manager.status(first.runId, workspace), (error: unknown) => error instanceof WhiteboardDesignError && error.code === "not_found");
  await account.nativeClient.signIn(account.users[0]!.email, account.password); delete process.env.CCAGENT_ACCOUNT_ID; await enterPlatformAccount();

  // A rotated/cropped/flipped original must not be paired with a misleading snapshot.
  for (const mutation of [{ angle: 0.2 }, { crop: { x: 1, y: 1, width: 1, height: 1 } }, { scale: [-1, 1] }]) {
    const current = await open(), changed = structuredClone(current.scene); Object.assign(changed.elements[0]!, mutation);
    await handleWhiteboard("save", { id: board.id, revision: current.revision, scene: changed }, workspace);
    await rejected({ ...body, revision: current.revision + 1, requestId: randomUUID() }, "base_image_transformed");
    const latest = await open(); await handleWhiteboard("save", { id: board.id, revision: latest.revision, scene: scene() }, workspace);
  }
  // Bounded retention preserves receipts: replaying an evicted result must never pay again.
  const latest = await open();
  for (let i = 0; i < 9; i++) { const run = await manager.start({ ...body, revision: latest.revision, requestId: randomUUID() }); await done(run.runId); }
  const beforeExpiredReplay = calls.length;
  await assert.rejects(manager.start(body), (error: unknown) => error instanceof WhiteboardDesignError && error.code === "result_expired");
  assert.equal(calls.length, beforeExpiredReplay);

  manager.dispose(); await rejected({ ...body, requestId: randomUUID() }, "unavailable");
  assert.equal(busyEvents.length, idleEvents.length, "every accepted reservation is released once");
  console.log("Whiteboard design tests passed: real account/store isolation; original/reference derivation; strict raster/version/model gates; sync shared reservation; identical retry coalescing; mismatched/replayed ID rejection; owned drafts with no board writes; provider cap; cancellation/timeout/late result; redacted failure; account/workspace checks and bounded retention. No supplier requests were sent.");
} finally {
  manager.dispose(); releaseHeldProvider(); await waitIdle(); await account.close();
  const relative = path.relative(parent, temp); assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
  await fs.rm(temp, { recursive: true, force: true });
}
