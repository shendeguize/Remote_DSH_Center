/**
 * 目标 1：转义往返（`src/lib/shq.js` ↔ 真 `sh`）。
 *
 * 这是全仓最不能错的一条：远端脚本里每一个用户可控的值都从 `shq` 出来。它错一次，
 * 用户的 config 就成了远端的任意命令执行。
 *
 * 三层 oracle，越往后越硬：
 *   1. 逆函数往返   `unshq(shq(s)) === s`（垫片的解析器是协议的可执行规格）
 *   2. **真 sh 往返** 把 `shq(s)` 交给真的 `/bin/sh`，打回来的字节必须逐字等于 s，
 *      且必须恰好是**一个**词。没有比这更权威的判据了——POSIX 实现自己说的。
 *   3. 校验器的后果 每个 assertXxx 放行的值，必须真的不具备它要防的那种能力
 *      （不是「匹配那条正则」——那是把实现抄一遍，抄错了一起错）。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';

import {
  assertEnvKey, assertInt, assertSafeHost, assertSafeName, assertWorkdir,
  isWorkdirPath, shq, workdirToken,
} from '../../src/lib/shq.js';
import { COMMON_SSH_OPTS } from '../../src/lib/ssh.js';
import { argvCanaryVerdict, canaryVerdict } from '../adversarial/oracle.js';
import { unshq, unshqWorkdir } from '../harness/shell-word.js';
import { ALPHABETS } from './prng.js';
import { injectionFailure, runFuzzTarget } from './runner.js';

/**
 * 交给真 sh 的串里不许有这两类字符，原因与被测代码无关，是 argv 本身的边界：
 * NUL 是 C 字符串终止符，落单代理对不是合法标量值（转 UTF-8 时会被换成 U+FFFD）。
 * 它们仍然参与纯 JS 层的往返检查——只是没法让 sh 表态。
 */
const ARGV_FORBID = Object.freeze(['\u0000', '\ud800']);
const WORDS_PER_CASE = 8;
const REMOTE_HOME = '/root';

function gen(rng) {
  const words = [];
  for (let i = 0; i < WORDS_PER_CASE; i += 1) {
    words.push(rng.nasty({ min: 0, max: 20, forbid: ARGV_FORBID }));
  }
  return {
    words,
    // 这一条不进 sh，专门用来喂纯 JS 层：NUL 与落单代理都放进来
    jsOnly: rng.nasty({ min: 0, max: 20, nastyRate: 0.3 }),
    name: candidate(rng, ALPHABETS.safeName),
    envKey: candidate(rng, 'abcdefgABCDEFG_0123456789'),
    host: candidate(rng, ALPHABETS.safeName),
    workdir: workdirCandidate(rng),
    intish: intCandidate(rng),
  };
}

/** 四成从合法字符集里取（要走到放行分支），六成下毒（要走到拦截分支）。 */
function candidate(rng, legalAlphabet) {
  return rng.bool(0.4)
    ? rng.string({ min: 0, max: 12, alphabet: legalAlphabet })
    : rng.nasty({ min: 0, max: 12, forbid: ARGV_FORBID });
}

function workdirCandidate(rng) {
  const tail = rng.bool(0.5)
    ? rng.string({ min: 0, max: 10, alphabet: 'abc/._-' })
    : rng.nasty({ min: 0, max: 10, forbid: ARGV_FORBID });
  return rng.pickWeighted([
    [3, `/${tail}`],
    [2, `~/${tail}`],
    [1, '~'],
    [2, tail],
    [1, ''],
  ]);
}

function intCandidate(rng) {
  return rng.pickWeighted([
    [4, String(rng.int(0, 70_000))],
    [1, `0${rng.int(0, 999)}`], // 前导零：不许当成合法整数
    [1, rng.nasty({ min: 0, max: 6, forbid: ARGV_FORBID })],
    [1, ` ${rng.int(1, 100)} `],
    [1, String(rng.int(1, 100) * 1e12)],
  ]);
}

function check(input) {
  for (const word of input.words) roundTripInJs(word);
  roundTripInJs(input.jsOnly);
  roundTripInSh(input.words);

  checkSafeName(input.name);
  checkEnvKey(input.envKey);
  checkSafeHost(input.host);
  checkWorkdir(input.workdir);
  checkInt(input.intish);
}

