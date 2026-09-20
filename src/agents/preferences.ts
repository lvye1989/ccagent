/** Per-definition, user-wide Open/Close preferences, independent of Teams/Skills. */
import { getUserSettingsPath } from "../utils/paths.js";
import { readJsonSettingsFile, updateUserSettings } from "../utils/settings.js";

export type AgentState = "open" | "close";
let states: Record<string, AgentState> = {};
let invalidSettings = false;
let pendingWrite: Promise<void> = Promise.resolve();
const listeners = new Set<() => void>();

export function isAgentEnabled(name: string): boolean {
  return !invalidSettings && (!Object.hasOwn(states, name) || states[name] !== "close");
}

export function agentClosedMessage(name: string): string {
  return `Agent '${name}' is closed. Use /agents open ${name} to enable it.`;
}

export function onAgentStatesChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function notify(): void {
  for (const listener of listeners) {
    try { listener(); } catch { /* A UI listener must not invalidate a saved preference. */ }
  }
}

function parseStates(value: unknown): Record<string, AgentState> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.values(value).some((state) => state !== "open" && state !== "close")) {
    throw new Error('agentStates must be an object mapping agent names to "open" or "close".');
  }
  return Object.fromEntries(Object.entries(value)) as Record<string, AgentState>;
}

async function readStates(): Promise<Record<string, AgentState>> {
  const { raw, parseError } = await readJsonSettingsFile<Record<string, unknown>>(getUserSettingsPath());
  if (parseError) throw new Error(`${parseError}\nSettings were left untouched.`);
  if (raw !== null && (typeof raw !== "object" || Array.isArray(raw))) {
    throw new Error("settings.json must contain a JSON object; settings were left untouched.");
  }
  return parseStates(raw?.agentStates);
}

/** Project/plugin reload cannot override a user Close. Missing entries default Open. */
export async function bootstrapAgentStates(): Promise<void> {
  try {
    states = await readStates();
    invalidSettings = false;
  } catch (error) {
    invalidSettings = true;
    throw error;
  } finally {
    notify();
  }
}

/** Serialize same-process writes so closing different agents cannot lose updates. */
export function setAgentState(name: string, state: AgentState): Promise<void> {
  const task = pendingWrite.then(async () => {
    if (!name.trim() || (state !== "open" && state !== "close")) throw new Error("Invalid agent name or state.");
    const next = { ...await readStates(), [name]: state };
    await updateUserSettings({ agentStates: next });
    states = next;
    invalidSettings = false;
    notify();
  });
  pendingWrite = task.catch(() => {});
  return task;
}
