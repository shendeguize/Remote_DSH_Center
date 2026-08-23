import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { recentLogs } from '../../src/lib/bus.js';
import { hostQueue } from '../../src/lib/ssh.js';
import { SETTINGS_MAX_BYTES } from '../../src/settings-file.js';
import {
  assertRest,
  settingsReadResponse,
  settingsWriteResponse,
} from '../contract/schemas.js';
import { newHostState } from '../harness/index.js';
import { SCENARIOS } from '../harness/scenarios.js';
import { bootServer, store } from './helpers.js';

const SETTINGS_ROUTE = (host) => `/api/hosts/${host}/dsh-settings`;
const SYNTHETIC_V1 = 'provider: synthetic-v1\nkey: test-only-alpha\n';
const SYNTHETIC_V2 = 'provider: synthetic-v2\r\nkey: test-only-beta\r\n';
const STALE_CONTENT = 'must-not-win: synthetic-stale\n';
const SIDE_CHANNEL_CANARIES = ['test-only-alpha', 'test-only-beta', 'synthetic-stale'];
const SETTINGS_STAGING_PREFIX = '.dsh_center_remote/settings-staging/';
const SETTINGS_STAGING_SENTINEL = `${SETTINGS_STAGING_PREFIX}keep.data`;
const SETTINGS_STAGING_RESERVED_RE = /^(?:read-[^/]*\.(?:data|hex|hex-raw)|write-[^/]*\.data)$/u;

function diskText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function assertNoStore(response) {
  assert.equal(response.headers['cache-control'], 'no-store');
}

function assertNoSettingsStaging(ctx, ...hosts) {
  for (const host of hosts) {
    const files = Object.keys(ctx.harness.remoteFiles(host));
    const reserved = files.filter((name) => (
      name.startsWith(SETTINGS_STAGING_PREFIX)
      && SETTINGS_STAGING_RESERVED_RE.test(name.slice(SETTINGS_STAGING_PREFIX.length))
    ));
    assert.equal(
      reserved.length,
      0,
      `${host} 不得遗留 reserved settings staging：${reserved.join(', ')}`,
    );
  }
}

function assertSettingsSentinel(ctx, host) {
  assert.equal(
    ctx.harness.remoteFiles(host)[SETTINGS_STAGING_SENTINEL],
    'user-owned-sentinel',
    'settings 操作不得删除 staging 目录下的用户无关文件',
  );
  assertNoSettingsStaging(ctx, host);
}

