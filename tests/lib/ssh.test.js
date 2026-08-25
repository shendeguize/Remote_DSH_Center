import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  COMMON_SSH_OPTS,
  TUNNEL_SSH_OPTS,
  SSH_INPUT_CAP_BYTES,
  SSH_OUTPUT_CAP_BYTES,
  localExec,
  localCopy,
  localShBin,
  sshExec,
  scpTo,
  execFailure,
  hostQueue,
  shutdownSsh,
  reopenSsh,
  liveChildCount,
  _resetQueues,
} from '../../src/lib/ssh.js';
import { exitCodeFor } from '../../src/cli.js';

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

// 装好 SIGTERM 处理器之后落一个就绪标记：想验「TERM 被收到了」的用例必须等到这个
// 标记出现才发信号。光「进程已 spawn」不够——node 启动到装上处理器之间有一段窗口，
// 信号落在窗口里会走默认处置（静默杀掉），拿到的 stdout 就是空串。用固定 sleep 赌
// 这段窗口，在并行跑满的机器上会偶发假红。
const READY_DIR = path.join(dir, 'ready');
fs.mkdirSync(READY_DIR, { recursive: true });
const SLOW = shim('slow.cjs', `
const fs = require('node:fs');
const path = require('node:path');
setTimeout(() => { fs.writeSync(1, 'late'); }, 60000);
process.on('SIGTERM', () => { fs.writeSync(1, 'got-term'); process.exit(0); });
fs.writeFileSync(path.join(${JSON.stringify(READY_DIR)}, String(process.pid)), '');
`);

/** 清掉上一个用例留下的标记——标记按 pid 命名，不清会把旧的算进这一轮。 */
function resetSlowReady() {
  fs.rmSync(READY_DIR, { recursive: true, force: true });
  fs.mkdirSync(READY_DIR, { recursive: true });
}

/** 等到 READY_DIR 里出现 n 个标记——即 n 个 SLOW 子进程都已装好 SIGTERM 处理器。 */
async function waitSlowReady(n, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const seen = fs.readdirSync(READY_DIR).length;
    if (seen >= n) return;
    assert.ok(Date.now() < deadline, `等了 ${timeoutMs}ms 只有 ${seen}/${n} 个子进程就绪`);
    await new Promise((resolve) => { setTimeout(resolve, 10); });
  }
}

const IGNORE_TERM = shim('ignore-term.cjs', `
process.on('SIGTERM', () => {});
setInterval(() => {}, 1000);
`);

const FAIL = shim('fail.cjs', `
process.stderr.write('ssh: connect to host x port 22: Connection refused');
process.exit(255);
`);

const LOCAL_RESULT = shim('local-result.cjs', `
process.stdout.write('local-out');
process.stderr.write('local-err');
process.exit(7);
`);

const STDIN_CAPTURE = shim('stdin-capture.cjs', `
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const stdinIsCharacterDevice = fs.fstatSync(0).isCharacterDevice();
const chunks = [];
process.stdin.on('data', (chunk) => chunks.push(chunk));
process.stdin.on('end', () => {
  const input = Buffer.concat(chunks);
  const text = input.toString('utf8');
  process.stdout.write(JSON.stringify({
    size: input.length,
    sha256: createHash('sha256').update(input).digest('hex'),
    argvHasInput: process.argv.slice(2).some((arg) => text !== '' && arg.includes(text)),
    envHasInput: Object.values(process.env).some((value) => text !== '' && value.includes(text)),
    stdinIsCharacterDevice,
  }));
});
`);

