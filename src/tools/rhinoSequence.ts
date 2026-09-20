/** Bounded LLM plan -> Jev decisions -> centrally gated native tools, without LLM round trips. */
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Tool, ToolContext, ToolResult } from "./Tool.js";
import { parseRhinoActionInput } from "./rhinoTools.js";
import { RHINO_INSPECT_SCHEMA } from "./rhinoCatalog.js";
import { getRhinoJevConfig, type RhinoJevDecision } from "./rhinoJev.js";
import { writeRhinoProjectReport } from "./rhinoProject.js";

const ACTIONS = ["inspect", "create_geometry", "create_curve", "create_solid", "loft", "curtain_wall", "floor_plates", "extrude", "transform", "copy_objects", "set_layer", "set_material", "set_view"] as const;
const stepSchema = z.object({
  id: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,47}$/),
  action: z.enum(ACTIONS), parameters: z.record(z.string(), z.unknown()),
  targets_from: z.string().optional(),
}).strict();
const schema = z.object({
  plan_id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  intent: z.string().trim().min(1).max(1000),
  steps: z.array(stepSchema).min(1).max(8),
  capture_final: z.boolean().default(false),
}).strict();
type Plan = z.infer<typeof schema>;
const SAMPLE = "00000000-0000-4000-8000-000000000001";

/** Rechecked inside the central execution gate, not merely by the outer plan. */
export function validateRhinoFastInput(name: string, input: Record<string, unknown>, cwd: string): void {
  if (name === "RhinoObserve") return;
  if (name === "RhinoInspect") {
    const p = RHINO_INSPECT_SCHEMA.parse(input);
    if (p.operation === "capabilities" || !p.target_guids?.length || !p.observation_id) throw new Error("Fast inspection requires observed geometry targets");
    if (p.operation === "closest_point" && !p.point) throw new Error("closest_point requires point");
    if (p.operation === "section" && (!p.origin || !p.normal)) throw new Error("section requires origin and normal");
    if (p.operation === "intersection" && p.target_guids.length !== 2) throw new Error("intersection requires exactly two target_guids");
    return;
  }
  if (name !== "RhinoAction" || !ACTIONS.includes(input.action as typeof ACTIONS[number]) || input.action === "inspect") {
    throw new Error("Action is outside the Rhino fast whitelist; use separately gated RhinoAction");
  }
  const p = parseRhinoActionInput(input, cwd).parameters;
  if (p.delete_inputs === true || p.overwrite === true || p.isolate === true) throw new Error("Destructive/overwrite/isolation operations cannot run in the fast lane");
}

export function parseRhinoSequence(input: Record<string, unknown>, cwd: string): Plan {
  if (JSON.stringify(input).length > 64_000) throw new Error("RhinoSequence exceeds the 64 KB plan limit");
  const plan = schema.parse(JSON.parse(JSON.stringify(input)));
  const prior = new Set<string>();
  for (const step of plan.steps) {
    if (prior.has(step.id)) throw new Error("Duplicate step id");
    if (step.targets_from && (!prior.has(step.targets_from) || step.parameters.target_guids !== undefined)) throw new Error("targets_from must reference an earlier step and cannot override explicit targets");
    const parameters = { ...step.parameters, ...(step.targets_from ? { target_guids: step.action === "loft" || step.parameters.operation === "intersection" ? [SAMPLE, "00000000-0000-4000-8000-000000000002"] : [SAMPLE] } : {}) };
    validateRhinoFastInput(step.action === "inspect" ? "RhinoInspect" : "RhinoAction",
      step.action === "inspect" ? { ...parameters, observation_id: "prevalidation" } : { action: step.action, parameters, intent: plan.intent, observation_id: "prevalidation" }, cwd);
    prior.add(step.id);
  }
  return plan;
}

function decode(result: ToolResult): Record<string, any> {
  if (result.isError || typeof result.content !== "string") throw new Error(String(result.content).slice(0, 2000));
  const value = JSON.parse(result.content);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid native tool payload");
  return value;
}
function errorText(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 2000); }

