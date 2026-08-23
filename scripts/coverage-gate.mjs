#!/usr/bin/env node
/**
 * 覆盖率门槛核对（TST-07 / 14 §6）。
 *
 * 跑一遍全量测试并产出 lcov，再核对总闸与分档门槛：
 *   src/**                行覆盖 ≥ 95%   —— 全仓总闸，按 DA 行数加权
 *   src/lib/**            行覆盖 ≥ 90%   —— 纯函数内核，没有借口
 *   src/*.js              行覆盖 ≥ 75%   —— 模块层，含 IO 与容错分支
 *   src/web/（非 components）≥ 80%   —— DOM-free 判定逻辑
 * `src/web/components/**` 只报告不设卡（它们的把关交给挂载冒烟与人工清单）。
 * branch（BRH/BRF）与 function（FNH/FNF）只作全仓诊断，不参与任一门槛。
 *
 * 用法：npm run coverage:gate
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isMainEntry } from '../src/lib/entry.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const TIERS = Object.freeze([
  { id: 'overall', label: 'src/**（全仓）', min: 95, match: (f) => f.startsWith('src/') },
  { id: 'lib', label: 'src/lib/**', min: 90, match: (f) => f.startsWith('src/lib/') },
  {
    id: 'modules',
    label: 'src/*.js',
    min: 75,
    match: (f) => /^src\/[^/]+\.js$/.test(f),
  },
  {
    id: 'web-logic',
    label: 'src/web/（不含 components）',
    min: 80,
    match: (f) => f.startsWith('src/web/') && !f.startsWith('src/web/components/'),
  },
  {
    id: 'web-components',
    label: 'src/web/components/**',
    min: null, // 只报告：DOM 组件由 tests/web/*mount*.test.js 与人工清单兜底
    match: (f) => f.startsWith('src/web/components/'),
  },
]);

/**
 * 解析 lcov：每个源文件的行命中率，以及可选的 branch/function 诊断计数。
 * @param {string} text
 * @param {string} [root]
 * @returns {Array<{
 *   file:string,
 *   found:number,
 *   hit:number,
 *   pct:number,
 *   branches:{found:number,hit:number}|null,
 *   functions:{found:number,hit:number}|null
 * }>}
 */
export function parseLcov(text, root = process.cwd()) {
  const byFile = new Map();
  let record = null;
  const finishRecord = () => {
    if (!record) return;
    let merged = byFile.get(record.file);
    if (!merged) {
      merged = {
        file: record.file,
        lines: new Map(),
        branchFound: null,
        branchHit: null,
        functionFound: null,
        functionHit: null,
      };
      byFile.set(record.file, merged);
    }
    for (const [lineNumber, isHit] of record.lines) {
      merged.lines.set(lineNumber, (merged.lines.get(lineNumber) ?? false) || isHit);
    }
    merged.branchFound = maxCount(merged.branchFound, record.branchFound);
    merged.branchHit = maxCount(merged.branchHit, record.branchHit);
    merged.functionFound = maxCount(merged.functionFound, record.functionFound);
    merged.functionHit = maxCount(merged.functionHit, record.functionHit);
    record = null;
  };

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('SF:')) {
      record = {
        file: normalizeLcovSource(line.slice(3), root),
        lines: new Map(),
        branchFound: null,
        branchHit: null,
        functionFound: null,
        functionHit: null,
      };
    } else if (line.startsWith('DA:') && record) {
      const [lineNumber, count] = line.slice(3).split(',');
      const numericLine = Number(lineNumber);
      const key = Number.isInteger(numericLine) && numericLine >= 0
        ? String(numericLine)
        : lineNumber;
      record.lines.set(key, (record.lines.get(key) ?? false) || Number(count) > 0);
    } else if (line.startsWith('BRF:') && record) {
      record.branchFound = lcovCount(line.slice(4));
    } else if (line.startsWith('BRH:') && record) {
      record.branchHit = lcovCount(line.slice(4));
    } else if (line.startsWith('FNF:') && record) {
      record.functionFound = lcovCount(line.slice(4));
    } else if (line.startsWith('FNH:') && record) {
      record.functionHit = lcovCount(line.slice(4));
    } else if (line === 'end_of_record' && record) {
      finishRecord();
    }
  }
  return [...byFile.values()].map((file) => {
    const found = file.lines.size;
    const hit = [...file.lines.values()].filter(Boolean).length;
    return {
      file: file.file,
      found,
      hit,
      pct: found === 0 ? 100 : (hit / found) * 100,
      branches: metricPair(file.branchFound, file.branchHit),
      functions: metricPair(file.functionFound, file.functionHit),
    };
  });
}

