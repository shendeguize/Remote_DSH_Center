import assert from 'node:assert/strict';
import test from 'node:test';

import {
  HOST_GROUPS,
  groupHostViews,
  hostGroupId,
  sortHostViews,
} from '../../src/web/components/host-table.js';

const host = (name, phase, patch = {}) => ({
  name,
  phase,
  local: false,
  orphaned: false,
  config: { enabled: true },
  probe: { dshPath: `/bin/${name}` },
  web: null,
  ...patch,
});

test('host table 固定五组并按 enabled/orphaned/phase 优先级分类', () => {
  assert.deepEqual(HOST_GROUPS.map(({ id }) => id), [
    'started', 'ready', 'missing-config', 'unreachable', 'unmanaged',
  ]);
  assert.equal(hostGroupId(host('running', 'running')), 'started');
  assert.equal(hostGroupId(host('reconnect', 'reconnect')), 'started');
  assert.equal(hostGroupId(host('abnormal', 'abnormal')), 'started');
  assert.equal(hostGroupId(host('ready', 'ready')), 'ready');
  assert.equal(hostGroupId(host('missing', 'no_dsh')), 'missing-config');
  assert.equal(hostGroupId(host('missing-config', 'missing-config')), 'missing-config');
  assert.equal(hostGroupId(host('unknown', 'unknown')), 'unreachable');
  assert.equal(hostGroupId(host('orphan', 'ready', { orphaned: true })), 'unreachable');
  assert.equal(hostGroupId(host('disabled', 'running', { config: { enabled: false } })), 'unmanaged');
  assert.deepEqual(Object.keys(groupHostViews([
    host('r', 'running'),
    host('u', 'unknown'),
    host('d', 'ready', { config: { enabled: false } }),
  ])), ['started', 'ready', 'missing-config', 'unreachable', 'unmanaged']);
});

test('host table 在组内支持 name/status/dsh/PID 排序，缺失 PID 排在末尾', () => {
  const hosts = [
    host('z', 'running', { web: { pid: 20 } }),
    host('a', 'running', { web: { pid: 10 }, probe: { dshPath: '/opt/dsh' } }),
    host('m', 'running', { web: null, probe: { dshPath: '/bin/dsh' } }),
  ];
  assert.deepEqual(sortHostViews(hosts).map(({ name }) => name), ['a', 'm', 'z']);
  assert.deepEqual(sortHostViews(hosts, 'pid').map(({ name }) => name), ['a', 'z', 'm']);
  assert.deepEqual(sortHostViews(hosts, 'dsh').map(({ name }) => name), ['m', 'z', 'a']);
  assert.deepEqual(sortHostViews(hosts, 'name', 'desc').map(({ name }) => name), ['z', 'm', 'a']);
});
