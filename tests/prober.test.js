import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as store from '../src/store.js';
import {
  applyProbe, interpretProbe, parseManualPort, parseRunningBlock, parseSniffPaths, probeHost, probeOnce,
} from '../src/prober.js';
import { CONFIG_VERSION, resolvePaths } from '../src/defaults.js';
import { _resetForTest } from '../src/lib/bus.js';
import { buildProbeScript } from '../src/lib/proto.js';
import { unshq } from './harness/shell-word.js';

const ok = (stdout) => ({ code: 0, stdout, stderr: '', timedOut: false, aborted: false });

/** 12 §1.1 协议的典型 stdout 样本。 */
const READY_SAMPLE = [
  'DSH_BIN=/usr/bin/dsh',
  'DSH_VERSION=0.1.0-rc.7',
  'DSH_HOME=/root/.dsh',
  'PROFILE_WEB=yes',
  'PROBE_PATH=/usr/local/bin:/usr/bin',
  'DSH_SNIFF<<EOF',
  '/home/test/.local/bin/dsh',
  '/usr/local/bin/dsh',
  'EOF',
  'DSH_SNIFF_LOGIN=/home/test/.local/bin/dsh',
  'DSH_SNIFF_VERSION=dsh 0.1.0-rc.7 (build abc)',
  'RUNNING_DSH_WEB<<EOF',
  ' 60768 dsh web --no-open --host 127.0.0.1 --port 8899',
  'EOF',
  'PROBE_DONE=yes',
  '',
].join('\n');

/** 同一份样本，但手动实例的端口一个写死、一个 `--port 0`（首段解析不出）。 */
const AMBIGUOUS_SAMPLE = READY_SAMPLE.replace(
  ' 60768 dsh web --no-open --host 127.0.0.1 --port 8899',
  ' 60768 dsh web --no-open --host 127.0.0.1 --port 0\n 70001 dsh web --no-open --port 8899',
);

test('interpretProbe：ready 全字段', () => {
  const r = interpretProbe(ok(READY_SAMPLE));
  assert.equal(r.ok, true);
  assert.equal(r.phase, 'ready');
  assert.equal(r.dshPath, '/usr/bin/dsh');
  assert.equal(r.version, '0.1.0-rc.7');
  assert.equal(r.dshHome, '/root/.dsh');
  assert.equal(r.profileWeb, true);
  assert.equal(r.noDshReason, null);
  assert.deepEqual(r.sniff, {
    paths: ['/home/test/.local/bin/dsh', '/usr/local/bin/dsh'],
    loginPath: '/home/test/.local/bin/dsh',
    version: 'dsh 0.1.0-rc.7 (build abc)',
    probePath: '/usr/local/bin:/usr/bin',
  });
  assert.deepEqual(r.manualInstances, [{
    pid: 60768,
    args: 'dsh web --no-open --host 127.0.0.1 --port 8899',
    port: 8899,
  }]);
});

test('interpretProbe：no_dsh 两种原因可区分', () => {
  const missing = interpretProbe(ok('DSH_BIN=MISSING\nDSH_HOME=/root/.dsh\nPROFILE_WEB=no\nDSH_SNIFF<<EOF\n/root/.canon/node/bin/dsh\nEOF\nDSH_SNIFF_LOGIN=/root/.canon/node/bin/dsh\nRUNNING_DSH_WEB<<EOF\nEOF\nPROBE_DONE=yes\n'));
  assert.equal(missing.phase, 'no_dsh');
  assert.equal(missing.noDshReason, 'missing-bin');
  assert.equal(missing.dshPath, null);
  assert.deepEqual(missing.sniff.paths, ['/root/.canon/node/bin/dsh']);
  assert.equal(missing.sniff.loginPath, '/root/.canon/node/bin/dsh');

  const noProfile = interpretProbe(ok('DSH_BIN=/usr/bin/dsh\nDSH_VERSION=0.1.0\nDSH_HOME=/root/.dsh\nPROFILE_WEB=no\nRUNNING_DSH_WEB<<EOF\nEOF\nPROBE_DONE=yes\n'));
  assert.equal(noProfile.phase, 'no_dsh');
  assert.equal(noProfile.noDshReason, 'no-web-profile');
  assert.equal(noProfile.dshPath, '/usr/bin/dsh', 'dsh 在，只是 profile 缺');
});

test('interpretProbe：旧版 PROBE 输出缺嗅探键时回退为空', () => {
  const r = interpretProbe(ok('DSH_BIN=MISSING\nDSH_HOME=/root/.dsh\nPROFILE_WEB=no\nRUNNING_DSH_WEB<<EOF\nEOF\nPROBE_DONE=yes\n'));
  assert.deepEqual(r.sniff, {
    paths: [], loginPath: null, version: null, probePath: null,
  });
});

