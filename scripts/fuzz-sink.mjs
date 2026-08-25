#!/usr/bin/env node
/**
 * fuzz 沉淀管道（harness 支柱 C 的最后一米）。
 *
 * 随机测试逮到一个输入，如果只是在 CI 日志里红一次，那它的价值就随日志一起过期了。
 * 这个脚本把发现变成**永久回放**：
 *
 *   .local/evidence/fuzz/findings.ndjson   ← 用例失败时自动落下（不入库）
 *              ↓ 按触发路径去重
 *   tests/fuzz/corpus/<目标>.json          ← 每次 npm test 都逐字回放
 *              ↓ 注入类另加一份
 *   tests/adversarial/corpus/<面>.json     ← RV-10：安全修复必附语料
 *
 * 为什么不让用例直接写库：那会让 `npm test` 变成会改仓库的命令，且没人 review 过就
 * 进了库。入库是显式的一步，由人看过 plan 再 `--write`。
 *
 * 用法：
 *   node scripts/fuzz-sink.mjs              # 只看计划（默认，不写任何文件）
 *   node scripts/fuzz-sink.mjs --write      # 落库
 *   node scripts/fuzz-sink.mjs --write --prune   # 落库后清空 findings
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  corpusFile, ID_PREFIX, loadFuzzCorpus, nextFuzzId, TARGETS,
} from '../tests/fuzz/corpus.js';
import { loadCorpus, SURFACES } from '../tests/adversarial/corpus.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const FINDINGS = path.join(ROOT, '.local', 'evidence', 'fuzz', 'findings.ndjson');

/** 面 → adversarial ID 前缀。与既有语料文件里的号段一致，不许另起一套。 */
export const SURFACE_PREFIX = Object.freeze({
  'launch-argv': 'ARGV',
  fingerprint: 'FP',
  http: 'HTTP',
});

/**
 * launch-argv runner 认得的注入点。转写出来的语料必须落在这张表里，否则它在
 * `buildFor` 那儿会直接抛「没有对应的构建调用」——等于入了一条永远空转的语料。
 */
export const KNOWN_ARGV_ENTRIES = Object.freeze([
  'inject.env.value', 'inject.env.key', 'inject.extraArgs', 'workdir', 'patch.remoteName',
  'logName', 'port', 'cleanup.keepNames', 'stop.fingerprint', 'verify.pid', 'logtail.lines',
  'settings.txn', 'settings.baseChecksum', 'ssh.host',
]);

/** @returns {object[]} 坏行跳过：findings 是追加写的，被 Ctrl-C 打断可能留半行 */
export function parseFindings(text) {
  const out = [];
  for (const line of String(text).split('\n')) {
    if (line.trim() === '') continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) out.push(parsed);
    } catch { /* 半行 / 手工乱涂，忽略 */ }
  }
  return out;
}

/**
 * 算出该入库什么。纯函数——判定逻辑要能单测，不能只能靠「跑一遍看看」。
 *
 * @param {object[]} findings
 * @param {{fuzz:Record<string,object[]>, adversarial:Record<string,object[]>}} existing
 * @returns {{fuzz:object[], adversarial:object[], skipped:object[], rejected:object[]}}
 */
