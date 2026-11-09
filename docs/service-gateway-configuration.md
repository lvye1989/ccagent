# 服务网关配置说明

管理员进入云端 `/admin/routes`（服务网关）新增、载入编辑、暂停或删除路由；写操作要求 `routes.write` 权限。模型、上游地址、供应商凭据、成本版本和默认服务在后台分别保存。

本轮已将以下 **6 条暂停路由** 写入正式数据库，并在生产后台发布增删改查界面（2026-11-09）。线上服务已逐项核对模型、协议、地址、暂停状态及 managed 凭据可解密；供应商接口尚未发起真实调用。**正式成本价格尚未核实，不启用这些路由，也不以探针合成价格代替生产价格。** 实际后续开放状态以正式后台页面为准。

`MAAS_ORIGIN` 在下表中表示从根 `.env` 的 `DASHSCOPE_BASE_URL` 取得的工作区 HTTPS origin；当前读图 baseURL 为 `https://llm-htz8qllbi0nz48bo.cn-beijing.maas.aliyuncs.com/compatible-mode/v1`。地址不包含查询参数或凭据。

| 用途 / 服务类型 | provider / protocol | 模型与配置来源 | 上游地址 |
| --- | --- | --- | --- |
| 视觉读图 `vision` | `qwen` / `openai-chat` | `QWEN_MODEL=qwen3.8-omni-flash`；协议来自 `QWEN_PROTOCOL`；凭据来源 `DASHSCOPE_API_KEY` | `DASHSCOPE_BASE_URL`，即上述 `/compatible-mode/v1`；请求追加 `/chat/completions` |
| 结构化决策 `decision` | `openrouter` / `jev-decisions` | `JEV_MODEL=~typesafe/jev-latest`；凭据来源 `OPENROUTER_API_KEY` | `https://openrouter.ai/api/alpha/decisions`（当前 `.env` 未覆盖地址，使用实现默认值） |
| Tavily 联网搜索 `search` | `tavily` / `tavily` | 服务别名 `tavily-search`，不是 `.env` 的大模型；凭据来源 `TAVILY_API_KEY` | `https://api.tavily.com/search` |
| 博查联网搜索 `search` | `bocha` / `bocha` | 服务别名 `bocha-search`；凭据来源 `bocha_API_KEY` | `https://api.bochaai.com/v1/web-search` |
| 语音合成 `voice` | `qwen` / `dashscope-tts` | `QWEN_TTS_MODEL=qwen-audio-3.1-tts-flash`；音色 `QWEN_TTS_VOICE=longanhuan_v3.1`；凭据来源 `DASHSCOPE_API_KEY` | 当前无 `DASHSCOPE_TTS_URL` 覆盖，按实现派生 `MAAS_ORIGIN` + `/api/v1/services/audio/tts/SpeechSynthesizer` |
| 图像生成 `image`（暂停草稿） | `qwen` / `dashscope-images` | 按阿里官方模型 `qwen-image-plus` 建立草稿；**不是根 `.env` 已有的生成模型配置**。可使用同工作区的 `DASHSCOPE_API_KEY` 作为凭据来源，实际授权须另行验证 | 同工作区 `MAAS_ORIGIN` + `/api/v1/services/aigc/multimodal-generation/generation`，以实际保存值及工作区地域为准 |

图像生成仅支持保存和管理配置，执行适配、结果文件处理、用量计量、正式计费与连通检测仍待实现，不能启用或宣称已可生成图片。[阿里官方模型说明](https://help.aliyun.com/en/model-studio/qwen-image-plus)与[图像生成 API](https://help.aliyun.com/en/model-studio/qwen-image-generation-and-editing-api-reference)仅作为草稿配置依据。客户端原有官方服务角色 `image` 对应的是 `vision` 读图；不能把生成草稿设为该读图角色。

供应商 Key 由服务端以 managed 凭据加密保存，并绑定路由编号、供应商与规范化地址。浏览器只获得配置状态，不回显 Key、密文或加密根；根 `.env` 只是本轮导入来源，不会因本机存在变量而自动让生产可用。自定义 Maas 域名须先经后台批准。修改供应商或地址后须重新录入匹配的凭据；更换模型、协议、服务类型或地址后须核对相应成本版本，不能直接套用其他模型的价格。

- **新增**：页面通过 `POST /api/admin/routes` 创建新编号，已有或已归档编号不能作为新路由覆盖写入；新建不携带旧版本。
- **编辑**：载入当前详情后通过 `PUT` 保存，并携带当时的 `expectedUpdatedAt`。其他管理员已修改时返回版本冲突，应重新载入并核对后再保存。
- **删除**：通过 `DELETE` 归档、暂停并移除该路由的凭据和默认/备用引用；保留路由编号、历史成本版本、调用、账本及审计。删除不等于退款或清除未结算费用，在途请求与冻结额度仍需按原记录核验，不能因删除而重复发起付费请求。

启用前须分别完成供应商授权、公开成本与计量单位、必要汇率及连通性核验。后台连通检测会产生供应商费用，需显式确认；保存配置本身不代表已执行检测。图像生成草稿不具备上述执行和检测能力。
