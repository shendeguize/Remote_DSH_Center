/**
 * api.js 的进程内单测：请求体上限、SSE 心跳/补发/主动断开、门禁白名单常量。
 * 起真 HTTP 服务的部分由 tests/integration 覆盖，这里只测不便经网络断言的细节。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

import {
  DSH_WORKSPACE_MAX_BODY_BYTES,
  MAX_BODY_BYTES,
  SETTINGS_MAX_BODY_BYTES,
  SETUP_ALLOWED,
  createSseHub,
  readJsonBody,
} from '../src/api.js';
import { CONFIG_VERSION, resolvePaths } from '../src/defaults.js';
import { logEvent, _resetForTest } from '../src/lib/bus.js';
import {
  dshSettingsPutSchema,
  dshWorkspaceCreateSchema,
  validate,
} from '../src/lib/validate.js';
import { posixCksum, SETTINGS_MAX_BYTES } from '../src/settings-file.js';
import * as store from '../src/store.js';
import { bootServer } from './integration/helpers.js';
import { newHostState } from './harness/index.js';
import {
  assertRest,
  assertShape,
  hostConfigPutResponse,
  localHostCreateResponse,
  settingsReadResponse,
  settingsWriteResponse,
  syncConfigResponse,
} from './contract/schemas.js';

const bodyOf = (text) => Readable.from([Buffer.from(text)]);

function rawRequest(base, method, route, payload) {
  const url = new URL(route, base);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch { /* 测试失败时保留原文供断言 */ }
        resolve({ status: res.statusCode, text, json });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

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

