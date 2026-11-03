param(
    [string]$GroupNumber = '1132949059',
    [int]$TimeoutSeconds = 600
)
$ErrorActionPreference = 'Stop'
$routeFile = Join-Path $PSScriptRoot '..\..\..\data\qq-additional-routes.json'
if (-not (Test-Path -LiteralPath $routeFile)) { throw 'Missing data/qq-additional-routes.json.' }
if ($TimeoutSeconds -lt 1) { throw 'TimeoutSeconds must be positive.' }

function Read-TargetRoute {
    $config = Get-Content -LiteralPath $routeFile -Raw -Encoding UTF8 | ConvertFrom-Json
    $route = @($config.routes | Where-Object { [string]$_.qq_group_number -eq $GroupNumber })
    if ($route.Count -ne 1) { throw "Expected exactly one route for QQ group $GroupNumber." }
    return $route[0]
}

$route = Read-TargetRoute
if (-not $route.group_openid) {
    Write-Host "Mention the bot in QQ group $GroupNumber and send: bind $GroupNumber $($route.binding_code)"
    Write-Host 'Keep the Discord-QQ service running. This window waits for the Gateway event.'
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 2
        $route = Read-TargetRoute
        if ($route.group_openid) { break }
    }
}
if (-not $route.group_openid) { throw 'Timed out waiting for group binding. Check bot membership and Gateway logs.' }
Write-Host "Bound QQ group $GroupNumber. group_openid: $($route.group_openid)"
Write-Host "Channels: $($route.channel_ids -join ', ')"
if ($route.enabled_at) {
    Write-Host "Forwarding enabled at: $($route.enabled_at)"
} else {
    Write-Host "Forwarding disabled. Last send error: $($route.last_send_error)"
}
