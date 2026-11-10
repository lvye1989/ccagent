import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rename, symlink, rm, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WebModelFiles } from "../entrypoint/webModelFiles.js";

const temp = await realpath(await mkdtemp(path.join(os.tmpdir(), "ccagent-model-files-")));
const registry = path.join(temp, "account", "model-files"), root = path.join(temp, "Rhino project");
const session = "11111111-1111-4111-8111-111111111111", other = "22222222-2222-4222-8222-222222222222";
try {
  await mkdir(path.join(root, "models"), { recursive: true });
  const file = path.join(root, "models", "模型 '& $(test).3dm");
  const header = "3D Geometry File Format 80\nfixture\n";
  await writeFile(file, header);
  const store = new WebModelFiles(registry);
  const artifact = await store.register(session, file, root);
  assert.equal(artifact.path, file);
  assert.equal(artifact.persistent, true);
  const restored = new WebModelFiles(registry);
  assert.deepEqual(await restored.list(session), [artifact], "Export cards survive server restart");
  const launches: string[] = [];
  const launch = async (file: string) => { launches.push(file); };
  await restored.open(session, artifact.id, launch);
  assert.deepEqual(launches, [file], "Exact Chinese/spaced/metacharacter path is passed as data to the opener");
  await assert.rejects(restored.open(other, artifact.id, launch), /当前对话/);
  await assert.rejects(new WebModelFiles(path.join(temp, "another-account")).open(session, artifact.id, launch), /当前对话/);
  await assert.rejects(restored.open("../escape", artifact.id, launch), /无效/);
  await assert.rejects(store.register(session, path.join(root, "missing.3dm"), root));
  const outside = path.join(temp, "outside.3dm"); await writeFile(outside, header);
  await assert.rejects(store.register(session, outside, root), /文件/);
  const wrongFormat = path.join(root, "not-a-model.3dm"); await writeFile(wrongFormat, "powershell.exe");
  await assert.rejects(store.register(session, wrongFormat, root), /格式/);
  await rename(file, file + ".moved");
  await assert.rejects(restored.open(session, artifact.id, launch), /已移动/);
  await rename(file + ".moved", file);
  await writeFile(file, "not a Rhino model");
  await assert.rejects(restored.open(session, artifact.id, launch), /格式/);
  await writeFile(file, header);
  const linkedRoot = path.join(temp, "linked-project");
  await symlink(root, linkedRoot, "junction");
  await assert.rejects(store.register(session, path.join(linkedRoot, "models", path.basename(file)), linkedRoot), /文件/);
  const nested = path.join(root, "linked-models");
  await symlink(path.dirname(outside), nested, "junction");
  await assert.rejects(store.register(session, path.join(nested, path.basename(outside)), root), /文件/);
  const transient = await store.register(other, file, root, true);
  assert.equal(transient.persistent, false);
  assert.deepEqual(await new WebModelFiles(registry).list(other), [], "Temporary chat exports are not persisted");
  assert.deepEqual(launches, [file], "Invalid, moved and cross-session files never launch an app");
  console.log("Model file delivery: persistence, explicit open, exact path, account/session isolation, traversal, missing/changed files, junctions and temporary chat passed.");
} finally {
  // Only this explicitly allocated test directory is removed; unlink junctions first.
  for (const file of [path.join(temp, "linked-project"), path.join(root, "linked-models")]) await rm(file, { force: true }).catch(() => {});
  if (path.dirname(temp) !== await realpath(os.tmpdir()) || !path.basename(temp).startsWith("ccagent-model-files-")) throw new Error("Unexpected test cleanup target");
  await rm(temp, { recursive: true, force: true });
}
