# Kie GPT Image 2.5 图像网关

## 后台配置

入口：<https://ccagent-cloud.vercel.app/admin/routes>。使用 `图像生成` 服务类型和 `KIE GPT Image 2.5` 协议；供应商为 `kie`，基础地址为 `https://api.kie.ai/api/v1`。无需在 Vercel 控制台配置供应商 Key。

四个模型分别对应文生图与图生图，调用参数一致：

| 平台路由 | 上游模型 |
| --- | --- |
| `kie-gpt-image-2-5-flare-t2i` | `gpt-image-2-5-flare-text-to-image` |
| `kie-gpt-image-2-5-flare-i2i` | `gpt-image-2-5-flare-image-to-image` |
| `kie-gpt-image-2-5-sunburst-t2i` | `gpt-image-2-5-sunburst-text-to-image` |
| `kie-gpt-image-2-5-sunburst-i2i` | `gpt-image-2-5-sunburst-image-to-image` |

在需要使用的每个路由中填写同一 Kie API Key，保存后不会回显。确认成本后开启服务；连接测试会向 Kie 提交一个真实的 1K 任务，由平台承担费用，页面会明确要求确认。缺少 Key 时保持暂停，不把配置完成当作真实出图验收。

内部重试固定为 0；异步图像任务不自动切换备用。超时后查询原任务，不重新创建收费任务。

## 单价