async function execute(plan: Plan, context: ToolContext): Promise<ToolResult> {
  const started = Date.now();
  const steps: Array<Record<string, any>> = [];
  const bindings = new Map<string, string[]>();
  let observation: Record<string, any> | undefined;
  let status = "completed";
  let stoppedReason: string | undefined;
  let nativeCalls = 0;
  const decisions: RhinoJevDecision[] = [];
  const uncertain: string[] = [];
  let failedStep: string | undefined;
  const invoke = async (name: "RhinoObserve" | "RhinoInspect" | "RhinoAction", input: Record<string, unknown>, preserveReceipt = false) => {
    if (context.abortSignal?.aborted) throw new Error("Aborted; no next step was started");
    nativeCalls++;
    const call = await context.runRhinoFastTool!(name, input);
    if (call.jevDecision) decisions.push(call.jevDecision as RhinoJevDecision);
    if (call.result.isError) {
      if (preserveReceipt && call.rawResult && !call.rawResult.isError) {
        return { data: decode(call.rawResult), decision: call.jevDecision as RhinoJevDecision | undefined, gateError: String(call.result.content) };
      }
      if (name === "RhinoAction" && (call.toolDispatched || call.rawResult)) uncertain.push(failedStep!);
      throw new Error(String(call.result.content));
    }
    return { data: decode(call.rawResult ?? call.result), decision: call.jevDecision as RhinoJevDecision | undefined, gateError: undefined };
  };
  try {
    observation = (await invoke("RhinoObserve", { object_limit: 500 })).data;
    for (const step of plan.steps) {
      failedStep = step.id;
      if (Date.now() - started > 90_000) throw new Error("90-second continuation budget reached; remaining steps were not started");
      if (observation.objects_truncated) throw new Error("Observation is truncated; return to LLM for narrower target selection");
      if (observation.current_command?.in_command) throw new Error("Rhino has an active command; return to LLM/user");
      const targets = step.targets_from ? bindings.get(step.targets_from) : undefined;
      if (step.targets_from && !targets?.length) throw new Error(`Step ${step.targets_from} created no bindable GUIDs`);
      const parameters = { ...step.parameters, ...(targets ? { target_guids: targets } : {}) };
      const input = step.action === "inspect" ? { ...parameters, observation_id: observation.observation_id }
        : { action: step.action, intent: plan.intent, observation_id: observation.observation_id, parameters };
      const call = await invoke(step.action === "inspect" ? "RhinoInspect" : "RhinoAction", input, true);
      // Record success BEFORE verifying. A subsequent observation failure must
      // never suggest the additive action was not executed and should be retried.
      const created = (call.data.createdGuids ?? call.data.created_guids ?? []) as string[];
      const receipt = { id: step.id, action: step.action, executed: true, verified: false, result: call.data, jev: call.decision, verified_targets: [] as Record<string, unknown>[] };
      steps.push(receipt); bindings.set(step.id, created);
      if (call.gateError) throw new Error(`Step executed but post-execution gate stopped continuation: ${call.gateError}`);
      const after = (await invoke("RhinoObserve", { object_limit: 500 })).data;
      if (after.objects_truncated || after.document.runtime_serial !== observation.document.runtime_serial || after.document.units !== observation.document.units
        || after.document.path !== observation.document.path || after.document.name !== observation.document.name) {
        throw new Error("Document changed or verification was truncated; stop without retry/rollback");
      }
      const actual = new Map<string, any>(after.objects.map((obj: any) => [obj.guid, obj]));
      if (observation.objects.some((obj: any) => !actual.has(obj.guid))) throw new Error("Unexpected object removal detected; stop for review");
      if (created.some(id => !actual.has(id) || actual.get(id).is_valid === false)) throw new Error("Created object missing/invalid after action; stop for review");
      const checkedIds = [...new Set([...created, ...((parameters.target_guids as string[] | undefined) ?? [])])];
      receipt.verified_targets = checkedIds.slice(0, 30).map(id => {
        const object = actual.get(id) ?? {};
        return { guid: id, type: object.type, is_valid: object.is_valid, is_solid: object.is_solid, bounding_box: object.bounding_box };
      });
      receipt.verified = true;
      observation = after;
    }
    if (plan.capture_final) observation = (await invoke("RhinoObserve", { object_limit: 500, capture: true })).data;
    failedStep = undefined;
  } catch (error) { status = "handoff"; stoppedReason = errorText(error); }
  const report = { plan_id: plan.plan_id, status, completed_steps: steps.filter(s => s.verified).map(s => s.id),
    executed_steps: steps.map(s => s.id), uncertain_steps: uncertain, stopped_step: failedStep, reason: stoppedReason, steps,
    final_observation_id: observation?.observation_id, document: observation?.document, capture_path: observation?.capture_path,
    metrics: { elapsed_ms: Date.now() - started, tool_attempts: nativeCalls, jev_calls: decisions.filter(d => d.durationMs !== undefined).length,
      jev_ms: decisions.reduce((sum, d) => sum + (d.durationMs ?? 0), 0), llm_round_trips_inside_sequence: 0 },
    next_step: status === "handoff" ? "Return to LLM/user. Never replay executed or uncertain steps; inspect uncertain effects first. Export, deletion and GH require ordinary separately confirmed RhinoAction." : "Verify the summary; do not replay this plan_id." };
  let reportPath: string | undefined;
  try { reportPath = writeRhinoProjectReport(`fast-${plan.plan_id}-${randomUUID()}.json`, { plan, ...report, decisions }); }
  catch (error) { status = "handoff"; report.status = status; report.reason = `Audit report failed: ${errorText(error)}`; }
  const compactSteps = steps.map(step => JSON.stringify(step.result).length <= 6000 ? step : { ...step, result: {
    truncated: true, details_in_report: true, created_guids: step.result.createdGuids?.slice(0, 60) ?? step.result.created_guids?.slice(0, 60),
    snapshot_path: step.result.snapshotPath ?? step.result.snapshot_path, operation: step.result.operation,
    results: step.result.results?.slice(0, 3),
  } });
  return { content: JSON.stringify({ ...report, steps: compactSteps, report_path: reportPath }, null, 2), ...(status !== "completed" ? { isError: true } : {}) };
}

