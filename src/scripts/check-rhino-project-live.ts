/** Read-only live diagnosis; --export additionally requests a user-authorized .3dm copy via the real agent. */
import { loadEnv } from "../utils/loadEnv.js";
await loadEnv();
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import * as path from "node:path";
import { getRhinoProjectDirectory, writeRhinoProjectReport } from "../tools/rhinoProject.js";
import { observeRhino } from "../tools/rhinoBackend.js";
import { runChildAgent } from "../agents/runAgent.js";
import { RHINO_AGENT } from "../agents/builtIn/rhinoAgent.js";
import { rhinoObserveTool, rhinoInspectTool, rhinoActionTool } from "../tools/rhinoTools.js";
import { loadPermissionSettings } from "../permissions/permissions.js";
import { readMergedStringSetting } from "../utils/settings.js";

if (!process.argv.includes("--execute")) throw new Error("Pass --execute for live observation; --export also authorizes a new project copy (never overwrites).");
const project = getRhinoProjectDirectory();
process.env.CCAGENT_RHINO_PROJECT_DIR = project;
const start = Date.now();
const before = await observeRhino({ objectLimit: 500 });
console.log(JSON.stringify({ project, document: before.document, command: before.command,
  objects: before.objects.map((obj: any) => ({ guid: obj.guid, name: obj.name, layer: obj.layer, type: obj.type, component: obj.ccagent_component })) }, null, 2));
if (process.argv.includes("--export")) {
  assert.equal(before.objectsTruncated, false, "Refuse an incomplete project export");
  const ids = before.objects.map((obj: any) => String(obj.guid)).sort();
  const file = path.join(project, "models", `中国尊-完整文档-${randomUUID().slice(0, 8)}.3dm`);
  const events: unknown[] = [];
  const result = await runChildAgent({
    agentDefinition: { ...RHINO_AGENT, maxTurns: 8 },
    prompt: `检查当前 Rhino 文档并保存已有模型的完整副本。只允许观察、只读测量、一次 .3dm 导出，不创建、删除、变换几何或更改视口。先 RhinoObserve，核对文档 runtime_serial=${before.document.runtime_serial}，对象数量=${ids.length}，再用 RhinoInspect measure 做只读测量（先 capabilities 查看正确 schema）。观察 capture:true 获取当前预览，然后重新观察并导出全部对象到 ${file}，overwrite:false，target_guids:${JSON.stringify(ids)}。用户明确授权此新文件的非覆盖导出；实际权限回调会核对路径。导出后观察确认对象和文档状态未变。不要执行 Grasshopper 或计算机输入。任何问题准确报告。`,
    availableTools: [rhinoObserveTool, rhinoInspectTool, rhinoActionTool],
    model: await readMergedStringSetting(process.cwd(), "defaultModel") ?? "deepseek",
    parentToolContext: { cwd: process.cwd(), sessionId: `rhino-diagnosis-${randomUUID()}` },
    permissionSettings: await loadPermissionSettings(process.cwd()),
    onPermissionRequest: async request => {
      const p = request.input.parameters as Record<string, unknown> | undefined;
      const allowed = request.toolName === "RhinoAction" && request.input.action === "import_export" && p?.operation === "export"
        && p.file_path === file && p.overwrite === false && Array.isArray(p.target_guids) && JSON.stringify([...p.target_guids].sort()) === JSON.stringify(ids);
      events.push({ type: "scoped_authorization", allowed, file });
      return allowed ? "allow_once" : "deny";
    },
    onProgress: event => {
      events.push(event);
      if (event.type === "text") process.stdout.write(event.text);
      else if (event.type === "tool_use_done") console.log(JSON.stringify({ ...event,
        result: event.result ? { ...event.result, content: String(event.result.content).slice(0, 600) } : undefined }));
    },
  });
  const after = await observeRhino({ objectLimit: 500 });
  const report = writeRhinoProjectReport(`diagnosis-${randomUUID()}.json`, { before, after, result, events, file, durationMs: Date.now() - start });
  assert.deepEqual(after.objects, before.objects, "Current document geometry/attributes must be unchanged");
  assert.deepEqual(after.layers, before.layers, "Layers must be unchanged");
  assert.deepEqual(after.selection, before.selection, "Selection must be unchanged");
  assert.equal(after.document.modified, before.document.modified);
  assert.equal(result.reason, "completed");
  assert.ok((await stat(file)).size > 0, "Agent must actually export a nonempty file");
  console.log(JSON.stringify({ passed: true, file, report, objectCount: ids.length, durationMs: Date.now() - start }));
} else {
  console.log(writeRhinoProjectReport(`observation-${randomUUID()}.json`, before));
}
