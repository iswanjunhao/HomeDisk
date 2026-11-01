# ===========================================================================
#  HomeCloud - Windows auto-start installer (runs in background)
#
#  What it does:
#    - Registers a Windows Task Scheduler task named "HomeCloudLAN"
#    - The task runs scripts\windows\start-homecloud.bat HIDDEN
#    - Trigger: at system startup (runs even with no user logged on)
#    - Account: SYSTEM (so it keeps running unattended)
#
#  Usage (run once, as Administrator is recommended):
#    Right-click this file -> "Run with PowerShell"
#
#  Notes:
#    - If PowerShell blocks the script:  Set-ExecutionPolicy RemoteSigned -Scope CurrentUser
#    - To remove auto-start later, run uninstall-service.ps1
#    - Edit the shared drive in start-homecloud.bat first!
# ===========================================================================

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$batPath  = Join-Path $scriptDir "start-homecloud.bat"
$taskName = "HomeCloudLAN"

if (-not (Test-Path $batPath)) {
  Write-Error "Cannot find $batPath. Keep the folder structure intact (scripts\windows\start-homecloud.bat)."
  exit 1
}

# Action: launch the bat through cmd.exe
$action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"$batPath`""

# Trigger: at every Windows startup
$trigger = New-ScheduledTaskTrigger -AtStartup

# Settings: run on battery, do not stop on idle, hidden, no time limit
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -Hidden `
  -ExecutionTimeLimit (New-TimeSpan -Days 3650) `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1)

# Principal: run as SYSTEM so it works without a logged-in user, with highest privileges
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest

# Register (overwrite if exists)
schtasks /Delete /TN $taskName /F 2>$null | Out-Null
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null

Write-Host "Task '$taskName' registered. Starting it now..."
Start-ScheduledTask -TaskName $taskName

Write-Host ""
Write-Host "Done. HomeCloud will start automatically at Windows boot."
Write-Host "Access it from any LAN device:  http://<this-pc-ip>:8080"
Write-Host "On this PC:                     http://127.0.0.1:8080"
