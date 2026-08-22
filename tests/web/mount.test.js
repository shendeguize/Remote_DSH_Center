/**
 * 整机挂载冒烟（TST-06）：用 DOM 垫片把 app.js 真的跑一遍。
 *
 * 这层专抓单测抓不到的东西——组件构造/渲染路径抛异常、事件没接上、
 * 状态变化后 DOM 没跟着走。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULTS, MANAGER_INFO, flush, hostView, mount, running,
} from './app-harness.js';
import { LAST_HOST_KEY } from '../../src/web/router.js';

function localHostView(name, patch = {}) {
  const base = hostView(name);
  return {
    ...base,
    local: true,
    sshInfo: null,
    config: { ...base.config, local: true, localPort: null },
    ...patch,
  };
}

function installStorage(t, storage) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else delete globalThis.localStorage;
  });
}

const waitForLongPress = () => new Promise((resolve) => { setTimeout(resolve, 600); });

test('首屏：拉 info/hosts/config，根路由落 hub 而不是管理台', async (t) => {
  const { app, dom, calls } = await mount(t);

  assert.deepEqual(
    calls.filter((c) => c.method === 'GET').map((c) => c.path).sort(),
    ['/api/config', '/api/hosts', '/api/manager/info'],
  );

  const rows = dom.app.querySelectorAll('.host-table tbody tr');
  assert.equal(rows.length, 2);
  assert.match(rows[0].textContent, /gpu-1/);
  assert.match(rows[0].textContent, /可拉起/, '状态徽章要有中文文案');

  const managerCard = dom.app.querySelector('.manager-card');
  assert.match(managerCard.textContent, /4242/);
  assert.match(managerCard.textContent, /1分 5秒/);

  const defaults = dom.app.querySelector('.defaults-card');
  assert.equal(defaults.querySelectorAll('input')[0].value, '8899');

  assert.equal(app.store.listHosts().length, 2);
  assert.equal(dom.window.location.hash, '#/hub');
  assert.equal(dom.app.querySelector('.view-hub').hidden, false);
  assert.match(dom.app.querySelector('.view-hub').textContent, /选择一台主机开始工作/);
  assert.equal(dom.app.querySelector('.view-dashboard').hidden, true, '原管理台不能再占默认首屏');
});

test('添加本机：名称输入可留空，默认名冲突后可填自定义名重试', async (t) => {
  const created = localHostView('workstation-local');
  const reply = (status, body) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });
  const { dom, calls } = await mount(t, {
    hosts: [],
    responder: ({ path, method, body }) => {
      if (path === '/api/hosts/local' && method === 'POST') {
        return body.name
          ? reply(201, { host: created })
          : reply(409, { error: '默认名称与现有 SSH 主机冲突', code: 'CONFLICT' });
      }
      return null;
    },
  });

  const card = dom.app.querySelector('.host-table-card');
  const nameInput = card.querySelector('input[type="text"]');
  const addButton = card.querySelector('[data-act="add-local"]');
  const nameLabel = card.querySelector('.field label');
  assert.ok(nameInput && addButton && nameLabel, '无本机时应同时显示名称输入与添加按钮');
  assert.equal(nameLabel.getAttribute('for'), nameInput.id, '名称输入必须有显式 label');
  assert.equal(addButton.getAttribute('aria-label'), '添加本机');

  addButton.click();
  await flush();
  assert.deepEqual(calls.find((c) => c.path === '/api/hosts/local').body, {}, '留空应让后端使用默认主机名');
  assert.equal(nameInput.closest('.field').hidden, false, '冲突后输入入口不能消失');
  assert.match(dom.app.querySelector('.toast-error').textContent, /冲突/);

  nameInput.value = 'workstation-local';
  addButton.click();
  await flush();
  await flush();

  const creates = calls.filter((c) => c.path === '/api/hosts/local');
  assert.deepEqual(creates[1].body, { name: 'workstation-local' });
  assert.equal(dom.app.querySelector('.host-table tbody tr').dataset.host, 'workstation-local');
});

test('本机行使用直连与本机探测文案，不提 SSH 或远端', async (t) => {
  const missing = localHostView('workstation', {
    phase: 'no_dsh',
    probe: {
      ...hostView('workstation').probe,
      dshPath: null,
      version: null,
      profileWeb: false,
      noDshReason: 'missing-bin',
    },
  });
  const { dom, es } = await mount(t, { hosts: [missing] });
  const row = () => dom.app.querySelector('.host-table tbody tr');

  assert.match(row().textContent, /本机未安装 dsh/);
  assert.doesNotMatch(row().textContent, /SSH|远端/);

  es().send('host-changed', {
    revision: 2,
    host: localHostView('workstation', {
      phase: 'running',
      mappedUrl: 'http://127.0.0.1:19001/',
      web: { pid: 999, port: 19001, startedByUs: true, startedAt: new Date().toISOString(), workdir: null },
      tunnel: { localPort: 19001, connected: true, reconnectAttempt: 0, suspendedReason: null },
    }),
  });
  await flush();
  assert.match(row().querySelector('.mapping-cell').textContent, /本机 19001/);
  assert.doesNotMatch(row().querySelector('.mapping-cell').textContent, /远端/);

  es().send('host-changed', {
    revision: 3,
    host: localHostView('workstation', {
      phase: 'unreachable',
      probe: { ...hostView('workstation').probe, errorSummary: null },
    }),
  });
  await flush();
  assert.match(row().textContent, /本机探测失败/);
  assert.doesNotMatch(row().textContent, /SSH|远端/);
});

test('远端行保留 SSH、远端缺失原因与端口映射文案', async (t) => {
  const missing = hostView('gpu-missing', {
    phase: 'no_dsh',
    probe: {
      ...hostView('gpu-missing').probe,
      dshPath: null,
      version: null,
      profileWeb: false,
      noDshReason: 'missing-bin',
    },
  });
  const unreachable = hostView('gpu-offline', {
    phase: 'unreachable',
    probe: { ...hostView('gpu-offline').probe, errorSummary: null },
  });
  const { dom } = await mount(t, { hosts: [running('gpu-running'), missing, unreachable] });
  const row = (name) => dom.app.querySelector(`.host-table tbody tr[data-host="${name}"]`);

  assert.match(row('gpu-running').querySelector('.mapping-cell').textContent, /→ 远端 8899/);
  assert.match(row('gpu-missing').textContent, /远端未安装 dsh/);
  assert.match(row('gpu-offline').textContent, /SSH 不可达/);
});

test('SSE snapshot 到达后表格与标签栏同步', async (t) => {
  const { dom, es } = await mount(t);
  es().open();
  es().send('snapshot', {
    revision: 9,
    manager: MANAGER_INFO,
    defaults: DEFAULTS,
    hosts: [running('gpu-1'), hostView('gpu-2')],
    logs: [{ ts: new Date().toISOString(), level: 'info', host: 'gpu-1', msg: '隧道已建立' }],
  });

  const tabs = dom.app.querySelectorAll('.host-tabs .tab');
  assert.deepEqual(tabs.map((tb) => tb.textContent.trim()), ['gpu-1', 'gpu-2'], 'ready 与 running 都应常驻标签栏');

  const rows = dom.app.querySelectorAll('.host-table tbody tr');
  assert.match(rows[0].textContent, /运行中/);
  assert.match(rows[0].textContent, /17701/);

  const events = dom.app.querySelectorAll('.event-list .event-item');
  assert.equal(events.length, 1);
  assert.match(events[0].textContent, /隧道已建立/);
});

test('点行内「拉起」发请求并锁住按钮', async (t) => {
  const { dom, calls, app } = await mount(t);
  const row = dom.app.querySelector('.host-table tbody tr');
  const startBtn = row.querySelectorAll('.row-actions .btn').find((b) => b.textContent === '拉起');
  assert.ok(startBtn, '可拉起状态应有「拉起」按钮');

  startBtn.click();
  await flush();

  assert.equal(calls.some((c) => c.path === '/api/hosts/gpu-1/start' && c.method === 'POST'), true);
  assert.equal(app.store.isPending('start', 'gpu-1'), true);

  const after = dom.app.querySelector('.host-table tbody tr');
  const busyBtn = after.querySelectorAll('.row-actions .btn').find((b) => b.textContent === '拉起');
  assert.equal(busyBtn.disabled, true, 'pending 期间冲突动作要禁用');
});

test('点 ready 标签一步拉起：慢 SSE 首帧显示可访问占位，phase 不乐观改写', async (t) => {
  const ready = hostView('gpu-ready');
  const { app, dom, calls, es } = await mount(t, { hosts: [ready] });
  const tab = dom.app.querySelector('.host-tabs .tab');

  tab.dispatchEvent({ type: 'click', detail: 0 });
  assert.equal(dom.window.location.hash, '#/host/gpu-ready', '启动请求未结算也应立即切到目标主机');
  assert.equal(calls.some((c) => c.path === '/api/hosts/gpu-ready/start' && c.method === 'POST'), true);
  assert.equal(app.store.getHost('gpu-ready').phase, 'ready', '不得乐观伪装成 running');
  assert.equal(dom.app.querySelector('.view-fallback').hidden, true, 'pending 首帧不能闪回不可打开提示');
  const pendingPlaceholder = dom.app.querySelector('.iframe-pane.is-placeholder');
  assert.equal(pendingPlaceholder.hidden, false, 'SSE 仍为 ready 时应由 start pending 提供占位视图');
  assert.match(pendingPlaceholder.textContent, /正在启动/);
  assert.equal(dom.app.querySelector('.iframe-pane iframe'), null, '没有 mappedUrl 时不得提前创建 iframe');
  const activeTab = dom.app.querySelector('.host-tabs .tab[data-host="gpu-ready"]');
  assert.equal(activeTab.getAttribute('aria-controls'), pendingPlaceholder.id, '标签控制的 panel 必须在首帧真实存在');

  await flush();
  assert.equal(app.store.getHost('gpu-ready').phase, 'ready', 'HTTP 已受理也不能替 SSE 改 phase');
  assert.equal(pendingPlaceholder.hidden, false, 'SSE 慢于 HTTP 响应时占位不能提前消失');

  es().send('host-changed', { revision: 2, host: { ...ready, phase: 'starting' } });
  await flush();
  const placeholder = dom.app.querySelector('.iframe-pane.is-placeholder');
  assert.equal(placeholder.hidden, false, 'starting 路由应显示 iframe 占位区');
  assert.match(placeholder.textContent, /正在启动/);
  assert.match(placeholder.textContent, /拉起远端 dsh web 并建立隧道/);
  assert.equal(dom.document.activeElement, placeholder.querySelector('.iframe-overlay'),
    '键盘激活 ready 标签后应在 SSE starting 到达时把焦点交给状态区');
});

test('触屏长按标签：菜单后的同周期 click 被吞掉，菜单动作仍可用', async (t) => {
  const ready = hostView('gpu-ready');
  const { dom, calls } = await mount(t, { hosts: [ready] });
  const tab = dom.app.querySelector('.host-tabs .tab');

  tab.dispatchEvent({
    type: 'pointerdown', pointerType: 'touch', pointerId: 7, clientX: 24, clientY: 16,
  });
  await waitForLongPress();

  const menu = dom.app.querySelector('.context-menu');
  assert.equal(menu.hidden, false, '长按应打开标签菜单');

  tab.dispatchEvent({ type: 'pointerup', pointerType: 'touch', pointerId: 7 });
  tab.dispatchEvent({
    type: 'click', pointerType: 'touch', pointerId: 7, detail: 1,
  });
  await flush();

  assert.equal(dom.window.location.hash, '#/hub', '长按生成的 click 不得顺手跳进主机');
  assert.equal(calls.some((c) => c.path === '/api/hosts/gpu-ready/start'), false, 'ready 长按不得误发 start');
  assert.equal(menu.hidden, false, '吞 click 不能连菜单一起关掉');

  const view = menu.querySelectorAll('button').find((button) => button.textContent === '在管理台查看');
  view.click();
  await flush();
  assert.equal(dom.window.location.hash, '#/manage', '长按打开的菜单仍应能执行动作');
  assert.equal(dom.app.querySelector('.host-drawer').hidden, false);
});

test('触屏标签：pointercancel/leave 清掉长按周期，后续普通 tap 照常打开', async (t) => {
  const ready = hostView('gpu-ready');
  const { dom, calls } = await mount(t, { hosts: [ready] });
  const tab = dom.app.querySelector('.host-tabs .tab');

  tab.dispatchEvent({
    type: 'pointerdown', pointerType: 'touch', pointerId: 8, clientX: 24, clientY: 16,
  });
  tab.dispatchEvent({ type: 'pointercancel', pointerType: 'touch', pointerId: 8 });
  tab.dispatchEvent({
    type: 'pointerdown', pointerType: 'touch', pointerId: 9, clientX: 24, clientY: 16,
  });
  tab.dispatchEvent({ type: 'pointerleave', pointerType: 'touch', pointerId: 9 });
  await waitForLongPress();

  assert.equal(dom.app.querySelector('.context-menu').hidden, true, '取消或离开后不能再迟到地弹菜单');

  tab.dispatchEvent({
    type: 'pointerdown', pointerType: 'touch', pointerId: 10, clientX: 24, clientY: 16,
  });
  tab.dispatchEvent({ type: 'pointerup', pointerType: 'touch', pointerId: 10 });
  tab.dispatchEvent({
    type: 'click', pointerType: 'touch', pointerId: 10, detail: 1,
  });
  await flush();

  assert.equal(dom.window.location.hash, '#/host/gpu-ready', '普通 tap 仍应打开主机');
  assert.equal(calls.some((c) => c.path === '/api/hosts/gpu-ready/start' && c.method === 'POST'), true);
});

test('ready 启动请求失败：pending 占位退回准确 fallback 并 toast', async (t) => {
  const ready = hostView('gpu-fail');
  const { app, dom, es } = await mount(t, {
    hosts: [ready],
    responder: ({ path, method }) => (path === '/api/hosts/gpu-fail/start' && method === 'POST'
      ? { ok: false, status: 500, text: async () => JSON.stringify({ error: '拉起被拒绝', code: 'START_FAILED' }) }
      : null),
  });

  dom.app.querySelector('.host-tabs .tab').click();
  const placeholder = dom.app.querySelector('.iframe-pane.is-placeholder');
  assert.equal(placeholder.hidden, false, '请求结算前仍应显示启动占位');
  assert.match(placeholder.textContent, /正在启动/);

  await flush();
  assert.equal(app.store.getHost('gpu-fail').phase, 'ready', '请求失败不能污染 SSE phase');
  assert.equal(app.store.isPending('start', 'gpu-fail'), false);
  assert.equal(placeholder.hidden, true, 'pending 结束且 phase 仍 ready 时应收起占位');
  const fallback = dom.app.querySelector('.view-fallback');
  assert.equal(fallback.hidden, false);
  assert.match(fallback.textContent, /可拉起/);
  const activeTab = dom.app.querySelector('.host-tabs .tab[data-host="gpu-fail"]');
  assert.equal(activeTab.getAttribute('aria-controls'), fallback.id,
    '失败结算后标签必须改为控制当前 fallback');
  assert.equal(fallback.getAttribute('aria-labelledby'), activeTab.id);
  assert.match(dom.app.querySelector('.toast-error').textContent, /拉起被拒绝/);

  es().send('host-changed', { revision: 2, host: running('gpu-fail') });
  await flush();
  const livePanel = dom.app.querySelector('.iframe-pane[data-host="gpu-fail"]');
  const liveTab = dom.app.querySelector('.host-tabs .tab[data-host="gpu-fail"]');
  assert.equal(livePanel.hidden, false);
  assert.equal(liveTab.getAttribute('aria-controls'), livePanel.id);
  assert.equal(fallback.hidden, true);
  assert.equal(fallback.getAttribute('id'), null, '切回正常 iframe 后 fallback 不得继续占用 panel id');
  assert.equal(fallback.getAttribute('aria-labelledby'), null);
});

test('starting 深链可直接打开占位遮罩并选中对应标签', async (t) => {
  const starting = hostView('gpu-starting', { phase: 'starting' });
  const { dom } = await mount(t, { hash: '#/host/gpu-starting', hosts: [starting] });

  const tab = dom.app.querySelector('.host-tabs .tab');
  assert.equal(tab.getAttribute('aria-selected'), 'true');
  assert.equal(tab.classList.contains('is-active'), true);
  assert.equal(dom.app.querySelector('.view-fallback').hidden, true);
  const placeholder = dom.app.querySelector('.iframe-pane.is-placeholder');
  assert.equal(placeholder.hidden, false);
  assert.match(placeholder.textContent, /正在启动/);
});

test('autoStart 勾选即存，落库结果覆盖本地', async (t) => {
  const updated = running('gpu-1');
  const { dom, calls, app } = await mount(t, {
    responder: ({ path, method }) => (path === '/api/hosts/gpu-1/config' && method === 'PUT'
      ? { ok: true, status: 200, text: async () => JSON.stringify({ host: updated }) }
      : null),
  });

  const toggle = dom.app.querySelector('.autostart-cell input');
  assert.equal(toggle.checked, false);
  toggle.checked = true;
  toggle.dispatchEvent({ type: 'change', target: toggle });
  await flush();

  const put = calls.find((c) => c.method === 'PUT');
  assert.deepEqual(put.body, { autoStart: true });
  assert.equal(app.store.getHost('gpu-1').config.autoStart, true);
  assert.equal(dom.app.querySelector('.autostart-cell input').checked, true);
});

test('断线：出现横幅且写按钮禁用；恢复后横幅消失', async (t) => {
  const { dom, es } = await mount(t);
  es().open();
  es().send('snapshot', { revision: 1, manager: MANAGER_INFO, defaults: DEFAULTS, hosts: [hostView('gpu-1')], logs: [] });

  const banner = dom.app.querySelector('.disconnect-banner');
  assert.equal(banner.hidden, true);

  for (const fn of es().listeners.get('error')) fn({});
  assert.equal(banner.hidden, false);
  assert.match(banner.textContent, /失联/);
  assert.equal(dom.app.querySelector('.probe-all').disabled, true);

  const startBtn = dom.app.querySelector('.host-table tbody tr').querySelectorAll('.btn').find((b) => b.textContent === '拉起');
  assert.equal(startBtn.disabled, true, '断线时写操作必须禁用');

  es().open();
  es().send('snapshot', { revision: 2, manager: MANAGER_INFO, defaults: DEFAULTS, hosts: [hostView('gpu-1')], logs: [] });
  assert.equal(banner.hidden, true);
});

test('路由到 running 主机：创建 iframe，进管理台只改显隐（keep-alive）', async (t) => {
  const { dom, es } = await mount(t);
  es().open();
  es().send('snapshot', { revision: 1, manager: MANAGER_INFO, defaults: DEFAULTS, hosts: [running('gpu-1')], logs: [] });

  dom.window.location.hash = '#/host/gpu-1';
  const frame = dom.app.querySelector('.iframe-pane iframe');
  assert.ok(frame, '应创建 iframe');
  assert.equal(frame.getAttribute('src'), 'http://127.0.0.1:17701/');
  assert.equal(dom.app.querySelector('.view-dashboard').hidden, true);

  dom.window.location.hash = '#/manage';
  const same = dom.app.querySelector('.iframe-pane iframe');
  assert.equal(same, frame, '切到管理台不能销毁 iframe');
  assert.equal(dom.app.querySelector('.iframe-pane[data-host="gpu-1"]').hidden, true);
  assert.equal(dom.app.querySelector('.view-dashboard').hidden, false);
});

test('hub 与 manage 互斥，header/tabbar 在两页与主机页都可见', async (t) => {
  const { dom } = await mount(t, { hosts: [running('gpu-1')] });
  const hub = dom.app.querySelector('.view-hub');
  const manage = dom.app.querySelector('.view-dashboard');
  const header = dom.app.querySelector('.app-header');
  const tabbar = dom.app.querySelector('.tabbar');

  assert.deepEqual([hub.hidden, manage.hidden, header.hidden, tabbar.hidden], [false, true, false, false]);

  dom.window.location.hash = '#/manage';
  assert.deepEqual([hub.hidden, manage.hidden, header.hidden, tabbar.hidden], [true, false, false, false]);

  dom.window.location.hash = '#/host/gpu-1';
  assert.deepEqual([hub.hidden, manage.hidden, header.hidden, tabbar.hidden], [true, true, false, false]);
});

test('管理入口次级化：无固定管理台首标签，激活态与页头全局动作正确', async (t) => {
  const { dom } = await mount(t, { hosts: [hostView('gpu-1')] });
  assert.equal(dom.app.querySelector('.tab-dashboard'), null, '固定「管理台」首标签应移除');
  assert.equal(dom.app.querySelector('.app-header .probe-all'), null, '薄壳 header 不应再放运维动作');
  assert.equal(dom.app.querySelector('.app-header .reload-config'), null);

  const manage = dom.app.querySelector('.tab-manage');
  assert.equal(manage.textContent, '⌂ 管理');
  assert.equal(manage.getAttribute('aria-pressed'), 'false');
  manage.click();

  assert.equal(dom.window.location.hash, '#/manage');
  assert.equal(manage.classList.contains('is-active'), true);
  assert.equal(manage.getAttribute('aria-pressed'), 'true');
  assert.equal(manage.getAttribute('aria-current'), 'page');
  const pageHead = dom.app.querySelector('.view-dashboard .manage-header');
  assert.match(pageHead.textContent, /管理/);
  assert.ok(pageHead.querySelector('.probe-all'));
  assert.ok(pageHead.querySelector('.reload-config'));
});

test('不可用/禁用主机进入 +N 可访问菜单，可探测或转到管理台', async (t) => {
  const disabled = running('disabled');
  disabled.enabled = false;
  disabled.config = { ...disabled.config, enabled: false };
  const hosts = [
    hostView('ready'),
    hostView('missing', { phase: 'no_dsh' }),
    hostView('offline', { phase: 'unreachable' }),
    disabled,
  ];
  const { dom, calls } = await mount(t, { hosts });
  assert.deepEqual(
    dom.app.querySelectorAll('.host-tabs .tab').map((tab) => tab.dataset.host),
    ['ready'],
  );

  const overflow = dom.app.querySelector('.tab-overflow');
  assert.equal(overflow.textContent, '+3 ▾');
  assert.equal(overflow.getAttribute('aria-haspopup'), 'menu');
  overflow.dispatchEvent({ type: 'keydown', key: 'ArrowDown' });

  const menu = dom.app.querySelector('.overflow-menu');
  assert.equal(menu.hidden, false);
  assert.equal(overflow.getAttribute('aria-expanded'), 'true');
  assert.match(menu.textContent, /disabled — 已禁用/);
  assert.match(menu.textContent, /missing — 未安装\/未配置/);
  assert.match(menu.textContent, /offline — SSH 不可达/);

  const probe = menu.querySelectorAll('button').find((button) => button.textContent === '探测 offline');
  probe.click();
  await flush();
  assert.equal(calls.some((c) => c.path === '/api/hosts/offline/probe' && c.method === 'POST'), true);
  assert.equal(menu.hidden, true);
  assert.equal(dom.document.activeElement, overflow, '选完动作后焦点应回到 +N 入口');

  overflow.click();
  const view = menu.querySelectorAll('button').find((button) => button.textContent === '在管理台查看 missing');
  view.click();
  await flush();
  assert.equal(dom.window.location.hash, '#/manage');
  assert.equal(dom.app.querySelector('.host-drawer').hidden, false);
  assert.match(dom.app.querySelector('.host-drawer').textContent, /missing/);
});

test('overflow 打开时实时重建，并在项目迁出后把焦点安全交回', async (t) => {
  const missing = hostView('missing', { phase: 'no_dsh' });
  const offline = hostView('offline', { phase: 'unreachable' });
  const { app, dom, es } = await mount(t, { hosts: [missing, offline] });
  app.store.setConnection({ sse: 'open' });

  const overflow = dom.app.querySelector('.tab-overflow');
  overflow.click();
  const menu = dom.app.querySelector('.overflow-menu');
  const item = (label) => menu.querySelectorAll('button').find((node) => node.textContent === label);
  item('探测 offline').focus();

  app.store.setConnection({ sse: 'offline' });
  assert.equal(menu.hidden, false, '连接态重渲染不能顺手关菜单');
  assert.equal(item('探测 offline').disabled, true, '断线后菜单必须立刻反映禁写状态');
  assert.equal(dom.document.activeElement.textContent, '在管理台查看 offline',
    '当前动作被禁用时应留在同一主机的可用动作上');

  app.store.setConnection({ sse: 'open' });
  const focusedBeforePending = dom.document.activeElement;
  const pending = app.store.beginPending({ action: 'probe', host: 'offline' });
  assert.equal(item('探测 offline').disabled, true, 'pending 重渲染必须立刻锁住对应动作');
  assert.notEqual(dom.document.activeElement, focusedBeforePending, '菜单内容应按最新 store 重建');
  assert.equal(dom.document.activeElement.textContent, '在管理台查看 offline',
    '重建后应按 host/action 恢复焦点');
  app.store.settlePending(pending.key);
  assert.equal(item('探测 offline').disabled, false);

  es().send('snapshot', {
    revision: 2,
    manager: MANAGER_INFO,
    defaults: DEFAULTS,
    hosts: [hostView('missing', { phase: 'no_dsh' }), hostView('offline', { phase: 'no_dsh' })],
    logs: [],
  });
  assert.match(menu.textContent, /offline — 未安装\/未配置/, 'hosts reset 后菜单状态文案必须刷新');
  assert.equal(dom.document.activeElement.textContent, '在管理台查看 offline',
    'reset 重建也应保持同一逻辑菜单项的焦点');

  es().send('host-changed', { revision: 3, host: hostView('offline') });
  await flush();
  assert.doesNotMatch(menu.textContent, /offline/, 'ready 主机应立即从 overflow 菜单消失');
  assert.ok(dom.app.querySelector('.host-tabs .tab[data-host="offline"]'), 'ready 主机应立即进入主标签');
  assert.equal(dom.document.activeElement, overflow, '当前菜单项消失后焦点应回 overflow 入口');

  es().send('host-changed', { revision: 4, host: hostView('missing') });
  await flush();
  assert.equal(menu.hidden, true, '最后一项迁出后菜单应关闭');
  assert.equal(overflow.hidden, true, '没有 overflow 主机时入口应隐藏');
  assert.equal(dom.document.activeElement.getAttribute('role'), 'tab',
    '焦点不能留在已隐藏的 overflow 入口上');
});

test('本机不可用项在 overflow 使用本机文案，远端文案不渗入', async (t) => {
  const localMissing = localHostView('local-missing', {
    phase: 'no_dsh',
    probe: {
      ...hostView('local-missing').probe,
      dshPath: null,
      version: null,
      profileWeb: false,
      noDshReason: 'missing-bin',
    },
  });
  const localUnavailable = localHostView('local-offline', {
    phase: 'unreachable',
    probe: { ...hostView('local-offline').probe, errorSummary: 'SSH connection refused' },
  });
  const { dom } = await mount(t, { hosts: [localMissing, localUnavailable] });

  dom.app.querySelector('.tab-overflow').click();
  const menu = dom.app.querySelector('.overflow-menu');
  assert.match(menu.textContent, /local-missing — 本机未安装或未配置/);
  assert.match(menu.textContent, /local-offline — 本机不可用/);
  assert.doesNotMatch(menu.textContent, /SSH|远端/, '本机项不能借用远端探测文案');
});

test('标签区分本机徽标与远端：本机 title 可读，远端文案不变', async (t) => {
  const local = localHostView('workstation');
  const remote = hostView('gpu-remote');
  const { dom } = await mount(t, { hosts: [local, remote] });
  const byHost = Object.fromEntries(dom.app.querySelectorAll('.host-tabs .tab').map((tab) => [tab.dataset.host, tab]));

  assert.equal(byHost.workstation.querySelector('.tag-lock').textContent, '本机');
  assert.match(byHost.workstation.getAttribute('title'), /本机/);
  assert.equal(byHost['gpu-remote'].querySelector('.tag-lock'), null);
  assert.equal(byHost['gpu-remote'].textContent, 'gpu-remote');
  assert.doesNotMatch(byHost['gpu-remote'].getAttribute('title'), /本机/);
});

test('品牌链接固定回 hub，不经过会恢复 lastHost 的根路由', async (t) => {
  installStorage(t, { getItem: () => 'gpu-1', setItem: () => {} });
  const { dom } = await mount(t, { hosts: [running('gpu-1')] });
  assert.equal(dom.window.location.hash, '#/host/gpu-1', '前提：根路由会恢复 lastHost');

  const brand = dom.app.querySelector('.brand-link');
  assert.equal(brand.getAttribute('href'), '#/hub');
  dom.window.location.hash = brand.getAttribute('href');
  assert.equal(dom.window.location.hash, '#/hub');
  assert.equal(dom.app.querySelector('.view-hub').hidden, false);
});

test('根路由恢复可开的 lastHost', async (t) => {
  installStorage(t, { getItem: () => 'gpu-1', setItem: () => {} });
  const hit = await mount(t, { hosts: [running('gpu-1')] });
  assert.equal(hit.dom.window.location.hash, '#/host/gpu-1');
  assert.ok(hit.dom.app.querySelector('.iframe-pane iframe'), '恢复 lastHost 后应直接打开 iframe');
});

test('根路由等主机清单就绪后才决定落点', async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const reply = (body) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
  const { dom } = await mount(t, {
    hash: '#/',
    responder: ({ path }) => (path === '/api/hosts'
      ? gate.then(() => reply({ revision: 1, hosts: [running('gpu-1')] }))
      : null),
  });

  assert.equal(dom.window.location.hash, '#/', '主机清单没到前不能提前猜根路由落点');
  assert.equal(dom.app.querySelector('.view-skeleton').hidden, false);

  release();
  await flush();
  await flush();
  assert.equal(dom.window.location.hash, '#/hub');
});

test('根路由的 lastHost 失效时落 hub', async (t) => {
  installStorage(t, { getItem: () => 'gone', setItem: () => {} });
  const { dom } = await mount(t, { hosts: [running('gpu-1')] });
  assert.equal(dom.window.location.hash, '#/hub');
});

test('根路由的 lastHost 已禁用时落 hub', async (t) => {
  installStorage(t, { getItem: () => 'gpu-1', setItem: () => {} });
  const disabled = running('gpu-1');
  disabled.enabled = false;
  disabled.config = { ...disabled.config, enabled: false };
  const { dom } = await mount(t, { hosts: [disabled] });
  assert.equal(dom.window.location.hash, '#/hub');
  assert.equal(dom.app.querySelector('.view-hub').hidden, false);
});

test('localStorage 读异常时根路由静默落 hub', async (t) => {
  installStorage(t, {
    getItem() { throw new Error('storage disabled'); },
    setItem() { throw new Error('storage disabled'); },
  });
  const { dom } = await mount(t, { hosts: [running('gpu-1')] });
  assert.equal(dom.window.location.hash, '#/hub');
});

test('localStorage 写异常不影响 host 深链', async (t) => {
  installStorage(t, {
    getItem: () => null,
    setItem() { throw new Error('quota denied'); },
  });
  const { dom } = await mount(t, { hash: '#/host/gpu-1', hosts: [running('gpu-1')] });
  assert.equal(dom.window.location.hash, '#/host/gpu-1');
  assert.ok(dom.app.querySelector('.iframe-pane iframe'));
});

test('成功进入可开 host 路由会记住 lastHost', async (t) => {
  const writes = [];
  installStorage(t, {
    getItem: () => null,
    setItem: (key, value) => writes.push([key, value]),
  });
  const { dom } = await mount(t, { hash: '#/host/gpu-1', hosts: [running('gpu-1')] });
  assert.equal(dom.window.location.hash, '#/host/gpu-1');
  assert.deepEqual(writes.at(-1), [LAST_HOST_KEY, 'gpu-1']);
});

test('非法路由规范化到 hub', async (t) => {
  const { dom } = await mount(t, { hash: '#/not-a-route' });
  assert.equal(dom.window.location.hash, '#/hub');
  assert.equal(dom.app.querySelector('.view-hub').hidden, false);
});

/**
 * 回归（真机 v0.2.0-rc.3 暴露，issue #15）：首屏就带 host 路由时——书签、刷新、
 * `dshc open <host>` 都走这条——主机数据还没到，tabbar 把「尚未同步」当成
 * 「标签已消失」，直接把地址改回根路由，于是深链永远落不到目标主机。
 *
 * 关键在于让 `/api/hosts` **迟到**：既有用例的 fetch 是立即 resolve 的，
 * 首屏那一瞬间 store 已经有主机，缺口正好被跳过。
 */
