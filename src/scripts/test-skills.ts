#!/usr/bin/env tsx
/**
 * Stage 17 verification script — exercise the Skills subsystem WITHOUT
 * touching the LLM. Lets you validate the file loader, frontmatter
 * parser, registry split (dynamic vs conditional), budget formatter,
 * conditional activation, and SkillTool execution end-to-end against
 * the example skills under `<cwd>/.ccagent/skills/`.
 *
 * Usage:
 *   cd ccagent
 *   npx tsx src/scripts/test-skills.ts
 *
 * Exits non-zero if any assertion fails — convenient for CI / manual checks.
 */

import { bootstrapSkills } from "../services/skills/bootstrap.js";
import {
  findSkill,
  getAllUserInvocableSkills,
  getModelVisibleSkills,
  listConditionalSkills,
} from "../services/skills/registry.js";
import { formatSkillsSystemReminder } from "../services/skills/budget.js";
import { activateConditionalSkillsForPaths } from "../services/skills/conditional.js";
import { skillTool } from "../tools/skillTool.js";
import { toolResultText } from "../tools/Tool.js";
import { matchesPermissionRule } from "../permissions/permissions.js";
import { QueryEngine } from "../core/queryEngine.js";
import * as os from "node:os";
import * as path from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";

let cwd = process.cwd();

const failures: string[] = [];
function assert(condition: unknown, label: string): void {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    console.log(`  ✗ ${label}`);
    failures.push(label);
  }
}

