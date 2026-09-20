param([switch]$Execute, [Parameter(Mandatory=$true)][string]$ProjectDirectory)
$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$desktopRoot = [Environment]::GetFolderPath('Desktop')
$projectRoot = [IO.Path]::GetFullPath($ProjectDirectory)
if (-not $projectRoot.StartsWith(([IO.Path]::GetFullPath((Join-Path $desktopRoot 'CCAGENT-Rhino')) + '\'), [StringComparison]::OrdinalIgnoreCase)) { throw 'Destination must be a dedicated Desktop/CCAGENT-Rhino project.' }
if (-not (Test-Path -LiteralPath $projectRoot -PathType Container)) { throw 'Create and verify the project directory first.' }

# Explicit task artifacts only: never move source, configuration or tutorial files.
$moves = @(
    @('rhino\output', 'archive\previous-output'),
    @('rhino\_diag', 'archive\diagnostics'),
    @('rhino\__pycache__', 'archive\bytecode-cache'),
    @('rhino\tower-300m-zun.plan.json', 'inputs\tower-300m-zun.plan.json'),
    @('rhino\tower-300m-zun.curtainwall.plan.json', 'inputs\tower-300m-zun.curtainwall.plan.json'),
    @('rhino\reference-finish.txt', 'archive\reference-finish-original.txt'),
    @('ccagent-0.1.1.tgz', 'archive\old-package\ccagent-0.1.1.tgz')
)
$operations = @($moves | ForEach-Object { [pscustomobject]@{ Mode='move'; Source=(Join-Path $repoRoot $_[0]); Destination=(Join-Path $projectRoot $_[1]) } })
$towerName = -join ([char]0x4E2D, [char]0x56FD, [char]0x5C0A)
$operations += [pscustomobject]@{ Mode='copy'; Source=(Join-Path $desktopRoot ($towerName + '.3dm')); Destination=(Join-Path $projectRoot 'models\tower-original-saved.3dm') }
$operations += [pscustomobject]@{ Mode='copy'; Source=(Join-Path $desktopRoot '3fc3fbe3a3a2af128f56764248a65049.png'); Destination=(Join-Path $projectRoot 'inputs\reference.png') }
$operations += [pscustomobject]@{ Mode='copy'; Source=(Join-Path ([Environment]::GetFolderPath('UserProfile')) '.ccagent\rhino'); Destination=(Join-Path $projectRoot 'archive\user-rhino-history') }

function Assert-Unlinked([string]$Target) {
    $cursor = [IO.Path]::GetFullPath($Target)
    while ($cursor) {
        if (Test-Path -LiteralPath $cursor) {
            if ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Refusing linked path: $cursor" }
        }
        $parent = [IO.Directory]::GetParent($cursor)
        if ($null -eq $parent) { break }; $cursor = $parent.FullName
    }
}

$manifest = @()
foreach ($operation in $operations) {
    $source = (Get-Item -LiteralPath $operation.Source -Force).FullName
    $destination = [IO.Path]::GetFullPath($operation.Destination)
    if ($operation.Mode -eq 'move' -and -not $source.StartsWith($repoRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Move source escaped repository.' }
    if (-not $destination.StartsWith($projectRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Destination escaped project.' }
    Assert-Unlinked $source; Assert-Unlinked $destination
    if (Test-Path -LiteralPath $destination) { throw "Destination already exists; no overwrite allowed: $destination" }
    $entry = Get-Item -LiteralPath $source -Force
    if ($entry.PSIsContainer) {
        $children = @(Get-ChildItem -LiteralPath $source -Recurse -Force)
        if (@($children | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }).Count) { throw "Linked child found: $source" }
        $files = @($children | Where-Object { -not $_.PSIsContainer })
    } else { $files = @($entry) }
    foreach ($file in $files) {
        $target = if ($entry.PSIsContainer) { Join-Path $destination $file.FullName.Substring($source.Length + 1) } else { $destination }
        $manifest += [pscustomobject]@{ mode=$operation.Mode; source=$file.FullName; destination=$target; bytes=$file.Length; sha256=(Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash }
    }
}
$operations | Format-Table -AutoSize
Write-Output ("Validated {0} files. No sources will be deleted; moves remain recoverable at the recorded destinations." -f $manifest.Count)
if (-not $Execute) { Write-Output 'Dry run only. Pass -Execute to migrate.'; exit 0 }
$recordPath = Join-Path $projectRoot ('reports\migration-' + [Guid]::NewGuid().ToString() + '.json')
# Persist the recovery map before the first move, including all source hashes.
[IO.File]::WriteAllText($recordPath, (ConvertTo-Json -InputObject $manifest -Depth 5), (New-Object Text.UTF8Encoding($false)))
foreach ($operation in $operations) {
    Assert-Unlinked $operation.Source; Assert-Unlinked $operation.Destination
    $null = New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($operation.Destination)) -Force
    if ($operation.Mode -eq 'move') { Move-Item -LiteralPath $operation.Source -Destination $operation.Destination }
    else { Copy-Item -LiteralPath $operation.Source -Destination $operation.Destination -Recurse }
}
foreach ($file in $manifest) {
    if ((Get-FileHash -LiteralPath $file.destination -Algorithm SHA256).Hash -ne $file.sha256) { throw "Hash mismatch after migration: $($file.destination)" }
}
Write-Output ("All {0} hashes verified. Migration record: {1}" -f $manifest.Count, $recordPath)
