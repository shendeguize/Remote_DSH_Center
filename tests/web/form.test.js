/** 表单解析/校验纯函数单测（10 §3.7、UI-19/23；与后端 validate.js 双层一致）。 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildDefaultsPatch, buildHostPatch, deepEqual, diffPatch, formatEnvLines, formatLines, parseEnvLines, parseLines, parsePort, parsePortRange, parseWorkdir, validatePatches,
} from '../../src/web/form.js';

test('parsePort 边界', () => {
  assert.deepEqual(parsePort('8899'), { ok: true, value: 8899 });
  assert.deepEqual(parsePort('65535'), { ok: true, value: 65_535 });
  assert.equal(parsePort('65536').ok, false);
  assert.equal(parsePort('0').ok, false);
  assert.equal(parsePort('-1').ok, false);
  assert.equal(parsePort('88.9').ok, false);
  assert.equal(parsePort('abc').ok, false);
  assert.equal(parsePort('').ok, false);
  assert.deepEqual(parsePort('', { allowEmpty: true }), { ok: true, value: null });
});

test('parsePortRange 拒绝倒置区间与过窄区间', () => {
  assert.deepEqual(parsePortRange('17701', '17799').value, [17_701, 17_799]);
  assert.deepEqual(parsePortRange('1024', '1024').value, [1024, 1024]);
  assert.match(parsePortRange('1023', '17799').error, /1024/, '本机监听端口不能落入特权区间');
  assert.equal(parsePortRange('17799', '17701').ok, false, '倒置区间必须报错');
  assert.deepEqual(parsePortRange('17701', '17701').value, [17_701, 17_701]);
  assert.equal(parsePortRange('17701', '17703', { minWidth: 10 }).ok, false);
});

test('parseEnvLines：KEY=VALUE、注释、值内等号、非法键名', () => {
  const ok = parseEnvLines('A=1\n# 注释\n\nB=x=y\n  C=3  ');
  assert.deepEqual(ok.value, { A: '1', B: 'x=y', C: '3' });

  assert.equal(parseEnvLines('1BAD=1').ok, false);
  assert.equal(parseEnvLines('has-dash=1').ok, false);
  assert.equal(parseEnvLines('NOEQ').ok, false);
  assert.equal(parseEnvLines('=1').ok, false);
  assert.equal(parseEnvLines('A=1\nA=2').ok, false, '重复键要报错');
  assert.deepEqual(parseEnvLines('').value, {});

  assert.equal(formatEnvLines({ A: '1', B: '2' }), 'A=1\nB=2');
});

test('parseLines / patches 绝对路径', () => {
  assert.deepEqual(parseLines(' --a \n\n--b\n'), ['--a', '--b']);
  assert.equal(formatLines(['--a', '--b']), '--a\n--b');
  assert.equal(validatePatches(['/tmp/a.yml']).ok, true);
  assert.equal(validatePatches(['rel/a.yml']).ok, false);
});

test('parseWorkdir：空 = null，只收绝对路径与 ~ 形态', () => {
  assert.deepEqual(parseWorkdir(''), { ok: true, value: null });
  assert.deepEqual(parseWorkdir('   '), { ok: true, value: null }, '纯空白等同留空');
  assert.deepEqual(parseWorkdir('  /root/proj  '), { ok: true, value: '/root/proj' });
  assert.deepEqual(parseWorkdir('~'), { ok: true, value: '~' });
  assert.deepEqual(parseWorkdir('~/proj'), { ok: true, value: '~/proj' });
  for (const bad of ['proj', './proj', '../up', '~user/proj']) {
    assert.equal(parseWorkdir(bad).ok, false, `应拒绝 ${bad}`);
  }
});

test('buildHostPatch 组装 PUT 请求体', () => {
  const built = buildHostPatch({
    enabled: true, autoStart: true, remoteWebPort: '9001', workdir: '~/proj', env: 'G=hi', extraArgs: '--verbose', patches: '/tmp/p.yml',
  });
  assert.deepEqual(built.value, {
    enabled: true,
    remoteWebPort: 9001,
    workdir: '~/proj',
    inject: { env: { G: 'hi' }, extraArgs: ['--verbose'], patches: ['/tmp/p.yml'] },
  });
  assert.equal('autoStart' in built.value, false, '抽屉 builder 不得顺带写回表格独占的自启值');

  const empty = buildHostPatch({
    enabled: false, remoteWebPort: '', workdir: '', env: '', extraArgs: '', patches: '',
  });
  assert.equal(empty.value.remoteWebPort, null, '空 = 继承 defaults');
  assert.equal(empty.value.workdir, null, '空 = 远端家目录');

  const bad = buildHostPatch({
    remoteWebPort: '70000', workdir: 'rel/dir', env: 'bad-key=1', patches: 'rel.yml',
  });
  assert.equal(bad.ok, false);
  assert.deepEqual(Object.keys(bad.errors).sort(), ['env', 'patches', 'remoteWebPort', 'workdir']);
});

test('buildDefaultsPatch 聚合四键并逐字段报错', () => {
  const built = buildDefaultsPatch({
    remoteWebPort: '8899',
    rangeFrom: '17701',
    rangeTo: '17799',
    managerPort: '7788',
    hostFilterDeny: 'git\\..*\n\n  github\\.com  \n',
    hostFilterAllow: '',
  });
  assert.deepEqual(built.value, {
    remoteWebPort: 8899,
    localPortRange: [17_701, 17_799],
    hostFilter: { allow: [], deny: ['git\\..*', 'github\\.com'] },
    manager: { port: 7788 },
  }, '名单按行切分，空行与两侧空格都吃掉');

  const bad = buildDefaultsPatch({
    remoteWebPort: 'x', rangeFrom: '20', rangeTo: '10', managerPort: '', hostFilterDeny: '(',
  });
  assert.equal(bad.ok, false);
  assert.deepEqual(Object.keys(bad.errors).sort(),
    ['hostFilterDeny', 'localPortRange', 'managerPort', 'remoteWebPort']);
  assert.match(bad.errors.hostFilterDeny, /不是合法正则/);

  const lowBindable = buildDefaultsPatch({
    remoteWebPort: '1', rangeFrom: '1023', rangeTo: '1024', managerPort: '1',
  });
  assert.equal(lowBindable.ok, false);
  assert.deepEqual(Object.keys(lowBindable.errors), ['localPortRange'],
    '普通远端/manager 端口允许 1，本机映射区间才要求从 1024 起');
});

test('diffPatch 只提交真正改动的键', () => {
  const current = { enabled: true, autoStart: false, inject: { env: { A: '1' }, extraArgs: [], patches: [] } };
  const patch = { enabled: true, autoStart: true, inject: { env: { A: '1' }, extraArgs: [], patches: [] } };
  assert.deepEqual(diffPatch(patch, current), { autoStart: true });
  assert.deepEqual(diffPatch(patch, patch), {});
});

test('deepEqual 处理嵌套与数组顺序', () => {
  assert.equal(deepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] }), true);
  assert.equal(deepEqual([1, 2], [2, 1]), false);
  assert.equal(deepEqual({ a: 1 }, { a: 1, b: 2 }), false);
  assert.equal(deepEqual(null, undefined), false);
});
