import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createRhinoProject, getRhinoProjectDirectory, resolveRhinoExportPath, withRhinoProject, rhinoProjectPath, writeRhinoProjectReport } from "../tools/rhinoProject.js";
import { parseRhinoActionInput, preflightRhinoActionWithJev, rhinoInspectTool } from "../tools/rhinoTools.js";
import { allocateRhinoCapture } from "../tools/rhinoArtifacts.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "ccagent-rhino-project-test-"));
const previous = [process.env.CCAGENT_RHINO_PROJECT_DIR, process.env.CCAGENT_RHINO_OUTPUT_ROOT];
delete process.env.CCAGENT_RHINO_PROJECT_DIR;
process.env.CCAGENT_RHINO_OUTPUT_ROOT = path.join(root, "desktop", "CCAGENT-Rhino");
let passed = 0;
function check(value: unknown, text: string) { assert.ok(value, text); console.log(`OK ${++passed}. ${text}`); }
const input = (file: string, operation = "export") => ({ action: "import_export", observation_id: "test", intent: "save model", parameters: { operation, file_path: file } });
try {
  const project = getRhinoProjectDirectory();
  check(project.startsWith(process.env.CCAGENT_RHINO_OUTPUT_ROOT!), "Default project is independent from launch cwd");
  check(createRhinoProject() !== project, "New invocations get collision-free project folders");
  check(resolveRhinoExportPath("models/tower.3dm") === path.join(project, "models", "tower.3dm"), "Relative export goes into project");
  for (const bad of ["../escape.3dm", path.join(process.cwd(), "tower.3dm"), "models/test.3dm:secret", "models/CON.3dm"]) {
    assert.throws(() => resolveRhinoExportPath(bad)); check(true, `Reject unsafe output ${path.basename(bad)}`);
  }
  const parsed = parseRhinoActionInput(input("source.3dm", "import"), root);
  check(parsed.parameters.file_path === path.join(root, "source.3dm"), "Import still resolves against input cwd");
  const normalized = input("models/tower.3dm");
  await preflightRhinoActionWithJev(normalized, { cwd: root });
  check(normalized.parameters.file_path === path.join(project, "models", "tower.3dm"), "Permission gate receives exact resolved output even when observation is stale");
  assert.throws(() => parseRhinoActionInput(input("tower.obj"), root), /Dialog-free/);
  check(true, "Untargeted OBJ export cannot enter a blocking format dialog");
  check(path.dirname(await allocateRhinoCapture()) === path.join(project, "previews"), "Captures belong to the project");
  check(rhinoProjectPath("snapshots", "sample.json") === path.join(project, "snapshots", "sample.json"), "Safety snapshots belong to the project");
  const report = writeRhinoProjectReport("test.json", { completed: true });
  check((JSON.parse(await fs.readFile(report, "utf8"))).completed, "Exclusive task report is persisted");
  assert.throws(() => writeRhinoProjectReport("test.json", {}), /EEXIST/);
  check(true, "Existing reports are not overwritten");
  const dirs = await Promise.all([0, 1].map(() => withRhinoProject(async directory => {
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(getRhinoProjectDirectory(), directory);
    return path.dirname(await allocateRhinoCapture());
  })));
  check(dirs[0] !== dirs[1], "Concurrent task output scopes are isolated");
  const outside = path.join(root, "outside"); await fs.mkdir(outside);
  const link = path.join(project, "redirect");
  await fs.symlink(outside, link, process.platform === "win32" ? "junction" : "dir");
  try { assert.throws(() => resolveRhinoExportPath("redirect/tower.3dm"), /linked/); check(true, "Directory junction cannot redirect export"); }
  finally { await fs.unlink(link); }
  process.env.CCAGENT_RHINO_PROJECT_DIR = process.cwd();
  assert.throws(() => createRhinoProject(), /outside the application/);
  check(true, "Application checkout cannot be configured as project output");
  for (const action of ["measure", "RhinoInspect", "RhinoObserve", "loft", "import_export", "run_grasshopper"]) {
    const result = await rhinoInspectTool.call({ operation: "capabilities", action }, { cwd: root });
    check(!result.isError, `Capabilities supports ${action} without a live Rhino or repeated retries`);
  }
  console.log(`Rhino project: ${passed} checks passed.`);
} finally {
  ["CCAGENT_RHINO_PROJECT_DIR", "CCAGENT_RHINO_OUTPUT_ROOT"].forEach((key, i) => {
    if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i];
  });
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  assert.match(path.basename(root), /^ccagent-rhino-project-test-/);
  await fs.rm(root, { recursive: true, force: true });
}