/** 第 1 层：垫片的逆函数。 */
function roundTripInJs(s) {
  const quoted = shq(s);
  assert.equal(unshq(quoted), s, `unshq(shq(x)) 没还原：${JSON.stringify(s)} → ${JSON.stringify(quoted)}`);
  assert.ok(quoted.startsWith("'") && quoted.endsWith("'"), `shq 输出没被单引号包住：${JSON.stringify(quoted)}`);
  // 引号内不许出现落单的 '：那正是闭合逃逸的形状
  const inner = quoted.slice(1, -1);
  assert.equal(
    inner.split("'\\''").join('').includes("'"),
    false,
    `shq 输出里有未处理的单引号：${JSON.stringify(quoted)}`,
  );
}

/**
 * 第 2 层：真 sh 表态。一次 spawn 验一整批（八个词），把进程开销摊薄。
 *
 * 分隔标记不能与被测内容撞车，故由内容自身派生并断言不出现——真撞上了宁可红，
 * 也不要在一个「大概不会撞」的假设上写判据。
 */
function roundTripInSh(words) {
  const mark = `FZM${words.join('').length.toString(36)}${words.length}MZF`;
  for (const w of words) {
    assert.equal(w.includes(mark), false, `分隔标记与被测内容撞车了：${JSON.stringify(mark)}`);
  }

  const echoBack = words.map((w) => `printf '%s%s' ${shq(mark)} ${shq(w)}`).join('; ');
  const wordCounts = words.map((w) => `set -- ${shq(w)}; printf %s "$#"`).join('; ');
  const stdout = execFileSync('sh', ['-c', `${echoBack}; printf '%s' ${shq(mark)}; ${wordCounts}`], {
    encoding: 'utf8',
    maxBuffer: 1 << 20,
  });

  const parts = stdout.split(mark);
  assert.equal(parts.length, words.length + 2, `真 sh 的输出切不开：${JSON.stringify(stdout)}`);
  for (const [i, word] of words.entries()) {
    assert.equal(parts[i + 1], word, `真 sh 打回来的第 ${i} 个词变了：${JSON.stringify(word)}`);
  }
  assert.equal(
    parts[parts.length - 1],
    '1'.repeat(words.length),
    `有词在真 sh 里没保持成单个词（分词逃逸）：${JSON.stringify(words)}`,
  );

  // 第 3 层的一半：金丝雀必须落在单引号内且不在命令位
  for (const word of words) {
    if (word === '' || word.includes("'")) continue;
    const body = `printf '%s' ${shq(word)}`;
    const verdict = canaryVerdict(body, word);
    if (!verdict.ok) {
      throw injectionFailure(
        `shq 出来的值逃出了单引号：${verdict.reason}`,
        { surface: 'launch-argv', entry: 'inject.extraArgs', payload: word, canary: word },
      );
    }
  }
}

/**
 * 第 3 层：校验器的**后果**。
 * 不比对正则（那只是把实现抄一遍），而是断言放行的值真的不具备它要防的能力。
 */
function checkSafeName(name) {
  const outcome = attempt(() => assertSafeName(name));
  if (!outcome.ok) {
    assertRejection(outcome, `assertSafeName(${JSON.stringify(name)})`);
    return;
  }
  assert.equal(outcome.value, name, 'assertSafeName 放行时必须原样返回');
  // 远端名进的是 `"$HOME/.dsh_center_remote/<name>"`——双引号内，故这些字符一个都不许有
  for (const char of ['"', '$', '`', '\\', ' ', '\t', '\n', '/']) {
    assert.equal(
      name.includes(char),
      false,
      `assertSafeName 放行了含 ${JSON.stringify(char)} 的名字，它会在双引号里活过来：${JSON.stringify(name)}`,
    );
  }
  assert.equal(shq(name), `'${name}'`, '合法远端名不该需要任何转义');
  assert.equal(name.startsWith('-'), false, '合法远端名不许以 - 开头（会被当选项）');
  assert.equal(name.startsWith('.'), false, '合法远端名不许以 . 开头（隐藏文件 / .. 穿越）');
}

