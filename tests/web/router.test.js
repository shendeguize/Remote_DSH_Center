/** 路由解析与 setup 守卫单测（10 §5）。 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LAST_HOST_KEY,
  applyGuard,
  canOpenHost,
  hostRoute,
  parseRoute,
  readLastHost,
  rememberLastHost,
  rootRouteTarget,
} from '../../src/web/router.js';

test('parseRoute 覆盖反转后的路由表', () => {
  assert.deepEqual(parseRoute(''), { kind: 'root', host: null, raw: '#/' });
  assert.deepEqual(parseRoute('#/'), { kind: 'root', host: null, raw: '#/' });
  assert.deepEqual(parseRoute('#/hub'), { kind: 'hub', host: null, raw: '#/hub' });
  assert.deepEqual(parseRoute('#/manage'), { kind: 'manage', host: null, raw: '#/manage' });
  assert.deepEqual(parseRoute('#/setup'), { kind: 'setup', host: null, raw: '#/setup' });
  assert.deepEqual(parseRoute('#/host/gpu-1'), { kind: 'host', host: 'gpu-1', raw: '#/host/gpu-1' });
  assert.equal(parseRoute('#/nope').kind, 'invalid');
  assert.equal(parseRoute('#/host/a/b').kind, 'invalid', '只接受单段主机名');
});

test('主机名里的特殊字符靠 URL 编码承载', () => {
  const name = 'proj/gpu?1 #x';
  const route = parseRoute(hostRoute(name));
  assert.equal(route.kind, 'host');
  assert.equal(route.host, name);
});

test('坏编码与空主机名不炸，按非法路由处理', () => {
  assert.equal(parseRoute('#/host/%E0%A4%A').kind, 'invalid');
  assert.equal(parseRoute('#/host/').kind, 'invalid');
});

test('setup 守卫：未知先渲骨架，未完成强制向导', () => {
  const root = parseRoute('#/');

  const unknown = applyGuard(root, { setupCompleted: null });
  assert.equal(unknown.blocked, true, 'setupCompleted 未知时不许闪现主界面');
  assert.equal(unknown.redirectTo, null);

  const incomplete = applyGuard(root, { setupCompleted: false });
  assert.equal(incomplete.redirectTo, '#/setup');
  assert.equal(incomplete.route.kind, 'setup');

  const already = applyGuard(parseRoute('#/setup'), { setupCompleted: false });
  assert.equal(already.redirectTo, null, '已在向导上不重复跳转');

  const done = applyGuard(parseRoute('#/host/a'), { setupCompleted: true });
  assert.equal(done.redirectTo, null);
  assert.equal(done.route.kind, 'host');
});

test('setup 已完成时非法路由规范化到 hub', () => {
  const guarded = applyGuard(parseRoute('#/not-a-route'), { setupCompleted: true });
  assert.equal(guarded.redirectTo, '#/hub');
  assert.deepEqual(guarded.route, { kind: 'hub', host: null, raw: '#/hub' });
});

test('canOpenHost 放行 starting 占位与三种 iframe 状态', () => {
  for (const phase of ['starting', 'running', 'degraded', 'crashed']) {
    assert.equal(canOpenHost({ phase }), true, phase);
  }
  for (const phase of ['ready', 'no_dsh', 'unreachable', 'unknown']) {
    assert.equal(canOpenHost({ phase }), false, phase);
  }
  assert.equal(canOpenHost(null), false);
});

test('根路由：lastHost 命中可开主机，否则落 hub', () => {
  const hosts = [
    { name: 'ready', phase: 'ready', enabled: true },
    { name: 'gpu-1', phase: 'running', enabled: true },
  ];
  const storage = { getItem: (key) => (key === LAST_HOST_KEY ? 'gpu-1' : null) };
  assert.equal(rootRouteTarget(hosts, storage), '#/host/gpu-1');
  assert.equal(
    rootRouteTarget([{ name: 'api-view', phase: 'running', config: { enabled: true } }], { getItem: () => 'api-view' }),
    '#/host/api-view',
    '后端 HostView 的启用位在 config.enabled',
  );

  assert.equal(rootRouteTarget(hosts, { getItem: () => 'ready' }), '#/hub', '未开主机不能恢复');
  assert.equal(rootRouteTarget(hosts, { getItem: () => 'gone' }), '#/hub', '失效主机不能恢复');
  assert.equal(rootRouteTarget(hosts, { getItem: () => null }), '#/hub');
});

test('根路由：lastHost 已禁用时不能恢复，即使旧运行态仍可开', () => {
  const disabled = { name: 'gpu-1', phase: 'running', enabled: false };
  assert.equal(rootRouteTarget([disabled], { getItem: () => 'gpu-1' }), '#/hub');
});

test('lastHost 存取失败静默降级', () => {
  const readThrows = { getItem() { throw new Error('storage disabled'); } };
  const writeThrows = { setItem() { throw new Error('quota denied'); } };
  assert.equal(readLastHost(readThrows), null);
  assert.equal(rootRouteTarget([{ name: 'gpu-1', phase: 'running' }], readThrows), '#/hub');
  assert.equal(rememberLastHost('gpu-1', writeThrows), false);

  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  assert.equal(rememberLastHost('proj/gpu #1', storage), true);
  assert.equal(readLastHost(storage), 'proj/gpu #1');
});
