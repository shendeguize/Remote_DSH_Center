import assert from 'node:assert/strict';
import test from 'node:test';

import {
  hostDshSummary,
  hostMappingSummary,
  hostPhaseHint,
  hostPhaseMeta,
  hostStatusText,
} from '../../src/web/host-presentation.js';
import {
  DASH,
  dshSummary,
  mappingSummary,
  phaseHint,
  phaseMeta,
} from '../../src/web/utils.js';

const host = (local, phase, patch = {}) => ({ local, phase, ...patch });

function assertFrozenFresh(make, expected) {
  const first = make();
  const second = make();
  assert.deepEqual(first, expected);
  assert.deepEqual(second, expected);
  assert.notStrictEqual(first, second);
  assert.equal(Object.isFrozen(first), true);
}

test('hostPhaseMeta 区分本机文案，其余 phase 委托现有展示语义', () => {
  const cases = [
    [false, 'unreachable', phaseMeta('unreachable')],
    [false, 'no_dsh', phaseMeta('no_dsh')],
    [false, 'ready', phaseMeta('ready')],
    [false, 'running', phaseMeta('running')],
    [true, 'unreachable', { label: '本机不可用', tone: 'neutral', dot: 'none' }],
    [true, 'no_dsh', { label: '本机未安装或未配置', tone: 'neutral', dot: 'none' }],
    [true, 'ready', phaseMeta('ready')],
    [true, 'running', phaseMeta('running')],
  ];

  for (const [local, phase, expected] of cases) {
    assertFrozenFresh(
      () => hostPhaseMeta(host(local, phase)),
      expected,
    );
  }
});

test('hostPhaseHint 保留远端语义并细分本机失败原因', () => {
  const remoteCases = [
    host(false, 'unreachable', { probe: { errorSummary: 'Host key verification failed' } }),
    host(false, 'no_dsh', { probe: { noDshReason: 'missing-bin' } }),
    host(false, 'no_dsh', { probe: { noDshReason: 'no-web-profile' } }),
    host(false, 'no_dsh', { probe: { noDshReason: 'future-reason' } }),
    host(false, 'ready'),
    host(false, 'running'),
  ];
  for (const remote of remoteCases) {
    assert.equal(hostPhaseHint(remote), phaseHint(remote));
  }

  assert.equal(
    hostPhaseHint(host(true, 'no_dsh', { probe: { noDshReason: 'missing-bin' } })),
    '本机未安装 dsh',
  );
  assert.equal(
    hostPhaseHint(host(true, 'no_dsh', { probe: { noDshReason: 'no-web-profile' } })),
    '本机 dsh 未配置 web profile',
  );
  assert.equal(
    hostPhaseHint(host(true, 'no_dsh', { probe: { noDshReason: 'future-reason' } })),
    '',
  );
  assert.equal(
    hostPhaseHint(host(true, 'unreachable', { probe: { errorSummary: '本机探测超时' } })),
    '本机探测超时',
  );
  assert.equal(hostPhaseHint(host(true, 'unreachable')), '本机命令执行失败');

  const delegated = host(true, 'running', {
    tunnel: { suspendedReason: 'local-port-busy' },
  });
  assert.equal(hostPhaseHint(delegated), phaseHint(delegated));
  assert.equal(hostPhaseHint(host(true, 'ready')), '');
});

test('hostDshSummary 仅替换本机 no_dsh 的第二行', () => {
  const remoteCases = [
    host(false, 'unreachable', { probe: { version: null, dshPath: null } }),
    host(false, 'no_dsh', {
      probe: { version: null, dshPath: null, noDshReason: 'missing-bin' },
    }),
    host(false, 'ready', { probe: { version: '0.2.0', dshPath: '/usr/bin/dsh' } }),
    host(false, 'running', { probe: { version: '0.2.0', dshPath: '/opt/dsh' } }),
  ];
  for (const remote of remoteCases) {
    assertFrozenFresh(() => hostDshSummary(remote), dshSummary(remote));
  }

  const localMissing = host(true, 'no_dsh', {
    probe: { version: null, dshPath: null, noDshReason: 'missing-bin' },
  });
  assertFrozenFresh(
    () => hostDshSummary(localMissing),
    { line1: DASH, line2: '本机未安装 dsh' },
  );

  const localNoProfile = host(true, 'no_dsh', {
    probe: { version: '0.2.0', dshPath: '/usr/local/bin/dsh', noDshReason: 'no-web-profile' },
  });
  assertFrozenFresh(
    () => hostDshSummary(localNoProfile),
    { line1: '0.2.0', line2: '本机 dsh 未配置 web profile' },
  );

  const localUnknown = host(true, 'no_dsh', {
    probe: { version: null, dshPath: null, noDshReason: 'future-reason' },
  });
  assertFrozenFresh(
    () => hostDshSummary(localUnknown),
    { line1: DASH, line2: '' },
  );

  const localRunning = host(true, 'running', {
    probe: { version: '0.2.0', dshPath: '/usr/local/bin/dsh' },
  });
  assertFrozenFresh(() => hostDshSummary(localRunning), dshSummary(localRunning));
});

test('hostMappingSummary 远端委托，本机只展示后端确认的直连端口', () => {
  const remoteCases = [
    host(false, 'running', {
      mappedUrl: 'http://127.0.0.1:12345/',
      tunnel: { localPort: 12345 },
      web: { port: 23456 },
    }),
    host(false, 'ready', {
      mappedUrl: null,
      config: { localPort: 12346 },
    }),
  ];
  for (const remote of remoteCases) {
    assertFrozenFresh(() => hostMappingSummary(remote), mappingSummary(remote));
  }

  const directZero = host(true, 'running', {
    mappedUrl: 'http://127.0.0.1:0/',
    tunnel: { localPort: 0 },
  });
  assertFrozenFresh(
    () => hostMappingSummary(directZero),
    { line1: '本机 0', line2: '直连 dsh web', url: directZero.mappedUrl },
  );

  const noMappedUrl = host(true, 'ready', {
    mappedUrl: null,
    tunnel: { localPort: 34567 },
    config: { localPort: 45678, remoteWebPort: 56789 },
    effectiveRemotePort: 56789,
    web: { port: 56789 },
  });
  assertFrozenFresh(
    () => hostMappingSummary(noMappedUrl),
    { line1: DASH, line2: '', url: null },
  );

  for (const localPort of [null, undefined]) {
    const missingPort = host(true, 'running', {
      mappedUrl: 'http://127.0.0.1:34567/',
      tunnel: { localPort },
      config: { localPort: 45678, remoteWebPort: 56789 },
      effectiveRemotePort: 56789,
      web: { port: 56789 },
    });
    assertFrozenFresh(
      () => hostMappingSummary(missingPort),
      { line1: DASH, line2: '', url: null },
    );
  }
});

test('hostStatusText 统一状态文字并让禁用态优先', () => {
  const cases = [
    [host(false, 'unreachable'), 'SSH 不可达'],
    [host(false, 'no_dsh'), '未安装/未配置'],
    [host(false, 'ready'), '可拉起'],
    [host(false, 'running'), '运行中'],
    [host(true, 'unreachable'), '本机不可用'],
    [host(true, 'no_dsh'), '本机未安装或未配置'],
    [host(true, 'ready'), '可拉起'],
    [host(true, 'running'), '运行中'],
  ];
  for (const [target, expected] of cases) {
    assert.equal(hostStatusText(target), expected);
    assert.equal(hostStatusText(target, { disabled: true }), '已禁用');
  }
});
