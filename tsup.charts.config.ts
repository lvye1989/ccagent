import { defineConfig } from "tsup";
export default defineConfig({ entry: { charts: "scripts/charts-entry.js" }, outDir: "dist", format: ["esm"], platform: "browser", target: "es2022", bundle: true, splitting: false, sourcemap: false, minify: true, clean: false });
