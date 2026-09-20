/** User-wide Skills switch. Installed definitions are retained for reopening. */
import { getUserSettingsPath } from "./paths.js";
import { readJsonSettingsFile, updateUserSettings } from "./settings.js";

let enabled = true;

export function isAgentSkillsEnabled(): boolean {
  return enabled;
}

/** Load only the user preference: project settings cannot reopen Skills. */
export async function bootstrapAgentSkills(): Promise<boolean> {
  const { raw, parseError } = await readJsonSettingsFile<Record<string, unknown>>(getUserSettingsPath());
  if (parseError || (raw !== null && (typeof raw !== "object" || Array.isArray(raw)))) {
    enabled = false;
    throw new Error(parseError ?? "settings.json must contain a JSON object.");
  }
  if (raw?.agentSkills !== undefined && typeof raw.agentSkills !== "boolean") {
    enabled = false;
    throw new Error("agentSkills must be a boolean; Skills remain closed until the setting is fixed.");
  }
  enabled = raw?.agentSkills !== false;
  return enabled;
}

export async function setAgentSkillsEnabled(next: boolean): Promise<void> {
  const { raw, parseError } = await readJsonSettingsFile<unknown>(getUserSettingsPath());
  if (parseError) throw new Error(`${parseError}\nSettings were left untouched.`);
  if (raw !== null && (typeof raw !== "object" || Array.isArray(raw))) {
    throw new Error("settings.json must contain a JSON object; settings were left untouched.");
  }
  await updateUserSettings({ agentSkills: next });
  enabled = next;
}
