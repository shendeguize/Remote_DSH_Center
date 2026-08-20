/**
 * 发布产物命名与校验和口径（`src/lib/bundle.js`）。
 *
 * 构建端和消费端共用这一份规则。它错了的表现是 404 或者「校验和查不到」，
 * 不是异常——所以名字的逐字形态值得有快照式用例，改名会当场红。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  RELEASE_REPO, SUMS_FILE, assetName, assetUrl, bundleDirName, formatSums,
  normalizeArch, parseSums, releaseByTagUrl, releasesUrl, SUPPORTED_ARCHES,
} from '../../src/lib/bundle.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('normalizeArch：uname -m 与 process.arch 的各种写法归一', () => {
  assert.equal(normalizeArch('arm64'), 'arm64');
  assert.equal(normalizeArch('aarch64'), 'arm64', 'Linux 上 uname -m 是这个写法');
  assert.equal(normalizeArch('x86_64'), 'x64', 'mac Intel 的 uname -m');
  assert.equal(normalizeArch('amd64'), 'x64');
  assert.equal(normalizeArch('X64'), 'x64', '大小写不该影响');
  assert.equal(normalizeArch('  arm64 '), 'arm64');
  assert.equal(normalizeArch('riscv64'), null, '不支持的架构给 null，让上层说人话');
  assert.equal(normalizeArch(undefined), null);
});

test('产物名的逐字形态（改名 = 破坏下载链接，必须当场红）', () => {
  assert.equal(bundleDirName({ version: '0.2.0-rc.1', arch: 'arm64' }), 'dsh-center-v0.2.0-rc.1-darwin-arm64');
  assert.equal(assetName({ version: '0.2.0-rc.1', arch: 'x64' }), 'dsh-center-v0.2.0-rc.1-darwin-x64.tar.gz');
  assert.equal(assetName({ version: '1.0.0', arch: 'arm64' }), 'dsh-center-v1.0.0-darwin-arm64.tar.gz');
  assert.deepEqual([...SUPPORTED_ARCHES], ['arm64', 'x64']);
  assert.equal(SUMS_FILE, 'SHA256SUMS');
});

test('parseSums：认 shasum -a 256 的输出（含二进制星号与杂行）', () => {
  const sha = 'a'.repeat(64);
  const other = 'b'.repeat(64);
  const text = [
    `${sha}  dsh-center-v0.2.0-darwin-arm64.tar.gz`,
    `${other} *dsh-center-v0.2.0-darwin-x64.tar.gz`,
    '# 注释行',
    '',
    '不是校验和的一行',
  ].join('\n');

  const sums = parseSums(text);
  assert.equal(sums.get('dsh-center-v0.2.0-darwin-arm64.tar.gz'), sha);
  assert.equal(sums.get('dsh-center-v0.2.0-darwin-x64.tar.gz'), other, '二进制模式的 * 前缀要剥掉');
  assert.equal(sums.size, 2, '杂行不该混进来');
  assert.equal(parseSums('').size, 0);
  assert.equal(parseSums(null).size, 0);
});

test('parseSums：大写十六进制归一到小写（比较时不能因大小写判成不符）', () => {
  const sums = parseSums(`${'A'.repeat(64)}  x.tar.gz`);
  assert.equal(sums.get('x.tar.gz'), 'a'.repeat(64));
});

test('formatSums 与 parseSums 是一对（能被 shasum -c 吃下的两空格格式）', () => {
  const entries = [['a.tar.gz', 'c'.repeat(64)], ['b.tar.gz', 'd'.repeat(64)]];
  const text = formatSums(entries);
  assert.match(text, /^[0-9a-f]{64} {2}a\.tar\.gz$/m, 'shasum -c 要求两个空格分隔');
  assert.ok(text.endsWith('\n'), '文件要以换行结尾');
  assert.deepEqual([...parseSums(text)], entries.map(([n, s]) => [n, s]));
});

test('URL 拼装', () => {
  assert.equal(releasesUrl('o/r', 5), 'https://api.github.com/repos/o/r/releases?per_page=5');
  assert.equal(releaseByTagUrl('v0.2.0', 'o/r'), 'https://api.github.com/repos/o/r/releases/tags/v0.2.0');
  assert.equal(
    assetUrl({ tag: 'v0.2.0', name: 'x.tar.gz', repo: 'o/r' }),
    'https://github.com/o/r/releases/download/v0.2.0/x.tar.gz',
  );
  assert.match(releasesUrl(), new RegExp(RELEASE_REPO.replace('/', '\\/')), '默认指向本仓库');
});

test('发布仓库只有一个源：install.sh 的默认 URL 必须和 RELEASE_REPO 对得上', () => {
  // shell 脚本没法 import 常量，只能靠用例把两处钉在一起——
  // 漂了的表现是「装的人拿到另一个仓库的产物」，静默且难查。
  const sh = fs.readFileSync(path.join(ROOT, 'install.sh'), 'utf8');
  assert.match(
    sh,
    new RegExp(`REPO_URL="\\$\\{DSHC_REPO_URL:-https://github\\.com/${RELEASE_REPO}\\.git\\}"`),
    `install.sh 的默认 clone 源应指向 ${RELEASE_REPO}`,
  );
});
