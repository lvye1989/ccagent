import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export const COMPUTER_USE_INDICATOR_TITLE = "ccagent正在控制电脑";
export const COMPUTER_USE_INDICATOR_SUBTITLE = "代理指针独立运行 · 您的鼠标仍可自由移动";

export interface ComputerUseIndicatorConfig {
  enabled: boolean;
  /** Safety fallback only. Normal shutdown happens when the agent turn ends. */
  idleTimeoutMs: number;
}

interface IndicatorSession {
  dir: string;
  statePath: string;
  child: ChildProcess;
}

const indicatorSessions = new Map<string, Promise<IndicatorSession>>();

function envBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || !value.trim()) return fallback;
  return !["0", "false", "no", "off"].includes(value.trim().toLowerCase());
}

function boundedInteger(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

export function getComputerUseIndicatorConfig(
  env: NodeJS.ProcessEnv = process.env,
): ComputerUseIndicatorConfig {
  return {
    enabled: envBoolean(env.CCAGENT_COMPUTER_USE_INDICATOR, true),
    idleTimeoutMs: boundedInteger(
      env.CCAGENT_COMPUTER_USE_INDICATOR_IDLE_TIMEOUT_MS,
      120_000,
      30_000,
      600_000,
    ),
  };
}

/**
 * Click-through WinForms overlay used by the long-lived indicator host.
 * The cursor is positioned only from CCAGENT's action coordinates; it never
 * reads or moves Windows Cursor.Position, so the user's hardware cursor stays
 * independent.
 */
export function computerUseIndicatorPowerShell(): string {
  return [
    "$indicatorSource = @'",
    "using System;",
    "using System.Drawing;",
    "using System.Drawing.Drawing2D;",
    "using System.Windows.Forms;",
    "public class CCAgentPassiveOverlayForm : Form {",
    "  protected override bool ShowWithoutActivation { get { return true; } }",
    "  protected override CreateParams CreateParams {",
    "    get {",
    "      CreateParams value = base.CreateParams;",
    "      value.ExStyle |= 0x08000000; // WS_EX_NOACTIVATE",
    "      value.ExStyle |= 0x00000020; // WS_EX_TRANSPARENT",
    "      value.ExStyle |= 0x00000080; // WS_EX_TOOLWINDOW",
    "      return value;",
    "    }",
    "  }",
    "  public CCAgentPassiveOverlayForm() {",
    "    FormBorderStyle = FormBorderStyle.None;",
    "    ShowInTaskbar = false;",
    "    StartPosition = FormStartPosition.Manual;",
    "    TopMost = true;",
    "    AutoScaleMode = AutoScaleMode.None;",
    "    DoubleBuffered = true;",
    "  }",
    "}",
    "public sealed class CCAgentControlBanner : CCAgentPassiveOverlayForm {",
    "  private string target = \"desktop application\";",
    "  public CCAgentControlBanner() {",
    "    ClientSize = new Size(570, 78);",
    "    BackColor = Color.FromArgb(30, 34, 46);",
    "    Opacity = 0.96;",
    "  }",
    "  public void UpdateTarget(string targetName, int left, int top, int width, int height) {",
    "    target = String.IsNullOrWhiteSpace(targetName) ? \"desktop application\" : targetName;",
    "    Rectangle screen = SystemInformation.VirtualScreen;",
    "    int desiredX = left + Math.Max(8, (width - Width) / 2);",
    "    int desiredY = top + 8;",
    "    int x = Math.Max(screen.Left, Math.Min(desiredX, screen.Right - Width));",
    "    int y = Math.Max(screen.Top, Math.Min(desiredY, screen.Bottom - Height));",
    "    Location = new Point(x, y);",
    "    Invalidate();",
    "  }",
    "  protected override void OnPaint(PaintEventArgs e) {",
    "    base.OnPaint(e);",
    "    e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;",
    "    using (Brush accent = new SolidBrush(Color.FromArgb(255, 92, 92))) e.Graphics.FillEllipse(accent, 18, 21, 14, 14);",
    "    using (Pen pulse = new Pen(Color.FromArgb(155, 255, 92, 92), 3f)) e.Graphics.DrawEllipse(pulse, 12, 15, 26, 26);",
    "    using (Font heading = new Font(\"Microsoft YaHei UI\", 12.5f, FontStyle.Bold))",
    "    using (Brush text = new SolidBrush(Color.White)) e.Graphics.DrawString(\"" + COMPUTER_USE_INDICATOR_TITLE + "\", heading, text, 52, 10);",
    "    string detail = \"" + COMPUTER_USE_INDICATOR_SUBTITLE + " · 目标：\" + target;",
    "    if (detail.Length > 88) detail = detail.Substring(0, 87) + \"…\";",
    "    using (Font body = new Font(\"Microsoft YaHei UI\", 9.2f, FontStyle.Regular))",
    "    using (Brush muted = new SolidBrush(Color.FromArgb(218, 224, 235))) e.Graphics.DrawString(detail, body, muted, 52, 42);",
    "  }",
    "}",
    "public sealed class CCAgentCursorBadge : CCAgentPassiveOverlayForm {",
    "  public CCAgentCursorBadge() {",
    "    ClientSize = new Size(84, 84);",
    "    BackColor = Color.Fuchsia;",
    "    TransparencyKey = Color.Fuchsia;",
    "  }",
    "  protected override void OnPaint(PaintEventArgs e) {",
    "    base.OnPaint(e);",
    "    e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;",
    "    using (Pen halo = new Pen(Color.FromArgb(235, 255, 72, 72), 4f)) e.Graphics.DrawEllipse(halo, 8, 8, 48, 48);",
    "    using (Pen outer = new Pen(Color.FromArgb(135, 255, 188, 66), 3f)) e.Graphics.DrawEllipse(outer, 2, 2, 60, 60);",
    "    Point[] pointer = new Point[] { new Point(31, 13), new Point(31, 55), new Point(41, 45), new Point(52, 68), new Point(61, 64), new Point(50, 42), new Point(65, 42) };",
    "    using (Brush fill = new SolidBrush(Color.White)) e.Graphics.FillPolygon(fill, pointer);",
    "    using (Pen edge = new Pen(Color.FromArgb(230, 210, 45, 45), 2.5f)) e.Graphics.DrawPolygon(edge, pointer);",
    "  }",
    "}",
    "public static class CCAgentControlOverlay {",
    "  private static CCAgentControlBanner banner;",
    "  private static CCAgentCursorBadge cursor;",
    "  public static void Show() {",
    "    if (banner != null) return;",
    "    banner = new CCAgentControlBanner();",
    "    cursor = new CCAgentCursorBadge();",
    "    banner.Show();",
    "    cursor.Show();",
    "    cursor.Hide();",
    "    Application.DoEvents();",
    "  }",
    "  public static void Update(string targetName, int left, int top, int width, int height, int pointerX, int pointerY, bool pointerVisible) {",
    "    Show();",
    "    banner.UpdateTarget(targetName, left, top, width, height);",
    "    if (pointerVisible) {",
    "      Rectangle screen = SystemInformation.VirtualScreen;",
    "      int x = Math.Max(screen.Left, Math.Min(pointerX - 31, screen.Right - cursor.Width));",
    "      int y = Math.Max(screen.Top, Math.Min(pointerY - 13, screen.Bottom - cursor.Height));",
    "      cursor.Location = new Point(x, y);",
    "      if (!cursor.Visible) cursor.Show();",
    "      cursor.Invalidate();",
    "    } else if (cursor.Visible) { cursor.Hide(); }",
    "    banner.Invalidate();",
    "    Application.DoEvents();",
    "  }",
    "  public static void Pump() { Application.DoEvents(); }",
    "  public static void Hide() {",
    "    if (cursor != null) { cursor.Close(); cursor.Dispose(); cursor = null; }",
    "    if (banner != null) { banner.Close(); banner.Dispose(); banner = null; }",
    "    Application.DoEvents();",
    "  }",
    "}",
    "'@",
    "[void](Add-Type -TypeDefinition $indicatorSource -ReferencedAssemblies 'System.Drawing','System.Windows.Forms')",
  ].join("\n");
}

export function computerUseIndicatorHostPowerShell(): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    "Add-Type -AssemblyName System.Windows.Forms",
    computerUseIndicatorPowerShell(),
    "$statePath = $env:CC_INDICATOR_STATE_PATH",
    "$idleTimeoutMs = [int64]$env:CC_INDICATOR_IDLE_TIMEOUT_MS",
    "$lastHeartbeat = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()",
    "try {",
    "  while ($true) {",
    "    if ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - $lastHeartbeat -gt $idleTimeoutMs) { break }",
    "    if (Test-Path -LiteralPath $statePath) {",
    "      try {",
    "        $raw = [System.IO.File]::ReadAllText($statePath, [System.Text.Encoding]::UTF8)",
    "        if ($raw) {",
    "          $state = ConvertFrom-Json $raw",
    "          if ($state.stop -eq $true) { break }",
    "          if ([int64]$state.updatedAt -gt $lastHeartbeat) { $lastHeartbeat = [int64]$state.updatedAt }",
    "          if ($state.active -eq $true) { [CCAgentControlOverlay]::Update([string]$state.targetLabel, [int]$state.left, [int]$state.top, [int]$state.width, [int]$state.height, [int]$state.pointerX, [int]$state.pointerY, [bool]$state.pointerVisible) }",
    "        }",
    "      } catch { }",
    "    }",
    "    [CCAgentControlOverlay]::Pump()",
    "    Start-Sleep -Milliseconds 25",
    "  }",
    "} finally {",
    "  [CCAgentControlOverlay]::Hide()",
    "}",
  ].join("\n");
}

