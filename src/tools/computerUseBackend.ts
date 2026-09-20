import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

export interface ComputerWindow {
  id: string;
  processId: number;
  processName: string;
  title: string;
  executable?: string;
}

export interface ComputerElement {
  index: number;
  controlType: string;
  name: string;
  automationId: string;
  className: string;
  enabled: boolean;
  focusable: boolean;
  focused: boolean;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

export interface ComputerObservation {
  window: ComputerWindow;
  width: number;
  height: number;
  nativeWidth: number;
  nativeHeight: number;
  elements: ComputerElement[];
  focusedElement?: string;
  screenshot: Buffer;
  mediaType: "image/jpeg";
}

export type ComputerAction =
  | { action: "activate" }
  | { action: "click"; x: number; y: number; button?: "left" | "right" | "middle"; clickCount?: number }
  | { action: "type_text"; text: string }
  | { action: "press_key"; key: string }
  | { action: "scroll"; x: number; y: number; scrollX: number; scrollY: number }
  | { action: "drag"; fromX: number; fromY: number; toX: number; toY: number }
  | { action: "set_value"; x: number; y: number; text: string }
  | { action: "wait"; durationMs: number };

const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_OUTPUT_CHARS = 2_000_000;

function nativePreamble(): string {
  return [
    "$nativeSource = @'",
    "using System;",
    "using System.Runtime.InteropServices;",
    "public static class CCAgentComputerNative {",
    "  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }",
    "  [DllImport(\"user32.dll\")] public static extern bool IsWindow(IntPtr hWnd);",
    "  [DllImport(\"user32.dll\")] public static extern bool IsIconic(IntPtr hWnd);",
    "  [DllImport(\"user32.dll\")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);",
    "  [DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(IntPtr hWnd);",
    "  [DllImport(\"user32.dll\")] public static extern IntPtr GetForegroundWindow();",
    "  [DllImport(\"user32.dll\")] public static extern bool BringWindowToTop(IntPtr hWnd);",
    "  [DllImport(\"user32.dll\")] public static extern void SwitchToThisWindow(IntPtr hWnd, bool altTab);",
    "  [DllImport(\"user32.dll\")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);",
    "  [DllImport(\"kernel32.dll\")] public static extern uint GetCurrentThreadId();",
    "  [DllImport(\"user32.dll\")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool attach);",
    "  [DllImport(\"user32.dll\")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);",
    "  [DllImport(\"user32.dll\")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint flags);",
    "  [DllImport(\"user32.dll\")] public static extern bool SetCursorPos(int x, int y);",
    "  [DllImport(\"user32.dll\")] public static extern void mouse_event(uint flags, uint dx, uint dy, int data, UIntPtr extraInfo);",
    "  [DllImport(\"user32.dll\")] public static extern void keybd_event(byte virtualKey, byte scanCode, uint flags, UIntPtr extraInfo);",
    "  [DllImport(\"user32.dll\", CharSet=CharSet.Unicode)] public static extern short VkKeyScan(char character);",
    "  [DllImport(\"user32.dll\")] public static extern bool SetProcessDPIAware();",
    "}",
    "'@",
    "[void](Add-Type -TypeDefinition $nativeSource -ReferencedAssemblies 'System.Drawing','System.Windows.Forms')",
    "[void][CCAgentComputerNative]::SetProcessDPIAware()",
  ].join("\n");
}

function powershellHeader(): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
  ].join("\n");
}

async function runPowerShell(
  script: string,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<string> {
  if (process.platform !== "win32") throw new Error("Computer Use is currently available only on Windows.");
  if (signal?.aborted) throw new Error("Computer Use operation aborted before it started.");
  const executable = process.env.CCAGENT_POWERSHELL?.trim() || "powershell.exe";
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(
      executable,
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
      {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, ...env },
      },
    );
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(stdout.trim());
    };
    const onAbort = () => {
      child.kill();
      finish(new Error("Computer Use operation aborted. Re-observe before retrying."));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error("Computer Use operation timed out. Its outcome is unknown; re-observe before retrying."));
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer | string) => {
      if (stdout.length < MAX_OUTPUT_CHARS) stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      if (stderr.length < MAX_OUTPUT_CHARS) stderr += chunk.toString();
    });
    child.on("error", (error) => finish(new Error("Failed to start Computer Use backend: " + error.message)));
    child.on("close", (code) => {
      if ((code ?? 1) !== 0) {
        finish(new Error("Computer Use backend exited with code " + (code ?? -1) + ": " + (stderr.trim() || stdout.trim())));
      } else {
        finish();
      }
    });
  });
}