test('remote settings HTTP 全链：missing→create→update→backup→stale，内容不旁路泄漏', async (t) => {
  const initial = SCENARIOS['settings-missing']();
  initial.files = {
    [SETTINGS_STAGING_SENTINEL]: 'user-owned-sentinel',
    [`${SETTINGS_STAGING_PREFIX}read-abandoned.data`]: 'reserved-old-read-data',
    [`${SETTINGS_STAGING_PREFIX}read-abandoned.hex`]: 'reserved-old-read-hex',
    [`${SETTINGS_STAGING_PREFIX}read-abandoned.hex-raw`]: 'reserved-old-read-hex-raw',
    [`${SETTINGS_STAGING_PREFIX}write-abandoned.data`]: 'reserved-old-write-data',
  };
  const ctx = await bootServer(t, {
    skipBoot: true,
    hosts: { 'gpu-1': initial },
  });
  const events = await ctx.sse();
  await events.wait((frame) => frame.type === 'snapshot');
  const initialFrameCount = events.frames.length;

  const missing = await ctx.get(SETTINGS_ROUTE('gpu-1'));
  assertRest(missing, {
    status: 200,
    schema: settingsReadResponse,
    label: 'GET missing settings',
  });
  assertNoStore(missing);
  assert.deepEqual(missing.json, {
    exists: false,
    path: '/root/.dsh/settings.yaml',
    content: '',
    checksum: null,
    size: 0,
  });
  assertSettingsSentinel(ctx, 'gpu-1');

  const created = await ctx.api('PUT', SETTINGS_ROUTE('gpu-1'), {
    content: SYNTHETIC_V1,
    baseChecksum: null,
  });
  assertRest(created, {
    status: 200,
    schema: settingsWriteResponse,
    label: 'PUT create settings',
  });
  assertNoStore(created);
  assert.equal(Object.hasOwn(created.json, 'content'), false);
  assert.equal(ctx.harness.hostState('gpu-1').settingsMode, 0o600);
  assert.deepEqual(ctx.harness.hostState('gpu-1').backup, {
    previousHex: null,
    absent: true,
    mode: 0o600,
  });
  assertSettingsSentinel(ctx, 'gpu-1');

  const loadedV1 = await ctx.get(SETTINGS_ROUTE('gpu-1'));
  assertRest(loadedV1, {
    status: 200,
    schema: settingsReadResponse,
    label: 'GET created settings',
  });
  assertNoStore(loadedV1);
  assert.equal(loadedV1.json.content, SYNTHETIC_V1);
  assert.equal(loadedV1.json.checksum, created.json.checksum);
  assert.deepEqual(Buffer.from(loadedV1.json.content), Buffer.from(SYNTHETIC_V1));
  assertSettingsSentinel(ctx, 'gpu-1');

  const updated = await ctx.api('PUT', SETTINGS_ROUTE('gpu-1'), {
    content: SYNTHETIC_V2,
    baseChecksum: loadedV1.json.checksum,
  });
  assertRest(updated, {
    status: 200,
    schema: settingsWriteResponse,
    label: 'PUT update settings',
  });
  assertNoStore(updated);
  const afterUpdate = ctx.harness.hostState('gpu-1');
  assert.equal(afterUpdate.settingsMode, 0o600);
  assert.deepEqual(afterUpdate.backup, {
    previousHex: Buffer.from(SYNTHETIC_V1).toString('hex'),
    absent: false,
    mode: 0o600,
  });
  assertSettingsSentinel(ctx, 'gpu-1');

  const stale = await ctx.api('PUT', SETTINGS_ROUTE('gpu-1'), {
    content: STALE_CONTENT,
    baseChecksum: loadedV1.json.checksum,
  });
  assertRest(stale, { status: 409, label: 'PUT stale settings' });
  assertNoStore(stale);
  assert.equal(stale.json.code, 'SETTINGS_STALE');
  assertSettingsSentinel(ctx, 'gpu-1');

  const loadedV2 = await ctx.get(SETTINGS_ROUTE('gpu-1'));
  assert.equal(loadedV2.status, 200, loadedV2.text);
  assert.equal(loadedV2.json.content, SYNTHETIC_V2, 'stale PUT 不得覆盖当前内容');
  assert.equal(loadedV2.json.checksum, updated.json.checksum);
  assert.deepEqual(ctx.harness.hostState('gpu-1').backup, afterUpdate.backup, 'stale 不得改备份');
  assertNoSettingsStaging(ctx, 'gpu-1');

  await new Promise((resolve) => { setImmediate(resolve); });
  assert.equal(events.frames.length, initialFrameCount, '同步 settings API 不产生 SSE 正文');

  const managerFiles = [
    path.join(ctx.harness.homeDir, 'config.json'),
    path.join(ctx.harness.homeDir, 'state.json'),
    path.join(ctx.harness.homeDir, 'manager.log'),
  ].map(diskText).join('\n');
  const sideChannels = [
    managerFiles,
    JSON.stringify(recentLogs()),
    JSON.stringify(events.frames),
    JSON.stringify(ctx.harness.transportCalls()),
  ].join('\n');
  for (const canary of SIDE_CHANNEL_CANARIES) {
    assert.equal(sideChannels.includes(canary), false, `${canary} 明文不得进入 manager 旁路`);
    const hex = Buffer.from(canary).toString('hex');
    assert.equal(sideChannels.includes(hex), false, `${canary} hex 不得进入 manager 旁路`);
  }
  for (const marker of ['CONTENT_HEX', 'PATH_HEX']) {
    assert.equal(sideChannels.includes(marker), false, `${marker} 原始协议不得进入 manager 旁路`);
  }
  assert.deepEqual(
    ctx.harness.transportCalls().map(({ transport, kind }) => ({ transport, kind })),
    [
      { transport: 'ssh', kind: 'settings-read' },
      { transport: 'ssh', kind: 'settings-write' },
      { transport: 'ssh', kind: 'settings-read' },
      { transport: 'ssh', kind: 'settings-write' },
      { transport: 'ssh', kind: 'settings-write' },
      { transport: 'ssh', kind: 'settings-read' },
    ],
  );
});

