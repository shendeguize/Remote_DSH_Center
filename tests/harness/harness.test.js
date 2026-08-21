/**
 * TST-01/02/03 验收：引擎输出与 12 §1 协议终稿一致、两次 ssh 调用间状态持续、
 * 每个场景可独立激活。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

import { createHarness, FAKE_SSH } from './index.js';
import { unshq } from './shell-word.js';
import { buildProbeScript, kvOne, parseProtoOutput } from '../../src/lib/proto.js';
import { sshExec } from '../../src/lib/ssh.js';
import {
  captureFingerprint,
  runLaunchSequence,
  stopRemote,
  tailRemoteLog,
  verifyRemote,
  _setWait,
} from '../../src/launcher.js';
import { interpretProbe, probeOnce } from '../../src/prober.js';
import { syncPatches } from '../../src/patchsync.js';

/** 拉起协议的 POLL 节奏在测试里压到最小，避免真等 9 秒。 */
_setWait((ms) => new Promise((r) => { setTimeout(r, Math.min(ms, 20)); }));

function harnessFixture(t, hosts) {
  const h = createHarness(hosts ? { hosts } : undefined);
  const restore = h.activate();
  t.after(() => { restore(); h.cleanup(); });
  return h;
}

test('unshq 是 shq 的逆（垫片解包正确性）', () => {
  for (const s of ['abc', "it's", 'a b', '', 'x; rm -rf ~', '深度 v2', "''"]) {
    const quoted = `'${s.split("'").join("'\\''")}'`;
    assert.equal(unshq(quoted), s, JSON.stringify(s));
  }
});

test('PROBE：健康主机回放 ready，输出符合协议且哨兵齐备', async (t) => {
  const h = harnessFixture(t);
  const res = await sshExec('gpu-1', buildProbeScript());
  assert.equal(res.code, 0);

  const out = parseProtoOutput(res.stdout, { requireDone: 'PROBE_DONE' });
  assert.equal(kvOne(out, 'DSH_BIN'), '/usr/bin/dsh');
  assert.equal(kvOne(out, 'DSH_VERSION'), '0.1.0-rc.7');
  assert.equal(kvOne(out, 'PROFILE_WEB'), 'yes');
  assert.equal(out.blocks.RUNNING_DSH_WEB, '');
  assert.deepEqual(out.stray, []);

  const result = interpretProbe(res);
  assert.equal(result.phase, 'ready');
  assert.equal(h.hostState('gpu-1').dshInstalled, true);
});

test('PROBE 三分类：ready / no_dsh(两种原因) / unreachable', async (t) => {
  const h = harnessFixture(t, {
    ok: undefined, // 由下方 scenario 填充
  });
  h.scenario('ok', 'healthy');
  h.scenario('nobin', 'no-dsh-missing-bin');
  h.scenario('noprofile', 'no-dsh-no-profile');
  h.scenario('down', 'unreachable');
  h.scenario('badkey', 'hostkey-fail');

  assert.equal((await probeOnce('ok')).phase, 'ready');

  const nobin = await probeOnce('nobin');
  assert.equal(nobin.phase, 'no_dsh');
  assert.equal(nobin.noDshReason, 'missing-bin');

  const noprofile = await probeOnce('noprofile');
  assert.equal(noprofile.phase, 'no_dsh');
  assert.equal(noprofile.noDshReason, 'no-web-profile');
  assert.equal(noprofile.dshPath, '/usr/bin/dsh', 'dsh 在，只是 profile 缺');

  const down = await probeOnce('down');
  assert.equal(down.phase, 'unreachable');
  assert.match(down.stderr, /Operation timed out/);

  const badkey = await probeOnce('badkey');
  assert.equal(badkey.phase, 'unreachable');
  assert.match(badkey.stderr, /Host key verification failed/);
});

test('conn-timeout 场景触发 sshExec 强杀链', async (t) => {
  const h = harnessFixture(t);
  h.scenario('gpu-1', 'conn-timeout', 30_000);

  const res = await sshExec('gpu-1', buildProbeScript(), { timeoutMs: 500 });
  assert.equal(res.timedOut, true);
  assert.equal(interpretProbe(res).phase, 'unreachable');
});

