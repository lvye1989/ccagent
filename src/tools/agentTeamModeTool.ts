import type { Tool, ToolContext, ToolResult } from "./Tool.js";
import { getActiveTeam } from "../state/teamContext.js";
import {
  isAgentTeamsEnabled,
  setAgentTeamsUserPreference,
} from "../utils/agentTeamsEnabled.js";
import { getUserSettingsPath } from "../utils/paths.js";
import { readJsonSettingsFile, updateUserSettings } from "../utils/settings.js";

export const agentTeamModeTool: Tool = {
  name: "AgentTeamMode",
  description:
    "Persistently open or close Agent Teams for the current user. Use this only after the user " +
    "explicitly chooses Open or Close through `/agent-team` (or directly asks to change the setting). " +
    "Closing is refused while a team is active so running teammates are not orphaned.",
  inputSchema: {
    type: "object",
    properties: {
      state: {
        type: "string",
        enum: ["open", "close"],
        description: "Open enables Agent Teams; close disables it.",
      },
    },
    required: ["state"],
    additionalProperties: false,
  },

  async call(input: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> {
    const state = typeof input.state === "string" ? input.state.toLowerCase() : "";
    if (state !== "open" && state !== "close") {
      return { content: "Error: state must be open or close.", isError: true };
    }

    if (state === "close") {
      const active = getActiveTeam();
      if (active) {
        return {
          content:
            `Agent Teams cannot be closed while team "${active.teamName}" is active. ` +
            "Finish the teammates and run TeamDelete first, then choose Close again.",
          isError: true,
        };
      }
    }

    const enabled = state === "open";
    try {
      const settingsPath = getUserSettingsPath();
      const existing = await readJsonSettingsFile<Record<string, unknown>>(settingsPath);
      if (existing.parseError) {
        return {
          content: `${existing.parseError}\nFix the JSON before changing Agent Teams; the file was left untouched.`,
          isError: true,
        };
      }
      await updateUserSettings({ agentTeams: enabled });
      setAgentTeamsUserPreference(enabled);
      const effective = isAgentTeamsEnabled();
      const overrideNotice = effective === enabled
        ? "The available team tools will reflect this setting on the next turn."
        : `The preference was saved, but this process remains ${effective ? "open" : "closed"} because a CLI or CCAGENT_TEAMS override takes precedence.`;
      return {
        content: [
          `Saved Agent Teams preference: ${enabled ? "open (enabled)" : "closed (disabled)"}.`,
          `Saved to: ${settingsPath}`,
          `Effective state: ${effective ? "open" : "closed"}.`,
          overrideNotice,
        ].join("\n"),
      };
    } catch (error) {
      return {
        content: `Could not update Agent Teams: ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      };
    }
  },

  isReadOnly(): boolean {
    return false;
  },

  // Must stay visible while Agent Teams is closed so `/agent-team` can reopen it.
  isEnabled(): boolean {
    return true;
  },
};
