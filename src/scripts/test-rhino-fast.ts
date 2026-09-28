import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { rhinoSequenceTool, parseRhinoSequence, validateRhinoFastInput } from "../tools/rhinoSequence.js";
import { buildRhinoJevRequest, canDispatchRhinoFastStep, canExecuteRhinoFastStep, interpretRhinoJevResponse, RHINO_ACTIONS, RHINO_TOOL_CATALOG, type RhinoJevDecision } from "../tools/rhinoJev.js";
import { runTools } from "../core/agenticLoop.js";
import { getEnabledToolManifest } from "../tools/index.js";
import { rhinoActionTool } from "../tools/rhinoTools.js";
import { checkPermission } from "../permissions/permissions.js";
import { RHINO_EXTENDED_ACTIONS } from "../tools/rhinoCatalog.js";
import type { ToolContext, ToolResult } from "../tools/Tool.js";
import { resetSettingsCache } from "../config/sources.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "ccagent-rhino-fast-test-"));
const env = { ...process.env };
Object.assign(process.env, { CCAGENT_HOME: path.join(root, "user"), CCAGENT_RHINO_PROJECT_DIR: path.join(root, "project"), OPENROUTER_API_KEY: "TEST_ONLY", CCAGENT_RHINO_JEV: "1", CCAGENT_RHINO_JEV_MODE: "enforce", CCAGENT_RHINO_FAST: "1" });
await fs.mkdir(process.env.CCAGENT_HOME!, { recursive: true });
let checks = 0;
function check(ok: unknown, label: string) { assert.ok(ok, label); console.log(`OK ${++checks}. ${label}`); }
const guid = "00000000-0000-4000-8000-000000000001";
const decision: RhinoJevDecision = { configured: true, available: true, mode: "enforce", model: "test", route: "rhino_api", nextAction: "create_geometry", routeConfidence: 0.99, parametersValid: 0.99, destructive: 0.01, expectedProgress: 0.99, targetValid: 0.99, permissionBehavior: "allow", summary: "fixture", durationMs: 2 };
const plan = () => ({ plan_id: randomUUID(), intent: "Create one point then move it", steps: [
  { id: "point", action: "create_geometry", parameters: { primitive: "point", point: [0, 0, 0] } },
  { id: "move", action: "transform", targets_from: "point", parameters: { operation: "translate", vector: [1, 0, 0] } },
] });
const json = (value: unknown): ToolResult => ({ content: JSON.stringify(value) });
function bridge(options: { failObservation?: number; nativeError?: boolean; postHookError?: boolean; switchDocument?: boolean; truncate?: boolean; cancelAfterAction?: AbortController; omitDeletionReceipt?: boolean } = {}) {
  let observations = 0; let mutations = 0; const calls: Array<{ name: string; input: Record<string, any> }> = [];
  const objects: Array<{ guid: string; is_valid: boolean }> = [];
  const context: ToolContext = { cwd: root, sessionId: randomUUID(), runRhinoFastTool: async (name, input) => {
    calls.push({ name, input });
    if (name === "RhinoObserve") {
      observations++;
      if (observations === options.failObservation) return { result: { content: "observation failed", isError: true }, toolDispatched: true };
      const result = json({ observation_id: `obs-${observations}`, document: { runtime_serial: options.switchDocument && mutations ? 2 : 1, units: "Meters" }, objects: [...objects], objects_truncated: options.truncate ?? false });
      return { result, rawResult: result, toolDispatched: true };
    }
    assert.equal(input.observation_id, `obs-${observations}`);
    if (input.action === "transform") assert.deepEqual((input.parameters as any).target_guids, [guid]);
    mutations++;
    if (input.action === "create_geometry") objects.push({ guid, is_valid: true });
    if (input.action === "object_state" && (input.parameters as Record<string, unknown> | undefined)?.operation === "delete") objects.splice(0, objects.length);
    options.cancelAfterAction?.abort();
    const rawResult = options.nativeError ? { content: "native failure after possible partial work", isError: true } : json({ ok: true,
      created_guids: input.action === "create_geometry" ? [guid] : [],
      deleted_guids: input.action === "object_state" && !options.omitDeletionReceipt ? [guid] : [], snapshot_path: "preserved.json" });
    return { result: options.postHookError ? { content: "post hook blocks continuation", isError: true } : rawResult, rawResult, toolDispatched: true, jevDecision: { ...decision, nextAction: input.action } };
  } };
  return { context, calls, mutations: () => mutations };
}

