/**
 * 主机名白/黑名单：锚定语义、黑名单优先、以及「用户正则不许把 manager 卡死」。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  checkHostPattern, compileHostFilter, hostFilterReason, HOST_FILTER_LIMITS,
} from '../../src/lib/host-filter.js';
import { DshError } from '../../src/lib/errors.js';
import { FACTORY_DEFAULTS } from '../../src/defaults.js';
import { mulberry32 } from '../fuzz/prng.js';

/**
 * 计时断言的上限。
 *
 * 健康的匹配是微秒级，被漏放的回溯炸弹是秒到分钟级（`(a{2,4})+` 实测 144 秒），
 * 中间差六个数量级，所以这里取一个很宽的秒级阈值：既照样抓得住漏网的形状，也不会
 * 因为覆盖率插桩 + 几十个测试文件并行争 CPU 而随机变红。计时只是形态判定的兜底，
 * 真正的闸门是 checkHostPattern 的静态判形。
 */
const TIMING_CEILING_MS = 2_000;

/** 出厂名单的家在出厂表里（defaults.js 必须零依赖，故名单不放 lib）。 */
const FACTORY_HOST_DENY = FACTORY_DEFAULTS.defaults.hostFilter.deny;

test('整串锚定：半截命中不算命中', () => {
  const f = compileHostFilter({ deny: ['git.*'] });
  for (const name of ['git.neodrive.neolix.net', 'github.com', 'gitlab-runner', 'git']) {
    assert.deepEqual(f.match(name), { rule: 'deny', pattern: 'git.*' }, `${name} 应被挡下`);
  }
  for (const name of ['mygit-box', 'legit', 'GPU_Node_git_x'.replace('git_x', 'a')]) {
    assert.equal(f.match(name), null, `${name} 只是名字里带 git，不该被挡`);
  }
});

test('忽略大小写：GitHub.com 与 github.com 是同一个地方', () => {
  const f = compileHostFilter({ deny: ['github\\.com'] });
  assert.deepEqual(f.match('GitHub.com'), { rule: 'deny', pattern: 'github\\.com' });
  assert.deepEqual(f.match('GITHUB.COM'), { rule: 'deny', pattern: 'github\\.com' });
});

test('白名单非空即「只认这些」，黑名单优先', () => {
  const onlyGpu = compileHostFilter({ allow: ['GPU_.*', 'CPU_.*'] });
  assert.equal(onlyGpu.match('GPU_Node_a100'), null);
  assert.equal(onlyGpu.match('CPU_Node_30v'), null);
  assert.deepEqual(onlyGpu.match('jps'), { rule: 'allow', pattern: 'GPU_.*' },
    '白名单没放它进来，要报出白名单这条规则');

  const both = compileHostFilter({ allow: ['.*'], deny: ['github\\.com'] });
  assert.deepEqual(both.match('github.com'), { rule: 'deny', pattern: 'github\\.com' },
    '同时命中按黑名单算');
  assert.equal(both.match('gpu-1'), null);
});

test('空名单放行一切；缺字段等同空名单', () => {
  assert.equal(compileHostFilter({}).match('anything'), null);
  assert.equal(compileHostFilter().match('anything'), null);
  assert.equal(compileHostFilter({ allow: [], deny: [] }).match('anything'), null);
});

test('出厂黑名单挡住代码托管入口，放过算力机', () => {
  const f = compileHostFilter({ deny: [...FACTORY_HOST_DENY] });
  for (const name of [
    'git.neodrive.neolix.net', 'github.com', 'gitlab.example.com', 'gitee.com',
    'bitbucket.org', 'ssh.dev.azure.com', 'myrepo.git',
  ]) {
    assert.ok(f.match(name), `${name} 应在出厂黑名单内`);
  }
  for (const name of [
    'GPU_Node_jiangyue_a100-80g-pfs', 'CPU_Node_jiangyue_30v120g-pfs', 'jps',
    'jiangyue-CPU-pfs-6012-lse_sim_executor', 'YANGdeMac-mini.local', 'digital-twin',
  ]) {
    assert.equal(f.match(name), null, `${name} 是算力机/本机，出厂名单不该碰它`);
  }
});

test('非法名单直接 VALIDATION，不静默丢规则', () => {
  const cases = [
    [{ deny: ['('] }, /不是合法正则/],
    [{ deny: [''] }, /不得为空串/],
    [{ deny: ['a\nb'] }, /控制字符/],
    [{ deny: ['x'.repeat(HOST_FILTER_LIMITS.maxPatternLength + 1)] }, /长度须/],
    [{ deny: Array.from({ length: HOST_FILTER_LIMITS.maxPatterns + 1 }, () => 'x') }, /最多/],
    [{ deny: [42] }, /须为字符串/],
    [{ deny: 'git.*' }, /须为数组/],
  ];
  for (const [filter, re] of cases) {
    assert.throws(() => compileHostFilter(filter), (err) => {
      assert.ok(err instanceof DshError);
      assert.equal(err.code, 'VALIDATION');
      assert.match(err.message, re);
      return true;
    }, JSON.stringify(filter));
  }
});

