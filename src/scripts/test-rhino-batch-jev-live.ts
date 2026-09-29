/** Opt-in provider smoke test. Sends only synthetic, read-only Rhino state. */
import "dotenv/config";
import { decideRhinoSequenceBatchWithJev } from "../tools/rhinoJev.js";

// Do not inherit a local development setting that disables HTTPS verification.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "1";

const observation = {
  observationId: "synthetic-readonly",
  capturedAt: new Date().toISOString(),
  document: { runtime_serial: 1, units: "Meters", name: "Synthetic" },
  layers: [], selection: [], objects: [], command: { in_command: false }, undo: {},
};
const steps = [
  { id: "point_a", action: "create_geometry" as const,
    parameters: { intent: "Create two independent points", primitive: "point", point: [0, 0, 0] } },
  { id: "point_b", action: "create_geometry" as const,
    parameters: { intent: "Create two independent points", primitive: "point", point: [1, 0, 0] } },
];
try {
  const result = await decideRhinoSequenceBatchWithJev(steps, observation);
  console.log(JSON.stringify({ batch_ms: result.durationMs,
    steps: Object.fromEntries(Object.entries(result.decisions).map(([id, decision]) => [id, {
      available: decision.available, route: decision.route, next_action: decision.nextAction,
      confidence: decision.routeConfidence, parameters_valid: decision.parametersValid,
    }])) }));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`live_jev_error=${message.replace(/sk-or-[A-Za-z0-9_-]+/g, "<redacted>").replace(/Bearer\s+\S+/gi, "Bearer <redacted>").slice(0, 240)}`);
  process.exitCode = 1;
}
