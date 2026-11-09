# 服务路由成本核查（2026-11-09 至 11-10）

通过已登录管理员的正常后台接口核对五条实际生产路由，并将确认的公开原价保存为追加成本版本。没有调用付费供应商，没有改变用户余额或历史账单；平台现有 1.3 收费倍率不计入下表成本。

| 路由 | 核查后的模型／计价项 | 上游原价 | 保存进度 |
| --- | --- | --- | --- |
| qwen-tts | qwen-audio-3.1-tts-flash，北京，文本输入 Token | 1.5 CNY／1,000,000 Token | 已保存 |
| qwen-tts | 同模型，合成音频输出 Token | 12 CNY／1,000,000 Token | 已保存 |
| qwen-image-generation | qwen-image-3.0，北京，1K／2K 输入图片 | 0.02 CNY／张 | 已保存，仅配置 |
| qwen-image-generation | 同模型，1K／2K 输出图片 | 0.18 CNY／张 | 已保存，仅配置 |
| bocha-search | Web Search API，成功请求 | 0.036 CNY／次 | 已保存 |
| tavily-search | Search，按量付费实际 Credit | 0.0537504 CNY／Credit（原价 0.008 USD） | 已保存 |
| jev-decision | typesafe/jev-1.14，输入 Token | 0.2821896 CNY／1,000,000 Token（原价 0.042 USD） | 已保存 |
| jev-decision | 同模型，输出 Token | 0 CNY／1,000,000 Token | 已显式保存零单价 |

最初生产后台 `usdCny` 为空、`fxVersion=0`、来源 `default`。用户随后明确要求查询今天汇率并设为默认。已在正常后台配置中保存 `usdCny=6.7188`，`fxVersion=1`，来源 `database`，保留原允许域名。

中国银行官网 2026-11-10 00:00:05 的中行折算价为 671.88 元／100 美元，即 1 USD = 6.7188 CNY。采用中行折算参考口径，不是购汇卖出价。国家外汇管理局最新公布的 2026-11-09 中间价也是 6.7188；11 月 10 日刚过零点，当日央行中间价尚未发布，不能将其称为“11 月 10 日央行中间价”。

美元两项已经精确按 `0.008 × 6.7188 = 0.0537504`、`0.042 × 6.7188 = 0.2821896` 换算并保存为 CNY 固定成本版本。Tavily 普通搜索 1 Credit、高级搜索 2 Credits，因此分别成本 0.0537504／0.1075008 元。以后修改默认汇率不会自动改写这些已保存的 CNY 成本，须另追加版本；历史调用价格快照不变。

## 必要配置修正

原图像型号 `qwen-image-plus` 列入 2026-10-10 下线清单，改为官方推荐 `qwen-image-3.0` 后绑定相应价格。图像执行和计费尚未接入，保持原暂停状态，不将成本配置保存当作图像生成验收。

Jev 原先为动态别名 `~typesafe/jev-latest`；改用官方当前固定型号 `typesafe/jev-1.14`，避免供应商自动切换型号造成价格失配。保留当前 Decisions endpoint、已保存凭据及暂停状态。

后台增加输入／输出图片按张计价项，图像路由也显示成本编辑器。未配置价格时，Tavily 默认 Credit、博查默认请求次数、语音与决策默认输入／输出 Token，聊天保留原三项。已有成本版本始终优先加载，不用默认项覆盖。

## 价格依据

- TTS：https://help.aliyun.com/zh/model-studio/qwen-audio-3-1-tts-flash
- 图像：https://help.aliyun.com/zh/model-studio/qwen-image-3-0
- 下线记录：https://help.aliyun.com/zh/model-studio/model-depreciation ，公告 https://www.aliyun.com/notice/118434
- 博查：https://bocha-ai.feishu.cn/wiki/JYSbwzdPIiFnz4kDYPXcHSDrnZb （从官网价格入口跳转的公开文档；采用标准按量价，不采用体验包或资源包折扣）
- Tavily：https://docs.tavily.com/documentation/api-credits （基础搜索 1 Credit，高级搜索 2 Credits，实际用量由供应商返回）
- Jev：https://openrouter.ai/typesafe/jev-1.14/ ，官方 Decisions 文档 https://openrouter.ai/docs/guides/community/jev
- 汇率：https://www.bankofchina.com/sourcedb/whpj/ （直接匿名 HTTP 读取核实今日报价；网页抓取缓存可能仍显示昨日），交叉核对 https://www.safe.gov.cn/AppStructured/hlw/RMBQuery.do

## 验证

类型检查和两套真实 React DOM 表单回归通过，覆盖不同协议默认项目、图像按张成本保存及重载、零单价、旧价格优先、旧路由与阶梯兼容。生产发布 `dpl_87ikcmg88Mf4CuK7aSaMTF1KaaTV`；发布输入仅含审核后的云端源码及必要共享模块，排除了本机凭据、用户文件与生成物。

五条价格均通过管理员 API 保存后再次读取核对；使用生产读取数据交给真实 React 编辑器渲染，核对每个价格框、单位框和币种值，所有字段与已保存成本一致。实际供应商调用、图像执行与收费行为不属于本次验收。

额外数据库回归的首轮 22 项中 21 项通过；最后的主 schema 不变保护检查与本次生产价格保存、计划维护重叠，发现快照变化而失败。没有删除或跳过保护。在停止生产写入后的独立窗口单独重跑原 Qwen 测试，9 项全部通过；同时确认主 schema 13 张表完整数据保持不变，仅新增 2 条允许的计划维护审计、未出现其他新增审计。测试业务表绑定独立 `ccagent_test_*` schema，结束后由原清理流程移除。首轮快照失败保留记录，不能改记通过。
