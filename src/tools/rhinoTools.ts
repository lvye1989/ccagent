import * as path from "node:path";
import { resolveRhinoExportPath, getRhinoProjectDirectory } from "./rhinoProject.js";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages.js";
import type { Tool, ToolContext, ToolResult } from "./Tool.js";
import {
  executeRhinoAction,
  getCachedRhinoObservation,
  observeRhino,
  inspectRhino,
  type RhinoObservation,
} from "./rhinoBackend.js";
import {
  decideRhinoActionWithJev,
  RHINO_ACTIONS,
  type RhinoActionName,
  type RhinoJevDecision,
} from "./rhinoJev.js";
import { parseExtendedRhinoAction, parseGrasshopper, rhinoTargetGuids, rhinoCapabilities, RHINO_INSPECT_SCHEMA, RHINO_EXTENDED_HELP } from "./rhinoCatalog.js";

const GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IMPORT_EXPORT_EXTENSIONS = new Set([
  ".3dm", ".dwg", ".dxf", ".obj", ".stl", ".step", ".stp", ".iges", ".igs",
  ".fbx", ".skp", ".ply", ".gltf", ".glb", ".sat", ".x_t", ".x_b",
]);

const PARAMETER_KEYS: Partial<Record<RhinoActionName, Set<string>>> = {
  create_geometry: new Set(["primitive", "point", "start", "end", "points", "min", "max", "center", "radius", "base", "axis", "height"]),
  transform: new Set(["target_guids", "operation", "vector", "center", "axis", "angle_degrees", "factors", "copy"]),
  extrude: new Set(["target_guids", "direction", "cap", "delete_inputs"]),
  loft: new Set(["target_guids", "sections", "center", "corner_ratio", "concavity", "crown_dip", "cap", "layer", "name", "expected_units"]),
  curtain_wall: new Set(["target_guids", "floors", "bays_per_side", "mullion_width", "transom_width", "depth", "glass_opacity", "layer_prefix", "spandrel_height", "expected_units"]),
  floor_plates: new Set(["target_guids", "floors", "slab_thickness", "inset", "core_width", "core_depth", "core_height", "layer_prefix", "expected_units"]),
  set_view: new Set(["target_guids", "direction", "display_mode", "projection", "portrait", "isolate"]),
  boolean: new Set(["operation", "target_guids", "cutter_guids", "delete_inputs"]),
  set_layer: new Set(["target_guids", "layer", "create_if_missing"]),
  set_material: new Set(["target_guids", "name", "diffuse_color", "opacity"]),
  run_grasshopper: new Set(["definition_path"]),
  import_export: new Set(["operation", "file_path", "selected_only", "overwrite", "target_guids"]),
  undo: new Set(),
};

export interface ParsedRhinoActionInput {
  action: RhinoActionName;
  observationId: string;
  intent: string;
  parameters: Record<string, unknown>;
}

function requestedTargetGuids(parameters: Record<string, unknown>): string[] {
  return rhinoTargetGuids(parameters);
}

function assertTargetsWereObserved(
  action: RhinoActionName,
  parameters: Record<string, unknown>,
  observation: RhinoObservation,
): void {
  const observed = new Set<string>();
  for (const item of [...observation.objects, ...observation.selection]) {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      const guid = (item as Record<string, unknown>).guid;
      if (typeof guid === "string") observed.add(guid.toLowerCase());
    }
  }
  const missing = requestedTargetGuids(parameters).filter((guid) => !observed.has(guid));
  if (missing.length > 0) {
    throw new Error(
      `target GUIDs were not present in the fresh RhinoObserve result: ${missing.join(", ")}. `
      + "Observe again with a larger object_limit instead of guessing GUIDs.",
    );
  }
  if (
    action === "import_export"
    && parameters.operation === "export"
    && parameters.selected_only === true
    && observation.selection.length === 0
  ) {
    throw new Error("selected_only export requires at least one object in the fresh RhinoObserve selection.");
  }
}

function isAction(value: unknown): value is RhinoActionName {
  return typeof value === "string" && (RHINO_ACTIONS as readonly string[]).includes(value);
}

