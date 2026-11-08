import type { Tool, ToolResult } from "../tools/Tool.js";

export type ComfyuiWebTestResult = {
  ok: boolean;
  mcpConnected: boolean;
  serverRunning: boolean;
  message: string;
  toolCount: number;
  url?: string;
  /** The engine version reported by server_info, not a guessed ComfyUI version. */
  version?: string;
  warning?: string;
};

type ObjectValue = Record<string, unknown>;
const objectValue = (value: unknown): value is ObjectValue => value !== null && typeof value === "object" && !Array.isArray(value);
const loopbackHosts = new Set(["localhost", "127.0.0.1", "::1"]);

function localHost(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const host = value.toLowerCase() === "[::1]" ? "::1" : value.toLowerCase();
  return loopbackHosts.has(host) ? host : undefined;
}

/** Require an origin, rather than silently discarding a proxy path or credential. */
function localUrl(value: unknown): URL | undefined {
  if (typeof value !== "string" || !/^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]+)?\/?$/i.test(value)) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" || !localHost(url.hostname) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) return undefined;
    if (url.port === "0") return undefined;
    return url;
  } catch { return undefined; }
}

function parseResult(result: ToolResult): ObjectValue {
  if (result.isError) throw new Error("tool-error");
  const text = typeof result.content === "string" ? result.content : result.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
  if (text.length > 1_000_000) throw new Error("invalid-result");
  const parsed: unknown = JSON.parse(text);
  if (!objectValue(parsed) || parsed.ok === false || parsed.error) throw new Error("invalid-result");
  const state = !parsed.server && objectValue(parsed.result) ? parsed.result : parsed;
  if (state.ok === false || state.error) throw new Error("invalid-result");
  return state;
}

function hasOutdated(value: unknown, depth = 0): boolean {
  if (depth > 4 || !value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((item) => hasOutdated(item, depth + 1));
  return Object.entries(value as ObjectValue).some(([key, item]) =>
    ((key === "outdated" || key === "is_outdated" || key === "update_available") && item === true)
    || (key === "status" && item === "outdated")
    || hasOutdated(item, depth + 1));
}

function stateWarning(state: ObjectValue): string | undefined {
  if (hasOutdated(state.freshness)) return "检测到 ComfyUI 或自定义节点有可用更新，请按需更新后再测试工作流。";
  if (objectValue(state.freshness) && state.freshness.error) return "版本更新检查暂不可用；本地连接检查仍已完成。";
  if (objectValue(state.compatibility) && Array.isArray(state.compatibility.warnings) && state.compatibility.warnings.length) return "comfy-cli 兼容性检查存在提示，请检查本地引擎版本。";
  return undefined;
}

/** Read-only UI probe: invoke only the connected server's fixed server_info tool. */
export async function runComfyuiWebTest(workspace: string, tools: readonly Tool[]): Promise<ComfyuiWebTestResult> {
  const report: ComfyuiWebTestResult = { ok: false, mcpConnected: false, serverRunning: false, message: "", toolCount: tools.length };
  const probes = tools.filter((tool) => tool.name.startsWith("mcp__") && tool.name.endsWith("__server_info"));
  try {
    if (probes.length !== 1 || !probes[0]!.isEnabled()) {
      report.message = "ComfyUI MCP 检查工具不可用，请先安装并连接插件。";
      return report;
    }
    let state: ObjectValue;
    try { state = parseResult(await probes[0]!.call({}, { cwd: workspace })); }
    catch {
      // MCP diagnostics can contain user paths, environment values or credentials.
      report.message = "ComfyUI MCP 状态检查失败，请检查本地 MCP 与 comfy-cli 是否可用。";
      return report;
    }
    report.mcpConnected = true;
    const server = state.server;
    if (!objectValue(server) || typeof server.running !== "boolean") {
      report.message = "ComfyUI MCP 返回了无效的服务状态，未能确认本地 ComfyUI 正在运行。";
      return report;
    }
    const url = server.url == null ? undefined : localUrl(server.url);
    if ((server.url != null && !url) || (server.running && !url)) {
      report.message = "服务地址不是受支持的本机 HTTP 地址，未通过本地 ComfyUI 检查。";
      return report;
    }
    if (state.comfy_target != null) {
      const target = state.comfy_target;
      const host = objectValue(target) ? localHost(target.host) : undefined;
      const port = objectValue(target) ? target.port : undefined;
      if (!host || typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535 || (url && (host !== localHost(url.hostname) || port !== Number(url.port || 80)))) {
        report.message = "MCP 的工作流目标与本机服务不一致，请检查并清除远程目标配置。";
        return report;
      }
    }
    const compatibility = state.compatibility;
    const version = objectValue(compatibility) ? compatibility.comfy_cli_version : undefined;
    if (typeof version === "string" && version.length <= 64 && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) report.version = version;
    report.warning = stateWarning(state);
    report.serverRunning = server.running;
    if (url) report.url = url.origin;
    if (!server.running) {
      report.message = "MCP 已连接，本地 ComfyUI 尚未运行。请先启动 ComfyUI，再测试连接。";
      return report;
    }
    report.ok = true;
    report.message = "MCP 已连接，已确认本地 ComfyUI 正在运行。";
    return report;
  } catch {
    report.message = "ComfyUI MCP 检查工具不可用，请重新连接插件后重试。";
    return report;
  }
}
