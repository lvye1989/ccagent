/**
 * Stage 36 release verification.
 *
 * Exercises the artifact users actually install: package metadata, bundle,
 * npm file boundary, tarball installation, command aliases, and the runtime
 * Node-version gate. No registry access or model credentials are required.
 *
 * Run: npm run test:stage36
 */

import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DIST_FILE = path.join(PROJECT_ROOT, "dist", "ccagent.js");
const DIST_MAP = `${DIST_FILE}.map`;
const INSTALLER_FILE = path.join(PROJECT_ROOT, "install.sh");
const NPM = process.platform === "win32" ? "npm.cmd" : "npm";

let passed = 0;
let failed = 0;

function section(title: string): void {
  process.stdout.write(`\n\u001b[1m${title}\u001b[0m\n`);
}

function assert(condition: unknown, label: string, detail?: string): void {
  if (condition) {
    passed++;
    process.stdout.write(`  \u001b[32m✓\u001b[0m ${label}\n`);
    return;
  }

  failed++;
  process.stdout.write(`  \u001b[31m✗ ${label}\u001b[0m${detail ? `\n    ${detail}` : ""}\n`);
}

interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

function run(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): CommandResult {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? PROJECT_ROOT,
    env: options.env ?? process.env,
    encoding: "utf-8",
    stdio: "pipe",
  });

  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error,
  };
}

function runNpm(args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): CommandResult {
  // Node cannot reliably spawn a .cmd shim directly on Windows. When this
  // verifier is launched through npm, npm_execpath points at npm-cli.js, which
  // can be invoked portably with the current Node executable.
  const npmCli = process.env.npm_execpath;
  return npmCli
    ? run(process.execPath, [npmCli, ...args], options)
    : run(NPM, args, options);
}

function parseNpmJson<T>(result: CommandResult, label: string): T | undefined {
  if (result.status !== 0) {
    assert(false, label, result.stderr || result.error?.message || `exit ${String(result.status)}`);
    return undefined;
  }

  try {
    return JSON.parse(result.stdout) as T;
  } catch (error) {
    assert(false, label, `invalid npm JSON: ${(error as Error).message}`);
    return undefined;
  }
}

interface PackResult {
  filename: string;
  files: Array<{ path: string; mode: number; size: number }>;
}

async function collectProductionSources(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    if (entry.name === "scripts") continue;
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectProductionSources(absolute)));
    } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
      files.push(absolute);
    }
  }

  return files;
}

const packageJson = JSON.parse(await fs.readFile(path.join(PROJECT_ROOT, "package.json"), "utf-8")) as {
  name: string;
  version: string;
  bin: Record<string, string>;
  files: string[];
  dependencies?: Record<string, string>;
  engines?: { node?: string };
  repository?: unknown;
  homepage?: string;
  bugs?: unknown;
};

section("[1] package contract");
assert(packageJson.name === "ccagent", "package name is ccagent");
assert(
  JSON.stringify(packageJson.bin) === JSON.stringify({ ccagent: "dist/ccagent.js" }),
  "only ccagent is registered",
);
assert(Object.keys(packageJson.dependencies ?? {}).length === 0, "runtime dependencies are empty");
assert(packageJson.engines?.node === ">=22", "Node engine is >=22");
assert(Boolean(packageJson.repository), "repository metadata exists");
assert(Boolean(packageJson.homepage), "homepage metadata exists");
assert(Boolean(packageJson.bugs), "bugs metadata exists");

section("[2] bundle contract");
const [bundle, bundleStat, mapStat] = await Promise.all([
  fs.readFile(DIST_FILE, "utf-8"),
  fs.stat(DIST_FILE),
  fs.stat(DIST_MAP),
]);
assert(bundle.startsWith("#!/usr/bin/env node\n"), "bundle starts with a Node shebang");
assert(
  process.platform === "win32" || (bundleStat.mode & constants.S_IXUSR) !== 0,
  "bundle is executable where POSIX modes apply",
);
assert(bundleStat.size > 0, "bundle is non-empty");
assert(mapStat.size > 0, "source map is non-empty");

