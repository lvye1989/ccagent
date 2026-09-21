/** Real Ink rendering regressions: no credentials, provider calls or user files. */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import React from "react";
import { render, Text } from "ink";
import { usePromptInput } from "../ui/hooks/usePromptInput.js";
import type { CommandSuggestion } from "../ui/types.js";

const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 45));
let checks = 0;
function check(value: unknown, label: string): void {
  assert.ok(value, label);
  checks++;
  process.stdout.write(`  [PASS] ${label}\n`);
}
class Boundary extends React.Component<{ children: React.ReactNode; onError: (error: Error) => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: Error) { this.props.onError(error); }
  render() { return this.state.failed ? <Text>Render failed</Text> : this.props.children; }
}
function terminal() {
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
  const stdout = Object.assign(new PassThrough(), { columns: 100, rows: 36, isTTY: true });
  const stderr = new PassThrough();
  let output = "";
  stdout.on("data", (chunk) => { output += chunk.toString(); });
  stderr.on("data", (chunk) => { output += chunk.toString(); });
  return { stdin, stdout, stderr, output: () => output, options: {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: stderr as unknown as NodeJS.WriteStream,
    debug: true, patchConsole: false, exitOnCtrlC: false,
  } };
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), "ccagent-prompt-render-"));
const oldCwd = process.cwd();
const oldEnv = { ...process.env };
const oldFetch = globalThis.fetch;
const oldConsoleError = console.error;
const reactErrors: string[] = [];
const renders: ReturnType<typeof render>[] = [];
let snapshot: ReturnType<typeof usePromptInput> | undefined;
let renderCount = 0;
let renderError: Error | undefined;
let questionActive = false;
const submitted: string[] = [];
let commands: CommandSuggestion[] = [{ name: "/fixture-skill", description: "Live skill" }];

function Harness(): React.ReactNode {
  renderCount++;
  const prompt = usePromptInput({
    isLoading: false, hasPermissionPrompt: false, hasQuestionPrompt: questionActive,
    isPlanExitPrompt: false, permissionMode: "default", taskMode: "task", cwd: root,
    // App intentionally rebuilds live skill commands on EVERY render. A stable
    // test prop hides the render-phase setState loop that breaks startup.
    extraCommands: commands.map((command) => ({ ...command })),
    onSubmit: (text) => { submitted.push(text); }, onExit() {},
    onInterrupt: () => false, onPermissionDecision: () => false, onToggleTranscript() {},
  });
  React.useLayoutEffect(() => { snapshot = prompt; });
  return <Text>{prompt.inputValue || "Ready"}</Text>;
}

try {
  process.env.CCAGENT_HOME = path.join(root, "user");
  process.env.CCAGENT_DISABLE_HOOKS = "1";
  process.chdir(root);
  globalThis.fetch = async () => { throw new Error("External requests prohibited in rendering tests"); };
  console.error = (...args: unknown[]) => { reactErrors.push(args.map(String).join(" ")); };
  await fs.writeFile(path.join(root, "alpha.txt"), "fixture");
  await fs.writeFile(path.join(root, "beta.txt"), "fixture");

  const tty = terminal();
  const element = () => <Boundary onError={(error) => { renderError = error; }}><Harness /></Boundary>;
  const instance = render(element(), tty.options);
  renders.push(instance);
  await pause();
  assert.equal(renderError, undefined, `Startup must not crash: ${renderError?.message}`);
  check(snapshot?.inputValue === "" && renderCount < 10, "Empty startup with fresh command arrays settles without a render loop");
  const input = async (text: string) => { snapshot!.setInputValue(text); await pause(); assert.equal(renderError, undefined); };
  const key = async (text: string) => { tty.stdin.write(text); await pause(); assert.equal(renderError, undefined); };

  await input("hello");
  check(snapshot!.commandSuggestions.length === 0, "Ordinary text hides command suggestions without render-phase state updates");
  await key("\r");
  check(submitted[0] === "hello" && snapshot!.inputValue === "", "Submit clears the prompt safely");
  await input("/agent");
  await key("\u001b[B");
  const selection = snapshot!.commandSuggestions.find((item) => item.isSelected)?.name;
  const priorRenderCount = renderCount;
  for (let i = 0; i < 8; i++) { instance.rerender(element()); await pause(); }
  check(renderCount - priorRenderCount <= 9 && snapshot!.commandSuggestions.find((item) => item.isSelected)?.name === selection,
    "Parent rerenders with fresh arrays preserve keyboard selection and remain bounded");
  await input("");
  await input("/agent");
  check(snapshot!.commandSuggestions[0]?.isSelected, "Closing and reopening the command palette resets selection");
  await input("/missing-fixture-command");
  check(snapshot!.commandSuggestions.length === 0, "Unmatched slash input settles with no suggestions");
  commands = [{ name: "/new-live-skill", description: "Updated registry" }];
  await input("/new-live");
  check(snapshot!.commandSuggestions[0]?.name === "/new-live-skill", "Live registry changes remain discoverable (no frozen startup memo)");

  for (const [command, property] of [
    ["/mode", "modeSuggestions"], ["/tasks", "taskModeSuggestions"],
    ["/think", "thinkSuggestions"], ["/effort", "effortSuggestions"],
  ] as const) {
    await input(command);
    await key("\u001b[B");
    check(snapshot![property].some((item) => item.isSelected), `${command} remains arrow-selectable`);
    await input("plain text");
    await input(command);
    check(snapshot![property].every((item) => !item.isSelected), `${command} resets selection after closing`);
  }
  await input("@");
  await key("\u001b[B");
  check(snapshot!.fileSuggestions[1]?.isSelected, "File suggestions remain keyboard-selectable");
  await input("");
  await input("@");
  check(snapshot!.fileSuggestions[0]?.isSelected, "File palette selection resets after closing");
  await input("");
  questionActive = true;
  instance.rerender(element());
  await pause();
  await key("1");
  check(snapshot!.inputValue === "", "Question card keystrokes do not leak into the hidden prompt");
  instance.unmount(); instance.cleanup(); renders.pop();

  // Cover the actual App tree, not only a simplified hook harness.
  const { App } = await import("../ui/App.js");
  const appTty = terminal();
  const app = render(<Boundary onError={(error) => { renderError = error; }}><App model="fixture-model" /></Boundary>, appTty.options);
  renders.push(app);
  await pause(); await pause(); await pause();
  check(!renderError && !appTty.output().includes("Too many re-renders") && appTty.output().includes("fixture-model"), "Full App startup renders successfully with an isolated user directory");
  appTty.stdin.write("/agents");
  await pause();
  check(!renderError && appTty.output().includes("/agents"), "Full App accepts /agents after startup");
  app.unmount(); app.cleanup(); renders.pop();
  check(reactErrors.length === 0, "No React render errors or warnings during all scenarios");
  process.stdout.write(`\nAll ${checks} prompt rendering checks passed.\n`);
} finally {
  for (const instance of renders) { instance.unmount(); instance.cleanup(); }
  console.error = oldConsoleError;
  globalThis.fetch = oldFetch;
  // Let asynchronous initialization/cleanup settle before removing its private home.
  await pause();
  process.chdir(oldCwd);
  for (const key of Object.keys(process.env)) if (!(key in oldEnv)) delete process.env[key];
  Object.assign(process.env, oldEnv);
  assert.ok(path.dirname(root) === os.tmpdir() && path.basename(root).startsWith("ccagent-prompt-render-"));
  await fs.rm(root, { recursive: true, force: true });
}
