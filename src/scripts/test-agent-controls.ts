import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { QueryEngine } from "../core/queryEngine.js";
import { bootstrapAgents } from "../agents/bootstrap.js";
import { getBuiltInAgents } from "../agents/builtIn/index.js";
import { findAgent, getAllAgents, getEnabledAgents, setAgents, clearAgents } from "../agents/registry.js";
import { bootstrapAgentStates, isAgentEnabled, setAgentState } from "../agents/preferences.js";
import { agentTool } from "../tools/agentTool.js";
import { runChildAgent } from "../agents/runAgent.js";
import { getAllTools } from "../tools/index.js";
import { isAgentSkillsEnabled } from "../utils/agentSkillsEnabled.js";
import { isAgentTeamsEnabled } from "../utils/agentTeamsEnabled.js";
import { buildSystemPrompt, renderSystemPrompt } from "../context/systemPrompt.js";
import type { ToolContext } from "../tools/Tool.js";
import { classifyUserInput } from "../ui/hooks/useAgentSession/inputClassification.js";
import { clearPendingNotifications, enqueuePendingNotification, drainPendingNotifications, pendingNotificationCount } from "../state/notificationStore.js";
import { bootstrapWorkfriendScheduler, createWorkfriendSchedule, listWorkfriendSchedules, clearWorkfriendTimers } from "../workfriend/scheduler.js";
import { resetSettingsCache } from "../config/sources.js";

let checks = 0;
function check(value: unknown, label: string): void {
  assert.ok(value, label); checks++; console.log(`  [PASS] ${label}`);
}
const taskRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ccagent-agent-controls-"));
const oldHome = process.env.CCAGENT_HOME;
const oldFetch = globalThis.fetch;
const oldKey = process.env.TEST_AGENT_CONTROLS_KEY;
process.env.CCAGENT_HOME = path.join(taskRoot, "user");
const settingsPath = path.join(process.env.CCAGENT_HOME, "settings.json");
globalThis.fetch = async () => { throw new Error("Unexpected network request"); };
const context: ToolContext = { cwd: taskRoot, sessionId: "agent-controls-test" };
const engine = new QueryEngine({ model: "no-network", toolContext: context });
const makeEngine = (ask: ToolContext["requestUserQuestion"]) => new QueryEngine({
  model: "no-network", toolContext: { ...context, requestUserQuestion: ask },
});
async function command(input: string, target = engine): Promise<string> {
  const messages: string[] = [];
  for await (const event of target.submitMessage(input)) {
    assert.equal(event.type, "command", "Agent controls must not invoke a model or change conversation history");
    if (event.type === "command") messages.push(event.message);
  }
  return messages.join("\n");
}
const readSettings = async () => JSON.parse(await fs.readFile(settingsPath, "utf8")) as Record<string, unknown>;
const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

