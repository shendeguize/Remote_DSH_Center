/**
 * fuzz 驱动器（harness 支柱 C）。
 *
 * 五个目标共用这一份控制流，各自只提供两个纯函数：
 *   gen(rng)         → input（必须 JSON 可序列化，否则沉淀不下来）
 *   check(input, ctx) → 不抛即通过
 *
 * 驱动器负责三件目标不该各写一遍的事：
 *   1. **先回放语料**再生成新例。历史逮到过的输入是硬回归，不吃预算、不看概率。
 *   2. **预算分层**：`npm test` 里是固定种子 + 固定例数（秒级，天天跑）；cron 里换成
 *      `DSHC_FUZZ_BUDGET_MS` 时间盒 + 随机根种子（探新，跑得久）。
 *   3. **失败即沉淀**：把失败例连同种子、触发签名写进 `.local/evidence/fuzz/`，并在
 *      报错里给出「单例重放」与「入库」两条现成命令。捞不回来的失败等于没发生过。
 *
 * 环境变量（都可缺省）：
 *   DSHC_FUZZ_SEED       根种子，定死整轮的全部输入
 *   DSHC_FUZZ_CASES      每目标例数（默认 200）
 *   DSHC_FUZZ_BUDGET_MS  改用时间盒；设了就忽略例数
 *   DSHC_FUZZ_ONLY       只跑这一个序号（复现单例用）
 *   DSHC_FUZZ_CORPUS_ONLY 只回放语料、不生成（想快速确认回归时用）
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isJsonRoundTrippable, loadFuzzCorpus, TARGETS } from './corpus.js';
import { rngFor } from './prng.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');

export const DEFAULT_CASES = 200;

/**
 * 默认根种子写死。随机默认值会让「昨天绿今天红而代码没动」成为常态，
 * 那种红没人查得动——探新是 cron 的活，日常闸门要的是确定性。
 */
export const DEFAULT_ROOT_SEED = 2_026_0825;

/** 一条注入类失败的标记。沉淀管道据此把它转写成 adversarial 语料。 */
export const INJECTION = 'injection';

/**
 * 抛一个「注入逃逸」失败。带上攻击面与注入点，`scripts/fuzz-sink.mjs` 才知道该往
 * 哪个 adversarial 语料文件里写。
 * @param {string} message
 * @param {{surface:string, entry:string, payload?:unknown, canary?:string}} meta
 */
export function injectionFailure(message, meta) {
  const error = new Error(message);
  error.fuzzClass = INJECTION;
  error.fuzzInjection = meta;
  // 把本函数自己那一帧从栈里摘掉，否则**每一条**注入失败的栈顶都是这里，
  // 触发签名全都相同 → 去重会把不同注入点的发现折成一条，语料就缺了。
  Error.captureStackTrace?.(error, injectionFailure);
  return error;
}

/** @param {NodeJS.ProcessEnv} [env] */
export function fuzzBudget(env = process.env) {
  const int = (raw) => {
    const n = Number.parseInt(raw ?? '', 10);
    return Number.isInteger(n) ? n : null;
  };
  const cases = int(env.DSHC_FUZZ_CASES);
  const budgetMs = int(env.DSHC_FUZZ_BUDGET_MS);
  const seed = int(env.DSHC_FUZZ_SEED);
  const only = int(env.DSHC_FUZZ_ONLY);
  return {
    rootSeed: seed === null ? DEFAULT_ROOT_SEED : seed >>> 0,
    cases: cases !== null && cases > 0 ? cases : DEFAULT_CASES,
    budgetMs: budgetMs !== null && budgetMs > 0 ? budgetMs : null,
    only: only !== null && only >= 0 ? only : null,
    corpusOnly: env.DSHC_FUZZ_CORPUS_ONLY === '1',
    seedExplicit: seed !== null,
  };
}

