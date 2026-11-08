# 应用到个人账户中心的安全登录衔接（2026-11-08）

应用中已有邮箱登录的用户点击账户中心、余额与充值、平台 Key 或调用明细时，通过绑定当前浏览器的短时票据进入同一个账户，无需再次输入密码。管理后台采用相同衔接，但原有管理员权限检查仍由云端执行。

## 实现

1. 点击时同步打开官方 `/account/bridge` 页面，避免请求完成后开窗被浏览器拦截。URL 只有本地来源、固定目标和随机 channel。
2. 云端创建 120 秒的签名 state，绑定 HttpOnly、Secure、SameSite=Lax 浏览器 nonce Cookie、channel、本地来源和固定目标。无共享 nonce 的首次并行请求使用当前 channel 的短期备用 Cookie；成功仅清理对应备用 Cookie。
3. 应用精确检查消息的 origin、窗口和 channel，经同源 `POST /api/account/bridge` 请求本地服务。原有 Origin 与 `x-ccagent-web` 校验继续生效。
4. 本地使用当前账户的 DPAPI 加密凭据向官方 issue 接口申请最多 60 秒的一次性票据。凭据始终留在本地服务端；请求期间退出、换账户或重启恢复的检查均在服务端执行。
5. 票据仅经指定窗口的 `postMessage` 和同源 POST 传递。数据库只保存票据哈希；消费以数据库事务原子删除，重新检查源用户验证、封禁、会话期限和撤销状态。
6. 内部 Better Auth 插件使用 SDK 签发源会话的 HttpOnly Cookie，不新建独立会话，不把会话值放入 JSON。内部签发路径不能从公开 auth HTTP 接口调用。
7. 成功窗口清除 opener 并替换到固定目标；不存在任意跳转。应用退出或密码重置撤销同一源会话，已打开的云端窗口下一次访问也必须重新登录。

本地来源只接受规范的 `http://127.0.0.1:<port>` 或 `http://localhost:<port>`。目标仅为 `/account`、`/account/billing`、`/account/keys`、`/account/usage` 和 `/admin`。页面设置 no-store、no-referrer 和独立 CSP nonce。Next.js 内部请求地址可能改写，桥接页使用严格匹配配置的 Host 校验；不从任意 forwarded header 构造来源或跳转地址。

弹窗拦截、关闭、超时、票据过期和账户切换均提供安全重试处理，不透传上游错误内容，也不保存票据到浏览器存储。

## 验证

- 云端真实隔离数据库及 Better Auth SDK：15 项通过，包括源会话撤销、密码重置、并发单次消费、跨浏览器、错误 state、Cookie 验签、封禁和首次并行开窗竞争；测试 Schema 已清理。
- 本地真实 HTTP 与 DPAPI：6 组通过，包括跨站/缺少请求头拒绝、异常和过期票据、重启后继续使用已加密会话、退出期间丢弃在途票据。
- 新增桥接 DOM 与完整 Web DOM 回归通过；25 项账户传输、15 项认证隔离及启动回归、源代码与安装包静态资源检查通过。根目录和云端类型检查、构建通过。
- 真实 Chromium + Next.js + 本地 Web + 隔离数据库：应用账户 A、云端原登录 B，点击余额入口直接进入 A；两个完全并行首次窗口分别进入 Key 和明细页，备用 Cookie 正确清理；退出应用后云端接口 401、受保护页面回到登录页。
- 浏览器检查中 session Cookie 为 HttpOnly、成功后 opener 已清除，最终 URL 无 state、ticket 或 token。测试没有创建个人 API Key、发送真实邮件、调用收费模型或支付。

复现入口：根目录 `npm.cmd run build` 后运行 `npm.cmd run test:account-bridge`；云端目录运行 `node --import tsx --test --test-concurrency=1 tests/account-bridge.test.ts`。完整浏览器环境可运行 `cloud/scripts/account-bridge-browser-fixture.ts`，仅创建临时测试 Schema，按其输出 stopFile 结束并清理。

## 当前发布

- 正式账户服务：`https://ccagent-cloud.vercel.app`。
- Production 部署：`dpl_CWx8HpvaN8QokbBuVYRna6bELNHd`，READY，已分配正式域名。
- 云端上传审查：107 个源码文件、488,612 字节，SHA-256 `c526ef7af20d568ed18a5cf094adc0178937d61a820a62f82d1343900a50043f`。不上传本地凭据、操作脚本、测试或生成文件。
- 正式站公开验证：新增桥接 7 项、已有账户服务 11 项通过。仅验证匿名拒绝、安全响应与接口健康，没有以真实用户在生产环境代登录。
- 本地 4174、4175 已重新构建并更新运行，健康 200、账户来源为正式服务，匿名桥接 401。

本次不涉及数据库迁移、支付启用、EXE 打包或真实用户账户操作。数据库继续使用既有私有 Schema；隔离测试结果与真实用户生产登录验收分别记录。
