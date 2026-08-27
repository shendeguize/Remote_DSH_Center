/**
 * DSH Center → Agent Sidecar consumer contract (C1–C4).
 *
 * This deliberately tests the small inventory surface Sidecar consumes rather
 * than coupling the two repositories through a shared package.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { resolvePaths } from '../../src/defaults.js';
import { PHASES } from '../../src/lib/machine.js';
import { assertShape, hostView } from './schemas.js';

const FIXTURE_URL = new URL('./fixtures/ls-json.v1.json', import.meta.url);
const LS_FIXTURE = JSON.parse(readFileSync(FIXTURE_URL, 'utf8'));
const C2_PHASES = new Set(['ready', 'no_dsh']);

const own = (value, key) => Object.hasOwn(value, key);

/**
 * C4 is intentionally smaller than Center's internal config/state schemas:
 * Sidecar's file fallback needs only identity/configuration from config.json
 * and eligibility/runtime state from state.json.
 */
export function fallbackFilesFrom(rows) {
  return {
    config: {
      hosts: Object.fromEntries(rows.map((host) => [
        host.name,
        { enabled: host.config.enabled, local: host.config.local },
      ])),
    },
    state: {
      hosts: Object.fromEntries(rows.map((host) => [
        host.name,
        { phase: host.phase, orphaned: host.orphaned },
      ])),
    },
  };
}

export function assertSidecarConsumerContract(rows) {
  assert.ok(Array.isArray(rows), 'dshc ls --json 必须输出数组');
  assert.ok(rows.length > 0, 'fixture 至少包含一台主机');

  const names = new Set();
  for (const host of rows) {
    assertShape(hostView, host, `HostView ${host.name ?? '<unknown>'}`);
    assert.equal(own(host, 'name'), true, 'C2 name 必须存在');
    assert.equal(typeof host.name, 'string', 'C2 name 必须是字符串');
    assert.ok(host.name.length > 0, 'C2 name 不能为空');
    assert.equal(names.has(host.name), false, `主机名重复：${host.name}`);
    names.add(host.name);

    for (const [field, value] of [
      ['local', host.local],
      ['orphaned', host.orphaned],
      ['config.local', host.config.local],
      ['config.enabled', host.config.enabled],
    ]) {
      assert.equal(typeof value, 'boolean', `C2 ${field} 必须是 boolean`);
    }
    assert.equal(host.local, host.config.local, `C2 ${host.name} 的 local 身份必须一致`);
    assert.equal(typeof host.phase, 'string', `C2 ${host.name}.phase 必须是字符串`);
    assert.ok(PHASES.includes(host.phase), `C2 phase 越界：${host.phase}`);
    assert.equal(own(host.probe, 'sniff'), true, `C2 ${host.name}.probe.sniff 应由新 fixture 提供`);
  }

  return rows;
}

test('C1/C2：固定 ls JSON 是 HostView 数组且字段类型稳定', () => {
  assertSidecarConsumerContract(LS_FIXTURE);
  assert.deepEqual(
    LS_FIXTURE.map((host) => host.name).sort(),
    ['remote-no-dsh', 'remote-orphaned', 'remote-ready', 'workstation'],
  );
});

test('C2/C3：fixture 覆盖 local、remote、orphaned、no_dsh 及资格语义', () => {
  const byName = Object.fromEntries(LS_FIXTURE.map((host) => [host.name, host]));
  assert.equal(byName.workstation.local, true);
  assert.equal(byName['remote-ready'].local, false);
  assert.equal(byName['remote-orphaned'].orphaned, true);
  assert.equal(byName['remote-no-dsh'].phase, 'no_dsh');

  const eligible = LS_FIXTURE
    .filter((host) => (
      host.config.enabled
      && !host.orphaned
      && !host.local
      && C2_PHASES.has(host.phase)
    ))
    .map((host) => host.name);
  assert.deepEqual(eligible, ['remote-no-dsh', 'remote-ready']);
});

test('C4：config/state 文件回退只依赖约定的最小 host 结构', () => {
  assertSidecarConsumerContract(LS_FIXTURE);
  const { config, state } = fallbackFilesFrom(LS_FIXTURE);

  assert.deepEqual(Object.keys(config), ['hosts']);
  assert.deepEqual(Object.keys(state), ['hosts']);
  for (const host of LS_FIXTURE) {
    const configHost = config.hosts[host.name];
    const stateHost = state.hosts[host.name];
    assert.deepEqual(Object.keys(configHost).sort(), ['enabled', 'local']);
    assert.deepEqual(Object.keys(stateHost).sort(), ['orphaned', 'phase']);
    assert.equal(typeof configHost.enabled, 'boolean');
    assert.equal(typeof configHost.local, 'boolean');
    assert.equal(typeof stateHost.orphaned, 'boolean');
    assert.ok(PHASES.includes(stateHost.phase));
  }
});

test('C4：消费端投影忽略 probe.sniff 诊断扩展', () => {
  const baseline = fallbackFilesFrom(LS_FIXTURE);
  const withSniff = LS_FIXTURE.map((host) => ({
    ...host,
    probe: {
      ...host.probe,
      sniff: {
        paths: ['/not-consumed/dsh'],
        loginPath: '/not-consumed/dsh',
        version: 'diagnostic-only',
        probePath: '/not-consumed',
      },
    },
  }));

  assert.deepEqual(fallbackFilesFrom(withSniff), baseline);
});

test('C4：DSHC_HOME 覆盖默认 ~/.dsh_center 且文件名固定', () => {
  const custom = resolvePaths({ DSHC_HOME: '/tmp/dshc-contract' }, '/home/example');
  assert.equal(custom.config, '/tmp/dshc-contract/config.json');
  assert.equal(custom.state, '/tmp/dshc-contract/state.json');

  const fallback = resolvePaths({}, '/home/example');
  assert.equal(fallback.config, '/home/example/.dsh_center/config.json');
  assert.equal(fallback.state, '/home/example/.dsh_center/state.json');
});
