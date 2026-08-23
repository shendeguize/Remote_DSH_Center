import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  SETTINGS_MAX_BYTES,
  _parseSettingsReadResult,
  posixCksum,
  readDshSettings,
  writeDshSettings,
} from '../src/settings-file.js';
import { DshError, ERROR_HTTP_STATUS } from '../src/lib/errors.js';
import {
  _resetQueues, hostQueue, reopenSsh, shutdownSsh,
} from '../src/lib/ssh.js';

const resolveLocal = () => true;

const execResult = (stdout, overrides = {}) => ({
  code: 0,
  signal: null,
  stdout,
  stderr: '',
  stdoutDropped: 0,
  stderrDropped: 0,
  timedOut: false,
  aborted: false,
  ...overrides,
});

function readFrame(content, {
  txn = 'read-test',
  path = '/home/test/.dsh/settings.yaml',
  exists = true,
  size = Buffer.byteLength(content),
  crc = posixCksum(Buffer.from(content)),
  contentHex = Buffer.from(content).toString('hex'),
  done = true,
} = {}) {
  const lines = [
    'SETTINGS_PROTO=1',
    `SETTINGS_TXN=${txn}`,
    `EXISTS=${exists ? 'yes' : 'no'}`,
    `SIZE=${exists ? size : 0}`,
    ...(exists ? [`CRC=${crc}`] : []),
    'PATH_HEX<<DSHC_PATH',
    Buffer.from(path).toString('hex'),
    'DSHC_PATH',
    'CONTENT_HEX<<DSHC_CONTENT',
    exists ? contentHex : '',
    'DSHC_CONTENT',
    ...(done ? ['SETTINGS_READ_DONE=yes'] : []),
  ];
  return `${lines.join('\n')}\n`;
}

function setLocalEnvironment(t, home, dshHome) {
  const previous = {
    HOME: process.env.HOME,
    DSH_HOME: process.env.DSH_HOME,
    DSHC_LOCAL_SH_BIN: process.env.DSHC_LOCAL_SH_BIN,
    DSHC_SSH_BIN: process.env.DSHC_SSH_BIN,
    DSHC_TEST_SETTINGS_RESULT: process.env.DSHC_TEST_SETTINGS_RESULT,
  };
  process.env.HOME = home;
  process.env.DSH_HOME = dshHome;
  delete process.env.DSHC_LOCAL_SH_BIN;
  delete process.env.DSHC_SSH_BIN;
  delete process.env.DSHC_TEST_SETTINGS_RESULT;
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    reopenSsh();
    _resetQueues();
  });
}

test('POSIX cksum 实现匹配标准向量', () => {
  assert.equal(posixCksum(Buffer.alloc(0)), 4_294_967_295);
  assert.equal(posixCksum(Buffer.from('123456789')), 930_766_865);
  assert.equal(posixCksum(Buffer.from('abc')), 1_219_131_554);
});

test('PUT 在执行前严格校验 content、surrogate、字节上限与 checksum', async () => {
  assert.equal(SETTINGS_MAX_BYTES, 512 * 1024);
  await assert.rejects(
    () => readDshSettings('local-validation'),
    (err) => err.code === 'VALIDATION' && /resolveLocal/u.test(err.message),
  );
  await assert.rejects(
    () => writeDshSettings('local-validation', { content: '', baseChecksum: null }),
    (err) => err.code === 'VALIDATION' && /resolveLocal/u.test(err.message),
  );

  for (const content of [undefined, null, 1, Buffer.from('x')]) {
    await assert.rejects(
      () => writeDshSettings('local-validation', { resolveLocal, content, baseChecksum: null }),
      (err) => err.code === 'VALIDATION' && /content/u.test(err.message),
    );
  }
  for (const content of ['\ud800', '\udc00', 'ok\ud800x', 'ok\udc00x']) {
    await assert.rejects(
      () => writeDshSettings('local-validation', { resolveLocal, content, baseChecksum: null }),
      (err) => err.code === 'VALIDATION' && /Unicode|surrogate/u.test(err.message),
    );
  }
  await assert.rejects(
    () => writeDshSettings('local-validation', {
      resolveLocal,
      content: 'a'.repeat(SETTINGS_MAX_BYTES + 1),
      baseChecksum: null,
    }),
    (err) => err.code === 'SETTINGS_TOO_LARGE' && err.httpStatus === 413,
  );

  for (const baseChecksum of [
    undefined,
    '',
    1,
    'cksum-v2:1:1',
    'cksum-v1:01:1',
    'cksum-v1:1:01',
    'cksum-v1:4294967296:1',
    'cksum-v1:1:524289',
  ]) {
    await assert.rejects(
      () => writeDshSettings('local-validation', { resolveLocal, content: '', baseChecksum }),
      (err) => err.code === 'VALIDATION' && /baseChecksum/u.test(err.message),
    );
  }
});

