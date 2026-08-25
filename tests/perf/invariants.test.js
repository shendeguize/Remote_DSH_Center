/**
 * 确定性性能不变量（harness 支柱 A：性能评估的硬闸那一半）。
 *
 * 这一支柱分两半，判据形态完全不同：
 *
 *   本文件（硬闸，进 `npm test`）  只断言**与机器快慢无关**的量：调用**次数**、
 *     在飞并发**峰值**、串行**顺序**、落盘**次数**、退避的**上界公式**。这些量在
 *     慢机器上和快机器上一模一样，所以可以毫不含糊地判红。
 *   scripts/perf-gate.mjs（软基线）  才管墙钟。
 *
 * 「在飞并发」不靠时钟算：垫片是一堆各自独立的短命进程，跨进程既没有共享内存也没有
 * 可比的 `performance.now()`。账本文件的**行序**就是全局全序（O_APPEND 小写入原子），
 * begin 记 +1、end 记 -1，顺序扫一遍就是真实峰值——一个时钟都不需要。
 * 见 tests/harness/fake-ssh.js 的 recordTransport / inFlightStats。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { CONFIG_VERSION, SSH_FANOUT_LIMIT, resolvePaths } from '../../src/defaults.js';
import { backoffDelay } from '../../src/tunnel.js';
import { createGate, mapPool } from '../../src/lib/pool.js';
import { hostQueue, _resetQueues } from '../../src/lib/ssh.js';
import { probeAll } from '../../src/prober.js';
import * as bus from '../../src/lib/bus.js';
import * as monitor from '../../src/monitor.js';
import * as store from '../../src/store.js';
import * as tunnel from '../../src/tunnel.js';
import { createHarness, newHostState } from '../harness/index.js';
import { inFlightStats } from '../harness/fake-ssh.js';

/** 等待用的 sleep 不许 unref：这套用例的事件循环里常常只剩这一个句柄，unref 掉就是提前退出。 */
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** 垫片默认几十毫秒就退，重叠窗口窄到峰值判据会失真；把每次回放拉长到真机量级。 */
const RTT_MS = 120;

/**
 * 装置 + store，不起 HTTP 服务（这一支柱要量的东西都在模块层）。
 * @param {import('node:test').TestContext} t
 * @param {string[]} names
 * @param {{faults?:object, state?:object}} [opts]
 */
async function fixture(t, names, { faults = { slowReplyMs: RTT_MS }, state = null } = {}) {
  const hosts = Object.fromEntries(names.map((n) => [n, newHostState({ faults })]));
  const harness = createHarness({ hosts });
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
  if (state) {
    fs.writeFileSync(path.join(harness.homeDir, 'state.json'), `${JSON.stringify(state, null, 2)}\n`);
  }

  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  t.after(async () => {
    // closeAll 必须在 _reset 之前：_reset 只丢内存态、不杀子进程，先复位就再也找不到它们了。
    // 而 spawn 出来的隧道 ssh 是活句柄——漏一个，整个测试文件就挂在事件循环上不退出。
    monitor.stopLoop();
    await tunnel.closeAll();
    tunnel._reset();
    store._reset();
    _resetQueues();
    bus._resetForTest();
    harness.cleanup();
    restore();
  });
  await store.init({ pathsOverride: resolvePaths({ DSHC_HOME: harness.homeDir }, os.homedir()) });
  return harness;
}

const hostNames = (n, prefix = 'gpu') => Array.from(
  { length: n },
  (_, i) => `${prefix}-${String(i + 1).padStart(2, '0')}`,
);

/**
 * 测试文件各自一个进程并行跑，从内核借临时端口会互相撞（借到手与真 bind 之间有窗口）。
 * 与 tests/integration/helpers.js 同一套办法：按 pid 切段，段内顺序找空位。
 */
const PORT_BASE = 21_000 + (process.pid % 300) * 10;
let portCursor = 0;

function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}