test('settings 不受 ready/no_dsh/disabled/crashed 限制，且旧 PROBE 分类不回归', async (t) => {
  const content = Buffer.from('state-independent: synthetic\n').toString('hex');
  const ctx = await bootServer(t, {
    hosts: {
      ready: newHostState({ settingsHex: content, settingsMode: 0o600 }),
      'no-dsh': newHostState({
        dshInstalled: false,
        settingsHex: content,
        settingsMode: 0o600,
      }),
      disabled: newHostState({ settingsHex: content, settingsMode: 0o600 }),
      crashed: newHostState({ settingsHex: content, settingsMode: 0o600 }),
    },
    hostConfig: {
      disabled: { enabled: false },
    },
  });

  assert.equal(store.getPhase('ready'), 'ready');
  assert.equal(store.getPhase('no-dsh'), 'no_dsh');
  assert.equal(store.getHostView('disabled').config.enabled, false);
  store.setPhase('crashed', 'starting', 'settings-test');
  store.setPhase('crashed', 'running', 'settings-test');
  store.setPhase('crashed', 'crashed', 'settings-test');

  const expectedPhases = {
    ready: 'ready',
    'no-dsh': 'no_dsh',
    disabled: 'ready',
    crashed: 'crashed',
  };
  for (const name of Object.keys(expectedPhases)) {
    // eslint-disable-next-line no-await-in-loop -- 逐态确认 GET/PUT 都没有 phase preflight
    const read = await ctx.get(SETTINGS_ROUTE(name));
    assertRest(read, {
      status: 200,
      schema: settingsReadResponse,
      label: `GET settings (${name})`,
    });
    // eslint-disable-next-line no-await-in-loop -- PUT 必须带本态 GET 返回的正确 base
    const write = await ctx.api('PUT', SETTINGS_ROUTE(name), {
      content: `phase-write-${name}: synthetic\n`,
      baseChecksum: read.json.checksum,
    });
    assertRest(write, {
      status: 200,
      schema: settingsWriteResponse,
      label: `PUT settings (${name})`,
    });
    assert.equal(store.getPhase(name), expectedPhases[name], `settings PUT 不得改变 ${name} phase`);
    assertNoSettingsStaging(ctx, name);
  }

  const calls = ctx.harness.transportCalls();
  assert.deepEqual(calls.slice(0, 4).map((call) => call.kind), ['probe', 'probe', 'probe', 'probe']);
  assert.deepEqual(calls.slice(4).map((call) => call.kind), [
    'settings-read',
    'settings-write',
    'settings-read',
    'settings-write',
    'settings-read',
    'settings-write',
    'settings-read',
    'settings-write',
  ]);
});