function requiredString(value: unknown, name: string, maxLength = 2_000): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string.`);
  const result = value.trim();
  if (result.length > maxLength) throw new Error(`${name} exceeds ${maxLength} characters.`);
  return result;
}

function assertBoolean(value: unknown, name: string): void {
  if (value !== undefined && typeof value !== "boolean") throw new Error(`${name} must be true or false.`);
}

function assertNumber(value: unknown, name: string, options: { min?: number; max?: number } = {}): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${name} must be a finite number.`);
  if (options.min !== undefined && value < options.min) throw new Error(`${name} must be at least ${options.min}.`);
  if (options.max !== undefined && value > options.max) throw new Error(`${name} must be at most ${options.max}.`);
  return value;
}

function assertPoint(value: unknown, name: string): void {
  if (!Array.isArray(value) || value.length !== 3) throw new Error(`${name} must be [x, y, z].`);
  value.forEach((coordinate, index) => assertNumber(coordinate, `${name}[${index}]`));
}

function assertGuidList(value: unknown, name: string, required = true): void {
  if (value === undefined && !required) return;
  if (!Array.isArray(value) || (required && value.length === 0)) {
    throw new Error(`${name} must be a non-empty GUID array.`);
  }
  if (value.length > 500) throw new Error(`${name} may contain at most 500 GUIDs.`);
  for (const guid of value) {
    if (typeof guid !== "string" || !GUID_PATTERN.test(guid)) throw new Error(`${name} contains an invalid Rhino GUID.`);
  }
}

function assertEnum(value: unknown, name: string, allowed: readonly string[]): string {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new Error(`${name} must be one of: ${allowed.join(", ")}.`);
  }
  return value;
}

function rejectUnknownKeys(action: RhinoActionName, parameters: Record<string, unknown>): void {
  const allowed = PARAMETER_KEYS[action]!;
  const unknown = Object.keys(parameters).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new Error(`RhinoAction ${action} rejected non-whitelisted parameters: ${unknown.join(", ")}.`);
  }
  const encodedLength = JSON.stringify(parameters).length;
  if (encodedLength > 100_000) throw new Error("RhinoAction parameters exceed the 100 KB safety limit.");
}

