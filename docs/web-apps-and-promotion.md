# Web 常用应用与首页广告

本轮只优化 Web 端，不生成 EXE。

## 用户入口

侧栏「插件」→「发现」：SketchUp、Adobe Photoshop、ComfyUI、Google Drive、Gmail、Google Calendar、Google Docs、Google Sheets、Google Slides、GitHub、Notion、Linear 的图标、用途和 MCP 状态。点击卡片查看连接要求并安装；「已安装」管理自己的应用。市场插件仍使用原有预览、安装、更新和卸载引擎。

Photoshop 无需填写 API Key，连接本机软件并提供连接／独立样例导出测试；接入方式和实测范围见 [Photoshop MCP Web](photoshop-mcp-web.md)。

ComfyUI 接入官方本地 stdio MCP，支持 uvx 固定版本和复用已有程序，提供只读状态检查；需要在运行 CCAGENT 的电脑上启动 ComfyUI，接入方式和实测范围见 [ComfyUI MCP Web](comfyui-mcp-web.md)。

SketchUp 接入社区 `sketchup-mcp2` 0.4.0，支持复用本机专用运行环境、端口配置与只读模型连接检查；本机 SketchUp 2025 已完成签名扩展安装和基础建模／导出实测。使用步骤和验收边界见 [SketchUp MCP Web](sketchup-mcp-web.md)。

- Google：沿用 Google Workspace MCP OAuth。服务端已配置 `GOOGLE_MCP_CLIENT_ID` / `GOOGLE_MCP_CLIENT_SECRET` 时可直接安装，否则在窗口填写自己的 OAuth Web 客户端。重定向 URI 为 `http://127.0.0.1:53682/oauth/callback`。安装后点击「授权连接」才打开浏览器；组织管理员须启用相应服务，仍受 Google 的权限限制。
- GitHub：填写 Personal Access Token，连接官方 `https://api.githubcopilot.com/mcp/`。
- Linear：填写 API Key，连接官方 `https://mcp.linear.app/mcp`。
- Notion：Integration Token 兼容模式，须共享所需页面。首次运行固定版本 `@notionhq/notion-mcp-server@2.6.1`，需要服务所在电脑具备 Node.js / npm 和网络。此官方本地服务已停止活跃维护，连接窗口已说明；没有宣称支持 Notion 远程 OAuth。

「已连接」表示 MCP 握手及工具发现成功，不代表每个远端文档或写操作都已经验收。断开会移除工具，保留配置，可重连。

## 配置与卸载

安装记录和 MCP 配置位于当前账号私有目录的 `settings.json`：`webAppConnections` 与 `mcpServers.app-*`。专用凭据存入同目录 `web-secrets.env`，配置仅保存环境变量引用。HTTP/SSE 请求头及 stdio 环境变量在启动连接时解析引用，缺少变量会明确失败。CLI 和 Web 共用 MCP 工具及权限系统。

卸载只删除本入口创建且未被修改或覆盖的配置，关闭连接并删除专用凭据；不删除远端资料。仍被其他设置引用的凭据保留。Google 本机 OAuth 缓存仅在同一服务没有其他连接使用时清理。第三方授权可在对应平台账号设置中撤销。任务、后台 Agent 或团队运行时禁止修改连接。

## 首页广告

广告配置：`web/promotion.js` 的 `HOME_PROMOTION`。可修改名称、说明、按钮、HTTPS 网址、活动 ID 与 `enabled`。目前启用文字广告，跳转至[中国建筑西北设计研究院有限公司官网](https://nwin.cscec.com/)。建筑图形是 CSS 装饰，未使用院方项目图片或标志。

仅在登录后的任务首页空闲、无待发内容和其他弹窗时展示。支持关闭、Escape、外部区域点击、键盘焦点约束与恢复。链接使用新标签和 `noopener noreferrer`。同一浏览器每个账号、每个活动每天最多自动展示一次，刷新保留频次；清理浏览器存储会重置频次。存储被禁用时退回当前页面计数。尚无云端投放管理后台，配置随 Web 资源发布。

## 验证

- `npm.cmd run typecheck` / `npm.cmd run build`
- `npm.cmd run test:web-integrations`：汇总应用目录、界面以及 ComfyUI、SketchUp、Photoshop 和 MCP 连接超时的现有专项，随 `test:web` 及 `verify:release` 执行。
- `npm.cmd run test:platform-enforcement`：真实本机 HTTP 与隔离账户，覆盖新应用目录及四个操作入口的未登录、退出、禁用和认证故障拦截，以及应用配置跨账户隔离、凭据不回显和跨账户卸载保护。首个认证故障或禁用请求关闭工作进程，后续业务请求继续拒绝，恢复后须经账户状态检查才能重新使用。
- `npm.cmd run test:web-apps`：账号隔离、配置保留、凭据引用、失败回滚、真实本地 MCP 工具执行、断开和卸载保护；卡片与广告交互。
- `npm.cmd run test:mcp-controls`：MCP 启停、取消、工具权限与 Google OAuth 既有回归。
- `node --import tsx src/scripts/test-web.ts` / `npm.cmd run test:web-ui`：Web 服务及界面回归。

测试使用隔离账号和本地 MCP 服务，第三方真实账号仍需用户授权后验收。图标来自 [Simple Icons](https://simpleicons.org/)（CC0），内置在 `web/app-icons.js`，运行时不请求第三方图片。品牌权利属于各自权利人。

2026-11-07 已通过上述检查，并使用 Playwright 在 1440×1000 与 390×844 下核对了卡片、连接窗口和广告。验证截图保存于 `output/playwright/app-catalog-desktop.png`、`app-catalog-mobile.png`、`app-connect-mobile.png`、`home-promotion-desktop.png` 与 `home-promotion-mobile.png`。未部署到远程平台。
