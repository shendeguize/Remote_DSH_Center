import assert from 'node:assert/strict';
import test from 'node:test';

import { createHub, hubHosts } from '../../src/web/components/hub.js';
import { visibleTabs } from '../../src/web/components/tabbar.js';
import { createStore } from '../../src/web/store.js';
import {
  flush, hostView, mount,
} from './app-harness.js';
import { installDom } from './dom-shim.js';

function host(name, phase = 'ready', patch = {}) {
  return {
    name,
    local: false,
    enabled: true,
    config: { enabled: true, localPort: null },
    phase,
    mappedUrl: null,
    tunnel: null,
    ...patch,
  };
}

function mountHub(t, hosts = []) {
  const dom = installDom();
  const store = createStore({
    hosts: new Map(hosts.map((item) => [item.name, item])),
    hostsLoaded: true,
  });
  const opened = [];
  let localAdds = 0;
  const hub = createHub({
    store,
    actions: {
      openHost: (name) => opened.push(name),
      addLocalHost: () => { localAdds += 1; },
    },
  });
  dom.app.append(hub.root);
  t.after(() => {
    hub.destroy();
    dom.restore();
  });
  return { dom, store, hub, opened, localAdds: () => localAdds };
}

test('Hub 分类：五种可开态进主卡片，其余状态与禁用主机折叠', () => {
  const disabled = host('disabled', 'running', { config: { enabled: false } });
  const hosts = [
    host('ready', 'ready'),
    host('starting', 'starting'),
    host('running', 'running'),
    host('degraded', 'degraded'),
    host('crashed', 'crashed'),
    host('offline', 'unreachable'),
    host('missing', 'no_dsh'),
    host('waiting', 'unknown'),
    host('legacy-disabled', 'running', { enabled: false, config: { enabled: true } }),
    disabled,
  ];
  const grouped = hubHosts(hosts);
  const tabs = visibleTabs(hosts);
  assert.deepEqual(grouped.primary, tabs, 'Hub primary 与 Tab visible 必须是同一批主机且顺序一致');
  assert.deepEqual(
    grouped.primary.map((item) => item.name),
    ['crashed', 'degraded', 'legacy-disabled', 'ready', 'running', 'starting'],
    '主入口统一按主机名排序，config.enabled 优先于旧 enabled',
  );
  assert.deepEqual(grouped.unavailable.map((item) => item.name), ['disabled', 'missing', 'offline', 'waiting']);
});

test('主卡片呈现状态/主机/本机徽标/映射摘要，并统一调用 openHost', (t) => {
  const phases = ['ready', 'starting', 'running', 'degraded', 'crashed'];
  const hosts = phases.map((phase, index) => host(`gpu-${phase}`, phase, index < 2 ? {} : {
    mappedUrl: `http://127.0.0.1:${18_000 + index}/`,
    tunnel: { localPort: 18_000 + index },
  }));
  hosts[0] = host('workstation', 'ready', { local: true, config: { enabled: true, local: true, localPort: null } });
  const { dom, opened } = mountHub(t, hosts);

  const cards = dom.app.querySelectorAll('.hub-host-card');
  assert.equal(cards.length, 5);
  assert.equal(dom.app.querySelector('[data-host="workstation"] .tag-lock').textContent, '本机');
  assert.match(dom.app.querySelector('[data-host="gpu-running"]').textContent, /运行中/);
  assert.match(dom.app.querySelector('[data-host="gpu-running"]').textContent, /18002/);
  assert.match(dom.app.querySelector('[data-host="workstation"]').textContent, /点击拉起并进入/);

  for (const card of cards) card.click();
  assert.deepEqual(opened.sort(), phases.slice(1).map((phase) => `gpu-${phase}`).concat('workstation').sort());
});

