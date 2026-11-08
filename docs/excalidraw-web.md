# Excalidraw Web 画布

## 入口与使用

登录 CCAGENT Web 后，点击左侧导航栏的「画布 · Excalidraw」打开白板。编辑器在进入画布后按需加载，使用本地打包的 `@excalidraw/excalidraw` **0.18.1**，不是外部网站 iframe，也不需要 Excalidraw API Key。

画布支持图形、箭头、文字、自由绘制、图片和框架。页面提供：

- 新建白板、选择已保存的白板、修改名称。
- 自动保存和「保存」按钮。
- 导入 `.excalidraw` JSON 文件；导入会创建新白板。
- 导出可继续编辑的 `.excalidraw` 文件，以及 PNG、SVG 图片。

下载文件以白板名称命名；浏览器负责选择下载位置。JSON 导出包含画布元素、支持的画布设置和内嵌图片。PNG、SVG 用于查看或分享，继续编辑请保留 `.excalidraw` 文件。

## AI 对话与自动绘图

AI 绘图输出可编辑的 Excalidraw 元素。ChatGPT 生图 API 仍待凭据方式确认，按《临时记录.md》中的独立需求接入和验收。

打开白板右侧的「AI 绘图」面板，选择应用已配置的可用模型，输入需求并发送，例如「画一张城市更新项目流程图，包含现状调研、方案评估、公众参与和实施运营」。画布 Agent 会读取现有元素，再调用绘图工具生成可编辑的图形、文字和连线；可继续发送需求调整布局、文字或指定图形。

AI 绘图复用 CCAGENT 的 QueryEngine、模型配置和登录检查。平台模型继续走原有服务网关及计费链路，个人模型沿用已有接入配置。模型选择器中没有可用模型时，先到应用设置完成模型接入。此面板中的专用 Agent 使用画布读取和绘图工具；这些工具不具备文件、Shell、浏览器或外部应用执行能力。画布文字、元素位置等摘要会随绘图需求发送给所选模型，内嵌图片数据不会发送。

生成期间可以停止请求。结果仅在当前白板与生成前画布内容一致时自动应用；若用户已继续编辑、切换白板或工作文件夹，迟到结果不会覆盖当前内容。绘图以一次可撤销操作进入编辑器，随后沿用自动保存。发生版本冲突时，仍可下载副本或另存为新白板。面板上方可「新对话」，会话过期后也可重试最新需求。AI 对话用于当前页面和服务进程中的续聊；画布文件独立持久保存。

自动生成的布局和文字仍需按实际业务检查。示例需求可以直接发送，也可先手工画出框架，再要求 Agent 补充节点、连线或调整样式。

## 保存、账号与工作文件夹

画布通过现有登录账号的私有 Web 后端保存为本地 JSON，按**账号和工作文件夹**隔离。它不依赖浏览器 `localStorage`，也不会自动写入当前项目目录、上传 Supabase 或创建云端 Excalidraw 文档。

存储结构为：

```text
<账号私有 CCAGENT_HOME>/whiteboards/<工作文件夹真实路径的 SHA-256>/<白板 UUID>.json
```

账号私有根目录沿用现有 Web 账户隔离机制。工作文件夹先解析为真实路径，同一目录的路径别名共享白板；切换到其他目录后显示该目录的白板列表。迁移到另一台机器或交给其他账号时，使用 `.excalidraw` 导出、导入。

最后一次编辑约 **800 毫秒**后自动保存；连续编辑会重新计时。状态栏显示保存中、已保存或错误。切换白板、离开画布及切换工作文件夹前会尝试完成保存；保存失败时保留当前更改，并提供重试或导出副本的恢复入口。关闭仍有未保存更改的页面时，浏览器会提示。

每次成功保存都会增加 `revision`。多个标签页同时打开同一白板时，后端只接受与当前版本一致的保存请求；过期版本返回 HTTP `409`、`code: "conflict"`，不覆盖较新的文件。发生冲突后自动保存暂停，当前编辑内容仍保留在页面中，可「下载未保存副本」或「另存为新白板」。保留副本后再重新打开最新版本；本次没有自动合并功能。

## 文件范围与限制