function lcovCount(raw) {
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function maxCount(current, next) {
  if (next === null) return current;
  return current === null ? next : Math.max(current, next);
}

function metricPair(found, hit) {
  if (found === null && hit === null) return null;
  return { found: found ?? 0, hit: hit ?? 0 };
}

function normalize(file, root) {
  const value = String(file);
  const base = String(root);
  const windowsAbsolute = /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\');
  const windowsRoot = /^[A-Za-z]:[\\/]/.test(base) || base.startsWith('\\\\');
  let relative = value;
  if (windowsAbsolute && windowsRoot) {
    relative = path.win32.relative(base, value);
  } else if (value.startsWith('/') && base.startsWith('/')) {
    relative = path.posix.relative(base.replaceAll('\\', '/'), value.replaceAll('\\', '/'));
  }
  return path.posix.normalize(relative.replaceAll('\\', '/')).replace(/^(?:\.\/)+/, '');
}

function isKnownSourceFile(file, root) {
  if (!file.startsWith('src/') || !file.endsWith('.js')) return false;
  const absolute = path.resolve(root, ...file.split('/'));
  const src = path.resolve(root, 'src');
  const fromSrc = path.relative(src, absolute);
  if (fromSrc === '..' || fromSrc.startsWith(`..${path.sep}`) || path.isAbsolute(fromSrc)) {
    return false;
  }
  try {
    return fs.lstatSync(absolute).isFile();
  } catch {
    return false;
  }
}

function normalizeLcovSource(file, root) {
  const full = normalize(file, root);
  if (isKnownSourceFile(full, root)) return full;
  const suffix = full.search(/[?#]/);
  if (suffix === -1) return full;
  const base = full.slice(0, suffix);
  return isKnownSourceFile(base, root) ? base : full;
}

const COVERAGE_SUPPRESSION = /^(?:node:coverage\s+(?:disable|ignore\s+next(?:\s+\d+)?)|c8\s+ignore\s+(?:next(?:\s+\d+)?|start|stop)|istanbul\s+ignore\s+(?:file|next|if|else))$/i;
const REGEX_PREFIX_KEYWORDS = new Set([
  'await', 'case', 'delete', 'do', 'else', 'instanceof', 'new',
  'return', 'throw', 'typeof', 'void', 'yield',
]);
const FOR_HEADER_OPERATORS = new Set(['in', 'of']);
const IDENTIFIER_START = /^(?:[$_]|\p{ID_Start})$/u;
const IDENTIFIER_CONTINUE = /^(?:[$_\u200C\u200D]|\p{ID_Continue})$/u;

/**
 * 提取真正 JS 注释 token 中的 coverage suppression。扫描器只承担这一个静态护栏：
 * 跳过字符串、template raw（`${}` 内重新按代码扫描）与 regex literal，不冒充通用 parser。
 * @param {string} source
 * @returns {Array<{line:number,directive:string}>}
 */
export function findCoverageSuppressions(source) {
  const text = String(source);
  const found = [];
  const codeFrame = (templateExpression) => ({
    type: 'code',
    templateExpression,
    braces: 0,
    canStartRegex: true,
    afterPropertyAccess: false,
    pendingFor: false,
    parens: [],
  });
  const frames = [codeFrame(false)];
  const top = () => frames[frames.length - 1];
  const codePointAt = (offset) => {
    const value = text.codePointAt(offset);
    return value === undefined ? '' : String.fromCodePoint(value);
  };
  const lineOf = (offset) => {
    let line = 1;
    for (let index = 0; index < offset; index += 1) {
      if (text[index] === '\n') line += 1;
    }
    return line;
  };
  const inspectComment = (start, end) => {
    const raw = text.slice(start, end);
    const directive = raw.trim();
    if (!COVERAGE_SUPPRESSION.test(directive)) return;
    const offset = start + raw.indexOf(directive);
    found.push({ line: lineOf(offset), directive: directive.replace(/\s+/g, ' ') });
  };
  const skipQuoted = (start, quote) => {
    let index = start + 1;
    while (index < text.length) {
      if (text[index] === '\\') {
        index += 2;
        if (text[index - 1] === '\r' && text[index] === '\n') index += 1;
      } else if (text[index] === quote) {
        return index + 1;
      } else if (text[index] === '\n' || text[index] === '\r') {
        return index;
      } else {
        index += 1;
      }
    }
    return index;
  };
  const skipRegex = (start) => {
    let index = start + 1;
    let inClass = false;
    while (index < text.length) {
      const char = text[index];
      if (char === '\\') {
        index += 2;
      } else if (char === '[') {
        inClass = true;
        index += 1;
      } else if (char === ']' && inClass) {
        inClass = false;
        index += 1;
      } else if (char === '/' && !inClass) {
        index += 1;
        while (/[A-Za-z]/.test(text[index] ?? '')) index += 1;
        return index;
      } else if (char === '\n' || char === '\r') {
        return index;
      } else {
        index += 1;
      }
    }
    return index;
  };

  let index = 0;
  while (index < text.length) {
    const frame = top();
    const char = text[index];
    const next = text[index + 1];
    const codePoint = codePointAt(index);

    if (frame.type === 'template') {
      if (char === '\\') {
        index += 2;
      } else if (char === '`') {
        frames.pop();
        index += 1;
      } else if (char === '$' && next === '{') {
        frames.push(codeFrame(true));
        index += 2;
      } else {
        index += 1;
      }
      continue;
    }

    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    if (char === "'" || char === '"') {
      index = skipQuoted(index, char);
      frame.canStartRegex = false;
      frame.afterPropertyAccess = false;
      frame.pendingFor = false;
      continue;
    }
    if (char === '`') {
      frame.canStartRegex = false;
      frame.afterPropertyAccess = false;
      frame.pendingFor = false;
      frames.push({ type: 'template' });
      index += 1;
      continue;
    }
    if (char === '/' && next === '/') {
      const contentStart = index + 2;
      index = text.indexOf('\n', contentStart);
      if (index === -1) index = text.length;
      inspectComment(contentStart, index);
      continue;
    }
    if (char === '/' && next === '*') {
      const contentStart = index + 2;
      const close = text.indexOf('*/', contentStart);
      const contentEnd = close === -1 ? text.length : close;
      inspectComment(contentStart, contentEnd);
      index = close === -1 ? text.length : close + 2;
      continue;
    }
    if (char === '/') {
      if (frame.canStartRegex) {
        index = skipRegex(index);
        frame.canStartRegex = false;
      } else {
        index += 1;
        frame.canStartRegex = true;
      }
      frame.afterPropertyAccess = false;
      frame.pendingFor = false;
      continue;
    }
    if (IDENTIFIER_START.test(codePoint)) {
      const start = index;
      index += codePoint.length;
      while (IDENTIFIER_CONTINUE.test(codePointAt(index))) {
        index += codePointAt(index).length;
      }
      const word = text.slice(start, index);
      const propertyName = frame.afterPropertyAccess;
      const inForHeader = frame.parens.includes('for');
      const precededByExpression = !frame.canStartRegex;
      frame.afterPropertyAccess = false;
      if (!propertyName && word === 'for') {
        frame.pendingFor = true;
        frame.canStartRegex = true;
      } else if (!propertyName && frame.pendingFor && word === 'await') {
        frame.canStartRegex = true;
      } else {
        frame.pendingFor = false;
        frame.canStartRegex = !propertyName && (
          REGEX_PREFIX_KEYWORDS.has(word)
          || (inForHeader && precededByExpression && FOR_HEADER_OPERATORS.has(word))
        );
      }
      continue;
    }
    if (/[0-9]/.test(char)) {
      index += 1;
      while (/[A-Za-z0-9_.]/.test(text[index] ?? '')) index += 1;
      frame.canStartRegex = false;
      frame.afterPropertyAccess = false;
      frame.pendingFor = false;
      continue;
    }
    if (char === '(') {
      frame.parens.push(frame.pendingFor ? 'for' : 'normal');
      frame.canStartRegex = true;
      frame.afterPropertyAccess = false;
      frame.pendingFor = false;
      index += 1;
      continue;
    }
    if (char === ')') {
      frame.parens.pop();
      frame.canStartRegex = false;
      frame.afterPropertyAccess = false;
      frame.pendingFor = false;
      index += 1;
      continue;
    }
    if (char === '.' && next === '.' && text[index + 2] === '.') {
      frame.canStartRegex = true;
      frame.afterPropertyAccess = false;
      frame.pendingFor = false;
      index += 3;
      continue;
    }
    if (char === '.' && /[0-9]/.test(next ?? '')) {
      index += 2;
      while (/[0-9_]/.test(text[index] ?? '')) index += 1;
      frame.canStartRegex = false;
      frame.afterPropertyAccess = false;
      frame.pendingFor = false;
      continue;
    }
    if (char === '.' || (
      char === '?' && next === '.' && !/[0-9]/.test(text[index + 2] ?? '')
    )) {
      frame.canStartRegex = false;
      frame.afterPropertyAccess = true;
      frame.pendingFor = false;
      index += char === '.' ? 1 : 2;
      continue;
    }
    if (frame.templateExpression && char === '}') {
      if (frame.braces === 0) {
        frames.pop();
      } else {
        frame.braces -= 1;
        frame.canStartRegex = false;
        frame.afterPropertyAccess = false;
        frame.pendingFor = false;
      }
      index += 1;
      continue;
    }
    if (char === '{') {
      if (frame.templateExpression) frame.braces += 1;
      frame.canStartRegex = true;
      frame.afterPropertyAccess = false;
      frame.pendingFor = false;
      index += 1;
      continue;
    }
    if (char === ']' || char === '}') {
      frame.canStartRegex = false;
      frame.afterPropertyAccess = false;
      frame.pendingFor = false;
      index += 1;
      continue;
    }
    if ((char === '+' || char === '-') && next === char) {
      frame.canStartRegex = false;
      frame.afterPropertyAccess = false;
      frame.pendingFor = false;
      index += 2;
      continue;
    }
    frame.canStartRegex = true;
    frame.afterPropertyAccess = false;
    frame.pendingFor = false;
    index += 1;
  }
  return found;
}

/**
 * 扫描仓库 src/ 下全部真实 .js 文件。src 树内任何软链都 fail-closed：
 * 不解析目标，避免仓库外目标与平台差异，也不让未测源码借软链绕过总闸。
 * @param {string} root
 * @returns {string[]} repo-relative POSIX 路径，稳定排序
 */
export function sourceJsFiles(root = process.cwd()) {
  const out = [];
  const rejectSymlink = (full) => {
    const relative = normalize(full, root);
    const error = new Error(
      `覆盖率源码扫描拒绝软链 ${relative}：src 树内软链可能指向仓库外或让未测源码绕过覆盖率总闸`,
    );
    error.code = 'COVERAGE_SOURCE_SYMLINK';
    throw error;
  };
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) rejectSymlink(full);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.js')) out.push(normalize(full, root));
    }
  };
  const src = path.join(root, 'src');
  if (fs.lstatSync(src).isSymbolicLink()) rejectSymlink(src);
  walk(src);

  const files = out.sort();
  const suppressions = [];
  for (const file of files) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    for (const match of findCoverageSuppressions(source)) {
      suppressions.push(`${file}:${match.line} ${match.directive}`);
    }
  }
  if (suppressions.length > 0) {
    const error = new Error(
      `src/**/*.js 不许使用 coverage suppression pragma（会缩小覆盖率分母）：\n  ${suppressions.join('\n  ')}`,
    );
    error.code = 'COVERAGE_SUPPRESSION_PRAGMA';
    throw error;
  }
  return files;
}

