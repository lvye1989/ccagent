import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const variantsRoot = resolve(root, ".tmp", "bytecode-cli-variants");
const packageRoot = resolve(root, ".tmp", "bytecode-matrix-package");
if (relative(root, packageRoot) !== join(".tmp", "bytecode-matrix-package")) {
  throw new Error("Bytecode matrix output must stay inside this workspace");
}
await mkdir(dirname(packageRoot), { recursive: true });
const realRoot = await realpath(root);
for (const parent of [dirname(packageRoot), variantsRoot]) {
  const child = relative(realRoot, await realpath(parent));
  if (!child || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new Error("Bytecode matrix input or output resolves outside this workspace");
  }
}
try {
  if ((await lstat(packageRoot)).isSymbolicLink()) {
    throw new Error("Refusing to replace a linked bytecode matrix directory");
  }
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}
const projectPackage = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const dirs = (await readdir(variantsRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
if (dirs.length === 0) throw new Error("Build exact-version CLI bytecode variants first");

await rm(packageRoot, { recursive: true, force: true });
await mkdir(join(packageRoot, "bin"), { recursive: true });
await mkdir(join(packageRoot, "dist", "variants"), { recursive: true });
await mkdir(join(packageRoot, "rhino"), { recursive: true });

const variants = [];
for (const id of dirs) {
  if (!/^\d+-\d+-\d+-(?:win32|linux|darwin)-(?:x64|arm64)$/.test(id)) {
    throw new Error(`Unexpected bytecode variant directory: ${id}`);
  }
  const sourceDist = join(variantsRoot, id, "dist");
  const manifest = JSON.parse(await readFile(join(sourceDist, "manifest.json"), "utf8"));
  if (manifest.sourceVersion !== projectPackage.version) {
    throw new Error(`Stale bytecode variant ${id}: ${manifest.sourceVersion}`);
  }
  const bytes = await readFile(join(sourceDist, "ccagent.jsc"));
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== manifest.sha256) throw new Error(`Bytecode checksum mismatch: ${id}`);
  const target = join(packageRoot, "dist", "variants", id);
  await mkdir(target, { recursive: true });
  await copyFile(join(sourceDist, "ccagent.jsc"), join(target, "ccagent.jsc"));
  variants.push({
    id,
    node: manifest.node,
    v8: manifest.v8,
    platform: manifest.platform,
    architecture: manifest.architecture,
    sha256,
    bytecode: `dist/variants/${id}/ccagent.jsc`,
  });
}

await writeFile(join(packageRoot, "dist", "matrix.json"), JSON.stringify({
  sourceVersion: projectPackage.version,
  variants,
}, null, 2) + "\n");
const supportedNodes = [...new Set(variants.map((item) => item.node.slice(1)))].sort((a, b) =>
  a.localeCompare(b, undefined, { numeric: true })
);
const supportedPlatforms = [...new Set(variants.map((item) => item.platform))].sort();
const supportedArchitectures = [...new Set(variants.map((item) => item.architecture))].sort();
await writeFile(join(packageRoot, "bin", "ccagent.cjs"), [
  "#!/usr/bin/env node",
  'const path = require("node:path");',
  'const { pathToFileURL } = require("node:url");',
  'const matrix = require("../dist/matrix.json");',
  "const selected = matrix.variants.find((item) => item.node === process.version && item.v8 === process.versions.v8 && item.platform === process.platform && item.architecture === process.arch);",
  "if (!selected) {",
  '  const available = matrix.variants.filter((item) => item.platform === process.platform && item.architecture === process.arch).map((item) => item.node).join(", ");',
  '  console.error(`No protected ccagent bytecode for ${process.version}/${process.platform}/${process.arch}. Available exact Node versions: ${available || "none"}.`);',
  "  process.exit(1);",
  "}",
  "globalThis.__CCAGENT_BYTECODE_VIRTUAL_URL__ = pathToFileURL(path.join(__dirname, '..', 'dist', 'ccagent.jsc')).href;",
  'require("bytenode");',
  'require(path.join(__dirname, "..", selected.bytecode));',
  "",
].join("\n"));
await writeFile(join(packageRoot, "package.json"), JSON.stringify({
  name: "ccdagent-bytecode",
  version: `${projectPackage.version}-beta.1`,
  description: "Bytecode beta of the CCAGENT terminal CLI for exact Node.js versions",
  license: "MIT",
  type: "commonjs",
  bin: { "ccagent-bytecode": "bin/ccagent.cjs" },
  files: ["bin", "dist", "rhino", "README.md", "LICENSE"],
  os: supportedPlatforms,
  cpu: supportedArchitectures,
  engines: { node: supportedNodes.join(" || ") },
  publishConfig: { access: "public", registry: "https://registry.npmjs.org/", tag: "beta" },
  dependencies: { bytenode: "1.7.0" },
}, null, 2) + "\n");
await writeFile(join(packageRoot, "README.md"), [
  "# ccdagent-bytecode (beta)",
  "",
  `Bytecode build of CCAGENT ${projectPackage.version}. This package is separate from \`ccdagent\`.`,
  "",
  "## Install",
  "",
  "```sh",
  "npm install -g ccdagent-bytecode@beta",
  "ccagent-bytecode --version",
  "```",
  "",
  `Supported operating system(s): ${supportedPlatforms.join(", ")}.`,
  `Supported architecture(s): ${supportedArchitectures.join(", ")}.`,
  `Supported exact Node.js version(s): ${supportedNodes.join(", ")}.`,
  "Run `node --version` to check your installed version. Other versions are not yet included.",
  "",
  "The application JavaScript bundle is distributed as V8 bytecode (`.jsc`).",
  "The small CLI loader, manifest, and Rhino Python runtime files remain readable.",
  "Bytecode raises the effort of reading the application code; it is not encryption.",
  "",
].join("\n"));
for (const name of [
  "ccagent_rhino_runner.py",
  "ccagent_rhino_architecture.py",
  "ccagent_rhino_toolkit.py",
  "ccagent_grasshopper.py",
  "TOOLKIT.md",
]) {
  await copyFile(join(root, "rhino", name), join(packageRoot, "rhino", name));
}
await copyFile(join(root, "LICENSE"), join(packageRoot, "LICENSE"));
process.stdout.write(`Built protected matrix with ${variants.length} exact-version variant(s): ${variants.map((item) => item.node).join(", ")}\n`);
