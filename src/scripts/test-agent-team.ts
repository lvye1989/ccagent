#!/usr/bin/env tsx
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { tryExpandBuiltinPromptCommand } from "../commands/builtinPromptCommands.js";
import { clearActiveTeam, setActiveTeam } from "../state/teamContext.js";
import { agentTeamModeTool } from "../tools/agentTeamModeTool.js";
import { findToolByName, getAllTools } from "../tools/index.js";
import {
  bootstrapAgentTeams,
  isAgentTeamsEnabled,
  setAgentTeamsUserPreference,
} from "../utils/agentTeamsEnabled.js";

let failures = 0;
function assert(condition: unknown, label: string): void {
  console.log(`  [${condition ? "PASS" : "FAIL"}] ${label}`);
  if (!condition) failures++;
}

async function main(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ccagent-agent-team-"));
  const previousHome = process.env.CCAGENT_HOME;
  const previousEnv = process.env.CCAGENT_TEAMS;
  process.env.CCAGENT_HOME = path.join(root, ".ccagent");
  delete process.env.CCAGENT_TEAMS;
  setAgentTeamsUserPreference(undefined);

  try {
    console.log("[1] default + slash command registration");
    assert(isAgentTeamsEnabled(), "Agent Teams defaults to open");
    assert(findToolByName("AgentTeamMode") === agentTeamModeTool, "mode tool is always registered");
    const expansion = tryExpandBuiltinPromptCommand("/agent-team");
    assert(expansion?.name === "agent-team", "/agent-team expands as a built-in prompt command");
    assert(
      expansion?.bodyText.includes("Open") && expansion.bodyText.includes("Close"),
      "bare command requests an Open/Close card",
    );
    const direct = tryExpandBuiltinPromptCommand("/agent-team close");
    assert(direct?.bodyText.includes("Additional instructions: close"), "direct Close argument is preserved");

    console.log("\n[2] persisted preference bootstrap");
    await fs.mkdir(process.env.CCAGENT_HOME, { recursive: true });
    await fs.writeFile(
      path.join(process.env.CCAGENT_HOME, "settings.json"),
      JSON.stringify({ agentTeams: false }, null, 2) + "\n",
      "utf-8",
    );
    await bootstrapAgentTeams();
    assert(!isAgentTeamsEnabled(), "bootstrap loads agentTeams=false from user settings");
    assert(!getAllTools().some((tool) => tool.name === "TeamCreate"), "team tools are hidden while closed");
    assert(getAllTools().some((tool) => tool.name === "AgentTeamMode"), "reopen tool remains visible while closed");

    console.log("\n[3] Open/Close mutation and active-team guard");
    const context = { cwd: root };
    const opened = await agentTeamModeTool.call({ state: "open" }, context);
    assert(!opened.isError && isAgentTeamsEnabled(), "Open applies immediately");
    let settings = JSON.parse(
      await fs.readFile(path.join(process.env.CCAGENT_HOME, "settings.json"), "utf-8"),
    ) as Record<string, unknown>;
    assert(settings.agentTeams === true, "Open persists agentTeams=true");
    assert(getAllTools().some((tool) => tool.name === "TeamCreate"), "team tools are visible after Open");

    setActiveTeam({
      teamName: "active-test",
      leadAgentId: "team-lead@active-test",
      teamFilePath: path.join(root, "team.json"),
      createdAt: Date.now(),
    });
    const refused = await agentTeamModeTool.call({ state: "close" }, context);
    assert(refused.isError && isAgentTeamsEnabled(), "Close refuses while a team is active");
    clearActiveTeam();

    const closed = await agentTeamModeTool.call({ state: "close" }, context);
    assert(!closed.isError && !isAgentTeamsEnabled(), "Close applies immediately when no team is active");
    settings = JSON.parse(
      await fs.readFile(path.join(process.env.CCAGENT_HOME, "settings.json"), "utf-8"),
    ) as Record<string, unknown>;
    assert(settings.agentTeams === false, "Close persists agentTeams=false");

    console.log("\n[4] legacy override compatibility");
    process.env.CCAGENT_TEAMS = "1";
    assert(isAgentTeamsEnabled(), "CCAGENT_TEAMS=1 overrides a closed preference");
    process.env.CCAGENT_TEAMS = "0";
    assert(!isAgentTeamsEnabled(), "CCAGENT_TEAMS=0 forces the feature closed");

    console.log("\n[5] malformed settings safety");
    delete process.env.CCAGENT_TEAMS;
    const settingsPath = path.join(process.env.CCAGENT_HOME, "settings.json");
    const malformed = "{ not valid JSON";
    await fs.writeFile(settingsPath, malformed, "utf-8");
    const malformedResult = await agentTeamModeTool.call({ state: "open" }, context);
    assert(malformedResult.isError, "malformed settings block the preference write");
    assert(await fs.readFile(settingsPath, "utf-8") === malformed, "malformed settings are left untouched");
  } finally {
    clearActiveTeam();
    setAgentTeamsUserPreference(undefined);
    if (previousHome === undefined) delete process.env.CCAGENT_HOME;
    else process.env.CCAGENT_HOME = previousHome;
    if (previousEnv === undefined) delete process.env.CCAGENT_TEAMS;
    else process.env.CCAGENT_TEAMS = previousEnv;
    await fs.rm(root, { recursive: true, force: true });
  }

  if (failures > 0) {
    console.error(`\n${failures} Agent Team test(s) failed.`);
    process.exitCode = 1;
  } else {
    console.log("\nAll Agent Team tests passed.");
  }
}

void main();
