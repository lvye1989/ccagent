# AGENT.md

This file provides guidance to AI agents when working with code in this repository.

## What this project is

CCAGENT is a **terminal-native agentic coding CLI** published as the `ccagent` npm package. It installs the `ccagent` command and the `ccagent` long alias.

- Runtime: Node 22+, ESM, strict TS, target ES2022, JSX `react-jsx`
- TUI: React 19 + Ink 7 (no web framework)
- Package manager: **npm** (`package-lock.json` is canonical — no pnpm/yarn/bun lockfiles)
- Single-package repo (no monorepo)

The code is organized into five broad layers:

1. **Interaction** — Ink/React terminal UI (`src/ui/`)
2. **Orchestration** — multi-turn session flow, slash commands, usage/state (`src/commands/`, `src/session/`, parts of `src/core/`)
3. **Agentic loop** — reason → tool call → observe (`src/core/`, `src/agents/`)
4. **Tooling** — file/shell/search/web/MCP/local tools with permissions and sandboxing (`src/tools/`, `src/permissions/`, `src/sandbox/`, `src/services/mcp/`)
5. **Model communication** — provider profiles and streaming LLM I/O over `llm-bridge` (`src/services/api/`)

The numbered roadmap is complete through **Stage 36**. The `ccagent` package is published on npm, and the post-publication registry cold check passes.

## Commands (the non-obvious ones)

There is **no** catch-all `npm test` and no lint/format script. Tests are smoke/characterization scripts wired directly in `package.json`; the release workflow runs the Stage 36 verification before publishing.

- **Typecheck:** `npm run typecheck` → `tsc --noEmit`
- **Build:** `npm run build` → `tsup` (outputs the bundled `dist/ccagent.js` + sourcemap)
- **Dev (no rebuild needed):** `npm run dev` → `tsx src/entrypoint/cli.ts`
- **Start built binary:** `npm start` → `node dist/ccagent.js`
- **Stage smokes:** `npm run test:stage20` … `test:stage36`
- **Release gate:** `npm run verify:release`
- **Domain smokes:** `test:queryengine`, `test:providerstream`, `test:notices`, `test:streaming`, `test:tasks`, `test:mcp`, `test:skills`, `test:sandbox`, `test:agents`, `test:filehistory`, `test:resilience`
- **Stage 24 sub-suites:** `test:stage24-md`, `…-clear`, `…-ui`, `…-ask`, `…-transcript`, `…-perm`, `…-stream`, `…-input`, `…-group`, `…-statusline`, `…-command`
- **Smoke aliases:** `npm run smoke:sandbox`, `npm run smoke:bash-sandbox`

For a smoke script not exposed as an npm script, run it directly with `npx tsx path/to/script.ts`.

### Script path inconsistency

Most `test:*` commands run files under `src/scripts/`, but **`test:stage30` is the exception**: it runs top-level `scripts/verify-multi-protocol.ts`. The top-level `scripts/` directory also contains `verify-*.ts` files that are not all wired to npm scripts; invoke them directly with `npx tsx scripts/verify-<name>.ts`.

## Gotchas

- **Two similar-looking config dirs are distinct:**
  - `.claude/` (`skills/`, `agents/`, `commands/`) — Claude Code integration config
  - `.ccagent/` (`skills/`, `agents/`, `commands/`, `settings.json`) — CCAGENT's own runtime config
  Do not merge them or move files between them.
- **`step/` is intentional tutorial code**, not a build artifact. It holds milestone snapshots (`step1.js` … `step35.js`) that mirror implementation stages; do not delete or clean it up.
- **`dist/` is generated and ignored by git**. Rebuilding with `npm run build` replaces it with the single-file release artifact and sourcemap.
- **Secrets/config caution:** `.env` and `.ccagent/settings.json` may contain local provider settings or secret-looking values. Do not copy token values into docs or output.
- **No `CONTRIBUTING.md`**; per the README, external contributions are not accepted yet, so conventions may shift.
- **Multi-provider model config** lives in user/project `settings.json`:
  - Anthropic provider names pass through directly
  - Other providers use `protocol` + `baseURL` + `${ENV_VAR}` interpolation for API keys
  - Relevant env vars: `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `QWEN_PROTOCOL`, `QWEN_MODEL`, `QWEN_BASE_URL`, `QWEN_API_KEY`, `DASHSCOPE_BASE_URL`, `DASHSCOPE_API_KEY`, `TAVILY_API_KEY`, `bocha_API_KEY`, `WEB_SEARCH_ADAPTER`, `CCAGENT_OFFICE_ENGINE`, `CCAGENT_PYTHON`, `CCAGENT_POWERSHELL`, `CCAGENT_LIBREOFFICE`
- **Windows Computer Use** is implemented as native `ComputerObserve` and `ComputerAction` tools. Keep the exact-window, one-action-then-reobserve loop and the high-impact confirmation floor; do not route it through MCP or a runtime skill.
- **Notable CLI flags:** `--print` (headless JSON output), `--plan`, `--auto`, `--permission-mode full`, `--dump-system-prompt`, `--model <name-or-profile>`.
