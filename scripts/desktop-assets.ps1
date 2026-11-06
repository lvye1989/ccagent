param([Parameter(Mandatory=$true)][string]$Destination)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
New-Item -ItemType Directory -Path $Destination -Force | Out-Null
function New-BrandBitmap([int]$Width, [int]$Height, [string]$Target, [bool]$Sidebar) {
  $bitmap = New-Object System.Drawing.Bitmap($Width, $Height)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $rectangle = New-Object System.Drawing.Rectangle(0, 0, $Width, $Height)
  $gradient = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rectangle, [System.Drawing.Color]::FromArgb(18,40,70), [System.Drawing.Color]::FromArgb(37,86,138), 60)
  $graphics.FillRectangle($gradient, $rectangle)
  $white = [System.Drawing.Brushes]::White
  if ($Sidebar) {
    $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::White, 5)
    $graphics.DrawArc($pen, 24, 32, 30, 30, 42, 276)
    $font = New-Object System.Drawing.Font('Segoe UI', 14, [System.Drawing.FontStyle]::Bold)
    $graphics.DrawString('CCAGENT', $font, $white, 20, 85)
    $small = New-Object System.Drawing.Font('Segoe UI', 8)
    $muted = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(176,204,232))
    $graphics.DrawString("YOUR LOCAL`nAI WORKSPACE", $small, $muted, 22, 119)
    $graphics.DrawString('WINDOWS DESKTOP', $small, $muted, 22, 278)
    $circle = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(60,110,160), 1)
    $graphics.DrawEllipse($circle, 55, 172, 210, 210)
    $circle.Dispose(); $muted.Dispose(); $small.Dispose(); $font.Dispose(); $pen.Dispose()
  } else {
    $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::White, 5)
    $graphics.DrawArc($pen, 14, 14, 27, 27, 42, 276)
    $font = New-Object System.Drawing.Font('Segoe UI', 11, [System.Drawing.FontStyle]::Bold)
    $graphics.DrawString('CCAGENT', $font, $white, 52, 18)
    $font.Dispose(); $pen.Dispose()
  }
  $bitmap.Save($Target, [System.Drawing.Imaging.ImageFormat]::Bmp)
  $gradient.Dispose(); $graphics.Dispose(); $bitmap.Dispose()
}
New-BrandBitmap 164 314 (Join-Path $Destination 'sidebar.bmp') $true
New-BrandBitmap 150 57 (Join-Path $Destination 'header.bmp') $false
# Multi-resolution ICO, using PNG frames for crisp taskbar and shortcut icons.
$frames = New-Object 'System.Collections.Generic.List[byte[]]'
foreach ($size in @(16, 24, 32, 48, 64, 128, 256)) {
  $bitmap = New-Object System.Drawing.Bitmap($size, $size)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $graphics.Clear([System.Drawing.Color]::FromArgb(24,60,102))
  $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::White, ($size * 0.11))
  $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  $graphics.DrawArc($pen, ($size * 0.24), ($size * 0.24), ($size * 0.52), ($size * 0.52), 42, 276)
  $stream = New-Object System.IO.MemoryStream
  $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
  $frames.Add($stream.ToArray())
  $pen.Dispose(); $graphics.Dispose(); $bitmap.Dispose(); $stream.Dispose()
}
$file = [System.IO.File]::Create((Join-Path $Destination 'icon.ico'))
$writer = New-Object System.IO.BinaryWriter($file)
$writer.Write([uint16]0); $writer.Write([uint16]1); $writer.Write([uint16]$frames.Count)
$offset = 6 + 16 * $frames.Count
$sizes = @(16, 24, 32, 48, 64, 128, 256)
for ($i = 0; $i -lt $frames.Count; $i++) {
  $dimension = if ($sizes[$i] -eq 256) { 0 } else { $sizes[$i] }
  $writer.Write([byte]$dimension); $writer.Write([byte]$dimension)
  $writer.Write([byte]0); $writer.Write([byte]0)
  $writer.Write([uint16]1); $writer.Write([uint16]32)
  $writer.Write([uint32]$frames[$i].Length); $writer.Write([uint32]$offset)
  $offset += $frames[$i].Length
}
foreach ($frame in $frames) { $writer.Write([byte[]]$frame) }
$writer.Dispose(); $file.Dispose()
