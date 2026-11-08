import path from "node:path";
import { readdir, readFile, stat } from "node:fs/promises";
import { getCCAgentPath } from "../../utils/paths.js";
import type { McpStdioServerConfig } from "../../types/mcp.js";

export const PHOTOSHOP_MCP_PACKAGE = "@alisaitteke/photoshop-mcp";
export const PHOTOSHOP_MCP_VERSION = "1.7.37";

/** Detection only: never launches Photoshop or touches its documents. */
export async function findPhotoshopExecutable(): Promise<string | undefined> {
  const supplied = process.env.PHOTOSHOP_PATH?.trim();
  if (supplied && path.isAbsolute(supplied) && await stat(supplied).then((info) => info.isFile(), () => false)) return supplied;
  if (process.platform !== "win32") return undefined;
  const base = path.join(process.env.ProgramFiles || "C:\\Program Files", "Adobe");
  const folders = await readdir(base, { withFileTypes: true }).catch(() => []);
  for (const folder of folders.filter((item) => item.isDirectory() && /^Adobe Photoshop\b/i.test(item.name)).sort((a, b) => b.name.localeCompare(a.name))) {
    const file = path.join(base, folder.name, "Photoshop.exe");
    if (await stat(file).then((info) => info.isFile(), () => false)) return file;
  }
  return undefined;
}

export async function buildPhotoshopMcpConfig(): Promise<McpStdioServerConfig> {
  let command = "npx", args = ["--yes", `${PHOTOSHOP_MCP_PACKAGE}@${PHOTOSHOP_MCP_VERSION}`];
  // Optional preinstalled runtime for offline/local deployments. Validate the pin.
  const entry = process.env.CCAGENT_PHOTOSHOP_MCP_ENTRY?.trim();
  if (entry) {
    if (!path.isAbsolute(entry) || !await stat(entry).then((info) => info.isFile(), () => false)) throw new Error("Photoshop MCP 预安装入口不存在。");
    const manifest = JSON.parse(await readFile(path.join(path.dirname(entry), "..", "package.json"), "utf8")) as Record<string, unknown>;
    if (manifest.name !== PHOTOSHOP_MCP_PACKAGE || manifest.version !== PHOTOSHOP_MCP_VERSION) throw new Error(`Photoshop MCP 预安装版本必须为 ${PHOTOSHOP_MCP_VERSION}。`);
    command = process.execPath; args = [entry];
  }
  const executable = await findPhotoshopExecutable();
  return {
    type: "stdio", command, args, connectTimeoutMs: 180_000, toolTimeoutMs: 90_000,
    env: {
      ANALYTICS_DISABLED: "1", POSTHOG_DISABLED: "1", PSMCP_FEEDBACK: "0", PSMCP_UPDATE_CHECK: "0",
      PHOTOSHOP_MCP_API: "extendscript", PHOTOSHOP_UXP_BRIDGE_PORT: "0",
      PHOTOSHOP_MCP_HOME: getCCAgentPath("integrations", "photoshop"),
      npm_config_cache: process.env.npm_config_cache?.trim() || getCCAgentPath("integrations", "npm-cache"),
      npm_config_ignore_scripts: "true", npm_config_prefer_offline: "true",
      ...(executable ? { PHOTOSHOP_PATH: executable } : {}),
    },
  };
}
