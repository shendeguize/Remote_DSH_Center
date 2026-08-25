#!/usr/bin/env node
/**
 * 变异测试闸门（harness 支柱 B：测试自身的可靠性）。
 *
 * 覆盖率回答「这行跑过吗」，变异测试回答**「这行的结果被断言过吗」**。两者差得很远：
 * 一个被跑了一百次却从没被检查过结果的分支，覆盖率是 100%，而把它改坏之后测试
 * 依然全绿——那条测试其实什么都没在保护。本闸门就是把这种「假绿」逐条揪出来。
 *
 * 做法：把产品代码按白名单算子改坏一处（`===`→`!==`、边界 ±1、删掉守卫子句……），
 * 跑相关测试，看会不会红。
 *   红了 = 「杀死」   —— 测试确实在盯着那处逻辑
 *   绿着 = 「幸存」   —— 那处逻辑没有任何断言在保护，或者这是个等价变异
 *
 * 幸存者不全是坏事（等价变异杀不掉是应该的），所以基线是
 * `tests/mutation/ALLOWED_SURVIVORS.json`：**逐条写清为什么杀不掉**。
 * 新出现的幸存者判红；已登记的幸存者被杀掉了也要报（该把那条豁免删了）。
 *
 * 分档（表驱动，见 TARGETS）：
 *   lib     `src/lib/**`   设卡：kill 率 ≥85% 且无新幸存者
 *   modules `src/*.js`     只报告（预算验证过再提为硬闸）
 *   web / plugin           预留插槽，尚未启用
 *
 * 两阶段跑测：先跑**直接**测那个文件的用例（多数变异体在这儿就死了，快），
 * 只有活下来的才补跑**依赖闭包**里的其余用例确认（慢，但只对少数派花这份钱）。
 * 这么做既不虚报幸存者，也不必每个变异体都跑全量。
 *
 * 安全性：全部变异都发生在临时沙盒（整仓副本）里，工作区一个字节都不动。
 *
 * 用法：
 *   node scripts/mutation-gate.mjs                       # 全部启用的档
 *   node scripts/mutation-gate.mjs --tier lib            # 只跑 lib 档
 *   node scripts/mutation-gate.mjs --only shq --list     # 只看会生成哪些变异体
 *   node scripts/mutation-gate.mjs --budget 1500         # 时间盒（秒），cron 用
 *   node scripts/mutation-gate.mjs --advisory            # 只报告，不判红
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { isMainEntry } from '../src/lib/entry.js';
import { DEFAULT_OPERATORS, OPERATORS, applyMutant, enumerateMutants } from './lib/mutants.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const ALLOWED_FILE = 'tests/mutation/ALLOWED_SURVIVORS.json';
export const EVIDENCE_DIR = '.local/evidence/mutation';

/** 沙盒不必复制的东西。`.local` 与 `plugin/node_modules` 是大头（各上百 MB）。 */
const SANDBOX_SKIP = new Set(['.git', 'node_modules', '.local', '_site', 'coverage']);

/**
 * 确认阶段每批跑几个用例文件。
 *
 * 为什么不一次跑完整个闭包：闭包动辄三四十个文件（底层件如 `errors.js` 几乎等于全量），
 * 一个变异体付一次全量的钱，整档就跑不完了。逐批跑、一杀就停之后，绝大多数「其实
 * 别处测到了」的变异体在第一两批就死了，只有真幸存者才付满额。
 */
const CONFIRM_BATCH = 4;

/**
 * 靶标分档表。加一档只需在这里加一行——「拓展坞」的意思是插槽先留好，
 * 等预算与 kill 率都验证过了再把 `enabled` / `enforce` 打开，而不是临时改代码结构。
 */