test('LAUNCH → POLL → VERIFY 全路径：拿到实际端口、指纹、真实可连的假 dsh web', async (t) => {
  const h = harnessFixture(t);

  const r = await runLaunchSequence('gpu-1', { port: 18899 });
  assert.equal(r.actualPort, 18899, '固定端口拉起');
  assert.equal(r.logName, 'web-18899.log');
  assert.equal(r.fingerprint, 'dsh web --no-open --host 127.0.0.1 --port 18899');

  // 状态在多次 ssh 调用之间持续
  const live = h.liveProcesses('gpu-1');
  assert.equal(live.length, 1);
  assert.equal(live[0].pid, r.pid);

  // 假 dsh web 是真的在监听
  await new Promise((resolve, reject) => {
    const sock = net.connect(r.actualPort, '127.0.0.1');
    sock.on('connect', () => { sock.destroy(); resolve(); });
    sock.on('error', reject);
  });

  const v = await verifyRemote('gpu-1', { pid: r.pid, port: r.actualPort, fingerprint: r.fingerprint });
  assert.equal(v.alive, true);
  assert.equal(v.fingerprintMatch, true);

  const log = await tailRemoteLog('gpu-1', { logName: r.logName, lines: 50 });
  assert.match(log, /dsh web: http:\/\/127\.0\.0\.1:18899/);
});

test('注入值（env / extraArgs / patch）进入远端命令行与指纹', async (t) => {
  const h = harnessFixture(t);
  const r = await runLaunchSequence('gpu-1', {
    port: 18901,
    env: { GREETING: "hi 'there'" },
    extraArgs: ['--verbose', 'x; rm -rf ~'],
    patchRemoteNames: ['aaaaaaaaaaaa-a.yml'],
  });

  const proc = h.liveProcesses('gpu-1')[0];
  assert.equal(proc.env.GREETING, "hi 'there'", '单引号经双层转义原样抵达');
  assert.deepEqual(proc.extraArgs, ['--verbose', 'x; rm -rf ~'], '危险字符未被解释为 shell 语法');
  assert.deepEqual(proc.patches, ['aaaaaaaaaaaa-a.yml']);
  assert.match(r.fingerprint, /--patch \/root\/\.dsh_center_remote\/patches\/aaaaaaaaaaaa-a\.yml/);
});

test('bind-busy-once：降级 --port 0 重拉，actualPort 为 OS 分配值，logName 为 auto 命名', async (t) => {
  const h = harnessFixture(t);
  h.scenario('gpu-1', 'bind-busy-once');

  const r = await runLaunchSequence('gpu-1', { port: 18902 });
  assert.notEqual(r.actualPort, 18902);
  assert.ok(r.actualPort > 0 && r.actualPort <= 65535);
  assert.match(r.logName, /^web-auto-[a-z0-9]+\.log$/);
  assert.equal(r.fingerprint, 'dsh web --no-open --host 127.0.0.1 --port 0', '降级进程命令行只含字面 0');
});

test('bind-busy-twice：两次失败 → LAUNCH_FAILED，detail 含两份日志尾', async (t) => {
  const h = harnessFixture(t);
  h.scenario('gpu-1', 'bind-busy-twice');

  await assert.rejects(
    () => runLaunchSequence('gpu-1', { port: 18903 }),
    (err) => {
      assert.equal(err.code, 'LAUNCH_FAILED');
      assert.match(err.detail, /第 1 次拉起/);
      assert.match(err.detail, /第 2 次拉起/);
      assert.match(err.detail, /EADDRINUSE/);
      return true;
    },
  );
  assert.deepEqual(h.liveProcesses('gpu-1'), [], '失败后远端无孤儿进程');
});

