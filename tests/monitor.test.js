import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { newFactoryConfig, newHostConfig, resolvePaths } from '../src/defaults.js';
import { _resetQueues, reopenSsh } from '../src/lib/ssh.js';
import * as monitor from '../src/monitor.js';
import * as store from '../src/store.js';
import * as tunnel from '../src/tunnel.js';

const HOST = 'gpu-1';
const FINGERPRINT = 'dsh web --no-open --host 127.0.0.1 --port 19001';

async function unusedPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitUntil(predicate, label, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop -- 等待子进程监听状态收敛
    if (await predicate()) return;
    if (Date.now() >= deadline) throw new Error(`等待「${label}」超时`);
    // eslint-disable-next-line no-await-in-loop -- 同上
    await new Promise((resolve) => { setTimeout(resolve, 20); });
  }
}

async function monitorFixture(t, sshBin, { localPort = null } = {}) {
  await tunnel.closeAll();
  tunnel._reset();
  monitor.stopLoop();
  store._reset();
  _resetQueues();
  reopenSsh();

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-monitor-'));
  const savedSsh = process.env.DSHC_SSH_BIN;
  process.env.DSHC_SSH_BIN = `${process.execPath} ${sshBin}`;

  const config = newFactoryConfig();
  config.setupCompleted = true;
  config.hosts[HOST] = { ...newHostConfig(), localPort };
  fs.writeFileSync(path.join(dir, 'config.json'), `${JSON.stringify(config, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, 'state.json'), `${JSON.stringify({
    hosts: {
      [HOST]: {
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
    monitor.stopLoop();
    await tunnel.closeAll();
    tunnel._reset();
    store._reset();
    _resetQueues();
    reopenSsh();
    if (savedSsh === undefined) delete process.env.DSHC_SSH_BIN;
    else process.env.DSHC_SSH_BIN = savedSsh;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  return dir;
}

test('巡检循环 start/stop 幂等：重复启动不叠定时器，停止后可确认释放', () => {
  monitor.stopLoop();
  monitor.startLoop({ intervalMs: 60_000 });
  assert.equal(monitor.isLooping(), true);
  monitor.startLoop({ intervalMs: 1 });
  assert.equal(monitor.isLooping(), true, '第二次 start 不得替换或叠加定时器');
  monitor.stopLoop();
  assert.equal(monitor.isLooping(), false);
  monitor.stopLoop();
});

test('深复核协议损坏时返回 unknown，保留 running 与隧道供下一轮重试', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-monitor-script-'));
  const calls = path.join(dir, 'calls.log');
  const malformed = path.join(dir, 'malformed.mjs');
  fs.writeFileSync(malformed, [
    "import fs from 'node:fs';",
    `fs.appendFileSync(${JSON.stringify(calls)}, 'verify\\n');`,
    "process.stdout.write('ALIVE=yes\\nARGS<<EOF\\nunterminated\\n');",
  ].join('\n'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const port = await unusedPort();
  await monitorFixture(t, malformed);
  await tunnel.open(HOST, { localPort: port, remotePort: port, direct: true });

  assert.deepEqual(await monitor.checkOne(HOST), { host: HOST, outcome: 'unknown' });
  assert.equal(store.getPhase(HOST), 'running', '无法判定不能定罪远端进程');
  assert.equal(tunnel.status(HOST)?.localPort, port, '无法判定不能清除现有恢复线索');
  assert.equal(fs.readFileSync(calls, 'utf8'), 'verify\n');
});

test('远端仍活但隧道重建失败时返回 restart-failed，不误标 crashed', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-monitor-restart-'));
  const listener = path.join(dir, 'listener.mjs');
  const failing = path.join(dir, 'failing.mjs');
  const calls = path.join(dir, 'calls.ndjson');
  fs.writeFileSync(listener, [
    "import net from 'node:net';",
    'const args = process.argv.slice(2);',
    "const forward = args[args.indexOf('-L') + 1];",
    "const port = Number(forward.split(':')[1]);",
    'const server = net.createServer((socket) => socket.destroy());',
    "server.listen(port, '127.0.0.1');",
    "process.on('SIGUSR2', () => server.close());",
    "process.on('SIGTERM', () => process.exit(0));",
    'setInterval(() => {}, 60_000);',
  ].join('\n'));
  fs.writeFileSync(failing, [
    "import fs from 'node:fs';",
    'const args = process.argv.slice(2);',
    `fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ tunnel: args.includes('-N') }) + '\\n');`,
    "if (args.includes('-N')) {",
    "  process.stderr.write('bind: Address already in use\\n');",
    '  process.exit(255);',
    '}',
    `process.stdout.write(${JSON.stringify(`ALIVE=yes\nARGS<<EOF\n${FINGERPRINT}\nEOF\nLISTEN=yes\nCWD=/tmp/work\nVERIFY_DONE=yes\n`)});`,
  ].join('\n'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const port = await unusedPort();
  await monitorFixture(t, listener, { localPort: port });
  await tunnel.open(HOST, { localPort: port, remotePort: 19001 });
  const childPid = tunnel._childPid(HOST);
  assert.ok(childPid);
  process.kill(childPid, 'SIGUSR2');
  await waitUntil(
    async () => !(await tunnel.probeLocalPort(port, 50)),
    '旧隧道停止监听',
  );

  process.env.DSHC_SSH_BIN = `${process.execPath} ${failing}`;
  const keepAlive = setInterval(() => {}, 1_000);
  let result;
  try {
    result = await monitor.checkOne(HOST);
  } finally {
    clearInterval(keepAlive);
  }
  assert.deepEqual(result, { host: HOST, outcome: 'restart-failed' });
  assert.equal(store.getPhase(HOST), 'running', '重建运输失败不等于远端服务死亡');
  assert.equal(tunnel.status(HOST)?.connected, false);
  assert.deepEqual(
    fs.readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse),
    [{ tunnel: false }, { tunnel: true }],
    '先 VERIFY 存活，再尝试新隧道',
  );
});
