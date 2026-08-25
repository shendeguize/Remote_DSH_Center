#!/usr/bin/env node
/**
 * 墙钟基线闸（harness 支柱 A 的软闸）。
 *
 * 硬闸在 `tests/perf/invariants.test.js`——那边只量与机器快慢无关的**计数**，
 * 零 flaky，可以毫不含糊地判红。这一关量的是**墙钟**，所以从判据到默认严格度都不同：
 *
 *   每场景跑 k=5 次取**中位数**（掐掉最慢那次的抖动），与 tests/perf/BASELINE.json
 *   比对，超出 ×2.5 宽容带才算退化。宽容带这么松是有意的：CI 的共享 runner 与本机
 *   差三倍不稀奇，判据紧一点就会天天假红，而假红的闸门等于没有闸门。
 *
 * 三态：
 *   （默认）check   超带即退 1。本机与 cron 用这个。
 *   --advisory      只打印，永远退 0。PR CI 用这个（机器异构，见设计 §8 风险 R2）。
 *   --record        重录基线并写回 BASELINE.json。改动要显式进 review 并说明理由（RV-10）。
 *
 * 每次运行的原始数据落 `.local/evidence/perf/<时间戳>.json`（不入库），供翻趋势。
 *
 * 用法：
 *   npm run perf:gate
 *   npm run perf:gate -- --advisory
 *   npm run perf:gate -- --record
 *   npm run perf:gate -- --only probe-fanout,proto-build -k 3
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isMainEntry } from '../src/lib/entry.js';
import { SCENARIOS } from '../tests/perf/scenarios.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const BASELINE_FILE = 'tests/perf/BASELINE.json';
export const EVIDENCE_DIR = '.local/evidence/perf';

/** 宽容带：中位数超过基线这么多倍才算退化。 */
export const TOLERANCE = 2.5;
/** 每场景重复次数（取中位数）。 */
export const REPEATS = 5;
/**
 * 低于这个毫秒数的场景不判红：几毫秒的量测里，GC 停顿一次就足以翻三倍，
 * 判它等于给自己找假红。仍然记录，仍然进证据文件。
 */
export const NOISE_FLOOR_MS = 5;

export function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * 纯判定：本次测量 × 基线 → 结论。主流程只负责跑场景与打印。
 * @param {Record<string, {ms:number, samples:number[], kind:string}>} measured
 * @param {Record<string, {ms:number}>} baseline
 * @param {{tolerance?:number, noiseFloorMs?:number}} [opts]
 */
export function perfVerdict(measured, baseline, { tolerance = TOLERANCE, noiseFloorMs = NOISE_FLOOR_MS } = {}) {
  const rows = [];
  for (const [id, m] of Object.entries(measured)) {
    const base = baseline[id]?.ms ?? null;
    const ratio = base === null || base === 0 ? null : m.ms / base;
    const belowFloor = base !== null && base < noiseFloorMs && m.ms < noiseFloorMs;
    const regressed = ratio !== null && ratio > tolerance && !belowFloor;
    rows.push({
      id, kind: m.kind, ms: m.ms, base, ratio, regressed, missing: base === null, belowFloor,
    });
  }
  rows.sort((a, b) => a.id.localeCompare(b.id));
  const stale = Object.keys(baseline).filter((id) => !(id in measured)).sort();
  const regressions = rows.filter((r) => r.regressed);
  const missing = rows.filter((r) => r.missing);
  return {
    rows,
    regressions,
    missing,
    stale,
    tolerance,
    ok: regressions.length === 0 && missing.length === 0 && stale.length === 0,
  };
}

const fmt = (ms) => (ms >= 100 ? `${ms.toFixed(0)}ms` : `${ms.toFixed(1)}ms`);

export function formatVerdict(verdict, { advisory = false } = {}) {
  const lines = [];
  const width = Math.max(...verdict.rows.map((r) => r.id.length), 4);
  for (const row of verdict.rows) {
    const mark = row.regressed ? '✘' : (row.missing ? '?' : '✔');
    const against = row.base === null
      ? '基线里没有它（新场景：跑一次 --record 收进去）'
      : `基线 ${fmt(row.base)} ×${row.ratio.toFixed(2)}${row.belowFloor ? '（都在噪声地板下，不判）' : ''}`;
    lines.push(`${mark} ${row.id.padEnd(width)} ${fmt(row.ms).padStart(8)}  ${against}`);
  }
  for (const id of verdict.stale) {
    lines.push(`✘ ${id.padEnd(width)} ${'—'.padStart(8)}  基线里有、场景表里没有（场景删了就 --record 一次）`);
  }
  if (verdict.ok) {
    lines.push(`\n✔ 全部在基线 ×${verdict.tolerance} 宽容带内。`);
  } else if (advisory) {
    lines.push(`\n· 有超带项，但 --advisory 只报不挡（机器异构，PR 上不作结论）。`);
  } else {
    lines.push(`\n✘ 墙钟退化：超出基线 ×${verdict.tolerance} 宽容带。`
      + '\n  先确认是真退化还是本机在忙（跑第二遍看是否稳定重现）；'
      + '\n  确属预期变化就 npm run perf:gate -- --record，并在 PR 里写清为什么（RV-10）。');
  }
  return lines.join('\n');
}