test('本机真实 POSIX 协议 roundtrip 保留全部 UTF-8 文本并执行 CAS', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'dshc-settings-module-'));
  const dshHome = join(home, 'dsh home');
  await mkdir(dshHome);
  t.after(() => rm(home, { recursive: true, force: true }));
  setLocalEnvironment(t, home, dshHome);
  _resetQueues();

  const missing = await readDshSettings('local-roundtrip', { resolveLocal });
  assert.deepEqual(missing, {
    exists: false,
    path: join(dshHome, 'settings.yaml'),
    content: '',
    checksum: null,
    size: 0,
  });

  const rich = '\ufeffname: 中文 😀\r\nliteral: "a\\0b"\r\nnul: \0\r\n';
  const created = await writeDshSettings('local-roundtrip', {
    resolveLocal,
    content: rich,
    baseChecksum: null,
  });
  assert.deepEqual(Object.keys(created).sort(), ['checksum', 'path', 'size', 'updated']);
  assert.equal(created.updated, true);
  assert.equal(created.path, join(dshHome, 'settings.yaml'));
  assert.equal(created.size, Buffer.byteLength(rich));
  assert.match(created.checksum, /^cksum-v1:\d+:\d+$/u);
  assert.equal(Object.hasOwn(created, 'content'), false, 'WRITE 不得回显敏感内容');

  const loaded = await readDshSettings('local-roundtrip', { resolveLocal });
  assert.equal(loaded.content, rich);
  assert.equal(loaded.checksum, created.checksum);
  assert.deepEqual(await readFile(join(dshHome, 'settings.yaml')), Buffer.from(rich));

  await assert.rejects(
    () => writeDshSettings('local-roundtrip', {
      resolveLocal,
      content: 'stale must not win',
      baseChecksum: null,
    }),
    (err) => err.code === 'SETTINGS_STALE' && err.httpStatus === 409,
  );
  assert.equal((await readDshSettings('local-roundtrip', { resolveLocal })).content, rich);

  const emptied = await writeDshSettings('local-roundtrip', {
    resolveLocal,
    content: '',
    baseChecksum: loaded.checksum,
  });
  assert.equal(emptied.size, 0);
  assert.equal((await readDshSettings('local-roundtrip', { resolveLocal })).content, '');

  const exact = 'x'.repeat(SETTINGS_MAX_BYTES);
  const exactWrite = await writeDshSettings('local-roundtrip', {
    resolveLocal,
    content: exact,
    baseChecksum: emptied.checksum,
  });
  assert.equal(exactWrite.size, SETTINGS_MAX_BYTES);
  const exactRead = await readDshSettings('local-roundtrip', { resolveLocal });
  assert.equal(exactRead.size, SETTINGS_MAX_BYTES);
  assert.equal(exactRead.content, exact);

  await writeFile(join(dshHome, 'settings.yaml'), Buffer.from([0xc3, 0x28]));
  await assert.rejects(
    () => readDshSettings('local-roundtrip', { resolveLocal }),
    (err) => err.code === 'SETTINGS_INVALID_UTF8' && err.httpStatus === 422,
  );
});