function parseJsonOutput<T>(output: string): T {
  const normalized = output.replace(/^\uFEFF/, "").trim();
  if (!normalized) throw new Error("Computer Use backend returned no data.");
  try {
    return JSON.parse(normalized) as T;
  } catch (error: unknown) {
    throw new Error(
      "Computer Use backend returned invalid JSON: " +
        (error instanceof Error ? error.message : String(error)) +
        ". Output: " +
        normalized.slice(0, 500),
    );
  }
}

const LIST_WINDOWS_SCRIPT = [
  powershellHeader(),
  "$items = @(Get-Process | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object {",
  "  $exe = $null",
  "  try { $exe = $_.Path } catch {}",
  "  [pscustomobject]@{",
  "    id = ([string][long]$_.MainWindowHandle)",
  "    processId = [int]$_.Id",
  "    processName = [string]$_.ProcessName",
  "    title = [string]$_.MainWindowTitle",
  "    executable = $exe",
  "  }",
  "})",
  "$items | ConvertTo-Json -Compress -Depth 4",
].join("\n");

export async function listComputerWindows(signal?: AbortSignal): Promise<ComputerWindow[]> {
  const output = await runPowerShell(LIST_WINDOWS_SCRIPT, {}, signal, 10_000);
  const parsed = parseJsonOutput<ComputerWindow[] | ComputerWindow>(output);
  return (Array.isArray(parsed) ? parsed : [parsed]).filter(
    (item) => item && typeof item.id === "string" && item.title.trim().length > 0,
  );
}

