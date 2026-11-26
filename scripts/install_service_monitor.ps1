param([string]$NodePath, [switch]$ObserveOnly)
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (-not $NodePath) { $NodePath = (Get-Command node -ErrorAction Stop).Source }
$NodePath = (Resolve-Path -LiteralPath $NodePath).Path
$dataRoot = if ($env:MUSE_DATA_DIR) { [IO.Path]::GetFullPath($env:MUSE_DATA_DIR) } else { Join-Path $projectRoot 'data' }
if ($dataRoot -ne (Join-Path $projectRoot 'data')) { throw 'Scheduled monitor currently requires the default project data directory' }
$taskName = 'Muse-Service-Monitor-' + (Split-Path $projectRoot -Leaf)
$arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}" -NodePath "{1}"' -f (Join-Path $PSScriptRoot 'check_services.ps1'), $NodePath
if (-not $ObserveOnly) { $arguments += ' -Recover' }
$action = New-ScheduledTaskAction -Execute (Get-Command powershell.exe -ErrorAction Stop).Source -Argument $arguments -WorkingDirectory $projectRoot
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)
$principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Select-Object TaskName,State
