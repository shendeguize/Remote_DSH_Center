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
import { newHostState } from './harness/index.js';
import {
  assertRest, hostConfigPutResponse, localHostCreateResponse, syncConfigResponse,
} from './contract/schemas.js';

const bodyOf = (text) => Readable.from([Buffer.from(text)]);

function syncServerOptions({ setupCompleted = true } = {}) {
  return {
    setupCompleted,
    hosts: {
      source: newHostState(),
      'target-a': newHostState(),
      'target-b': newHostState(),
    },
    hostConfig: {
      source: {
        remoteWebPort: null,
        workdir: null,
        inject: { env: { SYNCED: 'yes' }, extraArgs: ['--source'], patches: ['source.patch'] },
      },
      'target-a': {
        enabled: false,
        autoStart: true,
        localPort: 17777,
        remoteWebPort: 9001,
        workdir: '/old/workdir',
        inject: { env: { OLD: 'yes' }, extraArgs: ['--old'], patches: ['old.patch'] },
      },
      'target-b': {
        remoteWebPort: null,
        workdir: null,
        inject: { env: { SYNCED: 'yes' }, extraArgs: ['--source'], patches: ['source.patch'] },
      },
    },
  };
}

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

test('POST sync-config：非法 schema 请求统一拒绝且不落盘', async (t) => {
  const ctx = await bootServer(t, syncServerOptions());
  const configFile = path.join(ctx.harness.homeDir, 'config.json');
  const before = fs.readFileSync(configFile, 'utf8');
  const invalidBodies = [
    { source: '-source', targets: ['target-a'], dryRun: true },
    { source: 'source', targets: ['bad target'], dryRun: true },
    { source: 'source', targets: [], dryRun: true },
    { source: 'source', targets: ['target-a'], dryRun: 'true' },
    { source: 'source', targets: ['target-a'], dryRun: true, extra: true },
  ];

  for (const body of invalidBodies) {
    // eslint-disable-next-line no-await-in-loop -- 每个非法请求都要独立验证拒绝后文件未变
    const res = await ctx.api('POST', '/api/hosts/sync-config', body);
    assert.equal(res.status, 400, res.text);
    assert.equal(res.json.code, 'VALIDATION');
    assert.equal(fs.readFileSync(configFile, 'utf8'), before);
  }
});

test('POST sync-config preview：只返回计划，不写盘、不升 revision、不发 SSE', async (t) => {
  const ctx = await bootServer(t, syncServerOptions());
  const configFile = path.join(ctx.harness.homeDir, 'config.json');
  const before = fs.readFileSync(configFile, 'utf8');
  const statBefore = fs.statSync(configFile, { bigint: true });
  const sse = await ctx.sse();
  await sse.wait((frame) => frame.type === 'snapshot');
  const revisionBefore = store.currentRevision();
  const frameCountBefore = sse.frames.length;

  const res = await ctx.api('POST', '/api/hosts/sync-config', {
    source: 'source',
    targets: ['target-b', 'target-a'],
    dryRun: true,
  });

  assertRest(res, { status: 200, schema: syncConfigResponse, label: 'POST sync-config preview' });
  assert.deepEqual(res.json.targets, [
    { name: 'target-b', changed: false, changedFields: [] },
    {
      name: 'target-a',
      changed: true,
      changedFields: ['remoteWebPort', 'workdir', 'inject.env', 'inject.extraArgs', 'inject.patches'],
    },
  ]);
  assert.deepEqual(res.json.applied, []);
  assert.deepEqual(res.json.hosts, []);

  await new Promise((resolve) => { setTimeout(resolve, 20); });
  const statAfter = fs.statSync(configFile, { bigint: true });
  assert.equal(fs.readFileSync(configFile, 'utf8'), before);
  assert.equal(statAfter.ino, statBefore.ino, 'preview 不得原子替换 config 文件');
  assert.equal(statAfter.mtimeNs, statBefore.mtimeNs, 'preview 不得触碰 config mtime');
  assert.equal(store.currentRevision(), revisionBefore);
  assert.equal(sse.frames.length, frameCountBefore);
});