test('interpretProbe：ssh 失败/超时 → unreachable，stderr 保留', () => {
  const refused = interpretProbe({ code: 255, stdout: '', stderr: 'Connection refused', timedOut: false, aborted: false });
  assert.equal(refused.phase, 'unreachable');
  assert.equal(refused.stderr, 'Connection refused');

  const timeout = interpretProbe({ code: null, stdout: '', stderr: '', timedOut: true, aborted: false });
  assert.equal(timeout.phase, 'unreachable');
});

test('interpretProbe：缺哨兵（输出被截断）→ unreachable 且留证原文', () => {
  const r = interpretProbe(ok('DSH_BIN=/usr/bin/dsh\nDSH_HOME=/root/.dsh\n'));
  assert.equal(r.phase, 'unreachable');
  assert.match(r.stderr, /DSH_BIN=\/usr\/bin\/dsh/, 'detail 带原始输出便于诊断');
});

test('interpretProbe：多行 version 已在远端 head -n 1，此处按单行处理', () => {
  const r = interpretProbe(ok('DSH_BIN=/usr/bin/dsh\nDSH_VERSION=dsh 0.1.0-rc.7 (build abc)\nDSH_HOME=/root/.dsh\nPROFILE_WEB=yes\nRUNNING_DSH_WEB<<EOF\nEOF\nPROBE_DONE=yes\n'));
  assert.equal(r.version, 'dsh 0.1.0-rc.7 (build abc)');
});

test('探测按 config > PATH > 常见目录 > login shell 解析绝对 dsh，并回传依赖', () => {
  const script = buildProbeScript({ dshPath: '/opt/custom path/dsh' });
  assert.ok(script.includes("CONFIG_DSH_PATH='/opt/custom path/dsh'"));
  assert.ok(script.indexOf('CONFIG_DSH_PATH=') < script.indexOf('PATH_DSH='));
  assert.ok(script.indexOf('PATH_DSH=') < script.indexOf('SNIFF_PATH='));
  assert.ok(script.indexOf('SNIFF_PATH=') < script.indexOf('LOGIN_DSH='));
  assert.ok(script.includes('/usr/bin /usr/sbin'));

  const result = interpretProbe(ok([
    'DSH_BIN=/opt/custom path/dsh',
    'DSH_VERSION=dsh custom',
    'DSH_HOME=/root/.dsh',
    'PROFILE_WEB=yes',
    'HAS_BASH=yes',
    'HAS_TIMEOUT=no',
    'RUNNING_DSH_WEB<<EOF',
    'EOF',
    'PROBE_DONE=yes',
  ].join('\n')));
  assert.deepEqual(result.dependencies, {
    binary: true, webProfile: true, bash: true, timeout: false,
  });
  assert.equal(result.phase, 'ready');
});

test('parseRunningBlock：ps 行解析、忽略噪声行', () => {
  assert.deepEqual(
    parseRunningBlock('  123 dsh web --port 1\n\nnot a ps line\n 456   dsh web --port 2  '),
    [
      { pid: 123, args: 'dsh web --port 1', port: 1 },
      { pid: 456, args: 'dsh web --port 2', port: 2 },
    ],
  );
  assert.deepEqual(parseRunningBlock(''), []);
  assert.deepEqual(parseRunningBlock(null), []);
});

test('parseManualPort：固定端口可读，0/缺失按未知', () => {
  assert.equal(parseManualPort('dsh web --port 8899'), 8899);
  assert.equal(parseManualPort('dsh web --port=8899'), 8899);
  assert.equal(parseManualPort('dsh web --port 0'), null);
  assert.equal(parseManualPort('dsh web'), null);
});

test('parseSniffPaths：按行收集命中路径并忽略空行', () => {
  assert.deepEqual(
    parseSniffPaths('\n /usr/local/bin/dsh \n\n/home/me/.local/bin/dsh\n'),
    ['/usr/local/bin/dsh', '/home/me/.local/bin/dsh'],
  );
  assert.deepEqual(parseSniffPaths(null), []);
});

