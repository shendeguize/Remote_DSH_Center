import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyConfigSync,
  createConfigSyncPreview,
  planConfigSync,
  requireConfigSyncPreview,
  SYNC_PROFILE_FIELDS,
  syncProfileOf,
} from '../src/config-sync.js';
import { DshError } from '../src/lib/errors.js';

const inject = (env = {}, extraArgs = [], patches = []) => ({ env, extraArgs, patches });

const host = ({
  local = false,
  enabled = true,
  autoStart = false,
  localPort = null,
  remoteWebPort = null,
  workdir = null,
  inject: injection = inject(),
  ...noise
} = {}) => ({
  local,
  enabled,
  autoStart,
  localPort,
  remoteWebPort,
  workdir,
  inject: injection,
  ...noise,
});

const configOf = (hosts) => ({
  configVersion: 1,
  manager: { port: 7788 },
  defaults: { remoteWebPort: 8899, localPortRange: [17701, 17799] },
  hosts,
});

const RESERVED_HOST_NAMES = ['toString', 'constructor', '__proto__'];

function assertDshError(code, messagePattern) {
  return (err) => {
    assert.ok(err instanceof DshError);
    assert.equal(err.code, code);
    assert.match(err.message, messagePattern);
    return true;
  };
}

test('同步字段清单固定为五个响应路径', () => {
  assert.deepEqual(SYNC_PROFILE_FIELDS, [
    'remoteWebPort',
    'workdir',
    'inject.env',
    'inject.extraArgs',
    'inject.patches',
  ]);
  assert.equal(Object.isFrozen(SYNC_PROFILE_FIELDS), true);
});

test('syncProfileOf 只取固定 profile，并与主机配置深度隔离', () => {
  const source = host({
    local: true,
    enabled: false,
    autoStart: true,
    localPort: 17701,
    remoteWebPort: 9010,
    workdir: '/srv/source',
    inject: inject({ TOKEN: 'source' }, ['--verbose'], ['fix.patch']),
    name: 'source-name',
    phase: 'running',
    web: { pid: 42, workdir: '/runtime' },
    tunnel: { localPort: 17701 },
  });

  const profile = syncProfileOf(source);

  assert.deepEqual(profile, {
    remoteWebPort: 9010,
    workdir: '/srv/source',
    inject: {
      env: { TOKEN: 'source' },
      extraArgs: ['--verbose'],
      patches: ['fix.patch'],
    },
  });
  assert.deepEqual(Object.keys(profile), ['remoteWebPort', 'workdir', 'inject']);
  assert.notEqual(profile.inject, source.inject);
  assert.notEqual(profile.inject.env, source.inject.env);
  assert.notEqual(profile.inject.extraArgs, source.inject.extraArgs);
  assert.notEqual(profile.inject.patches, source.inject.patches);

  profile.inject.env.TOKEN = 'changed';
  profile.inject.extraArgs.push('--other');
  profile.inject.patches.push('other.patch');
  assert.deepEqual(source.inject, inject({ TOKEN: 'source' }, ['--verbose'], ['fix.patch']));
});

test('preview token 对目标/对象键顺序稳定，绑定全部同步 profile 且不泄漏 secret', () => {
  const secret = 'TOP-SECRET-PREVIEW-VALUE';
  const config = configOf({
    source: host({
      remoteWebPort: 9010,
      workdir: '/source',
      inject: inject({ ZED: 'last', TOKEN: secret, ALPHA: 'first' }, ['--source'], ['source.patch']),
    }),
    a: host({
      remoteWebPort: 9020,
      workdir: '/a',
      inject: inject({ OLD: 'a' }, ['--a'], ['a.patch']),
    }),
    b: host({
      remoteWebPort: 9030,
      workdir: '/b',
      inject: inject({ OLD: 'b' }, ['--b'], ['b.patch']),
    }),
  });
  const request = { source: 'source', targets: ['b', 'a'] };
  const preview = createConfigSyncPreview(config, request);

  assert.match(preview.previewToken, /^v1\.[A-Za-z0-9_-]{43}$/);
  assert.doesNotMatch(preview.previewToken, new RegExp(secret));
  assert.deepEqual(preview.plan.targets.map(({ name }) => name), ['b', 'a']);

  const reordered = structuredClone(config);
  reordered.hosts.source.inject.env = {
    ALPHA: 'first',
    TOKEN: secret,
    ZED: 'last',
  };
  const reorderedPreview = createConfigSyncPreview(reordered, {
    source: 'source',
    targets: ['a', 'b'],
  });
  assert.equal(reorderedPreview.previewToken, preview.previewToken, '集合与对象键顺序不应改变 token');

  reordered.hosts.source.enabled = false;
  reordered.hosts.a.autoStart = true;
  assert.equal(
    createConfigSyncPreview(reordered, request).previewToken,
    preview.previewToken,
    '同步范围外字段不应让 preview 过期',
  );

  for (const [label, mutate] of [
    ['source', (draft) => { draft.hosts.source.inject.env.TOKEN = 'changed-source'; }],
    ['target-a', (draft) => { draft.hosts.a.workdir = '/changed-target'; }],
    ['target-b', (draft) => { draft.hosts.b.inject.extraArgs.push('--changed-target'); }],
  ]) {
    const changed = structuredClone(config);
    mutate(changed);
    assert.notEqual(
      createConfigSyncPreview(changed, request).previewToken,
      preview.previewToken,
      `${label} 的同步 profile 变化必须改变 token`,
    );
    assert.throws(
      () => requireConfigSyncPreview(changed, request, preview.previewToken),
      assertDshError('CONFIG_STALE', /重新预览|预览.*过期/),
    );
  }

  assert.deepEqual(
    requireConfigSyncPreview(config, { source: 'source', targets: ['a', 'b'] }, preview.previewToken)
      .targets.map(({ name }) => name),
    ['a', 'b'],
  );
});

