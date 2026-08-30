/** 抽屉草稿与跨标签冲突（10 §3.3 / UI-19、UI-26）。 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  draftOf, isDirty, reconcile, workdirPending,
} from '../../src/web/components/host-drawer.js';

const config = (patch = {}) => ({
  enabled: true,
  autoStart: false,
  localPort: 17_701,
  remoteWebPort: null,
  workdir: null,
  inject: { env: { A: '1' }, extraArgs: ['--v'], patches: ['/tmp/a.yml'] },
  ...patch,
});

test('draftOf 把 config 摊平成文本表单', () => {
  assert.deepEqual(draftOf(config()), {
    enabled: true,
    dshPath: '',
    remoteWebPort: '',
    workdir: '',
    env: 'A=1',
    extraArgs: '--v',
    patches: '/tmp/a.yml',
  });
  // autoStart 由主机表自启列独占，localPort 由 manager 分配；都不进抽屉草稿
  assert.equal('autoStart' in draftOf(config()), false);
  assert.equal('localPort' in draftOf(config()), false);
});

test('isDirty 只认真实改动', () => {
  const cfg = config();
  assert.equal(isDirty(draftOf(cfg), cfg), false);
  assert.equal(isDirty({ ...draftOf(cfg), env: 'A=2' }, cfg), true);
  assert.equal(isDirty(draftOf(cfg), config({ autoStart: true })), false, '表格自启变化不属于抽屉草稿');
  // 空 remoteWebPort 与 null 等价，不该被当成脏
  assert.equal(isDirty({ ...draftOf(cfg), remoteWebPort: '' }, cfg), false);
});

test('显式远端端口：草稿存字符串，一打开不该被判脏', () => {
  // 真浏览器里 readForm() 拿到的永远是字符串；draftOf 若给数字，
  // 配了显式端口的主机一打开就是「脏草稿」——保存键亮着、Esc 还要确认放弃
  const cfg = config({ remoteWebPort: 8899 });
  assert.equal(draftOf(cfg).remoteWebPort, '8899');
  assert.equal(isDirty(draftOf(cfg), cfg), false);
  assert.equal(isDirty({ ...draftOf(cfg), remoteWebPort: '8899' }, cfg), false);
  assert.equal(isDirty({ ...draftOf(cfg), remoteWebPort: '9000' }, cfg), true);
  // 清空端口（回落全局默认）仍算改动
  assert.equal(isDirty({ ...draftOf(cfg), remoteWebPort: '' }, cfg), true);
});

test('启动目录：null 与空串等价，不该一打开就判脏', () => {
  const cfg = config();
  assert.equal(draftOf(cfg).workdir, '');
  assert.equal(isDirty(draftOf(cfg), cfg), false);
  assert.equal(isDirty({ ...draftOf(cfg), workdir: '~/proj' }, cfg), true);

  const withWd = config({ workdir: '~/proj' });
  assert.equal(draftOf(withWd).workdir, '~/proj');
  assert.equal(isDirty(draftOf(withWd), withWd), false);
  assert.equal(isDirty({ ...draftOf(withWd), workdir: '' }, withWd), true, '清空 = 回落家目录，是改动');
});

test('workdirPending：只在能证明分歧时才提示「重启后生效」', () => {
  const host = (phase, cfgWd, webWd) => ({
    phase,
    config: config({ workdir: cfgWd }),
    web: webWd === undefined ? null : { workdir: webWd },
  });

  assert.equal(workdirPending(host('running', '/root/b', '/root/a')), true);
  assert.equal(workdirPending(host('degraded', '/root/b', '/root/a')), true);
  assert.equal(workdirPending(host('running', '/root/a', '/root/a')), false);
  assert.equal(workdirPending(host('running', null, null)), false);
  assert.equal(workdirPending(host('running', '/root/a', null)), true, '从家目录改成具体目录也要提示');

  // 没在跑就没有「当前实例」可比，下次拉起自然生效
  assert.equal(workdirPending(host('ready', '/root/b')), false);
  assert.equal(workdirPending(host('crashed', '/root/b', '/root/a')), false);
  assert.equal(workdirPending(null), false);

  // 上一代 manager 写的 state 没有这个键：等同 null，不无端报「重启后生效」
  assert.equal(workdirPending({ phase: 'running', config: config(), web: { pid: 1 } }), false);
});

test('仅非抽屉字段变化：无论草稿是否脏都不制造冲突', () => {
  const prev = config();
  const next = config({ autoStart: true, localPort: 17_799 });
  const dirty = { ...draftOf(prev), env: 'A=9' };

  assert.deepEqual(reconcile(draftOf(prev), prev, next), {
    draft: draftOf(prev),
    conflicts: [],
    remoteChanged: false,
  });
  assert.deepEqual(reconcile(dirty, prev, next), {
    draft: dirty,
    conflicts: [],
    remoteChanged: false,
  });
});

test('三方合并：用户未改字段吸收远端，用户改过的无关字段保留本地', () => {
  const prev = config();
  const next = config({ inject: { ...prev.inject, env: { A: '2' } } });
  const local = { ...draftOf(prev), workdir: '~/local-project' };

  assert.deepEqual(reconcile(local, prev, next), {
    draft: {
      ...draftOf(next),
      workdir: '~/local-project',
    },
    conflicts: [],
    remoteChanged: true,
  });
});

test('三方合并：inject 子字段分别拥有，不把整个 inject 扩成同字段冲突', () => {
  const prev = config();
  const local = { ...draftOf(prev), env: 'A=9' };
  const next = config({
    inject: { ...prev.inject, extraArgs: ['--remote'] },
  });

  assert.deepEqual(reconcile(local, prev, next), {
    draft: {
      ...draftOf(next),
      env: 'A=9',
    },
    conflicts: [],
    remoteChanged: true,
  });
});

test('三方合并：双方同字段改成相同值时无冲突且草稿归于最新 baseline', () => {
  const prev = config();
  const next = config({ inject: { ...prev.inject, env: { A: '2' } } });
  const result = reconcile({ ...draftOf(prev), env: ' A=2 \n# 同值的本地注释' }, prev, next);

  assert.deepEqual(result, {
    draft: draftOf(next),
    conflicts: [],
    remoteChanged: true,
  });
  assert.equal(isDirty(result.draft, next), false);
});

test('三方合并：双方同字段改成不同值才报告冲突并保留本地', () => {
  const prev = config();
  const next = config({ inject: { ...prev.inject, env: { A: '2' } } });
  const local = { ...draftOf(prev), env: 'A=9' };

  assert.deepEqual(reconcile(local, prev, next), {
    draft: local,
    conflicts: ['env'],
    remoteChanged: true,
  });
});

test('只有运行态变化（config 不变）时不打扰用户', () => {
  const cfg = config();
  const dirty = { ...draftOf(cfg), env: 'A=9' };
  assert.deepEqual(reconcile(dirty, cfg, config()), {
    draft: dirty,
    conflicts: [],
    remoteChanged: false,
  }, 'phase 变化不该弹冲突');
});
