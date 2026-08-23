/** 前端 store 单测（DOM-free，14 §4）。 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { ACTION_TIMEOUT_MS, EVENT_BUFFER_LIMIT, TOAST_LIMIT, createStore, pendingKey } from '../../src/web/store.js';

function hostView(name, patch = {}) {
  return {
    name,
    enabled: true,
    orphaned: false,
    config: { enabled: true, autoStart: false, localPort: null, remoteWebPort: null, inject: { env: {}, extraArgs: [], patches: [] } },
    phase: 'unknown',
    effectiveRemotePort: 8899,
    mappedUrl: null,
    probe: null,
    web: null,
    tunnel: null,
    manualInstances: [],
    sshInfo: { user: 'me', hostName: '10.0.0.1', port: 22 },
    ...patch,
  };
}

test('pendingKey 区分主机级与全局动作', () => {
  assert.equal(pendingKey('start', 'gpu-1'), 'host:gpu-1:start');
  assert.equal(pendingKey('probe-all'), 'probe-all');
});

test('snapshot 整体替换主机集合并清 resyncing', () => {
  const store = createStore();
  store.setConnection({ sse: 'open' });
  store.setConnection({ resyncing: true });

  const seen = [];
  store.on('hosts:reset', (names) => seen.push(names));

  store.applySnapshot({
    revision: 7,
    manager: { setupCompleted: true, port: 7788 },
    defaults: { remoteWebPort: 8899, localPortRange: [17701, 17799] },
    hosts: [hostView('a'), hostView('b')],
    logs: [{ ts: '2026-01-01T00:00:00.000Z', level: 'info', host: 'a', msg: 'hi' }],
  });

  assert.equal(store.state.revision, 7);
  assert.deepEqual(seen.at(-1), ['a', 'b']);
  assert.equal(store.state.manager.setupCompleted, true);
  assert.equal(store.state.defaults.remoteWebPort, 8899);
  assert.equal(store.state.events.length, 1);
  assert.equal(store.state.connection.resyncing, false);

  // 第二帧里 b 消失 → 本地也必须删掉，不能留幽灵行
  store.applySnapshot({ revision: 8, hosts: [hostView('a')], logs: [] });
  assert.deepEqual(store.listHosts().map((h) => h.name), ['a']);
});

test('host-changed 丢弃旧 revision，接受新 revision', () => {
  const store = createStore();
  store.applySnapshot({ revision: 5, hosts: [hostView('a')], logs: [] });

  assert.equal(store.applyHostChanged({ revision: 4, host: hostView('a', { phase: 'running' }) }), false);
  assert.equal(store.getHost('a').phase, 'unknown');

  assert.equal(store.applyHostChanged({ revision: 6, host: hostView('a', { phase: 'running' }) }), true);
  assert.equal(store.getHost('a').phase, 'running');
  assert.equal(store.state.revision, 6);
});

test('mergeFetchedHosts 不覆盖请求发出后到达的 SSE 版本（10 §4.4 第 3 点）', () => {
  const store = createStore();
  const startedAt = performance.now() - 1_000; // 与 __receivedAt 同一把尺（单调钟，#104）

  // SSE 先到（接收时刻晚于 GET 发出时刻）
  store.applyHostChanged({ revision: 1, host: hostView('a', { phase: 'running' }) });
  // 陈旧的 GET 结果后到
  store.mergeFetchedHosts([hostView('a', { phase: 'ready' }), hostView('b')], 1, startedAt);

  assert.equal(store.getHost('a').phase, 'running', 'SSE 版本更新，不能被旧 GET 覆盖');
  assert.equal(store.getHost('b').phase, 'unknown', '未知主机照常补入');
});

test('接收时刻跨墙钟跳变仍可比先后（issue #104）', (t) => {
  // mergeFetchedHosts 靠 __receivedAt 与请求发出时刻比大小来决定「谁更新」。这把尺
  // 一旦是墙钟，请求在途期间的一次校时（休眠唤醒后的 NTP 步进）就能把先后判反，
  // 让陈旧的 GET 盖掉刚到的 SSE 快照。
  const store = createStore();
  store.applyHostChanged({ revision: 1, host: hostView('a', { phase: 'ready' }) });

  const real = Date.now;
  t.mock.method(Date, 'now', () => real.call(Date) - 3_600_000); // 墙钟往回拨一小时
  store.applyHostChanged({ revision: 2, host: hostView('b', { phase: 'running' }) });

  const first = store.getHost('a').__receivedAt;
  const second = store.getHost('b').__receivedAt;
  assert.ok(second >= first, `后到的快照时刻不该更早：${first} → ${second}`);
});

test('事件缓冲为环形，上限 50', () => {
  const store = createStore();
  for (let i = 0; i < EVENT_BUFFER_LIMIT + 10; i += 1) {
    store.appendEvent({ level: 'info', host: 'a', msg: `m${i}` });
  }
  assert.equal(store.state.events.length, EVENT_BUFFER_LIMIT);
  assert.equal(store.state.events.at(-1).msg, `m${EVENT_BUFFER_LIMIT + 9}`);
  assert.equal(store.state.events[0].msg, 'm10');

  store.clearEvents();
  assert.equal(store.state.events.length, 0);
});

test('canWrite：首屏建连中允许写，断线与重同步期间禁写', () => {
  const store = createStore();
  assert.equal(store.canWrite(), true, 'idle');
  store.setConnection({ sse: 'connecting' });
  assert.equal(store.canWrite(), true, '首次建连中不该把按钮全灰');
  store.setConnection({ sse: 'open' });
  assert.equal(store.canWrite(), true);
  store.setConnection({ sse: 'reconnecting' });
  assert.equal(store.canWrite(), false, '曾连上又断 → 禁写');
  store.setConnection({ sse: 'open', resyncing: true });
  assert.equal(store.canWrite(), false, '连接恢复但全量 snapshot 未到 → 仍禁写');
  store.applySnapshot({ revision: 1, hosts: [], logs: [] });
  assert.equal(store.canWrite(), true, 'snapshot 清掉 resyncing 后才恢复写操作');
  store.setConnection({ sse: 'offline' });
  assert.equal(store.canWrite(), false);
});

test('pending：202 结算靠 operationId，phase 到终态兜底', () => {
  const store = createStore();
  store.applySnapshot({ revision: 1, hosts: [hostView('a')], logs: [] });

  store.beginPending({ action: 'start', host: 'a' });
  assert.equal(store.isPending('start', 'a'), true);
  assert.equal(store.hostBusy('a'), true);

  store.acceptPending(pendingKey('start', 'a'), 'op-1');
  assert.equal(store.state.pending.get('host:a:start').status, 'accepted');

  assert.equal(store.settleByOperation('op-2'), null, '不匹配的 operationId 不结算');
  const settled = store.settleByOperation('op-1');
  assert.equal(settled.action, 'start');
  assert.equal(store.isPending('start', 'a'), false);

  // 兜底路径：operation-done 丢了，靠 host-changed 到 running 解锁
  store.beginPending({ action: 'start', host: 'a' });
  store.applyHostChanged({ revision: 2, host: hostView('a', { phase: 'starting' }) });
  assert.equal(store.isPending('start', 'a'), true, 'starting 是中间态，不结算');
  store.applyHostChanged({ revision: 3, host: hostView('a', { phase: 'running' }) });
  assert.equal(store.isPending('start', 'a'), false);
});

test('重连的快照要结算在飞的写操作（operation-done 帧已经错过了）', () => {
  const store = createStore();
  store.applySnapshot({ revision: 1, hosts: [hostView('a', { phase: 'ready' })], logs: [] });

  store.beginPending({ action: 'start', host: 'a' });
  store.acceptPending(pendingKey('start', 'a'), 'op-1');
  assert.equal(store.hostBusy('a'), true, '前提：那一行正忙');

  // 失联期间动作在后端完成了：operation-done 发过、页面没收到，重连只剩这份快照
  store.applySnapshot({ revision: 9, hosts: [hostView('a', { phase: 'running' })], logs: [] });
  assert.equal(store.isPending('start', 'a'), false, '快照说已经在运行了，按钮不该继续禁着');
  assert.equal(store.hostBusy('a'), false);

  // 真还在半路的（starting）不许提前解锁
  store.beginPending({ action: 'start', host: 'a' });
  store.applySnapshot({ revision: 10, hosts: [hostView('a', { phase: 'starting' })], logs: [] });
  assert.equal(store.isPending('start', 'a'), true, 'starting 是中间态，动作可能真还在飞');
});

test('pending 超时只解 loading，不改 phase', async () => {
  const store = createStore();
  store.applySnapshot({ revision: 1, hosts: [hostView('a', { phase: 'ready' })], logs: [] });
  store.beginPending({ action: 'start', host: 'a' });

  const key = pendingKey('start', 'a');
  const fired = [];
  const entry = store.acceptPending(key, 'op-x', (e) => fired.push(e.status));
  // 不真等 30s：直接把定时器的回调提前触发
  const timeout = entry.timeoutId;
  assert.ok(timeout, '应挂上超时定时器');
  assert.equal(ACTION_TIMEOUT_MS.start, 30_000);
  clearTimeout(timeout);
  entry.timeoutId = null;
  store.settlePending(key);

  assert.equal(store.getHost('a').phase, 'ready', 'phase 只由 SSE 推进');
  assert.deepEqual(fired, []);
});

test('toast：同文案折叠计数，超出上限丢最旧', () => {
  const store = createStore();
  store.addToast({ level: 'error', summary: '失败' });
  store.addToast({ level: 'error', summary: '失败' });
  assert.equal(store.state.toasts.length, 1);
  assert.equal(store.state.toasts[0].count, 2);

  for (let i = 0; i < TOAST_LIMIT + 2; i += 1) store.addToast({ level: 'info', summary: `t${i}` });
  assert.equal(store.state.toasts.length, TOAST_LIMIT);

  const id = store.state.toasts[0].id;
  store.dismissToast(id);
  assert.equal(store.state.toasts.some((t) => t.id === id), false);
});

test('config-changed 只更新配置端口，旧 revision 不得回退配置', () => {
  const store = createStore();
  store.setManagerInfo({ setupCompleted: true, port: 7788, pid: 42, version: '0.1.0' });
  store.setManagerConfig({ port: 7788 });
  const applied = store.applyConfigChanged({
    revision: 9,
    defaults: { remoteWebPort: 9000, localPortRange: [1, 2] },
    manager: { port: 7799 },
    changed: ['manager.port'],
  });

  assert.equal(applied, true);
  assert.equal(store.state.manager.info.port, 7788, '实际监听端口不能被目标配置冒充');
  assert.equal(store.state.manager.info.pid, 42);
  assert.equal(store.state.manager.configuredPort, 7799);
  assert.equal(store.state.defaults.remoteWebPort, 9000);

  const stale = store.applyConfigChanged({
    revision: 9,
    defaults: { remoteWebPort: 8000, localPortRange: [3, 4] },
    manager: { port: 7800 },
    changed: ['manager.port'],
  });
  assert.equal(stale, false);
  assert.equal(store.state.manager.configuredPort, 7799);
  assert.equal(store.state.defaults.remoteWebPort, 9000);
});

test('snapshot 原子更新实际监听端口与配置目标端口，并以 revision 挡住旧配置帧', () => {
  const store = createStore();
  const observed = [];
  store.on('manager:changed', () => {
    observed.push([store.state.manager.info?.port, store.state.manager.configuredPort]);
  });
  store.on('manager-config:changed', () => {
    observed.push([store.state.manager.info?.port, store.state.manager.configuredPort]);
  });

  store.applySnapshot({
    revision: 10,
    manager: { setupCompleted: true, port: 7788, pid: 43 },
    configuredPort: 7799,
    defaults: { remoteWebPort: 8899, localPortRange: [17_701, 17_799] },
    hosts: [],
    logs: [],
  });

  assert.equal(store.state.manager.info.port, 7788);
  assert.equal(store.state.manager.info.pid, 43);
  assert.equal(store.state.manager.configuredPort, 7799);
  assert.deepEqual(observed, [[7788, 7799], [7788, 7799]],
    '任一 manager 订阅者都只能观察到 runtime/configuredPort 同步后的状态');

  assert.equal(store.applyConfigChanged({
    revision: 9,
    defaults: { remoteWebPort: 9000, localPortRange: [18_001, 18_099] },
    manager: { port: 7800 },
    changed: ['manager.port'],
  }), false);
  assert.equal(store.state.manager.configuredPort, 7799, '旧配置帧不得回退 snapshot 真相');
});

test('旧 snapshot 不含 configuredPort 时保留已知配置目标端口', () => {
  const store = createStore();
  store.setManagerConfig({ port: 7799 });

  store.applySnapshot({
    revision: 10,
    manager: { setupCompleted: true, port: 7788, pid: 43 },
    defaults: { remoteWebPort: 8899, localPortRange: [17_701, 17_799] },
    hosts: [],
    logs: [],
  });

  assert.equal(store.state.manager.info.port, 7788);
  assert.equal(store.state.manager.configuredPort, 7799);
});

test('upsertHost 落地 REST 回传视图且不动 revision', () => {
  const store = createStore();
  store.applySnapshot({ revision: 3, hosts: [hostView('a')], logs: [] });
  store.upsertHost(hostView('a', { config: { ...hostView('a').config, autoStart: true } }));

  assert.equal(store.getHost('a').config.autoStart, true);
  assert.equal(store.state.revision, 3);
});
