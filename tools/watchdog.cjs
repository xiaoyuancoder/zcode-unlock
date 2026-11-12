'use strict';
/**
 * ZCode 破限注入守护进程
 *
 * 作用：持续监控引擎文件，一旦被官方更新 / 自修复 / 手动还原覆盖，
 *       立即重新注入提示词。这样「重启后失效」就不会再发生。
 *
 * 用法：
 *   node watchdog.cjs          前台运行（调试用）
 *   node watchdog.cjs --once   只检查一次就退出
 */

const fs = require('fs');
const path = require('path');

const LOG = path.join(__dirname, 'watchdog.log');
const INTERVAL = 15000; // 15s 轮询
const INJECTOR_PATH = path.join(__dirname, 'prompt-injector.cjs');

/**
 * 每次都重新加载注入器，避免 Node 的 require 缓存让我们一直用旧逻辑。
 * （改注入器后无需重启守护进程）
 */
function loadInjector() {
  delete require.cache[require.resolve(INJECTOR_PATH)];
  return require(INJECTOR_PATH);
}

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try {
    fs.appendFileSync(LOG, line);
  } catch {}
  process.stdout.write(line);
}

function engineStamp(enginePath) {
  try {
    const st = fs.statSync(enginePath);
    return `${st.size}:${st.mtimeMs}`;
  } catch {
    return null;
  }
}

function runOnce() {
  const injector = loadInjector();
  const engine = injector.findEngine();
  if (!engine) {
    log('engine not found');
    return 'no-engine';
  }
  const stamp = engineStamp(engine);
  const status = injector.status();
  if (status.injected) {
    return 'ok';
  }
  // 未注入 —— 说明引擎被覆盖了，重新注入。
  // 放到独立子进程里执行：守护进程本身长期持有引擎文件的读句柄，
  // 在 Windows 上会让 rename 覆盖失败。
  log(`detected un-injected engine (${stamp}); re-applying...`);
  const { spawnSync } = require('child_process');
  const r = spawnSync(process.execPath, [path.join(__dirname, 'prompt-injector.cjs'), 'apply'], {
    encoding: 'utf8',
    timeout: 60000,
    windowsHide: true,
  });
  const res = (() => {
    try { return JSON.parse(r.stdout); } catch { return null; }
  })();
  if (!res) {
    log(`re-inject produced no result: status=${r.status} stderr=${r.stderr}`);
    return 'failed';
  }
  if (res.ok && res.changed) {
    // 再确认一次，确保真的写进去了
    const after = loadInjector().status();
    if (after.injected) {
      log(`re-injected successfully; backup=${res.backup}`);
      return 'repaired';
    }
    log('re-inject reported success but verification failed');
    return 'failed';
  }
  log(`re-inject failed: ${JSON.stringify(res)}`);
  return 'failed';
}

function main() {
  const once = process.argv.includes('--once');
  log(`watchdog started (engine=${loadInjector().findEngine()})`);

  if (once) {
    const r = runOnce();
    log(`one-shot result: ${r}`);
    process.exit(r === 'failed' ? 1 : 0);
  }

  let last = null;
  const tick = () => {
    const engine = loadInjector().findEngine();
    const stamp = engine ? engineStamp(engine) : null;
    if (stamp !== last) {
      last = stamp;
      try {
        runOnce();
      } catch (e) {
        log(`error: ${e && e.message}`);
      }
    }
  };
  tick();
  setInterval(tick, INTERVAL);
  process.on('SIGINT', () => { log('stopped'); process.exit(0); });
  process.on('SIGTERM', () => { log('stopped'); process.exit(0); });
}

main();
