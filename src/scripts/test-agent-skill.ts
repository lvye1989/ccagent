import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { QueryEngine } from "../core/queryEngine.js";
import { handleAgentSkillCommand } from "../core/queryEngine/commands/agentSkill.js";
import { buildSystemPrompt, renderSystemPrompt } from "../context/systemPrompt.js";
import { bootstrapSkills } from "../services/skills/bootstrap.js";
import { setSkills, clearSkills, findSkill, getModelVisibleSkills, getAllUserInvocableSkills, activateConditional } from "../services/skills/registry.js";
import { activateConditionalSkillsForPaths } from "../services/skills/conditional.js";
import { skillTool } from "../tools/skillTool.js";
import { getAllTools } from "../tools/index.js";
import type { ToolContext } from "../tools/Tool.js";
import { bootstrapAgentSkills, isAgentSkillsEnabled, setAgentSkillsEnabled } from "../utils/agentSkillsEnabled.js";
import { classifyUserInput } from "../ui/hooks/useAgentSession/inputClassification.js";
import { isBuiltinCommandName, isBuiltinPromptCommand } from "../commands/builtinCommandNames.js";
import { tryExpandBuiltinPromptCommand } from "../commands/builtinPromptCommands.js";

let checks = 0;
function check(value: unknown, label: string): void {
  assert.ok(value, label);
  checks++;
  console.log(`  [PASS] ${label}`);
}

const taskRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ccagent-skill-switch-"));
const previousHome = process.env.CCAGENT_HOME;
const previousFetch = globalThis.fetch;
process.env.CCAGENT_HOME = path.join(taskRoot, "user");
globalThis.fetch = async () => { throw new Error("Unexpected network request from local skill control"); };
const settingsPath = path.join(process.env.CCAGENT_HOME, "settings.json");
const settings = async () => JSON.parse(await fs.readFile(settingsPath, "utf8")) as Record<string, unknown>;
const context: ToolContext = { cwd: taskRoot, sessionId: "skill-switch-test" };
let permissionGrants = 0;
context.addSessionAllowRules = () => { permissionGrants++; };
const engine = new QueryEngine({ model: "test-no-network", permissionMode: "default",
  permissionSettings: { allow: [], deny: [], mode: "default" }, toolContext: context });
async function command(input: string, target = engine): Promise<string> {
  const messages: string[] = [];
  for await (const event of target.submitMessage(input)) {
    assert.equal(event.type, "command", "Local skill commands must not start model turns or mutate conversation history");
    if (event.type === "command") messages.push(event.message);
  }
  return messages.join("\n");
}
async function menu(ask?: ToolContext["requestUserQuestion"]): Promise<string> {
  const messages: string[] = [];
  for await (const event of handleAgentSkillCommand([], ask)) {
    if (event.type === "command") messages.push(event.message);
  }
  return messages.join("\n");
}

