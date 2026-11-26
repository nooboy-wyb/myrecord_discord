param(
    [Parameter(Mandatory=$true)][ValidateSet('discord','telegram','qq')][string]$Role,
    [switch]$Submit,
    [string]$NodePath,
    [string]$CodexPath,
    [ValidateRange(10,900)][int]$TimeoutSeconds = 300
)
$ErrorActionPreference = 'Stop'
if (-not $NodePath) { $NodePath = (Get-Command node -ErrorAction Stop).Source }
$entry = Join-Path $PSScriptRoot 'monitor_diagnosis.cjs'
$ErrorActionPreference = 'Continue'
$preparedJson = & $NodePath $entry --role $Role
$prepareExit = $LASTEXITCODE
$ErrorActionPreference = 'Stop'
if ($prepareExit -ne 0) { throw 'Could not prepare monitoring diagnosis' }
$prepared = $preparedJson | ConvertFrom-Json
if (-not $Submit) {
    $preparedJson
    exit 0
}
if (Test-Path -LiteralPath $prepared.response) {
    Write-Output ('Diagnosis already exists: ' + $prepared.response)
    exit 0
}
if (-not $CodexPath) { $CodexPath = (Get-Command codex -ErrorAction Stop).Source }
$windowsPowerShell = (Get-Command powershell.exe -ErrorAction Stop).Source
function ConvertTo-PSLiteral([string]$Value) { "'" + $Value.Replace("'", "''") + "'" }
$submissionLock = $null
$temporaryFolder = $null
$child = $null
try {
    $submissionLock = [IO.File]::Open((Join-Path $prepared.job 'submit.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
    if (Test-Path -LiteralPath $prepared.response) {
        Write-Output ('Diagnosis already exists: ' + $prepared.response)
        exit 0
    }
    $temporaryFolder = Join-Path ([IO.Path]::GetTempPath()) ('muse-codex-diagnosis-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $temporaryFolder | Out-Null
    $promptFile = Join-Path $temporaryFolder 'prompt.txt'
    $schemaFile = Join-Path $temporaryFolder 'response.schema.json'
    $resultFile = Join-Path $temporaryFolder 'result.json'
    Copy-Item -LiteralPath $prepared.prompt -Destination $promptFile
    Copy-Item -LiteralPath $prepared.schema -Destination $schemaFile
    $invokeScript = @(
        "`$ErrorActionPreference = 'Continue'",
        "`$ProgressPreference = 'SilentlyContinue'",
        '$OutputEncoding = New-Object Text.UTF8Encoding($false)',
        ('Get-Content -LiteralPath ' + (ConvertTo-PSLiteral $promptFile) + ' -Raw -Encoding UTF8 | & ' + (ConvertTo-PSLiteral $CodexPath) +
            ' exec --ignore-user-config --ephemeral --sandbox read-only --skip-git-repo-check --color never --cd ' + (ConvertTo-PSLiteral $temporaryFolder) +
            ' --output-schema ' + (ConvertTo-PSLiteral $schemaFile) + ' --output-last-message ' + (ConvertTo-PSLiteral $resultFile) + ' -'),
        'exit $LASTEXITCODE'
    ) -join "`n"
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($invokeScript))
    $child = Start-Process -FilePath $windowsPowerShell -ArgumentList @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand',$encoded) `
        -WorkingDirectory $temporaryFolder -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput (Join-Path $prepared.job 'codex.stdout.log') -RedirectStandardError (Join-Path $prepared.job 'codex.stderr.log')
    $childHandle = $child.Handle
    if (-not $child.WaitForExit($TimeoutSeconds * 1000)) { throw 'Codex diagnosis timed out' }
    $child.WaitForExit()
    if ($child.ExitCode -ne 0) { throw 'Codex diagnosis failed; inspect the local diagnosis logs' }
    $ErrorActionPreference = 'Continue'
    & $NodePath $entry --role $Role --job $prepared.job --response $resultFile
    $validationExit = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
    if ($validationExit -ne 0) { throw 'Codex response failed validation; no recovery was executed' }
} finally {
    if ($child -and -not $child.HasExited) {
        & taskkill.exe /PID $child.Id /T /F | Out-Null
        $child.WaitForExit(5000) | Out-Null
    }
    if ($submissionLock) { $submissionLock.Dispose() }
    if ($temporaryFolder) {
        $resolvedFolder = [IO.Path]::GetFullPath($temporaryFolder)
        $expectedParent = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
        if ([IO.Path]::GetDirectoryName($resolvedFolder).TrimEnd('\') -eq $expectedParent -and
            [IO.Path]::GetFileName($resolvedFolder) -match '^muse-codex-diagnosis-[a-f0-9]{32}$') {
            Remove-Item -LiteralPath $resolvedFolder -Recurse -Force
        }
    }
}