export function sinkPlan(findings, existing) {
  const knownSignatures = new Map(
    TARGETS.map((target) => [
      target,
      new Set((existing.fuzz[target] ?? []).map((entry) => entry.signature)),
    ]),
  );
  const nextFuzz = new Map(TARGETS.map((target) => [target, [...(existing.fuzz[target] ?? [])]]));
  const nextAdv = new Map(SURFACES.map((surface) => [surface, [...(existing.adversarial[surface] ?? [])]]));

  const fuzz = [];
  const adversarial = [];
  const skipped = [];
  const rejected = [];

  for (const finding of findings) {
    const target = finding.target;
    if (!TARGETS.includes(target)) {
      rejected.push({ finding, why: `未知目标 ${JSON.stringify(target)}` });
      continue;
    }
    if (typeof finding.signature !== 'string' || finding.signature === '') {
      rejected.push({ finding, why: '缺触发签名，无法去重' });
      continue;
    }
    if (finding.input === undefined) {
      rejected.push({ finding, why: '缺 input，回放不了' });
      continue;
    }
    // 同一个 bug 的一百个输入只留一条：签名相同即视为同一处触发
    if (knownSignatures.get(target).has(finding.signature)) {
      skipped.push({ finding, why: '同签名已在库中' });
      continue;
    }
    knownSignatures.get(target).add(finding.signature);

    const entry = {
      id: nextFuzzId(target, nextFuzz.get(target)),
      target,
      signature: finding.signature,
      input: finding.input,
      origin: originOf(finding),
      note: (finding.message ?? '').split('\n')[0].slice(0, 200),
    };
    nextFuzz.get(target).push(entry);
    fuzz.push({ target, entry });

    const adv = adversarialEntryFor(finding, nextAdv);
    if (adv !== null) {
      if (adv.problem) rejected.push({ finding, why: adv.problem });
      else {
        nextAdv.get(adv.surface).push(adv.entry);
        adversarial.push(adv);
      }
    }
  }

  return {
    fuzz, adversarial, skipped, rejected,
  };
}

function originOf(finding) {
  const how = finding.kind === 'corpus'
    ? `语料 ${finding.ref} 回放`
    : `种子 ${finding.rootSeed}/#${finding.index}（seed=${finding.seed}）`;
  return `fuzz 自动沉淀：${how}，${finding.at ?? '时间未记'}`;
}

/**
 * 注入类发现 → adversarial 语料条目（RV-10：一条安全修复至少一条语料）。
 * @returns {{surface:string, entry:object, problem?:string}|null} 非注入类返回 null
 */
export function adversarialEntryFor(finding, nextAdv) {
  if (finding.class !== 'injection') return null;
  const meta = finding.injection;
  if (meta === null || typeof meta !== 'object') {
    return { surface: 'launch-argv', entry: null, problem: '注入类发现缺 injection 元信息，转写不了' };
  }
  const surface = meta.surface;
  if (!SURFACES.includes(surface)) {
    return { surface: 'launch-argv', entry: null, problem: `未知攻击面 ${JSON.stringify(surface)}` };
  }
  if (surface === 'launch-argv' && !KNOWN_ARGV_ENTRIES.includes(meta.entry)) {
    return { surface, entry: null, problem: `注入点 ${JSON.stringify(meta.entry)} 在 launch-argv runner 里没有构建调用` };
  }
  const canary = typeof meta.canary === 'string' ? meta.canary : null;
  if (canary === null || canary === '' || canary.includes("'")) {
    // 语料的形状校验会拦下这种（含单引号的金丝雀在正文里不逐字出现，追不了），
    // 与其入一条注定判红的语料，不如在这儿说清楚原因
    return { surface, entry: null, problem: `金丝雀 ${JSON.stringify(canary)} 不适合入库（空或含单引号）` };
  }

  return {
    surface,
    entry: {
      id: nextAdversarialId(surface, nextAdv.get(surface)),
      surface,
      entry: meta.entry,
      payload: meta.payload,
      canary,
      expect: { canary: 'single-quoted' },
      origin: originOf(finding),
    },
  };
}

