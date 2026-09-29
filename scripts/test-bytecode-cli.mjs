import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const variantId = `${process.version.slice(1).replaceAll(".", "-")}-${process.platform}-${process.arch}`;
const packageRoot = resolve(root, ".tmp", "bytecode-cli-variants", variantId);
const dist = join(packageRoot, "dist");
const loader = join(dist, "ccagent.cjs");
const manifest = JSON.parse(await readFile(join(dist, "manifest.json"), "utf8"));
const projectPackage = JSON.parse(await readFile(join(root, "package.json"), "utf8"));

assert.equal(manifest.node, process.version);
assert.equal(manifest.v8, process.versions.v8);
assert.equal(manifest.architecture, process.arch);
const bytecode = await readFile(join(dist, "ccagent.jsc"));
assert.equal(createHash("sha256").update(bytecode).digest("hex"), manifest.sha256);
assert.deepEqual((await readdir(dist)).sort(), ["ccagent.cjs", "ccagent.jsc", "manifest.json"]);
for (const name of ["ccagent_rhino_runner.py", "ccagent_rhino_architecture.py", "ccagent_rhino_toolkit.py", "ccagent_grasshopper.py"]) {
  await readFile(join(packageRoot, "rhino", name));
}

const testBase = resolve(root, ".tmp", "bytecode-cli-tests");
if (relative(root, testBase) !== join(".tmp", "bytecode-cli-tests")) {
  throw new Error("Bytecode test directory must stay inside this workspace");
}
await mkdir(testBase, { recursive: true });
const realTestBase = relative(await realpath(root), await realpath(testBase));
if (!realTestBase || realTestBase === ".." || realTestBase.startsWith(`..${sep}`) || isAbsolute(realTestBase)) {
  throw new Error("Bytecode test directory resolves outside this workspace");
}
const workDir = await mkdtemp(join(testBase, `${variantId}-`));

function run(args) {
  const result = spawnSync(process.execPath, [loader, ...args], {
    cwd: workDir,
    encoding: "utf8",
    windowsHide: true,
    timeout: 20_000,
    env: { ...process.env, CCAGENT_HOME: join(workDir, "home") },
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}

try {
  await writeFile(join(workDir, "settings.json"), "{}\n");
  assert.equal(run(["--version"]).trim(), `ccagent ${projectPackage.version}`);
  assert.match(run(["--help"]), /Usage:\s+ccagent/);
  assert.match(run(["init", "--help"]), /Usage: ccagent init/);
  assert.match(run(["--dump-system-prompt", "--settings", "settings.json"]), /^<SYSTEM_STATIC_CONTEXT>/);
  process.stdout.write(`Bytecode CLI smoke passed: ${variantId}, ${bytecode.length} bytes.\n`);
} finally {
  const child = relative(testBase, workDir);
  if (!child || child.startsWith("..") || isAbsolute(child) || !basename(workDir).startsWith(`${variantId}-`)) {
    throw new Error("Refusing to remove an unexpected bytecode test directory");
  }
  await rm(workDir, { recursive: true, force: true });
}
