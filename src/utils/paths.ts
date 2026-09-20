/**
 * Single source of truth for every CCAGENT on-disk path.
 *
 * Why this exists:
 *   The `~/.ccagent/` directory layout used to be re-derived in 9
 *   different files (taskStore, plans, memdir, session storage, MCP config,
 *   permission settings, AGENT.md loader, stream debug, …). Every refactor
 *   risked typo-ing the directory name (`.ccagent` vs `.agent`) or
 *   computing the home dir slightly differently (`os.homedir()` vs
 *   `process.env.HOME || "~"`, the latter producing a literal `~` string
 *   when HOME was unset).
 *
 *   This module centralizes ALL of those paths — both the global
 *   `~/.ccagent/...` family AND the per-project `<cwd>/.ccagent/...`
 *   family. Callers should NEVER recompute these paths inline; doing so
 *   defeats the purpose and reintroduces the drift this file was created
 *   to prevent.
 *
 * Layout:
 *
 *   Global (per-user, machine-wide):
 *     ~/.ccagent/
 *     ├── settings.json         ← user-scope settings (perms, mcpServers, ...)
 *     ├── AGENT.md              ← user-scope memory loaded into system prompt
 *     ├── tasks/                ← Task V2 persisted task graphs (per session)
 *     ├── plans/                ← Plan-mode plan files
 *     ├── projects/             ← per-cwd memory + session JSONL transcripts
 *     └── stream-debug.log      ← opt-in raw SSE log
 *
 *   Project (per-cwd, repo-local):
 *     <cwd>/.ccagent/
 *     └── settings.json         ← project-scope overrides (perms, mcpServers)
 *
 * Path resolution rules:
 *   - `CCAGENT_HOME` is an explicit full-directory override for tests and
 *     portable installs.
 *   - Otherwise global paths use `os.homedir()`. A deliberately overridden
 *     `HOME` that differs from `os.homedir()` is honored for hermetic test
 *     harnesses; the ordinary Windows `HOME` value does not change behavior.
 *   - All path joins go through `node:path` so platform separators are
 *     handled correctly.
 *   - These functions are PURE — they don't read or create anything on
 *     disk. Callers that want the directory to exist must `mkdir -p` it
 *     themselves (none of these helpers eagerly mkdir, to keep them
 *     side-effect-free for tests).
 */

import * as os from "node:os";
import * as path from "node:path";

const DIR_NAME = ".ccagent";
const SETTINGS_FILE = "settings.json";
const LOCAL_SETTINGS_FILE = "settings.local.json";
const STATE_FILE = "state.json";

// ─── Global (~/.ccagent/...) ──────────────────────────────────────

/** Returns `~/.ccagent`. */
export function getCCAgentHome(): string {
  const explicit = process.env.CCAGENT_HOME?.trim();
  if (explicit) return path.resolve(explicit);

  const systemHome = os.homedir();
  const environmentHome = process.env.HOME?.trim();
  const base =
    environmentHome && path.resolve(environmentHome) !== path.resolve(systemHome)
      ? environmentHome
      : systemHome;
  return path.join(base, DIR_NAME);
}

/** Returns `~/.ccagent/<name>` — for any subdirectory or file by name. */
export function getCCAgentPath(...segments: string[]): string {
  return path.join(getCCAgentHome(), ...segments);
}

/** Returns `~/.ccagent/settings.json`. */
export function getUserSettingsPath(): string {
  return getCCAgentPath(SETTINGS_FILE);
}

/**
 * Returns `~/.ccagent/state.json` — the machine-level State store
 * (project trust + per-machine preferences). Distinct from settings.json:
 * this file is never version-controlled and holds runtime/security state,
 * not shareable configuration.
 */
export function getStatePath(): string {
  return getCCAgentPath(STATE_FILE);
}

/** Returns `~/.ccagent/AGENT.md`. */
export function getGlobalAgentMdPath(): string {
  return getCCAgentPath("AGENT.md");
}

/** Returns `~/.ccagent/tasks`. */
export function getTasksRoot(): string {
  return getCCAgentPath("tasks");
}

/** Returns `~/.ccagent/plans`. */
export function getPlansRoot(): string {
  return getCCAgentPath("plans");
}

/** Returns `~/.ccagent/teams` — stage 21 Agent Teams root directory. */
export function getTeamsRoot(): string {
  return getCCAgentPath("teams");
}

/** Returns `~/.ccagent/projects` — both memory + session storage live here. */
export function getProjectsRoot(): string {
  return getCCAgentPath("projects");
}

/** Returns `~/.ccagent/stream-debug.log`. */
export function getStreamDebugLogPath(): string {
  return getCCAgentPath("stream-debug.log");
}

/**
 * Returns the private temporary directory for this CCAGENT process.
 *
 * Shell tools point TEMP/TMP/TMPDIR here so an artifact created by a shell
 * command can be consumed by Read/Grep/Glob without granting file tools access
 * to the whole operating-system temp directory. The process id separates
 * concurrent CCAGENT sessions; callers create the directory lazily.
 */
export function getToolTempRoot(): string {
  return getCCAgentPath("tmp", `process-${process.pid}`);
}

// ─── Project (<cwd>/.ccagent/...) ─────────────────────────────────

/** Returns `<cwd>/.ccagent`. */
export function getProjectCCAgentDir(cwd: string): string {
  return path.join(cwd, DIR_NAME);
}

/** Returns `<cwd>/.ccagent/settings.json`. */
export function getProjectSettingsPath(cwd: string): string {
  return path.join(getProjectCCAgentDir(cwd), SETTINGS_FILE);
}

/**
 * Returns `<cwd>/.ccagent/settings.local.json` — project-local personal
 * overrides. This file is gitignored (the writer adds it to `.gitignore`
 * automatically) so individual preferences never get committed.
 */
export function getLocalSettingsPath(cwd: string): string {
  return path.join(getProjectCCAgentDir(cwd), LOCAL_SETTINGS_FILE);
}

// ─── Tuple helpers ───────────────────────────────────────────────────

/**
 * Returns both settings file paths in scope order (user, then project).
 * Convenient for code that loads + merges both, like the MCP config and
 * permission settings loaders. Project overrides user, so iterate in this
 * order and let later writes win.
 */
export function getSettingsPaths(cwd: string): { user: string; project: string } {
  return { user: getUserSettingsPath(), project: getProjectSettingsPath(cwd) };
}
