$ErrorActionPreference = 'Stop'
$bundledNode = 'C:\Users\Administrator\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
$node = if (Test-Path $bundledNode) { $bundledNode } else { (Get-Command node -ErrorAction Stop).Source }
$settings = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'
if ($settings.ProxyEnable -eq 1 -and $settings.ProxyServer) {
    $address = [string]$settings.ProxyServer
    if ($address -match '(^|;)https?=([^;]+)') { $address = $Matches[2] }
    if ($address -notmatch '^https?://') { $address = "http://$address" }
    $env:HTTPS_PROXY = $address
    $env:HTTP_PROXY = $address
    $env:NO_PROXY = '127.0.0.1,localhost'
    Write-Host "Using Windows proxy: $address"
}
$logDir = Join-Path $PSScriptRoot '..\data\logs'
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$logEncoding = New-Object System.Text.UTF8Encoding($false)
function Write-CollectorLog([string]$text) {
    $now = Get-Date
    $line = '[{0}] {1}' -f $now.ToString('yyyy-MM-dd HH:mm:ss.fff zzz'), $text
    $logFile = Join-Path $logDir ('collector-{0}.log' -f $now.ToString('yyyy-MM-dd'))
    [System.IO.File]::AppendAllText($logFile, $line + [Environment]::NewLine, $logEncoding)
    Write-Host $line
}

Write-CollectorLog "Starting Discord collector with Node $node"
$previousErrorAction = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
$nodeExitCode = -1
try {
    & $node --use-env-proxy (Join-Path $PSScriptRoot 'discord_collector_server.cjs')
    $nodeExitCode = $LASTEXITCODE
} finally {
    $ErrorActionPreference = $previousErrorAction
    Write-CollectorLog "Discord collector exited with code $nodeExitCode"
}
if ($nodeExitCode -ne 0) { throw "Discord collector exited with code $nodeExitCode; see $logDir" }
