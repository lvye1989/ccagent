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
`~/.ccagent/settings.json` for the current account, prompts for DeepSeek,
optional Qwen vision/Jev access, and whether to install the complete official
Google Workspace MCP suite. It performs the configured model connection tests.
API keys and Google OAuth credentials are stored only in the private `.env`,
never in `settings.json`. Re-running the command preserves unrelated existing
configuration. Use
`ccagent init --skip-test` when setup must be completed offline.

### Official Google Workspace MCP suite

Google's official Workspace remote MCP servers are currently a Developer
Preview. During `ccagent init`, answer yes to install all eight Streamable HTTP
servers: Gmail, Drive, Docs, Sheets, Slides, Calendar, Chat, and People. This
adds remote server definitions; it does not install a third-party npm MCP
package.

Before use, join the Google Workspace Developer Preview Program, enable the
eight corresponding APIs in a Google Cloud project, configure the OAuth consent
screen, and create an OAuth 2.0 Web client. Register the exact callback shown by
the initializer (default:
`http://127.0.0.1:53682/oauth/callback`). Store its client ID and secret through
the hidden initializer prompts. Use `/mcp auth google-gmail` (or another server
name) to explicitly open Google's consent page; startup, tool discovery, and
ordinary tool calls never start browser consent. Tokens are kept under `~/.ccagent/oauth/google-workspace`
and are never written to `settings.json`.

### Per-server MCP Open / Close

In CCAGENT, enter `/mcp`, select a server, then choose **Open** or **Close**.
The server list is paginated; arrow keys and Enter select, Esc cancels. These
controls cover configured stdio, HTTP, SSE, and plugin-provided MCP servers.

```text
/mcp list
/mcp google-gmail
/mcp close google-gmail
/mcp open google-gmail
/mcp auth google-gmail
/mcp tools google-gmail
/mcp reconnect google-gmail
```

Open/Close is persisted in the current user's `~/.ccagent/settings.json` and
applied immediately in this process. Close cancels connections, pending OAuth,
and in-flight requests and removes the server's tools without deleting its
configuration or tokens. It cannot undo operations already accepted by the
remote server. Other running CCAGENT processes must be restarted to pick up
the saved preference. Reconnect and plugin reload do not override Close.

```json
{
  "mcpServerStates": {
    "google-gmail": "close",
    "plugin:example:server": "open"
  }
}
```

Individual server definitions also accept `"enabled": false`. User-wide
switches take precedence except for managed-policy disables; they do not
bypass project trust or `.mcp.json` approval. Open only starts a background
connection. If consent is needed, use `/mcp auth <name>` explicitly; it runs
in the background and `/mcp close <name>` cancels it. Valid saved refresh tokens
can still refresh silently. Built-in Rhino/Computer Use tools are not MCP
servers and are not affected by this menu.