test('plan 按目标输入顺序产出五路径粒度差异，且完全不改输入', () => {
  const source = host({
    remoteWebPort: 9010,
    workdir: '/srv/source',
    inject: inject({ TOKEN: 'source' }, ['--verbose'], ['fix.patch']),
    phase: 'running',
    web: { pid: 10 },
  });
  const config = configOf({
    source,
    'target-all': host({
      local: true,
      localPort: null,
      remoteWebPort: 9020,
      workdir: '/srv/target',
      inject: inject({ TOKEN: 'target' }, ['--quiet'], ['old.patch']),
      phase: 'stopped',
      tunnel: { localPort: null },
    }),
    'target-env': host({
      remoteWebPort: 9010,
      workdir: '/srv/source',
      inject: inject({ TOKEN: 'target' }, ['--verbose'], ['fix.patch']),
      phase: 'crashed',
      web: { pid: 99 },
    }),
  });
  const before = structuredClone(config);

  const plan = planConfigSync(config, {
    source: 'source',
    targets: ['target-env', 'target-all'],
  });

  assert.equal(plan.source, 'source');
  assert.deepEqual(plan.profile, syncProfileOf(source));
  assert.notEqual(plan.profile.inject, source.inject);
  assert.deepEqual(plan.targets, [
    { name: 'target-env', changed: true, changedFields: ['inject.env'] },
    { name: 'target-all', changed: true, changedFields: [...SYNC_PROFILE_FIELDS] },
  ]);
  assert.deepEqual(config, before);
});

test('local 与 remote 主机使用同一 profile；排除字段和运行态噪声不造成 changed', () => {
  const sharedProfile = {
    remoteWebPort: 9010,
    workdir: '/srv/shared',
    inject: inject({ A: '1' }, ['--x'], ['same.patch']),
  };
  const config = configOf({
    local: host({
      local: true,
      enabled: false,
      autoStart: true,
      localPort: null,
      ...sharedProfile,
      phase: 'running',
      web: { pid: 1 },
    }),
    remote: host({
      local: false,
      enabled: true,
      autoStart: false,
      localPort: 17777,
      ...sharedProfile,
      phase: 'crashed',
      tunnel: { connected: false },
    }),
  });

  assert.deepEqual(planConfigSync(config, {
    source: 'local',
    targets: ['remote'],
  }).targets, [
    { name: 'remote', changed: false, changedFields: [] },
  ]);
  assert.deepEqual(planConfigSync(config, {
    source: 'remote',
    targets: ['local'],
  }).targets, [
    { name: 'local', changed: false, changedFields: [] },
  ]);
});

test('plan 拒绝空目标、重复目标和源主机混入目标', () => {
  const config = configOf({
    source: host(),
    target: host(),
  });

  assert.throws(
    () => planConfigSync(config, { source: 'source', targets: [] }),
    assertDshError('VALIDATION', /目标|至少/),
  );
  assert.throws(
    () => planConfigSync(config, { source: 'source', targets: ['target', 'target'] }),
    assertDshError('VALIDATION', /目标|重复/),
  );
  assert.throws(
    () => planConfigSync(config, { source: 'source', targets: ['source'] }),
    assertDshError('VALIDATION', /源主机|目标/),
  );
});