test('不可用主机只占一行摘要并提供管理出口', (t) => {
  const disabled = host('disabled', 'running', { config: { enabled: false } });
  const { dom } = mountHub(t, [
    host('good', 'ready'),
    host('offline', 'unreachable'),
    host('missing', 'no_dsh'),
    disabled,
  ]);

  assert.equal(dom.app.querySelectorAll('.hub-host-card').length, 1);
  const folded = dom.app.querySelector('.hub-unavailable');
  assert.match(folded.textContent, /3 台主机不可用或已禁用/);
  assert.equal(folded.querySelectorAll('[data-host]').length, 0, '失败机器不能逐张铺满首屏');
  const manage = folded.querySelector('a');
  assert.equal(manage.textContent, '去管理');
  assert.equal(manage.getAttribute('href'), '#/manage');
});

test('hosts/pending/connection/route 实时重绘，destroy 后不再响应', (t) => {
  const { dom, store, hub } = mountHub(t, [host('gpu-1')]);
  const card = () => dom.app.querySelector('.hub-host-card');

  store.beginPending({ action: 'start', host: 'gpu-1' });
  assert.match(card().textContent, /操作处理中/);
  store.settlePending('host:gpu-1:start');

  store.setConnection({ sse: 'offline' });
  assert.match(card().textContent, /manager 已失联/);

  store.setRoute({ kind: 'host', host: 'gpu-1', raw: '#/host/gpu-1' });
  assert.equal(card().getAttribute('aria-current'), 'page');

  store.upsertHost(host('gpu-1', 'running', {
    mappedUrl: 'http://127.0.0.1:18888/',
    tunnel: { localPort: 18_888 },
  }));
  assert.match(card().textContent, /运行中/);
  const before = hub.root.textContent;
  hub.destroy();
  store.upsertHost(host('gpu-1', 'crashed'));
  assert.equal(hub.root.textContent, before, 'destroy 后监听必须全部解除');
});

test('空态提供添加本机与去管理两个可访问出口', (t) => {
  const { dom, localAdds } = mountHub(t, []);
  const empty = dom.app.querySelector('.hub-empty');
  assert.match(empty.textContent, /还没有主机/);

  const add = empty.querySelector('button');
  assert.equal(add.textContent, '添加本机');
  add.click();
  assert.equal(localAdds(), 1);

  const manage = empty.querySelector('a');
  assert.equal(manage.getAttribute('href'), '#/manage');
  assert.equal(manage.textContent, '去管理');
});

test('应用内 ready 卡片复用 openHost：立即进标签并提交 start', async (t) => {
  const ready = hostView('gpu-ready');
  const { app, dom, calls } = await mount(t, { hosts: [ready] });
  dom.app.querySelector('.hub-host-card[data-host="gpu-ready"]').click();
  await flush();

  assert.equal(dom.window.location.hash, '#/host/gpu-ready');
  assert.equal(calls.some((call) => call.path === '/api/hosts/gpu-ready/start' && call.method === 'POST'), true);
  assert.equal(app.store.getHost('gpu-ready').phase, 'ready', 'Hub 不得复制动作层、乐观改写 phase');
});

test('应用内空态的添加本机出口复用既有 API', async (t) => {
  const { dom, calls } = await mount(t, { hosts: [] });
  dom.app.querySelector('.hub-empty button').click();
  await flush();

  assert.equal(calls.some((call) => call.path === '/api/hosts/local' && call.method === 'POST'), true);
});

test('Hub 主卡片与顶部标签共享同一份 hostOrder 顺序', () => {
  const hosts = [
    host('gpu-c', 'running'),
    host('gpu-a', 'running'),
    host('gpu-b', 'running'),
  ];
  const grouped = hubHosts(hosts, ['gpu-b', 'gpu-c']);
  assert.deepEqual(
    grouped.primary.map((item) => item.name),
    ['gpu-b', 'gpu-c', 'gpu-a'],
  );
  // hub 与 Tab 必须投影同一顺序（单一规则源）
  assert.deepEqual(grouped.primary.map((item) => item.name), visibleTabs(hosts, ['gpu-b', 'gpu-c']).map((item) => item.name));
});
