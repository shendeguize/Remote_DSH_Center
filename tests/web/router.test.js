/** 路由解析与 setup 守卫单测（10 §5）。 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { applyGuard, canOpenHost, hostRoute, parseRoute } from '../../src/web/router.js';

test('parseRoute 覆盖路由表四行（10 §5.1）', () => {
  assert.deepEqual(parseRoute(''), { kind: 'dashboard', host: null, raw: '#/' });
  assert.deepEqual(parseRoute('#/'), { kind: 'dashboard', host: null, raw: '#/' });
  assert.deepEqual(parseRoute('#/setup'), { kind: 'setup', host: null, raw: '#/setup' });
  assert.deepEqual(parseRoute('#/host/gpu-1'), { kind: 'host', host: 'gpu-1', raw: '#/host/gpu-1' });
  assert.equal(parseRoute('#/nope').kind, 'dashboard', '未知路由回管理台');
  assert.equal(parseRoute('#/host/a/b').kind, 'dashboard', '只接受单段主机名');
});

test('主机名里的特殊字符靠 URL 编码承载', () => {
  const name = 'proj/gpu?1 #x';
  const route = parseRoute(hostRoute(name));
  assert.equal(route.kind, 'host');
  assert.equal(route.host, name);
});

test('坏编码与空主机名不炸，退回管理台', () => {
  assert.equal(parseRoute('#/host/%E0%A4%A').kind, 'dashboard');
  assert.equal(parseRoute('#/host/').kind, 'dashboard');
});

test('setup 守卫：未知先渲骨架，未完成强制向导', () => {
  const dash = parseRoute('#/');

  const unknown = applyGuard(dash, { setupCompleted: null });
  assert.equal(unknown.blocked, true, 'setupCompleted 未知时不许闪现管理台');
  assert.equal(unknown.redirectTo, null);

  const incomplete = applyGuard(dash, { setupCompleted: false });
  assert.equal(incomplete.redirectTo, '#/setup');
  assert.equal(incomplete.route.kind, 'setup');

  const already = applyGuard(parseRoute('#/setup'), { setupCompleted: false });
  assert.equal(already.redirectTo, null, '已在向导上不重复跳转');

  const done = applyGuard(parseRoute('#/host/a'), { setupCompleted: true });
  assert.equal(done.redirectTo, null);
  assert.equal(done.route.kind, 'host');
});

test('canOpenHost 只放行有 iframe 语义的三态', () => {
  for (const phase of ['running', 'degraded', 'crashed']) {
    assert.equal(canOpenHost({ phase }), true, phase);
  }
  for (const phase of ['ready', 'starting', 'no_dsh', 'unreachable', 'unknown']) {
    assert.equal(canOpenHost({ phase }), false, phase);
  }
  assert.equal(canOpenHost(null), false);
});
