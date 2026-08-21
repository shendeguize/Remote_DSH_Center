import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  COMMON_SSH_OPTS,
  TUNNEL_SSH_OPTS,
  SSH_OUTPUT_CAP_BYTES,
  sshExec,
  scpTo,
  execFailure,
  hostQueue,
  shutdownSsh,
  reopenSsh,
  liveChildCount,
  _resetQueues,
} from '../../src/lib/ssh.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-ssh-'));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

/**
 * 写一个假 ssh/scp 垫片，返回 DSHC_SSH_BIN 形式的「node + 脚本路径」。
 * 必须让 node 成为直接子进程：经 shebang 或 sh 包装启动会丢掉发给子进程的信号，
 * 无法验证 TERM→KILL 强杀链。
 */
function shim(name, body) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, body, { mode: 0o644 });
  return `${process.execPath} ${p}`;
}

const ARGV_DUMP = shim('argv-dump.cjs', `
process.stdout.write(JSON.stringify(process.argv.slice(2)));
`);

const SLOW = shim('slow.cjs', `
const fs = require('node:fs');
setTimeout(() => { fs.writeSync(1, 'late'); }, 60000);
process.on('SIGTERM', () => { fs.writeSync(1, 'got-term'); process.exit(0); });
`);

const IGNORE_TERM = shim('ignore-term.cjs', `
process.on('SIGTERM', () => {});
setInterval(() => {}, 1000);
`);

const FAIL = shim('fail.cjs', `
process.stderr.write('ssh: connect to host x port 22: Connection refused');
process.exit(255);
`);

/**
 * 狂吐的远端：先刷 N MB，最后才打我们要的那行。
 * 真机对应两种常见货色——日志里带 \\r 的进度条（整段就是一行），
 * 以及刷屏的 .bashrc/motd（每条一次性 ssh 都走登录 shell）。
 */
const SPEW = shim('spew.cjs', `
const mb = Number(process.env.DSHC_TEST_SPEW_MB || '600');
const fd = process.env.DSHC_TEST_SPEW_FD === '2' ? process.stderr : process.stdout;
const chunk = Buffer.alloc(1 << 20, 0x61);
(function pump(i) {
  if (i >= mb) { fd.write('\\nMARKER=tail-survived\\n'); return; }
  if (fd.write(chunk)) pump(i + 1);
  else fd.once('drain', () => pump(i + 1));
}(0));
`);

test('COMMON_SSH_OPTS / TUNNEL_SSH_OPTS 与契约逐字一致', () => {
  assert.deepEqual([...COMMON_SSH_OPTS], [
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=6',
    '-o', 'StrictHostKeyChecking=accept-new',
  ]);
  assert.deepEqual([...TUNNEL_SSH_OPTS], [
    ...COMMON_SSH_OPTS,
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'ExitOnForwardFailure=yes',
  ]);
});

test('sshExec argv：统一参数 + host + sh -c <shq(body)>（12 §0）', async (t) => {
  t.after(() => { delete process.env.DSHC_SSH_BIN; });
  process.env.DSHC_SSH_BIN = ARGV_DUMP;

  const res = await sshExec('gpu-1', "echo 'hi'; ls");
  assert.equal(res.code, 0);
  const argv = JSON.parse(res.stdout);
  assert.deepEqual(argv.slice(0, 6), [...COMMON_SSH_OPTS]);
  assert.equal(argv[6], 'gpu-1');
  assert.equal(argv[7], "sh -c 'echo '\\''hi'\\''; ls'");
});

test('sshExec 拒绝危险 host 名（ssh 参数位注入）', async () => {
  await assert.rejects(() => sshExec('-oProxyCommand=x', 'ls'), (e) => e.code === 'VALIDATION');
});

test('sshExec 超时：TERM 强杀并标记 timedOut，不 reject', async (t) => {
  t.after(() => { delete process.env.DSHC_SSH_BIN; });
  process.env.DSHC_SSH_BIN = SLOW;

  const res = await sshExec('gpu-1', 'sleep', { timeoutMs: 600 });
  assert.equal(res.timedOut, true);
  assert.equal(res.stdout, 'got-term', '先发 SIGTERM');
});

test('sshExec 对赖着不死的子进程升级到 SIGKILL', async (t) => {
  t.after(() => { delete process.env.DSHC_SSH_BIN; });
  process.env.DSHC_SSH_BIN = IGNORE_TERM;

  const res = await sshExec('gpu-1', 'stubborn', { timeoutMs: 600 });
  assert.equal(res.timedOut, true);
  assert.equal(res.signal, 'SIGKILL', 'TERM 后 2s 未退则升级 KILL');
});

test('sshExec 通过 AbortSignal 中止', async (t) => {
  t.after(() => { delete process.env.DSHC_SSH_BIN; });
  process.env.DSHC_SSH_BIN = SLOW;

  const ac = new AbortController();
  const p = sshExec('gpu-1', 'sleep', { timeoutMs: 60_000, signal: ac.signal });
  setTimeout(() => ac.abort(), 400);
  const res = await p;
  assert.equal(res.aborted, true);
  assert.equal(res.timedOut, false);
});

