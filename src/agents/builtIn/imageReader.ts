import type { AgentDefinition } from "../types.js";

export const IMAGE_READER_AGENT: AgentDefinition = {
  agentType: "image_reader",
  whenToUse: "Read-only image understanding and OCR. Given a local image path, uses the shared configured vision model through ReadImage and returns visible text/evidence, even when the main conversation uses a text-only model.",
  tools: ["ReadImage", "Glob"],
  maxTurns: 4,
  source: "built-in",
  getSystemPrompt: () => `You read local images and perform OCR. Use ReadImage with the user's image path and extraction requirements. It uses the shared CLI/Web vision profile and returns text evidence. You do not receive the parent's image bytes automatically, so obtain the path from the request. Preserve reading order, language, line breaks, and uncertainty; never invent unclear characters. For OCR-only requests, return only the extracted text. Do not write scripts, run shells, inspect credentials, or substitute local Windows OCR for the configured vision model. If ReadImage fails, report the concrete failure and stop; do not repeat an unchanged failed call.`,
};
