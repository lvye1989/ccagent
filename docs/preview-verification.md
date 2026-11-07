# 受保护 Preview 验证（2026-11-07）

本文记录首轮十组账户与后台验证。后续组合筛选版本的当前部署、筛选/导出口径及浏览器分阶段证据见 [后台组合筛选记录](admin-data-filters.md)。

验证路径为：真实浏览器邮箱密码登录 → Vercel 上的应用接口 → 独立测试 Schema → 用户中心和管理后台。使用正常 Better Auth、真实受限数据库账户和当前四个迁移，没有认证旁路。

## 首轮开发部署（保留）

| 项目 | 当前证据 |
| --- | --- |
| Vercel 项目 | `ccagent-cloud` / `prj_2VwqV4ZbAkSX4WKJKDImBzWsNNYF` |
| 团队 | `lvye-1989s-projects`，CLI 当前返回 Pro |
| URL | <https://ccagent-cloud-cq2wqtsqx-lvye-1989s-projects.vercel.app> |
| 部署 ID | `dpl_H2p3AvZ5DFoMEpTrgDekBkXnTsiv` |
| 目标 / 状态 | Preview / READY；访问保护保留 |
| 框架 / 运行时 / 区域 | Next.js 16.4.5 / Node.js 24.x / sin1 |
| 构建耗时 | Vercel inspect 返回 22 秒 |
| 源码 | 本地未提交工作区直接上传；不是某个 Git 提交的原样发布 |
| 上传摘要 | `d0fd1da77d95f5457b0184d16deb6d2cf1c81f52e37bde75da549d4e54a4f826` |

上传前后分别检查 Vercel 的实际文件清单，共 86 个源码文件、326,356 字节；清单仅包含云端源码、必要配置与两个共享金额/支付模块。本地环境文件、凭据、会话、个人数据、测试脚本、迁移工具和构建产物没有上传。摘要由按路径排序的文件 SHA-256 与长度清单计算，并写入保留部署的元数据。

