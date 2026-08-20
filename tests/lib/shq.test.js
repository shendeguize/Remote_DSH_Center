import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  shq, assertEnvKey, assertSafeName, assertSafeHost, assertInt, assertWorkdir, isWorkdirPath, workdirToken,
} from '../../src/lib/shq.js';
import { DshError } from '../../src/lib/errors.js';

const run = promisify(execFile);

/** 12 §2.2 用例表（输入 → 期望 shq 输出）。 */
const CASES = [
  ['abc', "'abc'"],
  ['a b  c', "'a b  c'"],
  ["it's", "'it'\\''s'"],
  ["'", "''\\'''"],
  ["''", "''\\'''\\'''"],
  ['a$HOME', "'a$HOME'"],
  ['`whoami`', "'`whoami`'"],
  ['x; rm -rf ~', "'x; rm -rf ~'"],
  ['a\nb', "'a\nb'"],
  ['深度求索/模型 v2', "'深度求索/模型 v2'"],
  ['', "''"],
  ['--port 9999', "'--port 9999'"],
];

test('12 §2.2 转义用例表逐条一致', () => {
  for (const [input, expected] of CASES) {
    assert.equal(shq(input), expected, `输入 ${JSON.stringify(input)}`);
  }
});

test('本机 sh -c 回显逐字等值（双层包装算例，12 §2.5）', async () => {
  for (const [input] of CASES) {
    const body = `printf '%s' ${shq(input)}`;
    const { stdout } = await run('sh', ['-c', body]);
    assert.equal(stdout, input, `sh 回显应还原 ${JSON.stringify(input)}`);
  }
});

test('双层包装：body 整体再 shq 一次交给 sh -c 仍逐字还原', async () => {
  const value = "hi 'there' $HOME\n第二行";
  const body = `printf '%s' ${shq(value)}`;
  const { stdout } = await run('sh', ['-c', `sh -c ${shq(body)}`]);
  assert.equal(stdout, value);
});

test('shq 拒绝非字符串', () => {
  assert.throws(() => shq(42), DshError);
});

test('assertEnvKey 白名单', () => {
  for (const ok of ['PATH', '_x', 'A1_b']) assert.equal(assertEnvKey(ok), ok);
  for (const bad of ['1A', 'a-b', 'a b', '', 'K=V', 'é']) {
    assert.throws(() => assertEnvKey(bad), (e) => e.code === 'VALIDATION');
  }
});

test('assertSafeName 拒绝空格/引号/前导 - 与 .', () => {
  for (const ok of ['web-8899.log', 'a_b.c-1', '3f9c0d12ab34-a.yml']) {
    assert.equal(assertSafeName(ok), ok);
  }
  for (const bad of ['-x', '.hidden', 'a b', "a'b", 'a/b', '', 'a;b']) {
    assert.throws(() => assertSafeName(bad), (e) => e.code === 'VALIDATION');
  }
});

test('assertSafeHost 拒绝以 - 开头（ssh 参数位注入，12 §2.4）', () => {
  assert.equal(assertSafeHost('gpu-node-1'), 'gpu-node-1');
  for (const bad of ['-oProxyCommand=x', 'a b', 'a:b', '']) {
    assert.throws(() => assertSafeHost(bad), (e) => e.code === 'VALIDATION');
  }
});

test('assertWorkdir 只收绝对路径与 ~ 形态（补丁 01 §4.1）', () => {
  const good = ['/', '/root', '/root/proj', '/a b/c', "/it's", '~', '~/proj', '~/a b', '/深度求索/模型'];
  for (const p of good) {
    assert.equal(isWorkdirPath(p), true, `应通过：${JSON.stringify(p)}`);
    assert.equal(assertWorkdir(p), p);
  }

  const bad = ['', 'proj', './proj', '../up', '~user/proj', '~~', '/a\nb', '/a\0b', '/a\rb', 42, null, undefined];
  for (const p of bad) {
    assert.equal(isWorkdirPath(p), false, `应拒绝：${JSON.stringify(p)}`);
    assert.throws(() => assertWorkdir(p), (e) => e.code === 'VALIDATION');
  }
});

test('workdirToken：~ 走 "$HOME" 相邻拼接，绝对路径走单引号', () => {
  assert.equal(workdirToken('/root/proj'), "'/root/proj'");
  assert.equal(workdirToken('/a b'), "'/a b'");
  assert.equal(workdirToken("/it's"), "'/it'\\''s'");
  assert.equal(workdirToken('~'), '"$HOME"');
  assert.equal(workdirToken('~/proj'), '"$HOME"\'/proj\'');
  assert.equal(workdirToken('~/a b'), '"$HOME"\'/a b\'');
  assert.throws(() => workdirToken('proj'), (e) => e.code === 'VALIDATION');
});

test('workdirToken 在真实 sh 下还原为单个词', async () => {
  for (const [wd, expected] of [['/a b', '/a b'], ["/it's", "/it's"], ['~/x y', '/home/t/x y'], ['~', '/home/t']]) {
    // $# 验证「单个词」：分词错了会变成 2
    const { stdout } = await run('sh', ['-c', `set -- ${workdirToken(wd)}; printf '%s|%s' "$#" "$1"`], {
      env: { ...process.env, HOME: '/home/t' },
    });
    assert.equal(stdout, `1|${expected}`, `输入 ${wd}`);
  }
});

test('assertInt 严格校验并支持 --port 0 的字面零', () => {
  assert.equal(assertInt(8899), '8899');
  assert.equal(assertInt('0', { allowZero: true }), '0');
  assert.throws(() => assertInt('0'), DshError);
  assert.throws(() => assertInt('08'), DshError);
  assert.throws(() => assertInt('8899; rm -rf /'), DshError);
  assert.throws(() => assertInt(70000), DshError);
  assert.throws(() => assertInt(-1), DshError);
});