try {
  check(canExecuteRhinoFastStep(decision, "create_geometry", {}), "Complete confident Jev evidence can continue");
  for (const override of [{ available: false }, { mode: "shadow" }, { nextAction: "undo" }, { route: "ask_user" }, { permissionBehavior: "ask" }, { parametersValid: undefined }, { destructive: undefined }, { expectedProgress: 0.2 }, { routeConfidence: 0.5 }, { forceObserve: true }]) {
    check(!canExecuteRhinoFastStep({ ...decision, ...override } as RhinoJevDecision, "create_geometry", {}), `Fail closed for ${JSON.stringify(override)}`);
  }
  check(!canExecuteRhinoFastStep({ ...decision, nextAction: "transform", targetValid: undefined }, "transform", { target_guids: [guid] }), "Referenced targets require target_valid evidence");
  const highImpact = { ...decision, nextAction: "object_state" as const, destructive: 0.9, permissionBehavior: "ask" as const };
  check(!canExecuteRhinoFastStep(highImpact, "object_state", { operation: "delete", target_guids: [guid] })
    && canDispatchRhinoFastStep(highImpact, "object_state", { operation: "delete", target_guids: [guid] }), "High-impact Jev review reaches the central gate without automatic approval");
  check(!canDispatchRhinoFastStep({ ...highImpact, expectedProgress: 0.1 }, "object_state", { operation: "delete", target_guids: [guid] }), "Low-progress high-impact action cannot enter the gate as a fast step");
  for (const [action, parameters] of [
    ["object_state", { operation: "delete", target_guids: [guid] }],
    ["layer_manage", { operation: "delete_empty", layer: "Test" }],
    ["import_export", { operation: "export", file_path: path.join(root, "project", "models", "test.3dm") }],
    ["run_grasshopper", { operation: "inspect", definition_path: path.join(root, "test.gh") }],
  ] as const) {
    const verdict = await checkPermission({ tool: rhinoActionTool, input: { action, parameters }, cwd: root,
      mode: "auto", settings: { mode: "auto", allow: [], deny: [] }, precomputedAutoDecision: { behavior: "allow", reason: "fixture" } });
    check(verdict.behavior === "ask", `${action} retains deterministic high-impact confirmation`);
  }
  const observed = { observationId: "test", capturedAt: new Date().toISOString(), document: {}, layers: [], objects: [], selection: [], command: {}, undo: {} };
  const full = buildRhinoJevRequest("create_geometry", {}, observed);
  const manifest = getEnabledToolManifest();
  const fast = buildRhinoJevRequest("create_geometry", {}, observed, [], true, manifest);
  check(JSON.stringify(fast).length < JSON.stringify(full).length, "Fast Jev request omits unrelated action choices");
  const toolsList = (fast.state as any).tools_list;
  check(toolsList.registry_revision === manifest.revision && toolsList.top_level_tools.includes("RhinoAction"), "Rhino Jev uses the live enabled-tool registry after observation");
  check(toolsList.catalog.length === RHINO_ACTIONS.length + 1 && RHINO_ACTIONS.every(action => toolsList.available_actions.includes(action)), "Fast Jev sees every implemented Rhino action family");
  check(toolsList.catalog.find((entry: any) => entry.action === "surface").operations.includes("sweep2")
    && toolsList.catalog.find((entry: any) => entry.action === "run_grasshopper").operations.includes("bake")
    && toolsList.catalog.find((entry: any) => entry.action === "inspect").operations.includes("section"), "Rhino tools_list includes extended, Grasshopper and inspection operations");
  check(RHINO_TOOL_CATALOG.filter(entry => (RHINO_EXTENDED_ACTIONS as readonly string[]).includes(entry.action)).reduce((count, entry) => count + entry.operations.length, 0) === 67, "All 67 implemented extended Rhino operations are discoverable");
  check(toolsList.catalog.every((entry: any) => entry.sequence_candidate === true), "Every discovered Rhino action and sub-operation is sequence-eligible");
  check(toolsList.allowed_actions.length === 1 && toolsList.allowed_actions[0] === "create_geometry", "Full discovery never expands the executable fast step");
  const withoutInspect = buildRhinoJevRequest("create_geometry", {}, observed, [], true, { ...manifest, tools: manifest.tools.filter(tool => tool.name !== "RhinoInspect") });
  check(!(withoutInspect.state as any).tools_list.available_actions.includes("inspect"), "Disabled Rhino tools are absent from Jev discovery");
  const inspection = interpretRhinoJevResponse({ model: "test", answers: { route: { type: "choice", choice: "rhino_api", confidence: 0.99 }, next_action: { type: "choice", choice: "inspect" }, parameters_valid: { type: "noul", noul: 0.99 }, target_valid: { type: "noul", noul: 0.99 }, destructive: { type: "noul", noul: 0.01 }, expected_progress: { type: "noul", noul: 0.99 } } }, "inspect", { mode: "enforce", model: "test", minConfidence: 0.8 }, { target_guids: [guid] });
  check(!inspection.forceObserve && canExecuteRhinoFastStep(inspection, "inspect", { target_guids: [guid] }), "Jev can select exact read-only inspection without a reobserve loop");
  const newlyEligible = [
    ["curve_edit", { operation: "join", target_guids: [guid] }],
    ["surface", { operation: "planar", target_guids: [guid] }],
    ["solid_edit", { operation: "cap", target_guids: [guid] }],
    ["mesh", { operation: "join", target_guids: [guid] }],
    ["subd", { operation: "from_mesh", target_guids: [guid] }],
    ["object_state", { operation: "delete", target_guids: [guid] }],
    ["layer_manage", { operation: "delete_empty", layer: "Test" }],
    ["group_manage", { operation: "create", group: "Test", target_guids: [guid] }],
    ["boolean", { operation: "union", target_guids: [guid], cutter_guids: [guid] }],
    ["run_grasshopper", { operation: "inspect", definition_path: path.join(root, "test.gh") }],
    ["import_export", { operation: "export", file_path: "models/test.3dm", overwrite: false }],
    ["undo", {}],
  ] as const;
  for (const [action, parameters] of newlyEligible) {
    parseRhinoSequence({ ...plan(), steps: [{ id: "new", action, parameters }] }, root);
    check(true, `${action} passes fast-plan validation with its own schema`);
  }
  parseRhinoSequence({ ...plan(), steps: [{ id: "capabilities", action: "inspect", parameters: { operation: "capabilities", action: "surface" } }] }, root);
  check(true, "RhinoInspect capabilities is eligible without geometry targets");
  assert.throws(() => parseRhinoSequence({ ...plan(), steps: [{ id: "unsupported", action: "Bash", parameters: {} }] }, root));
  check(true, "Unimplemented tool remains excluded");
  const tooMany = plan(); tooMany.steps = Array.from({ length: 9 }, (_, i) => ({ ...plan().steps[0], id: `step${i}` }));
  assert.throws(() => parseRhinoSequence(tooMany, root)); check(true, "At most eight steps");
  assert.throws(() => parseRhinoSequence({ ...plan(), steps: [{ ...plan().steps[1], targets_from: "future" }] }, root)); check(true, "Forward or arbitrary GUID binding rejected");
  parseRhinoSequence({ ...plan(), steps: [{ id: "delete_source", action: "extrude", parameters: { target_guids: [guid], direction: [0, 0, 1], delete_inputs: true } }] }, root);
  check(true, "Destructive parameter is sequence-eligible and remains subject to the central permission gate");
  assert.throws(() => validateRhinoFastInput("RhinoAction", { action: "extrude", parameters: { target_guids: [guid], direction: [0, 0, 1], arbitrary_script: "bad" }, observation_id: "test", intent: "bad" }, root));
  check(true, "Fast steps still reject invalid action parameters");
  for (const operation of ["closest_point", "section", "intersection"]) {
    assert.throws(() => parseRhinoSequence({ ...plan(), steps: [{ id: "bad", action: "inspect", parameters: { operation, target_guids: [guid] } }] }, root));
    check(true, `Operation-specific ${operation} parameters validated before the first step`);
  }
  const successful = bridge(); const input = plan();
  const result = await rhinoSequenceTool.call(input, successful.context); const report = JSON.parse(result.content as string);
  check(!result.isError && report.completed_steps.length === 2 && successful.calls.length === 5, "Two actions use three observations, no redundant pre-action observation");
  check(report.metrics.llm_round_trips_inside_sequence === 0 && report.metrics.jev_calls === 2, "Trace reports no intermediate LLM call and two Jev decisions");
  check((await fs.stat(report.report_path)).size > 0, "Durable plan and actual receipts saved outside repository");
  const deletePlan = () => ({ plan_id: randomUUID(), intent: "Create then delete one test object", steps: [
    { id: "point", action: "create_geometry", parameters: { primitive: "point", point: [0, 0, 0] } },
    { id: "delete", action: "object_state", targets_from: "point", parameters: { operation: "delete" } },
  ] });
  const deleted = bridge(); const deletedResult = await rhinoSequenceTool.call(deletePlan(), deleted.context); const deletedReport = JSON.parse(deletedResult.content as string);
  check(!deletedResult.isError && deletedReport.completed_steps.length === 2 && deletedReport.steps[1].observed_deleted_guids.includes(guid), "Reported deletion is verified against the fresh observation");
  const missingDeletion = bridge({ omitDeletionReceipt: true }); const missingResult = await rhinoSequenceTool.call(deletePlan(), missingDeletion.context);
  check(missingResult.isError && JSON.parse(missingResult.content as string).executed_steps.includes("delete"), "Unreported deletion stops continuation without replaying the action");
  await rhinoSequenceTool.call(input, successful.context); check(successful.mutations() === 2, "Identical plan retry returns receipt without duplicate mutation");
  const changed = await rhinoSequenceTool.call({ ...input, intent: "different" }, successful.context); check(changed.isError, "Same plan id cannot silently change meaning");
  const concurrent = bridge(); const concurrentPlan = plan();
  await Promise.all([rhinoSequenceTool.call(concurrentPlan, concurrent.context), rhinoSequenceTool.call(concurrentPlan, concurrent.context)]);
  check(concurrent.mutations() === 2, "Concurrent duplicate plan executes only once");
  for (const options of [{ failObservation: 2 }, { switchDocument: true }, { postHookError: true }]) {
    const fixture = bridge(options); const p = plan(); const response = await rhinoSequenceTool.call(p, fixture.context); const receipt = JSON.parse(response.content as string);
    check(response.isError && receipt.executed_steps[0] === "point" && fixture.mutations() === 1, `Preserve executed receipt and stop: ${JSON.stringify(options)}`);
    await rhinoSequenceTool.call(p, fixture.context); check(fixture.mutations() === 1, "Partial failure is not replayed");
  }
  const nativeFailure = bridge({ nativeError: true }); const failed = await rhinoSequenceTool.call(plan(), nativeFailure.context);
  check(JSON.parse(failed.content as string).uncertain_steps[0] === "point", "Uncertain partial mutation explicitly requires inspection, never blind retry");
  const truncated = bridge({ truncate: true }); await rhinoSequenceTool.call(plan(), truncated.context); check(truncated.mutations() === 0, "Truncated observation prevents action");
  const controller = new AbortController(); const cancelled = bridge({ cancelAfterAction: controller }); cancelled.context.abortSignal = controller.signal;
  await rhinoSequenceTool.call(plan(), cancelled.context); check(cancelled.mutations() === 1 && cancelled.calls.length === 2, "Abort prevents the next observation/action");
  const direct = await rhinoSequenceTool.call(plan(), { cwd: root, sessionId: "no-gate" }); check(direct.isError, "Direct calls cannot bypass central executor");
  const disabled = bridge(); process.env.CCAGENT_RHINO_FAST = "0";
  check((await rhinoSequenceTool.call(plan(), disabled.context)).isError && disabled.calls.length === 0, "Disabled fast mode starts no native call");
  process.env.CCAGENT_RHINO_FAST = "1"; process.env.CCAGENT_RHINO_JEV_MODE = "shadow";
  check((await rhinoSequenceTool.call(plan(), disabled.context)).isError && disabled.calls.length === 0, "Shadow mode cannot run fast steps");
  process.env.CCAGENT_RHINO_JEV_MODE = "enforce";
  // Real central permission path, with all native execution denied (no Rhino/network needed).
  resetSettingsCache();
  const originalFetch = globalThis.fetch; let network = 0;
  globalThis.fetch = (async () => { network++; throw new Error("Unexpected network request"); }) as typeof fetch;
  try {
    for (const mode of ["auto", "full"] as const) {
      const central = await runTools([{ type: "tool_use", id: randomUUID(), name: "RhinoSequence", input: plan() }], { cwd: root, sessionId: randomUUID() }, {
        permissionMode: mode, permissionSettings: { mode, allow: [], deny: ["RhinoObserve"] },
      });
      check(central.executions[0].result.isError && String(central.executions[0].result.content).includes("explicit RhinoObserve deny"), `Central leaf deny remains active in ${mode} mode`);
    }
    check(network === 0, "No redundant LLM/general Jev classifier on the sequence wrapper");
  } finally { globalThis.fetch = originalFetch; }
  console.log(`Rhino fast lane: ${checks} checks passed.`);
} finally {
  for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
  Object.assign(process.env, env); resetSettingsCache();
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert.match(path.basename(root), /^ccagent-rhino-fast-test-/);
  await fs.rm(root, { recursive: true, force: true });
}