function normalizeSessionKey(sessionId: string | undefined): string {
  return sessionId?.trim() || "default";
}

async function createIndicatorSession(key: string, targetLabel: string): Promise<IndicatorSession> {
  const config = getComputerUseIndicatorConfig();
  const dir = await mkdtemp(path.join(os.tmpdir(), "ccagent-control-indicator-"));
  const statePath = path.join(dir, "state.json");
  const scriptPath = path.join(dir, "indicator.ps1");
  await writeFile(statePath, JSON.stringify({
    stop: false,
    active: false,
    updatedAt: Date.now(),
    targetLabel,
    left: 0,
    top: 0,
    width: 570,
    height: 78,
    pointerX: 0,
    pointerY: 0,
    pointerVisible: false,
  }), { encoding: "utf8", mode: 0o600 });
  await writeFile(scriptPath, "\uFEFF" + computerUseIndicatorHostPowerShell(), { encoding: "utf8", mode: 0o600 });

  const executable = process.env.CCAGENT_POWERSHELL?.trim() || "powershell.exe";
  const child = spawn(
    executable,
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
    {
      windowsHide: true,
      stdio: "ignore",
      env: {
        ...process.env,
        CC_INDICATOR_STATE_PATH: statePath,
        CC_INDICATOR_IDLE_TIMEOUT_MS: String(config.idleTimeoutMs),
      },
    },
  );
  child.unref();
  const session: IndicatorSession = { dir, statePath, child };
  const cleanup = () => {
    const current = indicatorSessions.get(key);
    if (current) {
      void current.then((active) => {
        if (active === session) indicatorSessions.delete(key);
      }).catch(() => {});
    }
    void rm(dir, { recursive: true, force: true }).catch(() => {});
  };
  child.once("error", cleanup);
  child.once("exit", cleanup);
  return session;
}

