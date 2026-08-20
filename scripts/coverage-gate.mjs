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

async function runTestsWithCoverage(lcovPath) {
  const args = [
    '--test',
    '--experimental-test-coverage',
    '--test-coverage-include=src/**',
    '--test-reporter=spec',
    '--test-reporter-destination=stdout',
    '--test-reporter=lcov',
    `--test-reporter-destination=${lcovPath}`,
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
  let testExit;
  let files;
  try {
    testExit = await runTestsWithCoverage(lcovPath);
    files = parseLcov(fs.readFileSync(lcovPath, 'utf8'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
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
