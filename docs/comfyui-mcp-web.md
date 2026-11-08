# ComfyUI 本地 MCP（Web）

## 使用入口

Web 侧栏「插件」→「发现」→ **ComfyUI**。卡片提供本地图标、安装、重新检测、断开、重新连接、卸载与只读连接测试。「已安装」也可管理该入口。

填写本机 ComfyUI 地址，默认 `http://127.0.0.1:8188`，可以修改端口。仅接受 `http://localhost`、`http://127.0.0.1`、`http://[::1]` 根地址；不能填写远程域名、代理路径或带令牌的 URL。

程序路径有两种用法：

- 已安装官方工具：填写 `comfy-mcp.exe` 的绝对路径。若同目录存在 `comfy.exe`，自动复用；否则同时填写 comfy CLI 的绝对路径。macOS / Linux 使用无 `.exe` 后缀的程序。
- 留空程序路径：通过 `uvx --no-config --from comfy-mcp==0.10.0 --with comfy-cli==1.18.0 comfy-mcp` 运行固定版本。需要 uv 与 Python 3.10 以上；首次连接会下载独立工具环境。Windows 优先使用用户 `.local/bin/uvx.exe`，不存在时使用 PATH 中的 uvx。

开发者可在启动 CCAGENT 前设置 `CCAGENT_COMFY_MCP_EXECUTABLE`、`CCAGENT_COMFY_CLI_EXECUTABLE`，指定已有程序；也可用 `CCAGENT_UVX_EXECUTABLE` 指定 uvx 的绝对路径。界面填写的非空程序路径优先。

ComfyUI 本体、模型和自定义节点由用户另行安装和启动。**本机指运行 CCAGENT 后端的电脑。** 部署在远程平台的纯 Web 后端不能直接访问用户浏览器所在电脑的 localhost；本入口用于本地 Web 服务，不是 Comfy Cloud 接入。普通本地工作流无需 API Key。

## 连接与测试

「MCP 已连接」只表示官方 MCP 完成握手并发现工具。点击「测试连接」后，后端只调用该连接的固定 `server_info` 工具，分别展示 MCP 状态、ComfyUI 运行状态、实际工具数量及上游报告的 comfy-cli 版本。不会由 CLI 版本推断 ComfyUI 版本。

当 ComfyUI 未启动时，显示「MCP 已连接，本地 ComfyUI 尚未运行」，不会显示就绪。运行状态为真且上游地址通过本机地址校验后，才显示连接测试通过。测试不会启动服务、下载模型或执行生成。检测到本地软件或节点更新时会显示提示。

安装后，官方 MCP 工具进入现有 CLI / Web 的 MCP 注册表和 QueryEngine，正常对话中的工具调用继续使用现有权限系统。连接测试接口不接受浏览器提供的工具名、脚本或工作流。

## 配置与卸载

账号私有 `settings.json` 保存 `mcpServers.app-comfyui` 与安装归属记录，复用已有插件配置冲突保护。安装不保存 API Key。断开移除运行时工具但保留配置；卸载只移除本入口创建且未被修改或覆盖的配置，保留 ComfyUI、模型、工作流和外部工具程序。

MCP 使用 stdio 子进程。配置设置 `COMFY_LOCAL_URL`，清空继承的 `COMFYUI_URL`、`COMFYUI_HOST`、`COMFYUI_PORT`，避免工作流被环境中的远程目标转走。`COMFY_BIN` 指向选定的 comfy CLI。禁用 comfy-cli 遥测。

首次安装连接超时为 180 秒；单次工具调用超时为 120 秒。长生成宜使用上游的异步任务提交和状态查询。uv 使用按账号目录哈希分开的短临时缓存，并限制下载和安装并发，降低 Windows 深路径与缓存提交失败的影响；缓存只含公共依赖，可以重新生成。

官方 MCP 作为外部程序运行，未将其服务端源码或 Python 依赖打包进 CCAGENT。

## 2026-11-07 验证范围

使用隔离测试账号、真实 Comfy 官方 MCP 0.10.0 和 comfy-cli 1.18.0，完成 Web 安装、发现 **39 个工具**、只读状态检查、断开后移除工具、重连与卸载。未登录生产账号、修改生产配置或执行付费调用。

默认 uvx 启动配置也已完成真实握手并发现 39 个工具，记录在 `output/checks/comfyui-default-live.json`。本机早期 PATH 中的旧 uvx 与较长缓存路径组合曾发生 Windows 缓存重命名错误；调整为独立 uvx、账号隔离短缓存及单并发后复测通过。

当时本机 ComfyUI 未运行，真实结果为 `mcpConnected: true`、`serverRunning: false`、`ok: false`，因此**未验收图像生成、模型加载、工作流输出或全部工具功能**。没有为测试启动、升级或修改本机 ComfyUI。

Playwright 已检查 1440×1000 与 390×844 布局，并从界面实际安装和触发状态检查。实测记录在 `output/checks/comfyui-web-live.json`，截图在 `output/playwright/comfyui-web-desktop.png` 与 `comfyui-web-mobile.png`。

自动检查：

- `npm.cmd run typecheck` / `npm.cmd run build`
- `npm.cmd run test:web-comfyui`：本机地址、固定版本、已有程序、账号缓存隔离、固定只读调用、异常结果和诊断脱敏、界面成功／未运行／错误／重复点击／工作区切换／卸载。
- `npm.cmd run test:web-apps`：账号配置保护、并发持久化、凭据与 MCP 现有流程。
- `npm.cmd run test:web-photoshop`、`node --import tsx src/scripts/test-web.ts`、`npm.cmd run test:web-ui`：已有插件、Web HTTP 与界面回归。

离线模拟测试与真实 MCP 检查分开记录，不将模拟服务的成功状态视为真实 ComfyUI 已启动。

## 官方资料

- [Comfy 本地 MCP 接入说明](https://docs.comfy.org/agent-tools/mcp)
- [Comfy-Org/comfy-mcp](https://github.com/Comfy-Org/comfy-mcp)
- [comfy-mcp 0.10.0](https://pypi.org/project/comfy-mcp/0.10.0/)
- [uv 工具隔离与版本选择](https://docs.astral.sh/uv/guides/tools/)
