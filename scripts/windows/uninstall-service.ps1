# ===========================================================================
#  HomeCloud - remove the Windows auto-start task
#  Right-click -> "Run with PowerShell"
# ===========================================================================
$ErrorActionPreference = "Stop"
$taskName = "HomeCloudLAN"
schtasks /Delete /TN $taskName /F 2>$null
if ($LASTEXITCODE -eq 0) {
  Write-Host "Auto-start task '$taskName' removed."
} else {
  Write-Host "No auto-start task named '$taskName' was found (nothing to do)."
}
