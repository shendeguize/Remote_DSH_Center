/** 舰队会话分析卡片：按需只读、写权限跟随、结果与降级的呈现契约。 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createFleetAnalysis } from '../../src/web/components/fleet-analysis.js';
import { findAll, installDom, textOf } from './dom-shim.js';

/** 只暴露卡片真正用到的那几样能力，避免把整个 store 拖进来。 */
function createStore({ writable = true } = {}) {
  const listeners = new Map();
  let canWrite = writable;
  return {
    canWrite: () => canWrite,
    on(event, fn) {
      const handlers = listeners.get(event) ?? new Set();
      handlers.add(fn);
      listeners.set(event, handlers);
      return () => handlers.delete(fn);
    },
    /** 模仿真 store：改写权限后广播 connection:changed。 */
    setWritable(next) {
      canWrite = next;
      for (const fn of [...(listeners.get('connection:changed') ?? [])]) fn();
    },
    listenerCount(event) {
      return listeners.get(event)?.size ?? 0;
    },
  };
}

/** 卡片只调 POST /api/analysis/fleet 这一个端点。 */
function fakeFetch(t, respond) {
  const calls = [];
  const saved = globalThis.fetch;
  globalThis.fetch = async (path, init = {}) => {
    calls.push({ path, method: init.method ?? 'GET' });
    return respond(calls.length);
  };
  t.after(() => { globalThis.fetch = saved; });
  return calls;
}

const jsonOk = (body) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });

/** 垫片的 dispatchEvent 不回传处理器的 promise，异步点击要另外等一拍。 */
const flush = () => new Promise((r) => { setTimeout(r, 0); });

async function click(run) {
  run.dispatchEvent({ type: 'click' });
  await flush();
}

function mount(t, storeOpts) {
  const dom = installDom();
  t.after(() => dom.restore());
  const store = createStore(storeOpts);
  const card = createFleetAnalysis({ store });
  t.after(() => card.destroy());
  const run = card.root.querySelectorAll('button')[0];
  return {
    store,
    card,
    run,
    status: () => textOf(card.root.querySelectorAll('p')[0]),
    report: () => card.root.querySelectorAll('p.analysis-report')[0],
    items: () => findAll(card.root, 'li').map((li) => textOf(li)),
  };
}

test('挂载即为只读态时按钮就是禁用的，并说明写操作为何暂停', (t) => {
  // 修前：按钮恒为可用态，失联时点下去 onClick 首行直接 return——既不报错也不出任何
  // 提示，用户只看到一个点了没反应的「分析」。
  const h = mount(t, { writable: false });
  assert.equal(h.run.disabled, true);
  assert.equal(h.run.title, '与 manager 失联，写操作已暂停');

  h.store.setWritable(true);
  assert.equal(h.run.disabled, false, '写权限恢复后立刻可用');
  assert.equal(h.run.title, '');

  h.store.setWritable(false);
  assert.equal(h.run.disabled, true, '再次失联又禁用');
});

test('点击分析：只发一次 POST，聚类逐条渲染，摘要另起一段', async (t) => {
  const h = mount(t);
  const calls = fakeFetch(t, () => jsonOk({
    cached: false,
    generatedAt: '2026-09-01T02:00:00Z',
    clusters: [
      { project: 'dsh_cowork', agent: 'claude', model: 'sonnet-4', count: 3, hosts: ['lse_shadow', 'dsh_debug'] },
      { project: 'infra', agent: 'codex', model: 'gpt-5', count: 1, hosts: [] },
    ],
    report: '两台机器都在改 Center。',
  }));

  await click(h.run);

  assert.deepEqual(calls, [{ path: '/api/analysis/fleet', method: 'POST' }]);
  assert.match(h.status(), /刚刚完成：2 个聚类（2026-09-01T02:00:00Z）/);
  assert.deepEqual(h.items(), [
    'dsh_cowork · claude sonnet-4 × 3 · lse_shadow, dsh_debug',
    'infra · codex gpt-5 × 1',
  ]);
  assert.equal(h.report().hidden, false);
  assert.equal(textOf(h.report()), '本机摘要：两台机器都在改 Center。');
  assert.equal(h.run.disabled, false, '跑完按钮要还回去');
});

test('缓存结果、缺字段的聚类与空舰队都有明确呈现', async (t) => {
  const h = mount(t);
  fakeFetch(t, () => jsonOk({ cached: true, clusters: [{}] }));

  await click(h.run);
  assert.match(h.status(), /使用缓存：1 个聚类（时间未知）/);
  assert.deepEqual(h.items(), ['unknown · unknown unknown × 0'], '缺字段按 unknown 展示而不是空白');
  assert.equal(h.report().hidden, true, '没有摘要就不留空段落');

  h.card.destroy();
  const empty = mount(t);
  fakeFetch(t, () => jsonOk({ clusters: [] }));
  await click(empty.run);
  assert.deepEqual(empty.items(), ['没有可展示的聚类。']);
});

test('部分主机不可用时保留已得结果，并把失败原因追加到状态行', async (t) => {
  const h = mount(t);
  fakeFetch(t, () => jsonOk({
    clusters: [{ project: 'a', agent: 'claude', model: 'm', count: 1, hosts: ['gpu-1'] }],
    partial: true,
    failures: [{ host: 'gpu-2', detail: 'sidecar 未安装' }, { host: 'gpu-3', detail: null }],
  }));

  await click(h.run);
  assert.equal(h.items().length, 1, '部分失败不丢已采到的聚类');
  assert.match(h.status(), /（部分能力不可用：sidecar 未安装）/);
  assert.doesNotMatch(h.status(), /；/, '没有 detail 的失败项不该留出空的分隔符');
});

test('partial 但没给失败明细时只提示能力缺失', async (t) => {
  const h = mount(t);
  fakeFetch(t, () => jsonOk({ clusters: [], partial: true }));

  await click(h.run);
  assert.match(h.status(), /（部分能力不可用）/);
});

test('分析失败把原因写进状态行，按钮回到可用态以便重试', async (t) => {
  const h = mount(t);
  fakeFetch(t, () => ({
    ok: false,
    status: 503,
    text: async () => JSON.stringify({ error: 'manager 正在重启' }),
  }));

  await click(h.run);
  assert.match(h.status(), /^分析失败：manager 正在重启/);
  assert.equal(h.run.disabled, false, '失败后必须能重试');
});

test('分析进行中不接受二次点击，也不会因失联卡在禁用态', async (t) => {
  const h = mount(t);
  let release;
  const gate = new Promise((r) => { release = r; });
  const calls = fakeFetch(t, async () => {
    await gate;
    return jsonOk({ clusters: [] });
  });

  h.run.dispatchEvent({ type: 'click' });
  assert.equal(h.run.disabled, true, '在跑的时候按钮禁用');
  assert.match(h.status(), /正在采集聚类并生成本机摘要…/);
  await click(h.run);
  assert.equal(calls.length, 1, '重入被挡住，不该打第二发请求');

  release();
  await flush();
  assert.equal(h.run.disabled, false);
});

test('destroy 摘掉全部订阅，重复挂载不累积监听', (t) => {
  const h = mount(t, {});
  assert.equal(h.store.listenerCount('connection:changed'), 1);
  assert.equal(h.store.listenerCount('pending:changed'), 1);

  h.card.destroy();
  assert.equal(h.store.listenerCount('connection:changed'), 0);
  assert.equal(h.store.listenerCount('pending:changed'), 0);
});
