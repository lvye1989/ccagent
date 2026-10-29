/** Per-skill user preferences shared by the CLI and Web. */
import { getUserSettingsPath } from "../../utils/paths.js";
import { readJsonSettingsFile, updateUserSettings } from "../../utils/settings.js";

let states: Record<string, "open" | "close"> = {};
let valid = true;
let pending: Promise<void> = Promise.resolve();

async function readStates() {
  const { raw, parseError } = await readJsonSettingsFile<Record<string, unknown>>(getUserSettingsPath());
  if (parseError) throw new Error("Cannot read skill preferences; repair settings.json first.");
  if (raw !== null && (typeof raw !== "object" || Array.isArray(raw))) throw new Error("settings.json must be an object; it was left untouched.");
  const value = raw?.skillStates;
  if (value !== undefined && (!value || typeof value !== "object" || Array.isArray(value) || Object.values(value).some((v) => v !== "open" && v !== "close"))) {
    throw new Error("skillStates must map skill names to open or close.");
  }
  return (value ?? {}) as Record<string, "open" | "close">;
}

export async function bootstrapSkillStates(): Promise<void> {
  try { states = await readStates(); valid = true; }
  catch (error) { valid = false; throw error; }
}

export function isSkillEnabled(name: string): boolean {
  return valid && (!Object.hasOwn(states, name) || states[name] !== "close");
}

export function setSkillState(name: string, state: "open" | "close"): Promise<void> {
  const task = pending.then(async () => {
    if (!name.trim() || !["open", "close"].includes(state)) throw new Error("Invalid skill state.");
    const next = { ...await readStates(), [name]: state };
    await updateUserSettings({ skillStates: next });
    states = next; valid = true;
  });
  pending = task.catch(() => {});
  return task;
}
