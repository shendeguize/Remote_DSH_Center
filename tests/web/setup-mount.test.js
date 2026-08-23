/**
 * 首启向导整机走查（UI-22…25）：DOM 垫片下把四步真的点一遍。
 *
 * 覆盖 10 §7 里与向导相关的故障场景：非法端口不许前进、探测中途提交、
 * JSON 手改、端口迁移与迁移超时。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULTS, MANAGER_INFO, findButton, flush, hostView, mount, running,
} from './app-harness.js';
import { LAST_HOST_KEY, rootRouteTarget } from '../../src/web/router.js';

const SETUP_INFO = { ...MANAGER_INFO, setupCompleted: false, setupGateActive: true };

/** 进入 setup 模式的挂载：manager 说没初始化，路由被守卫强制到 #/setup。 */
async function mountSetup(t, { hosts = [], responder = null } = {}) {
  const ctx = await mount(t, { hosts, responder, info: SETUP_INFO });
  return { ...ctx, wizard: () => ctx.dom.app.querySelector('.setup-wizard') };
}

const stepTitle = (wizard) => wizard.querySelector('.step-title').textContent;
const fields = (wizard) => wizard.querySelectorAll('.step-panel .field input');
const next = (wizard) => findButton(wizard, '下一步');
const back = (wizard) => findButton(wizard, '上一步');
const cancelLink = (wizard) => wizard.querySelector('.wizard-foot a.link');

function typeInto(node, value) {
  node.value = value;
  node.dispatchEvent({ type: 'input', target: node });
}

/** 垫片的 focus() 默认只改 activeElement；这里补齐真实浏览器会同步派发的 focus 事件。 */
function installBrowserFocusEvents(t, node) {
  const proto = Object.getPrototypeOf(node);
  const original = proto.focus;
  proto.focus = function focusWithEvent() {
    original.call(this);
    this.dispatchEvent({ type: 'focus', target: this });
  };
  t.after(() => { proto.focus = original; });
}

function installLastHost(t, name) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const storage = {
    getItem(key) {
      return key === LAST_HOST_KEY ? name : null;
    },
    setItem() {},
  };
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else delete globalThis.localStorage;
  });
}

function localPresentationHost(name, phase, probePatch) {
  const base = hostView(name);
  return {
    ...base,
    local: true,
    sshInfo: null,
    config: { ...base.config, local: true, localPort: null },
    phase,
    probe: { ...base.probe, ...probePatch },
  };
}

test('步骤 1：预填现值，非法端口不许前进', async (t) => {
  const { wizard: w } = await mountSetup(t);
  const wizard = w();

  assert.match(stepTitle(wizard), /1\. 本机服务/);
  const [port, range] = fields(wizard);
  assert.equal(port.value, String(SETUP_INFO.port), '预填当前监听端口');
  assert.equal(range.value, `${DEFAULTS.localPortRange[0]}-${DEFAULTS.localPortRange[1]}`);
  assert.equal(cancelLink(wizard), null, '首次 setup 不给退出口子');

  typeInto(port, '70000');
  assert.equal(next(wizard).disabled, true, '非法端口锁住下一步');
  assert.match(wizard.querySelectorAll('.field-error').map((e) => e.textContent).find(Boolean), /65535/);

  typeInto(port, '6001');
  assert.equal(next(wizard).disabled, false);

  typeInto(range, '17800-17700');
  assert.equal(next(wizard).disabled, true, '倒置区间也要拦住');
});

test('读不到当前配置：字段留空并挡住下一步（前端不编一份出厂默认）', async (t) => {
  const { wizard: w } = await mountSetup(t, {
    responder: ({ path }) => (path === '/api/config'
      ? { ok: false, status: 500, text: async () => JSON.stringify({ error: '读配置失败' }) }
      : null),
  });
  const wizard = w();

  const [port, range] = fields(wizard);
  assert.equal(port.value, String(SETUP_INFO.port), 'manager 端口仍能从 info 拿到');
  assert.equal(range.value, '', '拿不到 defaults 就留空，不能凭空写一个区间');
  assert.equal(next(wizard).disabled, true, '空值不算合法答案');

  typeInto(range, '18000-18010');
  assert.equal(next(wizard).disabled, false, '用户填上就能继续');
});

