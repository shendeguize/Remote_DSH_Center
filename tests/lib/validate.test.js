import test from 'node:test';
import assert from 'node:assert/strict';

import {
  V,
  validate,
  assertValid,
  configSchema,
  stateSchema,
  setupBodySchema,
  hostConfigPatchSchema,
  defaultsPatchSchema,
} from '../../src/lib/validate.js';
import { newFactoryConfig, newHostConfig } from '../../src/defaults.js';

const goodConfig = () => ({
  configVersion: 1,
  setupCompleted: true,
  manager: { port: 7788 },
  defaults: { remoteWebPort: 8899, localPortRange: [17701, 17799] },
  hosts: {
    'gpu-1': {
      enabled: true,
      autoStart: false,
      localPort: 17701,
      remoteWebPort: null,
      inject: { env: { GREETING: 'hi' }, extraArgs: ['--verbose'], patches: ['/tmp/a.yml'] },
    },
  },
});

test('组合子：错误路径字符串格式', () => {
  const schema = V.obj({ a: V.obj({ b: V.int({ min: 1, max: 10 }) }) });
  const r = validate(schema, { a: { b: 99 } });
  assert.equal(r.ok, false);
  assert.deepEqual(r.errors, ['a.b: expected int 1..10']);

  const r2 = validate(V.obj({ x: V.arr(V.str()) }), { x: ['ok', 5] });
  assert.deepEqual(r2.errors, ['x[1]: expected string, got number']);
});

test('组合子：required / unknown key / nullable / enum', () => {
  assert.deepEqual(validate(V.obj({ a: V.str() }), {}).errors, ['a: required']);
  assert.deepEqual(validate(V.obj({ a: V.str() }), { a: 'x', b: 1 }).errors, ['b: unknown key']);
  assert.equal(validate(V.nullable(V.int()), null).ok, true);
  assert.equal(validate(V.obj({}, { extra: true }), { anything: 1 }).ok, true);
  assert.deepEqual(validate(V.enum_(['a', 'b']), 'c').errors, ['<root>: expected one of a|b, got "c"']);
});

test('configSchema 接受出厂 config 与完整 config', () => {
  assert.equal(validate(configSchema, newFactoryConfig()).ok, true);
  assert.equal(validate(configSchema, goodConfig()).ok, true);

  const withHost = newFactoryConfig();
  withHost.hosts['gpu-1'] = newHostConfig();
  assert.equal(validate(configSchema, withHost).ok, true);
});

test('configSchema：local 缺省兼容旧配置，true/false 均接受且类型严格', () => {
  const legacy = goodConfig();
  assert.equal('local' in legacy.hosts['gpu-1'], false);
  assert.equal(validate(configSchema, legacy).ok, true);
  assert.equal(newHostConfig().local, false);

  for (const local of [false, true]) {
    const config = goodConfig();
    config.hosts['gpu-1'].local = local;
    config.hosts['gpu-1'].localPort = null;
    assert.equal(validate(configSchema, config).ok, true, `应接受 local:${local}`);
  }

  const invalid = goodConfig();
  invalid.hosts['gpu-1'].local = 'true';
  assert.match(validate(configSchema, invalid).errors.join(), /expected boolean/);
});

test('configSchema/setupBodySchema：本机最多一个且 localPort 必须为 null', () => {
  const badPort = goodConfig();
  badPort.hosts['gpu-1'].local = true;
  assert.match(validate(configSchema, badPort).errors.join(), /localPort.*null/);
  assert.match(validate(setupBodySchema, badPort).errors.join(), /localPort.*null/);

  const duplicate = goodConfig();
  duplicate.hosts['gpu-1'].local = true;
  duplicate.hosts['gpu-1'].localPort = null;
  duplicate.hosts.localhost = { ...newHostConfig(), local: true };
  assert.match(validate(configSchema, duplicate).errors.join(), /最多.*一个.*local:true/);
  assert.match(validate(setupBodySchema, duplicate).errors.join(), /最多.*一个.*local:true/);
});

test('configSchema：localPortRange 必须 lo<=hi 且在 1024..65535', () => {
  const c = goodConfig();
  c.defaults.localPortRange = [17799, 17701];
  assert.match(validate(configSchema, c).errors.join(), /range start must be <= end/);

  const c2 = goodConfig();
  c2.defaults.localPortRange = [80, 17799];
  assert.match(validate(configSchema, c2).errors.join(), /expected int 1024/);

  const c3 = goodConfig();
  c3.defaults.localPortRange = [17701];
  assert.match(validate(configSchema, c3).errors.join(), /expected tuple of 2/);
});

test('configSchema：inject.env 键白名单（与 12 §2.3 双层一致）', () => {
  const c = goodConfig();
  c.hosts['gpu-1'].inject.env = { '1BAD': 'v' };
  assert.match(validate(configSchema, c).errors.join(), /invalid key/);

  const c2 = goodConfig();
  c2.hosts['gpu-1'].inject.env = { GOOD_1: '' };
  assert.equal(validate(configSchema, c2).ok, true, '空值合法');
});