function validateActionParameters(
  action: RhinoActionName,
  rawParameters: Record<string, unknown>,
  cwd: string,
): Record<string, unknown> {
  const parameters = { ...rawParameters };
  if (JSON.stringify(parameters).length > 100_000) throw new Error("RhinoAction parameters exceed the 100 KB safety limit.");
  if (action === "run_grasshopper") return parseGrasshopper(parameters, cwd);
  const extended = parseExtendedRhinoAction(action, parameters);
  if (extended) return extended;
  rejectUnknownKeys(action, parameters);
  switch (action) {
    case "loft": {
      if (parameters.target_guids !== undefined) {
        assertGuidList(parameters.target_guids, "target_guids");
        if ((parameters.target_guids as unknown[]).length < 2 || (parameters.target_guids as unknown[]).length > 64) throw new Error("loft needs 2-64 ordered curves.");
        if (parameters.sections !== undefined) throw new Error("loft accepts either sections or target_guids, not both.");
      } else {
        if (!Array.isArray(parameters.sections) || parameters.sections.length < 2 || parameters.sections.length > 64) throw new Error("sections must contain 2-64 ordered {z,width,depth} profiles.");
        let previous = -Infinity;
        for (const section of parameters.sections) {
          if (!section || typeof section !== "object" || Array.isArray(section) || Object.keys(section).some(key => !["z", "width", "depth"].includes(key))) throw new Error("each section must contain only z, width, depth.");
          const z = assertNumber(section.z, "section.z");
          if (z <= previous) throw new Error("section z values must be strictly increasing.");
          previous = z;
          assertNumber(section.width, "section.width", { min: 0.01, max: 10_000 });
          assertNumber(section.depth, "section.depth", { min: 0.01, max: 10_000 });
        }
      }
      if (parameters.center !== undefined) assertPoint(parameters.center, "center");
      for (const [key, max] of [["corner_ratio", 0.4], ["concavity", 0.15], ["crown_dip", 20]] as const) if (parameters[key] !== undefined) assertNumber(parameters[key], key, { min: 0, max });
      assertBoolean(parameters.cap, "cap");
      for (const key of ["name", "layer", "expected_units"]) if (parameters[key] !== undefined) parameters[key] = requiredString(parameters[key], key, 128);
      break;
    }
    case "curtain_wall": {
      assertGuidList(parameters.target_guids, "target_guids");
      if ((parameters.target_guids as unknown[]).length !== 1) throw new Error("curtain_wall needs exactly one loft target.");
      for (const [key, fallback, min, max] of [["floors", 75, 1, 200], ["bays_per_side", 28, 4, 80], ["mullion_width", 0.1, 0.01, 1], ["transom_width", 0.12, 0.01, 1], ["depth", 0.16, 0.01, 2], ["glass_opacity", 0.72, 0.05, 1], ["spandrel_height", 0.45, 0, 2]] as const) {
        parameters[key] ??= fallback;
        assertNumber(parameters[key], key, { min, max });
      }
      if (!Number.isInteger(parameters.floors) || !Number.isInteger(parameters.bays_per_side)) throw new Error("floors and bays_per_side must be integers.");
      if (Number(parameters.floors) * Number(parameters.bays_per_side) * 4 > 30_000) throw new Error("curtain_wall exceeds the 30000 panel limit.");
      parameters.layer_prefix = requiredString(parameters.layer_prefix ?? "CurtainWall", "layer_prefix", 100);
      if (parameters.expected_units !== undefined) parameters.expected_units = requiredString(parameters.expected_units, "expected_units", 128);
      break;
    }
    case "floor_plates": {
      assertGuidList(parameters.target_guids, "target_guids");
      if ((parameters.target_guids as unknown[]).length !== 1) throw new Error("floor_plates needs exactly one loft target.");
      for (const [key, fallback, min, max] of [["floors", 75, 1, 200], ["slab_thickness", 0.15, 0.01, 5], ["inset", 0.3, 0, 20], ["core_width", 18, 0.5, 400], ["core_depth", 18, 0.5, 400], ["core_height", 0.1, 0.1, 10_000]] as const) {
        if (parameters[key] === undefined) {
          if (key === "core_height") continue;
          parameters[key] = fallback;
        }
        assertNumber(parameters[key], key, { min, max });
      }
      if (!Number.isInteger(parameters.floors)) throw new Error("floors must be an integer.");
      parameters.layer_prefix = requiredString(parameters.layer_prefix ?? "Floors", "layer_prefix", 100);
      if (parameters.expected_units !== undefined) parameters.expected_units = requiredString(parameters.expected_units, "expected_units", 128);
      break;
    }
    case "set_view":
      assertBoolean(parameters.portrait, "portrait");
      assertBoolean(parameters.isolate, "isolate");
      assertGuidList(parameters.target_guids, "target_guids");
      assertPoint(parameters.direction, "direction");
      if ((parameters.direction as number[]).every(v => v === 0)) throw new Error("direction must not be zero.");
      if (parameters.display_mode !== undefined) assertEnum(parameters.display_mode, "display_mode", ["shaded", "rendered", "wireframe", "arctic"]);
      if (parameters.projection !== undefined) assertEnum(parameters.projection, "projection", ["parallel", "perspective"]);
      break;
    case "create_geometry": {
      const primitive = assertEnum(parameters.primitive, "primitive", ["point", "line", "polyline", "box", "sphere", "cylinder"]);
      if (primitive === "point") assertPoint(parameters.point, "point");
      if (primitive === "line") {
        assertPoint(parameters.start, "start");
        assertPoint(parameters.end, "end");
      }
      if (primitive === "polyline") {
        if (!Array.isArray(parameters.points) || parameters.points.length < 2 || parameters.points.length > 10_000) {
          throw new Error("points must contain 2-10000 XYZ points.");
        }
        parameters.points.forEach((point, index) => assertPoint(point, `points[${index}]`));
      }
      if (primitive === "box") {
        assertPoint(parameters.min, "min");
        assertPoint(parameters.max, "max");
      }
      if (primitive === "sphere") {
        assertPoint(parameters.center, "center");
        assertNumber(parameters.radius, "radius", { min: Number.EPSILON });
      }
      if (primitive === "cylinder") {
        assertPoint(parameters.base, "base");
        if (parameters.axis !== undefined) assertPoint(parameters.axis, "axis");
        assertNumber(parameters.radius, "radius", { min: Number.EPSILON });
        assertNumber(parameters.height, "height", { min: Number.EPSILON });
      }
      break;
    }
    case "transform": {
      assertGuidList(parameters.target_guids, "target_guids");
      const operation = assertEnum(parameters.operation, "operation", ["translate", "rotate", "scale"]);
      if (operation === "translate") assertPoint(parameters.vector, "vector");
      if (operation === "rotate") {
        assertPoint(parameters.center, "center");
        if (parameters.axis !== undefined) assertPoint(parameters.axis, "axis");
        assertNumber(parameters.angle_degrees, "angle_degrees");
      }
      if (operation === "scale") {
        assertPoint(parameters.center, "center");
        assertPoint(parameters.factors, "factors");
      }
      assertBoolean(parameters.copy, "copy");
      break;
    }
    case "extrude":
      assertGuidList(parameters.target_guids, "target_guids");
      assertPoint(parameters.direction, "direction");
      assertBoolean(parameters.cap, "cap");
      assertBoolean(parameters.delete_inputs, "delete_inputs");
      parameters.delete_inputs ??= false;
      break;
    case "boolean":
      assertGuidList(parameters.target_guids, "target_guids");
      if (assertEnum(parameters.operation, "operation", ["union", "difference", "intersection"]) !== "union") {
        assertGuidList(parameters.cutter_guids, "cutter_guids");
      } else {
        assertGuidList(parameters.cutter_guids, "cutter_guids", false);
      }
      assertBoolean(parameters.delete_inputs, "delete_inputs");
      parameters.delete_inputs ??= true;
      break;
    case "set_layer":
      assertGuidList(parameters.target_guids, "target_guids");
      parameters.layer = requiredString(parameters.layer, "layer", 512);
      assertBoolean(parameters.create_if_missing, "create_if_missing");
      parameters.create_if_missing ??= true;
      break;
    case "set_material":
      assertGuidList(parameters.target_guids, "target_guids");
      if (parameters.name !== undefined) parameters.name = requiredString(parameters.name, "name", 128);
      if (!Array.isArray(parameters.diffuse_color) || ![3, 4].includes(parameters.diffuse_color.length)) {
        throw new Error("diffuse_color must be [r, g, b] or [r, g, b, a].");
      }
      parameters.diffuse_color.forEach((channel, index) => {
        const value = assertNumber(channel, `diffuse_color[${index}]`, { min: 0, max: 255 });
        if (!Number.isInteger(value)) throw new Error(`diffuse_color[${index}] must be an integer.`);
      });
      if (parameters.opacity !== undefined) assertNumber(parameters.opacity, "opacity", { min: 0, max: 1 });
      break;
    case "import_export": {
      assertEnum(parameters.operation, "operation", ["import", "export"]);
      if (parameters.target_guids !== undefined) {
        assertGuidList(parameters.target_guids, "target_guids");
        if (parameters.operation !== "export") throw new Error("target_guids are only supported for export.");
      }
      const requestedPath = requiredString(parameters.file_path, "file_path", 4_096);
      const filePath = parameters.operation === "export" ? resolveRhinoExportPath(requestedPath) : path.resolve(cwd, requestedPath);
      if (!IMPORT_EXPORT_EXTENSIONS.has(path.extname(filePath).toLowerCase())) {
        throw new Error(`file_path extension is not allowlisted: ${path.extname(filePath) || "<none>"}.`);
      }
      parameters.file_path = filePath;
      if (parameters.target_guids !== undefined && path.extname(filePath).toLowerCase() !== ".3dm") throw new Error("target_guids export currently requires .3dm.");
      if (parameters.operation === "export" && path.extname(filePath).toLowerCase() !== ".3dm") throw new Error("Dialog-free API export currently requires .3dm. Other formats require a separately confirmed Computer Use step; no modal export was started.");
      assertBoolean(parameters.selected_only, "selected_only");
      assertBoolean(parameters.overwrite, "overwrite");
      parameters.overwrite ??= false;
      break;
    }
    case "undo":
      break;
  }
  return parameters;
}

