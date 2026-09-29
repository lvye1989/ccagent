import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire, isBuiltin } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import ts from "typescript";

const require = createRequire(import.meta.url);
const bytenode = require("bytenode");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const variantId = `${process.version.slice(1).replaceAll(".", "-")}-${process.platform}-${process.arch}`;
const packageRoot = resolve(root, ".tmp", "bytecode-cli-variants", variantId);
if (relative(root, packageRoot) !== join(".tmp", "bytecode-cli-variants", variantId)) {
  throw new Error("Bytecode CLI output must stay inside this workspace");
}
await mkdir(dirname(packageRoot), { recursive: true });
const parentRelative = relative(await realpath(root), await realpath(dirname(packageRoot)));
if (!parentRelative || parentRelative === ".." || parentRelative.startsWith(`..${sep}`) || isAbsolute(parentRelative)) {
  throw new Error("Bytecode CLI output parent resolves outside this workspace");
}
try {
  if ((await lstat(packageRoot)).isSymbolicLink()) {
    throw new Error("Refusing to replace a linked bytecode output directory");
  }
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}
await rm(packageRoot, { recursive: true, force: true });

const distDir = join(packageRoot, "dist");
const rhinoDir = join(packageRoot, "rhino");
const sourceBundle = join(distDir, "ccagent-build.cjs");
const bytecodeFile = join(distDir, "ccagent.jsc");
const loaderFile = join(distDir, "ccagent.cjs");
const manifestFile = join(distDir, "manifest.json");
const projectPackage = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
await mkdir(distDir, { recursive: true });
await mkdir(rhinoDir, { recursive: true });

function replaceDynamicBuiltinImports(source) {
  const parsed = ts.createSourceFile("ccagent-dynamic-imports.js", source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);
  const edits = [];
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const specifier = node.arguments[0];
      if (!specifier || !ts.isStringLiteralLike(specifier) || !isBuiltin(specifier.text)) {
        throw new Error(`Cannot wrap dynamic import at offset ${node.getStart(parsed)}`);
      }
      edits.push({
        start: node.getStart(parsed),
        end: node.end,
        replacement: `Promise.resolve().then(() => __ccagentImportBuiltin(${JSON.stringify(specifier.text)}))`,
      });
    }
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    source = source.slice(0, edit.start) + edit.replacement + source.slice(edit.end);
  }
  return { source, dynamicImportCount: edits.length };
}

function wrapEsmBundle(esmSource) {
  const rewritten = replaceDynamicBuiltinImports(esmSource.replace(/^#![^\r\n]*\r?\n/, ""));
  const source = rewritten.source;
  const parsed = ts.createSourceFile("ccagent-bundle.js", source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);
  const imports = [];
  const body = [];
  let last = 0;
  let importIndex = 0;
  for (const statement of parsed.statements) {
    if (ts.isExportDeclaration(statement) || ts.isExportAssignment(statement)) {
      throw new Error("CLI ESM bundle unexpectedly exports values");
    }
    if (!ts.isImportDeclaration(statement)) continue;
    const specifier = statement.moduleSpecifier.text;
    if (!isBuiltin(specifier)) {
      throw new Error(`Cannot wrap non-builtin ESM import: ${specifier}`);
    }
    body.push(source.slice(last, statement.getStart(parsed)));
    last = statement.end;

    const namespace = `__ccagentImport${importIndex++}`;
    imports.push(`const ${namespace} = require(${JSON.stringify(specifier)});`);
    const clause = statement.importClause;
    if (clause?.name) imports.push(`const ${clause.name.text} = ${namespace};`);
    if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
      imports.push(`const ${clause.namedBindings.name.text} = Object.assign(Object.create(null), ${namespace}, { default: ${namespace} });`);
    } else if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      const names = clause.namedBindings.elements.map((element) => {
        const imported = element.propertyName?.text ?? element.name.text;
        return `${JSON.stringify(imported)}: ${element.name.text}`;
      });
      imports.push(`const { ${names.join(", ")} } = ${namespace};`);
    }
  }
  body.push(source.slice(last));
  const wrapped = [
    'const __ccagentBytecodeUrl = globalThis.__CCAGENT_BYTECODE_VIRTUAL_URL__ || require("node:url").pathToFileURL(__filename).href;',
    "const __ccagentImportMetaResolve = (specifier) => require.resolve(specifier);",
    "const __ccagentImportBuiltin = (specifier) => { const value = require(specifier); return Object.assign(Object.create(null), value, { default: value }); };",
    "(async () => {",
    ...imports,
    ...body,
    "})().catch((error) => {",
    '  console.error("Fatal: " + (error instanceof Error ? error.message : String(error)));',
    "  process.exitCode = 1;",
    "});",
    "",
  ].join("\n");
  const check = ts.createSourceFile("ccagent-bytecode-wrapper.cjs", wrapped, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);
  if (check.parseDiagnostics.length > 0) {
    throw new Error(`Bytecode wrapper has ${check.parseDiagnostics.length} syntax error(s)`);
  }
  return { wrapped, importCount: importIndex, dynamicImportCount: rewritten.dynamicImportCount };
}

