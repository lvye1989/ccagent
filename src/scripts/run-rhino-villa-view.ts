/**
 * 把 Rhino 透视图对准刚导入的别墅（图层前缀 别墅_），并抓取视口截图。
 *
 * 为什么要走源码脚本：set_view 带 target_guids 时要求目标出现在同一次新鲜观测里，
 * 而当前文档有 282 个对象，直接 RhinoObserve(object_limit>=282) 会把整份对象表灌进会话上下文。
 * 脚本内部的 observeRhino 用大 objectLimit，但只回传摘要。
 *
 * Usage: npx tsx src/scripts/run-rhino-villa-view.ts --execute [--approve]
 */
import { loadEnv } from "../utils/loadEnv.js";
await loadEnv();

const { rhinoActionTool } = await import("../tools/rhinoTools.js");
const { preflightRhinoActionWithJev } = await import("../tools/rhinoTools.js");
const { observeRhino } = await import("../tools/rhinoBackend.js");

if (!process.argv.includes("--execute")) throw new Error("Live Rhino mutation requires --execute.");

const LAYER_PREFIX = "别墅_";
const OBJECT_LIMIT = 500;

const baseContext = {
  cwd: process.cwd(),
  sessionId: `rhino-villa-view-${Date.now()}`,
  abortSignal: new AbortController().signal,
};

type Observation = Awaited<ReturnType<typeof observeRhino>>;
type ObservedObject = Record<string, unknown>;

function objectsOf(observation: Observation): ObservedObject[] {
  return (observation.objects ?? []) as unknown as ObservedObject[];
}

const before = await observeRhino({ objectLimit: OBJECT_LIMIT });
const doc = (before.document ?? {}) as Record<string, unknown>;
console.log(`document: ${String(doc.name)}  objects=${String(doc.object_count)}  units=${String(doc.units)}`);

const villa = objectsOf(before).filter((item) => String(item.layer).startsWith(LAYER_PREFIX));
console.log(`villa objects found in fresh observation: ${villa.length}`);
if (villa.length === 0) throw new Error(`No objects on layer prefix ${LAYER_PREFIX}.`);

const byLayer = new Map<string, number>();
for (const item of villa) {
  const layer = String(item.layer);
  byLayer.set(layer, (byLayer.get(layer) ?? 0) + 1);
}
for (const [layer, count] of [...byLayer.entries()].sort()) {
  console.log(`   ${layer.padEnd(16)} ${count}`);
}

const guids = villa.map((item) => String(item.guid));
const span = villa.reduce<{ min: number[]; max: number[] }>(
  (acc, item) => {
    const box = item.bounding_box as { min: number[]; max: number[] } | undefined;
    if (!box) return acc;
    for (let i = 0; i < 3; i += 1) {
      acc.min[i] = Math.min(acc.min[i], box.min[i]);
      acc.max[i] = Math.max(acc.max[i], box.max[i]);
    }
    return acc;
  },
  { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] },
);
console.log(`villa bbox: ${span.min.map(n => n.toFixed(2)).join(",")} -> ${span.max.map(n => n.toFixed(2)).join(",")}`);

const input = {
  action: "set_view",
  observation_id: before.observationId,
  intent: "Frame the newly imported modern villa (layer prefix 别墅_) in the perspective viewport for visual review",
  parameters: {
    target_guids: guids,
    direction: [1, -2, -0.42],
    display_mode: "shaded",
    projection: "perspective",
    isolate: false,
  },
};

const decision = await preflightRhinoActionWithJev(input, baseContext as never, []);
console.log(`\nJev: route=${decision.route} permission=${decision.permissionBehavior} ${decision.summary}`);
if (decision.permissionBehavior !== "allow" && !process.argv.includes("--approve")) {
  throw new Error("blocked: Jev did not return allow. Re-run with --approve to authorize once.");
}

const result = await rhinoActionTool.call(input, { ...baseContext, rhinoJevDecision: decision } as never);
const content = typeof result.content === "string" ? result.content : JSON.stringify(result.content);
if (result.isError) throw new Error(`set_view failed: ${content}`);
const payload = JSON.parse(content) as Record<string, unknown>;
console.log(`set_view ok=${String(payload.ok)} message=${String(payload.message)}`);

const capture = await observeRhino({ objectLimit: 1, capture: true });
console.log(`\ncapture_path: ${capture.capturePath ?? "(none)"}`);
