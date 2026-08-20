/** SSE 客户端与断线横幅单测（10 §3.11 / §6，用假 EventSource 注入）。 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createStore } from '../../src/web/store.js';
import { bannerText, createSseClient } from '../../src/web/sse.js';

class FakeEventSource {
  static created = [];

  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.listeners = new Map();
    FakeEventSource.created.push(this);
  }

  addEventListener(type, fn) {
    const set = this.listeners.get(type) ?? new Set();
    set.add(fn);
    this.listeners.set(type, set);
  }

  emit(type, data) {
    for (const fn of this.listeners.get(type) ?? []) fn(data === undefined ? {} : { data: JSON.stringify(data) });
  }

  raise(type, ev = {}) {
    for (const fn of this.listeners.get(type) ?? []) fn(ev);
  }

  close() {
    this.readyState = 2;
  }
}

function boot() {
  FakeEventSource.created = [];
  const store = createStore();
  const client = createSseClient({ store, factory: (u) => new FakeEventSource(u) });
  client.connect();
  return { store, client, es: () => FakeEventSource.created.at(-1) };
}

test('横幅文案覆盖四种连接情形', () => {
  assert.equal(bannerText({ sse: 'connecting', everOpened: false, resyncing: false }), '正在连接 manager…');
  assert.equal(bannerText({ sse: 'offline', everOpened: false, resyncing: false }), '无法连接 manager，请确认服务已启动');
  assert.equal(bannerText({ sse: 'reconnecting', everOpened: true, resyncing: false }), '与 manager 失联，正在重连；写操作已暂停。');
  assert.equal(bannerText({ sse: 'offline', everOpened: true, resyncing: false }), '与 manager 失联且已停止重连；请检查 manager 进程后刷新页面');
  assert.equal(bannerText({ sse: 'open', everOpened: true, resyncing: true }), '已重新连上 manager，正在同步状态…');
  assert.equal(bannerText({ sse: 'open', everOpened: true, resyncing: false }), null, '同步完成后横幅消失');
  assert.equal(
    bannerText({ sse: 'reconnecting', everOpened: true, resyncing: false }, { managerRestarting: true }),
    'manager 正在重启，稍后自动重连…',
    '自己点的重启不该报成普通故障',
  );
});

test('snapshot 首帧即完成首屏同步', () => {
  const { store, es } = boot();
  es().raise('open');
  assert.equal(store.state.connection.sse, 'open');

  es().emit('snapshot', {
    revision: 3,
    manager: { setupCompleted: true, port: 7788 },
    defaults: { remoteWebPort: 8899, localPortRange: [1, 2] },
    hosts: [{ name: 'a', phase: 'ready', config: {}, manualInstances: [] }],
    logs: [],
  });

  assert.equal(store.state.revision, 3);
  assert.equal(store.getHost('a').phase, 'ready');
  assert.equal(store.state.connection.resyncing, false);
});

test('断线重连：先挂 resyncing，snapshot 到达后才撤横幅', () => {
  const { store, es } = boot();
  es().raise('open');
  es().emit('snapshot', { revision: 1, hosts: [], logs: [] });

  es().raise('error', {}); // 浏览器仍会自己重连（readyState !== 2）
  assert.equal(store.state.connection.sse, 'reconnecting');
  assert.ok(bannerText(store.state.connection));

  es().raise('open');
  assert.equal(store.state.connection.resyncing, true, '重连打开后仍需等全量');
  assert.ok(bannerText(store.state.connection));

  es().emit('snapshot', { revision: 5, hosts: [], logs: [] });
  assert.equal(bannerText(store.state.connection), null);
});

test('EventSource 彻底关闭时转 offline', () => {
  const { store, es } = boot();
  es().raise('open');
  es().readyState = 2;
  es().raise('error', {});
  assert.equal(store.state.connection.sse, 'offline');
});

test('坏 JSON 只报 warn toast，不中断连接', () => {
  const { store, es } = boot();
  es().raise('open');
  for (const fn of es().listeners.get('host-changed')) fn({ data: '{oops' });

  assert.equal(store.state.toasts.length, 1);
  assert.equal(store.state.toasts[0].level, 'warn');
  assert.equal(store.state.connection.sse, 'open');
});

test('operation-done 结算 pending 并按 status 提示', () => {
  const { store, es } = boot();
  es().raise('open');
  es().emit('snapshot', { revision: 1, hosts: [{ name: 'a', phase: 'ready', config: {}, manualInstances: [] }], logs: [] });

  store.beginPending({ action: 'start', host: 'a' });
  store.acceptPending('host:a:start', 'op-1');
  es().emit('operation-done', { operationId: 'op-1', host: 'a', action: 'start', status: 'ok' });
  assert.equal(store.isPending('start', 'a'), false);
  assert.equal(store.state.toasts.at(-1).level, 'success');

  store.beginPending({ action: 'stop', host: 'a' });
  store.acceptPending('host:a:stop', 'op-2');
  es().emit('operation-done', {
    operationId: 'op-2', host: 'a', action: 'stop', status: 'failed', error: 'KILL_REFUSED', detail: 'fingerprint mismatch',
  });
  assert.equal(store.isPending('stop', 'a'), false);
  const toast = store.state.toasts.at(-1);
  assert.equal(toast.level, 'error');
  assert.match(toast.summary, /KILL_REFUSED/);
  assert.equal(toast.detail, 'fingerprint mismatch');
});

test('log-line 进事件缓冲；config-changed 换 defaults', () => {
  const { store, es } = boot();
  es().raise('open');
  es().emit('log-line', { ts: '2026-01-01T00:00:00.000Z', level: 'warn', host: 'a', msg: '隧道重连' });
  assert.equal(store.state.events.at(-1).msg, '隧道重连');

  es().emit('config-changed', { revision: 9, defaults: { remoteWebPort: 9999, localPortRange: [1, 2] }, changed: ['defaults.remoteWebPort'] });
  assert.equal(store.state.defaults.remoteWebPort, 9999);
});

test('revive 不会造出第二个 EventSource', () => {
  const { client, es } = boot();
  es().raise('open');
  client.revive();
  assert.equal(FakeEventSource.created.length, 1, '活着的连接不重建');

  es().readyState = 2;
  client.revive();
  assert.equal(FakeEventSource.created.length, 2, '死了才重建');
});