test('launch-dies：进程启动即崩 → 快败（不等满 5 拍）', async (t) => {
  const h = harnessFixture(t);
  h.scenario('gpu-1', 'launch-dies');

  const started = Date.now();
  await assert.rejects(
    () => runLaunchSequence('gpu-1', { port: 18913 }),
    (err) => {
      assert.equal(err.code, 'LAUNCH_FAILED');
      assert.match(err.message, /立即退出/);
      assert.match(err.detail, /failed to load web profile/);
      return true;
    },
  );
  assert.ok(Date.now() - started < 3_000, 'ALIVE=no 应快败而非耗尽轮询');
  assert.deepEqual(h.liveProcesses('gpu-1'), []);
});

test('workdir：cd 段抵达假远端，绝对路径与 ~ 都还原为远端真实路径', async (t) => {
  const h = harnessFixture(t);

  await runLaunchSequence('gpu-1', { port: 18914, workdir: '/root/my proj' });
  assert.equal(h.hostState('gpu-1').workdir, '/root/my proj', '空格不该被 shell 分词');
  assert.equal(h.liveProcesses('gpu-1')[0].workdir, '/root/my proj');

  await runLaunchSequence('gpu-1', { port: 18915, workdir: '~/proj' });
  assert.equal(h.hostState('gpu-1').workdir, '/root/proj', '~ 由远端展开，不在 manager 侧拼');
});

test('workdir=null：脚本无 cd 段，引擎记录 null（回归锁）', async (t) => {
  const h = harnessFixture(t);
  await runLaunchSequence('gpu-1', { port: 18916 });
  assert.equal(h.hostState('gpu-1').workdir, null);
});

test('workdir-missing 场景：ERR=workdir + 退出码 8 → LAUNCH_FAILED（不误报不可达）', async (t) => {
  const h = harnessFixture(t);
  h.scenario('gpu-1', 'workdir-missing');

  await assert.rejects(
    () => runLaunchSequence('gpu-1', { port: 18917, workdir: '/no/such/dir' }),
    (err) => {
      assert.equal(err.code, 'LAUNCH_FAILED', '退出码 8 不该被归成 SSH_UNREACHABLE');
      assert.match(err.message, /工作目录不存在或不可进入/);
      assert.match(err.detail, /目标目录：\/no\/such\/dir/);
      return true;
    },
  );
  assert.deepEqual(h.liveProcesses('gpu-1'), [], 'cd 失败即无进程可孤儿');
});

test('workdir-missing 场景对 workdir=null 无效（没有 cd 就没有 cd 失败）', async (t) => {
  const h = harnessFixture(t);
  h.scenario('gpu-1', 'workdir-missing');
  const r = await runLaunchSequence('gpu-1', { port: 18918 });
  assert.equal(r.actualPort, 18918);
});

test('STOP：指纹全等 → term；再停一次 → already-dead', async (t) => {
  const h = harnessFixture(t);
  const r = await runLaunchSequence('gpu-1', { port: 18904 });

  const stop1 = await stopRemote('gpu-1', { pid: r.pid, fingerprint: r.fingerprint });
  assert.ok(['term', 'force'].includes(stop1.killed));
  assert.deepEqual(h.liveProcesses('gpu-1'), []);

  const stop2 = await stopRemote('gpu-1', { pid: r.pid, fingerprint: r.fingerprint });
  assert.equal(stop2.killed, 'already-dead');
});

test('pid-reuse：指纹不符 → KILLED=no 且进程不死（不误杀）', async (t) => {
  const h = harnessFixture(t);
  const r = await runLaunchSequence('gpu-1', { port: 18905 });
  h.reusePid('gpu-1', 'dsh web --no-open --host 127.0.0.1 --port 9999');

  const stop = await stopRemote('gpu-1', { pid: r.pid, fingerprint: r.fingerprint });
  assert.equal(stop.killed, 'no');
  assert.equal(stop.reason, 'fingerprint-mismatch');
  assert.equal(stop.actualArgs, 'dsh web --no-open --host 127.0.0.1 --port 9999');
  assert.equal(h.liveProcesses('gpu-1').length, 1, '拒杀后进程仍在');
});

