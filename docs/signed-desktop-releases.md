# Windows 发布、可信升级与回退

PR 和分支 push 会运行 `.github/workflows/verify.yml`。检查包括核心发布测试、云端 typecheck/离线测试/隔离 TLS PostgreSQL 集成测试/build，以及 Windows 安装包构建、隔离后端测试、真实 NSIS 安装、已安装 Electron 页面/预加载桥接启动、截图、重装保留配置和卸载。安装/卸载脚本拒绝普通 Windows 用户，只允许一次性 GitHub runner 或明确命名的专用 `ccagent-ci-*` 测试账号。云端真实 Blob/供应商端到端测试不在无凭据 CI 中，须另用专用测试资源运行；CI 不借用生产凭据。

普通 npm tag 发布必须依赖上述工作流通过。完整云端集成采用本机 PostgreSQL 服务，生成仅供当前 runner 使用的 TLS 证书并用 `NODE_EXTRA_CA_CERTS` 信任；生产证书验证逻辑不变。每个业务测试继续创建独立 schema，数据库名固定 `ccagent_ci`；测试脚本拒绝远端数据库。

## 正式桌面产物

`npm run desktop:dist` 或不带开发参数的 `node scripts/build-desktop.mjs` 默认要求正式签名。缺少以下配置即在下载或清理 staging 前失败，绝不自动降级为未签名安装包：

- `CSC_LINK`、`CSC_KEY_PASSWORD`：Windows 代码签名身份，由 electron-builder 读取。
- `CCAGENT_RELEASE_PUBLIC_KEYS_FILE`：JSON 对象，key ID 对应 PEM Ed25519 公钥。公钥随应用固化；清单不能自带信任根。
- `CCAGENT_RELEASE_KEY_ID`、`CCAGENT_RELEASE_PRIVATE_KEY_FILE`：清单签名身份，私钥只在发布环境使用，不复制进产物。
- `CCAGENT_RELEASE_DOWNLOAD_BASE`：正式 HTTPS 下载目录，以 `/` 结尾。
- `CCAGENT_RELEASE_CERTIFICATE_SHA256`：预期 Windows 发布者证书 SHA256，小写 64 位十六进制。

正式包启用 `forceCodeSigning`，构建后再次验证安装包的 Authenticode 状态及发布者证书，再生成 `.exe.manifest.json`。清单绑定版本、平台、下载地址、精确大小、SHA256 和发布者证书，采用 Ed25519 签名，默认有效期 30 天。签名检查失败不会产生可用于升级的清单。

`.github/workflows/desktop-release.yml` 提供手动准备流程，只接受与包版本相同的 `vMAJOR.MINOR.PATCH` tag，并使用 `windows-release` 环境；请在 GitHub 配置该环境的审批/分支规则以及 workflow 中列出的 secrets/variables。流程只上传审核产物，不把文件部署到下载站、不发送版本通知。正式下载站文件必须与清单里的 URL、大小和摘要一致。发布环境尚未配置时，流程会失败；不会创建或购买证书、生成正式密钥、签署正式版本。

本机调试可用 `--prepare-only` 或 `--dir`。一次性 CI 安装包必须显式传 `--unsigned-development`，不会包含正式公钥或签名更新清单，也不能与 `--copy-desktop` 合用。它只能验证安装行为，不能当作可信升级产物交付。

## 通知与用户安装

旧的“版本、说明、HTTPS 下载链接”公告保持兼容。管理员可在版本通知中附上发布工具生成的签名清单，并在云端配置 `CCAGENT_RELEASE_PUBLIC_KEYS`（与客户端已固定的公钥集合相同的 JSON）。云端会校验签名、有效期，并要求清单版本和下载地址等于公告字段；没有清单的旧通知仅保留普通下载能力。

桌面“帮助 → 检查并安装可信更新”从当前已登录账户读取公告，再用应用内固定公钥验证清单。用户确认后才下载，拒绝重定向，限制下载大小和时间，验证 SHA256 和 Windows 发布者。下载期间若启动了任务，会阻止安装。安装前再次核验文件；应用正常退出后，独立 helper 才运行已核验的安装包。用户数据和工作目录由原安装器保留。

## 回退与恢复

“帮助 → 从签名清单升级或回退”可选取以前版本的有效签名清单。低于当前版本时必须明确确认“下载并回退”，不能通过普通自动检查触发静默降级。它同样校验清单签名/有效期、文件摘要和发布者。已验证的清单与安装包留在用户数据的 `updates` 目录，可通过帮助菜单打开；到期清单需要发布者重新签发，不能绕过有效期。

首次升级前应备份重要会话与配置。回退安装器保留数据，但不能保证旧版本能读取以后版本的数据格式；遇到格式不兼容时，恢复对应旧版本的备份。更新下载或核验失败会保留当前应用；安装器本身失败时可从原版本清单重新安装。公钥轮换应先在一个受旧密钥信任的版本中加入下一把公钥，待客户端覆盖后才切换签名 key ID。

## 验证边界

`node --test scripts/test-signed-updates.mjs` 使用一次性测试密钥和非可执行 fixture，覆盖缺失签名身份拒绝、清单篡改/未知公钥/过期/不合法平台与 URL、下载大小/摘要不符、发布者拒绝、安装前文件变更和显式回退。`cloud/tests/signed-release.test.ts` 验证服务端签名和公告字段绑定。这里的测试不会签署实际发布产物。Windows 真实安装/启动检查只在专用测试环境执行。