test('probeOnce：同一 PROBE 模板按 local 显式选择本机或 ssh 运输', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-probe-transport-'));
  const recorder = path.join(dir, 'record.mjs');
  const localMark = path.join(dir, 'local.json');
  const sshMark = path.join(dir, 'ssh.json');
  fs.writeFileSync(recorder, [
    "import fs from 'node:fs';",
    'const [kind, mark, ...args] = process.argv.slice(2);',
    'fs.writeFileSync(mark, JSON.stringify({ kind, args }));',
    `process.stdout.write(${JSON.stringify(READY_SAMPLE)});`,
  ].join('\n'));

  const savedLocal = process.env.DSHC_LOCAL_SH_BIN;
  const savedSsh = process.env.DSHC_SSH_BIN;
  process.env.DSHC_LOCAL_SH_BIN = `${process.execPath} ${recorder} local ${localMark}`;
  process.env.DSHC_SSH_BIN = `${process.execPath} ${recorder} ssh ${sshMark}`;
  t.after(() => {
    if (savedLocal === undefined) delete process.env.DSHC_LOCAL_SH_BIN;
    else process.env.DSHC_LOCAL_SH_BIN = savedLocal;
    if (savedSsh === undefined) delete process.env.DSHC_SSH_BIN;
    else process.env.DSHC_SSH_BIN = savedSsh;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  assert.equal((await probeOnce('name-is-not-a-transport', { local: true })).phase, 'ready');
  assert.equal(fs.existsSync(localMark), true);
  assert.equal(fs.existsSync(sshMark), false, 'local=true 不得启动 ssh');
  const localCall = JSON.parse(fs.readFileSync(localMark, 'utf8'));
  assert.deepEqual(localCall.args, ['-c', buildProbeScript()]);

  assert.equal((await probeOnce('gpu-1', { local: false })).phase, 'ready');
  const remoteCall = JSON.parse(fs.readFileSync(sshMark, 'utf8'));
  const wrapped = remoteCall.args.at(-1);
  assert.equal(wrapped.startsWith('sh -c '), true);
  assert.equal(unshq(wrapped.slice('sh -c '.length)), buildProbeScript(), '远端仍发送同一份模板');

  fs.rmSync(localMark, { force: true });
  fs.rmSync(sshMark, { force: true });
  await storeFixture(t, { 'local-node': { local: true } });
  await probeHost('local-node');
  assert.equal(fs.existsSync(localMark), true, '队首从当前 HostView 读取 local');
  assert.equal(fs.existsSync(sshMark), false);
});

/**
 * 二段式端口解析的确定性夹具：第一段回 PROBE 样本（手动实例 --port 0，端口未知），
 * 第二段按 `manualPorts` 回 MANUAL_PORTS 块。真机上这条路径只在「首段解析不出端口」
 * 时才走，靠真实进程碰运气覆盖不到（Linux 上 ss 直接给出端口就整段跳过了）。
 */
function twoStageProbeFixture(t, { manualPorts = 'MANUAL_PORTS<<EOF\n60768=41234\nEOF\nMANUAL_PORTS_DONE=yes\n', exitCode = 0 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-probe-2stage-'));
  const recorder = path.join(dir, 'record.mjs');
  fs.writeFileSync(recorder, [
    'const script = process.argv.at(-1);',
    'if (script.includes("MANUAL_PORTS")) {',
    `  process.stdout.write(${JSON.stringify(manualPorts)});`,
    `  process.exit(${exitCode});`,
    '}',
    `process.stdout.write(${JSON.stringify(AMBIGUOUS_SAMPLE)});`,
  ].join('\n'));

  const saved = process.env.DSHC_LOCAL_SH_BIN;
  process.env.DSHC_LOCAL_SH_BIN = `${process.execPath} ${recorder}`;
  t.after(() => {
    if (saved === undefined) delete process.env.DSHC_LOCAL_SH_BIN;
    else process.env.DSHC_LOCAL_SH_BIN = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

test('probeOnce：--port 0 的手动实例走二段式解析补上真实端口', async (t) => {
  twoStageProbeFixture(t);

  const result = await probeOnce('gpu-1', { local: true });
  assert.equal(result.phase, 'ready');
  assert.deepEqual(result.manualInstances.map((i) => [i.pid, i.port]), [[60768, 41234], [70001, 8899]]);
});

test('probeOnce：二段式探测失败或输出残缺时保留端口未知，不编造端口', async (t) => {
  twoStageProbeFixture(t, { exitCode: 1 });
  const failed = await probeOnce('gpu-1', { local: true });
  assert.equal(failed.manualInstances[0].port, null, '非零退出按未知处理');

  // DONE 哨兵缺失说明输出被截断，parseProtoOutput 抛错——此时同样只能按未知处理。
  twoStageProbeFixture(t, { manualPorts: 'MANUAL_PORTS<<EOF\n60768=41234\nEOF\n' });
  const truncated = await probeOnce('gpu-1', { local: true });
  assert.equal(truncated.manualInstances[0].port, null, '缺 DONE 哨兵按未知处理');
});

test('probeOnce：二段式只补未知端口，已解析出的端口不被覆写', async (t) => {
  // 70001 首段已从 --port 8899 解析出端口，二段式即便报了别的端口也不该改它。
  twoStageProbeFixture(t, { manualPorts: 'MANUAL_PORTS<<EOF\n60768=41234\n70001=52000\nEOF\nMANUAL_PORTS_DONE=yes\n' });

  const result = await probeOnce('gpu-1', { local: true });
  assert.deepEqual(result.manualInstances.map((i) => [i.pid, i.port]), [[60768, 41234], [70001, 8899]]);
});

async function storeFixture(t, hosts = { 'gpu-1': null }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-prober-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    configVersion: CONFIG_VERSION,
    setupCompleted: true,
    manager: { port: 7788 },
    defaults: { remoteWebPort: 8899, localPortRange: [17701, 17799] },
    hosts: Object.fromEntries(Object.entries(hosts).map(([n, override]) => [n, {
      local: false,
      enabled: true,
      autoStart: false,
      localPort: null,
      remoteWebPort: null,
      inject: { env: {}, extraArgs: [], patches: [] },
      ...override,
    }])),
  }));
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  t.after(() => {
    store._reset();
    _resetForTest();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await store.init({ pathsOverride: resolvePaths({ DSHC_HOME: dir }, os.homedir()) });
}

test('applyProbe：三分类正确写 phase 与 probe 详情', async (t) => {
  await storeFixture(t);

  applyProbe('gpu-1', interpretProbe(ok(READY_SAMPLE)));
  assert.equal(store.getPhase('gpu-1'), 'ready');
  const probe = store.getHostState('gpu-1').probe;
  assert.equal(store.getHostState('gpu-1').dshPath, '/usr/bin/dsh');
  assert.equal(probe.version, '0.1.0-rc.7');
  assert.deepEqual(probe.sniff, {
    paths: ['/home/test/.local/bin/dsh', '/usr/local/bin/dsh'],
    loginPath: '/home/test/.local/bin/dsh',
    version: 'dsh 0.1.0-rc.7 (build abc)',
    probePath: '/usr/local/bin:/usr/bin',
  });
  assert.equal(probe.errorSummary, null);
  assert.match(probe.at, /^\d{4}-/);

  applyProbe('gpu-1', interpretProbe(ok('DSH_BIN=MISSING\nDSH_HOME=/x\nPROFILE_WEB=no\nRUNNING_DSH_WEB<<EOF\nEOF\nPROBE_DONE=yes\n')));
  assert.equal(store.getPhase('gpu-1'), 'no_dsh');
  assert.equal(store.getHostState('gpu-1').probe.noDshReason, 'missing-bin');

  applyProbe('gpu-1', interpretProbe({ code: 255, stdout: '', stderr: 'ssh: connect failed\nmore detail', timedOut: false, aborted: false }));
  assert.equal(store.getPhase('gpu-1'), 'unreachable');
  assert.equal(store.getHostState('gpu-1').probe.errorSummary, 'ssh: connect failed', '摘要取首行');
});

test('applyProbe：starting/running/degraded 期间不改 phase，只刷 manualInstances', async (t) => {
  await storeFixture(t);
  store.setPhase('gpu-1', 'ready', 't');
  store.setPhase('gpu-1', 'starting', 't');
  store.setPhase('gpu-1', 'running', 't');

  applyProbe('gpu-1', interpretProbe(ok(READY_SAMPLE)));
  assert.equal(store.getPhase('gpu-1'), 'running', '探测不得打断运行态');
  assert.equal(store.getHostState('gpu-1').manualInstances.length, 1);
  assert.ok(store.getHostState('gpu-1').probe, 'probe 详情照常刷新');
});

test('applyProbe：受管 PID 不进 manualInstances', async (t) => {
  await storeFixture(t);
  store.mutateHostState('gpu-1', (e) => { e.web = { pid: 60768, port: 8899, startedByUs: true }; });

  applyProbe('gpu-1', interpretProbe(ok(READY_SAMPLE)));
  assert.deepEqual(store.getHostState('gpu-1').manualInstances, [], '自己拉起的进程不算手动实例');
});

test('applyProbe：unreachable 后再探测可回到 ready（终态互迁）', async (t) => {
  await storeFixture(t);
  applyProbe('gpu-1', interpretProbe({ code: 255, stdout: '', stderr: 'x', timedOut: false, aborted: false }));
  assert.equal(store.getPhase('gpu-1'), 'unreachable');
  applyProbe('gpu-1', interpretProbe(ok(READY_SAMPLE)));
  assert.equal(store.getPhase('gpu-1'), 'ready');
});
