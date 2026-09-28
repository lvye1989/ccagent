import type { Tool, ToolDecisionPolicy } from "./Tool.js";

// Compatibility defaults for control-plane tools that intentionally bypass
// the general Jev classifier. Purpose-built Jev tools also declare their
// policy on the Tool object; these names keep third-party/test adapters with a
// matching built-in identity on the same route.
const LOCAL_CONTROL_TOOLS = new Set([
  "TodoWrite",
  "TaskCreate",
  "TaskUpdate",
  "TaskGet",
  "TaskList",
  "TeamCreate",
  "TeamDelete",
  "SendMessage",
  "AgentTeamMode",
]);

const PERMISSION_ONLY_TOOLS = new Set([
  "Agent",
  "AskUserQuestion",
  "EnterPlanMode",
  "ExitPlanMode",
]);

const SPECIALIZED_JEV_TOOLS = new Set([
  "ComputerAction",
  "ComputerActionGroup",
  "ComputerNavigate",
  "RhinoAction",
  "RhinoSequence",
  "WorkfriendAssess",
]);

/** Resolve the effective route without performing I/O or changing policy. */
export function resolveToolDecisionPolicy(tool: Tool): ToolDecisionPolicy {
  if (tool.decisionPolicy) return tool.decisionPolicy;
  if (tool.isReadOnly()) return "local";
  if (SPECIALIZED_JEV_TOOLS.has(tool.name)) return "specialized_jev";
  if (LOCAL_CONTROL_TOOLS.has(tool.name)) return "local";
  if (PERMISSION_ONLY_TOOLS.has(tool.name)) return "permission_only";
  return "generic_jev";
}
