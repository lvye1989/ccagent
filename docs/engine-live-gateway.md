# 真实 QueryEngine 与 Vercel 流式工具链路（2026-11-08）

真实本地 QueryEngine 经原生平台客户端、Vercel 网关和 DeepSeek 完成了一次工具往返：模型调用内置 Read 读取新建的临时文件，随后通过流式文本返回该文件中的随机校验值。没有用测试模型代替供应商，也没有直接拼接预设回答。测试仅开放固定文件的 Read，没有开放写入、Shell、其他工具或子代理。

## 现场证据

`output/checks/live-engine-hosted.json` 最终状态 passed，脚本退出 0。记录包括：

- 2 条真实模型请求、1 次 Read 执行、1 条工具结果、26 个文本事件，最终结束原因为 completed，校验值完全一致，没有模型或工具错误。
- 第二条请求包含相互匹配的 `function_call` / `function_call_output`；两次请求绑定同一任务编号，各自持久化的供应商尝试数为 1。
- 两条调用均 settled，冻结余额归零。私有 SSE 结果分别为 6,765 与 10,851 字节，原编号重放与私有文件逐字节一致，钱包不变，未增加调用记录。

| 模型请求 | 未缓存输入 Token | 缓存输入 Token | 输出 Token |
| --- | ---: | ---: | ---: |
| 请求工具 | 1,286 | 0 | 40 |
| 接收工具结果后回答 | 250 | 1,152 | 27 |

以上按合成价格和非现金测试余额结算；本轮缓存单价设为测试值，不能将测试金额或单价作为供应商实际成本、正式售价或账单对账结果。

## 运行边界

云端准备与清理由 `cloud/scripts/check-live-engine-hosted.ts` 执行；本地引擎部分位于 `src/scripts/helpers/liveEngineToolCheck.ts`，直接调用现有 QueryEngine 和 `fileReadTool`。CLI/Web 与 Next.js 分别进行类型检查，避免把 Next.js 的全局类型增强混入本地工具模块；没有为测试修改生产引擎、模型适配器或权限策略。

使用正常的 `/think off` 会话指令关闭思考；该本地设置没有产生模型请求。测试进程在原生 HTTP 边界最多放行两个唯一模型调用编号，重放必须沿用原编号和原正文。工具范围为仅一次固定文件 Read，测试文件内容最终未变化；用户已有工作区和文件未发送给模型。

实际 Vercel 部署继承已有 `CCAGENT_PROVIDER_DEEPSEEK` Secret。最初本地种子目录启用因缺少本地凭据状态被拦截，未建立模型调用，失败报告保留在 `output/checks/live-engine-hosted-initial-seeder-failure.json`。随后本地仅使用不转发的种子校验标记；远端部署未传入该标记或新的供应商值，实际模型响应必须由继承的真实 Secret 取得。

先建立独立测试 Schema，再动态加载数据库模块并核对 13 张表的绑定和 `ccagent_runtime` 身份，随后才写测试账户、密钥、价格和余额。临时部署 `dpl_HUGtRwwJTwumjpDwTnuwqRmtwb1F` 已删除并核对不存在，私有结果文件和测试 Schema 已清理，开发库 13 张表完整行摘要未变，测试进程已结束。

该结果证明当前 DeepSeek Responses 的真实流式、工具输入输出配对、缓存用量、结算和结果重放链路；不据此认定 Qwen 聊天/读图、所有外部工具、正式价格、支付、邮件、生产环境或最终安装版验收完成。保留的开发 Preview 和服务端配置见 [供应商配置](server-provider-configuration.md)。

## 原生客户端中断后的结算与恢复（2026-11-08 01:18）

`cloud/scripts/check-live-engine-hosted.ts --run --cancel-stream` 在新的隔离账户和临时受保护 Preview 中只允许一个唯一付费模型请求编号。原生客户端读到 1,739 字节、尚未收到最终用量和完成事件时，使用真实 AbortController 中断连接并取消读取；随后只查询原调用，没有重新发起生成。

`output/checks/live-cancel-stream-hosted.json` 最终 passed：调用状态从 held 变为 settled，实际用量为输入 32 / 输出 499 Token，授权和结算流水各一条，冻结增减相抵，最终冻结为零。完整私有 SSE 为 114,708 字节，含完成事件；原编号重放逐字节一致且钱包不变。价格和余额仍为合成测试值，没有真实用户扣款或商户交易。

源站记录 `serverMarkedInterruption: false`。本轮证明客户端已停止接收而原调用仍能按最终用量结算和恢复，不能声称 Vercel 源站识别了断开，或供应商在点击停止后立即停止生成与计费。该项使用原生平台客户端，不是 Web 停止按钮的界面验收，也没有在此轮运行 QueryEngine。临时部署和测试 Schema 已删除，开发库 13 张表完整行摘要未变。

## 本地缓存 Token 统计修正

真实工具往返的云端用量记录正确，但离线重放其最终事件时，复现本地 Responses 解析器漏记缓存明细：供应商输入总数 1,402 中有 1,152 个缓存 Token，原本地结果只保留总输入。现将其拆为非缓存 250、缓存 1,152、输出 27，共享上下文统计仍为 1,429，不把缓存再加一次。

修正仅涉及本地解析与用量归一化，未修改云端资金结算。新增五组有效缓存、全缓存、零缓存、非法明细及输出受限场景，包含此前十一组在内的 16 组检查通过；修正前失败记录已复现。包含修正的 554 个源文件隔离副本已通过完整 `npm.cmd run verify:release`，退出码 0、207 秒，检查期间副本未变化，结束时与工作区源码一致；报告为 `output/checks/whiteboard-auth-snapshot-5fe827ca-c7f1-4407-b0fe-308e344b3743/result.json`，同目录保存完整日志。云端类型检查另行通过。这不代替正式供应商账单、邮件、支付、生产或安装版验收，没有重新生成 EXE。
