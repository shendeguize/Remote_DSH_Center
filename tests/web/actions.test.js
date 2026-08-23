/**
 * 动作层单测（10 §4.5 / UI-09）：用假 fetch 覆盖 202 结算、错误 detail、
 * 冲突动作去重、断线禁写、手动实例保护。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createActions } from '../../src/web/actions.js';
import { createStore } from '../../src/web/store.js';

function res(status, body, { text = null } = {}) {
  const payload = text ?? (body === undefined ? '' : JSON.stringify(body));
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => payload,
  };
}

function harness(t, { responder, confirmAnswer = true } = {}) {
  const calls = [];
  const navigated = [];
  const confirms = [];

  const original = globalThis.fetch;
  globalThis.fetch = async (path, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ path, method: init.method ?? 'GET', body });
    return responder({ path, method: init.method ?? 'GET', body });
  };
  t.after(() => {
    globalThis.fetch = original;
  });

  const store = createStore();
  store.setConnection({ sse: 'open' });
  const actions = createActions({
    store,
    confirm: async (opts) => {
      confirms.push(opts);
      return confirmAnswer;
    },
    navigate: (to) => navigated.push(to),
  });
  return { store, actions, calls, navigated, confirms };
}

const hostView = (patch = {}) => ({
  name: 'gpu-1',
  enabled: true,
  orphaned: false,
  config: { enabled: true, autoStart: false, localPort: 17_701, remoteWebPort: null, inject: { env: {}, extraArgs: [], patches: [] } },
  phase: 'ready',
  effectiveRemotePort: 8899,
  mappedUrl: null,
  probe: null,
  web: null,
  tunnel: null,
  manualInstances: [],
  sshInfo: { user: 'me', hostName: '10.0.0.1', port: 22 },
  ...patch,
});

function seed(store, patch = {}) {
  store.applySnapshot({ revision: 1, hosts: [hostView(patch)], logs: [] });
}

test('start：202 后按钮持续 loading，直到 running 才解锁', async (t) => {
  const h = harness(t, { responder: () => res(202, { accepted: true, operationId: 'op-1' }) });
  seed(h.store);

  await h.actions.hostAction('start', 'gpu-1');
  assert.equal(h.calls[0].method, 'POST');
  assert.equal(h.calls[0].path, '/api/hosts/gpu-1/start');
  assert.equal(h.store.isPending('start', 'gpu-1'), true);
  assert.equal(h.store.getHost('gpu-1').phase, 'ready', '动作层不擅改 phase');

  h.store.applyHostChanged({ revision: 2, host: hostView({ phase: 'starting' }) });
  assert.equal(h.store.isPending('start', 'gpu-1'), true);

  h.store.applyHostChanged({ revision: 3, host: hostView({ phase: 'running' }) });
  assert.equal(h.store.isPending('start', 'gpu-1'), false);
});

test('202 动作迟迟无回执：超时释放 pending 并提示状态未确认', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness(t, { responder: () => res(202, { accepted: true, operationId: 'op-timeout' }) });
  seed(h.store);

  await h.actions.hostAction('start', 'gpu-1');
  assert.equal(h.calls.length, 1);
  assert.equal(h.store.isPending('start', 'gpu-1'), true);

  t.mock.timers.tick(30_000);
  assert.equal(h.store.isPending('start', 'gpu-1'), false, '未回执不能让按钮永久 loading');
  const toast = h.store.state.toasts.at(-1);
  assert.equal(toast.level, 'warn');
  assert.match(toast.summary, /gpu-1 start 结果未确认.*30s/);
  assert.match(toast.detail, /manager 侧可能仍在执行/);
});

test('同主机冲突动作不重复提交', async (t) => {
  const h = harness(t, { responder: () => res(202, { accepted: true, operationId: 'op-1' }) });
  seed(h.store);

  await h.actions.hostAction('start', 'gpu-1');
  await h.actions.hostAction('start', 'gpu-1');
  assert.equal(h.calls.length, 1);
});

test('未知主机不能执行动作或打开管理抽屉', async (t) => {
  const h = harness(t, { responder: () => res(202, { accepted: true }) });
  seed(h.store);

  const out = await h.actions.hostAction('probe', 'missing');
  h.actions.viewHostInManage('missing');

  assert.equal(out, null);
  assert.equal(h.calls.length, 0);
  assert.equal(h.store.isPending('probe', 'missing'), false);
  assert.deepEqual(h.navigated, []);
  assert.deepEqual(h.store.state.drawer, { open: false, host: null, dirty: false });
  const toast = h.store.state.toasts.at(-1);
  assert.equal(toast.level, 'warn');
  assert.match(toast.summary, /主机 missing 不存在/);
  assert.equal(toast.count, 2, '动作与管理入口都应明确拒绝，而不是静默吞掉');
});

test('HTTP 错误：pending 立即释放，toast 带 detail', async (t) => {
  const h = harness(t, {
    responder: () => res(409, { error: '远端端口被占用', code: 'REMOTE_PORT_BUSY', detail: 'bind: address already in use' }),
  });
  seed(h.store);

  await h.actions.hostAction('start', 'gpu-1');
  assert.equal(h.store.isPending('start', 'gpu-1'), false);
  const toast = h.store.state.toasts.at(-1);
  assert.equal(toast.level, 'error');
  assert.equal(toast.summary, '远端端口被占用');
  assert.equal(toast.detail, 'bind: address already in use');
});

test('probeAll 可用场景文案呈现失败，且只提交一次', async (t) => {
  const h = harness(t, {
    responder: () => res(503, { error: 'manager 正忙', code: 'BUSY', detail: 'probe queue full' }),
  });

  await h.actions.probeAll({ failureMessage: '发起探测失败（可稍后在管理台重试）' });

  assert.deepEqual(
    h.calls.map((call) => [call.method, call.path]),
    [['POST', '/api/hosts/probe']],
  );
  assert.equal(h.store.state.toasts.length, 1);
  assert.equal(h.store.state.toasts[0].summary, '发起探测失败（可稍后在管理台重试）');
  assert.match(h.store.state.toasts[0].detail, /manager 正忙/);
  assert.match(h.store.state.toasts[0].detail, /probe queue full/);
});

test('关停需二次确认，取消则不发请求', async (t) => {
  const h = harness(t, { responder: () => res(202, { accepted: true, operationId: 'op-1' }), confirmAnswer: false });
  seed(h.store, { phase: 'running', web: { pid: 4242, port: 8899, startedByUs: true, startedAt: null } });

  await h.actions.hostAction('stop', 'gpu-1');
  assert.equal(h.calls.length, 0);
  assert.equal(h.confirms.length, 1);
  assert.match(h.confirms[0].lines.join(' '), /4242/, '确认文案要给出 PID');
  assert.match(h.confirms[0].lines.join(' '), /指纹校验/, '要说明只杀自己拉起的进程');
});

test('动作硬闸阻止手动实例 restart/stop：不确认、不发请求', async (t) => {
  const h = harness(t, { responder: () => res(202, { accepted: true }) });
  seed(h.store, { phase: 'running', web: { pid: 9, port: 8899, startedByUs: false, startedAt: null } });

  for (const action of ['restart', 'stop']) {
    await h.actions.hostAction(action, 'gpu-1');
    const toast = h.store.state.toasts.at(-1);
    assert.equal(toast.level, 'warn');
    assert.match(toast.summary, new RegExp(action), `${action} 应明确告知被硬闸阻止`);
  }
  assert.equal(h.calls.length, 0);
  assert.equal(h.confirms.length, 0);
});

test('断线时禁写，但不静默失败', async (t) => {
  const h = harness(t, { responder: () => res(202, { accepted: true }) });
  seed(h.store);
  h.store.setConnection({ sse: 'reconnecting' });

  await h.actions.hostAction('start', 'gpu-1');
  assert.equal(h.calls.length, 0);
  assert.match(h.store.state.toasts.at(-1).summary, /失联/);
});

test('degraded 已自愈时不再发重连请求', async (t) => {
  const h = harness(t, { responder: () => res(202, { accepted: true }) });
  seed(h.store, { phase: 'running', web: { pid: 1, port: 8899, startedByUs: true, startedAt: null } });

  await h.actions.hostAction('reconnect', 'gpu-1');
  assert.equal(h.calls.length, 0);
  assert.match(h.store.state.toasts.at(-1).summary, /已自行恢复/);
});

test('autoStart toggle：以服务端回传视图为准', async (t) => {
  const updated = hostView({ config: { ...hostView().config, autoStart: true } });
  const h = harness(t, { responder: () => res(200, { host: updated }) });
  seed(h.store);

  await h.actions.setAutoStart('gpu-1', true);
  assert.equal(h.calls[0].method, 'PUT');
  assert.deepEqual(h.calls[0].body, { autoStart: true });
  assert.equal(h.store.getHost('gpu-1').config.autoStart, true);
  assert.equal(h.store.isPending('config:save', 'gpu-1'), false);
});

test('autoStart 失败：本地值不变并 toast', async (t) => {
  const h = harness(t, { responder: () => res(400, { error: 'autoStart 必须是布尔', code: 'VALIDATION' }) });
  seed(h.store);

  await h.actions.setAutoStart('gpu-1', true);
  assert.equal(h.store.getHost('gpu-1').config.autoStart, false, '失败不该留下乐观值');
  assert.equal(h.store.state.toasts.at(-1).level, 'error');
});

test('saveHostConfig 成功：提交 patch、落服务端 HostView 并提示成功', async (t) => {
  const updated = hostView({
    config: {
      ...hostView().config,
      workdir: '/srv/project',
      inject: { env: { MODE: 'test' }, extraArgs: [], patches: [] },
    },
  });
  const h = harness(t, { responder: () => res(200, { host: updated }) });
  seed(h.store);

  const out = await h.actions.saveHostConfig('gpu-1', {
    workdir: '/srv/project',
    inject: { env: { MODE: 'test' }, extraArgs: [], patches: [] },
  });

  assert.deepEqual(h.calls, [{
    path: '/api/hosts/gpu-1/config',
    method: 'PUT',
    body: {
      workdir: '/srv/project',
      inject: { env: { MODE: 'test' }, extraArgs: [], patches: [] },
    },
  }]);
  assert.deepEqual(out.host, updated);
  assert.equal(h.store.getHost('gpu-1').config.workdir, '/srv/project');
  assert.deepEqual(h.store.getHost('gpu-1').config.inject.env, { MODE: 'test' });
  assert.equal(h.store.state.toasts.at(-1).level, 'success');
  assert.equal(h.store.state.toasts.at(-1).summary, 'gpu-1 配置已保存');
});

test('saveHostConfig 迟到响应：snapshot 删除主机后不得复活或误报成功', async (t) => {
  let release;
  const stale = hostView({
    config: { ...hostView().config, workdir: '/srv/stale-response' },
  });
  const gate = new Promise((resolve) => {
    release = () => resolve(res(200, { host: stale }));
  });
  const h = harness(t, { responder: () => gate });
  seed(h.store);

  const request = h.actions.saveHostConfig('gpu-1', { workdir: '/srv/stale-response' });
  h.store.applySnapshot({ revision: 2, hosts: [], logs: [] });
  release();
  const out = await request;

  assert.deepEqual(out, { host: stale }, 'HTTP 成功事实仍返回给调用方');
  assert.equal(h.store.getHost('gpu-1'), null, '迟到 action response 不得复活 snapshot 已删除主机');
  assert.equal(h.store.state.toasts.some((toast) => toast.level === 'success'), false,
    '主机已删除时不能再报“配置已保存”');
});

test('saveHostConfig 迟到响应：较新 SSE 保持权威，不被旧 response 覆盖', async (t) => {
  let release;
  const stale = hostView({
    config: { ...hostView().config, workdir: '/srv/stale-response' },
  });
  const newest = hostView({
    config: { ...hostView().config, workdir: '/srv/newest-sse' },
  });
  const gate = new Promise((resolve) => {
    release = () => resolve(res(200, { host: stale }));
  });
  const h = harness(t, { responder: () => gate });
  seed(h.store);

  const request = h.actions.saveHostConfig('gpu-1', { workdir: '/srv/stale-response' });
  h.store.applyHostChanged({ revision: 2, host: newest });
  release();
  await request;

  assert.equal(h.store.getHost('gpu-1').config.workdir, '/srv/newest-sse');
  assert.equal(h.store.state.toasts.at(-1).summary, 'gpu-1 配置已保存');
});

test('运行中保存新 workdir：不重启实例，并明确提示 manager 重启无效', async (t) => {
  const current = hostView({
    phase: 'running',
    config: { ...hostView().config, workdir: '/srv/old' },
    web: {
      pid: 42,
      port: 8899,
      startedByUs: true,
      startedAt: '2026-08-23T00:00:00.000Z',
      workdir: '/srv/old',
    },
  });
  const updated = {
    ...current,
    config: { ...current.config, workdir: '/srv/new' },
  };
  const h = harness(t, { responder: () => res(200, { host: updated }) });
  h.store.applySnapshot({ revision: 1, hosts: [current], logs: [] });

  await h.actions.saveHostConfig('gpu-1', { workdir: '/srv/new' });

  assert.deepEqual(h.calls.map((call) => [call.method, call.path]), [
    ['PUT', '/api/hosts/gpu-1/config'],
  ], '保存配置不得暗中追加主机或 manager 重启');
  assert.equal(h.store.getHost('gpu-1').web.pid, 42);
  assert.equal(h.store.getHost('gpu-1').web.workdir, '/srv/old');
  assert.equal(h.store.getHost('gpu-1').config.workdir, '/srv/new');
  assert.equal(
    h.store.state.toasts.at(-1).summary,
    'gpu-1 配置已保存；需重启此主机的 dsh web（重启 manager 无效）',
  );
});

test('starting 保存新 workdir：无论 web 是否已出现都提示需重启主机实例', async (t) => {
  const startingWeb = {
    pid: 43,
    port: 8899,
    startedByUs: true,
    startedAt: '2026-08-23T00:00:00.000Z',
    workdir: '/srv/old',
  };
  for (const web of [null, startingWeb]) {
    await t.test(web ? 'web 已出现' : 'web 尚未出现', async (st) => {
      const current = hostView({
        phase: 'starting',
        config: { ...hostView().config, workdir: '/srv/old' },
        web,
      });
      const updated = {
        ...current,
        config: { ...current.config, workdir: '/srv/new' },
      };
      const h = harness(st, { responder: () => res(200, { host: updated }) });
      h.store.applySnapshot({ revision: 1, hosts: [current], logs: [] });

      await h.actions.saveHostConfig('gpu-1', { workdir: '/srv/new' });

      assert.equal(
        h.store.state.toasts.at(-1).summary,
        'gpu-1 配置已保存；需重启此主机的 dsh web（重启 manager 无效）',
      );
    });
  }
});

test('starting 保存 workdir 时流程已回落 ready/no_dsh：不误提示重启', async (t) => {
  for (const phase of ['ready', 'no_dsh']) {
    await t.test(phase, async (st) => {
      const current = hostView({
        phase: 'starting',
        config: { ...hostView().config, workdir: '/srv/old' },
        web: null,
      });
      const updated = {
        ...current,
        phase,
        config: { ...current.config, workdir: '/srv/new' },
      };
      const h = harness(st, { responder: () => res(200, { host: updated }) });
      h.store.applySnapshot({ revision: 1, hosts: [current], logs: [] });

      await h.actions.saveHostConfig('gpu-1', { workdir: '/srv/new' });

      assert.equal(h.store.state.toasts.at(-1).summary, 'gpu-1 配置已保存');
    });
  }
});

test('saveHostConfig API 失败：保留原 host 并显示错误 toast', async (t) => {
  const h = harness(t, {
    responder: () => res(400, {
      error: '启动目录不可用',
      code: 'VALIDATION',
      detail: '/srv/missing 不存在',
    }),
  });
  seed(h.store);
  const before = h.store.getHost('gpu-1');

  const out = await h.actions.saveHostConfig('gpu-1', { workdir: '/srv/missing' });

  assert.equal(out, null);
  assert.equal(h.calls.length, 1);
  assert.equal(h.store.getHost('gpu-1'), before, '失败不能用请求 patch 乐观改写 host');
  assert.equal(h.store.state.toasts.at(-1).level, 'error');
  assert.equal(h.store.state.toasts.at(-1).summary, '启动目录不可用');
  assert.equal(h.store.state.toasts.at(-1).detail, '/srv/missing 不存在');
});

test('saveHostConfig 断线：零请求且保留原 host', async (t) => {
  const h = harness(t, { responder: () => res(200, { host: hostView() }) });
  seed(h.store);
  const before = h.store.getHost('gpu-1');
  h.store.setConnection({ sse: 'reconnecting' });

  const out = await h.actions.saveHostConfig('gpu-1', { enabled: false });

  assert.equal(out, null);
  assert.equal(h.calls.length, 0);
  assert.equal(h.store.getHost('gpu-1'), before);
  assert.equal(h.store.state.toasts.at(-1).level, 'warn');
  assert.match(h.store.state.toasts.at(-1).summary, /失联/);
});

test('批量配置预览：按契约提交 dryRun 且不改写主机', async (t) => {
  const preview = {
    source: 'gpu-1',
    dryRun: true,
    targets: [{ name: 'gpu-2', changed: true, changedFields: ['inject.env'] }],
    applied: [],
    hosts: [],
    previewToken: 'v1.preview-token',
  };
  const h = harness(t, { responder: () => res(200, preview) });
  const target = hostView({ name: 'gpu-2' });
  h.store.applySnapshot({ revision: 1, hosts: [hostView(), target], logs: [] });

  const out = await h.actions.syncConfig({
    source: 'gpu-1',
    targets: ['gpu-2'],
    dryRun: true,
  });

  assert.deepEqual(h.calls, [{
    path: '/api/hosts/sync-config',
    method: 'POST',
    body: { source: 'gpu-1', targets: ['gpu-2'], dryRun: true },
  }]);
  assert.deepEqual(out, preview);
  assert.equal(h.store.getHost('gpu-2').config.inject.env.TEST, undefined);
  assert.equal(h.store.state.toasts.length, 0, '预览不应冒充已应用成功');
  assert.equal(h.store.isPending('config:sync'), false);
});

test('批量配置应用：转发 preview token，无 SSE 时用成功响应更新 store 且不推进 revision', async (t) => {
  const updated = hostView({
    name: 'gpu-2',
    config: {
      ...hostView().config,
      workdir: '/srv/shared',
      inject: { env: { TOKEN: 'server-only' }, extraArgs: [], patches: [] },
    },
  });
  const h = harness(t, {
    responder: () => res(200, {
      source: 'gpu-1',
      dryRun: false,
      targets: [{ name: 'gpu-2', changed: true, changedFields: ['workdir', 'inject.env'] }],
      applied: ['gpu-2'],
      hosts: [updated],
    }),
  });
  const original = hostView({ name: 'gpu-2' });
  h.store.applySnapshot({ revision: 1, hosts: [hostView(), original], logs: [] });

  await h.actions.syncConfig({
    source: 'gpu-1',
    targets: ['gpu-2'],
    dryRun: false,
    previewToken: 'v1.preview-token',
  });

  assert.deepEqual(h.calls[0].body, {
    source: 'gpu-1',
    targets: ['gpu-2'],
    dryRun: false,
    previewToken: 'v1.preview-token',
  });
  assert.equal(h.store.getHost('gpu-2').config.workdir, '/srv/shared',
    '没有后续 SSE 时，成功响应必须成为当前 store 的兜底真相');
  assert.equal(h.store.state.revision, 1, '无 revision 的动作响应不得伪造或推进 revision');
  assert.equal(h.store.state.toasts.at(-1).level, 'success');
  assert.equal(h.store.state.toasts.at(-1).summary, '已同步 1 台主机配置');
});

test('批量同步运行中目标：toast 点明需重启对应 dsh web，manager 重启无效', async (t) => {
  const original = hostView({
    name: 'gpu-2',
    phase: 'running',
    config: { ...hostView().config, workdir: '/srv/old' },
    web: {
      pid: 52,
      port: 8899,
      startedByUs: true,
      startedAt: '2026-08-23T00:00:00.000Z',
      workdir: '/srv/old',
    },
  });
  const updated = {
    ...original,
    config: { ...original.config, workdir: '/srv/shared' },
  };
  const h = harness(t, {
    responder: () => res(200, {
      source: 'gpu-1',
      dryRun: false,
      targets: [{ name: 'gpu-2', changed: true, changedFields: ['workdir'] }],
      applied: ['gpu-2'],
      hosts: [updated],
    }),
  });
  h.store.applySnapshot({ revision: 1, hosts: [hostView(), original], logs: [] });

  await h.actions.syncConfig({
    source: 'gpu-1',
    targets: ['gpu-2'],
    dryRun: false,
    previewToken: 'v1.preview-token',
  });

  const toast = h.store.state.toasts.at(-1);
  assert.equal(toast.summary, '已同步 1 台主机配置；运行中目标需重启 dsh web（重启 manager 无效）');
  assert.equal(toast.detail, 'gpu-2：需重启此主机的 dsh web（重启 manager 无效）');
  assert.equal(h.store.getHost('gpu-2').web.pid, 52, '同步配置不得重启运行实例');
});

test('批量配置应用迟到响应：请求后 snapshot 删除目标时不得复活幽灵主机', async (t) => {
  let release;
  const removed = hostView({
    name: 'gpu-2',
    config: { ...hostView().config, workdir: '/srv/removed-target' },
  });
  const gate = new Promise((resolve) => {
    release = () => resolve(res(200, {
      source: 'gpu-1',
      dryRun: false,
      targets: [{ name: 'gpu-2', changed: true, changedFields: ['workdir'] }],
      applied: ['gpu-2'],
      hosts: [removed],
    }));
  });
  const h = harness(t, { responder: () => gate });
  h.store.applySnapshot({
    revision: 1,
    hosts: [hostView(), hostView({ name: 'gpu-2' })],
    logs: [],
  });

  const request = h.actions.syncConfig({
    source: 'gpu-1',
    targets: ['gpu-2'],
    dryRun: false,
    previewToken: 'v1.preview-token',
  });
  h.store.applySnapshot({ revision: 2, hosts: [hostView()], logs: [] });
  release();
  await request;

  assert.equal(h.store.getHost('gpu-2'), null);
  assert.equal(h.store.state.revision, 2);
});

test('批量配置应用迟到响应：较新 SSE 已到后不得回退 store', async (t) => {
  let release;
  const stale = hostView({
    name: 'gpu-2',
    config: { ...hostView().config, workdir: '/srv/stale-response' },
  });
  const gate = new Promise((resolve) => {
    release = () => resolve(res(200, {
      source: 'gpu-1',
      dryRun: false,
      targets: [{ name: 'gpu-2', changed: true, changedFields: ['workdir'] }],
      applied: ['gpu-2'],
      hosts: [stale],
    }));
  });
  const h = harness(t, { responder: () => gate });
  h.store.applySnapshot({
    revision: 1,
    hosts: [hostView(), hostView({ name: 'gpu-2' })],
    logs: [],
  });

  const request = h.actions.syncConfig({
    source: 'gpu-1',
    targets: ['gpu-2'],
    dryRun: false,
    previewToken: 'v1.preview-token',
  });
  const newest = hostView({
    name: 'gpu-2',
    config: { ...hostView().config, workdir: '/srv/newest-sse' },
  });
  h.store.applyHostChanged({ revision: 2, host: newest });
  release();
  await request;

  assert.equal(h.calls[0].body.previewToken, 'v1.preview-token');
  assert.equal(h.store.getHost('gpu-2').config.workdir, '/srv/newest-sse');
  assert.equal(h.store.state.revision, 2);
  assert.equal(h.store.state.toasts.at(-1).summary, '已同步 1 台主机配置');
});

test('批量配置应用全已一致时提示 no-op', async (t) => {
  const target = hostView({ name: 'gpu-2' });
  const h = harness(t, {
    responder: () => res(200, {
      source: 'gpu-1',
      dryRun: false,
      targets: [{ name: 'gpu-2', changed: false, changedFields: [] }],
      applied: [],
      hosts: [target],
    }),
  });
  h.store.applySnapshot({ revision: 1, hosts: [hostView(), target], logs: [] });

  await h.actions.syncConfig({
    source: 'gpu-1',
    targets: ['gpu-2'],
    dryRun: false,
    previewToken: 'v1.preview-token',
  });

  assert.equal(h.store.state.toasts.at(-1).summary, '目标配置已一致');
});

test('批量配置超过 200 个目标时整单拒绝，不请求也不分批', async (t) => {
  const h = harness(t, { responder: () => res(200, {}) });
  const targets = Array.from({ length: 201 }, (_, index) => `gpu-${index + 2}`);

  const out = await h.actions.syncConfig({
    source: 'gpu-1',
    targets,
    dryRun: true,
  });

  assert.equal(out, null);
  assert.equal(h.calls.length, 0);
  assert.equal(h.store.isPending('config:sync'), false);
  assert.match(h.store.state.toasts.at(-1).summary, /最多同步 200 台/);
  assert.match(h.store.state.toasts.at(-1).detail, /整单原子.*不会自动拆分/);
});

test('批量配置失败与断线：guarded 释放 pending、toast，断线零请求', async (t) => {
  const h = harness(t, {
    responder: () => res(409, {
      error: '目标主机已变化',
      code: 'CONFLICT',
      detail: 'gpu-2 已删除',
    }),
  });
  h.store.applySnapshot({ revision: 1, hosts: [hostView(), hostView({ name: 'gpu-2' })], logs: [] });

  const failed = await h.actions.syncConfig({
    source: 'gpu-1',
    targets: ['gpu-2'],
    dryRun: true,
  });
  assert.equal(failed, null);
  assert.equal(h.store.isPending('config:sync'), false);
  assert.equal(h.store.state.toasts.at(-1).summary, '目标主机已变化');
  assert.equal(h.store.state.toasts.at(-1).detail, 'gpu-2 已删除');

  h.store.setConnection({ sse: 'reconnecting' });
  const disconnected = await h.actions.syncConfig({
    source: 'gpu-1',
    targets: ['gpu-2'],
    dryRun: true,
  });
  assert.equal(disconnected, null);
  assert.equal(h.calls.length, 1);
  assert.match(h.store.state.toasts.at(-1).summary, /失联/);
});

test('批量配置网络异常沿用 guarded 错误模型', async (t) => {
  const h = harness(t, {
    responder: () => {
      throw new TypeError('fetch failed');
    },
  });
  h.store.applySnapshot({ revision: 1, hosts: [hostView(), hostView({ name: 'gpu-2' })], logs: [] });

  const out = await h.actions.syncConfig({
    source: 'gpu-1',
    targets: ['gpu-2'],
    dryRun: true,
  });

  assert.equal(out, null);
  assert.equal(h.store.isPending('config:sync'), false);
  assert.match(h.store.state.toasts.at(-1).summary, /无法连接 manager/);
});

test('saveDefaults 更新配置端口但不冒充实际监听端口，并按响应提示重启', async (t) => {
  const h = harness(t, {
    responder: () => res(200, {
      defaults: { remoteWebPort: 8899, localPortRange: [17_701, 17_799] },
      manager: { port: 7799 },
      restartRequired: true,
    }),
  });
  h.store.setManagerInfo({ setupCompleted: true, port: 7788, pid: 1, version: '0.1.0', mode: 'background', uptimeMs: 0, hostCounts: {} });

  const out = await h.actions.saveDefaults({ remoteWebPort: 8899, localPortRange: [17_701, 17_799], manager: { port: 7799 } });
  assert.equal(out.restartRequired, true);
  assert.equal(h.store.state.manager.info.port, 7788);
  assert.equal(h.store.state.manager.configuredPort, 7799);
  assert.match(h.store.state.toasts.at(-1).summary, /重启/);
});

test('reload 成功展示变更，随后 HTTP 失败释放 pending 并保留错误真相', async (t) => {
  let attempts = 0;
  const h = harness(t, {
    responder: ({ path }) => {
      assert.equal(path, '/api/reload');
      attempts += 1;
      return attempts === 1
        ? res(200, { changed: ['hosts.gpu-2', 'defaults.remoteWebPort'] })
        : res(500, { error: '配置文件暂时不可读', code: 'CONFIG_READ', detail: 'permission denied' });
    },
  });

  const first = await h.actions.reload();
  assert.deepEqual(first.changed, ['hosts.gpu-2', 'defaults.remoteWebPort']);
  assert.equal(h.store.isPending('config:reload'), false);
  assert.equal(h.store.state.toasts.at(-1).level, 'success');
  assert.equal(h.store.state.toasts.at(-1).summary, '已重载配置（2 项变化）');
  assert.equal(h.store.state.toasts.at(-1).detail, 'hosts.gpu-2\ndefaults.remoteWebPort');

  const failed = await h.actions.reload();
  assert.equal(failed, null);
  assert.equal(h.calls.length, 2);
  assert.deepEqual(h.calls.map((call) => [call.method, call.path]), [
    ['POST', '/api/reload'],
    ['POST', '/api/reload'],
  ]);
  assert.equal(h.store.isPending('config:reload'), false);
  assert.equal(h.store.state.toasts.at(-1).level, 'error');
  assert.equal(h.store.state.toasts.at(-1).summary, '配置文件暂时不可读');
  assert.equal(h.store.state.toasts.at(-1).detail, 'permission denied');
});

test('manager 重启取消：不发请求也不创建 pending', async (t) => {
  const h = harness(t, {
    responder: () => res(202, { accepted: true }),
    confirmAnswer: false,
  });

  const out = await h.actions.restartManager();
  assert.equal(out, null);
  assert.equal(h.calls.length, 0);
  assert.equal(h.confirms.length, 1);
  const confirmation = h.confirms[0].lines.join(' ');
  assert.match(confirmation, /存活的受管实例.*复核接管/);
  assert.match(confirmation, /远端重建隧道、本机重新登记直连/);
  assert.match(confirmation, /ready.*autoStart.*才会拉起/);
  assert.doesNotMatch(confirmation, /按 autoStart 重建/);
  assert.equal(h.store.isPending('manager:restart'), false);
});

test('manager 重启 HTTP 失败：释放 pending 并展示服务端诊断', async (t) => {
  const h = harness(t, {
    responder: () => res(503, {
      error: '前台模式不能自我重启',
      code: 'UNSUPPORTED',
      detail: '请退出前台进程后重试',
    }),
  });

  const out = await h.actions.restartManager();
  assert.equal(out, null);
  assert.deepEqual(h.calls.map((call) => [call.method, call.path]), [
    ['POST', '/api/manager/restart'],
  ]);
  assert.equal(h.confirms.length, 1);
  assert.equal(h.store.isPending('manager:restart'), false);
  assert.equal(h.store.state.toasts.at(-1).level, 'error');
  assert.equal(h.store.state.toasts.at(-1).summary, '前台模式不能自我重启');
  assert.equal(h.store.state.toasts.at(-1).detail, '请退出前台进程后重试');
});

test('网络层异常（manager 不在）也走统一错误模型', async (t) => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new TypeError('fetch failed');
  };
  t.after(() => {
    globalThis.fetch = original;
  });

  const store = createStore();
  store.setConnection({ sse: 'open' });
  const actions = createActions({ store, confirm: async () => true, navigate: () => {} });
  store.applySnapshot({ revision: 1, hosts: [hostView()], logs: [] });

  await actions.hostAction('probe', 'gpu-1');
  assert.equal(store.isPending('probe', 'gpu-1'), false);
  assert.match(store.state.toasts.at(-1).summary, /无法连接 manager/);
});

test('日志失败返回 null，让调用方保住上一次内容', async (t) => {
  const h = harness(t, { responder: () => res(500, { error: 'ssh 超时', code: 'SSH_TIMEOUT' }) });
  seed(h.store);

  const out = await h.actions.loadHostLog('gpu-1');
  assert.equal(out, null);
  assert.deepEqual(h.calls.map((call) => [call.method, call.path]), [
    ['GET', '/api/hosts/gpu-1/log?lines=200'],
  ]);
  assert.equal(h.store.state.toasts.at(-1).level, 'error');
  assert.equal(h.store.state.toasts.at(-1).summary, 'ssh 超时');
});

test('日志响应读取抛普通 Error：返回 null 并保留诊断堆栈', async (t) => {
  const h = harness(t, {
    responder: () => ({
      ok: true,
      status: 200,
      text: async () => {
        throw new Error('日志流解码失败');
      },
    }),
  });
  seed(h.store);

  const out = await h.actions.loadHostLog('gpu-1', 37);
  assert.equal(out, null);
  assert.deepEqual(h.calls.map((call) => [call.method, call.path]), [
    ['GET', '/api/hosts/gpu-1/log?lines=37'],
  ]);
  const toast = h.store.state.toasts.at(-1);
  assert.equal(toast.level, 'error');
  assert.equal(toast.summary, 'gpu-1 日志拉取失败：日志流解码失败');
  assert.match(toast.detail, /Error: 日志流解码失败/);
});

test('settings GET：编码主机名并原样返回 missing/existing，成功不 toast', async (t) => {
  const missing = {
    exists: false,
    path: '/home/me/.dsh/settings.yaml',
    content: '',
    checksum: null,
    size: 0,
  };
  const existing = {
    exists: true,
    path: '/home/me/.dsh/settings.yaml',
    content: 'provider: synthetic\n',
    checksum: 'cksum-v1:123:20',
    size: 20,
  };
  let attempt = 0;
  const h = harness(t, {
    responder: () => res(200, attempt++ === 0 ? missing : existing),
  });

  assert.deepEqual(await h.actions.loadDshSettings('gpu/a b'), missing);
  assert.deepEqual(await h.actions.loadDshSettings('gpu/a b'), existing);
  assert.deepEqual(h.calls, [
    {
      path: '/api/hosts/gpu%2Fa%20b/dsh-settings',
      method: 'GET',
      body: null,
    },
    {
      path: '/api/hosts/gpu%2Fa%20b/dsh-settings',
      method: 'GET',
      body: null,
    },
  ]);
  assert.equal(h.store.isPending('settings:load', 'gpu/a b'), false);
  assert.deepEqual(h.store.state.toasts, []);
  assert.equal(h.store.state.revision, -1, 'settings GET 不得冒充 host/store/SSE 更新');
});

test('settings PUT：只提交 content/baseChecksum，同步结算且不发含糊成功 toast', async (t) => {
  const content = 'token: save-secret\n';
  const saved = {
    updated: true,
    path: '/home/me/.dsh/settings.yaml',
    checksum: 'cksum-v1:456:19',
    size: 19,
  };
  const h = harness(t, { responder: () => res(200, saved) });

  const out = await h.actions.saveDshSettings('gpu/a b', {
    content,
    baseChecksum: 'cksum-v1:123:18',
  });

  assert.deepEqual(h.calls, [{
    path: '/api/hosts/gpu%2Fa%20b/dsh-settings',
    method: 'PUT',
    body: {
      content,
      baseChecksum: 'cksum-v1:123:18',
    },
  }]);
  assert.deepEqual(out, saved);
  assert.equal(Object.hasOwn(out, 'content'), false, '保存响应不回显 settings 正文');
  assert.equal(h.store.isPending('settings:save', 'gpu/a b'), false);
  assert.deepEqual(h.store.state.toasts, [],
    '抽屉要区分“提交时版本已保存”与“当前仍有草稿”，动作层不能抢先报笼统成功');
});

test('settings load/save 使用独立 pending，同类重复调用不重复提交', async (t) => {
  const releases = new Map();
  const h = harness(t, {
    responder: ({ method }) => new Promise((resolve) => {
      releases.set(method, resolve);
    }),
  });

  const loading = h.actions.loadDshSettings('gpu-1');
  const saving = h.actions.saveDshSettings('gpu-1', {
    content: 'pending-secret\n',
    baseChecksum: null,
  });
  assert.equal(h.store.isPending('settings:load', 'gpu-1'), true);
  assert.equal(h.store.isPending('settings:save', 'gpu-1'), true);

  assert.equal(await h.actions.loadDshSettings('gpu-1'), null);
  assert.equal(await h.actions.saveDshSettings('gpu-1', {
    content: 'must-not-submit\n',
    baseChecksum: null,
  }), null);
  assert.equal(h.calls.length, 2);

  releases.get('GET')(res(200, {
    exists: false,
    path: '/home/me/.dsh/settings.yaml',
    content: '',
    checksum: null,
    size: 0,
  }));
  releases.get('PUT')(res(200, {
    updated: true,
    path: '/home/me/.dsh/settings.yaml',
    checksum: 'cksum-v1:1:15',
    size: 15,
  }));
  await Promise.all([loading, saving]);
  assert.equal(h.store.isPending('settings:load', 'gpu-1'), false);
  assert.equal(h.store.isPending('settings:save', 'gpu-1'), false);
});

test('settings GET 在断线/resync 仍尝试 REST，PUT 保持 canWrite 阻断', async (t) => {
  for (const mode of ['reconnecting', 'resyncing']) {
    await t.test(mode, async (st) => {
      const loadedResponse = {
        exists: false,
        path: '/home/me/.dsh/settings.yaml',
        content: '',
        checksum: null,
        size: 0,
      };
      const h = harness(st, { responder: () => res(200, loadedResponse) });
      if (mode === 'reconnecting') h.store.setConnection({ sse: 'reconnecting' });
      else h.store.setConnection({ sse: 'open', resyncing: true });
      const errors = [];

      const loaded = await h.actions.loadDshSettings('gpu-1', {
        onError: (error) => errors.push(error),
      });
      const saved = await h.actions.saveDshSettings('gpu-1', {
        content: `blocked-${mode}-secret\n`,
        baseChecksum: null,
      }, {
        onError: (error) => errors.push(error),
      });

      assert.deepEqual(loaded, loadedResponse);
      assert.equal(saved, null);
      assert.deepEqual(h.calls.map((call) => [call.method, call.path]), [
        ['GET', '/api/hosts/gpu-1/dsh-settings'],
      ]);
      assert.equal(errors.length, 1);
      assert.equal(errors[0].level, 'warn');
      assert.match(errors[0].summary, /失联/u);
      assert.equal(errors[0].detail, null);
      assert.equal(errors[0].code, null);
      assert.equal(errors[0].status, null);
      assert.doesNotMatch(
        JSON.stringify({ errors, toasts: h.store.state.toasts }),
        new RegExp(`blocked-${mode}-secret`, 'u'),
      );
    });
  }
});

test('settings API 已知错误使用本地固定文案，并保留 code/status', async (t) => {
  const cases = [
    [409, 'SETTINGS_STALE', 'dsh 配置文件已变化，请重新加载后再保存'],
    [413, 'SETTINGS_TOO_LARGE', 'dsh 配置文件超过大小限制，无法处理'],
    [501, 'SETTINGS_UNSUPPORTED', '该主机不支持安全编辑 dsh 配置文件'],
    [422, 'SETTINGS_INVALID_UTF8', 'dsh 配置文件不是有效的 UTF-8 文本'],
    [500, 'SETTINGS_READ_FAILED', '读取 dsh 配置文件失败，请稍后重试'],
    [500, 'SETTINGS_WRITE_FAILED', '保存 dsh 配置文件失败，请重新加载确认结果'],
    [409, 'SETTINGS_BUSY', '该主机已有 dsh 配置操作正在进行，请稍后重试'],
    [504, 'SSH_TIMEOUT', '保存结果未知，请重新加载后确认'],
    [502, 'SSH_UNREACHABLE', '保存结果未知，请重新加载后确认'],
    [504, 'LOCAL_TIMEOUT', '保存结果未知，请重新加载后确认'],
    [500, 'LOCAL_EXEC_FAILED', '保存结果未知，请重新加载后确认'],
  ];
  for (const [status, code, summary] of cases) {
    await t.test(code, async (st) => {
      const secret = `malicious-${code}-secret`;
      const h = harness(st, {
        responder: () => res(status, {
          error: `server error ${secret}`,
          code,
          detail: `server detail ${secret}`,
        }),
      });
      const errors = [];
      const out = await h.actions.saveDshSettings('gpu-1', {
        content: `request-${secret}\n`,
        baseChecksum: null,
      }, {
        onError: (error) => errors.push(error),
      });

      assert.equal(out, null);
      assert.equal(h.store.isPending('settings:save', 'gpu-1'), false);
      assert.equal(errors.length, 1);
      assert.equal(errors[0].code, code);
      assert.equal(errors[0].status, status);
      assert.equal(errors[0].summary, summary);
      assert.equal(errors[0].detail, null);
      assert.doesNotMatch(
        JSON.stringify({ errors, toasts: h.store.state.toasts }),
        new RegExp(secret, 'u'),
      );
    });
  }
});

test('settings API 未知 JSON/plain 错误只保留安全 code/status 与 HTTP 文案', async (t) => {
  for (const kind of ['json', 'plain']) {
    await t.test(kind, async (st) => {
      const secret = `malicious-${kind}-500-secret`;
      const h = harness(st, {
        responder: () => (kind === 'json'
          ? res(500, {
            error: `server error ${secret}`,
            code: `UNKNOWN_SETTINGS_FAILURE_${secret}`,
            detail: `server detail ${secret}`,
          })
          : res(500, undefined, { text: `plain server failure ${secret}` })),
      });
      const errors = [];

      const out = await h.actions.loadDshSettings('gpu-1', {
        onError: (error) => errors.push(error),
      });

      assert.equal(out, null);
      assert.equal(errors.length, 1);
      assert.equal(errors[0].status, 500);
      assert.equal(errors[0].code, 'INTERNAL');
      assert.equal(errors[0].summary, 'dsh 配置请求失败（HTTP 500）');
      assert.equal(errors[0].detail, null);
      assert.doesNotMatch(
        JSON.stringify({ errors, toasts: h.store.state.toasts }),
        new RegExp(secret, 'u'),
      );
    });
  }
});

test('settings transport 失败走 onError 的 ApiError code/status', async (t) => {
  const secret = 'transport-error-unique-secret';
  const h = harness(t, {
    responder: () => {
      throw new TypeError(`fetch failed ${secret}`);
    },
  });
  h.store.setConnection({ sse: 'reconnecting' });
  const errors = [];

  const out = await h.actions.loadDshSettings('gpu-1', {
    onError: (error) => errors.push(error),
  });

  assert.equal(out, null);
  assert.equal(h.store.isPending('settings:load', 'gpu-1'), false);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 'INTERNAL');
  assert.equal(errors[0].status, 0);
  assert.equal(errors[0].summary, 'dsh 配置请求失败，请稍后重试');
  assert.equal(errors[0].detail, null);
  assert.deepEqual(h.calls.map((call) => [call.method, call.path]), [
    ['GET', '/api/hosts/gpu-1/dsh-settings'],
  ]);
  assert.doesNotMatch(
    JSON.stringify({ errors, toasts: h.store.state.toasts }),
    new RegExp(secret, 'u'),
  );
});

test('settings GET/PUT 都使用 30 秒请求超时', async (t) => {
  for (const action of ['load', 'save']) {
    await t.test(action, async (st) => {
      st.mock.timers.enable({ apis: ['setTimeout'] });
      const original = globalThis.fetch;
      let aborted = false;
      globalThis.fetch = async (path, init) => new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          aborted = true;
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      });
      st.after(() => {
        globalThis.fetch = original;
      });

      const store = createStore();
      store.setConnection({ sse: 'open' });
      const actions = createActions({ store, confirm: async () => true, navigate: () => {} });
      const errors = [];
      const onError = (error) => errors.push(error);
      const request = action === 'load'
        ? actions.loadDshSettings('gpu-1', { onError })
        : actions.saveDshSettings('gpu-1', {
          content: 'timeout-secret\n',
          baseChecksum: null,
        }, { onError });

      st.mock.timers.tick(29_999);
      assert.equal(aborted, false);
      st.mock.timers.tick(1);
      assert.equal(aborted, true);
      assert.equal(await request, null);
      assert.equal(errors[0].code, 'SSH_TIMEOUT');
      assert.equal(errors[0].status, 0);
      assert.equal(
        errors[0].summary,
        action === 'save'
          ? '保存结果未知，请重新加载后确认'
          : 'dsh 配置请求超时，请稍后重试',
      );
    });
  }
});

test('settings PUT transport/正文读取失败统一提示保存结果未知', async (t) => {
  for (const stage of ['transport', 'body']) {
    await t.test(stage, async (st) => {
      const secret = `save-${stage}-failure-secret`;
      const h = harness(st, {
        responder: () => {
          if (stage === 'transport') throw new TypeError(`fetch failed ${secret}`);
          return {
            ok: true,
            status: 200,
            text: async () => {
              throw new Error(`body read failed ${secret}`);
            },
          };
        },
      });
      const errors = [];

      const out = await h.actions.saveDshSettings('gpu-1', {
        content: `request-${secret}\n`,
        baseChecksum: null,
      }, {
        onError: (error) => errors.push(error),
      });

      assert.equal(out, null);
      assert.equal(h.store.isPending('settings:save', 'gpu-1'), false);
      assert.equal(errors.length, 1);
      assert.equal(errors[0].code, 'INTERNAL');
      assert.equal(errors[0].status, 0);
      assert.equal(errors[0].summary, '保存结果未知，请重新加载后确认');
      assert.equal(errors[0].detail, null);
      assert.doesNotMatch(
        JSON.stringify({ errors, toasts: h.store.state.toasts }),
        new RegExp(secret, 'u'),
      );
    });
  }
});

test('settings timeout 覆盖 headers 后的响应正文读取，并最终释放 pending', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const original = globalThis.fetch;
  let bodyReadStarted = false;
  let bodyAborted = false;
  globalThis.fetch = async (path, init) => ({
    ok: true,
    status: 200,
    text: async () => new Promise((resolve, reject) => {
      bodyReadStarted = true;
      init.signal.addEventListener('abort', () => {
        bodyAborted = true;
        const error = new Error('body aborted');
        error.name = 'AbortError';
        reject(error);
      }, { once: true });
    }),
  });
  t.after(() => {
    globalThis.fetch = original;
  });

  const store = createStore();
  store.setConnection({ sse: 'open' });
  const actions = createActions({ store, confirm: async () => true, navigate: () => {} });
  const errors = [];
  const request = actions.loadDshSettings('gpu-1', {
    onError: (error) => errors.push(error),
  });
  await Promise.resolve();

  assert.equal(bodyReadStarted, true);
  assert.equal(store.isPending('settings:load', 'gpu-1'), true);
  t.mock.timers.tick(29_999);
  assert.equal(bodyAborted, false);
  t.mock.timers.tick(1);
  assert.equal(bodyAborted, true);
  assert.equal(await request, null);
  assert.equal(store.isPending('settings:load', 'gpu-1'), false);
  assert.equal(errors[0].code, 'SSH_TIMEOUT');
  assert.equal(errors[0].status, 0);
});

test('settings 成功响应 JSON 畸形时 PROTO_PARSE 不把原文/content 放入呈现', async (t) => {
  for (const action of ['load', 'save']) {
    await t.test(action, async (st) => {
      const secret = `malformed-${action}-secret`;
      const h = harness(st, {
        responder: () => res(200, undefined, {
          text: `{"content":"${secret}"`,
        }),
      });
      const errors = [];
      const onError = (error) => errors.push(error);
      const out = action === 'load'
        ? await h.actions.loadDshSettings('gpu-1', { onError })
        : await h.actions.saveDshSettings('gpu-1', {
          content: `${secret}-request`,
          baseChecksum: null,
        }, { onError });

      assert.equal(out, null);
      assert.equal(errors.length, 1);
      assert.equal(errors[0].code, 'PROTO_PARSE');
      assert.equal(errors[0].status, 200);
      assert.equal(errors[0].detail, null);
      assert.equal(
        errors[0].summary,
        action === 'save'
          ? '保存结果未知，请重新加载后确认'
          : '响应不是合法 JSON',
      );
      assert.doesNotMatch(
        JSON.stringify({ errors, toasts: h.store.state.toasts }),
        new RegExp(secret, 'u'),
      );
    });
  }
});

test('settings 解析脱敏不改变其他 API 的既有 PROTO_PARSE detail', async (t) => {
  const raw = '{"diagnostic":"legacy-detail"';
  const h = harness(t, {
    responder: () => res(200, undefined, { text: raw }),
  });
  seed(h.store);

  const out = await h.actions.hostAction('probe', 'gpu-1');

  assert.equal(out, null);
  const toast = h.store.state.toasts.at(-1);
  assert.equal(toast.summary, '响应不是合法 JSON');
  assert.equal(toast.detail, raw);
});

test('Workspace 登记：严格 POST 编码 URL/空对象，同步结算且区分新建与已有', async (t) => {
  const replies = [
    {
      created: true,
      workspaceId: 'workspace-new',
      title: 'project',
      path: '/srv/project',
    },
    {
      created: false,
      workspaceId: 'workspace-existing',
      title: 'project',
      path: '/srv/project',
    },
  ];
  const h = harness(t, { responder: () => res(200, replies.shift()) });

  const created = await h.actions.registerDshWorkspace('gpu/a b');
  const existing = await h.actions.registerDshWorkspace('gpu/a b');

  assert.deepEqual(h.calls, [
    {
      path: '/api/hosts/gpu%2Fa%20b/dsh-workspace',
      method: 'POST',
      body: {},
    },
    {
      path: '/api/hosts/gpu%2Fa%20b/dsh-workspace',
      method: 'POST',
      body: {},
    },
  ]);
  assert.equal(created.created, true);
  assert.equal(existing.created, false);
  assert.equal(h.store.isPending('workspace:register', 'gpu/a b'), false);
  assert.deepEqual(
    h.store.state.toasts.map((toast) => toast.summary),
    [
      'gpu/a b 已登记启动目录为 dsh Workspace',
      'gpu/a b 的启动目录已是 dsh Workspace',
    ],
  );
  assert.doesNotMatch(JSON.stringify(h.store.state.toasts), /\/srv\/project|workspace-new|workspace-existing/,
    '全局 toast 不得携带响应 path/id，强制关闭后的迟到成功仍需安全');
});

test('Workspace 登记 pending 去重、canWrite 闸门与 store 超时契约', async (t) => {
  let release;
  const gate = new Promise((resolve) => {
    release = () => resolve(res(200, {
      created: true,
      workspaceId: 'workspace-1',
      title: 'project',
      path: '/srv/project',
    }));
  });
  const h = harness(t, { responder: () => gate });

  const request = h.actions.registerDshWorkspace('gpu-1');
  assert.equal(h.store.isPending('workspace:register', 'gpu-1'), true);
  assert.equal(await h.actions.registerDshWorkspace('gpu-1'), null, '同主机 pending 不得重复提交');
  assert.equal(h.calls.length, 1);

  release();
  await request;
  assert.equal(h.store.isPending('workspace:register', 'gpu-1'), false);

  h.store.setConnection({ sse: 'reconnecting', everOpened: true });
  const blocked = await h.actions.registerDshWorkspace('gpu-1');
  assert.equal(blocked, null);
  assert.equal(h.calls.length, 1, '断联时不得发第二个登记请求');
  assert.match(h.store.state.toasts.at(-1).summary, /失联/);
});

test('Workspace 登记请求 20 秒超时会释放 pending，并只呈现固定安全错误', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const original = globalThis.fetch;
  let aborted = false;
  globalThis.fetch = async (path, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => {
      aborted = true;
      const error = new Error('unsafe timeout /private/workspace/path');
      error.name = 'AbortError';
      reject(error);
    }, { once: true });
  });
  t.after(() => {
    globalThis.fetch = original;
  });

  const store = createStore();
  store.setConnection({ sse: 'open' });
  const actions = createActions({ store, confirm: async () => true, navigate: () => {} });
  const errors = [];
  const request = actions.registerDshWorkspace('gpu-1', {
    onError: (error) => errors.push(error),
  });

  assert.equal(store.isPending('workspace:register', 'gpu-1'), true);
  t.mock.timers.tick(19_999);
  assert.equal(aborted, false);
  t.mock.timers.tick(1);
  assert.equal(aborted, true);
  assert.equal(await request, null);
  assert.equal(store.isPending('workspace:register', 'gpu-1'), false);
  assert.equal(errors[0].code, 'WORKSPACE_REGISTER_TIMEOUT');
  assert.equal(errors[0].status, 0);
  assert.equal(errors[0].summary, 'dsh Workspace 登记超时；可安全重试');
  assert.equal(errors[0].detail, null);
  assert.doesNotMatch(JSON.stringify({ errors, toasts: store.state.toasts }), /private|unsafe/);
});

test('Workspace API 错误只呈现 allowlist 固定文案，不泄露非 ok 或畸形响应', async (t) => {
  const cases = [
    {
      name: 'busy',
      response: res(409, {
        error: 'unsafe busy error /private/server/path',
        code: 'WORKSPACE_BUSY',
        detail: 'unsafe busy detail',
      }),
      code: 'WORKSPACE_BUSY',
      status: 409,
      summary: '该主机已有 dsh Workspace 登记正在进行，请稍后重试',
    },
    {
      name: 'workdir-required',
      response: res(400, {
        error: 'unsafe required error /private/server/path',
        code: 'WORKSPACE_WORKDIR_REQUIRED',
        detail: 'unsafe workdir detail',
      }),
      code: 'WORKSPACE_WORKDIR_REQUIRED',
      status: 400,
      summary: '请先配置启动目录并重启 dsh web 后再登记',
    },
    {
      name: 'cwd-unavailable',
      response: res(409, {
        error: 'unsafe cwd error /private/server/path',
        code: 'WORKSPACE_CWD_UNAVAILABLE',
        detail: 'unsafe cwd detail',
      }),
      code: 'WORKSPACE_CWD_UNAVAILABLE',
      status: 409,
      summary: '当前 dsh web 的实际工作目录不可用，请重启后重试',
    },
    {
      name: 'invalid-path',
      response: res(422, {
        error: 'unsafe path error /private/server/path',
        code: 'WORKSPACE_INVALID_PATH',
        detail: 'unsafe path detail',
      }),
      code: 'WORKSPACE_INVALID_PATH',
      status: 422,
      summary: '当前 dsh web 的实际工作目录不是绝对路径，无法登记',
    },
    {
      name: 'register-failed',
      response: res(502, {
        error: 'unsafe workspace error /private/server/path',
        code: 'WORKSPACE_REGISTER_FAILED',
        detail: 'unsafe detail token=secret',
      }),
      code: 'WORKSPACE_REGISTER_FAILED',
      status: 502,
      summary: 'dsh Workspace 登记失败，请稍后重试',
    },
    {
      name: 'timeout',
      response: res(504, {
        error: 'unsafe timeout error /private/server/path',
        code: 'WORKSPACE_REGISTER_TIMEOUT',
        detail: 'unsafe timeout detail',
      }),
      code: 'WORKSPACE_REGISTER_TIMEOUT',
      status: 504,
      summary: 'dsh Workspace 登记超时；可安全重试',
    },
    {
      name: 'unknown',
      response: res(500, {
        error: 'unknown unsafe workspace error',
        code: 'UNKNOWN_WORKSPACE_SECRET',
        detail: '/private/unknown/path',
      }),
      code: 'INTERNAL',
      status: 500,
      summary: 'dsh Workspace 请求失败（HTTP 500）',
    },
    {
      name: 'plain',
      response: res(503, undefined, { text: 'plain unsafe /private/plain/path' }),
      code: 'INTERNAL',
      status: 503,
      summary: 'dsh Workspace 请求失败（HTTP 503）',
    },
    {
      name: 'parse',
      response: res(200, undefined, { text: '{"path":"/private/malformed"' }),
      code: 'PROTO_PARSE',
      status: 200,
      summary: 'dsh Workspace 响应无法解析，请重试',
    },
  ];

  for (const item of cases) {
    await t.test(item.name, async (st) => {
      const h = harness(st, { responder: () => item.response });
      const errors = [];
      const out = await h.actions.registerDshWorkspace('gpu-1', {
        onError: (error) => errors.push(error),
      });

      assert.equal(out, null);
      assert.equal(h.store.isPending('workspace:register', 'gpu-1'), false);
      assert.equal(errors.length, 1);
      assert.equal(errors[0].code, item.code);
      assert.equal(errors[0].status, item.status);
      assert.equal(errors[0].summary, item.summary);
      assert.equal(errors[0].detail, null);
      assert.doesNotMatch(
        JSON.stringify({ errors, toasts: h.store.state.toasts }),
        /unsafe|secret|\/private|UNKNOWN_WORKSPACE_SECRET/,
      );
    });
  }
});

test('打开主机走路由，不存在则提示', async (t) => {
  const h = harness(t, { responder: () => res(200, {}) });
  seed(h.store);

  h.actions.openHost('gpu-1');
  assert.deepEqual(h.navigated, ['#/host/gpu-1']);

  h.actions.openHost('nope');
  assert.equal(h.navigated.length, 1);
  assert.match(h.store.state.toasts.at(-1).summary, /不存在/);
});

test('ready 打开以 config.enabled 为准，禁用项不触发 start', async (t) => {
  const h = harness(t, { responder: () => res(202, { accepted: true, operationId: 'op-1' }) });
  const disabled = hostView({
    name: 'config-disabled',
    enabled: true,
    config: { ...hostView().config, enabled: false },
  });
  const enabled = hostView({
    name: 'config-enabled',
    enabled: false,
    config: { ...hostView().config, enabled: true },
  });
  h.store.applySnapshot({ revision: 1, hosts: [disabled, enabled], logs: [] });

  h.actions.openHost(disabled.name);
  await Promise.resolve();
  assert.equal(h.calls.length, 0, 'config.enabled=false 时旧 enabled=true 也不能拉起');

  h.actions.openHost(enabled.name);
  await Promise.resolve();
  assert.deepEqual(
    h.calls.map((call) => [call.method, call.path]),
    [['POST', '/api/hosts/config-enabled/start']],
    'config.enabled=true 时旧 enabled=false 不得覆盖新字段',
  );
  assert.deepEqual(h.navigated, ['#/host/config-disabled', '#/host/config-enabled']);
});
