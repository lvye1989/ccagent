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

安装后，按照[通过 `.env` 配置 DeepSeek](#通过-env-配置-deepseek)创建唯一的
`.env`，然后运行：

```bash
ccagent
```

macOS 和 Linux 可以使用基于 npm 的安装脚本：

```bash
curl -fsSL https://raw.githubusercontent.com/lvye1989/ccagent/main/install.sh | sh
```

安装脚本会检查 Node.js、让 npm 在不执行包生命周期脚本的情况下安装
Registry 最新版本，并确认 `ccagent` 已进入 `PATH`；它不会替你安装 Node.js。

## 模型配置

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

程序会从启动 `ccagent` 时所在的目录加载 `.env`，该文件已被 Git 忽略，
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
  "models": {
    "deepseek": {
      "protocol": "${DEEPSEEK_PROTOCOL:-openai-responses}",
      "model": "${DEEPSEEK_MODEL:-deepseek-flash}",
      "baseURL": "${DEEPSEEK_BASE_URL:-https://api.deepseek.com}",
      "apiKey": "${DEEPSEEK_API_KEY}"
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
| `QWEN_PROTOCOL` | 可选 Computer Use 感知协议：`openai-responses`、`openai-chat` 或 `gemini` |
| `QWEN_MODEL` | 用于理解 Computer Use 截图的 Qwen/视觉模型 |
| `DASHSCOPE_BASE_URL` / `QWEN_BASE_URL` | DashScope 或兼容 Qwen 截图感知端点 |
| `DASHSCOPE_API_KEY` / `QWEN_API_KEY` | Computer Use 感知模型的 API Key |
| `CCAGENT_OFFICE_ENGINE` | 可选 Office 渲染器偏好：`word` 或 `libreoffice` |
| `CCAGENT_PYTHON` | 可选 Python 3 可执行文件路径，用于 PDF 转换辅助程序 |
| `CCAGENT_POWERSHELL` | 可选 PowerShell 可执行文件路径，用于 Microsoft Word 自动化 |
| `CCAGENT_LIBREOFFICE` | 可选 LibreOffice/soffice 路径，用于跨平台 PDF 渲染 |

`WebSearch` 会直接调用 Tavily 与博查 REST API，两者都不经过 Skill 或 MCP。Tavily 仍为优先后端；请求失败或无结果时自动尝试博查，也可以通过 `provider: "bocha"` 明确调用博查。两种 Key 都未配置时，Anthropic 官方 Profile 使用服务端搜索，其他模型回退到 Bing。

`classic_words` 是只读的内置 CNKGraph REST 工具，不经过 Skill 或 MCP，也不需要 API Key。它支持诗词文章检索、作品详情、作者作品集、同韵作品、对偶句、平仄、古籍与卷次、典故以及历史人物查询，并包含输入与 JSON 结构校验、结果限流、错误隔离和可配置超时。CNKGraph 开放资源用于研究学习；商业使用前请另行确认授权。

查询作者作品集时，`author_writings` 会统一改走 CNKGraph 的 JSON 作品检索接口，因为旧作者接口返回 CSV。人物检索中，完整姓名请使用 `person_scope: "Name"`，姓氏请使用 `person_scope: "Xing"`；非姓名范围返回 404 时会自动按完整姓名重试。

### Windows Computer Use

`ComputerObserve` 与 `ComputerAction` 在 Windows 上提供内置、非 MCP 的桌面控制闭环：

1. `ComputerObserve(action="list_windows")` 列出可用的顶层窗口。
2. `ComputerObserve(action="observe", window_id="...")` 只捕获所选窗口，返回截图、可访问性元素树与一次性 `snapshot_id`。
3. `ComputerAction` 针对这份新鲜快照只执行一个动作，随后立即重新观察并返回下一份快照。

推荐组合是 DeepSeek 作为主推理/文本模型，Qwen 仅作为视觉感知模型。可配置上表中的 `QWEN_*`/`DASHSCOPE_*` 环境变量，或令 `modelRoles.computerUse`（也接受 `computer_use`、`vision`、`image`、`multimodal`）指向已经声明的模型 Profile。在自动交付模式下，Qwen 成功生成视觉描述后，只把描述返回 DeepSeek，不把截图附加到 DeepSeek 回合。

窗口像素和可访问性文本始终按不可信数据处理。终端、Windows 身份验证/安全窗口、密码管理器、ChatGPT 与 Codex 均被排除。上传、外部通信、删除、金融、安装、医疗、验证码、账户及敏感数据操作，即使处于 Full Mode 也必须在动作发生前逐次确认；密码修改与绕过安全机制会被拒绝并交还用户操作。

该实现复现了 Codex 风格的可观察操作闭环与安全边界，但不包含 Codex 私有桌面辅助程序。当前使用 Windows `PrintWindow` 与 UI Automation，因此受保护内容或部分 GPU 渲染窗口的截图效果可能不同。对于 DOM 密集的网页任务，如有浏览器原生自动化能力，仍应优先使用。

运行 `/config list`、`/model list` 或 `/doctor` 可以检查最终生效的配置。

## 常用方式

```bash
ccagent                         # 交互式 REPL
ccagent --model gpt             # 选择模型 Profile
ccagent --plan                  # 只读计划模式
ccagent --auto                  # 分类器辅助的权限模式
ccagent --permission-mode full  # 跳过权限引擎提示与 allow/deny 规则
ccagent --resume                # 恢复最近一次会话
ccagent --resume <session-id>   # 恢复指定会话
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
| `/skills`、`/agents`、`/hooks`、`/mcp` | 检查扩展注册表 |
| `/plugin`、`/marketplace` | 安装和管理插件 |
| `/memory` | 检查或编辑项目记忆 |

## 核心能力

- 文件与代码工具：Read、Write、Edit、MultiEdit、Glob、Grep、Bash、PowerShell
- 文档格式转换工具：MarkdownToPdf、WordToPdf、PdfToWord、PdfToMarkdown。工具接收工作区文件路径，包含输出签名校验、超时、隔离写入和安全覆盖，并可使用用户上传的模板。文本模板支持 `{{content}}`、`{{title}}`、`{{source}}`、`{{date}}` 以及 `template_data` 中的标量变量；DOCX/DOTX 模板合并当前使用 Windows 上的 Microsoft Word。LibreOffice 是跨平台 PDF 渲染回退，PDF 解析使用本地 `pdf2docx`、PyMuPDF 或 pdfplumber。
- Web 与外部工具：WebFetch、WebSearch、`classic_words`（CNKGraph 古典文献）、MCP Tools、MCP Resources
- Windows Computer Use：目标窗口定点截图、UI Automation 元素、单动作执行、Qwen 感知路由、过期快照拒绝与动作时安全确认
- 安全执行：Allow/Ask/Deny、Plan Mode、Auto Mode、项目可信判断、Hooks 和受支持平台上的 Shell Sandbox。Full Mode（`/mode full`）会主动跳过通用权限规则引擎；Computer Use 高影响动作确认、Hooks、路径校验、工具校验和已启用的 Sandbox 仍是独立约束层。
- 长任务：TodoWrite、持久化任务图、Sub-Agent、后台运行、Git Worktree 隔离、Agent Teams
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


cd C:\Users\Windows11\Desktop\ccagent-0.1.1
npm run build
npm pack
npm install -g --force .\ccdagent-0.1.2.tgz