test('remote-crash：VERIFY 得 ALIVE=no', async (t) => {
  const h = harnessFixture(t);
  const r = await runLaunchSequence('gpu-1', { port: 18906 });
  h.crash('gpu-1');

  const v = await verifyRemote('gpu-1', { pid: r.pid, port: r.actualPort, fingerprint: r.fingerprint });
  assert.equal(v.alive, false);
  assert.equal(v.fingerprintMatch, null, '进程没了就无从比对');
});

test('captureFingerprint 在进程已死时抛 LAUNCH_FAILED', async (t) => {
  const h = harnessFixture(t);
  const r = await runLaunchSequence('gpu-1', { port: 18907 });
  h.crash('gpu-1');
  await assert.rejects(
    () => captureFingerprint('gpu-1', { pid: r.pid, port: r.actualPort }),
    (e) => e.code === 'LAUNCH_FAILED',
  );
});

test('VERIFY 回带 CWD：反映实际工作目录，不可读时降级为 null', async (t) => {
  const h = harnessFixture(t);

  const withWd = await runLaunchSequence('gpu-1', { port: 18919, workdir: '~/proj' });
  assert.equal(withWd.cwd, '/root/proj', '拉起时顺带取回，不多花一趟 ssh');

  const bare = await runLaunchSequence('gpu-1', { port: 18920 });
  assert.equal(bare.cwd, '/root', '无 cd 段时就是远端家目录');

  h.scenario('gpu-1', 'no-proc-cwd');
  const blind = await runLaunchSequence('gpu-1', { port: 18921, workdir: '/root/proj' });
  assert.equal(blind.cwd, null, 'CWD=unknown 归 null，绝不当成失败');
  assert.ok(blind.pid > 0, '拿不到 cwd 不影响拉起成功');
});

test('CWD 不进不误杀判据：cwd 变了照样按指纹停掉', async (t) => {
  const h = harnessFixture(t);
  const r = await runLaunchSequence('gpu-1', { port: 18922, workdir: '/root/proj' });

  h.faults('gpu-1', { noProcCwd: true }); // 复核拿不到 cwd（进程登记不动）
  const v = await verifyRemote('gpu-1', { pid: r.pid, port: r.actualPort, fingerprint: r.fingerprint });
  assert.equal(v.cwd, null);
  assert.equal(v.alive, true, '判据只有 PID 存活与 ARGS 全等');
  assert.equal(v.fingerprintMatch, true);
});

test('no-ss 场景：LISTEN=unknown 不作否定证据', async (t) => {
  const h = harnessFixture(t);
  h.scenario('gpu-1', 'no-ss');
  const r = await runLaunchSequence('gpu-1', { port: 18908 });
  const v = await verifyRemote('gpu-1', { pid: r.pid, port: r.actualPort, fingerprint: r.fingerprint });
  assert.equal(v.listen, 'unknown');
  assert.equal(v.alive, true);
});

test('日志缺失时返回 (no log)', async (t) => {
  harnessFixture(t);
  const text = await tailRemoteLog('gpu-1', { logName: 'web-nonexistent.log', lines: 10 });
  assert.match(text, /\(no log\)/);
});

test('patch 同步：首传上载、hash 未变跳过、改内容换名、旧文件被清理', async (t) => {
  const h = harnessFixture(t);
  const fs = await import('node:fs');
  const path = await import('node:path');
  const p = path.join(h.root, 'a.yml');
  fs.writeFileSync(p, 'version: 1\n');

  const first = await syncPatches('gpu-1', [p]);
  assert.equal(first.uploaded, 1);
  assert.equal(first.skipped, 0);
  const name1 = first.remoteNames[0];
  assert.match(name1, /^[0-9a-f]{12}-a\.yml$/);
  assert.equal(h.remoteFiles('gpu-1')[`.dsh_center_remote/patches/${name1}`], 'version: 1\n');

  const second = await syncPatches('gpu-1', [p], first.patchSync);
  assert.equal(second.uploaded, 0);
  assert.equal(second.skipped, 1, 'hash 未变则跳过');

  fs.writeFileSync(p, 'version: 2\n');
  const third = await syncPatches('gpu-1', [p], second.patchSync);
  assert.equal(third.uploaded, 1);
  const name2 = third.remoteNames[0];
  assert.notEqual(name2, name1, '内容变则名变');

  const files = Object.keys(h.remoteFiles('gpu-1'));
  assert.deepEqual(files, [`.dsh_center_remote/patches/${name2}`], '清理协议删掉了旧 hash 版本');
});

