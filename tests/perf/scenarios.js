/**
 * 墙钟基线的场景表（harness 支柱 A 的软闸那一半）。
 *
 * 刻意只量 **manager 侧的编排成本**——扇出调度、主机队列、状态机、模板构建、解析。
 * 假 ssh 量不到真实网络与远端性能，那属于真机验收（IT 系列）的范畴，不该进自动闸。
 *
 * 两类场景：
 *   path   走真装置（真子进程、真 fs、真 store 单例），量的是编排全链
 *   micro  纯函数，量的是热点算法本身（模板构建、schema 校验、lcov 解析）
 *
 * 这是**模块**不是用例文件：`scripts/perf-gate.mjs` 与用例都从这里取同一份场景，
 * 免得「基线量的东西」和「用例量的东西」各写一份然后悄悄分叉。
 */

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { CONFIG_VERSION, SSH_FANOUT_LIMIT, resolvePaths } from '../../src/defaults.js';
import { configSchema, validate } from '../../src/lib/validate.js';
import { createGate } from '../../src/lib/pool.js';
import { hostQueue, sshExec, _resetQueues } from '../../src/lib/ssh.js';
import {
  buildLaunchPollScript, buildLaunchScript, buildLogTailScript, buildProbeScript,
  buildStopScript, buildVerifyScript, parseProtoOutput,
} from '../../src/lib/proto.js';
import { shq } from '../../src/lib/shq.js';
import { probeAll } from '../../src/prober.js';
import * as bus from '../../src/lib/bus.js';
import * as monitor from '../../src/monitor.js';
import * as store from '../../src/store.js';
import * as tunnel from '../../src/tunnel.js';
import { createHarness, newHostState } from '../harness/index.js';
import { parseLcov } from '../../scripts/coverage-gate.mjs';

/**
 * 场景规模。改这些数就是改基线口径，`--record` 时要在 PR 里说明理由。
 *
 * 微基准的循环次数刻意调到「单次测量 ≥ 20ms」这个量级：几毫秒的量测里，一次 GC 停顿
 * 就足以让比值翻三倍，信噪比撑不起任何判据（perf-gate 的噪声地板也是为此而设）。
 */
export const SIZES = Object.freeze({
  probeHosts: 30,
  stormHosts: 16,
  tickHosts: 16,
  protoBuilds: 4_000,
  validateRuns: 600,
  parseRuns: 4_000,
  lcovFiles: 600,
});

const hostNames = (n) => Array.from({ length: n }, (_, i) => `gpu-${String(i + 1).padStart(2, '0')}`);

/**
 * 一套「装置 + store」，用完必须 dispose（隧道子进程是活句柄，漏一个进程就不退）。
 * @param {string[]} names
 */
async function bootFixture(names) {
  // manager 的事件总线往 console 走；量墙钟时那几百行日志既刷屏又计入耗时。
  const savedLog = console.log;
  const savedWarn = console.warn;
  console.log = () => {};
  console.warn = () => {};

  const harness = createHarness({
    hosts: Object.fromEntries(names.map((n) => [n, newHostState()])),
  });
  const restore = harness.activate();
  fs.writeFileSync(path.join(harness.homeDir, 'config.json'), `${JSON.stringify({
    configVersion: CONFIG_VERSION,
    setupCompleted: true,
    manager: { port: 7788 },
    defaults: { remoteWebPort: 8899, localPortRange: [17701, 17799] },
    hosts: Object.fromEntries(names.map((n, i) => [n, {
      local: false,
      enabled: true,
      autoStart: false,
      localPort: null,
      remoteWebPort: 8899 + i,
      workdir: null,
      inject: { env: {}, extraArgs: [], patches: [] },
    }])),
  }, null, 2)}\n`);
  await store.init({ pathsOverride: resolvePaths({ DSHC_HOME: harness.homeDir }, os.homedir()) });
  return {
    harness,
    async dispose() {
      monitor.stopLoop();
      await tunnel.closeAll();
      tunnel._reset();
      store._reset();
      _resetQueues();
      bus._resetForTest();
      harness.cleanup();
      restore();
      console.log = savedLog;
      console.warn = savedWarn;
    },
  };
}