export function parseRhinoActionInput(input: Record<string, unknown>, cwd: string): ParsedRhinoActionInput {
  if (!isAction(input.action)) throw new Error(`action must be one of: ${RHINO_ACTIONS.join(", ")}.`);
  const observationId = requiredString(input.observation_id, "observation_id", 128);
  const intent = requiredString(input.intent, "intent", 1_000);
  if (!input.parameters || typeof input.parameters !== "object" || Array.isArray(input.parameters)) {
    throw new Error("parameters must be an object.");
  }
  return {
    action: input.action,
    observationId,
    intent,
    parameters: validateActionParameters(input.action, input.parameters as Record<string, unknown>, cwd),
  };
}

function unavailableDecision(summary: string, forceObserve = false): RhinoJevDecision {
  return {
    configured: false,
    available: false,
    mode: "enforce",
    model: process.env.JEV_MODEL?.trim() || "~typesafe/jev-latest",
    route: "ask_user",
    permissionBehavior: "ask",
    ...(forceObserve ? { forceObserve: true } : {}),
    summary,
  };
}

export async function preflightRhinoActionWithJev(
  input: Record<string, unknown>,
  context: ToolContext,
  messages: MessageParam[] = [],
  fast = false,
): Promise<RhinoJevDecision> {
  let parsed: ParsedRhinoActionInput;
  try {
    parsed = parseRhinoActionInput(input, context.cwd);
    // Show the exact destination to the independent permission gate, not cwd-relative input.
    input.parameters = parsed.parameters;
  } catch (error) {
    return { ...unavailableDecision(`RhinoAction validation failed: ${error instanceof Error ? error.message : String(error)}`), requiresReplan: true };
  }
  const observation = getCachedRhinoObservation(parsed.observationId);
  if (!observation) {
    return unavailableDecision("Rhino observation is missing or older than 60 seconds; call RhinoObserve again.", true);
  }
  try {
    assertTargetsWereObserved(parsed.action, parsed.parameters, observation);
  } catch (error) {
    return unavailableDecision(
      `Rhino target validation failed: ${error instanceof Error ? error.message : String(error)}`,
      true,
    );
  }
  return await decideRhinoActionWithJev(
    parsed.action,
    { intent: parsed.intent, ...parsed.parameters },
    observation,
    messages,
    context.abortSignal,
    fast,
  );
}

