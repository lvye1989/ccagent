import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getBuiltInAgents } from "../agents/builtIn/index.js";
import { checkPermission, matchesPermissionRule } from "../permissions/permissions.js";
import { findToolByName } from "../tools/index.js";
import { resolveRhinoRunnerPath } from "../tools/rhinoBackend.js";
import {
  buildRhinoJevRequest,
  interpretRhinoJevResponse,
  RHINO_ACTIONS,
  type RhinoJevObservation,
} from "../tools/rhinoJev.js";
import { parseRhinoActionInput, rhinoActionTool, rhinoObserveTool } from "../tools/rhinoTools.js";
import type { JevDecisionResponse } from "../services/jev/openRouterJev.js";

let failures = 0;

function assert(condition: unknown, message: string): void {
  if (condition) console.log(`  ✓ ${message}`);
  else {
    failures += 1;
    console.error(`  ✗ ${message}`);
  }
}

function throws(fn: () => unknown, contains: string, message: string): void {
  try {
    fn();
    assert(false, message);
  } catch (error) {
    assert((error instanceof Error ? error.message : String(error)).includes(contains), message);
  }
}

const observation: RhinoJevObservation = {
  observationId: "obs-1",
  capturedAt: new Date().toISOString(),
  document: { name: "model.3dm", units: "Millimeters", runtime_serial: 12 },
  layers: [{ name: "Default", current: true }],
  selection: [],
  objects: [{ guid: "00000000-0000-4000-8000-000000000001", type: "Brep", bounding_box: { min: [0, 0, 0], max: [1, 1, 1] } }],
  command: { in_command: false, prompt: "Command" },
  undo: { recording_enabled: true, next_record_serial: 8 },
};

function response(overrides: Partial<JevDecisionResponse["answers"]> = {}): JevDecisionResponse {
  return {
    model: "typesafe/jev-test",
    answers: {
      route: { type: "choice", choice: "rhino_api", confidence: 0.99 },
      next_action: { type: "choice", choice: "transform", confidence: 0.99 },
      target_valid: { type: "noul", noul: 0.97 },
      parameters_valid: { type: "noul", noul: 0.91 },
      destructive: { type: "noul", noul: 0.08 },
      expected_progress: { type: "noul", noul: 0.89 },
      ...overrides,
    },
  };
}