test('settings 精确 512 KiB 可 GET/PUT，输出未触发运输截断', async (t) => {
  const exactA = 'x'.repeat(SETTINGS_MAX_BYTES);
  const exactB = 'b'.repeat(SETTINGS_MAX_BYTES);
  const ctx = await bootServer(t, {
    skipBoot: true,
    hosts: {
      exact: SCENARIOS['settings-exact-cap'](),
    },
  });

  const readA = await ctx.get(SETTINGS_ROUTE('exact'));
  assertRest(readA, {
    status: 200,
    schema: settingsReadResponse,
    label: 'GET exact-cap settings',
  });
  assert.equal(readA.json.size, SETTINGS_MAX_BYTES);
  assert.equal(readA.json.content, exactA);

  const writeB = await ctx.api('PUT', SETTINGS_ROUTE('exact'), {
    content: exactB,
    baseChecksum: readA.json.checksum,
  });
  assertRest(writeB, {
    status: 200,
    schema: settingsWriteResponse,
    label: 'PUT exact-cap settings',
  });
  assert.equal(writeB.json.size, SETTINGS_MAX_BYTES);

  const readB = await ctx.get(SETTINGS_ROUTE('exact'));
  assert.equal(readB.status, 200, readB.text);
  assert.equal(readB.json.size, SETTINGS_MAX_BYTES);
  assert.equal(readB.json.content, exactB);
  assertNoSettingsStaging(ctx, 'exact');
});

test('settings HTTP 故障矩阵：empty/UTF-8/超限/unsupported/read-write fail/corrupt/unknown', async (t) => {
  const ctx = await bootServer(t, {
    skipBoot: true,
    hosts: {
      empty: SCENARIOS['settings-empty'](),
      invalid: SCENARIOS['settings-invalid-utf8'](),
      oversized: SCENARIOS['settings-too-large'](),
      unsupported: SCENARIOS['settings-unsupported'](),
      'read-fail': SCENARIOS['settings-read-fail'](),
      corrupt: SCENARIOS['settings-protocol-corrupt'](),
      'write-fail': SCENARIOS['settings-write-fail'](),
      'unknown-before': SCENARIOS['settings-write-unknown-before-commit'](),
      'unknown-after': SCENARIOS['settings-write-unknown-after-commit'](),
    },
  });

  const empty = await ctx.get(SETTINGS_ROUTE('empty'));
  assertRest(empty, {
    status: 200,
    schema: settingsReadResponse,
    label: 'GET empty settings',
  });
  assert.equal(empty.json.exists, true);
  assert.equal(empty.json.content, '');
  assert.match(empty.json.checksum, /^cksum-v1:\d+:0$/u);

  const failures = [
    ['invalid', 422, 'SETTINGS_INVALID_UTF8'],
    ['oversized', 413, 'SETTINGS_TOO_LARGE'],
    ['unsupported', 501, 'SETTINGS_UNSUPPORTED'],
    ['read-fail', 500, 'SETTINGS_READ_FAILED'],
    ['corrupt', 500, 'PROTO_PARSE'],
  ];
  for (const [host, status, code] of failures) {
    // eslint-disable-next-line no-await-in-loop -- 每个故障都要独立走完整 HTTP/协议边界
    const response = await ctx.get(SETTINGS_ROUTE(host));
    assertRest(response, { status, label: `GET settings failure (${host})` });
    assert.equal(response.json.code, code);
    assertNoStore(response);
    if (host === 'corrupt') {
      assert.doesNotMatch(response.text, /protocol-corrupt: synthetic/u);
    }
  }

  const callsBeforeOversizedPut = ctx.harness.transportCalls().length;
  const oversizedPut = await ctx.api('PUT', SETTINGS_ROUTE('empty'), {
    content: 'x'.repeat(SETTINGS_MAX_BYTES + 1),
    baseChecksum: empty.json.checksum,
  });
  assertRest(oversizedPut, { status: 413, label: 'PUT oversized settings' });
  assert.equal(oversizedPut.json.code, 'SETTINGS_TOO_LARGE');
  assert.equal(
    ctx.harness.transportCalls().length,
    callsBeforeOversizedPut,
    '逻辑超限必须在启动目标命令前拒绝',
  );

  const callsBeforeOversizedCurrent = ctx.harness.transportCalls().length;
  const oversizedCurrent = await ctx.api('PUT', SETTINGS_ROUTE('oversized'), {
    content: 'replacement: synthetic\n',
    baseChecksum: null,
  });
  assertRest(oversizedCurrent, { status: 413, label: 'PUT over-cap current settings' });
  assert.equal(oversizedCurrent.json.code, 'SETTINGS_TOO_LARGE');
  assert.equal(
    ctx.harness.transportCalls().length,
    callsBeforeOversizedCurrent + 1,
    '远端当前文件超限必须由 settings-write 协议回报',
  );

  const writeFailureContent = 'write-failure: synthetic-only\n';
  const writeFailed = await ctx.api('PUT', SETTINGS_ROUTE('write-fail'), {
    content: writeFailureContent,
    baseChecksum: null,
  });
  assertRest(writeFailed, { status: 500, label: 'PUT write-fail settings' });
  assert.equal(writeFailed.json.code, 'SETTINGS_WRITE_FAILED');
  assert.doesNotMatch(writeFailed.text, /write-failure: synthetic-only/u);
  assert.equal(Object.hasOwn(ctx.harness.hostState('write-fail'), 'settingsHex'), false);

  const unknownCases = [
    {
      host: 'unknown-before',
      next: 'unknown-before-next: synthetic-only\n',
      expected: 'unknown-before-base: synthetic\n',
    },
    {
      host: 'unknown-after',
      next: 'unknown-after-next: synthetic-only\n',
      expected: 'unknown-after-next: synthetic-only\n',
    },
  ];
  for (const {
    host, next, expected,
  } of unknownCases) {
    // eslint-disable-next-line no-await-in-loop -- before/after commit 必须分别取各自 base
    const base = await ctx.get(SETTINGS_ROUTE(host));
    assert.equal(base.status, 200, base.text);
    // eslint-disable-next-line no-await-in-loop -- 两种 unknown 都走完整同步 PUT
    const unknown = await ctx.api('PUT', SETTINGS_ROUTE(host), {
      content: next,
      baseChecksum: base.json.checksum,
    });
    assertRest(unknown, { status: 500, label: `PUT ${host} settings result` });
    assert.equal(unknown.json.code, 'SETTINGS_WRITE_FAILED');
    assert.match(unknown.json.error, /结果未知.*重新 GET/u);
    assert.doesNotMatch(unknown.text, /unknown-(?:before|after)-next/u);
    // eslint-disable-next-line no-await-in-loop -- GET 裁决提交前后实际目标
    const confirmed = await ctx.get(SETTINGS_ROUTE(host));
    assert.equal(confirmed.status, 200, confirmed.text);
    assert.equal(confirmed.json.content, expected);
    assert.deepEqual(ctx.harness.hostState(host).backup, {
      previousHex: Buffer.from(base.json.content).toString('hex'),
      absent: false,
      mode: 0o600,
    });
  }

  const ledger = JSON.stringify(ctx.harness.transportCalls());
  assert.doesNotMatch(ledger, /write-failure: synthetic-only|unknown-(?:before|after)-next/u);
  assertNoSettingsStaging(
    ctx,
    'empty',
    'invalid',
    'oversized',
    'unsupported',
    'read-fail',
    'corrupt',
    'write-fail',
    'unknown-before',
    'unknown-after',
  );
});

