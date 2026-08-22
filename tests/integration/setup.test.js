/**
 * TST-04 主干流程（三）：setup 门禁与 POST /api/setup 提交（13 §4、02 §3.0）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { canonicalSetupLocalName } from '../../src/store.js';
import { bootServer, waitPhase } from './helpers.js';
import { SCENARIOS } from '../harness/scenarios.js';
import {
  accepted, assertRest, configBody, hostsList, managerInfo, setupResponse,
} from '../contract/schemas.js';

/** 向导第 4 步产物：整份 config。 */
function setupBody(ctx, {
  port,
  autoStart = [],
  candidates = ctx.hostNames.map((name) => ({ name, local: false })),
} = {}) {
  return {
    setupCompleted: false, // 后端强制置 true，请求体给什么都忽略
    manager: { port },
    defaults: { remoteWebPort: 8899, localPortRange: [24_101, 24_140] },
    hosts: Object.fromEntries(candidates.map((candidate) => {
      const { name, local = false } = typeof candidate === 'string' ? { name: candidate } : candidate;
      return [name, {
        local,
        enabled: true,
        autoStart: autoStart.includes(name),
        localPort: null,
        remoteWebPort: local ? null : ctx.remotePortOf(name),
        inject: { env: {}, extraArgs: [], patches: [] },
      }];
    })),
  };
}

test('未初始化：白名单可用、其余 409 SETUP_REQUIRED', async (t) => {
  const ctx = await bootServer(t, { setupCompleted: false });
  assert.equal(ctx.setupGate, true);

  const info = await ctx.get('/api/manager/info');
  assertRest(info, { status: 200, schema: managerInfo, label: 'GET info' });
  assert.equal(info.json.setupCompleted, false);
  assert.equal(info.json.setupGateActive, true);

  // 白名单：主机清单（ssh config + 一台只驻内存的本机候选）、只读 config、全量探测、SSE
  const hosts = await ctx.get('/api/hosts');
  assertRest(hosts, { status: 200, schema: hostsList, label: 'GET /api/hosts' });
  assert.deepEqual(hosts.json.hosts.filter((h) => !h.local).map((h) => h.name), ['gpu-1']);
  const localCandidates = hosts.json.hosts.filter((h) => h.local);
  assert.equal(localCandidates.length, 1, 'SSH 主机之外必须恰有一台本机候选');
  assert.equal(localCandidates[0].config.local, true);
  assert.equal(localCandidates[0].config.localPort, null);
  assert.equal(localCandidates[0].sshInfo, null);

  const config = await ctx.get('/api/config');
  assertRest(config, { status: 200, schema: configBody, label: 'GET /api/config' });
  assert.equal(Object.hasOwn(config.json.hosts, localCandidates[0].name), false, '候选不进入持久配置');
  const disk = JSON.parse(fs.readFileSync(path.join(ctx.harness.homeDir, 'config.json'), 'utf8'));
  assert.equal(Object.hasOwn(disk.hosts, localCandidates[0].name), false, '候选不落盘');

  const events = await ctx.sse();
  await events.wait((f) => f.type === 'snapshot');

  const probeAll = await ctx.api('POST', '/api/hosts/probe');
  assertRest(probeAll, { status: 202, schema: accepted, label: 'POST probe-all' });
  await events.wait((f) => f.type === 'operation-done' && f.data.operationId === probeAll.json.operationId);
  assert.equal((await waitPhase(ctx, 'gpu-1', 'ready')).phase, 'ready', '向导第 3 步据此显示可勾选');

  // 门禁外的一切
  for (const [method, path] of [
    ['POST', '/api/hosts/gpu-1/start'],
    ['POST', '/api/hosts/gpu-1/probe'],
    ['PUT', '/api/hosts/gpu-1/config'],
    ['PUT', '/api/config/defaults'],
    ['POST', '/api/reload'],
    ['GET', '/api/hosts/gpu-1/log'],
  ]) {
    const res = await ctx.api(method, path, method === 'PUT' ? {} : undefined);
    assert.equal(res.status, 409, `${method} ${path} 应被门禁拦截`);
    assert.equal(res.json.code, 'SETUP_REQUIRED');
  }
});

test('提交 setup：端口未变 → 撤门禁并热切换，autoStart 生效', async (t) => {
  const ctx = await bootServer(t, { setupCompleted: false, hosts: { 'gpu-1': SCENARIOS.healthy() } });
  const candidates = (await ctx.get('/api/hosts')).json.hosts
    .map((host) => ({ name: host.name, local: host.local }));
  const localName = candidates.find((candidate) => candidate.local).name;

  const bad = await ctx.api('POST', '/api/setup', { manager: { port: 70_000 } });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.code, 'VALIDATION');
  assert.match(bad.json.detail, /manager\.port/);

  const res = await ctx.api('POST', '/api/setup', setupBody(ctx, {
    port: ctx.port,
    autoStart: ['gpu-1'],
    candidates,
  }));
  assertRest(res, { status: 200, schema: setupResponse, label: 'POST /api/setup' });
  assert.deepEqual(
    { ok: res.json.ok, portChanged: res.json.portChanged, restartRequired: res.json.restartRequired },
    { ok: true, portChanged: false, restartRequired: false },
  );

  const info = await ctx.get('/api/manager/info');
  assert.equal(info.json.setupCompleted, true);
  assert.equal(info.json.setupGateActive, false, '门禁已撤');

  const saved = await ctx.get('/api/config');
  assert.equal(saved.json.setupCompleted, true, '后端强制置 true');
  assert.equal(saved.json.defaults.localPortRange[0], 24_101);
  assert.equal(saved.json.hosts[localName].local, true, '提交后本机候选转为持久主机');
  assert.equal(saved.json.hosts[localName].localPort, null, '本机直连不分配映射端口');

  // 撤门禁后其余端点恢复；autoStart 勾选的主机被补跑拉起
  const running = await waitPhase(ctx, 'gpu-1', 'running', { timeoutMs: 20_000 });
  assert.equal(running.tunnel.connected, true);
  assert.ok(running.tunnel.localPort >= 24_101 && running.tunnel.localPort <= 24_140);
});

