# Vercel 服务端供应商配置（2026-11-08）

独立项目 `ccagent-cloud` 的 Preview 环境已保存五个供应商 Secret，密钥不进入网页、安装包或部署源码。它们来自当前应用已有配置，仅通过 CLI 标准输入写入 Vercel，没有把值放入命令参数、日志或报告，也没有读取已保存 Secret 的值。Production 环境没有创建这些变量，正式服务目录和充值仍未开放。

## 管理员配置映射

| 现有服务 | 网关凭据环境变量 | 协议及配置说明 |
| --- | --- | --- |
| DeepSeek 主模型 | `CCAGENT_PROVIDER_DEEPSEEK` | 沿用当前 `deepseek-flash` / Responses 配置，当前应用基址为 `https://api.deepseek.com`。 |
| Qwen 聊天、读图及语音 | `CCAGENT_PROVIDER_QWEN` | 采用应用原有专属部署地址；聊天/读图保留 Chat Completions，语音保留专用 TTS 协议。聊天/读图原有权限或余额问题仍须分别验收。 |
| Jev 决策 | `CCAGENT_PROVIDER_JEV` | `jev-decisions`，基址 `https://openrouter.ai/api/alpha/decisions`。正式模型版本和成本绑定仍待落实。 |
| Tavily 搜索 | `CCAGENT_PROVIDER_TAVILY` | `tavily`，基址 `https://api.tavily.com/search`。 |
| 博查搜索 | `CCAGENT_PROVIDER_BOCHA` | `bocha`，基址 `https://api.bochaai.com/v1/web-search`；保留此前线上异常及后续通过记录。 |

Qwen 当前专属主机为 `llm-htz8qllbi0nz48bo.cn-beijing.maas.aliyuncs.com`。已将该准确主机名保存为 Preview 的 `CCAGENT_ALLOWED_UPSTREAM_HOSTS` Config；没有使用通配符，没有自动跟随重定向，也没有放宽 HTTPS 和证书验证。聊天/读图基址沿用该主机下 `/compatible-mode/v1`，TTS 地址沿用该主机下 `/api/v1/services/audio/tts/SpeechSynthesizer`。

环境变量是凭据来源，管理员还须配置服务路由、公开成本版本、结算汇率及默认角色后才能销售。没有价格或尚未启用的路由不会因密钥已保存而自动开放；Qwen 凭据存在也不能证明聊天/读图模型权限或余额可用。正式成本、套餐和商业条件按 [成本核对记录](provider-cost-review.md)验收。

## 已完成的验证

`cloud/scripts/configure-provider-env.ts` 创建前核对已登录团队、独立项目 ID 和本地项目链接，只写 Preview Secret；每次写入后核对 Secret 类型、作用范围，并检查原有环境变量的 ID、名称、类型及范围均保留。不带 `--run` 仅生成独立的 `provider-env-plan.json`，不覆盖实际执行记录；已有同名 Preview Secret 会保留，不会读取或覆盖它的值。执行报告为 `output/checks/provider-env-configuration.json`。

`cloud/scripts/check-hosted-provider-configuration.ts` 使用独立测试 Schema、受限运行账户和临时受保护 Preview，从项目继承这些 Secret，而非额外传入供应商值。十项真实 HTTP 检查通过：原生登录与账户目录、匿名拒绝、五类服务配置状态、密钥不回传、撤销管理员角色后普通用户立即被拒绝，以及零调用/订单/流水。测试路由全部关闭且没有价格，没有发起供应商请求。开发库 13 张表完整行摘要未变，临时部署和 Schema 已删除，报告为 `output/checks/hosted-provider-configuration.json`。

首次后台验证误用了只允许用户服务接口的原生客户端方法访问管理员接口，因此验证失败；修正仅在测试程序中使用该隔离管理员的正常登录会话读取后台 HTTP 接口，没有放宽产品客户端的接口白名单。初次报告保留在 `output/checks/hosted-provider-configuration-initial-failed.json`。

长期保留的开发 Preview 已更新并通过 13 项保护、健康及应用认证检查；其准确 URL、部署 ID、源码摘要和构建状态以 `output/checks/provider-preview-deployment.json` 为准。该检查仍使用开发库、关闭充值并保持 Vercel 访问保护，不是正式生产发布。原本地 `.env.local` 摘要不变；用于短期访问凭据刷新的文件只写本轮自建临时目录，使用后删除，没有覆盖本地配置。

