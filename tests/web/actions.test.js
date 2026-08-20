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
    calls.push({ path, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : null });
    return responder({ path, method: init.method ?? 'GET' });
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

test('同主机冲突动作不重复提交', async (t) => {
  const h = harness(t, { responder: () => res(202, { accepted: true, operationId: 'op-1' }) });
  seed(h.store);

  await h.actions.hostAction('start', 'gpu-1');
  await h.actions.hostAction('start', 'gpu-1');
  assert.equal(h.calls.length, 1);
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

test('关停需二次确认，取消则不发请求', async (t) => {
  const h = harness(t, { responder: () => res(202, { accepted: true, operationId: 'op-1' }), confirmAnswer: false });
  seed(h.store, { phase: 'running', web: { pid: 4242, port: 8899, startedByUs: true, startedAt: null } });

  await h.actions.hostAction('stop', 'gpu-1');
  assert.equal(h.calls.length, 0);
  assert.equal(h.confirms.length, 1);
  assert.match(h.confirms[0].lines.join(' '), /4242/, '确认文案要给出 PID');
  assert.match(h.confirms[0].lines.join(' '), /指纹校验/, '要说明只杀自己拉起的进程');
});

test('手动实例禁 stop：不确认、不发请求', async (t) => {
  const h = harness(t, { responder: () => res(202, { accepted: true }) });
  seed(h.store, { phase: 'running', web: { pid: 9, port: 8899, startedByUs: false, startedAt: null } });

  await h.actions.hostAction('stop', 'gpu-1');
  assert.equal(h.calls.length, 0);
  assert.equal(h.confirms.length, 0);
  assert.equal(h.store.state.toasts.at(-1).level, 'warn');
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

test('saveDefaults 提示端口需重启生效', async (t) => {
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
  assert.equal(h.store.state.manager.info.port, 7799);
  assert.match(h.store.state.toasts.at(-1).summary, /重启/);
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
  assert.equal(h.store.state.toasts.at(-1).level, 'error');
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
