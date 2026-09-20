import type { ScopedMcpServerConfig } from "../../types/mcp.js";
import { getUserSettingsPath } from "../../utils/paths.js";
import { readJsonSettingsFile, updateUserSettings } from "../../utils/settings.js";

export type McpServerState = "open" | "close";
let states: Record<string, McpServerState> = Object.create(null);
let loadedPath: string | undefined;
let loading: Promise<void> | undefined;
let writeTail: Promise<void> = Promise.resolve();

function parseStates(raw: unknown): Record<string, McpServerState> {
  const result: Record<string, McpServerState> = Object.create(null);
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [name, value] of Object.entries(raw)) {
      if (value === "open" || value === "close") result[name] = value;
    }
  }
  return result;
}

/** User-wide overrides include plugin MCPs and never copy their credentials. */
export async function loadMcpPreferences(): Promise<void> {
  const file = getUserSettingsPath();
  if (loadedPath === file && loading) return loading;
  loadedPath = file;
  loading = (async () => {
    const { raw } = await readJsonSettingsFile<Record<string, unknown>>(file);
    states = parseStates(raw?.mcpServerStates);
  })();
  return loading;
}

export function isMcpServerEnabled(name: string, config: ScopedMcpServerConfig): boolean {
  // An interactive preference cannot lift a managed policy restriction.
  if (config.scope === "policy" && config.enabled === false) return false;
  return states[name] ? states[name] === "open" : config.enabled !== false;
}

export async function saveMcpServerState(name: string, state: McpServerState): Promise<void> {
  const write = writeTail.then(async () => {
    await loadMcpPreferences();
    const { raw, parseError } = await readJsonSettingsFile<Record<string, unknown>>(getUserSettingsPath());
    if (parseError) throw new Error("Cannot save MCP switch: fix the invalid user settings.json first.");
    if (raw !== null && (typeof raw !== "object" || Array.isArray(raw))) {
      throw new Error("Cannot save MCP switch: user settings.json must contain an object.");
    }
    const next = { ...parseStates(raw?.mcpServerStates), [name]: state };
    await updateUserSettings({ mcpServerStates: next });
    states = next;
  });
  writeTail = write.catch(() => undefined);
  return write;
}

export function _resetMcpPreferencesForTesting(): void {
  states = Object.create(null);
  loadedPath = undefined;
  loading = undefined;
}
