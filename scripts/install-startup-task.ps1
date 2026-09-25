# Registers a Windows Scheduled Task that starts auto-pr-review when you log on.
# NOT run automatically - run it yourself if you want auto-start:
#   powershell -ExecutionPolicy Bypass -File D:\auto-pr-review\scripts\install-startup-task.ps1
#   powershell -ExecutionPolicy Bypass -File D:\auto-pr-review\scripts\install-startup-task.ps1 -DryRun
# Remove with scripts\uninstall-startup-task.ps1
param(
  [string]$TaskName = 'auto-pr-review',
  [switch]$DryRun
)

$root = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node -ErrorAction Stop).Source
$argLine = '"' + (Join-Path $root 'src\index.js') + '"'
if ($DryRun) { $argLine += ' --dry-run' }

# Runs in your interactive session (needed so the red review windows can be shown).
$action    = New-ScheduledTaskAction -Execute $node -Argument $argLine -WorkingDirectory $root
$trigger   = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
$settings  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 5) -StartWhenAvailable

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings `
  -Description 'Auto-reviews GitHub PRs assigned to me (dashboard http://localhost:4545)' -Force | Out-Null

Write-Host "Scheduled task '$TaskName' registered. It starts at next logon."
Write-Host "Start it now with:  Start-ScheduledTask -TaskName $TaskName"
