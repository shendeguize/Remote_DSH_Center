/**
 * 有界并发闸（issue #85）：语义要与 Promise.allSettled 对齐，只多一条「同时在飞不超上限」。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createGate, mapPool } from '../../src/lib/pool.js';

// 不 unref：这些定时器就是本用例仅有的「还有事要做」，unref 掉进程会当场收摊
const tick = (ms = 5) => new Promise((r) => { setTimeout(r, ms); });

/** 跑一遍并记下真实峰值。 */
async function runWithWitness(items, limit, fn) {
  let live = 0;
  let peak = 0;
  const results = await mapPool(items, async (item, i) => {
    live += 1;
    peak = Math.max(peak, live);
    try {
      return await fn(item, i);
    } finally {
      live -= 1;
    }
  }, limit);
  return { results, peak };
}

test('同时在飞不超上限', async () => {
  const items = Array.from({ length: 24 }, (_, i) => i);
  const { peak } = await runWithWitness(items, 6, () => tick(10));
  assert.equal(peak, 6, `峰值 ${peak}，上限是 6`);
});

test('上限比任务多、为 0、为负：都等价于全并发（不许卡住）', async () => {
  const items = [1, 2, 3];
  for (const limit of [99, 0, -1]) {
    // eslint-disable-next-line no-await-in-loop -- 三个取值顺序验
    const { peak, results } = await runWithWitness(items, limit, () => tick(10));
    assert.equal(peak, 3, `limit=${limit} 应全并发`);
    assert.equal(results.length, 3);
  }
});

test('结果按入参顺序，不按完成顺序', async () => {
  const delays = [30, 1, 20, 2];
  const results = await mapPool(delays, async (ms, i) => {
    await tick(ms);
    return i;
  }, 2);
  assert.deepEqual(results.map((r) => r.value), [0, 1, 2, 3]);
});

test('单个任务抛错不牵连其余：形状与 allSettled 一致', async () => {
  const results = await mapPool([1, 2, 3, 4], async (n) => {
    await tick(1);
    if (n % 2 === 0) throw new Error(`第 ${n} 个炸了`);
    return n * 10;
  }, 2);

  assert.deepEqual(results.map((r) => r.status), ['fulfilled', 'rejected', 'fulfilled', 'rejected']);
  assert.equal(results[0].value, 10);
  assert.equal(results[1].reason.message, '第 2 个炸了');
  assert.equal(results[2].value, 30);
});

test('抛错的那一格空出来照样接着排（不许因为异常少跑任务）', async () => {
  const seen = [];
  const items = Array.from({ length: 10 }, (_, i) => i);
  const results = await mapPool(items, async (i) => {
    seen.push(i);
    await tick(1);
    if (i < 4) throw new Error('前四个都炸');
    return i;
  }, 2);

  assert.deepEqual(seen.sort((a, b) => a - b), items, '每个任务都要被跑到');
  assert.equal(results.filter((r) => r.status === 'rejected').length, 4);
});

test('空清单：立刻返回空数组，不去 spawn 任何 worker', async () => {
  let called = 0;
  const results = await mapPool([], async () => { called += 1; }, 6);
  assert.deepEqual(results, []);
  assert.equal(called, 0);
});

test('同步抛出的任务也算 rejected（不许直接把 mapPool 掀了）', async () => {
  const results = await mapPool([1], () => { throw new Error('同步就炸'); }, 6);
  assert.equal(results[0].status, 'rejected');
  assert.equal(results[0].reason.message, '同步就炸');
});

// ── createGate：长期在那儿的那道闸（issue #100） ──────────────────────────

test('createGate：同时进去的不超过上限', async () => {
  const gate = createGate(3);
  let live = 0;
  let peak = 0;
  await Promise.all(Array.from({ length: 20 }, () => gate.run(async () => {
    live += 1;
    peak = Math.max(peak, live);
    await new Promise((r) => { setTimeout(r, 5); });
    live -= 1;
  })));
  assert.equal(peak, 3);
  assert.deepEqual(gate.stats(), { inFlight: 0, waiting: 0 }, '收场后闸里不许还挂着人');
});

test('createGate：先到先走，不许把前面的饿死', async () => {
  const gate = createGate(1);
  const order = [];
  const jobs = [1, 2, 3, 4].map((i) => gate.run(async () => {
    order.push(i);
    await new Promise((r) => { setTimeout(r, 2); });
  }));
  await Promise.all(jobs);
  assert.deepEqual(order, [1, 2, 3, 4]);
});

test('createGate：里面抛错也要把位置还回来（否则一次失败就永久少一个名额）', async () => {
  const gate = createGate(1);
  await assert.rejects(() => gate.run(async () => { throw new Error('boom'); }), /boom/);
  assert.equal(gate.stats().inFlight, 0);
  assert.equal(await gate.run(async () => 'ok'), 'ok');
});

test('createGate：limit<=0 等于不设闸', async () => {
  const gate = createGate(0);
  let live = 0;
  let peak = 0;
  await Promise.all(Array.from({ length: 8 }, () => gate.run(async () => {
    live += 1;
    peak = Math.max(peak, live);
    await new Promise((r) => { setTimeout(r, 2); });
    live -= 1;
  })));
  assert.equal(peak, 8);
});