/**
 * 找出磁盘源码集中没有 lcov 记录的文件；不猜这些文件有多少可执行行。
 * @param {Array<{file:string}>} files
 * @param {string} root
 */
export function missingSourceFiles(files, root = process.cwd()) {
  const covered = new Set(files.map((file) => normalize(file.file, root)));
  return sourceJsFiles(root).filter((file) => !covered.has(file));
}

/** 逐档汇总（档内按行数加权，避免小文件把大文件的窟窿盖住）。 */
export function evaluateTiers(files, tiers = TIERS) {
  return tiers.map((tier) => {
    const members = files.filter((f) => tier.match(f.file));
    const found = members.reduce((a, f) => a + f.found, 0);
    const hit = members.reduce((a, f) => a + f.hit, 0);
    // 分档可以没有成员；总闸没有任何 DA 数据则不能自称达标。
    const pct = found === 0 ? (tier.id === 'overall' ? 0 : 100) : (hit / found) * 100;
    const worst = [...members].sort((a, b) => a.pct - b.pct).slice(0, 3);
    return {
      ...tier,
      files: members.length,
      found,
      hit,
      pct,
      worst,
      ok: tier.min === null || ((tier.id !== 'overall' || found > 0) && pct >= tier.min),
    };
  });
}

/**
 * 主流程判定顺序：测试退出码 → 空 lcov → 覆盖率门槛与缺失源码。
 * 后两项同属 coverage 阶段，均须纳入最终退出判据。
 */