test('settings WRITE 第二次 CAS 捕获 backup 后的外部改写，不覆盖外部内容', async (t) => {
  const baseContent = 'second-cas-base: synthetic\n';
  const externalContent = 'second-cas-external: synthetic\n';
  const attempted = 'second-cas-attempted: must-not-win\n';
  const ctx = await bootServer(t, {
    skipBoot: true,
    hosts: {
      race: SCENARIOS['settings-change-before-second-cas'](baseContent, externalContent),
    },
  });

  const base = await ctx.get(SETTINGS_ROUTE('race'));
  assert.equal(base.status, 200, base.text);
  assert.equal(base.json.content, baseContent);

  const stale = await ctx.api('PUT', SETTINGS_ROUTE('race'), {
    content: attempted,
    baseChecksum: base.json.checksum,
  });
  assertRest(stale, { status: 409, label: 'PUT stale at second CAS' });
  assert.equal(stale.json.code, 'SETTINGS_STALE');

  const confirmed = await ctx.get(SETTINGS_ROUTE('race'));
  assert.equal(confirmed.status, 200, confirmed.text);
  assert.equal(confirmed.json.content, externalContent, '第二次 CAS 不得覆盖外部改写');
  assert.notEqual(confirmed.json.content, attempted);
  assert.deepEqual(ctx.harness.hostState('race').backup, {
    previousHex: Buffer.from(baseContent).toString('hex'),
    absent: false,
    mode: 0o600,
  });
  assertNoSettingsStaging(ctx, 'race');
});

