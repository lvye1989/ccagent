import { getMcpRegistry, getMcpRegistryEntry } from "../../../services/mcp/registry.js";
import { requestMcpReconnect, setMcpServerOpen } from "../../../services/mcp/bootstrap.js";
import { isMcpServerEnabled } from "../../../services/mcp/preferences.js";
import type { ToolContext } from "../../../tools/Tool.js";
import type { McpServerConnection } from "../../../types/mcp.js";
import type { QueryEngineEvent } from "../types.js";

const usage = "/mcp [list | <name> | open <name> | close <name> | auth <name> | tools <name> | reconnect <name>]";
type Ask = NonNullable<ToolContext["requestUserQuestion"]>;

function status(connection: McpServerConnection, toolCount: number): string {
  if (connection.type === "disabled") return "Close / 已关闭";
  if (connection.type === "pending") return "Open / 连接或授权中";
  if (connection.type === "failed") return `Open / ${connection.error}`;
  return connection.discoveryError
    ? `Open / ${connection.discoveryError}` : `Open / connected · ${toolCount} tool(s)`;
}

async function selectServer(ask: Ask): Promise<string | undefined> {
  const entries = getMcpRegistry();
  let page = 0;
  const pageCount = Math.ceil(entries.length / 3);
  while (entries.length) {
    const question = `选择 MCP 服务 (${page + 1}/${pageCount})；Esc 退出`;
    const slice = entries.slice(page * 3, page * 3 + 3);
    const options = slice.map(({ connection, tools }, i) => ({
      label: `${i + 1}. ${connection.name}`,
      description: status(connection, tools.length),
    }));
    if (pageCount > 1) options.push({ label: "Next page", description: "下一页（循环）" });
    const response = await ask({ questions: [{ header: "MCP", question, options }] });
    const answer = response?.answers[question];
    if (!answer) return undefined;
    if (answer === "Next page" && pageCount > 1) { page = (page + 1) % pageCount; continue; }
    const index = options.findIndex((option) => option.label === answer);
    if (index >= 0 && index < slice.length) return slice[index].connection.name;
    // Free text is accepted only when it is an exact configured server name.
    return entries.find((entry) => entry.connection.name === answer)?.connection.name;
  }
  return undefined;
}

/** Deterministic UI command: never asks an LLM to change service availability. */
export async function* handleMcpCommand(
  args: string[],
  ask?: ToolContext["requestUserQuestion"],
): AsyncGenerator<QueryEngineEvent, { handled: boolean }> {
  let [sub, ...rest] = args;
  let target = rest.join(" ");
  const entries = getMcpRegistry();
  if (!entries.length && (!sub || sub === "list")) {
    yield { type: "command", kind: "info", message: "MCP Servers (0 configured)\n\nNo MCP servers configured. Add them under \"mcpServers\" in:\n  ~/.ccagent/settings.json   (user-wide)\n  .ccagent/settings.json      (project-only)" };
    return { handled: true };
  }
  if (sub === "list" || (!sub && !ask)) {
    yield { type: "command", kind: "info", message: [
      `MCP Servers (${entries.length} configured)`,
      ...entries.map(({ connection, tools }) => `  ${connection.name}: ${status(connection, tools.length)}`),
      "", usage, "Open/Close 保存到当前用户 settings.json；授权仅由 /mcp auth 手动启动。",
    ].join("\n") };
    return { handled: true };
  }
  if (!sub && ask) {
    target = await selectServer(ask) ?? "";
    if (!target) {
      yield { type: "command", kind: "info", message: "MCP selection cancelled; no settings changed." };
      return { handled: true };
    }
    sub = "select";
  } else if (getMcpRegistryEntry(args.join(" "))) {
    target = args.join(" ");
    sub = "select";
  }
  const entry = getMcpRegistryEntry(target);
  if (!entry) {
    if (["open", "close", "auth", "tools", "reconnect"].includes(sub)) {
      yield { type: "command", kind: "error", message: target
        ? `MCP server '${target}' is not configured.` : `Usage: /mcp ${sub} <serverName>` };
      return { handled: true };
    }
    yield { type: "command", kind: "error", message: `Unknown MCP server or command. ${usage}` };
    return { handled: true };
  }
  if (sub === "select") {
    if (!ask) {
      yield { type: "command", kind: "info", message: `${target}: ${status(entry.connection, entry.tools.length)}\nUse /mcp open ${target} or /mcp close ${target}.` };
      return { handled: true };
    }
    const question = `${target}：选择 Open 或 Close（${status(entry.connection, entry.tools.length)}）`;
    const response = await ask({ questions: [{ header: "MCP switch", question, options: [
      { label: "Open", description: "启用并连接；需要授权时使用 /mcp auth，不自动弹浏览器。" },
      { label: "Close", description: "停止连接、取消待处理授权并撤下工具；保留配置与令牌。" },
    ] }] });
    const answer = response?.answers[question]?.toLowerCase();
    if (answer !== "open" && answer !== "close") {
      yield { type: "command", kind: "info", message: "MCP selection cancelled; no settings changed." };
      return { handled: true };
    }
    sub = answer;
  }
  try {
    if (sub === "open" || sub === "close") {
      await setMcpServerOpen(target, sub === "open");
      yield { type: "command", kind: "info", message: `MCP '${target}': ${sub === "open" ? "Open — 已启用，后台连接；用 /mcp list 查看状态。" : "Close — 已关闭，工具已撤下，待处理连接/授权已取消。"}\nSaved to ~/.ccagent/settings.json (mcpServerStates).` };
    } else if (sub === "auth" || sub === "reconnect") {
      if (!isMcpServerEnabled(target, entry.connection.config)) {
        throw new Error(`MCP '${target}' is closed. Use /mcp open ${target} first.`);
      }
      if (sub === "auth" && !(entry.connection.config.type === "http" && entry.connection.config.oauth)) {
        throw new Error(`MCP '${target}' has no browser OAuth configured. Use /mcp reconnect ${target}.`);
      }
      requestMcpReconnect(target, sub === "auth");
      yield { type: "command", kind: "info", message: `MCP '${target}': ${sub === "auth" ? "手动授权已启动，需要时将打开浏览器。" : "后台重连已启动（不会自动弹授权页）。"}\n/mcp list 查看状态；/mcp close ${target} 可随时取消。` };
    } else if (sub === "tools") {
      yield { type: "command", kind: "info", message: [
        `${target}: ${status(entry.connection, entry.tools.length)}`,
        ...entry.tools.map((tool) => `  ${tool.name}: ${tool.description.replace(/\s+/g, " ").slice(0, 100)}`),
      ].join("\n") };
    } else {
      yield { type: "command", kind: "error", message: usage };
    }
  } catch (error) {
    yield { type: "command", kind: "error", message: (error as Error).message };
  }
  return { handled: true };
}
