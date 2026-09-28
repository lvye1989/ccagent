#!/usr/bin/env tsx

import type { Tool, ToolDecisionPolicy } from "../tools/Tool.js";
import {
  buildToolJevRequest,
  interpretToolJevResponse,
  sanitizeToolInputForJev,
  shouldUseJevToolClassifier,
} from "../permissions/jevToolClassifier.js";
import {
  formatActionForClassifier,
  sanitizeClassifierToolInput,
} from "../permissions/autoClassifier.js";
import {
  applySearchRerankResponse,
  buildSearchRerankRequest,
} from "../services/jev/searchReranker.js";
import {
  buildRhinoJevRequest,
  interpretRhinoJevResponse,
  type RhinoJevObservation,
} from "../tools/rhinoJev.js";

let failures = 0;
function assert(condition: unknown, label: string): void {
  console.log(`  [${condition ? "PASS" : "FAIL"}] ${label}`);
  if (!condition) failures++;
}

function fakeTool(name: string, readOnly: boolean, decisionPolicy?: ToolDecisionPolicy): Tool {
  return {
    name,
    description: "test",
    inputSchema: { type: "object", properties: {} },
    ...(decisionPolicy ? { decisionPolicy } : {}),
    async call() { return { content: "ok" }; },
    isReadOnly() { return readOnly; },
    isEnabled() { return true; },
  };
}