test('深链首屏：主机数据迟到也不许把地址改回管理台', async (t) => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const reply = (body) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });

  const { dom } = await mount(t, {
    hash: '#/host/gpu-1',
    hosts: [running('gpu-1')],
    responder: ({ path }) => (path === '/api/hosts'
      ? gate.then(() => reply({ revision: 1, hosts: [running('gpu-1')] }))
      : null),
  });

  await flush();
  assert.equal(dom.window.location.hash, '#/host/gpu-1', '主机还没同步就被踢回根路由');

  release();
  await flush();
  await flush();
  assert.equal(dom.window.location.hash, '#/host/gpu-1');
  const frame = dom.app.querySelector('.iframe-pane iframe');
  assert.ok(frame, '数据到齐后该把 iframe 建出来');
  assert.equal(frame.getAttribute('src'), 'http://127.0.0.1:17701/');
});

/**
 * 回归（issue #25）：主机多、名字长时标签栏内容宽过可视区（真机实测 8 台
 * 2058px vs 1024px）。容器能横向滚，但从不自己跟到当前位置，切到靠后那台之后
 * 激活标签停在可视区外——看起来像一个都没选中。
 *
 * 垫片没有布局，判据只能是「有没有对着正确的元素滚」；滚了多少像素由 ui-smoke S11 盯。
 */
