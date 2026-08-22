/**
 * 页面对真后端的挂载验收（UI-28 / TST-06 收口）。
 *
 * `tests/web/*` 用手写 fixture 喂前端，抓的是组件自身的逻辑；这里把 DOM 垫片接到
 * **真的 manager**（真 HTTP、真 SSE 分帧、假远端只在 ssh 那一层），抓的是两侧契约漂移：
 * 后端换了字段名 / 少给一层对象，fixture 测试照样绿，这层会红。
 *
 * 顺带把人工清单里不需要人眼的几项自动化了：同源相对路径（第 22 项）、
 * setup 门禁强制跳转（第 1 项的后端侧）、manager 掉线横幅与禁写（第 13 项）。
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { installDom } from '../web/dom-shim.js';
import { bootServer, newHostState, server } from './helpers.js';

/** 真 SSE 客户端（Node 22 无 EventSource 全局），只实现页面用到的那点表面。 */
class LiveEventSource {
  constructor(url, base) {
    this.url = url;
    this.readyState = 0;
    this.listeners = new Map();
    const target = new URL(url, base);
    this.req = http.get({ host: target.hostname, port: target.port, path: target.pathname }, (res) => {
      if (res.statusCode !== 200) {
        this.#fail();
        return;
      }
      this.readyState = 1;
      this.#emit('open', {});
      let buffer = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buffer += chunk;
        let idx = buffer.indexOf('\n\n');
        while (idx !== -1) {
          this.#frame(buffer.slice(0, idx));
          buffer = buffer.slice(idx + 2);
          idx = buffer.indexOf('\n\n');
        }
      });
      // 服务端消失：浏览器会自己退避重连，这里只把状态摆成 CONNECTING 后报 error
      res.on('close', () => this.#fail());
    });
    this.req.on('error', () => this.#fail());
  }

  #frame(raw) {
    let type = 'message';
    const dataLines = [];
    for (const line of raw.split('\n')) {
      if (line.startsWith(':')) continue; // 心跳
      if (line.startsWith('event:')) type = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    if (dataLines.length > 0) this.#emit(type, { data: dataLines.join('\n') });
  }

  #fail() {
    if (this.readyState === 2) return;
    this.readyState = 0;
    this.#emit('error', {});
  }

  #emit(type, ev) {
    for (const fn of this.listeners.get(type) ?? []) fn(ev);
  }

  addEventListener(type, fn) {
    const set = this.listeners.get(type) ?? new Set();
    set.add(fn);
    this.listeners.set(type, set);
  }

  close() {
    this.readyState = 2;
    this.req.destroy();
  }
}

/**
 * 把页面挂到真 manager 上。
 * @param {import('node:test').TestContext} t
 * @param {{base:string}} ctx bootServer 的返回
 */
async function mountLive(t, ctx, { hash = null } = {}) {
  const dom = installDom();
  if (hash) dom.window.location.hash = hash;

  const paths = [];
  const saved = { fetch: globalThis.fetch, es: globalThis.EventSource };
  const sources = [];

  globalThis.fetch = (path, init) => {
    paths.push(path);
    return saved.fetch(new URL(path, ctx.base), init);
  };
  globalThis.EventSource = class extends LiveEventSource {
    constructor(url) {
      super(url, ctx.base);
      sources.push(this);
    }
  };

  const { bootApp } = await import('../../src/web/app.js');
  const app = bootApp();

  t.after(() => {
    app.destroy();
    for (const es of sources) es.close();
    globalThis.fetch = saved.fetch;
    if (saved.es === undefined) delete globalThis.EventSource;
    else globalThis.EventSource = saved.es;
    dom.restore();
  });

  await waitFor(() => paths.includes('/api/manager/info') && app.store.state.manager.pid !== null,
    '首屏 GET /api/manager/info');
  return { app, dom, paths, sources };
}

async function waitFor(cond, label, { timeoutMs = 15_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop -- 轮询真后端
    if (await cond()) return;
    if (Date.now() > deadline) throw new Error(`等待超时（${label}）`);
    // 不 unref：断线用例里定时器是唯一的活儿，unref 会让 node 判定「事件循环已空」而掐掉用例
    // eslint-disable-next-line no-await-in-loop -- 同上
    await new Promise((r) => { setTimeout(r, 25); });
  }
}

const rowOf = (dom, name) => dom.app
  .querySelectorAll('.host-table tbody tr')
  .find((tr) => tr.dataset.host === name) ?? null;

const btnOf = (scope, label) => scope?.querySelectorAll('.btn').find((b) => b.textContent === label) ?? null;