test('settings staging 灾难中断可遗留，下一次正常操作只清 reserved staging', async (t) => {
  const content = 'catastrophic-staging: synthetic-only\n';
  const ctx = await bootServer(t, {
    skipBoot: true,
    hosts: {
      interrupted: SCENARIOS['settings-staging-catastrophic'](),
    },
  });

  const interrupted = await ctx.api('PUT', SETTINGS_ROUTE('interrupted'), {
    content,
    baseChecksum: null,
  });
  assertRest(interrupted, { status: 502, label: 'PUT catastrophic staging interruption' });
  assert.equal(interrupted.json.code, 'SSH_UNREACHABLE');
  assert.match(interrupted.json.error, /结果未知.*重新 GET/u);
  assert.doesNotMatch(interrupted.text, /catastrophic-staging: synthetic-only/u);

  const staged = Object.entries(ctx.harness.remoteFiles('interrupted'))
    .filter(([name]) => name.startsWith(SETTINGS_STAGING_PREFIX));
  assert.equal(staged.length, 1, '灾难中断证明 fake 确实创建了 reserved staging');
  assert.equal(staged[0][1], Buffer.from(content).toString('hex'));
  assert.doesNotMatch(JSON.stringify(ctx.harness.transportCalls()), /catastrophic-staging/u);

  ctx.harness.faults('interrupted', { settingsCatastrophicAfterStaging: false });
  const recovered = await ctx.get(SETTINGS_ROUTE('interrupted'));
  assertRest(recovered, {
    status: 200,
    schema: settingsReadResponse,
    label: 'GET cleans catastrophic staging',
  });
  assert.equal(recovered.json.exists, false);
  assertNoSettingsStaging(ctx, 'interrupted');
});

test('settings API 在 hostQueue 队首重新确认主机仍存在，排队期间删除则不执行目标命令', async (t) => {
  const ctx = await bootServer(t, {
    skipBoot: true,
    hosts: { race: newHostState() },
  });
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const lifecycle = hostQueue('race').run('settings-race-hold', async () => held);
  t.after(() => { release(); });

  const requestA = ctx.get(SETTINGS_ROUTE('race'));
  const requestB = ctx.get(SETTINGS_ROUTE('race'));
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ id: 'timeout', response: null }), 2_000);
  });
  const first = await Promise.race([
    requestA.then((response) => ({ id: 'A', response })),
    requestB.then((response) => ({ id: 'B', response })),
    timeout,
  ]);
  clearTimeout(timer);
  assert.notEqual(first.id, 'timeout', '并发请求应在 2 秒内快速返回一个 SETTINGS_BUSY');
  assertRest(first.response, { status: 409, label: `concurrent GET ${first.id}` });
  assert.equal(first.response.json.code, 'SETTINGS_BUSY');
  const pending = first.id === 'A' ? requestB : requestA;
  assert.deepEqual(ctx.harness.transportCalls(), []);

  const configPath = path.join(ctx.harness.homeDir, 'config.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  delete config.hosts.race;
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  const reloaded = await ctx.api('POST', '/api/reload');
  assert.equal(reloaded.status, 200, reloaded.text);

  release();
  await lifecycle;
  const response = await pending;
  assertRest(response, { status: 404, label: 'queued GET after host deletion' });
  assert.equal(response.json.code, 'NOT_FOUND');
  assert.deepEqual(ctx.harness.transportCalls(), [], '队首 resolver 失败后不得启动 ssh');
});
