import { z } from "zod";
import * as path from "node:path";

const n = z.number().finite();
const positive = n.positive();
const point = z.tuple([n, n, n]);
const vector = point.refine(v => v.some(x => x !== 0), "vector must not be zero");
const guid = z.string().uuid();
const ids = z.array(guid).min(1).max(500).refine(v => new Set(v.map(x => x.toLowerCase())).size === v.length, "duplicate GUIDs are not allowed");
const label = z.string().trim().min(1).max(128);
const color = z.tuple([n.int().min(0).max(255), n.int().min(0).max(255), n.int().min(0).max(255)]);
const plane = { origin: point.default([0,0,0]), normal: vector.default([0,0,1]) };
const output = { layer: label.optional(), name: label.optional(), expected_units: label.optional() };
const targets = { target_guids: ids };
const keep = { delete_inputs: z.boolean().default(false) };
const boundedIndex = n.int().min(0).max(1000000);
const indices = z.array(boundedIndex).min(1).max(500);
const shape = <T extends z.ZodRawShape>(fields: T) => z.object(fields).strict();

export const RHINO_EXTENDED_SCHEMAS = {
  create_curve: z.discriminatedUnion("operation", [
    shape({operation:z.literal("circle"),...plane,radius:positive,...output}),
    shape({operation:z.literal("ellipse"),...plane,radius_x:positive,radius_y:positive,...output}),
    shape({operation:z.literal("arc"),start:point,through:point,end:point,...output}),
    shape({operation:z.literal("rectangle"),...plane,width:positive,height:positive,...output}),
    shape({operation:z.literal("polygon"),...plane,radius:positive,sides:n.int().min(3).max(1000),...output}),
    shape({operation:z.literal("interpolate"),points:z.array(point).min(4).max(2000),closed:z.boolean().default(false),...output}),
    shape({operation:z.literal("nurbs"),points:z.array(point).min(4).max(2000),degree:n.int().min(1).max(11).default(3),closed:z.boolean().default(false),...output}),
  ]),
  create_solid: z.discriminatedUnion("operation", [
    shape({operation:z.literal("cone"),...plane,radius:positive,height:positive,...output}),
    shape({operation:z.literal("torus"),...plane,major_radius:positive,minor_radius:positive,...output}),
  ]),
  curve_edit: z.discriminatedUnion("operation", [
    shape({operation:z.literal("join"),...targets,...keep,...output}),
    shape({operation:z.literal("explode"),...targets,...keep,...output}),
    shape({operation:z.literal("reverse"),...targets,...keep,...output}),
    shape({operation:z.literal("simplify"),...targets,...keep,...output}),
    shape({operation:z.literal("offset"),...targets,distance:n.refine(x=>x!==0),...plane,corner:z.enum(["sharp","round","smooth","chamfer"]).default("sharp"),...keep,...output}),
    shape({operation:z.literal("rebuild"),...targets,point_count:n.int().min(4).max(2000),degree:n.int().min(1).max(11).default(3),...keep,...output}),
    shape({operation:z.literal("split"),...targets,parameters:z.array(n).min(1).max(1000),...keep,...output}),
    shape({operation:z.literal("trim"),...targets,interval:z.tuple([n,n]).refine(v=>v[1]>v[0]),...keep,...output}),
    shape({operation:z.literal("fillet"),target_guids:ids.refine(v=>v.length===2),pick_points:z.tuple([point,point]),radius:positive,trim:z.boolean().default(true),...keep,...output}),
  ]),
  surface: z.discriminatedUnion("operation", [
    shape({operation:z.literal("planar"),...targets,...output}),
    shape({operation:z.literal("edge"),target_guids:ids.refine(v=>v.length>=2&&v.length<=4),...output}),
    shape({operation:z.literal("revolve"),...targets,axis_start:point,axis_end:point,angle_degrees:positive.max(360).default(360),cap:z.boolean().default(false),...output}),
    shape({operation:z.literal("sweep1"),...targets,rail_guids:ids.refine(v=>v.length===1),closed:z.boolean().default(false),...output}),
    shape({operation:z.literal("sweep2"),...targets,rail_guids:ids.refine(v=>v.length===2),closed:z.boolean().default(false),...output}),
    shape({operation:z.literal("pipe"),...targets,radius:positive,cap:z.enum(["none","flat","round"]).default("flat"),...output}),
  ]),
  solid_edit: z.discriminatedUnion("operation", [
    shape({operation:z.literal("cap"),...targets,...keep,...output}),
    shape({operation:z.literal("join"),...targets,...keep,...output}),
    shape({operation:z.literal("explode"),...targets,...keep,...output}),
    shape({operation:z.literal("offset"),...targets,distance:n.refine(x=>x!==0),solid:z.boolean().default(false),...keep,...output}),
    shape({operation:z.literal("fillet_edges"),...targets,edge_indices:indices,radius:positive,...keep,...output}),
    shape({operation:z.literal("chamfer_edges"),...targets,edge_indices:indices,radius:positive,...keep,...output}),
    shape({operation:z.literal("shell"),...targets,face_indices:indices,thickness:n.refine(x=>x!==0),...keep,...output}),
    shape({operation:z.literal("split"),...targets,cutter_guids:ids,...keep,...output}),
    shape({operation:z.literal("trim_plane"),...targets,...plane,...keep,...output}),
  ]),
  mesh: z.discriminatedUnion("operation", [
    shape({operation:z.literal("from_brep"),...targets,quality:z.enum(["fast","smooth"]).default("fast"),...output}),
    shape({operation:z.literal("join"),...targets,...keep,...output}),
    shape({operation:z.literal("explode"),...targets,...keep,...output}),
    shape({operation:z.literal("reduce"),...targets,face_count:n.int().min(4).max(1000000),...keep,...output}),
    shape({operation:z.literal("triangulate"),...targets,...keep,...output}),
    shape({operation:z.literal("quadrangulate"),...targets,...keep,...output}),
    shape({operation:z.literal("weld"),...targets,angle_degrees:positive.max(180).default(180),...keep,...output}),
    shape({operation:z.literal("unify_normals"),...targets,...keep,...output}),
  ]),
  subd: shape({operation:z.enum(["from_mesh","to_brep","subdivide"]),...targets,levels:n.int().min(1).max(3).default(1),...output}),
  copy_objects: z.discriminatedUnion("operation", [
    shape({operation:z.literal("copy"),...targets,vector:point.default([0,0,0]),...output}),
    shape({operation:z.literal("mirror"),...targets,...plane,...output}),
    shape({operation:z.literal("linear_array"),...targets,vector:vector,count:n.int().min(2).max(500),...output}),
    shape({operation:z.literal("polar_array"),...targets,center:point,axis:vector.default([0,0,1]),count:n.int().min(2).max(500),angle_degrees:positive.max(360).default(360),...output}),
  ]),
  object_state: shape({operation:z.enum(["select","deselect","hide","show","lock","unlock","delete","rename"]),...targets,name:label.optional()}),
  layer_manage: shape({operation:z.enum(["create","rename","visibility","lock","color","delete_empty","set_current"]),layer:label,new_name:label.optional(),visible:z.boolean().optional(),locked:z.boolean().optional(),color:color.optional()}),
  group_manage: shape({operation:z.enum(["create","add","remove","ungroup"]),group:label,target_guids:ids.optional()}),
};

