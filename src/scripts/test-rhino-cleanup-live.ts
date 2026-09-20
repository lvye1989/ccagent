/** Opt-in native Rhino read-only smoke. Creates only owned viewport captures. */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { observeRhino } from "../tools/rhinoBackend.js";
import { withRhinoTaskCleanup, type RhinoCleanupReport } from "../tools/rhinoArtifacts.js";
import { rhinoProjectPath } from "../tools/rhinoProject.js";

if (!process.argv.includes("--execute")) throw new Error("Pass --execute to capture the open Rhino viewport without modifying geometry.");
assert.notEqual(process.env.CCAGENT_RHINO_AUTO_CLEANUP, "0", "Enable cleanup for this smoke test");
const captureRoot = rhinoProjectPath("previews");
const oldCaptures = await fs.readdir(captureRoot).catch(() => [] as string[]);
const before = await observeRhino({ objectLimit: 500 });
const images: string[] = [];
let report!: RhinoCleanupReport;
const result = await withRhinoTaskCleanup(async () => {
  for (let i = 0; i < 3; i++) {
    const observation = await observeRhino({ capture: true, objectLimit: 500 });
    assert.equal(observation.document.runtime_serial, before.document.runtime_serial);
    const file = String(observation.capturePath);
    assert.equal(path.dirname(file), captureRoot);
    assert.ok((await fs.stat(file)).size > 0);
    images.push(file);
    console.log(`Native viewport capture ${i + 1}/3 complete.`);
  }
  return { reason: "completed", finalText: `最终预览：${images[2]}` };
}, (value) => { report = value; });
const after = await observeRhino({ objectLimit: 500 });
assert.deepEqual(after.objects, before.objects, "Object GUIDs and geometry summaries must not change");
assert.deepEqual(after.layers, before.layers, "Layers must not change");
assert.deepEqual(after.selection, before.selection, "Selection must not change");
assert.equal(after.document.modified, before.document.modified, "Document modified flag must not change");
assert.equal(await fs.stat(images[0]).then(() => true, () => false), false);
assert.equal(await fs.stat(images[1]).then(() => true, () => false), false);
assert.ok(await fs.stat(images[2]));
for (const name of oldCaptures) assert.ok(await fs.lstat(path.join(captureRoot, name)), "Pre-existing capture must be preserved");
console.log(result.finalText);
console.log(JSON.stringify({ passed: true, document: after.document.name, objectCount: after.objects.length,
  removedIntermediateCaptures: report.removed.filter((entry) => images.slice(0, 2).includes(entry.path)).length,
  preservedOldCaptures: oldCaptures.length, finalPreview: images[2], reportPath: report.reportPath }, null, 2));
