import { defineConfig } from "tsup";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export default defineConfig({
  entry: { "whiteboard-editor": "scripts/whiteboard-editor-entry.jsx" },
  outDir: "dist/whiteboard", format: ["esm"], platform: "browser", target: "es2022",
  bundle: true, splitting: true, sourcemap: false, minify: true, clean: true,
  noExternal: [/.*/],
  esbuildPlugins: [{
    name: "excalidraw-local-fonts",
    setup(build) {
      build.onLoad({ filter: /@excalidraw[\\/]excalidraw[\\/]dist[\\/]prod[\\/]chunk-[^\\/]+\.js$/ }, async ({ path: file }) => {
        const source = await readFile(file, "utf8");
        if (!source.includes("EXCALIDRAW_ASSET_PATH") || !source.includes("ASSETS_FALLBACK_URL")) return;
        // Pinned 0.18.1 adds a CDN font fallback even with a local asset path.
        // All font files ship locally; remove that one fallback at build time.
        const pattern = /return (\w+)\.push\(new URL\((\w+),(\w+)\.ASSETS_FALLBACK_URL\)\),\1/g;
        if ([...source.matchAll(pattern)].length !== 1) throw new Error("Review the Excalidraw local font adapter before upgrading.");
        return { contents: source.replace(pattern, "return $1"), loader: "js" };
      });
    },
  }],
  define: { "process.env.NODE_ENV": '"production"' },
  esbuildOptions(options) {
    options.conditions = ["browser", "production", "default"];
    options.loader = { ...options.loader, ".woff2": "file", ".woff": "file", ".ttf": "file" };
  },
  async onSuccess() {
    const source = path.resolve("node_modules/@excalidraw/excalidraw");
    await cp(path.join(source, "dist/prod/fonts"), "dist/whiteboard/fonts", { recursive: true });
    await mkdir("dist/whiteboard/licenses", { recursive: true });
    for (const [name, file] of [["Excalidraw", "web/vendor-licenses/Excalidraw.txt"], ["Excalidraw-fonts", "web/vendor-licenses/Excalidraw-fonts.txt"], ["React", "node_modules/react/LICENSE"], ["ReactDOM", "node_modules/react-dom/LICENSE"]]) {
      await writeFile(`dist/whiteboard/licenses/${name}.txt`, await readFile(file!));
    }
  },
});