test('首屏对真后端：三个 GET 全是同源相对路径，表格与 SSE snapshot 一致', async (t) => {
  const ctx = await bootServer(t, { hosts: { 'gpu-1': newHostState(), 'gpu-2': newHostState() } });
  const { app, dom, paths } = await mountLive(t, ctx);

  await waitFor(() => app.store.listHosts().length === 2, 'snapshot 到达');

  assert.equal(paths.every((p) => p.startsWith('/api/')), true,
    `页面不得出现绝对地址：${paths.filter((p) => !p.startsWith('/api/')).join(', ')}`);
  assert.deepEqual([...new Set(paths)].sort(), ['/api/config', '/api/hosts', '/api/manager/info']);

  const api = await ctx.get('/api/hosts');
  for (const host of api.json.hosts) {
    const row = rowOf(dom, host.name);
    assert.ok(row, `${host.name} 应有一行`);
    // 后端字段改名/少一层，这里的徽章文案就会落回 unknown
    assert.match(row.textContent, /可拉起/, `${host.name} 探测结果应渲染成「可拉起」`);
  }
  assert.equal(app.store.state.revision >= api.json.revision, true, 'SSE revision 不应落后于 GET');
  assert.equal(dom.app.querySelector('.defaults-card').querySelectorAll('input')[0].value, '8899');
  const info = (await ctx.get('/api/manager/info')).json;
  assert.match(dom.app.querySelector('.manager-card').textContent, new RegExp(String(info.pid)),
    'manager 卡应显示后端给的 pid');
});

test('页面点「拉起」→ 真起真隧道 → 标签页 iframe 指向后端给的 mappedUrl → 「关停」收回', async (t) => {
  const ctx = await bootServer(t);
  const { app, dom } = await mountLive(t, ctx);
  await waitFor(() => app.store.getHost('gpu-1')?.phase === 'ready', 'gpu-1 就绪');

  btnOf(rowOf(dom, 'gpu-1'), '拉起').click();
  await waitFor(() => app.store.getHost('gpu-1').phase === 'running', 'SSE 推到 running');

  const host = app.store.getHost('gpu-1');
  const fromApi = (await ctx.get('/api/hosts')).json.hosts[0];
  assert.equal(host.mappedUrl, fromApi.mappedUrl);
  assert.match(host.mappedUrl, /^http:\/\/127\.0\.0\.1:\d+\/$/);

  const tabs = dom.app.querySelectorAll('.host-tabs .tab');
  assert.deepEqual(tabs.map((tb) => tb.textContent.trim()), ['gpu-1'], 'running 主机应进标签栏');

  dom.window.location.hash = '#/host/gpu-1';
  const frame = dom.app.querySelector('.iframe-pane[data-host="gpu-1"] iframe');
  assert.equal(frame.getAttribute('src'), host.mappedUrl, 'iframe 地址来自后端，不由前端拼');
  assert.equal(dom.app.querySelector('.view-dashboard').hidden, true);

  const stopBtn = btnOf(rowOf(dom, 'gpu-1'), '关停');
  assert.equal(stopBtn.disabled, false, 'running 且本工具拉起的主机应可关停');
  stopBtn.click();

  const dialog = dom.app.querySelector('.confirm-dialog');
  assert.equal(dialog.open, true, '关停是危险动作，必须先确认');
  btnOf(dialog, '关停').click();
  await waitFor(() => app.store.getHost('gpu-1').phase === 'ready', 'SSE 推回 ready');

  assert.deepEqual(
    dom.app.querySelectorAll('.host-tabs .tab').map((tab) => tab.dataset.host),
    ['gpu-1'],
    'ready 后标签仍应常驻',
  );
  assert.equal(dom.app.querySelector('.iframe-pane[data-host="gpu-1"]'), null, 'pane 应销毁（会话不残留）');
});

test('未初始化：真后端门禁把页面按到 #/setup，且只发白名单请求', async (t) => {
  const ctx = await bootServer(t, { setupCompleted: false, skipBoot: true });
  assert.equal(ctx.setupGate, true);

  const { app, dom, paths } = await mountLive(t, ctx, { hash: '#/' });
  await waitFor(() => dom.window.location.hash === '#/setup', '强制跳转到向导');

  assert.equal(app.store.state.manager.setupCompleted, false);
  assert.equal(dom.app.querySelector('.setup-wizard').hidden, false);
  assert.equal(dom.app.querySelector('.view-dashboard').hidden, true);
  assert.equal(paths.includes('/api/hosts'), false, '向导第 3 步之前不该拉主机清单');

  // 门禁期间真发一次非白名单写请求：后端必须 409 SETUP_REQUIRED（页面据此禁写）
  const denied = await ctx.api('POST', '/api/hosts/gpu-1/start');
  assert.equal(denied.status, 409);
  assert.equal(denied.json.code, 'SETUP_REQUIRED');
});

test('manager 掉线：横幅出现且写按钮全禁用', async (t) => {
  const ctx = await bootServer(t);
  const { app, dom, sources } = await mountLive(t, ctx);
  await waitFor(() => app.store.listHosts().length === 1, 'snapshot 到达');

  const banner = dom.app.querySelector('.disconnect-banner');
  assert.equal(banner.hidden, true);

  await server._shutdownForTest(); // 相当于 dshc down
  await waitFor(() => sources[0].readyState === 0 && !banner.hidden, '断线横幅出现');

  assert.match(banner.textContent, /失联/);
  assert.equal(dom.app.querySelector('.header-actions .btn'), null, '非 manage 路由不显示全局动作');
  assert.equal(btnOf(rowOf(dom, 'gpu-1'), '拉起').disabled, true);

  dom.window.location.hash = '#/manage';
  const manageActions = dom.app.querySelectorAll('.manage-header .btn');
  assert.deepEqual(
    manageActions.map((button) => [button.textContent, button.disabled]),
    [['全部探测', true], ['重载配置', true]],
    '全局动作只在 manage 页头，且断线时全部禁用',
  );
});