/**
 * 回归（issue #73）：manager 退出时在飞的一次性 ssh 没人收，被交给 init 成孤儿。
 * 真机上探测有 ConnectTimeout=6 兜着，拉起/回读那几条能挂十几秒——`dshc restart`
 * 之后新老两批命令同时打同一台远端，看日志的人只能靠猜。
 */
test('shutdownSsh：关停时把在飞的一次性 ssh 一并收走', async (t) => {
  t.after(() => { delete process.env.DSHC_SSH_BIN; reopenSsh(); });
  process.env.DSHC_SSH_BIN = SLOW;

  const inFlight = [
    sshExec('gpu-1', 'sleep', { timeoutMs: 60_000 }),
    sshExec('gpu-2', 'sleep', { timeoutMs: 60_000 }),
  ];
  await new Promise((r) => { setTimeout(r, 200); }); // 等它们真的起来
  assert.equal(liveChildCount(), 2, '前提：两条 ssh 都在飞');

  shutdownSsh();
  const res = await Promise.all(inFlight);
  assert.deepEqual(res.map((r) => r.stdout), ['got-term', 'got-term'], '收的是同一条 TERM→KILL 强杀链');
  assert.equal(liveChildCount(), 0, '收完不许还挂着');

  // 闩落下之后不许再起新的：每主机队列里往往还压着后续任务（页面刚点过「全部探测」），
  // 只杀在飞的那批，队列里下一个立刻顶上来——退出过程会一直冒新 ssh，照样留孤儿。
  const after = await sshExec('gpu-1', 'sleep', { timeoutMs: 60_000 });
  assert.equal(after.aborted, true, '关停后还敢起新的 ssh');
  assert.match(after.stderr, /退出/, '要说清是因为在退出，别让调用方以为远端出了问题');
  assert.equal(liveChildCount(), 0, '压根不该 spawn');

  reopenSsh();
  const again = await sshExec('gpu-1', 'sleep', { timeoutMs: 300 });
  assert.equal(again.timedOut, true, '抬闩之后要照常能起（同进程里关停过又起来的场合）');
});

test('在飞账本：已经收场的不再挂着（不许无限长的账本）', async (t) => {
  t.after(() => { delete process.env.DSHC_SSH_BIN; });
  process.env.DSHC_SSH_BIN = ARGV_DUMP;

  for (let i = 0; i < 5; i += 1) {
    // eslint-disable-next-line no-await-in-loop -- 顺序跑，验的是收场后账本归零
    await sshExec('gpu-1', 'ls');
  }
  assert.equal(liveChildCount(), 0);
  shutdownSsh(); // 空账本上调也不许抛
  reopenSsh();
});

/**
 * 回归（issue #92）：远端吐多少 manager 就吃多少。256MB 能把 RSS 顶上去且不还，
 * 过了 V8 的字符串上限（约 512MB）就是 `RangeError: Invalid string length`——
 * 抛在流的 data 回调里没人接得住，manager 当场死、隧道全陪葬。
 */
test('sshExec 对狂吐的远端封顶：不崩、内存有界、留的是尾（issue #92）', async (t) => {
  t.after(() => { delete process.env.DSHC_SSH_BIN; delete process.env.DSHC_TEST_SPEW_MB; });
  process.env.DSHC_SSH_BIN = SPEW;
  process.env.DSHC_TEST_SPEW_MB = '600'; // 越过 V8 字符串上限，红的时候就是这里崩

  const before = process.memoryUsage().rss;
  const res = await sshExec('gpu-1', 'probe', { timeoutMs: 120_000 });
  const grew = process.memoryUsage().rss - before;

  assert.equal(res.code, 0, '封顶不该影响命令本身的成败判定');
  assert.ok(
    res.stdout.length <= SSH_OUTPUT_CAP_BYTES,
    `收上来的量必须封顶，实得 ${res.stdout.length} 字节`,
  );
  assert.ok(
    grew < 128 * 1024 * 1024,
    `远端不许决定 manager 的内存，实测涨了 ${Math.round(grew / 1048576)}MB`,
  );
  assert.match(res.stdout, /MARKER=tail-survived/, '留尾不留头：我们的 KEY=VALUE 在最后一行');
  assert.ok(res.stdoutDropped > 0, '丢了多少要记账，否则调用方没法告诉用户日志被截过');
});

test('sshExec 的 stderr 同样封顶（刷屏的 .bashrc 走的是这条）（issue #92）', async (t) => {
  t.after(() => {
    delete process.env.DSHC_SSH_BIN;
    delete process.env.DSHC_TEST_SPEW_MB;
    delete process.env.DSHC_TEST_SPEW_FD;
  });
  process.env.DSHC_SSH_BIN = SPEW;
  process.env.DSHC_TEST_SPEW_MB = '600';
  process.env.DSHC_TEST_SPEW_FD = '2';

  const res = await sshExec('gpu-1', 'probe', { timeoutMs: 120_000 });
  assert.ok(res.stderr.length <= SSH_OUTPUT_CAP_BYTES, `stderr 也得封顶，实得 ${res.stderr.length} 字节`);
  assert.ok(res.stderrDropped > 0);
  // detail 会原样进错误框/日志，封顶之后还得说清「这不是全部」
  const err = execFailure('gpu-1', '探测', { ...res, code: 1 });
  assert.match(err.detail, /截断|丢弃|过大/, `要告诉用户被截过：${err.detail.slice(-200)}`);
});

