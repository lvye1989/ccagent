/**
 * Opt-in live acceptance run for the floor_plates architecture action.
 *
 * Adds one merged floor-slab mesh plus one core-tube mesh to the existing
 * Zun_Reference_300m loft. Goes through the real RhinoAction tool:
 * fresh RhinoObserve -> Jev preflight -> gated execution -> verification observe.
 *
 * Re-runnable: objects left on the slab/core layers by an earlier run are removed
 * first, so repeated runs do not stack duplicates. The loft itself is never touched.
 *
 * Usage: npx tsx src/scripts/run-rhino-floor-plates.ts --execute [--approve]
 */
import { loadEnv } from "../utils/loadEnv.js";
await loadEnv();

const { rhinoActionTool } = await import("../tools/rhinoTools.js");
const { preflightRhinoActionWithJev } = await import("../tools/rhinoTools.js");
const { observeRhino } = await import("../tools/rhinoBackend.js");

if (!process.argv.includes("--execute")) throw new Error("Live Rhino mutation requires --execute.");

const LOFT_LAYER = "ZunRef_300m_Loft";
const LAYER_PREFIX = "ZunRef_300m";
const OWNED_LAYERS = new Set([`${LAYER_PREFIX}_floor_plates`, `${LAYER_PREFIX}_core_tube`]);
const PARAMETERS = {
  floors: 75,
  slab_thickness: 0.15,
  inset: 0.3,
  core_width: 18,
  core_depth: 18,
  layer_prefix: LAYER_PREFIX,
  expected_units: "Meters",
};

type Observation = Awaited<ReturnType<typeof observeRhino>>;
type ObservedObject = Record<string, unknown>;

const baseContext = {
  cwd: process.cwd(),
  sessionId: `rhino-floor-plates-${Date.now()}`,
  abortSignal: new AbortController().signal,
};

function objectsOf(observation: Observation): ObservedObject[] {
  return (observation.objects ?? []) as unknown as ObservedObject[];
}

function summarize(observation: Observation, label: string): void {
  const document = (observation.document ?? {}) as Record<string, unknown>;
  console.log(`\n── ${label} ──`);
  console.log(`  object_count: ${String(document.object_count)}`);
  for (const item of objectsOf(observation)) {
    const box = item.bounding_box as { min: number[]; max: number[] } | undefined;
    const span = box ? `${box.min.map(n => n.toFixed(3)).join(",")} -> ${box.max.map(n => n.toFixed(3)).join(",")}` : "";
    console.log(
      `  ${String(item.guid).slice(0, 8)}  ${String(item.layer).padEnd(32)} ${String(item.type).padEnd(6)} `
      + `${item.ccagent_component ? String(item.ccagent_component).padEnd(17) : "".padEnd(17)} ${span}`,
    );
  }
}

async function runAction(input: Record<string, unknown>, label: string): Promise<Record<string, unknown>> {
  const decision = await preflightRhinoActionWithJev(input, baseContext as never, []);
  console.log(
    `\n[${label}] Jev: route=${decision.route} permission=${decision.permissionBehavior} `
    + `${decision.forceObserve ? "forceObserve " : ""}${decision.summary}`,
  );
  if (decision.permissionBehavior !== "allow" && !process.argv.includes("--approve")) {
    throw new Error(`${label} blocked: Jev did not return allow. Re-run with --approve to authorize once.`);
  }
  const result = await rhinoActionTool.call(input, { ...baseContext, rhinoJevDecision: decision } as never);
  const content = typeof result.content === "string" ? result.content : JSON.stringify(result.content);
  if (result.isError) throw new Error(`${label} failed: ${content}`);
  return JSON.parse(content) as Record<string, unknown>;
}

// 1. Clean up anything an earlier run of this script left behind.
let observation = await observeRhino({ objectLimit: 40 });
summarize(observation, "BEFORE");

const stale = objectsOf(observation).filter((item) => OWNED_LAYERS.has(String(item.layer)));
if (stale.length > 0) {
  const guids = stale.map((item) => String(item.guid));
  console.log(`\nremoving ${guids.length} object(s) from a previous run: ${guids.join(", ")}`);
  await runAction(
    {
      action: "object_state",
      observation_id: observation.observationId,
      intent: "Remove the floor-plate and core-tube objects left by the previous run of this same script",
      parameters: { operation: "delete", target_guids: guids },
    },
    "cleanup",
  );
  observation = await observeRhino({ objectLimit: 40 });
}

// 2. Resolve the loft target from the fresh observation.
const loft = objectsOf(observation).find(
  (item) => item.layer === LOFT_LAYER && item.type === "Brep" && typeof item.guid === "string",
);
if (!loft) throw new Error(`No Brep on layer ${LOFT_LAYER}; cannot place floor plates.`);
const loftGuid = String(loft.guid);
console.log(`\nloft target: ${loftGuid}`);
console.log(`parameters : ${JSON.stringify(PARAMETERS)}`);

// 3. Build the slabs and core tube.
const result = await runAction(
  {
    action: "floor_plates",
    observation_id: observation.observationId,
    intent: "Add one floor slab per storey plus an 18x18 m full-height core tube to the reference tower",
    parameters: { target_guids: [loftGuid], ...PARAMETERS },
  },
  "floor_plates",
);

console.log("\n── floor_plates result ──");
for (const key of ["floors", "plate_count", "failed_floors", "slab_thickness", "inset", "core_width", "core_depth", "core_top_z", "floor_z_range", "usable_top_z", "floor_spacing", "source_guid"]) {
  if (result[key] !== undefined) console.log(`  ${key}: ${JSON.stringify(result[key])}`);
}
console.log(`  created: ${JSON.stringify(result.created_guids)}`);
if (Array.isArray(result.components)) {
  for (const component of result.components as Record<string, unknown>[]) {
    console.log(`  component ${String(component.component)}: count=${String(component.count)} faces=${String(component.mesh_faces)} guid=${String(component.guid)}`);
  }
}

// 4. Verify with an independent observation.
const after = await observeRhino({ objectLimit: 40 });
summarize(after, "AFTER");
