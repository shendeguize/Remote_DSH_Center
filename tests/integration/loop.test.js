/**
 * M3 验收：探测 → 拉起 → 隧道 → 关停 闭环（14 §3 主干流程 1）。
 * 全程只经 REST/SSE，远端为假装置——与 curl 手工走查等价，但可重复自动跑。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { bootServer, fetchText, waitPhase } from './helpers.js';
import {
  accepted, assertMappedUrlConsistency, assertRest, configBody, hostsList, managerInfo,
} from '../contract/schemas.js';

test('探测 → 拉起 → 隧道可用 → 关停：全程经 REST，远端进程与本机隧道均落地', async (t) => {
  const ctx = await bootServer(t, { hosts: { 'gpu-1': undefined } });

  assertRest(await ctx.get('/api/manager/info'), { status: 200, schema: managerInfo, label: 'GET info' });

  // 1. 启动序列已完成首轮探测
  const listed = await ctx.get('/api/hosts');
  assertRest(listed, { status: 200, schema: hostsList, label: 'GET /api/hosts' });
  assert.equal(listed.json.hosts.length, 1);
  const initial = listed.json.hosts[0];
  assert.equal(initial.phase, 'ready');
  assert.equal(initial.probe.profileWeb, true);
  assert.equal(initial.mappedUrl, null, '未拉起时不给 iframe 地址');
  assert.equal(initial.effectiveRemotePort, ctx.remotePortOf('gpu-1'));

  const events = await ctx.sse();
  const snapshot = await events.wait((f) => f.type === 'snapshot');
  assert.equal(snapshot.data.hosts.length, 1);
  assert.equal(snapshot.data.manager.setupCompleted, true);

  // 2. 拉起：202 受理 → operation-done(ok) → running
  const started = await ctx.api('POST', '/api/hosts/gpu-1/start');
  assertRest(started, { status: 202, schema: accepted, label: 'POST start' });
  assert.equal(started.json.host, 'gpu-1');

  const done = await events.wait((f) => f.type === 'operation-done' && f.data.operationId === started.json.operationId);
  assert.equal(done.data.status, 'ok', done.data.error ?? '');
  assert.equal(done.data.action, 'start');

  const running = await waitPhase(ctx, 'gpu-1', 'running');
  assert.equal(running.web.startedByUs, true);
  assert.equal(running.web.port, ctx.remotePortOf('gpu-1'), '固定端口路径：actualPort 即约定端口');
  assert.ok(running.web.cmdFingerprint.startsWith('dsh web --no-open'));
  assert.equal(running.tunnel.connected, true);
  assertMappedUrlConsistency(running);

  // 3. 隧道真的通：经本机映射端口打到假 dsh web
  const page = await fetchText(running.mappedUrl);
  assert.equal(page.status, 200);
  assert.match(page.text, /gpu-1/);

  const live = ctx.harness.liveProcesses('gpu-1');
  assert.equal(live.length, 1);
  assert.equal(live[0].pid, running.web.pid);

  // 4. 关停：远端进程消失、隧道端口不再可连、state 清空
  const stopped = await ctx.api('POST', '/api/hosts/gpu-1/stop');
  assert.equal(stopped.status, 202);
  const stopDone = await events.wait((f) => f.type === 'operation-done' && f.data.operationId === stopped.json.operationId);
  assert.equal(stopDone.data.status, 'ok', stopDone.data.error ?? '');

  const afterStop = await waitPhase(ctx, 'gpu-1', 'ready');
  assert.equal(afterStop.web, null);
  assert.equal(afterStop.tunnel, null);
  assert.equal(afterStop.mappedUrl, null);
  assert.equal(ctx.harness.liveProcesses('gpu-1').length, 0);
  await assert.rejects(() => fetchText(`http://127.0.0.1:${running.tunnel.localPort}/`));
});

test('localPort 一次分配后固定：重启复用同一本机端口', async (t) => {
  const ctx = await bootServer(t);

  await ctx.api('POST', '/api/hosts/gpu-1/start');
  const first = await waitPhase(ctx, 'gpu-1', 'running');
  const port = first.tunnel.localPort;
  const cfg = await ctx.get('/api/config');
  assertRest(cfg, { status: 200, schema: configBody, label: 'GET /api/config' });
  assert.equal(cfg.json.hosts['gpu-1'].localPort, port, '分配即回写 config');

  const restarted = await ctx.api('POST', '/api/hosts/gpu-1/restart');
  assert.equal(restarted.status, 202);
  const events = await ctx.sse();
  const done = await events.wait((f) => f.type === 'operation-done' && f.data.operationId === restarted.json.operationId);
  assert.equal(done.data.status, 'ok', done.data.error ?? '');

  const second = await waitPhase(ctx, 'gpu-1', 'running');
  assert.equal(second.tunnel.localPort, port);
  assert.notEqual(second.web.pid, first.web.pid, '远端换了新进程');
  assert.equal((await fetchText(second.mappedUrl)).status, 200);
});

test('多主机并发拉起互不干扰（各自 localPort 与远端端口）', async (t) => {
  const ctx = await bootServer(t, { hosts: { 'gpu-1': undefined, 'gpu-2': undefined } });

  const accepted = await Promise.all(ctx.hostNames.map((n) => ctx.api('POST', `/api/hosts/${n}/start`)));
  assert.deepEqual(accepted.map((r) => r.status), [202, 202]);

  const views = await Promise.all(ctx.hostNames.map((n) => waitPhase(ctx, n, 'running')));
  const localPorts = views.map((v) => v.tunnel.localPort);
  assert.equal(new Set(localPorts).size, 2, '本机端口不撞');
  for (const v of views) {
    assert.equal((await fetchText(v.mappedUrl)).status, 200);
  }
});
