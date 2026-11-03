param([Parameter(Mandatory=$true)][string]$SourceId,
  [Parameter(Mandatory=$true)][string]$GroupNumber,
  [Parameter(Mandatory=$true)][string]$ImageUrl,
  [switch]$DryRun)
$ErrorActionPreference = 'Stop'
if ($SourceId -notmatch '^\d{15,22}$' -or $GroupNumber -notmatch '^\d+$') { throw 'Invalid message ID or group number.' }
$node = (Get-Command node -ErrorAction Stop).Source
$settings = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'
if ($settings.ProxyEnable -eq 1 -and $settings.ProxyServer) {
    $address = [string]$settings.ProxyServer
    if ($address -match '(^|;)https?=([^;]+)') { $address = $Matches[2] }
    if ($address -notmatch '^https?://') { $address = "http://$address" }
    $env:HTTPS_PROXY = $address
    $env:HTTP_PROXY = $address
    $env:NO_PROXY = '127.0.0.1,localhost'
}
if (-not $DryRun) {
    $credentialFile = Join-Path $PSScriptRoot '..\..\..\data\qq-bot-credential.xml'
    $credential = Import-Clixml -LiteralPath $credentialFile
    $env:QQ_BOT_APP_SECRET = $credential.GetNetworkCredential().Password
}
try {
    $arguments = @('--use-env-proxy',(Join-Path $PSScriptRoot 'repair_uncaptured_image_from_url.cjs'),
      $SourceId,$GroupNumber,$ImageUrl)
    if ($DryRun) { $arguments += '--dry-run' }
    & $node @arguments
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally {
    Remove-Item Env:QQ_BOT_APP_SECRET -ErrorAction SilentlyContinue
    $credential = $null
}
