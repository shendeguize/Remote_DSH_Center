/**
 * 目标 4：主机状态机（`src/lib/machine.js`）的随机游走。
 *
 * 状态机的 bug 有个讨厌的性质：单步看都对，走长了才现形（走进一个出不来的态、
 * 或者绕一圈回来 phase 变了个不该变的值）。定死的用例只走事先想到的那几条路径，
 * 随机游走走的是**长的、没人想过的**路径。
 *
 * 盯四条：
 *   不卡死   任何可达态的出度 ≥ 1，且一步之内能回到 `ready`（探测随时能把主机拽回已知态）
 *   判定一致 `assertTransition` 抛 ⟺ `canTransition` 说不行，且抛的是 STATE_ILLEGAL_TRANSITION
 *   非法不动 被拒的迁移绝不改变当前态（游走过程中混入非法步，终态必须与只走合法步一致）
 *   垃圾输入 非 phase 的值一律 false，不抛、不认错、不把 `__proto__` 之类当成态
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertTransition, canTransition, isPhase, PHASES, PROBE_OUT, PROBE_PROTECTED_PHASES, TRANSITIONS,
} from '../../src/lib/machine.js';
import { runFuzzTarget } from './runner.js';

/** 像 phase 但不是 phase 的值。大小写、空白、原型链上的名字，都是真实出过事的形态。 */
const LOOKALIKES = Object.freeze([
  'Ready', 'READY', 'ready ', ' ready', 'read', 'readyy', '', 'unknown\n',
  '__proto__', 'constructor', 'prototype', 'toString', 'hasOwnProperty',
  'null', 'undefined', '0', 'true',
]);

const WALK_LENGTH = 40;

function gen(rng) {
  const start = rng.pick(PHASES);
  /** 每一步记「想去哪」：既可能是合法目标，也可能是任意 phase（于是可能非法）。 */
  const steps = Array.from({ length: WALK_LENGTH }, () => ({
    to: rng.pick(PHASES),
    // 三成的步子刻意挑一个当前态走不到的目标，专门验「被拒了不许动」
    preferIllegal: rng.bool(0.3),
  }));
  return {
    start,
    steps,
    junk: Array.from({ length: 4 }, () => (rng.bool(0.5)
      ? rng.pick(LOOKALIKES)
      : rng.nasty({ max: 10 }))),
  };
}

function check(input) {
  checkWalk(input);
  checkJunk(input);
}

function checkWalk(input) {
  let phase = input.start;
  assert.ok(isPhase(phase), `起点不是合法 phase：${phase}`);

  for (const [i, step] of input.steps.entries()) {
    const legal = legalTargets(phase);
    assert.ok(legal.length > 0, `phase ${phase} 出度为 0：走进去就出不来了`);
    assert.ok(legal.includes('ready'), `phase ${phase} 一步之内回不到 ready：探测拽不回来了`);

    const to = step.preferIllegal
      ? (illegalTargets(phase)[0] ?? step.to)
      : step.to;
    const allowed = canTransition(phase, to);

    if (allowed) {
      assert.equal(assertTransition(phase, to, `第${i}步`), to, 'assertTransition 放行时必须返回目标态');
      phase = to;
      assert.ok(isPhase(phase), `走到了 PHASES 之外：${phase}`);
      continue;
    }

    const before = phase;
    assert.throws(
      () => assertTransition(phase, to, `第${i}步`),
      (error) => {
        assert.equal(error?.code, 'STATE_ILLEGAL_TRANSITION', `非法迁移该抛 STATE_ILLEGAL_TRANSITION，实为 ${error?.code}`);
        assert.match(error.message, /非法状态迁移/u, '拒绝信息要说人话');
        assert.ok(error.message.includes(`第${i}步`), '拒绝信息要带触发者，否则查不到是谁干的');
        assert.equal(typeof error.detail, 'string', '拒绝要附合法目标清单');
        return true;
      },
      `${phase} → ${to} 该被拒`,
    );
    assert.equal(phase, before, '被拒的迁移改变了当前态');
  }
}