/**
 * 触发路径签名——语料去重的唯一依据。
 *
 * 「同一个 bug 的一百个输入」只该留一条语料，否则语料库会被一次随机风暴灌爆，
 * 之后没人愿意读它。用什么当同一性？错误码 + **第一个落在本仓源码里的栈帧**：
 * 同一处判断出的错，帧是同一个；不同处出的错，帧不同。比按错误文本去重稳（文本里
 * 常带具体输入值，每例都不一样，等于不去重）。
 *
 * @param {unknown} error
 * @param {string} target
 * @returns {string}
 */
export function signatureOf(error, target) {
  // 注入类的「触发路径」是那个注入点本身（面/注入点），比栈帧更贴近同一性：
  // 同一个注入点换个载荷是同一个洞，不同注入点即便栈帧相同也是两个洞。
  const entry = error?.fuzzInjection?.entry;
  const where = typeof entry === 'string' && entry !== ''
    ? `${error.fuzzInjection.surface}/${entry}`
    : repoFrame(error) ?? 'no-frame';
  return `${target}|${errorCode(error)}|${where}`;
}

function errorCode(error) {
  if (error === null || typeof error !== 'object') return 'non-error';
  const withCode = /** @type {{code?:unknown, name?:unknown}} */ (error);
  if (typeof withCode.code === 'string' && withCode.code !== '') return withCode.code;
  if (typeof withCode.name === 'string' && withCode.name !== '') return withCode.name;
  return 'Error';
}

/**
 * 栈里第一个本仓帧。优先 `src/`（产品代码里的触发点才是 bug 所在），其次 `tests/`
 * （断言失败的场合，触发点就是那条断言）。
 * @returns {string|null} `src/lib/shq.js:25` 形态（相对路径，跨机器一致）
 */
export function repoFrame(error, { root = REPO_ROOT } = {}) {
  const stack = typeof error?.stack === 'string' ? error.stack : '';
  const frames = [];
  for (const line of stack.split('\n')) {
    const m = /(?:file:\/\/)?(\/[^\s()]+\.(?:js|mjs)):(\d+):\d+/u.exec(line);
    if (!m) continue;
    const abs = m[1];
    if (!abs.startsWith(`${root}/`)) continue;
    frames.push(`${abs.slice(root.length + 1)}:${m[2]}`);
  }
  return frames.find((f) => f.startsWith('src/')) ?? frames[0] ?? null;
}

/**
 * @typedef {{target:string, gen:(rng:import('./prng.js').Rng)=>unknown,
 *   check:(input:unknown, ctx:unknown)=>unknown|Promise<unknown>,
 *   setup?:(t:object)=>unknown|Promise<unknown>, minCorpus?:number}} FuzzSpec
 */

/**
 * 跑一个 fuzz 目标。
 * @param {object} t node:test 的 TestContext
 * @param {FuzzSpec} spec
 * @returns {Promise<{corpus:number, generated:number, rootSeed:number}>}
 */
export async function runFuzzTarget(t, spec) {
  assert.ok(TARGETS.includes(spec.target), `未登记的 fuzz 目标：${spec.target}`);
  const budget = fuzzBudget();
  const ctx = spec.setup ? await spec.setup(t) : null;

  const corpus = loadFuzzCorpus(spec.target);
  if (spec.minCorpus !== undefined) {
    assert.ok(
      corpus.length >= spec.minCorpus,
      `${spec.target} 语料只有 ${corpus.length} 条，低于约定的 ${spec.minCorpus} 条`,
    );
  }
  for (const entry of corpus) {
    // eslint-disable-next-line no-await-in-loop -- 逐条回放：共用 ctx，且要能指名道姓地报错
    await guard(spec, entry.input, ctx, { kind: 'corpus', ref: entry.id, budget });
  }

  let generated = 0;
  if (!budget.corpusOnly) {
    const deadline = budget.budgetMs === null ? null : Date.now() + budget.budgetMs;
    const first = budget.only ?? 0;
    for (let index = first; ; index += 1) {
      if (budget.only !== null && index > budget.only) break;
      if (deadline === null) {
        if (index - first >= budget.cases) break;
      } else if (Date.now() >= deadline) break;

      const rng = rngFor(budget.rootSeed, spec.target, index);
      const input = spec.gen(rng);
      // 生成器的硬约束：输入必须能原样落盘再读回来。违反了就意味着这一例即便逮到 bug
      // 也沉淀不下来（存进语料的是它的有损投影，回放时未必再触发），得当场改生成器。
      assert.ok(
        isJsonRoundTrippable(input),
        `${spec.target} 第 ${index} 例的输入不是 JSON 往返稳定的值（seed=${rng.seed}）：`
          + `${safeJson(input)}\n生成器必须只产出 null/布尔/有限数/字符串/数组/纯对象。`,
      );
      // eslint-disable-next-line no-await-in-loop -- 一例一例来：随机测试的价值在可复现
      await guard(spec, input, ctx, {
        kind: 'generated', index, seed: rng.seed, budget,
      });
      generated += 1;
    }
    assert.ok(generated > 0, `${spec.target} 一个例子都没跑：预算配置把它整个跳过了`);
  }

  return { corpus: corpus.length, generated, rootSeed: budget.rootSeed };
}

