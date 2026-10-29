param([switch]$ValidateOnly)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Windows.Forms
if ($ValidateOnly) { Write-Output 'Folder picker available'; exit 0 }
[System.Windows.Forms.Application]::EnableVisualStyles()
$picker = New-Object System.Windows.Forms.FolderBrowserDialog
$picker.Description = if ($env:CCAGENT_FOLDER_PICKER_TITLE) { $env:CCAGENT_FOLDER_PICKER_TITLE } else { 'Choose a CCAGENT working folder' }
$picker.ShowNewFolderButton = $false
if ($picker.PSObject.Properties['UseDescriptionForTitle']) { $picker.UseDescriptionForTitle = $true }
$initialFolder = $env:CCAGENT_FOLDER_PICKER_INITIAL
if ($initialFolder -and [System.IO.Directory]::Exists($initialFolder)) { $picker.SelectedPath = $initialFolder }
# A hidden owner keeps the shell hidden while putting the interactive picker in front.
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.Opacity = 0
$owner.StartPosition = 'CenterScreen'
try {
  $owner.Show()
  $owner.Activate()
  $result = $picker.ShowDialog($owner)
  if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
    ConvertTo-Json -InputObject $picker.SelectedPath -Compress
  } else { Write-Output 'null' }
} finally {
  $picker.Dispose()
  $owner.Close()
  $owner.Dispose()
}