test('plan 对缺少参数和不存在的源/目标给出人话 DshError', () => {
  const config = configOf({
    source: host(),
    target: host(),
  });

  assert.throws(
    () => planConfigSync(config, { targets: ['target'] }),
    assertDshError('VALIDATION', /源主机|不能为空/),
  );
  assert.throws(
    () => planConfigSync(config, { source: 'source' }),
    assertDshError('VALIDATION', /目标|至少/),
  );
  assert.throws(
    () => planConfigSync(config, { source: 'missing', targets: ['target'] }),
    assertDshError('NOT_FOUND', /源主机.*missing|missing.*源主机/),
  );
  assert.throws(
    () => planConfigSync(config, { source: 'source', targets: ['missing'] }),
    assertDshError('NOT_FOUND', /目标主机.*missing|missing.*目标主机/),
  );
  for (const hosts of [null, 'not-an-object', () => ({})]) {
    assert.throws(
      () => planConfigSync(configOf(hosts), { source: 'source', targets: ['target'] }),
      assertDshError('NOT_FOUND', /源主机.*source|source.*源主机/),
    );
  }
});

test('plan 将继承的保留名视为不存在，并保持输入与 Object.prototype 不变', () => {
  const prototypeBefore = Object.getOwnPropertyDescriptors(Object.prototype);

  for (const name of RESERVED_HOST_NAMES) {
    const config = configOf({
      source: host({ remoteWebPort: 9001 }),
      target: host({ remoteWebPort: 9002 }),
    });
    const before = JSON.stringify(config);

    assert.throws(
      () => planConfigSync(config, { source: name, targets: ['target'] }),
      assertDshError('NOT_FOUND', new RegExp(`源主机.*${name}|${name}.*源主机`)),
    );
    assert.throws(
      () => planConfigSync(config, { source: 'source', targets: ['target', name] }),
      assertDshError('NOT_FOUND', new RegExp(`目标主机.*${name}|${name}.*目标主机`)),
    );
    assert.equal(JSON.stringify(config), before);
  }

  assert.deepEqual(Object.getOwnPropertyDescriptors(Object.prototype), prototypeBefore);
});

test('apply 在非 own 源或目标出现时整单失败，不留下部分修改', () => {
  const prototypeBefore = Object.getOwnPropertyDescriptors(Object.prototype);

  for (const name of RESERVED_HOST_NAMES) {
    const source = host({
      remoteWebPort: 9001,
      workdir: '/source',
      inject: inject({ SOURCE: 'yes' }),
    });
    const config = configOf({
      source,
      target: host({
        remoteWebPort: 9002,
        workdir: '/target',
        inject: inject({ TARGET: 'yes' }),
      }),
    });
    const profile = syncProfileOf(source);

    for (const plan of [
      {
        source: name,
        profile,
        targets: [{ name: 'target', changed: true, changedFields: [...SYNC_PROFILE_FIELDS] }],
      },
      {
        source: 'source',
        profile,
        targets: [
          { name: 'target', changed: true, changedFields: [...SYNC_PROFILE_FIELDS] },
          { name, changed: true, changedFields: [...SYNC_PROFILE_FIELDS] },
        ],
      },
    ]) {
      const draft = structuredClone(config);
      const before = JSON.stringify(draft);
      const role = plan.source === name ? '源主机' : '目标主机';

      assert.throws(
        () => applyConfigSync(draft, plan),
        assertDshError('NOT_FOUND', new RegExp(`${role}.*${name}|${name}.*${role}`)),
      );
      assert.equal(JSON.stringify(draft), before);
    }
  }

  assert.deepEqual(Object.getOwnPropertyDescriptors(Object.prototype), prototypeBefore);
});

test('own 保留名仍可作为源和目标 plan/apply，且不污染原型', () => {
  const prototypeBefore = Object.getOwnPropertyDescriptors(Object.prototype);

  for (let index = 0; index < RESERVED_HOST_NAMES.length; index += 1) {
    const sourceName = RESERVED_HOST_NAMES[index];
    const targetName = RESERVED_HOST_NAMES[(index + 1) % RESERVED_HOST_NAMES.length];
    const hosts = JSON.parse('{"toString":null,"constructor":null,"__proto__":null}');
    Object.defineProperty(hosts, sourceName, {
      configurable: true,
      enumerable: true,
      value: host({
        remoteWebPort: 9001,
        workdir: '/source',
        inject: inject({ SOURCE: sourceName }, ['--source'], ['source.patch']),
      }),
      writable: true,
    });
    Object.defineProperty(hosts, targetName, {
      configurable: true,
      enumerable: true,
      value: host({
        remoteWebPort: 9002,
        workdir: '/target',
        inject: inject({ TARGET: targetName }),
      }),
      writable: true,
    });
    const config = configOf(hosts);
    const before = JSON.stringify(config);
    const plan = planConfigSync(config, { source: sourceName, targets: [targetName] });
    const draft = structuredClone(config);

    assert.equal(Object.hasOwn(config.hosts, sourceName), true);
    assert.equal(Object.hasOwn(config.hosts, targetName), true);
    assert.deepEqual(plan.targets, [{
      name: targetName,
      changed: true,
      changedFields: [...SYNC_PROFILE_FIELDS],
    }]);
    assert.deepEqual(applyConfigSync(draft, plan), [targetName]);
    assert.deepEqual(syncProfileOf(draft.hosts[targetName]), syncProfileOf(config.hosts[sourceName]));
    assert.equal(JSON.stringify(config), before, 'plan/apply 不得修改输入 config');
  }

  assert.deepEqual(Object.getOwnPropertyDescriptors(Object.prototype), prototypeBefore);
});

