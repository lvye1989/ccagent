import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { QueryEngine } from "../core/queryEngine.js";
import {
  isMailPowerEnabled,
  loadMailPowerSettings,
  mailPowerForOperation,
  setMailPower,
} from "../config/mailPowerSettings.js";
import { classifyUserInput } from "../ui/hooks/useAgentSession/inputClassification.js";
import { isBuiltinCommandName } from "../commands/builtinCommandNames.js";
import { mailTool } from "../tools/mailTool.js";
import type { ToolContext } from "../tools/Tool.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "ccagent-powersetting-"));
const home = path.join(root, "user");
const previousHome = process.env.CCAGENT_HOME;
const previousFetch = globalThis.fetch;
process.env.CCAGENT_HOME = home;
globalThis.fetch = async () => { throw new Error("Local command unexpectedly called a provider"); };
const settingsPath = path.join(home, "settings.json");
const context: ToolContext = { cwd: root, sessionId: "powersetting-fixture" };
let checks = 0;
function check(condition: unknown, label: string): void {
  assert.ok(condition, label);
  checks++;
  console.log(`  [PASS] ${label}`);
}
async function command(input: string, toolContext: ToolContext = context): Promise<string> {
  const output: string[] = [];
  const engine = new QueryEngine({ model: "no-network", toolContext });
  for await (const event of engine.submitMessage(input)) {
    assert.equal(event.type, "command", "Mail power command must stay local");
    if (event.type === "command") output.push(`${event.kind}: ${event.message}`);
  }
  return output.join("\n");
}

try {
  check(isBuiltinCommandName("powersetting") && !classifyUserInput("/powersetting").isLlmTriggering,
    "Slash command is reserved and handled locally without a model");
  check(!(await isMailPowerEnabled("qq", "read")) && !(await isMailPowerEnabled("163", "send")),
    "Every mailbox power defaults off");
  const directToolResult = await mailTool.call({ account: "qq", operation: "list" }, context);
  check(directToolResult.isError === true && String(directToolResult.content).includes("closed"),
    "Direct Mail tool calls respect the same closed switch");
  check(mailPowerForOperation("list") === "read" && mailPowerForOperation("read") === "read" &&
    mailPowerForOperation("draft") === "write" && mailPowerForOperation("search") === "search" &&
    mailPowerForOperation("delete") === "delete" && mailPowerForOperation("send") === "send" &&
    mailPowerForOperation("other") === null,
    "All Mail operations map to the intended power");

  await fs.mkdir(path.join(root, ".ccagent"), { recursive: true });
  await fs.writeFile(path.join(root, ".ccagent", "settings.json"), JSON.stringify({
    mailPowers: { qq: { read: true, send: true }, "163": { delete: true } },
  }));
  check(!(await isMailPowerEnabled("qq", "list")) && !(await isMailPowerEnabled("163", "delete")),
    "Project settings cannot enable mailbox access");
  check((await command("/powersetting list")).includes("QQ 邮箱") &&
    (await command("/powersetting list")).includes("163 邮箱"), "List reports both accounts");

  await fs.mkdir(home, { recursive: true });
  await fs.writeFile(settingsPath, JSON.stringify({ custom: { keep: true } }), "utf8");
  check((await command("/powersetting qq read on")).includes("读信（列信、读信）：On") &&
    await isMailPowerEnabled("qq", "list"), "Read switch takes effect without restart");
  check(!(await isMailPowerEnabled("qq", "send")) && !(await isMailPowerEnabled("163", "read")),
    "Other powers and account stay off");
  check((await command("/powersetting 163 send open")).includes("On") &&
    await isMailPowerEnabled("163", "send"), "Open alias enables 163 send independently");
  check((await command("/powersetting qq read 关")).includes("Off") &&
    !(await isMailPowerEnabled("qq", "read")), "Chinese close alias disables a power");
  check((await command("/powersetting qq write 开")).includes("On") &&
    await isMailPowerEnabled("qq", "draft"), "Chinese open alias controls draft creation");
  check((await command("/powersetting qq delete on")).includes("删信：On") &&
    await isMailPowerEnabled("qq", "delete"), "Delete switch is available through the slash command");
  check((await command("/powersetting 163 send close")).includes("Off") &&
    !(await isMailPowerEnabled("163", "send")), "Close alias disables send");
  await Promise.all([
    setMailPower("qq", "delete", true),
    setMailPower("163", "search", true),
  ]);
  check(await isMailPowerEnabled("qq", "delete") && await isMailPowerEnabled("163", "search"),
    "Concurrent writes preserve both independent switches");
  check((JSON.parse(await fs.readFile(settingsPath, "utf8")) as Record<string, unknown>).custom !== undefined,
    "Writes preserve unrelated user settings");
  check(!(await isMailPowerEnabled("unknown", "read")) && !(await isMailPowerEnabled("qq", "unknown")),
    "Unknown account and operation fail closed");
  check((await command("/powersetting qq send maybe")).startsWith("error:"),
    "Unknown command argument cannot change permissions");

  let questions = 0;
  const interactive: ToolContext = { ...context, requestUserQuestion: async (request) => {
    questions++;
    const question = request.questions[0];
    const answer = question.header === "邮箱" ? "QQ 邮箱"
      : question.header === "权限" && question.question.includes("1/2") ? "下一页"
      : question.header === "权限" ? "查" : "开";
    assert.ok(question.options.some((option) => option.label === answer));
    return { answers: { [question.question]: answer } };
  } };
  check((await command("/powersetting", interactive)).includes("查信：On") &&
    await isMailPowerEnabled("qq", "search") && questions === 4,
    "Interactive menu can select account, second-page power, and On");
  const beforeCancel = await loadMailPowerSettings();
  check((await command("/powersetting", {
    ...context, requestUserQuestion: async () => null,
  })).includes("已取消") &&
    JSON.stringify(await loadMailPowerSettings()) === JSON.stringify(beforeCancel),
    "Cancelling interactive menu leaves settings untouched");

  await fs.writeFile(settingsPath, "{ invalid json", "utf8");
  check(!(await isMailPowerEnabled("qq", "search")) && !(await isMailPowerEnabled("163", "send")),
    "Unreadable or malformed user settings disable every power");
  check((await command("/powersetting qq send on")).includes("settings left unchanged") &&
    await fs.readFile(settingsPath, "utf8") === "{ invalid json",
    "Malformed settings are not overwritten by the command");
  await fs.writeFile(settingsPath, "null", "utf8");
  check((await command("/powersetting qq send on")).includes("JSON object") &&
    await fs.readFile(settingsPath, "utf8") === "null", "Non-object settings are not overwritten");

  console.log(`\nAll ${checks} mail power setting checks passed.`);
} finally {
  globalThis.fetch = previousFetch;
  if (previousHome === undefined) delete process.env.CCAGENT_HOME;
  else process.env.CCAGENT_HOME = previousHome;
  const resolvedTmp = path.resolve(os.tmpdir());
  const resolvedRoot = path.resolve(root);
  const relative = path.relative(resolvedTmp, resolvedRoot);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || !path.basename(resolvedRoot).startsWith("ccagent-powersetting-")) {
    throw new Error("Refusing to remove power settings test directory outside the expected temporary root");
  }
  await fs.rm(resolvedRoot, { recursive: true, force: true });
}