// ── 场景实现 ─────────────────────────────────────────────────────────────

/** 路径 1：一把 30 台的探测扇出（issue #85 那道闸的主场）。 */
async function probeFanout() {
  const names = hostNames(SIZES.probeHosts);
  const fx = await bootFixture(names);
  try {
    const settled = await probeAll(names);
    return { unit: 'hosts', n: settled.length };
  } finally {
    await fx.dispose();
  }
}

/**
 * 路径 2：重连风暴里真正花钱的那一段——16 台同时经扇出闸 + 各自的 hostQueue 打 VERIFY。
 *
 * 不真起 16 条隧道：`waitReady` 是 250ms 一档的轮询，量出来的是轮询粒度而不是编排成本
 * （在飞峰值那条**硬**判据在 invariants.test.js 里，用的是账本计数，与墙钟无关）。
 */
async function verifyStorm() {
  const names = hostNames(SIZES.stormHosts);
  const fx = await bootFixture(names);
  try {
    const gate = createGate(SSH_FANOUT_LIMIT);
    const script = buildVerifyScript({ pid: 60_768, port: 8899 });
    await Promise.all(names.map((name) => gate.run(() => hostQueue(name).run(
      'perf-verify',
      (signal) => sshExec(name, script, { signal }),
    ))));
    return { unit: 'hosts', n: names.length };
  } finally {
    await fx.dispose();
  }
}

/**
 * 路径 3：一拍巡检扫 16 台 running。
 *
 * 隧道用 direct 条目（本机直连形态，不 spawn ssh），指向一个真在监听的本机端口——
 * 于是 `probeForward` 会成功、不触发深核，量到的就是「一拍扫 N 台」的纯编排成本。
 */
async function monitorTick() {
  const names = hostNames(SIZES.tickHosts);
  const fx = await bootFixture(names);
  const server = net.createServer((sock) => {
    sock.on('data', () => sock.write('HTTP/1.0 200 OK\r\n\r\n'));
    sock.on('error', () => {});
  });
  try {
    await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
    const port = server.address().port;
    for (const name of names) {
      store.setPhase(name, 'ready', 'perf');
      store.setPhase(name, 'starting', 'perf');
      store.setPhase(name, 'running', 'perf');
      // eslint-disable-next-line no-await-in-loop -- 逐台登记，direct 条目不起子进程
      await tunnel.open(name, { localPort: port, remotePort: port, direct: true });
    }
    const result = await monitor.tick();
    return { unit: 'hosts', n: result.checked ?? 0 };
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fx.dispose();
  }
}

/** 微基准 1：五个远端模板的构建（含 shq 转义、env/patch/extraArgs 全带）。 */
function protoBuild() {
  const env = {
    CUDA_VISIBLE_DEVICES: '0,1', PATH: '/usr/local/bin:/usr/bin', TOKEN: "a'b\nc$d`e",
  };
  const extraArgs = ['--theme', 'dark side', '--flag=$(x)'];
  const patchRemoteNames = ['a.patch', 'b.patch', 'c.patch'];
  let bytes = 0;
  for (let i = 0; i < SIZES.protoBuilds; i += 1) {
    bytes += buildProbeScript().length;
    bytes += buildLaunchScript({
      logName: `web-${i % 7}.log`,
      port: 8899,
      dshPath: '/root/.canon/node/bin/dsh',
      env,
      patchRemoteNames,
      extraArgs,
      workdir: '~/work space/proj',
    }).length;
    bytes += buildLaunchPollScript({ logName: 'web.log', pid: 60_768 + i }).length;
    bytes += buildVerifyScript({ pid: 60_768 + i, port: 8899 }).length;
    bytes += buildStopScript({
      pid: 60_768 + i,
      fingerprint: 'dsh web --no-open --host 127.0.0.1 --port 8899',
    }).length;
    bytes += buildLogTailScript({ logName: 'web.log', lines: 200 }).length;
    bytes += shq(`payload-${i}\n'quoted'\t$(sub)`).length;
  }
  return { unit: 'bytes', n: bytes };
}

