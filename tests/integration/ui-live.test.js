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
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';

import { installDom } from '../web/dom-shim.js';
import { bootServer, newHostState, server } from './helpers.js';

/** 真 SSE 客户端（Node 22 无 EventSource 全局），只实现页面用到的那点表面。 */
class LiveEventSource {
  constructor(url, base) {
    this.url = url;
    this.base = base;
    this.readyState = 0;
    this.listeners = new Map();
    this.req = null;
    this.retryTimer = null;
    this.framesSuspended = false;
    this.#connect();
  }

  #connect() {
    if (this.readyState === 2 || this.req) return;
    const target = new URL(this.url, this.base);
    const req = http.get({ host: target.hostname, port: target.port, path: target.pathname }, (res) => {
      if (this.req !== req || this.readyState === 2) {
        res.destroy();
        return;
      }
      // 原生 EventSource 把 204 当成致命响应：进入 CLOSED、发 error，但不再重试。
      if (res.statusCode === 204) {
        res.resume();
        this.close();
        this.#emit('error', {});
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        this.#fail(req);
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
      // 服务端消失：按原生 EventSource 的语义回到 CONNECTING，并在同一 URL 重连。
      res.on('close', () => this.#fail(req));
    });
    this.req = req;
    req.on('error', () => this.#fail(req));
  }

  #frame(raw) {
    if (this.framesSuspended) return;
    let type = 'message';
    const dataLines = [];
    for (const line of raw.split('\n')) {
      if (line.startsWith(':')) continue; // 心跳
      if (line.startsWith('event:')) type = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    if (dataLines.length > 0) this.#emit(type, { data: dataLines.join('\n') });
  }

  #fail(req) {
    if (this.readyState === 2 || this.req !== req) return;
    this.req = null;
    this.readyState = 0;
    this.#emit('error', {});
    if (this.retryTimer === null) {
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        this.#connect();
      }, 25);
      this.retryTimer.unref?.();
    }
  }

  #emit(type, ev) {
    for (const fn of this.listeners.get(type) ?? []) fn(ev);
  }

  addEventListener(type, fn) {
    const set = this.listeners.get(type) ?? new Set();
    set.add(fn);
    this.listeners.set(type, set);
  }

  suspendFrames() {
    this.framesSuspended = true;
  }

  resumeFrames() {
    this.framesSuspended = false;
  }

  close() {
    this.readyState = 2;
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.req?.destroy();
    this.req = null;
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
  const requests = [];
  const saved = { fetch: globalThis.fetch, es: globalThis.EventSource };
  const sources = [];

  globalThis.fetch = (path, init) => {
    paths.push(path);
    const request = {
      path,
      method: init?.method ?? 'GET',
      body: init?.body ?? null,
      status: null,
      responseText: null,
      completed: false,
    };
    requests.push(request);
    return saved.fetch(new URL(path, ctx.base), init).then(async (res) => {
      request.status = res.status;
      request.responseText = await res.clone().text();
      request.completed = true;
      return res;
    }, (err) => {
      request.completed = true;
      throw err;
    });
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
  return { app, dom, paths, requests, sources };
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

function defaultsControls(dom) {
  const card = dom.app.querySelector('.defaults-card');
  const [remote, managerPort, rangeFrom, rangeTo] = card.querySelectorAll('input');
  return {
    card,
    remote,
    managerPort,
    rangeFrom,
    rangeTo,
    save: btnOf(card, '保存'),
    reset: btnOf(card, '还原'),
    notice: card.querySelector('.card-notice'),
  };
}

function changeValue(control, value) {
  control.value = String(value);
  control.dispatchEvent({ type: 'input' });
}

test('LiveEventSource 收到 204 后永久关闭且不安排重试', async (t) => {
  let requests = 0;
  let errors = 0;
  const endpoint = http.createServer((_req, res) => {
    requests += 1;
    res.writeHead(204).end();
  });
  await new Promise((resolve, reject) => {
    endpoint.once('error', reject);
    endpoint.listen(0, '127.0.0.1', resolve);
  });
  const { port } = endpoint.address();
  const source = new LiveEventSource('/api/events', `http://127.0.0.1:${port}`);
  source.addEventListener('error', () => { errors += 1; });
  t.after(async () => {
    source.close();
    await new Promise((resolve) => endpoint.close(resolve));
  });

  await waitFor(() => source.readyState === 2, '204 永久关闭 EventSource');

  assert.equal(requests, 1);
  assert.equal(errors, 1, '致命响应仍应通知页面进入 offline');
  assert.equal(source.req, null, '204 后不得保留请求引用');
  assert.equal(source.retryTimer, null, '204 后不得安排重试 timer');
});

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

test('#/manage 重载配置：真 POST 返回空 changed 并显示“配置无变化”', async (t) => {
  const ctx = await bootServer(t);
  const {
    app, dom, requests,
  } = await mountLive(t, ctx, { hash: '#/manage' });
  const reload = btnOf(dom.app.querySelector('.manage-header'), '重载配置');
  await waitFor(
    () => app.store.state.connection.sse === 'open' && !reload.disabled,
    '重载配置按钮就绪',
  );

  reload.click();
  assert.equal(app.store.isPending('config:reload'), true, 'POST 完成前应保持 pending');
  assert.equal(reload.disabled, true, 'pending 期间按钮应禁用');

  await waitFor(
    () => requests.some((request) => request.path === '/api/reload'
      && request.method === 'POST' && request.completed),
    '重载配置 POST 完成',
  );
  const post = requests.find((request) => request.path === '/api/reload'
    && request.method === 'POST');
  assert.equal(post.status, 200);
  assert.deepEqual(JSON.parse(post.responseText), { changed: [], orphaned: [], filtered: [] });
  await waitFor(
    () => !app.store.isPending('config:reload')
      && !reload.disabled
      && dom.app.querySelector('.toast-success')?.textContent.includes('配置无变化'),
    '重载无变化成功提示',
  );
});

test('#/manage 主机抽屉保存：真 PUT、SSE 与 REST 持久化保持身份并回填表单', async (t) => {
  const ctx = await bootServer(t, {
    skipBoot: true,
    hostConfig: {
      'gpu-1': {
        autoStart: true,
        local: false,
      },
    },
  });
  const events = await ctx.sse();
  await events.wait((frame) => frame.type === 'snapshot');
  const {
    app, dom, requests,
  } = await mountLive(t, ctx, { hash: '#/manage' });
  await waitFor(
    () => app.store.state.connection.sse === 'open'
      && app.store.getHost('gpu-1')
      && rowOf(dom, 'gpu-1'),
    '管理页 gpu-1 就绪',
  );

  rowOf(dom, 'gpu-1').click();
  const drawer = dom.app.querySelector('.host-drawer');
  await waitFor(() => !drawer.hidden && app.store.state.drawer.host === 'gpu-1', '打开 gpu-1 抽屉');
  const workdir = drawer.querySelectorAll('input').find((node) => node.type === 'text');
  const env = drawer.querySelectorAll('textarea')[0];
  const save = btnOf(drawer, '保存');

  changeValue(workdir, '~/saved-project');
  changeValue(env, 'MODE=integration\nFEATURE=config-save');
  assert.equal(app.store.state.drawer.dirty, true);
  assert.equal(save.disabled, false);
  save.click();

  await waitFor(
    () => requests.some((request) => request.path === '/api/hosts/gpu-1/config'
      && request.method === 'PUT' && request.completed),
    '主机配置 PUT 完成',
  );
  const put = requests.find((request) => request.path === '/api/hosts/gpu-1/config'
    && request.method === 'PUT');
  assert.equal(put.status, 200);
  assert.deepEqual(JSON.parse(put.body), {
    workdir: '~/saved-project',
    inject: {
      env: { MODE: 'integration', FEATURE: 'config-save' },
      extraArgs: [],
      patches: [],
    },
  }, '抽屉只提交实际改动，不得顺带覆盖 autoStart/local identity');

  const sse = await events.wait((frame) => frame.type === 'host-changed'
    && frame.data.host.config.workdir === '~/saved-project');
  const [config, hosts] = await Promise.all([
    ctx.get('/api/config'),
    ctx.get('/api/hosts'),
  ]);
  const restHost = hosts.json.hosts.find((host) => host.name === 'gpu-1');
  const storedHost = app.store.getHost('gpu-1');

  assert.equal(config.status, 200);
  assert.equal(config.json.hosts['gpu-1'].workdir, '~/saved-project');
  assert.deepEqual(config.json.hosts['gpu-1'].inject.env, {
    MODE: 'integration',
    FEATURE: 'config-save',
  });
  assert.equal(config.json.hosts['gpu-1'].autoStart, true);
  assert.equal(config.json.hosts['gpu-1'].local, false);
  const hostViews = [
    ['SSE HostView', sse.data.host],
    ['REST HostView', restHost],
    ['页面 store', storedHost],
  ];
  for (const [label, host] of hostViews) {
    assert.equal(host.config.autoStart, true, `${label} 不得丢 autoStart`);
    assert.equal(host.local, false, `${label} 不得丢顶层 local identity`);
    assert.equal(host.config.local, false, `${label} 不得丢 config.local identity`);
  }

  await waitFor(
    () => app.store.state.drawer.dirty === false
      && save.disabled
      && workdir.value === '~/saved-project'
      && env.value === 'MODE=integration\nFEATURE=config-save'
      && dom.app.querySelector('.toast-success')?.textContent.includes('gpu-1 配置已保存'),
    '主机保存后清脏并回显',
  );
});

test('#/manage 主机抽屉保存遇 CONFIG_STALE：保留 dirty 草稿并逐字保护磁盘配置', async (t) => {
  const ctx = await bootServer(t, { skipBoot: true });
  const {
    app, dom, requests,
  } = await mountLive(t, ctx, { hash: '#/manage' });
  await waitFor(
    () => app.store.state.connection.sse === 'open'
      && app.store.getHost('gpu-1')
      && rowOf(dom, 'gpu-1'),
    'CONFIG_STALE 用例管理页就绪',
  );

  rowOf(dom, 'gpu-1').click();
  const drawer = dom.app.querySelector('.host-drawer');
  await waitFor(() => !drawer.hidden && app.store.state.drawer.host === 'gpu-1', '打开 gpu-1 抽屉');
  const workdir = drawer.querySelectorAll('input').find((node) => node.type === 'text');
  const save = btnOf(drawer, '保存');
  const draft = '~/keep-dirty-after-stale';
  changeValue(workdir, draft);

  const configPath = path.join(ctx.harness.homeDir, 'config.json');
  const externallyEdited = `${fs.readFileSync(configPath, 'utf8')}\n`;
  fs.writeFileSync(configPath, externallyEdited);

  assert.equal(app.store.state.drawer.dirty, true);
  assert.equal(save.disabled, false);
  save.click();
  assert.equal(app.store.isPending('config:save', 'gpu-1'), true, '失败响应前保存应 pending');
  assert.equal(save.disabled, true, 'pending 期间保存按钮应禁用');

  await waitFor(
    () => requests.some((request) => request.path === '/api/hosts/gpu-1/config'
      && request.method === 'PUT' && request.completed),
    'CONFIG_STALE PUT 完成',
  );
  const put = requests.find((request) => request.path === '/api/hosts/gpu-1/config'
    && request.method === 'PUT');
  assert.equal(put.status, 409);
  assert.equal(JSON.parse(put.responseText).code, 'CONFIG_STALE');
  await waitFor(
    () => !app.store.isPending('config:save', 'gpu-1')
      && app.store.state.drawer.dirty
      && !save.disabled
      && workdir.value === draft
      && dom.app.querySelector('.toast-error')?.textContent.includes('配置文件被外部改过'),
    'CONFIG_STALE 后释放 pending 并保留草稿',
  );

  assert.equal(dom.app.querySelector('.toast-success'), null, '失败不得显示保存成功');
  assert.equal(
    app.store.state.toasts.some((toast) => toast.level === 'success'),
    false,
    '失败不得留下 success toast',
  );
  assert.equal(fs.readFileSync(configPath, 'utf8'), externallyEdited, '失败后磁盘配置必须逐字不变');
});

test('#/manage 全局默认保存：持久化 canonical 值并提示 manager 重启', async (t) => {
  const ctx = await bootServer(t);
  const managerTarget = ctx.port === 18_888 ? 18_889 : 18_888;
  const events = await ctx.sse();
  await events.wait((frame) => frame.type === 'snapshot');
  const {
    app, dom, requests,
  } = await mountLive(t, ctx, { hash: '#/manage' });
  const controls = defaultsControls(dom);
  await waitFor(
    () => app.store.state.connection.sse === 'open'
      && controls.remote.value === '8899'
      && controls.save.disabled,
    '全局默认卡加载',
  );

  changeValue(controls.remote, '018999');
  changeValue(controls.managerPort, `0${managerTarget}`);
  changeValue(controls.rangeFrom, '031000');
  changeValue(controls.rangeTo, '031010');
  assert.equal(controls.save.disabled, false);
  assert.equal(controls.reset.disabled, false);
  controls.save.click();

  await waitFor(
    () => requests.some((request) => request.path === '/api/config/defaults'
      && request.method === 'PUT' && request.completed),
    '全局默认 PUT 完成',
  );
  const put = requests.find((request) => request.path === '/api/config/defaults'
    && request.method === 'PUT');
  assert.equal(put.status, 200);
  assert.deepEqual(JSON.parse(put.body), {
    remoteWebPort: 18_999,
    localPortRange: [31_000, 31_010],
    manager: { port: managerTarget },
  });

  const frame = await events.wait((item) => item.type === 'config-changed'
    && item.data.defaults.remoteWebPort === 18_999
    && item.data.manager.port === managerTarget);
  const config = await ctx.get('/api/config');
  assert.equal(config.status, 200);
  assert.equal(config.json.defaults.remoteWebPort, 18_999);
  assert.deepEqual(config.json.defaults.localPortRange, [31_000, 31_010]);
  assert.equal(config.json.manager.port, managerTarget);
  assert.deepEqual(frame.data.defaults, config.json.defaults, 'SSE 与持久化 defaults 应一致');

  await waitFor(
    () => controls.remote.value === '18999'
      && controls.managerPort.value === String(managerTarget)
      && controls.rangeFrom.value === '31000'
      && controls.rangeTo.value === '31010'
      && controls.save.disabled
      && controls.reset.disabled
      && !controls.notice.hidden
      && /重启 manager 后生效/.test(controls.notice.textContent)
      && dom.app.querySelector('.toast-success')?.textContent.includes('需重启后生效'),
    '全局默认 canonical 回显与重启提示',
  );
});

test('#/manage 断线期间另一页改 manager 端口：重连 snapshot 恢复目标端口与重启提示', async (t) => {
  const ctx = await bootServer(t);
  const managerTarget = ctx.port === 18_888 ? 18_889 : 18_888;
  const {
    app, dom, paths, sources,
  } = await mountLive(t, ctx, { hash: '#/manage' });
  const controls = defaultsControls(dom);
  await waitFor(
    () => app.store.state.connection.sse === 'open'
      && app.store.state.manager.configuredPort === 7788
      && controls.managerPort.value === '7788',
    '断线前 manager 配置端口加载',
  );
  const configGetsBefore = paths.filter((item) => item === '/api/config').length;

  // 本页漏掉另一页保存产生的 config-changed，随后连接断开；恢复只能依赖新连接首帧 snapshot。
  sources[0].suspendFrames();
  const put = await ctx.api('PUT', '/api/config/defaults', { manager: { port: managerTarget } });
  assert.equal(put.status, 200);
  assert.equal(app.store.state.manager.configuredPort, 7788, '断线页必须确实漏掉配置变更帧');

  sources[0].req.destroy();
  sources[0].resumeFrames();
  await waitFor(
    () => app.store.state.connection.sse === 'open'
      && !app.store.state.connection.resyncing
      && app.store.state.manager.configuredPort === managerTarget,
    '重连 snapshot 恢复 manager 配置端口',
  );

  assert.equal(controls.managerPort.value, String(managerTarget));
  assert.equal(controls.notice.hidden, false);
  assert.match(controls.notice.textContent, new RegExp(`已配置为 ${managerTarget}.*重启 manager 后生效`));
  assert.equal(
    paths.filter((item) => item === '/api/config').length,
    configGetsBefore,
    '重连不得另发 config GET 与 snapshot 竞态',
  );
});

test('#/manage 非法本机端口区间：前端拦截且不得成功或改写配置', async (t) => {
  const ctx = await bootServer(t);
  const before = (await ctx.get('/api/config')).json;
  const {
    app, dom, requests,
  } = await mountLive(t, ctx, { hash: '#/manage' });
  const controls = defaultsControls(dom);
  await waitFor(
    () => app.store.state.connection.sse === 'open'
      && controls.rangeFrom.value === String(before.defaults.localPortRange[0]),
    '非法保存用例加载',
  );

  changeValue(controls.rangeFrom, '1023');
  assert.equal(controls.save.disabled, false);
  controls.save.click();
  await waitFor(
    () => controls.card.querySelectorAll('.field-error')
      .some((node) => node.textContent.includes('1024')),
    '本机端口下限校验出现',
  );

  assert.equal(
    requests.some((request) => request.path === '/api/config/defaults' && request.method === 'PUT'),
    false,
    '前端判定非法后不得发 PUT',
  );
  assert.equal(app.store.state.toasts.some((toast) => toast.level === 'success'), false);
  assert.equal(dom.app.querySelector('.toast-success'), null, '校验失败不得宣称保存成功');
  assert.deepEqual((await ctx.get('/api/config')).json, before, '校验失败不得改写持久化配置');
});

test('#/manage 批量同步：真 preview 不落盘，apply 经 SSE/REST/store 原子收敛', async (t) => {
  const sharedInject = {
    env: { BROWSER_SYNC_SECRET: 'server-only-value' },
    extraArgs: ['--source'],
    patches: ['source.patch'],
  };
  const ctx = await bootServer(t, {
    skipBoot: true,
    hosts: {
      source: newHostState(),
      'target-a': newHostState(),
      'target-b': newHostState(),
    },
    hostConfig: {
      source: {
        remoteWebPort: 19_901,
        workdir: '~/source-workdir',
        inject: sharedInject,
      },
      'target-a': {
        enabled: false,
        autoStart: true,
        localPort: 17_777,
        remoteWebPort: 19_902,
        workdir: '~/old-workdir',
        inject: { env: { OLD: 'yes' }, extraArgs: ['--old'], patches: ['old.patch'] },
      },
      'target-b': {
        remoteWebPort: 19_903,
        workdir: '~/source-workdir',
        inject: sharedInject,
      },
    },
  });
  const events = await ctx.sse();
  await events.wait((frame) => frame.type === 'snapshot');
  const before = (await ctx.get('/api/config')).json;
  const {
    app, dom, requests,
  } = await mountLive(t, ctx, { hash: '#/manage' });
  await waitFor(
    () => app.store.state.connection.sse === 'open'
      && app.store.listHosts().length === 3
      && !dom.app.querySelector('.config-sync-open').disabled,
    '批量同步入口就绪',
  );

  const entry = dom.app.querySelector('.config-sync-open');
  entry.focus();
  entry.click();
  const dialog = dom.app.querySelector('.config-sync-dialog');
  assert.equal(dialog.open, true);
  assert.equal(dialog.querySelector('[data-host="target-a"]'), null, '批量同步不得展示禁用目标');
  for (const name of ['target-b']) {
    const target = dialog.querySelector(`[data-host="${name}"]`);
    target.checked = true;
    target.dispatchEvent({ type: 'change' });
  }
  btnOf(dialog, '预览变更').click();

  await waitFor(
    () => requests.some((request) => request.path === '/api/hosts/sync-config'
      && request.method === 'POST' && request.completed),
    '批量同步 preview 完成',
  );
  const previewRequest = requests.find((request) => request.path === '/api/hosts/sync-config');
  assert.deepEqual(JSON.parse(previewRequest.body), {
    source: 'source',
    targets: ['target-b'],
    dryRun: true,
  });
  assert.deepEqual((await ctx.get('/api/config')).json, before, 'preview 必须完全只读');
  assert.match(dialog.querySelector('.config-sync-results').textContent, /target-b.*将变更/s);
  assert.doesNotMatch(dialog.textContent, /server-only-value|--source|source\.patch/,
    '预览只能显示字段名，不能泄漏配置值');

  btnOf(dialog, '应用同步').click();
  await waitFor(
    () => requests.filter((request) => request.path === '/api/hosts/sync-config'
      && request.method === 'POST' && request.completed).length === 2,
    '批量同步 apply 完成',
  );
  const applyRequest = requests.filter((request) => request.path === '/api/hosts/sync-config')[1];
  const applyBody = JSON.parse(applyRequest.body);
  assert.deepEqual({
    source: applyBody.source,
    targets: applyBody.targets,
    dryRun: applyBody.dryRun,
  }, {
    source: 'source',
    targets: ['target-b'],
    dryRun: false,
  });
  assert.match(applyBody.previewToken, /^v1\.[A-Za-z0-9_-]+$/, 'apply 必须带 preview 返回的 opaque token');
  const changedFrame = await events.wait((frame) => frame.type === 'host-changed'
    && frame.data.host.name === 'target-b'
    && frame.data.host.config.workdir === '~/source-workdir');
  const after = (await ctx.get('/api/config')).json;
  assert.deepEqual(after.hosts['target-b'].inject, sharedInject);
  assert.equal(after.hosts['target-b'].remoteWebPort, 19_901);
  assert.equal(after.hosts['target-b'].workdir, '~/source-workdir');
  assert.equal(after.hosts['target-a'].remoteWebPort, 19_902);
  assert.equal(after.hosts['target-a'].workdir, '~/old-workdir');
  assert.equal(after.hosts['target-a'].enabled, false);
  assert.equal(after.hosts['target-a'].autoStart, true);
  assert.equal(after.hosts['target-a'].localPort, 17_777);
  assert.deepEqual(changedFrame.data.host.config.inject, sharedInject);
  assert.deepEqual(app.store.getHost('target-b').config.inject, sharedInject);
  assert.match(dom.app.querySelector('.toast-success').textContent, /已同步 1 台主机配置/);
  assert.equal(dialog.querySelector('.config-sync-apply').disabled, true);

  btnOf(dialog, '关闭').click();
  assert.equal(dialog.open, false);
  assert.equal(dom.document.activeElement, entry);
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

test('manager 同端口重启：断线时禁写但保留返回导航，snapshot 后恢复页面', async (t) => {
  const ctx = await bootServer(t);
  const {
    app, dom, requests, sources,
  } = await mountLive(t, ctx);
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
    [['返回主页面', false], ['全部探测', true], ['重载配置', true], ['批量同步配置', true]],
    '断线不应禁用返回导航，但 manage 页头的写操作必须全部禁用',
  );
  const reload = btnOf(dom.app.querySelector('.manage-header'), '重载配置');
  const reloadPosts = () => requests.filter(
    (request) => request.path === '/api/reload' && request.method === 'POST',
  ).length;
  const beforeReloadPosts = reloadPosts();
  reload.click();
  await Promise.resolve();
  assert.equal(reloadPosts(), beforeReloadPosts, '断线期点击禁用按钮不得发重载请求');

  const originalPort = ctx.port;
  await ctx.startSamePort();
  assert.equal(ctx.port, originalPort, 'manager 必须在原端口恢复，页面地址不变');
  await waitFor(
    () => app.store.state.connection.sse === 'open'
      && !app.store.state.connection.resyncing
      && banner.hidden,
    '同端口重连后的 snapshot 到达',
  );

  assert.ok(rowOf(dom, 'gpu-1'), '恢复 snapshot 后至少仍有一行主机');
  assert.deepEqual(
    dom.app.querySelectorAll('.manage-header .btn').map((button) => [button.textContent, button.disabled]),
    [['返回主页面', false], ['全部探测', false], ['重载配置', false], ['批量同步配置', true]],
    '恢复同步后一般写操作应解禁；单主机仍不满足批量同步前提',
  );
});

test('store+DOM 桥接：running snapshot 解除断线前 start pending 并创建正确 iframe', async (t) => {
  const ctx = await bootServer(t);
  const { app, dom, sources } = await mountLive(t, ctx);
  await waitFor(() => app.store.getHost('gpu-1')?.phase === 'ready', 'gpu-1 就绪');

  const accepted = await ctx.api('POST', '/api/hosts/gpu-1/start');
  assert.equal(accepted.status, 202);
  await waitFor(async () => {
    const hosts = (await ctx.get('/api/hosts')).json.hosts;
    return hosts.find((host) => host.name === 'gpu-1')?.phase === 'running';
  }, 'manager 已把 gpu-1 推到 running');
  await waitFor(() => app.store.getHost('gpu-1')?.phase === 'running', '页面收到 running');

  // 真实 manager 提供恢复真相；pending 与断线窗口由 store+DOM 桥接确定性制造，
  // 避免把 _shutdownForTest 插进远端启动流水线产生不可控进程竞态。
  const apiState = await ctx.get('/api/hosts');
  const fromApi = apiState.json.hosts.find((host) => host.name === 'gpu-1');
  const staleReady = {
    ...fromApi,
    phase: 'ready',
    mappedUrl: null,
    tunnel: null,
    web: null,
  };
  sources[0].suspendFrames();
  app.store.applySnapshot({ revision: apiState.json.revision, hosts: [staleReady] });
  app.store.beginPending({ action: 'start', host: 'gpu-1' });
  dom.window.location.hash = '#/host/gpu-1';

  assert.equal(app.store.hostBusy('gpu-1'), true);
  assert.equal(btnOf(rowOf(dom, 'gpu-1'), '拉起').disabled, true, 'pending 行按钮应进入忙态');
  const pendingPane = dom.app.querySelector('.iframe-pane.is-placeholder');
  assert.equal(pendingPane.hidden, false);
  assert.equal(pendingPane.querySelector('.iframe-overlay').getAttribute('aria-busy'), 'true');

  app.store.setConnection({ sse: 'reconnecting' });
  assert.equal(app.store.canWrite(), false);
  app.store.setConnection({ sse: 'open', resyncing: true });
  app.store.applySnapshot({
    revision: apiState.json.revision,
    hosts: apiState.json.hosts,
    manager: (await ctx.get('/api/manager/info')).json,
    defaults: app.store.state.defaults,
  });

  const frame = dom.app.querySelector('.iframe-pane[data-host="gpu-1"] iframe');
  assert.equal(app.store.isPending('start', 'gpu-1'), false);
  assert.equal(app.store.hostBusy('gpu-1'), false);
  assert.equal(btnOf(rowOf(dom, 'gpu-1'), '关停').disabled, false, 'snapshot 结算后按钮忙态应解除');
  assert.equal(frame.getAttribute('src'), fromApi.mappedUrl, 'iframe 必须使用恢复后 GET 给出的 mappedUrl');
});