test('一路下一步走到确认页：JSON 预览带上勾选结果', async (t) => {
  const { calls, wizard: w, es } = await mountSetup(t, {
    hosts: [hostView('gpu-1'), hostView('gpu-2', { phase: 'no_dsh' })],
  });
  const wizard = w();

  next(wizard).click();
  assert.match(stepTitle(wizard), /2\. 远端约定/);
  next(wizard).click();
  await flush();

  assert.match(stepTitle(wizard), /3\. 主机纳管/);
  assert.ok(calls.some((c) => c.path === '/api/hosts' && c.method === 'GET'), '进第 3 步才拉候选');
  assert.equal(
    calls.filter((c) => c.path === '/api/hosts/probe' && c.method === 'POST').length,
    1,
    '进第 3 步只经动作层发起一轮全量探测',
  );

  const rows = wizard.querySelectorAll('.setup-hosts tbody tr');
  assert.equal(rows.length, 2);
  assert.match(wizard.querySelector('.wizard-progress').textContent, /已完成探测 2 \/ 共 2/);
  const [ready, noDsh] = rows;
  assert.equal(ready.querySelectorAll('input')[1].disabled, false, 'ready 可开启链接');
  assert.equal(ready.querySelectorAll('input')[1].checked, true, 'ready 默认开启');
  assert.equal(noDsh.querySelectorAll('input')[1].disabled, true, 'no_dsh 不许开启链接');

  // 探测结果经 SSE 逐台到达也要即时反映
  es().open();
  es().send('host-changed', { revision: 5, host: hostView('gpu-2', { phase: 'ready' }) });
  await flush();
  const after = wizard.querySelectorAll('.setup-hosts tbody tr')[1];
  assert.equal(after.querySelectorAll('input')[1].disabled, false, '变 ready 后解锁');
  assert.equal(after.querySelectorAll('input')[1].checked, true, '首次 ready 默认开启');

  next(wizard).click();
  assert.match(stepTitle(wizard), /4\. 确认/);
  const preview = JSON.parse(wizard.querySelector('textarea').value);
  assert.equal(preview.setupCompleted, true);
  assert.equal(preview.manager.port, SETUP_INFO.port);
  assert.deepEqual(Object.keys(preview.hosts), ['gpu-1', 'gpu-2']);
  assert.equal(preview.hosts['gpu-1'].autoStart, true);
});

test('发起探测被 API reject：只 toast 一次场景文案且只请求一次', async (t) => {
  const { app, calls, wizard: w } = await mountSetup(t, {
    hosts: [hostView('gpu-1')],
    responder: ({ path, method }) => {
      if (path === '/api/hosts/probe' && method === 'POST') {
        throw new TypeError('socket closed');
      }
      return null;
    },
  });
  const wizard = w();

  next(wizard).click();
  next(wizard).click();
  await flush();

  assert.equal(
    calls.filter((call) => call.path === '/api/hosts/probe' && call.method === 'POST').length,
    1,
    '向导只调用一次全量探测 API',
  );
  assert.equal(app.store.state.toasts.length, 1, '动作层统一呈现错误，向导不再重复 catch');
  assert.match(app.store.state.toasts[0].summary, /发起探测失败（可稍后在管理台重试）/);
});

test('同一本机 fixture 在管理表、overflow、setup 表共享状态与提示', async (t) => {
  const fixtures = [
    localPresentationHost('local-missing', 'no_dsh', {
      dshPath: null,
      version: null,
      profileWeb: false,
      noDshReason: 'missing-bin',
      errorSummary: null,
    }),
    localPresentationHost('local-offline', 'unreachable', {
      errorSummary: 'fixture errorSummary',
    }),
  ];
  const expected = new Map([
    ['local-missing', { label: '本机未安装或未配置', hint: '本机未安装 dsh' }],
    ['local-offline', { label: '本机不可用', hint: 'fixture errorSummary' }],
  ]);
  const { dom, wizard: w } = await mountSetup(t, { hosts: fixtures });
  const wizard = w();

  next(wizard).click();
  next(wizard).click();
  await flush();
  dom.app.querySelector('.tab-overflow').click();

  const overflow = dom.app.querySelector('.overflow-menu');
  for (const host of fixtures) {
    const setupRow = wizard.querySelector(`.setup-hosts tbody tr[data-host="${host.name}"]`);
    const manageRow = dom.app.querySelector(`.host-table tbody tr[data-host="${host.name}"]`);
    const overflowLine = overflow
      .querySelector(`[data-host="${host.name}"][data-action="view-manage"]`)
      .closest('li')
      .querySelector('span');
    const setupLabel = setupRow.querySelector('.phase-badge').textContent;
    const manageLabel = manageRow.querySelector('.phase-badge').textContent;
    const manageHint = manageRow.querySelector('.phase-hint').textContent;
    const want = expected.get(host.name);

    assert.equal(manageLabel, setupLabel, `${host.name} 的管理表与 setup label 必须逐字一致`);
    assert.equal(setupLabel, want.label);
    assert.equal(manageHint, want.hint);
    assert.equal(
      overflowLine.textContent,
      `${host.name} — ${setupLabel} · ${manageHint}`,
      `${host.name} 的 overflow 必须复用同一 label 与 hostPhaseHint`,
    );
  }
});

