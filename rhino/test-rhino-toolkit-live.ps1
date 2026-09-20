param([switch]$Execute)
$ErrorActionPreference = 'Stop'
if (-not $Execute) { throw 'Pass -Execute to run native Rhino regressions in an isolated headless document.' }
$running = @(Get-Process -Name Rhino -ErrorAction SilentlyContinue)
if ($running.Count -ne 1) { throw 'Exactly one running Rhino instance is required.' }
$testPath = Join-Path $PSScriptRoot 'test_toolkit_live.py'
$testStartedUtc = [DateTime]::UtcNow
$rhino = New-Object -ComObject Rhino.Interface.8
try {
    if (@(Get-Process -Name Rhino -ErrorAction SilentlyContinue).Count -ne 1) { throw 'COM attachment created another Rhino instance; refusing tests.' }
    $escapedPath = $testPath.Replace('"', '""')
    if (-not $rhino.RunScript('_-RunPythonScript "' + $escapedPath + '" _Enter', 0)) { throw 'Rhino rejected the fixed regression script.' }
} finally {
    try { $rhino.ReleaseWithoutClosing = 1 } catch {}
}
$reportPath = Join-Path ([Environment]::GetFolderPath('Desktop')) 'CCAGENT-Rhino/native-tests/toolkit-live-results.json'
if ((Get-Item -LiteralPath $reportPath).LastWriteTimeUtc -lt $testStartedUtc) { throw 'Rhino did not produce a fresh test report; refusing stale results.' }
$result = Get-Content -LiteralPath $reportPath -Raw -Encoding UTF8 | ConvertFrom-Json
Write-Output ("Native tests: {0} passed, {1} failed" -f $result.passed, $result.failed)
$result.tests | Where-Object { -not $_.ok } | Select-Object name,error,trace | ConvertTo-Json -Depth 10
if ($result.failed -gt 0) { exit 1 }
