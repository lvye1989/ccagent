/**
 * Registry command group — `/skills`, `/agents`, `/hooks`, `/mcp`.
 *
 * Extracted verbatim from queryEngine.ts; behavior is unchanged. These are the
 * read-only "what's loaded right now?" inspectors over the various startup
 * registries, plus `/mcp`'s tools/reconnect subcommands. Output is rendered as
 * system notices and never sent to the model.
 */

import { getAllUserInvocableSkills } from "../../../services/skills/registry.js";
import { getAllAgents } from "../../../agents/registry.js";
import { isAgentEnabled } from "../../../agents/preferences.js";
import { handleAgentControlsCommand } from "./agents.js";
import type { ToolContext } from "../../../tools/Tool.js";
import {
  loadHooksDiagnosticReport,
  HOOK_EVENTS,
  type HookEvent,
  type HooksSettings,
} from "../../../hooks/index.js";
import type { QueryEngineEvent } from "../types.js";
import type { CommandContext } from "./context.js";
import { refreshActivePlugins } from "../../../plugins/runtime.js";
import { isAgentSkillsEnabled } from "../../../utils/agentSkillsEnabled.js";

/**
 * Handle `/skills` — list loaded skills, or atomically reload all extension
 * registries with `/skills reload`.
 */
export async function* handleSkillsCommand(
  ctx: CommandContext,
  args: string[] = [],
): AsyncGenerator<QueryEngineEvent, { handled: boolean }> {
  if (args[0]?.toLowerCase() === "reload") {
    const result = await refreshActivePlugins(ctx.cwd);
    const summary = result.summary;
    const lines = [
      `Extensions reloaded: ${summary.enabledPlugins} enabled, ${summary.disabledPlugins} disabled.`,
      `Agent Skills: ${isAgentSkillsEnabled() ? "Open" : "Close (definitions retained, invocation disabled)"} — /agent-skill`,
      `Skills ${summary.skills} · Commands ${summary.commands} · Agents ${summary.agents} · ` +
        `Styles ${summary.outputStyles} · Hooks ${summary.hooks} · MCP ${summary.mcpServers} · ` +
        `Errors ${summary.errors}`,
    ];
    if (result.mcpStarted.length > 0) lines.push(`MCP started: ${result.mcpStarted.join(", ")}`);
    if (result.mcpStopped.length > 0) lines.push(`MCP stopped: ${result.mcpStopped.join(", ")}`);
    if (summary.errors > 0) {
      lines.push(`${summary.errors} issue(s) detected; run /doctor for details.`);
    }
    yield { type: "command", kind: summary.errors > 0 ? "error" : "info", message: lines.join("\n") };
    return { handled: true };
  }

  if (args.length > 0) {
    yield {
      type: "command",
      kind: "error",
      message: `Unknown /skills subcommand: ${args[0]}. Try /skills or /skills reload.`,
    };
    return { handled: true };
  }

  if (!isAgentSkillsEnabled()) {
    yield { type: "command", kind: "info", message: "Agent Skills: Close — 技能已停用，已安装文件保留。使用 /agent-skill open 开启。" };
    return { handled: true };
  }
  const all = getAllUserInvocableSkills();
  if (all.length === 0) {
    yield {
      type: "command",
      kind: "info",
      message:
        "Skills (0 loaded)\n\n" +
        "No skills found. Add a directory containing SKILL.md to:\n" +
        "  ~/.ccagent/skills/<name>/SKILL.md   (user-wide)\n" +
        "  .ccagent/skills/<name>/SKILL.md     (project-only)",
    };
    return { handled: true };
  }
  const lines = [`Skills (${all.length} loaded)`, ""];
  for (const skill of all) {
    const meta: string[] = [skill.source];
    if (skill.frontmatter.disableModelInvocation) meta.push("hidden-from-model");
    if (skill.frontmatter.paths) meta.push(`conditional: ${skill.frontmatter.paths.join(",")}`);
    if (skill.frontmatter.allowedTools.length > 0) {
      meta.push(`allowed-tools: ${skill.frontmatter.allowedTools.join(",")}`);
    }
    lines.push(`  /${skill.name} — ${skill.description}`);
    lines.push(`    ${meta.join(" · ")}`);
  }
  lines.push("", "Invoke a skill with /<name> [args], or let the model call it via the Skill tool.");
  yield { type: "command", kind: "info", message: lines.join("\n") };
  return { handled: true };
}

