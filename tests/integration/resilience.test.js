/**
 * TST-04 主干流程（二）：隧道断联与退避重连、远端崩溃分流、转发被拒挂起、
 * 巡检异常分流、manager 重启恢复（不重拉，只重建隧道）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import {
  bootServer, fetchText, monitor, server, store, tunnel, waitPhase,
} from './helpers.js';
import { liveChildCount } from '../../src/lib/ssh.js';
import { SCENARIOS, setFaults } from '../harness/scenarios.js';

/** 本进程名下还挂着几条隧道 ssh（假 ssh 垫片）。关停后必须归零，否则就是孤儿。 */
function tunnelChildren() {
  try {
    const out = execFileSync('pgrep', ['-P', String(process.pid), '-f', 'fake-ssh.js'], { encoding: 'utf8' });
    return out.split('\n').filter(Boolean);
  } catch {
    return []; // pgrep 无匹配时退出码 1
  }
}

const byName = (res, name) => res.json.hosts.find((h) => h.name === name);
const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); });

/** 收敛类判据：条件后来才成立也算过，超时才红（判据名带进错误，免得只看到一句 timeout）。 */
async function waitUntil(fn, label, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop -- 轮询
    if (await fn()) return;
    if (Date.now() > deadline) throw new Error(`等「${label}」超时 ${timeoutMs}ms`);
    // eslint-disable-next-line no-await-in-loop -- 同上
    await sleep(50);
  }
}

/** 隧道子进程被外力打断（等价 IT-06 的 kill -9 隧道）。 */
function dropTunnel(name, signal = 'SIGUSR1') {
  const pid = tunnel._childPid(name);
  assert.ok(pid, `${name} 应有隧道子进程`);
  process.kill(pid, signal);
  return pid;
}

test('隧道断联 → degraded → 退避重连 → 自动恢复 running', async (t) => {
  const ctx = await bootServer(t);
  const events = await ctx.sse();

  await ctx.api('POST', '/api/hosts/gpu-1/start');
  const running = await waitPhase(ctx, 'gpu-1', 'running');
  const firstPid = dropTunnel('gpu-1');

  const degraded = await waitPhase(ctx, 'gpu-1', 'degraded', { timeoutMs: 5_000 });
  assert.equal(degraded.tunnel?.connected ?? false, false);
  assert.equal(degraded.mappedUrl, `http://127.0.0.1:${running.tunnel.localPort}/`, 'degraded 期间 iframe 地址仍在');

  const recovered = await waitPhase(ctx, 'gpu-1', 'running', { timeoutMs: 15_000 });
  assert.equal(recovered.web.pid, running.web.pid, '远端实例不重拉');
  assert.equal(recovered.tunnel.localPort, running.tunnel.localPort, '本机端口不变');
  assert.equal(recovered.tunnel.reconnectAttempt, 0, '恢复后重连计数归零');
  assert.notEqual(tunnel._childPid('gpu-1'), firstPid, '隧道换了新子进程');
  assert.equal((await fetchText(recovered.mappedUrl)).status, 200);

  const logs = events.of('log-line').map((f) => f.data.msg);
  assert.ok(logs.some((m) => /隧道断开/.test(m)), `事件缺少断开记录：${logs.join(' | ')}`);
  assert.ok(logs.some((m) => /隧道已恢复/.test(m)), `事件缺少恢复记录：${logs.join(' | ')}`);
});

test('远端崩溃 + 隧道断联 → 重连前复核判死 → crashed（不再重连）', async (t) => {
  const ctx = await bootServer(t);
  await ctx.api('POST', '/api/hosts/gpu-1/start');
  await waitPhase(ctx, 'gpu-1', 'running');

  ctx.harness.crash('gpu-1');
  dropTunnel('gpu-1');

  const crashed = await waitPhase(ctx, 'gpu-1', 'crashed', { timeoutMs: 15_000 });
  assert.equal(crashed.tunnel, null);
  assert.equal(crashed.mappedUrl, null);
  assert.ok(crashed.web, 'web 记录保留，供页面显示「上次实例」');

  await sleep(1_500);
  assert.equal(byName(await ctx.get('/api/hosts'), 'gpu-1').phase, 'crashed', '不再反复重连');

  // crashed 可直接再 start（视作重启，02 §3.2）
  const restart = await ctx.api('POST', '/api/hosts/gpu-1/start');
  assert.equal(restart.status, 202);
  assert.equal((await waitPhase(ctx, 'gpu-1', 'running', { timeoutMs: 15_000 })).phase, 'running');
});

