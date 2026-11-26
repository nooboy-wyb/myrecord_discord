param(
    [ValidateSet('Status','Recover','Pause','Resume')][string]$Action = 'Status',
    [ValidateSet('all','discord','telegram','qq')][string]$Role = 'all',
    [string]$NodePath
)
$ErrorActionPreference = 'Stop'
if (-not $NodePath) { $NodePath = (Get-Command node -ErrorAction Stop).Source }
if ($Action -in @('Status','Recover')) {
    & (Join-Path $PSScriptRoot 'check_services.ps1') -NodePath $NodePath -Role $Role -Recover:($Action -eq 'Recover')
    exit $LASTEXITCODE
}
$arguments = @((Join-Path $PSScriptRoot 'service_monitor.cjs'), '--role', $Role)
switch ($Action) {
    'Pause' { $arguments += @('--control', 'pause') }
    'Resume' { $arguments += @('--control', 'resume') }
}
$ErrorActionPreference = 'Continue'
& $NodePath @arguments
exit $LASTEXITCODE
