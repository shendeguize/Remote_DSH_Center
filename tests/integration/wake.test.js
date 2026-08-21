/**
 * 规模向（二）：网络整体断了又回来的那一瞬（合盖睡醒、Wi-Fi 切换、跳板机抖一下）。
 * 一起断的隧道会一起进重连环——瞬时并发不许把共用跳板机打爆，且**每一台**都要自愈
 * （issue #100）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  bootServer, newHostState, tunnel, waitPhase,
} from './helpers.js';

const HOSTS = 16;
/** 真机一次 ssh 往返是几百毫秒量级；垫片默认几十毫秒就退，重叠窗口太窄，判据会失真。 */
const RTT_MS = 200;
/** 跳板机额度：与 sshd 出厂第一档同值，超出即按「认证前掐断」回放。 */
const MAX_STARTUPS = 10;

function manyHosts(n) {
  const hosts = {};
  for (let i = 1; i <= n; i += 1) {
    hosts[`gpu-${String(i).padStart(2, '0')}`] = newHostState({ faults: { slowProbeMs: RTT_MS } });
  }
  return hosts;
}

test(`${HOSTS} 条隧道同时断：并发有界且全部自愈（issue #100）`, async (t) => {
  const ctx = await bootServer(t, { hosts: manyHosts(HOSTS) });
  const sse = await ctx.sse();
  for (const name of ctx.hostNames) {
    // 一台一台起：这一轮问的是「醒来那一瞬」，别让启动阶段的扇出搅浑判读
    // eslint-disable-next-line no-await-in-loop -- 同上
    await ctx.api('POST', `/api/hosts/${name}/start`);
    // eslint-disable-next-line no-await-in-loop -- 同上
    await waitPhase(ctx, name, 'running', { timeoutMs: 60_000 });
  }

  // 从这一刻起才挂跳板机额度
  process.env.DSHC_HARNESS_MAX_STARTUPS = String(MAX_STARTUPS);
  t.after(() => { delete process.env.DSHC_HARNESS_MAX_STARTUPS; });

  const pids = ctx.hostNames.map((n) => tunnel._childPid(n)).filter(Boolean);
  assert.equal(pids.length, HOSTS, '前提：每台都有一条活着的隧道子进程');
  for (const pid of pids) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* 已退 */ }
  }

  // 预算：退避上界 30s，带抖动后最坏两三拍，给足余量
  for (const name of ctx.hostNames) {
    // eslint-disable-next-line no-await-in-loop -- 逐台等
    await waitPhase(ctx, name, 'running', { timeoutMs: 120_000 });
  }

  const peak = ctx.harness.state().peakInflight ?? 0;
  assert.ok(peak > 0, '装置没记到并发数，判据失效');
  assert.ok(
    peak <= MAX_STARTUPS,
    `同时在飞 ${peak} 条 ssh，超过跳板机额度 ${MAX_STARTUPS}——真机上这些连接会被随机掐断`,
  );

  // 散开的直接证据：重连不是挤在同一毫秒发生的
  const tries = sse.of('log-line')
    .filter((f) => /隧道重连尝试/.test(f.data.msg ?? ''))
    .map((f) => Date.parse(f.data.ts));
  assert.ok(tries.length >= HOSTS / 2, `前提：多数主机确实进过重连环，实得 ${tries.length} 条`);
  assert.ok(
    Math.max(...tries) - Math.min(...tries) > 200,
    '所有重连挤在 200ms 内发生，等于没散开——下一轮还会一起撞在同一堵墙上',
  );
});