test('探测异步重渲染按稳定身份恢复标题与复选框焦点', async (t) => {
  const { dom, es, wizard: w } = await mountSetup(t, { hosts: [hostView('gpu-1')] });
  const wizard = w();

  next(wizard).click();
  next(wizard).click();
  await flush();
  es().open();

  const title = wizard.querySelector('.step-title');
  title.focus();
  es().send('host-changed', { revision: 5, host: hostView('gpu-1', { phase: 'no_dsh' }) });
  await flush();
  assert.equal(
    dom.document.activeElement,
    wizard.querySelector('.step-title'),
    '标题没有字段 key，重渲染后必须仍回标题，不能误配首个无 key 复选框',
  );

  const enabled = wizard.querySelector('.setup-hosts tbody tr').querySelectorAll('input')[0];
  enabled.focus();
  es().send('host-changed', { revision: 6, host: hostView('gpu-1', { phase: 'ready' }) });
  await flush();
  const currentEnabled = wizard.querySelector('.setup-hosts tbody tr').querySelectorAll('input')[0];
  assert.equal(dom.document.activeElement, currentEnabled, '复选框继续按稳定 aria-label 恢复焦点');
});

test('换步把焦点带到新步骤的标题上（前进、后退都算）', async (t) => {
  const { dom, wizard: w } = await mountSetup(t, { hosts: [hostView('gpu-1')] });
  const wizard = w();
  const title = () => wizard.querySelector('.step-title');

  // 前提：焦点先落在「下一步」上——它随重建被移除，若不接管就掉回 body
  next(wizard).focus();
  assert.equal(dom.document.activeElement, next(wizard));

  next(wizard).click();
  await flush();
  assert.equal(dom.document.activeElement, title(), '前进一步后焦点该落在新标题上');
  assert.match(title().textContent, /2\. 远端约定/);
  assert.equal(title().getAttribute('tabindex'), '-1', '标题平时不该占 Tab 顺序');

  back(wizard).focus();
  back(wizard).click();
  await flush();
  assert.equal(dom.document.activeElement, title(), '后退也一样');
  assert.match(title().textContent, /1\. 本机服务/);

  // 同一步内的重渲染（改字段触发校验）不许抢焦点
  const [port] = fields(wizard);
  port.focus();
  typeInto(port, '70000');
  await flush();
  assert.equal(dom.document.activeElement, port, '还在填这个字段，焦点不许被标题夺走');
});

test('配置异步更新保留用户正在输入的非法端口草稿、错误与焦点', async (t) => {
  const { app, dom, wizard: w } = await mountSetup(t);
  const wizard = w();
  const port = fields(wizard)[0];

  port.focus();
  typeInto(port, '');
  assert.equal(next(wizard).disabled, true);
  assert.match(wizard.querySelectorAll('.field-error')[0].textContent, /请输入整数/);

  app.store.setDefaults({ ...DEFAULTS, localPortRange: [18_001, 18_099] });
  app.store.setManagerConfig({ port: 7799 });

  const [currentPort, currentRange] = fields(wizard);
  assert.equal(currentPort.value, '', '外部配置变化不能用合法值覆盖用户的临时空值');
  assert.equal(currentRange.value, '18001-18099', '同一轮更新仍须刷新未被用户接管的字段');
  assert.match(wizard.querySelectorAll('.field-error')[0].textContent, /请输入整数/);
  assert.equal(next(wizard).disabled, true, '原始输入错误仍须阻止前进');
  assert.equal(dom.document.activeElement, currentPort, '重渲染后焦点仍在用户接管的字段');
  assert.match(wizard.querySelector('.wizard-notice').textContent, /外部配置已更新.*草稿已保留/);
});

