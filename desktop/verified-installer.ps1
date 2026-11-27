param(
  [Parameter(Mandatory=$true)][string]$Installer,
  [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{64}$')][string]$Sha256,
  [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{64}$')][string]$CertificateSha256,
  [switch]$Launch,
  [int]$ParentPid = 0
)
$ErrorActionPreference = 'Stop'
function Assert-Installer {
  if ((Get-FileHash -LiteralPath $Installer -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Sha256) { throw 'UPDATE_HASH_MISMATCH' }
  $signature = Get-AuthenticodeSignature -LiteralPath $Installer
  if ($signature.Status -ne 'Valid' -or !$signature.SignerCertificate -or $signature.SignerCertificate.GetCertHashString([System.Security.Cryptography.HashAlgorithmName]::SHA256).ToLowerInvariant() -ne $CertificateSha256) { throw 'UPDATE_PUBLISHER_INVALID' }
}
Assert-Installer
if ($Launch) {
  # The helper waits for this exact application PID; it never terminates processes.
  # Start a verified helper copy before exiting, then validate the installer again.
  $arguments = @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',('"' + $PSCommandPath + '"'),'-Installer',('"' + $Installer + '"'),'-Sha256',$Sha256,'-CertificateSha256',$CertificateSha256,'-ParentPid',$ParentPid)
  Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList $arguments -WindowStyle Hidden | Out-Null
} elseif ($ParentPid -gt 0) {
  try { Wait-Process -Id $ParentPid -Timeout 60 -ErrorAction Stop } catch { if (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue) { throw 'UPDATE_APPLICATION_STILL_RUNNING' } }
  Assert-Installer
  $installed = Start-Process -FilePath $Installer -ArgumentList @('/S','--updated','--force-run') -PassThru -Wait -WindowStyle Hidden
  if ($installed.ExitCode -ne 0) { throw 'UPDATE_INSTALLER_FAILED' }
}