export async function preflightRhinoInspectWithJev(input: Record<string, unknown>, context: ToolContext, messages: MessageParam[] = []): Promise<RhinoJevDecision> {
  try {
    const p = RHINO_INSPECT_SCHEMA.parse(input);
    if (p.operation === "capabilities" || !p.observation_id || !p.target_guids) throw new Error("Fast inspection requires geometry targets and a fresh observation");
    const observation = getCachedRhinoObservation(p.observation_id);
    if (!observation) return unavailableDecision("Fast inspection observation is stale", true);
    assertTargetsWereObserved("transform", p, observation);
    return decideRhinoActionWithJev("inspect", p, observation, messages, context.abortSignal, true);
  } catch (error) { return { ...unavailableDecision(`Fast inspection validation failed: ${(error as Error).message}`), requiresReplan: true }; }
}

function observationSummary(observation: RhinoObservation): string {
  return JSON.stringify({
    observation_id: observation.observationId,
    captured_at: observation.capturedAt,
    rhino_version: observation.rhinoVersion,
    document: observation.document,
    layers: observation.layers,
    current_selection: observation.selection,
    objects: observation.objects,
    current_command: observation.command,
    undo: observation.undo,
    objects_truncated: observation.objectsTruncated,
    capture_path: observation.capturePath,
    project_directory: getRhinoProjectDirectory(),
  }, null, 2);
}

