/**
 * tunnel 的纯函数面（11 §5.3 分类表、§5.4 退避序列）——喂样本即可断言，不起子进程。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { newFactoryConfig, newHostConfig, resolvePaths } from '../src/defaults.js';
import { _resetQueues, reopenSsh } from '../src/lib/ssh.js';
import * as launcher from '../src/launcher.js';
import * as monitor from '../src/monitor.js';
import * as store from '../src/store.js';
import * as tunnel from '../src/tunnel.js';

const {
  TUNNEL_TIMING, backoffDelay, classifyExit, isForwardDeniedLine,
} = tunnel;

const CEILINGS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000];
const ATTEMPTS = [0, 1, 2, 3, 4, 5, 6, 10];
const LOCAL_NAME = 'local-host';
const FINGERPRINT = 'dsh web --no-open --host 127.0.0.1 --port 19001';

async function closeServer(server) {
  if (!server.listening) return;
  await new Promise((resolve) => server.close(resolve));
}

async function listenHttp() {
  const server = net.createServer((socket) => {
    socket.once('data', () => {
      socket.end('HTTP/1.0 200 OK\r\nContent-Length: 0\r\n\r\n');
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    server,
    port: /** @type {import('node:net').AddressInfo} */ (server.address()).port,
  };
}

async function unusedPort() {
  const { server, port } = await listenHttp();
  await closeServer(server);
  return port;
}

async function waitUntil(predicate, label, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop -- 等待子进程生命周期收敛
    if (await predicate()) return;
    if (Date.now() >= deadline) throw new Error(`等待「${label}」超时`);
    // eslint-disable-next-line no-await-in-loop -- 同上
    await new Promise((resolve) => { setTimeout(resolve, 20); });
  }
}

/**
 * 给 recover/monitor 建一份本机 HostView 与可记录运输调用的本地 shell 垫片。
 * @param {import('node:test').TestContext} t
 * @param {{port:number, alive?:boolean}} p
 */
