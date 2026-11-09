import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { getUserSettingsPath } from "../utils/paths.js";
import { withFileTransaction, writeJsonAtomically } from "../utils/fileTransaction.js";
import { resetSettingsCache } from "../config/sources.js";
import { storeWebSecret, removeWebSecret } from "../utils/webSecrets.js";
import { loadMcpConfigs } from "../services/mcp/config.js";
import { getMcpRegistryEntry } from "../services/mcp/registry.js";
import { isMcpServerEnabled } from "../services/mcp/preferences.js";
import { GOOGLE_WORKSPACE_MCP_ENDPOINTS, DEFAULT_GOOGLE_MCP_REDIRECT_URI } from "../services/mcp/googleWorkspace.js";
import type { McpServerConfig } from "../types/mcp.js";
import { buildPhotoshopMcpConfig } from "../services/mcp/photoshop.js";
import { buildComfyuiMcpConfig } from "../services/mcp/comfyui.js";
import { buildSketchupMcpConfig } from "../services/mcp/sketchup.js";
import { buildFigmaMcpConfig } from "../services/mcp/figma.js";
import { buildAutocadMcpConfig, removeAutocadMcpConfig } from "../services/mcp/autocad.js";
import { clearBrowserMcpOAuthCredentials } from "../services/mcp/browserOAuth.js";