async function main(): Promise<void> {
  console.log("\n── Rhino agent verification ──\n");

  console.log("[1] Built-in agent and tools");
  const agents = getBuiltInAgents();
  const rhino = agents.find((agent) => agent.agentType === "rhino_agent");
  assert(agents.length === 4, "four built-in agents are registered");
  assert(Boolean(rhino), "rhino_agent is built in");
  assert(rhino?.permissionMode === "auto", "rhino_agent uses Auto Mode for fast Jev-gated operations");
  assert(
    rhino?.tools?.join(",") === "RhinoObserve,RhinoInspect,RhinoAction,RhinoSequence,ComputerObserve,ComputerAction,ComputerNavigate",
    "rhino_agent has only structured Rhino and bounded Computer Use tools",
  );
  assert((rhino?.getSystemPrompt() ?? "").includes("Never call Bash or PowerShell"), "agent prompt forbids shell-based Rhino automation");
  assert(findToolByName("RhinoObserve") === rhinoObserveTool, "RhinoObserve is registered");
  assert(findToolByName("RhinoAction") === rhinoActionTool, "RhinoAction is registered");
  assert(rhinoObserveTool.isReadOnly() && !rhinoActionTool.isReadOnly(), "observe is read-only and action is mutating");

  console.log("\n[2] Strict action schemas");
  assert(["create_curve","surface","solid_edit","mesh","subd","group_manage"].every(a => (RHINO_ACTIONS as readonly string[]).includes(a)), "common modeling action families are registered");
  const loftInput = { action: "loft", observation_id: "obs-1", intent: "Reference tower", parameters: { sections: [{z:0,width:44,depth:44},{z:180,width:30.8,depth:30.8},{z:300,width:38,depth:38}], cap:false, crown_dip:2, expected_units:"Meters" } };
  assert(parseRhinoActionInput(loftInput, process.cwd()).action === "loft", "numerical section loft parses");
  throws(() => parseRhinoActionInput({ ...loftInput, parameters: { target_guids: Array.from({length:65}, (_, i) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`) } }, process.cwd()), "2-64", "curve loft and numerical loft share the 64-profile limit");
  throws(() => parseRhinoActionInput({ ...loftInput, parameters: {sections:[{z:10,width:4,depth:4},{z:0,width:3,depth:3}]} }, process.cwd()), "strictly increasing", "reversed profiles are rejected before Rhino mutation");
  throws(() => parseRhinoActionInput({ action:"curtain_wall", observation_id:"obs-1", intent:"facade", parameters:{target_guids:["00000000-0000-4000-8000-000000000001"],floors:200,bays_per_side:80} }, process.cwd()), "30000 panel", "unbounded facade generation is rejected");
  throws(() => parseRhinoActionInput({ action:"set_view", observation_id:"obs-1", intent:"view", parameters:{target_guids:["00000000-0000-4000-8000-000000000001"],direction:[0,0,0]} }, process.cwd()), "must not be zero", "zero camera direction is rejected");
  const platesInput = { action:"floor_plates", observation_id:"obs-1", intent:"slabs and core", parameters:{target_guids:["00000000-0000-4000-8000-000000000001"]} };
  const plates = parseRhinoActionInput(platesInput, process.cwd());
  assert(plates.parameters.floors === 75 && plates.parameters.slab_thickness === 0.15 && plates.parameters.inset === 0.3 && plates.parameters.core_width === 18, "floor_plates defaults to 75 floors, 0.15 m slabs, 0.3 m inset and an 18 m core");
  assert(plates.parameters.core_height === undefined, "floor_plates leaves the core height to the loft when unset");
  throws(() => parseRhinoActionInput({...platesInput, parameters:{...platesInput.parameters,floors:0}}, process.cwd()), "must be at least 1", "floor_plates rejects a zero floor count");
  throws(() => parseRhinoActionInput({...platesInput, parameters:{target_guids:["00000000-0000-4000-8000-000000000001","00000000-0000-4000-8000-000000000002"]}}, process.cwd()), "exactly one loft target", "floor_plates needs exactly one loft target");
  const exportInput = { action:"import_export", observation_id:"obs-1", intent:"save selected model", parameters:{operation:"export",file_path:"tower.3dm",target_guids:["00000000-0000-4000-8000-000000000001"]} };
  assert(parseRhinoActionInput(exportInput, process.cwd()).parameters.overwrite === false, "targeted 3dm export defaults to no overwrite");
  throws(() => parseRhinoActionInput({...exportInput, parameters:{...exportInput.parameters,file_path:"tower.obj"}}, process.cwd()), "requires .3dm", "targeted non-3dm export is rejected before entering a format dialog");
  throws(() => parseRhinoActionInput({...exportInput, parameters:{...exportInput.parameters,operation:"import"}}, process.cwd()), "only supported for export", "targeted export cannot turn into import");
  const parsed = parseRhinoActionInput({
    action: "transform",
    observation_id: "obs-1",
    intent: "Move the selected box 10 mm on X",
    parameters: {
      target_guids: ["00000000-0000-4000-8000-000000000001"],
      operation: "translate",
      vector: [10, 0, 0],
    },
  }, process.cwd());
  assert(parsed.action === "transform" && parsed.parameters.operation === "translate", "valid structured transform parses");
  throws(() => parseRhinoActionInput({
    action: "transform",
    observation_id: "obs-1",
    intent: "unsafe",
    parameters: {
      target_guids: ["00000000-0000-4000-8000-000000000001"],
      operation: "translate",
      vector: [1, 0, 0],
      command: "_-Delete",
    },
  }, process.cwd()), "non-whitelisted parameters", "arbitrary Rhino command fields are rejected");
  throws(() => parseRhinoActionInput({
    action: "run_grasshopper",
    observation_id: "obs-1",
    intent: "run plugin",
    parameters: { definition_path: "payload.py" },
  }, process.cwd()), ".gh or .ghx", "Grasshopper accepts definitions, not arbitrary scripts");

  console.log("\n[3] Jev route and validation decision");
  const request = buildRhinoJevRequest("transform", parsed.parameters, observation);
  assert(request.questions.route?.type === "choice", "route is a typed Jev choice");
  assert(request.questions.target_valid?.type === "noul", "target validity is a Jev probability");
  assert(request.questions.parameters_valid?.type === "noul", "parameter validity is a Jev probability");
  assert(request.questions.destructive?.type === "noul", "destructive risk is a Jev probability");
  assert(request.questions.expected_progress?.type === "noul", "expected progress is a Jev probability");
  const ordinary = interpretRhinoJevResponse(response(), "transform", { mode: "enforce", model: "~typesafe/jev-latest", minConfidence: 0.8 });
  assert(ordinary.route === "rhino_api" && ordinary.permissionBehavior === "allow", "high-confidence ordinary Rhino API action is allowed");
  assert(ordinary.targetValid === 0.97 && ordinary.parametersValid === 0.91, "Jev target and parameter probabilities are preserved");
  const uiRoute = interpretRhinoJevResponse(response({
    route: { type: "choice", choice: "computer_use", confidence: 0.98 },
  }), "transform", { mode: "enforce", model: "~typesafe/jev-latest", minConfidence: 0.8 });
  assert(uiRoute.redirectToComputerUse === true, "Jev can redirect an unsupported step to Computer Use without executing RhinoAction");
  const staleTarget = interpretRhinoJevResponse(response({
    target_valid: { type: "noul", noul: 0.2 },
  }), "transform", { mode: "enforce", model: "~typesafe/jev-latest", minConfidence: 0.8 });
  assert(staleTarget.forceObserve === true, "low target validity forces a new RhinoObserve");
  const changedAction = interpretRhinoJevResponse(response({
    next_action: { type: "choice", choice: "boolean", confidence: 0.96 },
  }), "transform", { mode: "enforce", model: "~typesafe/jev-latest", minConfidence: 0.8 });
  assert(changedAction.permissionBehavior === "ask", "Jev cannot silently replace the LLM-proposed action");

  console.log("\n[4] Permission floor");
  const settings = { mode: "full" as const, allow: ["RhinoAction(*)"], deny: [] };
  const booleanDecision = await checkPermission({
    tool: rhinoActionTool,
    input: { action: "boolean", parameters: { operation: "union", delete_inputs: true } },
    cwd: process.cwd(),
    settings,
  });
  assert(booleanDecision.behavior === "ask", "deleting boolean inputs asks even in Full Mode");
  const exportDecision = await checkPermission({
    tool: rhinoActionTool,
    input: { action: "import_export", parameters: { operation: "export", overwrite: false } },
    cwd: process.cwd(),
    settings,
  });
  assert(exportDecision.behavior === "ask", "export asks even in Full Mode");
  const grasshopperDecision = await checkPermission({
    tool: rhinoActionTool,
    input: { action: "run_grasshopper", parameters: {} },
    cwd: process.cwd(),
    settings,
  });
  assert(grasshopperDecision.behavior === "ask", "third-party Grasshopper execution asks even in Full Mode");
  assert(matchesPermissionRule("RhinoAction(transform)", "RhinoAction", { action: "transform" }), "Rhino allow rules can be action-scoped");
  assert(!matchesPermissionRule("RhinoAction(transform)", "RhinoAction", { action: "import_export" }), "transform allow rule cannot authorize export");

  console.log("\n[5] RhinoCommon bridge asset");
  const runnerPath = await resolveRhinoRunnerPath();
  const runner = await fs.readFile(runnerPath, "utf8");
  assert(runner.includes("BeginUndoRecord") && runner.includes("EndUndoRecord"), "bridge wraps model mutations in Rhino Undo Records");
  assert(runner.includes("_snapshot_before_action"), "bridge persists a pre-change GUID/parameter snapshot");
  assert(!runner.includes("RhinoApp.RunScript"), "bridge cannot execute model-supplied Rhino command strings");
  assert(runner.includes("ALLOWED_ACTIONS"), "bridge re-checks the action allowlist inside Rhino");

  if (failures > 0) {
    console.error(`\n${failures} Rhino verification check(s) failed.\n`);
    process.exitCode = 1;
  } else {
    console.log("\nAll Rhino agent checks passed.\n");
  }
}

const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ccagent-rhino-agent-test-"));
const previousProject = process.env.CCAGENT_RHINO_PROJECT_DIR;
process.env.CCAGENT_RHINO_PROJECT_DIR = path.join(fixtureRoot, "project");
try { await main(); } finally {
  if (previousProject === undefined) delete process.env.CCAGENT_RHINO_PROJECT_DIR; else process.env.CCAGENT_RHINO_PROJECT_DIR = previousProject;
  if (path.dirname(fixtureRoot) !== path.resolve(os.tmpdir()) || !path.basename(fixtureRoot).startsWith("ccagent-rhino-agent-test-")) throw new Error("Unexpected fixture root");
  await fs.rm(fixtureRoot, { recursive: true, force: true });
}
