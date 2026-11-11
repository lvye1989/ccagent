/** Account credential rotation reaches a retained project process without reloading its environment. */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { removeWebSecret, storeWebSecret, syncWebSecrets, WEB_SECRET_FILE } from "../utils/webSecrets.js";

const generated = /^CCAGENT_WEB_KEY_[A-F0-9]{24}$/;
const flags = ["CCAGENT_HOME", "CCAGENT_ACCOUNT_ID", "CCAGENT_WEB_WORKER_TOKEN", "CCAGENT_DESKTOP_TOKEN", "CCAGENT_DESKTOP_APP", "NODE_TLS_REJECT_UNAUTHORIZED"];
type Result = { id?: number; error?: string; keys?: Record<string, string>; flags?: Record<string, string | undefined>; ignored?: string | null; ready?: boolean };

if (process.env.CCAGENT_SECRET_SYNC_FIXTURE === "1") {
  const snapshot = () => ({
    keys: Object.fromEntries(Object.entries(process.env).filter(([key]) => generated.test(key))),
    flags: Object.fromEntries(flags.map(key => [key, process.env[key]])),
    ignored: process.env.CCAGENT_WEB_KEY_NOT_GENERATED ?? null,
  });
  process.on("message", (message: { id: number; close?: boolean }) => {
    if (message.close) { process.exit(0); return; }
    void syncWebSecrets().then(() => process.send?.({ id: message.id, ...snapshot() }))
      .catch(error => process.send?.({ id: message.id, error: error instanceof Error ? error.message : String(error), ...snapshot() }));
  });
  process.once("disconnect", () => process.exit(0));
  process.send?.({ ready: true });
} else {
  const temporaryRoot = await fs.realpath(os.tmpdir());
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(temporaryRoot, "ccagent-secret-sync-")));
  const home = path.join(temporary, "account"), project = path.join(temporary, "project");
  const priorHome = process.env.CCAGENT_HOME;
  const priorKeys = Object.fromEntries(Object.entries(process.env).filter(([key]) => generated.test(key)));
  let child: ChildProcess | undefined;
  let requestId = 0;
  try {
    await fs.mkdir(home); await fs.mkdir(path.join(project, ".ccagent"), { recursive: true });
    process.env.CCAGENT_HOME = home;
    const reference = await storeWebSecret("model:cross-project-fixture", "fixture-initial-key");
    const variable = reference.slice(2, -1), staleVariable = "CCAGENT_WEB_KEY_" + "C".repeat(24);
    await fs.writeFile(path.join(project, ".env"), `${variable}=project-key-must-not-load\nCCAGENT_ACCOUNT_ID=project-account-must-not-load\n`);
    await fs.writeFile(path.join(project, ".ccagent", "settings.json"), JSON.stringify({ env: { [variable]: "settings-key-must-not-load", CCAGENT_WEB_WORKER_TOKEN: "settings-token-must-not-load" } }));
    const environment: NodeJS.ProcessEnv = { ...process.env, CCAGENT_HOME: home, CCAGENT_SECRET_SYNC_FIXTURE: "1",
      CCAGENT_ACCOUNT_ID: "fixture-account", CCAGENT_WEB_WORKER_TOKEN: "fixture-worker-token", CCAGENT_DESKTOP_TOKEN: "fixture-desktop-token",
      CCAGENT_DESKTOP_APP: "1", NODE_TLS_REJECT_UNAUTHORIZED: "1" };
    for (const key of Object.keys(environment)) if (generated.test(key)) delete environment[key];
    delete environment.CCAGENT_WEB_KEY_NOT_GENERATED;
    environment[staleVariable] = "inherited-stale-key-must-be-removed";
    child = spawn(process.execPath, [...process.execArgv, import.meta.filename], { env: environment, cwd: project, windowsHide: true, stdio: ["ignore", "ignore", "pipe", "ipc"] });
    let childErrors = "";
    child.stderr?.on("data", chunk => { childErrors = (childErrors + String(chunk)).slice(-2000); });
    const owned = child;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Credential fixture did not start: ${childErrors}`)), 10_000);
      owned.once("message", (message: Result) => { clearTimeout(timeout); assert.equal(message.ready, true); resolve(); });
      owned.once("error", reject);
      owned.once("exit", code => { clearTimeout(timeout); reject(new Error(`Credential fixture exited: ${code}; ${childErrors}`)); });
    });
    const synchronize = () => new Promise<Result>((resolve, reject) => {
      const id = ++requestId;
      const timeout = setTimeout(() => { owned.off("message", receive); reject(new Error("Credential fixture sync timed out")); }, 10_000);
      function receive(message: Result) {
        if (message.id !== id) return;
        clearTimeout(timeout); owned.off("message", receive); resolve(message);
      }
      owned.on("message", receive); owned.send({ id });
    });
    const expectedFlags = Object.fromEntries(flags.map(key => [key, environment[key]]));
    let result = await synchronize();
    assert.equal(result.error, undefined); assert.deepEqual(result.keys, { [variable]: "fixture-initial-key" });
    assert.deepEqual(result.flags, expectedFlags, "sync preserves runtime flags and reads no project environment");
    await storeWebSecret("model:cross-project-fixture", "fixture-rotated-key");
    result = await synchronize(); assert.equal(result.keys?.[variable], "fixture-rotated-key", "a retained process observes another process's credential rotation");
    const ragReference = await storeWebSecret("rag:cross-project-fixture", "fixture-rag-key"), ragVariable = ragReference.slice(2, -1);
    result = await synchronize(); assert.equal(result.keys?.[ragVariable], "fixture-rag-key");
    const file = path.join(home, WEB_SECRET_FILE);
    await fs.appendFile(file, flags.map(key => `${key}=store-flag-must-not-load`).join("\n") + "\nCCAGENT_WEB_KEY_NOT_GENERATED=must-not-load\n");
    result = await synchronize(); assert.deepEqual(result.flags, expectedFlags);
    assert.equal(result.ignored, null, "a prefix match alone does not authorize environment injection");
    assert.deepEqual(result.keys, { [variable]: "fixture-rotated-key", [ragVariable]: "fixture-rag-key" }, "only strictly generated names can enter the environment");
    await removeWebSecret(reference);
    result = await synchronize(); assert.deepEqual(result.keys, { [ragVariable]: "fixture-rag-key" }, "removed keys disappear from a retained process");
    const backup = file + ".backup";
    await fs.rename(file, backup); await fs.mkdir(file);
    result = await synchronize(); assert.match(result.error ?? "", /regular file/); assert.deepEqual(result.keys, { [ragVariable]: "fixture-rag-key" });
    await fs.rmdir(file);
    const outside = path.join(temporary, "outside"); await fs.mkdir(outside);
    await fs.symlink(outside, file, "junction");
    result = await synchronize(); assert.match(result.error ?? "", /regular file/); assert.deepEqual(result.keys, { [ragVariable]: "fixture-rag-key" });
    await fs.unlink(file); await fs.rename(backup, file);
    result = await synchronize(); assert.deepEqual(result.keys, { [ragVariable]: "fixture-rag-key" }, "rejected store types do not alter the last valid environment snapshot");
    await fs.unlink(file);
    result = await synchronize(); assert.deepEqual(result.keys, {}, "a missing store clears generated credentials");
    assert.deepEqual(result.flags, expectedFlags);
    console.log("Web secret sync passed: separate retained process, model/RAG creation and rotation, deletion, missing store, strict namespace, unchanged runtime flags, ignored project environment and non-regular/linked store rejection.");
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const owned = child;
      await new Promise<void>(resolve => {
        const timeout = setTimeout(() => owned.kill(), 3000);
        owned.once("exit", () => { clearTimeout(timeout); resolve(); });
        if (owned.connected) owned.send({ close: true }); else owned.kill();
      });
    }
    if (priorHome === undefined) delete process.env.CCAGENT_HOME; else process.env.CCAGENT_HOME = priorHome;
    for (const key of Object.keys(process.env)) if (generated.test(key)) delete process.env[key];
    for (const [key, value] of Object.entries(priorKeys)) process.env[key] = value;
    assert.equal(path.dirname(temporary), temporaryRoot);
    assert.ok(path.basename(temporary).startsWith("ccagent-secret-sync-"));
    await fs.rm(temporary, { recursive: true, force: true });
  }
}
