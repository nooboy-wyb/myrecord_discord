param(
    [Parameter(Mandatory = $true)][string]$ChannelId,
    [ValidateRange(1,50)][int]$Count = 20
)
$ErrorActionPreference = 'Stop'
$bundledNode = 'C:\Users\Administrator\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
$node = if (Test-Path $bundledNode) { $bundledNode } else { (Get-Command node -ErrorAction Stop).Source }
& $node (Join-Path $PSScriptRoot 'queue_qq_history.cjs') $ChannelId $Count
