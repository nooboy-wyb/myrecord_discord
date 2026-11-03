param([switch]$ResetCredential)
$ErrorActionPreference = 'Stop'
$targetFile = Join-Path $PSScriptRoot '..\data\qq-group-openid.json'
if (-not (Test-Path $targetFile)) { throw 'Missing data/qq-group-openid.json. Get the target group OpenID first.' }
$target = Get-Content $targetFile -Raw | ConvertFrom-Json
$credentialFile = Join-Path $PSScriptRoot '..\data\qq-bot-credential.xml'
if ($ResetCredential -or -not (Test-Path $credentialFile)) {
    $secureSecret = Read-Host 'Enter AppSecret once for encrypted local storage (input hidden)' -AsSecureString
    $credential = [System.Management.Automation.PSCredential]::new([string]$target.app_id, $secureSecret)
    $credential | Export-Clixml -LiteralPath $credentialFile
    Write-Host 'Saved encrypted credential for this Windows user on this computer.'
} else {
    $credential = Import-Clixml -LiteralPath $credentialFile
}
if ($credential.UserName -ne [string]$target.app_id) {
    throw 'Stored credential AppID differs from the current target. Run again with -ResetCredential.'
}
$env:QQ_BOT_APP_ID = [string]$target.app_id
$env:QQ_BOT_APP_SECRET = $credential.GetNetworkCredential().Password
$env:QQ_FORWARD_ENABLED = '1'
try {
    & (Join-Path $PSScriptRoot 'start_discord_collector.ps1')
} finally {
    Remove-Item Env:QQ_BOT_APP_ID -ErrorAction SilentlyContinue
    Remove-Item Env:QQ_BOT_APP_SECRET -ErrorAction SilentlyContinue
    Remove-Item Env:QQ_FORWARD_ENABLED -ErrorAction SilentlyContinue
    $credential = $null
    $secureSecret = $null
}