/**
 * Handle `/agents` — native per-agent Open/Close controls, or a sourced
 * read-only listing with `/agents list` (also used without an interactive UI).
 *
 * The model only sees the agents in the system-prompt <system-reminder>;
 * this command is the human-side answer to "what sub-agent types are
 * available right now?"
 */
export async function* handleAgentsCommand(
  args: string[] = [], ask?: ToolContext["requestUserQuestion"],
): AsyncGenerator<QueryEngineEvent, { handled: boolean }> {
  if ((args.length > 0 && !(args.length === 1 && args[0] === "list")) || (args.length === 0 && ask && getAllAgents().length > 0)) {
    return yield* handleAgentControlsCommand(args, ask);
  }
  const all = getAllAgents();
  if (all.length === 0) {
    yield {
      type: "command",
      kind: "info",
      message:
        "Agents (0 loaded)\n\n" +
        "No agents registered. Built-ins should always be present — if you see\n" +
        "this, the bootstrap may have failed; check the startup logs.\n" +
        "Add custom agents under:\n" +
        "  ~/.ccagent/agents/<name>.md   (user-wide)\n" +
        "  .ccagent/agents/<name>.md     (project-only)",
    };
    return { handled: true };
  }

  // Group by source so a project override is visually adjacent to
  // (and shadowing) its built-in. Order: built-in → user → project.
  const SOURCE_ORDER: Record<string, number> = { "built-in": 0, user: 1, project: 2 };
  const sorted = [...all].sort((a, b) => {
    const cmp = (SOURCE_ORDER[a.source] ?? 99) - (SOURCE_ORDER[b.source] ?? 99);
    if (cmp !== 0) return cmp;
    return a.agentType.localeCompare(b.agentType);
  });

  const lines = [`Agents (${all.length} loaded)`, ""];
  for (const agent of sorted) {
    const tags: string[] = [isAgentEnabled(agent.agentType) ? "Open" : "Close", agent.source];
    if (agent.tools && agent.tools.length > 0) {
      tags.push(`tools: ${agent.tools.join(",")}`);
    } else {
      tags.push("tools: *");
    }
    if (agent.disallowedTools && agent.disallowedTools.length > 0) {
      tags.push(`disallowed: ${agent.disallowedTools.join(",")}`);
    }
    if (agent.model) tags.push(`model: ${agent.model}`);
    if (agent.maxTurns !== undefined) tags.push(`maxTurns: ${agent.maxTurns}`);
    if (agent.permissionMode) tags.push(`mode: ${agent.permissionMode}`);

    const desc = agent.whenToUse.length > 200
      ? `${agent.whenToUse.slice(0, 197)}…`
      : agent.whenToUse;
    lines.push(`  ${agent.agentType} — ${desc}`);
    lines.push(`    ${tags.join(" · ")}`);
    if (agent.filePath) {
      lines.push(`    ${agent.filePath}`);
    }
  }
  lines.push(
    "",
    "Sub-agents are spawned by the model via the `Agent` tool —",
    "you cannot invoke them directly. The model picks `subagent_type` from",
    "the open names listed above, based on the task.",
    "/agents — 逐个选择 Open / Close；/agents open <name>；/agents close <name>。",
  );
  yield { type: "command", kind: "info", message: lines.join("\n") };
  return { handled: true };
}

/**
 * Handle `/hooks` — read-only listing of every configured hook the
 * loader picked up at startup, grouped by event + source. Mirrors
 * source's `commands/hooks/index.ts` + `HooksConfigMenu`, stripped
 * to a text-only listing (no interactive TUI) — CCAGENT
 * deliberately keeps the teaching version's slash UX dead simple.
 *
 * Shows:
 *   - which file path was read for each scope (user / project)
 *   - the kill switch state (CCAGENT_DISABLE_HOOKS)
 *   - per-event matcher groups + the command + timeout
 *
 * The model never sees this output — it's a human-side answer to
 * "what hooks are running right now?".
 */
