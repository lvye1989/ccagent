import { createHash } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const require = createRequire(import.meta.url);
const bytenode = require("bytenode");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = resolve(root, ".tmp", "bytecode-prototype");
if (relative(root, outputDir) !== join(".tmp", "bytecode-prototype")) {
  throw new Error("Bytecode prototype output must stay inside this workspace");
}

const sourceBundle = join(outputDir, "core-build.cjs");
const bytecodeFile = join(outputDir, "core.jsc");
const loaderFile = join(outputDir, "load-core.cjs");
const manifestFile = join(outputDir, "manifest.json");
const packageFile = join(outputDir, "package.json");

await mkdir(outputDir, { recursive: true });
for (const artifact of [bytecodeFile, loaderFile, manifestFile, packageFile]) {
  await unlink(artifact).catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  });
}
try {
  const result = await build({
    stdin: {
      contents: [
        'export { QueryEngine } from "./src/core/queryEngine.ts";',
        'export { MAX_TOOL_TURNS, query, runTools } from "./src/core/agenticLoop.ts";',
      ].join("\n"),
      resolveDir: root,
      sourcefile: "core-bytecode-entry.ts",
      loader: "ts",
    },
    outfile: sourceBundle,
    platform: "node",
    format: "cjs",
    target: "node22",
    bundle: true,
    splitting: false,
    sourcemap: false,
    metafile: true,
    banner: {
      js: 'const __ccagentBytecodeUrl = require("node:url").pathToFileURL(__filename).href;',
    },
    define: { "import.meta.url": "__ccagentBytecodeUrl" },
    logLevel: "warning",
    plugins: [{
      name: "stub-optional-ink-devtools",
      setup(pluginBuild) {
        pluginBuild.onResolve({ filter: /^react-devtools-core$/ }, () => ({
          path: "react-devtools-core",
          namespace: "ink-devtools-stub",
        }));
        pluginBuild.onLoad({ filter: /.*/, namespace: "ink-devtools-stub" }, () => ({
          contents: "export default {};",
          loader: "js",
        }));
      },
    }],
  });

  if (result.warnings.length > 0) {
    throw new Error(`CJS build emitted ${result.warnings.length} warning(s)`);
  }
  const inputs = Object.keys(result.metafile.inputs).map((name) => name.replaceAll("\\", "/"));
  const projectSourceCount = inputs.filter((name) => name.startsWith("src/") || name.includes("/src/")).length;
  const coreSources = inputs
    .filter((name) => name.startsWith("src/core/") || name.includes("/src/core/"))
    .sort();
  for (const required of ["src/core/queryEngine.ts", "src/core/agenticLoop.ts"]) {
    if (!inputs.some((name) => name.endsWith(required))) {
      throw new Error(`Core source missing from bytecode bundle: ${required}`);
    }
  }

  await bytenode.compileFile({
    filename: sourceBundle,
    output: bytecodeFile,
    compileAsModule: true,
  });
  await writeFile(
    loaderFile,
    [
      'const manifest = require("./manifest.json");',
      'if (process.version !== manifest.node || process.versions.v8 !== manifest.v8 || process.arch !== manifest.architecture) {',
      '  throw new Error(`CCAGENT bytecode prototype requires ${manifest.node}/${manifest.v8}/${manifest.architecture}; found ${process.version}/${process.versions.v8}/${process.arch}`);',
      '}',
      'require("bytenode");',
      'module.exports = require("./core.jsc");',
      '',
    ].join("\n"),
  );
  const bytes = await readFile(bytecodeFile);
  await writeFile(manifestFile, JSON.stringify({
    prototypeOnly: true,
    entries: ["src/core/queryEngine.ts", "src/core/agenticLoop.ts"],
    bundledInputCount: inputs.length,
    projectSourceCount,
    coreSources,
    bytecode: "core.jsc",
    loader: "load-core.cjs",
    node: process.version,
    v8: process.versions.v8,
    architecture: process.arch,
    platform: process.platform,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  }, null, 2) + "\n");
  await writeFile(packageFile, JSON.stringify({
    name: "ccagent-core-bytecode-prototype",
    version: "0.0.0",
    private: true,
    type: "commonjs",
    dependencies: { bytenode: "1.7.0" },
  }, null, 2) + "\n");
  process.stdout.write(`Compiled ${coreSources.length} core sources, ${projectSourceCount} project sources, and ${inputs.length} total inputs to ${bytecodeFile} (${bytes.length} bytes)\n`);
} finally {
  // The intermediate CJS bundle is only needed while creating bytecode.
  await unlink(sourceBundle).catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  });
}
