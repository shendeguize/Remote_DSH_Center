import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PRIMARY_HOST_PHASES,
  allowedHostActions,
  hostActionBlockReason,
  hostActionSlots,
  isHostActionAllowed,
  isHostEnabled,
  isManagedHost,
  isPrimaryHost,
  isPrimaryHostPhase,
  orderedHosts,
  primaryHosts,
} from '../../src/web/host-rules.js';

const managed = (phase, patch = {}) => ({
  name: `managed-${phase}`,
  phase,
  config: { enabled: true },
  web: { startedByUs: true },
  ...patch,
});

const manual = (phase, patch = {}) => ({
  name: `manual-${phase}`,
  phase,
  config: { enabled: true },
  web: { startedByUs: false },
  ...patch,
});

test('PRIMARY_HOST_PHASES 是五种主入口状态的不可变列表', () => {
  assert.deepEqual(
    PRIMARY_HOST_PHASES,
    ['ready', 'starting', 'running', 'degraded', 'crashed'],
  );
  assert.equal(Object.isFrozen(PRIMARY_HOST_PHASES), true);
  assert.throws(() => PRIMARY_HOST_PHASES.push('unknown'), TypeError);

  for (const phase of PRIMARY_HOST_PHASES) assert.equal(isPrimaryHostPhase(phase), true);
  for (const phase of ['unknown', 'unreachable', 'no_dsh', undefined, null]) {
    assert.equal(isPrimaryHostPhase(phase), false);
  }
});

test('isHostEnabled 优先读 config.enabled，兼容顶层 enabled，且只认 true', () => {
  assert.equal(isHostEnabled({ config: { enabled: true }, enabled: false }), true);
  assert.equal(isHostEnabled({ config: { enabled: false }, enabled: true }), false);
  assert.equal(isHostEnabled({ enabled: true }), true, '兼容 legacy 顶层 enabled');
  assert.equal(isHostEnabled({ config: {}, enabled: true }), true);

  for (const enabled of [false, 1, 'true', null, undefined]) {
    assert.equal(isHostEnabled({ config: { enabled } }), false, `不应把 ${String(enabled)} 当成 true`);
  }
  assert.equal(isHostEnabled(null), false);
});

test('isManagedHost 只认 web.startedByUs === true', () => {
  assert.equal(isManagedHost({ web: { startedByUs: true } }), true);
  for (const startedByUs of [false, 1, 'true', null, undefined]) {
    assert.equal(isManagedHost({ web: { startedByUs } }), false);
  }
  assert.equal(isManagedHost(null), false);
});

test('isPrimaryHost 同时要求启用和主入口状态', () => {
  assert.equal(isPrimaryHost(managed('ready')), true);
  assert.equal(isPrimaryHost(managed('running', { config: { enabled: false } })), false);
  assert.equal(isPrimaryHost(managed('unreachable')), false);
  assert.equal(isPrimaryHost(manual('crashed', { config: undefined, enabled: true })), true);
  assert.equal(isPrimaryHost(null), false);
  assert.equal(isPrimaryHost(managed('running', { orphaned: true })), false, 'orphaned 不得进入 Hub 主入口');
});

test('primaryHosts 为 Hub/Tab 提供同一份稳定 name 排序，且不改输入', () => {
  const equalNameFirst = managed('running', { name: 'gpu-a', marker: 'first' });
  const equalNameSecond = managed('degraded', { name: 'gpu-a', marker: 'second' });
  const source = [
    managed('crashed', { name: 'gpu-z' }),
    equalNameFirst,
    managed('ready', { name: 'disabled', config: { enabled: false } }),
    managed('unknown', { name: 'waiting' }),
    managed('starting', { name: 'gpu-b' }),
    equalNameSecond,
    manual('ready', { name: 'gpu-c', config: undefined, enabled: true }),
  ];
  const before = [...source];

  const forHub = primaryHosts(source);
  const forTab = primaryHosts(new Set(source));

  assert.deepEqual(forHub.map((host) => host.name), ['gpu-a', 'gpu-a', 'gpu-b', 'gpu-c', 'gpu-z']);
  assert.deepEqual(forTab, forHub);
  assert.deepEqual(
    forHub.filter((host) => host.name === 'gpu-a').map((host) => host.marker),
    ['first', 'second'],
    'localeCompare 相等时必须保持输入顺序',
  );
  assert.deepEqual(source, before);
  assert.equal(source[0].name, 'gpu-z', '排序不得原地修改调用方数组');
});