export const TARGETS = Object.freeze([
  {
    id: 'lib',
    label: 'src/lib/**',
    enabled: true,
    enforce: true,
    minKill: 85,
    match: (f) => f.startsWith('src/lib/'),
  },
  {
    id: 'modules',
    label: 'src/*.js',
    enabled: true,
    enforce: false,
    minKill: null,
    match: (f) => /^src\/[^/]+\.js$/u.test(f),
    why: '模块层含大量 IO 与容错分支，先跑够几轮 cron 摸清预算与噪声，再提为硬闸',
  },
  {
    id: 'web',
    label: 'src/web/（不含 components）',
    enabled: false,
    enforce: false,
    minKill: null,
    match: (f) => f.startsWith('src/web/') && !f.startsWith('src/web/components/'),
    why: '前端判定逻辑要先有稳定的「文件→用例」映射（挂载测试是按组件而非按模块组织的）',
  },
  {
    id: 'plugin',
    label: 'plugin/src/**',
    enabled: false,
    enforce: false,
    minKill: null,
    match: (f) => f.startsWith('plugin/src/'),
    why: 'plugin/ 是独立 npm 包，有自己的 verify；要接进来得先让沙盒复制它的 node_modules',
  },
]);

// ── 纯判定层（可单测，不碰磁盘） ──────────────────────────────────────────

/**
 * @typedef {object} MutantResult
 * @property {string} id
 * @property {string} file
 * @property {string} op
 * @property {number} line
 * @property {string} code
 * @property {'killed'|'survived'|'timeout'|'syntax'|'unrun'} outcome
 * @property {number} [ms]
 */

/**
 * 判定。
 *
 * kill 率的分母只算「真跑过且语法合法」的变异体：语法不合法的变异体（`{1: 'x'}`
 * 变成 `{-1: 'x'}` 之类）没告诉我们任何关于测试的事，把它算进分母只会让数字虚高。
 * 超时算杀死——测试没在规定时间内跑完，这个行为差异同样是被察觉到了。
 *
 * @param {{results:MutantResult[], allowed:Map<string,object>, targets?:readonly object[],
 *   scopedFiles?:Set<string>, scopedOps?:Set<string>}} input
 */
export function mutationVerdict({
  results, allowed, targets = TARGETS, scopedFiles = null, scopedOps = null,
}) {
  const tiers = targets.filter((t) => t.enabled).map((tier) => {
    const mine = results.filter((r) => tier.match(r.file));
    const killed = mine.filter((r) => r.outcome === 'killed' || r.outcome === 'timeout');
    const survived = mine.filter((r) => r.outcome === 'survived');
    const syntax = mine.filter((r) => r.outcome === 'syntax');
    const unrun = mine.filter((r) => r.outcome === 'unrun');
    const scored = killed.length + survived.length;
    const killRate = scored === 0 ? null : (killed.length / scored) * 100;
    const newSurvivors = survived.filter((r) => !allowed.has(r.id));
    const resurrected = killed.filter((r) => allowed.has(r.id));
    const rateOk = tier.minKill === null || killRate === null || killRate >= tier.minKill;
    return {
      ...tier,
      total: mine.length,
      killed: killed.length,
      survived: survived.length,
      syntax: syntax.length,
      unrun: unrun.length,
      scored,
      killRate,
      newSurvivors,
      resurrected,
      rateOk,
      ok: !tier.enforce || (newSurvivors.length === 0 && rateOk),
    };
  });

  // 悬空豁免：登记了却已经不存在的变异体。只在它真的在这一轮的范围内时才算——
  // `--only` / `--op` 缩小了范围时，范围外的豁免当然找不到，那不是悬空。少了这层
  // 收窄，任何一次缩范围的局部跑都会误报一堆悬空豁免，闸门就成了「喊惯了的狼」。
  const ran = new Set(results.map((r) => r.id));
  const stale = [...allowed.values()].filter((entry) => {
    if (ran.has(entry.id)) return false;
    if (scopedFiles !== null && !scopedFiles.has(entry.file)) return false;
    if (scopedOps !== null && !scopedOps.has(entry.op)) return false;
    return true;
  });

  const enforced = tiers.filter((t) => t.enforce);
  const ok = enforced.every((t) => t.ok) && stale.length === 0;
  return {
    ok, exitCode: ok ? 0 : 1, tiers, stale,
  };
}

/**
 * 豁免基线的形状校验。核心就一条：**必须写理由**，而且不许是占位符——
 * 一份全是 `TODO` 的豁免表等于把闸门关了，还看着像开着。
 * @param {unknown} parsed
 * @returns {{entries:Map<string,object>, problems:string[]}}
 */
