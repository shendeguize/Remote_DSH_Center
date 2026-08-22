/**
 * api.js 的进程内单测：请求体上限、SSE 心跳/补发/主动断开、门禁白名单常量。
 * 起真 HTTP 服务的部分由 tests/integration 覆盖，这里只测不便经网络断言的细节。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

import { MAX_BODY_BYTES, SETUP_ALLOWED, createSseHub, readJsonBody } from '../src/api.js';
import { CONFIG_VERSION, resolvePaths } from '../src/defaults.js';
import { logEvent, _resetForTest } from '../src/lib/bus.js';
import * as store from '../src/store.js';
import { bootServer } from './integration/helpers.js';
import {
  assertRest, hostConfigPutResponse, localHostCreateResponse,
} from './contract/schemas.js';

const bodyOf = (text) => Readable.from([Buffer.from(text)]);

test('readJsonBody：空体 → {}，非法 JSON / 非对象 / 超限 → VALIDATION', async () => {
  assert.deepEqual(await readJsonBody(bodyOf('')), {});
  assert.deepEqual(await readJsonBody(bodyOf('{"a":1}')), { a: 1 });

  await assert.rejects(() => readJsonBody(bodyOf('{oops')), (e) => e.code === 'VALIDATION');
  await assert.rejects(() => readJsonBody(bodyOf('[1,2]')), (e) => e.code === 'VALIDATION');
  await assert.rejects(() => readJsonBody(bodyOf('"str"')), (e) => e.code === 'VALIDATION');

  const huge = Readable.from([Buffer.alloc(MAX_BODY_BYTES + 10, 0x20)]);
  huge.destroy = () => {};
  await assert.rejects(() => readJsonBody(huge), (e) => /上限/.test(e.message));
});

test('setup 门禁白名单＝13 §4 的六项', () => {
  assert.deepEqual([...SETUP_ALLOWED].sort(), [
    'GET /api/config',
    'GET /api/events',
    'GET /api/hosts',
    'GET /api/manager/info',
    'POST /api/hosts/probe',
    'POST /api/setup',
  ]);
});

test('POST /api/hosts/local：缺省名称取 hostname，并以 201 持久化本机身份', async (t) => {
  const ctx = await bootServer(t);
  const res = await ctx.api('POST', '/api/hosts/local', {});

  assertRest(res, { status: 201, schema: localHostCreateResponse, label: 'POST local(default)' });
  assert.equal(res.json.host.name, os.hostname());
  assert.equal(res.json.host.local, true);
  assert.equal(res.json.host.config.local, true);
  assert.equal(res.json.host.config.localPort, null);
  assert.equal(res.json.host.sshInfo, null);

  const config = (await ctx.get('/api/config')).json;
  assert.equal(config.hosts[os.hostname()].local, true);
  assert.equal(config.hosts[os.hostname()].localPort, null);
});

test('POST /api/hosts/local：显式名称成功，第二台本机以 409 拒绝', async (t) => {
  const ctx = await bootServer(t);
  const created = await ctx.api('POST', '/api/hosts/local', { name: 'workstation' });
  assertRest(created, { status: 201, schema: localHostCreateResponse, label: 'POST local(explicit)' });
  assert.equal(created.json.host.name, 'workstation');

  const duplicate = await ctx.api('POST', '/api/hosts/local', { name: 'workstation-2' });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.json.code, 'LOCAL_HOST_EXISTS');
  assert.equal(Object.hasOwn((await ctx.get('/api/config')).json.hosts, 'workstation-2'), false);
});

test('POST /api/hosts/local：与现有主机重名以 409 拒绝', async (t) => {
  const ctx = await bootServer(t);
  const res = await ctx.api('POST', '/api/hosts/local', { name: 'gpu-1' });

  assert.equal(res.status, 409);
  assert.equal(res.json.code, 'LOCAL_NAME_CONFLICT');
  assert.equal(Object.values((await ctx.get('/api/config')).json.hosts).some((host) => host.local), false);
});

test('POST /api/hosts/local：setup gate 下不是白名单动作', async (t) => {
  const ctx = await bootServer(t, { setupCompleted: false });
  const before = fs.readFileSync(path.join(ctx.harness.homeDir, 'config.json'), 'utf8');
  const res = await ctx.api('POST', '/api/hosts/local', { name: 'workstation' });

  assert.equal(res.status, 409);
  assert.equal(res.json.code, 'SETUP_REQUIRED');
  assert.equal(fs.readFileSync(path.join(ctx.harness.homeDir, 'config.json'), 'utf8'), before, '门禁拒绝不得落盘');
});

test('PUT host config：local 身份不可翻转，同值回显不写盘', async (t) => {
  const ctx = await bootServer(t);
  const configFile = path.join(ctx.harness.homeDir, 'config.json');
  const remoteBefore = fs.readFileSync(configFile, 'utf8');

  const remoteFlip = await ctx.api('PUT', '/api/hosts/gpu-1/config', { local: true });
  assert.equal(remoteFlip.status, 409);
  assert.equal(remoteFlip.json.code, 'NOT_ALLOWED');

  const remoteSame = await ctx.api('PUT', '/api/hosts/gpu-1/config', { local: false });
  assertRest(remoteSame, { status: 200, schema: hostConfigPutResponse, label: 'PUT remote local no-op' });
  assert.equal(remoteSame.json.host.local, false);
  assert.equal(fs.readFileSync(configFile, 'utf8'), remoteBefore, '远端身份同值提交不重写配置');

  await ctx.api('POST', '/api/hosts/local', { name: 'workstation' });
  const localBefore = fs.readFileSync(configFile, 'utf8');

  const localFlip = await ctx.api('PUT', '/api/hosts/workstation/config', { local: false });
  assert.equal(localFlip.status, 409);
  assert.equal(localFlip.json.code, 'NOT_ALLOWED');

  const localSame = await ctx.api('PUT', '/api/hosts/workstation/config', { local: true });
  assertRest(localSame, { status: 200, schema: hostConfigPutResponse, label: 'PUT local local no-op' });
  assert.equal(localSame.json.host.local, true);
  assert.equal(fs.readFileSync(configFile, 'utf8'), localBefore, '本机身份同值提交不重写配置');
});

/** 只实现 hub 用到的 ServerResponse/IncomingMessage 面。 */
function fakePair() {
  const writes = [];
  const handlers = {};
  const res = {
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
      return this;
    },
    write(chunk) {
      writes.push(chunk);
      return true;
    },
    end() {
      this.ended = true;
    },
    on() {},
    ended: false,
  };
  const req = { on(event, fn) { handlers[event] = fn; } };
  return {
    req, res, writes, fire: (event) => handlers[event]?.(),
    frames: () => writes.join('').split('\n\n').filter((f) => f.trim() !== ''),
  };
}