function checkEnvKey(key) {
  const outcome = attempt(() => assertEnvKey(key));
  if (!outcome.ok) {
    assertRejection(outcome, `assertEnvKey(${JSON.stringify(key)})`);
    return;
  }
  // 键名在 `env K='v'` 里处于引号**外**，转义救不了它，只能靠白名单
  for (const char of ['=', ' ', '\t', '\n', '$', '`', '"', "'", '\\', ';', '&', '|']) {
    assert.equal(
      key.includes(char),
      false,
      `assertEnvKey 放行了含 ${JSON.stringify(char)} 的键，它在引号外会生效：${JSON.stringify(key)}`,
    );
  }
  assert.equal(/^[A-Za-z_]/u.test(key), true, `环境变量名不许以非字母下划线开头：${JSON.stringify(key)}`);
}

function checkSafeHost(host) {
  const outcome = attempt(() => assertSafeHost(host));
  if (!outcome.ok) {
    assertRejection(outcome, `assertSafeHost(${JSON.stringify(host)})`);
    return;
  }
  // Host 名不经 shq，直接进 ssh 的 argv：不许成为选项，不许分裂成两个参数
  const argv = [...COMMON_SSH_OPTS, host, 'sh -c true'];
  const verdict = argvCanaryVerdict(argv, host);
  if (!verdict.ok) {
    throw injectionFailure(
      `Host 名逃进了 ssh 的参数位：${verdict.reason}`,
      { surface: 'launch-argv', entry: 'ssh.host', payload: host, canary: host },
    );
  }
  for (const char of [' ', '\t', '\n']) {
    assert.equal(host.includes(char), false, `Host 名不许含空白：${JSON.stringify(host)}`);
  }
}

function checkWorkdir(p) {
  const legal = isWorkdirPath(p);
  const outcome = attempt(() => assertWorkdir(p));
  assert.equal(outcome.ok, legal, `assertWorkdir 与 isWorkdirPath 判定不一致：${JSON.stringify(p)}`);
  if (!legal) {
    assertRejection(outcome, `assertWorkdir(${JSON.stringify(p)})`);
    return;
  }

  const token = workdirToken(p);
  const expanded = p === '~' || p.startsWith('~/') ? REMOTE_HOME + p.slice(1) : p;
  assert.equal(
    unshqWorkdir(token, REMOTE_HOME),
    expanded,
    `workdirToken 往返没还原：${JSON.stringify(p)} → ${JSON.stringify(token)}`,
  );
  // `cd -- <TOK>` 必须仍是三个词：token 分裂就等于把 cd 的参数拆了
  assert.equal(
    execFileSync('sh', ['-c', `set -- ${token}; printf %s "$#"`], { encoding: 'utf8' }),
    '1',
    `workdirToken 在真 sh 里不是单个词：${JSON.stringify(token)}`,
  );
}

function checkInt(raw) {
  const outcome = attempt(() => assertInt(raw, { min: 1, max: 65_535 }));
  if (!outcome.ok) {
    assertRejection(outcome, `assertInt(${JSON.stringify(raw)})`);
    return;
  }
  // 整数是**不转义**直接拼进脚本的，所以放行的值必须只剩 ASCII 数字
  assert.match(outcome.value, /^[0-9]+$/u, `assertInt 放行了非纯数字：${JSON.stringify(outcome.value)}`);
  const n = Number(outcome.value);
  assert.ok(n >= 1 && n <= 65_535, `assertInt 放行了越界值：${outcome.value}`);
}

function attempt(fn) {
  try {
    return { ok: true, value: fn(), error: null };
  } catch (error) {
    return { ok: false, value: null, error };
  }
}

/** 拒绝必须是「说人话的 VALIDATION」，不能是 TypeError 一类的意外崩。 */
function assertRejection(outcome, label) {
  assert.equal(outcome.error?.code, 'VALIDATION', `${label} 应以 VALIDATION 拒绝，实为 ${outcome.error?.code}`);
  assert.ok(
    typeof outcome.error.message === 'string' && outcome.error.message.length > 0,
    `${label} 的拒绝信息是空的`,
  );
}

test('fuzz：转义往返（unshq / 真 sh / 校验器后果）', async (t) => {
  const stats = await runFuzzTarget(t, {
    target: 'shq-roundtrip', gen, check, minCorpus: 1,
  });
  assert.ok(stats.corpus + stats.generated > 0, '一个例子都没跑');
});