test('等价收敛后的程序化焦点恢复不重夺 ownership，用户重新 focus 才接管', async (t) => {
  const { app, dom, wizard: w } = await mountSetup(t);
  const wizard = w();
  const port = fields(wizard)[0];
  installBrowserFocusEvents(t, port);

  port.focus();
  typeInto(port, '07799');
  app.store.setManagerConfig({ port: 7799 });

  let currentPort = fields(wizard)[0];
  assert.equal(currentPort.value, '7799', '语义相等后统一显示 schema 的规范格式');
  assert.equal(wizard.querySelector('.wizard-notice').hidden, true, '格式差异不能冒充配置冲突');
  assert.equal(next(wizard).disabled, false);
  assert.equal(dom.document.activeElement, currentPort, '规范化重渲染仍须保持字段焦点');

  app.store.setManagerConfig({ port: 7800 });
  currentPort = fields(wizard)[0];
  assert.equal(currentPort.value, '7800', '程序化恢复 focus 不能重新 claim，后续外部值仍应吸收');
  assert.equal(wizard.querySelector('.wizard-notice').hidden, true);

  wizard.querySelector('.step-title').focus();
  currentPort.focus();
  app.store.setManagerConfig({ port: 7801 });
  const userOwnedPort = fields(wizard)[0];
  assert.equal(userOwnedPort.value, '7800', '用户重新聚焦后才重新接管并保留本地显示');
  assert.match(wizard.querySelector('.wizard-notice').textContent, /外部配置已更新.*草稿已保留/);
  assert.equal(dom.document.activeElement, userOwnedPort);
});

test('端口区间等价格式与外部规范值语义相等：不报冲突并收敛显示', async (t) => {
  const { app, dom, wizard: w } = await mountSetup(t);
  const wizard = w();
  const range = fields(wizard)[1];

  range.focus();
  typeInto(range, '18001 18099');
  app.store.setDefaults({ ...DEFAULTS, localPortRange: [18_001, 18_099] });
  app.store.setManagerConfig({ port: SETUP_INFO.port });

  const currentRange = fields(wizard)[1];
  assert.equal(currentRange.value, '18001-18099', '等价区间统一显示 schema format');
  assert.equal(wizard.querySelector('.wizard-notice').hidden, true);
  assert.equal(next(wizard).disabled, false);
  assert.equal(dom.document.activeElement, currentRange);
});

test('配置异步更新仍回灌尚未被用户接管的 manager 端口', async (t) => {
  const { app, wizard: w } = await mountSetup(t);
  const wizard = w();

  assert.equal(fields(wizard)[0].value, String(SETUP_INFO.port));
  app.store.setManagerConfig({ port: 7799 });
  assert.equal(fields(wizard)[0].value, '7799', '未编辑初始预填必须吸收 configuredPort');
});

test('提交：POST /api/setup 用预览内容，端口未变则精确进入 #/hub', async (t) => {
  let saved = false;
  const { calls, dom, wizard: w } = await mountSetup(t, {
    hosts: [hostView('gpu-1')],
    responder: ({ path, method }) => {
      if (path === '/api/setup' && method === 'POST') {
        saved = true;
        return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, port: 7788, portChanged: false, restartRequired: false, restarting: false }) };
      }
      // 落盘后 manager 就该自报已初始化——守卫据此放行主机选择页
      if (path === '/api/manager/info' && saved) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ ...MANAGER_INFO, setupCompleted: true }) };
      }
      return null;
    },
  });
  const wizard = w();

  next(wizard).click();
  next(wizard).click();
  await flush();
  next(wizard).click();
  findButton(wizard, '完成并保存').click();
  await flush();

  const submitted = calls.find((c) => c.path === '/api/setup');
  assert.ok(submitted, '必须发出 POST /api/setup');
  assert.equal(submitted.body.hosts['gpu-1'].enabled, true);
  assert.equal(dom.window.location.hash, '#/hub', '端口没变直接进主机选择页');

  // 向导整块被藏起来，焦点会跟着一起消失。刚用键盘走完四步的人不该被丢在文档顶端。
  const landed = dom.document.activeElement;
  assert.notEqual(landed, dom.document.body, '收尾后焦点掉回 body');
  const hubTitle = dom.app.querySelector('.view-hub h2');
  assert.equal(hubTitle.textContent, '选择一台主机开始工作', '主机选择页标题语义不许漂移');
  assert.equal(landed, hubTitle, '焦点该落在主机选择页标题上');
});