async function withStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-api-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    configVersion: CONFIG_VERSION,
    setupCompleted: true,
    manager: { port: 7788 },
    defaults: { remoteWebPort: 8899, localPortRange: [17701, 17799] },
    hosts: { 'gpu-1': { enabled: true, autoStart: false, localPort: null, remoteWebPort: null, inject: { env: {}, extraArgs: [], patches: [] } } },
  }));
  t.mock.method(console, 'log', () => {});
  t.after(() => {
    store._reset();
    _resetForTest();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await store.init({ pathsOverride: resolvePaths({ DSHC_HOME: dir }, os.homedir()) });
}

const MANAGER_CTL = { info: () => ({ pid: 1, port: 7788, mode: 'foreground' }) };

test('新连接：首帧 snapshot 携带主机全量与最近日志', async (t) => {
  await withStore(t);
  logEvent('gpu-1', 'info', '预热一条日志');

  const hub = createSseHub({ managerCtl: MANAGER_CTL, heartbeatMs: 10_000 });
  t.after(() => hub.dispose());

  const c = fakePair();
  hub.attach(c.req, c.res);

  assert.equal(c.res.status, 200);
  assert.match(c.res.headers['content-type'], /text\/event-stream/);
  assert.equal(hub.size, 1);

  const snapshot = c.frames().find((f) => f.startsWith('event: snapshot'));
  const data = JSON.parse(snapshot.split('\ndata: ')[1]);
  assert.equal(data.hosts.length, 1);
  assert.equal(data.logs.at(-1).msg, '预热一条日志');
  assert.equal(typeof data.revision, 'number');
});

test('心跳：每拍写注释行 :hb（EventSource 会忽略）', async (t) => {
  await withStore(t);
  const hub = createSseHub({ managerCtl: MANAGER_CTL, heartbeatMs: 20 });
  t.after(() => hub.dispose());

  const c = fakePair();
  hub.attach(c.req, c.res);
  await new Promise((r) => { setTimeout(r, 70); });

  assert.ok(c.frames().filter((f) => f === ':hb').length >= 2, `心跳帧不足：${c.frames().join('|')}`);
});

test('客户端断开即摘除；closeAll 主动结束全部连接（否则 server.close 挂起）', async (t) => {
  await withStore(t);
  const hub = createSseHub({ managerCtl: MANAGER_CTL, heartbeatMs: 10_000 });
  t.after(() => hub.dispose());

  const a = fakePair();
  const b = fakePair();
  hub.attach(a.req, a.res);
  hub.attach(b.req, b.res);
  assert.equal(hub.size, 2);

  a.fire('close');
  assert.equal(hub.size, 1);

  hub.closeAll();
  assert.equal(hub.size, 0);
  assert.equal(b.res.ended, true);
});

test('host-changed 以发送时刻的视图序列化（合并 debounce 窗口内的连续变化）', async (t) => {
  await withStore(t);
  const hub = createSseHub({ managerCtl: MANAGER_CTL, heartbeatMs: 10_000 });
  t.after(() => hub.dispose());

  const c = fakePair();
  hub.attach(c.req, c.res);

  store.setPhase('gpu-1', 'ready', 'test');
  store.setPhase('gpu-1', 'starting', 'test');
  await new Promise((r) => { queueMicrotask(r); });
  await new Promise((r) => { setTimeout(r, 10); });

  const changes = c.frames().filter((f) => f.startsWith('event: host-changed'));
  assert.equal(changes.length, 1, '同一微任务内同名只发一帧');
  assert.equal(JSON.parse(changes[0].split('\ndata: ')[1]).host.phase, 'starting', '取发送时刻的最新态');
});

test('dispose 后不再收总线事件（防测试间串味与内存泄漏）', async (t) => {
  await withStore(t);
  const hub = createSseHub({ managerCtl: MANAGER_CTL, heartbeatMs: 10_000 });
  const c = fakePair();
  hub.attach(c.req, c.res);
  const before = c.frames().length;

  hub.dispose();
  logEvent(null, 'info', 'dispose 之后');
  await new Promise((r) => { setTimeout(r, 10); });
  assert.equal(c.frames().length, before);
});