/** Start (or reuse) the task-level indicator and return its private state path. */
export async function ensureComputerUseIndicatorSession(
  sessionId: string | undefined,
  targetLabel: string,
): Promise<string | undefined> {
  if (process.platform !== "win32" || !getComputerUseIndicatorConfig().enabled) return undefined;
  const key = normalizeSessionKey(sessionId);
  let pending = indicatorSessions.get(key);
  if (!pending) {
    pending = createIndicatorSession(key, targetLabel);
    indicatorSessions.set(key, pending);
  }
  let session = await pending;
  if (session.child.exitCode !== null) {
    indicatorSessions.delete(key);
    pending = createIndicatorSession(key, targetLabel);
    indicatorSessions.set(key, pending);
    session = await pending;
  }
  return session.statePath;
}

/** End the indicator exactly when the owning agent turn ends or is aborted. */
export async function endComputerUseIndicatorSession(sessionId?: string): Promise<void> {
  const key = normalizeSessionKey(sessionId);
  const pending = indicatorSessions.get(key);
  if (!pending) return;
  indicatorSessions.delete(key);
  const session = await pending.catch(() => undefined);
  if (!session) return;
  await writeFile(session.statePath, JSON.stringify({ stop: true, updatedAt: Date.now() }), "utf8").catch(() => {});
  if (session.child.exitCode === null) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (session.child.exitCode === null) session.child.kill();
        resolve();
      }, 1_500);
      session.child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  await rm(session.dir, { recursive: true, force: true }).catch(() => {});
}

export function hasComputerUseIndicatorSession(sessionId?: string): boolean {
  return indicatorSessions.has(normalizeSessionKey(sessionId));
}