async function previewSync(ctx, targets = ['target-b', 'target-a']) {
  const res = await ctx.api('POST', '/api/hosts/sync-config', {
    source: 'source',
    targets,
    dryRun: true,
  });
  assert.equal(res.status, 200, res.text);
  assert.match(res.json.previewToken, /^v1\.[A-Za-z0-9_-]{43}$/);
  return res.json.previewToken;
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

test('readJsonBody：settings 专用 wire 上限不放宽默认 1 MiB，并保持有限排空', async () => {
  assert.equal(SETTINGS_MAX_BODY_BYTES, 6 * SETTINGS_MAX_BYTES + 4096);

  const content = '\u0000'.repeat(SETTINGS_MAX_BYTES);
  const wire = JSON.stringify({ content, baseChecksum: null });
  assert.ok(Buffer.byteLength(wire) > MAX_BODY_BYTES, '样本必须越过通用 1 MiB wire 上限');
  assert.ok(Buffer.byteLength(wire) <= SETTINGS_MAX_BODY_BYTES, '512 KiB 最坏转义仍须过专用 wire 上限');

  await assert.rejects(
    () => readJsonBody(bodyOf(wire)),
    (error) => error.code === 'VALIDATION' && error.message.includes(String(MAX_BODY_BYTES)),
  );
  assert.deepEqual(
    await readJsonBody(bodyOf(wire), { maxBytes: SETTINGS_MAX_BODY_BYTES, fatalUtf8: true }),
    { content, baseChecksum: null },
  );

  const overContent = '\u0000'.repeat(525_000);
  const overWire = JSON.stringify({ content: overContent, baseChecksum: null });
  assert.ok(Buffer.byteLength(overWire) > SETTINGS_MAX_BODY_BYTES);
  await assert.rejects(
    () => readJsonBody(bodyOf(overWire), {
      maxBytes: SETTINGS_MAX_BODY_BYTES,
      overLimitCode: 'SETTINGS_TOO_LARGE',
    }),
    (error) => error.code === 'SETTINGS_TOO_LARGE'
      && error.message.includes(String(SETTINGS_MAX_BODY_BYTES)),
  );
});

test('readJsonBody：settings 模式明确拒绝非法 UTF-8 JSON', async () => {
  const invalidUtf8Json = Buffer.concat([
    Buffer.from('{"content":"'),
    Buffer.from([0xff]),
    Buffer.from('","baseChecksum":null}'),
  ]);

  assert.deepEqual(
    await readJsonBody(Readable.from([invalidUtf8Json])),
    { content: '\ufffd', baseChecksum: null },
    '默认 reader 保持既有 UTF-8 替换行为',
  );
  await assert.rejects(
    () => readJsonBody(Readable.from([invalidUtf8Json]), { fatalUtf8: true }),
    (error) => error.code === 'VALIDATION' && /UTF-8 JSON/u.test(error.message),
  );

  const secret = 'UNIQUE_SETTINGS_SECRET_7f9c';
  await assert.rejects(
    () => readJsonBody(bodyOf(`{"content":"${secret}"`), { redactParseError: true }),
    (error) => error.code === 'VALIDATION'
      && error.message === '请求体不是合法 JSON'
      && !error.message.includes(secret),
  );
});

test('settings PUT schema：双字段必填，拒绝 path/未知键与非法 checksum', () => {
  assert.equal(validate(dshSettingsPutSchema, { content: '', baseChecksum: null }).ok, true);
  assert.equal(validate(dshSettingsPutSchema, {
    content: 'model: test\n',
    baseChecksum: 'cksum-v1:4294967295:12',
  }).ok, true);

  const invalidBodies = [
    { content: '' },
    { baseChecksum: null },
    { content: '', baseChecksum: null, path: '/tmp/settings.yaml' },
    { content: '', baseChecksum: null, filename: 'settings.yaml' },
    { content: '', baseChecksum: 'sha256:abc' },
    { content: '', baseChecksum: 'cksum-v1:4294967296:0' },
    { content: '', baseChecksum: 'cksum-v1:1:524289' },
  ];
  for (const body of invalidBodies) {
    assert.equal(validate(dshSettingsPutSchema, body).ok, false, JSON.stringify(body));
  }
});

test('Workspace 登记 schema：只接受自有键为空的对象', () => {
  assert.equal(validate(dshWorkspaceCreateSchema, {}).ok, true);
  assert.equal(validate(dshWorkspaceCreateSchema, { path: '/tmp/forbidden' }).ok, false);
  assert.equal(validate(dshWorkspaceCreateSchema, { workdir: '/tmp/forbidden' }).ok, false);

  const inherited = Object.create({ path: '/tmp/inherited' });
  assert.equal(
    validate(dshWorkspaceCreateSchema, inherited).ok,
    true,
    'schema 只按 Object.hasOwn 处理 JSON 对象自有键',
  );
});

function makeWorkspaceHostRunning(name = 'gpu-1', workdir = '/srv/project') {
  store.setPhase(name, 'ready', 'workspace-api-test');
  store.setPhase(name, 'starting', 'workspace-api-test');
  store.setPhase(name, 'running', 'workspace-api-test');
  store.mutateHostState(name, (entry) => {
    entry.web = {
      pid: 1234,
      port: 8899,
      startedByUs: true,
      cmdFingerprint: 'dsh web --port 8899',
      log: 'dsh-web.log',
      startedAt: '2026-08-24T00:00:00.000Z',
      workdir,
      cwd: workdir,
    };
    entry.tunnel = { localPort: 17701 };
  });
  store.setTunnelStatusProvider((host) => (host === name
    ? {
      localPort: 17701,
      connected: true,
      reconnectAttempt: 0,
      suspendedReason: null,
    }
    : null));
}

function workspaceRpcResponse(rpcId, overrides = {}) {
  return new Response(JSON.stringify({
    type: 'server-response',
    rpcId,
    result: {
      ok: true,
      value: {
        workspace: {
          workspaceId: 'workspace-api-1',
          path: '/srv/project',
          title: 'project',
          sessionIds: ['session-secret-not-forwarded'],
          createdAt: '2026-08-24T00:00:00.000Z',
          updatedAt: '2026-08-24T00:00:00.000Z',
        },
        created: true,
      },
    },
    ...overrides,
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

test('POST dsh-workspace：严格路由/query/body/host 前置失败均不访问上游', async (t) => {
  const ctx = await bootServer(t, {
    skipBoot: true,
    hostConfig: { 'gpu-1': { workdir: '/srv/project' } },
  });
  let fetchCalls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    fetchCalls += 1;
    throw new Error('must not fetch');
  });

  const cases = [
    ['POST', '/api/hosts/gpu-1/dsh-workspace?path=%2Ftmp%2Fattack', {}, 400, 'VALIDATION'],
    ['POST', '/api/hosts/gpu-1/dsh-workspace', { path: '/tmp/attack' }, 400, 'VALIDATION'],
    ['POST', '/api/hosts/gpu-1/dsh-workspace', { workdir: '/tmp/attack' }, 400, 'VALIDATION'],
    ['POST', '/api/hosts/gpu-1/dsh-workspace', undefined, 400, 'VALIDATION'],
    ['POST', '/api/hosts/gpu-1/dsh-workspace/', {}, 404, 'NOT_FOUND'],
    ['POST', '/api/hosts/%/dsh-workspace', {}, 400, 'VALIDATION'],
    ['POST', '/api/hosts/missing/dsh-workspace', {}, 404, 'NOT_FOUND'],
  ];

  for (const [method, route, body, status, code] of cases) {
    // eslint-disable-next-line no-await-in-loop -- 每种边界都要确认没有任何上游访问
    const response = await ctx.api(method, route, body);
    assert.equal(response.status, status, `${method} ${route}: ${response.text}`);
    assert.equal(response.json.code, code);
    assert.equal(fetchCalls, 0);
  }

  const malformed = await rawRequest(
    ctx.base,
    'POST',
    '/api/hosts/gpu-1/dsh-workspace',
    '{"path":"/private/secret"',
  );
  assert.equal(malformed.status, 400, malformed.text);
  assert.equal(malformed.json.code, 'VALIDATION');
  assert.doesNotMatch(malformed.text, /private|secret/u);
  assert.equal(fetchCalls, 0);

  const secret = 'WORKSPACE_BODY_SECRET_6f3a';
  assert.ok(DSH_WORKSPACE_MAX_BODY_BYTES <= 256);
  const oversizedBody = JSON.stringify({
    padding: `${secret}${'x'.repeat(DSH_WORKSPACE_MAX_BODY_BYTES)}`,
  });
  assert.ok(Buffer.byteLength(oversizedBody) > DSH_WORKSPACE_MAX_BODY_BYTES);

  const oversized = await rawRequest(
    ctx.base,
    'POST',
    '/api/hosts/gpu-1/dsh-workspace',
    oversizedBody,
  );
  assert.equal(oversized.status, 400, oversized.text);
  assert.equal(oversized.json.code, 'VALIDATION');
  assert.match(oversized.json.error, new RegExp(String(DSH_WORKSPACE_MAX_BODY_BYTES), 'u'));
  assert.doesNotMatch(oversized.text, new RegExp(secret, 'u'));

  const queryFirst = await rawRequest(
    ctx.base,
    'POST',
    '/api/hosts/gpu-1/dsh-workspace?unused=1',
    oversizedBody,
  );
  assert.equal(queryFirst.status, 400, queryFirst.text);
  assert.match(queryFirst.json.error, /query/u);
  assert.doesNotMatch(queryFirst.json.error, /字节上限/u);

  const hostFirst = await rawRequest(
    ctx.base,
    'POST',
    '/api/hosts/missing/dsh-workspace',
    oversizedBody,
  );
  assert.equal(hostFirst.status, 404, hostFirst.text);
  assert.equal(hostFirst.json.code, 'NOT_FOUND');
  assert.equal(fetchCalls, 0);
});

test('POST dsh-workspace：setup gate 保持阻断且不访问上游', async (t) => {
  const ctx = await bootServer(t, {
    setupCompleted: false,
    skipBoot: true,
    hostConfig: { 'gpu-1': { workdir: '/srv/project' } },
  });
  let fetchCalls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    fetchCalls += 1;
    throw new Error('must not fetch');
  });

  const response = await ctx.api('POST', '/api/hosts/gpu-1/dsh-workspace', {});
  assert.equal(response.status, 409, response.text);
  assert.equal(response.json.code, 'SETUP_REQUIRED');
  assert.equal(fetchCalls, 0);
});

test('POST dsh-workspace：经 HostView.mappedUrl 调官方 RPC 并返回最小安全结果', async (t) => {
  const ctx = await bootServer(t, {
    skipBoot: true,
    hostConfig: { 'gpu-1': { workdir: '/srv/project' } },
  });
  makeWorkspaceHostRunning();
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const envelope = JSON.parse(init.body);
    requests.push({ url, init, envelope });
    return workspaceRpcResponse(envelope.rpcId);
  });

  const response = await ctx.api('POST', '/api/hosts/gpu-1/dsh-workspace', {});
  assert.equal(response.status, 200, response.text);
  assert.deepEqual(response.json, {
    created: true,
    workspaceId: 'workspace-api-1',
    title: 'project',
    path: '/srv/project',
  });
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(requests.length, 1, '已有绝对 CWD 时只发送 workspace.create');
  const [request] = requests;
  assert.equal(request.url, 'http://127.0.0.1:17701/api/workspace.create');
  assert.deepEqual(request.envelope, {
    type: 'client-request',
    rpcId: request.envelope.rpcId,
    method: 'workspace.create',
    payload: { path: '/srv/project' },
  });
  assert.equal(Object.hasOwn(response.json, 'sessionIds'), false);
  assert.equal(Object.hasOwn(response.json, 'createdAt'), false);
});

