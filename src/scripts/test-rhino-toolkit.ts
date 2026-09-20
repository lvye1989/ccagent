import assert from "node:assert/strict";
import { RHINO_EXTENDED_SCHEMAS, rhinoTargetGuids, rhinoCapabilities, parseGrasshopper } from "../tools/rhinoCatalog.js";
import { parseRhinoActionInput, rhinoInspectTool, rhinoActionTool } from "../tools/rhinoTools.js";
import { buildRhinoJevRequest, interpretRhinoJevResponse, requiresTargetValidation, type RhinoJevObservation } from "../tools/rhinoJev.js";
import { checkPermission } from "../permissions/permissions.js";
import { findToolByName } from "../tools/index.js";

const id="00000000-0000-4000-8000-000000000001";
const rail="00000000-0000-4000-8000-000000000002";
const base={observation_id:"obs",intent:"test common modeling operations"};
let checks=0;
function test(name:string,fn:()=>void){fn();checks++;console.log(`  ✓ ${name}`);}
const parse=(action:string,parameters:Record<string,unknown>)=>parseRhinoActionInput({...base,action,parameters},process.cwd());
const cases: Record<string,Record<string,unknown>> = {
  create_curve:{operation:"circle",radius:5}, create_solid:{operation:"torus",major_radius:5,minor_radius:1},
  curve_edit:{operation:"offset",target_guids:[id],distance:1}, surface:{operation:"sweep1",target_guids:[id],rail_guids:[rail]},
  solid_edit:{operation:"fillet_edges",target_guids:[id],edge_indices:[0],radius:1}, mesh:{operation:"reduce",target_guids:[id],face_count:100},
  subd:{operation:"subdivide",target_guids:[id],levels:2},copy_objects:{operation:"polar_array",target_guids:[id],center:[0,0,0],count:4},
  object_state:{operation:"rename",target_guids:[id],name:"Tower"},layer_manage:{operation:"color",layer:"Facade",color:[10,20,30]},
  group_manage:{operation:"create",group:"Tower",target_guids:[id]},
};
for(const action of Object.keys(RHINO_EXTENDED_SCHEMAS)) {
  test(`${action}: valid schema`,()=>assert.equal(parse(action,cases[action]).action,action));
  test(`${action}: reject code/unknown fields`,()=>assert.throws(()=>parse(action,{...cases[action],command:"_Delete",script:"arbitrary code"})));
  test(`${action}: reject unknown operation`,()=>assert.throws(()=>parse(action,{...cases[action],operation:"execute"})));
  test(`${action}: discoverable exact schema`,()=>assert.ok(rhinoCapabilities(action)));
}
test("geometry operations preserve sources by default",()=>assert.equal(parse("solid_edit",cases.solid_edit).parameters.delete_inputs,false));
test("revolve rejects zero axis",()=>assert.throws(()=>parse("surface",{operation:"revolve",target_guids:[id],axis_start:[0,0,0],axis_end:[0,0,0]})));
test("nurbs degree cannot exceed control point count",()=>assert.throws(()=>parse("create_curve",{operation:"nurbs",points:Array(4).fill([0,0,0]),degree:5})));
test("array object budget enforced",()=>assert.throws(()=>parse("copy_objects",{operation:"linear_array",target_guids:Array.from({length:10},(_,i)=>`00000000-0000-4000-8000-${String(i+1).padStart(12,"0")}`),vector:[1,0,0],count:500})));
test("duplicate targets rejected",()=>assert.throws(()=>parse("object_state",{operation:"delete",target_guids:[id,id]})));
test("nonfinite dimensions rejected",()=>assert.throws(()=>parse("create_curve",{operation:"circle",radius:Infinity})));
test("negative topology index rejected",()=>assert.throws(()=>parse("solid_edit",{...cases.solid_edit,edge_indices:[-1]})));
test("missing layer state value rejected",()=>assert.throws(()=>parse("layer_manage",{operation:"visibility",layer:"Facade"})));
test("missing group targets rejected",()=>assert.throws(()=>parse("group_manage",{operation:"add",group:"Tower"})));
test("oversized source payload rejected",()=>assert.throws(()=>parse("create_curve",{operation:"circle",radius:1,name:"x".repeat(100001)})));

