import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import {
  assertRest,
  workspaceRegisterResponse,
} from '../contract/schemas.js';
import {
  bootServer,
  store,
  tunnel,
  waitPhase,
} from './helpers.js';

const HOST = 'gpu-1';

function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

test('远端 Workspace：真实隧道登记幂等且不改 manager 状态', async (t) => {
  const ctx = await bootServer(t, {
    hostConfig: { [HOST]: { workdir: '~/proj' } },
  });
  const lifecycle = await ctx.sse();
  await lifecycle.wait((frame) => frame.type === 'snapshot');

  const start = await ctx.api('POST', `/api/hosts/${HOST}/start`);
  assert.equal(start.status, 202, start.text);
  await lifecycle.wait(
    (frame) => frame.type === 'operation-done'
      && frame.data.operationId === start.json.operationId,
  );
  const running = await waitPhase(ctx, HOST, 'running');
  assert.equal(running.config.workdir, '~/proj');
  assert.equal(running.web.workdir, '~/proj');
  assert.equal(running.web.cwd, '/root/proj');
  assert.equal(running.tunnel.connected, true);
  assert.notEqual(running.tunnel.localPort, ctx.remotePortOf(HOST));
  assert.ok(
    ctx.harness.transportCalls().some(
      (call) => call.transport === 'ssh' && call.kind === 'tunnel',
    ),
    '远端主机必须实际建立 fake-ssh 隧道',
  );

  const health = await fetch(`${running.mappedUrl}api/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true, label: HOST });

  const sideEffects = await ctx.sse();
  await sideEffects.wait((frame) => frame.type === 'snapshot');
  const beforeFrames = sideEffects.frames.length;
  const beforeHosts = (await ctx.get('/api/hosts')).json;
  const beforeConfig = (await ctx.get('/api/config')).json;
  const beforeRevision = store.currentRevision();

  const injected = await ctx.api(
    'POST',
    `/api/hosts/${HOST}/dsh-workspace`,
    { path: '/tmp/injected' },
  );
  assert.equal(injected.status, 400, injected.text);
  assert.equal(injected.json.code, 'VALIDATION');

  const first = await ctx.api('POST', `/api/hosts/${HOST}/dsh-workspace`, {});
  const firstBody = assertRest(first, {
    status: 200,
    schema: workspaceRegisterResponse,
    label: '首次 Workspace 登记',
  });
  assert.equal(first.headers['cache-control'], 'no-store');
  assert.equal(firstBody.created, true, '注入请求不得在上游预登记路径');
  assert.equal(firstBody.title, 'proj');
  assert.equal(firstBody.path, '/root/proj');

  const second = await ctx.api('POST', `/api/hosts/${HOST}/dsh-workspace`, {});
  const secondBody = assertRest(second, {
    status: 200,
    schema: workspaceRegisterResponse,
    label: '幂等 Workspace 登记',
  });
  assert.equal(second.headers['cache-control'], 'no-store');
  assert.equal(secondBody.created, false);
  assert.equal(secondBody.workspaceId, firstBody.workspaceId);
  assert.equal(secondBody.path, firstBody.path);
  assert.equal(secondBody.title, firstBody.title);

  await delay(75);
  assert.deepEqual((await ctx.get('/api/hosts')).json, beforeHosts, '登记不得改 HostView');
  assert.deepEqual((await ctx.get('/api/config')).json, beforeConfig, '登记不得改配置');
  assert.equal(store.currentRevision(), beforeRevision, '登记不得推进 revision');
  assert.equal(sideEffects.frames.length, beforeFrames, '登记不得广播 SSE');

  const changed = await ctx.api('PUT', `/api/hosts/${HOST}/config`, {
    workdir: '/root/next',
  });
  assert.equal(changed.status, 200, changed.text);
  assert.equal(changed.json.host.config.workdir, '/root/next');
  assert.equal(changed.json.host.web.workdir, '~/proj');
  await sideEffects.wait(
    (frame) => frame.type === 'host-changed'
      && frame.data.host.config.workdir === '/root/next',
  );
  const pendingRevision = store.currentRevision();
  const pendingFrames = sideEffects.frames.length;

  const pending = await ctx.api('POST', `/api/hosts/${HOST}/dsh-workspace`, {});
  assert.equal(pending.status, 409, pending.text);
  assert.equal(pending.json.code, 'PHASE_CONFLICT');
  await delay(75);
  assert.equal(store.currentRevision(), pendingRevision);
  assert.equal(sideEffects.frames.length, pendingFrames);

  const restart = await ctx.api('POST', `/api/hosts/${HOST}/restart`);
  assert.equal(restart.status, 202, restart.text);
  await sideEffects.wait(
    (frame) => frame.type === 'operation-done'
      && frame.data.operationId === restart.json.operationId,
  );
  const restarted = await waitPhase(ctx, HOST, 'running');
  assert.equal(restarted.web.workdir, '/root/next');
  assert.equal(restarted.web.cwd, '/root/next');

  const afterRestart = await ctx.api('POST', `/api/hosts/${HOST}/dsh-workspace`, {});
  const restartedBody = assertRest(afterRestart, {
    status: 200,
    schema: workspaceRegisterResponse,
    label: '重启后 Workspace 登记',
  });
  assert.equal(restartedBody.created, true);
  assert.equal(restartedBody.path, '/root/next');
  assert.equal(restartedBody.title, 'next');

  const nulled = await ctx.api('PUT', `/api/hosts/${HOST}/config`, { workdir: null });
  assert.equal(nulled.status, 200, nulled.text);
  await sideEffects.wait(
    (frame) => frame.type === 'host-changed'
      && frame.data.host.config.workdir === null,
  );
  const withoutWorkdir = await ctx.api('POST', `/api/hosts/${HOST}/dsh-workspace`, {});
  assert.equal(withoutWorkdir.status, 400, withoutWorkdir.text);
  assert.equal(withoutWorkdir.json.code, 'WORKSPACE_WORKDIR_REQUIRED');

  const reapplied = await ctx.api('PUT', `/api/hosts/${HOST}/config`, {
    workdir: '/root/next',
  });
  assert.equal(reapplied.status, 200, reapplied.text);
  assert.equal(reapplied.json.host.web.workdir, '/root/next');

  const releasedPort = reapplied.json.host.tunnel.localPort;
  await tunnel.close(HOST);
  store.setPhase(HOST, 'degraded', 'workspace-disconnected-integration');
  const degraded = store.getHostView(HOST);
  assert.equal(degraded.phase, 'degraded');
  assert.equal(degraded.tunnel.connected, false);
  assert.equal(degraded.mappedUrl, `http://127.0.0.1:${releasedPort}/`);

  let releasedPortRequests = 0;
  const releasedPortTrap = http.createServer((req, res) => {
    releasedPortRequests += 1;
    req.resume();
    res.writeHead(500);
    res.end();
  });
  await new Promise((resolve, reject) => {
    releasedPortTrap.once('error', reject);
    releasedPortTrap.listen(releasedPort, '127.0.0.1', resolve);
  });
  try {
    const disconnected = await ctx.api('POST', `/api/hosts/${HOST}/dsh-workspace`, {});
    assert.equal(disconnected.status, 409, disconnected.text);
    assert.equal(disconnected.json.code, 'PHASE_CONFLICT');
    assert.equal(releasedPortRequests, 0, '不得请求已释放、可能被其他进程复用的映射端口');
  } finally {
    await new Promise((resolve) => releasedPortTrap.close(resolve));
  }

  const stop = await ctx.api('POST', `/api/hosts/${HOST}/stop`);
  assert.equal(stop.status, 202, stop.text);
  await sideEffects.wait(
    (frame) => frame.type === 'operation-done'
      && frame.data.operationId === stop.json.operationId,
  );
  await waitPhase(ctx, HOST, 'ready');
});
