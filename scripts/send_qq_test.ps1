param([switch]$Image, [switch]$Additional)
$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'qq\selftest\send_qq_test.ps1') -Image:$Image -Additional:$Additional
if (-not $?) { exit 1 }
