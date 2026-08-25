/**
 * 金丝雀 oracle 自身的正反算例（harness 支柱 D）。
 *
 * 判据自己判错的方式只有一种：永远说「安全」。所以每条判据都要有反面算例——
 * 故意逃逸的正文必须判红，真实模板必须判绿。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { shq } from '../../src/lib/shq.js';
import {
  argvCanaryVerdict, canaryVerdict, locateCanary, scanShell,
} from './oracle.js';

const CANARY = 'dshc-canary';

test('scanShell：逐字符引用态与词/命令边界', () => {
  const { modes, words } = scanShell("echo 'a b'; ls -l \"$HOME\"");
  assert.equal(modes[6], 'single', "单引号内的 a 应为 single");
  assert.equal(modes[0], 'bare', 'echo 的 e 是裸露的');
  assert.deepEqual(words.map((w) => w.text), ['echo', 'a b', 'ls', '-l', '$HOME']);
  assert.deepEqual(words.map((w) => w.wordIndex), [0, 1, 0, 1, 2]);
  assert.deepEqual(words.map((w) => w.commandIndex), [0, 0, 1, 1, 1]);
});

test('scanShell：相邻的引用段是同一个词（workdirToken 的 "$HOME"\'/x\' 形态）', () => {
  const { words } = scanShell('cd -- "$HOME"\'/a b\'');
  assert.deepEqual(words.map((w) => w.text), ['cd', '--', '$HOME/a b']);
});

test('canaryVerdict：单引号内且非命令位 → 安全', () => {
  const body = `nohup env K=${shq(`x; touch /tmp/${CANARY}`)} dsh web --port 8899`;
  const verdict = canaryVerdict(body, CANARY);
  assert.equal(verdict.ok, true, verdict.reason ?? '');
  assert.equal(verdict.occurrences.length, 1);
  assert.equal(verdict.occurrences[0].mode, 'single');
});

test('canaryVerdict：裸露 → 逃逸（转义整个漏掉的形态）', () => {
  const body = `nohup env K=x; touch /tmp/${CANARY} dsh web --port 8899`;
  const verdict = canaryVerdict(body, CANARY);
  assert.equal(verdict.ok, false, '裸露的金丝雀居然被判安全');
  assert.match(verdict.reason, /bare/u);
});

test('canaryVerdict：双引号内 → 逃逸（$ 与反引号仍活着）', () => {
  const verdict = canaryVerdict(`LOG="/tmp/${CANARY}"`, CANARY);
  assert.equal(verdict.ok, false, '双引号不是保护');
  assert.match(verdict.reason, /double/u);
});

test('canaryVerdict：单引号但落在命令位 → 逃逸', () => {
  const verdict = canaryVerdict(`echo hi; '/tmp/${CANARY}' --arg`, CANARY);
  assert.equal(verdict.ok, false, '命令名被引号包着一样会执行');
  assert.match(verdict.reason, /命令位/u);
});

test('canaryVerdict：金丝雀根本没抵达 → 默认判红（语料空转也是缺陷）', () => {
  const verdict = canaryVerdict('echo hi', CANARY);
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /没有抵达/u);
  assert.equal(canaryVerdict('echo hi', CANARY, { requireOccurrence: false }).ok, true);
});

test('canaryVerdict：多次出现时任一处逃逸即整体判红', () => {
  const body = `env K=${shq(CANARY)} dsh web; touch /tmp/${CANARY}`;
  const verdict = canaryVerdict(body, CANARY);
  assert.equal(verdict.occurrences.length, 2);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.escapes.length, 1);
});

test('locateCanary：空金丝雀是调用方的错，直接抛', () => {
  assert.throws(() => locateCanary('x', ''), /金丝雀串不能为空/u);
});

test('argvCanaryVerdict：值位安全，argv[0] 与前导 - 判红', () => {
  const ok = argvCanaryVerdict(['ssh', '-o', 'BatchMode=yes', `host-${CANARY}`, 'sh -c x'], CANARY);
  assert.equal(ok.ok, true, ok.reason ?? '');

  const asCommand = argvCanaryVerdict([`${CANARY}-bin`, 'arg'], CANARY);
  assert.equal(asCommand.ok, false, 'argv[0] 就是要执行的程序');

  const asOption = argvCanaryVerdict(['ssh', `-oProxyCommand=${CANARY}`, 'host'], CANARY);
  assert.equal(asOption.ok, false, '前导 - 会被 ssh 当选项吃掉');

  const absent = argvCanaryVerdict(['ssh', 'host'], CANARY);
  assert.equal(absent.ok, false, '没抵达 argv 也算判据空转');
  assert.match(absent.reason, /没有抵达/u);
});