async function main(): Promise<void> {
  // The published package does not ship the ignored `.ccagent/` examples.
  // Build the documented fixture set in a disposable project so this test is
  // deterministic and cannot be affected by (or overwrite) the user's skills.
  cwd = await mkdtemp(path.join(os.tmpdir(), "ccagent-skills-"));
  const skillsDir = path.join(cwd, ".ccagent", "skills");
  const fixtures: Record<string, string> = {
    "hello-world": `---
name: hello-world
description: Test greeting skill
---
Hello $ARGUMENTS from \${CLAUDE_SESSION_ID} in \${CLAUDE_SKILL_DIR}.
`,
    "test-reviewer": `---
name: test-reviewer
description: Conditional test review skill
paths:
  - "**/*.test.ts"
---
Review the test file.
`,
    "secret-handshake": `---
name: secret-handshake
description: Hidden test skill
disable-model-invocation: true
---
Secret.
`,
    "dotted.skill": `---
name: dotted.skill
description: Dotted-name regression fixture
---
Dotted skill received $ARGUMENTS.
`,
  };
  for (const [name, body] of Object.entries(fixtures)) {
    const dir = path.join(skillsDir, name);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "SKILL.md"), body, "utf-8");
  }

  console.log(`\n[1] bootstrapSkills(${cwd})`);
  const result = await bootstrapSkills(cwd);
  console.log(
    `    loaded ${result.skillCount} unconditional + ${result.conditionalCount} conditional skill(s); ${result.warnings.length} warning(s).`,
  );

  console.log("\n[2] Registry split");
  const allUserInvocable = getAllUserInvocableSkills();
  const visibleToModel = getModelVisibleSkills();
  const conditional = listConditionalSkills();
  console.log(`    user-invocable: ${allUserInvocable.map((s) => s.name).join(", ")}`);
  console.log(`    model-visible:  ${visibleToModel.map((s) => s.name).join(", ")}`);
  console.log(`    conditional:    ${conditional.map((s) => s.name).join(", ")}`);

  assert(findSkill("hello-world"), "hello-world skill loaded");
  assert(findSkill("test-reviewer"), "test-reviewer skill loaded (conditional)");
  assert(findSkill("secret-handshake"), "secret-handshake skill loaded (hidden)");
  assert(findSkill("dotted.skill"), "dotted.skill exact name loaded");

  assert(
    !visibleToModel.some((s) => s.name === "secret-handshake"),
    "secret-handshake is HIDDEN from the model listing (disable-model-invocation: true)",
  );
  assert(
    !visibleToModel.some((s) => s.name === "test-reviewer"),
    "test-reviewer is HIDDEN from the initial model listing (paths gates it)",
  );
  assert(
    visibleToModel.some((s) => s.name === "hello-world"),
    "hello-world IS visible to the model",
  );
  assert(
    visibleToModel.some((s) => s.name === "dotted.skill"),
    "dotted.skill IS visible to the model",
  );

  console.log("\n[3] system-reminder formatting (initial)");
  const reminder = formatSkillsSystemReminder(visibleToModel);
  console.log(reminder.split("\n").map((l) => `    ${l}`).join("\n"));
  assert(reminder.includes("hello-world"), "system-reminder mentions hello-world");
  assert(!reminder.includes("test-reviewer"), "system-reminder does NOT mention test-reviewer initially");
  assert(!reminder.includes("secret-handshake"), "system-reminder does NOT mention secret-handshake");

  console.log("\n[4] Conditional activation via file path match");
  const activated = activateConditionalSkillsForPaths(["src/foo.test.ts"], cwd);
  console.log(`    activated: ${activated.join(", ") || "(none)"}`);
  assert(activated.includes("test-reviewer"), "test-reviewer activated by *.test.ts path");
  const reminderAfter = formatSkillsSystemReminder(getModelVisibleSkills());
  assert(reminderAfter.includes("test-reviewer"), "test-reviewer NOW appears in the system-reminder");

  console.log("\n[5] Permission rule matching");
  assert(
    matchesPermissionRule("Skill(hello-world)", "Skill", { skill: "hello-world" }),
    "Skill(hello-world) matches exactly",
  );
  assert(
    !matchesPermissionRule("Skill(hello-world)", "Skill", { skill: "test-reviewer" }),
    "Skill(hello-world) does NOT match test-reviewer",
  );
  assert(
    matchesPermissionRule("Skill(test-*)", "Skill", { skill: "test-reviewer" }),
    "Skill(test-*) prefix-matches test-reviewer",
  );
  assert(
    !matchesPermissionRule("Skill(test-*)", "Skill", { skill: "hello-world" }),
    "Skill(test-*) does NOT match hello-world",
  );

  console.log("\n[6] SkillTool.call() — variable substitution");
  const okResult = await skillTool.call(
    { skill: "hello-world", args: "CCAGENT" },
    { cwd, sessionId: "session-test-abc" },
  );
  const okText = toolResultText(okResult.content);
  console.log(okText.split("\n").slice(0, 8).map((l) => `    ${l}`).join("\n"));
  assert(!okResult.isError, "Skill call succeeded");
  assert(okText.includes("CCAGENT"), "$ARGUMENTS substituted with \"CCAGENT\"");
  assert(okText.includes("session-test-abc"), "${CLAUDE_SESSION_ID} substituted");
  assert(
    okText.includes(".ccagent/skills/hello-world"),
    "${CLAUDE_SKILL_DIR} substituted with the absolute skill path",
  );

  const dottedResult = await skillTool.call(
    { skill: "dotted.skill", args: "works" },
    { cwd, sessionId: "dot-test" },
  );
  const dottedText = toolResultText(dottedResult.content);
  assert(!dottedResult.isError && dottedText.includes("works"), "SkillTool accepts dotted skill names");

  const engine = new QueryEngine({
    model: "test-model",
    toolContext: { cwd, sessionId: "dot-slash-test" },
    permissionMode: "default",
    permissionSettings: { allow: [], deny: [], mode: "default" },
  });
  const slashExpansion = (
    engine as unknown as {
      tryExpandSkillCommand(input: string): { skill: { name: string }; bodyText: string } | null;
    }
  ).tryExpandSkillCommand("/dotted.skill slash-works");
  assert(
    slashExpansion?.skill.name === "dotted.skill" && slashExpansion.bodyText.includes("slash-works"),
    "slash command parser accepts dotted skill names",
  );

  console.log("\n[7] SkillTool.call() — disable-model-invocation rejected");
  const hiddenResult = await skillTool.call(
    { skill: "secret-handshake" },
    { cwd, sessionId: "x" },
  );
  const hiddenText = toolResultText(hiddenResult.content);
  console.log(`    ${hiddenText.split("\n")[0]}`);
  assert(hiddenResult.isError, "Hidden skill rejected when invoked by the model");
  assert(
    hiddenText.includes("disable-model-invocation"),
    "Error message mentions disable-model-invocation",
  );

  console.log("\n[8] SkillTool.call() — unknown skill rejected");
  const unknownResult = await skillTool.call(
    { skill: "does-not-exist" },
    { cwd, sessionId: "x" },
  );
  assert(unknownResult.isError, "Unknown skill name returns an error");

  console.log("\n[9] SkillTool.call() — invalid name rejected");
  const invalidNameResult = await skillTool.call(
    { skill: "../../etc/passwd" },
    { cwd, sessionId: "x" },
  );
  assert(invalidNameResult.isError, "Skill name with path traversal characters is rejected");

  await rm(cwd, { recursive: true, force: true });

  if (failures.length > 0) {
    console.error(`\n${failures.length} assertion(s) failed:`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }

  console.log("\nAll skills checks passed.\n");
}

main().catch((err: unknown) => {
  console.error("Fatal:", err);
  process.exit(1);
});
