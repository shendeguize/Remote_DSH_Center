import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_CLEANUP_RULES,
  buildCleanupPlan,
  normalizeCleanupRules,
} from '../src/cleanup.js';

test('cleanup defaults are bounded and only select owned test workdirs', () => {
  const now = Date.parse('2026-09-01T00:00:00.000Z');
  const candidates = buildCleanupPlan([
    {
      name: 'test-host',
      web: {
        pid: 42,
        port: 8899,
        startedByUs: true,
        cmdFingerprint: 'dsh web --port 8899',
        workdir: '/home/caros/workspace/dsh_debug',
        startedAt: '2026-08-30T00:00:00.000Z',
      },
    },
    {
      name: 'user-host',
      web: {
        pid: 43,
        startedByUs: false,
        cmdFingerprint: 'dsh web --port 8899',
        workdir: '/home/caros/workspace/dsh_debug',
      },
    },
  ], { now });
  assert.deepEqual(DEFAULT_CLEANUP_RULES, ['owned-web', 'test-workdir']);
  assert.deepEqual(candidates.map((item) => ({
    host: item.host,
    pid: item.pid,
    port: item.port,
    rule: item.rule,
  })), [{
    host: 'test-host',
    pid: 42,
    port: 8899,
    rule: 'owned-web',
  }]);
  assert.match(candidates[0].fingerprintSha12, /^[\da-f]{12}$/u);
});

test('cleanup rule parsing and stale-age remain fail-closed', () => {
  assert.deepEqual(normalizeCleanupRules(['stale-age']), ['stale-age']);
  assert.throws(() => normalizeCleanupRules(['arbitrary-command']));
  assert.throws(() => normalizeCleanupRules(['owned-web', 'owned-web']));
  assert.throws(() => buildCleanupPlan([], { staleAgeMs: -1 }));
  assert.deepEqual(buildCleanupPlan([{
    name: 'old',
    web: {
      pid: 7,
      startedByUs: true,
      cmdFingerprint: 'fp',
      workdir: '/home/caros/workspace/dsh_debug',
      startedAt: '2020-01-01T00:00:00.000Z',
    },
  }], {
    rules: ['stale-age'],
    now: Date.parse('2026-09-01T00:00:00.000Z'),
  }).map((item) => item.host), ['old']);
});

