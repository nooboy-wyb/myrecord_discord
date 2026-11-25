param(
    [ValidateSet('Setup', 'Configure', 'Login', 'Status', 'Channels', 'Probe', 'Watch')]
    [string]$Action = 'Status',
    [string]$Channel,
    [ValidateRange(1, 1000)][int]$Limit = 5,
    [ValidateRange(0, 2147483647)][int]$Seconds = 60,
    [ValidateSet('qr', 'phone')][string]$LoginMethod = 'qr',
    [string]$Proxy,
    [string]$Python
)
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$dataDirectory = Join-Path $projectRoot 'data\telegram'
$runtime = Join-Path $dataDirectory 'runtime\Scripts\python.exe'
$entryPoint = Join-Path $PSScriptRoot 'telegram\collector.py'
[IO.Directory]::CreateDirectory((Join-Path $dataDirectory 'tmp')) | Out-Null
$previousProxy = $env:TELEGRAM_PROXY
$previousEncoding = $env:PYTHONIOENCODING
$previousTemp = $env:TEMP
$previousTmp = $env:TMP
try {
    $env:PYTHONIOENCODING = 'utf-8'
    $env:TEMP = Join-Path $dataDirectory 'tmp'
    $env:TMP = $env:TEMP
    if ($Proxy) {
        $env:TELEGRAM_PROXY = $Proxy
    } elseif (-not $env:TELEGRAM_PROXY) {
        $settings = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -ErrorAction SilentlyContinue
        if ($settings.ProxyEnable -eq 1 -and $settings.ProxyServer) {
            $address = [string]$settings.ProxyServer
            if ($address -match '(^|;)https?=([^;]+)') { $address = $Matches[2] }
            if ($address -notmatch '^\w+://') { $address = "http://$address" }
            $env:TELEGRAM_PROXY = $address
        }
    }
    if ($Action -eq 'Setup') {
        if (-not (Test-Path -LiteralPath $runtime)) {
            if (-not $Python) { $Python = (Get-Command python -ErrorAction Stop).Source }
            & $Python -m venv (Join-Path $dataDirectory 'runtime')
            if ($LASTEXITCODE -ne 0) { throw 'Telegram Python environment creation failed' }
        }
        $installArguments = @('-m', 'pip', 'install', '--disable-pip-version-check', '--index-url', 'https://pypi.org/simple', '-r', (Join-Path $PSScriptRoot 'telegram\requirements.txt'))
        if ($env:TELEGRAM_PROXY) { $installArguments += @('--proxy', $env:TELEGRAM_PROXY) }
        & $runtime @installArguments
        if ($LASTEXITCODE -ne 0) { throw 'Telegram dependency installation failed' }
        return
    }
    if (-not (Test-Path -LiteralPath $runtime)) { throw 'Run this script with -Action Setup first' }
    $command = if ($Action -eq 'Channels') { 'dialogs' } else { $Action.ToLowerInvariant() }
    $telegramArguments = @($entryPoint, $command, '--data-dir', $dataDirectory)
    if ($Action -eq 'Channels' -and -not $PSBoundParameters.ContainsKey('Limit')) { $Limit = 1000 }
    $telegramArguments += @('--limit', [string]$Limit)
    if ($Channel) { $telegramArguments += @('--channel', $Channel) }
    if ($Action -eq 'Watch') { $telegramArguments += @('--seconds', [string]$Seconds) }
    if ($Action -eq 'Login') { $telegramArguments += @('--login-method', $LoginMethod) }
    & $runtime @telegramArguments
    if ($LASTEXITCODE -ne 0) { throw "Telegram $Action exited with code $LASTEXITCODE" }
} finally {
    $env:TELEGRAM_PROXY = $previousProxy
    $env:PYTHONIOENCODING = $previousEncoding
    $env:TEMP = $previousTemp
    $env:TMP = $previousTmp
}
