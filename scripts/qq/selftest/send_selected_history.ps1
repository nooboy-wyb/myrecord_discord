param([Parameter(Mandatory = $true)][string]$FirstSourceId, [Parameter(Mandatory = $true)][string]$SecondSourceId)
$ErrorActionPreference = 'Stop'
$credentialFile = Join-Path $PSScriptRoot '..\..\..\data\qq-bot-credential.xml'
$credential = Import-Clixml -LiteralPath $credentialFile
$env:QQ_BOT_APP_SECRET = $credential.GetNetworkCredential().Password
$settings = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'
if ($settings.ProxyEnable -eq 1 -and $settings.ProxyServer) {
    $address = [string]$settings.ProxyServer
    if ($address -match '(^|;)https?=([^;]+)') { $address = $Matches[2] }
    if ($address -notmatch '^https?://') { $address = "http://$address" }
    $env:HTTPS_PROXY = $address
    $env:HTTP_PROXY = $address
}
try {
    $bundledNode = 'C:\Users\Administrator\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
    $node = if (Test-Path $bundledNode) { $bundledNode } else { (Get-Command node -ErrorAction Stop).Source }
    & $node --use-env-proxy (Join-Path $PSScriptRoot 'send_selected_history.cjs') $FirstSourceId $SecondSourceId
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally {
    Remove-Item Env:QQ_BOT_APP_SECRET -ErrorAction SilentlyContinue
    $credential = $null
}
