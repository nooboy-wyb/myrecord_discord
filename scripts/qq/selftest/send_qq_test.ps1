param([switch]$Image, [switch]$Additional, [string]$SourceId)
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
}
$credentialFile = Join-Path $PSScriptRoot '..\..\..\data\qq-bot-credential.xml'
if (Test-Path -LiteralPath $credentialFile) {
    $credential = Import-Clixml -LiteralPath $credentialFile
    $env:QQ_BOT_APP_SECRET = $credential.GetNetworkCredential().Password
} else {
    $secureSecret = Read-Host 'Enter the reset AppSecret (input hidden)' -AsSecureString
    $env:QQ_BOT_APP_SECRET = [System.Net.NetworkCredential]::new('', $secureSecret).Password
}
try {
    $arguments = @('--use-env-proxy', (Join-Path $PSScriptRoot 'send.cjs'))
    if ($Image) { $arguments += '--image' }
    if ($Additional) { $arguments += '--additional' }
    if ($SourceId) { $arguments += @('--source-id', $SourceId) }
    & $node @arguments
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally {
    Remove-Item Env:QQ_BOT_APP_SECRET -ErrorAction SilentlyContinue
    $credential = $null
    $secureSecret = $null
}
