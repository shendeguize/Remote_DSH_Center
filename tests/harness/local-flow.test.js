import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import { createHarness } from './index.js';
import { newFactoryConfig, newHostConfig } from '../../src/defaults.js';
import * as bus from '../../src/lib/bus.js';
import * as ssh from '../../src/lib/ssh.js';
import * as launcher from '../../src/launcher.js';
import * as monitor from '../../src/monitor.js';
import { hashFile, remoteName } from '../../src/patchsync.js';
import * as ports from '../../src/ports.js';
import { probeHost } from '../../src/prober.js';
import { readDshSettings, writeDshSettings } from '../../src/settings-file.js';
import * as store from '../../src/store.js';
import * as tunnel from '../../src/tunnel.js';

const LOCAL_HOST = 'workstation-local';
const FAST_WAIT = (ms) => new Promise((resolve) => {
  const timer = setTimeout(resolve, Math.min(ms, 20));
  timer.unref?.();
});

function configFor(port) {
  const config = newFactoryConfig();
  config.setupCompleted = true;
  config.defaults.remoteWebPort = port;
  config.defaults.localPortRange = [31_000, 31_000];
  config.hosts[LOCAL_HOST] = {
    ...newHostConfig(),
    local: true,
    localPort: null,
    remoteWebPort: port,
  };
  return config;
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function localFixture(t) {
  const port = await freePort();
  const harness = createHarness({
    local: LOCAL_HOST,
    config: configFor(port),
  });
  const restore = harness.activate();

  store._reset();
  tunnel._reset();
  monitor.stopLoop();
  ssh._resetQueues();
  ssh.reopenSsh();
  bus._resetForTest();
  launcher._setWait(FAST_WAIT);

  let portPoolTouches = 0;
  ports._setProbe(async () => {
    portPoolTouches += 1;
    return true;
  });

  await store.init();
  store.setTunnelStatusProvider(tunnel.status);

  t.after(async () => {
    await tunnel.closeAll();
    monitor.stopLoop();
    store.flushStateSync();
    launcher._setWait(null);
    launcher._setStopTimeout(null);
    ports._setProbe(null);
    ssh._resetQueues();
    tunnel._reset();
    store._reset();
    bus._resetForTest();
    harness.cleanup();
    restore();
  });

  return {
    harness,
    portPoolTouches: () => portPoolTouches,
  };
}

async function startLocal(t) {
  const fixture = await localFixture(t);
  const probed = await probeHost(LOCAL_HOST);
  assert.equal(probed.phase, 'ready');
  assert.equal(store.getPhase(LOCAL_HOST), 'ready');

  const started = await launcher.start(LOCAL_HOST);
  const view = store.getHostView(LOCAL_HOST);
  assert.equal(view.phase, 'running');
  return { ...fixture, started, view };
}

function assertLocalTransportOnly(harness) {
  const calls = harness.transportCalls();
  assert.ok(calls.length > 0, '协议必须真实经过 fake local shell');
  assert.ok(calls.every((call) => call.transport === 'local'), JSON.stringify(calls));
  assert.equal(calls.some((call) => call.kind === 'tunnel'), false, '本机路径不得启动 fake-ssh tunnel child');
}

test('本机 settings：fake-local stdin 走同一 read/write 协议，transport 全为 local', async (t) => {
  const { harness } = await localFixture(t);
  const resolveLocal = () => store.getHostView(LOCAL_HOST).local;
  const content = '\ufeffprovider: synthetic-local\r\nnul: \0\r\n';

  const missing = await readDshSettings(LOCAL_HOST, { resolveLocal });
  assert.deepEqual(missing, {
    exists: false,
    path: path.join(harness.localHomeDir, '.dsh', 'settings.yaml'),
    content: '',
    checksum: null,
    size: 0,
  });

  const written = await writeDshSettings(LOCAL_HOST, {
    resolveLocal,
    content,
    baseChecksum: null,
  });
  assert.equal(written.updated, true);
  assert.equal(written.size, Buffer.byteLength(content));
  assert.equal(Object.hasOwn(written, 'content'), false);

  const loaded = await readDshSettings(LOCAL_HOST, { resolveLocal });
  assert.equal(loaded.content, content);
  assert.equal(loaded.checksum, written.checksum);
  assert.equal(harness.hostState(LOCAL_HOST).settingsMode, 0o600);
  assert.deepEqual(harness.hostState(LOCAL_HOST).backup, {
    previousHex: null,
    absent: true,
    mode: 0o600,
  });
  assert.deepEqual(
    harness.transportCalls().map(({ transport, kind }) => ({ transport, kind })),
    [
      { transport: 'local', kind: 'settings-read' },
      { transport: 'local', kind: 'settings-write' },
      { transport: 'local', kind: 'settings-read' },
    ],
  );
  assert.equal(
    Object.keys(harness.remoteFiles(LOCAL_HOST))
      .some((name) => name.startsWith('.dsh_center_remote/settings-staging/')),
    false,
    '本机 settings 成功路径不得遗留 staging',
  );
  assertLocalTransportOnly(harness);
});

test('本机全链：probe → launch → direct HTTP/HostView → stop', async (t) => {
  const {
    harness, portPoolTouches, started, view,
  } = await startLocal(t);

  assert.equal(started.localPort, started.actualPort);
  assert.equal(view.web.port, started.actualPort);
  assert.equal(view.tunnel.localPort, started.actualPort);
  assert.equal(view.tunnel.connected, true);
  assert.equal(view.mappedUrl, `http://127.0.0.1:${started.actualPort}/`);
  assert.equal(view.web.cwd, harness.localHomeDir, '本机协议的 HOME 使用隔离目录');

  const direct = tunnel.status(LOCAL_HOST);
  assert.equal(direct.direct, true);
  assert.equal(tunnel._childPid(LOCAL_HOST), null, 'direct entry 没有 ssh 子进程');

  const health = await fetch(`${view.mappedUrl}api/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true, label: LOCAL_HOST });

  assert.equal(portPoolTouches(), 0, '本机启动完全跳过映射端口池');
  assert.equal(store.getConfig().hosts[LOCAL_HOST].localPort, null, 'config 不持久化实际 web 端口');
  const kinds = harness.transportCalls().map((call) => call.kind);
  assert.deepEqual(kinds.slice(0, 2), ['probe', 'launch']);
  assert.ok(kinds.slice(2, -1).length >= 1 && kinds.slice(2, -1).every((kind) => kind === 'poll'));
  assert.equal(kinds.at(-1), 'verify');
  assert.equal(kinds.includes('cleanup'), false, '本机 patch 同步永久跳过 cleanup 协议');
  assertLocalTransportOnly(harness);

  const stopped = await launcher.stop(LOCAL_HOST);
  assert.ok(['term', 'force'].includes(stopped.killed));
  const ready = store.getHostView(LOCAL_HOST);
  assert.equal(ready.phase, 'ready');
  assert.equal(ready.web, null);
  assert.equal(ready.tunnel, null);
  assert.equal(ready.mappedUrl, null);
  assert.deepEqual(harness.liveProcesses(LOCAL_HOST), []);
  assert.equal(store.getConfig().hosts[LOCAL_HOST].localPort, null);
  assertLocalTransportOnly(harness);
});

test('本机全链：跨两轮移除碰撞 patch 后不覆盖源且 PATCH_ARGS 内容正确', async (t) => {
  const { harness } = await localFixture(t);
  const patchesDir = path.join(harness.localHomeDir, '.dsh_center_remote', 'patches');
  const sourceA = path.join(harness.root, 'a.yml');
  fs.mkdirSync(patchesDir, { recursive: true });
  fs.writeFileSync(sourceA, 'patch A\n');
  const initialAName = remoteName(await hashFile(sourceA), sourceA);
  const sourceB = path.join(patchesDir, initialAName);
  fs.writeFileSync(sourceB, 'patch B must survive\n');
  store.updateConfig((draft) => {
    draft.hosts[LOCAL_HOST].inject.patches = [sourceA, sourceB];
  });

  const probed = await probeHost(LOCAL_HOST);
  assert.equal(probed.phase, 'ready');
  await launcher.start(LOCAL_HOST);

  const firstProcess = harness.liveProcesses(LOCAL_HOST)[0];
  const safeAName = firstProcess.patches[0];
  assert.notEqual(safeAName, initialAName, '轮1 A 必须避让与 B 源同名的初始目标');
  assert.equal(fs.readFileSync(sourceB, 'utf8'), 'patch B must survive\n');
  assert.equal(fs.readFileSync(path.join(patchesDir, safeAName), 'utf8'), 'patch A\n');
  assert.equal(store.getHostView(LOCAL_HOST).phase, 'running');
  assertLocalTransportOnly(harness);

  await launcher.stop(LOCAL_HOST);
  store.updateConfig((draft) => {
    draft.hosts[LOCAL_HOST].inject.patches = [sourceA];
  });
  await launcher.start(LOCAL_HOST);

  const secondProcess = harness.liveProcesses(LOCAL_HOST)[0];
  assert.deepEqual(secondProcess.patches, [safeAName], '轮2 PATCH_ARGS 必须继续指向 A 的安全目标');
  assert.equal(fs.readFileSync(sourceB, 'utf8'), 'patch B must survive\n', '已移除 B 的源内容不得被覆盖');
  assert.equal(fs.readFileSync(path.join(patchesDir, safeAName), 'utf8'), 'patch A\n');
  assert.equal(
    harness.transportCalls().some((call) => call.kind === 'cleanup'),
    false,
    '移除配置后的再次同步也不得调用 cleanup',
  );
  await launcher.stop(LOCAL_HOST);
  assert.equal(store.getHostView(LOCAL_HOST).phase, 'ready');
});

test('本机巡检：进程崩溃后 direct entry 收敛为 crashed', async (t) => {
  const { harness, view } = await startLocal(t);
  harness.crash(LOCAL_HOST);
  await waitUntil(
    async () => !(await healthResponds(view.mappedUrl)),
    '假 dsh web 退出',
  );

  const checked = await monitor.tick();
  assert.deepEqual(checked.results, [{ host: LOCAL_HOST, outcome: 'crashed' }]);

  const crashed = store.getHostView(LOCAL_HOST);
  assert.equal(crashed.phase, 'crashed');
  assert.equal(crashed.tunnel, null);
  assert.equal(crashed.mappedUrl, null);
  assert.ok(crashed.web, '保留上次实例记录供诊断');
  assert.deepEqual(harness.liveProcesses(LOCAL_HOST), []);
  assertLocalTransportOnly(harness);
});

test('本机停止：PID 复用时指纹不符，拒杀且保留状态与进程', async (t) => {
  const { harness, view } = await startLocal(t);
  const replacement = 'dsh web --no-open --host 127.0.0.1 --port 65530';
  harness.reusePid(LOCAL_HOST, replacement);

  await assert.rejects(
    () => launcher.stop(LOCAL_HOST),
    (err) => err.code === 'KILL_REFUSED' && /指纹不符/.test(err.message),
  );

  const after = store.getHostView(LOCAL_HOST);
  assert.equal(after.phase, 'running');
  assert.equal(after.web.pid, view.web.pid, '拒杀后 state.web 不清');
  assert.equal(after.web.cmdFingerprint, view.web.cmdFingerprint);
  assert.equal(after.tunnel.localPort, view.web.port, '拒杀后 direct state 不清');
  assert.equal(after.tunnel.connected, true);
  assert.equal(after.mappedUrl, view.mappedUrl, '拒杀后 mappedUrl 仍可用');
  assert.equal(tunnel.status(LOCAL_HOST).direct, true, '拒杀后 direct entry 仍登记');
  assert.equal(harness.liveProcesses(LOCAL_HOST).length, 1, 'PID 复用场景的进程仍活着');
  assert.equal(harness.liveProcesses(LOCAL_HOST)[0].args, replacement);
  assert.ok(harness.transportCalls().some((call) => call.kind === 'stop'));
  const checked = await monitor.tick();
  assert.deepEqual(checked.results, [{ host: LOCAL_HOST, outcome: 'ok' }], '巡检不得退化为 no-tunnel');
  assertLocalTransportOnly(harness);
});

test('本机停止：STOP timeout 保留 direct entry，巡检后仍可成功关停', async (t) => {
  const { harness, view } = await startLocal(t);
  const hangingShell = path.join(harness.root, 'hang-local-stop.mjs');
  fs.writeFileSync(hangingShell, 'setInterval(() => {}, 60_000);\n');
  const originalLocalShell = process.env.DSHC_LOCAL_SH_BIN;

  launcher._setStopTimeout(50);
  process.env.DSHC_LOCAL_SH_BIN = `${process.execPath} ${hangingShell}`;
  try {
    await assert.rejects(
      () => launcher.stop(LOCAL_HOST),
      (err) => err.code === 'LOCAL_TIMEOUT' && /超时/.test(err.message),
    );
  } finally {
    process.env.DSHC_LOCAL_SH_BIN = originalLocalShell;
    launcher._setStopTimeout(null);
  }

  const afterTimeout = store.getHostView(LOCAL_HOST);
  assert.equal(afterTimeout.phase, 'running');
  assert.equal(afterTimeout.web.pid, view.web.pid, 'timeout 后 state.web 不清');
  assert.equal(afterTimeout.tunnel.localPort, view.web.port, 'timeout 后 direct state 不清');
  assert.equal(afterTimeout.tunnel.connected, true);
  assert.equal(afterTimeout.mappedUrl, view.mappedUrl, 'timeout 后 mappedUrl 仍可用');
  assert.equal(tunnel.status(LOCAL_HOST).direct, true, 'timeout 后 direct entry 仍登记');
  assert.equal(harness.liveProcesses(LOCAL_HOST).length, 1, 'timeout 不应误停本机进程');

  const checked = await monitor.tick();
  assert.deepEqual(checked.results, [{ host: LOCAL_HOST, outcome: 'ok' }], '巡检不得退化为 no-tunnel');

  const stopped = await launcher.stop(LOCAL_HOST);
  assert.ok(['term', 'force'].includes(stopped.killed));
  const ready = store.getHostView(LOCAL_HOST);
  assert.equal(ready.phase, 'ready');
  assert.equal(ready.web, null);
  assert.equal(ready.tunnel, null);
  assert.equal(ready.mappedUrl, null);
  assert.equal(tunnel.status(LOCAL_HOST), null, '成功 STOP 后才清 direct entry');
  assert.deepEqual(harness.liveProcesses(LOCAL_HOST), []);
  assertLocalTransportOnly(harness);
});

async function healthResponds(url) {
  try {
    const response = await fetch(`${url}api/health`, { signal: AbortSignal.timeout(300) });
    return response.status === 200;
  } catch {
    return false;
  }
}

async function waitUntil(predicate, label, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop -- 等待 detached 假进程退出
    if (await predicate()) return;
    if (Date.now() >= deadline) throw new Error(`等待「${label}」超时`);
    // eslint-disable-next-line no-await-in-loop -- 同上
    await new Promise((resolve) => { setTimeout(resolve, 25); });
  }
}