const gh={definition_path:"fixture.gh",operation:"solve",inputs:[{parameter_id:id,type:"geometry",branches:[{path:[0],values:[rail]}]}],outputs:[{component_id:id,output_index:0}]};
test("Grasshopper defaults remain backwards compatible",()=>assert.equal(parseGrasshopper({definition_path:"fixture.gh"},process.cwd()).operation,"solve"));
test("geometry references include GH nested data trees",()=>assert.deepEqual(rhinoTargetGuids(parseGrasshopper(gh,process.cwd())),[rail]));
test("sweep rail references are snapshotted",()=>assert.deepEqual(rhinoTargetGuids(cases.surface),[id,rail]));
test("GH code fields rejected",()=>assert.throws(()=>parseGrasshopper({...gh,code:"print(1)"},process.cwd())));
test("GH bake requires explicit outputs",()=>assert.throws(()=>parseGrasshopper({definition_path:"fixture.gh",operation:"bake"},process.cwd())));
test("GH inspector cannot set input data",()=>assert.throws(()=>parseGrasshopper({...gh,operation:"inspect"},process.cwd())));
test("GH geometry must be GUIDs",()=>assert.throws(()=>parseGrasshopper({...gh,inputs:[{parameter_id:id,type:"geometry",branches:[{path:[0],values:["some model code"]}]}]},process.cwd())));
test("GH wrong typed values rejected",()=>assert.throws(()=>parseGrasshopper({...gh,inputs:[{parameter_id:id,type:"point",branches:[{path:[0],values:[42]}]}]},process.cwd())));
test("GH repeated input GUIDs rejected",()=>assert.throws(()=>parseGrasshopper({...gh,inputs:[gh.inputs[0],gh.inputs[0]]},process.cwd())));
test("GH repeated tree paths rejected",()=>assert.throws(()=>parseGrasshopper({...gh,inputs:[{...gh.inputs[0],branches:[gh.inputs[0].branches[0],gh.inputs[0].branches[0]]}]},process.cwd())));
test("GH input work budget enforced",()=>assert.throws(()=>parseGrasshopper({definition_path:"fixture.gh",inputs:[{parameter_id:id,type:"number",branches:Array.from({length:6},(_,i)=>({path:[i],values:Array(2000).fill(1)}))}]},process.cwd())));

const observation:RhinoJevObservation={observationId:"obs",capturedAt:new Date().toISOString(),document:{},layers:[],selection:[],objects:[{guid:id},{guid:rail}],command:{},undo:{}};
test("Jev sees sweep rails",()=>assert.equal(((buildRhinoJevRequest("surface",cases.surface,observation).state as any).observation.action_targets as unknown[]).length,2));
test("Jev sees GH geometry targets",()=>assert.ok(requiresTargetValidation("run_grasshopper",parseGrasshopper(gh,process.cwd()))));
test("new curves do not request nonexistent targets",()=>assert.equal(requiresTargetValidation("create_curve",cases.create_curve),false));
test("targeted mesh with low target validity still requires observation",()=>assert.equal(interpretRhinoJevResponse({model:"typesafe/jev-test",answers:{route:{type:"choice",choice:"rhino_api",confidence:0.99},next_action:{type:"choice",choice:"mesh",confidence:0.99},target_valid:{type:"noul",noul:0.2}}},"mesh",{mode:"enforce",model:"typesafe/jev-test",minConfidence:0.8},cases.mesh).forceObserve,true));

for(const [action,parameters] of [["object_state",{operation:"delete",target_guids:[id]}],["curve_edit",{operation:"join",target_guids:[id],delete_inputs:true}],["solid_edit",{...cases.solid_edit,delete_inputs:true}],["mesh",{...cases.mesh,delete_inputs:true}],["layer_manage",{operation:"delete_empty",layer:"A"}],["run_grasshopper",{definition_path:"fixture.gh",operation:"inspect"}],["run_grasshopper",{definition_path:"fixture.gh",operation:"bake"}]] as const){
  const decision=await checkPermission({tool:rhinoActionTool,input:{action,parameters},cwd:process.cwd(),settings:{mode:"full",allow:["RhinoAction(*)"],deny:[]}});
  test(`${action}/${(parameters as Record<string,unknown>).operation}: fresh permission required`,()=>assert.equal(decision.behavior,"ask"));
}
test("read-only inspector is registered",()=>assert.equal(findToolByName("RhinoInspect"),rhinoInspectTool));
test("inspector is read-only",()=>assert.ok(rhinoInspectTool.isReadOnly()));
const capabilities=await rhinoInspectTool.call({operation:"capabilities",action:"run_grasshopper"},{cwd:process.cwd()});
test("capabilities works without launching Rhino",()=>assert.ok(!capabilities.isError && String(capabilities.content).includes("parameter_id")));
const stale=await rhinoInspectTool.call({operation:"measure",observation_id:"missing",target_guids:[id]},{cwd:process.cwd()});
test("geometry inspector refuses stale observations",()=>assert.equal(stale.isError,true));
console.log(`\nRhino toolkit: ${checks} checks passed.`);