test('settings 复用 hostQueue 且每主机只允许一个占位，完成后恢复', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'dshc-settings-queue-'));
  const dshHome = join(home, '.dsh');
  await mkdir(dshHome);
  t.after(() => rm(home, { recursive: true, force: true }));
  setLocalEnvironment(t, home, dshHome);
  _resetQueues();

  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const lifecycle = hostQueue('same-host').run('lifecycle-test', async () => held);
  let settled = false;
  const content = 'x'.repeat(SETTINGS_MAX_BYTES);
  const settings = writeDshSettings('same-host', {
    resolveLocal,
    content,
    baseChecksum: null,
  }).finally(() => { settled = true; });

  await new Promise((resolve) => { setTimeout(resolve, 30); });
  assert.equal(settled, false, 'settings 必须排在既有生命周期锁后面');
  const busyStarted = performance.now();
  await assert.rejects(
    () => readDshSettings('same-host', { resolveLocal }),
    (err) => err.code === 'SETTINGS_BUSY' && err.httpStatus === 409,
  );
  assert.ok(performance.now() - busyStarted < 100, '第二个 settings 请求应立即失败，不能进入队列');
  release();
  await lifecycle;
  assert.equal((await settings).size, SETTINGS_MAX_BYTES);
  assert.equal((await readDshSettings('same-host', { resolveLocal })).size, SETTINGS_MAX_BYTES);
});

test('resolveLocal 在 hostQueue 队首读取最新运输类型', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'dshc-settings-resolver-'));
  const dshHome = join(home, '.dsh');
  await mkdir(dshHome);
  t.after(() => rm(home, { recursive: true, force: true }));
  setLocalEnvironment(t, home, dshHome);
  _resetQueues();

  const failSsh = join(home, 'fail-ssh.cjs');
  await writeFile(failSsh, 'process.stderr.write("must-not-use-stale-remote"); process.exit(255);\n');
  process.env.DSHC_SSH_BIN = `${process.execPath} ${failSsh}`;

  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const lifecycle = hostQueue('switch-host').run('lifecycle-test', async () => held);
  let local = false;
  let resolverCalls = 0;
  const pending = readDshSettings('switch-host', {
    resolveLocal: () => {
      resolverCalls += 1;
      return local;
    },
  });
  await new Promise((resolve) => { setTimeout(resolve, 20); });
  assert.equal(resolverCalls, 0, '排队时不得提前捕获运输类型');
  local = true;
  release();
  await lifecycle;
  assert.equal((await pending).exists, false);
  assert.equal(resolverCalls, 1);

  await assert.rejects(
    () => readDshSettings('deleted-host', {
      resolveLocal: () => { throw new DshError('NOT_FOUND', '主机已删除'); },
    }),
    (err) => err.code === 'NOT_FOUND',
  );
  assert.equal(
    (await readDshSettings('deleted-host', { resolveLocal })).exists,
    false,
    'resolver 失败后必须释放 settings 占位',
  );

  const never = new Promise(() => {});
  let resolverGuard;
  const asyncResolverResult = await Promise.race([
    readDshSettings('async-resolver-host', { resolveLocal: () => never })
      .then(() => null, (error) => error),
    new Promise((resolve) => { resolverGuard = setTimeout(() => resolve(null), 100); }),
  ]);
  clearTimeout(resolverGuard);
  assert.equal(asyncResolverResult?.code, 'VALIDATION', 'Promise resolver 必须同步拒绝，不能卡住队列');
  assert.equal(
    (await readDshSettings('async-resolver-host', { resolveLocal })).exists,
    false,
    '异步 resolver 被拒后必须释放 settings 占位',
  );

  const unhandled = [];
  const onUnhandled = (reason) => { unhandled.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  try {
    await assert.rejects(
      () => readDshSettings('rejecting-resolver-host', {
        resolveLocal: () => Promise.reject(new Error('resolver-rejection-secret')),
      }),
      (err) => err.code === 'VALIDATION'
        && !/resolver-rejection-secret/u.test(err.message)
        && err.detail === null,
    );
    await new Promise((resolve) => { setImmediate(resolve); });
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
  assert.deepEqual(unhandled, [], '被拒 Promise 必须被消费，不能触发 unhandledRejection');
  assert.equal(
    (await readDshSettings('rejecting-resolver-host', { resolveLocal })).exists,
    false,
    'rejecting resolver 被拒后也必须释放 settings 占位',
  );
});

