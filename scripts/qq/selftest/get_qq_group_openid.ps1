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
$env:QQ_BOT_APP_ID = Read-Host 'Enter AppID of the bot in the group'
$secureSecret = Read-Host 'Enter the reset AppSecret (input hidden)' -AsSecureString
$env:QQ_BOT_APP_SECRET = [System.Net.NetworkCredential]::new('', $secureSecret).Password
try {
    & $node --use-env-proxy (Join-Path $PSScriptRoot '..\core\gateway.cjs')
} finally {
    Remove-Item Env:QQ_BOT_APP_ID -ErrorAction SilentlyContinue
    Remove-Item Env:QQ_BOT_APP_SECRET -ErrorAction SilentlyContinue
}