test('orderedHosts 按 hostOrder 排序，未排序主机按名字字母序排末尾且不改为输入', () => {
  const hosts = [
    managed('running', { name: 'gpu-b' }),
    managed('running', { name: 'gpu-a' }),
    managed('running', { name: 'gpu-c' }),
    managed('running', { name: 'gpu-z' }),
  ];
  const before = [...hosts];
  const ordered = orderedHosts(hosts, ['gpu-z', 'gpu-a']);
  assert.deepEqual(ordered.map((h) => h.name), ['gpu-z', 'gpu-a', 'gpu-b', 'gpu-c']);
  assert.deepEqual(hosts, before, '不得原地修改输入');
  // 空 order 退化为按名排序
  assert.deepEqual(orderedHosts(hosts).map((h) => h.name), ['gpu-a', 'gpu-b', 'gpu-c', 'gpu-z']);
  // 排名重复（order 里有重复名）时仍稳定
  assert.deepEqual(
    orderedHosts(hosts, ['gpu-a', 'gpu-a']).map((h) => h.name),
    ['gpu-a', 'gpu-b', 'gpu-c', 'gpu-z'],
  );
});

test('primaryHosts 应用顺序：拖拽后的主标签顺序即 hostOrder 在可见集里的投影', () => {
  const source = [
    managed('crashed', { name: 'gpu-z' }),
    managed('ready', { name: 'gpu-b' }),
    manual('running', { name: 'gpu-c' }),
    managed('starting', { name: 'gpu-a' }),
    managed('unknown', { name: 'waiting' }),
    managed('running', { name: 'disabled', config: { enabled: false } }),
  ];
  const ordered = primaryHosts(source, ['gpu-c', 'gpu-a', 'gpu-z']);
  assert.deepEqual(ordered.map((h) => h.name), ['gpu-c', 'gpu-a', 'gpu-z', 'gpu-b']);
});

const ACTION_MATRIX = [
  ['unknown', ['probe'], ['probe']],
  ['unreachable', ['probe'], ['probe']],
  ['no_dsh', ['probe'], ['probe']],
  ['ready', ['start', 'probe'], ['start', 'probe']],
  ['starting', ['open', 'probe'], ['open', 'probe']],
  ['running', ['open', 'restart', 'stop', 'probe'], ['open', 'probe']],
  ['degraded', ['open', 'reconnect', 'restart', 'stop', 'probe'], ['open', 'reconnect', 'probe']],
  ['crashed', ['open', 'restart', 'probe'], ['start', 'probe']],
];

test('allowedHostActions 覆盖八态 × managed/manual 生命周期矩阵', () => {
  for (const [phase, managedActions, manualActions] of ACTION_MATRIX) {
    assert.deepEqual(allowedHostActions(managed(phase)), managedActions, `${phase} managed`);
    assert.deepEqual(allowedHostActions(manual(phase)), manualActions, `${phase} manual`);
  }
});

test('stop/reconnect 入口与后端 phase 契约对齐', () => {
  assert.equal(isHostActionAllowed(managed('starting'), 'stop'), false, '后端 stop 不接受 starting');
  for (const phase of ['running', 'degraded']) {
    assert.equal(isHostActionAllowed(managed(phase), 'stop'), true, `后端 stop 接受受管 ${phase}`);
  }
  assert.equal(isHostActionAllowed(manual('degraded'), 'stop'), false, '后端 stop 仍要求 startedByUs');

  assert.equal(isHostActionAllowed(managed('degraded'), 'reconnect'), true);
  assert.equal(isHostActionAllowed(manual('degraded'), 'reconnect'), true, '后端 reconnect 不要求 startedByUs');
  assert.equal(
    isHostActionAllowed(manual('running'), 'reconnect'),
    false,
    '后端虽接受 running，但页面入口省略；竞态由 actions 判为已自行恢复',
  );
});

