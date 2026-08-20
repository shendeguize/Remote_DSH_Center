import test from 'node:test';
import assert from 'node:assert/strict';

import { PHASES, TRANSITIONS, canTransition, assertTransition } from '../../src/lib/machine.js';
import { DshError } from '../../src/lib/errors.js';

test('8×8 全组合与 §2.1 迁移表一致（快照）', () => {
  const matrix = {};
  for (const from of PHASES) {
    matrix[from] = PHASES.filter((to) => canTransition(from, to));
  }

  assert.deepEqual(matrix, {
    unknown: ['unknown', 'unreachable', 'no_dsh', 'ready'],
    unreachable: ['unreachable', 'no_dsh', 'ready'],
    no_dsh: ['unreachable', 'no_dsh', 'ready'],
    ready: ['unreachable', 'no_dsh', 'ready', 'starting'],
    starting: ['ready', 'starting', 'running'],
    running: ['ready', 'running', 'degraded', 'crashed'],
    degraded: ['ready', 'running', 'degraded', 'crashed'],
    crashed: ['unreachable', 'no_dsh', 'ready', 'starting', 'crashed'],
  });
});

test('自环恒许可（不查表，只刷新数据）', () => {
  for (const p of PHASES) {
    assert.equal(canTransition(p, p), true, `${p} 自环应许可`);
  }
  // starting/running/degraded 的自环不在表里，仍应许可——证明自环走的是短路分支
  for (const p of ['starting', 'running', 'degraded', 'unknown']) {
    assert.ok(!(TRANSITIONS[p] ?? []).includes(p));
    assert.equal(canTransition(p, p), true);
  }
});

test('02 行为要求的补全迁移全部合法', () => {
  assert.ok(canTransition('crashed', 'starting'), '02 §3.2 允许从 crashed 拉起视作重启');
  assert.ok(canTransition('starting', 'ready'), '02 §3.2 第 5 步失败回滚');
  assert.ok(canTransition('degraded', 'crashed'), '02 §3.3 重连前复核发现远端已死');
  assert.ok(canTransition('running', 'ready'), '02 §3.5 stop 完成');
  assert.ok(canTransition('degraded', 'ready'), 'degraded 也允许关停');
});

test('未知 phase 与非法迁移都判否', () => {
  assert.equal(canTransition('bogus', 'ready'), false);
  assert.equal(canTransition('ready', 'bogus'), false);
  assert.equal(canTransition('unknown', 'running'), false);
  assert.equal(canTransition('starting', 'crashed'), false);
});

test('assertTransition 抛 DshError 且带合法目标提示', () => {
  assert.equal(assertTransition('ready', 'starting', 'api.start'), 'starting');
  assert.throws(
    () => assertTransition('unknown', 'running', 'test'),
    (err) => {
      assert.ok(err instanceof DshError);
      assert.equal(err.code, 'STATE_ILLEGAL_TRANSITION');
      assert.equal(err.httpStatus, 500);
      assert.match(err.message, /unknown → running/);
      assert.match(err.detail, /unreachable, no_dsh, ready/);
      return true;
    },
  );
});
