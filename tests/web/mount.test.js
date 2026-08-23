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

function drawerDetail(drawer, label) {
  const detail = drawer.querySelector('.probe-detail');
  const labels = detail.querySelectorAll('dt');
  const values = detail.querySelectorAll('dd');
  const index = labels.findIndex((node) => node.textContent === label);
  return index < 0 ? null : values[index].textContent;
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
  assert.equal(app.store.state.manager.info.port, 7788);
  assert.equal(app.store.state.manager.configuredPort, 7788);
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

test('本机行使用共享状态、提示与直连映射语义', async (t) => {
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

  assert.equal(row().querySelector('.phase-badge').textContent, '本机未安装或未配置');
  assert.equal(row().querySelector('.phase-hint').textContent, '本机未安装 dsh');

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
  const mapping = row().querySelector('.mapping-cell');
  assert.equal(mapping.querySelector('a').textContent, '本机 19001');
  assert.equal(mapping.querySelector('small').textContent, '直连 dsh web');

  es().send('host-changed', {
    revision: 3,
    host: localHostView('workstation', {
      phase: 'unreachable',
      probe: { ...hostView('workstation').probe, errorSummary: '本机探测 fixture 失败详情' },
    }),
  });
  await flush();
  assert.equal(row().querySelector('.phase-badge').textContent, '本机不可用');
  assert.equal(row().querySelector('.phase-hint').textContent, '本机探测 fixture 失败详情',
    'errorSummary 是用户诊断信息，不能因本机身份被隐藏');
});

test('本机抽屉 badge 复用共享文案，不渗入 SSH/远端措辞', async (t) => {
  const unavailable = localHostView('workstation', {
    phase: 'unreachable',
    probe: { ...hostView('workstation').probe, errorSummary: '本机命令执行失败' },
  });
  const { dom } = await mount(t, { hosts: [unavailable] });
  dom.app.querySelector('.host-table tbody tr').click();
  await flush();

  const drawer = dom.app.querySelector('.host-drawer');
  assert.equal(drawer.querySelector('.drawer-badge .phase-badge').textContent, '本机不可用');
  assert.doesNotMatch(drawer.textContent, /SSH|远端/);
});

test('本机抽屉映射只在 URL 与 tunnel.localPort 齐全时展示 URL', async (t) => {
  const missingPort = localHostView('workstation', {
    phase: 'running',
    mappedUrl: 'http://127.0.0.1:19001/',
    web: { pid: 999, port: 19001, startedByUs: true, startedAt: new Date().toISOString(), workdir: null },
    tunnel: { localPort: null, connected: true, reconnectAttempt: 0, suspendedReason: null },
  });
  const { dom, es } = await mount(t, { hosts: [missingPort] });
  dom.app.querySelector('.host-table tbody tr').click();
  await flush();

  const drawer = dom.app.querySelector('.host-drawer');
  assert.equal(drawerDetail(drawer, '本机映射'), '—', '缺 tunnel.localPort 时不得直接信 mappedUrl');

  es().send('host-changed', {
    revision: 2,
    host: {
      ...missingPort,
      tunnel: { ...missingPort.tunnel, localPort: 19001 },
    },
  });
  await flush();
  assert.equal(drawerDetail(drawer, '本机映射'), missingPort.mappedUrl);
});

test('本机映射：Hub 与管理表只认同时确认的 mappedUrl 和 tunnel.localPort', async (t) => {
  const localRunning = (name, mappedUrl, tunnelPort, configPort) => {
    const base = localHostView(name);
    return {
      ...base,
      phase: 'running',
      mappedUrl,
      config: { ...base.config, localPort: configPort },
      web: {
        pid: 999, port: 8899, startedByUs: true, startedAt: new Date().toISOString(), workdir: null,
      },
      tunnel: {
        localPort: tunnelPort, connected: true, reconnectAttempt: 0, suspendedReason: null,
      },
    };
  };
  const confirmed = localRunning('local-confirmed', 'http://127.0.0.1:19001/', 19_001, 17_701);
  const missingUrl = localRunning('local-missing-url', null, 19_002, 17_702);
  const missingPort = localRunning('local-missing-port', 'http://127.0.0.1:19003/', null, 17_703);
  const { dom } = await mount(t, { hosts: [confirmed, missingUrl, missingPort] });
  const tableMapping = (name) => dom.app
    .querySelector(`.host-table tbody tr[data-host="${name}"] .mapping-cell`);
  const hubSummary = (name) => dom.app
    .querySelector(`.hub-host-card[data-host="${name}"] .hub-host-summary`);

  assert.equal(tableMapping(confirmed.name).querySelector('a').getAttribute('href'), confirmed.mappedUrl);
  assert.equal(tableMapping(confirmed.name).querySelector('a').textContent, '本机 19001');
  assert.equal(hubSummary(confirmed.name).textContent, '本机 19001 · 点击进入');

  for (const [host, reservedPort] of [[missingUrl, '17702'], [missingPort, '17703']]) {
    const mapping = tableMapping(host.name);
    const summary = hubSummary(host.name);
    assert.equal(mapping.querySelector('a'), null, `${host.name} 缺确认项时不能生成映射链接`);
    assert.equal(mapping.textContent, '—');
    assert.equal(summary.textContent, '页面已就绪 · 点击进入');
    assert.doesNotMatch(`${mapping.textContent} ${summary.textContent}`, new RegExp(reservedPort),
      `${host.name} 不能回退猜测 config.localPort`);
  }
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

test('pending start 遇到 running 快照后解除行忙态', async (t) => {
  const { app, dom, es } = await mount(t, { hosts: [hostView('gpu-1')] });
  dom.app.querySelector('[data-host="gpu-1"] [data-act="start"]').click();
  await flush();

  assert.equal(app.store.isPending('start', 'gpu-1'), true);
  assert.equal(app.store.hostBusy('gpu-1'), true);
  assert.equal(dom.app.querySelector('[data-host="gpu-1"] [data-act="start"]').disabled, true);

  es().send('snapshot', {
    revision: 2,
    manager: MANAGER_INFO,
    defaults: DEFAULTS,
    hosts: [running('gpu-1')],
    logs: [],
  });
  await flush();

  assert.equal(app.store.isPending('start', 'gpu-1'), false, '终态快照应结算失联期间丢失的 operation-done');
  assert.equal(app.store.hostBusy('gpu-1'), false);
  assert.equal(dom.app.querySelector('[data-host="gpu-1"] [data-act="stop"]').disabled, false,
    'running 到达后应展示可用的下一步动作');
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

test('抽屉不再编辑 autoStart，脏草稿忽略表格自启更新且保存不回滚', async (t) => {
  const original = hostView('gpu-1');
  const remote = hostView('gpu-1', {
    config: { ...original.config, autoStart: true },
  });
  const { app, dom, calls, es } = await mount(t, {
    hosts: [original],
    responder: ({ path, method, body }) => (path === '/api/hosts/gpu-1/config' && method === 'PUT'
      ? {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          host: { ...remote, config: { ...remote.config, inject: body.inject } },
        }),
      }
      : null),
  });
  dom.app.querySelector('.host-table tbody tr[data-host="gpu-1"]').click();
  await flush();

  const drawer = dom.app.querySelector('.host-drawer');
  assert.doesNotMatch(drawer.textContent, /随 manager 自启/);
  const drawerChecks = drawer.querySelectorAll('input[type="checkbox"]');
  assert.equal(drawerChecks.length, 1, '抽屉基本配置只保留纳管开关');
  assert.equal(drawerChecks[0].closest('.field').querySelector('label').textContent, '纳管此主机');

  const form = drawer.querySelector('.drawer-form');
  const envInput = drawer.querySelectorAll('textarea')[0];
  const notice = drawer.querySelector('.card-notice');
  envInput.value = 'LOCAL_DRAFT=1';
  form.dispatchEvent({ type: 'input' });
  assert.equal(app.store.state.drawer.dirty, true);

  es().send('host-changed', { revision: 2, host: remote });
  await flush();
  assert.equal(notice.hidden, true, '仅 autoStart 变化不属于抽屉冲突');
  assert.equal(envInput.value, 'LOCAL_DRAFT=1', '非抽屉字段更新不能覆盖脏草稿');
  assert.equal(app.store.getHost('gpu-1').config.autoStart, true);

  drawer.querySelectorAll('.btn').find((button) => button.textContent === '保存').click();
  await flush();

  const put = calls.find((call) => call.method === 'PUT');
  assert.deepEqual(put.body, {
    inject: { env: { LOCAL_DRAFT: '1' }, extraArgs: [], patches: [] },
  });
  assert.equal('autoStart' in put.body, false, '保存 env 不得顺带覆盖表格刚写入的自启值');
  assert.equal(app.store.getHost('gpu-1').config.autoStart, true, '远端自启值不得被抽屉保存回滚');
  assert.equal(notice.hidden, true);
});

test('断线重同步：横幅按阶段变化，写操作等快照后恢复', async (t) => {
  const { dom, es } = await mount(t);
  es().open();
  es().send('snapshot', { revision: 1, manager: MANAGER_INFO, defaults: DEFAULTS, hosts: [hostView('gpu-1')], logs: [] });

  const banner = dom.app.querySelector('.disconnect-banner');
  const startButton = () => dom.app.querySelector('[data-host="gpu-1"] [data-act="start"]');
  const probeAll = dom.app.querySelector('.probe-all');
  const backToMain = dom.app.querySelector('.manage-back');
  assert.equal(banner.hidden, true);
  assert.equal(startButton().disabled, false);

  for (const fn of es().listeners.get('error')) fn({});
  assert.equal(banner.hidden, false);
  assert.match(banner.textContent, /失联/);
  assert.equal(probeAll.disabled, true);
  assert.equal(startButton().disabled, true, '断线时写操作必须禁用');
  assert.equal(backToMain.disabled, false, '返回主页面不是写操作，失联时仍应可用');

  es().open();
  assert.equal(banner.hidden, false, 'EventSource open 不代表状态已经同步');
  assert.match(banner.textContent, /正在同步/);
  assert.equal(probeAll.disabled, true, 'resyncing 期间全局写操作仍需禁用');
  assert.equal(startButton().disabled, true, 'resyncing 期间主机写操作仍需禁用');
  assert.equal(backToMain.disabled, false, '同步期间不能锁住本地导航');

  es().send('snapshot', { revision: 2, manager: MANAGER_INFO, defaults: DEFAULTS, hosts: [hostView('gpu-1')], logs: [] });
  assert.equal(banner.hidden, true);
  assert.equal(probeAll.disabled, false);
  assert.equal(startButton().disabled, false, '全量快照完成后写操作应恢复');
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

test('管理页有显式返回主页面按钮，直达 hub 并保留页头运维动作', async (t) => {
  const { dom } = await mount(t, { hash: '#/manage', hosts: [running('gpu-1')] });
  const hub = dom.app.querySelector('.view-hub');
  const manage = dom.app.querySelector('.view-dashboard');
  const pageHead = manage.querySelector('.manage-header');
  const back = pageHead.querySelector('.manage-back');

  assert.ok(back, '管理页页头应有清楚可见的返回主页面按钮');
  assert.match(back.textContent, /返回主页面/);
  assert.equal(back.classList.contains('btn'), true, '返回入口应复用项目统一按钮样式');
  assert.equal(back.getAttribute('type'), 'button');
  assert.notEqual(back.getAttribute('role'), 'tab', '返回入口必须是原生按钮，不得混入标签角色');
  assert.ok(pageHead.querySelector('.probe-all'), '全部探测按钮必须保留');
  assert.ok(pageHead.querySelector('.reload-config'), '重载配置按钮必须保留');

  back.click();
  assert.equal(dom.window.location.hash, '#/hub');
  assert.equal(hub.hidden, false, '点击后应显示 Hub');
  assert.equal(manage.hidden, true, '点击后应隐藏管理页');
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

test('批量配置入口随主机数、连接态与 config:sync pending 刷新', async (t) => {
  const { app, dom, es } = await mount(t, {
    hash: '#/manage',
    hosts: [hostView('only-one')],
  });
  const entry = dom.app.querySelector('.config-sync-open');
  assert.ok(entry, '管理页页头应提供批量同步入口');
  assert.equal(entry.disabled, true, '不足两台主机不能同步');

  es().send('snapshot', {
    revision: 2,
    manager: MANAGER_INFO,
    defaults: DEFAULTS,
    hosts: [hostView('gpu-1'), hostView('gpu-2')],
    logs: [],
  });
  assert.equal(entry.disabled, false, 'hosts reset 增加到两台后应立即启用');

  const pending = app.store.beginPending({ action: 'config:sync' });
  assert.equal(entry.disabled, true, '同步 pending 时入口必须锁住');
  app.store.settlePending(pending.key);
  assert.equal(entry.disabled, false);

  entry.focus();
  entry.click();
  const dialog = dom.app.querySelector('.config-sync-dialog');
  assert.equal(dialog.open, true);
  assert.equal(dom.document.activeElement, dialog.querySelector('.config-sync-source'));

  app.store.setConnection({ sse: 'offline', everOpened: true });
  assert.equal(entry.disabled, true, 'store.canWrite=false 时必须禁用');
  assert.equal(dialog.open, false, '入口禁用时已打开的原生 dialog 必须关闭');
  assert.equal(dom.document.activeElement, dom.app.querySelector('.manage-back'),
    '断线关闭后焦点要回到稳定导航，不能留在 disabled 入口或 body');
});

test('批量配置 dialog：原生语义、焦点、源目标互斥与快捷选择完整', async (t) => {
  const { dom } = await mount(t, {
    hash: '#/manage',
    hosts: [hostView('gpu-1'), hostView('gpu-2'), hostView('gpu-3')],
  });
  const entry = dom.app.querySelector('.config-sync-open');
  entry.focus();
  entry.click();

  const dialog = dom.app.querySelector('.config-sync-dialog');
  const source = dialog.querySelector('.config-sync-source');
  const checks = () => dialog.querySelectorAll('.config-sync-targets input[type="checkbox"]');
  const byHost = (name) => checks().find((node) => node.dataset.host === name);
  assert.equal(dialog.localName, 'dialog');
  assert.equal(dialog.open, true);
  assert.equal(dialog.getAttribute('aria-labelledby'), 'config-sync-title');
  assert.ok(dialog.querySelector('label').getAttribute('for') === source.id);
  assert.match(dialog.querySelector('fieldset legend').textContent, /目标主机/);
  assert.equal(dialog.querySelector('.config-sync-status').getAttribute('aria-live'), 'polite');
  assert.equal(dialog.querySelector('.config-sync-error').getAttribute('role'), 'alert');
  assert.equal(dialog.querySelector('.config-sync-error').getAttribute('aria-live'), 'assertive');
  assert.equal(dialog.querySelector('.config-sync-target-count').textContent, '已选 0 / 200 台');
  assert.equal(dom.document.activeElement, source, '打开后应聚焦源主机 select');
  assert.equal(source.value, 'gpu-1');
  assert.equal(byHost('gpu-1').disabled, true, '源主机不能作为目标');
  assert.equal(byHost('gpu-1').checked, false);
  assert.equal(dialog.querySelector('.config-sync-preview').disabled, true, '没有目标时不能预览');
  assert.match(dialog.textContent, /不会修改主机身份、启用\/自启或本机映射端口/);

  dialog.querySelector('.config-sync-select-all').click();
  assert.deepEqual(
    checks().filter((node) => node.checked).map((node) => node.dataset.host),
    ['gpu-2', 'gpu-3'],
  );
  assert.equal(dialog.querySelector('.config-sync-target-count').textContent, '已选 2 / 200 台');

  source.value = 'gpu-2';
  source.dispatchEvent({ type: 'change' });
  assert.equal(byHost('gpu-2').disabled, true);
  assert.equal(byHost('gpu-2').checked, false, '新源必须立刻从目标中剔除');
  assert.equal(byHost('gpu-3').checked, true, '源变化应保留仍合法目标');
  assert.equal(byHost('gpu-1').checked, false, '旧源变合法后不应被擅自选中');

  dialog.querySelector('.config-sync-clear').click();
  assert.equal(checks().some((node) => node.checked), false);
  assert.equal(dialog.querySelector('.config-sync-preview').disabled, true);
});

test('批量配置目标上限：全选按主机顺序取前 200，手动第 201 项被拒绝', async (t) => {
  const names = Array.from({ length: 202 }, (_, index) => `host-${String(index).padStart(3, '0')}`);
  const { dom, calls } = await mount(t, {
    hash: '#/manage',
    hosts: names.map((name) => hostView(name)),
  });
  dom.app.querySelector('.config-sync-open').click();
  const dialog = dom.app.querySelector('.config-sync-dialog');
  const checks = () => dialog.querySelectorAll('.config-sync-targets input[type="checkbox"]');

  dialog.querySelector('.config-sync-select-all').click();
  const selectedByAll = checks().filter((node) => node.checked).map((node) => node.dataset.host);
  assert.deepEqual(selectedByAll, names.slice(1, 201), '全选应按 store 主机顺序截取，不能分批或乱序');
  assert.equal(selectedByAll.length, 200);
  assert.equal(dialog.querySelector('.config-sync-target-count').textContent, '已选 200 / 200 台');
  assert.match(dialog.querySelector('.config-sync-status').textContent, /前 200 台/);

  dialog.querySelector('.config-sync-preview').click();
  await flush();
  let request = calls.filter((call) => call.path === '/api/hosts/sync-config').at(-1);
  assert.deepEqual(request.body.targets, names.slice(1, 201));
  assert.equal(request.body.targets.length, 200, '任何请求都不得超过 UI 上限');

  dialog.querySelector('.config-sync-clear').click();
  const available = checks().filter((node) => !node.disabled);
  for (const input of available.slice(0, 200)) {
    input.checked = true;
    input.dispatchEvent({ type: 'change' });
  }
  const item201 = available[200];
  item201.checked = true;
  item201.dispatchEvent({ type: 'change' });

  assert.equal(item201.checked, false, '第 201 项必须当场拒选');
  assert.equal(checks().filter((node) => node.checked).length, 200);
  assert.equal(dialog.querySelector('.config-sync-target-count').textContent, '已选 200 / 200 台');
  assert.match(dialog.querySelector('.config-sync-status').textContent, /最多选择 200 台.*先取消一台/);

  dialog.querySelector('.config-sync-preview').click();
  await flush();
  request = calls.filter((call) => call.path === '/api/hosts/sync-config').at(-1);
  assert.equal(request.body.targets.length, 200);
});

test('批量配置预览 pending 锁住全部控件，无变更结果不能应用', async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { dom } = await mount(t, {
    hash: '#/manage',
    hosts: [hostView('source'), hostView('target')],
    responder: ({ path, body }) => (path === '/api/hosts/sync-config'
      ? gate.then(() => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          source: body.source,
          dryRun: true,
          targets: [{ name: 'target', changed: false, changedFields: [] }],
          applied: [],
          hosts: [],
          previewToken: 'v1.noop-preview',
        }),
      }))
      : null),
  });
  dom.app.querySelector('.config-sync-open').click();
  const dialog = dom.app.querySelector('.config-sync-dialog');
  const target = dialog.querySelector('[data-host="target"]');
  target.checked = true;
  target.dispatchEvent({ type: 'change' });
  dialog.querySelector('.config-sync-preview').click();

  assert.equal(dialog.querySelector('.config-sync-source').disabled, true);
  assert.equal(target.disabled, true);
  assert.equal(dialog.querySelector('.config-sync-select-all').disabled, true);
  assert.equal(dialog.querySelector('.config-sync-clear').disabled, true);
  assert.equal(dialog.querySelector('.config-sync-close').disabled, true);
  assert.equal(dialog.querySelector('.config-sync-preview').disabled, true);
  assert.equal(dialog.querySelector('.config-sync-apply').disabled, true);

  release();
  await flush();
  await flush();
  assert.match(dialog.querySelector('.config-sync-results').textContent, /无需变更/);
  assert.equal(dialog.querySelector('.config-sync-apply').disabled, true,
    '至少一台 changed 才允许应用');
});

test('批量配置预览与应用：不泄漏值、失效旧结果、标示重启并落服务端视图', async (t) => {
  const sourceHost = hostView('source', {
    config: {
      ...hostView('source').config,
      inject: { env: { API_SECRET: 'TOP-SECRET-VALUE' }, extraArgs: ['--secret-flag'], patches: [] },
    },
  });
  const targetHost = running('target-running');
  const updated = {
    ...targetHost,
    config: {
      ...targetHost.config,
      workdir: '/srv/from-source',
      inject: { env: { API_SECRET: 'SERVER-ONLY-VALUE' }, extraArgs: ['--secret-flag'], patches: [] },
    },
  };
  const newest = {
    ...updated,
    config: {
      ...updated.config,
      workdir: '/srv/newest-sse',
      inject: { ...updated.config.inject, env: { API_SECRET: 'LATEST-SSE-VALUE' } },
    },
  };
  let releaseApply;
  let previewCount = 0;
  const reply = (body) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
  const applyGate = new Promise((resolve) => {
    releaseApply = (body) => resolve(reply(body));
  });
  const { app, dom, calls, es } = await mount(t, {
    hash: '#/manage',
    hosts: [sourceHost, targetHost],
    responder: ({ path, method, body }) => {
      if (path !== '/api/hosts/sync-config' || method !== 'POST') return null;
      return body.dryRun
        ? reply({
          source: 'source',
          dryRun: true,
          targets: [{
            name: 'target-running',
            changed: true,
            changedFields: ['remoteWebPort', 'workdir', 'inject.env', 'inject.extraArgs', 'inject.patches'],
          }],
          applied: [],
          hosts: [],
          previewToken: `v1.preview-${previewCount += 1}`,
        })
        : applyGate;
    },
  });
  const applyResponse = {
    source: 'source',
    dryRun: false,
    targets: [{
      name: 'target-running',
      changed: true,
      changedFields: ['workdir', 'inject.env'],
    }],
    applied: ['target-running'],
    hosts: [updated],
  };
  const entry = dom.app.querySelector('.config-sync-open');
  entry.focus();
  entry.click();
  const dialog = dom.app.querySelector('.config-sync-dialog');
  const target = dialog.querySelector('[data-host="target-running"]');
  target.checked = true;
  target.dispatchEvent({ type: 'change' });

  dialog.querySelector('.config-sync-preview').click();
  await flush();

  const previewCall = calls.find((call) => call.path === '/api/hosts/sync-config');
  assert.deepEqual(previewCall.body, {
    source: 'source',
    targets: ['target-running'],
    dryRun: true,
  });
  const results = dialog.querySelector('.config-sync-results');
  assert.equal(results.querySelector('h3').textContent, '同步预览');
  assert.match(results.textContent, /将变更/);
  assert.match(results.textContent, /远端 web 端口/);
  assert.match(results.textContent, /工作目录/);
  assert.match(results.textContent, /环境变量/);
  assert.match(results.textContent, /附加参数/);
  assert.match(results.textContent, /补丁/);
  assert.doesNotMatch(dialog.textContent, /TOP-SECRET-VALUE|SERVER-ONLY-VALUE|--secret-flag/);
  assert.match(results.textContent, /下次重启生效/);
  assert.match(results.textContent, /不会重启或停止/);
  assert.equal(dialog.querySelector('.config-sync-apply').disabled, false);

  target.checked = false;
  target.dispatchEvent({ type: 'change' });
  assert.equal(dialog.querySelector('.config-sync-results'), null, '选择变化后旧 preview 必须消失');
  assert.match(dialog.querySelector('.config-sync-status').textContent, /重新预览/);
  assert.equal(dialog.querySelector('.config-sync-apply').disabled, true);

  target.checked = true;
  target.dispatchEvent({ type: 'change' });
  dialog.querySelector('.config-sync-preview').click();
  await flush();
  dialog.querySelector('.config-sync-apply').click();
  assert.equal(app.store.isPending('config:sync'), true);

  es().send('host-changed', { revision: 2, host: newest });
  await flush();
  assert.equal(app.store.getHost('target-running').config.workdir, '/srv/newest-sse',
    'apply 在途时到达的 revision SSE 应立即成为 store 真相');

  releaseApply(applyResponse);
  await flush();
  await flush();

  const syncCalls = calls.filter((call) => call.path === '/api/hosts/sync-config');
  assert.deepEqual(syncCalls.at(-1).body, {
    source: 'source',
    targets: ['target-running'],
    dryRun: false,
    previewToken: 'v1.preview-2',
  });
  assert.equal(app.store.getHost('target-running').config.workdir, '/srv/newest-sse',
    '迟到的无 revision apply 响应不得回退较新 SSE');
  assert.doesNotMatch(dialog.textContent, /TOP-SECRET-VALUE|SERVER-ONLY-VALUE|LATEST-SSE-VALUE|--secret-flag/);
  assert.equal(app.store.state.toasts.at(-1).summary, '已同步 1 台主机配置');
  const appliedResults = dialog.querySelector('.config-sync-results');
  assert.equal(appliedResults.querySelector('h3').textContent, '同步结果');
  assert.match(appliedResults.textContent, /已变更/);
  assert.doesNotMatch(appliedResults.textContent, /同步预览|将变更/);
  assert.equal(dialog.querySelector('.config-sync-apply').disabled, true, '应用成功后不能重复应用');
  assert.equal(dialog.open, true, '成功后允许留在结果页');

  es().send('host-changed', { revision: 3, host: newest });
  await flush();
  assert.ok(dialog.querySelector('.config-sync-results'),
    '应用后的结果页不是待应用 preview，随后到达的服务端 HostView 不应把它清空');

  dialog.querySelector('.config-sync-close').click();
  assert.equal(dialog.open, false);
  assert.equal(dom.document.activeElement, entry, '关闭后焦点应回到触发按钮');
});

test('批量配置 dialog：相关 SSE/hosts reset 废弃预览、删主机修正选择，Escape 还焦点', async (t) => {
  const reply = (body) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
  const { dom, es } = await mount(t, {
    hash: '#/manage',
    hosts: [hostView('source'), hostView('target'), hostView('third')],
    responder: ({ path, body }) => (path === '/api/hosts/sync-config' && body?.dryRun
      ? reply({
        source: body.source,
        dryRun: true,
        targets: body.targets.map((name) => ({ name, changed: true, changedFields: ['workdir'] })),
        applied: [],
        hosts: [],
        previewToken: 'v1.host-change-preview',
      })
      : null),
  });
  const entry = dom.app.querySelector('.config-sync-open');
  entry.focus();
  entry.click();
  const dialog = dom.app.querySelector('.config-sync-dialog');
  const target = dialog.querySelector('[data-host="target"]');
  target.checked = true;
  target.dispatchEvent({ type: 'change' });
  dialog.querySelector('.config-sync-preview').click();
  await flush();
  assert.ok(dialog.querySelector('.config-sync-results'));

  es().send('host-changed', { revision: 2, host: hostView('target', { phase: 'starting' }) });
  await flush();
  assert.equal(dialog.querySelector('.config-sync-results'), null);
  assert.match(dialog.querySelector('.config-sync-status').textContent, /主机状态已变化.*重新预览/);
  assert.equal(dialog.querySelector('.config-sync-apply').disabled, true);

  dialog.querySelector('.config-sync-preview').click();
  await flush();
  assert.ok(dialog.querySelector('.config-sync-results'));
  dialog.querySelector('[data-host="target"]').focus();
  es().send('snapshot', {
    revision: 3,
    manager: MANAGER_INFO,
    defaults: DEFAULTS,
    hosts: [hostView('target'), hostView('third')],
    logs: [],
  });
  await flush();

  const source = dialog.querySelector('.config-sync-source');
  assert.equal(source.value, 'target', '源被删除后应选择仍存在的第一台主机');
  assert.equal(dialog.querySelector('[data-host="target"]').disabled, true);
  assert.equal(dialog.querySelector('[data-host="target"]').checked, false);
  assert.equal(dom.document.activeElement.dataset.host, 'third',
    '重建后原焦点项变成 disabled 源时，应回退首个可用目标');
  assert.equal(dialog.querySelector('.config-sync-results'), null);
  assert.match(dialog.querySelector('.config-sync-status').textContent, /主机列表已变化.*重新预览/);

  dialog.dispatchEvent({ type: 'cancel' });
  assert.equal(dialog.open, false, 'Escape/cancel 应正常关闭');
  assert.equal(dom.document.activeElement, entry);
});

test('批量配置目标重建：焦点项消失时回退可用目标，无目标则回源选择', async (t) => {
  const { dom, es } = await mount(t, {
    hash: '#/manage',
    hosts: [hostView('source'), hostView('target'), hostView('third')],
  });
  dom.app.querySelector('.config-sync-open').click();
  const dialog = dom.app.querySelector('.config-sync-dialog');
  dialog.querySelector('[data-host="target"]').focus();

  es().send('snapshot', {
    revision: 2,
    manager: MANAGER_INFO,
    defaults: DEFAULTS,
    hosts: [hostView('source'), hostView('third')],
    logs: [],
  });
  await flush();
  assert.equal(dom.document.activeElement.dataset.host, 'third',
    '原目标被删除后应聚焦首个仍可用目标');

  es().send('snapshot', {
    revision: 3,
    manager: MANAGER_INFO,
    defaults: DEFAULTS,
    hosts: [hostView('third')],
    logs: [],
  });
  await flush();
  assert.equal(dom.document.activeElement, dialog.querySelector('.config-sync-source'),
    '唯一剩余项成为 disabled 源时，焦点应回源选择而不是 body');
});

test('批量配置预览 HTTP 失败：清空旧结果、释放 pending 并禁止应用', async (t) => {
  let previews = 0;
  const reply = (status, body) => ({
    ok: status < 400,
    status,
    text: async () => JSON.stringify(body),
  });
  const { app, dom, calls } = await mount(t, {
    hash: '#/manage',
    hosts: [hostView('source'), hostView('target')],
    responder: ({ path, body }) => {
      if (path !== '/api/hosts/sync-config' || !body?.dryRun) return null;
      previews += 1;
      return previews === 1
        ? reply(200, {
          source: body.source,
          dryRun: true,
          targets: [{ name: 'target', changed: true, changedFields: ['workdir'] }],
          applied: [],
          hosts: [],
          previewToken: 'v1.first-preview',
        })
        : reply(503, {
          error: '预览服务暂不可用',
          code: 'BUSY',
          detail: '请稍后重试：<img src=x onerror="pwned()">',
        });
    },
  });
  dom.app.querySelector('.config-sync-open').click();
  const dialog = dom.app.querySelector('.config-sync-dialog');
  const target = dialog.querySelector('[data-host="target"]');
  const preview = dialog.querySelector('.config-sync-preview');
  const apply = dialog.querySelector('.config-sync-apply');
  target.checked = true;
  target.dispatchEvent({ type: 'change' });

  preview.click();
  await flush();
  assert.ok(dialog.querySelector('.config-sync-results'), '先建立一份可应用的旧预览');
  assert.equal(apply.disabled, false);

  preview.click();
  assert.equal(calls.filter((call) => call.path === '/api/hosts/sync-config').length, 2);
  assert.equal(app.store.isPending('config:sync'), true);
  assert.equal(dialog.querySelector('.config-sync-results'), null, '重试发出时旧结果必须立刻移除');
  assert.equal(apply.disabled, true);

  await flush();
  assert.equal(app.store.isPending('config:sync'), false);
  assert.equal(dialog.querySelector('.config-sync-results'), null, '失败响应不能复活旧预览');
  assert.equal(apply.disabled, true);
  assert.equal(preview.disabled, false, '失败后应允许重新预览');
  assert.match(dialog.querySelector('.config-sync-status').textContent, /预览失败.*重试/);
  const toast = app.store.state.toasts.at(-1);
  assert.equal(toast.level, 'error');
  assert.equal(toast.summary, '预览服务暂不可用');
  assert.equal(toast.detail, '请稍后重试：<img src=x onerror="pwned()">');
  assert.match(dom.app.querySelector('.toast-error').textContent, /预览服务暂不可用/);
  const inlineError = dialog.querySelector('.config-sync-error');
  assert.equal(inlineError.hidden, false, '原生 modal 内必须有可访问的就地错误');
  assert.equal(inlineError.getAttribute('role'), 'alert');
  assert.equal(inlineError.getAttribute('aria-live'), 'assertive');
  assert.equal(inlineError.querySelector('.config-sync-error-summary').textContent, '预览服务暂不可用');
  assert.equal(inlineError.querySelector('details pre').textContent,
    '请稍后重试：<img src=x onerror="pwned()">');
  assert.equal(inlineError.querySelector('img'), null, '错误 detail 必须经 textContent 渲染');

  target.checked = false;
  target.dispatchEvent({ type: 'change' });
  assert.equal(inlineError.hidden, true, '重新选择目标后应清掉旧错误');
  assert.equal(inlineError.textContent, '');
});

test('批量配置 token 过期：就地要求重新预览，旧 token 不能重复应用', async (t) => {
  const reply = (status, body) => ({
    ok: status < 400,
    status,
    text: async () => JSON.stringify(body),
  });
  const { app, dom, calls } = await mount(t, {
    hash: '#/manage',
    hosts: [hostView('source'), hostView('target')],
    responder: ({ path, body }) => {
      if (path !== '/api/hosts/sync-config') return null;
      return body.dryRun
        ? reply(200, {
          source: body.source,
          dryRun: true,
          targets: [{ name: 'target', changed: true, changedFields: ['inject.env'] }],
          applied: [],
          hosts: [],
          previewToken: 'v1.stale-preview',
        })
        : reply(409, {
          error: '配置同步预览已过期或无效，请重新预览后再应用',
          code: 'CONFIG_STALE',
          detail: 'target revision changed',
        });
    },
  });
  dom.app.querySelector('.config-sync-open').click();
  const dialog = dom.app.querySelector('.config-sync-dialog');
  const target = dialog.querySelector('[data-host="target"]');
  const preview = dialog.querySelector('.config-sync-preview');
  const apply = dialog.querySelector('.config-sync-apply');
  target.checked = true;
  target.dispatchEvent({ type: 'change' });

  preview.click();
  await flush();
  assert.ok(dialog.querySelector('.config-sync-results'));
  assert.equal(apply.disabled, false);

  let injected = false;
  const stopInjecting = app.store.on('toasts:changed', (toasts) => {
    if (injected || toasts.at(-1)?.summary !== '配置同步预览已过期或无效，请重新预览后再应用') return;
    injected = true;
    app.store.addToast({
      level: 'error',
      summary: '并发无关错误',
      detail: '不能被同步 dialog 误取',
    });
  });
  t.after(stopInjecting);
  apply.click();
  assert.equal(app.store.isPending('config:sync'), true);
  assert.equal(dialog.querySelector('.config-sync-results'), null, '应用开始即不能继续展示待应用预览');
  await flush();

  const syncCalls = () => calls.filter((call) => call.path === '/api/hosts/sync-config');
  assert.deepEqual(syncCalls().map((call) => call.body.dryRun), [true, false]);
  assert.equal(syncCalls()[1].body.previewToken, 'v1.stale-preview');
  assert.equal(app.store.isPending('config:sync'), false);
  assert.equal(dialog.querySelector('.config-sync-results'), null);
  assert.equal(apply.disabled, true);
  assert.match(dialog.querySelector('.config-sync-status').textContent, /预览已失效.*重新预览/);
  assert.ok(app.store.state.toasts.some((toast) => toast.summary === '配置同步预览已过期或无效，请重新预览后再应用'));
  assert.equal(app.store.state.toasts.at(-1).summary, '并发无关错误',
    '前提：动作错误之后确实并发新增了另一条 error toast');
  assert.match(dom.app.querySelector('.toast-error').textContent, /配置同步预览已过期或无效/);
  const inlineError = dialog.querySelector('.config-sync-error');
  assert.equal(inlineError.hidden, false);
  assert.equal(inlineError.querySelector('.config-sync-error-summary').textContent, '配置同步预览已过期或无效，请重新预览后再应用',
    'dialog 必须关联本次 actions 错误，不能拿最后一条并发 toast');
  assert.equal(inlineError.querySelector('details pre').textContent, 'target revision changed');
  assert.doesNotMatch(inlineError.textContent, /并发无关错误|不能被同步 dialog 误取/);

  apply.click();
  await flush();
  assert.equal(syncCalls().length, 2, '失败后的应用按钮必须是硬禁用，不能重复提交');

  preview.click();
  await flush();
  assert.deepEqual(syncCalls().map((call) => call.body.dryRun), [true, false, true]);
  assert.ok(dialog.querySelector('.config-sync-results'), '失败后重新预览应恢复结果');
  assert.equal(apply.disabled, false);
  assert.equal(inlineError.hidden, true, '重新预览成功后应清掉旧错误');
  assert.equal(inlineError.textContent, '');
});

test('批量配置预览在途时 SSE 改写选择：迟到响应必须丢弃', async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const reply = (body) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
  const { app, dom, calls, es } = await mount(t, {
    hash: '#/manage',
    hosts: [hostView('source'), hostView('target'), hostView('third')],
    responder: ({ path, body }) => (path === '/api/hosts/sync-config' && body?.dryRun
      ? gate.then(() => reply({
        source: body.source,
        dryRun: true,
        targets: [{ name: 'target', changed: true, changedFields: ['workdir'] }],
        applied: [],
        hosts: [],
        previewToken: 'v1.late-preview',
      }))
      : null),
  });
  dom.app.querySelector('.config-sync-open').click();
  const dialog = dom.app.querySelector('.config-sync-dialog');
  const target = dialog.querySelector('[data-host="target"]');
  target.checked = true;
  target.dispatchEvent({ type: 'change' });
  dialog.querySelector('.config-sync-preview').click();
  assert.equal(app.store.isPending('config:sync'), true);

  es().send('snapshot', {
    revision: 2,
    manager: MANAGER_INFO,
    defaults: DEFAULTS,
    hosts: [hostView('target'), hostView('third')],
    logs: [],
  });
  const source = dialog.querySelector('.config-sync-source');
  assert.equal(source.value, 'target', 'SSE 删除原源主机后应修正为仍存在的主机');
  assert.equal(dialog.querySelector('[data-host="target"]').checked, false);
  assert.equal(dialog.querySelector('[data-host="target"]').disabled, true);
  assert.match(dialog.querySelector('.config-sync-status').textContent, /主机列表已变化.*重新预览/);
  assert.equal(app.store.isPending('config:sync'), true, '选择失效不能假装 HTTP 请求已经结算');

  release();
  await flush();
  await flush();
  assert.equal(calls.filter((call) => call.path === '/api/hosts/sync-config').length, 1);
  assert.equal(app.store.isPending('config:sync'), false);
  assert.equal(dialog.querySelector('.config-sync-results'), null, '旧 selection 的迟到结果不得渲染');
  assert.equal(dialog.querySelector('.config-sync-apply').disabled, true);
  assert.equal(dialog.querySelector('.config-sync-preview').disabled, true, '修正选择后尚无目标，不能直接重试');
  assert.match(dialog.querySelector('.config-sync-status').textContent, /主机列表已变化.*重新预览/,
    '迟到响应不能覆盖 SSE 给出的真实状态');
});

test('批量配置应用在途时断线：关闭 dialog，迟到响应不重开也不渲染', async (t) => {
  let releaseApply;
  const reply = (body) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
  const applyGate = new Promise((resolve) => {
    releaseApply = () => resolve(reply({
      source: 'source',
      dryRun: false,
      targets: [{ name: 'target', changed: true, changedFields: ['workdir'] }],
      applied: ['target'],
      hosts: [hostView('target', {
        config: { ...hostView('target').config, workdir: '/srv/stale-response' },
      })],
    }));
  });
  const { app, dom, es } = await mount(t, {
    hash: '#/manage',
    hosts: [hostView('source'), hostView('target')],
    responder: ({ path, body }) => {
      if (path !== '/api/hosts/sync-config') return null;
      return body.dryRun
        ? reply({
          source: 'source',
          dryRun: true,
          targets: [{ name: 'target', changed: true, changedFields: ['workdir'] }],
          applied: [],
          hosts: [],
          previewToken: 'v1.disconnect-preview',
        })
        : applyGate;
    },
  });
  es().open();
  es().send('snapshot', {
    revision: 2,
    manager: MANAGER_INFO,
    defaults: DEFAULTS,
    hosts: [hostView('source'), hostView('target')],
    logs: [],
  });
  const entry = dom.app.querySelector('.config-sync-open');
  entry.click();
  const dialog = dom.app.querySelector('.config-sync-dialog');
  const target = dialog.querySelector('[data-host="target"]');
  target.checked = true;
  target.dispatchEvent({ type: 'change' });
  dialog.querySelector('.config-sync-preview').click();
  await flush();
  dialog.querySelector('.config-sync-apply').click();
  assert.equal(app.store.isPending('config:sync'), true);

  app.store.setConnection({ sse: 'offline', everOpened: true });
  assert.equal(dialog.open, false);
  assert.equal(entry.disabled, true);
  assert.equal(dom.document.activeElement, dom.app.querySelector('.manage-back'));

  releaseApply();
  await flush();
  await flush();
  assert.equal(dialog.open, false, '迟到成功响应不能重开已因断线关闭的 dialog');
  assert.equal(dialog.querySelector('.config-sync-results'), null);
  assert.equal(app.store.getHost('target').config.workdir, '/srv/stale-response',
    '没有后续 SSE 时，迟到成功响应仍应更新 store');
});

test('批量配置 dialog 无 showModal/close 时使用 open 属性并恢复焦点', async (t) => {
  const { dom, calls } = await mount(t, {
    hash: '#/manage',
    hosts: [hostView('source'), hostView('target')],
  });
  const entry = dom.app.querySelector('.config-sync-open');
  const dialog = dom.app.querySelector('.config-sync-dialog');
  dialog.showModal = undefined;
  dialog.close = undefined;
  entry.focus();

  entry.click();
  assert.equal(dialog.hasAttribute('open'), true, '缺少 showModal 时仍应通过 open 属性展示');
  assert.equal(dom.document.activeElement, dialog.querySelector('.config-sync-source'));

  dialog.querySelector('.config-sync-close').click();
  assert.equal(dialog.hasAttribute('open'), false, '缺少 close 时应移除 open 属性');
  assert.equal(dom.document.activeElement, entry);
  assert.equal(calls.filter((call) => call.path === '/api/hosts/sync-config').length, 0);
});

test('+N overflow 可纯键盘遍历、退出并只探测选中的主机', async (t) => {
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
  overflow.focus();
  overflow.dispatchEvent({ type: 'keydown', key: 'ArrowDown' });

  const menu = dom.app.querySelector('.overflow-menu');
  assert.equal(menu.hidden, false);
  assert.equal(overflow.getAttribute('aria-expanded'), 'true');
  assert.deepEqual(
    [dom.document.activeElement.dataset.host, dom.document.activeElement.dataset.action],
    ['disabled', 'probe'],
    'ArrowDown 打开后应聚焦首个可用 menuitem',
  );
  assert.match(menu.textContent, /disabled — 已禁用/);
  assert.match(menu.textContent, /missing — 未安装\/未配置/);
  assert.match(menu.textContent, /offline — SSH 不可达/);

  menu.dispatchEvent({ type: 'keydown', key: 'ArrowDown' });
  assert.deepEqual(
    [dom.document.activeElement.dataset.host, dom.document.activeElement.dataset.action],
    ['disabled', 'view-manage'],
  );
  menu.dispatchEvent({ type: 'keydown', key: 'ArrowUp' });
  assert.deepEqual(
    [dom.document.activeElement.dataset.host, dom.document.activeElement.dataset.action],
    ['disabled', 'probe'],
  );
  menu.dispatchEvent({ type: 'keydown', key: 'End' });
  assert.deepEqual(
    [dom.document.activeElement.dataset.host, dom.document.activeElement.dataset.action],
    ['offline', 'view-manage'],
  );
  menu.dispatchEvent({ type: 'keydown', key: 'Home' });
  assert.deepEqual(
    [dom.document.activeElement.dataset.host, dom.document.activeElement.dataset.action],
    ['disabled', 'probe'],
  );

  menu.dispatchEvent({ type: 'keydown', key: 'Escape' });
  assert.equal(menu.hidden, true);
  assert.equal(overflow.getAttribute('aria-expanded'), 'false');
  assert.equal(dom.document.activeElement, overflow, 'Escape 后焦点应回到 +N 入口');

  overflow.dispatchEvent({ type: 'keydown', key: 'ArrowDown' });
  const probe = menu.querySelector('[data-host="offline"][data-action="probe"]');
  probe.click();
  await flush();
  assert.deepEqual(
    calls.filter((c) => c.method === 'POST' && c.path.endsWith('/probe')).map((c) => c.path),
    ['/api/hosts/offline/probe'],
    '不得误探测菜单里的其他主机',
  );
  assert.equal(menu.hidden, true);
  assert.equal(dom.document.activeElement, overflow, '执行动作后焦点应回到 +N 入口');

  overflow.dispatchEvent({ type: 'keydown', key: 'ArrowDown' });
  menu.querySelector('[data-host="missing"][data-action="view-manage"]').click();
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

test('本机不可用项在 overflow 复用共享状态与诊断提示', async (t) => {
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
  const lineFor = (name) => menu
    .querySelector(`[data-host="${name}"][data-action="view-manage"]`)
    .closest('li')
    .querySelector('span')
    .textContent;
  assert.equal(lineFor('local-missing'), 'local-missing — 本机未安装或未配置 · 本机未安装 dsh');
  assert.equal(lineFor('local-offline'), 'local-offline — 本机不可用 · SSH connection refused',
    'errorSummary 即使含 SSH 字样也应作为原始诊断信息显示');
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

test('本机深链 fallback 与共享状态文案一致', async (t) => {
  const localMissing = localHostView('workstation', {
    phase: 'no_dsh',
    probe: {
      ...hostView('workstation').probe,
      dshPath: null,
      version: null,
      profileWeb: false,
      noDshReason: 'missing-bin',
    },
  });
  const { dom } = await mount(t, {
    hash: '#/host/workstation',
    hosts: [localMissing],
  });

  const fallback = dom.app.querySelector('.view-fallback .empty-hint');
  assert.equal(
    fallback.textContent,
    'workstation 当前状态「本机未安装或未配置」，还没有可打开的页面。',
  );
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

  const saveBtn = drawer.querySelectorAll('.btn').find((b) => b.textContent === '保存');
  assert.equal(saveBtn.disabled, true, '刚打开的 canonical 草稿没有可保存变更');

  const envBox = drawer.querySelectorAll('textarea')[0];
  envBox.value = 'A=1';
  drawer.querySelector('.drawer-form').dispatchEvent({ type: 'input' });

  assert.equal(saveBtn.disabled, false, '有改动才允许保存');

  drawer.querySelector('.drawer-close').click();
  await flush();
  assert.equal(dom.app.querySelector('.confirm-dialog').open, true, '脏草稿关闭需确认');
});

test('抽屉保存归一化后无有效差异：零 PUT、canonical 回填并清脏', async (t) => {
  const base = hostView('gpu-1');
  const host = hostView('gpu-1', {
    config: {
      ...base.config,
      workdir: '/srv/project',
      inject: { ...base.config.inject, env: { BASE: '1' } },
    },
  });
  const { app, dom, calls } = await mount(t, { hosts: [host] });
  dom.app.querySelector('.host-table tbody tr[data-host="gpu-1"]').click();
  await flush();

  const drawer = dom.app.querySelector('.host-drawer');
  const form = drawer.querySelector('.drawer-form');
  const workdir = drawer.querySelector('input[type="text"]');
  const envInput = drawer.querySelectorAll('textarea')[0];
  const [save, discard] = drawer.querySelector('.drawer-actions').querySelectorAll('button');

  workdir.value = '  /srv/project  ';
  envInput.value = 'BASE=1\n\n# 仅注释，不改变 env';
  form.dispatchEvent({ type: 'input' });
  assert.equal(app.store.state.drawer.dirty, true, 'raw draft 与 canonical 文本不同，点击前应允许处理');
  assert.equal(save.disabled, false);
  assert.equal(discard.disabled, false);

  save.click();
  await flush();

  assert.equal(calls.some((call) => call.method === 'PUT'), false, '归一化后无 diff 不应请求服务端');
  assert.equal(workdir.value, '/srv/project', 'workdir 应回填服务端 canonical draft');
  assert.equal(envInput.value, 'BASE=1', '注释与空行应从 canonical draft 中移除');
  assert.equal(app.store.state.drawer.dirty, false);
  assert.equal(save.disabled, true);
  assert.equal(discard.disabled, true);
  const toast = app.store.state.toasts.at(-1);
  assert.equal(toast.level, 'info');
  assert.match(toast.summary, /没有需要保存的有效变更/);
  assert.match(dom.app.querySelector('.toast-info').textContent, /没有需要保存的有效变更/);
});

test('抽屉提交以当下 DOM 为准，正常 env 修改只 PUT inject', async (t) => {
  const original = hostView('gpu-1');
  const saved = hostView('gpu-1', {
    config: {
      ...original.config,
      inject: { ...original.config.inject, env: { LATEST: '2' } },
    },
  });
  const { app, dom, calls } = await mount(t, {
    hosts: [original],
    responder: ({ path, method }) => (path === '/api/hosts/gpu-1/config' && method === 'PUT'
      ? { ok: true, status: 200, text: async () => JSON.stringify({ host: saved }) }
      : null),
  });
  dom.app.querySelector('.host-table tbody tr[data-host="gpu-1"]').click();
  await flush();

  const drawer = dom.app.querySelector('.host-drawer');
  const form = drawer.querySelector('.drawer-form');
  const envInput = drawer.querySelectorAll('textarea')[0];
  const save = drawer.querySelector('.drawer-actions').querySelectorAll('button')[0];

  envInput.value = 'STALE=1';
  form.dispatchEvent({ type: 'input' });
  envInput.value = 'LATEST=2';
  save.click();
  await flush();

  const put = calls.find((call) => call.method === 'PUT');
  assert.deepEqual(put.body, {
    inject: { env: { LATEST: '2' }, extraArgs: [], patches: [] },
  });
  assert.deepEqual(app.store.getHost('gpu-1').config.inject.env, { LATEST: '2' });
  assert.equal(app.store.state.drawer.dirty, false);
});

test('抽屉三方合并：本地只改 workdir 时吸收 SSE inject，保存不回滚远端值', async (t) => {
  const base = hostView('gpu-1');
  const original = hostView('gpu-1', {
    config: {
      ...base.config,
      inject: { ...base.config.inject, env: { BASE: '1' } },
    },
  });
  const remote = hostView('gpu-1', {
    config: {
      ...original.config,
      inject: { ...original.config.inject, env: { REMOTE: '2' } },
    },
  });
  const { app, dom, calls, es } = await mount(t, {
    hosts: [original],
    responder: ({ path, method, body }) => (path === '/api/hosts/gpu-1/config' && method === 'PUT'
      ? {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          host: { ...remote, config: { ...remote.config, ...body } },
        }),
      }
      : null),
  });
  dom.app.querySelector('.host-table tbody tr[data-host="gpu-1"]').click();
  await flush();

  const drawer = dom.app.querySelector('.host-drawer');
  const form = drawer.querySelector('.drawer-form');
  const workdir = drawer.querySelector('input[type="text"]');
  const envInput = drawer.querySelectorAll('textarea')[0];
  const [save] = drawer.querySelector('.drawer-actions').querySelectorAll('button');
  const notice = drawer.querySelector('.card-notice');

  workdir.value = '~/local-project';
  form.dispatchEvent({ type: 'input' });
  es().send('host-changed', { revision: 2, host: remote });
  await flush();

  assert.equal(workdir.value, '~/local-project', '用户改过的 workdir 必须保留');
  assert.equal(envInput.value, 'REMOTE=2', '用户未改的 env 必须吸收 SSE 最新值');
  assert.equal(notice.hidden, true, '不同字段各自更新不应制造冲突');
  assert.equal(save.disabled, false);

  save.click();
  await flush();

  const put = calls.find((call) => call.path === '/api/hosts/gpu-1/config' && call.method === 'PUT');
  assert.deepEqual(put.body, { workdir: '~/local-project' },
    'PUT 只含相对最新 baseline 的本地改动，不能带旧 inject');
  assert.deepEqual(app.store.getHost('gpu-1').config.inject.env, { REMOTE: '2' });
  assert.equal(app.store.state.drawer.dirty, false);
});

test('抽屉三方合并：双方同字段不同才显示冲突并暂停保存，放弃后采用新值', async (t) => {
  const original = hostView('gpu-1');
  const { app, dom, es } = await mount(t, { hosts: [original] });
  dom.app.querySelector('.host-table tbody tr[data-host="gpu-1"]').click();
  await flush();

  const drawer = dom.app.querySelector('.host-drawer');
  const form = drawer.querySelector('.drawer-form');
  const envInput = drawer.querySelectorAll('textarea')[0];
  const [save, discard] = drawer.querySelector('.drawer-actions').querySelectorAll('button');
  const notice = drawer.querySelector('.card-notice');

  envInput.value = 'LOCAL_DRAFT=1';
  form.dispatchEvent({ type: 'input' });
  assert.equal(app.store.state.drawer.dirty, true);

  const remote = hostView('gpu-1', {
    config: {
      ...original.config,
      inject: { ...original.config.inject, env: { REMOTE_VALUE: 'new' } },
    },
  });
  es().send('host-changed', { revision: 2, host: remote });
  await flush();

  assert.equal(notice.hidden, false, '冲突必须投影到已挂载抽屉，而非只停在 reconcile 返回值');
  assert.match(notice.textContent, /远端配置已变化/);
  assert.match(notice.textContent, /草稿已保留/);
  assert.equal(envInput.value, 'LOCAL_DRAFT=1', '远端更新不能静默覆盖脏草稿');
  assert.equal(save.disabled, true, '未解决的同字段冲突不能覆盖远端值');
  assert.equal(discard.disabled, false, '用户也可明确放弃并载入远端值');

  discard.click();
  assert.equal(envInput.value, 'REMOTE_VALUE=new');
  assert.equal(notice.hidden, true);
  assert.equal(app.store.state.drawer.dirty, false);
  assert.equal(save.disabled, true);
  assert.equal(discard.disabled, true);
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

function defaultsControls(dom) {
  const card = dom.app.querySelector('.defaults-card');
  const [remote, managerPort, from, to] = card.querySelectorAll('input');
  const save = card.querySelectorAll('.btn').find((button) => button.textContent === '保存');
  const reset = card.querySelectorAll('.btn').find((button) => button.textContent === '还原');
  return {
    card, remote, managerPort, from, to, save, reset, notice: card.querySelector('.card-notice'),
  };
}

test('config GET 的目标端口不覆盖 manager 卡实际监听端口', async (t) => {
  const { app, dom } = await mount(t, {
    responder: ({ path }) => (path === '/api/config'
      ? {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          configVersion: 1,
          setupCompleted: true,
          manager: { port: 7799 },
          defaults: DEFAULTS,
          hosts: {},
        }),
      }
      : null),
  });
  const { managerPort, notice } = defaultsControls(dom);
  const managerCard = dom.app.querySelector('.manager-card');

  assert.equal(app.store.state.manager.info.port, 7788);
  assert.equal(app.store.state.manager.configuredPort, 7799);
  assert.equal(managerPort.value, '7799');
  assert.match(managerCard.textContent, /监听端口7788/, 'manager 卡必须展示当前实际监听值');
  assert.match(notice.textContent, /7799.*重启 manager 后生效/);
});

test('全局默认：打开时干净且本机端口输入下限为 1024', async (t) => {
  const { dom } = await mount(t);
  const {
    remote, managerPort, from, to, save, reset,
  } = defaultsControls(dom);

  assert.equal(save.disabled, true);
  assert.equal(reset.disabled, true);
  assert.equal(remote.getAttribute('min'), '1');
  assert.equal(managerPort.getAttribute('min'), '1');
  assert.equal(from.getAttribute('min'), '1024');
  assert.equal(to.getAttribute('min'), '1024');
});

test('全局默认：保存、跨标签变更与重启快照始终按配置/运行端口派生提示', async (t) => {
  const reply = (body) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
  const { app, dom, calls, es } = await mount(t, {
    responder: ({ path, method }) => (path === '/api/config/defaults' && method === 'PUT'
      ? reply({
        defaults: DEFAULTS,
        manager: { port: 7799 },
        restartRequired: true,
      })
      : null),
  });
  const {
    managerPort, save, reset, notice,
  } = defaultsControls(dom);

  managerPort.value = '7799';
  managerPort.dispatchEvent({ type: 'input' });
  assert.equal(save.disabled, false);
  assert.equal(reset.disabled, false);

  save.click();
  await flush();

  const puts = calls.filter((call) => call.path === '/api/config/defaults' && call.method === 'PUT');
  assert.equal(puts.length, 1);
  assert.deepEqual(puts[0].body, { manager: { port: 7799 } });
  assert.equal(managerPort.value, '7799');
  assert.equal(save.disabled, true);
  assert.equal(reset.disabled, true);
  assert.equal(notice.hidden, false);
  assert.match(notice.textContent, /7799.*重启 manager 后生效/);
  assert.equal(app.store.state.manager.info.port, 7788, '保存目标配置不能让运行态 manager 卡撒谎');
  assert.equal(app.store.state.manager.configuredPort, 7799);
  assert.match(dom.app.querySelector('.manager-card').textContent, /监听端口7788/);

  es().send('config-changed', {
    revision: 2,
    defaults: { ...DEFAULTS, remoteWebPort: 9000 },
    manager: { port: 7800 },
  });
  await flush();
  assert.equal(managerPort.value, '7800');
  assert.match(notice.textContent, /7800.*重启 manager 后生效/, '提示必须点名最新跨标签配置');
  assert.doesNotMatch(notice.textContent, /7799/);
  assert.equal(app.store.state.manager.info.port, 7788);

  es().send('config-changed', {
    revision: 3,
    defaults: { ...DEFAULTS, remoteWebPort: 9000 },
    manager: { port: 7788 },
  });
  await flush();
  assert.equal(notice.hidden, true, '目标改回实际监听端口后提示应自动消失');

  es().send('config-changed', {
    revision: 4,
    defaults: { ...DEFAULTS, remoteWebPort: 9000 },
    manager: { port: 7799 },
  });
  assert.equal(notice.hidden, false);
  es().send('snapshot', {
    revision: 5,
    manager: { ...MANAGER_INFO, port: 7799, pid: 4343 },
    defaults: { ...DEFAULTS, remoteWebPort: 9000 },
    hosts: [hostView('gpu-1'), hostView('gpu-2')],
    logs: [],
  });
  await flush();
  assert.equal(app.store.state.manager.configuredPort, 7799, '重连快照不得擦掉已知配置端口');
  assert.equal(app.store.state.manager.info.port, 7799);
  assert.equal(notice.hidden, true, 'manager 真正在目标端口重启后提示应自动清除');
  assert.match(dom.app.querySelector('.manager-card').textContent, /监听端口7799/);
});

test('全局默认：断线与重同步期间草稿可编辑、不可保存但可还原', async (t) => {
  const { dom, es } = await mount(t);
  es().open();
  es().send('snapshot', {
    revision: 2,
    manager: MANAGER_INFO,
    defaults: DEFAULTS,
    hosts: [hostView('gpu-1')],
    logs: [],
  });
  const {
    remote, managerPort, from, to, save, reset,
  } = defaultsControls(dom);

  for (const fn of es().listeners.get('error')) fn({});
  remote.value = '9001';
  remote.dispatchEvent({ type: 'change' });
  assert.equal(remote.value, '9001');
  assert.equal(save.disabled, true, '断线时不能保存');
  assert.equal(reset.disabled, false, '断线不应锁住本地还原');
  assert.equal([remote, managerPort, from, to].some((node) => node.disabled), false,
    '只有保存 pending 才能锁输入');

  es().open();
  managerPort.value = '7799';
  managerPort.dispatchEvent({ type: 'input' });
  assert.equal(managerPort.value, '7799', 'resyncing 期间仍应允许继续编辑');
  assert.equal(save.disabled, true);
  assert.equal(reset.disabled, false);

  reset.click();
  assert.equal(remote.value, String(DEFAULTS.remoteWebPort));
  assert.equal(managerPort.value, String(MANAGER_INFO.port));
  assert.equal(save.disabled, true);
  assert.equal(reset.disabled, true);
});

test('全局默认：外部更新保留同字段草稿、跟随未改字段，还原载入最新值', async (t) => {
  const { dom, es } = await mount(t);
  const {
    remote, managerPort, from, to, save, reset, notice,
  } = defaultsControls(dom);

  remote.value = '9001';
  remote.dispatchEvent({ type: 'input' });
  es().send('config-changed', {
    revision: 2,
    defaults: { remoteWebPort: 9002, localPortRange: [18_001, 18_099] },
    manager: { port: 7799 },
  });
  await flush();

  assert.equal(remote.value, '9001', '同字段外部更新不能覆盖用户草稿');
  assert.equal(managerPort.value, '7799');
  assert.equal(from.value, '18001');
  assert.equal(to.value, '18099');
  assert.equal(notice.hidden, false);
  assert.match(notice.textContent, /配置已变化/);
  assert.match(notice.textContent, /草稿已保留/);
  assert.equal(save.disabled, false);
  assert.equal(reset.disabled, false);

  reset.click();
  assert.equal(remote.value, '9002');
  assert.equal(managerPort.value, '7799');
  assert.equal(from.value, '18001');
  assert.equal(to.value, '18099');
  assert.equal(notice.hidden, false, '冲突清除后仍应保留配置端口与运行端口不一致的事实');
  assert.doesNotMatch(notice.textContent, /草稿已保留/);
  assert.match(notice.textContent, /7799.*重启 manager 后生效/);
  assert.equal(save.disabled, true);
  assert.equal(reset.disabled, true);
});

test('全局默认：保存按最新 baseline diff，不回滚外部未编辑字段并清冲突', async (t) => {
  const latestDefaults = { remoteWebPort: 9001, localPortRange: [18_001, 18_099] };
  const reply = (body) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
  const { dom, calls, es } = await mount(t, {
    responder: ({ path, method }) => (path === '/api/config/defaults' && method === 'PUT'
      ? reply({
        defaults: latestDefaults,
        manager: { port: 7799 },
        restartRequired: false,
      })
      : null),
  });
  const {
    remote, managerPort, from, to, save, reset, notice,
  } = defaultsControls(dom);

  remote.value = '9001';
  remote.dispatchEvent({ type: 'input' });
  es().send('config-changed', {
    revision: 2,
    defaults: { remoteWebPort: 9002, localPortRange: [18_001, 18_099] },
    manager: { port: 7799 },
  });
  await flush();
  assert.equal(notice.hidden, false, '前提：远端与本地同时改了 remoteWebPort');

  save.click();
  await flush();

  const put = calls.find((call) => call.path === '/api/config/defaults' && call.method === 'PUT');
  assert.deepEqual(put.body, { remoteWebPort: 9001 });
  assert.deepEqual(
    [remote.value, managerPort.value, from.value, to.value],
    ['9001', '7799', '18001', '18099'],
  );
  assert.equal(notice.hidden, false, '本次响应虽无需重启，既存配置端口差异仍不能被擦掉');
  assert.doesNotMatch(notice.textContent, /草稿已保留/);
  assert.match(notice.textContent, /7799.*重启 manager 后生效/);
  assert.equal(save.disabled, true);
  assert.equal(reset.disabled, true);
});

test('全局默认：归一化后无有效 diff 时零 PUT 并回填 canonical', async (t) => {
  const { app, dom, calls } = await mount(t);
  const {
    remote, save, reset,
  } = defaultsControls(dom);

  remote.value = '08899';
  remote.dispatchEvent({ type: 'input' });
  assert.equal(save.disabled, false, 'raw 草稿有变化时应允许点击保存做归一化');

  save.click();
  await flush();

  assert.equal(calls.some((call) => call.path === '/api/config/defaults' && call.method === 'PUT'), false);
  assert.equal(remote.value, '8899');
  assert.equal(save.disabled, true);
  assert.equal(reset.disabled, true);
  assert.equal(app.store.state.toasts.at(-1).level, 'info');
  assert.match(app.store.state.toasts.at(-1).summary, /没有需要保存的有效变更/);
});

test('全局默认：倒置区间不提交，逐字段报错', async (t) => {
  const { dom, calls } = await mount(t);
  const {
    card, remote, managerPort, from, to,
  } = defaultsControls(dom);
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

test('全局默认：低于 1024 的本机端口区间就地报错', async (t) => {
  const { dom, calls } = await mount(t);
  const {
    card, from, save,
  } = defaultsControls(dom);

  from.value = '1023';
  from.dispatchEvent({ type: 'input' });
  save.click();
  await flush();

  assert.equal(calls.some((call) => call.path === '/api/config/defaults' && call.method === 'PUT'), false);
  const errors = card.querySelectorAll('.field-error').map((node) => node.textContent).filter(Boolean);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /1024/);
});

test('setup 未完成：强制跳向导，先不拉主机清单', async (t) => {
  const { app, dom, calls, es } = await mount(t, {
    responder: ({ path }) => {
      if (path === '/api/manager/info') {
        return { ok: true, status: 200, text: async () => JSON.stringify({ ...MANAGER_INFO, setupCompleted: false }) };
      }
      if (path === '/api/config') {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            configVersion: 1,
            setupCompleted: false,
            manager: { port: 7799 },
            defaults: DEFAULTS,
            hosts: {},
          }),
        };
      }
      return null;
    },
  });

  assert.equal(dom.window.location.hash, '#/setup');
  assert.equal(calls.some((c) => c.path === '/api/hosts'), false, '主机清单等向导走到第 3 步再拉');
  assert.equal(app.store.state.manager.info.port, 7788);
  assert.equal(app.store.state.manager.configuredPort, 7799, 'setup 路径的 config GET 也必须写配置端口');
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
