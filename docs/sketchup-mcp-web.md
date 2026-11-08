# SketchUp 本地 MCP 安装与 Web 接入

## 本次安装结果

已在本机 **SketchUp 2025（25.0.660）** 安装社区 MIT 开源项目 `zinin/sketchup-mcp2` 的 **0.4.0 签名 RBZ**，并安装配套 Python MCP 0.4.0。两端版本已通过真实握手与模型读取验证，发现 22 个工具。不是 Trimble 官方 Claude Connector。

安装位置：

- 原生扩展：`%APPDATA%\SketchUp\SketchUp 2025\SketchUp\Plugins\mcp_for_sketchup.rb` 与同名支持目录。
- 独立 Python 运行环境：`%LOCALAPPDATA%\CCAGENT\integrations\sketchup-mcp\0.4.0`。
- MCP 程序：上述目录中的 `Scripts\sketchup-mcp2.exe`。
- 已校验安装包：工作区 `output/checks/sketchup-install/`，含原始签名 RBZ、wheel、发布清单与原生安装记录 `native-install.json`。

原有 SketchUp 扩展和系统 Python 保留。安装没有修改 SketchUp 的授权、扩展加载策略或软件版本。

## 日常使用

1. 打开 SketchUp 和需要处理的模型。
2. 在 SketchUp 的「扩展／插件 → MCP Server → Start Server」启动服务。上游扩展不会在每次打开 SketchUp 时自动启动服务器。
3. Web 侧栏「插件 → 发现 → SketchUp」，点击「安装并连接」。端口默认 `9876`，程序路径可以留空：自动复用本次安装的专用运行环境。
4. 点击「测试连接」，确认显示 **SketchUp 连接测试通过**。只显示「MCP 已连接」尚不能证明原生软件连接正常。

Web 中的安装登记按登录账号隔离。当前默认 CLI 尚未配置官方账号服务；本轮 Web 验证使用临时隔离测试账号，没有创建或替代生产账号。实际用户登录后须在自己的插件库登记该连接，本机原生扩展和 Python 环境无需重复安装。

模型操作工具随后进入现有 CLI / Web MCP 注册表，继续使用现有 QueryEngine 与工具权限。输入描述时写明尺寸和单位；本桥接使用毫米。

## 设置与限制

本机扩展已设置 `host=127.0.0.1`、`port=9876`，并保存 **`eval_enabled=false`**。基础建模工具仍可用，任意 Ruby 执行入口保持关闭。不要为了连接改变 SketchUp 的认证或扩展安全策略。

Web 提供安装、重新检测、只读测试、断开、重连与卸载。卸载 Web 入口仅移除当前账号中本入口创建的配置，保留本机 SketchUp、原生 RBZ、Python 环境和模型文件。

「测试连接」固定调用该服务器的 `get_version` 和 `get_model_info`，不会接收浏览器提交的脚本、Ruby、导出路径或模型修改参数；不会创建、保存或修改模型。两端兼容并返回有效模型信息后才显示通过。原始模型路径、标题及诊断不会返回界面。

上游 `ruby_version=0.4.0` 是 Ruby 扩展版本，不是 SketchUp 或 Ruby 解释器版本。该上游版本未在这两个工具中返回 SketchUp 应用版本，因此界面不推断或冒充应用版本；本次实际 25.0.660 由 SketchUp 原生安装 API 记录确认。

视口截图工具上游要求 **SketchUp 2026+**，本机 2025 未验收截图，Web 未提供截图测试按钮。没有验收全部工具；上游仍列有燕尾榫、指接榫几何问题，不能将这些功能视为已验证。

此入口连接运行 CCAGENT 后端所在电脑的 SketchUp。远程纯云端 Web 仍需要本地连接器，不能通过浏览器 localhost 直接控制本机软件。

## 运行时配置

账号私有 `settings.json` 使用 `mcpServers.app-sketchup` 与归属记录 `webAppConnections.sketchup`。本机无需 API Key。

程序路径选择顺序：界面填写的非空绝对路径 → `CCAGENT_SKETCHUP_MCP_EXECUTABLE` → 本次固定版本的安装目录 → uvx 后备运行器。后备命令固定为：

```text
uvx --no-config --from sketchup-mcp2==0.4.0 sketchup-mcp2
```

uvx 后备方式要求 uv 与 Python 3.10 以上；Windows 优先使用用户 `.local/bin/uvx.exe`，也可由 `CCAGENT_UVX_EXECUTABLE` 指定。缓存按账号隔离并保持短路径，限制下载／安装并发。

环境固定 `SKETCHUP_MCP_HOST=127.0.0.1`；可填写 1–65535 的整数端口，并与 SketchUp 扩展保持一致。上游调用超时 60 秒，CCAGENT 工具超时 90 秒，首次连接超时 180 秒。修改模型的调用若超时，先读取模型状态再决定是否重试。

## 实测与回归

2026-11-07 使用真实本机软件与独立模板副本完成：

- 两端 0.4.0 兼容握手、发现 22 个工具、读取模型。
- 创建 `1200 × 800 × 200 mm` 长方体、校验实际边界、设置蓝色材质。
- 导出并校验 SKP 文件头和 STL 结构，样例为 `output/checks/sketchup-mcp-test.skp`、`sketchup-mcp-test.stl`。
- 两次撤销后，测试模型路径、实体数、边界和图层恢复到初始状态。未处理业务模型。
- 使用隔离账号验证 Web 真实连接、未登录拒绝、任意脚本参数拒绝、断开移除工具、重连和卸载保留其他配置。

证据分别在 `output/checks/sketchup-mcp-live.json`、`sketchup-native-live.json`、`sketchup-web-live.json`。测试和生成文件没有提交或部署到远程平台。

Playwright 已从界面实际安装并点击测试，显示「SketchUp 连接测试通过」。1440×1000 与 390×844 截图保存在 `output/playwright/sketchup-web-desktop.png`、`sketchup-web-mobile.png`、`sketchup-web-mobile-result.png`。本机 SketchUp 服务保持运行；临时测试网页会关闭。

通过的自动检查：`npm.cmd run typecheck`、`npm.cmd run build`、`npm.cmd run test:web-sketchup`、`npm.cmd run test:web-apps`、ComfyUI／Photoshop 既有回归、Web HTTP 与界面回归。离线模拟测试与真实 SketchUp 验证分别记录。

## 下载来源与校验

固定 [0.4.0 发布页](https://github.com/zinin/sketchup-mcp2/releases/tag/v0.4.0)，下载后按发布清单核对 SHA256：

| 文件 | SHA256 |
|---|---|
| `mcp_for_sketchup_v0.4.0-signed.rbz` | `723a041878d61d92dba85cceabae01c7868f1152012de732cea7b9a776abf05a` |
| `sketchup_mcp2-0.4.0-py3-none-any.whl` | `a551b8bdc654d9e44d3983dcf85203a85f1d5b3c91ec4b1c7855d9fc934ca283` |

签名包保持原样，通过 SketchUp 原生 `install_from_archive` API 安装，未修改其加密代码或签名文件。
