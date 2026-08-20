/**
 * 工程化工具链：入口判定、安装脚本、统一闸门的纯逻辑。
 *
 * 这层的价值全在「装出去以后还能不能跑」——尤其是软链入口那条：
 * 判错了不会报错，只会静悄悄退 0，什么都不做。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { isMainEntry } from '../src/lib/entry.js';
import { PACK_RULES, selectStages, summarize, verifyPackFiles } from '../scripts/check.mjs';
import { linkPlan, pathHint, prefixInPath } from '../scripts/install.mjs';
import { evaluateGuards, extractChangelogSection, versionFromTag } from '../scripts/release-guard.mjs';
import { findChrome } from '../scripts/ui-smoke.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'src', 'cli.js');

function tmpdir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-tooling-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// ── 入口判定 ─────────────────────────────────────────────────────────────

test('isMainEntry：直接执行算、被 import 不算、经软链执行也算', (t) => {
  const dir = tmpdir(t);
  const real = path.join(dir, 'tool.js');
  fs.writeFileSync(real, '// noop\n');
  const link = path.join(dir, 'linked');
  fs.symlinkSync(real, link);
  const url = `file://${real}`;

  assert.equal(isMainEntry(url, real), true);
  assert.equal(isMainEntry(url, link), true, '软链名与真身指同一个文件，必须算直接执行');
  assert.equal(isMainEntry(url, path.join(dir, 'other.js')), false);
  assert.equal(isMainEntry(url, undefined), false, 'REPL / 无 argv[1] 时不算');
});

test('经软链执行 dshc --help 真的有输出（PATH 安装的就是软链）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-link-'));
  const link = path.join(dir, 'dshc');
  try {
    fs.symlinkSync(CLI, link);
    const res = await new Promise((resolve, reject) => {
      const child = spawn(link, ['--help'], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (c) => { stdout += c; });
      child.stderr.on('data', (c) => { stderr += c; });
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, stdout, stderr }));
    });
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /dshc/, '软链入口必须照样打印用法，而不是静默退 0');
    assert.match(res.stdout, /生命周期/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── 安装脚本 ─────────────────────────────────────────────────────────────

test('linkPlan 分清四种现状：新建 / 已就位 / 换指向 / 撞上真实文件', (t) => {
  const dir = tmpdir(t);
  const target = path.join(dir, 'cli.js');
  fs.writeFileSync(target, '');
  const link = path.join(dir, 'dshc');

  assert.equal(linkPlan(link, target).action, 'create');

  fs.symlinkSync(target, link);
  assert.equal(linkPlan(link, target).action, 'noop');

  const other = path.join(dir, 'old-cli.js');
  fs.writeFileSync(other, '');
  fs.rmSync(link);
  fs.symlinkSync(other, link);
  const relink = linkPlan(link, target);
  assert.equal(relink.action, 'relink');
  assert.equal(relink.current, other);

  const real = path.join(dir, 'real');
  fs.writeFileSync(real, '');
  assert.equal(linkPlan(real, target).action, 'conflict', '真实文件不能被悄悄覆盖');
});

test('prefixInPath 认得出前缀是否在 PATH 里（含 ~ 与尾斜杠）', () => {
  const home = os.homedir();
  const bin = path.join(home, '.local', 'bin');
  assert.equal(prefixInPath(bin, `/usr/bin:${bin}:/bin`), true);
  assert.equal(prefixInPath(bin, `/usr/bin:${bin}/:/bin`), true, '尾斜杠不该影响判定');
  assert.equal(prefixInPath(bin, '~/.local/bin:/usr/bin'), true, 'PATH 里写 ~ 也要认');
  assert.equal(prefixInPath(bin, '/usr/bin:/bin'), false);
  assert.equal(prefixInPath(bin, ''), false);
});

test('pathHint 按 shell 给对 rc 文件', () => {
  assert.match(pathHint('/opt/bin', '/bin/zsh'), /\.zshrc/);
  assert.match(pathHint('/opt/bin', '/bin/bash'), /\.bash_profile/);
  assert.match(pathHint('/opt/bin', '/usr/bin/fish'), /shell rc/);
  assert.match(pathHint('/opt/bin', '/bin/zsh'), /\/opt\/bin/);
});

// ── 统一闸门 ─────────────────────────────────────────────────────────────

const STAGES = [{ id: 'tests' }, { id: 'ui' }, { id: 'pack' }, { id: 'cli' }];

test('selectStages：only / skip 组合，打错字要报错', () => {
  assert.deepEqual(selectStages(STAGES).map((s) => s.id), ['tests', 'ui', 'pack', 'cli']);
  assert.deepEqual(selectStages(STAGES, { only: 'pack,cli' }).map((s) => s.id), ['pack', 'cli']);
  assert.deepEqual(selectStages(STAGES, { skip: 'ui' }).map((s) => s.id), ['tests', 'pack', 'cli']);
  assert.deepEqual(selectStages(STAGES, { only: 'tests,ui', skip: 'ui' }).map((s) => s.id), ['tests']);
  assert.throws(() => selectStages(STAGES, { only: 'uii' }), /未知关卡：uii/);
  assert.throws(() => selectStages(STAGES, { skip: 'browser' }), /未知关卡：browser/);
});

test('verifyPackFiles：该进的都在、tests 与 .local 不许混进去', () => {
  const good = [...PACK_RULES.required, 'src/lib/shq.js', 'src/web/app.js'];
  assert.equal(verifyPackFiles(good).ok, true);

  const leaky = verifyPackFiles([...good, 'tests/api.test.js', '.local/tasks/design.md']);
  assert.equal(leaky.ok, false);
  assert.deepEqual(leaky.leaked, ['tests/api.test.js', '.local/tasks/design.md']);

  const short = verifyPackFiles(good.filter((f) => f !== 'src/cli.js'));
  assert.equal(short.ok, false);
  assert.deepEqual(short.missing, ['src/cli.js']);
});

test('summarize 三种状态各有记号', () => {
  const text = summarize([
    { label: '甲', status: 'pass', note: 'ok', ms: 1_200 },
    { label: '乙', status: 'skip', note: '没装 Chrome', ms: 0 },
    { label: '丙', status: 'fail', note: '炸了', ms: 900 },
  ]);
  assert.match(text, /✔ 甲/);
  assert.match(text, /· 乙.*没装 Chrome/);
  assert.match(text, /✘ 丙.*炸了/);
  assert.match(text, /1\.2s/);
});

// ── 版本管控 ─────────────────────────────────────────────────────────────

test('版本号与 CHANGELOG 不许脱节：package.json 的 version 必须有对应小节', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const changelog = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
  const body = extractChangelogSection(changelog, pkg.version);
  assert.notEqual(
    body,
    '',
    `CHANGELOG.md 里没有 v${pkg.version} 的小节（或正文为空）：bump 版本号时必须同步搬运 Unreleased`,
  );
});

test('versionFromTag：认 refs/tags 前缀，形状不对给 null', () => {
  assert.equal(versionFromTag('refs/tags/v0.1.0'), '0.1.0');
  assert.equal(versionFromTag('v1.2.30'), '1.2.30');
  assert.equal(versionFromTag('0.1.0'), null, '少了 v 前缀不算');
  assert.equal(versionFromTag('v0.1'), null, '必须三段');
  assert.equal(versionFromTag('v0.1.0-rc1'), null, '预发布后缀先一律拦住');
  assert.equal(versionFromTag(''), null);
});

test('extractChangelogSection：截到下一个标题或链接引用区为止', () => {
  const text = [
    '# 变更记录', '',
    '## [Unreleased]', '', '- 攒着的东西', '',
    '## [0.2.0] - 2026-09-01', '', '### 新增', '- 甲', '',
    '## [0.1.0] - 2026-08-21', '', '### 新增', '- 乙', '',
    '[0.1.0]: https://example.com/tag/v0.1.0', '',
  ].join('\n');

  assert.equal(extractChangelogSection(text, '0.2.0'), '### 新增\n- 甲');
  assert.equal(extractChangelogSection(text, '0.1.0'), '### 新增\n- 乙', '链接引用区不算正文');
  assert.equal(extractChangelogSection(text, '9.9.9'), '', '没这个版本给空串');
  assert.equal(extractChangelogSection('## [0.3.0] - 今天\n\n', '0.3.0'), '', '只有标题没正文也算不合格');
});

test('evaluateGuards：三关各自能红，全过则带出正文', () => {
  const changelog = '## [0.1.0] - 2026-08-21\n\n### 新增\n- 初版\n';
  const base = {
    tag: 'v0.1.0', pkgVersion: '0.1.0', changelog, tagSha: 'a'.repeat(40), releaseSha: 'a'.repeat(40), inMain: true,
  };

  const pass = evaluateGuards(base);
  assert.equal(pass.ok, true, pass.problems.join('；'));
  assert.equal(pass.version, '0.1.0');
  assert.match(pass.body, /初版/);

  assert.match(
    evaluateGuards({ ...base, pkgVersion: '0.2.0' }).problems.join(''),
    /package\.json 的 version 是 0\.2\.0/,
    '守卫一：tag 与包版本对不上',
  );
  assert.match(
    evaluateGuards({ ...base, changelog: '## [0.9.0]\n\n- 别的版本\n' }).problems.join(''),
    /没有 v0\.1\.0 的小节/,
    '守卫二：CHANGELOG 缺小节',
  );
  assert.match(
    evaluateGuards({ ...base, releaseSha: 'b'.repeat(40) }).problems.join(''),
    /release 分支 HEAD 是/,
    '守卫三：tag 没打在 release HEAD 上',
  );
  assert.match(
    evaluateGuards({ ...base, inMain: false }).problems.join(''),
    /不在 main 上/,
    '守卫三：release 出现了 main 没有的提交',
  );
  assert.match(evaluateGuards({ ...base, tag: 'v0.1' }).problems.join(''), /不是 v/, 'tag 形状不对');

  const partial = evaluateGuards({
    tag: 'v0.1.0', pkgVersion: '0.1.0', changelog,
  });
  assert.equal(partial.ok, true, '只给前两关的信息时（本地预检）不该因缺 sha 判红');
});

test('findChrome：显式指定优先，找不到给 null', () => {
  const exists = (p) => ['/usr/bin/chromium', '/custom/chrome'].includes(p);
  assert.equal(findChrome({ env: { DSHC_CHROME: '/custom/chrome' }, exists }), '/custom/chrome');
  assert.equal(findChrome({ env: {}, exists }), '/usr/bin/chromium', '没指定就按常见落点找');
  assert.equal(findChrome({ env: {}, exists: () => false }), null);
  assert.equal(
    findChrome({ env: { DSHC_CHROME: '/gone' }, exists }),
    '/usr/bin/chromium',
    '指定的路径不存在时要继续往下找，而不是直接放弃',
  );
});