test('READ parser 严查 framing、hex、size、CRC、UTF-8 与输出截断', () => {
  const valid = readFrame('abc');
  assert.deepEqual(_parseSettingsReadResult(execResult(valid), 'parser-host', 'read-test'), {
    exists: true,
    path: '/home/test/.dsh/settings.yaml',
    content: 'abc',
    checksum: 'cksum-v1:1219131554:3',
    size: 3,
  });

  const corrupt = [
    readFrame('abc', { contentHex: '61zz63' }),
    readFrame('abc', { contentHex: '6162' }),
    readFrame('abc', { size: 4 }),
    readFrame('abc', { crc: 1 }),
    readFrame('abc', { done: false }),
    `SETTINGS_PROTO=1\n${valid}`,
    valid.replace('SETTINGS_TXN=read-test\n', ''),
    valid.replace('SETTINGS_TXN=read-test', 'SETTINGS_TXN=wrong-txn'),
    valid.replace('SETTINGS_TXN=read-test\n', 'SETTINGS_TXN=read-test\nSETTINGS_TXN=read-test\n'),
  ];
  for (const stdout of corrupt) {
    assert.throws(
      () => _parseSettingsReadResult(execResult(stdout), 'parser-host', 'read-test'),
      (err) => {
        assert.equal(err.code, 'PROTO_PARSE');
        assert.equal(err.detail, null);
        assert.equal(err.cause, undefined);
        return true;
      },
    );
  }
  assert.throws(
    () => _parseSettingsReadResult(execResult(valid, { stdoutDropped: 12 }), 'parser-host', 'read-test'),
    (err) => err.code === 'PROTO_PARSE' && err.detail === null,
  );

  const invalidBytes = Buffer.from([0xc3, 0x28]);
  const invalidUtf8 = readFrame('', {
    size: invalidBytes.length,
    crc: posixCksum(invalidBytes),
    contentHex: invalidBytes.toString('hex'),
  });
  assert.throws(
    () => _parseSettingsReadResult(execResult(invalidUtf8), 'parser-host', 'read-test'),
    (err) => err.code === 'SETTINGS_INVALID_UTF8'
      && err.httpStatus === 422
      && err.detail === null
      && err.cause === undefined,
  );
});

