/** 全局 toast 的关闭时序与定时器清理契约。 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createToastRegion } from '../../src/web/components/toast-region.js';
import { installDom } from './dom-shim.js';

function createStore(initialToasts) {
  const listeners = new Map();
  const dismissCalls = [];
  const state = { toasts: [...initialToasts] };

  const emit = (event) => {
    for (const fn of [...(listeners.get(event) ?? [])]) fn();
  };

  return {
    state,
    dismissCalls,
    on(event, fn) {
      const handlers = listeners.get(event) ?? new Set();
      handlers.add(fn);
      listeners.set(event, handlers);
      return () => handlers.delete(fn);
    },
    dismissToast(id) {
      dismissCalls.push(id);
      state.toasts = state.toasts.filter((toast) => toast.id !== id);
      emit('toasts:changed');
    },
    listenerCount(event) {
      return listeners.get(event)?.size ?? 0;
    },
  };
}

function installFakeTimers(t) {
  const descriptors = {
    setTimeout: Object.getOwnPropertyDescriptor(globalThis, 'setTimeout'),
    clearTimeout: Object.getOwnPropertyDescriptor(globalThis, 'clearTimeout'),
  };
  const active = new Map();
  const cleared = [];
  let nextId = 1;
  let now = 0;

  globalThis.setTimeout = (fn, delay = 0) => {
    const handle = { id: nextId };
    nextId += 1;
    active.set(handle, { fn, at: now + Number(delay) });
    return handle;
  };
  globalThis.clearTimeout = (handle) => {
    if (active.delete(handle)) cleared.push(handle);
  };

  t.after(() => {
    for (const [key, descriptor] of Object.entries(descriptors)) {
      Object.defineProperty(globalThis, key, descriptor);
    }
  });

  return {
    active,
    cleared,
    advanceBy(ms) {
      const target = now + ms;
      while (true) {
        const due = [...active.entries()]
          .filter(([, timer]) => timer.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        const [handle, timer] = due;
        active.delete(handle);
        now = timer.at;
        timer.fn();
      }
      now = target;
    },
  };
}

test('toast 到期后自动 dismiss，并从 DOM 与定时器表移除', (t) => {
  const dom = installDom();
  const timers = installFakeTimers(t);
  t.after(dom.restore);
  const store = createStore([
    { id: 'auto', level: 'success', summary: '已完成', timeoutMs: 40 },
  ]);
  const region = createToastRegion({ store });

  assert.equal(region.root.children.length, 1);
  assert.equal(timers.active.size, 1);
  timers.advanceBy(39);
  assert.deepEqual(store.dismissCalls, []);
  assert.equal(region.root.children.length, 1);

  timers.advanceBy(1);
  assert.deepEqual(store.dismissCalls, ['auto']);
  assert.equal(region.root.children.length, 0);
  assert.equal(timers.active.size, 0, '触发后的 timer 不得残留');

  region.destroy();
  assert.equal(store.listenerCount('toasts:changed'), 0);
});

test('手动关闭会清 timeout，之后推进时间不会二次 dismiss', (t) => {
  const dom = installDom();
  const timers = installFakeTimers(t);
  t.after(dom.restore);
  const store = createStore([
    { id: 'manual', level: 'info', summary: '处理中', timeoutMs: 50 },
  ]);
  const region = createToastRegion({ store });

  region.root.querySelector('.toast-close').click();
  assert.deepEqual(store.dismissCalls, ['manual']);
  assert.equal(region.root.children.length, 0);
  assert.equal(timers.cleared.length, 1, '手动关闭必须调用 clearTimeout');
  assert.equal(timers.active.size, 0);

  timers.advanceBy(1_000);
  assert.deepEqual(store.dismissCalls, ['manual'], '已清除的回调不得再次删除同一 toast');

  region.destroy();
  assert.equal(store.listenerCount('toasts:changed'), 0);
});

test('destroy 解绑订阅并清除所有尚未触发的 timer', (t) => {
  const dom = installDom();
  const timers = installFakeTimers(t);
  t.after(dom.restore);
  const store = createStore([
    { id: 'one', level: 'info', summary: '第一条', timeoutMs: 100 },
    { id: 'two', level: 'success', summary: '第二条', timeoutMs: 200 },
    { id: 'three', level: 'warn', summary: '第三条', timeoutMs: 300 },
  ]);
  const region = createToastRegion({ store });

  assert.equal(timers.active.size, 3);
  assert.equal(store.listenerCount('toasts:changed'), 1);
  region.destroy();
  assert.equal(timers.cleared.length, 3);
  assert.equal(timers.active.size, 0);
  assert.equal(store.listenerCount('toasts:changed'), 0);

  timers.advanceBy(1_000);
  assert.deepEqual(store.dismissCalls, [], 'destroy 后任何旧 timer 都不得生效');
});
