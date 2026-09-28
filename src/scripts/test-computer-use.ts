#!/usr/bin/env tsx

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getAllTools } from "../tools/index.js";
import { toolResultText } from "../tools/Tool.js";
import {
  computerActionGroupTool,
  computerActionTool,
  computerNavigateTool,
  computerObserveTool,
  prohibitedWindowReason,
  resolveComputerActionGroupJevDecision,
  validateComputerActionGroup,
  validateComputerKey,
} from "../tools/computerUseTools.js";
import { COMPUTER_USE_BROWSER_FAST_PATH_GUIDANCE } from "../tools/computerUseGuidance.js";
import {
  computerUseActionPowerShell,
  listComputerWindows,
  observeComputerWindow,
  performComputerActions,
} from "../tools/computerUseBackend.js";
import {
  COMPUTER_USE_INDICATOR_SUBTITLE,
  COMPUTER_USE_INDICATOR_TITLE,
  computerUseIndicatorHostPowerShell,
  computerUseIndicatorPowerShell,
  endComputerUseIndicatorSession,
  getComputerUseIndicatorConfig,
  hasComputerUseIndicatorSession,
} from "../tools/computerUseIndicator.js";
import { checkPermission, type PermissionSettings } from "../permissions/permissions.js";
import { loadEnv } from "../utils/loadEnv.js";
import {
  buildComputerUseJevRequest,
  buildComputerNavigationJevRequest,
  getComputerUseJevConfig,
  interpretComputerUseJevResponse,
} from "../tools/computerUseJev.js";
import {
  callOpenRouterJev,
  OpenRouterJevError,
  type JevDecisionResponse,
} from "../services/jev/openRouterJev.js";

const failures: string[] = [];

function assert(condition: unknown, label: string): void {
  console.log("  [" + (condition ? "PASS" : "FAIL") + "] " + label);
  if (!condition) failures.push(label);
}

function withoutWhitespace(value: string): string {
  return value.replace(/\s+/g, "");
}

const settings = (mode: PermissionSettings["mode"]): PermissionSettings => ({
  allow: [],
  deny: [],
  mode,
});

async function launchTestWindow(): Promise<{
  child: ChildProcess;
  dir: string;
  documentPath: string;
  titleHint: string;
}> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ccagent-computer-test-"));
  const titleHint = "CCAgent Computer Use Probe " + Date.now();
  const documentPath = path.join(dir, "probe-output.txt");
  const sourcePath = path.join(dir, "ComputerUseProbe.cs");
  const executablePath = path.join(dir, "CCAgentComputerUseProbe.exe");
  const source = String.raw`using System;
using System.Drawing;
using System.IO;
using System.Windows.Forms;

public static class ComputerUseProbe {
  [STAThread]
  public static void Main(string[] args) {
    string title = args[0];
    string outputPath = args[1];
    Application.EnableVisualStyles();
    Application.SetCompatibleTextRenderingDefault(false);
    var form = new Form {
      Text = title,
      Width = 820,
      Height = 520,
      StartPosition = FormStartPosition.CenterScreen,
      KeyPreview = true
    };
    var editor = new TextBox {
      Name = "ProbeEditor",
      AccessibleName = "Computer Use probe editor",
      Multiline = true,
      Dock = DockStyle.Fill,
      Font = new Font("Segoe UI", 18),
      Text = "Computer Use Observation Probe\r\nProbe Button"
    };
    editor.TextChanged += delegate { form.Text = title + " [modified]"; };
    form.KeyDown += delegate(object sender, KeyEventArgs e) {
      if (e.Control && e.KeyCode == Keys.S) {
        File.WriteAllText(outputPath, editor.Text);
        form.Text = title + " [saved]";
        e.SuppressKeyPress = true;
      }
    };
    form.Controls.Add(editor);
    form.Shown += delegate { editor.Focus(); editor.SelectionStart = editor.TextLength; };
    Application.Run(form);
  }
}`;
  await fs.writeFile(sourcePath, source, "utf-8");
  await fs.writeFile(documentPath, "Computer Use Observation Probe\nProbe Button\n", "utf-8");
  const compileScript = [
    "$ErrorActionPreference = 'Stop'",
    "$source = [System.IO.File]::ReadAllText($env:CC_PROBE_SOURCE)",
    "Add-Type -TypeDefinition $source -ReferencedAssemblies 'System.Windows.Forms','System.Drawing' -OutputAssembly $env:CC_PROBE_EXE -OutputType WindowsApplication",
  ].join("\n");
  const encoded = Buffer.from(compileScript, "utf16le").toString("base64");
  await new Promise<void>((resolve, reject) => {
    const compiler = spawn(
      process.env.CCAGENT_POWERSHELL?.trim() || "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
      {
        windowsHide: true,
        env: { ...process.env, CC_PROBE_SOURCE: sourcePath, CC_PROBE_EXE: executablePath },
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    let stderr = "";
    const timer = setTimeout(() => {
      compiler.kill();
      reject(new Error("Timed out compiling the isolated Computer Use probe."));
    }, 20_000);
    compiler.stderr?.on("data", (chunk: Buffer | string) => { stderr += chunk.toString(); });
    compiler.on("error", reject);
    compiler.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error("Failed to compile the isolated Computer Use probe: " + stderr));
    });
  });
  return {
    child: spawn(executablePath, [titleHint, documentPath], { windowsHide: false, stdio: "ignore" }),
    dir,
    documentPath,
    titleHint,
  };
}