test('切换主机时把激活标签滚进可视区，且只在切换时滚', async (t) => {
  const { dom, es } = await mount(t, { hosts: [running('gpu-1'), running('gpu-2')] });
  es().open();
  es().send('snapshot', {
    revision: 1, manager: MANAGER_INFO, defaults: DEFAULTS, hosts: [running('gpu-1'), running('gpu-2')], logs: [],
  });
  await flush();

  dom.document.scrollCalls.length = 0;
  dom.window.location.hash = '#/host/gpu-2';
  await flush();

  const scrolled = dom.document.scrollCalls.at(-1);
  assert.ok(scrolled, '切到 gpu-2 却没滚标签栏');
  assert.equal(scrolled.node.dataset.host, 'gpu-2', '滚的应该是激活的那个标签');
  assert.ok(scrolled.node.classList.contains('is-active'));
  assert.equal(scrolled.opts.inline, 'nearest', '要最小滚动，别把标签甩到正中');

  // 同一路由下再重渲染不许再滚：否则用户自己拖标签栏会被一直拽回去
  const before = dom.document.scrollCalls.length;
  es().send('host-changed', { revision: 2, host: running('gpu-1') });
  await flush();
  assert.equal(dom.document.scrollCalls.length, before, '激活项没变却又滚了一次');
});

