# Changelog

All notable changes to CCAGENT are documented in this file.

## [Unreleased]

### Added

- Added `ccagent init`, an interactive first-run setup that creates private
  user-level environment and settings files, safely preserves existing
  configuration, and verifies DeepSeek text plus optional Qwen vision and
  OpenRouter Jev Decisions access.
- Added an OpenRouter `~typesafe/jev-latest` typed decision gate for Windows
  Computer Use. It cross-checks LLM-proposed actions against the fresh UI
  snapshot, can upgrade risk or request re-observation/confirmation, and can
  replace the slower general Auto Mode classifier for confident ordinary
  actions without weakening deterministic safety rules.
- Added `WorkfriendAssess`, which uses Jev typed score/choice decisions for
  non-clinical 0-4 workplace mood-strain and stress-load scoring, work-state
  classification, and next-action selection. Decision mode delegates the
  primary action to Jev while retaining a deterministic urgent-human-support
  safety floor and explicit permission for external wellbeing-text transfer.

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