async function nextPort() {
  for (let i = 0; i < 10; i += 1) {
    const port = PORT_BASE + (portCursor % 10);
    portCursor += 1;
    // eslint-disable-next-line no-await-in-loop -- 顺序探测
    if (await portFree(port)) return port;
  }
  throw new Error(`端口段 ${PORT_BASE} 已无空闲端口`);
}

// ── 扇出：次数与峰值 ─────────────────────────────────────────────────────

/**
 * 扇出上限的逐字值。
 *
 * 判据**不许**写成 `peak <= SSH_FANOUT_LIMIT`——那样把限制改成 7，判据自己也跟着放宽，
 * 闸门永远绿。这里钉逐字 6，出厂表一改这条就红，正是我们要的（issue #85 的教训是
 * 「6 是照 sshd MaxStartups 10:30:100 算出来的」，不是随手取的数）。
 */
const FANOUT_CAP = 6;

test(`扇出上限就是 ${FANOUT_CAP}：出厂表里那个数不许悄悄变`, () => {
  assert.equal(
    SSH_FANOUT_LIMIT,
    FANOUT_CAP,
    'SSH_FANOUT_LIMIT 变了：它是照 sshd 出厂 MaxStartups 10:30:100 算的（留 4 条给用户自己的会话），'
    + '要动就得先说明新数怎么来的，并把本文件的 FANOUT_CAP 一起改',
  );
});

test(`probeAll 30 台：ssh 恰好 30 次，在飞峰值 ≤ ${FANOUT_CAP}`, async (t) => {
  const names = hostNames(30);
  const harness = await fixture(t, names);

  const settled = await probeAll(names);
  assert.equal(settled.length, 30);
  assert.deepEqual(
    settled.filter((r) => r.status !== 'fulfilled'),
    [],
    '假远端全健康，一台都不该失败',
  );

  const probes = harness.transportEvents().filter((e) => e.kind === 'probe');
  const stats = inFlightStats(probes);
  assert.equal(stats.total, 30, '一台一次，不许重探也不许漏探');
  assert.equal(stats.unfinished, 0, '有 ssh 起了没收：账本里 begin 多于 end');
  assert.ok(
    stats.peak > 1,
    `在飞峰值只有 ${stats.peak}：扇出退化成串行，或 slowReplyMs 没生效导致判据空转`,
  );
  assert.ok(
    stats.peak <= FANOUT_CAP,
    `在飞峰值 ${stats.peak} 超过扇出闸 ${FANOUT_CAP}——真机上这些连接会被跳板机随机掐断`
    + `\n在飞序列：${stats.sequence.join(',')}`,
  );
});

test('mapPool 的峰值就是 limit：不多不少，且结果按入参顺序', async () => {
  for (const limit of [1, 2, FANOUT_CAP]) {
    let inFlight = 0;
    let peak = 0;
    // eslint-disable-next-line no-await-in-loop -- 逐档量峰值，语义上必须顺序
    const settled = await mapPool(Array.from({ length: 30 }, (_, i) => i), async (i) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await sleep(1);
      inFlight -= 1;
      return i;
    }, limit);
    assert.equal(peak, limit, `limit=${limit} 时峰值应恰好是 limit，实测 ${peak}`);
    assert.deepEqual(settled.map((r) => r.value), Array.from({ length: 30 }, (_, i) => i));
  }
});

test(`重连环的闸：16 台同时敲门，峰值 ≤ ${FANOUT_CAP} 且排队 FIFO（issue #100）`, async () => {
  const gate = createGate(SSH_FANOUT_LIMIT);
  let inFlight = 0;
  let peak = 0;
  const entered = [];
  await Promise.all(hostNames(16).map((name) => gate.run(async () => {
    entered.push(name);
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await sleep(5);
    inFlight -= 1;
  })));
  assert.equal(peak, FANOUT_CAP, `16 台挤一起时峰值应被压到 ${FANOUT_CAP}，实测 ${peak}`);
  assert.deepEqual(entered, hostNames(16), '排队必须 FIFO：后来的插队会饿死前面的');
  assert.deepEqual(gate.stats(), { inFlight: 0, waiting: 0 }, '闸没还干净：额度泄漏一次就少一条');
});

