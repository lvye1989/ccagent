#!/usr/bin/env tsx

import type { Tool } from "../tools/Tool.js";
import {
  buildToolJevRequest,
  interpretToolJevResponse,
  sanitizeToolInputForJev,
  shouldUseJevToolClassifier,
} from "../permissions/jevToolClassifier.js";
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

function fakeTool(name: string, readOnly: boolean): Tool {
  return {
    name,
    description: "test",
    inputSchema: { type: "object", properties: {} },
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
  const request = buildToolJevRequest("Write", { file_path: "src/app.ts", content: "secret body" }, [
    { role: "user", content: "Update src/app.ts and never reveal token=abc123-private." },
  ]);
  assert(Boolean(request.questions.disposition && request.questions.goal_aligned), "tool decision batches disposition and alignment");
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
    },
  }, { mode: "enforce", model: "~typesafe/jev-latest", minConfidence: 0.8 });
  assert(safe.permissionBehavior === "allow", "scoped reversible file edits bypass the general LLM classifier");
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