export function coverageVerdict({
  testExit, files, tiers = evaluateTiers(files), missing = [],
}) {
  const failed = tiers.filter((tier) => !tier.ok);
  if (testExit !== 0) {
    return {
      ok: false, exitCode: testExit, phase: 'tests', failed, missing,
    };
  }
  if (files.length === 0) {
    return {
      ok: false, exitCode: 1, phase: 'empty-lcov', failed, missing,
    };
  }
  const ok = failed.length === 0 && missing.length === 0;
  return {
    ok, exitCode: ok ? 0 : 1, phase: 'coverage', failed, missing,
  };
}

/**
 * 独立汇总全仓 branch/function 诊断；缺指标的文件不伪造分母。
 * @param {ReturnType<typeof parseLcov>} files
 * @param {(file:string) => boolean} [match]
 */
export function aggregateDiagnostics(files, match = TIERS[0].match) {
  const members = files.filter((f) => match(f.file));
  const sum = (key) => members.reduce((metric, file) => {
    if (file[key] === null || file[key] === undefined) return metric;
    return {
      found: metric.found + file[key].found,
      hit: metric.hit + file[key].hit,
      files: metric.files + 1,
    };
  }, { found: 0, hit: 0, files: 0 });
  return {
    files: members.length,
    branches: sum('branches'),
    functions: sum('functions'),
  };
}

