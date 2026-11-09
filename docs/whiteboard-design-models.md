# Excalidraw 建筑与城市设计：图像模型配置

此功能支持通过 CCAGENT 官方网关生成图片，也保留个人配置的 DashScope / OpenAI 兼容图像编辑服务。官方模式使用当前登录账户的平台 Key 和平台余额；个人服务使用个人供应商账户。主模型继续使用 DeepSeek，Qwen 视觉读图仍作为独立读图工具。

## Kie GPT Image 2.5 官方网关

后台为四个独立模型建立路由：

| 变体 | 上游模型 ID | 输入方式 |
| --- | --- | --- |
| Flare 文生图 | `gpt-image-2-5-flare-text-to-image` | 文字要求 |
| Flare 图生图 | `gpt-image-2-5-flare-image-to-image` | 1–16 张输入图片 |
| Sunburst 文生图 | `gpt-image-2-5-sunburst-text-to-image` | 文字要求 |
| Sunburst 图生图 | `gpt-image-2-5-sunburst-image-to-image` | 1–16 张输入图片 |

管理员在后台为各路由填写 Kie Key、公开成本并开放后，应用刷新官方服务目录即可选择。应用设置中的“图像生成”角色可指定默认路由；白板也能直接选择其他已开放的图像路由。它们只出现在图像生成面板，不进入主对话模型选择。

在白板“图像模型设置”选择“CCAGENT 官方图像生成”并保存。文生图不要求原图；图生图支持只添加参考图，或导入原图、在图上勾画并添加参考图。原图与勾画各占一张输入，存在原图和勾画时最多再加 14 张参考图。没有原图与勾画时可使用 16 张参考图。

参数支持：提示词最多 20,000 字符；`aspect_ratio` 为 `auto`、`1:1`、`3:2`、`2:3`、`4:3`、`3:4`、`16:9`、`9:16`、`21:9`、`27:16`、`16:27`、`9:8`、`8:9`；分辨率为 `1K`、`2K`、`4K`。最后四种比例仅支持 1K。按当前供应商请求 schema，`background=transparent/opaque/auto` 仅在 1K 发送；2K/4K 使用自动背景并省略该字段。没有添加供应商未公开支持的质量、seed 或 mask 参数。每次返回一张图片。

每张输入支持最多 30 MiB 的 PNG / JPEG / WebP，验证后的图片单边不超过 8192 像素、总像素不超过 16,777,216。高清原图与参考图逐张上传至账户和工作区隔离的本地临时附件库，不嵌入 10 MiB 的白板文件；临时附件保留 30 分钟，总量最多 480 MiB。临时附件不是永久白板历史。画布里保留压缩原图和勾画；需要复现任务时应保留原始输入文件。

生成结果允许最多 64 MiB，经签名和 MIME 验证后显示。下载按钮保留供应商原始尺寸及透明背景；大图放入画布时使用保留透明度的缩小 PNG 预览，白板仍受 10 MiB 总量限制。若原白板已接近上限，保存失败会保留生成结果的预览与下载入口。

### 平台调用合同

1. 通过现有私有文件接口上传 `purpose=image` 并完成上传，获得当前账户拥有的文件 UUID。
2. `POST /v1/images/tasks` 提交 `{ model: 路由ID, prompt, input_images?: ["ccagent-file:文件UUID"], aspect_ratio, resolution, background? }`。文生图省略 `input_images`。
3. 请求携带当前已验证邮箱会话及个人平台 Key，沿用 `idempotency-key`、`x-ccagent-task-id`、`x-ccagent-price-version` 和 `x-ccagent-price-fingerprint`。Kie Key 只留在服务端。
4. 接收 `{ id, call_id, status, poll_after_ms, images }`；对 `queued/processing` 使用 `GET /v1/images/tasks/{id}` 继续查询。成功结果为 `images: [{ file_id, mime_type, expires_at }]`，再经账户鉴权的 `/api/files/{file_id}` 下载。

原图输入的逻辑指纹、私有上传 UUID、提交屏障和平台任务 ID 仅以回执元数据保存于账户目录，不保存供应商 Key 或图片内容。请求编号重入先核对逻辑指纹，复用原上传和原任务；改变图片、模型或要求不能复用同一编号。提交结果未知时只查询原请求，不自动再次提交收费生成。

“停止”只停止本地等待和轮询，不能取消已提交的 Kie 任务。白板提供“继续查询原任务”；刷新或重启应用后可凭原请求回执继续查询，无需重新上传图片或再次生成。成功和明确失败的本地回执在 24 小时后自动清理；未知任务回执保留以供核对。结果的实际可恢复期同时受平台私有文件有效期限制。

验证使用隔离账户与本地 HTTP fixtures，覆盖四变体、16 张输入、20k 提示、比例/分辨率/背景限制、私有上传、单次提交、未知状态与中断恢复、同编号改输入拒绝、账户/工作区隔离以及白板无底图生成。未使用真实 Kie Key，未发起实际计费图像生成。