/** 微基准 2：全 schema 校验一份 50 台主机的 config。 */
function validateConfig() {
  const hosts = {};
  for (const name of hostNames(50)) {
    hosts[name] = {
      local: false,
      enabled: true,
      autoStart: false,
      localPort: null,
      remoteWebPort: 8899,
      workdir: '/root/work',
      inject: { env: { A: '1', B: '2' }, extraArgs: ['--x'], patches: [] },
    };
  }
  const config = {
    configVersion: CONFIG_VERSION,
    setupCompleted: true,
    manager: { port: 7788 },
    defaults: { remoteWebPort: 8899, localPortRange: [17701, 17799] },
    hosts,
  };
  let ok = 0;
  for (let i = 0; i < SIZES.validateRuns; i += 1) {
    if (validate(configSchema, config).ok) ok += 1;
  }
  return { unit: 'validations', n: ok };
}

/** 微基准 3：lcov 解析（覆盖率闸每次跑都要过一遍它）。 */
function lcovParse() {
  const chunks = [];
  for (let f = 0; f < SIZES.lcovFiles; f += 1) {
    chunks.push(`SF:src/generated/file-${f}.js`);
    for (let line = 1; line <= 60; line += 1) chunks.push(`DA:${line},${line % 3 === 0 ? 0 : 1}`);
    chunks.push('BRF:8', 'BRH:6', 'FNF:4', 'FNH:3', 'end_of_record');
  }
  const text = chunks.join('\n');
  const parsed = parseLcov(text, process.cwd());
  return { unit: 'files', n: parsed.files?.length ?? parsed.size ?? SIZES.lcovFiles };
}

/** 微基准 4：协议输出解析（每次 ssh 往返都要过它）。 */
function protoParse() {
  const stdout = [
    'DSH_BIN=/usr/bin/dsh',
    'DSH_VERSION=0.1.0-rc.7',
    'DSH_HOME=/root/.dsh',
    'PROFILE_WEB=yes',
    'RUNNING_DSH_WEB<<EOF',
    ...Array.from({ length: 40 }, (_, i) => ` ${60_000 + i} dsh web --no-open --host 127.0.0.1 --port ${8899 + i}`),
    'EOF',
    'PROBE_DONE=yes',
    '',
  ].join('\n');
  let rows = 0;
  for (let i = 0; i < SIZES.parseRuns; i += 1) {
    const out = parseProtoOutput(stdout, { requireDone: 'PROBE_DONE' });
    rows += (out.blocks.RUNNING_DSH_WEB ?? '').length;
  }
  return { unit: 'chars', n: rows };
}

/**
 * 场景表。id 即 BASELINE.json 的键——改 id 等于弃掉那条历史，别顺手改。
 * @type {ReadonlyArray<{id:string, kind:'path'|'micro', label:string,
 *   run:() => Promise<{unit:string,n:number}>|{unit:string,n:number}}>}
 */
export const SCENARIOS = Object.freeze([
  {
    id: 'probe-fanout', kind: 'path', label: `${SIZES.probeHosts} 台探测扇出`, run: probeFanout,
  },
  {
    id: 'verify-storm', kind: 'path', label: `${SIZES.stormHosts} 台复核风暴`, run: verifyStorm,
  },
  {
    id: 'monitor-tick', kind: 'path', label: `一拍巡检扫 ${SIZES.tickHosts} 台`, run: monitorTick,
  },
  {
    id: 'proto-build', kind: 'micro', label: '远端模板构建 + shq', run: protoBuild,
  },
  {
    id: 'validate-config', kind: 'micro', label: '全 schema 校验 50 台 config', run: validateConfig,
  },
  {
    id: 'proto-parse', kind: 'micro', label: '协议输出解析', run: protoParse,
  },
  {
    id: 'lcov-parse', kind: 'micro', label: `lcov 解析 ${SIZES.lcovFiles} 文件`, run: lcovParse,
  },
]);