function observationScript(): string {
  return [
    powershellHeader(),
    "Add-Type -AssemblyName System.Drawing",
    "Add-Type -AssemblyName System.Windows.Forms",
    "Add-Type -AssemblyName UIAutomationClient",
    "Add-Type -AssemblyName UIAutomationTypes",
    nativePreamble(),
    "$handle = [IntPtr][long]$env:CC_WINDOW_ID",
    "if (-not [CCAgentComputerNative]::IsWindow($handle)) { throw 'Target window no longer exists.' }",
    "if ([CCAgentComputerNative]::IsIconic($handle)) { throw 'Target window is minimized. Activate it before observing.' }",
    "$rect = New-Object CCAgentComputerNative+RECT",
    "if (-not [CCAgentComputerNative]::GetWindowRect($handle, [ref]$rect)) { throw 'Could not read target window bounds.' }",
    "$width = $rect.Right - $rect.Left",
    "$height = $rect.Bottom - $rect.Top",
    "if ($width -lt 2 -or $height -lt 2) { throw 'Target window has invalid bounds.' }",
    "$bitmap = New-Object System.Drawing.Bitmap($width, $height, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)",
    "$graphics = [System.Drawing.Graphics]::FromImage($bitmap)",
    "$hdc = $graphics.GetHdc()",
    "$printed = $false",
    "try { $printed = [CCAgentComputerNative]::PrintWindow($handle, $hdc, 2) } finally { $graphics.ReleaseHdc($hdc) }",
    "if (-not $printed) { $graphics.CopyFromScreen($rect.Left, $rect.Top, 0, 0, (New-Object System.Drawing.Size($width, $height))) }",
    "$maxWidth = 1600",
    "$maxHeight = 1200",
    "$scale = [Math]::Min(1.0, [Math]::Min($maxWidth / [double]$width, $maxHeight / [double]$height))",
    "$outWidth = [Math]::Max(1, [int][Math]::Round($width * $scale))",
    "$outHeight = [Math]::Max(1, [int][Math]::Round($height * $scale))",
    "$outputBitmap = $bitmap",
    "if ($outWidth -ne $width -or $outHeight -ne $height) {",
    "  $outputBitmap = New-Object System.Drawing.Bitmap($outWidth, $outHeight, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)",
    "  $resizeGraphics = [System.Drawing.Graphics]::FromImage($outputBitmap)",
    "  $resizeGraphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic",
    "  $resizeGraphics.DrawImage($bitmap, 0, 0, $outWidth, $outHeight)",
    "  $resizeGraphics.Dispose()",
    "}",
    "$codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' } | Select-Object -First 1",
    "$encoderParams = New-Object System.Drawing.Imaging.EncoderParameters(1)",
    "$encoderParams.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]82)",
    "$outputBitmap.Save($env:CC_SCREENSHOT_PATH, $codec, $encoderParams)",
    "$encoderParams.Dispose()",
    "if ($outputBitmap -ne $bitmap) { $outputBitmap.Dispose() }",
    "$graphics.Dispose()",
    "$bitmap.Dispose()",
    "$elements = New-Object System.Collections.Generic.List[object]",
    "$focusedDescription = $null",
    "try {",
    "  $root = [System.Windows.Automation.AutomationElement]::FromHandle($handle)",
    "  if ($root -ne $null) {",
    "    $nodes = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)",
    "    $limit = [Math]::Min($nodes.Count, 300)",
    "    for ($i = 0; $i -lt $limit; $i++) {",
    "      try {",
    "        $node = $nodes.Item($i)",
    "        $current = $node.Current",
    "        $bounds = $current.BoundingRectangle",
    "        $relativeX = $null; $relativeY = $null; $elementWidth = $null; $elementHeight = $null",
    "        if (-not [double]::IsInfinity($bounds.X) -and $bounds.Width -gt 0 -and $bounds.Height -gt 0) {",
    "          $relativeX = [int][Math]::Round(($bounds.X - $rect.Left) * $scale)",
    "          $relativeY = [int][Math]::Round(($bounds.Y - $rect.Top) * $scale)",
    "          $elementWidth = [int][Math]::Round($bounds.Width * $scale)",
    "          $elementHeight = [int][Math]::Round($bounds.Height * $scale)",
    "        }",
    "        $controlType = [string]$current.ControlType.ProgrammaticName",
    "        if ($controlType.Contains('.')) { $controlType = $controlType.Substring($controlType.LastIndexOf('.') + 1) }",
    "        $elements.Add([pscustomobject]@{",
    "          index = $i",
    "          controlType = $controlType",
    "          name = [string]$current.Name",
    "          automationId = [string]$current.AutomationId",
    "          className = [string]$current.ClassName",
    "          enabled = [bool]$current.IsEnabled",
    "          focusable = [bool]$current.IsKeyboardFocusable",
    "          focused = [bool]$current.HasKeyboardFocus",
    "          x = $relativeX; y = $relativeY; width = $elementWidth; height = $elementHeight",
    "        })",
    "      } catch {}",
    "    }",
    "  }",
    "  $focusCondition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::HasKeyboardFocusProperty, $true)",
    "  $focused = $root.FindFirst([System.Windows.Automation.TreeScope]::Subtree, $focusCondition)",
    "  if ($focused -ne $null) { $focusedDescription = ([string]$focused.Current.ControlType.ProgrammaticName) + ': ' + ([string]$focused.Current.Name) }",
    "} catch {}",
    "$elementArray = $elements.ToArray()",
    "$result = [pscustomobject]@{ width = $outWidth; height = $outHeight; nativeWidth = $width; nativeHeight = $height; elements = $elementArray; focusedElement = $focusedDescription }",
    "$result | ConvertTo-Json -Compress -Depth 7",
  ].join("\n");
}

