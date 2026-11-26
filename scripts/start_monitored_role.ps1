param([Parameter(Mandatory=$true)][ValidateSet('discord','telegram','qq')][string]$Role)
$ErrorActionPreference = 'Stop'
if ($env:MUSE_NODE_PATH) { $env:Path = (Split-Path $env:MUSE_NODE_PATH -Parent) + ';' + $env:Path }
$roleExitCode = 0
$failureType = $null
try {
    switch ($Role) {
        'discord' { & (Join-Path $PSScriptRoot 'start_discord_collector.ps1') }
        'telegram' { & (Join-Path $PSScriptRoot 'start_telegram.ps1') -Action Monitor }
        'qq' { & (Join-Path $PSScriptRoot 'start_qq_sender.ps1') }
    }
} catch {
    $roleExitCode = if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) { $LASTEXITCODE } else { 1 }
    $failureType = $_.Exception.GetType().Name
    Write-Output ('Role {0} exited: {1}, code {2}' -f $Role, $failureType, $roleExitCode)
} finally {
    if ($env:MUSE_MONITOR_LAUNCH_RESULT) {
        $result = @{role=$Role; exited_at=[DateTimeOffset]::UtcNow.ToString('o'); exit_code=$roleExitCode; error_type=$failureType} | ConvertTo-Json -Compress
        [IO.File]::WriteAllText($env:MUSE_MONITOR_LAUNCH_RESULT, $result, (New-Object Text.UTF8Encoding($false)))
    }
}
exit $roleExitCode
