/**
 * TST-04/05：SSE 帧序列、revision 语义、新连接补发、operation-done 一对一。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { bootServer, waitPhase } from './helpers.js';
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
