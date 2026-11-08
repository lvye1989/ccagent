# Photoshop MCP Web 接入与实测

## 入口与使用

在 CCAGENT Web 侧栏打开「插件」→「Adobe Photoshop」→「安装并连接」。无需为 Photoshop MCP 填写大模型 API Key，应用继续使用自己的模型和权限体系。安装完成后：

1. 启动本机 Photoshop。
2. 点击「测试连接」读取真实运行版本与打开的文档数量。
3. 点击「创建测试图并导出」创建独立的 960×540 测试文档，写入背景和两个文字图层，另存 PNG、PSD，然后关闭测试文档并恢复原来的文档焦点、标尺与对话框设置。
4. 使用结果中的「预览 PNG」「下载 PSD」「下载测试报告」。输出位于当前工作文件夹的 `output/photoshop-mcp-tests/<本次测试ID>/`。

界面分别显示 MCP 握手状态与 Photoshop 实机测试状态；MCP 已连接不等于 Photoshop 已经可用。断开连接会移除当前 MCP 工具；卸载仅移除当前账号中的连接配置，保留 Photoshop、工作文件和测试输出。

## 实现

- 社区项目：[alisaitteke/photoshop-mcp](https://github.com/alisaitteke/photoshop-mcp)，固定 `@alisaitteke/photoshop-mcp@1.7.37`，MIT。Photoshop 本体需要用户自备，社区桥接并非 Adobe 官方产品。
- 当前路线：Web → 账号私有 Worker → 共享 MCP 工具注册表 → 本地 stdio MCP → Windows COM / ExtendScript → Photoshop。基础测试不需要 UXP 插件。
- 连接配置由 `src/services/mcp/photoshop.ts` 生成；优先发现本机 Photoshop 安装路径，可通过可信环境变量 `PHOTOSHOP_PATH` 指定其他路径。
- 默认通过 npx 启动固定版本，首次安装可能联网下载依赖。单服务 `connectTimeoutMs` 为 180000，避免首次下载被默认 30 秒连接时限中断。其他 MCP 保持原默认值与 Google OAuth 授权时限。
- npx 优先复用已验证的下载缓存，并禁用安装脚本；本接入使用纯 MCP 服务，不启动上游独立聊天 UI。
- 预安装部署可设置 `CCAGENT_PHOTOSHOP_MCP_ENTRY` 为该固定版本的 `dist/index.js` 绝对路径；启动前检查相邻 package.json 的包名与版本。这样可从已安装的运行时启动，而不用重复在线安装。
- 禁用社区服务的匿名统计、反馈提示和更新检查；其私有数据目录位于当前账号的 integrations/photoshop。上游始终建立一个 loopback UXP 桥，本接入让系统分配空闲端口，基础 COM 测试不使用该桥。

测试接口只接受 `connection` / `sample` 两种固定操作，浏览器不能提交任意脚本、工具名或输出文件路径。需要已登录账号、同源及本地请求标头；任务、后台 Agent、团队或配置操作运行期间拒绝测试。跨 Worker 的测试通过本机文件锁串行执行，避免同时操作同一 Photoshop。

样例由固定脚本创建并只操作自己的文档；输出目录检查真实路径，拒绝越出工作文件夹的目录链接。完成后独立检查 PNG 签名和尺寸、PSD 签名和可编辑图层数，计算 SHA-256，再验证原文档 ID 和焦点已经恢复。结果文件链接绑定工作区，切换工作区后清除旧结果。

如果 Photoshop 调用超时，脚本可能仍在 Photoshop 中执行。请先等待并执行连接测试，不要立即反复点击样例导出。Windows 安装检测可能把年份当版本，因此实机验证读取 `app.version`，不采用上游安装检测返回的年份来宣布成功。

## 2026-11-07 实测结果

Web 验收采用隔离的本地测试账号；Photoshop 和图像输出使用真实本机软件。没有修改用户现有账号、计费配置或工作文件，也没有进行云端部署或 EXE 封装。

| 检查 | 结果 |
| --- | --- |
| Photoshop 脚本真实响应 | 通过，运行版本 27.2.0 |
| MCP 工具发现 | 128 个 |
| 默认 npx 固定版本启动 | 通过；启用 TLS 验证、关闭安装脚本 |
| Web 安装和测试按钮 | 通过 |
| 新建文档、图层和文字 | 通过 |
| PNG 导出与尺寸 | 960×540，文件头和实际预览检查通过 |
| PSD 导出与可编辑图层 | 4 个图层 |
| Web 预览／下载文件 | 内容哈希与本地输出一致 |
| 断开／重新连接 | 断开后工具移除且测试被拒绝，重连后实机测试通过 |
| 原文档状态 | 测试前后均无打开文档，测试标签已关闭 |

独立汇总报告：`output/checks/photoshop-web-live.json`；测试输出：`output/checks/photoshop-web-test.png`、`output/checks/photoshop-web-test.psd`。浏览器截图位于 `output/playwright/photoshop-web-desktop.png`、`output/playwright/photoshop-web-mobile-result.png`；已核对 1440px 桌面与 390px 手机布局。隔离 Web 验收服务结束后自动停止，测试报告和输出保留。

本轮验证覆盖基础连接、固定样例编辑和导出；没有逐一验收全部 128 个工具，也未验收神经滤镜、Firefly 生成式能力或生产账号的自然语言修图效果。

## 回归命令

`npm.cmd run test:web-photoshop` 是离线回归，只检查错误处理、目录边界、配置、超时和 UI，不启动 Photoshop，不可替代上表实机验收。另执行类型检查、构建、Web HTTP/UI 与 MCP 控制回归。
