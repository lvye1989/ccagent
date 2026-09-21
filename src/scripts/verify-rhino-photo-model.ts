/** Real built-in rhino_agent read-only acceptance after the scoped native photo plan. */
import { loadEnv } from "../utils/loadEnv.js";
await loadEnv();
const fs=await import("node:fs/promises");const path=await import("node:path");
const {execFileSync}=await import("node:child_process");
const {observeRhino}=await import("../tools/rhinoBackend.js");
const {runChildAgent}=await import("../agents/runAgent.js");
const {RHINO_AGENT}=await import("../agents/builtIn/rhinoAgent.js");
const {getAllTools}=await import("../tools/index.js");
const {loadProfiles}=await import("../services/api/providers/profile.js");
const {bootstrapAgentStates}=await import("../agents/preferences.js");
const {loadPermissionSettings}=await import("../permissions/permissions.js");
const folder=path.resolve(process.argv[2]??"");
process.env.CCAGENT_RHINO_PROJECT_DIR=folder;
const journal=JSON.parse(await fs.readFile(path.join(folder,"reports","native-plan-journal.json"),"utf8"));
const before=JSON.parse(await fs.readFile(path.join(folder,"reports","initial-observation.json"),"utf8"));
const after=await observeRhino({objectLimit:500,capture:true});
const existing=new Map(after.objects.map((o:any)=>[o.guid,o]));
const originalChanges=before.objects.filter((o:any)=>{
  const a=existing.get(o.guid) as any;
  if(!a||["name","layer","hidden","locked","type"].some(k=>a[k]!==o[k]))return true;
  return ["min","max"].some(k=>o.bounding_box[k].some((v:number,i:number)=>Math.abs(v-a.bounding_box[k][i])>.001));
});
if(originalChanges.length)throw new Error("Original document objects changed");
const model=path.join(folder,"models","photo-courtyard.3dm");
const fileCheck=JSON.parse(execFileSync("python",["-c",`import rhino3dm as r,json,sys,collections
m=r.File3dm.Read(sys.argv[1])
layers={layer.Index:layer.Name for layer in m.Layers}
print(json.dumps({'objects':len(m.Objects),'ids':[str(o.Attributes.Id) for o in m.Objects],'invalid':[str(o.Attributes.Id) for o in m.Objects if not o.Geometry.IsValid],'hidden':[str(o.Attributes.Id) for o in m.Objects if not o.Attributes.Visible],'units':str(m.Settings.ModelUnitSystem),'layer_counts':dict(collections.Counter(layers[o.Attributes.LayerIndex] for o in m.Objects))}))`,model],{encoding:"utf8",windowsHide:true}));
const expected=Object.entries(journal.groups).filter(([k])=>k!=="Helper").flatMap(([,v])=>v as string[]);
if(fileCheck.invalid.length||fileCheck.hidden.length||fileCheck.objects!==expected.length||expected.some(id=>!fileCheck.ids.includes(id)))throw new Error("Export geometry failed acceptance");
await fs.copyFile(after.capturePath!,path.join(folder,"previews","courtyard-perspective.png"));
await fs.copyFile(journal.frontPreview,path.join(folder,"previews","courtyard-front.png"));
const manifest={model,bytes:(await fs.stat(model)).size,fileCheck,original_objects_preserved:before.objects.length,new_object_count:expected.length,capture:after.capturePath,created_with:"built-in rhino_agent initial run; Codex-reviewed fixed parameter plan through runTools / Jev / RhinoAction; final built-in rhino_agent read-only acceptance",precision:"Photo-proportioned conceptual reconstruction, not measured as-built geometry"};
await fs.writeFile(path.join(folder,"reports","model-verification.json"),JSON.stringify(manifest,null,2));
console.log(JSON.stringify(manifest));
await bootstrapAgentStates();const settings=await loadPermissionSettings(process.cwd());const profiles=await loadProfiles(process.cwd());
const targetIds=[...journal.bindings.hall_wall_0,...journal.bindings.entrance_glass,...journal.bindings.main_roof_0];
const result=await runChildAgent({
  agentDefinition:{...RHINO_AGENT,maxTurns:5},
  prompt:`请作为 rhino_agent 对本次照片参考模型做只读验收，不要建模、改视角或导出。成果文件 ${model} 已由独立 rhino3dm 检查：${expected.length}个有效可见对象，单位Meters，原来23个对象全部保留。请只做两步：第一轮 RhinoObserve(object_limit:500)，收到真实 observation_id 后，第二轮 RhinoInspect(operation:measure,target_guids:${JSON.stringify(targetIds)},max_items:3,observation_id:实际返回值)。不要同时发观察与依赖它的检查。三对象分别是带六边形窗洞的侧墙、入口玻璃和一片折面屋顶。然后用中文汇报实际验收结果，并说明这是照片比例概念模型，不是一比一测绘模型。所有修改工具已禁止，无需再调用capabilities。`,
  availableTools:getAllTools().filter(t=>["RhinoObserve","RhinoInspect"].includes(t.name)),model:profiles.defaultModel??"deepseek",
  parentToolContext:{cwd:process.cwd(),sessionId:"photo-courtyard-acceptance"},permissionMode:"default",
  permissionSettings:{...settings,mode:"default",allow:[],deny:[...settings.deny,"RhinoAction(*)","RhinoSequence(*)","ComputerAction(*)","ComputerNavigate(*)"]},
  onPermissionRequest:async()=>"deny",
  onProgress:e=>{if(e.type==="text")process.stdout.write(e.text);else console.log(JSON.stringify(e.type==="tool_use_done"?{...e,result:{...e.result,content:String(e.result?.content).slice(0,250)}}:e));},
});
await fs.writeFile(path.join(folder,"reports","rhino-agent-acceptance.json"),JSON.stringify(result,null,2));
console.log(JSON.stringify({reason:result.reason,calls:result.totalToolUseCount,final:result.finalText}));
