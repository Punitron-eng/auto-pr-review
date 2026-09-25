# Removes the auto-pr-review startup Scheduled Task.
param([string]$TaskName = 'auto-pr-review')
Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
Write-Host "Scheduled task '$TaskName' removed."