async function localRuntime(t, { port, alive = true }) {
  await tunnel.closeAll();
  tunnel._reset();
  store._reset();
  reopenSsh();

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-tunnel-direct-'));
  const callsFile = path.join(dir, 'calls.ndjson');
  const runner = path.join(dir, 'transport.mjs');
  fs.writeFileSync(runner, [
    "import fs from 'node:fs';",
    'const [kind, mark] = process.argv.slice(2);',
    "fs.appendFileSync(mark, `${JSON.stringify({ kind, args: process.argv.slice(4) })}\\n`);",
    "if (kind === 'ssh') { process.stderr.write('ssh must not run\\n'); process.exit(70); }",
    alive
      ? `process.stdout.write(${JSON.stringify(`ALIVE=yes\nARGS<<EOF\n${FINGERPRINT}\nEOF\nLISTEN=yes\nCWD=/tmp/local\nVERIFY_DONE=yes\n`)});`
      : "process.stdout.write('ALIVE=no\\nLISTEN=no\\nCWD=unknown\\nVERIFY_DONE=yes\\n');",
  ].join('\n'));

  const saved = {
    DSHC_LOCAL_SH_BIN: process.env.DSHC_LOCAL_SH_BIN,
    DSHC_SSH_BIN: process.env.DSHC_SSH_BIN,
  };
  process.env.DSHC_LOCAL_SH_BIN = `${process.execPath} ${runner} local ${callsFile}`;
  process.env.DSHC_SSH_BIN = `${process.execPath} ${runner} ssh ${callsFile}`;

  const config = newFactoryConfig();
  config.setupCompleted = true;
  config.hosts[LOCAL_NAME] = {
    ...newHostConfig(),
    local: true,
    localPort: null,
  };
  fs.writeFileSync(path.join(dir, 'config.json'), `${JSON.stringify(config, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, 'state.json'), `${JSON.stringify({
    hosts: {
      [LOCAL_NAME]: {
        phase: 'running',
        probe: null,
        web: {
          pid: 43210,
          port,
          startedByUs: true,
          cmdFingerprint: FINGERPRINT,
          log: 'web-19001.log',
          startedAt: new Date(0).toISOString(),
        },
        // 模拟上一代 manager 留下的可丢弃线索；recover 必须以 web.port 重建 direct。
        tunnel: { localPort: 17701, remotePort: port, openedAt: new Date(0).toISOString() },
        patchSync: { files: {} },
        manualInstances: [],
      },
    },
  }, null, 2)}\n`);

  await store.init({ pathsOverride: resolvePaths({ DSHC_HOME: dir }, os.homedir()) });
  store.setTunnelStatusProvider(tunnel.status);

  t.after(async () => {
    await tunnel.closeAll();
    tunnel._reset();
    store._reset();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  return {
    calls() {
      if (!fs.existsSync(callsFile)) return [];
      return fs.readFileSync(callsFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
    },
  };
}

async function remoteTunnelRuntime(t, { port }) {
  await tunnel.closeAll();
  tunnel._reset();
  store._reset();
  _resetQueues();
  reopenSsh();

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-tunnel-remote-'));
  const callsFile = path.join(dir, 'starts.log');
  const runner = path.join(dir, 'tunnel.mjs');
  fs.writeFileSync(runner, [
    "import fs from 'node:fs';",
    "import net from 'node:net';",
    'const args = process.argv.slice(2);',
    `fs.appendFileSync(${JSON.stringify(callsFile)}, 'start\\n');`,
    "const forward = args[args.indexOf('-L') + 1];",
    "const localPort = Number(forward.split(':')[1]);",
    'const server = net.createServer((socket) => socket.destroy());',
    "server.listen(localPort, '127.0.0.1');",
    "process.on('SIGUSR1', () => process.exit(255));",
    "process.on('SIGTERM', () => process.exit(0));",
  ].join('\n'));

  const savedSsh = process.env.DSHC_SSH_BIN;
  process.env.DSHC_SSH_BIN = `${process.execPath} ${runner}`;
  const config = newFactoryConfig();
  config.setupCompleted = true;
  config.hosts['gpu-1'] = { ...newHostConfig(), localPort: port };
  fs.writeFileSync(path.join(dir, 'config.json'), `${JSON.stringify(config, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, 'state.json'), `${JSON.stringify({
    hosts: {
      'gpu-1': {
        phase: 'running',
        probe: null,
        web: {
          pid: 43210,
          port: 19001,
          startedByUs: true,
          cmdFingerprint: FINGERPRINT,
          log: 'web-19001.log',
          startedAt: new Date(0).toISOString(),
        },
        tunnel: null,
        patchSync: { files: {} },
        manualInstances: [],
      },
    },
  }, null, 2)}\n`);
  await store.init({ pathsOverride: resolvePaths({ DSHC_HOME: dir }, os.homedir()) });
  store.setTunnelStatusProvider(tunnel.status);

  t.after(async () => {
    await tunnel.closeAll();
    tunnel._reset();
    store._reset();
    _resetQueues();
    reopenSsh();
    if (savedSsh === undefined) delete process.env.DSHC_SSH_BIN;
    else process.env.DSHC_SSH_BIN = savedSsh;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  return {
    starts() {
      if (!fs.existsSync(callsFile)) return 0;
      return fs.readFileSync(callsFile, 'utf8').trim().split('\n').filter(Boolean).length;
    },
  };
}

test('backoffDelay：1,2,4,8,16,30,30… 秒封顶 30s（作为上界）', () => {
  assert.deepEqual(ATTEMPTS.map((n) => backoffDelay(n, () => 1)), CEILINGS);
});

/**
 * 抖动（issue #100）：确定值意味着一起断的主机锁着步一起重试，每轮都同时撞在
 * 跳板机的 MaxStartups 上——实测 16 台同时断，70 秒后仍有 6 台卡着且 attempt 全等。
 */
test('backoffDelay 带抖动：落在半程到满程之间，且真的会变（issue #100）', () => {
  assert.deepEqual(
    ATTEMPTS.map((n) => backoffDelay(n, () => 0)),
    CEILINGS.map((c) => c / 2),
    '最短也要有半程：全 0 抖动等于没退避，断链瞬间会变成打桩',
  );

  for (const n of ATTEMPTS) {
    const seen = new Set(Array.from({ length: 200 }, () => backoffDelay(n)));
    assert.ok(seen.size > 1, `attempt=${n} 每次都给同一个值，等于没抖`);
    for (const v of seen) {
      assert.ok(v >= CEILINGS[ATTEMPTS.indexOf(n)] / 2, `${v} 低于半程`);
      assert.ok(v <= CEILINGS[ATTEMPTS.indexOf(n)], `${v} 超过了 §5.4 的上界`);
    }
  }
});

test('分类优先级 1：主动杀一律 expected（close/closeAll/restartChild/stop）', () => {
  assert.equal(classifyExit({ killedByUs: true, stderrTail: 'Address already in use' }), 'expected');
  assert.equal(classifyExit({ killedByUs: true, forcedReason: 'forward-disabled' }), 'expected');
});

test('分类优先级 2：本机端口被占（真 ssh 两种文案）', () => {
  const samples = [
    'bind [127.0.0.1]:17701: Address already in use\nchannel_setup_fwd_listener_tcpip: cannot listen to port: 17701',
    'bind: address already in use',
    'channel_setup_fwd_listener_tcpip: cannot listen to port: 17701',
  ];
  for (const stderrTail of samples) {
    assert.equal(classifyExit({ stderrTail }), 'local-port-busy', stderrTail);
  }
});

test('分类优先级 3：远端禁止转发', () => {
  const samples = [
    'channel 2: open failed: administratively prohibited: open failed',
    'Forwarding disabled by server',
    'forwarding request failed',
  ];
  for (const stderrTail of samples) {
    assert.equal(classifyExit({ stderrTail }), 'forward-disabled', stderrTail);
  }
});

test('分类优先级 4：其余归 network（进退避重连环）', () => {
  for (const stderrTail of [
    '',
    'Connection to 10.0.0.1 closed by remote host.',
    'client_loop: send disconnect: Broken pipe',
    'ssh: connect to host x port 22: Operation timed out',
    'Timeout, server 10.0.0.1 not responding.',
  ]) {
    assert.equal(classifyExit({ stderrTail }), 'network', stderrTail);
  }
  assert.equal(classifyExit(), 'network', '缺参数时按 network（宁可多试一拍）');
});

test('forcedReason 优先于 stderr 内容（运行中判定已下结论）', () => {
  assert.equal(classifyExit({ forcedReason: 'forward-disabled', stderrTail: 'Broken pipe' }), 'forward-disabled');
});

test('isForwardDeniedLine：只认转发被拒，不误伤普通报错', () => {
  assert.equal(isForwardDeniedLine('channel 3: open failed: administratively prohibited: open failed'), true);
  assert.equal(isForwardDeniedLine('debug1: Connection established.'), false);
  assert.equal(isForwardDeniedLine('bind [127.0.0.1]:17701: Address already in use'), false);
});

test('时间常量符合 §5.2/§5.3 约定', () => {
  assert.equal(TUNNEL_TIMING.readyTimeoutMs, 8_000);
  assert.equal(TUNNEL_TIMING.readyPollMs, 250);
  assert.equal(TUNNEL_TIMING.denyThreshold, 3);
  assert.equal(TUNNEL_TIMING.denyWindowMs, 60_000);
});

test('direct open：恒等端口、无 ssh child、状态可序列化，close/closeAll 只清账', async () => {
  tunnel._reset();
  store._reset();

  const { server, port } = await listenHttp();
  try {
    const opened = await tunnel.open('-无需经过-ssh-host-校验', {
      localPort: port,
      remotePort: port,
      direct: true,
    });
    assert.deepEqual(opened, {
      localPort: port,
      connected: true,
      reconnectAttempt: 0,
      suspendedReason: null,
      direct: true,
    });
    assert.deepEqual(JSON.parse(JSON.stringify(opened)), opened, 'direct 标识必须可序列化');
    assert.equal(tunnel.isOpen('-无需经过-ssh-host-校验'), true);
    assert.deepEqual(tunnel.listOpen(), ['-无需经过-ssh-host-校验']);
    assert.equal(tunnel._childPid('-无需经过-ssh-host-校验'), null, '直连不得伪装成 ssh child');
    assert.equal(store.getHostState('-无需经过-ssh-host-校验').tunnel.direct, true);

    await tunnel.close('-无需经过-ssh-host-校验');
    assert.equal(tunnel.status('-无需经过-ssh-host-校验'), null);
    assert.equal(await tunnel.probeForward(port, 500), true, '清直连账不能顺带关停 dsh web');

    await tunnel.open('local-a', { localPort: port, remotePort: port, direct: true });
    await tunnel.open('local-b', { localPort: port, remotePort: port, direct: true });
    await tunnel.closeAll();
    assert.deepEqual(tunnel.listOpen(), []);
  } finally {
    await closeServer(server);
    tunnel._reset();
    store._reset();
  }
});

test('direct open 拒绝非恒等或非法端口，且不破坏已有条目', async () => {
  tunnel._reset();
  store._reset();
  await tunnel.open('local', { localPort: 19001, remotePort: 19001, direct: true });

  await assert.rejects(
    () => tunnel.open('local', { localPort: 19001, remotePort: 19002, direct: true }),
    (err) => err?.code === 'VALIDATION' && /端口.*一致/.test(err.message),
  );
  assert.equal(tunnel.status('local').localPort, 19001);

  await assert.rejects(
    () => tunnel.open('bad', { localPort: 0, remotePort: 0, direct: true }),
    (err) => err?.code === 'VALIDATION',
  );
  assert.equal(tunnel.status('bad'), null);
  await tunnel.closeAll();
  tunnel._reset();
  store._reset();
});

test('direct reconnect/restartChild 稳定拒绝且不改变运行条目', async () => {
  tunnel._reset();
  store._reset();
  await tunnel.open('local', { localPort: 19001, remotePort: 19001, direct: true });

  await assert.rejects(
    () => tunnel.requestReconnect('local'),
    (err) => err?.code === 'NOT_ALLOWED' && err.message === '本机主机使用直连，没有隧道可重连',
  );
  await assert.rejects(
    () => tunnel.restartChild('local'),
    (err) => err?.code === 'NOT_ALLOWED' && /没有隧道子进程可重建/.test(err.message),
  );
  assert.deepEqual(tunnel.status('local'), {
    localPort: 19001,
    connected: true,
    reconnectAttempt: 0,
    suspendedReason: null,
    direct: true,
  });
  await tunnel.closeAll();
  tunnel._reset();
  store._reset();
});

test('requestReconnect：无活动隧道时返回稳定 NOT_FOUND，不新建无主资源', async () => {
  await tunnel.closeAll();
  tunnel._reset();

  await assert.rejects(
    () => tunnel.requestReconnect('missing'),
    (err) => err?.code === 'NOT_FOUND' && /当前无隧道可重连/.test(err.message),
  );
  assert.equal(tunnel.status('missing'), null);
  assert.equal(tunnel._childPid('missing'), null);
});

test('remote open：子进程端口冲突退出时分类并清除失败条目', async (t) => {
  await tunnel.closeAll();
  tunnel._reset();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-tunnel-exit-'));
  const runner = path.join(dir, 'exit.mjs');
  fs.writeFileSync(runner, "process.stderr.write('bind: Address already in use\\n'); process.exit(255);\n");
  const savedSsh = process.env.DSHC_SSH_BIN;
  process.env.DSHC_SSH_BIN = `${process.execPath} ${runner}`;
  t.after(async () => {
    await tunnel.closeAll();
    tunnel._reset();
    if (savedSsh === undefined) delete process.env.DSHC_SSH_BIN;
    else process.env.DSHC_SSH_BIN = savedSsh;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const port = await unusedPort();
  const keepAlive = setInterval(() => {}, 1_000);
  try {
    await assert.rejects(
      () => tunnel.open('gpu-1', { localPort: port, remotePort: 19001 }),
      (err) => err?.code === 'TUNNEL_PORT_BUSY' && /已被占用/.test(err.message),
    );
  } finally {
    clearInterval(keepAlive);
  }
  assert.equal(tunnel.status('gpu-1'), null, '失败 open 必须删除内存条目');
  assert.equal(tunnel._childPid('gpu-1'), null, '退出子进程不得残留 pid');
});

test('意外退出已排重连时显式 close 会取消计时器并收净条目', async (t) => {
  const port = await unusedPort();
  const fixture = await remoteTunnelRuntime(t, { port });
  await tunnel.open('gpu-1', { localPort: port, remotePort: 19001 });
  const childPid = tunnel._childPid('gpu-1');
  assert.ok(childPid);

  process.kill(childPid, 'SIGUSR1');
  await waitUntil(
    () => tunnel.status('gpu-1')?.connected === false,
    '意外退出进入 degraded/待重连',
  );
  assert.equal(store.getPhase('gpu-1'), 'degraded');
  assert.equal(fixture.starts(), 1);

  await tunnel.close('gpu-1');
  assert.equal(tunnel.status('gpu-1'), null);
  assert.equal(tunnel._childPid('gpu-1'), null);
  assert.equal(fixture.starts(), 1, '显式关闭不得再冒出新的隧道子进程');
});

test('recoverOne：本机 VERIFY 成功后按 web.port 重建 direct，不分配映射端口', async (t) => {
  const port = await unusedPort();
  const fixture = await localRuntime(t, { port });

  assert.equal(await launcher.recoverOne(LOCAL_NAME), 'running');
  assert.deepEqual(tunnel.status(LOCAL_NAME), {
    localPort: port,
    connected: true,
    reconnectAttempt: 0,
    suspendedReason: null,
    direct: true,
  });
  assert.equal(tunnel._childPid(LOCAL_NAME), null);
  assert.equal(store.getConfig().hosts[LOCAL_NAME].localPort, null, '本机恢复不得写映射端口');
  assert.equal(store.getHostState(LOCAL_NAME).tunnel.direct, true);
  assert.deepEqual(fixture.calls().map((call) => call.kind), ['local'], '恢复只允许本机 VERIFY');
});

test('direct 巡检：HTTP 成功不做 VERIFY，close 后 web 仍运行', async (t) => {
  const { server, port } = await listenHttp();
  t.after(() => closeServer(server));
  const fixture = await localRuntime(t, { port });
  await tunnel.open(LOCAL_NAME, { localPort: port, remotePort: port, direct: true });

  assert.deepEqual(await monitor.checkOne(LOCAL_NAME), { host: LOCAL_NAME, outcome: 'ok' });
  assert.deepEqual(fixture.calls(), [], '最小 HTTP probe 成功后不应再执行 VERIFY');
  assert.equal(store.getHostView(LOCAL_NAME).mappedUrl, `http://127.0.0.1:${port}/`);

  await tunnel.close(LOCAL_NAME);
  assert.equal(await tunnel.probeForward(port, 500), true, '关闭 direct 不能杀本机 web');
});

test('direct 巡检：HTTP 失败且 VERIFY 判死时直接 crashed，无 degraded/重连', async (t) => {
  const port = await unusedPort();
  const fixture = await localRuntime(t, { port, alive: false });
  await tunnel.open(LOCAL_NAME, { localPort: port, remotePort: port, direct: true });

  assert.deepEqual(await monitor.checkOne(LOCAL_NAME), { host: LOCAL_NAME, outcome: 'crashed' });
  assert.equal(store.getPhase(LOCAL_NAME), 'crashed');
  assert.equal(tunnel.status(LOCAL_NAME), null);
  assert.deepEqual(fixture.calls().map((call) => call.kind), ['local'], '失败后 VERIFY 也不得走 ssh');
});

test('direct 巡检：HTTP 失败但进程指纹仍匹配时保持 running，不造 degraded/退避', async (t) => {
  const port = await unusedPort();
  const fixture = await localRuntime(t, { port, alive: true });
  await tunnel.open(LOCAL_NAME, { localPort: port, remotePort: port, direct: true });

  assert.deepEqual(await monitor.checkOne(LOCAL_NAME), { host: LOCAL_NAME, outcome: 'unresponsive' });
  assert.equal(store.getPhase(LOCAL_NAME), 'running');
  assert.deepEqual(tunnel.status(LOCAL_NAME), {
    localPort: port,
    connected: true,
    reconnectAttempt: 0,
    suspendedReason: null,
    direct: true,
  });
  assert.equal(tunnel._childPid(LOCAL_NAME), null);
  assert.deepEqual(fixture.calls().map((call) => call.kind), ['local']);
});
