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
    /** 追加一条并广播，模仿真 store 的 addToast。 */
    push(toast) {
      state.toasts = [...state.toasts, toast];
      emit('toasts:changed');
    },
    /** 同一条再来一次：真 store 只把 count 加一，不新建。 */
    bump(id) {
      const hit = state.toasts.find((toast) => toast.id === id);
      hit.count += 1;
      emit('toasts:changed');
    },
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

/**
 * 回归（issue #114）：`error: null` 的本意是「不自动关闭」，但 `null ?? 5_000` 又把它
 * 变回 5 秒，`if (ms === null) return` 成了死代码。真浏览器上的表现是：错误 toast 里的
 * 「详情」是唯一能看到远端为什么起不来的地方，人正读着，6 秒后整条被抽走、焦点掉回 body。
 *
 * 真 store 的 addToast 默认给 `timeoutMs: null`，意思是「这条没单独指定，按 level 走」——
 * 所以判据必须分得清「没指定」和「指定为不关」，这里逐字按真 store 的形状构造。
 */
test('错误 toast 不自动消失，直到人手动关（issue #114）', (t) => {
  const dom = installDom();
  const timers = installFakeTimers(t);
  t.after(dom.restore);
  const store = createStore([
    {
      id: 'err',
      level: 'error',
      summary: '拉起失败（gpu-2）',
      detail: 'fatal: failed to load web profile',
      timeoutMs: null,
    },
  ]);
  const region = createToastRegion({ store });

  assert.equal(timers.active.size, 0, 'error 一档压根不该排自动关闭的 timer');
  timers.advanceBy(600_000);
  assert.deepEqual(store.dismissCalls, [], '等十分钟也得留着');
  assert.equal(region.root.children.length, 1);

  region.root.querySelector('.toast-close').click();
  assert.deepEqual(store.dismissCalls, ['err'], '手动仍然关得掉');
  region.destroy();
});

test('其余档位照旧自动关闭：info/success 5s、warn 8s（别把 #114 修过头）', (t) => {
  const dom = installDom();
  const timers = installFakeTimers(t);
  t.after(dom.restore);
  const store = createStore([
    { id: 'i', level: 'info', summary: '处理中', timeoutMs: null },
    { id: 's', level: 'success', summary: '已完成', timeoutMs: null },
    { id: 'w', level: 'warn', summary: '有点不对', timeoutMs: null },
  ]);
  const region = createToastRegion({ store });
  assert.equal(timers.active.size, 3);

  timers.advanceBy(4_999);
  assert.deepEqual(store.dismissCalls, []);
  timers.advanceBy(1);
  assert.deepEqual(store.dismissCalls.sort(), ['i', 's'], '5 秒这一档到点');

  timers.advanceBy(2_999);
  assert.deepEqual(store.dismissCalls.sort(), ['i', 's']);
  timers.advanceBy(1);
  assert.deepEqual(store.dismissCalls.sort(), ['i', 's', 'w'], 'warn 是 8 秒');

  region.destroy();
});

test('调用方显式给的 timeoutMs 优先于档位默认值', (t) => {
  const dom = installDom();
  const timers = installFakeTimers(t);
  t.after(dom.restore);
  // 真调用点：actions.js / setup-wizard.js 的「已保存」用 4s，比 success 档的 5s 短
  const store = createStore([{ id: 'quick', level: 'success', summary: '配置已保存', timeoutMs: 4_000 }]);
  const region = createToastRegion({ store });

  timers.advanceBy(3_999);
  assert.deepEqual(store.dismissCalls, []);
  timers.advanceBy(1);
  assert.deepEqual(store.dismissCalls, ['quick']);
  region.destroy();
});

/**
 * 回归（issue #114 的第二半）：render 每次都 clear(root) 整片重建，于是再来一条 toast
 * （批量操作一次弹好几条很常见）就会把你正在读的那条换成新节点——`<details>` 的展开
 * 状态归零、焦点掉回 body。dom-shim 忠实模拟了这一点：移除含 activeElement 的子树会
 * 把 activeElement 打回 body，所以这条用例在修复前是真红。
 */
test('再来一条 toast 时，已展开的详情与焦点留在原处（issue #114）', (t) => {
  const dom = installDom();
  installFakeTimers(t);
  t.after(dom.restore);
  const store = createStore([
    { id: 'err', level: 'error', summary: '拉起失败（gpu-2）', detail: '远端日志尾巴', timeoutMs: null },
  ]);
  const region = createToastRegion({ store });

  const first = region.root.children[0];
  const details = first.querySelector('details');
  details.open = true;
  const copyButton = first.querySelector('.detail-actions button');
  copyButton.focus();
  assert.equal(dom.document.activeElement, copyButton, '前提：焦点确实在复制键上');

  store.push({ id: 'err2', level: 'error', summary: '拉起失败（gpu-3）', detail: '另一台', timeoutMs: null });

  assert.equal(region.root.children.length, 2);
  assert.equal(region.root.children[0], first, '原来那条必须还是同一个节点，不能整片重建');
  assert.equal(details.open, true, '展开状态要留着');
  assert.equal(dom.document.activeElement, copyButton, '焦点不能被抽走');
  region.destroy();
});

test('同一条重复出现只更新计数，节点与焦点都不动（issue #114）', (t) => {
  const dom = installDom();
  installFakeTimers(t);
  t.after(dom.restore);
  const store = createStore([
    { id: 'err', level: 'error', summary: '拉起失败', detail: '日志', count: 1, timeoutMs: null },
  ]);
  const region = createToastRegion({ store });
  const first = region.root.children[0];
  const copyButton = first.querySelector('.detail-actions button');
  copyButton.focus();

  store.bump('err');

  assert.equal(region.root.children[0], first, '同一条只该原地更新');
  assert.match(first.querySelector('.summary').textContent, /×2/, '计数要跟上');
  assert.equal(dom.document.activeElement, copyButton, '焦点不能因为计数变化被抽走');
  region.destroy();
});

test('关掉中间一条：剩下的节点不重建，顺序保持', (t) => {
  const dom = installDom();
  installFakeTimers(t);
  t.after(dom.restore);
  const store = createStore([
    { id: 'a', level: 'error', summary: '第一条', timeoutMs: null },
    { id: 'b', level: 'error', summary: '第二条', timeoutMs: null },
    { id: 'c', level: 'error', summary: '第三条', timeoutMs: null },
  ]);
  const region = createToastRegion({ store });
  const [nodeA, , nodeC] = [...region.root.children];

  store.dismissToast('b');

  assert.equal(region.root.children.length, 2);
  assert.equal(region.root.children[0], nodeA, '前面那条原样留着');
  assert.equal(region.root.children[1], nodeC, '后面那条也原样留着，且顺序没乱');
  region.destroy();
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
