import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { getCCAgentPath } from "../../utils/paths.js";
import type { McpStdioServerConfig } from "../../types/mcp.js";

export const COMFY_MCP_VERSION = "0.10.0";
export const COMFY_CLI_VERSION = "1.18.0";
export const DEFAULT_COMFYUI_URL = "http://127.0.0.1:8188";

/** This catalog entry deliberately targets the computer running CCAGENT. */
export function normalizeLocalComfyuiUrl(value: unknown): string {
  const supplied = value === undefined || value === "" ? DEFAULT_COMFYUI_URL : value;
  if (typeof supplied !== "string" || supplied.length > 256) throw new Error("请填写有效的本机 ComfyUI HTTP 地址。");
  if (!/^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]+)?\/?$/i.test(supplied.trim())) throw new Error("ComfyUI 本地插件仅支持本机 HTTP 根地址，可指定端口。");
  let url: URL;
  try { url = new URL(supplied.trim()); }
  catch { throw new Error("请填写有效的本机 ComfyUI HTTP 地址。"); }
  if (url.protocol !== "http:" || url.port === "0" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("ComfyUI 本地插件仅支持 http://127.0.0.1、localhost 或 [::1] 的根地址，可指定端口。");
  }
  return url.origin;
}

async function executable(value: unknown, name: "comfy-mcp" | "comfy" | "uvx"): Promise<string | undefined> {
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string" || !value.trim() || value.length > 8192 || /[\x00-\x1f]/.test(value)) throw new Error(`${name} 程序路径无效。`);
  const file = value.trim();
  const basename = path.basename(file).toLowerCase();
  if (!path.isAbsolute(file) || ![name, `${name}.exe`].includes(basename)
    || !await stat(file).then((info) => info.isFile(), () => false)) {
    throw new Error(`请选择已安装的 ${name}${process.platform === "win32" ? ".exe" : ""} 的绝对路径。`);
  }
  return file;
}

async function uvxExecutable(): Promise<string> {
  const supplied = await executable(process.env.CCAGENT_UVX_EXECUTABLE, "uvx");
  if (supplied) return supplied;
  // Astral's standalone Windows installer uses this location; prefer it over
  // stale pip-provided uvx shims earlier in PATH. Other platforms use PATH.
  if (process.platform === "win32") {
    const standalone = path.join(os.homedir(), ".local", "bin", "uvx.exe");
    if (await stat(standalone).then((info) => info.isFile(), () => false)) return standalone;
  }
  return "uvx";
}

/** Register an external official server; never installs or launches ComfyUI itself. */
export async function buildComfyuiMcpConfig(options: Record<string, unknown> = {}): Promise<McpStdioServerConfig> {
  const localUrl = normalizeLocalComfyuiUrl(options.localUrl);
  const supplied = (value: unknown, fallback: string | undefined) => value === undefined || value === "" ? fallback : value;
  const entry = await executable(supplied(options.mcpExecutable, process.env.CCAGENT_COMFY_MCP_EXECUTABLE), "comfy-mcp");
  let comfy = await executable(supplied(options.comfyExecutable, process.env.CCAGENT_COMFY_CLI_EXECUTABLE), "comfy");
  if (entry && !comfy) {
    const sibling = path.join(path.dirname(entry), process.platform === "win32" ? "comfy.exe" : "comfy");
    if (await stat(sibling).then((info) => info.isFile(), () => false)) comfy = sibling;
    else throw new Error("该目录未找到 comfy，请同时填写已安装的 comfy CLI 程序路径。");
  }
  return {
    type: "stdio",
    command: entry || await uvxExecutable(),
    args: entry ? [] : ["--no-config", "--from", `comfy-mcp==${COMFY_MCP_VERSION}`, "--with", `comfy-cli==${COMFY_CLI_VERSION}`, "comfy-mcp"],
    connectTimeoutMs: 180_000,
    toolTimeoutMs: 120_000,
    env: {
      COMFY_BIN: comfy || "comfy",
      COMFY_LOCAL_URL: localUrl,
      // Empty overrides prevent inherited remote-target settings from diverting jobs.
      COMFYUI_URL: "", COMFYUI_HOST: "", COMFYUI_PORT: "",
      DO_NOT_TRACK: "1", COMFY_NO_TELEMETRY: "1", PYTHONUTF8: "1",
      // Keep Windows extraction paths short, while keeping accounts separate.
      // The cache contains only public packages and may be regenerated.
      UV_CACHE_DIR: path.join(os.tmpdir(), "cc-comfy", createHash("sha256").update(getCCAgentPath("integrations", "comfyui")).digest("hex").slice(0, 16)),
      UV_CONCURRENT_DOWNLOADS: "1", UV_CONCURRENT_INSTALLS: "1",
    },
  };
}