async function findTestWindow(titleHint: string): Promise<Awaited<ReturnType<typeof listComputerWindows>>[number]> {
  for (let attempt = 0; attempt < 30; attempt++) {
    const found = (await listComputerWindows()).find(
      (window) => window.title.toLowerCase().includes(titleHint.toLowerCase()),
    );
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("Test window did not appear.");
}

async function main(): Promise<void> {
  await loadEnv();
  console.log("\n[1] Registry and safety policy");
  const names = new Set(getAllTools().map((tool) => tool.name));
  const orderedNames = getAllTools().map((tool) => tool.name);
  assert(names.has("ComputerObserve") === (process.platform === "win32"), "ComputerObserve Windows registration");
  assert(names.has("ComputerAction") === (process.platform === "win32"), "ComputerAction Windows registration");
  assert(names.has("ComputerActionGroup") === (process.platform === "win32"), "ComputerActionGroup Windows registration");
  assert(names.has("ComputerNavigate") === (process.platform === "win32"), "ComputerNavigate Windows registration");
  assert(
    prohibitedWindowReason({ id: "1", processId: 1, processName: "WindowsTerminal", title: "Terminal" }) !== null,
    "terminal windows are prohibited",
  );
  assert(
    prohibitedWindowReason({ id: "2", processId: 2, processName: "KeePass", title: "Vault" }) !== null,
    "password managers are prohibited",
  );
  assert(validateComputerKey("Windows+r") !== null, "Windows-key shortcuts are prohibited");
  assert(validateComputerKey("Control_L+a") === null, "ordinary keyboard chords are accepted");
  if (process.platform === "win32") {
    assert(
      orderedNames.indexOf("ComputerActionGroup") < orderedNames.indexOf("ComputerAction"),
      "the browser fast path is presented before the single-action fallback",
    );
  }
  assert(
    COMPUTER_USE_BROWSER_FAST_PATH_GUIDANCE.includes("MUST use ComputerActionGroup") &&
      COMPUTER_USE_BROWSER_FAST_PATH_GUIDANCE.includes("stop and report success") &&
      computerActionGroupTool.description.includes(COMPUTER_USE_BROWSER_FAST_PATH_GUIDANCE),
    "the always-on browser routing and completion instructions are also present in the group tool description",
  );
  const groupSchemaProperties = (computerActionGroupTool.inputSchema as {
    properties: Record<string, unknown>;
  }).properties;
  assert(
    !("perception" in groupSchemaProperties) && !("image_delivery" in groupSchemaProperties),
    "the grouped fast path cannot opt back into remote perception or inline image delivery",
  );
  const validBrowserGroup = {
    window_id: "browser",
    snapshot_id: "snapshot",
    goal: "Search the web for current news",
    risk_category: "ordinary" as const,
    actions: [
      { action: "press_key" as const, key: "Control+l" },
      { action: "wait" as const, duration_ms: 150 },
      { action: "type_text" as const, text: "https://www.baidu.com/s?wd=test" },
      { action: "press_key" as const, key: "Enter" },
      { action: "wait" as const, duration_ms: 1_000 },
    ],
  };
  assert(validateComputerActionGroup(validBrowserGroup) === null, "ordinary address-bar search with bounded intermediate/final waits is accepted as one browser action group");
  const browserSnapshot = {
    id: "snapshot",
    createdAt: Date.now(),
    observation: {
      window: { id: "browser", processId: 1, processName: "chrome", title: "Baidu" },
      width: 1_200,
      height: 800,
      nativeWidth: 1_200,
      nativeHeight: 800,
      focusedElement: "ControlType.Document: Baidu",
      elements: [
        {
          index: 74,
          controlType: "Edit",
          name: "百度搜索",
          automationId: "chat-textarea",
          className: "",
          enabled: true,
          focusable: true,
          focused: false,
          x: 200,
          y: 150,
          width: 600,
          height: 40,
        },
        {
          index: 81,
          controlType: "Button",
          name: "百度一下",
          automationId: "chat-submit-button",
          className: "",
          enabled: true,
          focusable: true,
          focused: false,
          x: 820,
          y: 150,
          width: 100,
          height: 40,
        },
      ],
      screenshot: Buffer.alloc(0),
      mediaType: "image/jpeg" as const,
    },
  };
  const validPageSearchGroup = {
    window_id: "browser",
    snapshot_id: "snapshot",
    goal: "Search Baidu for current news",
    risk_category: "ordinary" as const,
    actions: [
      { action: "set_value" as const, element_index: 74, text: "马斯克最新消息" },
      { action: "press_key" as const, key: "Enter" },
      { action: "wait" as const, duration_ms: 1_000 },
    ],
  };
  assert(
    validateComputerActionGroup(validPageSearchGroup, browserSnapshot) === null,
    "one fresh editable browser element can be filled and submitted in one action group",
  );
  assert(
    validateComputerActionGroup(
      {
        ...validPageSearchGroup,
        actions: [
          { action: "set_value" as const, element_index: 81, text: "must not type into a button" },
          { action: "press_key" as const, key: "Enter" },
          { action: "wait" as const, duration_ms: 1_000 },
        ],
      },
      browserSnapshot,
    )?.includes("Edit or ComboBox") === true,
    "grouped page input is rejected unless the fresh snapshot target is editable",
  );
  assert(
    validateComputerActionGroup(
      {
        ...validPageSearchGroup,
        actions: [
          { action: "set_value" as const, x: 200, y: 150, text: "raw coordinates are unsafe" },
          { action: "press_key" as const, key: "Enter" },
          { action: "wait" as const, duration_ms: 1_000 },
        ],
      },
      browserSnapshot,
    )?.includes("element_index") === true,
    "grouped page input rejects raw coordinates",
  );
  assert(
    validateComputerActionGroup({
      ...validBrowserGroup,
      actions: [
        { action: "press_key" as const, key: "Control+l" },
        { action: "press_key" as const, key: "Enter" },
        { action: "type_text" as const, text: "must not type after navigation" },
      ],
    })?.includes("Only a final wait") === true,
    "a browser group cannot target a changed page after submission",
  );
  assert(
    validateComputerActionGroup({ ...validBrowserGroup, risk_category: "external_communication" })?.includes("ordinary") === true,
    "non-ordinary effects cannot use the grouped fast path",
  );
  assert(
    validateComputerActionGroup({
      ...validBrowserGroup,
      actions: [
        { action: "click" as const, x: 100, y: 100 },
        { action: "type_text" as const, text: "unsafe stale-focus path" },
      ],
    })?.includes("unsupported") === true,
    "grouped browser clicks remain rejected so changed-page coordinates and focus are never reused",
  );

  console.log("\n[2] Visible control indicator");
  const defaultIndicator = getComputerUseIndicatorConfig({});
  const disabledIndicator = getComputerUseIndicatorConfig({ CCAGENT_COMPUTER_USE_INDICATOR: "off" });
  const customIndicator = getComputerUseIndicatorConfig({ CCAGENT_COMPUTER_USE_INDICATOR_IDLE_TIMEOUT_MS: "180000" });
  const invalidIndicator = getComputerUseIndicatorConfig({ CCAGENT_COMPUTER_USE_INDICATOR_IDLE_TIMEOUT_MS: "1000" });
  const indicatorSource = computerUseIndicatorPowerShell();
  const indicatorHost = computerUseIndicatorHostPowerShell();
  const actionSource = computerUseActionPowerShell();
  assert(defaultIndicator.enabled && defaultIndicator.idleTimeoutMs === 120_000, "control indicator is enabled by default with a bounded crash fallback");
  assert(!disabledIndicator.enabled, "headless users can explicitly disable the control indicator");
  assert(customIndicator.idleTimeoutMs === 180_000 && invalidIndicator.idleTimeoutMs === 120_000, "indicator crash timeout is configurable only within safe bounds");
  assert(indicatorSource.includes(COMPUTER_USE_INDICATOR_TITLE) && indicatorSource.includes(COMPUTER_USE_INDICATOR_SUBTITLE), "overlay includes an explicit AI-control warning");
  assert(indicatorSource.includes("WS_EX_NOACTIVATE") && indicatorSource.includes("WS_EX_TRANSPARENT"), "overlay does not steal focus or block user input");
  assert(indicatorSource.includes("CCAgentCursorBadge") && indicatorSource.includes("DrawPolygon"), "overlay draws a highlighted mouse-pointer badge");
  assert(indicatorHost.includes("$statePath") && indicatorHost.includes("$state.stop"), "one indicator host stays alive until the owning agent turn stops it");
  assert(!indicatorSource.includes("Cursor.Position"), "the agent pointer never follows the user's hardware cursor");
  assert(actionSource.includes("PostMessage") && !actionSource.includes("SetCursorPos") && !actionSource.includes("mouse_event"), "mouse actions target the selected window without moving the system cursor");

  console.log("\n[3] Permission floor");
  const cwd = process.cwd();
  const observePlan = await checkPermission({
    tool: computerObserveTool,
    input: { action: "list_windows" },
    cwd,
    settings: settings("plan"),
  });
  assert(observePlan.behavior === "allow", "ComputerObserve is allowed in plan mode");
  const ordinaryDefault = await checkPermission({
    tool: computerActionTool,
    input: { action: "click", risk_category: "ordinary", intent: "focus a local field" },
    cwd,
    settings: settings("default"),
  });
  assert(ordinaryDefault.behavior === "ask", "ordinary input asks in default mode");
  const ordinaryFull = await checkPermission({
    tool: computerActionTool,
    input: { action: "click", risk_category: "ordinary", intent: "focus a local field" },
    cwd,
    settings: settings("full"),
  });
  assert(ordinaryFull.behavior === "allow", "ordinary input follows explicit full mode");
  const sensitiveFull = await checkPermission({
    tool: computerActionTool,
    input: { action: "type_text", risk_category: "sensitive_data", intent: "enter private data" },
    cwd,
    settings: settings("full"),
  });
  assert(sensitiveFull.behavior === "ask", "sensitive input still asks in full mode");
  const passwordFull = await checkPermission({
    tool: computerActionTool,
    input: { action: "click", risk_category: "change_password", intent: "submit password change" },
    cwd,
    settings: settings("full"),
  });
  assert(passwordFull.behavior === "deny", "password changes require user hand-off");
  const navigateDefault = await checkPermission({
    tool: computerNavigateTool,
    input: { goal: "Find slide 8", stop_condition: "Slide 8 is visible" },
    cwd,
    settings: settings("default"),
  });
  assert(navigateDefault.behavior === "ask", "bounded multi-step navigation asks in default mode");
  const groupDefault = await checkPermission({
    tool: computerActionGroupTool,
    input: validBrowserGroup,
    cwd,
    settings: settings("default"),
  });
  assert(groupDefault.behavior === "ask", "ordinary browser action group asks once in default mode");
  const groupJevDefaultAllow = await checkPermission({
    tool: computerActionGroupTool,
    input: validBrowserGroup,
    cwd,
    settings: settings("default"),
    precomputedAutoDecision: { behavior: "allow", reason: "Jev approved the complete ordinary browser group" },
  });
  assert(groupJevDefaultAllow.behavior === "allow", "one high-confidence Jev allow replaces the ordinary default-mode group prompt");
  const groupPlanDenied = await checkPermission({
    tool: computerActionGroupTool,
    input: validBrowserGroup,
    cwd,
    settings: settings("plan"),
    precomputedAutoDecision: { behavior: "allow", reason: "Jev approved the complete ordinary browser group" },
  });
  assert(groupPlanDenied.behavior === "deny", "Jev browser-group approval cannot bypass Plan Mode");
  const highRiskGroupDenied = await checkPermission({
    tool: computerActionGroupTool,
    input: { ...validBrowserGroup, risk_category: "external_communication" },
    cwd,
    settings: settings("full"),
    precomputedAutoDecision: { behavior: "allow", reason: "invalid attempted downgrade" },
  });
  assert(highRiskGroupDenied.behavior === "deny", "browser-group fast path cannot bypass the ordinary-risk floor");
  const fallbackAskBypassedByFull = await checkPermission({
    tool: computerActionGroupTool,
    input: validBrowserGroup,
    cwd,
    settings: { mode: "full", allow: ["ComputerActionGroup"], deny: [] },
    precomputedAutoDecision: { behavior: "allow", reason: "must not override mandatory fallback review" },
    requiredComputerGroupReview: { behavior: "ask", reason: "confirm the intact browser group once" },
  });
  assert(
    fallbackAskBypassedByFull.behavior === "allow",
    "Full Mode bypasses an ordinary whole-group fallback prompt without weakening the group safety floor",
  );
  const fallbackAllowExecutes = await checkPermission({
    tool: computerActionGroupTool,
    input: validBrowserGroup,
    cwd,
    settings: settings("default"),
    requiredComputerGroupReview: { behavior: "allow", reason: "whole-group fallback reviewer approved" },
  });
  assert(fallbackAllowExecutes.behavior === "allow", "an explicit whole-group fallback allow can execute the intact plan");
  const fallbackPlanDenied = await checkPermission({
    tool: computerActionGroupTool,
    input: validBrowserGroup,
    cwd,
    settings: settings("plan"),
    requiredComputerGroupReview: { behavior: "allow", reason: "must not bypass Plan Mode" },
  });
  assert(fallbackPlanDenied.behavior === "deny", "whole-group fallback approval cannot bypass Plan Mode");
  const fallbackRuleBypassedInFull = await checkPermission({
    tool: computerActionGroupTool,
    input: validBrowserGroup,
    cwd,
    settings: { mode: "full", allow: [], deny: ["ComputerActionGroup"] },
    requiredComputerGroupReview: { behavior: "allow", reason: "must not bypass an explicit deny rule" },
  });
  assert(fallbackRuleBypassedInFull.behavior === "allow", "Full Mode bypasses configured allow/deny rules for an ordinary browser group");
  const fallbackRuleDeniedInDefault = await checkPermission({
    tool: computerActionGroupTool,
    input: validBrowserGroup,
    cwd,
    settings: { mode: "default", allow: [], deny: ["ComputerActionGroup"] },
    requiredComputerGroupReview: { behavior: "allow", reason: "must not bypass an explicit deny rule" },
  });
  assert(fallbackRuleDeniedInDefault.behavior === "deny", "whole-group fallback approval cannot bypass an explicit deny rule outside Full Mode");

  console.log("\n[4] Jev + LLM Computer Use decision gate");
  const originalJevTimeout = process.env.JEV_TIMEOUT_MS;
  delete process.env.JEV_TIMEOUT_MS;
  assert(getComputerUseJevConfig().timeoutMs === 8_000, "Jev default timeout tolerates normal OpenRouter latency without an unbounded wait");
  if (originalJevTimeout === undefined) delete process.env.JEV_TIMEOUT_MS;
  else process.env.JEV_TIMEOUT_MS = originalJevTimeout;
  const jevRequest = buildComputerUseJevRequest({
    userGoal: "Attach the selected drawing to an external message.",
    window: {
      processName: "rhino",
      title: "Rhino - model.3dm",
      focusedElement: "Attach",
      width: 1200,
      height: 800,
    },
    elements: [{ index: 7, controlType: "Button", name: "Attach", enabled: true, focused: true }],
    proposedAction: { action: "click", element_index: 7, risk_category: "ordinary" },
  });
  assert(Boolean(jevRequest.questions.disposition && jevRequest.questions.risk_category), "Jev request batches disposition and risk questions");
  assert(JSON.stringify(jevRequest).includes("untrusted observations"), "Jev state marks screen content as untrusted");
  const navigationRequest = buildComputerNavigationJevRequest({
    userGoal: "Find slide 8",
    goal: "Find slide 8",
    stopCondition: "Slide 8 is visible",
    allowedActions: ["page_up", "page_down"],
    completedSteps: ["page_up"],
    window: { processName: "powerpnt", title: "Deck", focusedElement: "Slide", width: 1200, height: 800 },
    elements: [],
    perception: "Slide 10 is currently visible.",
  });
  const navigationChoices = navigationRequest.questions.next_step?.type === "choice"
    ? Object.keys(navigationRequest.questions.next_step.criteria)
    : [];
  assert(navigationChoices.includes("page_up") && !navigationChoices.includes("escape"), "bounded navigation exposes only the caller's allowed actions");
  assert(!JSON.stringify(computerNavigateTool.inputSchema).includes("type_text"), "bounded navigation cannot type or click");
  let capturedJevBody: Record<string, unknown> = {};
  const mockedJev = await callOpenRouterJev(jevRequest, {
    apiKey: "openrouter-test-key",
    fetchImpl: (async (_input: string | URL | Request, init?: RequestInit) => {
      capturedJevBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        model: "typesafe/jev-1.13",
        answers: { reachable: { type: "noul", noul: 0.99 } },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch,
  });
  assert(mockedJev.answers.reachable?.type === "noul", "OpenRouter Decisions response is parsed as typed Jev answers");
  assert(capturedJevBody.model === "~typesafe/jev-latest", "OpenRouter request uses the Jev latest alias");
  assert(
    (capturedJevBody.provider as { zdr?: boolean; data_collection?: string }).zdr === true &&
      (capturedJevBody.provider as { data_collection?: string }).data_collection === "deny",
    "OpenRouter Jev request enforces zero-retention and no-data-collection routing",
  );

  const successfulJevResponse = () => new Response(JSON.stringify({
    model: "typesafe/jev-1.13",
    answers: { reachable: { type: "noul", noul: 0.99 } },
  }), { status: 200, headers: { "Content-Type": "application/json" } });

  let transient503Attempts = 0;
  const recoveredFrom503 = await callOpenRouterJev(jevRequest, {
    apiKey: "openrouter-test-key",
    maxAttempts: 2,
    retryDelayMs: 0,
    fetchImpl: (async () => {
      transient503Attempts++;
      return transient503Attempts === 1
        ? new Response(JSON.stringify({ error: { message: "temporary overload" } }), {
            status: 503,
            headers: { "Content-Type": "application/json" },
          })
        : successfulJevResponse();
    }) as typeof fetch,
  });
  assert(
    transient503Attempts === 2 &&
      recoveredFrom503.attempts === 2 &&
      recoveredFrom503.answers.reachable?.type === "noul",
    "a transient Jev HTTP 503 is retried once and the second response succeeds",
  );

  let transientTimeoutAttempts = 0;
  const recoveredFromTimeout = await callOpenRouterJev(jevRequest, {
    apiKey: "openrouter-test-key",
    timeoutMs: 10,
    maxAttempts: 2,
    retryDelayMs: 0,
    fetchImpl: ((_input: string | URL | Request, init?: RequestInit) => {
      transientTimeoutAttempts++;
      if (transientTimeoutAttempts > 1) return Promise.resolve(successfulJevResponse());
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) {
          reject(signal.reason);
          return;
        }
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }) as typeof fetch,
  });
  assert(
    transientTimeoutAttempts === 2 &&
      recoveredFromTimeout.attempts === 2 &&
      recoveredFromTimeout.answers.reachable?.type === "noul",
    "a transient Jev timeout is retried once and the second response succeeds",
  );

  let exhaustedTimeoutAttempts = 0;
  let exhaustedTimeoutError: unknown;
  try {
    await callOpenRouterJev(jevRequest, {
      apiKey: "openrouter-test-key",
      timeoutMs: 10,
      maxAttempts: 2,
      retryDelayMs: 0,
      fetchImpl: ((_input: string | URL | Request, init?: RequestInit) => {
        exhaustedTimeoutAttempts++;
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal?.aborted) {
            reject(signal.reason);
            return;
          }
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      }) as typeof fetch,
    });
  } catch (error) {
    exhaustedTimeoutError = error;
  }
  assert(
    exhaustedTimeoutAttempts === 2 &&
      exhaustedTimeoutError instanceof OpenRouterJevError &&
      exhaustedTimeoutError.kind === "timeout" &&
      exhaustedTimeoutError.attempts === 2 &&
      exhaustedTimeoutError.message.includes("after 2 attempts"),
    "two Jev timeouts stop at the retry bound and report the attempt count",
  );

  let unauthorizedAttempts = 0;
  let unauthorizedError: unknown;
  try {
    await callOpenRouterJev(jevRequest, {
      apiKey: "openrouter-test-key",
      maxAttempts: 3,
      retryDelayMs: 0,
      fetchImpl: (async () => {
        unauthorizedAttempts++;
        return new Response(JSON.stringify({ error: { message: "invalid key" } }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }) as typeof fetch,
    });
  } catch (error) {
    unauthorizedError = error;
  }
  assert(
    unauthorizedAttempts === 1 &&
      unauthorizedError instanceof OpenRouterJevError &&
      unauthorizedError.kind === "http" &&
      unauthorizedError.status === 401,
    "a Jev HTTP 401 is a hard failure and is never retried",
  );

  let protocolAttempts = 0;
  let protocolError: unknown;
  try {
    await callOpenRouterJev(jevRequest, {
      apiKey: "openrouter-test-key",
      maxAttempts: 3,
      retryDelayMs: 0,
      fetchImpl: (async () => {
        protocolAttempts++;
        return new Response(JSON.stringify({ model: "typesafe/jev-1.13" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) as typeof fetch,
    });
  } catch (error) {
    protocolError = error;
  }
  assert(
    protocolAttempts === 1 &&
      protocolError instanceof OpenRouterJevError &&
      protocolError.kind === "protocol",
    "a malformed Jev protocol response is never retried",
  );

  const parentAbortController = new AbortController();
  let parentAbortAttempts = 0;
  let parentAbortError: unknown;
  const parentAbortRequest = callOpenRouterJev(jevRequest, {
    apiKey: "openrouter-test-key",
    timeoutMs: 1_000,
    maxAttempts: 3,
    retryDelayMs: 0,
    signal: parentAbortController.signal,
    fetchImpl: ((_input: string | URL | Request, init?: RequestInit) => {
      parentAbortAttempts++;
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) {
          reject(signal.reason);
          return;
        }
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }) as typeof fetch,
  });
  parentAbortController.abort(new Error("parent request cancelled"));
  try {
    await parentAbortRequest;
  } catch (error) {
    parentAbortError = error;
  }
  assert(
    parentAbortAttempts === 1 &&
      parentAbortError instanceof OpenRouterJevError &&
      parentAbortError.kind === "aborted",
    "a parent AbortSignal cancels the active Jev call without any retry",
  );

  const highRiskResponse: JevDecisionResponse = {
    model: "typesafe/jev-1.13",
    answers: {
      disposition: {
        type: "choice",
        choice: "confirm",
        probabilities: { execute: 0.01, reobserve: 0.01, confirm: 0.97, deny: 0.01 },
        confidence: 0.96,
      },
      risk_category: {
        type: "choice",
        choice: "upload",
        probabilities: { ordinary: 0.01, upload: 0.99 },
        confidence: 0.98,
      },
      target_present: { type: "noul", noul: 0.99 },
      goal_aligned: { type: "noul", noul: 0.95 },
      prompt_injection: { type: "noul", noul: 0.01 },
    },
  };
  const highRiskDecision = interpretComputerUseJevResponse(
    highRiskResponse,
    "ordinary",
    "click",
    { mode: "enforce", model: "~typesafe/jev-latest", minConfidence: 0.8 },
  );
  assert(highRiskDecision.effectiveRisk === "upload", "Jev can only upgrade an LLM-declared ordinary risk");
  assert(highRiskDecision.permissionBehavior === "ask", "Jev high-impact decision requires confirmation");

  const unavailableGroupDecision = resolveComputerActionGroupJevDecision({
    configured: true,
    available: false,
    mode: "enforce",
    model: "~typesafe/jev-latest",
    originalRisk: "ordinary",
    effectiveRisk: "ordinary",
    summary: "Jev request timed out after 2 attempts.",
  });
  assert(
    unavailableGroupDecision.requiresFallbackReview === true &&
      unavailableGroupDecision.forceDeny !== true &&
      unavailableGroupDecision.summary.includes("Do not decompose"),
    "an unavailable Jev gate keeps the browser group intact for one fallback review instead of forcing single actions",
  );

  const safeResponse: JevDecisionResponse = {
    model: "typesafe/jev-1.13",
    answers: {
      disposition: { type: "choice", choice: "execute", probabilities: { execute: 0.96 }, confidence: 0.94 },
      risk_category: { type: "choice", choice: "ordinary", probabilities: { ordinary: 0.98 }, confidence: 0.97 },
      target_present: { type: "noul", noul: 0.98 },
      goal_aligned: { type: "noul", noul: 0.95 },
      prompt_injection: { type: "noul", noul: 0.01 },
    },
  };
  const safeDecision = interpretComputerUseJevResponse(
    safeResponse,
    "ordinary",
    "click",
    { mode: "enforce", model: "~typesafe/jev-latest", minConfidence: 0.8 },
  );
  assert(safeDecision.permissionBehavior === "allow", "high-confidence ordinary Jev decision can accelerate Auto Mode");
  const noDowngrade = interpretComputerUseJevResponse(
    safeResponse,
    "external_communication",
    "click",
    { mode: "enforce", model: "~typesafe/jev-latest", minConfidence: 0.8 },
  );
  assert(noDowngrade.effectiveRisk === "external_communication" && noDowngrade.permissionBehavior === "ask", "Jev never downgrades an LLM-declared high-impact risk");

  const jevAutoAllow = await checkPermission({
    tool: computerActionTool,
    input: { action: "click", risk_category: "ordinary", intent: "focus a local field" },
    cwd,
    settings: settings("auto"),
    precomputedAutoDecision: { behavior: "allow", reason: "Jev verified ordinary action" },
  });
  assert(jevAutoAllow.behavior === "allow", "Auto Mode consumes Jev decision without a second LLM classifier call");
  const groupJevAutoAllow = await checkPermission({
    tool: computerActionGroupTool,
    input: validBrowserGroup,
    cwd,
    settings: settings("auto"),
    precomputedAutoDecision: { behavior: "allow", reason: "Jev verified the complete ordinary browser group" },
  });
  assert(groupJevAutoAllow.behavior === "allow", "one Jev decision authorizes one ordinary browser group in Auto Mode");

  if (process.platform !== "win32" || process.env.LIVE_COMPUTER_USE !== "1") {
    console.log("\n[5] Live Windows observation skipped (set LIVE_COMPUTER_USE=1)");
  } else {
    console.log("\n[5] Live observe → act → observe loop");
    const launched = await launchTestWindow();
    try {
      const window = await findTestWindow(launched.titleHint);
      const context = { cwd, sessionId: "computer-use-test", defaultModel: "qwen-test" };
      const verifyPerception = process.env.LIVE_COMPUTER_PERCEPTION === "1";
      const observed = await computerObserveTool.call(
        {
          action: "observe",
          window_id: window.id,
          perception: verifyPerception ? "on" : "off",
          image_delivery: "inline",
        },
        context,
      );
      const observedText = toolResultText(observed.content);
      if (observed.isError) console.log("  Observe error: " + observedText);
      const snapshotId = observedText.match(/snapshot_id:\s*([0-9a-f-]+)/i)?.[1];
      const hasImage = Array.isArray(observed.content) && observed.content.some((block) => block.type === "image");
      const screenshotOutput = process.env.COMPUTER_USE_SCREENSHOT_OUTPUT;
      if (screenshotOutput && Array.isArray(observed.content)) {
        const screenshot = observed.content.find((block) => block.type === "image");
        if (screenshot?.type === "image" && screenshot.source.type === "base64") {
          await fs.writeFile(screenshotOutput, Buffer.from(screenshot.source.data, "base64"));
        }
      }
      assert(!observed.isError && hasImage && Boolean(snapshotId), "observe returns a screenshot and snapshot_id");
      assert(observedText.includes("Accessibility elements:\n["), "accessibility tree contains target-window elements");
      if (verifyPerception) {
        assert(
          observedText.includes("Perception model (qwen-computer-perception):") &&
            !observedText.includes("Perception fallback:"),
          "configured Qwen model interprets the live screenshot",
        );
      }

      const rejectedGroup = await computerActionGroupTool.call(
        {
          window_id: window.id,
          snapshot_id: snapshotId,
          goal: "exercise local validation without sending input",
          risk_category: "ordinary",
          actions: [
            { action: "press_key", key: "Control+l" },
            { action: "type_text", text: "not sent" },
          ],
        },
        context,
      );
      assert(
        rejectedGroup.isError === true && toolResultText(rejectedGroup.content).includes("snapshot remains valid"),
        "pre-execution group validation preserves the fresh snapshot for a corrected retry",
      );

      const editableIndex = observedText.match(/^\[(\d+)\]\s+(?:Document|Edit)\b/m)?.[1];
      const replacementText = "Computer Use Action Probe " + Date.now();
      const acted = await computerActionTool.call(
        {
          action: "set_value",
          window_id: window.id,
          snapshot_id: snapshotId,
          intent: "replace text in the isolated temporary test document",
          risk_category: "ordinary",
          ...(editableIndex
            ? { element_index: Number(editableIndex) }
            : { x: 300, y: 180 }),
          text: replacementText,
          perception: "off",
          image_delivery: "inline",
        },
        context,
      );
      const actedText = toolResultText(acted.content);
      if (acted.isError) console.log("  Action error: " + actedText);
      const refreshedId = actedText.match(/snapshot_id:\s*([0-9a-f-]+)/i)?.[1];
      assert(!acted.isError && Boolean(refreshedId) && refreshedId !== snapshotId, "text action consumes the old snapshot and returns a fresh one");
      assert(hasComputerUseIndicatorSession("computer-use-test"), "control banner remains alive after one action instead of flashing per input");

      assert(
        withoutWhitespace(actedText).includes(withoutWhitespace(replacementText)),
        "text action changed the isolated probe editor",
      );

      const selected = await computerActionTool.call(
        {
          action: "press_key",
          window_id: window.id,
          snapshot_id: refreshedId,
          intent: "select all text in the isolated temporary test document",
          risk_category: "ordinary",
          key: "Control+a",
          perception: "off",
          image_delivery: "text_only",
        },
        context,
      );
      const selectedText = toolResultText(selected.content);
      const selectedId = selectedText.match(/snapshot_id:\s*([0-9a-f-]+)/i)?.[1];
      if (selected.isError) console.log("  Select-all error: " + selectedText);
      assert(!selected.isError && Boolean(selectedId), "keyboard chord returns a fresh observation");

      const finalText = "Computer Use Keyboard Probe " + Date.now();
      const typed = await computerActionTool.call(
        {
          action: "type_text",
          window_id: window.id,
          snapshot_id: selectedId,
          intent: "replace the selected text in the isolated temporary test document",
          risk_category: "ordinary",
          text: finalText,
          perception: "off",
          image_delivery: "text_only",
        },
        context,
      );
      const typedText = toolResultText(typed.content);
      if (typed.isError) console.log("  Type error: " + typedText);
      const normalizedTypedText = withoutWhitespace(typedText);
      const keyboardReplaced =
        !typed.isError &&
        normalizedTypedText.includes("ComputerUseKeyboardProbe") &&
        !normalizedTypedText.includes("ComputerUseActionProbe");
      if (!keyboardReplaced) {
        console.log(
          "  Keyboard observation: " +
            typedText.split("\n").filter((line) => /focused_element|probe/i.test(line)).join(" | "),
        );
      }
      assert(
        keyboardReplaced,
        "keyboard chord and typing replaced the selected text",
      );
      assert(hasComputerUseIndicatorSession("computer-use-test"), "one task-level indicator survives multiple ComputerAction calls");

      const batchText = "Computer Use 中文批量输入测试 " + Date.now();
      const beforeBatch = await observeComputerWindow(window);
      await performComputerActions(
        window,
        [
          { action: "press_key", key: "Control+a" },
          { action: "type_text", text: batchText },
        ],
        { width: beforeBatch.nativeWidth, height: beforeBatch.nativeHeight },
      );
      const afterBatch = await observeComputerWindow(window);
      assert(
        withoutWhitespace(afterBatch.elements.map((element) => element.name).join("\n")).includes(withoutWhitespace(batchText)),
        "multiple native inputs execute in one helper call without intermediate observation",
      );

      const stale = await computerActionTool.call(
        {
          action: "wait",
          window_id: window.id,
          snapshot_id: snapshotId,
          intent: "attempt stale reuse",
          risk_category: "ordinary",
          duration_ms: 100,
          perception: "off",
          image_delivery: "text_only",
        },
        context,
      );
      assert(stale.isError === true && toolResultText(stale.content).includes("stale"), "stale snapshot reuse is rejected");
    } finally {
      await endComputerUseIndicatorSession("computer-use-test");
      await endComputerUseIndicatorSession();
      assert(!hasComputerUseIndicatorSession("computer-use-test") && !hasComputerUseIndicatorSession(), "task completion removes every test indicator session");
      launched.child.kill();
      if (launched.child.exitCode === null) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 1_500);
          launched.child.once("exit", () => { clearTimeout(timer); resolve(); });
        });
      }
      await fs.rm(launched.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }

  if (failures.length > 0) {
    console.error("\nComputer Use checks failed: " + failures.join(", "));
    process.exitCode = 1;
  } else {
    console.log("\nAll Computer Use checks passed.");
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
