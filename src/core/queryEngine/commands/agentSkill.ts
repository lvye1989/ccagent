import type { ToolContext } from "../../../tools/Tool.js";
import { getUserSettingsPath } from "../../../utils/paths.js";
import { isAgentSkillsEnabled, setAgentSkillsEnabled } from "../../../utils/agentSkillsEnabled.js";
import type { QueryEngineEvent } from "../types.js";

/** Local control command: selecting Open/Close never calls a model or MCP. */
export async function* handleAgentSkillCommand(
  args: string[],
  ask?: ToolContext["requestUserQuestion"],
): AsyncGenerator<QueryEngineEvent, { handled: boolean }> {
  let state: string | undefined = args[0]?.toLowerCase();
  if (args.length > 1 || (state && !["open", "close", "status"].includes(state))) {
    yield { type: "command", kind: "error", message: "Usage: /agent-skill [open|close|status]" };
    return { handled: true };
  }
  if (state === "status" || (!state && !ask)) {
    yield { type: "command", kind: "info", message: `Agent Skills: ${isAgentSkillsEnabled() ? "Open" : "Close"}\n/agent-skill open — 开启；/agent-skill close — 关闭。` };
    return { handled: true };
  }
  try {
    if (!state && ask) {
      const question = `Agent Skills 当前为 ${isAgentSkillsEnabled() ? "Open" : "Close"}，请选择：`;
      const response = await ask({ questions: [{ header: "Agent Skills", question, options: [
        { label: "Open", description: "启用技能发现、Skill 工具、技能命令及按路径自动触发。" },
        { label: "Close", description: "停用技能入口，保留已安装技能；不影响 Agent、MCP 和普通工具。" },
      ] }] });
      state = response?.answers[question]?.trim().toLowerCase();
      if (state !== "open" && state !== "close") {
        yield { type: "command", kind: "info", message: "Agent Skills selection cancelled; no settings changed." };
        return { handled: true };
      }
    }
    await setAgentSkillsEnabled(state === "open");
    yield { type: "command", kind: "info", message: [
      `Agent Skills: ${state === "open" ? "Open — 已开启" : "Close — 已关闭"}，后续技能调用立即生效。`,
      `Saved to: ${getUserSettingsPath()} (agentSkills: ${isAgentSkillsEnabled()})`,
      "不会删除技能、清除已有会话内容或撤销已执行的操作。",
    ].join("\n") };
  } catch (error) {
    yield { type: "command", kind: "error", message: `Could not update Agent Skills: ${error instanceof Error ? error.message : String(error)}` };
  }
  return { handled: true };
}