export async function* handleHooksCommand(
  ctx: CommandContext,
): AsyncGenerator<QueryEngineEvent, { handled: boolean }> {
  const report = await loadHooksDiagnosticReport(ctx.cwd);
  const lines: string[] = [];

  lines.push("Hooks configuration");
  lines.push("");
  if (report.globallyDisabled) {
    lines.push("⚠ CCAGENT_DISABLE_HOOKS is set — all hooks are disabled this session.");
    lines.push("");
  }
  lines.push(`User-scope file:    ${report.userPath}`);
  lines.push(`Project-scope file: ${report.projectPath}`);
  lines.push("");

  const totalHookCount = (scope: HooksSettings): number =>
    HOOK_EVENTS.reduce(
      (sum, ev) =>
        sum +
        (scope[ev] ?? []).reduce((s, g) => s + g.hooks.length, 0),
      0,
    );
  const userTotal = totalHookCount(report.userHooks);
  const projectTotal = totalHookCount(report.projectHooks);

  if (userTotal === 0 && projectTotal === 0) {
    lines.push("No hooks configured. To add one, edit the user or project file above:");
    lines.push("");
    lines.push("  {");
    lines.push('    "hooks": {');
    lines.push('      "PreToolUse": [');
    lines.push('        { "matcher": "Bash", "hooks": [');
    lines.push('          { "type": "command", "command": "./safety-check.sh", "timeout": 10 }');
    lines.push("        ] }");
    lines.push("      ]");
    lines.push("    }");
    lines.push("  }");
    lines.push("");
    lines.push("Six events are supported: " + HOOK_EVENTS.join(", "));
    lines.push("");
    lines.push("Hook contract:");
    lines.push("  - stdin = JSON event payload");
    lines.push("  - exit 0 + stdout text   → injected as additionalContext (for some events)");
    lines.push("  - exit 2 + stderr text   → block the action; stderr fed back to the model");
    lines.push("  - JSON stdout            → richer control (decision / permissionDecision / additionalContext)");
    yield { type: "command", kind: "info", message: lines.join("\n") };
    return { handled: true };
  }

  lines.push(`Loaded ${userTotal + projectTotal} hook command(s) — ${userTotal} user, ${projectTotal} project.`);
  lines.push("");

  const renderScope = (scopeLabel: string, scope: HooksSettings): void => {
    let anyForScope = false;
    for (const event of HOOK_EVENTS) {
      const groups = scope[event] ?? [];
      if (groups.length === 0) continue;
      if (!anyForScope) {
        lines.push(`[${scopeLabel}]`);
        anyForScope = true;
      }
      for (const group of groups) {
        const matcher = group.matcher && group.matcher !== "*" ? group.matcher : "*";
        lines.push(`  ${event}  matcher=${matcher}`);
        for (const hook of group.hooks) {
          const cmdPreview = hook.command.length > 80
            ? `${hook.command.slice(0, 77)}...`
            : hook.command;
          lines.push(`    - $ ${cmdPreview}    (timeout: ${hook.timeout ?? 60}s)`);
        }
      }
    }
    if (anyForScope) lines.push("");
  };

  renderScope("user", report.userHooks);
  renderScope("project", report.projectHooks);

  lines.push("Order of execution: all user groups, then all project groups (in file order).");
  lines.push("Run results aggregate as: deny > ask > allow.");
  lines.push("Set CCAGENT_DISABLE_HOOKS=1 to disable every hook for one session.");

  // Re-cast HookEvent to satisfy the unused-import check after type
  // narrowing eliminates the value usage at runtime. (Compile-only;
  // no runtime cost.)
  void ({} as HookEvent);

  yield { type: "command", kind: "info", message: lines.join("\n") };
  return { handled: true };
}

/**
 * MCP controls use native question cards and local commands, never an LLM.
 */
export { handleMcpCommand } from "./mcp.js";