test('sshExec 连不上：code 255 + stderr，execFailure 归类 SSH_UNREACHABLE', async (t) => {
  t.after(() => { delete process.env.DSHC_SSH_BIN; });
  process.env.DSHC_SSH_BIN = FAIL;

  const res = await sshExec('gpu-1', 'probe');
  assert.equal(res.code, 255);
  const err = execFailure('gpu-1', '探测', res);
  assert.equal(err.code, 'SSH_UNREACHABLE');
  assert.match(err.detail, /Connection refused/);
});

test('sshExec 二进制不存在也不 reject（归入 stderr）', async (t) => {
  t.after(() => { delete process.env.DSHC_SSH_BIN; });
  process.env.DSHC_SSH_BIN = path.join(dir, 'definitely-missing-bin');

  const res = await sshExec('gpu-1', 'probe');
  assert.equal(res.code, null);
  assert.ok(res.stderr.length > 0);
  assert.equal(execFailure('gpu-1', '探测', res).code, 'SSH_UNREACHABLE');
});

test('execFailure 区分超时/中止/成功', () => {
  assert.equal(execFailure('h', 'x', { timedOut: true, code: null, stderr: '' }).code, 'SSH_TIMEOUT');
  assert.equal(execFailure('h', 'x', { aborted: true, code: null, stderr: '' }).code, 'SSH_TIMEOUT');
  assert.equal(execFailure('h', 'x', { code: 0, stderr: '' }), null);
});

test('scpTo argv：COMMON_SSH_OPTS + -- + host:remoteRelPath', async (t) => {
  t.after(() => { delete process.env.DSHC_SCP_BIN; });
  process.env.DSHC_SCP_BIN = ARGV_DUMP;

  const res = await scpTo('gpu-1', '/tmp/a.yml', '.dsh_center_remote/patches/aaa-a.yml');
  const argv = JSON.parse(res.stdout);
  assert.deepEqual(argv, [
    ...COMMON_SSH_OPTS,
    '--',
    '/tmp/a.yml',
    'gpu-1:.dsh_center_remote/patches/aaa-a.yml',
  ]);
});

// ── §6 每主机串行队列 ────────────────────────────────────────────────────

test('hostQueue 同 host 返回同一实例、不同 host 相互独立', () => {
  _resetQueues();
  assert.equal(hostQueue('a'), hostQueue('a'));
  assert.notEqual(hostQueue('a'), hostQueue('b'));
});

test('同主机任务串行执行', async () => {
  _resetQueues();
  const q = hostQueue('a');
  const order = [];
  const task = (id, ms) => q.run(id, async () => {
    order.push(`${id}-start`);
    await new Promise((r) => setTimeout(r, ms));
    order.push(`${id}-end`);
  });

  await Promise.all([task('t1', 40), task('t2', 5), task('t3', 1)]);
  assert.deepEqual(order, ['t1-start', 't1-end', 't2-start', 't2-end', 't3-start', 't3-end']);
});

test('前序失败不阻断后续任务，调用方各拿自己的成败', async () => {
  _resetQueues();
  const q = hostQueue('a');
  const bad = q.run('bad', async () => { throw new Error('boom'); });
  const good = q.run('good', async () => 'ok');

  await assert.rejects(() => bad, /boom/);
  assert.equal(await good, 'ok');
});

test('跨主机并行不互相排队', async () => {
  _resetQueues();
  const started = [];
  const hold = (h) => hostQueue(h).run('x', async () => {
    started.push(h);
    await new Promise((r) => setTimeout(r, 30));
  });
  const p = Promise.all([hold('a'), hold('b')]);
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(started.sort(), ['a', 'b']);
  await p;
});

test('队列超时经 signal 中止任务并抛 SSH_TIMEOUT', async () => {
  _resetQueues();
  const q = hostQueue('a');
  await assert.rejects(
    () => q.run('slow', (signal) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      setTimeout(resolve, 5_000).unref();
    }), { timeoutMs: 60 }),
    (err) => {
      assert.equal(err.code, 'SSH_TIMEOUT');
      assert.match(err.message, /slow 超时 60ms/);
      return true;
    },
  );
});

test('队列超时会强杀底层 ssh 子进程（signal 贯通到 sshExec）', async (t) => {
  t.after(() => { delete process.env.DSHC_SSH_BIN; });
  process.env.DSHC_SSH_BIN = SLOW;
  _resetQueues();

  const res = await hostQueue('a').run(
    'probe',
    (signal) => sshExec('a', 'sleep', { timeoutMs: 60_000, signal }),
    { timeoutMs: 400 },
  );
  assert.equal(res.aborted, true, '队列超时经 signal 抵达 sshExec 并杀掉子进程');
});
