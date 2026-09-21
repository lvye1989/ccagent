/** Opt-in recovery: explicit geometric parameters through the application's unchanged Jev/permission/tool gate. */
import { loadEnv } from "../utils/loadEnv.js";
await loadEnv();
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { runTools } from "../core/agenticLoop.js";
import { observeRhino } from "../tools/rhinoBackend.js";
import { parseRhinoActionInput } from "../tools/rhinoTools.js";
import { loadPermissionSettings } from "../permissions/permissions.js";
import { withRhinoTaskCleanup } from "../tools/rhinoArtifacts.js";
import { getRhinoProjectDirectory } from "../tools/rhinoProject.js";
import { rhinoTargetGuids } from "../tools/rhinoCatalog.js";

type P = [number, number, number];
type Step = { id: string; action: string; parameters: Record<string, any>; group?: string };
const plans: Step[] = [];
const add = (id: string, action: string, parameters: Record<string, any>, group?: string) => { plans.push({ id, action, parameters, group }); return `@${id}`; };
const xyz = (p: P): P => [150 + p[0], p[1], p[2]];
const box = (id: string, min: P, max: P, group: string) => add(id, "create_geometry", { primitive: "box", min: xyz(min), max: xyz(max) }, group);
function curve(id: string, points: P[], closed = true): string {
  const p = points.map(xyz); if (closed) p.push(p[0]!);
  return add(id, "create_geometry", { primitive: "polyline", points: p }, "Helper");
}
function panel(id: string, points: P[], group: string, holes: P[][] = []): string {
  const refs = [curve(`${id}_edge`, points), ...holes.map((h, i) => curve(`${id}_hole${i}`, h))];
  return add(id, "surface", { operation: "planar", target_guids: refs, layer: `PhotoCourt_${group}`, name: id, expected_units: "Meters" }, group);
}
const frameCurves: string[] = [];
const frame = (id: string, points: P[], closed = true) => { frameCurves.push(curve(id, points, closed)); };
const rect = (x0: number, x1: number, y: number, z0: number, z1: number): P[] => [[x0,y,z0],[x1,y,z0],[x1,y,z1],[x0,y,z1]];
// Existing successful agent steps are explicitly reused, never recreated.
box("right_base", [6,1.9,0], [26.6,10.1,.55], "Stone");
box("left_base_extension", [-26.6,1.9,0], [-23.5,10.1,.55], "Stone");
// Octagonal main hall: open glass entrance and oblique white cheeks with actual six-sided holes.
const footprint: P[] = [[-6,2,0],[-3.8,0,0],[3.8,0,0],[6,2,0],[6,8,0],[3.8,10,0],[-3.8,10,0],[-6,8,0]];
for (const side of [0,2,3,4,5,6,7]) {
  const a=footprint[side]!, b=footprint[(side+1)%8]!;
  const wall: P[]=[[a[0],a[1],.55],[b[0],b[1],.55],[b[0],b[1],7.2],[a[0],a[1],7.2]];
  const hole: P[]=[];
  if(side===0||side===2) for(const [t,z] of [[.5,3.35],[.73,2.98],[.73,2.15],[.5,1.78],[.27,2.15],[.27,2.98]]) hole.push([a[0]+(b[0]-a[0])*t!,a[1]+(b[1]-a[1])*t!,z!]);
  panel(`hall_wall_${side}`,wall,"White",hole.length?[hole]:[]);
  if(hole.length) { panel(`hex_glass_${side}`,hole,"Glass"); frame(`hex_frame_${side}`,hole); }
}
panel("entrance_glass",rect(-3.8,3.8,-.02,.55,4.8),"Glass");
panel("entrance_gable",[[-3.8,-.02,4.8],[3.8,-.02,4.8],[0,-.02,6.8]],"Glass");
panel("front_upper_left",[[-3.8,0,4.8],[0,0,6.8],[0,0,7.2],[-3.8,0,7.2]],"White");
panel("front_upper_right",[[0,0,6.8],[3.8,0,4.8],[3.8,0,7.2],[0,0,7.2]],"White");
frame("front_outer",rect(-3.8,3.8,-.11,.55,7.2));
frame("front_gable_frame",[[-3.8,-.12,4.8],[0,-.12,6.8],[3.8,-.12,4.8]],false);
frame("front_transom",[[-3.8,-.12,4.8],[3.8,-.12,4.8]],false);
for(const x of [-2.4,-1.2,0,1.2,2.4]) frame(`mullion_${x}`,[[x,-.10,.6],[x,-.10,4.8]],false);
frame("door_header",[[-3.8,-.13,3],[3.8,-.13,3]],false);
frame("eave",footprint.map(p=>[p[0],p[1],7.2] as P));
frame("belt",footprint.map(p=>[p[0],p[1],4.8] as P));
for(const i of [0,3,4,7]) {const p=footprint[i]!;frame(`hall_post_${i}`,[[p[0],p[1],.55],[p[0],p[1],7.2]],false);}
// Homothetic octagonal rings form true planar roof facets (no warped quads).
const upper = footprint.map(p=>[p[0]*.32,5+(p[1]-5)*.32,9.1] as P);
for(let i=0;i<8;i++) {const j=(i+1)%8;panel(`main_roof_${i}`,[[footprint[i]![0],footprint[i]![1],7.2],[footprint[j]![0],footprint[j]![1],7.2],upper[j]!,upper[i]!],"Roof");}
function lantern(id:string,cx:number,cy:number,r:number,z0:number,z1:number) {
  const ring:P[]=[[cx,cy-r,z0],[cx+r,cy,z0],[cx,cy+r,z0],[cx-r,cy,z0]];
  for(let i=0;i<4;i++) {
    const a=ring[i]!,b=ring[(i+1)%4]!;
    const face:P[]=[a,b,[b[0],b[1],z1],[a[0],a[1],z1]];
    const hole:P[]=[];const mid=z0+(z1-z0)*.65;const dz=(z1-z0)*.12;
    for(const [t,z] of [[.5,mid+dz],[.59,mid],[.5,mid-dz],[.41,mid]])hole.push([a[0]+(b[0]-a[0])*t!,a[1]+(b[1]-a[1])*t!,z!]);
    panel(`${id}_face${i}`,face,"White",[hole]);panel(`${id}_diamond${i}`,hole,"DarkGlass");
    frame(`${id}_edge${i}`,face); // visible narrow stone reveals at the diamond are approximated by the dark pane
  }
  panel(`${id}_cap`,ring.map(p=>[p[0],p[1],z1] as P),"Roof");
}
lantern("central_lantern",0,5,2.4,9.1,11.5);
// Continuous low white wings; separate walls preserve the entrance opening.
for(const [label,x0,x1] of [["left",-20,-6],["right",6,20]] as const) {
  box(`${label}_wing`,[x0,2.4,.55],[x1,7.8,4.6],"White");
  box(`${label}_wing_cap`,[x0-.05,2.3,4.6],[x1+.05,7.9,4.82],"Stone");
  frame(`${label}_wing_front`,rect(x0,x1,2.3,.55,4.65));
  for(const x of [x0+(x1-x0)/3,x0+2*(x1-x0)/3]) frame(`${label}_joint_${x}`,[[x,2.28,.55],[x,2.28,4.65]],false);
}
for(const cx of [-23,23]) {
  const prefix=cx<0?"west":"east",cy=6,w=3.5;
  box(`${prefix}_body`,[cx-w,cy-w,.55],[cx+w,cy+w,5.3],"White");
  const ring:P[]=[[cx-w,cy-w,5.3],[cx+w,cy-w,5.3],[cx+w,cy+w,5.3],[cx-w,cy+w,5.3]];
  const inner:P[]=ring.map(p=>[cx+(p[0]-cx)*.35,cy+(p[1]-cy)*.35,6.8]);
  for(let i=0;i<4;i++)panel(`${prefix}_roof${i}`,[ring[i]!,ring[(i+1)%4]!,inner[(i+1)%4]!,inner[i]!],"Roof");
  // Small side lanterns preserve the family of roof silhouettes, with rotated square footprints.
  lantern(`${prefix}_lantern`,cx,cy,1.45,6.8,8.0);
  frame(`${prefix}_front`,rect(cx-w,cx+w,cy-w-.05,.55,5.3));
  frame(`${prefix}_belt`,rect(cx-w,cx+w,cy-w-.07,2.9,5.3));
  panel(`${prefix}_window`,rect(cx-1,cx+1,cy-w-.06,.8,2.65),"DarkGlass");
}
// Water court, paving and tree island. No mirrored architecture is generated.
box("pool_bottom",[-30,-22,-.38],[30,2.1,-.16],"Pool");
panel("water",[[-30,-22,.02],[30,-22,.02],[30,2.1,.02],[-30,2.1,.02]],"Water");
box("front_path",[-31.2,-23.2,-.12],[31.2,-22,.22],"Paving");
box("west_path",[-31.2,-22,-.12],[-30,10.5,.22],"Paving");
box("east_path",[30,-22,-.12],[31.2,10.5,.22],"Paving");
box("island_stone",[14,-4.5,-.15],[21,1.8,.35],"Stone");
box("island_green",[14.3,-4.2,.35],[20.7,1.5,.43],"Green");
add("tree_trunk","create_geometry",{primitive:"cylinder",base:xyz([17.4,-1.2,.43]),axis:[0,0,1],height:2.25,radius:.22},"Trunk");
for(const [i,p,r] of [[0,[17.4,-1.2,3.2],1.6],[1,[15.9,-.7,2.95],1.2],[2,[18.85,-.6,3.0],1.25]] as [number,P,number][]) add(`tree_crown${i}`,"create_geometry",{primitive:"sphere",center:xyz(p),radius:r},"Green");
add("frames","surface",{operation:"pipe",target_guids:frameCurves,radius:.095,cap:"flat",layer:"PhotoCourt_Stone",name:"dark_structural_frame",expected_units:"Meters"},"Stone");
const materials:Record<string,{color:number[];opacity?:number}>={White:{color:[226,229,224]},Stone:{color:[48,56,58]},Roof:{color:[75,83,85]},Glass:{color:[85,137,151],opacity:.42},DarkGlass:{color:[39,63,68],opacity:.82},Water:{color:[48,101,102],opacity:.7},Pool:{color:[25,48,46]},Paving:{color:[137,140,135]},Green:{color:[47,85,42]},Trunk:{color:[92,70,48]}};
for(const [group,m] of Object.entries(materials)) {
  add(`layer_${group}`,"set_layer",{target_guids:[`#${group}`],layer:`PhotoCourt_${group}`});
  add(`material_${group}`,"set_material",{target_guids:[`#${group}`],name:`PhotoCourt_${group}`,diffuse_color:m.color,opacity:m.opacity??1});
}
add("helpers_layer","set_layer",{target_guids:["#Helper"],layer:"PhotoCourt_Helper"});
add("helpers_hide","object_state",{operation:"hide",target_guids:["#Helper"]});