export const rhinoObserveTool: Tool = {
  name: "RhinoObserve",
  description:
    "Read the active Rhino 8 document through RhinoCommon: document name/units/tolerances, layers, selection, object GUID/type/bounding boxes, current command state, and undo state. " +
    "Always call immediately before RhinoAction and pass its observation_id. This tool does not launch Rhino and never modifies the document.",
  inputSchema: {
    type: "object" as const,
    properties: {
      capture: { type: "boolean", description: "Capture the current Rhino viewport to a local PNG using Rhino's native display API (no vision service needed). Returns capture_path." },
      object_limit: {
        type: "number",
        minimum: 1,
        maximum: 500,
        description: "Maximum number of document objects to return (default 200).",
      },
    },
  },
  maxResultSizeChars: 80_000,
  async call(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    try {
      if (input.object_limit !== undefined && (!Number.isInteger(input.object_limit) || Number(input.object_limit) < 1 || Number(input.object_limit) > 500)) {
        return { content: "RhinoObserve error: object_limit must be an integer from 1 to 500.", isError: true };
      }
      const observation = await observeRhino(
        { ...(input.object_limit !== undefined ? { objectLimit: Number(input.object_limit) } : {}), capture: input.capture === true },
        context.abortSignal,
      );
      return { content: observationSummary(observation) };
    } catch (error) {
      return {
        content: `RhinoObserve error: ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      };
    }
  },
  isReadOnly: () => true,
  isEnabled: () => process.platform === "win32",
};

export const rhinoActionTool: Tool = {
  name: "RhinoAction",
  description:
    RHINO_EXTENDED_HELP + " " +
    `Perform one structured RhinoCommon action from the fixed whitelist: ${RHINO_ACTIONS.join(", ")}. ` +
    "run_grasshopper supports operation inspect/solve/bake, typed inputs with data-tree branches and explicit outputs. Request RhinoInspect capabilities action:run_grasshopper for its full schema. " +
    "Requires a fresh RhinoObserve observation_id. CCAGENT stores a pre-change GUID/parameter snapshot and wraps document mutations in one Rhino Undo Record. " +
    "No arbitrary Rhino command or script text is accepted. set_view also supports portrait:true (presentation viewport) and isolate:true (reversibly hide other objects). import_export export to .3dm also supports target_guids to export only these observed objects with layers/materials and no format dialogs. Jev chooses rhino_api, computer_use, or ask_user before execution; Jev failure falls back to manual confirmation.",
  inputSchema: {
    type: "object" as const,
    properties: {
      action: { type: "string", enum: [...RHINO_ACTIONS] },
      observation_id: { type: "string", description: "Fresh observation_id returned by RhinoObserve." },
      intent: { type: "string", description: "Concise user-aligned purpose of this one action." },
      parameters: {
        type: "object",
        description:
          "Action-specific structured parameters only. create_geometry {primitive,...}; transform {target_guids,operation,...}; extrude {target_guids,direction,cap,delete_inputs}; loft {sections:[{z,width,depth},...],center:[x,y,z],corner_ratio:0.15,concavity:0.02,crown_dip:2,cap:false,layer,name,expected_units} OR loft {target_guids:[2-64 ordered curve GUIDs],cap}; curtain_wall {target_guids:[one generated loft],floors:75,bays_per_side:28,mullion_width:0.10,transom_width:0.12,depth:0.16,glass_opacity:0.72,spandrel_height:0.45,layer_prefix,expected_units}; floor_plates {target_guids:[one generated loft],floors:75,slab_thickness:0.15,inset:0.30,core_width:18,core_depth:18,core_height:optional full-height core,layer_prefix,expected_units} builds one merged floor-slab mesh plus a core-tube mesh; set_view {target_guids,direction:[1,-2,-0.15],display_mode:shaded|rendered|arctic|wireframe,projection:parallel|perspective,portrait:false,isolate:false}; boolean {operation,target_guids,cutter_guids,delete_inputs}; set_layer {target_guids,layer}; set_material {target_guids,diffuse_color,opacity}; run_grasshopper {definition_path}; import_export {operation,file_path,selected_only,overwrite,target_guids:[optional GUIDs for .3dm export only]}; undo {}. Loft, curtain_wall and floor_plates are additive, preserve source objects, and return component GUIDs and counts. All distances use the document units.",
      },
    },
    required: ["action", "observation_id", "intent", "parameters"],
  },
  maxResultSizeChars: 50_000,
  async call(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    try {
      const parsed = parseRhinoActionInput(input, context.cwd);
      const observation = getCachedRhinoObservation(parsed.observationId);
      if (!observation) {
        return { content: "RhinoAction blocked: observation is missing or stale; call RhinoObserve again.", isError: true };
      }
      assertTargetsWereObserved(parsed.action, parsed.parameters, observation);
      const suppliedDecision = context.rhinoJevDecision as RhinoJevDecision | undefined;
      const decision = suppliedDecision ?? await decideRhinoActionWithJev(
        parsed.action,
        { intent: parsed.intent, ...parsed.parameters },
        observation,
        [],
        context.abortSignal,
      );
      // Normal calls arrive through agenticLoop after its permission gate and
      // carry the exact preflight decision in ToolContext. A direct/internal
      // invocation has no proof that an "ask" decision was shown to the user,
      // so it may execute only Jev-confirmed ordinary actions.
      if (!suppliedDecision && decision.permissionBehavior !== "allow") {
        return {
          content: `RhinoAction blocked: this action requires the agent permission gate before execution. ${decision.summary}`,
          isError: true,
        };
      }
      if (decision.forceObserve) {
        return { content: `RhinoAction blocked: Jev requires a fresh inspection. ${decision.summary}`, isError: true };
      }
      if (decision.requiresReplan) return { content: `RhinoAction not executed: correct the proposed parameters or ask the user; observing the same document will not fix them. ${decision.summary}`, isError: true };
      if (decision.redirectToComputerUse) {
        return {
          content: `RhinoAction not executed: Jev selected computer_use. Re-observe the Rhino window, then use bounded Computer Use for the unsupported UI/plugin step. ${decision.summary}`,
          isError: true,
        };
      }
      const result = await executeRhinoAction(
        parsed.action,
        parsed.parameters,
        observation,
        context.abortSignal,
      );
      return {
        content: JSON.stringify({
          ...result,
          jev: {
            available: decision.available,
            route: decision.route,
            next_action: decision.nextAction,
            target_valid: decision.targetValid,
            parameters_valid: decision.parametersValid,
            destructive: decision.destructive,
            expected_progress: decision.expectedProgress,
          },
          next_step: "Call RhinoObserve again before another RhinoAction.",
        }, null, 2),
        ...(result.solution_ok === false ? {isError:true} : {}),
      };
    } catch (error) {
      return {
        content: `RhinoAction error: ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      };
    }
  },
  isReadOnly: () => false,
  isEnabled: () => process.platform === "win32",
};

