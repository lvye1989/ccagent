# Changelog

All notable changes to CCAGENT are documented in this file.

## [Unreleased]

### Security

- Gate project/local model profiles and environment injection on explicit project
  trust, before CLI extension bootstrap. Prevent untrusted repositories from
  redirecting trusted provider credentials or selecting a different dotenv file.
  Pin user credential paths and protect home/trust identity, Node loaders and TLS
  policy from project env. Reloads remove revoked project values. Added 15 offline
  credential-routing regression checks to the release gate.
- Updated compatible transitive dependencies to resolve six npm audit findings,
  including all three high-severity advisories. A low-severity Windows esbuild
  development-server advisory remains under tsup; see the 2026-09-21 audit report.

### Added

- Added native per-agent Open/Close controls to `/agents`, including paginated
  selection, direct commands and user-wide `agentStates` persistence. Closed
  definitions stay installed but are hidden from model discovery and rejected
  before new foreground/background/team execution. Existing runs finish safely;
  Workfriend shortcuts and pending check-ins pause while closed and resume on Open.

- Added `/agent-skill` with local Open/Close question cards and direct commands.
  The user-wide `agentSkills` preference persists across restarts, disables skill
  discovery/invocation/conditional activation without deleting installed files,
  and leaves agents, MCP servers and ordinary tools independent.

- Added default-on `RhinoSequence`: bounded Jev-driven step continuation with
  automatic native observation/verification, actual GUID bindings, replay-safe
  receipts and per-step latency reports. Every leaf retains central permissions
  and hooks; uncertain decisions stop, and high-impact operations stay outside
  the fast lane. Added offline safety and opt-in real read-only acceptance tests.

- Rhino projects now default to unique Desktop folders with colocated models,
  previews, safety snapshots and reports. Export destinations are normalized
  before permission checks and cannot escape into the application checkout.
- Fixed read-only inspection capability lookup, blocked dialog-based non-3dm
  exports before execution, and preserved full-document settings in 3dm copies.

- Added built-in `rhino_agent` task finalization with deterministic cleanup of
  tracked bridge scratch files and unneeded intermediate captures. Final previews,
  referenced captures, models, exports, GH definitions and safety snapshots are
  retained. Failed/interrupted tasks preserve diagnostic captures; uncertain live
  bridge jobs, edited files, links and unknown files are not deleted. Cleanup
  counts and private audit paths are appended to the agent result.

- Added a paginated `/mcp` server picker with per-server Open/Close controls,
  user-wide persistence, plugin support, immediate tool removal, and cancellation
  of pending connections/OAuth. Background discovery no longer opens a browser;
  `/mcp auth <name>` explicitly starts cancellable browser consent. Existing
  credentials are retained on Close, and stale tool adapters cannot execute.

- Added opt-in installation of all eight official Google Workspace remote MCP
  servers during `ccagent init`, with environment-backed OAuth credentials,
  loopback browser authorization, private token persistence, refresh support,
  and one-time retry of the challenged MCP request.

- Added `ccagent init`, an interactive first-run setup that creates private
  user-level environment and settings files, safely preserves existing
  configuration, and verifies DeepSeek text plus optional Qwen vision and
  OpenRouter Jev Decisions access.
- Added an OpenRouter `~typesafe/jev-latest` typed decision gate for Windows
  Computer Use. It cross-checks LLM-proposed actions against the fresh UI
  snapshot, can upgrade risk or request re-observation/confirmation, and can
  replace the slower general Auto Mode classifier for confident ordinary
  actions without weakening deterministic safety rules.
- Added `ComputerNavigate`, a Jev-directed loop limited to five reversible
  navigation inputs with mandatory observation after every step and no click,
  typing, submission, upload, installation, deletion, or account actions.
- Added a secret-redacted Jev classifier for non-read-only Auto Mode tools and
  Jev relevance/source-quality reranking for multi-result web searches. Both
  fail safely to the existing classifier or original search order.
- Computer and general tool traces now distinguish the raw Jev answer, applied
  gate, and final permission outcome.
- Added a default-on Windows Computer Use control indicator: a topmost,
  click-through warning banner plus a highlighted pointer graphic appears only
  while real input is being sent and is removed on success or failure.
- Added `WorkfriendAssess`, which uses Jev typed score/choice decisions for
  non-clinical 0-4 workplace mood-strain and stress-load scoring, work-state
  classification, and next-action selection. Decision mode delegates the
  primary action to Jev while retaining a deterministic urgent-human-support
  safety floor and explicit permission for external wellbeing-text transfer.
- Added the built-in `rhino_agent` for Rhino 8 on Windows, with structured
  RhinoCommon observation and allowlisted modeling actions, fresh GUID-based
  snapshots, one-record Undo behavior, Jev route/target/parameter validation,
  confirmation floors for destructive or external effects, and bounded
  Computer Use fallback for unsupported UI and plug-in surfaces.

### Fixed

- Routed `classic_words.author_writings` through the JSON writing-search API,
  added full-name person search, and fall back from a failed alias/surname
  lookup to `person_scope=Name`.
- Defaulted Qwen Computer Use perception to the DashScope-compatible
  `openai-chat` protocol instead of accepting a zero-token Responses result.

## [0.1.2] - 2026-09-20

### Added

- Canonical `.env` configuration for the DeepSeek API key, including a
  cross-directory `CCAGENT_ENV_FILE` pointer and regression coverage.
- `.env.example` in the published npm package.

### Changed

- Updated package metadata and documentation for the
  `lvye1989/ccagent` repository.
- Renamed the npm package to `ccdagent` while retaining `ccagent` as the
  installed terminal command, enabling direct global installation with
  `npm install -g ccdagent`.

## [0.1.1] - 2026-09-04

### Changed

- Updated the public project status after the first npm publication and registry cold-cache verification.

## [0.1.0] - 2026-08-15

### Added

- First npm-distributable CCAGENT CLI release.
- Single-file ESM bundle with source maps and no runtime dependency tree.
- Node.js 22 runtime gate, npm package boundary checks, and release verification.
- npm-backed macOS/Linux installer and provenance-enabled tag release workflow.

### Changed

- The npm package and primary command are named `ccagent`.
- `ccagent` is installed as the long command alias.
- The former development-only `agent` command is no longer registered because it is ambiguous and collision-prone.
