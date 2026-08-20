/**
 * TST-04 主干流程（三）：setup 门禁与 POST /api/setup 提交（13 §4、02 §3.0）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { bootServer, waitPhase } from './helpers.js';
import { SCENARIOS } from '../harness/scenarios.js';
import {
  accepted, assertRest, configBody, hostsList, managerInfo, setupResponse,
} from '../contract/schemas.js';

/** 向导第 4 步产物：整份 config。 */
function setupBody(ctx, { port, autoStart = [] } = {}) {
  return {
    setupCompleted: false, // 后端强制置 true，请求体给什么都忽略
    manager: { port },
    defaults: { remoteWebPort: 8899, localPortRange: [24_101, 24_140] },
    hosts: Object.fromEntries(ctx.hostNames.map((n) => [n, {
      enabled: true,
      autoStart: autoStart.includes(n),
      localPort: null,
      remoteWebPort: ctx.remotePortOf(n),
      inject: { env: {}, extraArgs: [], patches: [] },
    }])),
  };
}

test('未初始化：白名单可用、其余 409 SETUP_REQUIRED', async (t) => {
  const ctx = await bootServer(t, { setupCompleted: false });
  assert.equal(ctx.setupGate, true);

  const info = await ctx.get('/api/manager/info');
  assertRest(info, { status: 200, schema: managerInfo, label: 'GET info' });
  assert.equal(info.json.setupCompleted, false);
  assert.equal(info.json.setupGateActive, true);

  // 白名单：主机清单（来自 ssh config 合并）、只读 config、全量探测、SSE
  const hosts = await ctx.get('/api/hosts');
  assertRest(hosts, { status: 200, schema: hostsList, label: 'GET /api/hosts' });
  assert.deepEqual(hosts.json.hosts.map((h) => h.name), ['gpu-1']);
  assertRest(await ctx.get('/api/config'), { status: 200, schema: configBody, label: 'GET /api/config' });

  const events = await ctx.sse();
  await events.wait((f) => f.type === 'snapshot');

  const probeAll = await ctx.api('POST', '/api/hosts/probe');
  assertRest(probeAll, { status: 202, schema: accepted, label: 'POST probe-all' });
  await events.wait((f) => f.type === 'operation-done' && f.data.operationId === probeAll.json.operationId);
  assert.equal((await waitPhase(ctx, 'gpu-1', 'ready')).phase, 'ready', '向导第 3 步据此显示可勾选');

  // 门禁外的一切
  for (const [method, path] of [
    ['POST', '/api/hosts/gpu-1/start'],
    ['POST', '/api/hosts/gpu-1/probe'],
    ['PUT', '/api/hosts/gpu-1/config'],
    ['PUT', '/api/config/defaults'],
    ['POST', '/api/reload'],
    ['GET', '/api/hosts/gpu-1/log'],
  ]) {
    const res = await ctx.api(method, path, method === 'PUT' ? {} : undefined);
    assert.equal(res.status, 409, `${method} ${path} 应被门禁拦截`);
    assert.equal(res.json.code, 'SETUP_REQUIRED');
  }
});

test('提交 setup：端口未变 → 撤门禁并热切换，autoStart 生效', async (t) => {
  const ctx = await bootServer(t, { setupCompleted: false, hosts: { 'gpu-1': SCENARIOS.healthy() } });

  const bad = await ctx.api('POST', '/api/setup', { manager: { port: 70_000 } });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.code, 'VALIDATION');
  assert.match(bad.json.detail, /manager\.port/);

  const res = await ctx.api('POST', '/api/setup', setupBody(ctx, { port: ctx.port, autoStart: ['gpu-1'] }));
  assertRest(res, { status: 200, schema: setupResponse, label: 'POST /api/setup' });
  assert.deepEqual(
    { ok: res.json.ok, portChanged: res.json.portChanged, restartRequired: res.json.restartRequired },
    { ok: true, portChanged: false, restartRequired: false },
  );

  const info = await ctx.get('/api/manager/info');
  assert.equal(info.json.setupCompleted, true);
  assert.equal(info.json.setupGateActive, false, '门禁已撤');

  const saved = await ctx.get('/api/config');
  assert.equal(saved.json.setupCompleted, true, '后端强制置 true');
  assert.equal(saved.json.defaults.localPortRange[0], 24_101);

  // 撤门禁后其余端点恢复；autoStart 勾选的主机被补跑拉起
  const running = await waitPhase(ctx, 'gpu-1', 'running', { timeoutMs: 20_000 });
  assert.equal(running.tunnel.connected, true);
  assert.ok(running.tunnel.localPort >= 24_101 && running.tunnel.localPort <= 24_140);
});

test('提交 setup：端口改动 + 前台模式 → restartRequired，配置已落盘', async (t) => {
  const ctx = await bootServer(t, { setupCompleted: false });

  const res = await ctx.api('POST', '/api/setup', setupBody(ctx, { port: 7999 }));
  assertRest(res, { status: 200, schema: setupResponse, label: 'POST /api/setup' });
  assert.equal(res.json.port, 7999);
  assert.equal(res.json.portChanged, true);
  assert.equal(res.json.restartRequired, true, '前台模式不自我重启（02 §9.4）');
  assert.equal(res.json.restarting, false);

  assert.equal((await ctx.get('/api/config')).json.manager.port, 7999);

  // 重启后按新配置起来（这里用同一 DSHC_HOME 重跑启动序列）
  await ctx.reboot();
  const info = await ctx.get('/api/manager/info');
  assert.equal(info.json.setupGateActive, false);
  assert.equal((await ctx.get('/api/hosts')).json.hosts[0].phase, 'ready');
});
