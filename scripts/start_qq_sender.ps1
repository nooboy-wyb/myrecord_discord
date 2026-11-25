param([switch]$ResetCredential)
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$dataRoot = if ($env:MUSE_DATA_DIR) { $env:MUSE_DATA_DIR } else { Join-Path $projectRoot 'data' }
$target = Get-Content -LiteralPath (Join-Path $dataRoot 'qq-group-openid.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$credentialFile = Join-Path $dataRoot 'qq-bot-credential.xml'
if ($ResetCredential -or -not (Test-Path -LiteralPath $credentialFile)) {
    $secureSecret = Read-Host 'QQ AppSecret (encrypted local storage)' -AsSecureString
    $credential = [PSCredential]::new([string]$target.app_id, $secureSecret)
    $credential | Export-Clixml -LiteralPath $credentialFile
} else {
    $credential = Import-Clixml -LiteralPath $credentialFile
}
if ($credential.UserName -ne [string]$target.app_id) { throw 'QQ credential AppID mismatch' }
$previousEnvironment = @{}
foreach ($name in @('QQ_BOT_APP_ID','QQ_BOT_APP_SECRET','HTTPS_PROXY','HTTP_PROXY','NO_PROXY')) {
    $previousEnvironment[$name] = [Environment]::GetEnvironmentVariable($name,'Process')
}
try {
    $env:QQ_BOT_APP_ID = [string]$target.app_id
    $env:QQ_BOT_APP_SECRET = $credential.GetNetworkCredential().Password
    $settings = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'
    if ($settings.ProxyEnable -eq 1 -and $settings.ProxyServer) {
        $address = [string]$settings.ProxyServer
        if ($address -match '(^|;)https?=([^;]+)') { $address = $Matches[2] }
        if ($address -notmatch '^https?://') { $address = "http://$address" }
        $env:HTTPS_PROXY = $address
        $env:HTTP_PROXY = $address
        $env:NO_PROXY = '127.0.0.1,localhost'
    }
    $node = (Get-Command node -ErrorAction Stop).Source
    $previousErrorAction = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $senderExitCode = -1
    try {
        & $node --use-env-proxy (Join-Path $PSScriptRoot 'qq\sender.cjs')
        $senderExitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousErrorAction
    }
    if ($senderExitCode -ne 0) { throw "QQ sender exited with code $senderExitCode" }
} finally {
    foreach ($name in $previousEnvironment.Keys) {
        [Environment]::SetEnvironmentVariable($name,$previousEnvironment[$name],'Process')
    }
    $credential = $null
}