export function parseAllowed(parsed) {
  const problems = [];
  const entries = new Map();
  const list = parsed?.entries;
  if (!Array.isArray(list)) {
    return { entries, problems: [`${ALLOWED_FILE} 需要顶层 { "entries": [...] }`] };
  }
  for (const [i, entry] of list.entries()) {
    const at = `entries[${i}]`;
    const id = entry?.id;
    if (typeof id !== 'string' || id.split('|').length !== 4) {
      problems.push(`${at}：id 形状不符（要 <文件>|<算子>|<行哈希>|<序号>）：${JSON.stringify(id)}`);
      continue;
    }
    const [file, op] = id.split('|');
    if (entry.file !== file) problems.push(`${id}：file 字段与 id 里的文件名不一致（${JSON.stringify(entry.file)}）`);
    if (!OPERATORS.includes(op)) problems.push(`${id}：算子 ${op} 不在白名单里`);
    const why = entry?.why;
    if (typeof why !== 'string' || why.trim().length < 8) {
      problems.push(`${id}：why 必填且要说清楚（一句人话，不是「暂时」两个字）`);
    } else if (/^\s*(?:todo|tbd|xxx|待补|待写)/iu.test(why)) {
      problems.push(`${id}：why 还是占位符（${JSON.stringify(why)}）——没写清理由的豁免等于偷偷关掉闸门`);
    }
    if (entries.has(id)) problems.push(`${id}：重复登记`);
    entries.set(id, { ...entry, id, file, op });
  }
  return { entries, problems };
}

export function formatVerdict(verdict, { advisory = false, budgetHit = false } = {}) {
  const lines = [];
  for (const tier of verdict.tiers) {
    const rate = tier.killRate === null ? '  ——  ' : `${tier.killRate.toFixed(1).padStart(5)}%`;
    const gate = tier.enforce ? `门槛 ${tier.minKill}%` : '仅报告';
    const mark = tier.enforce ? (tier.ok ? '✔' : '✘') : '·';
    lines.push(
      `${mark} ${tier.label.padEnd(24)} kill ${rate}  ${gate}`
      + `（杀 ${tier.killed} / 幸存 ${tier.survived} / 语法不合法 ${tier.syntax}`
      + `${tier.unrun > 0 ? ` / 未跑 ${tier.unrun}` : ''}）`,
    );
    if (!tier.rateOk) lines.push(`    kill 率没到 ${tier.minKill}%：测试在这一档里护得不够密`);
    for (const survivor of tier.newSurvivors.slice(0, 20)) {
      lines.push(`    新幸存 ${survivor.file}:${survivor.line} [${survivor.op}]  ${truncate(survivor.code, 80)}`);
    }
    if (tier.newSurvivors.length > 20) {
      lines.push(`    …还有 ${tier.newSurvivors.length - 20} 个新幸存者（详见证据文件）`);
    }
    for (const back of tier.resurrected.slice(0, 20)) {
      lines.push(`    已被杀掉却还挂着豁免 ${back.file}:${back.line} [${back.op}]——把它从 ${ALLOWED_FILE} 删了`);
    }
  }

  for (const entry of verdict.stale.slice(0, 20)) {
    lines.push(`✘ 悬空豁免 ${entry.id}：这个变异体已经不存在了（那一行改过？）——删掉或重新登记`);
  }

  const newTotal = verdict.tiers.reduce((n, t) => n + (t.enforce ? t.newSurvivors.length : 0), 0);
  if (newTotal > 0) {
    lines.push('');
    lines.push('新幸存者的处置只有两条路，都要写在 PR 里：');
    lines.push('  1. 补一条断言把它杀掉（首选：说明测试确实漏了一处判据）');
    lines.push(`  2. 确认是等价变异，登记进 ${ALLOWED_FILE} 并写清为什么杀不掉`);
    lines.push('照抄下面的骨架（把 why 换成人话）：');
    for (const tier of verdict.tiers.filter((t) => t.enforce)) {
      for (const s of tier.newSurvivors.slice(0, 10)) {
        lines.push(`    ${JSON.stringify({
          id: s.id, file: s.file, op: s.op, code: truncate(s.code, 120), why: '',
        })},`);
      }
    }
  }

  if (budgetHit) {
    lines.push('');
    lines.push('时间盒到点，剩下的变异体没跑（记为「未跑」，不进 kill 率分母）。');
  }
  if (verdict.ok) {
    lines.push('');
    lines.push('设卡档全部达标：没有新幸存者，豁免表也没有悬空条目。');
  } else if (advisory) {
    lines.push('');
    lines.push('advisory 模式：以上只作报告，不影响退出码。');
  }
  return lines.join('\n');
}