test('configSchema：端口越界、类型错、未知键全部报错', () => {
  const c = goodConfig();
  c.manager.port = 70000;
  assert.equal(validate(configSchema, c).ok, false);

  const c2 = goodConfig();
  c2.hosts['gpu-1'].localPort = '17701';
  assert.match(validate(configSchema, c2).errors.join(), /expected int/);

  const c3 = goodConfig();
  c3.hosts['gpu-1'].bogus = 1;
  assert.match(validate(configSchema, c3).errors.join(), /unknown key/);
});

test('configSchema：workdir 可缺省（旧 config 兼容），给了就必须是绝对路径或 ~ 形态', () => {
  const c = goodConfig();
  assert.equal(validate(configSchema, c).ok, true, '缺 workdir 键不该拦启动');

  for (const good of [null, '/root/proj', '~', '~/proj']) {
    const ok = goodConfig();
    ok.hosts['gpu-1'].workdir = good;
    assert.equal(validate(configSchema, ok).ok, true, `应通过：${JSON.stringify(good)}`);
  }
  for (const bad of ['', 'proj', '../up', '~user/x', 42]) {
    const no = goodConfig();
    no.hosts['gpu-1'].workdir = bad;
    assert.match(validate(configSchema, no).errors.join(), /绝对路径/, `应拒绝：${JSON.stringify(bad)}`);
  }
});

test('stateSchema 宽松模式：允许 12 §4.4 的增补字段', () => {
  const state = {
    hosts: {
      'gpu-1': {
        phase: 'running',
        probe: { dshPath: '/usr/bin/dsh' },
        web: { pid: 1, port: 8899, log: 'web-8899.log' },
        tunnel: { localPort: 17701 },
        patchSync: { files: {} },
        manualInstances: [{ pid: 2, args: 'dsh web' }],
        futureField: 'ok',
      },
    },
    schemaExtra: true,
  };
  assert.equal(validate(stateSchema, state).ok, true);
});

test('stateSchema 拒绝非法 phase', () => {
  const r = validate(stateSchema, { hosts: { a: { phase: 'bogus' } } });
  assert.match(r.errors.join(), /expected one of/);
});

test('setupBodySchema：configVersion/setupCompleted 可缺省', () => {
  const body = goodConfig();
  delete body.configVersion;
  delete body.setupCompleted;
  assert.equal(validate(setupBodySchema, body).ok, true);
});

test('hostConfigPatchSchema：local 只校验类型，localPort 明令拒收', () => {
  assert.equal(validate(hostConfigPatchSchema, {}).ok, true);
  assert.equal(validate(hostConfigPatchSchema, { autoStart: true }).ok, true);
  assert.equal(validate(hostConfigPatchSchema, { local: true }).ok, true);
  assert.equal(validate(hostConfigPatchSchema, { local: false }).ok, true);
  assert.match(validate(hostConfigPatchSchema, { local: 1 }).errors.join(), /expected boolean/);
  assert.match(validate(hostConfigPatchSchema, { localPort: 17701 }).errors.join(), /unknown key/);
  assert.equal(validate(hostConfigPatchSchema, { workdir: '~/proj' }).ok, true);
  assert.equal(validate(hostConfigPatchSchema, { workdir: null }).ok, true);
  assert.match(validate(hostConfigPatchSchema, { workdir: 'proj' }).errors.join(), /绝对路径/);
  assert.equal(
    validate(hostConfigPatchSchema, { inject: { env: {}, extraArgs: [], patches: [] } }).ok,
    true,
  );
  assert.match(
    validate(hostConfigPatchSchema, { inject: { env: {} } }).errors.join(),
    /extraArgs: required/,
    'inject 给出时其三个子键全量替换，必须齐全',
  );
});

test('defaultsPatchSchema 局部体', () => {
  assert.equal(validate(defaultsPatchSchema, { remoteWebPort: 9000 }).ok, true);
  assert.equal(validate(defaultsPatchSchema, { manager: { port: 7788 } }).ok, true);
  assert.match(validate(defaultsPatchSchema, { localPortRange: [2, 3] }).errors.join(), /expected int 1024/);
});

test('assertValid 抛 VALIDATION，detail 为逐条错误路径', () => {
  assert.throws(
    () => assertValid(configSchema, { configVersion: 1 }, '配置校验失败'),
    (err) => {
      assert.equal(err.code, 'VALIDATION');
      assert.equal(err.message, '配置校验失败');
      assert.match(err.detail, /setupCompleted: required/);
      assert.match(err.detail, /manager: required/);
      return true;
    },
  );
  assert.doesNotThrow(() => assertValid(configSchema, goodConfig(), 'x'));
});