test('退避上界就是 2^n 秒封顶 30s，抖动只在半程到满程之间（§5.4）', () => {
  const ceilings = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000];
  ceilings.forEach((ceiling, attempt) => {
    assert.equal(backoffDelay(attempt, () => 1), ceiling, `attempt=${attempt} 的上界`);
    assert.equal(backoffDelay(attempt, () => 0), ceiling / 2, `attempt=${attempt} 的下界（半程抖动）`);
  });
  // 上界单调不减且封顶：任何一档突破 30s，「合盖睡醒」的等待就会长到用户以为坏了
  let previous = 0;
  for (let attempt = 0; attempt <= 20; attempt += 1) {
    const upper = backoffDelay(attempt, () => 1);
    assert.ok(upper >= previous, `attempt=${attempt} 的上界回退了`);
    assert.ok(upper <= 30_000, `attempt=${attempt} 的上界 ${upper}ms 冲破 30s 封顶`);
    previous = upper;
  }
});

// ── 巡检：不叠加、不重复劳动 ─────────────────────────────────────────────

/**
 * 一台「表面 running、转发通道已经不通」的主机：真隧道子进程在，但它转发到的远端端口
 * 上没人监听，于是 probeForward 必然失败——这正是巡检深核被触发的现场。
 *
 * 全用真东西（真子进程、真 store、真账本）：`tunnel` / `monitor` 是 ESM 命名空间，
 * 导出不可改写，mock 不了；而这条路本来也值得走真的。
 */
async function runningButBroken(t) {
  const name = 'gpu-01';
  const harness = await fixture(t, [name]);
  const localPort = await nextPort();
  const remotePort = await nextPort();
  const fingerprint = `dsh web --no-open --host 127.0.0.1 --port ${remotePort}`;

  // 假远端那侧要有个**真活着**的进程：垫片的 alive() 会去 kill(pid, 0)，深核只有判活
  // 才走到「重建隧道」而不是「crashed」。借一个自己起的哨兵进程——不能借本进程 pid，
  // harness.cleanup() 会把登记过的 pid 逐个 SIGKILL（那就把测试自己杀了）。
  const sentinel = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore' });
  t.after(() => { try { sentinel.kill('SIGKILL'); } catch { /* 已退出 */ } });
  harness.setHost(name, {
    faults: { slowReplyMs: RTT_MS },
    processes: { [String(sentinel.pid)]: { args: fingerprint, port: remotePort } },
  });

  store.mutateHostState(name, (st) => {
    st.web = {
      pid: sentinel.pid, port: remotePort, startedByUs: true, cmdFingerprint: fingerprint,
    };
  });
  store.setPhase(name, 'ready', 'perf-fixture');
  store.setPhase(name, 'starting', 'perf-fixture');
  store.setPhase(name, 'running', 'perf-fixture');
  await tunnel.open(name, { localPort, remotePort });
  assert.equal(await tunnel.probeForward(localPort, 300), false, '转发通道本该不通，判据前提没成立');
  return { name, harness };
}

test('monitor.tick 不叠加：上一轮没结束时后来的直接跳过', async (t) => {
  // 深核那次 ssh 有 slowReplyMs 的 120ms，重叠窗口足够
  const { harness } = await runningButBroken(t);

  const first = monitor.tick();
  const overlapping = await Promise.all([monitor.tick(), monitor.tick(), monitor.tick()]);
  assert.deepEqual(
    overlapping,
    [{ skipped: true }, { skipped: true }, { skipped: true }],
    '重入没被挡住：慢 ssh 会一轮压一轮叠上去',
  );
  assert.equal((await first).skipped, undefined, '第一拍必须真跑');

  // 三次被跳过的拍不许偷偷发过 ssh——「跳过」得是真的什么都没做
  const verifies = harness.transportEvents().filter((e) => e.kind === 'verify' && e.phase !== 'end');
  assert.equal(verifies.length, 1, `一拍只该有一次 VERIFY，实测 ${verifies.length} 次`);

  // 第一拍收了之后闸重新放开，否则巡检就此停摆
  const after = await monitor.tick();
  assert.equal(after.skipped, undefined, '上一轮结束后没放开闸，巡检就此停摆');
});

