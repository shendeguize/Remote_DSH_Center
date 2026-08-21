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

/**
 * 回归（真机 v0.2.0-rc.3 暴露，issue #15）：首屏就带 host 路由时——书签、刷新、
 * `dshc open <host>` 都走这条——主机数据还没到，tabbar 把「尚未同步」当成
 * 「标签已消失」，直接把地址改回 `#/`，于是深链永远落在管理台。
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
  assert.equal(dom.window.location.hash, '#/host/gpu-1', '主机还没同步就被踢回管理台');

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

test('主机真的从状态里消失（不是尚未同步）→ 仍回管理台', async (t) => {
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
  assert.equal(dom.window.location.hash, '#/', '标签真消失了才该回管理台');
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
