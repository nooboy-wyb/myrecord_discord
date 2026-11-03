param([Parameter(Mandatory=$true)][string]$SourceId,[switch]$SecondConfirmedMissing,[switch]$WholeConfirmedMissing)
$ErrorActionPreference = 'Stop'
if ($SourceId -notmatch '^\d+$') { throw 'Invalid Discord message ID.' }
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
if (-not (Test-Path -LiteralPath $credentialFile)) { throw 'Missing encrypted QQ credential.' }
$credential = Import-Clixml -LiteralPath $credentialFile
$env:QQ_BOT_APP_SECRET = $credential.GetNetworkCredential().Password
try {
    $arguments = @('--use-env-proxy',(Join-Path $PSScriptRoot 'repair_liuyudong_images.cjs'),$SourceId)
    if ($SecondConfirmedMissing) { $arguments += '--second-confirmed-missing' }
    if ($WholeConfirmedMissing) { $arguments += '--whole-confirmed-missing' }
    & $node @arguments
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally {
    Remove-Item Env:QQ_BOT_APP_SECRET -ErrorAction SilentlyContinue
    $credential = $null
}
