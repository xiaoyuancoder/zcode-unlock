'use strict';
/**
 * ZCode 引擎提示词注入器（幂等）
 *
 * 目标：把 resources/glm/zcode.cjs 里内置的「安全 / 道德边界」提示词替换为
 *       用户自定义内容，并保证官方升级或文案改动后仍能自动重新定位。
 *
 * 设计要点：
 *   1. 定位不绑定某一句固定文本，而是按「结构锚点」+「语义特征」多路匹配，
 *      官方改了措辞也能命中。
 *   2. 注入走 customSystemPrompt 通道：该字段非空时，引擎走
 *      custom_system_prompt 段，内置身份段（含安全条款）整体不再进入系统提示词。
 *   3. 幂等：已注入过则不重复改写，不会把文件越改越长。
 *   4. 原子替换：写临时文件 → node --check 通过 → os.replace 覆盖。
 *   5. 备份可回滚：保留一份 .zcode-unlock.bak，且带引擎指纹，避免拿旧备份覆盖新引擎。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const HERE = __dirname;
const PROMPT_FILE = path.join(HERE, 'system-prompt.md');
const MARKER = 'ZCODE_UNLOCK_INJECTED';

// ---------------------------------------------------------------- 引擎发现

function candidateEnginePaths() {
  const out = [];
  if (process.env.ZCODE_ENGINE) out.push(process.env.ZCODE_ENGINE);

  const roots = [];
  for (const d of ['C:', 'D:', 'E:', 'F:', 'G:', 'H:']) {
    roots.push(`${d}\\zcode`, `${d}\\ZCode`, `${d}\\Program Files\\ZCode`);
  }
  roots.push(
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'ZCode'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', '@opencodedesktop'),
    path.join(process.env.ProgramFiles || '', 'ZCode'),
  );

  for (const root of roots) {
    out.push(path.join(root, 'resources', 'glm', 'zcode.cjs'));
    out.push(path.join(root, 'Contents', 'Resources', 'glm', 'zcode.cjs'));
    out.push(path.join(root, 'resources', 'app.asar.unpacked', 'resources', 'glm', 'zcode.cjs'));
  }
  return out;
}

function findEngine() {
  for (const c of candidateEnginePaths()) {
    try {
      if (c && fs.existsSync(c) && fs.statSync(c).isFile()) return c;
    } catch {}
  }
  return null;
}

// ---------------------------------------------------------------- 定位策略

/**
 * 引擎把系统提示词各段拼成一个数组。安全条款是其中一个纯字符串常量。
 * 我们不假设它的具体措辞，而是找出「身份段构造函数」里被引用的那个常量。
 */
