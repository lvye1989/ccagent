import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = resolve(root, ".tmp", "bytecode-matrix-package");
const matrix = JSON.parse(await readFile(join(packageRoot, "dist", "matrix.json"), "utf8"));
const projectPackage = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const releasePackage = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
assert.equal(matrix.sourceVersion, projectPackage.version);
assert.equal(releasePackage.name, "ccdagent-bytecode");
assert.equal(releasePackage.version, `${projectPackage.version}-beta.1`);
assert.equal(releasePackage.private, undefined);
assert.equal(releasePackage.publishConfig.tag, "beta");
assert.equal(releasePackage.bin["ccagent-bytecode"], "bin/ccagent.cjs");
assert.deepEqual(await readdir(join(packageRoot, "bin")), ["ccagent.cjs"]);
assert.deepEqual(releasePackage.os, [...new Set(matrix.variants.map((item) => item.platform))].sort());
assert.deepEqual(releasePackage.cpu, [...new Set(matrix.variants.map((item) => item.architecture))].sort());
assert.deepEqual(new Set(releasePackage.engines.node.split(" || ")), new Set(matrix.variants.map((item) => item.node.slice(1))));
assert.match(await readFile(join(packageRoot, "README.md"), "utf8"), /npm install -g ccdagent-bytecode@beta/);

for (const variant of matrix.variants) {
  const bytes = await readFile(join(packageRoot, variant.bytecode));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), variant.sha256);
}
await readFile(resolve(packageRoot, "dist", "../rhino/ccagent_rhino_runner.py"));
const selected = matrix.variants.find((item) =>
  item.node === process.version &&
  item.v8 === process.versions.v8 &&
  item.platform === process.platform &&
  item.architecture === process.arch
);
assert.ok(selected, `No matrix variant for ${process.version}/${process.platform}/${process.arch}`);

const testBase = resolve(root, ".tmp", "bytecode-matrix-tests");
if (relative(root, testBase) !== join(".tmp", "bytecode-matrix-tests")) {
  throw new Error("Bytecode matrix test directory must stay inside this workspace");
}
await mkdir(testBase, { recursive: true });
const realTestBase = relative(await realpath(root), await realpath(testBase));
if (!realTestBase || realTestBase === ".." || realTestBase.startsWith(`..${sep}`) || isAbsolute(realTestBase)) {
  throw new Error("Bytecode matrix test directory resolves outside this workspace");
}
const workDir = await mkdtemp(join(testBase, "matrix-"));

function run(args) {
  const result = spawnSync(process.execPath, [join(packageRoot, "bin", "ccagent.cjs"), ...args], {
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
  assert.match(run(["--dump-system-prompt", "--settings", "settings.json"]), /^<SYSTEM_STATIC_CONTEXT>/);
  process.stdout.write(`Bytecode matrix smoke passed: ${selected.id} of ${matrix.variants.length} variant(s).\n`);
} finally {
  const child = relative(testBase, workDir);
  if (!child || child.startsWith("..") || isAbsolute(child) || !basename(workDir).startsWith("matrix-")) {
    throw new Error("Refusing to remove an unexpected bytecode matrix test directory");
  }
  await rm(workDir, { recursive: true, force: true });
}
