param([string]$GroupNumber = '1132949059', [int]$TimeoutSeconds = 600)
$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'qq\selftest\get_qq_additional_group_openid.ps1') -GroupNumber $GroupNumber -TimeoutSeconds $TimeoutSeconds
if (-not $?) { exit 1 }
