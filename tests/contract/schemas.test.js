/**
 * 校验器自身的测试（TST-05 验收：故意改一个字段名，对应用例红）。
 * 没有这层，schemas.js 可能悄悄退化成「什么都通过」的橡皮图章。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { validate } from '../../src/lib/validate.js';
import {
  accepted, assertSseStream, errorBody, hostView, managerInfo, operationDone,
} from './schemas.js';

const HOST_VIEW = {
  name: 'gpu-1',
  local: false,
  sshInfo: { hostName: '10.0.0.1', user: 'root', port: 22 },
  orphaned: false,
  config: {
    local: false,
    enabled: true,
    autoStart: false,
    localPort: 17701,
    remoteWebPort: null,
    workdir: '/root/proj',
    inject: { env: { GREETING: 'hi' }, extraArgs: ['--verbose'], patches: ['/tmp/a.yml'] },
  },
  phase: 'running',
  effectiveRemotePort: 8899,
  mappedUrl: 'http://127.0.0.1:17701/',
  probe: {
    dshPath: '/usr/bin/dsh',
    version: '0.1.0',
    dshHome: '/root/.dsh',
    profileWeb: true,
    noDshReason: null,
    at: '2026-08-20T12:00:00.000Z',
    errorSummary: null,
  },
  web: {
    pid: 60768,
    port: 8899,
    startedByUs: true,
    cmdFingerprint: 'dsh web --no-open --host 127.0.0.1 --port 8899',
    log: 'web-8899.log',
    startedAt: '2026-08-20T12:00:00.000Z',
    workdir: '/root/proj',
    cwd: '/root/proj',
  },
  tunnel: { localPort: 17701, connected: true, reconnectAttempt: 0, suspendedReason: null },
  patchSync: {
    files: {
      '/tmp/a.yml': { hash: '3f9c0d12ab34', remoteName: '3f9c0d12ab34-a.yml', syncedAt: '2026-08-20T12:00:00.000Z' },
    },
  },
  manualInstances: [{ pid: 12345, args: 'dsh web --port 9000' }],
};

test('13 §1.3 的样例 HostView 通过校验', () => {
  assert.deepEqual(validate(hostView, HOST_VIEW), { ok: true, errors: [] });
});

test('字段改名即红（契约漂移检测）', () => {
  const drifted = structuredClone(HOST_VIEW);
  drifted.mappedURL = drifted.mappedUrl;
  delete drifted.mappedUrl;
  const { ok, errors } = validate(hostView, drifted);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes('mappedUrl: required')));
  assert.ok(errors.some((e) => e.includes('mappedURL: unknown key')));
});

test('多出一个顶层键即红（防悄悄扩容）', () => {
  const extra = { ...HOST_VIEW, debugInfo: {} };
  assert.equal(validate(hostView, extra).ok, false);
});

test('缺省与 null 语义区分：可为 null 的键仍必须存在', () => {
  const nulled = { ...HOST_VIEW, probe: null, web: null, tunnel: null, sshInfo: null, mappedUrl: null };
  assert.equal(validate(hostView, nulled).ok, true);

  const missing = structuredClone(HOST_VIEW);
  delete missing.web;
  assert.equal(validate(hostView, missing).ok, false);
});

test('HostView 的顶层 local 与 config.local 都是必填身份字段', () => {
  const missingTopLevel = structuredClone(HOST_VIEW);
  delete missingTopLevel.local;
  const topLevelResult = validate(hostView, missingTopLevel);
  assert.equal(topLevelResult.ok, false);
  assert.ok(topLevelResult.errors.some((e) => e.includes('local: required')));

  const missingConfig = structuredClone(HOST_VIEW);
  delete missingConfig.config.local;
  const configResult = validate(hostView, missingConfig);
  assert.equal(configResult.ok, false);
  assert.ok(configResult.errors.some((e) => e.includes('config.local: required')));
});

test('workdir 只收 null、绝对路径与 ~ 形态（补丁 01 §5.1）', () => {
  const withWorkdir = (v) => {
    const c = structuredClone(HOST_VIEW);
    c.config.workdir = v;
    c.web.workdir = v;
    return validate(hostView, c).ok;
  };
  for (const good of [null, '/root/proj', '~', '~/proj', '/a b/c']) {
    assert.equal(withWorkdir(good), true, `应通过：${JSON.stringify(good)}`);
  }
  for (const bad of ['', 'proj', './proj', '~user/proj']) {
    assert.equal(withWorkdir(bad), false, `应拒绝：${JSON.stringify(bad)}`);
  }
});

test('枚举越界即红：phase / noDshReason / suspendedReason / 错误码', () => {
  const badPhase = { ...HOST_VIEW, phase: 'zombie' };
  assert.equal(validate(hostView, badPhase).ok, false);

  const badReason = structuredClone(HOST_VIEW);
  badReason.probe.noDshReason = 'whatever';
  assert.equal(validate(hostView, badReason).ok, false);

  const badSuspend = structuredClone(HOST_VIEW);
  badSuspend.tunnel.suspendedReason = 'paused';
  assert.equal(validate(hostView, badSuspend).ok, false);

  assert.equal(validate(errorBody, { error: 'x', code: 'NOPE' }).ok, false);
  assert.equal(validate(errorBody, { error: 'x', code: 'LAUNCH_FAILED' }).ok, true);
  assert.equal(validate(errorBody, { error: 'x', code: 'LAUNCH_FAILED', detail: 'y' }).ok, true);
});

test('202 受理体：accepted 必须为 true，operationId 必须是 uuid v4 形状', () => {
  assert.equal(validate(accepted, { accepted: true, operationId: crypto.randomUUID(), host: 'gpu-1' }).ok, true);
  assert.equal(validate(accepted, { accepted: true, operationId: crypto.randomUUID(), host: null }).ok, true);
  assert.equal(validate(accepted, { accepted: false, operationId: crypto.randomUUID(), host: null }).ok, false);
  assert.equal(validate(accepted, { accepted: true, operationId: 'not-a-uuid', host: null }).ok, false);
});

test('时间戳必须是 ISO-8601 UTC 毫秒形态', () => {
  const info = {
    version: '0.1.0',
    pid: 1,
    port: 7788,
    mode: 'background',
    startedAt: '2026-08-20 12:00:00',
    uptimeMs: 0,
    setupCompleted: true,
    setupGateActive: false,
    hostCounts: { total: 0, running: 0, degraded: 0, crashed: 0 },
    revision: 0,
  };
  assert.equal(validate(managerInfo, info).ok, false);
  assert.equal(validate(managerInfo, { ...info, startedAt: '2026-08-20T12:00:00.000Z' }).ok, true);
});

test('assertSseStream：未知帧类型与 revision 回退都会失败', () => {
  const ok = [
    { type: 'snapshot', data: { revision: 5, manager: null, defaults: null, hosts: [], logs: [] } },
  ];
  // snapshot 的 manager 是必填对象，这里故意给 null 以确认校验器不放水
  assert.throws(() => assertSseStream(ok), /snapshot/);

  const done = (revision) => ({
    type: 'operation-done',
    data: {
      revision, operationId: 'x', host: null, action: 'probe-all', status: 'ok', error: null, code: null, detail: null,
    },
  });
  assert.equal(validate(operationDone, done(1).data).ok, true);
  assert.throws(() => assertSseStream([done(3), done(2)]), /单调/);
  assert.throws(() => assertSseStream([{ type: 'mystery', data: { revision: 1 } }]), /未定义于契约/);
});