test('主机真的从状态里消失（不是尚未同步）→ 回 hub', async (t) => {
  const { dom, es } = await mount(t, { hosts: [running('gpu-1')] });
  es().open();
  es().send('snapshot', {
    revision: 1, manager: MANAGER_INFO, defaults: DEFAULTS, hosts: [running('gpu-1')], logs: [],
  });

  dom.window.location.hash = '#/host/gpu-1';
  assert.ok(dom.app.querySelector('.iframe-pane iframe'), '先确认开着');

  // 配置里被摘掉的主机：snapshot 整体替换后它不再存在
  es().send('snapshot', {
    revision: 2, manager: MANAGER_INFO, defaults: DEFAULTS, hosts: [], logs: [],
  });
  await flush();
  assert.equal(dom.window.location.hash, '#/hub', '标签真消失了才该回起始页');
});

test('ready 深链 fallback：不造 iframe，并与选中标签形成完整 tabpanel 关系', async (t) => {
  const { dom } = await mount(t, { hash: '#/host/gpu-1', hosts: [hostView('gpu-1')] });
  assert.equal(dom.app.querySelector('.iframe-pane iframe'), null);
  const fallback = dom.app.querySelector('.view-fallback');
  const activeTab = dom.app.querySelector('.host-tabs .tab[data-host="gpu-1"]');
  assert.equal(fallback.hidden, false);
  assert.equal(fallback.getAttribute('role'), 'tabpanel');
  assert.equal(fallback.getAttribute('aria-hidden'), 'false');
  assert.equal(activeTab.getAttribute('aria-controls'), fallback.id,
    '选中标签必须控制当前真实可见的 fallback panel');
  assert.equal(fallback.getAttribute('aria-labelledby'), activeTab.id);
  assert.match(fallback.textContent, /可拉起/);
  const back = fallback.querySelector('a.link');
  assert.equal(back.getAttribute('href'), '#/hub');
  assert.equal(back.textContent, '回到起始页');
});