test('orphaned 远程主机只保留查看入口，隐藏所有远程动作', () => {
  const host = managed('running', { orphaned: true, local: false });
  assert.deepEqual(allowedHostActions(host), ['open']);
  for (const action of ['start', 'stop', 'restart', 'reconnect', 'probe']) {
    assert.equal(isHostActionAllowed(host, action), false, action);
  }
  assert.equal(isHostActionAllowed(host, 'open'), true);
});

test('allowedHostActions 返回不可变值，调用方不能污染后续结果', () => {
  const actions = allowedHostActions(managed('degraded'));
  assert.equal(Object.isFrozen(actions), true);
  assert.throws(() => actions.push('destroy'), TypeError);
  assert.deepEqual(
    allowedHostActions(managed('degraded')),
    ['open', 'reconnect', 'restart', 'stop', 'probe'],
  );
});

test('同一 phase 的受管/手动实例给出同一排按钮，差异只落在禁用与理由上', () => {
  for (const [phase] of ACTION_MATRIX) {
    assert.deepEqual(
      hostActionSlots(manual(phase)).map(({ action }) => action),
      hostActionSlots(managed(phase)).map(({ action }) => action),
      `${phase}：两行都写着同一个状态，按钮数量与顺序不能不一样`,
    );
  }

  const running = hostActionSlots(manual('running'));
  assert.deepEqual(running.map(({ action }) => action), ['open', 'restart', 'stop', 'probe']);
  assert.deepEqual(
    running.filter(({ enabled }) => !enabled).map(({ action }) => action),
    ['restart', 'stop'],
    '手动实例照旧不许被关停或重启（不误杀契约）',
  );
  for (const slot of running.filter(({ enabled }) => !enabled)) {
    assert.match(slot.reason, /非本工具拉起/, `${slot.action} 必须说明为什么按不动`);
  }
  for (const slot of running.filter(({ enabled }) => enabled)) {
    assert.equal(slot.reason, null, '可用动作不应挂禁用理由');
  }
});

test('槽位可用性与 allowedHostActions 逐项一致，理由覆盖每个禁用项', () => {
  for (const [phase] of ACTION_MATRIX) {
    for (const host of [managed(phase), manual(phase)]) {
      for (const { action, enabled, reason } of hostActionSlots(host)) {
        assert.equal(enabled, isHostActionAllowed(host, action), `${host.name} / ${action}`);
        assert.equal(
          typeof reason === 'string' && reason !== '',
          !enabled,
          `${host.name} / ${action} 的理由应仅在禁用时出现`,
        );
      }
    }
  }

  assert.match(hostActionBlockReason(managed('crashed'), 'start'), /重启/);
  assert.match(hostActionBlockReason(manual('crashed', { web: null }), 'open'), /拉起/);
  assert.equal(hostActionBlockReason(managed('running'), 'stop'), null);
});

test('orphaned 主机不摆一排按不动的按钮，只留查看入口', () => {
  const host = managed('running', { orphaned: true, local: false });
  assert.deepEqual(hostActionSlots(host).map(({ action }) => action), ['open']);
  assert.equal(hostActionSlots(host)[0].enabled, true);
  assert.match(hostActionBlockReason(host, 'stop'), /ssh config 已消失/);
});

test('isHostActionAllowed 与动作矩阵使用同一规则', () => {
  const universe = ['start', 'open', 'reconnect', 'restart', 'stop', 'probe', 'destroy'];
  for (const [phase, managedActions, manualActions] of ACTION_MATRIX) {
    for (const [host, expected] of [
      [managed(phase), managedActions],
      [manual(phase), manualActions],
    ]) {
      for (const action of universe) {
        assert.equal(
          isHostActionAllowed(host, action),
          expected.includes(action),
          `${host.name} / ${action}`,
        );
      }
    }
  }
  assert.equal(isHostActionAllowed(null, 'probe'), true);
  assert.equal(isHostActionAllowed(null, undefined), false);
});
