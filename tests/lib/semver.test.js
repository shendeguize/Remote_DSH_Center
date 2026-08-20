/**
 * SemVer 内核（`src/lib/semver.js`）。
 *
 * 这层是「更新到哪个版本」的唯一判据：判错了不会报错，只会静静地把用户留在旧版本，
 * 或者反过来把稳定用户推到 rc 上。pre-release 的优先级规则逐条钉死在下面。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { compareVersions, isPrerelease, parseVersion, pickLatest } from '../../src/lib/semver.js';

test('parseVersion：认 v 前缀、拆 pre-release 段、规整出比较用形态', () => {
  assert.deepEqual(
    { ...parseVersion('v0.2.0-rc.1') },
    {
      major: 0, minor: 2, patch: 0, prerelease: ['rc', '1'], build: null, version: '0.2.0-rc.1',
    },
  );
  assert.equal(parseVersion('0.1.0').version, '0.1.0');
  assert.equal(parseVersion('  v1.2.30  ').version, '1.2.30', '两头空白不该算形状错');
  assert.equal(parseVersion('1.0.0+build.5').build, 'build.5');
  assert.equal(parseVersion('1.0.0+build.5').version, '1.0.0', 'build 元数据不进比较形态');
});

test('parseVersion：形状不对一律 null，不猜', () => {
  for (const bad of ['0.1', 'v1', '1.2.3.4', 'latest', '', null, undefined, 'v1.2.x', '1.2.3-']) {
    assert.equal(parseVersion(bad), null, `${bad} 不该被当成版本号`);
  }
  assert.equal(parseVersion('1.0.01'), null, '数字段前导零不合规');
  assert.equal(parseVersion('01.0.0'), null, '核心段前导零同样不合规');
  assert.equal(parseVersion('1.0.0-rc.01'), null, 'pre-release 数字段前导零也拦住');
});

test('isPrerelease：带后缀才算', () => {
  assert.equal(isPrerelease('0.2.0-rc.1'), true);
  assert.equal(isPrerelease('v0.2.0'), false);
  assert.equal(isPrerelease('不是版本号'), false, '非法输入不算预发布');
});

test('compareVersions：核心号逐段比', () => {
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
  assert.equal(compareVersions('0.2.0', '0.1.9'), 1);
  assert.equal(compareVersions('0.1.0', '1.0.0'), -1);
  assert.equal(compareVersions('1.0.1', '1.0.0'), 1);
  assert.equal(compareVersions('v1.0.0', '1.0.0'), 0, 'v 前缀不影响大小');
  assert.equal(compareVersions('1.0.0+a', '1.0.0+b'), 0, 'build 元数据不参与比较');
});

test('compareVersions：pre-release 的四条优先级规则', () => {
  assert.equal(compareVersions('1.0.0', '1.0.0-rc.1'), 1, '正式版大于同核心号的预发布');
  assert.equal(compareVersions('1.0.0-rc.1', '1.0.0-rc.2'), -1, '数字段按数值比');
  assert.equal(compareVersions('1.0.0-rc.9', '1.0.0-rc.10'), -1, '按数值而非字典序：9 < 10');
  assert.equal(compareVersions('1.0.0-alpha', '1.0.0-beta'), -1, '字母段按字典序');
  assert.equal(compareVersions('1.0.0-1', '1.0.0-alpha'), -1, '数字段永远小于字母段');
  assert.equal(compareVersions('1.0.0-rc', '1.0.0-rc.1'), -1, '字段少的更小');
  assert.equal(compareVersions('1.0.0-rc.1', '1.0.0-rc.1'), 0);
  // 规范里的完整序列，一次跑通
  const ordered = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0'];
  for (let i = 1; i < ordered.length; i += 1) {
    assert.equal(compareVersions(ordered[i - 1], ordered[i]), -1, `${ordered[i - 1]} 应小于 ${ordered[i]}`);
  }
});

test('compareVersions：非法输入直接抛，不静默当成 0', () => {
  assert.throws(() => compareVersions('latest', '1.0.0'), /不是合法版本号：latest/);
  assert.throws(() => compareVersions('1.0.0', 'v9'), /不是合法版本号：v9/);
});

test('pickLatest：默认跳过预发布，--pre 口径才带上', () => {
  const all = ['0.1.0', '0.2.0-rc.1', '0.2.0-rc.2', '0.1.1'];
  assert.equal(pickLatest(all), '0.1.1', '稳定口径下 rc 不该入选');
  assert.equal(pickLatest(all, { includePrerelease: true }), '0.2.0-rc.2');
  assert.equal(pickLatest(['0.2.0-rc.1', '0.2.0'], { includePrerelease: true }), '0.2.0', '正式版仍然更大');
});

test('pickLatest：非法候选忽略、全空给 null', () => {
  assert.equal(pickLatest(['nightly', '0.1.0', 'v0.2.0']), 'v0.2.0', '原样返回入选的那个字符串');
  assert.equal(pickLatest(['nightly', 'latest']), null);
  assert.equal(pickLatest([]), null);
  assert.equal(pickLatest(['0.2.0-rc.1']), null, '只有 rc 时稳定口径下没有可选');
});