export function formatReport(tiers, diagnostics = null) {
  const lines = [];
  for (const tier of tiers) {
    const gate = tier.min === null ? '仅报告' : `门槛 ${tier.min}%`;
    const mark = tier.min === null ? '·' : (tier.ok ? '✔' : '✘');
    lines.push(`${mark} ${tier.label.padEnd(26)} ${tier.pct.toFixed(2).padStart(6)}%  ${gate}（${tier.files} 个文件；${tier.hit}/${tier.found} 行）`);
    for (const f of tier.worst) {
      if (tier.min !== null && f.pct >= tier.min) continue;
      lines.push(`    最低：${f.file} ${f.pct.toFixed(2)}%（${f.hit}/${f.found} 行）`);
    }
  }
  if (diagnostics) {
    const metric = (name, counts) => {
      if (counts.files === 0) return `${name} 无记录`;
      const partial = counts.files < diagnostics.files
        ? `（${counts.files}/${diagnostics.files} 个文件有记录）`
        : '';
      return `${name} ${counts.hit}/${counts.found}${partial}`;
    };
    lines.push(`· 全仓诊断（不设门槛）  ${metric('branch BRH/BRF', diagnostics.branches)}；${metric('function FNH/FNF', diagnostics.functions)}`);
  }
  return lines.join('\n');
}

