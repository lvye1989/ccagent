#!/usr/bin/env tsx

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { bashTool, isReadOnlyCommand } from "../tools/bashTool.js";
import { fileReadTool } from "../tools/fileReadTool.js";
import { globTool } from "../tools/globTool.js";
import { grepTool } from "../tools/grepTool.js";
import { powerShellTool } from "../tools/powerShellTool.js";
import { toolResultText } from "../tools/Tool.js";
import { resolveBashExecutable } from "../utils/bashExecutable.js";
import { readTrustedStringArraySetting } from "../utils/settings.js";
import { setAdditionalAllowedRoots } from "../tools/pathUtils.js";
import { getToolTempRoot } from "../utils/paths.js";

const failures: string[] = [];

function assert(condition: unknown, label: string): void {
  console.log(`  [${condition ? "PASS" : "FAIL"}] ${label}`);
  if (!condition) failures.push(label);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function main(): Promise<void> {
  console.log("\n[1] Bash executable resolution");
  const savedOverride = process.env.CCAGENT_BASH;
  process.env.CCAGENT_BASH = "C:/custom/bash.exe";
  assert(resolveBashExecutable() === "C:/custom/bash.exe", "CCAGENT_BASH explicitly overrides shell discovery");
  if (savedOverride === undefined) delete process.env.CCAGENT_BASH;
  else process.env.CCAGENT_BASH = savedOverride;

  const savedShell = process.env.SHELL;
  if (process.platform === "win32") {
    process.env.SHELL = "C:\\Windows\\System32\\bash.exe";
    assert(
      !/[/\\]Windows[/\\]System32[/\\]bash\.exe$/i.test(resolveBashExecutable()),
      "an inherited WSL bash.exe SHELL value is rejected",
    );
  }
  if (savedShell === undefined) delete process.env.SHELL;
  else process.env.SHELL = savedShell;

  const executable = resolveBashExecutable();
  if (process.platform === "win32") {
    assert(
      !/[/\\]Windows[/\\]System32[/\\]bash\.exe$/i.test(executable),
      "Windows does not select the WSL bash.exe launcher when Git Bash is installed",
    );
  } else {
    assert(Boolean(executable), "non-Windows platforms resolve a Bash executable");
  }

  console.log("\n[2] Native absolute path execution");
  const packagePath = path.join(process.cwd(), "package.json").replace(/\\/g, "/");
  const result = await bashTool.call(
    { command: `wc -l "${packagePath}"` },
    { cwd: process.cwd() },
  );
  const output = toolResultText(result.content);
  assert(result.isError !== true, "Bash accepts the native absolute workspace path");
  assert(output.includes("package.json"), "wc reads the requested native path");

  console.log("\n[3] Cancellation, timeout, and read-only classification");
  const badTimeout = await bashTool.call(
    { command: "printf should-not-run", timeout: -1 },
    { cwd: process.cwd() },
  );
  assert(badTimeout.isError === true, "Bash rejects negative timeouts");

  const aborted = new AbortController();
  aborted.abort();
  const preAborted = await bashTool.call(
    { command: "printf should-not-run" },
    { cwd: process.cwd(), abortSignal: aborted.signal },
  );
  assert(preAborted.isError === true, "Bash does not spawn a pre-aborted command");
  assert(!isReadOnlyCommand("cat package.json; rm output.txt"), "semicolon mutation is not read-only");
  assert(!isReadOnlyCommand("cat package.json > output.txt"), "output redirection is not read-only");
  assert(!isReadOnlyCommand("cat $(rm output.txt)"), "command substitution is not read-only");
  assert(isReadOnlyCommand("git status && rg TODO src"), "ordinary chained inspection stays read-only");

  if (process.platform === "win32") {
    const psBadTimeout = await powerShellTool.call(
      { command: "Write-Output should-not-run", timeout: 0 },
      { cwd: process.cwd() },
    );
    assert(psBadTimeout.isError === true, "PowerShell rejects invalid timeouts");
    const psPreAborted = await powerShellTool.call(
      { command: "Write-Output should-not-run" },
      { cwd: process.cwd(), abortSignal: aborted.signal },
    );
    assert(psPreAborted.isError === true, "PowerShell does not spawn a pre-aborted command");

    const previousHome = process.env.CCAGENT_HOME;
    const isolatedHome = await fs.mkdtemp(path.join(os.tmpdir(), "ccagent-shell-temp-home-"));
    process.env.CCAGENT_HOME = path.join(isolatedHome, ".ccagent");
    try {
      const tempProbe = await powerShellTool.call(
        {
          command:
            "$p = Join-Path $env:TEMP 'word_content_check.txt'; " +
            "Set-Content -LiteralPath $p -Value 'word temp bridge'; " +
            "Write-Output $p",
        },
        { cwd: process.cwd() },
      );
      const expectedPath = path.join(getToolTempRoot(), "word_content_check.txt");
      assert(tempProbe.isError !== true && await fs.access(expectedPath).then(() => true).catch(() => false),
        "PowerShell redirects $env:TEMP into the private CCAGENT temp directory");
      const readable = await fileReadTool.call(
        { file_path: expectedPath },
        { cwd: process.cwd() },
      );
      assert(
        readable.isError !== true && toolResultText(readable.content).includes("word temp bridge"),
        "Read can consume a temporary Word inspection artifact created by PowerShell",
      );

      const unrelatedTemp = path.join(os.tmpdir(), `ccagent-unrelated-${process.pid}.txt`);
      await fs.writeFile(unrelatedTemp, "must stay outside the boundary", "utf-8");
      try {
        const blocked = await fileReadTool.call(
          { file_path: unrelatedTemp },
          { cwd: process.cwd() },
        );
        assert(
          blocked.isError === true,
          "Read still blocks unrelated files in the operating-system temp directory",
        );
      } finally {
        await fs.rm(unrelatedTemp, { force: true });
      }
    } finally {
      if (previousHome === undefined) delete process.env.CCAGENT_HOME;
      else process.env.CCAGENT_HOME = previousHome;
      await fs.rm(isolatedHome, { recursive: true, force: true });
    }
  }

  console.log("\n[4] Grep, Glob, Read, and no-ripgrep fallback");
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ccagent-tool-regression-"));
  try {
    await fs.writeFile(path.join(tmp, "sample.txt"), "alpha\n--version\nomega\n", "utf8");
    await fs.mkdir(path.join(tmp, "nested"));
    await fs.writeFile(path.join(tmp, "nested", "other.ts"), "const fallback = true;\n", "utf8");

    if (process.platform === "win32") {
      const pidPath = path.join(tmp, "child.pid").replace(/\\/g, "/");
      const childScript = `require("fs").writeFileSync("${pidPath}",String(process.pid));setInterval(()=>{},1000)`;
      const timedOut = await bashTool.call(
        { command: `node -e ${shellQuote(childScript)}`, timeout: 300 },
        { cwd: tmp },
      );
      assert(timedOut.isError === true, "Bash timeout returns an error");
      const childPid = Number(await fs.readFile(path.join(tmp, "child.pid"), "utf8"));
      await new Promise((resolve) => setTimeout(resolve, 100));
      let childAlive = false;
      try { process.kill(childPid, 0); childAlive = true; } catch { childAlive = false; }
      assert(!childAlive, "Bash timeout terminates the Windows child process tree");
    }

    const optionPattern = await grepTool.call({ pattern: "--version", path: tmp }, { cwd: tmp });
    const optionText = toolResultText(optionPattern.content);
    assert(optionPattern.isError !== true, "Grep treats leading-dash patterns as regex text");
    assert(optionText.includes("sample.txt") && !optionText.includes("ripgrep 15"), "Grep does not execute --version");
    const shortOptionPattern = await grepTool.call(
      { pattern: "-e", path: tmp, timeout: 2_000 },
      { cwd: tmp },
    );
    assert(shortOptionPattern.isError !== true, "Grep '-e' completes instead of waiting on stdin");
    const abortedGrep = await grepTool.call(
      { pattern: "alpha", path: tmp },
      { cwd: tmp, abortSignal: aborted.signal },
    );
    assert(abortedGrep.isError === true, "Grep does not start a pre-aborted search");

    const noMatch = await globTool.call(
      { pattern: "**/*.definitely-missing", path: tmp },
      { cwd: tmp },
    );
    assert(noMatch.isError !== true, "Glob reports no matches as a successful empty result");
    const abortedGlob = await globTool.call(
      { pattern: "**/*", path: tmp },
      { cwd: tmp, abortSignal: aborted.signal },
    );
    assert(abortedGlob.isError === true, "Glob does not start a pre-aborted search");

    const badBase = await globTool.call(
      { pattern: "*.txt", path: path.join(tmp, "sample.txt") },
      { cwd: tmp },
    );
    assert(badBase.isError === true, "Glob explains that its base path must be a directory");

    const badOffset = await fileReadTool.call(
      { file_path: "sample.txt", offset: 0 },
      { cwd: tmp },
    );
    assert(badOffset.isError === true, "Read rejects a non-positive offset");
    const badLimit = await fileReadTool.call(
      { file_path: "sample.txt", limit: 0 },
      { cwd: tmp },
    );
    assert(badLimit.isError === true, "Read rejects a non-positive limit");

    const savedRg = process.env.CCAGENT_RG;
    process.env.CCAGENT_RG = "ccagent-rg-does-not-exist";
    const fallbackGrep = await grepTool.call(
      { pattern: "fallback", path: tmp, include: "**/*.ts" },
      { cwd: tmp },
    );
    assert(fallbackGrep.isError !== true, "Grep has a cross-platform fallback when rg is unavailable");
    assert(toolResultText(fallbackGrep.content).includes("other.ts"), "fallback Grep returns the expected match");
    const fallbackGlob = await globTool.call(
      { pattern: "**/*.ts", path: tmp },
      { cwd: tmp },
    );
    assert(fallbackGlob.isError !== true, "Glob has a cross-platform fallback when rg is unavailable");
    assert(toolResultText(fallbackGlob.content).includes("other.ts"), "fallback Glob returns the expected file");
    if (savedRg === undefined) delete process.env.CCAGENT_RG;
    else process.env.CCAGENT_RG = savedRg;
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }

  const externalPath = process.argv[2];
  if (externalPath) {
    console.log("\n[5] Configured external path");
    const roots = await readTrustedStringArraySetting(process.cwd(), "additionalDirectories");
    setAdditionalAllowedRoots(roots);
    const externalResult = await bashTool.call(
      { command: `wc -l ${shellQuote(externalPath.replace(/\\/g, "/"))}` },
      { cwd: process.cwd() },
    );
    assert(externalResult.isError !== true, "Bash reads the requested external Windows path");

    const grepResult = await grepTool.call(
      {
        pattern: "async def autopaper_start|EXPLORING|def _explore|search_sources",
        path: externalPath,
      },
      { cwd: process.cwd() },
    );
    const grepOutput = toolResultText(grepResult.content);
    assert(grepResult.isError !== true, "Grep accepts the configured additional directory");
    assert(
      grepOutput.includes("autopaper_start") && grepOutput.includes("EXPLORING"),
      "Grep returns the expected server.py matches",
    );

    const globResult = await globTool.call(
      { pattern: path.basename(externalPath), path: path.dirname(externalPath) },
      { cwd: process.cwd() },
    );
    assert(globResult.isError !== true, "Glob accepts the configured additional directory");
    assert(
      toolResultText(globResult.content).includes(path.basename(externalPath)),
      "Glob finds the requested external file",
    );
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} Bash path test(s) failed.`);
    process.exitCode = 1;
    return;
  }
  console.log(`\nAll Bash path tests passed with: ${executable}`);
}

await main();