test('协议错误与运输错误不泄漏 content、hex、stdin 或 cause', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'dshc-settings-errors-'));
  const dshHome = join(home, '.dsh');
  await mkdir(dshHome);
  t.after(() => rm(home, { recursive: true, force: true }));
  setLocalEnvironment(t, home, dshHome);
  const fake = join(home, 'settings-result.cjs');
  await writeFile(fake, `
const cases = {
  tooLarge: [10, 'SETTINGS_PROTO=1\\nSETTINGS_TXN={txn}\\nERR=settings-too-large\\n'],
  stale: [11, 'SETTINGS_PROTO=1\\nSETTINGS_TXN={txn}\\nERR=settings-stale\\nCOMMIT_STATE=not-committed\\n'],
  unknown: [12, 'SETTINGS_PROTO=1\\nSETTINGS_TXN={txn}\\nERR=settings-write\\nCOMMIT_STATE=unknown\\n'],
  unknownLarge: [10, 'SETTINGS_PROTO=1\\nSETTINGS_TXN={txn}\\nERR=settings-too-large\\nCOMMIT_STATE=unknown\\n'],
  staleUnknown: [11, 'SETTINGS_PROTO=1\\nSETTINGS_TXN={txn}\\nERR=settings-stale\\nCOMMIT_STATE=unknown\\n'],
  readFailed: [1, 'SETTINGS_PROTO=1\\nSETTINGS_TXN={txn}\\nERR=settings-read\\n'],
  unsupported: [1, 'SETTINGS_PROTO=1\\nSETTINGS_TXN={txn}\\nERR=settings-unsupported\\n'],
  noise: [7, 'SETTINGS_DEBUG=noise\\nERR=settings-read\\n', 'secret-from-noise'],
  wrongTxn: [12, 'SETTINGS_PROTO=1\\nSETTINGS_TXN=other-txn\\nERR=settings-write\\nCOMMIT_STATE=unknown\\n'],
  partialTransport: [255, 'SETTINGS_PROTO=1\\nSETTINGS_TXN={txn}\\nERR=settings-write\\n', 'partial-disconnect'],
  duplicateProto: [1, 'SETTINGS_PROTO=1\\nSETTINGS_PROTO=1\\nSETTINGS_TXN={txn}\\nERR=settings-read\\n'],
  duplicateTxn: [12, 'SETTINGS_PROTO=1\\nSETTINGS_TXN={txn}\\nSETTINGS_TXN={txn}\\nERR=settings-write\\nCOMMIT_STATE=unknown\\n'],
  writeTruncated: [0, 'SETTINGS_PROTO=1\\nSETTINGS_TXN={txn}\\nNEW_SIZE=12\\n'],
  writeBadCrc: [0, 'SETTINGS_PROTO=1\\nSETTINGS_TXN={txn}\\nPATH_HEX<<DSHC_PATH\\n2f746d702f73657474696e67732e79616d6c\\nDSHC_PATH\\nNEW_SIZE=12\\nNEW_CRC=0\\nSETTINGS_WRITE_DONE=yes\\n'],
  transport: [7, '', 'secret-from-stderr'],
};
const selected = cases[process.env.DSHC_TEST_SETTINGS_RESULT];
const txn = /T='([^']+)'/.exec(process.argv.at(-1))?.[1] || 'missing';
process.stdout.write(selected[1].replaceAll('{txn}', txn));
if (selected[2]) process.stderr.write(selected[2]);
process.exit(selected[0]);
`);
  process.env.DSHC_LOCAL_SH_BIN = `${process.execPath} ${fake}`;

  const cases = [
    ['tooLarge', () => readDshSettings('error-host', { resolveLocal }), 'SETTINGS_TOO_LARGE', 413],
    ['stale', () => writeDshSettings('error-host', {
      resolveLocal, content: 'stdin-secret', baseChecksum: null,
    }), 'SETTINGS_STALE', 409],
    ['unknown', () => writeDshSettings('error-host', {
      resolveLocal, content: 'stdin-secret', baseChecksum: null,
    }), 'SETTINGS_WRITE_FAILED', 500],
    ['unknownLarge', () => writeDshSettings('error-host', {
      resolveLocal, content: 'stdin-secret', baseChecksum: null,
    }), 'SETTINGS_WRITE_FAILED', 500],
    ['staleUnknown', () => writeDshSettings('error-host', {
      resolveLocal, content: 'stdin-secret', baseChecksum: null,
    }), 'SETTINGS_STALE', 409],
    ['readFailed', () => readDshSettings('error-host', { resolveLocal }), 'SETTINGS_READ_FAILED', 500],
    ['unsupported', () => readDshSettings('error-host', { resolveLocal }), 'SETTINGS_UNSUPPORTED', 501],
    ['noise', () => readDshSettings('error-host', { resolveLocal }), 'LOCAL_EXEC_FAILED', 500],
    ['wrongTxn', () => writeDshSettings('error-host', {
      resolveLocal, content: 'stdin-secret', baseChecksum: null,
    }), 'LOCAL_EXEC_FAILED', 500],
    ['partialTransport', () => writeDshSettings('error-host', {
      resolveLocal, content: 'stdin-secret', baseChecksum: null,
    }), 'LOCAL_EXEC_FAILED', 500],
    ['duplicateProto', () => readDshSettings('error-host', { resolveLocal }), 'PROTO_PARSE', 500],
    ['duplicateTxn', () => writeDshSettings('error-host', {
      resolveLocal, content: 'stdin-secret', baseChecksum: null,
    }), 'PROTO_PARSE', 500],
    ['writeTruncated', () => writeDshSettings('error-host', {
      resolveLocal, content: 'stdin-secret', baseChecksum: null,
    }), 'PROTO_PARSE', 500],
    ['writeBadCrc', () => writeDshSettings('error-host', {
      resolveLocal, content: 'stdin-secret', baseChecksum: null,
    }), 'PROTO_PARSE', 500],
    ['transport', () => writeDshSettings('error-host', {
      resolveLocal, content: 'stdin-secret', baseChecksum: null,
    }), 'LOCAL_EXEC_FAILED', 500],
  ];

  for (const [scenario, action, code, status] of cases) {
    process.env.DSHC_TEST_SETTINGS_RESULT = scenario;
    // eslint-disable-next-line no-await-in-loop -- 同一个假执行器逐个切换确定性故障场景
    await assert.rejects(action, (err) => {
      assert.equal(err.code, code);
      assert.equal(err.httpStatus, status);
      assert.equal(err.detail, null);
      const exposed = `${err.message}\n${err.detail ?? ''}\n${String(err.cause ?? '')}`;
      assert.doesNotMatch(exposed, /stdin-secret|secret-from-stderr|CONTENT_HEX|[0-9a-f]{32}/u);
      if (['unknown', 'unknownLarge', 'staleUnknown'].includes(scenario)) {
        assert.match(err.message, /重新 GET/u);
        assert.doesNotMatch(err.message, /未提交/u);
      }
      if (['wrongTxn', 'partialTransport', 'transport'].includes(scenario)) {
        assert.match(err.message, /结果未知.*重新 GET/u);
      }
      if (['duplicateTxn', 'writeTruncated', 'writeBadCrc'].includes(scenario)) {
        assert.equal(err.code, 'PROTO_PARSE');
        assert.match(err.message, /保存结果未知.*先重新 GET/u);
      }
      if (scenario === 'duplicateProto') {
        assert.match(err.message, /协议响应无效/u);
        assert.doesNotMatch(err.message, /保存结果未知/u);
      }
      return true;
    });
  }
  delete process.env.DSHC_TEST_SETTINGS_RESULT;

  shutdownSsh();
  await assert.rejects(
    () => writeDshSettings('aborted-write-host', {
      resolveLocal,
      content: 'stdin-secret',
      baseChecksum: null,
    }),
    (err) => err.code === 'LOCAL_TIMEOUT'
      && err.httpStatus === 504
      && /结果未知.*重新 GET/u.test(err.message)
      && err.detail === null
      && !/stdin-secret/u.test(err.message),
  );
  reopenSsh();

  const fakeSsh = join(home, 'partial-ssh.cjs');
  await writeFile(fakeSsh, `
const txn = /(?:read|write)-[0-9a-f-]{36}/.exec(process.argv.join(' '))?.[0] || 'missing';
process.stdout.write('SETTINGS_PROTO=1\\nSETTINGS_TXN=' + txn + '\\nERR=settings-write\\n');
process.stderr.write('ssh-secret');
process.exit(255);
`);
  process.env.DSHC_SSH_BIN = `${process.execPath} ${fakeSsh}`;
  await assert.rejects(
    () => writeDshSettings('ssh-partial-host', {
      resolveLocal: () => false,
      content: 'stdin-secret',
      baseChecksum: null,
    }),
    (err) => err.code === 'SSH_UNREACHABLE'
      && err.httpStatus === 502
      && /结果未知.*重新 GET/u.test(err.message)
      && err.detail === null
      && !/ssh-secret|stdin-secret/u.test(err.message),
  );
});

