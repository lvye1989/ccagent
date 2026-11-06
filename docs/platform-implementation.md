# CCAGENT 云端平台实施与验收

需求依据：[临时记录.md](../临时记录.md)。此清单跟踪全部目标；离线检查通过不等于生产上线验收完成。

## 已落实与证据

- 2026-11-06：确认源码没有云端账户及数据库层；桌面、本地 Web 和 CLI 仍使用现有共享引擎。保留已有安装包相关未提交修改。
- 用户确定采用独立 Supabase 项目，不能连接或修改参考项目的生产业务表。
- `src/platform/money.ts`：整数微元、充值整数分、版本化价格所需的精确成本计算、美元汇率和倍率计算；缺少汇率或异常金额拒绝计算。
- `src/platform/zpay.ts`：POST 收银参数、MD5 签名与通知验签、订单金额和交易号核对、主动查单、全额退款与未知结果分类；没有重试退款的行为。
- `npm run test:platform-core`：离线金额和协议检查，包括独立 Python hashlib 签名向量及超长交易号精度保护。测试未发起真实支付，不证明支付商户生产权限。
- `npm run typecheck`：通过。
- `src/platform/accountClient.ts`、`secureStore.ts`：Better Auth 原生邮箱账户接口接入、每次检查有效会话、服务地址绑定、Windows DPAPI 凭据加密、退出和断网状态区分；不保存密码。
- CLI 已增加 `ccagent account setup/login/register/forgot/status/logout`，密码仅通过交互隐藏输入。共享账户客户端尚未接入所有业务请求的强制认证，不能据此认定统一登录完成。
- `npm run test:platform-account`：覆盖真实本地 HTTP 协议请求、Windows DPAPI 加解密、账户禁用/替换、来源变更、断网、退出、损坏凭据与 CLI 接入；属于测试服务协议验证，尚非真实 Better Auth 数据库验收。
- Vercel CLI 65.12.1 已登录；已发现 Supabase Free 和 Resend 邮件集成。后续只按已确认的独立项目配置，不自动升级付费数据库计划。
- 已创建并关联 `lvye-1989s-projects/ccagent-cloud`，项目编号 `prj_2VwqV4ZbAkSX4WKJKDImBzWsNNYF`；尚未部署应用。Supabase Free 安装返回 `integration_terms_acceptance_required`，正在等待用户在 Vercel 接受首次集成条款，尚未创建数据库。
- 已通过 Vercel API 写入并重新读取验证项目设置：`framework=nextjs`、`rootDirectory=cloud`、`nodeVersion=24.x`、`buildCommand=npm run build`、`installCommand=npm ci`。
- 当前验证：14 项金额/支付协议检查、15 项账户/CLI 检查、TypeScript、CLI 与图表构建均通过；编译后的账户帮助、未配置账户服务拒绝访问、命令行密码参数拒绝访问均通过。

## 下一步接续

1. 用户接受 Supabase 首次集成条款后，先检查安装与资源状态，避免重复创建。使用 CLI 65.12.1 的 `--non-interactive`，不要用该子命令不支持的 `--yes`。
2. 在 `cloud/` 中执行独立免费开发项目安装：`vercel integration add supabase --scope lvye-1989s-projects --name ccagent-development --billing-plan free --meta region=sin1 --environment development --no-claim --no-env-pull --non-interactive`。正式及测试数据环境继续保持隔离。
3. 按技能流程拉取并验证环境变量名称，完整连接真实数据库后建立 Next.js / Drizzle / Better Auth 后端与迁移，不能用示例数据替代。
4. 将现有 `src/platform` 金额、支付及账户组件接入真实服务，并继续完成下方所有未勾选项目；目前没有强制业务登录、云端账本或管理员后台完成的证据。

## 必须完成的实现与验收

- [ ] 独立 `cloud/` Next.js 应用、Vercel 项目、Supabase PostgreSQL 与隔离 Schema/数据库权限。
- [ ] Drizzle 版本迁移、连接复用、连通性和迁移版本检查、隔离环境的备份恢复与回滚演练。
- [ ] Better Auth 邮箱注册/验证、邮箱密码登录、找回密码、密码重置失效旧会话、禁用账户。
- [ ] CLI、Web、桌面及真实引擎的强制认证；自定义供应商和个人 Key 不能绕过登录。
- [ ] 客户端会话安全保存、账户切换数据隔离、保留并迁移已有本地文件与会话。
- [ ] 普通用户/管理员角色与服务端逐接口授权、受控初始化首个管理员。
- [ ] 个人 Key 创建/哈希保存/撤销/限额，用户余额、订单、调用明细和任务费用界面。
- [ ] 整数微元账本、冻结/结算/释放、并发余额保护、幂等和不可变审计流水。
- [ ] 七支付真实订单落库、5 秒内持久化确认通知、查单后幂等入账、通知丢失补偿。
- [ ] 原订单全额退款、冻结退款额度、未知结果保持待核验，禁止盲目重试。
- [ ] 主模型流式/工具/图片兼容接口；读图、Jev Decisions、Tavily/博查搜索和 Qwen 语音适配器。
- [ ] 平台路由、成本来源及版本、实际用量、1.3 倍率和结算汇率快照；未配置价格的服务不出售。
- [ ] 平台承担内部重试成本；流式中断按可核实用量结算，24 小时异常冻结补偿。
- [ ] 用户私有 Blob 大文件上传/读取/归属/短期有效/清理；禁止跨用户对象引用。
- [ ] 管理后台布局、账户权限、Key、订单退款、数据管控、服务路由、状态检测、分页筛选导出与审计。
- [ ] 非敏感配置落库、环境变量优先级、保存字段白名单、缓存失效与生效反馈、秘密不回显。
- [ ] 本地处理/Rhino/工具权限保持共享引擎；个人 MCP、RAG、Google/邮箱授权保留。
- [ ] 认证、越权、并发透支、重复通知、伪造回调、重试、中断、退款和隔离环境故障测试。
- [ ] 现有 CLI/Web/桌面/权限回归、真实数据库与各供应商联调、经授权小额充值退款、大陆网络验证。
- [ ] 配置正式域名、正式邮件与支付商户；更新版本并重新生成桌面安装包，放置在桌面。

## 当前环境状态

- 参考项目开发环境使用 Supabase PostgreSQL / Drizzle / Better Auth；没有复制其数据库连接串、认证密钥或其他服务密钥。
- 本机 Docker 命令可用，但 Docker Linux 引擎未启动，尚未运行数据库容器。
- 不将未完成的登录、账本、部署或真实支付描述为可用产品。