try {
  check(await bootstrapAgentSkills(), "Skills default to Open without settings");
  check(isBuiltinCommandName("agent-skill") && !isBuiltinPromptCommand("agent-skill"), "Switch is reserved and local, not a model prompt");
  check(!tryExpandBuiltinPromptCommand("/agent-skill"), "Switch never expands into an LLM prompt");
  check(!classifyUserInput("/agent-skill").isLlmTriggering, "UI classifies switch as local");

  const skillDir = path.join(taskRoot, ".ccagent", "skills", "switch-fixture");
  await fs.mkdir(skillDir, { recursive: true });
  const skillFile = path.join(skillDir, "SKILL.md");
  const body = "---\nname: switch-fixture\ndescription: unique-switch-fixture-description\nallowed-tools:\n  - Read\n---\nSkill-only fixture instructions.\n";
  await fs.writeFile(skillFile, body, "utf8");
  await bootstrapSkills(taskRoot);
  const fixture = findSkill("switch-fixture")!;
  assert.ok(fixture);
  const fixtures = [fixture,
    { ...fixture, name: "plugin:fixture", source: "plugin" as const },
    { ...fixture, name: "agent-skill" }, // reserved-name collision must not hijack the toggle
    { ...fixture, name: "conditional-fixture", frontmatter: { ...fixture.frontmatter, paths: ["**/*.ts"] } },
  ];
  setSkills(fixtures);
  check(getAllTools().includes(skillTool), "Open advertises the Skill tool");
  check(classifyUserInput("/switch-fixture").isLlmTriggering, "Open allows user skill commands");
  check(!classifyUserInput("/agent-skill").isLlmTriggering, "Same-named skill cannot shadow switch classification");
  check(!(await skillTool.call({ skill: fixture.name }, context)).isError && permissionGrants === 1, "Open loads skill normally");
  const unrelated = getAllTools().filter((t) => t.name !== "Skill").map((t) => t.name).join(",");
  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  await fs.writeFile(settingsPath, JSON.stringify({ agentTeams: false, customSetting: { retained: true } }), "utf8");
  check((await command("/agent-skill close")).includes("Close"), "Direct Close reaches real QueryEngine despite name collision");
  check(!isAgentSkillsEnabled() && (await settings()).agentSkills === false, "Close applies immediately and persists false");
  check((await settings()).agentTeams === false && Boolean((await settings()).customSetting), "Unrelated user settings preserved");
  check(!getAllTools().includes(skillTool), "Close removes Skill from model tools");
  check(getAllTools().map((t) => t.name).join(",") === unrelated, "Close leaves agents, Rhino, Teams, MCP and ordinary tools unchanged");
  check(!getModelVisibleSkills().length && !getAllUserInvocableSkills().length, "Close hides model discovery and skill completion list");
  check(!activateConditional("conditional-fixture") && !activateConditionalSkillsForPaths(["src/a.ts"], taskRoot).length, "Close blocks both direct and path-based conditional activation");
  check((await skillTool.call({ skill: fixture.name }, context)).isError && permissionGrants === 1, "Captured Skill tool cannot bypass Close or grant permissions");
  check((await skillTool.call({ skill: "plugin:fixture" }, context)).isError, "Plugin skill invocation also blocked");
  check((await command("/switch-fixture")).includes("/agent-skill open"), "Closed slash invocation provides reopen guidance without model call");
  check(!classifyUserInput("/switch-fixture").isLlmTriggering, "Closed skill command remains a local error in UI");
  check((await command("/skills")).includes("Close"), "Skills inspector reports closed instead of missing installation");
  check((await command("/help")).includes("/agent-skill"), "Help includes the new command");
  const closedPrompt = renderSystemPrompt(await buildSystemPrompt({ cwd: taskRoot }));
  check(!closedPrompt.includes(fixture.description) && closedPrompt.includes("Agent Skills is closed"), "New system prompt excludes skills and disallows stale workflow continuation");
  setSkills(fixtures);
  check(!getModelVisibleSkills().length, "Registry/plugin reload cannot reopen skills");
  await bootstrapAgentSkills();
  check(!isAgentSkillsEnabled(), "Startup bootstrap restores persisted Close");
  const closedText = await fs.readFile(settingsPath, "utf8");
  check((await command("/agent-skill status")).includes("Close"), "Status reads effective state");
  check((await command("/agent-skill invalid")).includes("Usage:"), "Invalid argument rejected");
  check((await command("/agent-skill open extra")).includes("Usage:"), "Extra arguments rejected");
  check((await menu()).includes("Close"), "Noninteractive bare command only reports status");
  check((await menu(async () => null)).includes("cancelled"), "Esc/cancel leaves setting unchanged");
  check((await menu(async (req) => ({ answers: { [req.questions[0].question]: "maybe" } }))).includes("cancelled"), "Unrecognized free text cannot enable skills");
  check((await menu(async () => { throw new Error("test question failure"); })).includes("Could not update"), "Question errors are handled without setting changes");
  check(await fs.readFile(settingsPath, "utf8") === closedText && !isAgentSkillsEnabled(), "Read-only/cancel/invalid paths never write settings");

  let cardCount = 0;
  const interactiveEngine = new QueryEngine({ model: "test-no-network", toolContext: { ...context,
    requestUserQuestion: async (req) => {
      cardCount++;
      const q = req.questions[0];
      assert.deepEqual(q.options.map((o) => o.label), ["Open", "Close"]);
      return { answers: { [q.question]: cardCount === 1 ? "Open" : "Close" } };
    },
  } });
  check((await command("/agent-skill", interactiveEngine)).includes("Open") && cardCount === 1, "Real engine displays one native Open/Close card, no LLM");
  check(isAgentSkillsEnabled() && (await settings()).agentSkills === true, "Interactive Open takes effect and persists");
  check(getModelVisibleSkills().some((s) => s.name === "plugin:fixture"), "Open restores retained plugin definitions");
  check(activateConditionalSkillsForPaths(["src/a.ts"], taskRoot).includes("conditional-fixture"), "Open restores conditional activation");
  check((await command("/agent-skill", interactiveEngine)).includes("Close") && cardCount === 2, "Interactive Close also works");
  check((await command("/config set agentSkills true")).includes("Setting updated") && isAgentSkillsEnabled(), "User /config write applies the same live switch");
  check((await command("/config set agentSkills false --project")).includes("user-only"), "Project config cannot overwrite user-wide preference");
  check((await command("/config set agentSkills false --local")).includes("user-only"), "Local config cannot overwrite user-wide preference");
  check((await command("/config set agentSkills nope")).includes("boolean"), "Invalid /config value rejected");
  check((await command("/agent-skill CLOSE")).includes("Close"), "Open/Close arguments are case insensitive");
  await fs.writeFile(path.join(taskRoot, ".ccagent", "settings.json"), JSON.stringify({ agentSkills: true }), "utf8");
  await bootstrapAgentSkills();
  check(!isAgentSkillsEnabled(), "Startup ignores conflicting project preference");
  check(await fs.readFile(skillFile, "utf8") === body, "Skill installation stays byte-identical across toggles");
  await fs.writeFile(settingsPath, "{ invalid json", "utf8");
  check((await command("/agent-skill open")).includes("left untouched") && !isAgentSkillsEnabled(), "Malformed settings prevent runtime/persistent change");
  check(await fs.readFile(settingsPath, "utf8") === "{ invalid json", "Malformed settings are not overwritten");
  await fs.writeFile(settingsPath, "[]", "utf8");
  check((await command("/agent-skill open")).includes("JSON object"), "Non-object settings cannot be overwritten");
  await fs.writeFile(settingsPath, JSON.stringify({ agentSkills: "false" }), "utf8");
  await assert.rejects(bootstrapAgentSkills, /boolean/);
  check(!isAgentSkillsEnabled(), "Invalid startup boolean fails closed");
  await fs.writeFile(settingsPath, "{}", "utf8");
  await setAgentSkillsEnabled(true);
  await bootstrapAgentSkills();
  check(isAgentSkillsEnabled() && getAllTools().includes(skillTool), "Saved Open survives startup bootstrap");
  console.log(`\nAll ${checks} Agent Skills checks passed (no model/network calls).`);
} finally {
  clearSkills();
  globalThis.fetch = previousFetch;
  if (previousHome === undefined) delete process.env.CCAGENT_HOME;
  else process.env.CCAGENT_HOME = previousHome;
  await fs.rm(taskRoot, { recursive: true, force: true });
}