try {
  await bootstrapAgentStates();
  check(isAgentEnabled("Explore") && isAgentEnabled("new-agent"), "Missing preferences default to Open, including future agents");
  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  await fs.writeFile(settingsPath, JSON.stringify({ agentTeams: false, agentSkills: false, custom: { keep: true } }));
  const agentDir = path.join(taskRoot, ".ccagent", "agents");
  await fs.mkdir(agentDir, { recursive: true });
  const customFile = path.join(agentDir, "reviewer.md");
  const customText = "---\nname: reviewer\ndescription: Project reviewer fixture\n---\nReview only.\n";
  await fs.writeFile(customFile, customText);
  await bootstrapAgents(taskRoot);
  const plugin = { ...getBuiltInAgents()[0], agentType: "plugin:helper", source: "plugin" as const };
  const definitions = [...getAllAgents(), plugin];
  setAgents(definitions);
  check(getAllAgents().length === 6, "Built-in, project and plugin definitions are loaded");
  check(!classifyUserInput("/agents").isLlmTriggering, "Agent menu is a local command");
  const originalTools = getAllTools().map((t) => t.name).join(",");
  const originalTeams = isAgentTeamsEnabled();
  const originalSkills = isAgentSkillsEnabled();
  check((await command("/agents list")).includes("Open · built-in"), "List reports per-agent state and source");
  check((await command("/agents")).includes("6 loaded"), "Noninteractive bare command retains detailed listing");

  check((await command("/agents close rhino_agent")).includes("Close"), "Direct Close applies to built-in Rhino");
  check(!isAgentEnabled("rhino_agent") && isAgentEnabled("Explore"), "Only selected agent is closed");
  check((await readSettings()).agentStates && (await readSettings()).agentTeams === false && (await readSettings()).agentSkills === false && Boolean((await readSettings()).custom), "Agent switch preserves Teams, Skills and unrelated settings");
  check(getAllTools().map((t) => t.name).join(",") === originalTools && isAgentTeamsEnabled() === originalTeams && isAgentSkillsEnabled() === originalSkills, "Ordinary tools, Teams and Skills remain independently controlled");
  check(getAllAgents().some((a) => a.agentType === "rhino_agent") && !getEnabledAgents().some((a) => a.agentType === "rhino_agent"), "Closed agent retained for management but hidden from available catalog");
  const prompt = renderSystemPrompt(await buildSystemPrompt({ cwd: taskRoot }));
  check(!prompt.includes("- rhino_agent [") && prompt.includes("- Explore ["), "System prompt only advertises Open agents");
  check((await command("/agents rhino_agent")).includes("Close"), "Direct agent selection reports current state without UI");
  for (const variant of [
    {}, { run_in_background: true }, { isolation: "worktree" },
    { name: "teammate", team_name: "team", run_in_background: true },
  ]) {
    const result = await agentTool.call({ prompt: "Do not execute", subagent_type: "rhino_agent", ...variant }, {
      ...context, getPermissionMode: () => "full",
    });
    check(result.isError && String(result.content).includes("/agents open rhino_agent"), `Close blocks Agent tool before launch (${JSON.stringify(variant)}) even in Full mode`);
  }
  await assert.rejects(runChildAgent({ agentDefinition: findAgent("rhino_agent")!, prompt: "Never launch",
    availableTools: [], model: "no-network", parentToolContext: context }), /is closed/);
  check(true, "Execution-time guard rejects stale/cached definitions before Rhino project creation or model calls");
  await command("/agents close general-purpose");
  check((await agentTool.call({ prompt: "Default agent test" }, context)).isError, "Omitted subagent_type cannot bypass a closed general-purpose agent");
  await command("/agents open general-purpose");
  await command("/agents close reviewer");
  await command("/agents close plugin:helper");
  check(!isAgentEnabled("reviewer") && !isAgentEnabled("plugin:helper"), "Custom and namespaced plugin agents support Close");
  setAgents(definitions);
  check(!getEnabledAgents().some((a) => ["rhino_agent", "reviewer", "plugin:helper"].includes(a.agentType)), "Registry reload preserves user Close");
  await bootstrapAgentStates();
  check(!isAgentEnabled("rhino_agent"), "Startup restores persisted per-agent Close");
  await fs.writeFile(path.join(taskRoot, ".ccagent", "settings.json"), JSON.stringify({ agentStates: { rhino_agent: "open" } }));
  await bootstrapAgentStates();
  check(!isAgentEnabled("rhino_agent"), "Project preference cannot override user Close");
  check(await fs.readFile(customFile, "utf8") === customText, "Agent definition files are unchanged");

  let cards = 0;
  const interactive = makeEngine(async (req) => {
    const q = req.questions[0]; cards++;
    assert.ok(q.options.length <= 4);
    if (cards === 1) return { answers: { [q.question]: "Next page" } };
    if (cards === 2) {
      check(q.options[0].label.includes("rhino_agent") && q.options[0].description?.includes("Close"), "Second menu page shows closed Rhino with correct status");
      return { answers: { [q.question]: q.options[0].label } };
    }
    assert.deepEqual(q.options.map((o) => o.label), ["Open", "Close"]);
    return { answers: { [q.question]: "Open" } };
  });
  check((await command("/agents", interactive)).includes("Open") && cards === 3, "Real QueryEngine supports paginated agent picker and native Open/Close card");
  check(isAgentEnabled("rhino_agent") && !isAgentEnabled("reviewer"), "Interactive Open changes only selected agent");
  const closeMenu = makeEngine(async (req) => ({ answers: { [req.questions[0].question]: "Close" } }));
  check((await command("/agents rhino_agent", closeMenu)).includes("Close"), "Named-agent card also supports Close");
  const saved = await fs.readFile(settingsPath, "utf8");
  check((await command("/agents", makeEngine(async () => null))).includes("cancelled"), "Cancelling picker does not change settings");
  check((await command("/agents Explore", makeEngine(async () => null))).includes("cancelled"), "Cancelling state card does not change settings");
  check((await command("/agents Explore", makeEngine(async (req) => ({ answers: { [req.questions[0].question]: "unknown choice" } })))).includes("cancelled"), "Unknown free-text choice never changes state");
  check((await command("/agents", makeEngine(async () => { throw new Error("question fixture error"); }))).includes("question fixture error"), "Question errors produce local diagnostics");
  check((await command("/agents close missing-agent")).includes("Unknown agent"), "Unknown agent rejected");
  check((await command("/agents open Explore extra")).includes("Usage:"), "Extra arguments rejected");
  check((await command("/agents close explore")).includes("Unknown agent"), "Exact agent names prevent ambiguous case-based selection");
  check((await command('/config set agentStates {} --project')).includes("Use /agents"), "Generic config writes cannot silently bypass live state");
  check(await fs.readFile(settingsPath, "utf8") === saved, "Invalid/cancel/read-only command paths leave settings byte-identical");
  await Promise.all([setAgentState("Explore", "close"), setAgentState("reviewer", "open")]);
  const concurrent = (await readSettings()).agentStates as Record<string, string>;
  check(concurrent.Explore === "close" && concurrent.reviewer === "open", "Concurrent per-agent writes preserve both choices");

  await command("/agents close workfriend");
  check((await command("/workfriend")).includes("/agents open workfriend"), "Workfriend shortcut cannot start a closed agent workflow");
  check(!classifyUserInput("/workfriend").isLlmTriggering, "Closed Workfriend shortcut is a local error in the UI");
  clearPendingNotifications();
  enqueuePendingNotification({ mode: "workfriend-notification", text: "held fixture" });
  enqueuePendingNotification({ mode: "task-notification", text: "completed task fixture" });
  check(pendingNotificationCount() === 1 && drainPendingNotifications()[0]?.mode === "task-notification", "Close holds Workfriend reminders but delivers running task results");
  check(pendingNotificationCount() === 0 && drainPendingNotifications().length === 0, "Held reminder cannot trigger a hidden model turn while closed");
  const end = new Date(Date.now() + 30 * 60 * 1000);
  const schedule = await createWorkfriendSchedule({ workdayEnd: `${String(end.getHours()).padStart(2, "0")}:${String(end.getMinutes()).padStart(2, "0")}`,
    workSummary: "fixture", moodSummary: "fixture", cwd: taskRoot });
  await bootstrapWorkfriendScheduler();
  await tick(1200);
  check((await listWorkfriendSchedules()).find((s) => s.id === schedule.id)?.status === "pending" && pendingNotificationCount() === 0, "Closed Workfriend leaves due scheduled reminders pending on disk");
  await command("/agents open workfriend");
  check(drainPendingNotifications().some((n) => n.text === "held fixture"), "Open releases already-queued reminders");
  for (let i = 0; i < 80 && pendingNotificationCount() === 0; i++) await tick(20);
  check(pendingNotificationCount() === 1 && (await listWorkfriendSchedules())[0]?.status === "fired", "Open resumes persisted overdue reminders without restart");
  clearPendingNotifications(); clearWorkfriendTimers();

  // Harmless mocked provider run proves Open still executes and Close is not a force-kill.
  process.env.TEST_AGENT_CONTROLS_KEY = "fixture-only";
  await fs.writeFile(settingsPath, JSON.stringify({ ...await readSettings(), models: { controls_fixture: {
    protocol: "openai-chat", model: "fixture", baseURL: "https://agent-controls.test/v1", apiKey: "TEST_AGENT_CONTROLS_KEY",
  } } }));
  resetSettingsCache();
  let modelCalls = 0;
  await setAgentState("reviewer", "open");
  globalThis.fetch = async () => {
    modelCalls++;
    await setAgentState("reviewer", "close");
    const chunk = { choices: [{ index: 0, delta: { content: "Fixture finished safely" }, finish_reason: "stop" }] };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { "Content-Type": "text/event-stream" } });
  };
  const result = await runChildAgent({ agentDefinition: findAgent("reviewer")!, prompt: "Fixture only", availableTools: [],
    model: "controls_fixture", parentToolContext: context });
  check(result.reason === "completed" && modelCalls === 1 && result.finalText.includes("finished safely"), "Open agent runs; Close during an already-started task does not force-kill it");
  await assert.rejects(runChildAgent({ agentDefinition: findAgent("reviewer")!, prompt: "Blocked next run", availableTools: [],
    model: "controls_fixture", parentToolContext: context }), /is closed/);
  check(modelCalls === 1, "Subsequent invocation of the closed agent cannot make a model request");

  await Promise.all(getAllAgents().map((agent) => setAgentState(agent.agentType, "close")));
  check(getEnabledAgents().length === 0 && (await command("/agents list")).includes("6 loaded"), "All agents may be closed while management retains every definition");
  check((await command("/agents OPEN plugin:helper")).includes("Open") && getEnabledAgents().length === 1, "Local menu/direct commands can reopen an agent when all are closed");

  await fs.writeFile(settingsPath, "{ invalid", "utf8");
  check((await command("/agents open reviewer")).includes("left untouched") && !isAgentEnabled("reviewer"), "Malformed settings prevent disk/runtime mutations");
  check(await fs.readFile(settingsPath, "utf8") === "{ invalid", "Malformed settings retained for recovery");
  await assert.rejects(bootstrapAgentStates);
  check(getEnabledAgents().length === 0, "Invalid startup settings fail closed");
  await fs.writeFile(settingsPath, '{"agentStates":{"Explore":true}}');
  await assert.rejects(bootstrapAgentStates, /agentStates/);
  check(!isAgentEnabled("Explore"), "Invalid agent state value cannot silently reopen agent");
  await fs.writeFile(settingsPath, "[]");
  check((await command("/agents open Explore")).includes("JSON object"), "Non-object settings cannot be overwritten");
  await fs.writeFile(settingsPath, "{}");
  await bootstrapAgentStates();
  check(getEnabledAgents().length === 6, "Repaired settings restore default Open without reloading definitions");
  console.log(`\nAll ${checks} per-agent control checks passed (external network blocked/mocked).`);
} finally {
  await tick(30); // Let read-only scheduler listeners settle before removing the test-owned root.
  clearWorkfriendTimers(); clearPendingNotifications(); clearAgents();
  globalThis.fetch = oldFetch;
  if (oldHome === undefined) delete process.env.CCAGENT_HOME; else process.env.CCAGENT_HOME = oldHome;
  if (oldKey === undefined) delete process.env.TEST_AGENT_CONTROLS_KEY; else process.env.TEST_AGENT_CONTROLS_KEY = oldKey;
  const resolved = path.resolve(taskRoot);
  assert.ok(path.basename(resolved).startsWith("ccagent-agent-controls-") && path.dirname(resolved) === path.resolve(os.tmpdir()));
  await fs.rm(resolved, { recursive: true, force: true });
}