function truncate(text, max) {
  const s = String(text ?? '').replaceAll(/\s+/gu, ' ');
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

// ── 「文件 → 用例」映射 ──────────────────────────────────────────────────

/** 静态 import 图（含动态 `import()`——它一样能把代码拉进来）。 */
export function buildImportGraph(root = ROOT) {
  const rel = (p) => path.relative(root, p).split(path.sep).join('/');
  const walk = (dir, out = []) => {
    if (!fs.existsSync(dir)) return out;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, out);
      else if (entry.name.endsWith('.js')) out.push(full);
    }
    return out;
  };
  const deps = new Map();
  for (const file of [...walk(path.join(root, 'src')), ...walk(path.join(root, 'tests'))]) {
    const text = fs.readFileSync(file, 'utf8');
    const specs = [
      ...text.matchAll(/^\s*(?:import|export)[^'"]*?from\s+['"]([^'"]+)['"]/gmu),
      ...text.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gmu),
      ...text.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/gu),
    ].map((m) => m[1]).filter((s) => s.startsWith('.'));
    deps.set(rel(file), specs.map((spec) => {
      const resolved = path.resolve(path.dirname(file), spec);
      const target = fs.existsSync(resolved) && fs.statSync(resolved).isFile()
        ? resolved
        : `${resolved}.js`;
      return rel(target);
    }));
  }
  return deps;
}

/**
 * 两级用例集。
 *
 * `direct`：直接 import 了这个文件的用例，外加同名约定（`src/lib/x.js` → `tests/lib/x.test.js`）。
 *   跑得快，多数变异体在这儿就死了。
 * `closure`：依赖闭包里能到达这个文件的其余用例。只在 direct 没杀掉时补跑——
 *   不补的话会虚报一大堆「其实别处测到了」的幸存者，闸门就没人信了。
 *
 * @param {Map<string,string[]>} deps
 * @returns {(file:string) => {direct:string[], closure:string[]}}
 */
export function testSetResolver(deps, root = ROOT) {
  const tests = [...deps.keys()].filter((f) => f.endsWith('.test.js'));
  const reach = new Map(tests.map((t) => {
    const seen = new Set();
    const stack = [t];
    while (stack.length > 0) {
      const node = stack.pop();
      for (const dep of deps.get(node) ?? []) {
        if (!seen.has(dep)) {
          seen.add(dep);
          stack.push(dep);
        }
      }
    }
    return [t, seen];
  }));
  /** 触及的 src 文件数——既是「这条用例多贵」的代理，也是「它多聚焦」的代理。 */
  const breadth = new Map(tests.map((t) => [
    t,
    [...reach.get(t)].filter((f) => f.startsWith('src/')).length,
  ]));

  return (file) => {
    const direct = new Set(tests.filter((t) => (deps.get(t) ?? []).includes(file)));
    const byName = file.replace(/^src\//u, 'tests/').replace(/\.js$/u, '.test.js');
    if (fs.existsSync(path.join(root, byName))) direct.add(byName);
    // 闭包按「触及面窄的排前面」：窄的用例既跑得快，又更像是盯着某一处判据的单测，
    // 也就更可能一上来就把变异体杀掉。确认阶段是逐批停的，前几批命中率决定总开销。
    const closure = tests
      .filter((t) => reach.get(t).has(file) && !direct.has(t))
      .sort((a, b) => breadth.get(a) - breadth.get(b) || a.localeCompare(b));
    return { direct: [...direct].sort(), closure };
  };
}

// ── 沙盒与执行 ──────────────────────────────────────────────────────────

function makeSandbox(dir) {
  fs.cpSync(ROOT, dir, {
    recursive: true,
    dereference: false,
    filter: (src) => {
      const rel = path.relative(ROOT, src);
      if (rel === '') return true;
      const parts = rel.split(path.sep);
      return !parts.some((part) => SANDBOX_SKIP.has(part));
    },
  });
}

function exec(cmd, args, { cwd, timeoutMs }) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd,
      stdio: ['ignore', 'ignore', 'ignore'],
      // 变异体可能让代码陷进死循环，子进程必须能被整组带走
      detached: true,
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }, timeoutMs);
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ code: 1, timedOut: false });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, timedOut });
    });
  });
}

