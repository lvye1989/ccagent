# CCAGENT 发信域名验证

2026-11-06 从已创建的 Resend 资源读取；发信域名：`notify.cjai.pro`。

在 Cloudflare 的 **cjai.pro → DNS → Records** 新增下列三条记录。名称按相对 `cjai.pro` 填写，TTL 选 Auto；CNAME 选择 **DNS only（灰云）**。保留现有 MX、TXT 及其他记录。

| 类型 | 名称 | 内容 |
| --- | --- | --- |
| TXT | `resend._domainkey.notify` | `p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC8fZs+CNSLFoSq/lbSYEH4//EqjQForhOrIsbRSh087NlMEkP2YgxVWuYbJ4IcqDyHU7W9yV0dfmfrcnKOZlRe0NtDeKaCsg5laqXLrHfVAMfDINleZu+J5MXErrtT9W3flWd6HAW5uAwA8t+iRDGNd0q17vX+rHCkrLEyetKHvQIDAQAB` |
| CNAME | `rsend.notify` | `rsend-apne1.forge.rmta.net` |
| CNAME | `send.notify` | `send.forge.rmta.net` |

以上是公开 DNS 验证信息，不含 API 密钥。添加后运行 `cloud/` 中的 `npx tsx scripts/check-email-domain.ts` 检查；需 Resend 确认 verified 后才能认定发信域名就绪。

资源入口：https://vercel.com/d/dashboard/integrations/resend/icfg_fAAP5xtVexWrKvnl4lUejqPL/resources/ir_m9qJF3UzTcFBu03W

## 实际验证

2026-11-07：通过已授权 Cloudflare MCP 核验正确的 `cjai.pro` 活跃 Zone，发现三条精确名称的记录均缺失；随后只新增上表三条记录，TTL Auto，CNAME 为 DNS only。Cloudflare API 复读及公开 DNS over HTTPS 均已解析到预期值。Resend API 已返回域名 `verified`，DKIM 与两条 SPF 验证记录均为 `verified`。未改动其他 DNS 记录。

域名验证不等于邮件已经送达收件箱。真实注册验证、密码找回收信仍待测试邮箱提供后验收。
