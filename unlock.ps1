param(
  [Parameter(Position = 0)]
  [ValidateSet('status', 'apply', 'rollback')]
  [string]$Action = 'status',

  # 工具部署目录。注入表达式会把该目录下的 system-prompt.md 路径写进引擎，
  # 部署后不要移动/重命名此目录。
  [string]$DeployDir = 'C:\zcode-unlock'
)

$ErrorActionPreference = 'Stop'
$srcTools = Join-Path $PSScriptRoot 'tools'
$injector = Join-Path $DeployDir 'prompt-injector.cjs'
$taskName = 'ZCodeUnlockWatchdog'

if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) {
  Write-Host '[X] Node.js not found in PATH. Install Node.js first.' -ForegroundColor Red
  exit 1
}

function Stop-WatchdogProcesses {
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*watchdog.cjs*" -and $_.CommandLine -like "*$DeployDir*" } |
    ForEach-Object {
      Write-Host "  stopping watchdog pid=$($_.ProcessId)"
      Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }
}

function Show-Status {
  Write-Host "== engine status =="
  & node.exe $injector status
}

switch ($Action) {
  'status' {
    if (-not (Test-Path $injector)) {
      Write-Host "[X] not deployed yet: $DeployDir (run: .\unlock.ps1 apply)" -ForegroundColor Yellow
      exit 1
    }
    Show-Status
  }

  'apply' {
    Write-Host "== deploying tools to $DeployDir =="
    New-Item -ItemType Directory -Force -Path $DeployDir | Out-Null
    Copy-Item (Join-Path $srcTools '*') $DeployDir -Force

    Write-Host "== injecting engine patch =="
    & node.exe $injector apply
    if ($LASTEXITCODE -ne 0) { Write-Host '[X] injection failed' -ForegroundColor Red; exit 1 }

    Write-Host "== installing watchdog (scheduled task + HKCU Run) =="
    & node.exe (Join-Path $DeployDir 'install-task.cjs') install
    & node.exe (Join-Path $DeployDir 'install-autostart.cjs') install

    Start-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    Write-Host ''
    Write-Host '[OK] done. Fully quit ZCode (including tray) and restart to take effect.' -ForegroundColor Green
    Write-Host "     edit prompt: $DeployDir\system-prompt.md, then restart ZCode again."
    Show-Status
  }

  'rollback' {
    Write-Host "== rollback =="
    Stop-WatchdogProcesses

    & node.exe (Join-Path $DeployDir 'install-autostart.cjs') uninstall
    & node.exe (Join-Path $DeployDir 'install-task.cjs') uninstall

    if (Test-Path $injector) {
      & node.exe $injector revert
    } else {
      Write-Host '  tools dir missing; restore engine manually from zcode.cjs.zcode-unlock.bak'
    }

    Remove-Item $DeployDir -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host '[OK] reverted. Fully quit ZCode and restart.' -ForegroundColor Green
  }
}
