/**
 * TST-04/05：SSE 帧序列、revision 语义、新连接补发、operation-done 一对一。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import net from 'node:net';

import { logEvent } from '../../src/lib/bus.js';
import { bootServer, server, waitPhase } from './helpers.js';
import { assertShape, hostChanged, snapshot as snapshotSchema } from '../contract/schemas.js';

test('首帧 snapshot：manager + defaults + 全量主机 + 最近日志', async (t) => {
  const ctx = await bootServer(t);
  const events = await ctx.sse();

  const first = events.frames[0] ?? await events.wait(() => true);
  assert.equal(first.type, 'snapshot', 'snapshot 必须是首帧');
  assertShape(snapshotSchema, first.data, 'snapshot');
  assert.equal(first.data.hosts.length, 1);
  assert.ok(first.data.logs.length > 0, '补发最近日志（启动序列已产生若干条）');
  assert.equal(first.data.defaults.remoteWebPort, 8899);
});

test('revision：host-changed 递增；新连接的 snapshot 携带当时 revision', async (t) => {
  const ctx = await bootServer(t);
  const a = await ctx.sse();
  await a.wait((f) => f.type === 'snapshot');

  const started = await ctx.api('POST', '/api/hosts/gpu-1/start');
  await a.wait((f) => f.type === 'operation-done' && f.data.operationId === started.json.operationId);
  await waitPhase(ctx, 'gpu-1', 'running');

  const changes = a.of('host-changed');
  assert.ok(changes.length >= 2, `拉起过程应有多次 host-changed，实际 ${changes.length}`);
  for (const f of changes) assertShape(hostChanged, f.data, 'host-changed');
  const revs = a.frames.filter((f) => f.type !== 'snapshot').map((f) => f.data.revision);
  assert.deepEqual(revs, [...revs].sort((x, y) => x - y), 'revision 单调递增');

  const b = await ctx.sse();
  const late = await b.wait((f) => f.type === 'snapshot');
  assert.equal(late.data.hosts[0].phase, 'running', '晚到的客户端一帧即同步到最新态');
  assert.ok(late.data.revision >= revs.at(-1), '补发的 revision 不小于既有帧');

  // 同一条 REST 动作只结算一次
  const dones = a.of('operation-done').filter((f) => f.data.operationId === started.json.operationId);
  assert.equal(dones.length, 1, '每个 202 有且仅有一条 operation-done');
});

test('config-changed：PUT defaults 触发全局帧，PUT 主机配置只触发 host-changed', async (t) => {
  const ctx = await bootServer(t);
  const events = await ctx.sse();
  await events.wait((f) => f.type === 'snapshot');

  await ctx.api('PUT', '/api/config/defaults', { remoteWebPort: 9101 });
  const cfgFrame = await events.wait((f) => f.type === 'config-changed');
  assert.equal(cfgFrame.data.defaults.remoteWebPort, 9101);
  assert.ok(cfgFrame.data.changed.includes('defaults.remoteWebPort'));

  const before = events.of('config-changed').length;
  await ctx.api('PUT', '/api/hosts/gpu-1/config', { autoStart: true });
  const hostFrame = await events.wait((f) => f.type === 'host-changed' && f.data.host.config.autoStart === true);
  assert.equal(hostFrame.data.host.name, 'gpu-1');
  assert.equal(events.of('config-changed').length, before, '主机面改动不发全局帧');
});

test('log-line：msg 单行摘要、长文本只在 detail', async (t) => {
  const ctx = await bootServer(t, { hosts: { 'gpu-1': undefined } });
  const events = await ctx.sse();
  await events.wait((f) => f.type === 'snapshot');

  ctx.harness.faults('gpu-1', { hostkeyFail: true });
  const probe = await ctx.api('POST', '/api/hosts/gpu-1/probe');
  await events.wait((f) => f.type === 'operation-done' && f.data.operationId === probe.json.operationId);
  await waitPhase(ctx, 'gpu-1', 'unreachable');

  for (const f of events.of('log-line')) {
    assert.ok(!f.data.msg.includes('\n'), `msg 必须单行：${JSON.stringify(f.data.msg)}`);
  }
});

/** 裸连一条 SSE：拿到 req/res 好在用例里粗暴掐断。 */
function openRawSse(base) {
  const url = new URL('/api/events', base);
  return new Promise((resolve) => {
    const req = http.request({
      host: url.hostname, port: url.port, path: url.pathname, method: 'GET',
    }, (res) => {
      res.on('data', () => {});
      resolve({ req, res });
    });
    req.end();
  });
}

