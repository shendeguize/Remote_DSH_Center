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

test('批量配置应用：响应不覆盖 store，随后 revision SSE 才推进配置真相', async (t) => {
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
  });

  assert.deepEqual(h.calls[0].body, { source: 'gpu-1', targets: ['gpu-2'], dryRun: false });
  assert.equal(h.store.getHost('gpu-2').config.workdir, original.config.workdir,
    '无 revision 的 apply 响应不得覆盖当前 store');
  assert.equal(h.store.state.toasts.at(-1).level, 'success');
  assert.equal(h.store.state.toasts.at(-1).summary, '已同步 1 台主机配置');

  h.store.applyHostChanged({ revision: 2, host: updated });
  assert.equal(h.store.getHost('gpu-2').config.workdir, '/srv/shared',
    '带 revision 的 SSE 才能推进 host/config');
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
  });
  const newest = hostView({
    name: 'gpu-2',
    config: { ...hostView().config, workdir: '/srv/newest-sse' },
  });
  h.store.applyHostChanged({ revision: 2, host: newest });
  release();
  await request;

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

  await h.actions.syncConfig({ source: 'gpu-1', targets: ['gpu-2'], dryRun: false });

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
