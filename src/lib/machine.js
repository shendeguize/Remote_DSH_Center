/**
 * 主机状态机（11 §2）。README 状态机图为子集，02 行为要求的补全迁移已在
 * README「契约疑议」第 2 条报备并裁决采纳。
 */

import { DshError } from './errors.js';

export const PHASES = Object.freeze([
  'unknown',
  'unreachable',
  'no_dsh',
  'ready',
  'starting',
  'running',
  'degraded',
  'crashed',
]);

/** 探测的三分类结果。 */
export const PROBE_OUT = Object.freeze(['unreachable', 'no_dsh', 'ready']);

/**
 * from → 允许的 to。不含 from===to 的自环：自环恒许可（只刷新数据，不算迁移）。
 * @type {Readonly<Record<string, readonly string[]>>}
 */
export const TRANSITIONS = Object.freeze({
  unknown: PROBE_OUT,
  unreachable: PROBE_OUT,
  no_dsh: PROBE_OUT,
  ready: Object.freeze([...PROBE_OUT, 'starting']),
  crashed: Object.freeze([...PROBE_OUT, 'starting']),
  starting: Object.freeze(['running', 'ready']),
  running: Object.freeze(['degraded', 'crashed', 'ready']),
  degraded: Object.freeze(['running', 'crashed', 'ready']),
});

/** 探测不得改写这三态的 phase（11 §2.2 说明）：只刷新 manualInstances。 */
export const PROBE_PROTECTED_PHASES = Object.freeze(['starting', 'running', 'degraded']);

export function isPhase(p) {
  return PHASES.includes(p);
}

export function canTransition(from, to) {
  if (!isPhase(from) || !isPhase(to)) return false;
  if (from === to) return true;
  return (TRANSITIONS[from] ?? []).includes(to);
}

/**
 * 终审守卫（11 §2.3 第三层）。走到这里还非法 = 代码 bug。
 * @throws {DshError} STATE_ILLEGAL_TRANSITION
 */
export function assertTransition(from, to, cause = 'unknown') {
  if (!canTransition(from, to)) {
    throw new DshError(
      'STATE_ILLEGAL_TRANSITION',
      `非法状态迁移 ${from} → ${to}（触发：${cause}）`,
      { detail: `合法目标：${(TRANSITIONS[from] ?? []).join(', ') || '(无)'}` },
    );
  }
  return to;
}