export const RHINO_EXTENDED_ACTIONS = Object.keys(RHINO_EXTENDED_SCHEMAS) as (keyof typeof RHINO_EXTENDED_SCHEMAS)[];
export const RHINO_EXTENDED_HELP = "create_curve(circle/ellipse/arc/rectangle/polygon/interpolate/nurbs); create_solid(cone/torus); curve_edit(join/explode/reverse/simplify/offset/rebuild/split/trim/fillet); surface(planar/edge/revolve/sweep1/sweep2/pipe); solid_edit(cap/join/explode/offset/fillet_edges/chamfer_edges/shell/split/trim_plane); mesh(from_brep/join/explode/reduce/triangulate/quadrangulate/weld/unify_normals); subd(from_mesh/to_brep/subdivide); copy_objects(copy/mirror/linear_array/polar_array); object_state(select/deselect/hide/show/lock/unlock/delete/rename); layer_manage(create/rename/visibility/lock/color/delete_empty/set_current); group_manage(create/add/remove/ungroup). Use RhinoInspect(operation:capabilities, action:...) to read an exact JSON parameter schema before an unfamiliar action. Geometry results preserve sources by default; delete_inputs:true always requires confirmation. Arrays count includes the original.";

export function parseExtendedRhinoAction(action: string, input: Record<string, unknown>): Record<string, unknown> | undefined {
  const schema = RHINO_EXTENDED_SCHEMAS[action as keyof typeof RHINO_EXTENDED_SCHEMAS];
  if (!schema) return undefined;
  const p = schema.parse(input) as Record<string, unknown>;
  if (action === "create_solid" && p.operation === "torus" && Number(p.minor_radius) >= Number(p.major_radius)) throw new Error("minor_radius must be smaller than major_radius");
  if ((p.operation === "nurbs" && Number(p.degree) >= (p.points as unknown[]).length) || (p.operation === "rebuild" && Number(p.degree) >= Number(p.point_count))) throw new Error("degree must be smaller than point count");
  if (p.operation === "revolve" && JSON.stringify(p.axis_start) === JSON.stringify(p.axis_end)) throw new Error("revolve axis must not be zero");
  if (action === "copy_objects" && (p.target_guids as unknown[]).length * (Number(p.count ?? 2) - 1) > 2000) throw new Error("array exceeds 2000 new objects");
  if (action === "object_state" && p.operation === "rename" && !p.name) throw new Error("rename requires name");
  const required: Record<string,string> = {rename:"new_name",visibility:"visible",lock:"locked",color:"color"};
  if (action === "layer_manage" && required[String(p.operation)] && p[required[String(p.operation)]] === undefined) throw new Error(`${p.operation} requires ${required[String(p.operation)]}`);
  if (action === "group_manage" && p.operation !== "ungroup" && !p.target_guids) throw new Error("group operation requires target_guids");
  return p;
}

