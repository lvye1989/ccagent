import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { getCCAgentPath } from "../../utils/paths.js";
import type { McpStdioServerConfig } from "../../types/mcp.js";

export const SKETCHUP_MCP_VERSION = "0.4.0";
export const DEFAULT_SKETCHUP_MCP_PORT = 9876;

/** Public integration runtime shared on this machine, separate from account settings. */
export function getInstalledSketchupMcpExecutable(): string {
  const data = process.platform === "win32"
    ? process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local")
    : process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
  return path.join(data, "CCAGENT", "integrations", "sketchup-mcp", SKETCHUP_MCP_VERSION,
    process.platform === "win32" ? "Scripts" : "bin", process.platform === "win32" ? "sketchup-mcp2.exe" : "sketchup-mcp2");
}

export function normalizeSketchupMcpPort(value: unknown): number {
  if (value === undefined || value === "") return DEFAULT_SKETCHUP_MCP_PORT;
  if (!(typeof value === "number" || typeof value === "string") || !/^\d{1,5}$/.test(String(value).trim())) throw new Error("SketchUp MCP 端口须为 1–65535 的整数。");
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("SketchUp MCP 端口须为 1–65535 的整数。");
  return port;
}

async function existing(file: string): Promise<boolean> { return stat(file).then((info) => info.isFile(), () => false); }
async function suppliedExecutable(value: unknown, name: string): Promise<string | undefined> {
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string" || !value.trim() || value.length > 8192 || /[\x00-\x1f]/.test(value)) throw new Error(`${name} 程序路径无效。`);
  const file = value.trim();
  if (!path.isAbsolute(file) || ![name, `${name}.exe`].includes(path.basename(file).toLowerCase()) || !await existing(file)) throw new Error(`请选择已安装 ${name} 的绝对路径。`);
  return file;
}

/** Connects only to a loopback Ruby bridge; never launches or edits SketchUp. */
export async function buildSketchupMcpConfig(options: Record<string, unknown> = {}): Promise<McpStdioServerConfig> {
  const port = normalizeSketchupMcpPort(options.port);
  const selected = options.mcpExecutable === undefined || options.mcpExecutable === "" ? process.env.CCAGENT_SKETCHUP_MCP_EXECUTABLE : options.mcpExecutable;
  let entry = await suppliedExecutable(selected, "sketchup-mcp2");
  const installed = getInstalledSketchupMcpExecutable();
  if (!entry && await existing(installed)) entry = installed;
  let runner: string | undefined;
  if (!entry) {
    runner = await suppliedExecutable(process.env.CCAGENT_UVX_EXECUTABLE, "uvx");
    const standalone = path.join(os.homedir(), ".local", "bin", "uvx.exe");
    if (!runner && process.platform === "win32" && await existing(standalone)) runner = standalone;
  }
  return {
    type: "stdio", command: entry || runner || "uvx",
    args: entry ? [] : ["--no-config", "--from", `sketchup-mcp2==${SKETCHUP_MCP_VERSION}`, "sketchup-mcp2"],
    connectTimeoutMs: 180_000, toolTimeoutMs: 90_000,
    env: {
      SKETCHUP_MCP_HOST: "127.0.0.1", SKETCHUP_MCP_PORT: String(port), SKETCHUP_MCP_TIMEOUT: "60", SKETCHUP_MCP_LOG_LEVEL: "WARN",
      PYTHONUTF8: "1", DO_NOT_TRACK: "1",
      UV_CACHE_DIR: path.join(os.tmpdir(), "cc-sketch", createHash("sha256").update(getCCAgentPath("integrations", "sketchup")).digest("hex").slice(0, 16)),
      UV_CONCURRENT_DOWNLOADS: "1", UV_CONCURRENT_INSTALLS: "1",
    },
  };
}
