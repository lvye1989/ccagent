export const COMPUTER_USE_INDICATOR_TITLE = "CCAGENT 正在控制电脑";
export const COMPUTER_USE_INDICATOR_SUBTITLE = "AI control active · 鼠标与键盘可能自动操作";

export interface ComputerUseIndicatorConfig {
  enabled: boolean;
  holdMs: number;
}

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
    holdMs: boundedInteger(env.CCAGENT_COMPUTER_USE_INDICATOR_HOLD_MS, 650, 250, 3_000),
  };
}

/**
 * WinForms overlay compiled only when an input action is about to be sent.
 * Both windows are topmost, click-through, excluded from Alt+Tab, and shown
 * without activation so the verified target window keeps keyboard focus.
 */
export function computerUseIndicatorPowerShell(): string {
  return [
    "$indicatorSource = @'",
    "using System;",
    "using System.Drawing;",
    "using System.Drawing.Drawing2D;",
    "using System.Threading;",
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
    "  private readonly string target;",
    "  public CCAgentControlBanner(string targetName) {",
    "    target = String.IsNullOrWhiteSpace(targetName) ? \"desktop application\" : targetName;",
    "    ClientSize = new Size(540, 78);",
    "    BackColor = Color.FromArgb(30, 34, 46);",
    "    Opacity = 0.96;",
    "    Rectangle screen = SystemInformation.VirtualScreen;",
    "    Location = new Point(screen.Left + Math.Max(12, (screen.Width - Width) / 2), screen.Top + 24);",
    "  }",
    "  protected override void OnPaint(PaintEventArgs e) {",
    "    base.OnPaint(e);",
    "    e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;",
    "    using (Brush accent = new SolidBrush(Color.FromArgb(255, 92, 92))) e.Graphics.FillEllipse(accent, 18, 21, 14, 14);",
    "    using (Pen pulse = new Pen(Color.FromArgb(155, 255, 92, 92), 3f)) e.Graphics.DrawEllipse(pulse, 12, 15, 26, 26);",
    "    using (Font heading = new Font(\"Microsoft YaHei UI\", 12.5f, FontStyle.Bold))",
    "    using (Brush text = new SolidBrush(Color.White)) e.Graphics.DrawString(\"" + COMPUTER_USE_INDICATOR_TITLE + "\", heading, text, 52, 10);",
    "    string detail = \"" + COMPUTER_USE_INDICATOR_SUBTITLE + " · 目标：\" + target;",
    "    if (detail.Length > 82) detail = detail.Substring(0, 81) + \"…\";",
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
    "  public static void Show(string targetName) {",
    "    Hide();",
    "    banner = new CCAgentControlBanner(targetName);",
    "    cursor = new CCAgentCursorBadge();",
    "    UpdateCursor();",
    "    banner.Show();",
    "    cursor.Show();",
    "    banner.Refresh();",
    "    cursor.Refresh();",
    "    Application.DoEvents();",
    "  }",
    "  public static void UpdateCursor() {",
    "    if (cursor == null || cursor.IsDisposed) return;",
    "    Point point = Cursor.Position;",
    "    Rectangle screen = SystemInformation.VirtualScreen;",
    "    int x = Math.Max(screen.Left, Math.Min(point.X - 31, screen.Right - cursor.Width));",
    "    int y = Math.Max(screen.Top, Math.Min(point.Y - 31, screen.Bottom - cursor.Height));",
    "    cursor.Location = new Point(x, y);",
    "    cursor.Refresh();",
    "    Application.DoEvents();",
    "  }",
    "  public static void Pump(int milliseconds) {",
    "    int duration = Math.Max(0, milliseconds);",
    "    DateTime until = DateTime.UtcNow.AddMilliseconds(duration);",
    "    do {",
    "      UpdateCursor();",
    "      Application.DoEvents();",
    "      Thread.Sleep(16);",
    "    } while (DateTime.UtcNow < until);",
    "  }",
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