export const RHINO_INSPECT_SCHEMA = shape({
  operation:z.enum(["capabilities","measure","topology","divide_curve","closest_point","intersection","section"]),
  action:z.string().optional(), observation_id:z.string().optional(), target_guids:ids.optional(),
  point:point.optional(), origin:point.optional(), normal:vector.optional(),
  count:n.int().min(2).max(1000).default(20), max_items:n.int().min(1).max(1000).default(100),
});

const inputBranch = shape({path:z.array(n.int().min(0).max(1000000)).min(1).max(16),values:z.array(z.union([n,z.boolean(),z.string().max(4000),point])).max(2000)});
export const GRASSHOPPER_SCHEMA = shape({
  definition_path:z.string().trim().min(1).max(4096),
  operation:z.enum(["inspect","solve","bake"]).default("solve"),
  inputs:z.array(shape({parameter_id:guid,type:z.enum(["number","integer","boolean","string","point","vector","geometry"]),branches:z.array(inputBranch).min(1).max(100)})).max(100).default([]),
  outputs:z.array(shape({component_id:guid,output_index:n.int().min(0).max(100).default(0)})).max(100).default([]),
  max_items:n.int().min(1).max(2000).default(200), layer:label.optional(),
});

export function parseGrasshopper(input: Record<string,unknown>, cwd:string): Record<string,unknown> {
  const p = GRASSHOPPER_SCHEMA.parse(input);
  p.definition_path = path.resolve(cwd,p.definition_path);
  if (![".gh",".ghx"].includes(path.extname(p.definition_path).toLowerCase())) throw new Error("definition_path must use .gh or .ghx");
  if (p.operation === "inspect" && (p.inputs.length || p.outputs.length)) throw new Error("inspect does not accept inputs/outputs");
  if (p.operation === "bake" && !p.outputs.length) throw new Error("bake requires explicit outputs");
  if (new Set(p.inputs.map(x=>x.parameter_id.toLowerCase())).size!==p.inputs.length) throw new Error("duplicate input parameter_id");
  let total = 0;
  for (const input of p.inputs) {
    const paths = new Set<string>();
    for (const branch of input.branches) {
      const key=JSON.stringify(branch.path);
      if(paths.has(key)) throw new Error("duplicate data tree path");
      paths.add(key);
      for(const v of branch.values) {
        total++;
        if(input.type === "geometry") guid.parse(v);
        else if(input.type === "point" || input.type === "vector") point.parse(v);
        else if(input.type === "integer") n.int().parse(v);
        else if(input.type === "number") n.parse(v);
        else if(input.type === "boolean") z.boolean().parse(v);
        else z.string().parse(v);
      }
    }
  }
  if(total>10000) throw new Error("Grasshopper input exceeds 10000 values");
  return p;
}

/** All referenced geometry enters observation, snapshots and Jev via this one helper. */
export function rhinoTargetGuids(p:Record<string,unknown>):string[] {
  const values: string[] = [];
  for(const key of ["target_guids","cutter_guids","rail_guids","object_guids"]) if(Array.isArray(p[key])) values.push(...p[key] as string[]);
  if(typeof p.target_guid === "string") values.push(p.target_guid);
  if(Array.isArray(p.inputs)) for(const input of p.inputs) if(input.type === "geometry") for(const branch of input.branches ?? []) values.push(...branch.values);
  return [...new Set(values.map(v=>v.toLowerCase()))];
}

export function rhinoCapabilities(action?:string):unknown {
  if (action && ["RhinoInspect", "inspect", "measure", "topology", "divide_curve", "closest_point", "intersection", "section"].includes(action)) {
    return { tool: "RhinoInspect", requested_operation: action, schema: z.toJSONSchema(RHINO_INSPECT_SCHEMA, { io: "input" }),
      required_for_geometry: ["operation", "observation_id", "target_guids"], defaults: { count: 20, max_items: 100 } };
  }
  const schemas:Record<string,z.ZodType> = {...RHINO_EXTENDED_SCHEMAS,run_grasshopper:GRASSHOPPER_SCHEMA};
  if(action && !schemas[action]) throw new Error("Unknown extended action; use RhinoAction schema for legacy actions");
  return action ? z.toJSONSchema(schemas[action], { io: "input" }) : {actions:Object.keys(schemas),help:RHINO_EXTENDED_HELP,inspect:z.toJSONSchema(RHINO_INSPECT_SCHEMA, { io: "input" })};
}
