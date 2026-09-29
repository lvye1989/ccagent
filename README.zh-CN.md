# CCAGENT

一个使用 TypeScript 和 Node.js 构建的开源终端 Coding Agent。

![CCAGENT banner](https://raw.githubusercontent.com/lvye1989/ccagent/main/public/img/banner.png)

CCAGENT 在一套可阅读、可扩展的代码中提供类 Claude Code 工作流：流式模型对话、本地文件与 Shell 工具、权限模式、会话、MCP、Skills、Sub-Agent、Agent Teams、多模态输入、Windows Computer Use 和插件系统。

> English documentation: [README.md](./README.md)

## 项目状态

**当前阶段：**阶段 36 已完成。

实现、教程文章与 `step/` 快照均已完成到阶段 36。`ccagent` 已发布到 npm 的 `latest` 标签，发布后的冷缓存 registry 验证已经通过。

## 路线图与当前进度

CCAGENT 采用 37 阶段路线图，从模型通信开始，逐步构建到最终分发。

| 阶段 | 模块 | 核心快照 | 状态 |
|---|---|---|---:|
| 0 | 项目脚手架 | 项目基础 | ✅ 已完成 |
| 1 | LLM 通信层 | [`step/step1.js`](./step/step1.js) | ✅ 已完成 |
| 2 | React/Ink 终端 UI | [`step/step2.js`](./step/step2.js) | ✅ 已完成 |
| 3 | Tool 接口与第一个工具 | [`step/step3.js`](./step/step3.js) | ✅ 已完成 |
| 4 | 核心 Agentic Loop | [`step/step4.js`](./step/step4.js) | ✅ 已完成 |
| 5 | 完整核心工具集 | [`step/step5.js`](./step/step5.js) | ✅ 已完成 |
| 6 | System Prompt 与上下文工程 | [`step/step6.js`](./step/step6.js) | ✅ 已完成 |
| 7 | 权限控制系统 | [`step/step7.js`](./step/step7.js) | ✅ 已完成 |
| 8 | QueryEngine 多轮编排 | [`step/step8.js`](./step/step8.js) | ✅ 已完成 |
| 9 | 会话持久化与恢复 | [`step/step9.js`](./step/step9.js) | ✅ 已完成 |
| 10 | 项目记忆系统 | [`step/step10.js`](./step/step10.js) | ✅ 已完成 |
| 11 | 上下文压缩 | [`step/step11.js`](./step/step11.js) | ✅ 已完成 |
| 12 | Token 预算精细管理 | [`step/step12.js`](./step/step12.js) | ✅ 已完成 |
| 13 | Plan Mode | [`step/step13.js`](./step/step13.js) | ✅ 已完成 |
| 14 | TodoWrite 会话任务跟踪 | [`step/step14.js`](./step/step14.js) | ✅ 已完成 |
| 15 | 持久化任务图（V2） | [`step/step15.js`](./step/step15.js) | ✅ 已完成 |
| 16 | MCP 协议支持 | [`step/step16.js`](./step/step16.js) | ✅ 已完成 |
| 17 | Skills 系统 | [`step/step17.js`](./step/step17.js) | ✅ 已完成 |
| 18 | Sandbox | [`step/step18.js`](./step/step18.js) | ✅ 已完成 |
| 19 | Sub-Agent 与 Agent 定义系统 | [`step/step19.js`](./step/step19.js) | ✅ 已完成 |
| 20 | 后台执行与 Worktree 隔离 | [`step/step20.js`](./step/step20.js) | ✅ 已完成 |
| 21 | Agent Teams 与多 Agent 协作 | [`step/step21.js`](./step/step21.js) | ✅ 已完成 |
| 22 | Hooks 生命周期系统 | [`step/step22.js`](./step/step22.js) | ✅ 已完成 |
| 23 | Output Styles 与用户命令 | [`step/step23.js`](./step/step23.js) | ✅ 已完成 |
| 24 | 渲染体验升级 | [`step/step24.js`](./step/step24.js) | ✅ 已完成 |
| 25 | 配置系统完善 | [`step/step25.js`](./step/step25.js) | ✅ 已完成 |
| 26 | 文件历史与回滚 | [`step/step26.js`](./step/step26.js) | ✅ 已完成 |
| 27 | 错误处理与韧性 | [`step/step27.js`](./step/step27.js) | ✅ 已完成 |
| 28 | Headless 与管道模式 | [`step/step28.js`](./step/step28.js) | ✅ 已完成 |
| 29 | Auto Mode 分类器 | [`step/step29.js`](./step/step29.js) | ✅ 已完成 |
| 30 | 多 Provider 支持 | [`step/step30.js`](./step/step30.js) | ✅ 已完成 |
| 31 | Web、MultiEdit、MCP Resources 与 PowerShell | [`step/step31.js`](./step/step31.js) | ✅ 已完成 |
| 32 | 图片与截图多模态输入 | [`step/step32.js`](./step/step32.js) | ✅ 已完成 |
| 33 | 内置命令补全 | [`step/step33.js`](./step/step33.js) | ✅ 已完成 |
| 34 | Extended Thinking 控制与展示 | [`step/step34.js`](./step/step34.js) | ✅ 已完成 |
| 35 | Plugins 与 Marketplace | [`step/step35.js`](./step/step35.js) | ✅ 已完成 |
| 36 | 打包发布与文档 | [`step/step36.js`](./step/step36.js) | ✅ 已完成 |

阶段 36 已通过本地类型检查、单文件打包、tarball 边界检查、隔离全局安装、安装器测试、真实 PTY 启动及 `npm publish --dry-run` 验证。

## 快速开始

运行要求：Node.js 22 或更高版本、npm，以及至少一个受支持模型服务的凭证。

从 npm Registry 直接全局安装 CCAGENT：

```bash
npm install -g ccdagent
ccagent --version
```

npm 包名为 `ccdagent`，安装后的终端命令仍为 `ccagent`。

以后升级到 Registry 最新版本可执行：

```bash
npm install -g ccdagent@latest
```

也可以不保留全局安装，直接运行一次：

```bash
npx --yes ccdagent@latest
```

npm Registry 包由公开的
[`lvye1989/ccagent`](https://github.com/lvye1989/ccagent) 仓库构建。通过
Registry 安装会下载已经打包的 CLI，不会在本地留下可编辑的源码仓库。

安装后先运行首次配置向导，再启动 CCAGENT：

```bash
ccagent init
ccagent
```

`ccagent init` 会根据当前账户自动创建 `~/.ccagent/.env` 和
`~/.ccagent/settings.json`，交互式配置 DeepSeek、可选的 Qwen 视觉模型与
Jev，并询问是否安装完整的 Google Workspace 官方 MCP 套件。向导会对已配置
模型执行连接测试。API Key 与 Google OAuth 凭据只写入私有 `.env`，不会写入
`settings.json`。重新运行向导会保留不相关的已有配置；离线环境可使用
`ccagent init --skip-test`。

### Google Workspace 官方 MCP 全套服务

Google 官方 Workspace 远程 MCP 目前仍处于 Developer Preview。运行
`ccagent init` 时选择安装，会一次加入 Gmail、Drive、Docs、Sheets、Slides、
Calendar、Chat 与 People 共 8 个 Streamable HTTP 服务；这里写入的是官方
远程端点配置，不会安装第三方 npm MCP 包。

使用前还需要加入 Google Workspace Developer Preview Program，在 Google
Cloud 项目中启用对应的 8 个 API、配置 OAuth 同意屏幕，并创建 OAuth 2.0 Web
客户端。请登记向导显示的精确回调地址（默认
`http://127.0.0.1:53682/oauth/callback`），再通过隐藏输入填写 Client ID 与
Client Secret。使用 `/mcp auth google-gmail`（或其他服务名）手动打开 Google
授权页；启动、后台发现工具和普通工具调用都不会自动弹出授权页。令牌保存在
`~/.ccagent/oauth/google-workspace`，不会写入 `settings.json`。

### 每个 MCP 独立 Open / Close

在应用内输入 `/mcp`，选择服务，再选择 **Open** 或 **Close**。服务列表分页
显示，方向键选择、Enter 确认、Esc 取消。支持已配置的 stdio、HTTP、SSE
以及插件提供的 MCP 服务。

```text
/mcp list                    # 查看所有服务状态
/mcp google-gmail            # 打开该服务的 Open / Close 选择卡片
/mcp close google-gmail      # 关闭 Gmail MCP
/mcp open google-gmail       # 启用 Gmail MCP，后台连接
/mcp auth google-gmail       # 明确要求浏览器授权
/mcp tools google-gmail      # 查看该服务的工具
/mcp reconnect google-gmail  # 后台重连，不自动弹授权页
```

选择保存在当前用户的 `~/.ccagent/settings.json`，在当前进程立即生效。Close
会取消待处理连接、授权等待与在途请求，并撤下该服务的工具；不删除服务配置
或 OAuth 令牌，也不能撤销远端已经接受的操作。其他已启动的 CCAGENT 进程
需要重启才能读取新设置。重连和插件重新加载不会擅自打开已经 Close 的服务。

```json
{
  "mcpServerStates": {
    "google-gmail": "close",
    "plugin:example:server": "open"
  }
}
```

每个 `mcpServers` 服务定义也支持 `"enabled": false`。用户开关优先于普通
服务定义，但不能覆盖受管理策略的禁用，也不绕过项目可信与 `.mcp.json`
审批。Open 不代表自动授权：需要时使用 `/mcp auth <服务名>`；授权在后台
进行，可用 Close 取消。有效的已保存刷新令牌仍可静默续期。
Rhino、Computer Use 等内置工具不是 MCP 服务，不受此菜单影响。

Google 官方配置说明：
[配置 Google Workspace MCP 服务器](https://developers.google.com/workspace/guides/configure-mcp-servers?hl=zh-CN)。

### QQ 与 163 个人邮箱

内置 `Mail` 工具支持对已配置的 `qq` 或 `163` 邮箱执行 `list`（列信）、
`read`（读信）、`search`（搜索）、`draft`（保存草稿）、`delete`（移入
Trash 文件夹）和 `send`（发送）。它只连接预设的服务商 IMAP/SMTP 服务器并
使用 TLS，不接受任意邮件服务器地址；与 Gmail MCP 独立。

1. 在 [QQ 邮箱设置](https://help.mail.qq.com/detail/106/985)中开启第三方
   IMAP/SMTP 服务并生成客户端授权码。163 邮箱在网页版的“设置 →
   POP3/SMTP/IMAP”中开启所需协议并生成授权码，参见
   [网易客户端设置说明](https://help.mail.126.com/faqDetail.do?code=d7a5dc8471cd0c0e8b4b8f4f8e49998b374173cfe9171305fa1ce630d7f67ac2a5feb28b66796d3b)。
2. 将要使用的邮箱地址和**客户端授权码**填入选定的私有 `.env`：

   ```dotenv
   CCAGENT_QQ_MAIL_ADDRESS=your-name@qq.com
   CCAGENT_QQ_MAIL_AUTH_CODE=your-qq-client-authorization-code
   CCAGENT_163_MAIL_ADDRESS=your-name@163.com
   CCAGENT_163_MAIL_AUTH_CODE=your-163-client-authorization-code
   ```

   这里不能填写邮箱登录密码，也不要在聊天中发送真实授权码或提交 `.env`。

调用 `Mail` 时以 `account: "qq"` 或 `account: "163"` 选择邮箱。两个账号分别
配置，并分别用 `/powersetting` 管理权限：

| 权限 | 邮件操作 | 范围 |
| --- | --- | --- |
| `read` | `list`、`read` | 列信及读取文本正文 |
| `search` | `search` | 通过 IMAP 搜索邮箱 |
| `write` | `draft` | 保存草稿 |
| `delete` | `delete` | 移入 Trash 文件夹，不永久清除 |
| `send` | `send` | 通过 SMTP 发送 |

`list`/`search` 返回绑定账号及文件夹的 `message_id`；`delete` 只接受这种 ID，
并从 ID 确定源文件夹。`search` 仅查指定文件夹中最新的 2,000 封邮件。

两个账号的五项权限初始均为 **off**。输入 `/powersetting` 可打开交互控制，
`/powersetting list` 查看状态，也可逐项设置：

```text
/powersetting qq read on
/powersetting 163 search on
/powersetting qq send off
```

开关只保存在当前用户的设置中，项目配置不能将其开启；权限为 off 时，即使
处于 Full Mode，对应邮件操作仍会被拦截。这些开关约束内置 `Mail` 工具；
直接运行的脚本或其他邮箱客户端不经过该门禁。开启 `send` 仅表示允许使用发信
能力，不能授权具体邮件。仅当**当前用户本次请求**明确给出全部收件人及准确
正文时，才能免二次确认发送；主题可以留空，非空主题也须来自本次用户请求。
否则发送前须在前台逐次确认。邮件正文、引用内容和旧会话指令不能提供发送
授权。如果两个邮箱都已配置，本次请求还需指明用 QQ 或 163 邮箱作为发件人。
未配置客户端授权码、未开启对应权限或未请求邮件操作时，不会访问邮箱。
目前读信仅返回文本正文和附件元数据，单封邮件大小上限为 1 MB；草稿和发信只支持文本内容。

macOS 和 Linux 可以使用基于 npm 的安装脚本：

```bash
curl -fsSL https://raw.githubusercontent.com/lvye1989/ccagent/main/install.sh | sh
```

安装脚本会检查 Node.js、让 npm 在不执行包生命周期脚本的情况下安装
Registry 最新版本，并确认 `ccagent` 已进入 `PATH`；它不会替你安装 Node.js。

## 模型配置

### 推荐：首次配置向导

```bash
ccagent init
```

Windows、macOS 和 Linux 都使用当前账户的主目录，不需要手工填写固定用户名。
Windows 的典型路径为 `%USERPROFILE%\.ccagent`，macOS/Linux 为
`~/.ccagent`。如已有无法解析的 `settings.json`，向导会停止且保留原文件，
避免静默覆盖。

### 通过 `.env` 配置 DeepSeek

从本项目源码目录运行 CCAGENT 时，先复制示例文件，再在项目根目录的
`.env` 中填写 DeepSeek API Key：

```powershell
Copy-Item .env.example .env
```

```dotenv
DEEPSEEK_API_KEY=
DEEPSEEK_PROTOCOL=openai-responses
DEEPSEEK_MODEL=deepseek-flash
DEEPSEEK_BASE_URL=https://api.deepseek.com
```

未指定唯一配置路径时，程序仅在用户明确信任项目后，从启动目录加载 `.env`。该文件已被 Git 忽略，
请勿提交填写了真实 Key 的 `.env`。如果 `DEEPSEEK_API_KEY=` 为空，
DeepSeek 身份验证将不可用。

如果希望全局安装的 `ccagent` 能在任意目录使用，请让
`CCAGENT_ENV_FILE` 指向这一个唯一的 `.env` 文件。例如在仓库根目录的
Windows PowerShell 中执行：

```powershell
[Environment]::SetEnvironmentVariable("CCAGENT_ENV_FILE", (Resolve-Path ".env").Path, "User")
```

设置 Windows 用户环境变量后需要打开一个新终端，已经打开的终端不会
自动继承新值。CCAGENT 会主动忽略操作系统/进程环境以及 settings 文件
`env` 块中的 `DEEPSEEK_API_KEY`；选定的 `.env` 是 DeepSeek Key 的唯一来源。

未信任项目的 `env` 和模型 Profile 不会被加载。交互式启动会先询问信任；
`--print` 不会自动授予信任。用户级配置及明确指定的唯一 `.env` 仍可在任意目录使用。
项目不能替换 `CCAGENT_ENV_FILE`、用户目录/信任记录、Node 加载器或 TLS 校验设置。
用户 settings 中的相对 `.env` 路径以该 settings 文件所在目录为基准，不随项目目录改变。

使用原始 Anthropic 模型名时，只配置环境变量即可：

```bash
export ANTHROPIC_AUTH_TOKEN="your-token"
export ANTHROPIC_MODEL="claude-sonnet-4-20250514" # 可选
ccagent
```

CCAGENT 也支持具名的 Anthropic、OpenAI 兼容、Gemini 和本地模型 Profile。用户级配置放在 `~/.ccagent/settings.json`，项目级配置放在 `.ccagent/settings.json`：

```json
{
  "defaultModel": "deepseek",
  "agentTeams": true,
  "agentSkills": true,
  "agentStates": {},
  "models": {
    "deepseek": {
      "protocol": "${DEEPSEEK_PROTOCOL:-openai-responses}",
      "model": "${DEEPSEEK_MODEL:-deepseek-flash}",
      "baseURL": "${DEEPSEEK_BASE_URL:-https://api.deepseek.com}",
      "apiKey": "${DEEPSEEK_API_KEY}",
      "contextWindow": 1048576
    },
    "gpt": {
      "protocol": "openai-chat",
      "model": "gpt-5.1",
      "baseURL": "https://api.openai.com/v1",
      "apiKey": "${OPENAI_API_KEY}"
    },
    "gemini": {
      "protocol": "gemini",
      "model": "gemini-2.5-pro",
      "apiKey": "${GEMINI_API_KEY}"
    },
    "ollama": {
      "protocol": "openai-chat",
      "model": "qwen2.5-coder",
      "baseURL": "http://localhost:11434/v1"
    }
  }
}
```

通过 `ccagent --model deepseek` 启动，或在 REPL 中执行 `/model deepseek`
选择 Profile。未显式选择模型时，`defaultModel` 会将该 Profile 设为默认模型。

`contextWindow` 表示模型服务商提供的输入与输出总 Token 容量。CCAGENT
会用它计算预警与自动压缩阈值，但不会凭空扩大模型本身的容量。内置的
`deepseek-flash` Profile 使用 `1048576`（1 Mi Token）；自定义网关或本地
模型应填写服务商公布的真实数值。也可以使用
`CCAGENT_MAX_CONTEXT_TOKENS` 对当前进程统一覆盖。

CCAGENT 会在接近限制前自动清理旧工具结果并总结历史；多步骤工具循环
执行期间也会先压缩再继续，而不是直接中断。需要提前压缩或指定总结重点时，
仍可运行 `/compact [重点说明]`；运行 `/context` 可查看最终生效的窗口和估算占用。

| 环境变量 | 用途 |
|---|---|
| `ANTHROPIC_AUTH_TOKEN` | Anthropic API Token 或兼容网关 Token |
| `ANTHROPIC_BASE_URL` | 可选的 Anthropic 兼容端点 |
| `ANTHROPIC_MODEL` | 默认原始 Anthropic 模型名 |
| `DEEPSEEK_API_KEY` | DeepSeek API Key；只接受选定 `.env` 文件中的值 |
| `DEEPSEEK_PROTOCOL` | 可选的 DeepSeek 协议覆盖；示例 Profile 默认为 `openai-responses` |
| `DEEPSEEK_MODEL` | 可选的 DeepSeek 模型覆盖；示例 Profile 默认为 `deepseek-flash` |
| `DEEPSEEK_BASE_URL` | 可选的 DeepSeek API 地址覆盖；默认为 `https://api.deepseek.com` |
| `CCAGENT_ENV_FILE` | 指向唯一 `.env` 的可选绝对路径，用于从其他目录启动 |
| `CCAGENT_MAX_CONTEXT_TOKENS` | 可选的进程级上下文窗口覆盖；通常优先使用 Profile 的 `contextWindow` |
| `OPENAI_API_KEY` | OpenAI 兼容 Profile 引用的 Key |
| `GEMINI_API_KEY` | Gemini Profile 引用的 Key |
| `TAVILY_API_KEY` | Tavily API Key；配置后内置 `WebSearch` 将直接调用 Tavily |
| `bocha_API_KEY` | 博查 API Key；启用面向中文网络搜索的直接补充后端 |
| `WEB_SEARCH_ADAPTER` | 可选搜索后端：`tavily`、`bocha`、`api` 或 `bing` |
| `TAVILY_SEARCH_DEPTH` | 可选 Tavily 搜索深度，默认为 `basic` |
| `TAVILY_TIMEOUT_MS` | 可选 Tavily 超时毫秒数，默认为 `20000` |
| `BOCHA_TIMEOUT_MS` | 可选博查超时毫秒数，默认为 `20000` |
| `CLASSIC_WORDS_BASE_URL` | `classic_words` 可选 CNKGraph API 地址，默认为 `https://api.cnkgraph.com` |
| `CLASSIC_WORDS_TIMEOUT_MS` | 可选 CNKGraph 请求超时毫秒数，默认为 `15000` |
| `CCAGENT_BASH` | 可选 Bash 可执行文件；Windows 检测到 Git Bash 时会优先使用，以兼容原生盘符路径 |
| `MCP_TOOL_TIMEOUT_MS` | MCP 工具调用默认超时，默认为 `300000`；服务级 `toolTimeoutMs` 优先 |
| `GOOGLE_MCP_CLIENT_ID` | Google Workspace 官方 MCP 使用的 OAuth 2.0 Web Client ID；由 `ccagent init` 写入私有 `.env` |
| `GOOGLE_MCP_CLIENT_SECRET` | Google Workspace MCP 的 OAuth Client Secret；不会写入 `settings.json` |
| `CCAGENT_QQ_MAIL_ADDRESS` / `CCAGENT_163_MAIL_ADDRESS` | 内置 `Mail` 工具可选的 QQ / 163 个人邮箱地址 |
| `CCAGENT_QQ_MAIL_AUTH_CODE` / `CCAGENT_163_MAIL_AUTH_CODE` | 服务商签发的 IMAP/SMTP 客户端授权码，只放入私有环境文件 |
| `QWEN_PROTOCOL` | 可选 Computer Use 感知协议；DashScope 推荐并默认使用已验证的 `openai-chat`，也支持 `openai-responses` 或 `gemini` |
| `QWEN_MODEL` | 用于理解 Computer Use 截图的 Qwen/视觉模型 |
| `DASHSCOPE_BASE_URL` / `QWEN_BASE_URL` | DashScope 或兼容 Qwen 截图感知端点 |
| `DASHSCOPE_API_KEY` / `QWEN_API_KEY` | Computer Use 感知模型的 API Key |
| `OPENROUTER_API_KEY` | Computer Use、Rhino、Auto Mode、搜索与 Workfriend 的 Jev 决策所用 OpenRouter Key；保存于选定的私有 `.env` |
| `CCAGENT_COMPUTER_USE_JEV` | 配置 OpenRouter Key 后是否启用 Jev；默认启用 |
| `CCAGENT_COMPUTER_USE_INDICATOR` | 从首个 Computer Action 到本轮任务结束，持续显示置顶接管提示与独立代理指针；默认启用 |
| `CCAGENT_COMPUTER_USE_INDICATOR_IDLE_TIMEOUT_MS` | 异常退出时的兜底清理超时，可设为 `30000-600000` 毫秒；正常情况下任务结束即清理，默认 `120000` |
| `CCAGENT_TOOL_JEV` | Auto Mode 下是否优先用 Jev 判断非只读工具；配置 Key 后默认启用 |
| `JEV_TOOL_MODE` | 通用工具决策模式：`enforce`（默认）、`shadow` 或 `off` |
| `CCAGENT_SEARCH_JEV` | 是否按查询相关性与来源质量重排多条 `WebSearch` 结果；配置 Key 后默认启用 |
| `CCAGENT_WORKFRIEND_JEV` | 是否启用 Workfriend 的 Jev 情绪/压力评估；默认启用 |
| `CCAGENT_RHINO_JEV` | 是否启用 `RhinoAction` 的 Jev 路由、目标、参数和进度校验；配置 OpenRouter Key 后默认启用 |
| `CCAGENT_RHINO_JEV_MODE` | Rhino 专用的 `enforce`（默认）、`shadow` 或 `off` 模式 |
| `CCAGENT_RHINO_JEV_MIN_CONFIDENCE` | Rhino 路由决策的最低置信度，默认 `0.8` |
| `CCAGENT_RHINO_PROGID` | 用于连接运行中 Rhino 的 Windows COM ProgID，默认 `Rhino.Interface.8` |
| `CCAGENT_RHINO_TIMEOUT_MS` | RhinoCommon 桥接超时，可设为 `5000-300000` 毫秒，默认 `60000` |
| `CCAGENT_RHINO_AUTO_CLEANUP` | 默认 `1`：内置 Rhino 任务成功后清理已登记的中间截图；设为 `0` 保留全部截图用于调试 |
| `CCAGENT_RHINO_KEEP_CAPTURES` | 成功任务保留最后 `1-20` 张观察截图，默认 `1`；最终回复引用的图片额外保留 |
| `CCAGENT_JEV_MODE` | `enforce`（默认）、`shadow` 或 `off` |
| `WORKFRIEND_JEV_MODE` | `decision`（Jev 选择主要行动，默认）、`advisory`（仅评分）或 `off` |
| `JEV_MODEL` | OpenRouter Decisions 模型，默认为 `~typesafe/jev-latest` |
| `JEV_BASE_URL` | 可选的 OpenRouter 官方 Decisions 端点覆盖；默认为 `https://openrouter.ai/api/alpha/decisions` |
| `JEV_TIMEOUT_MS` / `JEV_MIN_CONFIDENCE` | 可选超时和执行置信度阈值；默认 `8000` 与 `0.8` |
| `QWEN_TTS_MODEL` | Workfriend 语音交付模型，默认 `qwen-audio-3.1-tts-flash` |
| `QWEN_TTS_VOICE` | 可选的 Workfriend 音色，默认 `longanhuan_v3.1` |
| `DASHSCOPE_TTS_URL` | 可选的 Qwen-Audio-TTS 完整接口地址；未设置时从 `DASHSCOPE_BASE_URL` 推导 |
| `CCAGENT_OFFICE_ENGINE` | 可选 Office 渲染器偏好：`word` 或 `libreoffice` |
| `CCAGENT_PYTHON` | 可选 Python 3 可执行文件路径，用于 PDF 转换辅助程序 |
| `CCAGENT_POWERSHELL` | 可选 PowerShell 可执行文件路径，用于 Microsoft Word 自动化 |
| `CCAGENT_LIBREOFFICE` | 可选 LibreOffice/soffice 路径，用于跨平台 PDF 渲染 |

`WebSearch` 会直接调用 Tavily 与博查 REST API，两者都不经过 Skill 或 MCP。Tavily 仍为优先后端；请求失败或无结果时自动尝试博查，也可以通过 `provider: "bocha"` 明确调用博查。两种 Key 都未配置时，Anthropic 官方 Profile 使用服务端搜索，其他模型回退到 Bing。配置 Jev 且结果不少于两条时，程序会用一次批量类型化决策按查询相关性与来源质量重排；Jev 失败时保持搜索提供商的原始顺序。

`BrowserSearch` 是打开已知网址或搜索结果页的独立快速通道：**LLM → BrowserSearch → 专用 Jev 门禁 → 系统默认浏览器**。它不需要先截图、扫描无障碍树或调用 Qwen。搜索引擎固定为百度、Bing、Google 与 DuckDuckGo；直接导航只接受 HTTPS，以及本地开发所需的回环地址 HTTP，并拒绝内嵌凭证和自定义协议。该路径复用 Computer Use Jev 配置并要求 `enforce` 模式；瞬时失败只做一次有界重试，Jev 不可用时会把完整的一次性请求交给一次独立回退复核，不会拆成桌面单步动作。用户明确选择 Full Mode 时，经过本地校验的普通请求可直接继续，不再额外调用回退模型。疑似秘密的输入不会发送给远程复核模型，即使在 Full Mode 仍会要求用户确认。成功只表示操作系统已接受该 URL，并不声称远端页面已经加载完成。需要事实、结构化搜索结果或引用时使用 `WebSearch`；必须继续操作网页时再进入通用 Computer Use 闭环。

在 Auto Mode 中，CCAGENT 会从当前真正启用的工具生成带修订号的内部 `tools_list`。它是运行时元数据，不是另一个可由模型调用的工具，也不会增加一轮 LLM。对于通用非只读调用，Jev 会收到精简工具清单、已选工具的说明、输入 Schema、决策策略，以及该次参数的限长脱敏摘要；真正执行前，运行时还会再次核对工具仍处于启用状态。高置信度且范围明确的本地操作可直接继续；删除、外部影响、凭证、安装、系统修改、范围扩大或不确定操作仍需确认。Computer Use、BrowserSearch、Rhino 与 Workfriend 保留各自的专用类型化门禁，不会被通用 Jev 重复判断。确定性拒绝、Schema/路径/新鲜度校验、阻断型 Hooks、Sandbox 与动作级确认底线独立生效，Jev 不能削弱它们。开放式规划与 Sub-Agent 路由仍由主 LLM 负责。

Full Mode（`/mode full`）会在可信本地会话中跳过普通权限提示，包括 `WebFetch` 首次域名提示和 Rhino/Workfriend 的普通确认，并由内置 Agent 与 Sub-Agent 继承。它**不会**重新开启已关闭的工具、MCP、Skill 或 Agent，不会绕过 Schema、参数、路径、工作区与新鲜度校验、阻断型 Hooks、专用 Jev 的停止/重观察/重规划决定或已启用的 Sandbox，也不会取消 Computer Use 的高影响确认底线和密码修改/绕过安全机制的确定性拒绝。BrowserSearch 遇到疑似秘密、敏感内容或与当前用户意图冲突时仍会要求确认。`Mail.send` 仍要求本轮用户直接给出准确收件人和完整正文，否则须在前台逐次确认。

Shell 命令会通过 `TEMP`、`TMP`、`TMPDIR` 和 `CCAGENT_TMPDIR` 获得进程专用临时目录 `~/.ccagent/tmp/process-<pid>`。PowerShell 生成的 Word 内容检查文件等临时产物可以继续交给 `Read`、`Grep` 或 `Glob`，但不会因此放开整个操作系统 Temp 目录。

`classic_words` 是只读的内置 CNKGraph REST 工具，不经过 Skill 或 MCP，也不需要 API Key。它支持诗词文章检索、作品详情、作者作品集、同韵作品、对偶句、平仄、古籍与卷次、典故以及历史人物查询，并包含输入与 JSON 结构校验、结果限流、错误隔离和可配置超时。CNKGraph 开放资源用于研究学习；商业使用前请另行确认授权。

查询作者作品集时，`author_writings` 会统一改走 CNKGraph 的 JSON 作品检索接口，因为旧作者接口返回 CSV。人物检索中，完整姓名请使用 `person_scope: "Name"`，姓氏请使用 `person_scope: "Xing"`；非姓名范围返回 404 时会自动按完整姓名重试。

### 内置 Workfriend

在交互式 REPL 中运行 `/workfriend` 即可启动内置工作伙伴。它会先通过交互卡片询问你今天在做什么、最近的办公心情、当前工作压力以及本地的下班时间，然后把提醒私密地保存到 `~/.ccagent/workfriend/`，并在下班前约一小时发起回访。如果当时 CCAGENT 没有运行，待处理提醒会在下次启动时恢复。

Workfriend 会在首次问询和下班回访后调用 OpenRouter Jev，将情绪负荷和压力负荷分别评为 `0-4` 级，同时判断当前工作状态并选择下一步行动。`WORKFRIEND_JEV_MODE=decision` 时，Jev 的行动选择是主方案，主 LLM 负责解释、个性化建议与安慰，不能静默改成其他方案；`advisory` 模式只使用评分。评分是非临床的工作状态参考，不是心理健康诊断。明确的即时危险或自伤信号由程序安全规则强制升级到人工/紧急支持，任何模型都不能降级。

发送给 OpenRouter 的仅为传入 `WorkfriendAssess` 的工作、心情、压力、进度与瓶颈摘要，不会自动发送隐藏会话全文、凭证或完整问卷。该工具按外部数据传输处理，Default/Auto 模式会逐次请求确认；用户明确选择 Full Mode 后会跳过这项普通提示，但不会绕过本地校验和紧急支持安全底线。提醒只持久化精简评分摘要，不保存完整问卷。回访选择题仍不超过 10 道；最终可选择导出为可编辑的 `.docx` 或由 Qwen 生成的 `.wav`。Word 交付无需额外依赖；语音交付会把最终文本发送到 DashScope，需要配置 `DASHSCOPE_API_KEY`（或 `QWEN_API_KEY`）。

### 内置 Rhino Agent

常用工具已扩展为曲线、曲面、实体、网格、SubD、复制/阵列、对象/图层/组管理，并提供只读 `RhinoInspect`。新工具的 **67 种子操作**及 Grasshopper 传参、数据树、求解、输出读取和烘焙示例见 [Rhino / Grasshopper 工具手册](rhino/TOOLKIT.md)。这些是明确实现的常用核心能力，不是对全部 Rhino 命令及第三方插件的无限制调用。

需要控制 Rhino 8 时，可以要求 CCAGENT 使用内置的 `rhino_agent`。它采用 **80% RhinoCommon 直接操作 + 20% Computer Use** 的组合：

看图建模从参考图、prompt 和已知实测尺寸开始。视觉模型先整理可见体量、尺寸与单位、立面节奏、材质、视角假设、遮挡部分及不确定估计，形成建模规格。如果关键尺寸仍不确定，`rhino_agent` 可调用 `WebSearch` 定向查找公开尺寸或常见设计范围，必要时用 `WebFetch` 核对来源页面并标注链接；常见范围只能作为设计假设，查不到或资料冲突时继续保留不确定性，不能把照片比例当作实测值。随后查询已启用的 Rhino 操作目录及所需 `RhinoInspect` Schema，再用 `RhinoObserve` 取得文档单位、对象和真实 GUID。主模型编制操作计划，Jev 审查固定步骤。视觉输出不能虚构 GUID、授予权限，也不能生成任意 Rhino/Grasshopper 命令。

- `RhinoObserve` 连接当前正在运行的 Rhino 8，不会自行启动应用；返回活动文档名称、单位与容差、图层、当前选择、对象 GUID/类型/包围盒、当前命令状态和撤销状态。
- `RhinoAction` 接受 `create_geometry`、`transform`、`extrude`、`loft`、`curtain_wall`、`set_view`、`boolean`、`set_layer`、`set_material`、`run_grasshopper`、`import_export` 和 `undo`。未知字段会被拒绝，不接受任意 Rhino 命令、宏或可执行脚本文本。
- `loft` 支持有序曲线 GUID 放样，或 `sections:[{z,width,depth},...]` 数值截面放样；可设置圆角比例 `corner_ratio`、侧面微凹 `concavity`、冠部下凹 `crown_dip`、图层与名称。非平面冠部使用 `cap:false`。`expected_units` 在单位不匹配时阻止建模。
- `curtain_wall` 从数值截面放样塔体生成玻璃、竖梃、横梁、层间板与设备层带；`floors` 和 `bays_per_side` 控制分格，最多 30000 块面板。组件合并为少量可编辑网格对象，保留源 NURBS 塔体；这是建筑外观模型，不是幕墙施工详图。
- `set_view` 按目标 GUID 调整视角和显示模式；可选 `portrait:true` 创建或复用竖版展示视口，`isolate:true` 隐藏其他对象但不删除（通过 Show 与对应图层的可见性开关恢复）。`RhinoObserve(capture:true)` 使用 Rhino 原生 API 在本地保存视口 PNG；仅在视觉校准、偏差诊断或最终验收时增加 `vision_analysis:true`，把 Qwen 视觉证据与原生观察一并返回。`.3dm` 导出支持 `target_guids`，直接写入指定对象及其图层、材质，避免格式对话框阻塞。
- 每个动作都必须携带 60 秒内生成的 `RhinoObserve` 编号。修改前，固定 RhinoCommon 桥接脚本会把对象 GUID、参数、文档状态与包围盒保存到项目文件夹的 `snapshots/`；每次 `RhinoAction` 复用 Rhino 为该脚本命令自动建立的单独 Undo Record（非命令宿主下再显式 `BeginUndoRecord`）。导出会保存快照并要求确认，但外部文件写入无法通过 Rhino Undo 撤销。
- Jev 输出 `route`、`next_action`、`parameters_valid`、`destructive` 与 `expected_progress`，仅在操作已有目标时检查 `target_valid`。参数无效会要求修正参数；动作失败、超时后观察立即失效。Jev 可以在 Auto Mode 放行高置信度普通 Rhino API 操作、要求重新观察、转交有界 Computer Use，或要求用户复核；不能直接执行或偷偷替换动作。
- 删除对象、任意 `delete_inputs:true`、删除空图层、导出/覆盖文件、加载第三方 `.gh`/`.ghx` 定义在 Default/Auto 模式下逐次确认。只有用户明确选择 Full Mode 才跳过这项普通提示；固定动作白名单、Schema、快照、路径、专用 Jev 结论、Hooks 与 Sandbox 边界仍然生效。GH 的 `inspect` 也按高影响操作处理，因为组件反序列化可能执行第三方代码；禁止任意模型脚本不等于沙箱。Jev 不可用时，Default/Auto 下的 Rhino 修改回退到人工确认。

直接桥接当前面向 **Windows 上的 Rhino 8**，通过已安装的 `Rhino.Interface.8` COM 自动化入口连接运行中的应用，并在 Rhino 内执行随包发布的固定脚本 `rhino/ccagent_rhino_runner.py`。请先打开 Rhino 并等待加载完成，再启动 `rhino_agent`；CCAGENT 会先确认 Rhino 进程已经存在，因此只读观察不会擅自启动 Rhino。如果同时打开多个 Rhino 实例，Rhino COM Interface 无法预先指定连接哪一个，请只保留需要控制的实例。

#### Jev 快速执行通道

内置 `rhino_agent` 优先使用 `RhinoSequence` 执行已明确的多步任务。主模型通常按一个建模阶段
规划 4–8 个有效步骤，最多 15 步。执行前，程序校验操作 Schema、单位、路径、显式 GUID 和步骤依赖，
并对目标与判断依据已稳定的步骤向 Jev 发起一次批量预审，每步保留独立结论。执行仍按顺序进行：
先核对该步预审是否仍适用；若依赖新生成的 GUID 或变化后的几何状态，则重新请 Jev 判断当前步骤；
随后逐步通过中央权限和 Hooks、由 RhinoCommon 执行，再以新鲜的 RhinoObserve 核验原生结果。
计划有效期间不必每步返回主模型。一次批量预审不等于整段计划获得执行授权；每个动作仍经过
原有权限、快照与 Undo 机制。

Jev 会收到当前已启用 Rhino 操作的精简 `tools_list`，包含已实现 `RhinoAction` 动作类别、
子操作和 `RhinoInspect` 操作；当前步骤另附精确参数契约。目录中的所有已实现动作及子操作
均可纳入快速计划，但目录发现不授予权限，Jev 也不能替换已校验的计划动作。数值放样 → 幕墙
→ 材质等可用 `targets_from` 引用前一步实际生成的 GUID；只读测量、剖切和最近点查询也可
组合执行。Jev 不生成任意脚本、不改变计划参数。

默认开启，要求 OpenRouter Key 已配置且 Jev 处于 `enforce`。设 `CCAGENT_RHINO_FAST=0`
可关闭。导出、删除、覆盖、布尔、撤销和 Grasshopper 也可列入快速计划；每一步仍经过
专用 Jev 与中央权限门禁。Default/Auto 下高影响步骤需要确认；若后台任务无法弹出确认，
序列会在该步骤执行前交回 Agent/用户。Full Mode 遵循上面的权限边界。
预审失效时先对当前步骤重新请求 Jev；若复审仍低置信度、缺失评分、超时或不可用，
或观察过期、文档变化、权限拒绝、原生核验失败，则交回主模型/用户。
不降低阈值、不自动重试建模、不自动回滚。每段最多 15 步，
执行超过 90 秒后不再启动下一步。

同一 agent 会话内，同一 `plan_id` 只执行一次（包括部分失败），重试返回原记录。
报告区分 `completed_steps`、`executed_steps` 和可能部分修改的 `uncertain_steps`，
后续计划只能包含尚未执行且已核实的工作。报告和 Jev 耗时写入桌面项目 `reports/fast-*.json`。
每个建模阶段结束时对齐视角，用 `RhinoObserve(capture:true, vision_analysis:true)` 将当前视口的
视觉证据与参考图规格比较，只针对观察到的偏差编制下一段计划。`RhinoSequence.capture_final`
只保存截图，不提供视觉分析。几何和视觉验收后，再单独导出选定对象至 `.3dm`，核验文件路径、
文件及对象集合。Full Mode（`/mode full`）跳过 Rhino 的普通人工确认，但仍经过 Jev、
中央门禁、本地校验和原生结果核验。
示例请求：**“用 Jev 快速通道完成塔体放样、幕墙和材质，导出前再向我确认。”**

验证命令：`npm run test:rhino-fast`；可选的 `npm run test:rhino-fast-live` 使用真实
LLM/Jev 对当前参考塔做三项只读检查，不改动模型，也不把只读耗时当作复杂建模性能保证。

#### Rhino 项目输出与自动清理

每次内置 `rhino_agent` 任务默认建立当前用户桌面下的 `CCAGENT-Rhino/Rhino-时间-唯一编号/`。
模型、预览、快照和报告统一归入此目录，不再随启动位置写入仓库根目录或 `rhino/output/`。
`RhinoObserve` 返回 `project_directory`，任务结束也会给出文件夹路径。
导出使用相对路径，例如 `models/tower.3dm`；确认卡显示的是解析后的绝对路径。
导入和 Grasshopper 输入仍按原工作目录定位，不会被改写。

可在 `.env` 设置绝对路径 `CCAGENT_RHINO_OUTPUT_ROOT` 更改项目父文件夹，或设置
`CCAGENT_RHINO_PROJECT_DIR` 继续使用指定的已有项目。不能将程序仓库或磁盘、用户目录、
桌面本身设为项目文件夹；路径穿越和符号链接重定向会被拒绝。
完整 `.3dm` 导出保留文档设置、组、图层状态、材质和用户数据，不改变当前打开文档的路径。
其它格式的 API 导出会在执行前提示改走单独确认的 Computer Use，避免格式对话框造成超时。
保存文件仍需确认；运行时不会因任务结束而擅自导出或覆盖已有模型。

内置 `rhino_agent` 完成后，程序自动清理本次任务明确登记的临时文件，不由大模型
猜测哪些路径应该删除。成功任务删除不再需要的中间观察截图，保留最后一张预览及
最终回复中引用或写明文件名的截图。任务失败、中断、达到轮次上限或出现失败步骤时，
保留观察截图用于诊断。可通过 `CCAGENT_RHINO_AUTO_CLEANUP=0` 保留全部截图，
或用 `CCAGENT_RHINO_KEEP_CAPTURES=2` 保留最后两张预览。

桥接的 `job.json`、`result.json`、临时包装脚本在确认执行结束后清理，任务结束时
再次尝试。PowerShell 调用进程被终止不代表 Rhino 已停止，因此无法确认完成的文件
会保留。模型、导出成果及 OBJ/MTL/纹理等配套文件、零字节失败导出、计划、Grasshopper
定义、操作快照、旧会话文件和未知项目文件均不自动删除。被用户修改过的文件、
符号链接/Junction、含未知内容的目录也会保留；清理不会删除 Rhino 几何对象。

结束回复会附上实际删除数量和项目 `reports/cleanup/` 下的清理记录。
临时文件直接删除，不进入回收站、不可恢复。既有未登记残留不会按日期、名称或空文件
规则批量清扫。正在运行的 CCAGENT 需要重启才能加载此功能。

### Agent Teams 默认状态与开关

每个 Agent 的开关与 Agent Teams 独立。输入 `/agents`，选择内置、自定义或插件 Agent，再选择 **Open** 或 **Close**；超过三个时可翻页。`/agents list` 查看全部状态，`/agents rhino_agent` 直接打开该 Agent 的卡片，也可输入 `/agents close rhino_agent` 或 `/agents open rhino_agent`。名称精确匹配（如 `Explore`、`plugin:helper`）。开关在本地执行，不调用模型或 API。

默认全部 Open。状态按名称保存到用户 `~/.ccagent/settings.json` 的 `agentStates`，例如 `{"rhino_agent":"close","workfriend":"open"}`。Close 会从模型可选列表隐藏该 Agent，并阻止新的前台、后台和团队调用，Full 模式也不能绕过；插件重载和项目同名覆盖不会擅自重新开启。定义文件、已有成果和历史保留，已经启动的任务不会强制中断，需要停止时请另行取消任务。关闭 Agent 不会连带关闭底层普通工具、Skills、MCP 或 Agent Teams。关闭 `workfriend` 还会停用 `/workfriend` 并暂存待发送提醒，Open 后恢复；已有会话内容不会被清除。

Agent Teams 现在默认处于 Open 状态，无需启动参数即可使用 `TeamCreate`、`SendMessage` 和 `TeamDelete`。在 REPL 中运行 `/agent-team`，即可通过交互卡片选择 **Open** 或 **Close**；也可以直接运行 `/agent-team open` 或 `/agent-team close`。选择会立即生效，并以 `agentTeams` 字段持久化到 `~/.ccagent/settings.json`。

如果当前仍有活动团队，CCAGENT 会拒绝 Close，避免遗留仍在运行的队友；请先结束队友并执行 `TeamDelete`。如需仅覆盖当前进程，仍兼容 `--agent-teams`、`--no-agent-teams` 以及旧的 `CCAGENT_TEAMS=1|0` 环境变量，它们的优先级高于已保存设置。

Skills 也默认 Open。输入 `/agent-skill` 可在本地卡片选择 **Open** 或 **Close**，不调用模型、无需 API；也支持 `/agent-skill open`、`/agent-skill close` 和 `/agent-skill status`。选择以布尔字段 `agentSkills` 保存到当前用户 `~/.ccagent/settings.json`，对后续调用立即生效，重启后保留。Close 会隐藏技能发现列表、技能补全和 `Skill` 工具，阻止 `/<技能名>`，并暂停按路径自动激活（含插件技能）；保留安装文件，再次 Open 即可恢复，`/skills reload` 不会擅自开启。Agent（含 `rhino_agent`）、Agent Teams、MCP、普通工具和自定义提示命令独立控制。关闭不会清除已进入会话的技能内容、撤销已完成操作或收回本会话已授予的权限；需要清空上下文时请使用 `/clear` 或新建会话。

### Windows Computer Use

普通搜索或直接打开网址时，优先使用 `BrowserSearch`：它经过一次专用 Jev 判断后直接打开校验过的搜索结果 URL 或 HTTPS URL，通常不需要先观察桌面。需要识别或操作网页时，再使用 `ComputerObserve`、`ComputerAction`、`ComputerActionGroup` 与 `ComputerNavigate` 构成的 Windows 内置、非 MCP 桌面控制闭环：

1. `ComputerObserve(action="list_windows")` 列出可用的顶层窗口。
2. `ComputerObserve(action="observe", window_id="...")` 只捕获所选窗口，返回截图、可访问性元素树与一次性 `snapshot_id`。
3. `ComputerAction` 针对这份新鲜快照只执行一个动作，随后立即重新观察并返回下一份快照。
4. `ComputerActionGroup` 是 `BrowserSearch` 无法完成的、已完整规划的普通浏览器交互快速回退。主 LLM 一次提交 2–8 个固定动作，Jev 对脱敏后的整组计划只判断一次；高置信度的 Jev 放行会替代普通权限提示和第二个分类模型。随后 Windows 在一次原生调用中连续执行，中间不截图、不扫描无障碍树、不调用 Qwen，最后只做一次精简的本地无障碍树观察。确定性拒绝、Plan Mode、阻断型 Hooks 与 Computer Use 高影响确认底线仍有最终约束力；Full Mode 以外还会应用已配置的 allow/deny 规则。最终检查默认关闭 Qwen；只有无障碍树不足时才显式启用。典型交互可以是 `set_value（新鲜快照中的已启用 Edit/ComboBox）→ Enter → 有界等待`，也可以是 `Control+L → 可选有界等待 → 输入网址/查询词 → Enter → 有界等待`；批量流程拒绝原始坐标点击，整组等待总计不超过 5 秒。文本改用 Windows 原生 Unicode 输入，中文不再依赖当前输入法；本地计划校验失败发生在 Jev 和真实输入之前，并保留快照供修正后重试。Jev 必须可用且处于 `enforce`，工具只支持浏览器和普通可逆输入，提交页面后禁止继续操作新页面。
5. `ComputerNavigate` 可让 Jev 在最多五步内选择可逆导航动作（Escape、翻页、Home/End、定量滚动或等待），每次输入后都重新观察；达到目标、状态含糊、疑似提示词注入、窗口变化、Jev 失败或达到步数上限时立即停止。该工具不能点击、输入、提交、上传、安装、删除或修改账户。

在 CCAGENT 发送本轮第一个输入前，Windows 会在目标窗口上端显示置顶的 **“ccagent正在控制电脑”** 提示条，并显示红橙色的**代理指针**。提示条与代理指针会跨越重新观察和多个单步动作持续存在，直到该轮任务完成、中止或失败时才消失。提示层可被鼠标穿透且不抢键盘焦点；点击、滚动与拖动通过定向窗口消息送往已验证的目标窗口，代理指针不再读取或移动用户的硬件鼠标，因此两个指针可以各自移动。键盘快捷键和文本输入仍需让目标应用获得 Windows 的唯一键盘焦点。提示只会在目标窗口与快照尺寸通过最终校验后出现。`CCAGENT_COMPUTER_USE_INDICATOR_IDLE_TIMEOUT_MS` 仅用于进程异常退出时兜底清理，并非单次动作显示时长；只有无人值守或无桌面环境才建议设置 `CCAGENT_COMPUTER_USE_INDICATOR=0`。

推荐组合是 DeepSeek 作为主推理/文本模型，Qwen 仅作为视觉感知模型。可配置上表中的 `QWEN_*`/`DASHSCOPE_*` 环境变量，或令 `modelRoles.computerUse`（也接受 `computer_use`、`vision`、`image`、`multimodal`）指向已经声明的模型 Profile。在自动交付模式下，Qwen 成功生成视觉描述后，只把描述返回 DeepSeek，不把截图附加到 DeepSeek 回合。

配置 `OPENROUTER_API_KEY` 后，CCAGENT 会在主 LLM 提出 `ComputerAction` 或 `ComputerActionGroup` 与权限/执行链之间增加 Jev 类型化决策门。程序通过 OpenRouter Decisions API 调用 `~typesafe/jev-latest`，一次批量判断目标是否存在、动作是否符合用户目标、是否疑似提示词注入、处置方式与实际风险。发送给 Jev 的只有文本和结构化状态，不含截图，也不含即将输入的正文。动作组严格只调用一次 Jev，不能静默回退为未经审查的多动作执行。Jev 只能提高、不能降低主 LLM 声明的风险；高置信度普通操作可避免 Auto Mode 再调用一次通用 LLM 分类器，不确定、高影响或判断冲突时会退回重新观察、现有权限确认或单动作执行。每个已执行结果都会同时记录 Jev 门禁与 `final_permission`，避免把原始 `execute` 误解为最终授权。每个请求都强制使用 ZDR 并禁止提供商收集数据。`ComputerActionGroup` 要求 `CCAGENT_JEV_MODE=enforce`；shadow/off 模式保留单动作路径。

窗口像素和可访问性文本始终按不可信数据处理。终端、Windows 身份验证/安全窗口、密码管理器、ChatGPT 与 Codex 均被排除。上传、外部通信、删除、金融、安装、医疗、验证码、账户及敏感数据操作，即使处于 Full Mode 也必须在动作发生前逐次确认；密码修改与绕过安全机制会被拒绝并交还用户操作。

`ComputerAction` 只作为动态目标或单步动作的回退工具。它的动作后观察默认使用本地 `perception=off`、`image_delivery=text_only`，并返回精简元素列表，避免每次按键后都远程调用 Qwen；只有本地无障碍信息无法定位或验收目标时，才重新显式调用 `ComputerObserve(perception="on")`。

如果用户只要求打开、搜索或导航，成功的 `BrowserSearch` 会直接结束快速通道，不需要初始 `ComputerObserve`；只有必须验证或操作页面状态时才进入桌面控制闭环。成功的 `ComputerActionGroup` 已包含最终本地观察，因此 CCAGENT 不会再重复调用一次 `ComputerObserve`/Qwen。

该实现复现了 Codex 风格的可观察操作闭环与安全边界，但不包含 Codex 私有桌面辅助程序。当前使用 Windows `PrintWindow` 与 UI Automation，因此受保护内容或部分 GPU 渲染窗口的截图效果可能不同。对于 DOM 密集的网页任务，如有浏览器原生自动化能力，仍应优先使用。

运行 `/config list`、`/model list` 或 `/doctor` 可以检查最终生效的配置。

## 常用方式

```bash
ccagent init                    # 首次创建用户配置并测试模型连接
ccagent                         # 交互式 REPL
ccagent --model gpt             # 选择模型 Profile
ccagent --plan                  # 只读计划模式
ccagent --auto                  # 分类器辅助的权限模式
ccagent --permission-mode full  # 跳过普通权限提示；Mail.send 仍受单次发送约束
ccagent --resume                # 恢复最近一次会话
ccagent --resume <session-id>   # 恢复指定会话
# 进入 CCAGENT 后运行 /workfriend，启动每日工作回访
# 进入 CCAGENT 后运行 /agent-team，选择 Open 或 Close
ccagent -p "总结这个仓库"                         # Headless 文本输出
ccagent -p "列出可用工具" --output-format json   # 机器可读输出
git diff | ccagent -p "审查这个补丁"              # 合并 stdin 与 Prompt
```

运行 `ccagent --help` 查看全部启动参数。常用 REPL 命令包括：

| 命令 | 用途 |
|---|---|
| `/help` | 查看命令和快捷键 |
| `/model`、`/mode`、`/think`、`/effort` | 控制模型、权限与推理行为（`/mode full` 提供广泛权限，但 Computer Use 高影响动作仍需确认） |
| `/config`、`/status`、`/doctor`、`/context` | 检查配置和运行状态 |
| `/resume`、`/history`、`/export`、`/copy` | 管理会话与输出 |
| `/rewind`、`/diff` | 检查或恢复文件改动 |
| `/permissions` | 检查权限规则 |
| `/skills`、`/hooks`、`/mcp` | 检查扩展注册表 |
| `/agents [list\|<name>\|open <name>\|close <name>]` | 查看全部 Agent，或逐个选择 Open/Close |
| `/plugin`、`/marketplace` | 安装和管理插件 |
| `/memory` | 检查或编辑项目记忆 |
| `/workfriend` | 启动内置工作/心情问询和持久化的下班前回访 |
| `/agent-team [open\|close]` | 开启或关闭 Agent Teams；不带参数时显示交互选择卡片 |
| `/agent-skill [open\|close\|status]` | 开启或关闭 Skills；不带参数时显示本地交互选择卡片 |

## 核心能力

- 文件与代码工具：Read、Write、Edit、MultiEdit、Glob、Grep、Bash、PowerShell
- 文档格式转换工具：MarkdownToPdf、WordToPdf、PdfToWord、PdfToMarkdown。工具接收工作区文件路径，包含输出签名校验、超时、隔离写入和安全覆盖，并可使用用户上传的模板。文本模板支持 `{{content}}`、`{{title}}`、`{{source}}`、`{{date}}` 以及 `template_data` 中的标量变量；DOCX/DOTX 模板合并当前使用 Windows 上的 Microsoft Word。LibreOffice 是跨平台 PDF 渲染回退，PDF 解析使用本地 `pdf2docx`、PyMuPDF 或 pdfplumber。
- Web 与外部工具：WebFetch、Jev 重排的 WebSearch、Jev 门禁的 BrowserSearch、`classic_words`（CNKGraph 古典文献）、MCP Tools、MCP Resources
- Windows Computer Use：普通打开/搜索请求的免快照 BrowserSearch、目标窗口定点截图、UI Automation 元素、单动作执行、单次 Jev 门禁的普通浏览器动作组、Jev 有界导航、Qwen 感知路由、过期快照拒绝与动作时安全确认
- 安全执行：Allow/Ask/Deny、Plan Mode、内部已启用 `tools_list` 加 Jev 的 Auto Mode 通用工具判断、项目可信判断、Hooks 和受支持平台上的 Shell Sandbox。Full Mode（`/mode full`）是显式免确认策略并由 Agent 继承，但工具/Agent 启用状态、输入校验、阻断型 Hooks、专用 Jev 结论、Computer Use 高影响确认、确定性拒绝和已启用的 Sandbox 仍是独立边界。
- 长任务：TodoWrite、持久化任务图、Sub-Agent、后台运行、Git Worktree 隔离、Agent Teams
- 内置 Workfriend：工作与心情交互问询、Jev 0-4 级情绪/压力评分与下一步决策、下班前一小时持久化回访、最多 10 道上下文选择题、优化建议与鼓励，以及 Word/Qwen 语音交付
- 上下文与连续性：会话持久化、Resume、Compaction、Token 预算、项目记忆、文件检查点和 Rewind
- 扩展能力：Skills、自定义 Agents、Slash Commands、Output Styles、Hooks、MCP Servers、Plugins 和静态 Marketplace
- 使用接口：Ink 交互界面、Headless text/JSON/NDJSON、图片与截图、多模型协议

## 升级与卸载

升级全局包，或重新运行安装脚本：

```bash
npm install -g --ignore-scripts ccdagent@latest
```

卸载：

```bash
npm uninstall -g ccdagent
```

卸载 npm 包时，`~/.ccagent/` 下的用户配置与会话会被有意保留。

## 故障排查

1. 运行 `ccagent --version`，并用 `node --version` 确认 Node.js 版本。
2. 在 CCAGENT 中运行 `/doctor`，检查凭证、Settings、MCP、Plugins、Sandbox 支持和目录写入权限。
3. 运行 `/status` 和 `/config list`，确认当前模型与配置来源。
4. 如果全局安装成功但找不到 `ccagent`，请把 `npm prefix -g` 对应的全局 bin 目录加入 `PATH`，然后打开一个新 Shell。
5. 可复现的问题请提交到 [GitHub Issues](https://github.com/lvye1989/ccagent/issues)。

提交 Issue 时不要包含 API Key、`.env` 内容或私密 Prompt。

## 架构

CCAGENT 将五层运行时职责保持分离：

```text
终端 UI
    ↓
QueryEngine（多轮编排）
    ↓
Agentic Loop（推理 → 工具 → 观察）
    ↓
工具与权限执行
    ↓
Provider API 与流式适配
```

打包发布是包裹这五层的交付层。npm 包发布为可读的 ESM 单文件 bundle 和 sourcemap，不携带运行时依赖树。

实现主线和教程快照已完成到阶段 35；阶段 36 负责把 CLI 打包分发，并补齐面向用户的公共文档。

## 本地开发

```bash
git clone https://github.com/lvye1989/ccagent.git
cd ccagent
npm install
cp .env.example .env
npm run dev
```

Windows PowerShell 请将 `cp .env.example .env` 替换为
`Copy-Item .env.example .env`。启动前请打开 `.env` 填写
`DEEPSEEK_API_KEY`，完整配置参见[通过 `.env` 配置 DeepSeek](#通过-env-配置-deepseek)。

常用检查：

```bash
npm run typecheck
npm run build
npm run test:stage36
npm run verify:release
npm publish --dry-run
```

主代码位于 `src/`，阶段快照位于 `step/`。`dist/` 是生成且被 Git 忽略的构建目录。

## 贡献

项目仍在快速演进，目前暂不接收外部 Pull Request。欢迎提交带有明确复现步骤的 Issue。

## License

[MIT](./LICENSE)
