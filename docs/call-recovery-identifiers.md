# 调用编号与断线恢复（2026-11-07）

需求要求断线后先查原调用，不创建另一笔收费请求。核对发现网关接受 `[A-Za-z0-9._:-]{1,200}`，状态查询却要求首字符为字母或数字，因此 `_resume` 等已执行编号会收到 400，无法按原编号核对状态。

## 修正后的接口

`core/call-identifiers.ts` 统一派发与查询的编号校验，保留原网关允许的 1–200 个字符范围。已有 `GET /api/account/calls/<编号>` 继续使用；新增 `GET /api/account/calls?id=<编码编号>`，只允许唯一的 `id` 参数。两种入口都调用原 `ownedCallStatus`，从真实登录会话解析用户，继续按用户及编号联合查询。

恰好为 `.`、`..` 的编号在路径中会被 URL 规范化，编码点号也不能避免。因此通过查询参数恢复这些原本已被网关接受的编号；没有通过缩小原请求范围绕开恢复问题。原生客户端仍使用 UUID，不改变现有客户端配置、请求重放或收费规则。

查询不要求仍然有效的消费 Key，撤销后仍可读取本人历史；未登录、跨账户和失效会话继续受原认证与归属约束。结果不新增内部 Key、请求哈希、私有对象标识或供应商正文。非法编号、重复 `id` 或额外查询字段被拒绝。

## 复现与验收

`output/checks/call-identifiers-before.log` 保留修复前的失败：实际已执行的 `_resume` 及 `_unmeasured` 查询为 400，跨账户请求也被编号校验提前拒绝。初轮还包含对路径点段应拒绝派发的预期；最终改为保留原接受范围、通过查询入口覆盖，不将该初轮预期当作产品要求。

新增 `cloud/tests/call-identifiers.test.ts` 使用真实受限 PostgreSQL 角色、动态导入后的精确测试 Schema 绑定和真实私有 Blob；上游响应和余额均为合成数据。每轮先后比较开发库 13 张表完整行摘要，只清理明确归属该夹具用户的文件，再删除本轮临时 Schema。验证范围包括：

- 普通、四种标点前缀及 200 字符编号的派发、两种查询和原结果重放；供应商只执行一次、重放不扣费。
- 点段编号通过查询参数核对和重放，不被 URL 改写。
- 无效、重复或额外字段不产生调用预留、资金变化或供应商请求。
- 用量缺失保留待核验，原编号重复请求不新增派发；Key 撤销后仍可查询本人历史，未登录及跨账户被拒绝。

`output/checks/call-identifiers-after.log` 为 6 项通过、零失败/取消/跳过，包含父用例和上述五组；本轮精确表绑定为 `ccagent_test_a15b93342005b25f`，受限角色为 `ccagent_runtime`，开发库 13 张表完整行摘要前后不变。修复前夹具 `ccagent_test_10e1ac1548db2014` 也证明开发库摘要未变。

`call-identifiers-cleanup.json` 确认这两组明确 Schema 已删除，活动查询与未结束事务为零、迁移数仍为四；另有一个 idle 后端，不将其称为活动事务或终止其他连接。`call-identifiers-typecheck-final.log` 类型检查通过。

随后 `call-identifiers-gateway-regression.log` 的既有网关 10 项全部通过，覆盖流式、有限重试、缺失用量、原结果重放、错误释放、文件归属和撤销后查询；上游为合成响应，数据库及存储实际执行。全部结束后 `call-identifiers-cleanup-inventory.json` 只读清点未发现任何 `ccagent_test_<16位十六进制>` Schema，活动查询和未结束事务为零、另有一个 idle 后端，开发库仍四个迁移。没有据此删除未知资源或终止其他连接。

既有完整云端 170 项属于本修正之前的源码，不能替代新专项；6 项和 10 项也不合并成新的全量验收数量。最终生产、真实供应商、邮件、支付、OpenAI 生图和安装版仍按各自门槛验收。

## 最新受保护开发预览

2026-11-07 16:21（北京时间）部署 `dpl_FMratseFv9HtcX6diGtsman8CFgF`，地址 <https://ccagent-cloud-4hhoq1t9t-lvye-1989s-projects.vercel.app>。已核对原 `ccagent-cloud` / `lvye-1989s-projects`，目标为 Preview，保持访问保护；Next.js、Node 24.x、sin1，无缓存构建 30.795 秒、READY。

`call-identifiers-deployment-inputs.json` 审查 101 个源码文件、462,835 字节，摘要 `fa93c5e1bf58f1a6a041ef6294a6ef2069e4d7b84679dcd29e00fde01f014299`，排除凭据、本地数据、测试及生成文件；`call-identifiers-deployment-final.json` 独立核对项目、环境和源码元数据一致。本地变更尚未提交，以源码摘要和 `gitDirty=1` 标识，不把 HEAD 当作完整变更已提交的证明。

`call-identifiers-preview-check.log` / `.json` 的 13 项通过：未认证访问继续受 Vercel 保护，受信任检查下健康接口正常，两个调用查询入口、账户、目录、管理及维护接口均拒绝未登录访问，账户页转登录，不存在账户经真实数据库认证路径被拒绝。该部署检查不包含已登录远端供应商调用，不代替上方隔离账本/存储专项或正式验收。

`call-identifiers-oidc-access.json` 记录访问令牌未输出及临时完整环境文件立即移除，没有覆盖 `cloud/.env.local`、更改保护策略、发布生产或生成新 EXE。没有真实邮件、充值、退款或付费模型请求。
