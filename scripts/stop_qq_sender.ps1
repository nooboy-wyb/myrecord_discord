$ErrorActionPreference = 'Stop'
$port = if ($env:MUSE_QQ_PORT) { [int]$env:MUSE_QQ_PORT } else { 8766 }
$expected = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'qq\sender.cjs'))
$listener = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $listener) { Write-Host 'QQ sender is already stopped.'; return }
$processInfo = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)"
if (-not $processInfo -or $processInfo.CommandLine -notlike "*$expected*") { throw 'Sender port belongs to another process' }
Stop-Process -Id $listener.OwningProcess -ErrorAction Stop
Write-Host 'Stopped QQ sender; collectors continue independently.'
