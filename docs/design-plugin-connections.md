# 设计类插件连接

在 Web 的「插件」页面，「常用应用」提供 Canva（可画）、Figma 和 AutoCAD 的图标卡片。点击卡片添加当前账号的 MCP 配置，连接成功后工具进入现有 Agent 工具引擎，沿用当前权限设置。服务实际完成连接后才显示「已连接」；添加配置、授权等待和连接失败分别显示。

## Canva（可画）

这里按 Canva 设计平台理解用户所说的 canvas。使用官方 Streamable HTTP 端点 `https://api.canva.com/connect/v1/mcp`，无需手工粘贴访问令牌。

1. 在 [Canva 开发者门户](https://www.canva.dev/docs/apps/mcp/access/)创建应用并启用 Canva MCP。
2. 登记 `http://127.0.0.1:53683/oauth/callback` 回调地址（可在表单中更改本机端口，但必须与门户一致）。
3. 打开 Canva 卡片，填写 Client ID 和 Client Secret，添加连接。
4. 点击「授权连接」，在浏览器确认访问权限。普通启动和重新检测不会自动弹出授权浏览器。

管理员也可预先设置 `CANVA_MCP_CLIENT_ID` / `CANVA_MCP_CLIENT_SECRET`，用户仍需逐账号授权。表单凭据存于账号私有配置，工作目录设置只保存引用；访问/刷新令牌通过本机安全凭据存储保存，Windows 使用 DPAPI。OAuth 支持 PKCE、state、受校验的本机回调、取消和超时。卸载先停止连接及在途令牌写入，再清理专用本机登录；不会撤销远端授权或删除设计文件。

可用能力以授权账号和 `tools/list` 的实际返回为准。本轮未使用真实 Canva 客户端授权进行云端验收。

## Figma

采用 [Figma 官方桌面 MCP](https://developers.figma.com/docs/figma-mcp-server/local-server-installation/)。在运行 CCAGENT 的同一台电脑上启动 Figma Desktop，打开设计文件，在 Dev Mode 中启用 MCP Server。默认地址 `http://127.0.0.1:3845/mcp`，卡片只接受本机 HTTP `/mcp` 地址，不需要 API Key。按官方要求准备适用套餐和席位。

桌面 MCP 提供设计上下文读取，不支持直接写入画布。官方远程 MCP 的客户端准入与桌面模式不同，本入口不承诺 CCAGENT 获得远程客户端资格。纯云端部署访问的是服务器本机，不能直接连接用户电脑；本地 Web / Windows 客户端适用。

## AutoCAD

采用社区 [C48H74/autocad-mcp](https://github.com/C48H74/autocad-mcp) v0.3.1，固定提交 `2966d7f05523386b1b55582260e958ecb6f288d1`。相较需要额外 .NET 插件加载的方案，该实现可由 Windows 本地 stdio + COM 接入，适合本项目现有 MCP 引擎。它不是 Autodesk 官方服务。

填写已存在的专用 CAD 工作目录。默认 COM 标识 `AutoCAD.Application.25` 对应本机 AutoCAD 2025，2020 可填写 `AutoCAD.Application.23.1`。可指定已安装的 MCP 可执行程序；留空时使用 uvx，首次连接需要联网下载固定版本源码、依赖及 Python 3.11。AutoCAD 本体和 uv 需另行准备。

连接创建账号私有的唯一 TOML：关闭自动启动和 Lisp，限制导出目录。原生 COM 命令操作 AutoCAD 当前活动 DWG，目录限制不能当作活动图纸的读写沙箱；操作前核对图纸并保留副本。DWG 只支持当前已命名文件保存，不能承诺任意路径另存。详见 [AutoCAD 接入说明](autocad-mcp.md)。

本机发现 AutoCAD 2020 / 2025，但本轮未启动、连接或修改图纸。上游的实机记录不能代替本机版本验收。MCP 工具服务连通也不等于 AutoCAD 已启动或打开图纸。

## 验证

`npm run test:design-plugins` 覆盖真实本地 HTTP MCP 工具调用、OAuth 授权协议、凭据隔离与清理、CAD 配置和图纸保留。`npm run test:web-apps` 同时执行完整插件库 DOM 回归，覆盖旧应用及新增图标、表单、连接状态和卸载。真实第三方账号授权和 AutoCAD 绘图仍需在各自环境中验收。