test('嵌套量词当场拒收：拿它当规则等于让保存配置卡死 manager', () => {
  // 判形必须在「跑一遍」之前完成：跑 (a+)+$ 撞 64 个 a 就是那次卡死本身
  for (const bad of [
    '(a+)+', '([a-z]*)*', '(x|xx)+', '((a+))+', '(a*)+', '(a+){2,}', '(\\d+)*',
    // 有界但变长的内层同样致命：(a{2,4})+ 实测跑到 144 秒
    '(a{2,4})+', '(ab?)+', '(a?)+', '(?:a{1,3})*',
    // 外层有界也救不了：(a+){12} 是 C(63,11)≈10^12 步
    '(a+){12}', '(x|xx){8}', '(a+){2,4}',
  ]) {
    assert.match(checkHostPattern(bad) ?? '', /嵌套量词/, bad);
  }
  // 主机名用得上的写法一条都不许被误伤
  for (const good of [
    'git.*', 'github\\.com', '.*\\.git', '(gitlab|github)\\..*', 'gpu-[0-9]+',
    'GPU_Node_.*-pfs', '.*', 'a{2,4}', '(foo)?bar.*', '[a-z]+\\.[a-z]+',
    // 定长内层每步只有一种解释；(?:…) 的 ? 是组前缀不是量词；重复上限 1 不产生组合
    '(a{2})+', '(?:gitlab|github)\\..*', '(git\\..*)?', '(a+)?', 'host\\{1\\}',
    ...FACTORY_HOST_DENY,
  ]) {
    assert.equal(checkHostPattern(good), null, good);
  }
});

test('灾难性回溯的形状在编译前就被挡住（走到匹配就来不及了）', () => {
  const bomb = '(a+)+$';
  assert.throws(() => compileHostFilter({ deny: [bomb] }), /嵌套量词/);

  // 反证：若把它放过去，一次 match 的代价就不是毫秒量级——这里只验规则确实没被编译进去。
  // 阈值故意放到秒级：健康与爆炸之间差六个数量级，收紧只会让闸门在满载的跑测机上乱红。
  const safe = compileHostFilter({ deny: ['a+'] });
  const started = process.hrtime.bigint();
  safe.match(`${'a'.repeat(64)}!`);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(elapsedMs < TIMING_CEILING_MS, `放行的规则匹配应是微秒级，实测 ${elapsedMs}ms`);
});

test('判定原因给人话', () => {
  assert.equal(hostFilterReason(null), null);
  assert.equal(hostFilterReason({ rule: 'deny', pattern: 'git\\..*' }), '命中黑名单 git\\..*');
  assert.match(hostFilterReason({ rule: 'allow', pattern: 'GPU_.*' }), /不在白名单内/);
});

test('性质：凡是被放行的正则，撞上最坏形状的主机名也只花微秒（ReDoS 守卫真的成立）', () => {
  // 固定种子：探新是 cron fuzz 的活，日常闸门要确定性
  const rng = mulberry32(20_260_903);
  const pieces = [
    'a', 'git', '\\.', '.*', '.+', '[a-z]', '[a-z]*', '[0-9]+', '(a|b)', '(git|hub)',
    'x?', 'a{2,4}', 'a{2}', 'b{1,3}', '_', '-', '\\d', '\\w', '(?:ab)', '$', '^',
  ];
  /** 外层怎么重复分组：无界与有界都要试，(a+){12} 那类只有有界外层才构造得出 */
  const wraps = ['*', '+', '?', '{2,4}', '{8}', '{2,}'];
  // 灾难性回溯要靠「长的同质串 + 末尾一个不匹配的字符」才炸得出来
  const victims = [
    'a'.repeat(32), `${'a'.repeat(32)}!`, `${'git.'.repeat(8)}!`,
    `${'a-b.'.repeat(8)}!`, 'GPU_Node_jiangyue_a100-80g-pfs',
  ];

  let accepted = 0;
  for (let i = 0; i < 4_000; i += 1) {
    let source = '';
    const parts = 1 + Math.floor(rng() * 6);
    for (let p = 0; p < parts; p += 1) {
      source += pieces[Math.floor(rng() * pieces.length)];
      if (rng() < 0.25) source = `(${source})${wraps[Math.floor(rng() * wraps.length)]}`;
    }
    if (checkHostPattern(source) !== null) continue;
    accepted += 1;

    const filter = compileHostFilter({ deny: [source] });
    const started = process.hrtime.bigint();
    for (const victim of victims) filter.match(victim);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    assert.ok(
      elapsedMs < TIMING_CEILING_MS,
      `放行的规则 ${JSON.stringify(source)} 匹配耗时 ${elapsedMs}ms——判形漏了一种回溯形状`,
    );
  }
  assert.ok(accepted > 500, `样本太少（只放行了 ${accepted} 条），这轮等于没测`);
});