Qwen 专属主机的允许列表已随后续保留部署生效。当前受保护开发地址为 <https://ccagent-cloud-7e7yur0n9-lvye-1989s-projects.vercel.app>，部署 `dpl_9TJxnQiDx2MtJY3VtFs6tUYbigBf`，READY；102 个文件/464,446 字节源码摘要为 `9edfc3f2ea95bba0ade65dd7a0659b555045e0f8e4ea6db1c721b46652f81bb9`。新部署沿用开发 Schema `ccagent`，充值关闭，原本地环境文件摘要未变，13 项访问检查通过。此前保留版本和报告没有删除。

## DeepSeek 与 Qwen 语音的真实云端链路

另外使用独立临时 Preview 和测试 Schema，直接继承项目长期 Secret，各发起一次小型真实请求：

| 服务 | 上游计量 | 结算、文件及重放 |
| --- | --- | --- |
| DeepSeek Responses | 输入 12 / 输出 1 / 缓存输入 0 Token | HTTP 200、settled、私有 JSON 下载一致；原编号重放不改变钱包。 |
| Qwen 专属部署 TTS | 输入 5 / 输出 17 Token | HTTP 200、settled、真实 WAV 下载及 RIFF/WAVE 文件头验证通过；私有 JSON 一致，原编号重放不改变钱包。 |

这轮继承已有项目 Secret，没有用部署级参数重新提供供应商值；准确凭据来源和每次持久化尝试数见 `output/checks/live-primary-services-hosted.json`。金额按合成价格和非现金测试余额计算，没有真实用户充值或扣费，不能作为正式成本。临时部署 `dpl_DAxhmyJyXZk3rE4GxnZ47UWgUkSe` 与独立 Schema 已清理并复核，开发库 13 张表完整行摘要未变，脚本退出 0。此前本机测试、Jev/搜索的分阶段 Vercel 结果分别保留，不把它们相加为一次完整生产验收。

这两项证明了正常非流式 Responses 和语音请求的真实云端链路。随后真实 QueryEngine 的 DeepSeek 流式 Read 工具往返、缓存用量和原编号重放也已通过，见 [引擎真实链路](engine-live-gateway.md)。后台平台承担费用的连接检测亦完成下述 Tavily 实网检查；Qwen 聊天/读图、正式账单与生产环境仍按各自范围验收。

## 后台平台承担费用的真实检测（2026-11-08 01:09）

使用 `check-hosted-provider-configuration.ts --run --real-route-test`，在另一独立测试 Schema 和临时 Preview 中完成 12 项配置、权限及真实检测检查；默认不带该附加参数的配置验证仍不调用供应商，报告文件也分别保存。

测试管理员先取得 Tavily 暂停路由的固定检测和成本指纹，再确认一次由平台承担费用的检测。供应商返回 HTTP 200 / 1 search credit，状态 succeeded，响应和用量均核实，`platformPaid=true`、`userChargeMicro=0`。同一检测编号再次提交返回原结果，开始/结果审计各保持一条。账户钱包始终为零余额、零冻结，没有用户调用预留、订单或流水；撤销管理员角色后，该普通用户读取后台设置和检测结果均被 403 拒绝。

此处价格定义和公开成本金额仍为合成测试值，不能作为 Tavily 采购单价或账单金额。实际供应商额度可能消耗，用户钱包不扣费不表示供应商免费。准确报告为 `output/checks/hosted-admin-live-route-test.json`；临时部署 `dpl_AapE1TjiVX5YGB6LprA4PZGahv2K` 和测试 Schema 已删除并复核，开发库 13 张表完整行摘要未变，进程已结束。本轮验证后台 HTTP 的真实费用与权限路径，没有新增或替代既有界面截图验收。

## 后续运营条件

正式管理员和实际邮件收件邮箱仍待指定；没有自动提升已有用户权限。七支付商户和实际交易、OpenAI 生图凭据方式、Qwen 聊天/读图权限、正式价格及供应商账单、生产数据库和存储隔离、域名、维护调度、备份及最终安装 EXE 仍按 [全部需求核对](goal-audit.md)分别完成。
