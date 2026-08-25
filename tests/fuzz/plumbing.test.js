/**
 * fuzz 体系自身的判定逻辑（不随机，全定死）。
 *
 * 随机测试有个自指的风险：驱动器或语料库自己坏了，五个目标会一起「静静地跑零个例子」
 * 然后报绿。所以这一份把体系的骨架逐条钉住——PRNG 的确定性、预算解析、触发签名、
 * 语料形状、沉淀管道的去重与转写。这些全是纯函数，判定逻辑该有单测。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  ID_PREFIX, TARGETS, corpusFile, isJsonRoundTrippable, loadAllFuzzCorpus, loadFuzzCorpus,
  nextFuzzId, validateFuzzEntry,
} from './corpus.js';
import {
  ALPHABETS, NASTY_CODEPOINTS, Rng, hashSeed, mulberry32, rngFor,
} from './prng.js';
import {
  DEFAULT_CASES, DEFAULT_ROOT_SEED, fuzzBudget, injectionFailure, repoFrame, signatureOf,
  targetFile,
} from './runner.js';
import {
  KNOWN_ARGV_ENTRIES, SURFACE_PREFIX, adversarialEntryFor, nextAdversarialId, parseFindings,
  sinkPlan,
} from '../../scripts/fuzz-sink.mjs';
import { SURFACES, loadCorpus, validateEntry } from '../adversarial/corpus.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// ── PRNG ────────────────────────────────────────────────────────────────

test('mulberry32：同种子逐位可复现，不同种子不同流', () => {
  const a = Array.from({ length: 8 }, mulberry32(12_345));
  const b = Array.from({ length: 8 }, mulberry32(12_345));
  const c = Array.from({ length: 8 }, mulberry32(12_346));
  assert.deepEqual(a, b, '同种子必须给出完全相同的序列——随机测试的可复现性全押在这里');
  assert.notDeepEqual(a, c, '相邻种子给出同一条流，说明种子实际没参与运算');
  for (const value of a) {
    assert.ok(value >= 0 && value < 1, `输出越界：${value}`);
  }
});

test('mulberry32：逐字快照（改了算法就是改了全部历史语料的含义）', () => {
  // 语料里存的是「输入」而非「种子」，所以换算法不会让旧语料失效；但**新**例子会全部
  // 变样，等于换了一套测试。故意让它需要显式改这个快照。
  const next = mulberry32(1);
  assert.deepEqual(
    Array.from({ length: 4 }, next).map((v) => Math.floor(v * 1e9)),
    [627_073_940, 2_735_721, 527_447_039, 981_050_967],
  );
});

test('hashSeed：目标名参与，所以两个目标的同序号例子不撞', () => {
  assert.equal(hashSeed(1, 'a', 0), hashSeed(1, 'a', 0), '同输入必须同输出');
  assert.notEqual(hashSeed(1, 'a', 0), hashSeed(1, 'b', 0), '目标名没进种子：两个目标会验同一串输入');
  assert.notEqual(hashSeed(1, 'a', 0), hashSeed(1, 'a', 1), '序号没进种子：整轮都在验第 0 例');
  assert.notEqual(hashSeed(1, 'a', 0), hashSeed(2, 'a', 0), '根种子没进种子：DSHC_FUZZ_SEED 就白设了');
  // 分隔符必须真的分隔：('ab',0) 与 ('a','b0') 不许折成同一个
  assert.notEqual(hashSeed('ab', 0), hashSeed('a', 'b0'));
  for (const seed of [hashSeed(0), hashSeed(-1), hashSeed('x')]) {
    assert.ok(Number.isInteger(seed) && seed >= 0 && seed <= 0xffff_ffff, `种子不是 32 位无符号：${seed}`);
  }
});

test('Rng：区间闭合、加权分布、洗牌保元素、毒串遵守禁字', () => {
  const rng = new Rng(7);
  for (let i = 0; i < 200; i += 1) {
    const v = rng.int(3, 5);
    assert.ok(v >= 3 && v <= 5 && Number.isInteger(v), `int 越界：${v}`);
  }
  assert.throws(() => rng.int(5, 3), /区间反了/u);
  assert.throws(() => rng.pick([]), /空表/u);

  // 权重 0 的项永远不该被选中
  const picks = new Set(Array.from({ length: 200 }, () => rng.pickWeighted([[1, 'a'], [0, 'never']])));
  assert.deepEqual([...picks], ['a'], 'pickWeighted 选中了权重为 0 的项');

  const source = [1, 2, 3, 4, 5];
  const shuffled = rng.shuffle(source);
  assert.deepEqual([...shuffled].sort(), source, '洗牌丢了或多了元素');
  assert.deepEqual(source, [1, 2, 3, 4, 5], '洗牌改了入参数组');

  const forbidden = ['\u0000', '\ud800'];
  for (let i = 0; i < 100; i += 1) {
    const s = rng.nasty({ min: 5, max: 20, forbid: forbidden, nastyRate: 0.9 });
    for (const ch of forbidden) {
      assert.equal(s.includes(ch), false, `毒串里出现了禁字 ${JSON.stringify(ch)}：${JSON.stringify(s)}`);
    }
  }

  const plain = rng.string({ min: 30, max: 30, alphabet: ALPHABETS.plain });
  assert.equal(plain.length, 30);
  assert.match(plain, /^[a-z0-9]+$/u, 'string 越出了给定字符集');
});

test('rngFor：与 hashSeed 一致，且暴露 seed 供失败信息复现', () => {
  const rng = rngFor(99, 'shq-roundtrip', 3);
  assert.equal(rng.seed, hashSeed(99, 'shq-roundtrip', 3));
  assert.deepEqual(
    Array.from({ length: 3 }, () => rng.float()),
    Array.from({ length: 3 }, mulberry32(hashSeed(99, 'shq-roundtrip', 3))),
  );
});

test('毒字符表里没有大写 ASCII——proto 目标的标签正是靠这一点不被伪造', () => {
  const pool = `${ALPHABETS.shell}${NASTY_CODEPOINTS.join('')}`;
  assert.equal(/[A-Z]/u.test(pool), false, `shell 毒池里出现了大写字母，tagged() 的不可伪造性就没了：${pool}`);
});

// ── 预算与签名 ──────────────────────────────────────────────────────────

test('fuzzBudget：默认写死、env 覆盖、垃圾值退回默认', () => {
  const base = fuzzBudget({});
  assert.equal(base.rootSeed, DEFAULT_ROOT_SEED, '默认根种子必须写死：随机默认值会让日常闸门天天假红');
  assert.equal(base.cases, DEFAULT_CASES);
  assert.equal(base.budgetMs, null, '默认不走时间盒');
  assert.equal(base.only, null);
  assert.equal(base.corpusOnly, false);
  assert.equal(base.seedExplicit, false);

  const cron = fuzzBudget({ DSHC_FUZZ_BUDGET_MS: '60000', DSHC_FUZZ_SEED: '4242', DSHC_FUZZ_CASES: '5' });
  assert.equal(cron.budgetMs, 60_000);
  assert.equal(cron.rootSeed, 4_242);
  assert.equal(cron.seedExplicit, true);
  assert.equal(cron.cases, 5, '例数仍然解析出来（时间盒优先由 runner 决定，不在这儿吞掉）');

  for (const bad of ['', 'abc', '0', '-3', 'x9']) {
    assert.equal(fuzzBudget({ DSHC_FUZZ_CASES: bad }).cases, DEFAULT_CASES, `垃圾例数 ${JSON.stringify(bad)} 该退回默认`);
    assert.equal(fuzzBudget({ DSHC_FUZZ_BUDGET_MS: bad }).budgetMs, null, `垃圾预算 ${JSON.stringify(bad)} 该退回不限时`);
  }
  assert.equal(fuzzBudget({ DSHC_FUZZ_ONLY: '0' }).only, 0, '只跑第 0 例是合法请求，不许被当成假值丢掉');
  assert.equal(fuzzBudget({ DSHC_FUZZ_CORPUS_ONLY: '1' }).corpusOnly, true);
});

test('repoFrame：优先 src 帧，其次 tests，仓外帧一律不算', () => {
  const error = new Error('x');
  error.stack = [
    'Error: x',
    '    at foo (node:internal/whatever:1:1)',
    '    at bar (/elsewhere/other-repo/src/lib/shq.js:9:9)',
    `    at baz (file://${ROOT}/tests/fuzz/shq.test.js:88:10)`,
    `    at qux (file://${ROOT}/src/lib/shq.js:25:11)`,
  ].join('\n');
  assert.equal(repoFrame(error, { root: ROOT }), 'src/lib/shq.js:25', 'src 帧优先：bug 在产品里，不在断言里');

  const testOnly = new Error('y');
  testOnly.stack = `Error: y\n    at baz (file://${ROOT}/tests/fuzz/shq.test.js:88:10)`;
  assert.equal(repoFrame(testOnly, { root: ROOT }), 'tests/fuzz/shq.test.js:88');

  assert.equal(repoFrame(new Error('z'), { root: '/nowhere' }), null, '没有本仓帧就是 null，不许编一个');
  assert.equal(repoFrame({}, { root: ROOT }), null);
});

test('signatureOf：注入类按注入点归一，其余按错误码 + 栈帧', () => {
  const injected = injectionFailure('逃了', { surface: 'launch-argv', entry: 'inject.extraArgs' });
  assert.equal(
    signatureOf(injected, 'proto-roundtrip'),
    'proto-roundtrip|Error|launch-argv/inject.extraArgs',
    '注入类的同一性是注入点：换个载荷是同一个洞，换个注入点是两个洞',
  );

  const coded = Object.assign(new Error('v'), { code: 'VALIDATION' });
  coded.stack = `Error: v\n    at f (file://${ROOT}/src/lib/shq.js:75:11)`;
  assert.equal(signatureOf(coded, 'shq-roundtrip'), 'shq-roundtrip|VALIDATION|src/lib/shq.js:75');

  assert.equal(signatureOf('不是错误对象', 'machine-walk'), 'machine-walk|non-error|no-frame');
});

test('injectionFailure：把自己那一帧摘掉，否则所有注入发现签名相同、去重会吞掉语料', () => {
  const error = injectionFailure('逃了', { surface: 'http', entry: 'body' });
  assert.equal(error.fuzzClass, 'injection');
  assert.equal(
    (error.stack ?? '').includes('injectionFailure'),
    false,
    '栈顶还是 injectionFailure 自己：不同注入点会折成一条签名',
  );
});

test('targetFile：五个目标都指向真实存在的用例文件', () => {
  for (const target of TARGETS) {
    const file = targetFile(target);
    assert.ok(
      fs.existsSync(path.join(ROOT, file)),
      `${target} 的重放命令指向不存在的文件 ${file}——照抄粘贴会直接报错`,
    );
  }
  assert.equal(new Set(TARGETS.map(targetFile)).size, TARGETS.length, '两个目标指向了同一个文件');
});

// ── 语料库形状 ──────────────────────────────────────────────────────────

test('每个目标都有语料文件、ID 前缀与 corpus 目录一一对应', () => {
  assert.deepEqual(Object.keys(ID_PREFIX).sort(), [...TARGETS].sort(), 'ID 前缀表与目标表不同步');
  assert.equal(new Set(Object.values(ID_PREFIX)).size, TARGETS.length, 'ID 前缀有重复：两个目标会抢同一个号段');
  const dir = path.join(ROOT, 'tests', 'fuzz', 'corpus');
  const onDisk = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/u, '')).sort();
  assert.deepEqual(onDisk, [...TARGETS].sort(), '语料目录里有孤立文件或缺文件');
  for (const target of TARGETS) {
    assert.ok(fs.existsSync(corpusFile(target)), `${target} 的语料文件不存在`);
  }
  assert.throws(() => corpusFile('nope'), /未知 fuzz 目标/u);
});

test('语料条目逐条过形状校验，ID 全库唯一，同目标内签名不重复', () => {
  const all = loadAllFuzzCorpus();
  assert.ok(all.length >= 10, `全库只有 ${all.length} 条语料，回归面太薄`);

  const ids = new Set();
  for (const { target, entry } of all) {
    const problems = validateFuzzEntry(entry, target);
    assert.deepEqual(problems, [], `语料形状不合格：\n${problems.join('\n')}`);
    assert.equal(ids.has(entry.id), false, `语料 ID 重复：${entry.id}`);
    ids.add(entry.id);
  }

  for (const target of TARGETS) {
    const signatures = loadFuzzCorpus(target).map((e) => e.signature);
    assert.equal(
      new Set(signatures).size,
      signatures.length,
      `${target} 有重复签名：同一处触发留两条语料，回放两遍拿不到更多信息`,
    );
  }
});

test('validateFuzzEntry：逐项都能报出问题（不是永远返回空数组）', () => {
  const good = {
    id: 'FZ-SHQ-007', target: 'shq-roundtrip', signature: 's', input: { a: 1 }, origin: 'o',
  };
  assert.deepEqual(validateFuzzEntry(good, 'shq-roundtrip'), []);

  const cases = [
    [{ ...good, id: 'FZ-shq-007' }, /id 形状不符/u],
    [{ ...good, id: 'FZ-PROTO-007' }, /id 形状不符/u],
    [{ ...good, target: 'proto-roundtrip' }, /target 应为/u],
    [{ ...good, signature: '   ' }, /signature 必填/u],
    [{ ...good, input: undefined }, /input 必填/u],
    [{ ...good, origin: '' }, /origin 必填/u],
  ];
  for (const [entry, pattern] of cases) {
    const problems = validateFuzzEntry(entry, 'shq-roundtrip');
    assert.ok(problems.length > 0, `这条该被判不合格：${JSON.stringify(entry)}`);
    assert.match(problems.join('\n'), pattern);
  }
});

test('isJsonRoundTrippable：挡住回放不出原值的输入', () => {
  for (const value of [
    { a: 1 }, [1, 'x', null], 'str', 0, -0.5, false, null, [], {},
    { nested: [{ deep: ['x', null] }] }, Object.create(null),
  ]) {
    assert.equal(isJsonRoundTrippable(value), true, `该判可往返：${JSON.stringify(value)}`);
  }

  // 这一组的共性：JSON 会把它们**静静地**改写成合法值，所以「序列化两次比文本」
  // 一律放行——而回放出来的已经不是当初那个输入了。
  const lossy = [
    ['undefined', undefined],
    ['NaN（写成 null）', Number.NaN],
    ['Infinity（写成 null）', Infinity],
    ['函数', () => {}],
    ['Date（写成字符串）', new Date(0)],
    ['Map（写成 {}）', new Map([['a', 1]])],
    ['Set（写成 {}）', new Set([1])],
    ['带 undefined 值的键（整键消失）', { a: undefined }],
    ['嵌套里的 NaN', { a: [{ b: Number.NaN }] }],
    ['symbol 键（整键消失）', { [Symbol('s')]: 1 }],
    ['数组空洞（写成 null）', [1, , 3]], // eslint-disable-line no-sparse-arrays -- 就是要测空洞
    ['自带 toJSON 的对象', { toJSON: () => 1 }],
    ['BigInt（序列化直接抛）', 1n],
  ];
  for (const [why, value] of lossy) {
    assert.equal(isJsonRoundTrippable(value), false, `该判不可往返（${why}）`);
  }

  const cyclic = { a: 1 };
  cyclic.self = cyclic;
  assert.equal(isJsonRoundTrippable(cyclic), false, '循环引用该判不可往返，且不该抛');

  // 同一个对象出现在两个位置不是循环——别把 DAG 误杀成环
  const shared = { a: 1 };
  assert.equal(isJsonRoundTrippable({ x: shared, y: shared }), true, '共享子对象被误判成循环引用');
});

test('nextFuzzId：取最大号 + 1，不填补空洞（语料只增不改）', () => {
  assert.equal(nextFuzzId('shq-roundtrip', []), 'FZ-SHQ-001');
  assert.equal(
    nextFuzzId('shq-roundtrip', [{ id: 'FZ-SHQ-001' }, { id: 'FZ-SHQ-003' }]),
    'FZ-SHQ-004',
    '002 是被删掉的号，不许回收——回收会让历史记录里的 002 指向另一条语料',
  );
  assert.equal(nextFuzzId('http-body', [{ id: 'FZ-SHQ-009' }]), 'FZ-HTTP-001', '别的目标的号段不许影响本目标');
  assert.equal(nextFuzzId('machine-walk', [{ id: 'not-an-id' }, {}]), 'FZ-MACHINE-001');
});

// ── 沉淀管道 ────────────────────────────────────────────────────────────

test('parseFindings：坏行跳过（追加写被 Ctrl-C 打断会留半行）', () => {
  const text = [
    '{"target":"shq-roundtrip","signature":"a","input":1}',
    '',
    '{"target":"proto-rou',
    'null',
    '[1,2]',
    '"string"',
    '{"target":"http-body","signature":"b","input":2}',
  ].join('\n');
  const findings = parseFindings(text);
  assert.deepEqual(
    findings.map((f) => f.target),
    ['shq-roundtrip', 'http-body'],
    '半行、空行、null、数组、裸字符串都该跳过，别把它们当发现',
  );
});

const EMPTY_EXISTING = Object.freeze({
  fuzz: Object.fromEntries(TARGETS.map((t) => [t, []])),
  adversarial: Object.fromEntries(SURFACES.map((s) => [s, []])),
});

function finding(over = {}) {
  return {
    target: 'shq-roundtrip',
    signature: 'sig-a',
    class: 'assertion',
    injection: null,
    kind: 'generated',
    index: 3,
    seed: 111,
    rootSeed: 222,
    input: { words: ['x'] },
    message: '往返没还原',
    at: '2026-08-25T00:00:00.000Z',
    ...over,
  };
}

test('sinkPlan：同签名只入一条，不同签名各入一条', () => {
  const plan = sinkPlan([
    finding(),
    finding({ input: { words: ['另一个输入'] } }), // 同签名 → 同一处触发
    finding({ signature: 'sig-b' }),
  ], EMPTY_EXISTING);

  assert.deepEqual(plan.fuzz.map((f) => f.entry.id), ['FZ-SHQ-001', 'FZ-SHQ-002']);
  assert.deepEqual(plan.fuzz.map((f) => f.entry.signature), ['sig-a', 'sig-b']);
  assert.equal(plan.skipped.length, 1, '同签名的第二条该被跳过');
  assert.deepEqual(plan.rejected, []);
  assert.match(plan.fuzz[0].entry.origin, /种子 222\/#3（seed=111）/u, 'origin 要能顺着查回那一例');
});

test('sinkPlan：库里已有的签名不再重复入库', () => {
  const existing = {
    ...EMPTY_EXISTING,
    fuzz: { ...EMPTY_EXISTING.fuzz, 'shq-roundtrip': [{ id: 'FZ-SHQ-001', signature: 'sig-a' }] },
  };
  const plan = sinkPlan([finding(), finding({ signature: 'sig-new' })], existing);
  assert.deepEqual(plan.fuzz.map((f) => f.entry.id), ['FZ-SHQ-002'], '新签名接着 001 之后发号');
  assert.equal(plan.skipped.length, 1);
});

test('sinkPlan：形状不全的发现进 rejected 而不是被静静丢掉', () => {
  const plan = sinkPlan([
    finding({ target: 'no-such-target' }),
    finding({ signature: '' }),
    finding({ input: undefined, signature: 'sig-c' }),
  ], EMPTY_EXISTING);
  assert.deepEqual(plan.fuzz, []);
  assert.equal(plan.rejected.length, 3);
  assert.match(plan.rejected.map((r) => r.why).join('\n'), /未知目标/u);
  assert.match(plan.rejected.map((r) => r.why).join('\n'), /缺触发签名/u);
  assert.match(plan.rejected.map((r) => r.why).join('\n'), /缺 input/u);
});

test('sinkPlan：注入类同时转写攻击语料，且转写出来的条目能过 adversarial 形状校验', () => {
  const plan = sinkPlan([finding({
    target: 'proto-roundtrip',
    signature: 'sig-inj',
    class: 'injection',
    injection: {
      surface: 'launch-argv', entry: 'inject.extraArgs', payload: 'CANARY-x$(id)', canary: 'CANARY-x',
    },
    input: { extraArgs: ['CANARY-x$(id)'] },
  })], EMPTY_EXISTING);

  assert.equal(plan.adversarial.length, 1, '注入类必须留下一条攻击语料（RV-10）');
  const { surface, entry } = plan.adversarial[0];
  assert.equal(surface, 'launch-argv');
  assert.equal(entry.id, 'AV-ARGV-001');
  assert.deepEqual(entry.expect, { canary: 'single-quoted' });
  assert.deepEqual(validateEntry(entry, 'launch-argv'), [], '转写出来的语料自己不合格，入库即红');
});

test('adversarialEntryFor：非注入类不转写；转写不了的要说清原因', () => {
  const empty = new Map(SURFACES.map((s) => [s, []]));
  assert.equal(adversarialEntryFor(finding(), empty), null, '非注入类不该凭空造攻击语料');

  const bad = [
    [{ class: 'injection', injection: null }, /缺 injection 元信息/u],
    [{ class: 'injection', injection: { surface: 'nope', entry: 'x', canary: 'c' } }, /未知攻击面/u],
    [{ class: 'injection', injection: { surface: 'launch-argv', entry: '没登记', canary: 'c' } }, /没有构建调用/u],
    [{ class: 'injection', injection: { surface: 'launch-argv', entry: 'workdir', canary: "有'引号" } }, /不适合入库/u],
    [{ class: 'injection', injection: { surface: 'launch-argv', entry: 'workdir', canary: '' } }, /不适合入库/u],
  ];
  for (const [over, pattern] of bad) {
    const out = adversarialEntryFor(finding(over), empty);
    assert.equal(out.entry, null, `这条不该转写：${JSON.stringify(over)}`);
    assert.match(out.problem, pattern);
  }
});

test('攻击语料的号段与既有文件一致，注入点白名单与 runner 保持同步', () => {
  assert.deepEqual(Object.keys(SURFACE_PREFIX).sort(), [...SURFACES].sort(), '面与号段前缀表不同步');
  for (const surface of SURFACES) {
    const entries = loadCorpus(surface);
    const next = nextAdversarialId(surface, entries);
    assert.match(next, new RegExp(`^AV-${SURFACE_PREFIX[surface]}-\\d{3}$`, 'u'));
    assert.equal(entries.some((e) => e.id === next), false, `${surface} 发出了已被占用的号 ${next}`);
    // 现有条目的号段前缀必须与表一致，否则新号会跟历史号错开
    for (const entry of entries) {
      assert.match(entry.id, new RegExp(`^AV-${SURFACE_PREFIX[surface]}-\\d{3}$`, 'u'), `${entry.id} 不在 ${surface} 的号段里`);
    }
  }

  const runner = fs.readFileSync(path.join(ROOT, 'tests', 'adversarial', 'launch-argv.test.js'), 'utf8');
  const implemented = [...runner.matchAll(/^\s*case '([^']+)':/gmu)].map((m) => m[1]);
  assert.deepEqual(
    [...KNOWN_ARGV_ENTRIES].sort(),
    [...implemented].sort(),
    'fuzz-sink 的注入点白名单与 launch-argv runner 的 buildFor 不同步：转写出来的语料会空转',
  );
});
