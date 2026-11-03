$ErrorActionPreference = 'Stop'
$expectedScript = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'discord_collector_server.cjs'))
$line = netstat -ano -p tcp | Select-String '127.0.0.1:8765\s+0.0.0.0:0\s+LISTENING' | Select-Object -First 1
if (-not $line) { Write-Host 'Collector is already stopped.'; exit 0 }
$processIdText = ($line.ToString().Trim() -split '\s+')[-1]
$processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $processIdText"
if (-not $processInfo -or $processInfo.CommandLine -notlike "*$expectedScript*") {
    throw 'Port 8765 is owned by another process; refusing to stop it.'
}
Stop-Process -Id ([int]$processIdText) -ErrorAction Stop
Write-Host 'Stopped Discord collector and QQ forwarding.'