test('iframe 断联遮罩的返回锚点指向 hub', async (t) => {
  const { dom, es } = await mount(t, { hash: '#/host/gpu-1', hosts: [running('gpu-1')] });
  es().send('host-changed', { revision: 2, host: { ...running('gpu-1'), phase: 'degraded' } });
  await flush();

  const overlay = dom.app.querySelector('.iframe-pane[data-host="gpu-1"] .iframe-overlay');
  assert.equal(overlay.hidden, false);
  const back = overlay.querySelector('a.link');
  assert.equal(back.getAttribute('href'), '#/hub');
  assert.equal(back.textContent, '回到起始页');
});

test('标签菜单「在管理台查看」会切 manage 并展开对应抽屉', async (t) => {
  const { dom } = await mount(t, { hosts: [running('gpu-1')] });
  const tab = dom.app.querySelector('.host-tabs .tab');
  tab.dispatchEvent({
    type: 'contextmenu', clientX: 20, clientY: 30, preventDefault() {},
  });
  const menu = dom.app.querySelector('.context-menu');
  const view = menu.querySelectorAll('button').find((button) => button.textContent === '在管理台查看');
  assert.ok(view);

  view.click();
  await flush();
  assert.equal(dom.window.location.hash, '#/manage');
  const drawer = dom.app.querySelector('.host-drawer');
  assert.equal(drawer.hidden, false);
  assert.match(drawer.textContent, /gpu-1/);
});