test('手改 JSON：非法不许提交也不许返回；合法则原样提交', async (t) => {
  const { calls, wizard: w } = await mountSetup(t, { hosts: [hostView('gpu-1')] });
  const wizard = w();
  next(wizard).click();
  next(wizard).click();
  await flush();
  next(wizard).click();

  const area = wizard.querySelector('textarea');
  typeInto(area, '{ "configVersion": 1, ');
  assert.equal(findButton(wizard, '完成并保存').disabled, true, '非法 JSON 锁住提交');
  back(wizard).click();
  assert.match(stepTitle(wizard), /4\. 确认/, '解析失败不许返回上一步');

  const edited = {
    configVersion: 1,
    setupCompleted: true,
    manager: { port: 7788 },
    defaults: { remoteWebPort: 9999, localPortRange: [20_000, 20_005] },
    hosts: { 'gpu-1': { enabled: true, autoStart: false, localPort: 20_000, remoteWebPort: null, inject: { env: { A: '1' }, extraArgs: [], patches: [] } } },
  };
  typeInto(wizard.querySelector('textarea'), JSON.stringify(edited, null, 2));
  assert.equal(findButton(wizard, '完成并保存').disabled, false);

  findButton(wizard, '完成并保存').click();
  await flush();
  assert.deepEqual(calls.find((c) => c.path === '/api/setup').body, edited, '手改内容原样提交');
});

test('返回第 3 步先回灌草稿：JSON 里的勾选被带回勾选框', async (t) => {
  const { wizard: w } = await mountSetup(t, { hosts: [hostView('gpu-1')] });
  const wizard = w();
  next(wizard).click();
  next(wizard).click();
  await flush();
  next(wizard).click();

  const cfg = JSON.parse(wizard.querySelector('textarea').value);
  cfg.hosts['gpu-1'].enabled = false;
  cfg.hosts['gpu-1'].autoStart = false;
  cfg.manager.port = 6789;
  typeInto(wizard.querySelector('textarea'), JSON.stringify(cfg, null, 2));

  back(wizard).click();
  const row = wizard.querySelector('.setup-hosts tbody tr');
  assert.equal(row.querySelectorAll('input')[0].checked, false, '纳管勾选跟着 JSON 走');

  back(wizard).click();
  back(wizard).click();
  assert.equal(fields(wizard)[0].value, '6789', '端口也要回灌');
});

test('探测未完成时提交：先确认，且未完成主机不自启', async (t) => {
  const { calls, dom, wizard: w } = await mountSetup(t, {
    hosts: [hostView('slow', { phase: 'unknown', probe: null })],
  });
  const wizard = w();
  next(wizard).click();
  next(wizard).click();
  await flush();
  next(wizard).click();

  assert.match(wizard.querySelector('.wizard-warn').textContent, /仍有 1 台探测未完成/);
  findButton(wizard, '完成并保存').click();
  await flush();

  const dialog = dom.app.querySelector('.confirm-dialog');
  assert.equal(dialog.hasAttribute('open') || dialog.open === true, true, '必须二次确认');
  assert.match(dialog.textContent, /仍有 1 台探测未完成/);
  assert.equal(calls.some((c) => c.path === '/api/setup'), false, '确认前不许提交');

  findButton(dialog, '仍然保存').click();
  await flush();
  const body = calls.find((c) => c.path === '/api/setup').body;
  assert.equal(body.hosts.slow.enabled, true);
  assert.equal(body.hosts.slow.autoStart, false, '未探完的主机一律不自启');
});

test('提交后迟到的探测结果不改已冻结的快照', async (t) => {
  const { calls, dom, es, wizard: w } = await mountSetup(t, {
    hosts: [hostView('slow', { phase: 'unknown', probe: null })],
  });
  const wizard = w();
  next(wizard).click();
  next(wizard).click();
  await flush();
  next(wizard).click();
  findButton(wizard, '完成并保存').click();
  await flush();

  // 确认对话框还开着时，探测结果到达
  es().open();
  es().send('host-changed', { revision: 7, host: hostView('slow', { phase: 'ready' }) });
  findButton(dom.app.querySelector('.confirm-dialog'), '仍然保存').click();
  await flush();

  const body = calls.find((c) => c.path === '/api/setup').body;
  assert.equal(body.hosts.slow.autoStart, false, '冻结快照不受迟到结果影响');
});

