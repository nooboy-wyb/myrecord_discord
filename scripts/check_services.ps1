param([switch]$Recover, [string]$NodePath)
$ErrorActionPreference = 'Stop'
if (-not $NodePath) { $NodePath = (Get-Command node -ErrorAction Stop).Source }
$arguments = @((Join-Path $PSScriptRoot 'service_monitor.cjs'))
if ($Recover) { $arguments += '--recover' }
$ErrorActionPreference = 'Continue'
& $NodePath @arguments
exit $LASTEXITCODE
