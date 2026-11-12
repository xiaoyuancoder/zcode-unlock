'use strict';
// 用 Windows 计划任务托管守护进程：登录时启动 + 崩溃自动重启
const { execFileSync } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

const TASK = 'ZCodeUnlockWatchdog';
// 通过 VBS 启动器拉起：node.exe 是控制台程序，直接执行会弹黑窗
const WSCRIPT = path.join(process.env.SystemRoot || 'C:/Windows', 'System32', 'wscript.exe');
const VBS = path.join(__dirname, 'run-hidden.vbs');

function ps(script) {
  return execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    encoding: 'utf8',
  });
}

const install = `
$ErrorActionPreference='Stop'
$action = New-ScheduledTaskAction -Execute '${WSCRIPT}' -Argument '"${VBS}"' -WorkingDirectory '${__dirname}'
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName '${TASK}' -Action $action -Trigger $trigger -Settings $settings -Description 'ZCode prompt injection watchdog (hidden window)' -Force | Out-Null
Write-Output 'installed'
`;

const uninstall = `
$ErrorActionPreference='SilentlyContinue'
Unregister-ScheduledTask -TaskName '${TASK}' -Confirm:$false
Write-Output 'uninstalled'
`;

const cmd = process.argv[2] === 'uninstall' ? uninstall : install;
console.log(ps(cmd).trim());
