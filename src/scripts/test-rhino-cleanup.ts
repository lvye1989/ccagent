import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { allocateRhinoCapture, sealRhinoCapture, protectRhinoArtifact, markRhinoTaskFailure, RhinoJobFiles, withRhinoTaskCleanup, type RhinoCleanupReport } from "../tools/rhinoArtifacts.js";
import { RHINO_AGENT } from "../agents/builtIn/rhinoAgent.js";
import { runChildAgent } from "../agents/runAgent.js";
import { registerMcpTools } from "../tools/index.js";
import type { Tool } from "../tools/Tool.js";
import { resetSettingsCache } from "../config/sources.js";

const taskRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ccagent-cleanup-test-"));
const previousHome = process.env.CCAGENT_HOME;
const previousProject = process.env.CCAGENT_RHINO_PROJECT_DIR;
process.env.CCAGENT_RHINO_PROJECT_DIR = path.join(taskRoot, "project");
const previousCleanup = process.env.CCAGENT_RHINO_AUTO_CLEANUP;
const previousKeep = process.env.CCAGENT_RHINO_KEEP_CAPTURES;
process.env.CCAGENT_HOME = path.join(taskRoot, "user");
await fs.mkdir(process.env.CCAGENT_HOME, { recursive: true });
process.env.CCAGENT_RHINO_AUTO_CLEANUP = "1";
process.env.CCAGENT_RHINO_KEEP_CAPTURES = "1";
const testJobs: RhinoJobFiles[] = [];
let passed = 0;
function check(ok: unknown, label: string): void { assert.ok(ok, label); console.log(`  OK ${++passed}. ${label}`); }
async function exists(file: string): Promise<boolean> { return fs.lstat(file).then(() => true, () => false); }
async function capture(): Promise<string> {
  const file = await allocateRhinoCapture();
  await fs.writeFile(file, `fixture-capture-${path.basename(file)}`);
  await sealRhinoCapture(file);
  return file;
}
async function job(): Promise<RhinoJobFiles> {
  const files = await RhinoJobFiles.create(); testJobs.push(files);
  await fs.writeFile(files.jobPath, '{"kind":"observe"}');
  await fs.writeFile(files.wrapperPath, "# fixed test wrapper");
  await files.sealInputs();
  return files;
}
let report!: RhinoCleanupReport;
const onReport = (value: RhinoCleanupReport) => { report = value; };

