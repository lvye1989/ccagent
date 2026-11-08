import path from "node:path";
import { readFile, realpath, stat } from "node:fs/promises";
import type { ServerResponse } from "node:http";

const types: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf",
  ".json": "application/json; charset=utf-8", ".txt": "text/plain; charset=utf-8",
  ".png": "image/png", ".svg": "image/svg+xml",
};

/** Only generated local editor assets, never arbitrary workspace/account files. */
export async function serveWhiteboardAsset(res: ServerResponse, pathname: string, webRoot: string): Promise<void> {
  let relative: string;
  try { relative = decodeURIComponent(pathname.slice("/whiteboard-assets/".length)); }
  catch { res.writeHead(404); res.end(); return; }
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(relative) || relative.split("/").some((part) => !part || part === "." || part === "..")) { res.writeHead(404); res.end(); return; }
  const type = types[path.extname(relative).toLowerCase()];
  if (!type) { res.writeHead(404); res.end(); return; }
  try {
    const root = await realpath(path.join(webRoot, "../dist/whiteboard"));
    const file = await realpath(path.join(root, relative));
    const fromRoot = path.relative(root, file);
    if (!fromRoot || fromRoot.startsWith("..") || path.isAbsolute(fromRoot) || !(await stat(file)).isFile()) { res.writeHead(404); res.end(); return; }
    const bytes = await readFile(file);
    res.writeHead(200, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "cross-origin-resource-policy": "same-origin" });
    res.end(bytes);
  } catch { res.writeHead(404); res.end(); }
}

// The editor needs inline React styles and font-subsetting WebAssembly. Keep
// these allowances on its isolated document rather than the main application.
export const WHITEBOARD_EDITOR_CSP = "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data: blob:; connect-src 'self'; worker-src 'self' blob:; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";
