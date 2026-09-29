import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { QueryEngine as SourceQueryEngine } from "../src/core/queryEngine.ts";

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = resolve(root, ".tmp", "bytecode-prototype");
const manifest = JSON.parse(readFileSync(resolve(outputDir, "manifest.json"), "utf8"));

assert.equal(manifest.node, process.version, "bytecode requires the build Node version");
assert.equal(manifest.architecture, process.arch, "bytecode requires the build architecture");
assert.equal(existsSync(resolve(outputDir, "core-build.cjs")), false, "intermediate JS was removed");
assert.equal(existsSync(resolve(outputDir, "core-build.cjs.map")), false, "no source map was produced");
const bytes = readFileSync(resolve(outputDir, "core.jsc"));
assert.equal(createHash("sha256").update(bytes).digest("hex"), manifest.sha256);
assert.notEqual(bytes.subarray(0, 2).toString("utf8"), "#!", "artifact is not a JS entrypoint");

const { QueryEngine, MAX_TOOL_TURNS, query, runTools } = require(resolve(outputDir, "load-core.cjs"));
assert.equal(typeof QueryEngine, "function");
assert.equal(typeof query, "function");
assert.equal(typeof runTools, "function");
assert.equal(MAX_TOOL_TURNS, 50);
const options = {
  model: "bytecode-smoke",
  toolContext: { cwd: root },
  initialMessages: [{ role: "user", content: "prototype" }],
};
const engine = new QueryEngine(options);
const sourceEngine = new SourceQueryEngine(options);
assert.equal(engine.getPermissionMode(), "default");
assert.deepEqual(engine.getState(), sourceEngine.getState());
assert.equal(engine.clearContextAndImplement("do the work"), sourceEngine.clearContextAndImplement("do the work"));
assert.deepEqual(engine.getState(), sourceEngine.getState());
assert.match(engine.beginUserTurn(), /^[0-9a-f-]{36}$/);
assert.equal(engine.getCurrentMessageId()?.length, 36);
process.stdout.write(`Bytecode core loaded and QueryEngine smoke check passed on ${process.version}/${process.arch}.\n`);