test('标签菜单「在新窗口打开」只在有 mappedUrl 时启用并切断 opener', async (t) => {
  const ready = hostView('gpu-ready');
  const live = running('gpu-live');
  const { dom } = await mount(t, { hosts: [ready, live] });
  const opened = [];
  dom.window.open = (url, target) => {
    const popup = { opener: 'parent' };
    opened.push({ url, target, popup });
    return popup;
  };

  const readyTab = dom.app.querySelector('.host-tabs .tab[data-host="gpu-ready"]');
  readyTab.dispatchEvent({
    type: 'contextmenu', clientX: 20, clientY: 30, preventDefault() {},
  });
  let item = dom.app.querySelector('.context-menu').querySelectorAll('button')
    .find((button) => button.textContent === '在新窗口打开');
  assert.equal(item.disabled, true, '无 mappedUrl 时必须禁用');

  const liveTab = dom.app.querySelector('.host-tabs .tab[data-host="gpu-live"]');
  liveTab.dispatchEvent({
    type: 'contextmenu', clientX: 20, clientY: 30, preventDefault() {},
  });
  item = dom.app.querySelector('.context-menu').querySelectorAll('button')
    .find((button) => button.textContent === '在新窗口打开');
  assert.equal(item.disabled, false);
  item.click();

  assert.equal(opened.length, 1);
  assert.deepEqual(
    { url: opened[0].url, target: opened[0].target },
    { url: live.mappedUrl, target: '_blank' },
  );
  assert.equal(opened[0].popup.opener, null, '新窗口不得保留反向控制父页的 opener');
});

test('行点击打开抽屉；有脏草稿时关闭要确认', async (t) => {
  const { dom, calls } = await mount(t);
  dom.app.querySelector('.host-table tbody tr').click();
  await flush();

  const drawer = dom.app.querySelector('.host-drawer');
  assert.equal(drawer.hidden, false);
  assert.match(drawer.textContent, /gpu-1/);
  assert.equal(calls.some((c) => c.path.startsWith('/api/hosts/gpu-1/log')), true, '打开即拉一次日志');

  const envBox = drawer.querySelectorAll('textarea')[0];
  envBox.value = 'A=1';
  drawer.querySelector('.drawer-form').dispatchEvent({ type: 'input' });

  const saveBtn = drawer.querySelectorAll('.btn').find((b) => b.textContent === '保存');
  assert.equal(saveBtn.disabled, false, '有改动才允许保存');

  drawer.querySelector('.drawer-close').click();
  await flush();
  assert.equal(dom.app.querySelector('.confirm-dialog').open, true, '脏草稿关闭需确认');
});

test('日志里的 HTML 原样当文本显示（远端 stderr 是攻击者能左右的）', async (t) => {
  const { dom, es } = await mount(t);
  const panel = dom.app.querySelector('.event-panel');

  es().open();
  es().send('snapshot', {
    revision: 1,
    manager: MANAGER_INFO,
    defaults: DEFAULTS,
    hosts: [hostView('gpu-1')],
    logs: [{
      ts: new Date().toISOString(),
      level: 'error',
      host: 'gpu-1',
      msg: '远端说：<img src=x onerror="pwned()">',
    }],
  });

  const item = panel.querySelector('.event-list .event-item');
  assert.match(item.textContent, /<img src=x onerror="pwned\(\)">/, '该原样显示');
  assert.equal(item.querySelectorAll('img').length, 0, '不许解析成节点');
});

