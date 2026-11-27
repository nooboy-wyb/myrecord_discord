param(
    [Parameter(Mandatory=$true)][string]$DataDirectory,
    [Parameter(Mandatory=$true)][string]$EntryPoint,
    [Parameter(Mandatory=$true)][string]$ExpectedStatusAt,
    [Parameter(Mandatory=$true)][string]$ExpectedProcesses
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$expected = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($ExpectedProcesses)) | ConvertFrom-Json
$expected = @($expected)
if ($expected.Count -lt 1 -or $expected.Count -gt 2) { throw 'Unexpected Telegram process chain' }
$statusFile = Join-Path $DataDirectory 'monitor-status.json'
function Confirm-StaleStatus {
    $status = Get-Content -LiteralPath $statusFile -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($status.at -ne $ExpectedStatusAt -or ([DateTimeOffset]::UtcNow - [DateTimeOffset]::Parse($status.at)).TotalSeconds -le 300) {
        throw 'Telegram scan progressed or is no longer stale; restart cancelled'
    }
}
Confirm-StaleStatus
$entryPattern = '(?i)(^|[\s"''])' + [regex]::Escape($EntryPoint.Replace('\','/')) + '(?=[\s"'']|$)'
$dataPattern = '(?i)--data-dir\s+["'']?' + [regex]::Escape($DataDirectory.Replace('\','/')) + '(?=[\s"'']|$)'
$matched = @(Get-CimInstance Win32_Process | Where-Object {
    $_.Name -in @('python.exe','pythonw.exe') -and $_.CommandLine -and
    ($_.CommandLine.Replace('\','/') -match $entryPattern) -and
    ($_.CommandLine -match '\smonitor(?:\s|$)') -and
    ($_.CommandLine.Replace('\','/') -match $dataPattern)
})
if ($matched.Count -ne $expected.Count) { throw ('Telegram process membership changed; restart cancelled (expected {0}, found {1})' -f $expected.Count,$matched.Count) }
foreach ($item in $expected) {
    $current = @($matched | Where-Object { $_.ProcessId -eq $item.pid })
    if ($current.Count -ne 1 -or $current[0].CreationDate.ToUniversalTime().ToString('o') -ne $item.created_at) {
        throw 'Telegram process identity changed; restart cancelled'
    }
}
if (@($matched | Where-Object { $_.ParentProcessId -notin @($matched.ProcessId) }).Count -ne 1) {
    throw 'Multiple Telegram instances; restart cancelled'
}
Confirm-StaleStatus
# Stop the verified runtime child first; its venv launcher normally exits with it.
foreach ($item in ($matched | Sort-Object @{e={if ($_.ParentProcessId -in @($matched.ProcessId)) {0} else {1}}})) {
    $current = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $item.ProcessId)
    if ($null -eq $current) { continue }
    if ($current.CreationDate.ToUniversalTime().ToString('o') -ne $item.CreationDate.ToUniversalTime().ToString('o')) {
        throw 'PID was reused; stop cancelled'
    }
    Stop-Process -Id $item.ProcessId -Force -ErrorAction Stop
}
foreach ($item in $matched) {
    $remaining = Get-Process -Id $item.ProcessId -ErrorAction SilentlyContinue
    if ($remaining -and -not $remaining.WaitForExit(5000)) { throw 'Telegram worker did not exit' }
}
@{pids=@($matched.ProcessId);reason='confirmed_scan_stall'} | ConvertTo-Json -Compress
