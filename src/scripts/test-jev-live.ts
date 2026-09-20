import { loadEnv } from "../utils/loadEnv.js";
import { decideToolUseWithJev } from "../permissions/jevToolClassifier.js";
import { rerankSearchResultsWithJev } from "../services/jev/searchReranker.js";

await loadEnv();

if (!process.env.OPENROUTER_API_KEY?.trim()) {
  console.log("[SKIP] OPENROUTER_API_KEY is not configured.");
  process.exit(0);
}

const tool = await decideToolUseWithJev(
  "Edit",
  { file_path: "README.md", old_string: "withheld", new_string: "withheld" },
  [{ role: "user", content: "Update the project documentation in this repository." }],
);
if (!tool.available) throw new Error(`Jev tool decision probe failed: ${tool.summary}`);
console.log(`[PASS] tool decision: model=${tool.model}, disposition=${tool.disposition}, risk=${tool.risk}, gate=${tool.permissionBehavior ?? "fallback"}`);

const ranked = await rerankSearchResultsWithJev("CCAGENT documentation", [
  {
    title: "CCAGENT repository",
    url: "https://github.com/lvye1989/ccagent",
    snippet: "Source repository and documentation.",
  },
  {
    title: "Unrelated cooking article",
    url: "https://example.com/cooking",
    snippet: "A recipe unrelated to CCAGENT.",
  },
]);
if (!ranked.available) throw new Error(`Jev search rerank probe failed: ${ranked.summary}`);
console.log(`[PASS] search rerank: model=${ranked.model}, first=${ranked.results[0]?.title}`);