/**
 * 在沙盒里试一个变异体。
 * @returns {Promise<MutantResult>}
 */
async function tryMutant(mutant, {
  sandbox, testsOf, timeoutMs, confirm, batchSize,
}) {
  const target = path.join(sandbox, ...mutant.file.split('/'));
  const original = fs.readFileSync(target, 'utf8');
  const started = Date.now();
  try {
    fs.writeFileSync(target, applyMutant(original, mutant));

    // 语法预检：算子是文本级的，难免造出语法不合法的变异体（`{1:'x'}` → `{-1:'x'}`）。
    // 那种变异体不说明测试好坏，别让它进 kill 率的分母。
    const syntax = await exec(process.execPath, ['--check', target], { cwd: sandbox, timeoutMs });
    if (syntax.code !== 0) return result(mutant, 'syntax', started);

    const { direct, closure } = testsOf(mutant.file);
    if (direct.length === 0 && closure.length === 0) {
      return { ...result(mutant, 'unrun', started), note: '没有任何用例能到达这个文件' };
    }

    const batches = [direct, ...(confirm === 'off' ? [] : chunk(closure, batchSize))];
    for (const batch of batches) {
      if (batch.length === 0) continue;
      // eslint-disable-next-line no-await-in-loop -- 逐批停：一批杀掉了就不必再跑后面的
      const run = await exec(process.execPath, ['--test', ...batch], { cwd: sandbox, timeoutMs });
      if (run.timedOut) return result(mutant, 'timeout', started);
      if (run.code !== 0) return result(mutant, 'killed', started);
    }
    return result(mutant, 'survived', started);
  } finally {
    fs.writeFileSync(target, original);
  }
}

function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function result(mutant, outcome, started) {
  return {
    id: mutant.id,
    file: mutant.file,
    op: mutant.op,
    line: mutant.line,
    code: mutant.code,
    outcome,
    ms: Date.now() - started,
  };
}

/**
 * 按文件轮转排序：时间盒到点时，跑过的那部分应该横跨所有文件，
 * 而不是把第一个文件啃完、剩下的一个没碰。
 */
export function interleaveByFile(mutants) {
  const byFile = new Map();
  for (const mutant of mutants) {
    if (!byFile.has(mutant.file)) byFile.set(mutant.file, []);
    byFile.get(mutant.file).push(mutant);
  }
  const queues = [...byFile.keys()].sort().map((file) => byFile.get(file));
  const out = [];
  for (let round = 0; out.length < mutants.length; round += 1) {
    for (const queue of queues) {
      if (round < queue.length) out.push(queue[round]);
    }
  }
  return out;
}

// ── 主流程 ──────────────────────────────────────────────────────────────

function sourceFiles(targets) {
  const walk = (dir, out = []) => {
    if (!fs.existsSync(dir)) return out;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, out);
      else if (entry.name.endsWith('.js')) out.push(full);
    }
    return out;
  };
  return walk(path.join(ROOT, 'src'))
    .map((f) => path.relative(ROOT, f).split(path.sep).join('/'))
    .filter((f) => targets.some((t) => t.match(f)))
    .sort();
}

function readAllowed() {
  const file = path.join(ROOT, ...ALLOWED_FILE.split('/'));
  if (!fs.existsSync(file)) return { entries: new Map(), problems: [] };
  return parseAllowed(JSON.parse(fs.readFileSync(file, 'utf8')));
}