// ── 测量 ─────────────────────────────────────────────────────────────────

async function measure(scenario, repeats) {
  const samples = [];
  // 先空跑一次不计数：第一次跑要付 JIT 编译、模块首次求值、页表预热的钱，
  // 那笔钱与「代码退化了没有」无关，却足以让微基准的比值翻好几倍。
  let meta = await scenario.run();
  for (let i = 0; i < repeats; i += 1) {
    const started = performance.now();
    // eslint-disable-next-line no-await-in-loop -- 就是要一次一次地量，并发会互相污染
    meta = await scenario.run();
    samples.push(performance.now() - started);
  }
  return {
    kind: scenario.kind,
    ms: Number(median(samples).toFixed(3)),
    samples: samples.map((s) => Number(s.toFixed(3))),
    meta,
  };
}

function readBaseline() {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(ROOT, ...BASELINE_FILE.split('/')), 'utf8'));
    return parsed.scenarios ?? {};
  } catch {
    return {};
  }
}

function writeBaseline(measured) {
  const scenarios = {};
  for (const id of Object.keys(measured).sort()) {
    scenarios[id] = { ms: measured[id].ms, kind: measured[id].kind };
  }
  const body = {
    note: '墙钟基线（scripts/perf-gate.mjs 生成）。改动须在 PR 里说明理由，见 CONTRIBUTING RV-10。',
    tolerance: TOLERANCE,
    repeats: REPEATS,
    recordedOn: `${process.platform}/${process.arch} node ${process.versions.node}`,
    scenarios,
  };
  fs.writeFileSync(path.join(ROOT, ...BASELINE_FILE.split('/')), `${JSON.stringify(body, null, 2)}\n`);
}

function writeEvidence(measured) {
  const dir = path.join(ROOT, ...EVIDENCE_DIR.split('/'));
  try {
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replaceAll(/[:.]/gu, '-');
    fs.writeFileSync(path.join(dir, `${stamp}.json`), `${JSON.stringify({
      at: new Date().toISOString(),
      host: `${process.platform}/${process.arch} node ${process.versions.node}`,
      measured,
    }, null, 2)}\n`);
  } catch {
    // 证据落不下来不该让闸门判红：它是给人翻趋势的，不是判据
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const flag = (name) => argv.includes(`--${name}`);
  const opt = (name) => {
    const i = argv.indexOf(name);
    return i === -1 ? null : argv[i + 1];
  };

  const only = opt('--only')?.split(',').map((s) => s.trim()).filter(Boolean) ?? null;
  const repeats = Number(opt('-k') ?? opt('--repeats') ?? REPEATS);
  if (!Number.isInteger(repeats) || repeats < 1) {
    process.stderr.write('-k 要是 ≥1 的整数\n');
    process.exitCode = 3;
    return;
  }
  const scenarios = only
    ? SCENARIOS.filter((s) => only.includes(s.id))
    : [...SCENARIOS];
  if (scenarios.length === 0) {
    process.stderr.write(`--only 没匹配到场景（可选：${SCENARIOS.map((s) => s.id).join(', ')}）\n`);
    process.exitCode = 3;
    return;
  }

  process.stdout.write(`\n墙钟基线：${scenarios.length} 个场景 × k=${repeats}，取中位数\n`);
  const measured = {};
  for (const scenario of scenarios) {
    process.stdout.write(`  · ${scenario.id}（${scenario.label}）…`);
    // eslint-disable-next-line no-await-in-loop -- 场景之间必须串行，否则量的是互相打扰
    measured[scenario.id] = await measure(scenario, repeats);
    process.stdout.write(` ${fmt(measured[scenario.id].ms)}\n`);
  }
  writeEvidence(measured);

  if (flag('record')) {
    if (only) {
      process.stderr.write('--record 不接受 --only：只录一部分会把其余场景从基线里抹掉\n');
      process.exitCode = 3;
      return;
    }
    writeBaseline(measured);
    process.stdout.write(`\n已重录 ${BASELINE_FILE}（记得在 PR 里说明为什么要动基线）。\n`);
    return;
  }

  const advisory = flag('advisory');
  const verdict = perfVerdict(measured, readBaseline());
  process.stdout.write(`\n${formatVerdict(verdict, { advisory })}\n`);
  if (!verdict.ok && !advisory) process.exitCode = 1;
}

if (isMainEntry(import.meta.url)) await main();