test('settings 错误码 HTTP 状态表完整', () => {
  assert.deepEqual(
    {
      SETTINGS_TOO_LARGE: ERROR_HTTP_STATUS.SETTINGS_TOO_LARGE,
      SETTINGS_BUSY: ERROR_HTTP_STATUS.SETTINGS_BUSY,
      SETTINGS_STALE: ERROR_HTTP_STATUS.SETTINGS_STALE,
      SETTINGS_WRITE_FAILED: ERROR_HTTP_STATUS.SETTINGS_WRITE_FAILED,
      SETTINGS_READ_FAILED: ERROR_HTTP_STATUS.SETTINGS_READ_FAILED,
      SETTINGS_UNSUPPORTED: ERROR_HTTP_STATUS.SETTINGS_UNSUPPORTED,
      SETTINGS_INVALID_UTF8: ERROR_HTTP_STATUS.SETTINGS_INVALID_UTF8,
    },
    {
      SETTINGS_TOO_LARGE: 413,
      SETTINGS_BUSY: 409,
      SETTINGS_STALE: 409,
      SETTINGS_WRITE_FAILED: 500,
      SETTINGS_READ_FAILED: 500,
      SETTINGS_UNSUPPORTED: 501,
      SETTINGS_INVALID_UTF8: 422,
    },
  );
});