test('远端禁止转发：连续被拒 → 挂起 forward-disabled，不进退避环', async (t) => {
  const ctx = await bootServer(t, { hosts: { 'gpu-1': SCENARIOS['forward-disabled']() } });
  await ctx.api('POST', '/api/hosts/gpu-1/start');
  const running = await waitPhase(ctx, 'gpu-1', 'running');

  // 本地监听照常建立（11 §5.3 的实现级修正），每次连接才被掐断
  for (let i = 0; i < 3; i += 1) {
    // eslint-disable-next-line no-await-in-loop -- 逐次连接才能累计 stderr 拒绝行
    await assert.rejects(() => fetchText(running.mappedUrl));
  }

  const degraded = await waitPhase(ctx, 'gpu-1', 'degraded', { timeoutMs: 10_000 });
  assert.equal(degraded.phase, 'degraded');

  await sleep(1_500);
  const st = tunnel.status('gpu-1');
  assert.equal(st.suspendedReason, 'forward-disabled');
  assert.equal(st.reconnectAttempt, 0, '挂起态不进退避环');

  // 手动重连仍可尝试（清挂起、立即试一拍）
  const again = await ctx.api('POST', '/api/hosts/gpu-1/reconnect');
  assert.equal(again.status, 202);
});

test('degraded 期间 stop：远端照样关停、隧道撤除，回到 ready', async (t) => {
  const ctx = await bootServer(t, { hosts: { 'gpu-1': SCENARIOS['forward-disabled']() } });
  await ctx.api('POST', '/api/hosts/gpu-1/start');
  const running = await waitPhase(ctx, 'gpu-1', 'running');
  for (let i = 0; i < 3; i += 1) {
    // eslint-disable-next-line no-await-in-loop -- 逐次连接才能累计 stderr 拒绝行
    await assert.rejects(() => fetchText(running.mappedUrl));
  }
  await waitPhase(ctx, 'gpu-1', 'degraded', { timeoutMs: 10_000 });

  const stop = await ctx.api('POST', '/api/hosts/gpu-1/stop');
  assert.equal(stop.status, 202, JSON.stringify(stop.json));

  const ready = await waitPhase(ctx, 'gpu-1', 'ready', { timeoutMs: 15_000 });
  assert.equal(ready.tunnel, null);
  assert.equal(ready.mappedUrl, null);
  assert.equal(ready.web, null, 'stop 成功就该清掉 web 记录');
  assert.equal(ctx.harness.liveProcesses('gpu-1').length, 0, '远端实例必须真的没了');
  assert.equal(tunnel.status('gpu-1')?.localPort ?? null, null, '隧道条目一并撤除');
});