Official setup guide:
[Configure the Google Workspace MCP servers](https://developers.google.com/workspace/guides/configure-mcp-servers).

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

Without a canonical path, `.env` is loaded from the launch directory only after
you explicitly trust that project. It is ignored by Git. Never commit a populated `.env`. An empty
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

Project/local `env` and model profiles are ignored until project trust is granted.
The interactive CLI asks before loading those settings; `--print` never grants
trust implicitly. User settings and an explicit canonical env file still work
from untrusted directories. Projects cannot replace `CCAGENT_ENV_FILE`, the user
home/trust store, Node loaders or TLS verification settings. A relative env path
in user settings resolves beside that settings file, not against the project.

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

Select a profile with `ccagent --model deepseek` or `/model deepseek` inside
the REPL. `defaultModel` makes that profile the default when no explicit model
is selected.

`contextWindow` is the provider's total input/output token capacity. CCAGENT
uses it for warnings and automatic compaction; it does not invent extra model
capacity. The bundled `deepseek-flash` profile uses `1048576` (1 Mi tokens).
For a custom gateway or local model, set the value advertised by that provider.
`CCAGENT_MAX_CONTEXT_TOKENS` remains available as a process-wide override.

CCAGENT automatically micro-compacts old tool output and summarizes history
before the active profile reaches its limit, including while a multi-step tool
loop is running. `/compact [focus]` remains available when you want an earlier
manual summary, and `/context` shows the resolved window and current estimate.

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
| `CCAGENT_MAX_CONTEXT_TOKENS` | Optional process-wide context-window override; per-profile `contextWindow` is preferred |
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
| `GOOGLE_MCP_CLIENT_ID` | OAuth 2.0 Web client ID used by the official Google Workspace MCP servers; written to the private `.env` by `ccagent init` |
| `GOOGLE_MCP_CLIENT_SECRET` | OAuth client secret for Google Workspace MCP; never stored in `settings.json` |
| `QWEN_PROTOCOL` | Optional Computer Use perception protocol; the verified DashScope default is `openai-chat`, with `openai-responses` and `gemini` also supported |
| `QWEN_MODEL` | Qwen/vision model used to interpret Computer Use screenshots |
| `DASHSCOPE_BASE_URL` / `QWEN_BASE_URL` | DashScope or compatible Qwen endpoint for screenshot perception |
| `DASHSCOPE_API_KEY` / `QWEN_API_KEY` | API key for the Computer Use perception model |
| `OPENROUTER_API_KEY` | OpenRouter key for Jev decisions in Computer Use, Rhino, Auto Mode, search, and Workfriend; stored in the selected private `.env` |
| `CCAGENT_COMPUTER_USE_JEV` | Enable the Jev gate when an OpenRouter key is available; defaults to enabled |
| `CCAGENT_COMPUTER_USE_INDICATOR` | Show the topmost control banner and highlighted mouse pointer while input is being sent; defaults to enabled |
| `CCAGENT_COMPUTER_USE_INDICATOR_HOLD_MS` | Post-action indicator duration from `250` to `3000` ms; defaults to `650` |
| `CCAGENT_TOOL_JEV` | Use Jev before the general LLM classifier for non-read-only Auto Mode tools; defaults to enabled when a key exists |
| `JEV_TOOL_MODE` | General tool-decision mode: `enforce` (default), `shadow`, or `off` |
| `CCAGENT_SEARCH_JEV` | Rerank multi-result `WebSearch` output by query relevance and source quality; defaults to enabled when a key exists |
| `CCAGENT_WORKFRIEND_JEV` | Enable Jev mood/stress assessment in Workfriend; defaults to enabled |
| `CCAGENT_RHINO_JEV` | Enable Jev route/target/parameter/progress validation for `RhinoAction`; defaults to enabled when an OpenRouter key exists |
| `CCAGENT_RHINO_JEV_MODE` | Rhino-specific `enforce` (default), `shadow`, or `off` mode |
| `CCAGENT_RHINO_JEV_MIN_CONFIDENCE` | Minimum confidence for a Rhino route decision; defaults to `0.8` |
| `CCAGENT_RHINO_PROGID` | Windows COM ProgID for attaching to the running Rhino instance; defaults to `Rhino.Interface.8` |
| `CCAGENT_RHINO_TIMEOUT_MS` | RhinoCommon bridge timeout from `5000` to `300000` ms; defaults to `60000` |
| `CCAGENT_RHINO_AUTO_CLEANUP` | Defaults to `1`: clean tracked intermediate captures when the built-in Rhino task succeeds; `0` retains captures for debugging |
| `CCAGENT_RHINO_KEEP_CAPTURES` | Keep the latest `1-20` viewport captures per successful task (default `1`), plus every capture referenced in the final response |
| `CCAGENT_JEV_MODE` | `enforce` (default), `shadow`, or `off` |
| `WORKFRIEND_JEV_MODE` | `decision` (Jev chooses the primary action, default), `advisory` (scores only), or `off` |
| `JEV_MODEL` | OpenRouter Decisions model; defaults to `~typesafe/jev-latest` |
| `JEV_BASE_URL` | Optional official OpenRouter Decisions endpoint override; defaults to `https://openrouter.ai/api/alpha/decisions` |
| `JEV_TIMEOUT_MS` / `JEV_MIN_CONFIDENCE` | Optional timeout and enforcement-confidence threshold; defaults to `5000` and `0.8` |
| `QWEN_TTS_MODEL` | Workfriend voice-delivery model; defaults to `qwen-audio-3.1-tts-flash` |
| `QWEN_TTS_VOICE` | Optional Workfriend voice id; defaults to `longanhuan_v3.1` |
| `DASHSCOPE_TTS_URL` | Optional full Qwen-Audio-TTS endpoint; otherwise derived from `DASHSCOPE_BASE_URL` |
| `CCAGENT_OFFICE_ENGINE` | Optional office renderer preference: `word` or `libreoffice` |
| `CCAGENT_PYTHON` | Optional Python 3 executable for PDF conversion helpers |
| `CCAGENT_POWERSHELL` | Optional PowerShell executable for Microsoft Word automation |
| `CCAGENT_LIBREOFFICE` | Optional LibreOffice/soffice executable for cross-platform PDF rendering |

`WebSearch` calls Tavily and Bocha through their REST APIs directly; neither integration uses a Skill or MCP. Tavily remains the preferred configured provider, while Bocha supplements it on errors or empty results and can be selected explicitly with `provider: "bocha"`. Without either key, CCAGENT falls back to Anthropic server-side search (for first-party Anthropic profiles) or Bing. When Jev is configured and at least two results are present, one batched typed decision reranks them by query relevance and source quality; failure preserves the provider's original order.

In Auto Mode, Jev now handles the narrow allow-versus-confirm decision for non-read-only tools before the general-purpose LLM classifier. It receives a bounded, secret-redacted summary of the recent user intent and proposed tool call; file bodies, prompts, passwords, tokens, and API keys are withheld. Confident, scoped local work can proceed directly, while destructive, external, credential, installation, system, broad, or uncertain operations still require confirmation. Deterministic deny rules, path/tool validation, hooks, sandboxing, and action-specific confirmation floors run independently and cannot be weakened by Jev. Open-ended planning and sub-agent routing remain with the main LLM.

Shell commands receive a private per-process temporary directory at `~/.ccagent/tmp/process-<pid>` through `TEMP`, `TMP`, `TMPDIR`, and `CCAGENT_TMPDIR`. Files created there—such as Word content checks produced by PowerShell—can be consumed by `Read`, `Grep`, or `Glob` without granting those tools access to the entire operating-system temp directory.

`classic_words` is a built-in, read-only CNKGraph REST tool rather than a Skill or MCP integration. It needs no API key and supports poetry/prose search, exact works, author collections, rhymes, couplets, tonal patterns, ancient books and volumes, allusions, and historical people. It validates inputs and JSON responses, limits large results, isolates HTTP failures, and applies a configurable timeout. CNKGraph's open resources are intended for research and learning; confirm authorization before commercial use.

For author collections, `author_writings` is normalized through CNKGraph's JSON
writing-search endpoint because the legacy author URL returns CSV. For people,
use `person_scope: "Name"` with a full name and `person_scope: "Xing"` with a
surname; a 404 from a non-name scope is retried as a full-name lookup.

### Built-in Workfriend

Run `/workfriend` in the interactive REPL to start the built-in work companion. It first asks what you are working on, how work has felt recently, your current work pressure, and your local workday end time through interactive cards. It then stores a private reminder under `~/.ccagent/workfriend/` and checks in about one hour before the workday ends. If CCAGENT is closed at that time, the pending reminder is restored on the next launch.

After the initial intake and again after the end-of-day questionnaire, Workfriend calls OpenRouter Jev to score mood strain and stress load from `0-4`, classify the work state, and choose the next action. In `WORKFRIEND_JEV_MODE=decision`, Jev's action is the primary plan while the main LLM explains and personalizes it; `advisory` uses the scores without delegating the action. These are non-clinical workplace-reflection scores, not mental-health diagnoses. Explicit immediate-danger or self-harm signals trigger a deterministic urgent-human-support floor that no model can downgrade.

Only the work, mood, stress, progress, and bottleneck summaries supplied to `WorkfriendAssess` are sent to OpenRouter—not hidden conversation history, credentials, or the complete questionnaire. Because this is an external transfer of private wellbeing text, the tool requires fresh confirmation even in Full Mode. The reminder persists only a concise score/action summary. The later check-in still uses no more than 10 card questions. You then choose an editable `.docx` or a Qwen-generated `.wav`. Word delivery is dependency-free; voice delivery sends the final text to DashScope and requires `DASHSCOPE_API_KEY` (or `QWEN_API_KEY`).

### Built-in Rhino agent

The common toolkit now covers curves, surfaces, solids, meshes, SubD, copies/arrays, and object/layer/group management, plus read-only `RhinoInspect`. See the [Rhino / Grasshopper toolkit guide](rhino/TOOLKIT.md) for **67 new sub-operations**, typed Grasshopper data trees, solving, output inspection and selected-output baking. These are implemented core modeling capabilities, not unrestricted access to every Rhino command or third-party plugin.

Ask CCAGENT to use `rhino_agent` for Rhino 8 modeling. The built-in agent follows an **80% RhinoCommon / 20% Computer Use** strategy:

- `RhinoObserve` attaches to the running Rhino 8 instance without launching it and returns the active document name, units and tolerances, layers, current selection, object GUID/type/bounding boxes, current command state, and undo state.
- `RhinoAction` accepts `create_geometry`, `transform`, `extrude`, `loft`, `curtain_wall`, `set_view`, `boolean`, `set_layer`, `set_material`, `run_grasshopper`, `import_export`, and `undo`. It rejects unknown fields and never accepts a Rhino command, macro, or executable script string.
- `loft` accepts ordered curve GUIDs or numerical `sections:[{z,width,depth},...]`, with `corner_ratio`, `concavity`, `crown_dip`, layer and name. Use `cap:false` for a nonplanar crown. `expected_units` stops mismatched document units before modeling.
- `curtain_wall` generates glass, mullions, transoms, spandrels and mechanical bands on a numerical-section loft. `floors` and `bays_per_side` control up to 30000 panels, grouped into a few editable mesh objects while retaining the NURBS source. This is an architectural appearance model, not fabrication detailing.
- `set_view` fits target GUIDs and sets projection/display mode. Optional `portrait:true` creates/reuses a presentation viewport; `isolate:true` hides other objects without deleting them (restore with Show and the affected layer visibility toggles). `RhinoObserve(capture:true)` saves a native viewport PNG and returns `capture_path` without requiring a perception service. `.3dm` export accepts `target_guids` and writes those objects with layers/materials without format dialogs.
- Every action requires a `RhinoObserve` id no more than 60 seconds old. Before mutation, the fixed RhinoCommon bridge saves object GUIDs, parameters, document state, and bounding boxes under the project folder's `snapshots/`; each `RhinoAction` runs as one Rhino script-command Undo Record (with an explicit `BeginUndoRecord` fallback for non-command hosts). Export is snapshotted and confirmed but cannot be undone inside Rhino.
- Jev returns `route`, `next_action`, `parameters_valid`, `destructive`, and `expected_progress`; `target_valid` is checked only for existing-object operations. Invalid parameters request correction instead of repeated observation. Failed/timed-out actions invalidate the observation. Jev can allow a high-confidence ordinary Rhino API action in Auto Mode, require another observation, redirect to bounded Computer Use, or request user review. It cannot execute or substitute an action.
- Object deletion, any `delete_inputs:true`, deleting empty layers, exporting/overwriting files, and loading third-party `.gh`/`.ghx` definitions always require fresh confirmation, including in Full Mode. Even GH `inspect` needs approval: deserialization may run third-party component code, and blocking model-supplied scripts is not a sandbox. If Jev is unavailable, Rhino changes fall back to manual confirmation.

The direct bridge currently targets **Rhino 8 on Windows** and uses the installed `Rhino.Interface.8` COM automation entry point to attach to the running application and execute the packaged, fixed `rhino/ccagent_rhino_runner.py` inside Rhino. Open Rhino and wait for it to finish loading before starting `rhino_agent`; CCAGENT checks for a running process before creating the Interface object, so a read-only observation does not launch Rhino. If multiple Rhino instances are open, Rhino's COM Interface cannot predetermine which instance it will attach to; keep only the intended instance open.

#### Jev fast dispatch

The built-in `rhino_agent` prefers `RhinoSequence` for known ordinary multi-step
work. The LLM proposes 1–8 structured steps once; Jev decides each exact step,
and the runtime observes, runs the central permission/hooks path, executes and
verifies without intermediate LLM turns. `targets_from` binds actual GUIDs
created by an earlier step. Inspections can also be batched.

Enabled by default with a configured OpenRouter key and Jev `enforce`; set
`CCAGENT_RHINO_FAST=0` to disable. Export/import, deletion, overwrite, booleans,
undo and third-party GH are excluded and retain ordinary confirmation.
Missing/low-confidence evidence, stale observations, document changes or tool
errors stop the sequence for LLM/user review. No automatic mutation retries or
rollback; after 90 seconds no further step starts. A `plan_id` is executed only
once within an agent session, even on partial failure. Receipts distinguish
completed, executed and uncertain steps and persist under project `reports/`.

Run `npm run test:rhino-fast` for offline safety checks. The opt-in
`npm run test:rhino-fast-live` uses real LLM/Jev/native calls for read-only tower
inspections; its timing is not a guarantee for complex modeling workloads.

#### Rhino project outputs and automatic cleanup

Each built-in task creates a unique folder under the current user's
`Desktop/CCAGENT-Rhino/`, independent of the launch/installation directory.
Models, `previews/`, `snapshots/`, and `reports/` stay together; `RhinoObserve`
returns `project_directory`. Relative exports such as `models/tower.3dm` resolve
there **before** the permission prompt. Import/GH input paths still use the original cwd.
Optionally set absolute `CCAGENT_RHINO_OUTPUT_ROOT` to change the parent folder,
or `CCAGENT_RHINO_PROJECT_DIR` to continue an existing dedicated project.
The repository, drive/home/Desktop roots, path traversal and linked destinations
are rejected. Complete `.3dm` copies preserve document settings, groups, layer
states, materials and user data without changing the open document's path.
Other export formats require a separately confirmed Computer Use step; the API
refuses them before opening a blocking format dialog. Export/overwrite still
requires confirmation; task finalization never silently saves a model.

The built-in `rhino_agent` now finalizes tracked files automatically, without an
LLM choosing arbitrary paths to delete. After a successful task, it deletes
unneeded intermediate viewport captures and retains the last preview plus any
capture linked or named in its final response. A failed, interrupted, or
turn-limited task retains captures for diagnosis. Set `CCAGENT_RHINO_AUTO_CLEANUP=0`
to retain all captures, or `CCAGENT_RHINO_KEEP_CAPTURES=2` to retain two recent previews.

Bridge `job.json`, `result.json`, and generated wrappers are cleaned after
confirmed completion, with a retry at task end. Killing the PowerShell caller
does not prove Rhino stopped: unconfirmed jobs are retained. Models, exports
(including OBJ/MTL/textures and zero-byte failed exports), plans, Grasshopper
definitions, safety snapshots, old sessions, and unknown project files are never
auto-deleted. Edited files, links/junctions, and non-empty unexpected directories
are preserved. Cleanup never removes Rhino geometry or uses shell deletion.

The runtime appends actual removal counts and a private audit path under
the project folder's `reports/cleanup/` to the final response. Deleted temporary files are not
recoverable from the recycle bin. Existing untracked leftovers are deliberately
not swept. Restart a running CCAGENT process to load this feature; no npm release
is required when the global command points to the local checkout.

### Agent Teams default and switch

Individual agent availability is separate from Agent Teams. Run `/agents` to select any built-in, custom or plugin agent, then choose **Open** or **Close**. More than three definitions use a paginated picker. `/agents list` shows all states; `/agents rhino_agent` opens its state card; `/agents close rhino_agent` and `/agents open rhino_agent` change it directly. Names are exact, including `Explore` and plugin namespaces. The local controls need no model/API call.

All agents default to Open. Choices persist by name under `agentStates` in user `~/.ccagent/settings.json`, e.g. `{"rhino_agent":"close","workfriend":"open"}`. Close removes the definition from model discovery and rejects new foreground/background/team invocations, including Full mode. Reloading plugins or project overrides cannot reopen it. Definitions and existing results are retained; already-started tasks finish normally, so use task cancellation separately if needed. Closing an agent does not disable its underlying ordinary tools, Skills, MCP or Agent Teams. Closing `workfriend` also blocks `/workfriend` and holds pending check-ins; Open resumes them. Existing conversation content is not erased.

Agent Teams is open by default, so `TeamCreate`, `SendMessage`, and `TeamDelete` are available without a startup flag. Run `/agent-team` to choose **Open** or **Close** in an interactive card. You can also run `/agent-team open` or `/agent-team close` directly. The choice is applied immediately and persisted as `agentTeams` in `~/.ccagent/settings.json`.

CCAGENT refuses to close Agent Teams while a team is active; finish the teammates and run `TeamDelete` first. For one-process overrides, `--agent-teams`, `--no-agent-teams`, and the legacy `CCAGENT_TEAMS=1|0` variable remain supported and take precedence over the saved preference.

Skills are also open by default. Run `/agent-skill` to choose **Open** or **Close** in a local card (no model/API call), or use `/agent-skill open`, `/agent-skill close`, and `/agent-skill status`. The user-wide `agentSkills` boolean in `~/.ccagent/settings.json` is saved for future starts and applies immediately to subsequent invocations. Close removes skill discovery/completions and the `Skill` tool, blocks `/<skill-name>`, and pauses conditional activation, including plugin skills. Installed files remain available for reopening; `/skills reload` does not reopen Skills. Agents (including `rhino_agent`), Agent Teams, MCP servers, ordinary tools and user-defined prompt commands have independent controls. Close does not erase prior conversation content, undo completed work, or revoke permissions already granted in this session; use `/clear` or start a new session if you need a fresh context.

### Windows Computer Use

`ComputerObserve`, `ComputerAction`, and `ComputerNavigate` provide a built-in, non-MCP desktop-control loop on Windows:

1. `ComputerObserve(action="list_windows")` lists eligible top-level windows.
2. `ComputerObserve(action="observe", window_id="...")` captures only the selected window and returns a screenshot, accessibility tree, and single-use `snapshot_id`.
3. `ComputerAction` performs exactly one action against that fresh snapshot, then immediately observes again and returns the next snapshot.
4. `ComputerNavigate` lets Jev choose up to five reversible navigation steps (`Escape`, paging, `Home`/`End`, bounded scrolling, or wait). It re-observes after every input and stops on success, ambiguity, prompt-injection risk, a changed window, Jev failure, or the step limit. It cannot click, type, submit, upload, install, delete, or change accounts.

Immediately before CCAGENT sends real mouse or keyboard input, Windows shows a topmost **“CCAGENT 正在控制电脑”** banner and a red/orange pointer halo. The overlay is click-through, does not take keyboard focus, follows the pointer, and is always removed after the action or an error. It appears only after the target window and snapshot size pass their final checks, so a rejected action does not falsely claim control. Set `CCAGENT_COMPUTER_USE_INDICATOR=0` only for unattended/headless environments.

The recommended pairing is DeepSeek as the main reasoning/text model and Qwen as a perception-only model. Configure the `QWEN_*`/`DASHSCOPE_*` variables above, or point `modelRoles.computerUse` (also accepts `computer_use`, `vision`, `image`, or `multimodal`) at a declared model profile. In automatic delivery mode, a successful Qwen description is returned to DeepSeek without attaching the screenshot to the DeepSeek turn.

When `OPENROUTER_API_KEY` is configured, CCAGENT adds Jev as a typed decision gate between the LLM-proposed `ComputerAction` and the permission/execution path. It calls OpenRouter's Decisions API with `~typesafe/jev-latest`, batches target validity, goal alignment, prompt-injection, disposition, and risk questions, and sends text/structured state only—never the screenshot or the text being typed. Jev can raise but never lower the LLM-declared risk. A confident ordinary decision avoids a second general-purpose Auto Mode classifier call; uncertainty, high-impact classification, or disagreement falls back to re-observation, existing permission prompts, or the normal LLM classifier. Each executed result records both the Jev gate and `final_permission`, so `execute` in the raw answer is no longer confused with final authorization. Every request requires ZDR and denies provider data collection. Use `CCAGENT_JEV_MODE=shadow` to observe decisions without enforcement.

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
| `/skills`, `/hooks`, `/mcp` | Inspect extension registries |
| `/agents [list\|<name>\|open <name>\|close <name>]` | Inspect all agents or choose each agent's Open/Close state |
| `/plugin`, `/marketplace` | Install and manage plugins |
| `/memory` | Inspect or edit project memory |
| `/workfriend` | Start the built-in work/mood check-in and persistent end-of-day companion |
| `/agent-team [open\|close]` | Open or close Agent Teams; no argument shows an interactive choice |
| `/agent-skill [open\|close\|status]` | Open or close Skills; no argument shows a local interactive choice |

## Capabilities

- File and code tools: Read, Write, Edit, MultiEdit, Glob, Grep, Bash, and PowerShell
- Document conversion tools: MarkdownToPdf, WordToPdf, PdfToWord, and PdfToMarkdown. Each accepts workspace file paths, validates output signatures, supports timeouts and safe overwrite, and can use uploaded templates. Text templates support `{{content}}`, `{{title}}`, `{{source}}`, `{{date}}`, plus scalar values from `template_data`; DOCX/DOTX template merging currently uses Microsoft Word on Windows. LibreOffice is the cross-platform PDF-rendering fallback, and PDF extraction uses local Python packages such as `pdf2docx`, PyMuPDF, or pdfplumber.
- Web and external tools: WebFetch, Jev-ranked WebSearch, `classic_words` (CNKGraph classical literature), MCP tools, and MCP resources
- Windows Computer Use: point-in-time target-window screenshots, UI Automation elements, single-action execution, bounded Jev navigation, Qwen perception routing, OpenRouter Jev typed preflight decisions, stale-snapshot rejection, and action-time safety confirmation
- Safe execution: allow/ask/deny rules, Plan Mode, Auto Mode, project trust, hooks, and shell sandboxing where supported. Full Mode (`/mode full`) intentionally bypasses the general permission rule engine; high-impact Computer Use confirmations, hooks, path validation, tool validation, and an enabled sandbox remain separate layers.
- Long-running work: TodoWrite, persistent task graphs, sub-agents, background runs, Git worktree isolation, and Agent Teams
- Built-in Workfriend: interactive work/mood intake, Jev 0-4 mood/stress scoring and next-action decisions, persistent one-hour-before-finish check-in, up to 10 contextual question cards, advice and encouragement, plus Word or Qwen voice delivery
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