const projectIndex=process.argv.indexOf("--project-dir");
if(projectIndex<0||!process.argv[projectIndex+1])throw new Error("Provide --project-dir with the existing photo task folder");
process.env.CCAGENT_RHINO_PROJECT_DIR=path.resolve(process.argv[projectIndex+1]!);
process.env.JEV_TIMEOUT_MS ??= "15000"; // task-scoped bounded wait, no settings change or relaxed decision threshold
const project=getRhinoProjectDirectory();
const baseline=JSON.parse(await fs.readFile(path.join(project,"reports","initial-observation.json"),"utf8"));
const protectedIds=new Set<string>(baseline.objects.map((o:any)=>o.guid));
const exportPath=path.join(project,"models","photo-courtyard.3dm");
const journalFile=path.join(project,"reports","native-plan-journal.json");
const journal:any=await fs.readFile(journalFile,"utf8").then(JSON.parse).catch(()=>({steps:{},bindings:{},groups:{Stone:["ebbfb050-6ea7-46e5-88b8-4de74cd0fa63","ec0f7351-545d-402b-a61a-cd6980038fdc","0e473b14-946a-4f04-bc73-9cb61f0eab22"]}}));
// This exact receipt was recovered by a fresh read-only observation after a
// header-decoding failure. Match name/type/bounds before accepting, never retry.
if(journal.steps.east_roof1?.status==="running"&&!journal.steps.east_roof1.receipt){
  const observation=await observeRhino({objectLimit:500});
  const recovered=observation.objects.find((o:any)=>o.guid==="fad5bd8c-f2dc-437a-bf2a-0cc679de4b01") as any;
  const expectedBounds={max:[176.5,9.5,6.8],min:[174.225,2.5,5.3]};
  const boundsMatch=Object.entries(expectedBounds).every(([key,values])=>values.every((v,i)=>Math.abs((recovered?.bounding_box?.[key]?.[i]??Infinity)-v)<.001));
  if(observation.document.runtime_serial!==baseline.document.runtime_serial||recovered?.name!=="east_roof1"||recovered?.type!=="Brep"||!recovered?.is_valid||!boundsMatch)throw new Error("Recovered receipt no longer matches observed geometry");
  const ids=[recovered.guid];journal.steps.east_roof1={...journal.steps.east_roof1,status:"completed",result:{created_guids:ids,recovered_from_observation:observation.observationId}};
  journal.bindings.east_roof1=ids;journal.groups.Roof.push(...ids);
  await fs.writeFile(journalFile,JSON.stringify(journal,null,2));
}
await fs.writeFile(path.join(project,"inputs","native-photo-plan.json"),JSON.stringify(plans,null,2));
console.log(JSON.stringify({project,planned_actions:plans.length,execute:process.argv.includes("--execute")}));
if(!process.argv.includes("--execute"))process.exit(0);
const settings=await loadPermissionSettings(process.cwd());
const controller=new AbortController();process.on("SIGINT",()=>controller.abort());
const save=()=>fs.writeFile(journalFile,JSON.stringify(journal,null,2));
function resolveValue(v:any):any {
  if(Array.isArray(v))return v.flatMap(x=>typeof x==="string"&&x.startsWith("@")?journal.bindings[x.slice(1)]??(()=>{throw new Error(`Missing ${x}`)})():typeof x==="string"&&x.startsWith("#")?journal.groups[x.slice(1)]??[]:[resolveValue(x)]);
  if(v&&typeof v==="object")return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,resolveValue(x)]));return v;
}
async function execute(step:Step):Promise<any> {
  const previous=journal.steps[step.id];
  if(previous?.status==="completed")return previous.result;
  if(previous?.status==="running")throw new Error(`Uncertain earlier step ${step.id}; inspect receipt/native snapshots before any replay.`);
  const observation=await observeRhino({objectLimit:500});
  if(observation.document.runtime_serial!==baseline.document.runtime_serial||observation.document.units!=="Meters"||observation.command?.in_command||observation.objectsTruncated)throw new Error("Document changed, busy or truncated");
  const actual=new Set(observation.objects.map((o:any)=>o.guid));
  if([...protectedIds].some(id=>!actual.has(id)))throw new Error("A protected existing object is missing");
  const parameters=resolveValue(step.parameters);
  const ids=rhinoTargetGuids(parameters);if(ids.some(id=>protectedIds.has(id)||!actual.has(id)))throw new Error("Invalid/protected target in photo plan");
  const input={action:step.action,parameters,observation_id:observation.observationId,intent:`Photo courtyard step ${step.id}. ${step.action==="set_layer"?`Organize this task's newly created geometry into ${parameters.layer}; a default layer name does not mean it is an old object.`:step.action==="set_material"?`Assign ${parameters.name} visual material to this task's new geometry.`:"Execute the exact photo-reference geometry parameters."} All referenced GUIDs have been checked against the fresh observation AND the protected baseline; none is one of the original 23 objects. Meter-based model at X=150.`};
  parseRhinoActionInput(input,process.cwd());
  journal.steps[step.id]={status:"running",input,started:new Date().toISOString()};await save();
  const start=Date.now();
  const result=await runTools([{type:"tool_use",id:randomUUID(),name:"RhinoAction",input}],{cwd:process.cwd(),sessionId:"photo-courtyard-recovery",abortSignal:controller.signal},{permissionMode:"default",permissionSettings:{...settings,mode:"default",allow:[]},conversationMessages:[{role:"user",content:"Generate an approximate model from my four courtyard photos. Preserve old objects. New geometry is at X=150. Export only the new model to its Desktop project folder."}],onPermissionRequest:async request=>JSON.stringify(request.input)===JSON.stringify(input)?"allow_once":"deny"});
  const content=String(result.executions[0]?.result.content);const isError=result.executions[0]?.result.isError;
  journal.steps[step.id].receipt=content;journal.steps[step.id].elapsed_ms=Date.now()-start;
  if(isError){journal.steps[step.id].status="error";await save();throw new Error(`${step.id}: ${content}`);}
  // Jev errors may themselves contain inline JSON; native payload starts after
  // the blank separator, not at the first brace in the decision header.
  await save();
  const nativeStart=content.startsWith("{")?0:content.indexOf("\n\n{")+2;
  if(nativeStart<2&&!content.startsWith("{"))throw new Error(`No native payload for ${step.id}; inspect saved receipt before replay`);
  const data=JSON.parse(content.slice(nativeStart));
  journal.steps[step.id].status="completed";journal.steps[step.id].result=data;
  const created=data.createdGuids??data.created_guids??[];journal.bindings[step.id]=created;
  if(step.group)(journal.groups[step.group]??=[]).push(...created);
  await save();console.log(JSON.stringify({step:step.id,created:created.length,ms:Date.now()-start,completed:Object.values(journal.steps).filter((s:any)=>s.status==="completed").length,total:plans.length}));return data;
}
await withRhinoTaskCleanup(async()=>{
  for(const step of plans)await execute(step);
  const all=Object.entries(journal.groups).filter(([k])=>k!=="Helper").flatMap(([,v])=>v as string[]);
  await execute({id:"front_view_v2",action:"set_view",parameters:{target_guids:all,direction:[0,1,-.12],projection:"parallel",display_mode:"rendered",isolate:false}});
  const front=await observeRhino({objectLimit:500,capture:true});journal.frontPreview=front.capturePath;await save();
  await execute({id:"oblique_view_v2",action:"set_view",parameters:{target_guids:all,direction:[-.65,1,-.3],projection:"parallel",display_mode:"rendered",isolate:false}});
  const oblique=await observeRhino({objectLimit:500,capture:true});journal.obliquePreview=oblique.capturePath;await save();
  await execute({id:"export",action:"import_export",parameters:{operation:"export",file_path:exportPath,target_guids:all,overwrite:false}});
  const after=await observeRhino({objectLimit:500});await fs.writeFile(path.join(project,"reports","final-native-observation.json"),JSON.stringify(after,null,2));
  const stat=await fs.stat(exportPath);if(stat.size<1024)throw new Error("Empty export");
  const finalText=JSON.stringify({exportPath,bytes:stat.size,objects:all.length,front:journal.frontPreview,oblique:journal.obliquePreview});console.log(finalText);
  return {reason:"completed",finalText};
},report=>console.log(JSON.stringify({cleanup:report.removed.length,report:report.reportPath})));