- 单个导入文件和保存的白板上限为 **10 MiB**，元素上限为 **10,000**；内嵌图片也计入总大小。
- JSON 文件须为 Excalidraw `type: "excalidraw"`、`version: 2` 格式。导入时会校验元素、图片和设置；无效内容不会覆盖现有文件。
- 保存的内嵌图片支持 PNG、JPEG、WebP、GIF。远程图片地址及 SVG 图片数据不在本次导入范围内；画布本身仍可导出为 SVG。
- 不接受 iframe、网页嵌入或任意脚本。画布链接不会在编辑器中打开外部页面。
- 页面临时状态（选中项、协作者、弹窗等）不写入文档。当前未提供白板删除、历史版本浏览或多人实时协作。

## 本地资源与集成边界

编辑器在同源隔离文档 `/whiteboard-editor.html` 中运行。React、Excalidraw、样式、字体和字体处理代码打包到 `dist/whiteboard/`，通过 `/whiteboard-assets/` 提供；`EXCALIDRAW_ASSET_PATH` 指向该本地资源目录。中文字体分片随资源一起发布。

React 与 React DOM 固定为相同版本。构建适配器移除 Excalidraw 0.18.1 自带的外部字体回退，避免请求 CDN；升级 Excalidraw 时若适配位置变化，构建会失败并要求复核。上游 MIT 许可保存在 `web/vendor-licenses/Excalidraw.txt`，随构建资源一起分发。

编辑器使用独立 CSP：网络、脚本和字体限制为同源；图片允许内嵌数据与 Blob，Worker 允许同源和 Blob。字体子集处理需要 WebAssembly，React 需要内联样式，这两项许可仅配置在编辑器文档中。应用提供右侧 AI 绘图助手；Excalidraw 自带的云端 AI、在线协作、网页嵌入及外部素材库跳转继续关闭。

这里的「本地」指运行 CCAGENT Web 后端的电脑。已有登录服务和 Web 访问要求继续适用；不承诺整个应用可脱网登录。此次仅完成 Web 画布集成，不包含 EXE 封装或安装程序优化。

## 开发与验证

安装依赖后运行（Windows PowerShell 使用 `npm.cmd`）：

```powershell
npm.cmd run typecheck
npm.cmd run build
npm.cmd run test:whiteboard
```

`build` 包含 `build:whiteboard`；仅重建编辑器可运行 `npm.cmd run build:whiteboard`。开发启动 `npm.cmd run web:dev` 也会先生成编辑器资源。修改源代码后，需重建并重启现有 Web 服务再检查。

`test:whiteboard` 包含 AI 绘图检查；单独运行可使用 `npm.cmd run test:whiteboard-ai`。AI 测试使用隔离账号、真实 Agent 工具调用循环和本地模型测试服务，覆盖工具作用域、声明式绘图校验、续聊、停止、界面状态及 HTTP 访问保护，不调用真实付费模型。

自动检查覆盖私有存储隔离、JSON 校验、保存冲突、前端交互与 HTTP 访问保护；命令成功不代表浏览器绘制和图片导出已通过。浏览器验收还需实际检查新建与绘制、自动保存后刷新、中文字体、JSON 往返、PNG/SVG 导出、工作文件夹切换及两个标签页的冲突恢复。

本次已在隔离测试账号的真实浏览器中验证中文文字、矩形和箭头绘制、自动保存及刷新恢复、`.excalidraw` 导入和导出、PNG/SVG 下载，以及两标签页版本冲突后阻止离开、保留内容并另存为新白板。桌面和 390px 窄屏布局已检查；导出 PNG 已人工查看，SVG/JSON 内容已校验。工作区和账号隔离另由真实 HTTP 服务测试验证。没有使用真实用户账号或调用付费模型。

AI 绘图已在真实浏览器中串起本地模型测试服务、实际 QueryEngine 工具循环与 Excalidraw SDK：生成含中文标签及绑定箭头的流程图、自动保存与 PNG 导出、对话补图、保留手工图形、原生撤销/重做及面板撤销、迟到结果拒绝应用、停止请求、刷新恢复和移动布局。另直接验证同一绘图协议下的定点标签修改、箭头改连、双向引用修复及原生撤销恢复。真实付费模型的输出质量与服务可用性未在这些隔离测试中验证。

相关实现：`web/whiteboard.js`、`scripts/whiteboard-editor-entry.jsx`、`src/entrypoint/webWhiteboards.ts`、`src/entrypoint/webWhiteboardAssets.ts`、`tsup.whiteboard.config.ts`。

上游：[Excalidraw 0.18.1 发布说明](https://github.com/excalidraw/excalidraw/releases/tag/v0.18.1)、[组件安装文档](https://docs.excalidraw.com/docs/@excalidraw/excalidraw/installation)。