function findSecurityNoticeLiteral(source) {
  // 策略 A：结构锚点 —— buildIdentityPrompt 内部引用的标识符
  //   function <id>(e){return[[...,<ID>].join(...)]}
  // 先找 buildIdentityPrompt 的实现体
  const fnRe = /function\s+([A-Za-z_$][\w$]*)\s*\(\s*e\s*\)\s*\{\s*return\s*\[\[\s*""\s*,/g;
  let m;
  while ((m = fnRe.exec(source)) !== null) {
    const body = source.slice(m.index, m.index + 4000);
    // 该函数返回的数组里引用了一个模块级常量（形如 ,XXX] 或 ,XXX,""）
    const refRe = /,\s*([A-Za-z_$][\w$]*)\s*\]/g;
    let r;
    while ((r = refRe.exec(body)) !== null) {
      const id = r[1];
      const assign = findModuleConstant(source, id);
      if (assign && looksLikePolicyText(assign.value)) {
        return { kind: 'structural', id, value: assign.value, assignStart: assign.start, assignEnd: assign.end };
      }
    }
  }
  return null;
}

/** 找模块级常量赋值：<id>="..." 或 <id>=`...` */
function findModuleConstant(source, id) {
  const re = new RegExp(
    `(?:^|[;,{}]\\s*)${id.replace(/\$/g, '\\$')}\\s*=\\s*("(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*'|\`(?:[^\`\\\\]|\\\\.)*\`)`,
    'm'
  );
  const m = source.match(re);
  if (!m) return null;
  return { value: decodeLiteral(m[1]), start: m.index + m[0].indexOf(m[1]), end: m.index + m[0].indexOf(m[1]) + m[1].length, raw: m[1] };
}

/**
 * 找到「安全条款常量」当前所在的赋值位置。
 * 优先用结构锚点（buildIdentityPrompt 引用了谁），
 * 找不到时回退到语义扫描：所有看起来像安全条款的模块级字符串常量。
 */
function findPolicyConstant(source) {
  const structural = findSecurityNoticeLiteral(source);
  if (structural) return structural;

  // 语义回退：扫描所有模块级字符串常量，挑最像安全条款的
  const re = /(?:^|[;,{}]\s*)([A-Za-z_$][\w$]*)\s*=\s*("(?:[^"\\]|\\.)*")/gm;
  let best = null;
  let m;
  while ((m = re.exec(source)) !== null) {
    const id = m[1];
    const value = decodeLiteral(m[2]);
    if (!looksLikePolicyText(value)) continue;
    if (!best || value.length > best.value.length) {
      const start = m.index + m[0].indexOf(m[2]);
      best = { kind: 'semantic', id, value, assignStart: start, assignEnd: start + m[2].length };
    }
  }
  return best;
}

function decodeLiteral(lit) {
  if (lit.startsWith('"')) {
    try { return JSON.parse(lit); } catch { return lit.slice(1, -1); }
  }
  if (lit.startsWith("'")) return lit.slice(1, -1).replace(/\\'/g, "'").replace(/\\\\/g, '\\');
  return lit.slice(1, -1).replace(/\\`/g, '`').replace(/\\n/g, '\n').replace(/\\"/g, '"');
}

function encodeForDoubleQuote(text) {
  return JSON.stringify(text);
}

/** 语义特征：这段文字像不像「安全 / 道德边界」条款 */
function looksLikePolicyText(text) {
  if (typeof text !== 'string') return false;
  if (text.length < 40 || text.length > 20000) return false;
  const low = text.toLowerCase();
  const markers = [
    'refuse', 'dual-use', 'dual use', 'authorized security testing',
    'content policy', 'safety', 'do not', 'must not', 'should not',
    'ethical', 'malicious', 'harmful', 'decline', 'inappropriate',
    'not allowed', 'prohibited', 'illegal', 'unauthorized',
  ];
  const hits = markers.filter((m) => low.includes(m));
  return hits.length >= 2;
}

// ---------------------------------------------------------------- 注入

function findInjectionAnchor(source) {
  // customSystemPrompt 是引擎的配置字段，注入它即可让内置身份段整体旁路。
  const candidates = [
    'customSystemPrompt:this.config.systemPrompt,workflowActor:this.config.workflowActor,language:',
    'customSystemPrompt:this.config.systemPrompt,language:',
    'customSystemPrompt:this.config.systemPrompt,',
  ];
  for (const c of candidates) {
    if (source.includes(c)) return c;
  }
  // 兜底：只替换赋值表达式本身
  const m = source.match(/customSystemPrompt:this\.config\.systemPrompt/);
  return m ? m[0] : null;
}

/**
 * 生成替换安全条款常量的表达式。
 * 运行时从 system-prompt.md 读内容；读不到则回退到空字符串（此时该段为空，
 * 等同于没有安全条款），不会因为文件缺失而让引擎崩溃。
 */
function buildPolicyExpression() {
  const fileLiteral = JSON.stringify(PROMPT_FILE);
  return (
    '(()=>{try{const fs=require("node:fs");' +
    `const p=${fileLiteral};` +
    'if(fs.existsSync(p)){const t=fs.readFileSync(p,"utf8");if(t&&t.trim())return t}}catch(e){}' +
    'return ""})()'
  );
}

/**
 * 判断源码里是否已经存在我们的注入。
 * 判据：安全条款常量已被替换成读文件的表达式。
 */
function isInjected(source) {
  const c = findPolicyConstantWithState(source);
  return !!(c && c.isInjected);
}

/**
 * 找出源码里安全条款常量当前的赋值位置，并判断它是否已被注入。
 * 注入后常量值是一个 IIFE 表达式而非字符串字面量，
 * 因此要先按「已注入」形态匹配，再回退到字面量匹配。
 */
function findPolicyConstantWithState(source) {
  // 已注入形态：<id>=(()=>{...readFileSync...})()
  const injRe = /(?:^|[;,{}]\s*)([A-Za-z_$][\w$]*)\s*=\s*(\(\(\)\s*=>\s*\{[\s\S]{0,600}?readFileSync[\s\S]{0,600}?\}\)\(\))/gm;
  let m;
  while ((m = injRe.exec(source)) !== null) {
    const start = m.index + m[0].indexOf(m[2]);
    return {
      kind: 'injected',
      id: m[1],
      value: '',
      raw: m[2],
      assignStart: start,
      assignEnd: start + m[2].length,
      isInjected: true,
    };
  }

  const c = findPolicyConstant(source);
  if (!c) return null;
  c.isInjected = false;
  c.raw = source.slice(c.assignStart, c.assignEnd);
  return c;
}

/**
 * 还原 customSystemPrompt 上遗留的读文件注入。
 * 之前尝试过用 customSystemPrompt 注入，但那样会连带跳过 identity / memory /
 * env info / output style 等段落。现在改为只替换安全条款常量，这里负责清理。
 */
function restoreCustomSystemPrompt(source) {
  const key = 'customSystemPrompt:';
  const idx = source.indexOf(key);
  if (idx < 0) return { source, restored: false };
  const rest = source.slice(idx + key.length);
  if (!rest.startsWith('(()=>')) return { source, restored: false };

  // 括号配平：找出这个 IIFE（连同随后的 () 调用）的结束位置。
  // 跳过字符串字面量，避免内部路径里的括号干扰计数。
  let depth = 0;
  let i = 0;
  let inStr = null;
  while (i < rest.length && i < 4000) {
    const c = rest[i];
    if (inStr) {
      if (c === '\\') { i += 2; continue; }
      if (c === inStr) inStr = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { inStr = c; i++; continue; }
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) {
        const after = rest.slice(i + 1);
        if (!after.startsWith('()')) return { source, restored: false };
        const end = idx + key.length + i + 3;
        const restored = source.slice(0, idx + key.length) + 'this.config.systemPrompt' + source.slice(end);
        // 自检：还原后应能再次匹配到原始形态，否则不还原（避免破坏文件）
        const check = restored.slice(idx + key.length);
        if (!check.startsWith('this.config.systemPrompt')) return { source, restored: false };
        return { source: restored, restored: true };
      }
    }
    i++;
  }
  return { source, restored: false };
}

function inject(source, promptText) {
  // 先清理遗留的 customSystemPrompt 注入（那会损失功能段落）
  const cleaned = restoreCustomSystemPrompt(source);
  let base = cleaned.source;
  const didRestore = cleaned.restored;

  // 方案：把「安全条款常量」的值整体替换掉。
  //
  // 为什么不用 customSystemPrompt：引擎在 customSystemPrompt 非空时会整体跳过
  // 身份段（tkn(n)）以及 !i 块里的 memory / env info / output style /
  // context management 等段落，会损失大量正常功能。
  //
  // 直接替换安全条款常量则只动这一处：身份段的其它结构（CLI 前缀、harness
  // 段）全部保留，安全条款被换成我们的内容。
  //
  // 替换成读文件的 IIFE 而非内联文本：改提示词只需编辑 system-prompt.md，
  // 不必重写 15MB 的引擎文件。
  const c = findPolicyConstantWithState(base);
  if (!c) throw new Error('policy constant not found');

  const expression = buildPolicyExpression();
  if (c.isInjected && c.raw === expression && !didRestore) {
    return { patched: base, anchor: 'already-injected', changed: false };
  }

  const patched = base.slice(0, c.assignStart) + expression + base.slice(c.assignEnd);
  return {
    patched,
    anchor: didRestore
      ? 'restored-custom-prompt-and-replaced-policy'
      : c.isInjected
        ? 'refreshed-existing-injection'
        : 'policy-constant-replaced',
    policyVar: c.id,
  };
}

// ---------------------------------------------------------------- 备份 / 原子写

function engineFingerprint(source) {
  return crypto.createHash('sha256').update(source).digest('hex').slice(0, 16);
}

function backupPathFor(enginePath) {
  return enginePath + '.zcode-unlock.bak';
}

function writeBackup(enginePath, original) {
  const bak = backupPathFor(enginePath);
  const stamp = backupPathFor(enginePath) + '.meta';
  const fp = engineFingerprint(original);
  try {
    if (fs.existsSync(bak)) {
      const meta = JSON.parse(fs.readFileSync(stamp, 'utf8'));
      if (meta.fingerprint === fp) return bak; // 同一版本，无需重复备份
    }
  } catch {}
  const tmp = bak + '.tmp';
  fs.writeFileSync(tmp, original, 'utf8');
  fs.renameSync(tmp, bak);
  fs.writeFileSync(stamp, JSON.stringify({ fingerprint: fp, at: new Date().toISOString() }, null, 2), 'utf8');
  return bak;
}

function nodeCheck(filePath) {
  // node --check 对 15MB 级 bundle 会耗尽堆内存，改用 vm.Script 只编译不执行
  try {
    const vm = require('vm');
    new vm.Script(fs.readFileSync(filePath, 'utf8'), { filename: filePath });
    return true;
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

// ---------------------------------------------------------------- 主流程

function applyPatch({ verbose = false } = {}) {
  const engine = findEngine();
  if (!engine) return { ok: false, reason: 'engine_not_found' };

  let original;
  try {
    original = fs.readFileSync(engine, 'utf8');
  } catch (e) {
    return { ok: false, reason: 'engine_unreadable', error: String(e) };
  }

  let promptText;
  try {
    promptText = fs.readFileSync(PROMPT_FILE, 'utf8');
  } catch (e) {
    return { ok: false, reason: 'prompt_missing', error: String(e) };
  }
  if (!promptText.trim()) return { ok: false, reason: 'prompt_empty' };

  let patched, anchor, policyVar;
  try {
    const r = inject(original, promptText);
    patched = r.patched;
    anchor = r.anchor;
    policyVar = r.policyVar;
  } catch (e) {
    return { ok: false, reason: 'inject_failed', error: String(e) };
  }

  if (patched === original) {
    return { ok: true, changed: false, engine, reason: 'no_change' };
  }

  // 写临时文件 → 语法校验 → 原子替换
  // 临时文件必须以 .cjs 结尾，node --check 才能识别为 CommonJS
  const tmp = engine + '.zcode-unlock.tmp.cjs';
  fs.writeFileSync(tmp, patched, 'utf8');
  const check = nodeCheck(tmp);
  if (check !== true) {
    try { fs.unlinkSync(tmp); } catch {}
    return { ok: false, reason: 'syntax_check_failed', error: check.error };
  }

  writeBackup(engine, original);
  try {
    fs.renameSync(tmp, engine);
  } catch (e) {
    // 目标文件被占用（Windows 上常见于引擎正在运行）
    try { fs.unlinkSync(tmp); } catch {}
    return { ok: false, reason: 'replace_failed', error: String(e) };
  }

  const after = findPolicyConstantWithState(patched);
  return {
    ok: true,
    changed: true,
    engine,
    anchor,
    policyVar,
    backup: backupPathFor(engine),
    policyConstant: after ? after.id : null,
    policyIsInjected: after ? after.isInjected : false,
  };
}

function status() {
  const engine = findEngine();
  if (!engine) return { ok: false, reason: 'engine_not_found' };
  const src = fs.readFileSync(engine, 'utf8');
  const c = findPolicyConstantWithState(src);
  return {
    ok: true,
    engine,
    injected: !!(c && c.isInjected),
    policyVar: c ? c.id : null,
    policyPreview: c ? c.value.slice(0, 200) : null,
    policyInjected: c ? c.isInjected : false,
    backup: fs.existsSync(backupPathFor(engine)) ? backupPathFor(engine) : null,
    promptFile: PROMPT_FILE,
    promptBytes: fs.existsSync(PROMPT_FILE) ? fs.statSync(PROMPT_FILE).size : 0,
  };
}

function revert() {
  const engine = findEngine();
  if (!engine) return { ok: false, reason: 'engine_not_found' };
  const bak = backupPathFor(engine);
  if (!fs.existsSync(bak)) return { ok: false, reason: 'no_backup' };
  const orig = fs.readFileSync(bak, 'utf8');
  const tmp = engine + '.zcode-unlock.tmp.cjs';
  fs.writeFileSync(tmp, orig, 'utf8');
  const check = nodeCheck(tmp);
  if (check !== true) {
    try { fs.unlinkSync(tmp); } catch {}
    return { ok: false, reason: 'syntax_check_failed', error: check.error };
  }
  fs.renameSync(tmp, engine);
  return { ok: true, engine, reverted: true };
}

module.exports = { applyPatch, status, revert, findEngine, findSecurityNoticeLiteral, PROMPT_FILE };

if (require.main === module) {
  const cmd = process.argv[2] || 'status';
  let res;
  if (cmd === 'apply') res = applyPatch({ verbose: true });
  else if (cmd === 'revert') res = revert();
  else res = status();
  console.log(JSON.stringify(res, null, 2));
}
