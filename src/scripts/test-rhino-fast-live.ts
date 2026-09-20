/** Opt-in read-only real LLM -> RhinoSequence -> Jev -> native inspection acceptance. */
import { loadEnv } from "../utils/loadEnv.js";
await loadEnv();
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { observeRhino } from "../tools/rhinoBackend.js";
import { rhinoSequenceTool } from "../tools/rhinoSequence.js";
import { getRhinoProjectDirectory, writeRhinoProjectReport } from "../tools/rhinoProject.js";
import { runChildAgent, type AgentProgressEvent } from "../agents/runAgent.js";
import { RHINO_AGENT } from "../agents/builtIn/rhinoAgent.js";
import { loadPermissionSettings } from "../permissions/permissions.js";
import { readMergedStringSetting } from "../utils/settings.js";

if (!process.argv.includes("--execute")) throw new Error("Pass --execute to run read-only native inspections and real model requests.");
process.env.CCAGENT_RHINO_PROJECT_DIR = getRhinoProjectDirectory();
const before = await observeRhino({ objectLimit: 500 });
const target = before.objects.find((item: any) => item.ccagent_component === "loft_skin") as Record<string, unknown> | undefined;
assert.ok(target && typeof target.guid === "string", "Read-only fixture requires the existing reference loft");
const plan = { plan_id: `readonly-${randomUUID()}`, intent: "Read-only inspection of the existing observed tower surface; no edits, export or UI changes", steps: [
  { id: "measure", action: "inspect", parameters: { operation: "measure", target_guids: [target.guid], max_items: 10 } },
  { id: "section", action: "inspect", parameters: { operation: "section", target_guids: [target.guid], origin: [0, 0, 150], normal: [0, 0, 1], max_items: 10 } },
  { id: "nearest", action: "inspect", parameters: { operation: "closest_point", target_guids: [target.guid], point: [50, 0, 150], max_items: 10 } },
] };
const events: AgentProgressEvent[] = [];
const started = Date.now();
const result = await runChildAgent({
  agentDefinition: { ...RHINO_AGENT, tools: ["RhinoSequence"], maxTurns: 3 }, availableTools: [rhinoSequenceTool],
  prompt: `请使用本次只读验收提供的现有塔体 GUID，原样调用一次 RhinoSequence：${JSON.stringify(plan)}。不新增/修改几何、不导出、不调整视口、不调用其它工具。如果返回 handoff，准确报告原因并停止，不重试或改变参数。完成后用中文简短汇报实际耗时、Jev 决策和检查结果。`,
  parentToolContext: { cwd: process.cwd(), sessionId: `fast-live-${randomUUID()}` },
  model: await readMergedStringSetting(process.cwd(), "defaultModel") ?? "deepseek",
  permissionSettings: await loadPermissionSettings(process.cwd()),
  onPermissionRequest: async () => "deny", // No writes or elevated approval in this test.
  onProgress: event => {
    events.push(event);
    if (event.type === "text") process.stdout.write(event.text);
    else if (event.type === "tool_use_done") console.log(JSON.stringify({ ...event, result: { ...event.result, content: String(event.result?.content).slice(0, 1600) } }));
  },
});
const after = await observeRhino({ objectLimit: 500 });
const reportPath = writeRhinoProjectReport(`fast-live-${randomUUID()}.json`, { before, after, result, events, durationMs: Date.now() - started });
assert.deepEqual(after.objects, before.objects); assert.deepEqual(after.layers, before.layers); assert.deepEqual(after.selection, before.selection);
assert.deepEqual(after.document, before.document, "Read-only fast lane must preserve the user's document");
const calls = events.filter((e): e is Extract<AgentProgressEvent, { type: "tool_use_done" }> => e.type === "tool_use_done");
assert.equal(calls.length, 1, "The LLM should submit one plan, not three individual inspection turns");
assert.equal(calls[0].toolName, "RhinoSequence");
assert.ok(!calls[0].result?.isError, String(calls[0].result?.content));
const receipt = JSON.parse(String(calls[0].result?.content));
assert.equal(receipt.status, "completed"); assert.equal(receipt.completed_steps.length, 3);
assert.equal(receipt.metrics.jev_calls, 3); assert.equal(receipt.metrics.llm_round_trips_inside_sequence, 0);
assert.ok(receipt.steps.every((step: any) => step.jev.available && step.jev.mode === "enforce"));
console.log(JSON.stringify({ passed: true, reportPath, metrics: receipt.metrics, documentUnchanged: true, overallMs: Date.now() - started }, null, 2));
