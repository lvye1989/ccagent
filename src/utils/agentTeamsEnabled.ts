/**
 * Central Agent Teams availability switch.
 *
 * Agent Teams is enabled by default. Users can persist their preference in
 * `~/.ccagent/settings.json` through `/agent-team`, while command-line flags
 * and the legacy environment variable remain available for one-process
 * overrides.
 *
 * Precedence (highest first):
 *   1. `--no-agent-teams` / `--agent-teams`
 *   2. `CCAGENT_TEAMS` (1/true/yes/on or 0/false/no/off)
 *   3. user setting `agentTeams`
 *   4. default: enabled
 */

import { getUserSettingsPath } from "./paths.js";
import { readJsonSettingsFile } from "./settings.js";

const TRUTHY_VALUES = new Set(["1", "true", "yes", "on"]);

let userPreference: boolean | undefined;

function envOverride(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  return TRUTHY_VALUES.has(value.trim().toLowerCase());
}

/** Install a user preference in the running process (also used after writes). */
export function setAgentTeamsUserPreference(enabled: boolean | undefined): void {
  userPreference = enabled;
}

/** Load `agentTeams` from the user settings file before tools are assembled. */
export async function bootstrapAgentTeams(): Promise<boolean> {
  const { raw, parseError } = await readJsonSettingsFile<Record<string, unknown>>(
    getUserSettingsPath(),
  );
  if (parseError) throw new Error(parseError);
  userPreference = typeof raw?.agentTeams === "boolean" ? raw.agentTeams : undefined;
  return isAgentTeamsEnabled();
}

/** Return the effective state for the current process. */
export function isAgentTeamsEnabled(): boolean {
  // A force-off flag wins if contradictory flags were supplied.
  if (process.argv.includes("--no-agent-teams")) return false;
  if (process.argv.includes("--agent-teams")) return true;

  const fromEnv = envOverride(process.env["CCAGENT_TEAMS"]);
  if (fromEnv !== undefined) return fromEnv;

  return userPreference ?? true;
}
