param(
    [Parameter(Mandatory=$true)][string]$RequestFile,
    [Parameter(Mandatory=$true)][string]$DataDirectory,
    [Parameter(Mandatory=$true)][string]$NodePath
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$root = [IO.Path]::GetFullPath($DataDirectory)
$request = [IO.Path]::GetFullPath($RequestFile)
if (-not $request.StartsWith((Join-Path $root 'monitor') + '\',[StringComparison]::OrdinalIgnoreCase)) {
    throw 'Monitor notice must be stored in the monitor directory'
}
$credential = Import-Clixml -LiteralPath (Join-Path $root 'qq-bot-credential.xml')
$target = Get-Content -LiteralPath (Join-Path $root 'qq-group-openid.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($credential.UserName -ne [string]$target.app_id) { throw 'QQ credential AppID mismatch' }
$previous = @{}
foreach ($name in @('QQ_BOT_APP_ID','QQ_BOT_APP_SECRET','HTTPS_PROXY','HTTP_PROXY','NO_PROXY','MUSE_DATA_DIR')) {
    $previous[$name] = [Environment]::GetEnvironmentVariable($name,'Process')
}
try {
    $env:MUSE_DATA_DIR = $root
    $env:QQ_BOT_APP_ID = [string]$target.app_id
    $env:QQ_BOT_APP_SECRET = $credential.GetNetworkCredential().Password
    $settings = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -ErrorAction SilentlyContinue
    if ($settings.ProxyEnable -eq 1 -and $settings.ProxyServer) {
        $address = [string]$settings.ProxyServer
        if ($address -match '(^|;)https?=([^;]+)') { $address = $Matches[2] }
        if ($address -notmatch '^https?://') { $address = "http://$address" }
        $env:HTTPS_PROXY = $address
        $env:HTTP_PROXY = $address
        $env:NO_PROXY = '127.0.0.1,localhost'
    }
    $ErrorActionPreference = 'Continue'
    & $NodePath --use-env-proxy (Join-Path $PSScriptRoot 'monitor_notices.cjs') $request
    $noticeExit = $LASTEXITCODE
} finally {
    foreach ($name in $previous.Keys) { [Environment]::SetEnvironmentVariable($name,$previous[$name],'Process') }
    $credential = $null
}
exit $noticeExit
