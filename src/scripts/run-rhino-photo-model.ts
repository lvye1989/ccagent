/** Opt-in photo task through the real built-in agent; never runs generated Rhino scripts. */
import { loadEnv } from "../utils/loadEnv.js";
await loadEnv();
const fs = await import("node:fs/promises");
const path = await import("node:path");
const { randomUUID } = await import("node:crypto");
const { runChildAgent } = await import("../agents/runAgent.js");
const { RHINO_AGENT } = await import("../agents/builtIn/rhinoAgent.js");
const { bootstrapAgentStates } = await import("../agents/preferences.js");
const { getAllTools } = await import("../tools/index.js");
const { loadPermissionSettings } = await import("../permissions/permissions.js");
const { loadProfiles } = await import("../services/api/providers/profile.js");
const { observeRhino, getCachedRhinoObservation } = await import("../tools/rhinoBackend.js");
const { rhinoTargetGuids } = await import("../tools/rhinoCatalog.js");
const { getRhinoJevConfig } = await import("../tools/rhinoJev.js");
const { rhinoDesktopDirectory, getRhinoProjectDirectory } = await import("../tools/rhinoProject.js");

if (!process.argv.includes("--execute")) throw new Error("Requires --execute for the authorized live modeling task.");
await bootstrapAgentStates();
const promptIndex = process.argv.indexOf("--prompt-file");
if (promptIndex < 0 || !process.argv[promptIndex + 1]) throw new Error("Provide --prompt-file with the scoped photo task.");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const taskFolder = path.join(rhinoDesktopDirectory(), "CCAGENT-Rhino", `Photo-Courtyard-${stamp}-${randomUUID().slice(0, 6)}`);
process.env.CCAGENT_RHINO_PROJECT_DIR = taskFolder;
const output = getRhinoProjectDirectory();
const prompt = await fs.readFile(path.resolve(process.argv[promptIndex + 1]!), "utf8");
await fs.writeFile(path.join(output, "inputs", "modeling-brief.md"), prompt, { flag: "wx" });
for (const name of ["ScreenShot_2026-09-21_205325_736.png", "ScreenShot_2026-09-21_205354_000.png", "ScreenShot_2026-09-21_205411_511.png", "ScreenShot_2026-09-21_205424_411.png"]) {
  await fs.copyFile(path.join(rhinoDesktopDirectory(), name), path.join(output, "inputs", name), 1);
}
const before = await observeRhino({ objectLimit: 500 });
if (before.objectsTruncated || before.document.units !== "Meters" || before.command?.in_command) throw new Error("Need an idle, untruncated Rhino document in Meters.");
const initialIds = new Set(before.objects.map((item) => String((item as Record<string, unknown>).guid).toLowerCase()));
const serial = before.document.runtime_serial;
await fs.writeFile(path.join(output, "reports", "initial-observation.json"), JSON.stringify(before, null, 2), { flag: "wx" });
const exportPath = path.join(output, "models", "photo-courtyard.3dm");
const profiles = await loadProfiles(process.cwd());
const model = profiles.defaultModel ?? "deepseek";
const settings = await loadPermissionSettings(process.cwd());
const controller = new AbortController();
const deadline = setTimeout(() => controller.abort(), 18 * 60_000);
const events: unknown[] = [];
const started = Date.now();
const emit = (value: unknown) => { events.push(value); console.log(JSON.stringify(value)); };
const deniedActions = new Set(["undo", "run_grasshopper", "layer_manage"]);
function scopedPoint(value: unknown): boolean {
  return Array.isArray(value) && value.length === 3 && value.every(Number.isFinite)
    && value[0] >= 110 && value[0] <= 190 && value[1] >= -45 && value[1] <= 35 && value[2] >= -2 && value[2] <= 22;
}
emit({ type: "start", output, model, document: before.document, jev: { enabled: getRhinoJevConfig().enabled, mode: getRhinoJevConfig().mode } });
try {
  const result = await runChildAgent({
    agentDefinition: { ...RHINO_AGENT, maxTurns: 48 }, prompt: prompt + `\n最终仅导出本任务的新模型到 ${exportPath}，overwrite:false。`,
    availableTools: getAllTools().filter((tool) => tool.name.startsWith("Rhino")), model,
    parentToolContext: { cwd: process.cwd(), sessionId: `photo-courtyard-${stamp}` },
    // Every mutation gets a scoped parent check, including leaves of a Jev sequence.
    permissionMode: "default", permissionSettings: { ...settings, mode: "default", allow: [] },
    abortSignal: controller.signal,
    onPermissionRequest: async (request) => {
      let allowed = request.toolName === "RhinoSequence";
      const p = request.input.parameters as Record<string, unknown> | undefined;
      const action = String(request.input.action ?? "");
      if (request.toolName === "RhinoAction" && p && !deniedActions.has(action)) {
        const observation = getCachedRhinoObservation(String(request.input.observation_id));
        const ids = rhinoTargetGuids(p);
        allowed = observation?.document.runtime_serial === serial;
        for (const id of ids) {
          const item = observation?.objects.find((obj) => String((obj as Record<string, unknown>).guid).toLowerCase() === id) as Record<string, any> | undefined;
          allowed &&= !initialIds.has(id) && Boolean(item?.bounding_box && scopedPoint(item.bounding_box.min) && scopedPoint(item.bounding_box.max));
        }
        if (action === "create_geometry") {
          for (const key of ["point", "start", "end", "min", "max", "center", "base"]) if (p[key]) allowed &&= scopedPoint(p[key]);
          if (Array.isArray(p.points)) allowed &&= p.points.every(scopedPoint);
        }
        if (typeof p.layer === "string") allowed &&= p.layer.startsWith("PhotoCourt_");
        if (action === "set_view") allowed &&= p.isolate !== true;
        if (action === "import_export") allowed &&= p.operation === "export" && path.resolve(String(p.file_path)) === exportPath && p.overwrite !== true && ids.length > 0;
        if (action === "object_state") allowed &&= ids.length > 0 && ["hide", "show", "rename", "delete"].includes(String(p.operation));
      }
      emit({ type: "scoped_permission", tool: request.toolName, action, allowed, elapsed_ms: Date.now() - started });
      return allowed ? "allow_once" : "deny";
    },
    onProgress: (event) => {
      if (event.type === "text") { process.stdout.write(event.text); return; }
      events.push({ ...event, elapsed_ms: Date.now() - started });
      const logged = event.type === "tool_use_done" && event.result
        ? { ...event, result: { ...event.result, content: String(event.result.content).slice(0, 1100) } } : event;
      console.log(JSON.stringify({ ...logged, elapsed_ms: Date.now() - started }));
    },
  });
  const after = await observeRhino({ objectLimit: 500, capture: true });
  const report = { started: stamp, model, output, before, after, result, events };
  await fs.writeFile(path.join(output, "reports", "agent-run.json"), JSON.stringify(report, null, 2));
  const artifact = await fs.stat(exportPath).catch(() => undefined);
  const createdCount = after.objects.filter((item) => !initialIds.has(String((item as Record<string, unknown>).guid).toLowerCase())).length;
  if (!artifact?.isFile() || artifact.size < 1024 || createdCount === 0) {
    throw new Error(`Model task incomplete: agent reason=${result.reason}, new objects=${createdCount}, export bytes=${artifact?.size ?? 0}. Diagnostics: ${output}`);
  }
  emit({ type: "finished", reason: result.reason, calls: result.totalToolUseCount, duration_ms: result.totalDurationMs, output, capture: after.capturePath, final: result.finalText });
} finally {
  clearTimeout(deadline);
  await fs.writeFile(path.join(output, "reports", "events.json"), JSON.stringify(events, null, 2));
}
