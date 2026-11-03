$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'qq\selftest\get_qq_group_openid.ps1')
if (-not $?) { exit 1 }
