#!/usr/bin/env tsx
import { readFile, rm, stat } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { tryExpandBuiltinPromptCommand } from "../commands/builtinPromptCommands.js";
import { askUserQuestionTool } from "../tools/askUserQuestionTool.js";
import { workfriendAssessTool } from "../tools/workfriendAssessTool.js";
import { workfriendDeliverTool } from "../tools/workfriendDeliverTool.js";
import { workfriendScheduleTool } from "../tools/workfriendScheduleTool.js";
import { findToolByName } from "../tools/index.js";
import {
  clearWorkfriendTimers,
  createWorkfriendSchedule,
  getWorkfriendSchedulePath,
  listWorkfriendSchedules,
} from "../workfriend/scheduler.js";
import { clearPendingNotifications, peekPendingNotifications } from "../state/notificationStore.js";
import { checkPermission } from "../permissions/permissions.js";
import {
  buildWorkfriendJevRequest,
  interpretWorkfriendJevResponse,
} from "../workfriend/jevAssessment.js";

let failures = 0;
function assert(condition: unknown, label: string): void {
  console.log(`${condition ? "  ✓" : "  ✗"} ${label}`);
  if (!condition) failures++;
}

async function main(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "ccagent-workfriend-"));
  const previousHome = process.env.CCAGENT_HOME;
  const previousDashscopeKey = process.env.DASHSCOPE_API_KEY;
  process.env.CCAGENT_HOME = path.join(root, ".ccagent");
  try {
    console.log("[1] registration + slash command");
    assert(findToolByName("WorkfriendAssess") === workfriendAssessTool, "Jev assessment tool is registered");
    assert(findToolByName("WorkfriendSchedule") === workfriendScheduleTool, "schedule tool is registered");
    assert(findToolByName("WorkfriendDeliver") === workfriendDeliverTool, "delivery tool is registered");
    const expansion = tryExpandBuiltinPromptCommand("/workfriend");
    assert(expansion?.name === "workfriend", "/workfriend expands as a built-in prompt command");
    assert(expansion?.bodyText.includes("existing context remains available"), "launcher retains main context");
    assert(expansion?.bodyText.includes("WorkfriendAssess"), "launcher delegates scoring and action choice to Jev");

    console.log("\n[2] Jev mood/stress decision boundary");
    const request = buildWorkfriendJevRequest({
      phase: "end_of_day",
      workSummary: "Prepare a project review",
      moodEvidence: "Frustrated but safe",
      stressEvidence: "High pressure from a deadline",
      progressAndBottlenecks: "Blocked on a manager decision",
    });
    assert(request.questions.mood_strain?.type === "score", "mood strain uses a typed Jev score");
    assert(request.questions.stress_load?.type === "score", "stress load uses a typed Jev score");
    assert(request.questions.next_action?.type === "choice", "next action is delegated as a typed Jev choice");
    const ordinaryAssessment = interpretWorkfriendJevResponse({
      model: "typesafe/jev-test",
      answers: {
        mood_strain: { type: "score", score: 2, confidence: 0.91 },
        stress_load: { type: "score", score: 3, confidence: 0.92 },
        work_state: { type: "choice", choice: "blocked", confidence: 0.93 },
        next_action: { type: "choice", choice: "solve_primary_blocker", confidence: 0.94 },
        urgent_support_signal: { type: "noul", noul: 0.02, confidence: 0.95 },
      },
    }, { mode: "decision", model: "~typesafe/jev-latest" });
    assert(ordinaryAssessment.moodStrainScore === 2 && ordinaryAssessment.stressLoadScore === 3, "Jev scores are normalized to the 0-4 scale");
    assert(ordinaryAssessment.decisionAuthority === "jev" && ordinaryAssessment.recommendedAction === "solve_primary_blocker", "decision mode gives Jev primary action authority");
    const safetyAssessment = interpretWorkfriendJevResponse({
      model: "typesafe/jev-test",
      answers: {
        mood_strain: { type: "score", score: 4 },
        stress_load: { type: "score", score: 4 },
        work_state: { type: "choice", choice: "depleted" },
        next_action: { type: "choice", choice: "continue_current_plan" },
        urgent_support_signal: { type: "noul", noul: 0.88 },
      },
    }, { mode: "decision", model: "~typesafe/jev-latest" });
    assert(safetyAssessment.safetyOverride && safetyAssessment.recommendedAction === "seek_urgent_human_support", "fixed safety floor overrides an unsafe ordinary Jev action");
    assert(!workfriendAssessTool.isReadOnly(), "external wellbeing-text transmission requires the normal permission path");
    const assessmentInput = {
      phase: "start_of_day",
      work_summary: "Review a project",
      mood_evidence: "Steady",
      stress_evidence: "Moderate",
    };
    const defaultPermission = await checkPermission({
      tool: workfriendAssessTool,
      input: assessmentInput,
      cwd: root,
      mode: "default",
    });
    const fullPermission = await checkPermission({
      tool: workfriendAssessTool,
      input: assessmentInput,
      cwd: root,
      mode: "full",
    });
    assert(defaultPermission.behavior === "ask" && fullPermission.behavior === "ask", "wellbeing-text transfer requires fresh consent even in Full Mode");

    console.log("\n[3] question-card limit");
    const makeQuestion = (n: number) => ({
      question: `Question ${n}?`,
      header: `Q${n}`,
      options: [{ label: "A" }, { label: "B" }],
    });
    const ten = await askUserQuestionTool.call(
      { questions: Array.from({ length: 10 }, (_, index) => makeQuestion(index + 1)) },
      {
        cwd: root,
        requestUserQuestion: async (request) => ({
          answers: Object.fromEntries(request.questions.map((q) => [q.question, "A"])),
        }),
      },
    );
    assert(!ten.isError, "10 interactive questions are accepted");
    const eleven = await askUserQuestionTool.call(
      { questions: Array.from({ length: 11 }, (_, index) => makeQuestion(index + 1)) },
      { cwd: root, requestUserQuestion: async () => null },
    );
    assert(eleven.isError && String(eleven.content).includes("at most 10"), "11 questions are rejected");

    console.log("\n[4] persistent schedule");
    const now = new Date();
    const end = new Date(now.getTime() + 2 * 60 * 60 * 1000);
    const hhmm = `${String(end.getHours()).padStart(2, "0")}:${String(end.getMinutes()).padStart(2, "0")}`;
    const scheduled = await workfriendScheduleTool.call(
      {
        action: "schedule",
        workday_end: hhmm,
        work_summary: "Finish the Workfriend implementation",
        mood_summary: "Focused but slightly tired",
        assessment_summary: "mood_strain=1/4, stress_load=2/4, next_action=continue_current_plan",
        context_summary: "The implementation and its tests are the active context.",
      },
      { cwd: root },
    );
    assert(!scheduled.isError, "schedule tool creates a reminder");
    assert((await stat(getWorkfriendSchedulePath())).size > 0, "schedule persists under CCAGENT_HOME");
    const schedules = await listWorkfriendSchedules();
    assert(schedules.length === 1 && schedules[0]?.status === "pending", "persisted schedule can be restored");
    assert(schedules[0]?.contextSummary?.includes("active context"), "relevant conversation context is persisted for restart recovery");
    assert(schedules[0]?.assessmentSummary?.includes("stress_load=2/4"), "concise Jev assessment is persisted without the full questionnaire");
    const cancelled = await workfriendScheduleTool.call(
      { action: "cancel", schedule_id: schedules[0]?.id },
      { cwd: root },
    );
    assert(!cancelled.isError, "pending reminder can be cancelled");

    clearPendingNotifications();
    const soonEnd = new Date(Date.now() + 30 * 60 * 1000);
    const soonHhmm = `${String(soonEnd.getHours()).padStart(2, "0")}:${String(soonEnd.getMinutes()).padStart(2, "0")}`;
    await createWorkfriendSchedule({
      workdayEnd: soonHhmm,
      workSummary: "A near-end-of-day task",
      moodSummary: "Steady",
      contextSummary: "Keep the active context available.",
      cwd: root,
    });
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    const notifications = peekPendingNotifications();
    assert(notifications.length === 1 && notifications[0]?.mode === "workfriend-notification", "a due schedule emits a Workfriend notification");
    assert(notifications[0]?.text.includes("conversation_context_summary"), "the reminder carries its restart-safe context summary");
    clearPendingNotifications();

    console.log("\n[5] Word + voice delivery boundaries");
    const docxPath = path.join(root, "workfriend-test.docx");
    const word = await workfriendDeliverTool.call(
      {
        format: "word",
        title: "Workfriend Test",
        content: "# Progress\n- Finished implementation\n\n## Next step\nRun verification.",
        output_path: docxPath,
      },
      { cwd: root },
    );
    assert(!word.isError, "Word delivery succeeds without Office or extra dependencies");
    const docx = await readFile(docxPath);
    assert(docx.subarray(0, 2).toString() === "PK", "Word output is a ZIP-based DOCX");
    assert(docx.includes(Buffer.from("word/document.xml")), "DOCX contains the main Word document part");

    delete process.env.DASHSCOPE_API_KEY;
    const voice = await workfriendDeliverTool.call(
      { format: "voice", content: "A short check-in.", output_path: path.join(root, "voice.wav") },
      { cwd: root },
    );
    assert(voice.isError && String(voice.content).includes("DASHSCOPE_API_KEY"), "voice delivery fails clearly when no key is configured");
  } finally {
    clearWorkfriendTimers();
    if (previousHome === undefined) delete process.env.CCAGENT_HOME;
    else process.env.CCAGENT_HOME = previousHome;
    if (previousDashscopeKey === undefined) delete process.env.DASHSCOPE_API_KEY;
    else process.env.DASHSCOPE_API_KEY = previousDashscopeKey;
    await rm(root, { recursive: true, force: true });
  }
  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exitCode = failures === 0 ? 0 : 1;
}

void main();