async function main(): Promise<void> {
  console.log("\n[1] General Jev Auto Mode classifier");
  const sanitized = sanitizeToolInputForJev({
    command: "deploy --token=super-secret-value",
    content: "private file body",
    password: "do-not-send",
    file_path: "src/app.ts",
  });
  assert(JSON.stringify(sanitized).includes("<redacted>"), "credential-like fields are redacted");
  assert(!JSON.stringify(sanitized).includes("private file body"), "file content is represented by metadata only");
  assert(!JSON.stringify(sanitized).includes("super-secret-value"), "inline command secrets are redacted");
  const fallbackSanitized = sanitizeClassifierToolInput({
    url: "https://example.com/private?token=never-send&email=user@example.com",
    text: "typed private content",
    command: "deploy --token=also-never-send",
  });
  const fallbackSerialized = JSON.stringify(fallbackSanitized);
  assert(!fallbackSerialized.includes("never-send") && !fallbackSerialized.includes("typed private content"), "fallback classifier withholds URL query values and typed content");
  assert(fallbackSerialized.includes("query_keys") && fallbackSerialized.includes("withheld-content"), "fallback classifier preserves bounded structural metadata");
  assert(!formatActionForClassifier("BrowserSearch", {
    action: "open_url",
    url: "https://example.com/news?access_token=private-value",
  }).includes("private-value"), "BrowserSearch fallback never serializes direct-URL query values");
  const request = buildToolJevRequest("Write", { file_path: "src/app.ts", content: "secret body" }, [
    { role: "user", content: "Update src/app.ts and never reveal token=abc123-private." },
  ], {
    revision: 7,
    tools: [
      { name: "Read", description: "Read a file", inputSchema: { type: "object", properties: {} }, decisionPolicy: "local" },
      { name: "Write", description: "Write a file", inputSchema: { type: "object", properties: { file_path: { type: "string" } } }, decisionPolicy: "generic_jev" },
    ],
  });
  assert(Boolean(request.questions.disposition && request.questions.goal_aligned && request.questions.tool_match), "tool decision batches disposition, tool match, and alignment");
  assert(JSON.stringify(request.state).includes('"registry_revision":7') && JSON.stringify(request.state).includes('"selected_tool_contract"'), "Jev receives the enabled internal tools_list revision and selected schema");
  assert(!JSON.stringify(request).includes("secret body"), "tool decision never sends write content");
  assert(!JSON.stringify(request).includes("abc123-private"), "recent user intent is secret-redacted");
  const safe = interpretToolJevResponse({
    model: "typesafe/jev-test",
    answers: {
      disposition: { type: "choice", choice: "allow", confidence: 0.96 },
      risk: { type: "choice", choice: "file_write", confidence: 0.92 },
      goal_aligned: { type: "noul", noul: 0.95 },
      irreversible: { type: "noul", noul: 0.03 },
      secret_exposure: { type: "noul", noul: 0.01 },
      external_effect: { type: "noul", noul: 0.01 },
      scope_change: { type: "noul", noul: 0.02 },
      tool_match: { type: "noul", noul: 0.97 },
    },
  }, { mode: "enforce", model: "~typesafe/jev-latest", minConfidence: 0.8 });
  assert(safe.permissionBehavior === "allow", "scoped reversible file edits bypass the general LLM classifier");
  const wrongTool = interpretToolJevResponse({
    model: "typesafe/jev-test",
    answers: {
      disposition: { type: "choice", choice: "allow", confidence: 0.96 },
      risk: { type: "choice", choice: "ordinary", confidence: 0.92 },
      goal_aligned: { type: "noul", noul: 0.95 },
      tool_match: { type: "noul", noul: 0.2 },
      irreversible: { type: "noul", noul: 0.01 },
      secret_exposure: { type: "noul", noul: 0.01 },
      external_effect: { type: "noul", noul: 0.01 },
      scope_change: { type: "noul", noul: 0.01 },
    },
  }, { mode: "enforce", model: "~typesafe/jev-latest", minConfidence: 0.8 });
  assert(wrongTool.permissionBehavior === "ask", "Jev rejects a selected tool that does not match the enabled tools_list and goal");
  const external = interpretToolJevResponse({
    model: "typesafe/jev-test",
    answers: {
      disposition: { type: "choice", choice: "allow", confidence: 0.96 },
      risk: { type: "choice", choice: "external_effect", confidence: 0.95 },
      goal_aligned: { type: "noul", noul: 0.95 },
      irreversible: { type: "noul", noul: 0.05 },
      secret_exposure: { type: "noul", noul: 0.02 },
      external_effect: { type: "noul", noul: 0.92 },
      scope_change: { type: "noul", noul: 0.03 },
    },
  }, { mode: "enforce", model: "~typesafe/jev-latest", minConfidence: 0.8 });
  assert(external.permissionBehavior === "ask", "external effects still require confirmation");
  assert(shouldUseJevToolClassifier(fakeTool("Write", false)), "mutating tools use the Jev classifier");
  assert(!shouldUseJevToolClassifier(fakeTool("Read", true)), "read-only tools skip unnecessary Jev calls");
  assert(!shouldUseJevToolClassifier(fakeTool("WorkfriendAssess", false)), "Jev-backed tools do not recursively classify themselves");
  assert(!shouldUseJevToolClassifier(fakeTool("ComputerNavigate", false)), "bounded Jev navigation skips the generic Jev classifier");
  assert(!shouldUseJevToolClassifier(fakeTool("FixtureSpecialized", false, "specialized_jev")), "explicit specialized Jev policy skips the generic classifier");
  assert(!shouldUseJevToolClassifier(fakeTool("Agent", false)), "open-ended sub-agent routing remains with the main LLM");

  console.log("\n[2] Jev search reranking");
  const results = [
    { title: "Secondary commentary", url: "https://example.com/post", snippet: "Discussion" },
    { title: "Official specification", url: "https://docs.example.org/spec", snippet: "Primary documentation" },
  ];
  const searchRequest = buildSearchRerankRequest("official specification", results);
  assert(Object.keys(searchRequest.questions).length === 4, "search rerank batches relevance and quality for every result");
  const reranked = applySearchRerankResponse(results, {
    model: "typesafe/jev-test",
    answers: {
      r0_relevant: { type: "noul", noul: 0.45 },
      r0_quality: { type: "score", score: 1 },
      r1_relevant: { type: "noul", noul: 0.98 },
      r1_quality: { type: "score", score: 3 },
    },
  });
  assert(reranked[0]?.title === "Official specification", "Jev relevance and quality reorder search results");

  console.log("\n[3] Jev Rhino route validation");
  const rhinoObservation: RhinoJevObservation = {
    observationId: "00000000-0000-4000-8000-000000000000",
    capturedAt: "2026-01-01T00:00:00.000Z",
    document: { units: "Meters", object_count: 0 },
    layers: [],
    selection: [],
    objects: [],
    command: { in_command: false },
    undo: { recording_active: true },
  };
  const rhinoConfig = { mode: "enforce", model: "~typesafe/jev-latest", minConfidence: 0.8 } as const;
  const createRequest = buildRhinoJevRequest(
    "create_geometry",
    { intent: "create a floor slab", primitive: "box", min: [-1, -1, 0], max: [1, 1, 0.25] },
    rhinoObservation,
  );
  assert(
    !("target_valid" in createRequest.questions),
    "target-less create_geometry is not asked an unanswerable target_valid question",
  );
  assert(
    "parameters_valid" in createRequest.questions && "route" in createRequest.questions,
    "target-less create_geometry still validates route and parameters",
  );
  assert(
    JSON.stringify(createRequest.state).includes('"source":"internal_cached_manifest"') &&
      JSON.stringify(createRequest.state).includes('"selected_tool":"RhinoAction"'),
    "Rhino Jev receives the bounded internal tools_list and selected structured tool",
  );
  const layerRequest = buildRhinoJevRequest(
    "set_layer",
    { intent: "move objects to a layer", target_guids: ["00000000-0000-4000-8000-000000000001"], layer: "楼板" },
    rhinoObservation,
  );
  assert("target_valid" in layerRequest.questions, "target operations still ask target_valid");

  const allowedCreation = interpretRhinoJevResponse({
    model: "typesafe/jev-test",
    answers: {
      route: { type: "choice", choice: "rhino_api", confidence: 0.95 },
      next_action: { type: "choice", choice: "create_geometry", confidence: 0.95 },
      parameters_valid: { type: "noul", noul: 0.9 },
      destructive: { type: "noul", noul: 0.05 },
      expected_progress: { type: "noul", noul: 0.9 },
    },
  }, "create_geometry", rhinoConfig);
  assert(
    allowedCreation.forceObserve !== true && allowedCreation.permissionBehavior === "allow",
    "a well-formed target-less creation is allowed instead of looping on 'requires a fresh RhinoObserve'",
  );

  const legacyCreation = interpretRhinoJevResponse({
    model: "typesafe/jev-test",
    answers: {
      route: { type: "choice", choice: "rhino_api", confidence: 0.82 },
      next_action: { type: "choice", choice: "create_geometry", confidence: 0.95 },
      target_valid: { type: "noul", noul: 0.35 },
      parameters_valid: { type: "noul", noul: 0.68 },
      destructive: { type: "noul", noul: 0.07 },
      expected_progress: { type: "noul", noul: 0.81 },
    },
  }, "create_geometry", rhinoConfig);
  assert(
    legacyCreation.forceObserve !== true && legacyCreation.permissionBehavior === "allow",
    "create_geometry ignores an unexpected legacy target_valid answer",
  );

  const forcedObserve = interpretRhinoJevResponse({
    model: "typesafe/jev-test",
    answers: {
      route: { type: "choice", choice: "rhino_api", confidence: 0.95 },
      next_action: { type: "choice", choice: "set_layer", confidence: 0.95 },
      target_valid: { type: "noul", noul: 0.3 },
      parameters_valid: { type: "noul", noul: 0.9 },
      destructive: { type: "noul", noul: 0.05 },
      expected_progress: { type: "noul", noul: 0.9 },
    },
  }, "set_layer", rhinoConfig);
  assert(
    forcedObserve.forceObserve === true,
    "a low target_valid score still forces a fresh observation for a GUID-targeted action",
  );
  const invalidParameters = interpretRhinoJevResponse({ model:"typesafe/jev-test", answers: {
    route:{type:"choice",choice:"rhino_api",confidence:0.95}, next_action:{type:"choice",choice:"inspect",confidence:0.95}, parameters_valid:{type:"noul",noul:0.2},
  } }, "loft", rhinoConfig);
  assert(invalidParameters.requiresReplan === true && !invalidParameters.forceObserve, "invalid loft parameters require correction instead of a repeated observation loop");
  const lastObject = {guid:"00000000-0000-4000-8000-000000000201",type:"Curve"};
  const largeRequest = buildRhinoJevRequest("loft", {target_guids:[lastObject.guid]}, {...rhinoObservation,objects:[...Array.from({length:200},(_,i)=>({guid:String(i)})),lastObject]});
  assert(JSON.stringify(largeRequest.state).includes('"action_targets":[{"guid":"'+lastObject.guid+'"'), "Jev sees referenced objects beyond the 200-object context cut");
  assert(!("target_valid" in buildRhinoJevRequest("loft",{sections:[{z:0,width:44,depth:44},{z:300,width:38,depth:38}]},rhinoObservation).questions), "numerical loft does not request nonexistent target validation");

  console.log(failures === 0 ? "\nAll Jev decision checks passed." : `\n${failures} Jev decision check(s) failed.`);
  process.exitCode = failures === 0 ? 0 : 1;
}

void main();
