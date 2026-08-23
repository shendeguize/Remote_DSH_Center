/** 路由解析与 setup 守卫单测（10 §5）。 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LAST_HOST_KEY,
  applyGuard,
  attachRouter,
  canOpenHost,
  hostRoute,
  navigate,
  parseRoute,
  readLastHost,
  rememberLastHost,
  rootRouteTarget,
} from '../../src/web/router.js';

function createHashWindow(initialHash = '') {
  const listeners = new Map();
  const replaceCalls = [];
  let hash = initialHash;

  const win = {
    HashChangeEvent: class {
      constructor(type) {
        this.type = type;
      }
    },
    addEventListener(type, fn) {
      const handlers = listeners.get(type) ?? new Set();
      handlers.add(fn);
      listeners.set(type, handlers);
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
    dispatchEvent(event) {
      for (const fn of [...(listeners.get(event.type) ?? [])]) fn(event);
      return true;
    },
    listenerCount(type) {
      return listeners.get(type)?.size ?? 0;
    },
    replaceCalls,
  };

  win.location = {
    get hash() {
      return hash;
    },
    set hash(value) {
      if (value === hash) return;
      hash = value;
      win.dispatchEvent(new win.HashChangeEvent('hashchange'));
    },
    replace(value) {
      replaceCalls.push(value);
      this.hash = value;
    },
  };

  return win;
}

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

test('根路由：lastHost 统一使用 config.enabled，缺失时才回退 legacy enabled', () => {
  const cases = [
    {
      label: 'config 禁用覆盖 legacy 启用',
      host: { name: 'config-disabled', phase: 'running', config: { enabled: false }, enabled: true },
      expected: '#/hub',
    },
    {
      label: 'config 启用覆盖 legacy 禁用',
      host: { name: 'config-enabled', phase: 'running', config: { enabled: true }, enabled: false },
      expected: '#/host/config-enabled',
    },
    {
      label: '无 config 时回退 legacy 禁用',
      host: { name: 'legacy-disabled', phase: 'running', enabled: false },
      expected: '#/hub',
    },
    {
      label: '无 config 时回退 legacy 启用',
      host: { name: 'legacy-enabled', phase: 'running', enabled: true },
      expected: '#/host/legacy-enabled',
    },
  ];

  for (const current of cases) {
    const storage = { getItem: () => current.host.name };
    assert.equal(rootRouteTarget([current.host], storage), current.expected, current.label);
  }
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

test('attachRouter 立即回调、响应 hashchange，detach 后彻底解绑', () => {
  const win = createHashWindow('#/hub');
  const routes = [];
  const detach = attachRouter((route) => routes.push(route), { win });

  assert.deepEqual(routes, [{ kind: 'hub', host: null, raw: '#/hub' }], '绑定后立即交付当前路由');
  assert.equal(win.listenerCount('hashchange'), 1);

  win.location.hash = '#/host/gpu-1';
  assert.deepEqual(routes.at(-1), { kind: 'host', host: 'gpu-1', raw: '#/host/gpu-1' });

  detach();
  assert.equal(win.listenerCount('hashchange'), 0, 'detach 必须释放监听器');
  win.location.hash = '#/manage';
  assert.equal(routes.length, 2, '解绑后 hash 变化不再回调');
});

test('navigate 对新 hash 依赖原生事件，对同 hash 显式补发事件', () => {
  const win = createHashWindow('#/hub');
  const observed = [];
  win.addEventListener('hashchange', (event) => observed.push({ event, hash: win.location.hash }));

  navigate('#/manage', { win });
  assert.equal(win.location.hash, '#/manage');
  assert.equal(observed.length, 1, '新 hash 由 location 变化触发一次');

  navigate('#/manage', { win });
  assert.equal(observed.length, 2, '同 hash 也必须显式通知路由层');
  assert.ok(observed[1].event instanceof win.HashChangeEvent);
  assert.equal(observed[1].hash, '#/manage');

  navigate('#/setup', { win, replace: true });
  assert.deepEqual(win.replaceCalls, ['#/setup']);
  assert.equal(win.location.hash, '#/setup');
  assert.equal(observed.length, 3, 'replace 到新 hash 同样触发路由更新');
});
