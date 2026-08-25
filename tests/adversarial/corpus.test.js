/**
 * 语料库自身的形状闸（harness 支柱 D）。
 *
 * 语料是数据，出错的方式很安静：id 撞号会让「永久回放」变成「悄悄替换」，
 * 忘写 origin 会让三个月后没人知道这条在防什么，canary 带单引号则整条语料空转。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { canaryOf, loadAll, loadCorpus, SURFACES, validateEntry } from './corpus.js';

test('每条语料形状合格（id / surface / entry / payload / expect / origin）', () => {
  const problems = [];
  for (const surface of SURFACES) {
    for (const entry of loadCorpus(surface)) {
      problems.push(...validateEntry(entry, surface));
    }
  }
  assert.deepEqual(problems, [], `语料形状不合格：\n${problems.join('\n')}`);
});

test('id 全库唯一且只增不改（撞号等于悄悄替换掉一条回归）', () => {
  const seen = new Map();
  const duplicates = [];
  for (const { surface, entry } of loadAll()) {
    if (seen.has(entry.id)) duplicates.push(`${entry.id}（${seen.get(entry.id)} 与 ${surface}）`);
    else seen.set(entry.id, surface);
  }
  assert.deepEqual(duplicates, [], `id 撞号：${duplicates.join('、')}`);
});

test('语料规模不许缩水：三个面合计 ≥30 条，每面 ≥8 条', () => {
  const counts = Object.fromEntries(SURFACES.map((s) => [s, loadCorpus(s).length]));
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  for (const [surface, n] of Object.entries(counts)) {
    assert.ok(n >= 8, `${surface} 只有 ${n} 条语料，少于下限 8（删语料要先改设计）`);
  }
  assert.ok(total >= 30, `语料合计 ${total} 条，少于下限 30；实际分布 ${JSON.stringify(counts)}`);
});

test('canary 语料确实带得动金丝雀（是 payload 子串、无单引号）', () => {
  let tracked = 0;
  for (const { entry } of loadAll()) {
    const canary = canaryOf(entry);
    if (canary === null) continue;
    tracked += 1;
    assert.equal(canary.includes("'"), false, `${entry.id} 的 canary 含单引号`);
  }
  assert.ok(tracked >= 12, `带金丝雀的语料只有 ${tracked} 条，追踪面太窄`);
});