// ── 点名：声明了多少用例，就该跑了多少 ────────────────────────────────────

/**
 * 顶格声明的用例数。缩进的是 `t.test` 子用例（由父用例负责），注释与字符串里的不算。
 * @param {string} source
 * @returns {number}
 */
export function countDeclaredTests(source) {
  return (source.match(/^test(?:\.skip|\.todo|\.only)?\(/gm) ?? []).length;
}

/**
 * 从 TAP 里读出总数与逐文件实跑数。多文件跑时每个文件是一层 subtest，
 * 里面的用例缩进 4 格。
 * @param {string} tap
 * @returns {{total:number|null, perFile:Record<string,number>}}
 */
export function parseTapCensus(tap) {
  const perFile = {};
  let total = null;
  let current = null;
  for (const line of tap.split('\n')) {
    const file = /^# Subtest: (tests\/.*\.test\.js)$/.exec(line);
    if (file) {
      current = file[1];
      perFile[current] ??= 0;
      continue;
    }
    const total_ = /^# tests (\d+)$/.exec(line);
    if (total_) {
      total = Number(total_[1]);
      continue;
    }
    if (current && /^ {4}(?:not )?ok \d+ - /.test(line)) perFile[current] += 1;
  }
  return { total, perFile };
}

/**
 * 逐文件对账。少跑的都要点名——一个用例把自己的进程弄死（自杀式 SIGTERM、
 * process.exit）时，`node --test` 会把这个文件报成通过，后面的用例静静地消失。
 * @param {Record<string,number>} declared
 * @param {Record<string,number>} ran
 * @returns {Array<{file:string, declared:number, ran:number}>}
 */
export function shortfall(declared, ran) {
  const gaps = [];
  for (const [file, n] of Object.entries(declared)) {
    const actual = ran[file] ?? 0;
    if (actual < n) gaps.push({ file, declared: n, ran: actual });
  }
  return gaps;
}

/**
 * 逐文件复跑一遍，把短的那个点出来。TAP 里没有文件归属（同一批用例是平铺的），
 * 所以只能这么定位——只在总数已经对不上、也就是已经红了的那条路上花这份时间。
 * @param {Record<string,number>} declared
 * @returns {Promise<Array<{file:string, declared:number, ran:number}>>}
 */
async function locateShortfall(declared) {
  const gaps = [];
  for (const [file, n] of Object.entries(declared)) {
    // eslint-disable-next-line no-await-in-loop -- 逐个文件跑，并发只会互相抢端口
    const ran = await countRanIn(file);
    if (ran < n) gaps.push({ file, declared: n, ran });
  }
  return gaps;
}

function countRanIn(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--test', '--test-reporter=tap', file], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c) => { out += c; });
    child.on('error', () => resolve(0));
    child.on('close', () => resolve(parseTapCensus(out).total ?? 0));
  });
}

/** 静态扫一遍：每个用例文件顶格声明了几个用例。 */
function declaredCensus(root = process.cwd()) {
  const out = {};
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (ent.name.endsWith('.test.js')) {
        const rel = path.relative(root, full).split(path.sep).join('/');
        out[rel] = countDeclaredTests(fs.readFileSync(full, 'utf8'));
      }
    }
  };
  walk(path.join(root, 'tests'));
  return out;
}

