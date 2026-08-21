/**
 * 单调钟（issue #104）：所有上界与窗口都拿它当尺，故它必须不受系统时间摆布。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { monotonicMs } from '../../src/lib/clock.js';

test('单调钟不受墙钟摆布：Date.now 被换掉也照样只往前走', (t) => {
  const before = monotonicMs();

  // 模拟一次 NTP 回拨：整个进程看到的墙钟往后退一小时
  t.mock.method(Date, 'now', () => 0);
  const mid = monotonicMs();
  t.mock.method(Date, 'now', () => -3_600_000);
  const after = monotonicMs();

  assert.ok(mid >= before, `墙钟归零后单调钟不该倒退：${before} → ${mid}`);
  assert.ok(after >= mid, `墙钟回拨后单调钟不该倒退：${mid} → ${after}`);
});

test('单调钟量的是真实流逝：睡 60ms 就该看到约 60ms', async () => {
  const t0 = monotonicMs();
  await new Promise((r) => { setTimeout(r, 60); });
  const elapsed = monotonicMs() - t0;

  assert.ok(elapsed >= 50, `至少该有 50ms，实际 ${elapsed}ms`);
  assert.ok(elapsed < 2_000, `不该离谱地大，实际 ${elapsed}ms`);
});

test('绝对值无意义，但同一进程内取两次的差可用', () => {
  const a = monotonicMs();
  const b = monotonicMs();
  assert.equal(typeof a, 'number');
  assert.ok(Number.isFinite(a));
  assert.ok(b >= a);
});