export const rhinoInspectTool: Tool = {
  name:"RhinoInspect",
  description:"Read exact tool schemas (capabilities, no running Rhino required), or inspect observed geometry without modifying it: measure, topology edge/face indices, divide_curve, closest_point, intersection, section. Geometry inspections require fresh observation_id and target_guids. Results are bounded; no geometry is created. Before unfamiliar RhinoAction operations, request capabilities with its action name.",
  inputSchema:{type:"object",properties:{
    operation:{type:"string",enum:["capabilities","measure","topology","divide_curve","closest_point","intersection","section"]},
    action:{type:"string",description:"Action name for its exact schema, e.g. surface or run_grasshopper"},
    observation_id:{type:"string"},target_guids:{type:"array",items:{type:"string"}},
    point:{type:"array",items:{type:"number"}},origin:{type:"array",items:{type:"number"}},normal:{type:"array",items:{type:"number"}},
    count:{type:"integer"},max_items:{type:"integer"},
  },required:["operation"]},
  async call(input:Record<string,unknown>,context:ToolContext){
    try {
      const p=RHINO_INSPECT_SCHEMA.parse(input);
      if(p.operation === "capabilities") {
        if(p.action === "RhinoObserve") return {content:JSON.stringify(rhinoObserveTool.inputSchema,null,2)};
        if(p.action && p.action !== "run_grasshopper" && PARAMETER_KEYS[p.action as RhinoActionName]) {
          return {content:JSON.stringify({tool:"RhinoAction",action:p.action,
            required:["action","observation_id","intent","parameters"],
            allowed_parameters:[...PARAMETER_KEYS[p.action as RhinoActionName]!],
            help:(rhinoActionTool.inputSchema.properties as Record<string,unknown>)?.parameters,
            note:"Allowed fields and usage guide; operation-dependent constraints are checked by the strict action validator. Only .3dm API export is dialog-free; export paths must be inside project_directory."},null,2)};
        }
        return {content:JSON.stringify(rhinoCapabilities(p.action),null,2)};
      }
      if(!p.observation_id || !p.target_guids) throw new Error("Geometry inspection requires observation_id and target_guids");
      const observation=getCachedRhinoObservation(p.observation_id);
      if(!observation) throw new Error("Call RhinoObserve again; observation is missing or stale");
      assertTargetsWereObserved("transform",p,observation);
      if(p.operation === "closest_point" && !p.point) throw new Error("closest_point requires point");
      if(p.operation === "section" && (!p.origin || !p.normal)) throw new Error("section requires origin and normal");
      if(p.operation === "intersection" && p.target_guids.length!==2) throw new Error("intersection requires exactly two target_guids");
      return {content:JSON.stringify(await inspectRhino(p,observation,context.abortSignal),null,2)};
    } catch(error) { return {content:`RhinoInspect error: ${error instanceof Error?error.message:String(error)}`,isError:true}; }
  },
  isReadOnly:()=>true,
  isConcurrencySafe:()=>false,
  isEnabled:()=>process.platform==="win32",
};