test('POST sync-config apply：一次原子落盘并只复制 profile', async (t) => {
  const ctx = await bootServer(t, syncServerOptions());
  const configFile = path.join(ctx.harness.homeDir, 'config.json');
  const originalRenameSync = fs.renameSync.bind(fs);
  let configRenames = 0;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === configFile) configRenames += 1;
    return originalRenameSync(from, to);
  });
  const sse = await ctx.sse();
  await sse.wait((frame) => frame.type === 'snapshot');

  const res = await ctx.api('POST', '/api/hosts/sync-config', {
    source: 'source',
    targets: ['target-b', 'target-a'],
    dryRun: false,
  });
  await sse.wait((frame) => frame.type === 'host-changed' && frame.data.host.name === 'target-a');

  assertRest(res, { status: 200, schema: syncConfigResponse, label: 'POST sync-config apply' });
  assert.deepEqual(res.json.applied, ['target-a']);
  assert.deepEqual(res.json.hosts.map((host) => host.name), ['target-b', 'target-a']);
  assert.equal(configRenames, 1, '所有目标必须收敛到一次 updateConfig 原子落盘');
  assert.equal(sse.of('operation-done').length, 0, '配置同步不是 stop/restart/probe 长动作');

  const onDisk = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  assert.equal(onDisk.hosts['target-a'].remoteWebPort, null, '源为 null 时清除端口 override');
  assert.equal(onDisk.hosts['target-a'].workdir, null, '源为 null 时清除 workdir override');
  assert.deepEqual(onDisk.hosts['target-a'].inject, onDisk.hosts.source.inject);
  assert.equal(onDisk.hosts['target-a'].enabled, false);
  assert.equal(onDisk.hosts['target-a'].autoStart, true);
  assert.equal(onDisk.hosts['target-a'].localPort, 17777);
  assert.equal(onDisk.hosts['target-a'].local, false);
  assert.equal(res.json.hosts[1].config.remoteWebPort, null);
  assert.equal(res.json.hosts[1].config.workdir, null);
});

test('POST sync-config apply：全相同时不重写文件', async (t) => {
  const ctx = await bootServer(t, syncServerOptions());
  const configFile = path.join(ctx.harness.homeDir, 'config.json');
  const before = fs.readFileSync(configFile, 'utf8');
  const statBefore = fs.statSync(configFile, { bigint: true });
  const originalRenameSync = fs.renameSync.bind(fs);
  let configRenames = 0;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === configFile) configRenames += 1;
    return originalRenameSync(from, to);
  });

  const res = await ctx.api('POST', '/api/hosts/sync-config', {
    source: 'source',
    targets: ['target-b'],
    dryRun: false,
  });

  assertRest(res, { status: 200, schema: syncConfigResponse, label: 'POST sync-config no-op' });
  assert.deepEqual(res.json.targets, [{ name: 'target-b', changed: false, changedFields: [] }]);
  assert.deepEqual(res.json.applied, []);
  assert.deepEqual(res.json.hosts.map((host) => host.name), ['target-b']);
  const statAfter = fs.statSync(configFile, { bigint: true });
  assert.equal(configRenames, 0);
  assert.equal(fs.readFileSync(configFile, 'utf8'), before);
  assert.equal(statAfter.ino, statBefore.ino);
  assert.equal(statAfter.mtimeNs, statBefore.mtimeNs);
});

test('POST sync-config：missing/重复/source target 整单失败且文件逐字不变', async (t) => {
  const ctx = await bootServer(t, syncServerOptions());
  const configFile = path.join(ctx.harness.homeDir, 'config.json');
  const before = fs.readFileSync(configFile, 'utf8');
  const cases = [
    [{ source: 'missing', targets: ['target-a'], dryRun: false }, 404, 'NOT_FOUND'],
    [{ source: 'source', targets: ['target-a', 'missing'], dryRun: false }, 404, 'NOT_FOUND'],
    [{ source: 'source', targets: ['target-a', 'target-a'], dryRun: false }, 400, 'VALIDATION'],
    [{ source: 'source', targets: ['target-a', 'source'], dryRun: false }, 400, 'VALIDATION'],
  ];

  for (const [body, status, code] of cases) {
    // eslint-disable-next-line no-await-in-loop -- 每类整单失败都要在同一原始文件上验证
    const res = await ctx.api('POST', '/api/hosts/sync-config', body);
    assert.equal(res.status, status, res.text);
    assert.equal(res.json.code, code);
    assert.equal(fs.readFileSync(configFile, 'utf8'), before);
  }
});

