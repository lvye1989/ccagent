# CCAGENT 数据库备份、恢复与迁移回滚演练

## 范围

应用账户、权限、余额、订单、退款、调用用量、成本版本、配置和审计位于独立 Supabase 项目的 `ccagent` Schema。备份应覆盖整个应用 Schema、Drizzle 迁移记录、函数、触发器、约束、索引、序列、RLS 和授权，不能只导出用户或钱包表。外部对象和环境变量另行管理：数据库备份不包含私有 Blob 的文件内容、Vercel 环境变量、数据库角色密码或本机用户工作区。Supabase Free 项目应自行定期导出并保留异地副本；参见 [Supabase 备份说明](https://supabase.com/docs/guides/platform/backups)。

本仓库的 `db:rehearse` 使用真实 Supabase 连接，只在随机 `ccagent_test_<16位十六进制>` Schema 写入虚构数据，随后通过原生 `pg_dump` 导出，恢复到本机独立 PostgreSQL 实例。它不会恢复、删除或替换现有 `ccagent` Schema，也不做生产切换、真实收发邮件、商户充值退款或供应商调用。

## 运行演练

运行目录为 `cloud/`。已有忽略的 `.env.local` 应提供管理连接 `DATABASE_MIGRATION_URL`，通过直接或 session 连接使用；脚本拒绝 6543 事务连接。实际运行连接仍使用权限受限的 `DATABASE_URL`，两者不能互换。连接串和密码不放在命令行参数或报告中。

需要 PostgreSQL 17.x 的 `pg_dump`、`pg_restore`、`initdb`、`pg_ctl`。本机已使用 PostgreSQL 官网指向的 [EDB 二进制下载页](https://www.enterprisedb.com/download-postgresql-binaries)，下载 17.11-5 Windows x64 压缩包，并将运行所需的 `bin/lib/share` 解压到忽略目录 `.tmp/tools/postgresql-17.11-5/pgsql/`；未安装 Windows 服务或修改全局 PATH。下载地址：`https://get.enterprisedb.com/postgresql/postgresql-17.11-5-windows-x64-binaries.zip`。本次下载文件 SHA-256：`80379b2c04d51c30225532e0ae04509899141e9957ed096fe749d7fd9df8f82f`。该值用于识别本次工具包，不替代来源校验。

```powershell
Set-Location 'C:\Users\Windows11\Desktop\ccagent.src\ccagent-0.1.1\cloud'
npm.cmd run db:rehearse
```

其他位置的工具可通过 `CCAGENT_PG_BIN` 指定目录。本地测试服务使用随机端口，仅监听 `127.0.0.1`，采用本次生成的测试口令和 SCRAM；远端导出使用 `verify-full` TLS 和公开信任根证书。测试口令、会话 Cookie 及密码哈希不会输出至普通日志。所有子进程隐藏窗口运行，结束时关闭测试连接、停止本地服务并清理本轮随机 Schema 和临时集群目录。

后端共享连接配置和原生导出工具均已内置 Supabase 的公开根证书，并执行证书链及主机名校验。证书来源为 `https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt`，X.509 SHA-256 指纹为 `80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA`，有效期至 2031-04-26。供应商轮换时需复核并更新信任根。该校验覆盖客户端到所连接端点；连接池到数据库的内部链路由 Supabase 的平台设置负责，参见 [SSL 配置说明](https://supabase.com/docs/guides/platform/ssl-enforcement)。

演练按以下步骤验证：

1. 应用真实的 `0000`、`0001` 迁移，覆盖所有已声明应用表及迁移表，写入账户、认证、权限、账本、订单、退款、服务、价格和文件元数据。
2. 将全部行内容按确定顺序计算摘要，同时记录结构、函数、触发器、约束、索引、RLS、表/函数权限及序列状态。普通报告仅保留数量和摘要。
3. 使用原生 custom archive 格式导出整个随机 Schema，恢复至新的空数据库，逐项比较摘要。保留函数和授权，不以重新跑建表脚本代替恢复。
4. 通过现有 Better Auth 代码确认原 Cookie 能读取已恢复会话，原邮箱和测试密码能重新登录；邮件传输被显式禁止。
5. 应用当前真实迁移（包括 `0002`、`0003`）并再次执行，确认全部版本幂等；使用本地 `ccagent_runtime` 验证资金结算函数可执行，直接修改钱包、删除账本和篡改审计被拒绝。部署和演练共用运行角色授权函数。
6. 注入包含建表、写数据和失败语句的测试迁移，验证 DDL、数据及迁移记录在同一事务回滚。
7. 将迁移前的原始归档恢复到另一个空数据库，验证数据和版本回到 `0002` 之前，再次验证原会话并重新升级；不在运行中的数据库执行无选择删除。
8. 导出升级和结算后的当前状态，再恢复到第三个空数据库，核对所有数据与结构，并确认远端源 Schema 未被修改。

报告、表摘要及归档保存在忽略目录 `output/checks/database-recovery/<时间与随机编号>/`。`manifest.json` 是验收入口，结合命令退出码核对结果，不能仅根据归档文件存在判定恢复成功。该目录只保留虚构测试数据。生产备份应使用独立受控目录、加密存储及异地保留策略，不提交到 Git 或打入安装包。

运行角色的创建顺序不再影响资金函数授权：共用初始化函数检查并补齐 `post_ledger`、`authorize_usage`、`finish_usage` 的执行权限，同时保持钱包和账本的直接写入限制。`tests/runtime-bootstrap.test.ts` 在真实 Supabase 隔离 Schema 中撤销这些权限后，验证调用先被拒绝、初始化可幂等修复、授权和结算可执行；没有改动现有业务 Schema 的权限。

## 本地开发库迁移前加密备份

Windows 管理端可在 `cloud/` 运行 `npm.cmd run db:backup:local`。脚本只导出 `ccagent` 应用 Schema，使用管理连接和严格 TLS；原生二进制归档在内存中由当前 Windows 用户的 DPAPI 加密，再以独占方式写入 `%LOCALAPPDATA%\CCAGENT\database-backups\`。不会在源码、普通日志或磁盘临时文件中保存明文数据归档，也不会修改源数据库。现有备份不会覆盖。

2026-11-07 已保存开发库迁移前备份 `2026-11-06T23-25-07-920Z-5bb6f3fb-9113-4a36-9e75-d54d75c4dd61.dpapi.json`，原始归档 73,150 字节，SHA-256 为 `3c18c21d3636d89d8da205b62f00627387d65b386e95b529b2d7510b014a6239`。重新读取加密文件后解密、核对字节数与摘要，并让 `pg_restore` 读取目录和全部数据块；验证期间未执行归档中的 SQL，未将真实开发库数据恢复到另一数据库。证据为 `output/checks/development-backup-local.log` 和 `development-backup-verify.log`。

再次验证已有文件，不重新连接或导出数据库：

```powershell
npm.cmd run db:backup:local -- --verify "$env:LOCALAPPDATA\CCAGENT\database-backups\2026-11-06T23-25-07-920Z-5bb6f3fb-9113-4a36-9e75-d54d75c4dd61.dpapi.json"
```

DPAPI 备份依赖原 Windows 用户及其密钥材料，不能直接在另一台机器或另一个 Windows 账户解密。因此本步骤用于本地开发库变更前保留副本；正式灾难恢复仍需独立管理的可恢复加密密钥、异地存储和保留策略。恢复时应在原受控用户环境中解密并经管道传给 `pg_restore`，先恢复到隔离且禁止业务写入的新目标，不能直接覆盖运行数据库。上述加密验证与虚构数据的完整恢复演练分别记录。

当前本地工具对原生归档输出设 16 MiB 上限，超限会失败；大型数据库需先采用符合数据量的流式加密备份方案，不能把失败的备份当作迁移前副本。

## 上线前和故障恢复

计划迁移前记录当前应用代码、迁移文件摘要和数据库版本，核对即将执行的 SQL，并取得能恢复的备份。生产备份使用管理身份、完整应用 Schema 和 session/direct 连接；[pg_dump](https://www.postgresql.org/docs/17/app-pgdump.html) 的 custom archive 可由 [pg_restore](https://www.postgresql.org/docs/17/app-pgrestore.html) 还原。角色和角色密码通过受控服务端配置重建，恢复后重新核对运行角色权限；不能把运行身份提升为管理身份来解决恢复错误。

故障恢复先在新的、受保护且不接收业务写入的目标数据库进行，检查数据摘要、迁移版本、登录和资金约束，再决定切换。数据库快照只能恢复备份时刻的状态；正式切换前必须核对备份后的支付、结算和退款，以及账户禁用、Key 撤销和密码重置等安全变更。由服务端补偿或人工对账处理，不能直接把旧余额和旧授权作为最新结果。生产域名及写入切换需在上述核对完成后执行。

正常情况下优先向前修复迁移；确需恢复到旧版本时，使用迁移前备份恢复到新目标，并配套使用兼容的应用版本。演练证明该过程的数据库机制，不等于已经完成生产备份调度、异地保留或生产故障切换。

## 验证证据与连接诊断

2026-11-07 后续的有界获锁实现、两款 Node 驱动对照和完整回归进度，见 [数据库并发记录](database-concurrency.md)。下述较早的失败与恢复报告继续保留作为历史证据。

2026-11-07：`db:rehearse` 完成 12 项检查。当前报告为 `output/checks/database-recovery/2026-11-06T23-49-58-695Z-26d8bf6c/manifest.json`，包含 21 张应用表和 1 张迁移表，从前两个迁移升级到当前四个迁移后再次完整恢复。报告确认源测试 Schema 清理、本地服务停止，成功演练的临时集群目录已删除。首次管道等待失败留下的 `ccagent-pg-recovery-CFE5Ad` 目录保留为诊断证据，服务已停止；后续演练未复用它。此前 11 项、三个迁移的成功报告仍保留在 `2026-11-06T22-50-32-143Z-9ee20da7/`。

`recovery-account-lock-final.log` 的一次失败显示结构摘要相同、数据摘要不同。已实测源库使用 `en_US.UTF-8`、演练库使用 `C`，相同大小写测试行的默认排序不同；摘要现在对行和结构清单显式使用 `COLLATE "C"`。增加强制包含大小写行的跨排序回归后，上述 12 项演练通过。仅规范比较顺序，不重写数据或改变源库排序规则。生产恢复应另行匹配编码、排序规则及其版本，不能以摘要通过替代该核对。

4 项数据库 TLS 检查通过：受信链可以连接，不可信链及错误主机名被拒绝；测试只进行无凭据的 SSLRequest/TLS 握手。运行账户后置创建/补权测试另有 1 项通过。类型检查和云端构建通过。上述结果分别记录在 `output/checks/database-tls.log`、`runtime-bootstrap.log`、`recovery-final-typecheck.log` 和 `recovery-final-build.log`。

同轮完整云端回归共 74 项，71 项通过、3 项失败（价格目录父用例及其一个子用例、钱包并发用例），错误为连接关闭或查询超时。失败日志 `output/checks/cloud-recovery-full.log` 已保留。随后带诊断重跑价格目录及钱包共 9 项通过，不能据此认定根因已修复或正式稳定性验收已完成。

新增账户事务锁后，管理身份/5432 会话连接的完整回归 `cloud-account-lock-full.log` 仍有资金超时和后续依赖用例失败；原失败不能归结为锁顺序已全部修复。`0003` 尚未应用到现有开发库。新锁的独立真实运行账户检查通过三类入口排队、其他账户并行、嵌套锁及回滚释放；入账客户端仅请求用到的标量 ID，避免无用的复合返回类型解析。

业务数据库夹具现默认采用 `.env.local` 中实际的 `ccagent_runtime`/6543 事务连接，初始化时核验真实角色和按 Schema 授权；管理连接仅用于迁移及测试准备。该方式完整业务回归 `cloud-runtime-account-lock-full.log` 共 76 项，69 项通过、7 项失败、无取消，仍有并发退款、额度授权及重复入账检查超时和后续依赖失败。旧管理身份对照仍可通过 `CCAGENT_TEST_BUSINESS_DATABASE=owner-session` 显式重现，已有失败日志保留。改变验收身份用于覆盖实际权限和连接方式；结果表明超时不限于管理连接，并未认定稳定性验收完成。

隔离诊断还用同一管理账户、原生 `pgbench 17.11`，分别以简单/扩展协议在 5432 与 6543 完成各 32 次并发入账请求，四组余额均只增加一次（`native-wallet-control.log`、`native-wallet-extended-control.log`）。临时目录中的 `pg 8.23.1` 驱动对照第一轮在入账检查后发生断言失败，阶段信息不足；加入明确的失败元数据后，后续一轮通过 32 次重复入账、48 次混合读取、10 次额度竞争与结算（`pg-driver-wallet-control.log`、`pg-driver-wallet-diagnostic.log`）。这些对照不能证明更换驱动就能修复间歇问题，正式依赖和运行驱动尚未更换。没有通过增加超时、减少并发或放松资金断言取得通过结果。

可通过 postgres 4.1 自带的 diagnostics channel 采集查询时序和池状态，不修改驱动文件：

```powershell
Set-Location 'C:\Users\Windows11\Desktop\ccagent.src\ccagent-0.1.1\cloud'
node --import tsx --import ./scripts/lib/database-trace.mjs --test --test-concurrency=1 tests/catalog.test.ts tests/wallet-concurrency.test.ts
```

元数据写入 `output/checks/database-trace-<进程与时间>.jsonl`，包括语句种类/摘要、连接编号、排队和首字节时序、事务结果及池状态。挂起超过 3 秒时，额外通过独立原生客户端读取等待事件、阻塞进程和语句摘要，辅助区分数据库锁等待与客户端/传输停顿。记录不含 SQL 正文、参数、结果、数据库地址、用户名或原始错误消息。诊断中的通过结果需与未启用诊断的回归分别记录。
