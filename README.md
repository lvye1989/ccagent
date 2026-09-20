# CCAGENT

An open-source, terminal-native coding agent built with TypeScript and Node.js.

![CCAGENT banner](https://raw.githubusercontent.com/lvye1989/ccagent/main/public/img/banner.png)

CCAGENT provides a Claude Code-style workflow in a readable, extensible codebase: streaming model conversations, local file and shell tools, permission modes, sessions, MCP, skills, sub-agents, Agent Teams, multimodal input, Windows Computer Use, and plugins.

> 中文文档：[README.zh-CN.md](./README.zh-CN.md)

## Project status

**Current stage:** Stage 36 complete.

The implementation, tutorial article, and `step/` snapshot tracks are complete through Stage 36. The `ccagent` package is published on npm under the `latest` tag, and the post-publication cold-cache registry check passes.

## Roadmap and progress

CCAGENT follows a 37-stage roadmap that builds the system progressively from model communication to distribution.

| Stage | Area | Core snapshot | Status |
|---|---|---|---:|
| 0 | Project scaffold | Project foundation | ✅ Done |
| 1 | LLM communication layer | [`step/step1.js`](./step/step1.js) | ✅ Done |
| 2 | React/Ink terminal UI | [`step/step2.js`](./step/step2.js) | ✅ Done |
| 3 | Tool interface and first tool | [`step/step3.js`](./step/step3.js) | ✅ Done |
| 4 | Core agentic loop | [`step/step4.js`](./step/step4.js) | ✅ Done |
| 5 | Complete core toolset | [`step/step5.js`](./step/step5.js) | ✅ Done |
| 6 | System prompt and context engineering | [`step/step6.js`](./step/step6.js) | ✅ Done |
| 7 | Permission control system | [`step/step7.js`](./step/step7.js) | ✅ Done |
| 8 | QueryEngine multi-turn orchestration | [`step/step8.js`](./step/step8.js) | ✅ Done |
| 9 | Session persistence and restore | [`step/step9.js`](./step/step9.js) | ✅ Done |
| 10 | Project memory system | [`step/step10.js`](./step/step10.js) | ✅ Done |
| 11 | Context compaction | [`step/step11.js`](./step/step11.js) | ✅ Done |
| 12 | Fine-grained token budget management | [`step/step12.js`](./step/step12.js) | ✅ Done |
| 13 | Plan Mode | [`step/step13.js`](./step/step13.js) | ✅ Done |
| 14 | TodoWrite session task tracking | [`step/step14.js`](./step/step14.js) | ✅ Done |
| 15 | Persistent task graph (V2) | [`step/step15.js`](./step/step15.js) | ✅ Done |
| 16 | MCP protocol support | [`step/step16.js`](./step/step16.js) | ✅ Done |
| 17 | Skills system | [`step/step17.js`](./step/step17.js) | ✅ Done |
| 18 | Sandbox | [`step/step18.js`](./step/step18.js) | ✅ Done |
| 19 | Sub-Agent and agent definitions | [`step/step19.js`](./step/step19.js) | ✅ Done |
| 20 | Background agents and worktree isolation | [`step/step20.js`](./step/step20.js) | ✅ Done |
| 21 | Agent Teams and multi-agent collaboration | [`step/step21.js`](./step/step21.js) | ✅ Done |
| 22 | Hooks lifecycle system | [`step/step22.js`](./step/step22.js) | ✅ Done |
| 23 | Output styles and user commands | [`step/step23.js`](./step/step23.js) | ✅ Done |
| 24 | Rendering experience upgrades | [`step/step24.js`](./step/step24.js) | ✅ Done |
| 25 | Configuration system improvements | [`step/step25.js`](./step/step25.js) | ✅ Done |
| 26 | File history and rewind | [`step/step26.js`](./step/step26.js) | ✅ Done |
| 27 | Error handling and resilience | [`step/step27.js`](./step/step27.js) | ✅ Done |
| 28 | Headless and pipe mode | [`step/step28.js`](./step/step28.js) | ✅ Done |
| 29 | Auto Mode classifier | [`step/step29.js`](./step/step29.js) | ✅ Done |
| 30 | Multi-provider support | [`step/step30.js`](./step/step30.js) | ✅ Done |
| 31 | Web, MultiEdit, MCP resources, and PowerShell | [`step/step31.js`](./step/step31.js) | ✅ Done |
| 32 | Multimodal image and screenshot input | [`step/step32.js`](./step/step32.js) | ✅ Done |
| 33 | Built-in command completion | [`step/step33.js`](./step/step33.js) | ✅ Done |
| 34 | Extended Thinking controls and display | [`step/step34.js`](./step/step34.js) | ✅ Done |
| 35 | Plugins and Marketplace | [`step/step35.js`](./step/step35.js) | ✅ Done |
| 36 | Packaging, publishing, and documentation | [`step/step36.js`](./step/step36.js) | ✅ Done |

Stage 36 has passed local typechecking, bundling, tarball boundary checks, isolated global installation, installer tests, real PTY startup, and `npm publish --dry-run` verification.

## Quick start

Requirements: Node.js 22 or newer, npm, and credentials for at least one supported model provider.

Install CCAGENT globally from the npm Registry:

```bash
npm install -g ccdagent
ccagent --version
```

The npm package is named `ccdagent`; the installed terminal command remains
`ccagent`.

To upgrade later, install the latest Registry release again:

```bash
npm install -g ccdagent@latest
```

You can also run a one-off session without keeping a global installation:

```bash
npx --yes ccdagent@latest
```

The npm Registry package is built from the public
[`lvye1989/ccagent`](https://github.com/lvye1989/ccagent) repository. Installing
from the Registry downloads the packaged CLI; it does not leave an editable
source checkout on disk.

After installation, run the first-use setup and then start CCAGENT:

```bash
ccagent init
ccagent
```

`ccagent init` creates `~/.ccagent/.env` and
`~/.ccagent/settings.json` for the current account, prompts for DeepSeek and
optional Qwen vision access, and performs text and image connection tests. API
keys are stored only in the private `.env`, never in `settings.json`. Re-running
the command preserves unrelated existing configuration. Use
`ccagent init --skip-test` when setup must be completed offline.

An npm-backed installer is available for macOS and Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/lvye1989/ccagent/main/install.sh | sh
```

The installer checks Node.js, asks npm to install the latest Registry package
without running package lifecycle scripts, and verifies `ccagent` on `PATH`.
It does not install Node.js for you.

## Model configuration

### Recommended: first-use setup

```bash
ccagent init
```

The command derives the current user's home directory on Windows, macOS, and
Linux, so no hard-coded username is needed. It refuses to overwrite an existing
malformed `settings.json`, leaving the original file available for recovery.

### DeepSeek with `.env`

When running CCAGENT from this source checkout, copy the example file and set
the DeepSeek key in the project-root `.env`:

```powershell
Copy-Item .env.example .env
```

```dotenv
DEEPSEEK_API_KEY=
DEEPSEEK_PROTOCOL=openai-responses
DEEPSEEK_MODEL=deepseek-flash
DEEPSEEK_BASE_URL=https://api.deepseek.com
```

The `.env` file is loaded from the directory where `ccagent` is launched and
is ignored by Git. Never commit a populated `.env`. An empty
`DEEPSEEK_API_KEY=` leaves DeepSeek authentication unavailable.

If the globally installed `ccagent` command must work from every directory,
point `CCAGENT_ENV_FILE` at this one canonical `.env` file. For example, from
the repository root in Windows PowerShell:

```powershell
[Environment]::SetEnvironmentVariable("CCAGENT_ENV_FILE", (Resolve-Path ".env").Path, "User")
```

Open a new terminal after setting a Windows user environment variable. Existing
terminals do not inherit the new value. CCAGENT intentionally ignores
`DEEPSEEK_API_KEY` inherited from the OS/process and from settings-file `env`
blocks; the selected `.env` is the only accepted source for the DeepSeek key.

For a raw Anthropic model name, environment variables are enough:

```bash
export ANTHROPIC_AUTH_TOKEN="your-token"
export ANTHROPIC_MODEL="claude-sonnet-4-20250514" # optional
ccagent
```

CCAGENT also supports named Anthropic, OpenAI-compatible, Gemini, and local profiles. Put settings in `~/.ccagent/settings.json` for user-wide configuration or `.ccagent/settings.json` for a project:

```json
{
  "defaultModel": "deepseek",
  "agentTeams": true,
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

Select a profile with `ccagent --model deepseek` or `/model deepseek` inside
the REPL. `defaultModel` makes that profile the default when no explicit model
is selected.

| Environment variable | Purpose |
|---|---|
| `ANTHROPIC_AUTH_TOKEN` | Anthropic API token or compatible gateway token |
| `ANTHROPIC_BASE_URL` | Optional Anthropic-compatible endpoint |
| `ANTHROPIC_MODEL` | Default raw Anthropic model name |
| `DEEPSEEK_API_KEY` | DeepSeek API key; accepted only from the selected `.env` file |
| `DEEPSEEK_PROTOCOL` | Optional DeepSeek protocol override; defaults to `openai-responses` in the example profile |
| `DEEPSEEK_MODEL` | Optional DeepSeek model override; defaults to `deepseek-flash` in the example profile |
| `DEEPSEEK_BASE_URL` | Optional DeepSeek endpoint override; defaults to `https://api.deepseek.com` |
| `CCAGENT_ENV_FILE` | Optional absolute path to the one canonical `.env`, used when launching from other directories |
| `OPENAI_API_KEY` | Referenced by OpenAI-compatible profiles |
| `GEMINI_API_KEY` | Referenced by Gemini profiles |
| `TAVILY_API_KEY` | Tavily API key; makes built-in `WebSearch` call Tavily directly |
| `bocha_API_KEY` | Bocha API key; enables direct supplementary Chinese web search |
| `WEB_SEARCH_ADAPTER` | Optional search override: `tavily`, `bocha`, `api`, or `bing` |
| `TAVILY_SEARCH_DEPTH` | Optional Tavily depth; defaults to `basic` |
| `TAVILY_TIMEOUT_MS` | Optional Tavily timeout; defaults to `20000` |
| `BOCHA_TIMEOUT_MS` | Optional Bocha timeout; defaults to `20000` |
| `CLASSIC_WORDS_BASE_URL` | Optional CNKGraph API endpoint for `classic_words`; defaults to `https://api.cnkgraph.com` |
| `CLASSIC_WORDS_TIMEOUT_MS` | Optional CNKGraph request timeout; defaults to `15000` |
| `CCAGENT_BASH` | Optional Bash executable; Windows defaults to Git Bash when installed so native drive paths remain valid |
| `MCP_TOOL_TIMEOUT_MS` | Default timeout for MCP tool calls; defaults to `300000` (server-level `toolTimeoutMs` takes precedence) |
| `QWEN_PROTOCOL` | Optional Computer Use perception protocol; the verified DashScope default is `openai-chat`, with `openai-responses` and `gemini` also supported |
| `QWEN_MODEL` | Qwen/vision model used to interpret Computer Use screenshots |
| `DASHSCOPE_BASE_URL` / `QWEN_BASE_URL` | DashScope or compatible Qwen endpoint for screenshot perception |
| `DASHSCOPE_API_KEY` / `QWEN_API_KEY` | API key for the Computer Use perception model |
| `QWEN_TTS_MODEL` | Workfriend voice-delivery model; defaults to `qwen-audio-3.1-tts-flash` |
| `QWEN_TTS_VOICE` | Optional Workfriend voice id; defaults to `longanhuan_v3.1` |
| `DASHSCOPE_TTS_URL` | Optional full Qwen-Audio-TTS endpoint; otherwise derived from `DASHSCOPE_BASE_URL` |
| `CCAGENT_OFFICE_ENGINE` | Optional office renderer preference: `word` or `libreoffice` |
| `CCAGENT_PYTHON` | Optional Python 3 executable for PDF conversion helpers |
| `CCAGENT_POWERSHELL` | Optional PowerShell executable for Microsoft Word automation |
| `CCAGENT_LIBREOFFICE` | Optional LibreOffice/soffice executable for cross-platform PDF rendering |

`WebSearch` calls Tavily and Bocha through their REST APIs directly; neither integration uses a Skill or MCP. Tavily remains the preferred configured provider, while Bocha supplements it on errors or empty results and can be selected explicitly with `provider: "bocha"`. Without either key, CCAGENT falls back to Anthropic server-side search (for first-party Anthropic profiles) or Bing.

Shell commands receive a private per-process temporary directory at `~/.ccagent/tmp/process-<pid>` through `TEMP`, `TMP`, `TMPDIR`, and `CCAGENT_TMPDIR`. Files created there—such as Word content checks produced by PowerShell—can be consumed by `Read`, `Grep`, or `Glob` without granting those tools access to the entire operating-system temp directory.

`classic_words` is a built-in, read-only CNKGraph REST tool rather than a Skill or MCP integration. It needs no API key and supports poetry/prose search, exact works, author collections, rhymes, couplets, tonal patterns, ancient books and volumes, allusions, and historical people. It validates inputs and JSON responses, limits large results, isolates HTTP failures, and applies a configurable timeout. CNKGraph's open resources are intended for research and learning; confirm authorization before commercial use.

For author collections, `author_writings` is normalized through CNKGraph's JSON
writing-search endpoint because the legacy author URL returns CSV. For people,
use `person_scope: "Name"` with a full name and `person_scope: "Xing"` with a
surname; a 404 from a non-name scope is retried as a full-name lookup.

### Built-in Workfriend

Run `/workfriend` in the interactive REPL to start the built-in work companion. It first asks what you are working on, how work has felt recently, and your local workday end time through interactive cards. It then stores a private reminder under `~/.ccagent/workfriend/` and checks in about one hour before the workday ends. If CCAGENT is closed at that time, the pending reminder is restored on the next launch.

At check-in, Workfriend uses the current conversation context, asks about progress and bottlenecks, and presents at most 10 focused multiple-choice questions. It responds with prioritized suggestions and grounded encouragement. You then choose an editable `.docx` or a Qwen-generated `.wav`. Word delivery is dependency-free; voice delivery sends the final text to DashScope and requires `DASHSCOPE_API_KEY` (or `QWEN_API_KEY`).

### Agent Teams default and switch

Agent Teams is open by default, so `TeamCreate`, `SendMessage`, and `TeamDelete` are available without a startup flag. Run `/agent-team` to choose **Open** or **Close** in an interactive card. You can also run `/agent-team open` or `/agent-team close` directly. The choice is applied immediately and persisted as `agentTeams` in `~/.ccagent/settings.json`.

CCAGENT refuses to close Agent Teams while a team is active; finish the teammates and run `TeamDelete` first. For one-process overrides, `--agent-teams`, `--no-agent-teams`, and the legacy `CCAGENT_TEAMS=1|0` variable remain supported and take precedence over the saved preference.

### Windows Computer Use

`ComputerObserve` and `ComputerAction` provide a built-in, non-MCP desktop-control loop on Windows:

1. `ComputerObserve(action="list_windows")` lists eligible top-level windows.
2. `ComputerObserve(action="observe", window_id="...")` captures only the selected window and returns a screenshot, accessibility tree, and single-use `snapshot_id`.
3. `ComputerAction` performs exactly one action against that fresh snapshot, then immediately observes again and returns the next snapshot.

The recommended pairing is DeepSeek as the main reasoning/text model and Qwen as a perception-only model. Configure the `QWEN_*`/`DASHSCOPE_*` variables above, or point `modelRoles.computerUse` (also accepts `computer_use`, `vision`, `image`, or `multimodal`) at a declared model profile. In automatic delivery mode, a successful Qwen description is returned to DeepSeek without attaching the screenshot to the DeepSeek turn.

Window pixels and accessibility text are always treated as untrusted data. Terminals, Windows authentication/security surfaces, password managers, ChatGPT, and Codex are excluded. Uploads, external communication, deletion, financial, installation, medical, CAPTCHA, account, and sensitive-data actions require a fresh action-time confirmation even in Full Mode; password changes and safety bypasses are denied and handed back to the user.

This implementation reproduces the observable Codex-style workflow and safety boundaries, but it does not bundle Codex's private desktop helper. It uses Windows `PrintWindow` plus UI Automation, so protected-content and some GPU-rendered windows may capture differently. Browser-native automation remains preferable for DOM-heavy web tasks when available.

Run `/config list`, `/model list`, or `/doctor` to inspect the effective setup.

## Common usage

```bash
ccagent init                    # create user config and test model access
ccagent                         # interactive REPL
ccagent --model gpt             # select a model profile
ccagent --plan                  # read-only planning mode
ccagent --auto                  # classifier-assisted permission mode
ccagent --permission-mode full  # bypass permission-engine prompts and rules
ccagent --resume                # resume the latest session
ccagent --resume <session-id>   # resume a specific session
# inside CCAGENT: /workfriend   # start a daily work check-in
# inside CCAGENT: /agent-team   # choose Open or Close for Agent Teams
ccagent -p "summarize this repo"                 # headless text output
ccagent -p "list the tools" --output-format json # machine-readable output
git diff | ccagent -p "review this patch"         # combine stdin and a prompt
```

Run `ccagent --help` for every startup option. Useful REPL commands include:

| Command | Purpose |
|---|---|
| `/help` | List commands and shortcuts |
| `/model`, `/mode`, `/think`, `/effort` | Control model, permission, and reasoning behavior (`/mode full` grants broad access; high-impact Computer Use confirmations remain enforced) |
| `/config`, `/status`, `/doctor`, `/context` | Inspect configuration and runtime health |
| `/resume`, `/history`, `/export`, `/copy` | Work with sessions and output |
| `/rewind`, `/diff` | Inspect or restore file changes |
| `/permissions` | Inspect permission rules |
| `/skills`, `/agents`, `/hooks`, `/mcp` | Inspect extension registries |
| `/plugin`, `/marketplace` | Install and manage plugins |
| `/memory` | Inspect or edit project memory |
| `/workfriend` | Start the built-in work/mood check-in and persistent end-of-day companion |
| `/agent-team [open\|close]` | Open or close Agent Teams; no argument shows an interactive choice |

## Capabilities

- File and code tools: Read, Write, Edit, MultiEdit, Glob, Grep, Bash, and PowerShell
- Document conversion tools: MarkdownToPdf, WordToPdf, PdfToWord, and PdfToMarkdown. Each accepts workspace file paths, validates output signatures, supports timeouts and safe overwrite, and can use uploaded templates. Text templates support `{{content}}`, `{{title}}`, `{{source}}`, `{{date}}`, plus scalar values from `template_data`; DOCX/DOTX template merging currently uses Microsoft Word on Windows. LibreOffice is the cross-platform PDF-rendering fallback, and PDF extraction uses local Python packages such as `pdf2docx`, PyMuPDF, or pdfplumber.
- Web and external tools: WebFetch, WebSearch, `classic_words` (CNKGraph classical literature), MCP tools, and MCP resources
- Windows Computer Use: point-in-time target-window screenshots, UI Automation elements, single-action execution, Qwen perception routing, stale-snapshot rejection, and action-time safety confirmation
- Safe execution: allow/ask/deny rules, Plan Mode, Auto Mode, project trust, hooks, and shell sandboxing where supported. Full Mode (`/mode full`) intentionally bypasses the general permission rule engine; high-impact Computer Use confirmations, hooks, path validation, tool validation, and an enabled sandbox remain separate layers.
- Long-running work: TodoWrite, persistent task graphs, sub-agents, background runs, Git worktree isolation, and Agent Teams
- Built-in Workfriend: interactive work/mood intake, persistent one-hour-before-finish check-in, up to 10 contextual question cards, advice and encouragement, plus Word or Qwen voice delivery
- Context and continuity: session persistence, resume, compaction, token budgets, project memory, file checkpoints, and rewind
- Extensibility: skills, custom agents, slash commands, output styles, hooks, MCP servers, plugins, and static marketplaces
- Interfaces: interactive Ink UI, headless text/JSON/NDJSON output, images and screenshots, and multiple model protocols

## Upgrade and uninstall

Upgrade the global package, or re-run the installer:

```bash
npm install -g --ignore-scripts ccdagent@latest
```

Remove it with:

```bash
npm uninstall -g ccdagent
```

User configuration and sessions under `~/.ccagent/` are intentionally preserved when the npm package is removed.

## Troubleshooting

1. Run `ccagent --version` and confirm Node.js with `node --version`.
2. Run `/doctor` inside CCAGENT to inspect credentials, settings, MCP, plugins, sandbox support, and writable paths.
3. Run `/status` and `/config list` to verify the active model and configuration sources.
4. If a global install succeeds but `ccagent` is not found, add the npm global bin directory associated with `npm prefix -g` to `PATH`, then open a new shell.
5. Report reproducible problems through [GitHub Issues](https://github.com/lvye1989/ccagent/issues).

Never include API keys, `.env` contents, or private prompts in an issue.

## Architecture

CCAGENT keeps five runtime layers separate:

```text
Terminal UI
    ↓
QueryEngine (multi-turn orchestration)
    ↓
Agentic Loop (reason → tool → observe)
    ↓
Tools and permission enforcement
    ↓
Provider API and streaming adapters
```

Packaging is the delivery layer around those five runtime layers. The published npm package is a readable ESM bundle with a source map and no runtime dependency tree.

The implementation and tutorial snapshot series are complete through Stage 35. Stage 36 packages the CLI for distribution and completes the public documentation.

## Development

```bash
git clone https://github.com/lvye1989/ccagent.git
cd ccagent
npm install
cp .env.example .env
npm run dev
```

On Windows PowerShell, use `Copy-Item .env.example .env` instead of `cp`.
Before starting, open `.env` and set `DEEPSEEK_API_KEY`; see
[DeepSeek with `.env`](#deepseek-with-env) for the complete model setup.

Useful checks:

```bash
npm run typecheck
npm run build
npm run test:stage36
npm run verify:release
npm publish --dry-run
```

The main source lives under `src/`; milestone snapshots live under `step/`. Build output under `dist/` is generated and ignored by Git.

## Contributing

The project is still evolving quickly and is not accepting external pull requests yet. Issues with clear reproduction steps are welcome.

## License

[MIT](./LICENSE)