test('patch 同步：本地文件不可读 → VALIDATION 快败', async (t) => {
  harnessFixture(t);
  await assert.rejects(
    () => syncPatches('gpu-1', ['/definitely/not/here.yml']),
    (e) => e.code === 'VALIDATION',
  );
});

test('scp-fail 场景：整个同步快败', async (t) => {
  const h = harnessFixture(t);
  h.scenario('gpu-1', 'scp-fail');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const p = path.join(h.root, 'b.yml');
  fs.writeFileSync(p, 'x\n');

  await assert.rejects(() => syncPatches('gpu-1', [p]), (e) => e.code === 'SSH_UNREACHABLE');
});

test('探测发现手动实例（RUNNING_DSH_WEB 块 → manualInstances）', async (t) => {
  const h = harnessFixture(t);
  const r = await runLaunchSequence('gpu-1', { port: 18909 });

  const result = await probeOnce('gpu-1');
  assert.equal(result.phase, 'ready');
  assert.equal(result.manualInstances.length, 1);
  assert.equal(result.manualInstances[0].pid, r.pid);
  assert.equal(result.manualInstances[0].args, r.fingerprint);
});

test('探测不把自己那层 sh -c 记成手动实例（真机自匹配回归）', async (t) => {
  harnessFixture(t);

  // 空场：远端一个 dsh web 都没跑，manualInstances 必须是空的。
  // 修前的模板 grep "[d]sh.*web" 会命中脚本自身的命令行（里头既有 command -v dsh
  // 又有 profiles/web），凭空造出一条幻影，页面于是恒显「另有 1 个手动实例」。
  const ready = await probeOnce('gpu-1');
  assert.equal(ready.phase, 'ready');
  assert.deepEqual(ready.manualInstances, [], `不该有幻影：${JSON.stringify(ready.manualInstances)}`);

  // 没装 dsh 的主机同样中招过——那条 sh -c 与 dsh 是否存在无关。
  const h2 = harnessFixture(t, {});
  h2.scenario('nobin', 'no-dsh-missing-bin');
  const noDsh = await probeOnce('nobin');
  assert.equal(noDsh.phase, 'no_dsh');
  assert.deepEqual(noDsh.manualInstances, []);
});

test('slow-probe 场景不阻塞其他主机（并行探测）', async (t) => {
  const h = harnessFixture(t, {});
  h.scenario('slow', 'slow-probe', 700);
  h.scenario('fast', 'healthy');

  const started = Date.now();
  const [slow, fast] = await Promise.all([probeOnce('slow'), probeOnce('fast')]);
  const elapsed = Date.now() - started;

  assert.equal(slow.phase, 'ready');
  assert.equal(fast.phase, 'ready');
  assert.ok(elapsed < 1600, `并行应远快于串行，实测 ${elapsed}ms`);
});

test('隧道垫片：ssh -N -L 转发到假 dsh web，杀垫片即隧道断', async (t) => {
  const h = harnessFixture(t);
  const { spawn } = await import('node:child_process');
  const r = await runLaunchSequence('gpu-1', { port: 18910 });

  const localPort = 27910;
  const child = spawn(process.execPath, [
    FAKE_SSH,
    '-N', '-L', `127.0.0.1:${localPort}:127.0.0.1:${r.actualPort}`,
    'gpu-1',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill('SIGKILL'));

  // 等本地监听就绪
  await waitConnect(localPort);
  const res = await fetch(`http://127.0.0.1:${localPort}/api/health`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).label, 'gpu-1');

  const exited = new Promise((resolve) => child.on('close', (code, sig) => resolve({ code, sig })));
  child.kill('SIGUSR1');
  const { code } = await exited;
  assert.equal(code, 255, 'tunnel-drop：垫片自杀模拟网络中断');
});