现有开发库已经完成四个迁移后才部署新代码。Preview 沿用其服务端安全配置和 `ccagent_runtime`，没有给客户端增加数据库凭据，也没有修改 CCAGENT 的 Production、正式域名或最终安装包。Pro 支持每分钟 Cron；Vercel 的计划限制参考[官方文档](https://vercel.com/docs/schedules/cron-jobs/usage-and-pricing)。本轮没有激活正式环境维护调度。

## 真实浏览器验证

临时部署 `dpl_3pm42CE1f1k3kYtrhEn5np2GCCkR` 与保留部署使用相同上传摘要，仅逐次覆盖 `DB_SCHEMA=ccagent_test_930eb097cbfadbf6`、禁用付款并清空邮件/支付密钥。测试账户为两个已验证的虚构邮箱，密码随机生成；测试 Schema 包含当前迁移和受限角色授权。没有真实邮件、支付或供应商推理调用。

| 检查组 | 实际结果 |
| --- | --- |
| Vercel 保护 | 未携带平台身份时被拦截；自动化仅向指定 Preview 源发送短期 OIDC 请求头 |
| 未登录访问 | 用户、管理、模型和维护接口返回 401 |
| 邮箱密码与权限 | 浏览器错误密码提示、有效登录、真实会话落库；普通用户不能读取后台、设置或导出 |
| 个人 Key | 界面创建、一次性显示、隐藏、精确的 20 元限额；列表不返回完整 Key 或哈希；只填 Key 不能绕过登录，伪造归属被拒绝 |
| 管理员与数据 | 管理员正常登录；后台显示测试 Schema、四个迁移及 `ccagent_runtime`；管理员自己的 Key 列表没有其他用户数据，跨账户 Key 调用被拒绝 |
| 余额和并发 | 界面增加虚构余额 12.34 元；四个相同幂等编号的并发请求只再增加 0.01 元；实际为两条资金流水，用户界面显示 12.35 元，冻结为零 |
| 设置持久化 | 界面保存客服邮箱和字符串汇率 `7`，重新加载后保留；旧版本更新及环境变量只读字段修改均返回 409 |
| 导出和审计 | 管理员获得真实 CSV，不含密码/Key/哈希；余额调整、配置修改和导出均有审计行 |
| 撤销和停用 | 界面撤销 Key 后拒绝调用；后台禁用账户后原会话和新建 Key 的业务调用失效，账户页面回登录；390 像素登录页无水平溢出 |
| 浏览器错误 | 受测流程没有 pageerror 或应用 5xx 响应 |

共 10 组通过。初次运行在额度标签定位处停止，原因是标签还包含说明文字；仅修正验证脚本定位后重新运行通过，没有为测试增加应用旁路。

证据：

- `output/checks/hosted-preview-ccagent_test_930eb097cbfadbf6/report.json`
- `output/playwright/hosted-preview-ccagent_test_930eb097cbfadbf6/`：登录、账户、隐藏后的 Key、数据库、设置及窄屏截图。粉色条为截图对密码/Key 的遮罩。
- `output/checks/hosted-preview-source-audit.json`：上传范围和源码摘要。
- `output/checks/persistent-preview-check.log`：保留部署的 9 项保护、健康、未登录接口、跳转及错误密码检查通过，确实走了数据库认证路径。
- `output/checks/persistent-preview-after-cleanup.log`：删除临时测试 Schema 后再次通过同组检查，确认保留部署不依赖该 Schema；不是额外九个不同用例。
- `output/checks/persistent-preview-deployment.json`：实时部署元数据与上传摘要一致，基于 `c1a8847` 且 `gitDirty=1`，不能当作该提交的原样发布。
- `output/checks/persistent-preview-runtime-errors.json`：00:34–00:54 UTC 的 error/fatal 查询返回零条，无排除区间或后续分页；这只是该次查询窗口的结果。

可复用工具为 `cloud/scripts/hosted-browser-fixture.ts`、`verify-hosted-preview.mjs`、`check-deployment-inputs.ts` 和原有 `check-preview.ts`。前两者从 `cloud/` 运行：夹具输出受限的合成凭据文件路径及停止文件路径，验证器读取 `CCAGENT_PREVIEW_URL`、`CCAGENT_FIXTURE_FILE`、`CCAGENT_PLAYWRIGHT_PACKAGE` 和已有短期 `VERCEL_OIDC_TOKEN`。Playwright 包路径仅用于本机验证，不是应用运行依赖。不得记录凭据文件内容、请求头、HAR 或未遮罩 Key 截图。

## 清理与边界

先以精确部署 ID 删除临时 Preview，再通知夹具清理。夹具进程已正常结束；原生数据库查询确认该测试 Schema 不存在、没有活动测试查询，开发库仍有四个迁移，随后 `db:check` 返回 22 张表且连通正常。合成凭据与停止文件已移除，保留的开发 Preview 不依赖该临时 Schema。

这不替代真实注册/验证/密码找回收信、各供应商及公开成本验收、七支付经授权小额充值退款、大陆网络、正式环境隔离与灾备、正式维护任务或最终 EXE 验收。生图接入仍等待凭据选择。

## CLI 误建资源记录

按 CLI 帮助执行 `vercel env run ... -- node ../.tmp/verify-hosted-preview.mjs` 时，实际发生了单文件部署，而非执行验证。此行为的内部原因未确定，未再次重试该命令；后续验证直接读取已有且未过期的本地开发 OIDC Token，没有覆盖 `.env.local`。

- 误建项目：`verify-hosted-preview` / `prj_TRjhTwod1UqFCzoNpOatOFt5DMJp`。
- 唯一部署：`dpl_E5VFDmGgSsYCRCCPW9h4eHxojYcp`，被 Vercel 首次部署规则标为 Production；它不是 CCAGENT 的 Production。
- 文件 API 仅列出 `src/verify-hosted-preview.mjs`，SHA-1 `40917bb68c6067fb3913c047813b816d2f2e8c6e` 与当时本地脚本一致。该脚本没有内联凭据或真实用户数据。
- 项目自定义环境变量为零。部署的 136 个构建/运行变量名均已安全检查，没有数据库、AUTH_SECRET、供应商、邮件或支付等应用密钥变量；其中 Vercel 预置 Token/部署变量不等于复制应用凭据。没有读取或打印变量值。
- 未登录实际访问返回 302 到 `vercel.com`，访问保护仍生效。项目暂停命令被 CLI 拒绝：要求本人在终端输入项目名，不能自动确认；没有改用其他接口绕过。
- 删除该误建项目及唯一部署的确认问题已发送，尚未收到答复，因此资源仍保留，不能记录为已清理。

项目删除帮助明确要求本人批准后使用 `--confirm-name`。收到批准后，仅删除上述新建项目，并复查 CCAGENT 项目、保留 Preview 和本地链接；不删除既有部署或更改访问保护。
