/**
 * 规模向的集成验收：一台 manager 管很多远端时，「对每台各来一次 ssh」的扇出不许把
 * 共用的跳板机打爆（sshd 出厂 `MaxStartups 10:30:100`）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { bootServer, newHostState, waitPhase } from './helpers.js';

const HOSTS = 24;
/** 跳板机额度：与 sshd 出厂第一档同值，超出即按「认证前掐断」回放。 */
const MAX_STARTUPS = 10;

/** 真机一次 ssh 往返是几百毫秒量级；垫片默认几十毫秒就退，重叠窗口太窄，判据会失真。 */
const RTT_MS = 200;

function manyHosts(n) {
  const hosts = {};
  for (let i = 1; i <= n; i += 1) {
    hosts[`gpu-${String(i).padStart(2, '0')}`] = newHostState({ faults: { slowProbeMs: RTT_MS } });
  }
  return hosts;
}

test(`${HOSTS} 台共用跳板机：首轮探测不许超出 MaxStartups（issue #85）`, async (t) => {
  process.env.DSHC_HARNESS_MAX_STARTUPS = String(MAX_STARTUPS);
  t.after(() => { delete process.env.DSHC_HARNESS_MAX_STARTUPS; });

  const ctx = await bootServer(t, { hosts: manyHosts(HOSTS) });

  // 启动序列自带一轮 probeAll；再显式来一轮，两轮都不许有主机被跳板机掐成 unreachable
  const again = await ctx.api('POST', '/api/hosts/probe');
  assert.equal(again.status, 202);
  for (const name of ctx.hostNames) {
    // eslint-disable-next-line no-await-in-loop -- 逐台等，数量固定
    await waitPhase(ctx, name, 'ready');
  }

  const peak = ctx.harness.state().peakInflight ?? 0;
  assert.ok(peak > 0, '装置没记到并发数，判据失效');
  assert.ok(
    peak <= MAX_STARTUPS,
    `同时在飞 ${peak} 条 ssh，超过跳板机额度 ${MAX_STARTUPS}——真机上这些连接会被随机掐断`,
  );

  const list = await ctx.get('/api/hosts');
  const bad = list.json.hosts.filter((h) => h.phase !== 'ready').map((h) => `${h.name}:${h.phase}`);
  assert.deepEqual(bad, [], '有主机被误判成不可达');
});
