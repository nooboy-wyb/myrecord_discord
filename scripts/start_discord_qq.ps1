param([switch]$ResetCredential)
$ErrorActionPreference = 'Stop'
$sender = Join-Path $PSScriptRoot 'start_qq_sender.ps1'
$dataRoot = if ($env:MUSE_DATA_DIR) { $env:MUSE_DATA_DIR } else { Join-Path $PSScriptRoot '..\data' }
$collectorPort = if ($env:MUSE_COLLECTOR_PORT) { [int]$env:MUSE_COLLECTOR_PORT } else { 8765 }
if (Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort $collectorPort -State Listen -ErrorAction SilentlyContinue) {
    throw "Collector port $collectorPort is already in use. Stop the old collector before using this combined launcher."
}
$port = if ($env:MUSE_QQ_PORT) { [int]$env:MUSE_QQ_PORT } else { 8766 }
$listener = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($listener) {
    $owner = Get-CimInstance Win32_Process -Filter ('ProcessId={0}' -f @($listener)[0].OwningProcess)
    $expectedSender = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'qq\sender.cjs'))
    if (-not $owner.CommandLine -or $owner.CommandLine.Replace('/','\') -notmatch [regex]::Escape($expectedSender)) {
        throw "Port $port belongs to another process"
    }
    try {
        $token = (Get-Content -LiteralPath (Join-Path $dataRoot 'collector-token.txt') -Raw).Trim()
        $health = Invoke-RestMethod -Uri "http://127.0.0.1:$port/v1/health" -Headers @{'x-collector-token'=$token} -TimeoutSec 1
        if ($health.role -ne 'qq-sender') { throw 'Unexpected sender role' }
    } catch { throw 'Existing QQ sender failed the authenticated health check; verify its data directory and log.' }
}
if (-not $listener) {
    if ($ResetCredential) { throw 'Run start_qq_sender.ps1 -ResetCredential in an interactive terminal first.' }
    if (-not (Test-Path -LiteralPath (Join-Path $dataRoot 'qq-bot-credential.xml')) -or
        -not (Test-Path -LiteralPath (Join-Path $dataRoot 'qq-group-openid.json'))) {
        throw 'Run start_qq_sender.ps1 in an interactive terminal to configure the sender first.'
    }
    $arguments = @('-NoProfile','-ExecutionPolicy','Bypass','-File',('"{0}"' -f $sender))
    $process = Start-Process powershell -ArgumentList $arguments -WindowStyle Hidden -PassThru
    $ready = $false
    for ($attempt = 0; $attempt -lt 40; $attempt++) {
        if ($process.HasExited) { throw 'QQ sender failed to start; run start_qq_sender.ps1 interactively to inspect the error.' }
        try {
            $token = (Get-Content -LiteralPath (Join-Path $dataRoot 'collector-token.txt') -Raw).Trim()
            $health = Invoke-RestMethod -Uri "http://127.0.0.1:$port/v1/health" -Headers @{'x-collector-token'=$token} -TimeoutSec 1
            if ($health.role -eq 'qq-sender') { $ready = $true; break }
        } catch {}
        Start-Sleep -Milliseconds 250
    }
    if (-not $ready) { throw 'QQ sender health check timed out; inspect its log before starting collection.' }
}
Write-Host 'DC collection and QQ sending now run in separate processes.'
& (Join-Path $PSScriptRoot 'start_discord_collector.ps1')