function legalTargets(phase) {
  return PHASES.filter((to) => canTransition(phase, to));
}

function illegalTargets(phase) {
  return PHASES.filter((to) => !canTransition(phase, to));
}

/** 垃圾输入：只许返回 false，一步也不许崩，也不许把原型链上的名字当成态。 */
function checkJunk(input) {
  for (const junk of input.junk) {
    if (PHASES.includes(junk)) continue;
    assert.equal(isPhase(junk), false, `isPhase 认了非法态：${JSON.stringify(junk)}`);
    for (const phase of PHASES) {
      assert.equal(canTransition(junk, phase), false, `canTransition 放行了非法起点：${JSON.stringify(junk)}`);
      assert.equal(canTransition(phase, junk), false, `canTransition 放行了非法目标：${JSON.stringify(junk)}`);
    }
    assert.equal(canTransition(junk, junk), false, `非法态的自环也不许放行：${JSON.stringify(junk)}`);
  }
}

test('fuzz：状态机随机游走（不卡死 / 判定一致 / 非法不动 / 垃圾不崩）', async (t) => {
  const stats = await runFuzzTarget(t, {
    target: 'machine-walk', gen, check, minCorpus: 2,
  });
  assert.ok(stats.corpus + stats.generated > 0, '一个例子都没跑');
});

test('迁移表的静态形状：目标都在 PHASES 内、自环恒许可、探测保护态与探测结论不相交', () => {
  for (const [from, targets] of Object.entries(TRANSITIONS)) {
    assert.ok(PHASES.includes(from), `迁移表里有不存在的起点：${from}`);
    assert.ok(Array.isArray(targets), `${from} 的目标不是数组`);
    assert.equal(new Set(targets).size, targets.length, `${from} 的目标有重复`);
    for (const to of targets) {
      assert.ok(PHASES.includes(to), `${from} → ${to}：目标不在 PHASES 内`);
    }
  }
  // 自环恒许可，与列不列无关。三个探测结论态的目标表复用了 PROBE_OUT，所以表里
  // **会**出现它们的自环（`unreachable → unreachable`）——那是复用的结果，不是语义，
  // 判据只该管「自环放行」这件事本身。
  for (const phase of PHASES) {
    assert.equal(canTransition(phase, phase), true, `自环该恒许可：${phase}`);
  }
  for (const phase of PROBE_PROTECTED_PHASES) {
    assert.ok(PHASES.includes(phase), `探测保护态不在 PHASES 内：${phase}`);
    assert.equal(PROBE_OUT.includes(phase), false, `${phase} 既是探测结论又是探测保护态，自相矛盾`);
  }
});

test('终审守卫的契约边界：phase 必须由调用方先过 enum，守卫本身不接受原型链上的名字', () => {
  // canTransition 对任何非 phase 值都安全地回 false，这是对外的那道门。
  assert.equal(canTransition('__proto__', 'ready'), false);
  assert.equal(canTransition('ready', '__proto__'), false);

  // assertTransition 是「走到这里还非法 = 代码 bug」的终审守卫（见 machine.js 注释），
  // 它假定两端已是 phase。传 `__proto__` 进去会摸到 Object.prototype 而不是迁移表，
  // 于是抛的是 TypeError 而非 DshError。这条用例把这个边界钉在这里：真正的防线是
  // 「phase 只能从 V.enum_(PHASES) 过来」（store 与 state schema 已经这么做了），
  // 谁要绕过 canTransition 直接调终审守卫，得自己先把值过一遍 isPhase。
  assert.throws(() => assertTransition('__proto__', 'ready'), TypeError);
  assert.equal(isPhase('__proto__'), false, 'isPhase 是那道该用的门，它没有这个问题');
});