test('POST dsh-workspace：degraded 但映射断开时快败且不 fetch', async (t) => {
  const ctx = await bootServer(t, {
    skipBoot: true,
    hostConfig: { 'gpu-1': { workdir: '/srv/project' } },
  });
  makeWorkspaceHostRunning();
  store.setPhase('gpu-1', 'degraded', 'workspace-api-disconnected-test');
  store.setTunnelStatusProvider(() => ({
    localPort: 17701,
    connected: false,
    reconnectAttempt: 1,
    suspendedReason: null,
  }));
  let fetchCalls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    fetchCalls += 1;
    throw new Error('must not fetch released mapped port');
  });

  const response = await ctx.api('POST', '/api/hosts/gpu-1/dsh-workspace', {});
  assert.equal(response.status, 409, response.text);
  assert.equal(response.json.code, 'PHASE_CONFLICT');
  assert.equal(fetchCalls, 0);
});

test('POST dsh-workspace：上游 domain 错误经 HTTP 边界保持脱敏', async (t) => {
  const ctx = await bootServer(t, {
    skipBoot: true,
    hostConfig: { 'gpu-1': { workdir: '/srv/project' } },
  });
  makeWorkspaceHostRunning();
  const secret = 'UPSTREAM_WORKSPACE_SECRET_/private/project';
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const { rpcId } = JSON.parse(init.body);
    return new Response(JSON.stringify({
      type: 'server-response',
      rpcId,
      result: {
        ok: false,
        error: {
          code: 'workspace-invalid-path',
          message: secret,
          details: { path: secret },
        },
      },
    }), { status: 200 });
  });

  const response = await ctx.api('POST', '/api/hosts/gpu-1/dsh-workspace', {});
  assert.equal(response.status, 422, response.text);
  assert.equal(response.json.code, 'WORKSPACE_INVALID_PATH');
  assert.equal(Object.hasOwn(response.json, 'detail'), false);
  assert.doesNotMatch(response.text, /UPSTREAM_WORKSPACE_SECRET|private/u);
});

