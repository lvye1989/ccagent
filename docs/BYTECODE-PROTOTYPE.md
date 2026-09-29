# Core bytecode prototype

Run `npm run prototype:bytecode` from the repository root. This bundles the
runtime modules reached from `src/core/queryEngine.ts` and
`src/core/agenticLoop.ts` as CommonJS, compiles them with bytenode, and checks
that the bytecode exports work and that basic `QueryEngine` behavior matches
the TypeScript implementation.

The generated files live in `.tmp/bytecode-prototype/`:

- `core.jsc`: the bytecode artifact.
- `load-core.cjs`: a small CommonJS loader that checks the Node/V8/architecture
  recorded at build time before loading bytecode. It requires the `bytenode`
  runtime package.
- `manifest.json`: the build environment, included core sources, and artifact
  checksum.
- `package.json`: a private package declaring the bytenode runtime needed if
  this folder is copied elsewhere for an isolated load test.

The intermediate `core-build.cjs` is removed after compilation. No source map
is produced. `.tmp/` is ignored by Git and excluded from the npm package's
`files` list, so this prototype does not change the published CLI.

This is a load and basic behavior prototype, not a replacement for the ESM
application entrypoint. Before shipping bytecode, the loader and `bytenode`
must be included as runtime files, Rhino asset paths must be verified in the
final installation layout, and the complete CLI test suite must pass on each
supported Node version and architecture. One `.jsc` artifact does not cover
the current `node >=22` support range.

## Full CLI preview

Run `npm run prototype:bytecode-cli` under the exact Node version you want to
support. The build writes an isolated private package to
`.tmp/bytecode-cli-variants/<node-version>-<platform>-<architecture>/` and runs
safe CLI checks (`--version`, `--help`, `init --help`, and
`--dump-system-prompt`). To build a different version, invoke
`scripts/build-bytecode-cli.mjs` and `scripts/test-bytecode-cli.mjs` with that
version's `node` executable. The build preserves the ESM dependencies' top-level
`await` inside the bytecode and rewrites only Node builtin imports in the
temporary bundle. It deletes the temporary plain-JS bundle afterward.

After building all desired exact-version variants, run
`npm run prototype:bytecode-matrix`. This creates the separate
`ccdagent-bytecode` beta package in `.tmp/bytecode-matrix-package/`. Its small CommonJS launcher selects a
matching `.jsc` by exact Node, V8, OS, and architecture. The preview includes
the Rhino runtime assets beside `dist/`, matching the path layout expected by
the existing CLI. A version with no matching bytecode exits with an explicit
message. No plain application bundle or source map is included.

On Windows x64, the beta package has been smoke-tested with Node 22.23.3, 24.16.0,
24.21.0, and 26.10.0. Those exact patches are the currently built variants;
this does **not** make all future or older `node >=22` installations compatible.
The matrix tarball has also been installed into an isolated global prefix; its
CLI shim, prompt dump, and interactive Ink welcome screen were exercised without
sending a model request.
The public package uses the separate `ccagent-bytecode` command and the npm
`beta` tag. Its package metadata lists the built OS, architecture, and exact
Node versions. Always audit the final tarball before publishing; it must not
contain the original JavaScript bundle, TypeScript sources, source maps, or
local credentials.
The published `ccdagent` package retains its existing ESM build and broad
Node range. A protected npm release needs more platform builds, complete
interactive session/provider/Rhino testing, and a release process that regenerates
bytecode when supported Node patches change.