test('事件面板：按主机筛选、折叠、清空，以及新出现的主机要进下拉', async (t) => {
  const { dom, es } = await mount(t);
  const panel = dom.app.querySelector('.event-panel');
  const filter = panel.querySelector('.event-filter');
  const lines = () => panel.querySelectorAll('.event-list .event-item').map((li) => li.textContent);

  es().open();
  const ts = new Date().toISOString();
  es().send('snapshot', {
    revision: 3,
    manager: MANAGER_INFO,
    defaults: DEFAULTS,
    hosts: [hostView('gpu-1'), hostView('gpu-2')],
    logs: [
      { ts, level: 'info', host: 'gpu-1', msg: '一号说话' },
      { ts, level: 'warn', host: 'gpu-2', msg: '二号抱怨' },
      { ts, level: 'info', host: null, msg: 'manager 自己' },
    ],
  });
  assert.equal(lines().length, 3);

  filter.value = 'gpu-2';
  filter.dispatchEvent({ type: 'change' });
  assert.deepEqual(lines().map((s) => /二号抱怨/.test(s)), [true], '筛选后只剩这台的');

  filter.value = '';
  filter.dispatchEvent({ type: 'change' });
  assert.equal(lines().length, 3, '选回「全部主机」要全回来');

  const toggle = panel.querySelector('.collapse-toggle');
  const body = panel.querySelector('.event-body');
  toggle.click();
  assert.equal(body.hidden, true, '折叠要真藏起来（hidden 才会一并从无障碍树里消失）');
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(toggle.textContent, '展开');
  toggle.click();
  assert.equal(body.hidden, false);
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');

  // 新主机是靠 host-changed 单条到达的（ssh config 里多出一台、向导收尾解门禁都走这条），
  // 只认整份快照的话，下拉里就永远缺这台，没法单独看它的事件。
  es().send('host-changed', { revision: 4, host: hostView('gpu-9') });
  await flush();
  assert.equal(filter.options.some((o) => o.value === 'gpu-9'), true, '新主机没进筛选下拉');
  assert.equal(filter.value, '', '重建下拉不该悄悄换掉当前选择');

  panel.querySelectorAll('.btn').find((b) => b.textContent === '清空').click();
  assert.equal(lines().length, 0);
  assert.match(panel.querySelector('.event-list').textContent, /暂无事件/);
});

test('行内控件上的 Enter/Space 归控件自己，不去开抽屉', async (t) => {
  const { dom } = await mount(t);
  const row = dom.app.querySelector('.host-table tbody tr');
  const probe = row.querySelector('[data-act="probe"]');
  const toggle = row.querySelector('input[type="checkbox"]');

  for (const [node, what] of [[probe, '探测键'], [toggle, '自启开关']]) {
    for (const key of ['Enter', ' ']) {
      node.dispatchEvent({ type: 'keydown', key });
      // eslint-disable-next-line no-await-in-loop -- 逐个按键看反应
      await flush();
      assert.equal(dom.app.querySelector('.host-drawer').hidden, true,
        `${what}上按 ${key === ' ' ? 'Space' : key} 不该开抽屉——行的 preventDefault 会连带废掉控件的原生激活`);
    }
  }

  row.dispatchEvent({ type: 'keydown', key: 'Enter' });
  await flush();
  assert.equal(dom.app.querySelector('.host-drawer').hidden, false, '落在行本身的 Enter 照旧开抽屉');
});

test('按住的那一下不许被重建吞掉：更新攒到松手后再刷', async (t) => {
  const { dom, es } = await mount(t);
  const table = dom.app.querySelector('.host-table-card');
  const probe = () => dom.app.querySelector('.host-table tbody tr [data-act="probe"]');
  const held = probe();

  // 鼠标与 Space 的原生激活都在「抬起」那一刻，要求按下抬起是同一个节点。
  // 表格若在这中间整行重建，这一次操作就悄无声息地没了（issue #61）。
  held.dispatchEvent({ type: 'pointerdown', bubbles: true });
  es().open();
  es().send('host-changed', { revision: 9, host: hostView('gpu-1', { phase: 'ready' }) });
  await flush();

  assert.equal(probe(), held, '手指还按着，节点就不该被换掉');

  held.dispatchEvent({ type: 'pointerup', bubbles: true });
  await flush();
  assert.notEqual(probe(), held, '松手之后要把攒下的更新刷上去');

  // 按键那条路同理：Space 也是抬起才激活
  const keyHeld = probe();
  keyHeld.dispatchEvent({ type: 'keydown', key: ' ', bubbles: true });
  es().send('host-changed', { revision: 10, host: hostView('gpu-1', { phase: 'running' }) });
  await flush();
  assert.equal(probe(), keyHeld, '按键按住期间同样不许换节点');

  keyHeld.dispatchEvent({ type: 'keyup', key: ' ', bubbles: true });
  await flush();
  assert.equal(
    dom.app.querySelector('.host-table tbody tr').textContent.includes('运行中'),
    true,
    '松手后表格必须追上最新数据，不能停在按住那一刻',
  );
  assert.ok(table, '表格还在');
});

test('抽屉里的启动目录：改值只提交 workdir，非法值就地报错不发请求', async (t) => {
  const saved = hostView('gpu-1', { config: { ...hostView('gpu-1').config, workdir: '~/proj' } });
  const { dom, calls } = await mount(t, {
    responder: ({ path, method }) => (path === '/api/hosts/gpu-1/config' && method === 'PUT'
      ? { ok: true, status: 200, text: async () => JSON.stringify({ host: saved }) }
      : null),
  });
  dom.app.querySelector('.host-table tbody tr').click();
  await flush();

  const drawer = dom.app.querySelector('.host-drawer');
  const box = drawer.querySelector('input[type="text"]');
  assert.ok(box, '注入配置区应有启动目录输入框');
  assert.match(box.getAttribute('placeholder'), /家目录/);
  const form = drawer.querySelector('.drawer-form');
  const save = drawer.querySelectorAll('.btn').find((b) => b.textContent === '保存');

  box.value = 'relative/dir';
  form.dispatchEvent({ type: 'input' });
  save.click();
  await flush();
  assert.equal(calls.some((c) => c.method === 'PUT'), false, '非法值不该发请求');
  assert.match(drawer.textContent, /绝对路径/, '错误就地提示');

  box.value = '~/proj';
  form.dispatchEvent({ type: 'input' });
  save.click();
  await flush();
  const put = calls.find((c) => c.method === 'PUT');
  assert.deepEqual(put.body, { workdir: '~/proj' }, '只提交改动的键');
});

/**
 * 回归（issue #30）：错误提示原来只在点保存时算一次，之后再没人碰——
 * 真 Chrome 里改回合法值 45999，红字和 aria-invalid 还挂在那儿。
 */
test('错误提示跟着输入更新：改对了立刻灭，改坏了立刻换成新错', async (t) => {
  const { dom, calls } = await mount(t);
  dom.app.querySelector('.host-table tbody tr').click();
  await flush();

  const drawer = dom.app.querySelector('.host-drawer');
  const form = drawer.querySelector('.drawer-form');
  const port = drawer.querySelector('input[type="number"]');
  const save = drawer.querySelectorAll('.btn').find((b) => b.textContent === '保存');
  const errText = () => drawer.querySelectorAll('.field-error').map((e) => e.textContent).filter(Boolean).join(' / ');

  port.value = '70000';
  form.dispatchEvent({ type: 'input' });
  save.click();
  await flush();
  assert.equal(calls.some((c) => c.method === 'PUT'), false, '非法值不该发请求');
  assert.match(errText(), /65535/, '点保存时该报出来');
  assert.equal(port.getAttribute('aria-invalid'), 'true');

  port.value = '45999';
  form.dispatchEvent({ type: 'input' });
  await flush();
  assert.equal(errText(), '', '值已合法，红字还挂着（读屏用户听到的是「无效」）');
  assert.equal(port.getAttribute('aria-invalid'), 'false');

  // 再改坏：既然提示已经亮过，就该跟着换成当前这条错，而不是留着旧的
  port.value = '0';
  form.dispatchEvent({ type: 'input' });
  await flush();
  assert.match(errText(), /65535/, '改回非法值应立刻重新提示');
});