test('POST dsh-workspace：客户端断开会 abort 上游并释放 admission slot', async (t) => {
  const ctx = await bootServer(t, {
    skipBoot: true,
    hostConfig: { 'gpu-1': { workdir: '/srv/project' } },
  });
  makeWorkspaceHostRunning();
  let fetchCalls = 0;
  let markStarted;
  let markAborted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const aborted = new Promise((resolve) => { markAborted = resolve; });
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    fetchCalls += 1;
    if (fetchCalls === 1) {
      markStarted();
      if (init.signal.aborted) markAborted();
      else init.signal.addEventListener('abort', markAborted, { once: true });
      return new Promise(() => {});
    }
    return workspaceRpcResponse(JSON.parse(init.body).rpcId);
  });

  const url = new URL('/api/hosts/gpu-1/dsh-workspace', ctx.base);
  const client = http.request({
    host: url.hostname,
    port: url.port,
    path: url.pathname,
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'content-length': 2,
    },
  });
  client.on('error', () => {});
  client.end('{}');
  await started;
  client.destroy();
  await Promise.race([
    aborted,
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('上游 fetch 未随客户端断开而 abort')), 1_000);
      timer.unref?.();
    }),
  ]);

  const retry = await ctx.api('POST', '/api/hosts/gpu-1/dsh-workspace', {});
  assert.equal(retry.status, 200, retry.text);
  assert.equal(retry.json.created, true);
  assert.equal(fetchCalls, 2);
});

