/** Opt-in live acceptance run. Uses the real built-in agent and permission gate. */
import { loadEnv } from "../utils/loadEnv.js";
await loadEnv();
const fs = await import("node:fs/promises");
const path = await import("node:path");
const { runChildAgent } = await import("../agents/runAgent.js");
const { RHINO_AGENT } = await import("../agents/builtIn/rhinoAgent.js");
const { getAllTools } = await import("../tools/index.js");
const { loadPermissionSettings } = await import("../permissions/permissions.js");
const { readMergedStringSetting } = await import("../utils/settings.js");
const { observeRhino } = await import("../tools/rhinoBackend.js");

if (!process.argv.includes("--execute")) throw new Error("Live Rhino mutation requires --execute.");
const { getRhinoProjectDirectory } = await import("../tools/rhinoProject.js");
const output = getRhinoProjectDirectory();
// Reuse the same project for the wrapper's export authorization and agent scope.
process.env.CCAGENT_RHINO_PROJECT_DIR = output;
await fs.mkdir(output, {recursive:true});
const stamp = new Date().toISOString().replace(/[:.]/g,"-");
const exportPath = path.join(output, "zun-reference-300m.3dm");
const events: unknown[] = [];
const started = Date.now();
const controller = new AbortController();
const promptOverride = process.argv.indexOf("--prompt-file");
const prompt = promptOverride >= 0 ? await fs.readFile(process.argv[promptOverride + 1]!, "utf8") : `用户要求调用内置 rhino_agent，按提供的中国尊照片重建一栋300米高的塔楼，并增加完整玻璃幕墙。这是已授权的真实建模验收任务，请执行，不要只给计划。
参考图解读：两端外张、连续收腰、圆角矩形且四面微凹；顶部四角略高，中间下凹；银蓝灰玻璃、密集银色竖梃、每层横梁、少量暖白灯光和设备层暗带。保留300m概念尺度，照片不能保证实测准确。
当前原有对象全部保留。新塔中心[0,0,0]，名称 Zun_Reference_300m，图层 ZunRef_300m_Loft。先观察，单位必须Meters。已存在同名塔体时必须复用其GUID，避免重复创建。
用 loft 动作、以下截面[{"z":0,"width":44,"depth":44},{"z":24,"width":40.8,"depth":40.8},{"z":60,"width":36.8,"depth":36.8},{"z":96,"width":33.8,"depth":33.8},{"z":132,"width":31.8,"depth":31.8},{"z":168,"width":30.8,"depth":30.8},{"z":192,"width":30.8,"depth":30.8},{"z":216,"width":31.3,"depth":31.3},{"z":246,"width":32.8,"depth":32.8},{"z":270,"width":34.6,"depth":34.6},{"z":288,"width":36.4,"depth":36.4},{"z":300,"width":38,"depth":38}]，center[0,0,0],corner_ratio:0.15,concavity:0.025,crown_dip:2,cap:false,expected_units:Meters。不要用三个直线剖面代替连续放样。
然后观察并对新塔执行一次 curtain_wall：floors:75,bays_per_side:28,mullion_width:0.10,transom_width:0.12,depth:0.16,glass_opacity:0.78,spandrel_height:0.4,layer_prefix:ZunRef_300m,expected_units:Meters。已存在这些组件时复用。幕墙只需要一个批量工具调用。
再观察，核验10个新增对象左右、8400块玻璃面板和各构件；用set_view对新塔及幕墙GUID设direction:[0.30,-1,-0.10],projection:parallel,display_mode:shaded，然后RhinoObserve(capture:true)。截图路径只表示已捕获，不代表你已经看过图。
最后使用import_export operation:export,file_path:${exportPath},target_guids:[仅新塔及新幕墙真实GUID],overwrite:false。3dm目标GUID导出已支持，使用API不会弹格式对话框。本次用户已授权创建建模成果，父级会在权限回调核对路径和对象后授权。若已有文件则不要覆盖，报告即可。任何报错先分析，不重复已成功动作，不删除旧对象，不运行第三方脚本。
报告实际完成内容、错误、GUID、计数、截图和文件路径。`;
const before = await observeRhino({objectLimit:500});
const initialGuids = new Set(before.objects.map(o=>String((o as Record<string,unknown>).guid)));
const model = await readMergedStringSetting(process.cwd(), "defaultModel") ?? "deepseek";
const settings = await loadPermissionSettings(process.cwd());
const result = await runChildAgent({
  agentDefinition: RHINO_AGENT,
  prompt,
  availableTools: getAllTools(),
  model,
  parentToolContext:{cwd:process.cwd(),sessionId:`rhino-reference-${stamp}`},
  permissionSettings: settings,
  abortSignal: controller.signal,
  onPermissionRequest: async request => {
    const p = request.input.parameters as Record<string,unknown> | undefined;
    const action = request.input.action;
    let allowed = request.toolName === "RhinoObserve";
    if (request.toolName === "RhinoAction" && p) {
      if (action === "loft") allowed = p.name === "Zun_Reference_300m" && p.expected_units === "Meters" && JSON.stringify(p.center) === "[0,0,0]";
      if (["curtain_wall","set_view"].includes(String(action))) {
        const ids = p.target_guids;
        allowed = Array.isArray(ids) && ids.every(id => !initialGuids.has(String(id)) || before.objects.some(o=>String((o as Record<string,unknown>).guid)===id && /ZunRef|Zun_Reference/.test(JSON.stringify(o))));
      }
      if (action === "import_export") allowed = p.operation === "export" && path.resolve(String(p.file_path)) === exportPath && p.overwrite !== true && Array.isArray(p.target_guids) && p.target_guids.every(id=>!initialGuids.has(String(id)) || before.objects.some(o=>String((o as Record<string,unknown>).guid)===id && /ZunRef|Zun_Reference/.test(JSON.stringify(o))));
    }
    const event = {type:"scoped_user_authorization",elapsed_ms:Date.now()-started,action,allowed,summary:request.summary};
    events.push(event); console.log(JSON.stringify(event));
    return allowed ? "allow_once" : "deny";
  },
  onProgress:event=>{
    if(event.type === "text") { process.stdout.write(event.text); return; }
    const logged = {...event,elapsed_ms:Date.now()-started};
    events.push(logged);
    console.log(JSON.stringify(event.type === "tool_use_done" ? {...logged,result: event.result ? {...event.result,content:String(event.result.content).slice(0,1500)} : undefined} : logged));
    if (event.type === "tool_use_done" && event.isError) controller.abort();
  },
});
const after = await observeRhino({objectLimit:500,capture:true});
const report = {started_at:stamp,model,before,after,result,events};
const reportPath = path.join(output,`rhino-agent-run-${stamp}.json`);
await fs.writeFile(reportPath,JSON.stringify(report,null,2)+"\n","utf8");
console.log(JSON.stringify({reportPath,reason:result.reason,tool_calls:result.totalToolUseCount,duration_ms:result.totalDurationMs,final:result.finalText,capture:after.capturePath},null,2));