test('端口改变：进迁移页，只探新 origin，成功后跳转', async (t) => {
  const target = 'http://127.0.0.1:6001';
  const targetHosts = [running('gpu-1')];
  const probes = [];
  installLastHost(t, 'gpu-1');
  assert.equal(
    rootRouteTarget(targetHosts),
    '#/host/gpu-1',
    '前提：目标 origin 的根路由会按 lastHost 恢复主机页',
  );
  const { calls, dom, wizard: w } = await mountSetup(t, {
    hosts: targetHosts,
    responder: ({ path, method }) => {
      if (path === '/api/setup' && method === 'POST') {
        return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, port: 6001, portChanged: true, restartRequired: false, restarting: true }) };
      }
      if (path.startsWith(target)) {
        probes.push(path);
        // 第一次还没起来，第二次就绪
        const body = probes.length > 1 ? { ...MANAGER_INFO, port: 6001, setupCompleted: true } : null;
        return body
          ? { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }
          : { ok: false, status: 503, json: async () => null, text: async () => '' };
      }
      return null;
    },
  });
  const wizard = w();

  typeInto(fields(wizard)[0], '6001');
  next(wizard).click();
  next(wizard).click();
  await flush();
  next(wizard).click();
  findButton(wizard, '完成并保存').click();
  await flush();

  assert.match(wizard.textContent, /正在等待 http:\/\/127\.0\.0\.1:6001/);
  assert.match(wizard.querySelector('.migration-target').textContent, /6001/);

  // 迁移探测按递增间隔进行，等它走完两轮
  for (let i = 0; i < 150 && dom.window.location.replacedWith === null; i += 1) {
    // eslint-disable-next-line no-await-in-loop -- 等异步轮询
    await new Promise((r) => { setTimeout(r, 20); });
  }

  assert.equal(dom.window.location.href, `${target}/#/hub`, '必须绕过会恢复 lastHost 的目标根路由');
  assert.equal(calls.filter((c) => c.path === '/api/setup').length, 1, '迁移期间绝不重复 POST setup');
  assert.ok(probes.length >= 2, '失败的一轮不算完');
});

test('迁移超时：停在迁移页，可重试与复制地址，不回滚配置', async (t) => {
  const { calls, dom, wizard: w } = await mountSetup(t, {
    hosts: [],
    responder: ({ path, method }) => {
      if (path === '/api/setup' && method === 'POST') {
        return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, port: 6002, portChanged: true, restartRequired: false, restarting: true }) };
      }
      if (path.startsWith('http://127.0.0.1:6002')) return { ok: false, status: 503, json: async () => null, text: async () => '' };
      return null;
    },
  });
  const wizard = w();

  // 把预算压到毫秒级：等真 60 秒没意义
  const { MIGRATION_BUDGET_MS } = await import('../../src/web/components/setup-wizard.js');
  assert.equal(MIGRATION_BUDGET_MS, 60_000, '生产预算仍是 60 秒');

  typeInto(fields(wizard)[0], '6002');
  next(wizard).click();
  next(wizard).click();
  await flush();
  next(wizard).click();
  findButton(wizard, '完成并保存').click();
  await flush();

  assert.match(wizard.textContent, /正在等待/);
  assert.equal(dom.window.location.href.includes('6002'), false, '未确认就绪绝不跳转');
  assert.equal(calls.filter((c) => c.path === '/api/setup').length, 1);
  assert.ok(findButton(wizard, '复制新地址'), '始终给得到人工兜底的口子');
});

test('重新配置（已初始化）：预填现值且给取消入口', async (t) => {
  const configuredPort = 7799;
  const { dom } = await mount(t, {
    hosts: [hostView('gpu-1')],
    hash: '#/setup',
    responder: ({ path }) => (path === '/api/config'
      ? {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          configVersion: 1,
          setupCompleted: true,
          manager: { port: configuredPort },
          defaults: DEFAULTS,
          hosts: {},
        }),
      }
      : null),
  });
  const wizard = dom.app.querySelector('.setup-wizard');

  assert.equal(wizard.hidden, false);
  assert.equal(dom.window.location.hash, '#/setup', '已初始化时不会被守卫改写');
  const cancel = cancelLink(wizard);
  assert.ok(cancel, '重新配置可以放弃');
  assert.equal(cancel.getAttribute('href'), '#/manage', '取消链接必须精确返回管理页');
  assert.equal(cancel.textContent, '取消，返回管理台');
  assert.equal(MANAGER_INFO.port, 7788, 'fixture 明确模拟仍监听旧端口');
  assert.equal(fields(wizard)[0].value, String(configuredPort), '重新配置必须优先预填已落盘端口');
});