截至本次接入，Kie 的[模型页面](https://kie.ai/gpt-image-2-5)和[价格说明](https://kie.ai/pricing)给出的四模型公开单价相同，按生成图片张数收费，不按百万 Token 收费。后台已保存默认汇率为 **6.7188 CNY/USD**，版本 1。本次将美元价格精确换算为固定人民币成本版本：

| 输出分辨率 | Kie credits/张 | 美元/张 | 人民币公开成本/张 | 平台计价项 |
| --- | ---: | ---: | ---: | --- |
| 1K | 6 | 0.03 | 0.201564 | `output_images_1k` |
| 2K | 10 | 0.05 | 0.33594 | `output_images_2k` |
| 4K | 16 | 0.08 | 0.537504 | `output_images_4k` |

三项的计价单位数量均为 **1**。每个成功任务只记录其实际分辨率对应的一张，其余两项为零，不把三个单价相加。表中为公开成本；平台现有服务费规则仍为公开成本 × 1.3，金额使用整数微元核算。充值赠送积分不当作通用公开折扣。修改默认汇率不会改写已保存的人民币价格版本或历史账单。

## 公开功能与参数

- `prompt`：1–20,000 字符。
- `resolution`：`1K`、`2K`、`4K`。
- `aspect_ratio`：`auto`、`1:1`、`3:2`、`2:3`、`4:3`、`3:4`、`16:9`、`9:16`、`21:9`、`27:16`、`16:27`、`9:8`、`8:9`。最后四项仅支持 1K。
- `background`：1K 支持 `transparent`、`opaque`、`auto`；2K/4K 不发送该参数。
- 图生图接受 1–16 张 JPEG、PNG、WebP，每张不超过 30 MB。原图、勾画图与参考图共同计入 16 张；文生图不传入图片。

限制依据当前四模型 [OpenAPI 参数](https://docs.kie.ai/market/gpt/gpt-image-2-5-flare-text-to-image.md)及官网实际表单。官网 README 仍有高分辨率透明背景的旧说明，但当前参数 schema 与表单均把背景控制限定为 1K；接入按正式参数处理。2.5 未公开 `quality`、`output_format`、`seed`、`mask` 或 `n` 参数，不将 2.6 的字段混入该模型。输出文件按供应商实际返回格式核验。

## 平台调用

平台接口要求有效账户登录状态和该账户的 CCAGENT 平台 Key。供应商 Key 仅保存在后台，调用方不直接使用它。继续使用现有 `idempotency-key`、`x-ccagent-task-id`、价格版本及价格指纹请求头；从最新 `/v1/models` 获取已开放路由与价格。

1. 图生图先通过现有 `/api/files` 初始化私有图片上传，使用返回的限时地址上传，再调用 `/api/files/{id}` 完成上传。平台验证文件类型、实际大小与账户归属。文生图跳过此步。
2. 创建任务：`POST /v1/images/tasks`。

```json
{
  "model": "kie-gpt-image-2-5-sunburst-i2i",
  "prompt": "依据原图与参考图绘制城市设计分析图，保留道路和建筑关系",
  "input_images": ["ccagent-file:<当前账户已上传图片的 UUID>"],
  "aspect_ratio": "16:9",
  "resolution": "2K"
}
```

文生图改用 `...-t2i` 路由并省略 `input_images`；1K 透明图可增加 `"background": "transparent"`。

3. 读取响应中的平台任务 `id`，通过 `GET /v1/images/tasks/{id}` 查询。遵循 `poll_after_ms`，不通过重复 POST 轮询。
4. `status=succeeded` 时，使用 `images[].file_id` 从 `/api/files/{file_id}` 下载当前账户的私有结果。临时文件有期限，应及时保存到画布或下载。

任务状态为 `queued`、`processing`、`succeeded`、`failed`、`unknown`。`unknown` 表示结果需要核实，不能据此重发收费请求。任务查询同样检查用户与平台 Key 归属；价格、汇率、参数按创建时快照结算。

平台服务端按 [Kie 任务规范](https://docs.kie.ai/market/common/get-task-detail.md)调用 `createTask` 和 `recordInfo`，检查 HTTP 状态以及 JSON `code`。参考图由服务端上传到 Kie；用户任意 URL 不直接透传。返回图片通过公开 HTTPS/DNS 检查及格式检查后写入账户私有存储，不向客户端暴露供应商私钥或原始签名下载链接。

## 应用入口

打开左侧 Excalidraw 的建筑/城市分析绘图面板后，直接填写要求并生成。白板默认使用管理员网关服务，不显示模型、供应商、地址或 Key 设置；遗留个人图像配置和环境直连参数均被忽略。面板打开和新任务开始时自动获取最新图像服务目录，不要求用户手动刷新，也不新建平台 Key。

官方服务设置的「图像生成」将四个 GPT Image 2.5 通道合并为一个选择项，保留已有选择与计价路由。仍有效的用户选择优先于管理员默认设置；用户没有选择时使用管理员推荐服务。没有图片时自动文生图；导入原图、勾画或添加参考图后自动图生图，并按输入模式选择同系列对应路由；对应模式未开放时明确报告服务暂未开放，不因失败换模型重发。后台未设置默认时，使用稳定排序后的可用路由确定初始服务。比例、分辨率及支持的背景仍作为生成要求供用户选择。高清输入逐张保存为账户与工作区绑定的临时附件，保留白板原有体积边界。

读取图像目录使用当前账户已绑定的平台 Key，生成时使用图像专属目录快照，不改写主模型、Qwen 读图、全局辅助开关、备用偏好或已保存价格。缺少绑定时报告账户服务暂不可用，不转向供应商配置弹窗。

结果支持原尺寸下载；大图插入画布时使用保留透明通道的缩小预览，以保持白板原有存储上限。需要原始分辨率时使用下载入口保存原图。

图像生成属于独立辅助服务 `imageGeneration`。主对话模型仍为 DeepSeek，`image` 读图角色仍为 Qwen；图像生成模型不会出现在主模型下拉框。

停止本地等待不能取消 Kie 已接受的任务，也不能据此承诺免除上游费用。已确认失败的任务释放冻结额度；无法核实的任务不自动重试创建。原任务恢复沿用原调用标识和价格快照。

参考图上传请求包含 multipart 实际字节数的 `Content-Length`。上传前失败记录 `IMAGE_INPUT_UPLOAD_FAILED`、安全的 `failureStage` 和 `failureCode`，用于区分私有文件读取与供应商上传，以及凭据、限流、响应格式等问题。原始供应商错误正文、图片地址和密钥不会写入诊断记录。客户端按错误类别提示失败阶段和下一步操作，并保留调用编号。