test('巡检：本地监听半死但远端活着 → 重建子进程；远端已死 → crashed', async (t) => {
  const ctx = await bootServer(t, { hosts: { alive: SCENARIOS.healthy(), gone: SCENARIOS.healthy() } });
  for (const n of ctx.hostNames) await ctx.api('POST', `/api/hosts/${n}/start`);
  await Promise.all(ctx.hostNames.map((n) => waitPhase(ctx, n, 'running')));

  const healthy = await monitor.tick();
  assert.deepEqual(
    healthy.results.map((r) => `${r.host}:${r.outcome}`),
    ['alive:ok', 'gone:ok'],
    `健康态巡检不动手（当前视图 ${JSON.stringify((await ctx.get('/api/hosts')).json.hosts.map((h) => [h.name, h.phase]))}）`,
  );

  const alivePid = tunnel._childPid('alive');
  dropTunnel('alive', 'SIGUSR2'); // 只关监听，进程照活
  dropTunnel('gone', 'SIGUSR2');
  ctx.harness.crash('gone');
  await sleep(200);

  const results = Object.fromEntries((await monitor.tick()).results.map((r) => [r.host, r.outcome]));
  assert.equal(results.alive, 'restarted');
  assert.equal(results.gone, 'crashed');

  assert.notEqual(tunnel._childPid('alive'), alivePid);
  assert.equal(byName(await ctx.get('/api/hosts'), 'alive').phase, 'running');
  assert.equal(byName(await ctx.get('/api/hosts'), 'gone').phase, 'crashed');
});

test('巡检：远端死了但隧道子进程照活（accept 后立刻断）→ crashed', async (t) => {
  const ctx = await bootServer(t, { hosts: { 'gpu-1': SCENARIOS.healthy() } });
  await ctx.api('POST', '/api/hosts/gpu-1/start');
  const running = await waitPhase(ctx, 'gpu-1', 'running');
  const tunnelPid = tunnel._childPid('gpu-1');

  // 真机 IT-07 的形态：只杀远端 dsh web，不碰隧道。ssh 仍在监听、仍会 accept，
  // 只是每条连接开通道失败后被掐断——所以「connect 成功」不能当健康。
  ctx.harness.crash('gpu-1');
  assert.equal(await tunnel.probeLocalPort(running.tunnel.localPort, 1_000), true, 'ssh 仍在监听');
  assert.equal(await tunnel.probeForward(running.tunnel.localPort, 1_000), false, '转发通道已不载数据');
  assert.equal(tunnel._childPid('gpu-1'), tunnelPid, '隧道子进程未退出');

  assert.equal((await monitor.tick()).results[0].outcome, 'crashed');
  const crashed = await waitPhase(ctx, 'gpu-1', 'crashed', { timeoutMs: 5_000 });
  assert.equal(crashed.tunnel, null);
  assert.equal(crashed.mappedUrl, null);
});

test('关停正撞上重连的一拍：不许再冒新的隧道子进程（issue #74）', async (t) => {
  const ctx = await bootServer(t, { hosts: { 'gpu-1': SCENARIOS.healthy() } });
  await ctx.api('POST', '/api/hosts/gpu-1/start');
  await waitPhase(ctx, 'gpu-1', 'running');

  // 让重连前复核挂住，好把关停准确插进「复核已发出、隧道还没重建」这条缝里
  setFaults('gpu-1', { connTimeoutMs: 30_000 });
  dropTunnel('gpu-1');
  const deadline = Date.now() + 10_000;
  while (liveChildCount() === 0) {
    if (Date.now() > deadline) assert.fail('等不到重连前复核发出');
    // eslint-disable-next-line no-await-in-loop -- 就是在等那一拍进到复核里
    await sleep(50);
  }

  await server._shutdownForTest();
  // 这一等必须是 ref 住的：关停之后就没别的东西吊着事件循环，unref 的定时器会被直接跳过
  await new Promise((r) => { setTimeout(r, 500); }); // 留出「被强杀的复核返回 → 那一拍继续往下走」的时间

  assert.equal(liveChildCount(), 0, '在飞的一次性 ssh 该被收走');
  assert.deepEqual(tunnelChildren(), [], '关停之后不许再有隧道子进程：那是没人管的孤儿');
});