const versionResult = run(process.execPath, [DIST_FILE, "--version"]);
assert(versionResult.status === 0, "built --version exits successfully", versionResult.stderr);
assert(versionResult.stdout.trim() === `ccagent ${packageJson.version}`, "built --version matches package.json");

const helpResult = run(process.execPath, [DIST_FILE, "--help"]);
assert(helpResult.status === 0, "built --help exits successfully", helpResult.stderr);
assert(helpResult.stdout.includes("ccagent [options]"), "help documents the ccagent command");
assert(!helpResult.stdout.includes("\n  agent [options]"), "help does not advertise the retired agent command");

const productionSources = await collectProductionSources(path.join(PROJECT_ROOT, "src"));
const hardcodedVersionFiles: string[] = [];
for (const source of productionSources) {
  if ((await fs.readFile(source, "utf-8")).includes(`\"${packageJson.version}\"`)) {
    hardcodedVersionFiles.push(path.relative(PROJECT_ROOT, source));
  }
}
assert(
  hardcodedVersionFiles.length === 0,
  "release version is not hard-coded in production source",
  hardcodedVersionFiles.join(", "),
);

section("[3] npm package boundary");
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ccagent-stage36-"));
const cacheDir = path.join(tempRoot, "npm-cache");
const packDir = path.join(tempRoot, "pack");
const installPrefix = path.join(tempRoot, "prefix");
await Promise.all([
  fs.mkdir(cacheDir, { recursive: true }),
  fs.mkdir(packDir, { recursive: true }),
  fs.mkdir(installPrefix, { recursive: true }),
]);

