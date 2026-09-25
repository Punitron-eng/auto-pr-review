# Opened by auto-pr-review for every AI run. Paints the window RED, runs the engine job,
# records the exit code for the worker, then closes itself after a few seconds.
param(
  [Parameter(Mandatory = $true)][string]$JobDir,
  [string]$Title = 'PR Review',
  [string]$Node = 'node',
  [int]$CloseAfter = 15
)

try {
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  $Host.UI.RawUI.WindowTitle = $Title
  $Host.UI.RawUI.BackgroundColor = 'DarkRed'
  $Host.UI.RawUI.ForegroundColor = 'White'
  Clear-Host
} catch { }

Set-Content -Path (Join-Path $JobDir 'pid.txt') -Value $PID -Encoding ascii

$runner = Join-Path $PSScriptRoot '..\src\engine-runner.js'
& $Node $runner $JobDir
$code = $LASTEXITCODE
if ($null -eq $code) { $code = -1 }

Set-Content -Path (Join-Path $JobDir 'exitcode.txt') -Value $code -Encoding ascii

Write-Host ''
Write-Host "Review run finished (exit $code). This window will close in $CloseAfter seconds." -ForegroundColor White -BackgroundColor DarkRed
Start-Sleep -Seconds $CloseAfter