test('settings REST contract：read 条件形状与 write 不回显 content', () => {
  const missing = {
    exists: false,
    path: '/home/test/.dsh/settings.yaml',
    content: '',
    checksum: null,
    size: 0,
  };
  const existingContent = '中文\n';
  const existingBytes = Buffer.from(existingContent, 'utf8');
  const existingCrc = posixCksum(existingBytes);
  const existing = {
    exists: true,
    path: '/home/test/.dsh/settings.yaml',
    content: existingContent,
    checksum: `cksum-v1:${existingCrc}:${existingBytes.byteLength}`,
    size: existingBytes.byteLength,
  };
  const written = {
    updated: true,
    path: '/home/test/.dsh/settings.yaml',
    checksum: 'cksum-v1:456:7',
    size: 7,
  };
  assertShape(settingsReadResponse, missing, 'settings missing');
  assertShape(settingsReadResponse, existing, 'settings existing');
  assertShape(settingsWriteResponse, written, 'settings write');

  assert.equal(validate(settingsReadResponse, { ...missing, checksum: 'cksum-v1:1:0' }).ok, false);
  assert.equal(validate(settingsReadResponse, { ...existing, size: 6 }).ok, false);
  const wrongCrc = existingCrc === 0 ? 1 : 0;
  assert.equal(validate(settingsReadResponse, {
    ...existing,
    checksum: `cksum-v1:${wrongCrc}:${existingBytes.byteLength}`,
  }).ok, false);
  assert.equal(validate(settingsWriteResponse, { ...written, updated: false }).ok, false);
  assert.equal(validate(settingsWriteResponse, { ...written, content: 'secret' }).ok, false);
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

test('settings API：query、非法 body、未知主机均在目标执行前拒绝', async (t) => {
  const ctx = await bootServer(t, { skipBoot: true });
  assert.deepEqual(ctx.harness.transportCalls(), []);

  const cases = [
    ['GET', '/api/hosts/gpu-1/dsh-settings?path=%2Ftmp%2Fx', undefined, 400, 'VALIDATION'],
    ['PUT', '/api/hosts/gpu-1/dsh-settings?unused=1', {
      content: '', baseChecksum: null,
    }, 400, 'VALIDATION'],
    ['PUT', '/api/hosts/gpu-1/dsh-settings', {
      content: '', baseChecksum: null, path: '/tmp/settings.yaml',
    }, 400, 'VALIDATION'],
    ['PUT', '/api/hosts/gpu-1/dsh-settings', {
      content: '', baseChecksum: 'bad-token',
    }, 400, 'VALIDATION'],
    ['GET', '/api/hosts/missing/dsh-settings', undefined, 404, 'NOT_FOUND'],
    ['PUT', '/api/hosts/missing/dsh-settings', {
      content: '', baseChecksum: null,
    }, 404, 'NOT_FOUND'],
  ];

  for (const [method, route, body, status, code] of cases) {
    // eslint-disable-next-line no-await-in-loop -- 每个前置拒绝都要逐一确认目标端账本不变
    const res = await ctx.api(method, route, body);
    assert.equal(res.status, status, `${method} ${route}: ${res.text}`);
    assert.equal(res.json.code, code);
    assert.deepEqual(ctx.harness.transportCalls(), [], `${method} ${route} 不得执行目标命令`);
  }
});

test('settings API：畸形 host 编码统一为无 stack detail 的 VALIDATION', async (t) => {
  const ctx = await bootServer(t, { skipBoot: true });
  for (const method of ['GET', 'PUT']) {
    // eslint-disable-next-line no-await-in-loop -- GET/PUT 都必须独立通过路由边界
    const res = await ctx.api(
      method,
      '/api/hosts/%/dsh-settings',
      method === 'PUT' ? { content: '', baseChecksum: null } : undefined,
    );
    assert.equal(res.status, 400, res.text);
    assert.equal(res.json.code, 'VALIDATION');
    assert.equal(Object.hasOwn(res.json, 'detail'), false);
    assert.doesNotMatch(res.text, /URIError|stack|decodeURIComponent/u);
    assert.deepEqual(ctx.harness.transportCalls(), []);
  }
});

test('settings PUT：非法 JSON 脱敏，525000 NUL wire 超限映射 413', async (t) => {
  const ctx = await bootServer(t, { skipBoot: true });
  const secret = 'UNIQUE_SETTINGS_SECRET_4a26';
  const malformed = await rawRequest(
    ctx.base,
    'PUT',
    '/api/hosts/gpu-1/dsh-settings',
    `{"content":"${secret}","baseChecksum":null`,
  );
  assert.equal(malformed.status, 400, malformed.text);
  assert.equal(malformed.json.code, 'VALIDATION');
  assert.equal(malformed.json.error, '请求体不是合法 JSON');
  assert.doesNotMatch(malformed.text, new RegExp(secret, 'u'));

  const overWire = JSON.stringify({
    content: '\u0000'.repeat(525_000),
    baseChecksum: null,
  });
  const oversized = await rawRequest(
    ctx.base,
    'PUT',
    '/api/hosts/gpu-1/dsh-settings',
    overWire,
  );
  assert.equal(oversized.status, 413, oversized.text);
  assert.equal(oversized.json.code, 'SETTINGS_TOO_LARGE');
  assert.deepEqual(ctx.harness.transportCalls(), []);
});

test('settings API：GET/PUT 默认受 setup gate 阻断且不执行目标命令', async (t) => {
  const ctx = await bootServer(t, { setupCompleted: false, skipBoot: true });

  const get = await ctx.get('/api/hosts/gpu-1/dsh-settings');
  assert.equal(get.status, 409);
  assert.equal(get.json.code, 'SETUP_REQUIRED');

  const put = await ctx.api('PUT', '/api/hosts/gpu-1/dsh-settings', {
    content: '',
    baseChecksum: null,
  });
  assert.equal(put.status, 409);
  assert.equal(put.json.code, 'SETUP_REQUIRED');
  assert.deepEqual(ctx.harness.transportCalls(), []);
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
  const { previewToken, ...missingPreviewToken } = res.json;
  assert.throws(
    () => assertRest(
      { ...res, json: missingPreviewToken },
      { status: 200, schema: syncConfigResponse, label: 'POST sync-config preview 缺 token' },
    ),
    /previewToken: required/,
  );
  assert.match(previewToken, /^v1\.[A-Za-z0-9_-]{43}$/);
  assert.doesNotMatch(previewToken, /SYNCED|source\.patch|--source/);
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
  const previewToken = await previewSync(ctx);

  const res = await ctx.api('POST', '/api/hosts/sync-config', {
    source: 'source',
    targets: ['target-a', 'target-b'],
    dryRun: false,
    previewToken,
  });
  await sse.wait((frame) => frame.type === 'host-changed' && frame.data.host.name === 'target-a');

  assertRest(res, { status: 200, schema: syncConfigResponse, label: 'POST sync-config apply' });
  assert.equal(Object.hasOwn(res.json, 'previewToken'), false, 'apply 响应不应回传 preview token');
  assert.deepEqual(res.json.applied, ['target-a']);
  assert.deepEqual(res.json.hosts.map((host) => host.name), ['target-a', 'target-b']);
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
  assert.equal(res.json.hosts[0].config.remoteWebPort, null);
  assert.equal(res.json.hosts[0].config.workdir, null);
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
  const previewToken = await previewSync(ctx, ['target-b']);

  const res = await ctx.api('POST', '/api/hosts/sync-config', {
    source: 'source',
    targets: ['target-b'],
    dryRun: false,
    previewToken,
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

test('POST sync-config apply：缺 token 为 400，错误 token 为 409，均不落盘', async (t) => {
  const ctx = await bootServer(t, syncServerOptions());
  const configFile = path.join(ctx.harness.homeDir, 'config.json');
  const before = fs.readFileSync(configFile, 'utf8');
  const base = {
    source: 'source',
    targets: ['target-a'],
    dryRun: false,
  };

  const missing = await ctx.api('POST', '/api/hosts/sync-config', base);
  assert.equal(missing.status, 400, missing.text);
  assert.equal(missing.json.code, 'VALIDATION');

  const wrong = await ctx.api('POST', '/api/hosts/sync-config', {
    ...base,
    previewToken: 'wrong-preview-token',
  });
  assert.equal(wrong.status, 409, wrong.text);
  assert.equal(wrong.json.code, 'CONFIG_STALE');
  assert.match(wrong.json.error, /重新预览|预览.*过期/);
  assert.equal(fs.readFileSync(configFile, 'utf8'), before);
});

test('POST sync-config apply：preview 后源 profile 变化则整单 CONFIG_STALE', async (t) => {
  const ctx = await bootServer(t, syncServerOptions());
  const configFile = path.join(ctx.harness.homeDir, 'config.json');
  const previewToken = await previewSync(ctx, ['target-a']);
  const changed = await ctx.api('PUT', '/api/hosts/source/config', { workdir: '/changed-source' });
  assert.equal(changed.status, 200, changed.text);
  const beforeApply = fs.readFileSync(configFile, 'utf8');

  const res = await ctx.api('POST', '/api/hosts/sync-config', {
    source: 'source',
    targets: ['target-a'],
    dryRun: false,
    previewToken,
  });

  assert.equal(res.status, 409, res.text);
  assert.equal(res.json.code, 'CONFIG_STALE');
  assert.equal(fs.readFileSync(configFile, 'utf8'), beforeApply);
  const onDisk = JSON.parse(beforeApply);
  assert.equal(onDisk.hosts.source.workdir, '/changed-source');
  assert.equal(onDisk.hosts['target-a'].workdir, '/old/workdir', '不得应用未预览的新源值');
});

test('POST sync-config apply：preview 后任一目标 profile 变化则整单 CONFIG_STALE', async (t) => {
  const ctx = await bootServer(t, syncServerOptions());
  const configFile = path.join(ctx.harness.homeDir, 'config.json');
  const previewToken = await previewSync(ctx, ['target-a', 'target-b']);
  const changed = await ctx.api('PUT', '/api/hosts/target-b/config', { workdir: '/changed-target' });
  assert.equal(changed.status, 200, changed.text);
  const beforeApply = fs.readFileSync(configFile, 'utf8');

  const res = await ctx.api('POST', '/api/hosts/sync-config', {
    source: 'source',
    targets: ['target-b', 'target-a'],
    dryRun: false,
    previewToken,
  });

  assert.equal(res.status, 409, res.text);
  assert.equal(res.json.code, 'CONFIG_STALE');
  assert.equal(fs.readFileSync(configFile, 'utf8'), beforeApply);
});

test('POST sync-config apply：同步范围外变化不使 token 过期', async (t) => {
  const ctx = await bootServer(t, syncServerOptions());
  const previewToken = await previewSync(ctx, ['target-a']);
  const changed = await ctx.api('PUT', '/api/hosts/target-a/config', { enabled: true });
  assert.equal(changed.status, 200, changed.text);

  const res = await ctx.api('POST', '/api/hosts/sync-config', {
    source: 'source',
    targets: ['target-a'],
    dryRun: false,
    previewToken,
  });

  assertRest(res, { status: 200, schema: syncConfigResponse, label: 'POST sync-config unrelated change' });
  assert.deepEqual(res.json.applied, ['target-a']);
  assert.equal(res.json.hosts[0].config.enabled, true);
});

test('POST sync-config：missing/重复/source target 整单失败且文件逐字不变', async (t) => {
  const ctx = await bootServer(t, syncServerOptions());
  const configFile = path.join(ctx.harness.homeDir, 'config.json');
  const before = fs.readFileSync(configFile, 'utf8');
  const cases = [
    [{
      source: 'missing', targets: ['target-a'], dryRun: false, previewToken: 'wrong-preview-token',
    }, 404, 'NOT_FOUND'],
    [{
      source: 'source', targets: ['target-a', 'missing'], dryRun: false, previewToken: 'wrong-preview-token',
    }, 404, 'NOT_FOUND'],
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
        {
          source: name,
          targets: ['target-a'],
          dryRun,
          ...(dryRun ? {} : { previewToken: 'wrong-preview-token' }),
        },
        {
          source: 'source',
          targets: ['target-a', name],
          dryRun,
          ...(dryRun ? {} : { previewToken: 'wrong-preview-token' }),
        },
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