function writeEvidence(payload) {
  try {
    const dir = path.join(ROOT, ...EVIDENCE_DIR.split('/'));
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replaceAll(/[:.]/gu, '-');
    const file = path.join(dir, `${stamp}.json`);
    fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`);
    return path.relative(ROOT, file);
  } catch {
    return null; // 证据落不下来不该让闸门判红
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const flag = (name) => argv.includes(`--${name}`);
  const opt = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? null : argv[i + 1] ?? null;
  };
  const known = new Set([
    '--tier', '--only', '--op', '--jobs', '--budget', '--timeout', '--confirm', '--advisory', '--list',
  ]);
  const takesValue = new Set(['--tier', '--only', '--op', '--jobs', '--budget', '--timeout', '--confirm']);
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    if (!known.has(argv[i])) {
      process.stderr.write(`不认识的参数：${argv[i]}（可用：${[...known].join(' ')}）\n`);
      process.exitCode = 3;
      return;
    }
    if (takesValue.has(argv[i])) i += 1;
  }

  const tierIds = opt('tier')?.split(',').map((s) => s.trim()).filter(Boolean) ?? null;
  const targets = tierIds
    ? TARGETS.filter((t) => tierIds.includes(t.id)).map((t) => ({ ...t, enabled: true }))
    : TARGETS.filter((t) => t.enabled);
  if (targets.length === 0) {
    process.stderr.write(`--tier 没匹配到分档（可选：${TARGETS.map((t) => t.id).join(', ')}）\n`);
    process.exitCode = 3;
    return;
  }
  const opFilter = opt('op')?.split(',').map((s) => s.trim()).filter(Boolean) ?? null;
  if (opFilter && opFilter.some((op) => !OPERATORS.includes(op))) {
    process.stderr.write(`--op 只认这些算子：${OPERATORS.join(', ')}\n`);
    process.exitCode = 3;
    return;
  }
  const ops = new Set(opFilter ?? DEFAULT_OPERATORS);
  const positiveInt = (name, fallback) => {
    const raw = opt(name);
    if (raw === null) return fallback;
    const n = Number(raw);
    return Number.isInteger(n) && n > 0 ? n : null;
  };
  const jobs = positiveInt('jobs', Math.min(os.availableParallelism?.() ?? os.cpus().length, 8));
  const budgetSec = positiveInt('budget', null);
  const timeoutSec = positiveInt('timeout', 180);
  if (jobs === null || timeoutSec === null || (opt('budget') !== null && budgetSec === null)) {
    process.stderr.write('--jobs / --budget / --timeout 都要是 ≥1 的整数（秒）\n');
    process.exitCode = 3;
    return;
  }
  const confirm = opt('confirm') ?? 'batch';
  if (!['batch', 'off'].includes(confirm)) {
    process.stderr.write('--confirm 只认 batch（默认，逐批确认幸存者）或 off（只跑直接用例，快但会虚报幸存者）\n');
    process.exitCode = 3;
    return;
  }

  const only = opt('only');
  const files = sourceFiles(targets).filter((f) => (only === null ? true : f.includes(only)));
  if (files.length === 0) {
    process.stderr.write(`--only ${JSON.stringify(only)} 没匹配到源码文件\n`);
    process.exitCode = 3;
    return;
  }

  const allMutants = files
    .flatMap((file) => enumerateMutants(fs.readFileSync(path.join(ROOT, ...file.split('/')), 'utf8'), { file }))
    .filter((m) => ops.has(m.op));
  const queue = interleaveByFile(allMutants);

  const deps = buildImportGraph();
  const testsOf = testSetResolver(deps);

  if (flag('list')) {
    process.stdout.write(`\n${files.length} 个文件，${queue.length} 个变异体：\n`);
    for (const file of files) {
      const n = allMutants.filter((m) => m.file === file).length;
      const { direct, closure } = testsOf(file);
      process.stdout.write(`  ${file.padEnd(26)} ${String(n).padStart(4)} 个  用例 直接 ${direct.length} / 闭包 ${closure.length}\n`);
    }
    process.stdout.write(`算子：${[...ops].join(' ')}\n`);
    return;
  }

  const { entries: allowed, problems } = readAllowed();
  if (problems.length > 0) {
    process.stdout.write(`\n${ALLOWED_FILE} 形状不合格：\n  ${problems.join('\n  ')}\n`);
    process.exitCode = 1;
    return;
  }

  process.stdout.write(
    `\n变异测试：${files.length} 个文件 / ${queue.length} 个变异体，${jobs} 路并发`
    + `${budgetSec === null ? '' : `，时间盒 ${budgetSec}s`}\n`
    + '正在准备沙盒（整仓副本，工作区不会被改动）……\n',
  );

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-mut-'));
  const sandboxes = [];
  const results = [];
  const preflightTests = [...new Set(files.flatMap((f) => testsOf(f).direct))].sort();
  const deadline = budgetSec === null ? null : Date.now() + budgetSec * 1_000;
  let budgetHit = false;
  let cursor = 0;
  let done = 0;

  try {
    for (let i = 0; i < jobs; i += 1) {
      const dir = path.join(tmp, `sandbox-${i}`);
      makeSandbox(dir);
      sandboxes.push(dir);
    }

    // 自检：没改任何东西的沙盒必须先是绿的。
    //
    // 这一关防的是变异闸门最安静的失败方式——**假杀**。如果沙盒里的测试因为别的原因
    // （沙盒少复制了一个文件、某条用例在这台机器上本来就红、端口被占）本来就不过，
    // 那么每个变异体都会被判成「杀死」，kill 率漂亮地接近 100%，而闸门其实什么都没测。
    // 「幸存」是要靠证据的，「杀死」同样要——凭据就是「不改的时候它是绿的」。
    if (preflightTests.length > 0) {
      process.stdout.write(`自检：未变异的沙盒先跑一遍 ${preflightTests.length} 个直接用例……\n`);
      const clean = await exec(process.execPath, ['--test', ...preflightTests], {
        cwd: sandboxes[0], timeoutMs: timeoutSec * 1_000,
      });
      if (clean.code !== 0) {
        process.stdout.write(
          '\n未变异的沙盒本来就是红的，整轮结论作废：这种情况下每个变异体都会被判成'
          + '「杀死」，kill 率再高也没有意义。\n先在干净工作区跑一遍：\n'
          + `  node --test ${preflightTests.join(' ')}\n`
          + `${clean.timedOut ? `（自检超时，超过 ${timeoutSec}s）\n` : ''}`,
        );
        process.exitCode = 1;
        return;
      }
    }

    const worker = async (sandbox) => {
      for (;;) {
        if (deadline !== null && Date.now() >= deadline) {
          budgetHit = true;
          return;
        }
        const index = cursor;
        cursor += 1;
        if (index >= queue.length) return;
        // eslint-disable-next-line no-await-in-loop -- 这就是工作队列：一个做完再领下一个
        const outcome = await tryMutant(queue[index], {
          sandbox, testsOf, timeoutMs: timeoutSec * 1_000, confirm, batchSize: CONFIRM_BATCH,
        });
        results.push(outcome);
        done += 1;
        if (done % 25 === 0 || done === queue.length) {
          const killed = results.filter((r) => r.outcome === 'killed' || r.outcome === 'timeout').length;
          const survived = results.filter((r) => r.outcome === 'survived').length;
          process.stdout.write(`  ${done}/${queue.length}  杀 ${killed} / 幸存 ${survived}\n`);
        }
      }
    };
    await Promise.all(sandboxes.map(worker));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  for (const mutant of queue.slice(results.length)) {
    if (results.some((r) => r.id === mutant.id)) continue;
    results.push(result(mutant, 'unrun', Date.now()));
  }

  const verdict = mutationVerdict({
    results, allowed, targets, scopedFiles: new Set(files), scopedOps: ops,
  });
  const advisory = flag('advisory');
  process.stdout.write(`\n变异测试门槛：\n${formatVerdict(verdict, { advisory, budgetHit })}\n`);

  const evidence = writeEvidence({
    at: new Date().toISOString(),
    host: `${process.platform}/${process.arch} node ${process.versions.node}`,
    jobs,
    budgetSec,
    files,
    survivors: results.filter((r) => r.outcome === 'survived'),
    results,
  });
  if (evidence) process.stdout.write(`\n逐条结果落在 ${evidence}（不入库）。\n`);

  if (!verdict.ok && !advisory) process.exitCode = verdict.exitCode;
}

if (isMainEntry(import.meta.url)) await main();