test('提交 setup：拒绝把 SSH 主机伪装成本机', async (t) => {
  const ctx = await bootServer(t, { setupCompleted: false });
  const before = fs.readFileSync(path.join(ctx.harness.homeDir, 'config.json'), 'utf8');

  const res = await ctx.api('POST', '/api/setup', setupBody(ctx, {
    port: ctx.port,
    candidates: [{ name: 'gpu-1', local: true }],
  }));

  assert.equal(res.status, 409);
  assert.equal(res.json.code, 'NOT_ALLOWED');
  assert.match(res.json.error, /SSH 主机.*本机/);
  assert.equal(fs.readFileSync(path.join(ctx.harness.homeDir, 'config.json'), 'utf8'), before, '拒绝后不得落盘');
  assert.equal((await ctx.get('/api/manager/info')).json.setupGateActive, true, '拒绝后门禁保持');
});

test('已完成配置重跑 setup：保留本机身份成功，翻成远端则拒绝', async (t) => {
  const ctx = await bootServer(t, { setupCompleted: false });
  const candidates = (await ctx.get('/api/hosts')).json.hosts
    .map((host) => ({ name: host.name, local: host.local }));
  const localName = candidates.find((candidate) => candidate.local).name;

  const first = await ctx.api('POST', '/api/setup', setupBody(ctx, { port: ctx.port, candidates }));
  assertRest(first, { status: 200, schema: setupResponse, label: '首次 POST /api/setup' });

  const saved = (await ctx.get('/api/config')).json;
  const rerun = await ctx.api('POST', '/api/setup', saved);
  assertRest(rerun, { status: 200, schema: setupResponse, label: '重跑 POST /api/setup' });
  assert.equal((await ctx.get('/api/config')).json.hosts[localName].local, true);

  const flipped = structuredClone(saved);
  flipped.hosts[localName].local = false;
  flipped.hosts[localName].remoteWebPort = 8899;
  const rejected = await ctx.api('POST', '/api/setup', flipped);
  assert.equal(rejected.status, 409);
  assert.equal(rejected.json.code, 'NOT_ALLOWED');
  assert.match(rejected.json.error, /本机主机.*SSH 主机/);
  assert.equal((await ctx.get('/api/config')).json.hosts[localName].local, true, '拒绝后必须保留既有本机身份');
});

test('已初始化 manager 的 force-init 仅接受 canonical 本机名，并以单次 setup 原子替换', async (t) => {
  const ctx = await bootServer(t);
  const configFile = path.join(ctx.harness.homeDir, 'config.json');
  const beforeText = fs.readFileSync(configFile, 'utf8');
  const current = (await ctx.get('/api/config')).json;
  assert.equal(Object.values(current.hosts).some((host) => host.local === true), false);
  assert.equal(
    (await ctx.get('/api/hosts')).json.hosts.some((host) => host.local === true),
    false,
    '普通 GET 不应暴露仅供 setup 校验的候选',
  );

  const localName = canonicalSetupLocalName(os.hostname(), {
    hosts: current.hosts,
    sshNames: ctx.hostNames,
  });
  const selfChosen = setupBody(ctx, {
    port: ctx.port,
    candidates: [
      { name: 'gpu-1', local: false },
      { name: 'client-picked-local', local: true },
    ],
  });
  const rejected = await ctx.api('POST', '/api/setup', selfChosen);
  assert.equal(rejected.status, 409);
  assert.equal(rejected.json.code, 'NOT_ALLOWED');
  assert.equal(fs.readFileSync(configFile, 'utf8'), beforeText, 'setup 失败不得污染原配置');
  assert.deepEqual((await ctx.get('/api/config')).json, current, '失败后内存配置也必须保持原值');

  const config = setupBody(ctx, {
    port: ctx.port,
    candidates: [
      { name: 'gpu-1', local: false },
      { name: localName, local: true },
    ],
  });
  const submitted = await ctx.api('POST', '/api/setup', config);
  assertRest(submitted, { status: 200, schema: setupResponse, label: 'force-init POST /api/setup' });
  const saved = (await ctx.get('/api/config')).json;
  assert.equal(saved.hosts[localName].local, true);
  assert.equal(saved.hosts[localName].localPort, null);
  assert.equal(Object.values(saved.hosts).filter((host) => host.local === true).length, 1);
});

test('提交 setup：端口改动 + 前台模式 → restartRequired，配置已落盘', async (t) => {
  const ctx = await bootServer(t, { setupCompleted: false });

  const res = await ctx.api('POST', '/api/setup', setupBody(ctx, { port: 7999 }));
  assertRest(res, { status: 200, schema: setupResponse, label: 'POST /api/setup' });
  assert.equal(res.json.port, 7999);
  assert.equal(res.json.portChanged, true);
  assert.equal(res.json.restartRequired, true, '前台模式不自我重启（02 §9.4）');
  assert.equal(res.json.restarting, false);

  assert.equal((await ctx.get('/api/config')).json.manager.port, 7999);

  // 重启后按新配置起来（这里用同一 DSHC_HOME 重跑启动序列）
  await ctx.reboot();
  const info = await ctx.get('/api/manager/info');
  assert.equal(info.json.setupGateActive, false);
  assert.equal((await ctx.get('/api/hosts')).json.hosts[0].phase, 'ready');
});