test('forward-disabled 场景：本地监听建立但每次连接被掐断并打 stderr', async (t) => {
  const h = harnessFixture(t);
  const { spawn } = await import('node:child_process');
  h.scenario('gpu-1', 'forward-disabled');

  const localPort = 27911;
  const child = spawn(process.execPath, [
    FAKE_SSH,
    '-N', '-L', `127.0.0.1:${localPort}:127.0.0.1:19999`,
    'gpu-1',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill('SIGKILL'));

  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });

  await waitConnect(localPort);
  await assert.rejects(() => fetch(`http://127.0.0.1:${localPort}/`));
  await new Promise((r) => setTimeout(r, 100));
  assert.match(stderr, /administratively prohibited/);
  assert.equal(child.exitCode, null, '子进程不退出——这正是 11 §5.3 修正要处理的情形');
});

test('本机端口被占：隧道垫片报 cannot listen to port 并退出 255', async (t) => {
  harnessFixture(t);
  const { spawn } = await import('node:child_process');

  const blocker = net.createServer();
  await new Promise((r) => blocker.listen(27912, '127.0.0.1', r));
  t.after(() => blocker.close());

  const child = spawn(process.execPath, [
    FAKE_SSH,
    '-N', '-L', '127.0.0.1:27912:127.0.0.1:19999',
    'gpu-1',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  const { code } = await new Promise((r) => child.on('close', (c, s) => r({ code: c, sig: s })));

  assert.equal(code, 255);
  assert.match(stderr, /Address already in use/);
  assert.match(stderr, /cannot listen to port: 27912/);
});

test('孤儿看护：装置拥有者进程没了，假 dsh web 自己退（打断的运行不留残骸）', async (t) => {
  const h = harnessFixture(t);
  const dead = await deadPid();
  // 模拟「起垫片的那次运行已经不在了」：把拥有者指向一个确定已死的 pid
  process.env.DSHC_HARNESS_OWNER_PID = String(dead);

  await runLaunchSequence('gpu-1', { port: 0 });
  const [pid] = Object.keys(h.hostState('gpu-1').processes);

  const gone = await waitGone(Number(pid), 6_000);
  assert.ok(gone, `拥有者 ${dead} 已死，垫片 ${pid} 应自行退出`);
});

test('孤儿看护不误杀：拥有者还活着，假 dsh web 照常服务', async (t) => {
  const h = harnessFixture(t);

  const r = await runLaunchSequence('gpu-1', { port: 0 });
  const [pid] = Object.keys(h.hostState('gpu-1').processes);

  await new Promise((res) => { setTimeout(res, 1_500); });
  assert.ok(alive(Number(pid)), '拥有者健在期间不许自杀');
  const got = await fetch(`http://127.0.0.1:${r.actualPort}/api/health`);
  assert.equal(got.status, 200);
});

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** 造一个「确定已经死掉」的 pid：起个立刻自退的子进程，等它 close 后回收其 pid。 */
async function deadPid() {
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
  await new Promise((r) => child.on('close', r));
  return child.pid;
}

async function waitGone(pid, budgetMs) {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    // eslint-disable-next-line no-await-in-loop -- 轮询等进程消失
    await new Promise((r) => { setTimeout(r, 100); });
  }
  return false;
}

function waitConnect(port, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const sock = net.connect(port, '127.0.0.1');
      sock.once('connect', () => { sock.destroy(); resolve(); });
      sock.once('error', () => {
        sock.destroy();
        if (Date.now() > deadline) reject(new Error(`端口 ${port} 未就绪`));
        else setTimeout(attempt, 50);
      });
    };
    attempt();
  });
}