type App = { id: string; name: string; description: string; category: string; auth: "google" | "token" | "local" | "oauth"; url: string; help: string; note: string; tokenLabel?: string };
export const CANVA_MCP_URL = "https://api.canva.com/connect/v1/mcp";
export const DEFAULT_CANVA_REDIRECT_URI = "http://127.0.0.1:53683/oauth/callback";
export const COMMON_APPS: readonly App[] = [
  { id: "canva", name: "Canva（可画）", description: "授权连接 Canva，调用账号可用的设计工具", category: "设计", auth: "oauth", url: "https://www.canva.com/", help: "https://www.canva.dev/docs/apps/mcp/access/", note: "使用 Canva 官方 MCP。需先在 Canva 开发者门户创建应用、启用 Canva MCP 并登记回调地址，再填写 Client ID / Secret 并点击授权连接。可用功能与账号及服务实际返回的工具有关；添加配置后尚未授权不代表已连接。" },
  { id: "figma", name: "Figma", description: "读取桌面版 Figma 的设计上下文、组件与布局", category: "设计", auth: "local", url: "https://www.figma.com/", help: "https://developers.figma.com/docs/figma-mcp-server/local-server-installation/", note: "使用 Figma 官方桌面 MCP。先启动桌面版，在 Dev Mode 中启用 MCP Server，默认地址 http://127.0.0.1:3845/mcp。需要适用套餐及 Dev / Full 席位。桌面 MCP 提供设计上下文读取，不支持写入画布；无需填写 API Key。" },
  { id: "autocad", name: "AutoCAD", description: "连接本机 AutoCAD，操作二维图纸并导出 CAD 成果", category: "建模", auth: "local", url: "https://www.autodesk.com/products/autocad/overview", help: "https://github.com/C48H74/autocad-mcp", note: "采用社区 MIT 开源 C48H74/autocad-mcp 0.3.1 固定提交，支持 Windows COM 与 DXF 模式。需选择专用 CAD 文件夹；未指定已安装程序时通过 uvx 下载依赖及 Python 3.11。默认连接 AutoCAD 2025，关闭自动启动和 Lisp。DXF / PDF 等文件导出受所选目录限制；原生 COM 操作直接作用于当前打开的图纸，操作前请核对。请自行启动 AutoCAD 并打开图纸；本机 2020 / 2025 绘图兼容性尚未实测。DWG 仅支持已有文件原位保存。" },
  { id: "sketchup", name: "SketchUp", description: "连接本机 SketchUp，读取模型、创建组件并导出文件", category: "建模", auth: "local", url: "https://www.sketchup.com/", help: "https://github.com/zinin/sketchup-mcp2/releases/tag/v0.4.0", note: "采用社区 MIT 开源 sketchup-mcp2 0.4.0，需要在桌面版 SketchUp 安装配套签名 RBZ 并启动 MCP Server。本地已有运行时会自动复用；否则使用 uvx 固定版本，需要 uv 和 Python 3.10 以上。无需 API Key。视口截图要求 SketchUp 2026，本入口先提供只读连接检查。" },
  { id: "photoshop", name: "Adobe Photoshop", description: "连接本机 Photoshop，编辑图层并导出图片", category: "图像", auth: "local", url: "https://www.adobe.com/products/photoshop.html", help: "https://github.com/alisaitteke/photoshop-mcp", note: "使用固定版本 1.7.37 的社区 MCP。需要本机 Photoshop；首次安装可能需要下载依赖。安装后可测试真实连接、创建独立样例并导出 PNG / PSD。" },
  { id: "comfyui", name: "ComfyUI", description: "连接本机 ComfyUI，运行图像工作流并获取结果", category: "图像", auth: "local", url: "https://www.comfy.org/", help: "https://github.com/Comfy-Org/comfy-mcp", note: "使用 Comfy 官方本地 MCP。可复用已安装的 comfy-mcp 和 comfy CLI；留空程序路径时通过 uvx 运行固定版本 0.10.0 / 1.18.0，需要 uv 和 Python 3.10 以上。ComfyUI、模型和节点需另行安装并启动，本地工作流无需 API Key。" },
  { id: "google-drive", name: "Google Drive", description: "搜索和整理云端文件", category: "文件", auth: "google", url: "https://drive.google.com/", help: "https://developers.google.com/workspace/mcp", note: "需要启用 Google Workspace MCP，并使用已配置的 Google OAuth 客户端完成授权。" },
  { id: "google-gmail", name: "Gmail", description: "查找邮件、整理收件箱", category: "沟通", auth: "google", url: "https://mail.google.com/", help: "https://developers.google.com/workspace/mcp", note: "由 Google 授权页面确认邮件访问范围。需要已启用 Workspace MCP 的账号。" },
  { id: "google-calendar", name: "Google Calendar", description: "查询日程、协调会议", category: "日程", auth: "google", url: "https://calendar.google.com/", help: "https://developers.google.com/workspace/mcp", note: "由 Google 授权页面确认日历访问范围。组织管理员可能需要先启用服务。" },
  { id: "google-docs", name: "Google Docs", description: "阅读、创建和编辑文档", category: "文档", auth: "google", url: "https://docs.google.com/", help: "https://developers.google.com/workspace/mcp", note: "需要 Google Workspace MCP 权限，文档访问范围以授权账号为准。" },
  { id: "google-sheets", name: "Google Sheets", description: "处理电子表格和数据", category: "数据", auth: "google", url: "https://sheets.google.com/", help: "https://developers.google.com/workspace/mcp", note: "需要 Google Workspace MCP 权限，表格访问范围以授权账号为准。" },
  { id: "google-slides", name: "Google Slides", description: "整理演示文稿与幻灯片", category: "演示", auth: "google", url: "https://slides.google.com/", help: "https://developers.google.com/workspace/mcp", note: "需要 Google Workspace MCP 权限，演示文稿访问范围以授权账号为准。" },
  { id: "github", name: "GitHub", description: "查看代码、议题和拉取请求", category: "开发", auth: "token", url: "https://github.com/", help: "https://github.com/settings/personal-access-tokens", tokenLabel: "GitHub Personal Access Token", note: "请创建仅包含所需仓库和权限的令牌。使用 GitHub 官方远程 MCP 服务。" },
  { id: "notion", name: "Notion", description: "连接笔记、知识库与数据库", category: "知识", auth: "token", url: "https://www.notion.so/", help: "https://www.notion.so/profile/integrations", tokenLabel: "Notion Integration Token", note: "令牌兼容模式：需将页面共享给集成。安装会运行固定版本的官方本地 MCP 包（需要 Node.js / npm）；该本地服务已停止活跃维护。" },
  { id: "linear", name: "Linear", description: "跟进项目、议题与团队工作", category: "项目", auth: "token", url: "https://linear.app/", help: "https://linear.app/settings/account/security", tokenLabel: "Linear API Key", note: "连接 Linear 官方远程 MCP。请按实际需要设置 API Key 的团队和权限范围。" },
];