try {
  const legacyCapture = await capture(); // No task scope owns this old image.
  const outputs = ["tower.3dm", "tower.obj", "tower.mtl", "material.png", "inputs.gh", "inputs.ghx", "tower.plan.json", "snapshot.json", "empty.obj"];
  for (const file of outputs) await fs.writeFile(path.join(taskRoot, file), file === "empty.obj" ? "" : "user-artifact");
  let images: string[] = [];
  const result = await withRhinoTaskCleanup(async () => {
    images = [await capture(), await capture(), await capture()];
    for (const file of outputs) protectRhinoArtifact(path.join(taskRoot, file), "User input/output");
    const files = await job();
    await fs.writeFile(files.resultPath, '{"ok":true}');
    await files.finish(true);
    check(!(await exists(files.root.path)), "Completed bridge job removes only its known temp files and empty directory");
    return { reason: "completed", finalText: `Reference comparison: ${images[0]}` };
  }, onReport);
  check(await exists(images[0]) && !await exists(images[1]) && await exists(images[2]), "Keep last preview and final-response reference; delete unneeded intermediate capture");
  check((await Promise.all(outputs.map((file) => exists(path.join(taskRoot, file))))).every(Boolean), "Models, OBJ sidecars, GH definitions, plans, snapshots and zero-byte exports preserved");
  check(result.finalText.includes("已删除 4 个") && result.finalText.includes("不可恢复"), "Actual cleanup count and deletion boundary appended to final result");
  const audit = JSON.parse(await fs.readFile(report.reportPath!, "utf8"));
  check(audit.removed.length === 4 && audit.retained.some((entry: any) => entry.reason === "Final preview"), "Cleanup audit records exact removed paths and retained artifacts");
  check(await exists(legacyCapture), "Pre-existing untracked captures are not swept by name, age or extension");

  process.env.CCAGENT_RHINO_KEEP_CAPTURES = "2";
  await withRhinoTaskCleanup(async () => {
    images = [await capture(), await capture(), await capture()];
    return { reason: "completed", finalText: "done" };
  }, onReport);
  check(!await exists(images[0]) && await exists(images[1]) && await exists(images[2]), "Configurable latest-preview count is honored");
  process.env.CCAGENT_RHINO_KEEP_CAPTURES = "1";
  process.env.CCAGENT_RHINO_AUTO_CLEANUP = "0";
  await withRhinoTaskCleanup(async () => {
    images = [await capture(), await capture()];
    return { reason: "completed", finalText: "done" };
  }, onReport);
  check(await exists(images[0]) && report.reason === "disabled", "Debug opt-out preserves intermediate captures");
  process.env.CCAGENT_RHINO_AUTO_CLEANUP = "1";
  for (const reason of ["aborted", "model_error", "max_turns", "blocking_limit"]) {
    await withRhinoTaskCleanup(async () => {
      images = [await capture(), await capture()];
      return { reason, finalText: "incomplete" };
    }, onReport);
    check(await exists(images[0]) && await exists(images[1]), `${reason}: preserve diagnostic captures`);
  }
  await assert.rejects(withRhinoTaskCleanup(async () => {
    images = [await capture(), await capture()]; throw new Error("original failure");
  }, onReport), /original failure/);
  check(await exists(images[0]) && report.reason === "exception", "Thrown errors retain diagnosis and are not replaced by cleanup errors");
  await withRhinoTaskCleanup(async () => {
    images = [await capture(), await capture()]; markRhinoTaskFailure();
    return { reason: "completed", finalText: "One action failed" };
  }, onReport);
  check(await exists(images[0]) && report.reason === "failed_step", "A completed LLM turn does not hide failed modeling steps");

  await withRhinoTaskCleanup(async () => {
    images = [await capture(), await capture()];
    await fs.writeFile(images[0], "user-modified-capture");
    return { reason: "completed", finalText: "done" };
  }, onReport);
  check(await fs.readFile(images[0], "utf8") === "user-modified-capture" && report.warnings.length > 0, "Never delete an owned capture edited after creation");
  const linkedCopy = path.join(taskRoot, "shared-preview.png");
  await withRhinoTaskCleanup(async () => {
    images = [await capture(), await capture()];
    await fs.link(images[0], linkedCopy);
    return { reason: "completed", finalText: "done" };
  }, onReport);
  check(await exists(images[0]) && await exists(linkedCopy) && report.warnings.length > 0, "Hard-linked captures remain untouched");
  await withRhinoTaskCleanup(async () => {
    const files = await job();
    await fs.writeFile(files.jobPath, "user-modified-job");
    await fs.writeFile(path.join(files.root.path, "important.3dm"), "preserve me");
    await fs.writeFile(files.resultPath, '{"ok":true}');
    await files.finish(true);
    check(await exists(files.jobPath) && await exists(path.join(files.root.path, "important.3dm")), "Job cleanup preserves changed inputs and unknown files instead of recursive deletion");
    return { reason: "completed", finalText: "done" };
  }, onReport);
  await withRhinoTaskCleanup(async () => {
    const files = await job();
    await files.finish(false);
    check(await exists(files.jobPath), "A timeout does not delete files potentially still used by Rhino");
    return { reason: "completed", finalText: "no completion marker" };
  }, onReport);
  check(report.retained.some((entry) => entry.reason.includes("completion unconfirmed")), "Unconfirmed bridge jobs are reported as retained");
  let lateJob!: RhinoJobFiles;
  await withRhinoTaskCleanup(async () => {
    lateJob = await job(); await lateJob.finish(false);
    await fs.writeFile(lateJob.resultPath, '{"ok":false,"error":"safe failure"}');
    return { reason: "model_error", finalText: "failed" };
  }, onReport);
  check(!await exists(lateJob.root.path), "Late atomic completion allows safe retry of bridge housekeeping");

  // Replace the registered root with a junction: neither outside file nor the
  // moved original capture may be deleted by finalization.
  const captureRoot = path.join(process.env.CCAGENT_RHINO_PROJECT_DIR!, "previews");
  const movedRoot = path.join(process.env.CCAGENT_RHINO_PROJECT_DIR!, "previews-test-original");
  const outsideRoot = path.join(taskRoot, "outside"); await fs.mkdir(outsideRoot);
  let linked = false;
  try {
    await withRhinoTaskCleanup(async () => {
      images = [await capture(), await capture()];
      await fs.writeFile(path.join(outsideRoot, path.basename(images[0])), "outside-kept");
      await fs.rename(captureRoot, movedRoot);
      await fs.symlink(outsideRoot, captureRoot, process.platform === "win32" ? "junction" : "dir"); linked = true;
      return { reason: "completed", finalText: "done" };
    }, onReport);
    check(await fs.readFile(path.join(outsideRoot, path.basename(images[0])), "utf8") === "outside-kept" && report.warnings.length > 0, "Directory junction replacement cannot redirect cleanup outside the allocated root");
  } finally {
    if (linked) await fs.unlink(captureRoot);
    if (await exists(movedRoot)) await fs.rename(movedRoot, captureRoot);
  }
  const concurrent: Array<{ paths: string[]; report: RhinoCleanupReport }> = [];
  await Promise.all([1, 2].map(async () => {
    const paths: string[] = [];
    await withRhinoTaskCleanup(async () => {
      paths.push(await capture(), await capture()); return { reason: "completed", finalText: "done" };
    }, (r) => concurrent.push({ paths, report: r }));
  }));
  check(concurrent.every(({ paths, report: r }) => r.removed.length === 1 && r.removed[0].path === paths[0]) && concurrent[0].report.taskId !== concurrent[1].report.taskId, "Concurrent agents cannot clean each other's captures");

  // Drive the actual child-agent -> model -> tool -> model -> finally path.
  // Provider traffic is intercepted; no external network or Rhino mutations.
  await fs.writeFile(path.join(process.env.CCAGENT_HOME!, "settings.json"), JSON.stringify({ models: { cleanup_fixture: { protocol: "openai-chat", model: "fixture", baseURL: "https://cleanup.test/v1", apiKey: "TEST_CLEANUP_KEY" } } }));
  process.env.TEST_CLEANUP_KEY = "fixture-only"; resetSettingsCache();
  const fixturePaths: string[] = [];
  const fixtureTool: Tool = {
    name: "CleanupFixture", description: "Test-owned capture fixture", inputSchema: { type: "object", properties: {} },
    isReadOnly: () => true, isEnabled: () => true,
    call: async () => { const file = await capture(); fixturePaths.push(file); return { content: file }; },
  };
  const originalFetch = globalThis.fetch;
  let calls = 0;
  registerMcpTools([fixtureTool]);
  globalThis.fetch = (async () => {
    calls++;
    const chunks = calls === 1
      ? [{ choices: [{ index: 0, delta: { tool_calls: [0, 1, 2].map((index) => ({ index, id: `cleanup-${index}`, type: "function", function: { name: "CleanupFixture", arguments: "{}" } })) }, finish_reason: "tool_calls" }] }]
      : [{ choices: [{ index: 0, delta: { content: `Done. Final preview: ${fixturePaths.at(-1)}` }, finish_reason: "stop" }] }];
    return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });
  }) as typeof fetch;
  try {
    const child = await runChildAgent({
      agentDefinition: { ...RHINO_AGENT, tools: ["CleanupFixture"], maxTurns: 3 }, prompt: "Test the capture cleanup lifecycle.",
      availableTools: [fixtureTool], model: "cleanup_fixture", parentToolContext: { cwd: taskRoot, sessionId: "cleanup-integration" },
      permissionSettings: { allow: [], deny: [], mode: "default" },
    });
    check(child.reason === "completed" && calls === 2 && fixturePaths.length === 3, "Built-in rhino_agent completes actual model-tool-result-model loop");
    check(!await exists(fixturePaths[0]) && !await exists(fixturePaths[1]) && await exists(fixturePaths[2]) && child.finalText.includes("已删除 2 个"), "Built-in agent automatically finalizes cleanup before returning to parent");
  } finally { globalThis.fetch = originalFetch; registerMcpTools([]); delete process.env.TEST_CLEANUP_KEY; }
  console.log(`\nRhino cleanup: ${passed} checks passed.`);
} finally {
  // Test-created roots only. Explicit containment checks before recursive fixture removal.
  for (const files of testJobs) {
    const dir = path.resolve(files.root.path);
    assert.equal(path.dirname(dir), path.resolve(os.tmpdir()));
    assert.match(path.basename(dir), /^ccagent-rhino-/);
    await fs.rm(dir, { recursive: true, force: true });
  }
  assert.equal(path.dirname(path.resolve(taskRoot)), path.resolve(os.tmpdir()));
  assert.match(path.basename(taskRoot), /^ccagent-cleanup-test-/);
  await fs.rm(taskRoot, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env.CCAGENT_HOME; else process.env.CCAGENT_HOME = previousHome;
  if (previousProject === undefined) delete process.env.CCAGENT_RHINO_PROJECT_DIR; else process.env.CCAGENT_RHINO_PROJECT_DIR = previousProject;
  if (previousCleanup === undefined) delete process.env.CCAGENT_RHINO_AUTO_CLEANUP; else process.env.CCAGENT_RHINO_AUTO_CLEANUP = previousCleanup;
  if (previousKeep === undefined) delete process.env.CCAGENT_RHINO_KEEP_CAPTURES; else process.env.CCAGENT_RHINO_KEEP_CAPTURES = previousKeep;
}