/**
 * 回归（issue #30）：没点过保存之前，填 abc / 0 / 70000 一律没有任何提示。
 * 边打字边报太吵（刚敲下 4 就红一次没意义），所以按离开字段（blur）报。
 */
test('离开字段即校验：不必等到点保存才第一次知道填错了', async (t) => {
  const { dom } = await mount(t);
  dom.app.querySelector('.host-table tbody tr').click();
  await flush();

  const drawer = dom.app.querySelector('.host-drawer');
  const form = drawer.querySelector('.drawer-form');
  const port = drawer.querySelector('input[type="number"]');
  const errText = () => drawer.querySelectorAll('.field-error').map((e) => e.textContent).filter(Boolean).join(' / ');

  // 打 8080 的过程中会先经过 '0'（非法），这时候报错就是纯噪声
  port.value = '0';
  form.dispatchEvent({ type: 'input' });
  await flush();
  assert.equal(errText(), '', '还在打字就报错太吵');

  port.dispatchEvent({ type: 'blur' });
  await flush();
  assert.match(errText(), /65535/, '离开字段了还不说，就得等到点保存才知道');

  // 碰过之后就一直跟着值走：这里不再需要第二次 blur
  port.value = '8080';
  form.dispatchEvent({ type: 'input' });
  await flush();
  assert.equal(errText(), '', '改成合法值后红字该立刻灭');

  port.value = '';
  form.dispatchEvent({ type: 'input' });
  await flush();
  assert.equal(errText(), '', '清空＝回落全局默认，是合法的');
});

test('抽屉里的「重启后生效」徽标：仅当运行实例与已存配置不一致时出现', async (t) => {
  const host = running('gpu-1');
  host.config = { ...host.config, workdir: '/root/b' };
  host.web = { ...host.web, workdir: '/root/a' };

  const { dom } = await mount(t, { hosts: [host] });
  dom.app.querySelector('.host-table tbody tr').click();
  await flush();

  const drawer = dom.app.querySelector('.host-drawer');
  const badgeEl = drawer.querySelector('.pending-badge');
  assert.equal(badgeEl.hidden, false, '两值不等且实例在跑 → 提示重启');
  assert.equal(badgeEl.textContent, '重启后生效');
});

test('抽屉里的「重启后生效」徽标：值一致时隐藏；实测工作目录照常展示', async (t) => {
  const host = running('gpu-1');
  host.web = { ...host.web, cwd: '/root/proj' };
  const { dom } = await mount(t, { hosts: [host] });
  dom.app.querySelector('.host-table tbody tr').click();
  await flush();

  const drawer = dom.app.querySelector('.host-drawer');
  assert.equal(drawer.querySelector('.pending-badge').hidden, true);
  const probe = drawer.querySelector('.probe-detail');
  assert.match(probe.textContent, /实际工作目录/);
  assert.match(probe.textContent, /\/root\/proj/);
});

test('实测工作目录不可读时显示「—」，不编造值', async (t) => {
  const { dom } = await mount(t, { hosts: [running('gpu-1')] });
  dom.app.querySelector('.host-table tbody tr').click();
  await flush();

  const rows = dom.app.querySelector('.probe-detail').querySelectorAll('dd').map((d) => d.textContent);
  assert.ok(rows.includes('—'), `cwd 为 null 应退回破折号：${rows.join('|')}`);
});

test('manager 重启需确认，确认后发请求', async (t) => {
  const { dom, calls } = await mount(t);
  dom.app.querySelector('.manager-card').querySelectorAll('.btn').find((b) => /重启 manager/.test(b.textContent)).click();
  await flush();

  const dialog = dom.app.querySelector('.confirm-dialog');
  assert.equal(dialog.open, true);
  dialog.querySelectorAll('.btn').find((b) => b.textContent === '重启').click();
  await flush();

  assert.equal(calls.some((c) => c.path === '/api/manager/restart' && c.method === 'POST'), true);
});

test('全局默认：倒置区间不提交，逐字段报错', async (t) => {
  const { dom, calls } = await mount(t);
  const card = dom.app.querySelector('.defaults-card');
  const inputs = card.querySelectorAll('input');
  const [remote, managerPort, from, to] = inputs;
  assert.equal(remote.value, '8899');
  assert.equal(managerPort.value, '7788');

  from.value = '17799';
  to.value = '17701';
  card.querySelectorAll('.btn').find((b) => b.textContent === '保存').click();
  await flush();

  assert.equal(calls.some((c) => c.method === 'PUT'), false, '非法区间不该发请求');
  const errors = card.querySelectorAll('.field-error').map((e) => e.textContent).filter(Boolean);
  assert.equal(errors.length, 1, '只该在出错的字段上报错');
  assert.match(errors[0], /终点/);
});

test('setup 未完成：强制跳向导，先不拉主机清单', async (t) => {
  const { dom, calls, es } = await mount(t, {
    responder: ({ path }) => (path === '/api/manager/info'
      ? { ok: true, status: 200, text: async () => JSON.stringify({ ...MANAGER_INFO, setupCompleted: false }) }
      : null),
  });

  assert.equal(dom.window.location.hash, '#/setup');
  assert.equal(calls.some((c) => c.path === '/api/hosts'), false, '主机清单等向导走到第 3 步再拉');
  assert.ok(es(), 'setup 模式仍建 SSE：第 3 步要靠 host-changed 收探测结果');
  assert.equal(dom.app.querySelector('.view-dashboard').hidden, true);
  assert.equal(dom.app.querySelector('.setup-wizard').hidden, false, '向导独占页面');
});

test('向导收尾落 hub，并把焦点交给 hub 标题', async (t) => {
  const info = { ...MANAGER_INFO, setupCompleted: false };
  const { app, dom } = await mount(t, { info });
  assert.equal(dom.window.location.hash, '#/setup');

  app.store.setManagerInfo({ ...MANAGER_INFO, setupCompleted: true });
  dom.window.location.hash = '#/hub';

  const heading = dom.app.querySelector('.view-hub h2');
  assert.equal(dom.window.location.hash, '#/hub');
  assert.equal(dom.app.querySelector('.setup-wizard').hidden, true);
  assert.equal(dom.document.activeElement, heading);
  assert.equal(heading.getAttribute('tabindex'), '-1');
});

test('manager 不可达：给可重试的错误页', async (t) => {
  const { dom } = await mount(t, {
    responder: ({ path }) => (path === '/api/manager/info'
      ? { ok: false, status: 500, text: async () => JSON.stringify({ error: '内部错误', code: 'INTERNAL' }) }
      : null),
  });

  const skeleton = dom.app.querySelector('.view-skeleton');
  assert.match(skeleton.textContent, /无法连接 manager/);
  assert.ok(skeleton.querySelectorAll('.btn').find((b) => b.textContent === '重试'));
  assert.equal(dom.app.querySelector('.toast-error') !== null, true);
});