async function guard(spec, input, ctx, meta) {
  try {
    await spec.check(input, ctx);
  } catch (error) {
    const finding = {
      target: spec.target,
      signature: signatureOf(error, spec.target),
      class: error?.fuzzClass ?? 'assertion',
      injection: error?.fuzzInjection ?? null,
      kind: meta.kind,
      ref: meta.ref ?? null,
      index: meta.index ?? null,
      seed: meta.seed ?? null,
      rootSeed: meta.budget.rootSeed,
      input,
      message: String(error?.message ?? error).slice(0, 2_000),
      at: new Date().toISOString(),
    };
    recordFinding(finding);
    throw decorate(error, finding, spec.target);
  }
}

function decorate(error, finding, target) {
  const where = finding.kind === 'corpus'
    ? `语料 ${finding.ref} 回放失败`
    : `第 ${finding.index} 例失败（seed=${finding.seed}）`;
  const replay = finding.kind === 'corpus'
    ? `DSHC_FUZZ_CORPUS_ONLY=1 node --test ${targetFile(target)}`
    : `DSHC_FUZZ_SEED=${finding.rootSeed} DSHC_FUZZ_ONLY=${finding.index} node --test ${targetFile(target)}`;
  error.message = [
    `[fuzz ${target}] ${where}`,
    `  触发签名：${finding.signature}`,
    `  输入：${truncate(safeJson(finding.input), 600)}`,
    `  单例重放：${replay}`,
    '  入库为永久回归语料：node scripts/fuzz-sink.mjs --write',
    `  原始失败：${finding.message}`,
  ].join('\n');
  return error;
}

/** 目标名 → 用例文件。重放命令要能照抄粘贴，不能让人再去猜文件在哪。 */
export function targetFile(target) {
  const base = {
    'shq-roundtrip': 'shq',
    'proto-roundtrip': 'proto',
    'validate-mutation': 'validate',
    'machine-walk': 'machine',
    'http-body': 'http',
  }[target];
  return `tests/fuzz/${base}.test.js`;
}

/**
 * 失败落盘到 `.local/evidence/fuzz/findings.ndjson`（不入库）。
 *
 * 为什么不直接写进 `tests/fuzz/corpus/`：那会让 `npm test` 变成会改仓库的命令——
 * 一次 CI 跑完工作区就脏了，而且没人 review 过就进了库。沉淀是显式的一步
 * （`scripts/fuzz-sink.mjs --write`），由人按 RV-10 提交。
 */
export function recordFinding(finding, { dir = findingsDir() } = {}) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'findings.ndjson'), `${safeJson(finding)}\n`);
    return true;
  } catch {
    // 落不下去也不能盖掉真正的失败——测试该报的还是那条断言
    return false;
  }
}

export function findingsDir() {
  return path.join(REPO_ROOT, '.local', 'evidence', 'fuzz');
}

function safeJson(value) {
  try {
    return JSON.stringify(value) ?? 'undefined';
  } catch {
    return '"<不可序列化>"';
  }
}

function truncate(text, max) {
  return text.length <= max ? text : `${text.slice(0, max)}…（共 ${text.length} 字符）`;
}
