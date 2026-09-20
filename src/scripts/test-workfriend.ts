#!/usr/bin/env tsx
import { readFile, rm, stat } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { tryExpandBuiltinPromptCommand } from "../commands/builtinPromptCommands.js";
import { askUserQuestionTool } from "../tools/askUserQuestionTool.js";
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
    assert(findToolByName("WorkfriendSchedule") === workfriendScheduleTool, "schedule tool is registered");
    assert(findToolByName("WorkfriendDeliver") === workfriendDeliverTool, "delivery tool is registered");
    const expansion = tryExpandBuiltinPromptCommand("/workfriend");
    assert(expansion?.name === "workfriend", "/workfriend expands as a built-in prompt command");
    assert(expansion?.bodyText.includes("existing context remains available"), "launcher retains main context");

    console.log("\n[2] question-card limit");
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

    console.log("\n[3] persistent schedule");
    const now = new Date();
    const end = new Date(now.getTime() + 2 * 60 * 60 * 1000);
    const hhmm = `${String(end.getHours()).padStart(2, "0")}:${String(end.getMinutes()).padStart(2, "0")}`;
    const scheduled = await workfriendScheduleTool.call(
      {
        action: "schedule",
        workday_end: hhmm,
        work_summary: "Finish the Workfriend implementation",
        mood_summary: "Focused but slightly tired",
        context_summary: "The implementation and its tests are the active context.",
      },
      { cwd: root },
    );
    assert(!scheduled.isError, "schedule tool creates a reminder");
    assert((await stat(getWorkfriendSchedulePath())).size > 0, "schedule persists under CCAGENT_HOME");
    const schedules = await listWorkfriendSchedules();
    assert(schedules.length === 1 && schedules[0]?.status === "pending", "persisted schedule can be restored");
    assert(schedules[0]?.contextSummary?.includes("active context"), "relevant conversation context is persisted for restart recovery");
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

    console.log("\n[4] Word + voice delivery boundaries");
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