export function nextAdversarialId(surface, entries) {
  const prefix = SURFACE_PREFIX[surface];
  const re = new RegExp(`^AV-${prefix}-(\\d{3})$`, 'u');
  let max = 0;
  for (const entry of entries) {
    const m = re.exec(entry?.id ?? '');
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `AV-${prefix}-${String(max + 1).padStart(3, '0')}`;
}

// ── 输出与落盘 ──────────────────────────────────────────────────────────

export function formatPlan(plan, { findings }) {
  const lines = [];
  lines.push(`\nfuzz 发现 ${findings} 条，去重后待入库 ${plan.fuzz.length} 条`);
  for (const { target, entry } of plan.fuzz) {
    lines.push(`  + ${entry.id}  ${target}`);
    lines.push(`      签名 ${entry.signature}`);
    lines.push(`      输入 ${truncate(JSON.stringify(entry.input), 160)}`);
  }
  if (plan.adversarial.length > 0) {
    lines.push(`\n注入类转写为攻击语料 ${plan.adversarial.length} 条（RV-10）：`);
    for (const { surface, entry } of plan.adversarial) {
      lines.push(`  + ${entry.id}  ${surface} / ${entry.entry}`);
      lines.push(`      载荷 ${truncate(JSON.stringify(entry.payload), 160)}`);
    }
  }
  if (plan.skipped.length > 0) {
    lines.push(`\n跳过 ${plan.skipped.length} 条（同一处触发已有语料，不重复堆积）`);
  }
  if (plan.rejected.length > 0) {
    lines.push(`\n转写不了 ${plan.rejected.length} 条，需要人看一眼：`);
    for (const { finding, why } of plan.rejected) {
      lines.push(`  ! ${finding.target ?? '?'}：${why}`);
    }
  }
  if (plan.fuzz.length === 0 && plan.adversarial.length === 0) {
    lines.push('\n没有新东西要入库。');
  }
  return lines.join('\n');
}

function truncate(text, max) {
  const s = String(text ?? '');
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

function writePlan(plan) {
  const byTarget = new Map();
  for (const { target, entry } of plan.fuzz) {
    if (!byTarget.has(target)) byTarget.set(target, loadFuzzCorpus(target));
    byTarget.get(target).push(entry);
  }
  for (const [target, entries] of byTarget) {
    fs.writeFileSync(corpusFile(target), `${JSON.stringify(entries, null, 2)}\n`);
  }

  const bySurface = new Map();
  for (const { surface, entry } of plan.adversarial) {
    if (!bySurface.has(surface)) bySurface.set(surface, loadCorpus(surface));
    bySurface.get(surface).push(entry);
  }
  for (const [surface, entries] of bySurface) {
    const file = path.join(ROOT, 'tests', 'adversarial', 'corpus', `${surface}.json`);
    fs.writeFileSync(file, `${JSON.stringify(entries, null, 2)}\n`);
  }
  return { targets: [...byTarget.keys()], surfaces: [...bySurface.keys()] };
}

function main(argv) {
  const write = argv.includes('--write');
  const prune = argv.includes('--prune');
  const unknown = argv.filter((a) => !['--write', '--prune'].includes(a));
  if (unknown.length > 0) {
    console.error(`不认识的参数：${unknown.join(' ')}（只支持 --write / --prune）`);
    return 3;
  }

  if (!fs.existsSync(FINDINGS)) {
    console.log(`\n没有 fuzz 发现记录（${path.relative(ROOT, FINDINGS)} 不存在）。`);
    console.log('随机测试失败时才会落下记录；先跑 npm test 或 cron 的长预算轮。');
    return 0;
  }

  const findings = parseFindings(fs.readFileSync(FINDINGS, 'utf8'));
  const existing = {
    fuzz: Object.fromEntries(TARGETS.map((t) => [t, loadFuzzCorpus(t)])),
    adversarial: Object.fromEntries(SURFACES.map((s) => [s, loadCorpus(s)])),
  };
  const plan = sinkPlan(findings, existing);
  console.log(formatPlan(plan, { findings: findings.length }));

  if (!write) {
    if (plan.fuzz.length > 0 || plan.adversarial.length > 0) {
      console.log('\n这是计划，什么都没改。加 --write 落库（记得在 PR 里按 RV-10 说明来历）。');
    }
    return 0;
  }

  const done = writePlan(plan);
  console.log(`\n已写入：${[...done.targets, ...done.surfaces].join('、') || '（无）'}`);
  if (prune) {
    fs.rmSync(FINDINGS);
    console.log(`已清空 ${path.relative(ROOT, FINDINGS)}`);
  }
  console.log('接着跑一遍 npm test：新语料必须能回放（先红后绿的那个「红」现在应该固化了）。');
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}

export { ID_PREFIX };
