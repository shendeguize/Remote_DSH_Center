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

test('首屏：拉 info/hosts/config，渲染主机表与 manager 卡', async (t) => {
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
  assert.deepEqual(tabs.map((tb) => tb.textContent.trim()), ['gpu-1'], '只有 running 主机进标签栏');

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

test('路由到 running 主机：创建 iframe，回管理台只改显隐（keep-alive）', async (t) => {
  const { dom, es } = await mount(t);
  es().open();
  es().send('snapshot', { revision: 1, manager: MANAGER_INFO, defaults: DEFAULTS, hosts: [running('gpu-1')], logs: [] });

  dom.window.location.hash = '#/host/gpu-1';
  const frame = dom.app.querySelector('.iframe-pane iframe');
  assert.ok(frame, '应创建 iframe');
  assert.equal(frame.getAttribute('src'), 'http://127.0.0.1:17701/');
  assert.equal(dom.app.querySelector('.view-dashboard').hidden, true);

  dom.window.location.hash = '#/';
  const same = dom.app.querySelector('.iframe-pane iframe');
  assert.equal(same, frame, '切回管理台不能销毁 iframe');
  assert.equal(dom.app.querySelector('.iframe-pane[data-host="gpu-1"]').hidden, true);
  assert.equal(dom.app.querySelector('.view-dashboard').hidden, false);
});

test('深链到不可打开的主机：不造 iframe，给可返回的提示', async (t) => {
  const { dom, es } = await mount(t);
  es().open();
  es().send('snapshot', { revision: 1, manager: MANAGER_INFO, defaults: DEFAULTS, hosts: [hostView('gpu-1')], logs: [] });

  dom.window.location.hash = '#/host/gpu-1';
  assert.equal(dom.app.querySelector('.iframe-pane iframe'), null);
  const fallback = dom.app.querySelector('.view-fallback');
  assert.equal(fallback.hidden, false);
  assert.match(fallback.textContent, /可拉起/);
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