try {
  const npmEnv: NodeJS.ProcessEnv = { ...process.env, npm_config_cache: cacheDir };
  // `npm publish --dry-run` exports its config into lifecycle scripts. If that
  // flag leaks into the nested install below, npm reports success without
  // creating the prefix and this verification tests nothing. Each nested npm
  // command declares its own dry-run behavior explicitly, so remove the outer
  // lifecycle setting here.
  delete npmEnv.npm_config_dry_run;
  delete npmEnv.NPM_CONFIG_DRY_RUN;
  const dryRun = parseNpmJson<PackResult[]>(
    runNpm(["pack", "--dry-run", "--json", "--ignore-scripts"], { env: npmEnv }),
    "npm pack --dry-run succeeds",
  );

  const expectedFiles = [
    ".env.example",
    "LICENSE",
    "README.md",
    "README.zh-CN.md",
    "dist/ccagent.js",
    "dist/ccagent.js.map",
    "package.json",
  ];
  const packedFiles = dryRun?.[0]?.files.map((file) => file.path).sort() ?? [];
  assert(JSON.stringify(packedFiles) === JSON.stringify(expectedFiles), "tarball contains only release files", packedFiles.join(", "));

  const pack = parseNpmJson<PackResult[]>(
    runNpm(["pack", "--json", "--ignore-scripts", "--pack-destination", packDir], { env: npmEnv }),
    "npm pack succeeds",
  );
  const tarball = pack?.[0]?.filename ? path.join(packDir, pack[0].filename) : undefined;
  assert(Boolean(tarball), "npm reports the generated tarball");

  if (tarball) {
    const install = runNpm(
      ["install", "-g", "--ignore-scripts", "--prefix", installPrefix, tarball],
      { env: npmEnv },
    );
    assert(install.status === 0, "tarball installs in an isolated global prefix", install.stderr);

    const binDir = path.join(installPrefix, process.platform === "win32" ? "" : "bin");
    const commandSuffix = process.platform === "win32" ? ".cmd" : "";
    const ccagentBin = path.join(binDir, `ccagent${commandSuffix}`);
    const retiredBin = path.join(binDir, `agent${commandSuffix}`);

    const [ccagentExists, retiredExists] = await Promise.all([
      fs.access(ccagentBin).then(() => true, () => false),
      fs.access(retiredBin).then(() => true, () => false),
    ]);
    assert(ccagentExists, "installed ccagent command exists");
    assert(!retiredExists, "retired agent command is absent");

    const installed = process.platform === "win32"
      ? run(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", ccagentBin, "--version"])
      : run(ccagentBin, ["--version"]);
    assert(installed.stdout.trim() === `ccagent ${packageJson.version}`, "installed ccagent reports the release version", installed.stderr);

    const installedPackage = path.join(installPrefix, "lib", "node_modules", "ccagent");
    const nestedDependencies = path.join(installedPackage, "node_modules");
    const hasNestedDependencies = await fs.access(nestedDependencies).then(() => true, () => false);
    assert(!hasNestedDependencies, "installed package has no nested dependency tree");
  }

  section("[4] installer contract");
  if (process.platform === "win32") {
    process.stdout.write("  - skipped: install.sh is a POSIX-only installer\n");
  } else {
    const fakeBin = path.join(tempRoot, "fake-bin");
    const npmLog = path.join(tempRoot, "npm.log");
    const fakePrefix = path.join(tempRoot, "npm-prefix");
    await fs.mkdir(fakeBin, { recursive: true });
    const fakeNode = path.join(fakeBin, "node");
    const fakeNpm = path.join(fakeBin, "npm");
    const fakeCCAgent = path.join(fakeBin, "ccagent");
    await Promise.all([
      fs.writeFile(fakeNode, '#!/bin/sh\nprintf "22.22.0\\n"\n', { mode: 0o755 }),
      fs.writeFile(
        fakeNpm,
        `#!/bin/sh\nif [ "$1" = "prefix" ]; then printf '%s\\n' ${JSON.stringify(fakePrefix)}; exit 0; fi\nprintf '%s\\n' "$*" >> ${JSON.stringify(npmLog)}\n`,
        { mode: 0o755 },
      ),
      fs.writeFile(fakeCCAgent, `#!/bin/sh\nprintf 'ccagent ${packageJson.version}\\n'\n`, { mode: 0o755 }),
    ]);

    const installerEnv = {
      ...process.env,
      PATH: `${fakeBin}:/usr/bin:/bin`,
      CCAGENT_VERSION: "next",
    };
    const installerFirst = run("/bin/sh", [INSTALLER_FILE], { env: installerEnv });
    const installerSecond = run("/bin/sh", [INSTALLER_FILE], { env: installerEnv });
    assert(installerFirst.status === 0, "installer succeeds with Node 22", installerFirst.stderr);
    assert(installerSecond.status === 0, "installer is idempotent", installerSecond.stderr);
    const npmCalls = (await fs.readFile(npmLog, "utf-8")).trim().split("\n");
    assert(npmCalls.length === 2, "idempotent install invokes npm once per run");
    assert(
      npmCalls.every((call) => call === "install -g --ignore-scripts ccagent@next"),
      "installer honors CCAGENT_VERSION and disables lifecycle scripts",
      npmCalls.join(" | "),
    );

    await fs.writeFile(fakeNode, '#!/bin/sh\nprintf "20.19.0\\n"\n', { mode: 0o755 });
    const oldInstaller = run("/bin/sh", [INSTALLER_FILE], { env: installerEnv });
    assert(oldInstaller.status === 1, "installer rejects Node 20");
    assert(oldInstaller.stderr.includes("Node.js 22 or newer"), "installer explains the Node requirement");

    await fs.writeFile(fakeNode, '#!/bin/sh\nprintf "22.22.0\\n"\n', { mode: 0o755 });
    await fs.rm(fakeCCAgent);
    const missingPath = run("/bin/sh", [INSTALLER_FILE], { env: installerEnv });
    assert(missingPath.status === 1, "installer fails when the command is not on PATH");
    assert(
      missingPath.stderr.includes(`${fakePrefix}/bin`),
      "installer reports the npm global bin directory",
      missingPath.stderr,
    );
  }

  section("[5] old-Node failure path");
  const simulatedOldNode = run(process.execPath, [
    "--input-type=module",
    "--eval",
    `Object.defineProperty(process.versions, "node", { value: "18.20.0" }); await import(${JSON.stringify(pathToFileURL(DIST_FILE).href)});`,
  ]);
  assert(simulatedOldNode.status === 1, "Node 18 path exits non-zero");
  assert(simulatedOldNode.stderr.includes("requires Node.js 22 or newer"), "Node 18 path prints an actionable message");
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}

process.stdout.write(`\n\u001b[1mStage 36: ${passed} passed, ${failed} failed.\u001b[0m\n`);
if (failed > 0) process.exitCode = 1;