const CLOSE_STDIN_EARLY = shim('close-stdin-early.cjs', `
const fs = require('node:fs');
fs.closeSync(0);
setTimeout(() => process.exit(23), 50);
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

test('localExec argv：前导参数 + -c + 原始模板文本，不套远端 sh -c', async (t) => {
  t.after(() => { delete process.env.DSHC_LOCAL_SH_BIN; });
  delete process.env.DSHC_LOCAL_SH_BIN;
  assert.deepEqual(localShBin(), { bin: 'sh', prefixArgs: [] });
  process.env.DSHC_LOCAL_SH_BIN = ARGV_DUMP;

  const command = "printf '%s\\n' \"raw text\"; echo $HOME";
  assert.deepEqual(localShBin(), {
    bin: process.execPath,
    prefixArgs: [path.join(dir, 'argv-dump.cjs')],
  });
  const res = await localExec(command);
  assert.equal(res.code, 0);
  assert.deepEqual(JSON.parse(res.stdout), ['-c', command]);
});

test('sshExec/localExec 无 input 时继续把 stdin 接到 ignore', async (t) => {
  t.after(() => {
    delete process.env.DSHC_SSH_BIN;
    delete process.env.DSHC_LOCAL_SH_BIN;
  });
  process.env.DSHC_SSH_BIN = STDIN_CAPTURE;
  process.env.DSHC_LOCAL_SH_BIN = STDIN_CAPTURE;

  const remote = JSON.parse((await sshExec('gpu-1', 'capture')).stdout);
  const local = JSON.parse((await localExec('capture')).stdout);

  for (const captured of [remote, local]) {
    assert.equal(captured.size, 0);
    assert.equal(captured.stdinIsCharacterDevice, true, '无 input 必须维持 stdio=ignore，不创建 pipe');
  }
});

test('sshExec/localExec 只经 pipe 原样传入二进制 input，不进入 argv/env', async (t) => {
  t.after(() => {
    delete process.env.DSHC_SSH_BIN;
    delete process.env.DSHC_LOCAL_SH_BIN;
  });
  process.env.DSHC_SSH_BIN = STDIN_CAPTURE;
  process.env.DSHC_LOCAL_SH_BIN = STDIN_CAPTURE;
  const input = Buffer.from('dshc-stdin-only-\0-秘密-20260823');
  const expectedHash = createHash('sha256').update(input).digest('hex');

  const remoteResult = await sshExec('gpu-1', 'capture', { input });
  const localResult = await localExec('capture', { input: new Uint8Array(input) });

  for (const result of [remoteResult, localResult]) {
    assert.deepEqual(Object.keys(result).sort(), [
      'aborted',
      'code',
      'signal',
      'stderr',
      'stderrDropped',
      'stdout',
      'stdoutDropped',
      'timedOut',
    ]);
    const captured = JSON.parse(result.stdout);
    assert.equal(result.code, 0);
    assert.equal(captured.size, input.length);
    assert.equal(captured.sha256, expectedHash);
    assert.equal(captured.argvHasInput, false);
    assert.equal(captured.envHasInput, false);
    assert.equal(captured.stdinIsCharacterDevice, false);
  }
});

test('sshExec/localExec input 二次限长：exact cap 成功，cap+1 与非二进制拒绝', async (t) => {
  t.after(() => {
    delete process.env.DSHC_SSH_BIN;
    delete process.env.DSHC_LOCAL_SH_BIN;
  });
  process.env.DSHC_SSH_BIN = STDIN_CAPTURE;
  process.env.DSHC_LOCAL_SH_BIN = STDIN_CAPTURE;
  assert.equal(SSH_INPUT_CAP_BYTES, 512 * 1024);

  const exact = Buffer.alloc(SSH_INPUT_CAP_BYTES, 0xa5);
  const remote = await sshExec('gpu-1', 'capture', { input: exact });
  const local = await localExec('capture', { input: new Uint8Array(exact) });
  assert.equal(JSON.parse(remote.stdout).size, SSH_INPUT_CAP_BYTES);
  assert.equal(JSON.parse(local.stdout).size, SSH_INPUT_CAP_BYTES);

  const over = Buffer.alloc(SSH_INPUT_CAP_BYTES + 1);
  await assert.rejects(
    () => sshExec('gpu-1', 'capture', { input: over }),
    (err) => err?.code === 'VALIDATION' && /512 KiB/u.test(err.message),
  );
  await assert.rejects(
    () => localExec('capture', { input: over }),
    (err) => err?.code === 'VALIDATION' && /512 KiB/u.test(err.message),
  );
  await assert.rejects(
    () => sshExec('gpu-1', 'capture', { input: 'not-binary' }),
    (err) => err instanceof TypeError && /Buffer|Uint8Array/u.test(err.message),
  );
  await assert.rejects(
    () => localExec('capture', { input: new DataView(new ArrayBuffer(1)) }),
    (err) => err instanceof TypeError && /Buffer|Uint8Array/u.test(err.message),
  );
});

test('sshExec/localExec 子进程早退关闭 stdin 时不产生未处理 EPIPE', async (t) => {
  t.after(() => {
    delete process.env.DSHC_SSH_BIN;
    delete process.env.DSHC_LOCAL_SH_BIN;
  });
  process.env.DSHC_SSH_BIN = CLOSE_STDIN_EARLY;
  process.env.DSHC_LOCAL_SH_BIN = CLOSE_STDIN_EARLY;
  const input = Buffer.alloc(SSH_INPUT_CAP_BYTES, 0x5a);

  const remote = await sshExec('gpu-1', 'exit-early', { input });
  const local = await localExec('exit-early', { input });
  assert.equal(remote.code, 23);
  assert.equal(local.code, 23);
  assert.equal(remote.stderr, '');
  assert.equal(local.stderr, '');
});

test('localExec 保留 stdout/stderr/退出码的 ExecResult 形状', async (t) => {
  t.after(() => { delete process.env.DSHC_LOCAL_SH_BIN; });
  process.env.DSHC_LOCAL_SH_BIN = LOCAL_RESULT;

  const res = await localExec('ignored');
  assert.deepEqual(res, {
    code: 7,
    signal: null,
    stdout: 'local-out',
    stderr: 'local-err',
    stdoutDropped: 0,
    stderrDropped: 0,
    timedOut: false,
    aborted: false,
  });
  const err = execFailure('workstation', '取远端日志', res);
  assert.equal(err.code, 'LOCAL_EXEC_FAILED');
  assert.equal(err.detail, 'local-err');
  assert.match(err.message, /取本机日志失败/);
  assert.doesNotMatch(err.message, /远端|SSH/);
  assert.equal(exitCodeFor(err), 1, '本机命令失败是操作失败，不是通信故障');
});

test('localExec 与 sshExec 共用 2MB 留尾输出封顶', async (t) => {
  t.after(() => {
    delete process.env.DSHC_LOCAL_SH_BIN;
    delete process.env.DSHC_TEST_SPEW_MB;
  });
  process.env.DSHC_LOCAL_SH_BIN = SPEW;
  process.env.DSHC_TEST_SPEW_MB = '4';

  const res = await localExec('spew', { timeoutMs: 10_000 });
  assert.equal(res.code, 0);
  assert.ok(res.stdout.length <= SSH_OUTPUT_CAP_BYTES);
  assert.ok(res.stdoutDropped > 0);
  assert.match(res.stdout, /MARKER=tail-survived/);
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

test('sshExec 带满额 input 超时仍走 TERM 强杀且无未处理 stdin 错误', async (t) => {
  t.after(() => { delete process.env.DSHC_SSH_BIN; });
  process.env.DSHC_SSH_BIN = SLOW;

  const res = await sshExec('gpu-1', 'sleep', {
    timeoutMs: 300,
    input: Buffer.alloc(SSH_INPUT_CAP_BYTES),
  });
  assert.equal(res.timedOut, true);
  assert.equal(res.stdout, 'got-term');
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

test('localExec 超时映射 CLI 退出 2，并复用 timeout/AbortSignal 强杀语义', async (t) => {
  t.after(() => { delete process.env.DSHC_LOCAL_SH_BIN; });
  process.env.DSHC_LOCAL_SH_BIN = SLOW;

  const timed = await localExec('sleep', { timeoutMs: 300 });
  assert.equal(timed.timedOut, true);
  assert.equal(timed.stdout, 'got-term');
  assert.equal(execFailure('workstation', '远端探测', timed).code, 'LOCAL_TIMEOUT');
  assert.equal(
    exitCodeFor(execFailure('workstation', '远端探测', timed)),
    2,
    'LOCAL_TIMEOUT 属于超时或通信失败；普通执行/复制失败仍退出 1',
  );

  process.env.DSHC_LOCAL_SH_BIN = IGNORE_TERM;
  const killed = await localExec('stubborn', { timeoutMs: 200 });
  assert.equal(killed.timedOut, true);
  assert.equal(killed.signal, 'SIGKILL');

  process.env.DSHC_LOCAL_SH_BIN = SLOW;
  const ac = new AbortController();
  const pending = localExec('sleep', { timeoutMs: 60_000, signal: ac.signal });
  setTimeout(() => ac.abort(), 200);
  const aborted = await pending;
  assert.equal(aborted.aborted, true);
  assert.equal(aborted.timedOut, false);
});

/**
 * 回归（issue #73）：manager 退出时在飞的一次性 ssh 没人收，被交给 init 成孤儿。
 * 真机上探测有 ConnectTimeout=6 兜着，拉起/回读那几条能挂十几秒——`dshc restart`
 * 之后新老两批命令同时打同一台远端，看日志的人只能靠猜。
 */
test('shutdownSsh：关停时把在飞的一次性 ssh 一并收走', async (t) => {
  t.after(() => { delete process.env.DSHC_SSH_BIN; reopenSsh(); });
  process.env.DSHC_SSH_BIN = SLOW;

  resetSlowReady();
  const inFlight = [
    sshExec('gpu-1', 'sleep', { timeoutMs: 60_000 }),
    sshExec('gpu-2', 'sleep', { timeoutMs: 60_000 }),
  ];
  await waitSlowReady(2); // 等它们真的装好 SIGTERM 处理器，不是等一个固定时长
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

test('localExec 与 localCopy 遵从共享关停闩，reopen 后恢复', async (t) => {
  t.after(() => {
    delete process.env.DSHC_LOCAL_SH_BIN;
    delete process.env.DSHC_SSH_BIN;
    reopenSsh();
  });
  process.env.DSHC_LOCAL_SH_BIN = SLOW;
  process.env.DSHC_SSH_BIN = SLOW;

  resetSlowReady();
  const pending = [
    sshExec('gpu-1', 'sleep', { timeoutMs: 60_000 }),
    localExec('sleep', { timeoutMs: 60_000 }),
  ];
  await waitSlowReady(2);
  assert.equal(liveChildCount(), 2);
  shutdownSsh();
  const stopped = await Promise.all(pending);
  assert.deepEqual(stopped.map((res) => res.stdout), ['got-term', 'got-term']);
  assert.equal(liveChildCount(), 0);

  const blockedExec = await localExec('sleep');
  assert.equal(blockedExec.aborted, true);

  const blockedCopy = await localCopy(
    path.join(dir, 'never-read'),
    '.dsh_center_remote/patches/never-written',
  );
  assert.equal(blockedCopy.aborted, true);
  assert.equal(liveChildCount(), 0);

  reopenSsh();
  process.env.DSHC_LOCAL_SH_BIN = ARGV_DUMP;
  assert.equal((await localExec('true')).code, 0);
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

test('localCopy 在隔离 HOME 下递归建目录并复制文件', async (t) => {
  const home = fs.mkdtempSync(path.join(dir, 'local-home-'));
  const source = path.join(dir, 'patch.yml');
  const relative = '.dsh_center_remote/patches/nested/abc-patch.yml';
  fs.writeFileSync(source, 'patch-body');
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  t.after(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  });

  const res = await localCopy(source, relative);
  assert.deepEqual(res, {
    code: 0,
    signal: null,
    stdout: '',
    stderr: '',
    stdoutDropped: 0,
    stderrDropped: 0,
    timedOut: false,
    aborted: false,
  });
  assert.equal(
    fs.readFileSync(path.join(home, relative), 'utf8'),
    'patch-body',
  );
});

test('localCopy：rename 是提交点，迟到 abort 不删除已原子替换的旧目标', async (t) => {
  const home = fs.mkdtempSync(path.join(dir, 'copy-commit-home-'));
  const source = path.join(dir, 'copy-commit-source');
  const relative = '.dsh_center_remote/patches/committed.yml';
  const target = path.join(home, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(source, 'new-content');
  fs.writeFileSync(target, 'old-content');

  const previousHome = process.env.HOME;
  const originalRename = fs.promises.rename;
  const ac = new AbortController();
  process.env.HOME = home;
  fs.promises.rename = async (...args) => {
    await originalRename(...args);
    ac.abort();
  };
  t.after(() => {
    fs.promises.rename = originalRename;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  });

  const res = await localCopy(source, relative, { signal: ac.signal });

  assert.equal(res.code, 0, 'rename 已成功就必须报告成功');
  assert.equal(res.aborted, false, '提交后的迟到 abort 不得改写已完成结果');
  assert.equal(fs.readFileSync(target, 'utf8'), 'new-content', '旧目标必须被原子替换且保留新内容');
  assert.deepEqual(
    fs.readdirSync(path.dirname(target)).filter((name) => name.includes('.dshc-copy-')),
    [],
    '提交后不得残留临时文件',
  );
  assert.equal(liveChildCount(), 0);
});

test('localCopy 拒绝绝对路径、.. 穿越和 NUL', async (t) => {
  const home = fs.mkdtempSync(path.join(dir, 'escape-home-'));
  const source = path.join(dir, 'escape-source');
  fs.writeFileSync(source, 'x');
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  t.after(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  });

  for (const remotePath of [
    path.join(home, '.dsh_center_remote/absolute'),
    '.dsh_center_remote/../outside',
    '.dsh_center_remote/patches/\0bad',
  ]) {
    // eslint-disable-next-line no-await-in-loop -- 每个危险路径都必须独立拒绝
    await assert.rejects(
      () => localCopy(source, remotePath),
      (err) => err instanceof Error && err.code === 'VALIDATION',
    );
  }
  assert.equal(fs.existsSync(path.join(home, 'outside')), false);
});

test('localCopy 拒绝目标中间目录 symlink，不向 HOME 外写文件', async (t) => {
  const home = fs.mkdtempSync(path.join(dir, 'symlink-home-'));
  const outside = fs.mkdtempSync(path.join(dir, 'symlink-outside-'));
  const source = path.join(dir, 'symlink-source');
  fs.writeFileSync(source, 'must-stay-inside');
  fs.mkdirSync(path.join(home, '.dsh_center_remote'));
  fs.symlinkSync(outside, path.join(home, '.dsh_center_remote', 'patches'));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  t.after(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  });

  const res = await localCopy(
    source,
    '.dsh_center_remote/patches/nested/escaped.yml',
  );
  assert.equal(res.code, null);
  assert.match(res.stderr, /符号链接|symlink/i);
  assert.equal(
    execFailure('workstation', 'patch 上载', res).code,
    'LOCAL_COPY_FAILED',
  );
  assert.equal(fs.existsSync(path.join(outside, 'nested', 'escaped.yml')), false);
});

test('localCopy 源文件失败返回稳定 ExecResult，预中止不落正式文件', async (t) => {
  const home = fs.mkdtempSync(path.join(dir, 'copy-fail-home-'));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  t.after(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  });

  const missing = await localCopy(
    path.join(dir, 'missing-source'),
    '.dsh_center_remote/patches/missing',
  );
  assert.equal(missing.code, null);
  assert.equal(missing.aborted, false);
  assert.match(missing.stderr, /ENOENT|no such file/i);
  assert.equal(missing.stdout, '');
  assert.equal(missing.stdoutDropped, 0);
  assert.equal(missing.stderrDropped, 0);
  const copyErr = execFailure('workstation', 'patch 上载', missing);
  assert.equal(copyErr.code, 'LOCAL_COPY_FAILED');
  assert.match(copyErr.detail, /ENOENT|no such file/i);
  assert.equal(exitCodeFor(copyErr), 1);

  const source = path.join(dir, 'abort-source');
  const relative = '.dsh_center_remote/patches/aborted';
  fs.writeFileSync(source, 'do-not-copy');
  const ac = new AbortController();
  ac.abort();
  const aborted = await localCopy(source, relative, { signal: ac.signal });
  assert.equal(aborted.aborted, true);
  assert.equal(fs.existsSync(path.join(home, relative)), false);
  assert.equal(liveChildCount(), 0);
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
