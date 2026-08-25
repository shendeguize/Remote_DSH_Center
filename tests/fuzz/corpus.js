/**
 * fuzz 回归语料（harness 支柱 C 的沉淀端）。
 *
 * 随机测试有个众所周知的失败模式：这次逮到了，改完就忘了，半年后同一个形状再次
 * 溜进来，得靠运气再撞一次。语料库就是治这个的——每个逮到过的输入被按**触发路径**
 * 去重后写死在这里，从此**每次** `npm test` 都逐字回放一遍，不再靠概率。
 *
 * 与 `tests/adversarial/corpus/` 的分工：那边是「攻击载荷」，人写、按面组织；
 * 这边是「随机逮到的输入」，机器写（`scripts/fuzz-sink.mjs`）、按目标组织。
 * 注入类的发现会被沉淀管道同时转写成一条 adversarial 语料（RV-10）。
 *
 * 条目形状：
 *   id         FZ-<目标缩写>-NNN，全库唯一。删条目 = 放弃一次回归，不许改号
 *   target     所属 fuzz 目标（见 TARGETS）
 *   signature  触发路径签名（去重键，见 runner.js 的 signatureOf）
 *   input      逐字回放的输入（必须 JSON 可序列化——这是对生成器的硬约束）
 *   origin     来历：种子、发现时间、相关 issue/PR
 *   note       可选，一句话说清这个输入毒在哪
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 五个目标。加目标要同时加语料文件与 ID 前缀，`matrix-gate` 和卫生用例都盯着。 */
export const TARGETS = Object.freeze([
  'shq-roundtrip',
  'proto-roundtrip',
  'validate-mutation',
  'machine-walk',
  'http-body',
]);

/** 目标 → ID 前缀。不从目标名机械推导，是为了让 ID 短且改名时不会悄悄换号。 */
export const ID_PREFIX = Object.freeze({
  'shq-roundtrip': 'SHQ',
  'proto-roundtrip': 'PROTO',
  'validate-mutation': 'VALID',
  'machine-walk': 'MACHINE',
  'http-body': 'HTTP',
});

export function corpusFile(target) {
  if (!TARGETS.includes(target)) throw new Error(`未知 fuzz 目标：${target}`);
  return path.join(HERE, 'corpus', `${target}.json`);
}

/** @returns {object[]} 文件不存在即空语料（新目标落地时不必先造文件） */
export function loadFuzzCorpus(target) {
  const file = corpusFile(target);
  if (!fs.existsSync(file)) return [];
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(parsed)) throw new Error(`${target}.json 顶层必须是数组`);
  return parsed;
}

export function loadAllFuzzCorpus() {
  return TARGETS.flatMap((target) => loadFuzzCorpus(target).map((entry) => ({ target, entry })));
}

/**
 * @param {object} entry
 * @param {string} target
 * @returns {string[]} 形状问题（空数组即合格）
 */
export function validateFuzzEntry(entry, target) {
  const problems = [];
  const id = entry?.id;
  const prefix = ID_PREFIX[target];
  if (typeof id !== 'string' || !new RegExp(`^FZ-${prefix}-\\d{3}$`, 'u').test(id)) {
    problems.push(`id 形状不符（要 FZ-${prefix}-NNN）：${JSON.stringify(id)}`);
  }
  if (entry?.target !== target) {
    problems.push(`${id}：target 应为 ${target}，实为 ${JSON.stringify(entry?.target)}`);
  }
  if (typeof entry?.signature !== 'string' || entry.signature.trim() === '') {
    problems.push(`${id}：signature 必填（去重键，没有它语料会重复堆积）`);
  }
  if (entry?.input === undefined) {
    problems.push(`${id}：input 必填（不带输入的语料回放不了任何东西）`);
  } else if (!isJsonRoundTrippable(entry.input)) {
    problems.push(`${id}：input 不是 JSON 往返稳定的值，回放出来的不是当初那个输入`);
  }
  if (typeof entry?.origin !== 'string' || entry.origin.trim() === '') {
    problems.push(`${id}：origin 必填（哪个种子哪一轮逮到的，出事时要能顺着查）`);
  }
  return problems;
}

/**
 * JSON 往返稳定性。语料落盘再读回来必须还是**同一个值**，否则回放的根本不是当初逮到的
 * 输入，而是它的一个有损投影——那种「回归测试」比没有更坏，因为它看着是绿的。
 *
 * 判据是逐层走一遍白名单，而不是「序列化两次比文本」：后者会放过一整类有损情形，
 * 因为 JSON 把它们**静静地**改写成合法值，第二次序列化自然稳定。`NaN` 与 `Infinity`
 * 变成 `null`、`Date` 变成字符串、`{a: undefined}` 变成 `{}`、`Map` 变成 `{}`——
 * 文本都稳定，值全不是原来那个。
 */
export function isJsonRoundTrippable(value, seen = new Set()) {
  if (value === null) return true;
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return true;
    case 'number':
      // NaN / ±Infinity 会被写成 null：读回来是另一个值，且往往是能跑通的另一个值
      return Number.isFinite(value);
    case 'object':
      break;
    default:
      // undefined / function / symbol / bigint：要么被丢掉，要么直接抛
      return false;
  }

  if (seen.has(value)) return false; // 循环引用：JSON.stringify 会抛
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      // 逐下标走，不用 every/some：那一族方法**跳过空洞**，而空洞恰恰是要抓的
      // 有损情形之一（`[1, , 3]` 会被写成 `[1,null,3]`）。
      for (let i = 0; i < value.length; i += 1) {
        if (!(i in value)) return false;
        if (!isJsonRoundTrippable(value[i], seen)) return false;
      }
      return true;
    }
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return false; // Date / Map / 类实例
    if (typeof (/** @type {{toJSON?:unknown}} */ (value).toJSON) === 'function') return false;
    if (Object.getOwnPropertySymbols(value).length > 0) return false; // symbol 键会被丢掉
    return Object.entries(value).every(([, v]) => isJsonRoundTrippable(v, seen));
  } finally {
    seen.delete(value);
  }
}

/** 下一个可用 ID。语料只增不改，所以永远取「现存最大号 + 1」，不填补空洞。 */
export function nextFuzzId(target, entries) {
  const prefix = ID_PREFIX[target];
  const re = new RegExp(`^FZ-${prefix}-(\\d{3})$`, 'u');
  let max = 0;
  for (const entry of entries) {
    const m = re.exec(entry?.id ?? '');
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `FZ-${prefix}-${String(max + 1).padStart(3, '0')}`;
}