// In-session replay protection, including partial failure and concurrent duplicate calls.
const ledger = new Map<string, { hash: string; result: Promise<ToolResult> }>();
export const rhinoSequenceTool: Tool = {
  name: "RhinoSequence",
  description: "Fast bounded Rhino plan: submit 1-8 validated ordinary steps once. Jev decides each exact step; the runtime observes/verifies automatically through the normal permission gate without intermediate LLM turns. Actions: inspect (read-only RhinoInspect parameters), create_geometry/create_curve/create_solid, loft, curtain_wall, floor_plates, extrude, transform, copy_objects, set_layer, set_material, set_view. targets_from binds only actual created GUIDs of one earlier step. No export/import/delete/boolean/undo/GH/third-party scripts or isolate:true. Stops on uncertainty/error, never auto-retries mutations. Reusing a plan_id within this session returns the original receipt; new work needs a new plan_id.",
  inputSchema: z.toJSONSchema(schema, { io: "input" }) as Tool["inputSchema"],
  maxResultSizeChars: 100_000,
  async call(input, context) {
    try {
      if (process.env.CCAGENT_RHINO_FAST === "0") throw new Error("Rhino fast lane is disabled; use normal tools");
      const config = getRhinoJevConfig();
      if (!config.enabled || config.mode !== "enforce") throw new Error("Fast lane requires Jev enforce with a configured API key; use normal LLM review/confirmation");
      if (!context.runRhinoFastTool || !context.sessionId) throw new Error("RhinoSequence requires the central agent execution gate and session identity");
      const plan = parseRhinoSequence(input, context.cwd);
      const key = `${context.sessionId}\0${plan.plan_id}`;
      const hash = createHash("sha256").update(JSON.stringify(plan)).digest("hex");
      const previous = ledger.get(key);
      if (previous) {
        if (previous.hash !== hash) throw new Error("plan_id was already used with different steps; no new operation was started");
        return previous.result;
      }
      // Do not evict a replay receipt and accidentally authorize a duplicate plan.
      if (ledger.size >= 500) throw new Error("Fast receipt limit reached; use normal tools or start a new application session");
      const result = execute(plan, context); ledger.set(key, { hash, result });
      return result;
    } catch (error) { return { content: `RhinoSequence stopped before execution: ${errorText(error)}`, isError: true }; }
  },
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  isEnabled: () => process.platform === "win32" && process.env.CCAGENT_RHINO_FAST !== "0",
};