try {
  const result = await build({
    entryPoints: [join(root, "src", "entrypoint", "cli.ts")],
    outfile: sourceBundle,
    platform: "node",
    format: "esm",
    target: "node22",
    bundle: true,
    splitting: false,
    sourcemap: false,
    metafile: true,
    logLevel: "warning",
    define: {
      "import.meta.url": "__ccagentBytecodeUrl",
      "import.meta.resolve": "__ccagentImportMetaResolve",
      __CCAGENT_VERSION__: JSON.stringify(projectPackage.version),
    },
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
  if (!inputs.some((name) => name.endsWith("src/core/agenticLoop.ts"))) {
    throw new Error("CLI bytecode bundle is missing src/core/agenticLoop.ts");
  }
  const { wrapped, importCount, dynamicImportCount } = wrapEsmBundle(await readFile(sourceBundle, "utf8"));
  await writeFile(sourceBundle, wrapped);

  await bytenode.compileFile({
    filename: sourceBundle,
    output: bytecodeFile,
    compileAsModule: true,
  });
  const bytes = await readFile(bytecodeFile);
  await writeFile(manifestFile, JSON.stringify({
    prototypeOnly: true,
    sourceVersion: projectPackage.version,
    node: process.version,
    v8: process.versions.v8,
    platform: process.platform,
    architecture: process.arch,
    rewrittenBuiltinImports: importCount,
    rewrittenDynamicBuiltinImports: dynamicImportCount,
    bundledInputCount: inputs.length,
    projectSourceCount: inputs.filter((name) => name.startsWith("src/") || name.includes("/src/")).length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  }, null, 2) + "\n");
  await writeFile(loaderFile, [
    "#!/usr/bin/env node",
    'const manifest = require("./manifest.json");',
    'if (process.version !== manifest.node || process.versions.v8 !== manifest.v8 || process.arch !== manifest.architecture) {',
    '  console.error(`ccagent bytecode requires ${manifest.node}/${manifest.v8}/${manifest.architecture}; found ${process.version}/${process.versions.v8}/${process.arch}`);',
    "  process.exit(1);",
    "}",
    'require("bytenode");',
    'require("./ccagent.jsc");',
    "",
  ].join("\n"));
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({
    name: "ccdagent-bytecode-preview",
    version: `0.0.0-${projectPackage.version.replaceAll(".", "-")}-${variantId}`,
    private: true,
    type: "commonjs",
    bin: { ccagent: "dist/ccagent.cjs" },
    files: ["dist", "rhino", "LICENSE"],
    engines: { node: process.version.slice(1) },
    os: [process.platform],
    cpu: [process.arch],
    dependencies: { bytenode: "1.7.0" },
  }, null, 2) + "\n");

  for (const name of [
    "ccagent_rhino_runner.py",
    "ccagent_rhino_architecture.py",
    "ccagent_rhino_toolkit.py",
    "ccagent_grasshopper.py",
    "TOOLKIT.md",
  ]) {
    await copyFile(join(root, "rhino", name), join(rhinoDir, name));
  }
  await copyFile(join(root, "LICENSE"), join(packageRoot, "LICENSE"));
  process.stdout.write(`Built ${bytecodeFile} (${bytes.length} bytes; ${inputs.length} bundled inputs)\n`);
} finally {
  await rm(sourceBundle, { force: true });
}