依据：[Kie 模型页面](https://kie.ai/gpt-image-2-5)。

## 可用配置

| 项目 | DashScope / 阿里云百炼 | OpenAI 兼容图像编辑 |
| --- | --- | --- |
| 模型 | 默认 `qwen-image-2.0-pro` | 默认 `gpt-image-1.5`，也可填写兼容服务支持的编辑模型 |
| API 地址 | `https://dashscope.aliyuncs.com/api/v1` | `https://api.openai.com/v1` 或兼容服务的 API 根地址 |
| 实际接口 | `/api/v1/services/aigc/multimodal-generation/generation` | `/images/edits` |
| 参考图 | 最多 1 张；另发送原图及勾画图，共 3 张 | 最多 2 张；另发送原图及勾画图，共 4 张 |
| API Key | 与所选地域及模型权限对应的百炼 Key | 对应供应商个人 Key |

百炼新业务空间域名也可填写，例如 `https://你的业务空间ID.cn-beijing.maas.aliyuncs.com/api/v1`；新加坡域名与 Key 应使用同一地域。填写完整编辑接口地址也可。

原 `qwen-image-edit-plus` 等编辑模型 ID 允许手工配置，但没有在本次修改中调用供应商验证其可用性；默认采用当前中文官方编辑文档列出的 `qwen-image-2.0-pro`。视觉读图模型（如 Qwen VL）及纯文生图接口不能替代图像编辑接口。

## 使用方式

1. 打开左侧 Excalidraw，新建或打开白板，点击顶部“建筑与城市设计”。在面板内“图像模型设置”填写供应商、接口地址、模型和个人 Key，保存后使用。
2. 导入原图，点击“在原图上勾画”，以画笔、线条、箭头或文字在原图上表达修改范围。
3. 按需添加参考图，在文字要求中说明其用途，例如立面材质、建筑风格、分析图配色。
4. 选择“建筑设计图”或“城市设计分析图”，输入绘制要求，点击“生成设计图”。
5. 检查生成结果，下载或点击“放入画布”保留为独立图片；原图不会被替换。保留未要求修改区域及场地关系仍须人工核对。模型生成的分析图不能当作实测结果或法定规划依据。

面板导入支持 20 MiB 以内的 PNG、JPEG、WebP，并自动缩小到最长边 1600 像素；过大的图片请先压缩。编辑器快照最长边不得超过 2048 像素，原图与勾画图尺寸必须一致。服务端每图上限 10 MiB，单边不超过 8192 像素、总像素不超过 16,777,216，一次输入总大小不超过 30 MiB。每次请求要求返回一张图。

## 凭据与调用行为

个人设置保存在当前账户的数据目录；项目配置不能覆盖它。Windows 上新增 Key 通过系统 DPAPI 加密，普通设置文件及 API 响应不包含 Key。更换供应商或接口地址时须重新填写 Key，空白输入只保留同一供应商、同一地址的现有 Key。清除配置会同时关闭环境默认配置的回退。

开发者可在启动进程前显式提供 `IMAGE_EDIT_PROVIDER`、`IMAGE_EDIT_MODEL`、`IMAGE_EDIT_BASE_URL`、`IMAGE_EDIT_API_KEY`。默认 DashScope 地址未被覆盖时，也允许启动时继承的 `DASHSCOPE_API_KEY` 或 `QWEN_API_KEY`。不会自动复用 `QWEN_MODEL`、`QWEN_BASE_URL`、通用 `OPENAI_API_KEY` 或切换工作区后注入的项目 `.env`。普通用户可直接在界面填写个人图像模型。

请求不自动重试。取消会停止本地等待与结果下载，已送达供应商的请求仍可能完成并产生费用；超时后应先核对供应商记录，再决定是否重新生成。结果仅通过受限的公开 HTTPS 下载，下载连接不携带供应商 Key，也不接受重定向。

## 验证范围

本次使用本地模拟供应商验证协议、原图及勾画图传递、参考图限制、账户凭据隔离、异常脱敏、取消和结果下载地址限制；未发起真实计费图像调用，也未验证任意第三方兼容服务的最终出图效果。

2026-11-09 原图导入修复：选中的图片改为通过 `FileReader` 读取为 data URL，兼容主页面的图片安全策略。浏览器回归使用与实际应用一致的主页面及编辑器 CSP，通过真实文件输入导入 PNG，检查侧栏缩略图和实际画布显示，而非仅检查导出图片。

官方接口参考：[阿里云百炼图像编辑 API](https://help.aliyun.com/zh/model-studio/qwen-image-edit-api)、[OpenAI 图像编辑 API](https://developers.openai.com/api/reference/go/resources/images/methods/edit)。