test('apply 只改 changed target 的 profile，并保持所有排除字段不动', () => {
  const config = configOf({
    source: host({
      remoteWebPort: null,
      workdir: null,
      inject: inject({ SOURCE: 'yes' }, ['--source'], ['source.patch']),
    }),
    changed: host({
      local: true,
      enabled: false,
      autoStart: true,
      localPort: null,
      remoteWebPort: 9555,
      workdir: '/old',
      inject: inject({ OLD: 'yes' }, ['--old'], ['old.patch']),
      name: 'display-name',
      phase: 'running',
      web: { pid: 7, workdir: '/active' },
      tunnel: { localPort: 17701, connected: true },
    }),
    unchanged: host({
      remoteWebPort: null,
      workdir: null,
      inject: inject({ SOURCE: 'yes' }, ['--source'], ['source.patch']),
      phase: 'crashed',
    }),
  });
  const plan = planConfigSync(config, {
    source: 'source',
    targets: ['unchanged', 'changed'],
  });
  const draft = structuredClone(config);
  const changedBefore = structuredClone(draft.hosts.changed);
  const unchangedRef = draft.hosts.unchanged;
  const webRef = draft.hosts.changed.web;
  const tunnelRef = draft.hosts.changed.tunnel;

  assert.deepEqual(applyConfigSync(draft, plan), ['changed']);
  assert.equal(draft.hosts.changed.remoteWebPort, null, 'null 会清除远端端口 override');
  assert.equal(draft.hosts.changed.workdir, null, 'null 会清除 workdir override');
  assert.deepEqual(draft.hosts.changed.inject, config.hosts.source.inject);
  for (const field of ['name', 'local', 'enabled', 'autoStart', 'localPort', 'phase']) {
    assert.deepEqual(draft.hosts.changed[field], changedBefore[field], `${field} 不得被同步`);
  }
  assert.equal(draft.hosts.changed.web, webRef);
  assert.equal(draft.hosts.changed.tunnel, tunnelRef);
  assert.equal(draft.hosts.unchanged, unchangedRef, 'unchanged target 连对象本身也不碰');
});

test('apply 为每个目标独立深拷贝 inject，不共享源、plan 或其他目标引用', () => {
  const config = configOf({
    source: host({
      remoteWebPort: 9001,
      workdir: '/source',
      inject: inject({ TOKEN: 'secret' }, ['--arg'], ['one.patch']),
    }),
    a: host({ inject: inject({ A: 'a' }) }),
    b: host({ inject: inject({ B: 'b' }) }),
  });
  const plan = planConfigSync(config, { source: 'source', targets: ['a', 'b'] });
  const draft = structuredClone(config);

  assert.deepEqual(applyConfigSync(draft, plan), ['a', 'b']);
  for (const key of ['inject']) assert.notEqual(draft.hosts.a[key], draft.hosts.b[key]);
  for (const key of ['env', 'extraArgs', 'patches']) {
    assert.notEqual(draft.hosts.a.inject[key], draft.hosts.b.inject[key]);
    assert.notEqual(draft.hosts.a.inject[key], plan.profile.inject[key]);
    assert.notEqual(draft.hosts.a.inject[key], config.hosts.source.inject[key]);
  }

  draft.hosts.a.inject.env.TOKEN = 'changed';
  draft.hosts.a.inject.extraArgs.push('--changed');
  draft.hosts.a.inject.patches.push('changed.patch');
  assert.deepEqual(draft.hosts.b.inject, inject({ TOKEN: 'secret' }, ['--arg'], ['one.patch']));
  assert.deepEqual(plan.profile.inject, inject({ TOKEN: 'secret' }, ['--arg'], ['one.patch']));
  assert.deepEqual(config.hosts.source.inject, inject({ TOKEN: 'secret' }, ['--arg'], ['one.patch']));
});