test('单主机深核恒 1 次 ssh：端口不通只换来一次 VERIFY', async (t) => {
  const { name, harness } = await runningButBroken(t);

  const result = await monitor.checkOne(name);
  assert.equal(result.outcome, 'restarted', `深核应判活并重建隧道，实为 ${result.outcome}`);
  const verifies = harness.transportEvents().filter((e) => e.kind === 'verify' && e.phase !== 'end');
  assert.equal(verifies.length, 1, `一次深核只许一次 VERIFY，实测 ${verifies.length} 次`);
  assert.equal(
    harness.transportEvents().filter((e) => e.kind === 'probe').length,
    0,
    '深核不该顺手再来一轮 PROBE：那是探测的活，重复劳动在 N 台上会翻 N 倍',
  );
});

// ── 同主机串行：hostQueue 绝无并发 ───────────────────────────────────────

test('同主机 hostQueue 绝无并发：20 个作业首尾相接，跨主机才并行', async (t) => {
  await fixture(t, ['gpu-01', 'gpu-02']);

  const marks = [];
  const job = (host, index) => hostQueue(host).run(`perf-${index}`, async () => {
    marks.push(`${host}:in:${index}`);
    await sleep(1);
    marks.push(`${host}:out:${index}`);
  });

  await Promise.all([
    ...Array.from({ length: 20 }, (_, i) => job('gpu-01', i)),
    ...Array.from({ length: 20 }, (_, i) => job('gpu-02', i)),
  ]);

  for (const host of ['gpu-01', 'gpu-02']) {
    const own = marks.filter((m) => m.startsWith(`${host}:`));
    assert.equal(own.length, 40, `${host} 的作业没全跑完`);
    for (let i = 0; i < own.length; i += 2) {
      const [enter, leave] = [own[i], own[i + 1]];
      assert.equal(enter, `${host}:in:${i / 2}`, `${host} 的入队顺序被打乱：${own.join(' ')}`);
      assert.equal(leave, `${host}:out:${i / 2}`, `${host} 上出现了并发：${own.join(' ')}`);
    }
  }
  // 两台交错才说明「串行只在同主机内」，否则这条判据可能是被全局串行蒙对的
  const firstOther = marks.findIndex((m) => m.startsWith('gpu-02:'));
  assert.ok(firstOther < 40, `gpu-02 直到 gpu-01 全跑完才开始（index=${firstOther}）：串行串到了主机之间`);
});

// ── 落盘：一次 start 的 state.json 写次数 ────────────────────────────────

test('state.json 落盘有 debounce：连续 40 次改动合并到 ≤ 3 次写', async (t) => {
  await fixture(t, ['gpu-01']);

  let writes = 0;
  const original = fs.renameSync.bind(fs);
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (String(to).endsWith('state.json')) writes += 1;
    return original(from, to);
  });

  for (let i = 0; i < 40; i += 1) {
    store.mutateHostState('gpu-01', (st) => { st.probe = { at: new Date().toISOString(), n: i }; });
  }
  // debounce 是 100ms 一档；等两档，让该落的都落完
  await sleep(store.STATE_DEBOUNCE_MS * 3);
  store.flushStateSync();

  assert.ok(writes >= 1, '一次都没落盘：debounce 把状态吞了，manager 重启会丢一整段');
  assert.ok(
    writes <= 3,
    `40 次改动落了 ${writes} 次盘：debounce 失效，高频改动会把磁盘打满 fsync`,
  );
});