async function runTestsWithCoverage(lcovPath, tapPath) {
  const args = [
    '--test',
    '--experimental-test-coverage',
    '--test-coverage-include=src/**',
    '--test-reporter=spec',
    '--test-reporter-destination=stdout',
    '--test-reporter=lcov',
    `--test-reporter-destination=${lcovPath}`,
    '--test-reporter=tap',
    `--test-reporter-destination=${tapPath}`,
    'tests/**/*.test.js',
  ];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'inherit', 'inherit'] });
    child.on('close', (code) => resolve(code ?? 1));
  });
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-cov-'));
  const lcovPath = path.join(tmp, 'lcov.info');
  const tapPath = path.join(tmp, 'run.tap');
  let testExit;
  let files;
  let census;
  try {
    testExit = await runTestsWithCoverage(lcovPath, tapPath);
    files = parseLcov(fs.readFileSync(lcovPath, 'utf8'), ROOT);
    census = parseTapCensus(fs.readFileSync(tapPath, 'utf8'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  const declared = declaredCensus();
  const declaredTotal = Object.values(declared).reduce((a, b) => a + b, 0);
  if (census.total !== null && census.total < declaredTotal) {
    process.stdout.write(`\n用例点名不齐：声明 ${declaredTotal} 个，实跑 ${census.total} 个。`
      + '多半是某个用例把自己的进程弄死了（自杀式 SIGTERM、process.exit）——'
      + '`node --test` 会把这种半途而废的文件报成通过，后面的用例静静消失。\n正在逐文件定位……\n');
    // TAP 是不是带文件归属，取决于 node 的隔离方式；平铺时 perFile 是空的，只能复跑定位
    const located = Object.keys(census.perFile).length > 0
      ? shortfall(declared, census.perFile)
      : await locateShortfall(declared);
    for (const g of located) process.stdout.write(`  ${g.file}：声明 ${g.declared}，实跑 ${g.ran}\n`);
    if (located.length === 0) process.stdout.write('  逐文件复跑时都够数：大概率是跨文件互相干扰，按上面的总数差自己找\n');
    process.exitCode = 1;
    return;
  }

  const tiers = evaluateTiers(files);
  const diagnostics = aggregateDiagnostics(files);
  const preliminary = coverageVerdict({
    testExit, files, tiers, missing: [],
  });
  process.stdout.write(`\n覆盖率门槛（总闸 + 分档；14 §6）：\n${formatReport(tiers, diagnostics)}\n`);

  if (preliminary.phase === 'tests') {
    process.stdout.write('\n测试未全绿，覆盖率门槛不作为结论。\n');
    process.exitCode = preliminary.exitCode;
    return;
  }
  // 空分档不该判红，但整份 lcov 都是空的只有一种可能：覆盖率根本没采到。
  // 总闸在纯判定层也会红；这里另给一句直接可查的失败原因。
  if (preliminary.phase === 'empty-lcov') {
    process.stdout.write('\nlcov 里一条记录都没有：覆盖率没采到，门槛结论不成立。\n');
    process.exitCode = preliminary.exitCode;
    return;
  }
  let missing;
  try {
    missing = missingSourceFiles(files, ROOT);
  } catch (error) {
    if (!['COVERAGE_SOURCE_SYMLINK', 'COVERAGE_SUPPRESSION_PRAGMA'].includes(error?.code)) {
      throw error;
    }
    process.stdout.write(`\n覆盖率源码扫描失败：${error.message}\n`);
    process.exitCode = 1;
    return;
  }
  const verdict = coverageVerdict({
    testExit, files, tiers, missing,
  });
  if (verdict.failed.length > 0) {
    process.stdout.write(`\n未达门槛：${verdict.failed.map((tier) => tier.label).join('、')}\n`);
  }
  if (verdict.missing.length > 0) {
    process.stdout.write('\nlcov 缺少以下 src/**/*.js 源码记录：\n');
    for (const file of verdict.missing) process.stdout.write(`  - ${file}\n`);
  }
  if (!verdict.ok) {
    process.exitCode = verdict.exitCode;
    return;
  }
  process.stdout.write('\n源码记录齐全，总闸与分档门槛全部达标（branch/function 仅诊断）。\n');
}

if (isMainEntry(import.meta.url)) await main();
