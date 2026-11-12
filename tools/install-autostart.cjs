'use strict';
/**
 * 安装 / 卸载开机自启的注入守护进程
 *
 * 用 HKCU\Run 注册表项（当前用户级，无需管理员）。
 * 守护进程在登录后常驻，监控引擎文件，被覆盖时自动重新注入。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const HERE = __dirname;
const NODE = process.execPath;
const RUN_KEY = 'HKCU' + String.fromCharCode(92) + 'Software' + String.fromCharCode(92) +
  'Microsoft' + String.fromCharCode(92) + 'Windows' + String.fromCharCode(92) +
  'CurrentVersion' + String.fromCharCode(92) + 'Run';
const VALUE_NAME = 'ZCodeUnlockWatchdog';

function regAdd(name, data) {
  const BS = String.fromCharCode(92);
  const key = 'HKCU' + BS + 'Software' + BS + 'Microsoft' + BS + 'Windows' + BS + 'CurrentVersion' + BS + 'Run';
  // 用 reg.exe 直接写，避免 PowerShell 脚本编码与引号转义问题
  execFileSync('reg.exe', ['add', key, '/v', name, '/t', 'REG_SZ', '/d', data, '/f'], { encoding: 'utf8' });
}

function regDelete(name) {
  const BS = String.fromCharCode(92);
  const key = 'HKCU' + BS + 'Software' + BS + 'Microsoft' + BS + 'Windows' + BS + 'CurrentVersion' + BS + 'Run';
  try {
    execFileSync('reg.exe', ['delete', key, '/v', name, '/f'], { encoding: 'utf8' });
  } catch {}
}

function regRead(name) {
  const BS = String.fromCharCode(92);
  const key = 'HKCU' + BS + 'Software' + BS + 'Microsoft' + BS + 'Windows' + BS + 'CurrentVersion' + BS + 'Run';
  try {
    const out = execFileSync('reg.exe', ['query', key, '/v', name], { encoding: 'utf8' });
    const m = out.match(/REG_SZ\s+(.+)/);
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

function install() {
  // 通过 VBS 启动器拉起：node.exe 是控制台程序，直接启动会弹黑窗。
  // VBS 用 WScript.Shell.Run(..., 0, False) 以 SW_HIDE 方式启动。
  const vbs = path.join(HERE, 'run-hidden.vbs');
  const wscript = path.join(process.env.SystemRoot || 'C:/Windows', 'System32', 'wscript.exe');
  const cmd = `"${wscript}" "${vbs}"`;
  regAdd(VALUE_NAME, cmd);
  const written = regRead(VALUE_NAME);
  return { ok: true, valueName: VALUE_NAME, command: cmd, verified: written === cmd, written };
}

function uninstall() {
  regDelete(VALUE_NAME);
  return { ok: true, valueName: VALUE_NAME, removed: regRead(VALUE_NAME) === null };
}

module.exports = { install, uninstall, VALUE_NAME };

if (require.main === module) {
  const cmd = process.argv[2] || 'install';
  const res = cmd === 'uninstall' ? uninstall() : install();
  console.log(JSON.stringify(res, null, 2));
}
