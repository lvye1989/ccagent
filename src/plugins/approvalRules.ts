import type { LoadedPlugin } from "./loadedTypes.js";
import type { PluginManifest } from "./schemas.js";

type Rule = NonNullable<PluginManifest["approvalRules"]>[number] & { pluginId: string };
let byTool = new Map<string, Rule[]>();

export function setPluginApprovalRules(plugins: LoadedPlugin[], trust: ReadonlyMap<string, boolean>): void {
  const next = new Map<string, Rule[]>();
  for (const plugin of plugins) {
    if (!trust.get(plugin.pluginId)) continue;
    for (const rule of plugin.manifest.approvalRules ?? []) {
      const list = next.get(rule.tool) ?? [];
      list.push({ ...rule, pluginId: plugin.pluginId });
      next.set(rule.tool, list);
    }
  }
  byTool = next;
}

export function pluginMayRequireApproval(tool: string): boolean {
  return !!byTool.get(tool)?.some(rule => rule.behavior === "ask");
}

export function pluginApprovalRule(tool: string, input: Record<string, unknown>): Rule | undefined {
  let ask: Rule | undefined;
  for (const rule of byTool.get(tool) ?? []) {
    if (rule.operation !== undefined && input.operation !== rule.operation) continue;
    if (rule.behavior === "deny") return rule;
    ask ??= rule;
  }
  return ask;
}