async function waitUntil(pred, why, { timeoutMs = 5_000 } = {}) {
  const end = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > end) throw new Error(why);
    // eslint-disable-next-line no-await-in-loop -- 轮询
    await new Promise((r) => { setTimeout(r, 50); });
  }
}

test('客户端硬断（进程被杀 / 网线被拔）也从广播名单里除名', async (t) => {
  const ctx = await bootServer(t);
  const hub = () => server.runtime.handler.sseHub;
  assert.equal(hub().size, 0, '前提：开工前没人在线');

  // req.destroy 与 res.destroy 分别对应「客户端进程消失」与「连接被中途掐断」，
  // 两条都要能除名：漏一条就是每次浏览器崩溃都往名单里留一具尸体，
  // 之后每条日志都要往死连接上写。
  const conns = [];
  for (let i = 0; i < 8; i += 1) {
    // eslint-disable-next-line no-await-in-loop -- 逐条建连
    conns.push(await openRawSse(ctx.base));
  }
  assert.equal(hub().size, 8, `8 条都该在线，实得 ${hub().size}`);

  for (const [i, c] of conns.entries()) {
    if (i % 2 === 0) c.req.destroy();
    else c.res.destroy();
  }
  await waitUntil(() => hub().size === 0, `名单没清空（还剩 ${hub().size}）`);
});

test('客户端不读就把它踢掉：写队列不许无上限地涨', async (t) => {
  const ctx = await bootServer(t);
  const hub = () => server.runtime.handler.sseHub;
  const port = Number(new URL(ctx.base).port);

  // 僵死客户端：发完请求就 pause()。接收窗口填满后，服务端每帧只能往内存里排队——
  // 这正是「标签被系统冻结 / 笔记本合盖 / 网络黑洞」在服务端看到的样子。
  const sock = await new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1', () => {
      s.write('GET /api/events HTTP/1.1\r\nHost: 127.0.0.1\r\nAccept: text/event-stream\r\n\r\n');
      s.pause();
      resolve(s);
    });
  });
  t.after(() => sock.destroy());
  await waitUntil(() => hub().size === 1, '前提：僵死客户端没连上');

  // 每条 1KB × 4000 条 ≈ 4MB，稳稳越过上限
  const fat = 'x'.repeat(1024);
  for (let i = 0; i < 4000; i += 1) logEvent('gpu-1', 'info', `洪峰 ${i}`, fat);

  await waitUntil(() => hub().size === 0, '不读的客户端始终没被踢掉——写队列会一直涨到 OOM');
});

test('读得动的客户端不许被误踢', async (t) => {
  const ctx = await bootServer(t);
  const hub = () => server.runtime.handler.sseHub;
  let bytes = 0;
  const req = http.request({
    host: '127.0.0.1', port: Number(new URL(ctx.base).port), path: '/api/events', method: 'GET',
  }, (res) => {
    res.on('data', (c) => { bytes += c.length; });
  });
  req.end();
  t.after(() => req.destroy());
  await waitUntil(() => hub().size === 1, '前提：客户端没连上');

  const fat = 'x'.repeat(1024);
  for (let i = 0; i < 4000; i += 1) logEvent('gpu-1', 'info', `洪峰 ${i}`, fat);
  await waitUntil(() => bytes > 2_000_000, `收得太少（${bytes}B）`, { timeoutMs: 10_000 });
  assert.equal(hub().size, 1, '一直在读的客户端被踢了');
});
