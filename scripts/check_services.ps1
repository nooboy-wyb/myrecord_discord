param(
    [switch]$Recover,
    [string]$NodePath,
    [ValidateSet('all','discord','telegram','qq')][string]$Role = 'all',
    [ValidateRange(1,300)][int]$TimeoutSeconds = 90
)
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$dataRoot = if ($env:MUSE_DATA_DIR) { [IO.Path]::GetFullPath($env:MUSE_DATA_DIR) } else { Join-Path $projectRoot 'data' }
$folder = Join-Path $dataRoot 'monitor'
New-Item -ItemType Directory -Path $folder -Force | Out-Null
$encoding = New-Object Text.UTF8Encoding($false)
$statusFile = Join-Path $folder 'supervisor-status.json'
$supervisorLock = $null
$child = $null
$exitCode = 1
$status = $null
function Write-SupervisorStatus($Value) {
    $temporary = $statusFile + '.' + $PID + '.tmp'
    [IO.File]::WriteAllText($temporary, ($Value | ConvertTo-Json -Depth 5), $encoding)
    if ([IO.File]::Exists($statusFile)) { [IO.File]::Replace($temporary, $statusFile, [NullString]::Value) }
    else { [IO.File]::Move($temporary, $statusFile) }
}
function Write-SupervisorEvent([string]$Event, $Value) {
    $zone = [TimeZoneInfo]::FindSystemTimeZoneById('China Standard Time')
    $day = [TimeZoneInfo]::ConvertTimeFromUtc([DateTime]::UtcNow, $zone).ToString('yyyy-MM-dd')
    $eventFile = Join-Path $folder ('supervisor-events-' + $day + '.jsonl')
    $record = @{event=$Event; observed_at=[DateTimeOffset]::UtcNow.ToString('o'); status=$Value}
    [IO.File]::AppendAllText($eventFile, ($record | ConvertTo-Json -Depth 6 -Compress) + "`n", $encoding)
}
function Stop-OwnedTick {
    try { $child.Kill() } catch { if (-not $child.HasExited) { throw } }
    if (-not $child.WaitForExit(5000)) { throw 'Monitor tick could not be terminated' }
}
try {
    try { $supervisorLock = [IO.File]::Open((Join-Path $folder 'supervisor.lock'), 'OpenOrCreate', 'ReadWrite', 'None') }
    catch [IO.IOException] {
        $code = $_.Exception.HResult -band 0xFFFF
        if ($code -notin @(32,33)) { throw }
        Write-Output '{"supervisor":"ALREADY_RUNNING"}'
        exit 0
    }
    $previous = if (Test-Path -LiteralPath $statusFile) { Get-Content -LiteralPath $statusFile -Raw -Encoding UTF8 | ConvertFrom-Json } else { $null }
    $startedAt = [DateTimeOffset]::UtcNow.ToString('o')
    $logPrefix = Join-Path $folder ('tick-' + [guid]::NewGuid().ToString('N'))
    $status = @{state='RUNNING'; started_at=$startedAt; finished_at=$null; tick_pid=$null; exit_code=$null;
        timeout_seconds=$TimeoutSeconds; recovery_enabled=[bool]$Recover; recovery_role=$Role;
        last_success_at=$previous.last_success_at; consecutive_failures=[int]$previous.consecutive_failures;
        stdout=($logPrefix + '.stdout.log'); stderr=($logPrefix + '.stderr.log'); error_type=$null}
    Write-SupervisorStatus $status
    if (-not $NodePath) { $NodePath = (Get-Command node -ErrorAction Stop).Source }
    $arguments = '"{0}" --role {1}' -f (Join-Path $PSScriptRoot 'service_monitor.cjs'), $Role
    if ($Recover) { $arguments += ' --recover' }
    $child = Start-Process -FilePath $NodePath -ArgumentList $arguments -WorkingDirectory $projectRoot -WindowStyle Hidden `
        -RedirectStandardOutput $status.stdout -RedirectStandardError $status.stderr -PassThru
    $childHandle = $child.Handle
    $status.tick_pid = $child.Id
    Write-SupervisorStatus $status
    if ($child.WaitForExit($TimeoutSeconds * 1000)) {
        if ($null -eq $child.ExitCode) { throw 'Monitor exit code unavailable' }
        $exitCode = [int]$child.ExitCode
        $status.state = if ($exitCode -eq 0) { 'SUCCEEDED' } else { 'FAILED' }
    } else {
        Stop-OwnedTick
        $exitCode = 124
        $status.state = 'TIMED_OUT'
    }
} catch {
    if ($status) { $status.state = 'FAILED'; $status.error_type = $_.Exception.GetType().Name }
    Write-Error -Message 'Monitor supervisor failed; inspect its local status and logs' -ErrorAction Continue
} finally {
    if ($child) {
        try { if (-not $child.HasExited) { Stop-OwnedTick } }
        catch {
            $exitCode = 1
            if ($status) { $status.state = 'FAILED'; $status.error_type = $_.Exception.GetType().Name }
        } finally { $child.Dispose() }
    }
    if ($supervisorLock) {
        try {
            if ($status) {
                $status.finished_at = [DateTimeOffset]::UtcNow.ToString('o')
                $status.exit_code = $exitCode
                if ($status.state -eq 'SUCCEEDED') { $status.last_success_at = $status.finished_at; $status.consecutive_failures = 0 }
                else { $status.consecutive_failures++ }
                Write-SupervisorStatus $status
                Write-SupervisorEvent 'tick_finished' $status
                $status | ConvertTo-Json -Depth 5 -Compress
            }
        } finally { $supervisorLock.Dispose() }
    }
}
exit $exitCode