export async function observeComputerWindow(
  window: ComputerWindow,
  signal?: AbortSignal,
): Promise<ComputerObservation> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ccagent-computer-use-"));
  const screenshotPath = path.join(dir, randomUUID() + ".jpg");
  try {
    const output = await runPowerShell(
      observationScript(),
      { CC_WINDOW_ID: window.id, CC_SCREENSHOT_PATH: screenshotPath },
      signal,
    );
    const state = parseJsonOutput<{
      width: number;
      height: number;
      nativeWidth: number;
      nativeHeight: number;
      elements?: ComputerElement[];
      focusedElement?: string | null;
    }>(output);
    const screenshot = await readFile(screenshotPath);
    if (screenshot.length === 0) throw new Error("Computer Use captured an empty screenshot.");
    return {
      window,
      width: state.width,
      height: state.height,
      nativeWidth: state.nativeWidth,
      nativeHeight: state.nativeHeight,
      elements: Array.isArray(state.elements) ? state.elements : [],
      ...(state.focusedElement ? { focusedElement: state.focusedElement } : {}),
      screenshot,
      mediaType: "image/jpeg",
    };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function actionScript(): string {
  return [
    powershellHeader(),
    "Add-Type -AssemblyName System.Windows.Forms",
    nativePreamble(),
    "$handle = [IntPtr][long]$env:CC_WINDOW_ID",
    "if (-not [CCAgentComputerNative]::IsWindow($handle)) { throw 'Target window no longer exists.' }",
    "$input = ConvertFrom-Json $env:CC_ACTION_INPUT",
    "if ([CCAgentComputerNative]::IsIconic($handle)) { [void][CCAgentComputerNative]::ShowWindowAsync($handle, 9); Start-Sleep -Milliseconds 250 }",
    "$currentThread = [CCAgentComputerNative]::GetCurrentThreadId()",
    "$targetPid = [uint32]0",
    "$targetThread = [CCAgentComputerNative]::GetWindowThreadProcessId($handle, [ref]$targetPid)",
    "$foregroundHandle = [CCAgentComputerNative]::GetForegroundWindow()",
    "$foregroundPid = [uint32]0",
    "$foregroundThread = if ($foregroundHandle -ne [IntPtr]::Zero) { [CCAgentComputerNative]::GetWindowThreadProcessId($foregroundHandle, [ref]$foregroundPid) } else { [uint32]0 }",
    "$attachedTarget = $false; $attachedForeground = $false",
    "try {",
    "  if ($targetThread -ne 0 -and $targetThread -ne $currentThread) { $attachedTarget = [CCAgentComputerNative]::AttachThreadInput($currentThread, $targetThread, $true) }",
    "  if ($foregroundThread -ne 0 -and $foregroundThread -ne $currentThread -and $foregroundThread -ne $targetThread) { $attachedForeground = [CCAgentComputerNative]::AttachThreadInput($currentThread, $foregroundThread, $true) }",
    "  [void][CCAgentComputerNative]::BringWindowToTop($handle)",
    "  [void][CCAgentComputerNative]::SetForegroundWindow($handle)",
    "} finally {",
    "  if ($attachedForeground) { [void][CCAgentComputerNative]::AttachThreadInput($currentThread, $foregroundThread, $false) }",
    "  if ($attachedTarget) { [void][CCAgentComputerNative]::AttachThreadInput($currentThread, $targetThread, $false) }",
    "}",
    "Start-Sleep -Milliseconds 150",
    "if ([CCAgentComputerNative]::GetForegroundWindow() -ne $handle) {",
    "  [CCAgentComputerNative]::SwitchToThisWindow($handle, $true)",
    "  Start-Sleep -Milliseconds 150",
    "}",
    "if ([CCAgentComputerNative]::GetForegroundWindow() -ne $handle) {",
    "  $shell = New-Object -ComObject WScript.Shell",
    "  [void]$shell.AppActivate([int]$targetPid)",
    "  Start-Sleep -Milliseconds 150",
    "}",
    "if ([CCAgentComputerNative]::GetForegroundWindow() -ne $handle) {",
    "  [CCAgentComputerNative]::keybd_event([byte]0x12, 0, 0, [UIntPtr]::Zero)",
    "  try { [void][CCAgentComputerNative]::SetForegroundWindow($handle) } finally { [CCAgentComputerNative]::keybd_event([byte]0x12, 0, 2, [UIntPtr]::Zero) }",
    "  Start-Sleep -Milliseconds 150",
    "}",
    "if ([CCAgentComputerNative]::GetForegroundWindow() -ne $handle) { throw 'Could not safely activate the exact target window; no input was sent. Re-observe and retry.' }",
    "$rect = New-Object CCAgentComputerNative+RECT",
    "if (-not [CCAgentComputerNative]::GetWindowRect($handle, [ref]$rect)) { throw 'Could not read target window bounds.' }",
    "$currentWidth = $rect.Right - $rect.Left; $currentHeight = $rect.Bottom - $rect.Top",
    "if ($currentWidth -ne [int]$env:CC_EXPECTED_WIDTH -or $currentHeight -ne [int]$env:CC_EXPECTED_HEIGHT) { throw 'Target window size changed after the snapshot; no input was sent. Re-observe before retrying.' }",
    "function Move-Cursor([int]$x, [int]$y) { [void][CCAgentComputerNative]::SetCursorPos($rect.Left + $x, $rect.Top + $y) }",
    "function Send-MouseClick([string]$button, [int]$count) {",
    "  $down = [uint32]0x0002; $up = [uint32]0x0004",
    "  if ($button -eq 'right') { $down = 0x0008; $up = 0x0010 }",
    "  if ($button -eq 'middle') { $down = 0x0020; $up = 0x0040 }",
    "  for ($i = 0; $i -lt $count; $i++) { [CCAgentComputerNative]::mouse_event($down,0,0,0,[UIntPtr]::Zero); [CCAgentComputerNative]::mouse_event($up,0,0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds 70 }",
    "}",
    "function Escape-SendKeys([string]$value) {",
    "  $builder = New-Object System.Text.StringBuilder",
    "  foreach ($character in $value.ToCharArray()) {",
    "    $piece = switch ([string]$character) { '+' {'{+}'} '^' {'{^}'} '%' {'{%}'} '~' {'{~}'} '(' {'{(}'} ')' {'{)}'} '{' {'{{}'} '}' {'{}}'} '[' {'{[}'} ']' {'{]}'} default {[string]$character} }",
    "    [void]$builder.Append($piece)",
    "  }",
    "  return $builder.ToString()",
    "}",
    "function Send-KeyChordNative([string]$key) {",
    "  $parts = @($key -split '\\+' | ForEach-Object { $_.Trim() } | Where-Object { $_ })",
    "  if ($parts.Count -eq 0) { throw 'Empty key chord.' }",
    "  $modifiers = New-Object System.Collections.Generic.List[byte]",
    "  for ($i = 0; $i -lt $parts.Count - 1; $i++) {",
    "    switch -Regex ($parts[$i]) { '^(Control|Ctrl|Control_L|Control_R)$' {$modifiers.Add([byte]0x11)} '^(Alt|Alt_L|Alt_R)$' {$modifiers.Add([byte]0x12)} '^(Shift|Shift_L|Shift_R)$' {$modifiers.Add([byte]0x10)} default { throw ('Unsupported key modifier: ' + $parts[$i]) } }",
    "  }",
    "  $main = $parts[$parts.Count - 1]",
    "  $virtualKey = switch -Regex ($main) {",
    "    '^(Return|Enter)$' {[byte]0x0D} '^(Escape|Esc)$' {[byte]0x1B} '^Tab$' {[byte]0x09} '^Backspace$' {[byte]0x08} '^Delete$' {[byte]0x2E}",
    "    '^Up$' {[byte]0x26} '^Down$' {[byte]0x28} '^Left$' {[byte]0x25} '^Right$' {[byte]0x27} '^Home$' {[byte]0x24} '^End$' {[byte]0x23}",
    "    '^Page_?Up$' {[byte]0x21} '^Page_?Down$' {[byte]0x22} '^Space$' {[byte]0x20}",
    "    '^F([1-9]|1[0-2])$' {[byte](0x70 + [int]$Matches[1] - 1)}",
    "    default {",
    "      if ($main.Length -ne 1) { throw ('Unsupported key: ' + $main) }",
    "      $scan = [CCAgentComputerNative]::VkKeyScan($main[0])",
    "      if ($scan -eq -1) { throw ('Unsupported key: ' + $main) }",
    "      $implicit = ([int]$scan -shr 8) -band 0xFF",
    "      if (($implicit -band 1) -ne 0 -and -not $modifiers.Contains([byte]0x10)) { $modifiers.Add([byte]0x10) }",
    "      if (($implicit -band 2) -ne 0 -and -not $modifiers.Contains([byte]0x11)) { $modifiers.Add([byte]0x11) }",
    "      if (($implicit -band 4) -ne 0 -and -not $modifiers.Contains([byte]0x12)) { $modifiers.Add([byte]0x12) }",
    "      [byte]([int]$scan -band 0xFF)",
    "    }",
    "  }",
    "  try {",
    "    foreach ($modifier in $modifiers) { [CCAgentComputerNative]::keybd_event($modifier, 0, 0, [UIntPtr]::Zero) }",
    "    [CCAgentComputerNative]::keybd_event($virtualKey, 0, 0, [UIntPtr]::Zero)",
    "    [CCAgentComputerNative]::keybd_event($virtualKey, 0, 2, [UIntPtr]::Zero)",
    "  } finally {",
    "    for ($i = $modifiers.Count - 1; $i -ge 0; $i--) { [CCAgentComputerNative]::keybd_event($modifiers[$i], 0, 2, [UIntPtr]::Zero) }",
    "  }",
    "  Start-Sleep -Milliseconds 60",
    "}",
    "switch ([string]$input.action) {",
    "  'activate' {}",
    "  'click' { Move-Cursor ([int]$input.x) ([int]$input.y); Send-MouseClick ([string]$input.button) ([int]$input.clickCount) }",
    "  'type_text' { [System.Windows.Forms.SendKeys]::SendWait((Escape-SendKeys ([string]$input.text))) }",
    "  'press_key' { Send-KeyChordNative ([string]$input.key) }",
    "  'scroll' { Move-Cursor ([int]$input.x) ([int]$input.y); [CCAgentComputerNative]::mouse_event(0x0800,0,0,-[int]$input.scrollY,[UIntPtr]::Zero); if ([int]$input.scrollX -ne 0) { [CCAgentComputerNative]::mouse_event(0x01000,0,0,[int]$input.scrollX,[UIntPtr]::Zero) } }",
    "  'drag' {",
    "    Move-Cursor ([int]$input.fromX) ([int]$input.fromY); [CCAgentComputerNative]::mouse_event(0x0002,0,0,0,[UIntPtr]::Zero)",
    "    for ($i = 1; $i -le 20; $i++) { $x = [int]([double]$input.fromX + (([double]$input.toX - [double]$input.fromX) * $i / 20)); $y = [int]([double]$input.fromY + (([double]$input.toY - [double]$input.fromY) * $i / 20)); Move-Cursor $x $y; Start-Sleep -Milliseconds 12 }",
    "    [CCAgentComputerNative]::mouse_event(0x0004,0,0,0,[UIntPtr]::Zero)",
    "  }",
    "  'set_value' { Move-Cursor ([int]$input.x) ([int]$input.y); Send-MouseClick 'left' 1; Send-KeyChordNative 'Control+a'; [System.Windows.Forms.SendKeys]::SendWait((Escape-SendKeys ([string]$input.text))) }",
    "  'wait' { Start-Sleep -Milliseconds ([int]$input.durationMs) }",
    "  default { throw ('Unsupported Computer Use action: ' + [string]$input.action) }",
    "}",
    "[pscustomobject]@{ ok = $true } | ConvertTo-Json -Compress",
  ].join("\n");
}

export async function performComputerAction(
  window: ComputerWindow,
  action: ComputerAction,
  expectedSize: { width: number; height: number },
  signal?: AbortSignal,
): Promise<void> {
  await runPowerShell(
    actionScript(),
    {
      CC_WINDOW_ID: window.id,
      CC_ACTION_INPUT: JSON.stringify(action),
      CC_EXPECTED_WIDTH: String(expectedSize.width),
      CC_EXPECTED_HEIGHT: String(expectedSize.height),
    },
    signal,
    action.action === "wait" ? Math.max(DEFAULT_TIMEOUT_MS, action.durationMs + 5_000) : DEFAULT_TIMEOUT_MS,
  );
}
