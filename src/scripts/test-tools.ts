#!/usr/bin/env tsx
import { loadEnv } from "../utils/loadEnv.js";
loadEnv();
/**
 * Phase 3 verification script — Test tool interface and FileReadTool.
 *
 * Tests:
 *   1. Tool registry works (getAllTools, findToolByName)
 *   2. FileReadTool can read a file with line numbers
 *   3. FileReadTool handles offset/limit
 *   4. FileReadTool handles errors (missing file)
 *   5. Tools convert to API parameter format
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getAllTools, findToolByName, getToolsApiParams } from "../tools/index.js";
import { fileEditTool } from "../tools/fileEditTool.js";
import { fileReadTool } from "../tools/fileReadTool.js";
import { fileWriteTool } from "../tools/fileWriteTool.js";
import { grepTool } from "../tools/grepTool.js";
import { globTool } from "../tools/globTool.js";
import { multiEditTool } from "../tools/multiEditTool.js";
import { toolResultText, type ToolContext } from "../tools/Tool.js";

const ctx: ToolContext = { cwd: process.cwd() };

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
  console.log(`✓ ${message}`);
}

async function main() {
  console.log("── Phase 3: Tool Interface Verification ──\n");

  // 1. Registry
  const tools = getAllTools();
  console.log(`✓ getAllTools() returned ${tools.length} tool(s): [${tools.map(t => t.name).join(", ")}]`);

  const readTool = findToolByName("Read");
  if (!readTool) {
    console.error("✗ findToolByName('Read') returned undefined");
    process.exit(1);
  }
  console.log(`✓ findToolByName('Read') → ${readTool.name}`);
  console.log(`  isReadOnly: ${readTool.isReadOnly()}, isEnabled: ${readTool.isEnabled()}`);

  // 2. Read package.json
  console.log("\n── Test: Read package.json ──\n");
  const result = await readTool.call({ file_path: "package.json" }, ctx);
  if (result.isError) {
    console.error(`✗ Error reading package.json: ${toolResultText(result.content)}`);
    process.exit(1);
  }
  const lines = toolResultText(result.content).split("\n");
  console.log(`✓ Read package.json (${lines.length} output lines)`);
  // Show first 5 lines
  for (const line of lines.slice(0, 6)) {
    console.log(`  ${line}`);
  }
  console.log("  ...");

  // 3. Read with offset/limit
  console.log("\n── Test: Read with offset=3, limit=5 ──\n");
  const partial = await readTool.call({ file_path: "package.json", offset: 3, limit: 5 }, ctx);
  if (partial.isError) {
    console.error(`✗ Error: ${partial.content}`);
    process.exit(1);
  }
  console.log(`✓ Partial read:`);
  for (const line of toolResultText(partial.content).split("\n").slice(0, 7)) {
    console.log(`  ${line}`);
  }

  // 4. Error handling — missing file
  console.log("\n── Test: Read non-existent file ──\n");
  const missing = await readTool.call({ file_path: "does-not-exist.txt" }, ctx);
  if (!missing.isError) {
    console.error("✗ Expected isError=true for missing file");
    process.exit(1);
  }
  console.log(`✓ Correctly returned error: ${toolResultText(missing.content).split("\n")[0]}`);

  // 5. Mutating file tools + symlink boundary
  console.log("\n── Test: Write/Edit/MultiEdit and real-path boundary ──\n");
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ccagent-file-tools-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "ccagent-file-tools-outside-"));
  const tmpCtx: ToolContext = { cwd: tmp };
  try {
    const written = await fileWriteTool.call(
      { file_path: "nested/example.txt", content: "alpha beta beta\n" },
      tmpCtx,
    );
    assert(written.isError !== true, "Write creates parent directories and a UTF-8 file");

    const edited = await fileEditTool.call(
      { file_path: "nested/example.txt", old_string: "alpha", new_string: "omega" },
      tmpCtx,
    );
    assert(edited.isError !== true, "Edit replaces a unique match");

    const filePath = path.join(tmp, "nested", "example.txt");
    const beforeAtomicFailure = await fs.readFile(filePath, "utf8");
    const atomicFailure = await multiEditTool.call(
      {
        file_path: "nested/example.txt",
        edits: [
          { old_string: "omega", new_string: "first" },
          { old_string: "does-not-exist", new_string: "never" },
        ],
      },
      tmpCtx,
    );
    assert(atomicFailure.isError === true, "MultiEdit rejects a batch when one edit fails");
    assert(
      (await fs.readFile(filePath, "utf8")) === beforeAtomicFailure,
      "MultiEdit failure leaves the file unchanged",
    );

    const multiEdited = await multiEditTool.call(
      {
        file_path: "nested/example.txt",
        edits: [
          { old_string: "omega", new_string: "first" },
          { old_string: "beta", new_string: "second", replace_all: true },
        ],
      },
      tmpCtx,
    );
    assert(multiEdited.isError !== true, "MultiEdit applies ordered edits atomically");
    const readBack = await fileReadTool.call({ file_path: "nested/example.txt" }, tmpCtx);
    assert(
      toolResultText(readBack.content).includes("first second second"),
      "Read observes the final edited content",
    );

    await fs.writeFile(path.join(outside, "outside.txt"), "outside boundary\n", "utf8");
    let symlinkCreated = false;
    try {
      await fs.symlink(outside, path.join(tmp, "escape"), process.platform === "win32" ? "junction" : "dir");
      symlinkCreated = true;
    } catch (error) {
      console.log(`· symlink boundary check skipped: ${(error as Error).message}`);
    }
    if (symlinkCreated) {
      const escapedRead = await fileReadTool.call({ file_path: "escape/outside.txt" }, tmpCtx);
      assert(escapedRead.isError === true, "Read blocks a workspace symlink that escapes allowed roots");
      const escapedWrite = await fileWriteTool.call(
        { file_path: "escape/new.txt", content: "blocked" },
        tmpCtx,
      );
      assert(escapedWrite.isError === true, "Write blocks a parent symlink that escapes allowed roots");
      const escapedGrep = await grepTool.call({ pattern: "outside", path: "escape" }, tmpCtx);
      assert(escapedGrep.isError === true, "Grep blocks a directory symlink that escapes allowed roots");
      const escapedGlob = await globTool.call({ pattern: "**/*", path: "escape" }, tmpCtx);
      assert(escapedGlob.isError === true, "Glob blocks a directory symlink that escapes allowed roots");
    }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }

  // 6. API params format
  console.log("\n── Test: API parameter conversion ──\n");
  const apiParams = getToolsApiParams();
  console.log(`✓ getToolsApiParams() returned ${apiParams.length} tool(s)`);
  for (const p of apiParams) {
    console.log(`  - ${p.name}: ${p.description?.slice(0, 60)}...`);
    console.log(`    input_schema.properties: [${Object.keys(p.input_schema.properties ?? {}).join(", ")}]`);
  }

  console.log("\n✓ Phase 3 tool verification passed!\n");
}

main().catch((err) => {
  console.error(`\n✗ Fatal: ${err.message}`);
  process.exit(1);
});