test('POST sync-config：继承保留名在 dryRun/apply 都返回 404 且不改文件或全局对象', async (t) => {
  const reservedNames = ['toString', 'constructor', '__proto__'];
  const inheritedValues = new Map(reservedNames.map((name) => [name, {}[name]]));
  const inheritedBefore = new Map([...inheritedValues].map(
    ([name, value]) => [name, Object.getOwnPropertyDescriptors(value)],
  ));
  t.after(() => {
    for (const [name, value] of inheritedValues) {
      const descriptors = inheritedBefore.get(name);
      for (const key of Reflect.ownKeys(value)) {
        if (!Object.hasOwn(descriptors, key)) delete value[key];
      }
      Object.defineProperties(value, descriptors);
    }
  });

  const ctx = await bootServer(t, syncServerOptions());
  const configFile = path.join(ctx.harness.homeDir, 'config.json');
  const before = fs.readFileSync(configFile, 'utf8');

  for (const dryRun of [true, false]) {
    for (const name of reservedNames) {
      for (const body of [
        { source: name, targets: ['target-a'], dryRun },
        { source: 'source', targets: ['target-a', name], dryRun },
      ]) {
        // eslint-disable-next-line no-await-in-loop -- 每个恶意名称和模式都要独立验证拒绝后的磁盘与全局状态
        const res = await ctx.api('POST', '/api/hosts/sync-config', body);
        assert.equal(res.status, 404, `${JSON.stringify(body)}: ${res.text}`);
        assert.equal(res.json.code, 'NOT_FOUND');
        assert.equal(fs.readFileSync(configFile, 'utf8'), before);
        for (const [inheritedName, value] of inheritedValues) {
          assert.deepEqual(
            Object.getOwnPropertyDescriptors(value),
            inheritedBefore.get(inheritedName),
            `${inheritedName} 对应的全局对象不得被修改`,
          );
        }
      }
    }
  }
});

test('POST sync-config：setup gate 默认拒绝', async (t) => {
  const ctx = await bootServer(t, syncServerOptions({ setupCompleted: false }));
  const configFile = path.join(ctx.harness.homeDir, 'config.json');
  const before = fs.readFileSync(configFile, 'utf8');
  const res = await ctx.api('POST', '/api/hosts/sync-config', {
    source: 'source',
    targets: ['target-a'],
    dryRun: true,
  });

  assert.equal(res.status, 409);
  assert.equal(res.json.code, 'SETUP_REQUIRED');
  assert.equal(fs.readFileSync(configFile, 'utf8'), before);
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

test('新连接：首帧 snapshot 携带运行态、配置目标端口、主机全量与最近日志', async (t) => {
  await withStore(t);
  logEvent('gpu-1', 'info', '预热一条日志');

  const hub = createSseHub({
    managerCtl: { info: () => ({ pid: 1, port: 7799, mode: 'foreground' }) },
    heartbeatMs: 10_000,
  });
  t.after(() => hub.dispose());

  const c = fakePair();
  hub.attach(c.req, c.res);

  assert.equal(c.res.status, 200);
  assert.match(c.res.headers['content-type'], /text\/event-stream/);
  assert.equal(hub.size, 1);

  const snapshot = c.frames().find((f) => f.startsWith('event: snapshot'));
  const data = JSON.parse(snapshot.split('\ndata: ')[1]);
  assert.equal(data.manager.port, 7799, 'manager 运行态仍报告实际监听端口');
  assert.equal(data.configuredPort, 7788, '配置目标端口必须来自唯一 config store');
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