test('manager 重启：running 主机不重拉、只重建隧道；autoStart 已运行则跳过', async (t) => {
  const ctx = await bootServer(t, {
    hosts: { keep: SCENARIOS.healthy(), lost: SCENARIOS.healthy() },
    hostConfig: { keep: { autoStart: true }, lost: { autoStart: false } },
  });

  const first = await waitPhase(ctx, 'keep', 'running', { timeoutMs: 15_000 });
  await ctx.api('POST', '/api/hosts/lost/start');
  const lostFirst = await waitPhase(ctx, 'lost', 'running');

  // 一台主机的远端在 manager 不在场时死掉：重启后应被判 crashed
  ctx.harness.crash('lost');

  await ctx.reboot();

  const keep = await waitPhase(ctx, 'keep', 'running', { timeoutMs: 15_000 });
  assert.equal(keep.web.pid, first.web.pid, '同一远端进程被接管，未重拉');
  assert.equal(keep.tunnel.localPort, first.tunnel.localPort);
  assert.equal(keep.tunnel.connected, true);
  assert.equal((await fetchText(keep.mappedUrl)).status, 200);
  assert.equal(ctx.harness.liveProcesses('keep').length, 1, '远端没有多出第二个实例');

  const lost = await waitPhase(ctx, 'lost', 'crashed', { timeoutMs: 15_000 });
  assert.equal(lost.tunnel, null);
  assert.equal(lost.web.pid, lostFirst.web.pid, 'web 记录留证');
});

/**
 * 回归（issue #96）：主机离开 config.hosts 之后，本机这半边成了没人能碰的孤儿——
 * 隧道 ssh 还活着、本机端口还在转发，而页面上看不见它、stop/reconnect 一律 404。
 *
 * 两条路都走得到：手改 config.json 再 reload；重跑一次 setup（它是整份替换，
 * 上一份有、这一份没有的主机就这么消失）。
 */
test('主机被从 config 删掉：本机隧道要收掉，远端不许自动杀（issue #96）', async (t) => {
  const ctx = await bootServer(t, { hosts: { 'gpu-1': SCENARIOS.healthy(), 'gpu-2': SCENARIOS.healthy() } });
  const sse = await ctx.sse();
  await ctx.api('POST', '/api/hosts/gpu-1/start');
  await ctx.api('POST', '/api/hosts/gpu-2/start');
  const started = await waitPhase(ctx, 'gpu-1', 'running');
  const kept = await waitPhase(ctx, 'gpu-2', 'running');
  const localPort = started.tunnel.localPort;
  const remotePid = started.web.pid;
  assert.equal((await fetchText(`http://127.0.0.1:${localPort}/`)).status, 200, '前提：隧道通着');

  const cfgPath = path.join(ctx.harness.homeDir, 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  delete cfg.hosts['gpu-1'];
  fs.writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`);
  assert.equal((await ctx.api('POST', '/api/reload')).status, 200);

  await waitUntil(() => tunnel.status('gpu-1') === null, '隧道记录被撤掉');
  assert.equal(tunnel.isOpen('gpu-1'), false, '页面上碰不到它了，子进程就必须由 manager 自己收');
  await waitUntil(
    async () => (await fetchText(`http://127.0.0.1:${localPort}/`).then(() => false, () => true)),
    `本机端口 ${localPort} 不再有人监听`,
  );

  // 「不误杀」：删一条配置不等于「把远端那个服务停掉」，没有明确指令就不动远端
  assert.equal(ctx.harness.liveProcesses('gpu-1').length, 1, '远端实例不许被自动杀掉');
  assert.equal(store.getHostState('gpu-1')?.web?.pid, remotePid, 'state 留着，加回来还能接管');

  const said = sse.of('log-line').map((f) => f.data.msg).concat(
    (await ctx.get('/api/hosts')).status === 200 ? [] : [],
  );
  assert.ok(
    said.some((m) => /gpu-1/.test(m) && /远端|还在/.test(m)),
    `要说清远端还在跑，否则用户以为删干净了：${said.join(' | ')}`,
  );

  // 别收过头：还在配置里的那台一根汗毛都不许动
  assert.equal((await ctx.get('/api/hosts')).json.hosts.map((h) => h.name).join(','), 'gpu-2');
  assert.equal(tunnel.isOpen('gpu-2'), true);
  assert.equal((await fetchText(`http://127.0.0.1:${kept.tunnel.localPort}/`)).status, 200);
});
