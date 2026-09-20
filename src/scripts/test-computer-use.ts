#!/usr/bin/env tsx

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getAllTools } from "../tools/index.js";
import { toolResultText } from "../tools/Tool.js";
import {
  computerActionTool,
  computerObserveTool,
  prohibitedWindowReason,
  validateComputerKey,
} from "../tools/computerUseTools.js";
import { listComputerWindows } from "../tools/computerUseBackend.js";
import { checkPermission, type PermissionSettings } from "../permissions/permissions.js";
import { loadEnv } from "../utils/loadEnv.js";

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
  loadEnv();
  console.log("\n[1] Registry and safety policy");
  const names = new Set(getAllTools().map((tool) => tool.name));
  assert(names.has("ComputerObserve") === (process.platform === "win32"), "ComputerObserve Windows registration");
  assert(names.has("ComputerAction") === (process.platform === "win32"), "ComputerAction Windows registration");
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

  console.log("\n[2] Permission floor");
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

  if (process.platform !== "win32" || process.env.LIVE_COMPUTER_USE !== "1") {
    console.log("\n[3] Live Windows observation skipped (set LIVE_COMPUTER_USE=1)");
  } else {
    console.log("\n[3] Live observe → act → observe loop");
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
