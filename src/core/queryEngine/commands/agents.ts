import { findAgent, getAllAgents } from "../../../agents/registry.js";
import { isAgentEnabled, setAgentState } from "../../../agents/preferences.js";
import { getUserSettingsPath } from "../../../utils/paths.js";
import type { ToolContext } from "../../../tools/Tool.js";
import type { QueryEngineEvent } from "../types.js";

type Ask = NonNullable<ToolContext["requestUserQuestion"]>;
const usage = "/agents [list | <name> | open <name> | close <name>]";

async function pickAgent(ask: Ask): Promise<string | undefined> {
  const all = getAllAgents();
  let page = 0;
  const pages = Math.ceil(all.length / 3);
  while (all.length > 0) {
    const slice = all.slice(page * 3, page * 3 + 3);
    const question = `选择 Agent (${page + 1}/${pages})；Esc 退出`;
    const options = slice.map((agent, index) => ({
      label: `${index + 1}. ${agent.agentType}`,
      description: `${isAgentEnabled(agent.agentType) ? "Open" : "Close"} · ${agent.source} · ${agent.whenToUse.slice(0, 90)}`,
    }));
    if (pages > 1) options.push({ label: "Next page", description: "下一页（循环）" });
    const response = await ask({ questions: [{ header: "Agents", question, options }] });
    const answer = response?.answers[question];
    if (!answer) return undefined;
    if (answer === "Next page" && pages > 1) { page = (page + 1) % pages; continue; }
    const index = options.findIndex((option) => option.label === answer);
    if (index >= 0 && index < slice.length) return slice[index].agentType;
    // Free text must be an exact registered name; never guess which agent to change.
    return all.find((agent) => agent.agentType === answer)?.agentType;
  }
  return undefined;
}

/** Native cards and deterministic writes; no LLM, MCP or agent execution. */
export async function* handleAgentControlsCommand(
  args: string[], ask?: ToolContext["requestUserQuestion"],
): AsyncGenerator<QueryEngineEvent, { handled: boolean }> {
  let action = "select";
  let name: string | undefined;
  try {
    if (args.length === 0 && ask) {
      name = await pickAgent(ask);
      if (!name) {
        yield { type: "command", kind: "info", message: "Agent selection cancelled; no settings changed." };
        return { handled: true };
      }
    } else if (args.length === 2 && ["open", "close"].includes(args[0].toLowerCase())) {
      action = args[0].toLowerCase(); name = args[1];
    } else if (args.length === 1) {
      name = args[0];
    } else {
      throw new Error(`Usage: ${usage}`);
    }
    if (!name || !findAgent(name)) throw new Error(`Unknown agent '${name ?? ""}'. ${usage}`);
    if (action === "select") {
      if (!ask) {
        yield { type: "command", kind: "info", message: `${name}: ${isAgentEnabled(name) ? "Open" : "Close"}\n${usage}` };
        return { handled: true };
      }
      const question = `${name} 当前为 ${isAgentEnabled(name) ? "Open" : "Close"}，请选择：`;
      const response = await ask({ questions: [{ header: "Agent switch", question, options: [
        { label: "Open", description: "允许模型调用该 Agent；保留原工具权限和安全检查。" },
        { label: "Close", description: "隐藏并阻止该 Agent 的新任务；不删除定义，不强行中断运行中的任务。" },
      ] }] });
      const answer = response?.answers[question]?.trim().toLowerCase();
      if (answer !== "open" && answer !== "close") {
        yield { type: "command", kind: "info", message: "Agent selection cancelled; no settings changed." };
        return { handled: true };
      }
      action = answer;
    }
    // A plugin may have been unloaded while the question card was open.
    if (!findAgent(name)) throw new Error(`Agent '${name}' is no longer loaded; no settings changed.`);
    await setAgentState(name, action === "open" ? "open" : "close");
    yield { type: "command", kind: "info", message: [
      `Agent '${name}': ${isAgentEnabled(name) ? "Open — 已开启" : "Close — 已关闭"}，对新任务立即生效。`,
      `Saved to: ${getUserSettingsPath()} (agentStates)`,
      "保留定义、已有成果和历史记录；已运行的任务不会强制中断。",
      ...(name === "workfriend" ? ["Workfriend 关闭期间暂停专用入口和待发送提醒，重新开启后恢复。"] : []),
    ].join("\n") };
  } catch (error) {
    yield { type: "command", kind: "error", message: `Could not update Agent: ${error instanceof Error ? error.message : String(error)}` };
  }
  return { handled: true };
}