type Installation = { serverName: string; fingerprint: string; secrets: string[] };
function map(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("配置格式有误，请先修复 settings.json。");
  return value as Record<string, unknown>;
}
async function settings(): Promise<Record<string, unknown>> {
  try { return map(JSON.parse(await readFile(getUserSettingsPath(), "utf8"))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error("账号配置无法读取，请先修复 settings.json；原文件未改动。");
  }
}
function fingerprint(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function record(value: unknown): Installation | undefined {
  if (!value || typeof value !== "object") return;
  const item = value as Installation;
  if (typeof item.serverName === "string" && /^app-[a-z-]+$/.test(item.serverName) && typeof item.fingerprint === "string" && Array.isArray(item.secrets) && item.secrets.every((s) => typeof s === "string")) return item;
}
function owns(installation: Installation | undefined, servers: Record<string, unknown>): installation is Installation {
  return !!installation && !!servers[installation.serverName] && fingerprint(servers[installation.serverName]) === installation.fingerprint;
}

export async function webAppsView(workspace: string) {
  const config = await settings(), servers = map(config.mcpServers), installed = map(config.webAppConnections);
  const effective = (await loadMcpConfigs(workspace)).servers;
  return { apps: COMMON_APPS.map((app) => {
    const installation = record(installed[app.id]);
    const managed = owns(installation, servers);
    const shadowed = !!installation && effective[installation.serverName]?.scope !== "user";
    const entry = managed && !shadowed ? getMcpRegistryEntry(installation.serverName) : undefined;
    const connection = entry?.connection;
    const state = installation && (!managed || shadowed) ? "conflict" : !installation ? "available"
      : !isMcpServerEnabled(installation.serverName, effective[installation.serverName]!) ? "disabled"
      : connection?.type === "connected" ? (connection.discoveryError ? "degraded" : "connected")
      : connection?.type === "failed" ? "failed" : "pending";
    return { ...app, installed: !!installation, state, tools: entry?.tools.length ?? 0,
      ...(installation ? { serverName: installation.serverName } : {}),
      googleConfigured: app.auth === "google" && !!process.env.GOOGLE_MCP_CLIENT_ID && !!process.env.GOOGLE_MCP_CLIENT_SECRET,
      oauthConfigured: app.auth === "oauth" && !!process.env.CANVA_MCP_CLIENT_ID && !!process.env.CANVA_MCP_CLIENT_SECRET };
  }) };
}

/** Persists only catalog-owned entries. Runtime startup/cleanup is owned by the worker. */
export async function changeWebApp(workspace: string, body: Record<string, unknown>, onUninstall?: (name: string, config: McpServerConfig) => Promise<void>): Promise<{ serverName: string; removed: boolean }> {
  const app = COMMON_APPS.find((item) => item.id === body.id);
  if (!app || !["install", "uninstall"].includes(String(body.op))) throw new Error("请选择有效的应用和操作。");
  const secretRefs: string[] = [];
  let committed = false;
  let createdAutocad: McpServerConfig | undefined;
  let removedConfig: McpServerConfig | undefined;
  try {
    const result = await withFileTransaction(getUserSettingsPath(), async () => {
      const config = await settings(), servers = map(config.mcpServers), installed = map(config.webAppConnections);
      const current = record(installed[app.id]);
      const serverName = `app-${app.id}`;
      const effective = (await loadMcpConfigs(workspace)).servers;
      if (body.op === "uninstall") {
        if (!owns(current, servers) || effective[current.serverName]?.scope !== "user") throw new Error("该应用配置已被修改或覆盖，请在 MCP 设置中处理，避免删除其他配置。");
        removedConfig = servers[current.serverName] as McpServerConfig;
        delete servers[current.serverName]; delete installed[app.id];
        await writeJsonAtomically(getUserSettingsPath(), { ...config, mcpServers: servers, webAppConnections: installed });
        // Only remove dedicated secrets when no remaining setting references them.
        for (const ref of current.secrets) if (!JSON.stringify({ ...config, mcpServers: servers, webAppConnections: installed }).includes(ref.slice(2, -1))) secretRefs.push(ref);
        return { serverName: current.serverName, removed: true };
      }
      if (current || servers[serverName] || effective[serverName] || getMcpRegistryEntry(serverName)) throw new Error("该应用已安装或存在同名 MCP 配置，请先在 MCP 设置中检查。");
      const credentials = map(body.credentials);
      const save = async (key: string, value: unknown) => {
        if (typeof value !== "string" || !value.trim()) throw new Error(`请填写 ${key}。`);
        const ref = await storeWebSecret(`web-app:${app.id}:${randomUUID()}:${key}`, value);
        secretRefs.push(ref); return ref;
      };
      let server: McpServerConfig;
      if (app.auth === "local") {
        if (app.id === "sketchup") server = await buildSketchupMcpConfig(credentials);
        else if (app.id === "comfyui") server = await buildComfyuiMcpConfig(credentials);
        else if (app.id === "figma") server = buildFigmaMcpConfig(credentials);
        else if (app.id === "autocad") server = createdAutocad = await buildAutocadMcpConfig(credentials);
        else if (app.id === "photoshop") server = await buildPhotoshopMcpConfig();
        else throw new Error("此本地应用尚未配置连接方式。");
      } else if (app.auth === "google") {
        const supplied = !!credentials.clientId || !!credentials.clientSecret;
        if (!supplied && (!process.env.GOOGLE_MCP_CLIENT_ID || !process.env.GOOGLE_MCP_CLIENT_SECRET)) throw new Error("请先配置 Google OAuth 客户端 ID 和客户端密钥。");
        const clientIdEnv = supplied ? (await save("Google Client ID", credentials.clientId)).slice(2, -1) : "GOOGLE_MCP_CLIENT_ID";
        const clientSecretEnv = supplied ? (await save("Google Client Secret", credentials.clientSecret)).slice(2, -1) : "GOOGLE_MCP_CLIENT_SECRET";
        server = { type: "http", url: GOOGLE_WORKSPACE_MCP_ENDPOINTS[app.id as keyof typeof GOOGLE_WORKSPACE_MCP_ENDPOINTS], oauth: { provider: "google", clientIdEnv, clientSecretEnv, redirectUri: DEFAULT_GOOGLE_MCP_REDIRECT_URI } };
      } else if (app.auth === "oauth") {
        const supplied = !!credentials.clientId || !!credentials.clientSecret;
        if (!supplied && (!process.env.CANVA_MCP_CLIENT_ID || !process.env.CANVA_MCP_CLIENT_SECRET)) throw new Error("请先配置 Canva Client ID 和 Client Secret。");
        const rawRedirect = credentials.redirectUri === undefined || credentials.redirectUri === "" ? DEFAULT_CANVA_REDIRECT_URI : credentials.redirectUri;
        if (typeof rawRedirect !== "string" || !/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}\/oauth\/callback$/.test(rawRedirect)) throw new Error("Canva 回调地址须为 http://127.0.0.1:端口/oauth/callback，且与开发者门户完全一致。");
        let redirectUri: string;
        try { const redirect = new URL(rawRedirect); if (!redirect.port) throw new Error(); redirectUri = redirect.href; } catch { throw new Error("Canva 回调地址端口无效，请使用 1024 以上的本机端口。"); }
        const clientIdEnv = supplied ? (await save("Canva Client ID", credentials.clientId)).slice(2, -1) : "CANVA_MCP_CLIENT_ID";
        const clientSecretEnv = supplied ? (await save("Canva Client Secret", credentials.clientSecret)).slice(2, -1) : "CANVA_MCP_CLIENT_SECRET";
        server = { type: "http", url: CANVA_MCP_URL, oauth: { provider: "browser", clientIdEnv, clientSecretEnv, redirectUri } };
      } else {
        const token = await save(app.tokenLabel!, credentials.token);
        server = app.id === "notion"
          ? { command: "npx", args: ["-y", "@notionhq/notion-mcp-server@2.6.1"], env: { NOTION_TOKEN: token } }
          : { type: "http", url: app.id === "github" ? "https://api.githubcopilot.com/mcp/" : "https://mcp.linear.app/mcp", headers: { Authorization: `Bearer ${token}` } };
      }
      servers[serverName] = server;
      installed[app.id] = { serverName, fingerprint: fingerprint(server), secrets: [...secretRefs] } satisfies Installation;
      await writeJsonAtomically(getUserSettingsPath(), { ...config, mcpServers: servers, webAppConnections: installed });
      return { serverName, removed: false };
    });
    committed = true;
    resetSettingsCache();
    if (result.removed && removedConfig) {
      try {
      // Stop active transports and drain token writes before removing account credentials.
      await onUninstall?.(result.serverName, removedConfig);
      if (removedConfig.type === "http" && removedConfig.oauth?.provider === "browser" && process.env[removedConfig.oauth.clientIdEnv]) {
        const oauth = removedConfig.oauth;
        const serverUrl = new URL(removedConfig.url).href;
        const others = Object.values((await loadMcpConfigs(workspace)).servers);
        const shared = others.some((item) => item.type === "http" && item.oauth?.provider === "browser"
          && new URL(item.url).href === serverUrl
          && item.oauth.redirectUri === oauth.redirectUri
          && process.env[item.oauth.clientIdEnv]?.trim() === process.env[oauth.clientIdEnv]?.trim());
        if (!shared) await clearBrowserMcpOAuthCredentials(removedConfig.url, oauth);
      }
      if (app.id === "autocad") await removeAutocadMcpConfig(removedConfig);
      for (const ref of secretRefs) await removeWebSecret(ref);
      } catch {
        throw new Error("应用入口已卸载，但本机连接或凭据清理未完成。请关闭相关 MCP 连接，并在 MCP 设置中检查本机配置；远端资料未删除。");
      }
    }
    return result;
  } finally {
    if (!committed) {
      if (createdAutocad) await removeAutocadMcpConfig(createdAutocad);
      for (const ref of secretRefs) await removeWebSecret(ref);
    }
  }
}
