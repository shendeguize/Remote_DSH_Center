#!/usr/bin/env node
/**
 * 覆盖率门槛核对（TST-07 / 14 §6）。
 *
 * 跑一遍全量测试并产出 lcov，再按三档门槛逐档核对：
 *   src/lib/**            行覆盖 ≥ 90%   —— 纯函数内核，没有借口
 *   src/*.js              行覆盖 ≥ 75%   —— 模块层，含 IO 与容错分支
 *   src/web/（非 components）≥ 80%   —— DOM-free 判定逻辑
 * `src/web/components/**` 只报告不设卡（它们的把关交给挂载冒烟与人工清单）。
 *
 * 用法：npm run coverage:gate
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { isMainEntry } from '../src/lib/entry.js';

export const TIERS = Object.freeze([
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
 * 解析 lcov：每个源文件的行命中率。
 * @param {string} text
 * @returns {Array<{file:string, found:number, hit:number, pct:number}>}
 */
export function parseLcov(text) {
  const out = [];
  let file = null;
  let found = 0;
  let hit = 0;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('SF:')) {
      file = line.slice(3);
      found = 0;
      hit = 0;
    } else if (line.startsWith('DA:')) {
      const [, count] = line.slice(3).split(',');
      found += 1;
      if (Number(count) > 0) hit += 1;
    } else if (line === 'end_of_record' && file) {
      out.push({ file: normalize(file), found, hit, pct: found === 0 ? 100 : (hit / found) * 100 });
      file = null;
    }
  }
  return out;
}

function normalize(file) {
  const rel = path.isAbsolute(file) ? path.relative(process.cwd(), file) : file;
  return rel.split(path.sep).join('/');
}

/** 逐档汇总（档内按行数加权，避免小文件把大文件的窟窿盖住）。 */
export function evaluateTiers(files, tiers = TIERS) {
  return tiers.map((tier) => {
    const members = files.filter((f) => tier.match(f.file));
    const found = members.reduce((a, f) => a + f.found, 0);
    const hit = members.reduce((a, f) => a + f.hit, 0);
    const pct = found === 0 ? 100 : (hit / found) * 100;
    const worst = [...members].sort((a, b) => a.pct - b.pct).slice(0, 3);
    return {
      ...tier,
      files: members.length,
      pct,
      worst,
      ok: tier.min === null || pct >= tier.min,
    };
  });
}

export function formatReport(tiers) {
  const lines = [];
  for (const tier of tiers) {
    const gate = tier.min === null ? '仅报告' : `门槛 ${tier.min}%`;
    const mark = tier.min === null ? '·' : (tier.ok ? '✔' : '✘');
    lines.push(`${mark} ${tier.label.padEnd(26)} ${tier.pct.toFixed(2).padStart(6)}%  ${gate}（${tier.files} 个文件）`);
    for (const f of tier.worst) {
      if (tier.min !== null && f.pct >= tier.min) continue;
      lines.push(`    最低：${f.file} ${f.pct.toFixed(2)}%（${f.hit}/${f.found} 行）`);
    }
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
    files = parseLcov(fs.readFileSync(lcovPath, 'utf8'));
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
  process.stdout.write(`\n覆盖率门槛（14 §6）：\n${formatReport(tiers)}\n`);

  const failed = tiers.filter((t) => !t.ok);
  if (testExit !== 0) {
    process.stdout.write('\n测试未全绿，覆盖率门槛不作为结论。\n');
    process.exitCode = testExit;
    return;
  }
  // 空档按 100% 算（档内没文件时不该判红），但整份 lcov 都是空的只有一种可能：
  // 覆盖率根本没采到。此时「三档达标」是假绿，闸门必须自己先红。
  if (files.length === 0) {
    process.stdout.write('\nlcov 里一条记录都没有：覆盖率没采到，门槛结论不成立。\n');
    process.exitCode = 1;
    return;
  }
  if (failed.length > 0) {
    process.stdout.write(`\n未达门槛：${failed.map((t) => t.label).join('、')}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write('\n三档门槛全部达标。\n');
}

if (isMainEntry(import.meta.url)) await main();
