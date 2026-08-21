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
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';

import { isMainEntry } from '../src/lib/entry.js';
import { parseVersion } from '../src/lib/semver.js';
import { PACK_RULES, selectStages, summarize, verifyPackFiles } from '../scripts/check.mjs';
import {
  NODE_RUNTIME_VERSION, makeBundleInfo, nodeDistUrl, nodeShasumsUrl, nodeTarballName,
  packFileList, resolveBuildVersion, shimScript,
} from '../scripts/build-bundle.mjs';
import {
  isBrokenPipe, linkPlan, linkTarget, pathHint, prefixInPath, silenceBrokenPipe,
} from '../scripts/install.mjs';
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

test('linkTarget：git 安装指 cli.js，发布包指启动器', (t) => {
  const dir = tmpdir(t);

  const repo = path.join(dir, 'clone');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  assert.deepEqual(linkTarget(repo), {
    target: path.join(repo, 'src', 'cli.js'), channel: 'git', viaShim: false,
  });

  // 发布包必须指 bin/dshc：装的人可能压根没装 node，
  // 直接软链到 app/src/cli.js 的话 shebang 找不到解释器
  const bundleRoot = path.join(dir, 'app');
  const app = path.join(bundleRoot, 'app');
  fs.mkdirSync(app, { recursive: true });
  fs.writeFileSync(path.join(bundleRoot, 'BUNDLE_INFO.json'), '{"version":"0.9.0","arch":"arm64"}');
  assert.deepEqual(linkTarget(app), {
    target: path.join(bundleRoot, 'bin', 'dshc'), channel: 'bundle', viaShim: true,
  });
});

// ── 发布包构建 ───────────────────────────────────────────────────────────

test('随包 Node 版本满足 engines.node，且是个合法版本号', () => {
  // 改这个常量等于改所有新装用户的运行时；低于 engines.node 的话装出来当场跑不动
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const min = Number(/(\d+)/.exec(pkg.engines.node)[1]);
  const parsed = parseVersion(NODE_RUNTIME_VERSION);
  assert.ok(parsed, `NODE_RUNTIME_VERSION 形状不对：${NODE_RUNTIME_VERSION}`);
  assert.ok(
    parsed.major >= min,
    `随包 Node ${NODE_RUNTIME_VERSION} 低于 engines.node（${pkg.engines.node}）`,
  );
  assert.equal(parsed.major % 2, 0, '只挑 LTS：偶数大版本');
});

test('官方 Node 发行版的名字与地址（拼错了表现是 404）', () => {
  assert.equal(nodeTarballName({ version: '22.23.2', arch: 'arm64' }), 'node-v22.23.2-darwin-arm64.tar.gz');
  assert.equal(
    nodeDistUrl({ version: '22.23.2', arch: 'x64' }),
    'https://nodejs.org/dist/v22.23.2/node-v22.23.2-darwin-x64.tar.gz',
  );
  assert.equal(nodeShasumsUrl('22.23.2'), 'https://nodejs.org/dist/v22.23.2/SHASUMS256.txt');
});

test('启动器脚本：自己解软链、只用自带 node、不碰系统 node', () => {
  const shim = shimScript();
  // 装到 PATH 的是软链，$0 是软链自己的路径。不解引用就会把包根算到
  // ~/.local，然后「装好了但跑不通」——这条断言就是为了别再犯。
  assert.match(shim, /while \[ -L "\$target" \]/, '必须循环解软链');
  assert.match(shim, /readlink "\$target"/);
  assert.match(shim, /exec "\$DIR\/runtime\/bin\/node" "\$DIR\/app\/src\/cli\.js" "\$@"/);
  assert.equal(shim.includes('#!/bin/sh'), true, '用 sh 而不是 bash：别对壳做多余假设');
  assert.equal(/exec\s+node\b/.test(shim), false, '绝不能退回系统 node');
});

test('BUNDLE_INFO.json 带齐通道识别要用的字段', () => {
  const info = makeBundleInfo({
    version: '0.2.0-rc.1', arch: 'x64', sourceSha: 'abc', builtAt: '2026-08-21T00:00:00Z',
  });
  assert.deepEqual(info, {
    version: '0.2.0-rc.1',
    tag: 'v0.2.0-rc.1',
    platform: 'darwin',
    arch: 'x64',
    nodeVersion: NODE_RUNTIME_VERSION,
    sourceSha: 'abc',
    builtAt: '2026-08-21T00:00:00Z',
  });
});

test('packFileList：app/ 的内容就是打包白名单，混进 tests/ 要报错', () => {
  const ok = JSON.stringify([{ files: [...PACK_RULES.required, 'src/updater.js'].map((path_) => ({ path: path_ })) }]);
  assert.deepEqual(packFileList(ok), [...PACK_RULES.required, 'src/updater.js']);

  const leaky = JSON.stringify([{ files: [...PACK_RULES.required, 'tests/api.test.js'].map((p) => ({ path: p })) }]);
  assert.throws(() => packFileList(leaky), /混入了不该发的/);

  const short = JSON.stringify([{ files: PACK_RULES.required.filter((f) => f !== 'src/cli.js').map((p) => ({ path: p })) }]);
  assert.throws(() => packFileList(short), /缺文件/);

  assert.throws(() => packFileList('不是 json'), /无法解析/);
});

test('打包白名单含 scripts/install.mjs：发布包里要靠它摘链/装服务', () => {
  assert.ok(
    PACK_RULES.required.includes('scripts/install.mjs'),
    '安装规则只有一份，发布包必须带上它，否则卸载与 --service 在发布包安装下无从执行',
  );
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.ok(pkg.files.includes('scripts/install.mjs'), 'package.json 的 files 也要放它进来');
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

test('versionFromTag：认 refs/tags 前缀与预发布后缀，形状不对给 null', () => {
  assert.equal(versionFromTag('refs/tags/v0.1.0'), '0.1.0');
  assert.equal(versionFromTag('v1.2.30'), '1.2.30');
  assert.equal(versionFromTag('refs/tags/v0.2.0-rc.1'), '0.2.0-rc.1', '预发布 tag 要认');
  assert.equal(versionFromTag('0.1.0'), null, '少了 v 前缀不算');
  assert.equal(versionFromTag('v0.1'), null, '必须三段');
  assert.equal(versionFromTag('v0.1.0-'), null, '空的预发布后缀不算合法版本号');
  assert.equal(
    versionFromTag('v0.1.0+build.5'), null,
    'build 元数据不参与比较，放过去只会让守卫一莫名其妙地红',
  );
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
  assert.equal(pass.prerelease, false, '正式版不该被当成预发布');

  const partial = evaluateGuards({
    tag: 'v0.1.0', pkgVersion: '0.1.0', changelog,
  });
  assert.equal(partial.ok, true, '只给前两关的信息时（本地预检）不该因缺 sha 判红');
});

test('evaluateGuards：预发布不要求打在 release HEAD 上，但仍要求出自 main', () => {
  const changelog = '## [0.2.0-rc.1] - 2026-08-21\n\n### 新增\n- 试装\n';
  const rc = {
    tag: 'v0.2.0-rc.1',
    pkgVersion: '0.2.0-rc.1',
    changelog,
    tagSha: 'a'.repeat(40),
    // rc 不动稳定指针：release 分支还指着上一个正式版，这是**正常**状态
    releaseSha: 'b'.repeat(40),
    inMain: true,
  };

  const pass = evaluateGuards(rc);
  assert.equal(pass.ok, true, pass.problems.join('；'));
  assert.equal(pass.prerelease, true);
  assert.equal(pass.version, '0.2.0-rc.1');
  assert.match(pass.body, /试装/, 'rc 也得有 CHANGELOG 正文');

  assert.match(
    evaluateGuards({ ...rc, inMain: false }).problems.join(''),
    /不在 main 上/,
    'rc 也不许从野分支上凭空长出来',
  );
  assert.match(
    evaluateGuards({ ...rc, pkgVersion: '0.2.0' }).problems.join(''),
    /package\.json 的 version 是 0\.2\.0/,
    'rc 的版本号一致性一点不放松：0.2.0 与 0.2.0-rc.1 是两个版本',
  );

  // 反面：同样的 sha 错位，正式版必须红——别把豁免误伤到正式版上
  const asFinal = evaluateGuards({ ...rc, tag: 'v0.2.0', pkgVersion: '0.2.0', changelog: '## [0.2.0]\n\n- 正式\n' });
  assert.match(asFinal.problems.join(''), /正式版 tag 只许打在 release HEAD 上/);
});

/**
 * 回归（先红后绿）：rc.2 的验收里拿 `--version 0.1.9` 造旧包（package.json 当时是
 * 0.2.0-rc.2），装上后 `dshc version` 一行说 0.2.0-rc.2、一行说 v0.1.9——包里两处
 * 版本源对不上，拿到包的人无从判断自己装的是什么。
 */
test('resolveBuildVersion：版本只有一个源，点名不同的版本要拦住', () => {
  assert.equal(resolveBuildVersion({ requested: null, pkgVersion: '0.2.0-rc.2' }), '0.2.0-rc.2');
  assert.equal(
    resolveBuildVersion({ requested: '0.2.0-rc.2', pkgVersion: '0.2.0-rc.2' }), '0.2.0-rc.2',
    '复述同一个版本号是允许的（当核对用）',
  );
  assert.throws(
    () => resolveBuildVersion({ requested: '0.1.9', pkgVersion: '0.2.0-rc.2' }),
    /与 package\.json 的 0\.2\.0-rc\.2 不一致/,
    '这正是造出自相矛盾的包的那条路',
  );
  assert.throws(() => resolveBuildVersion({ requested: 'v0.1', pkgVersion: '0.2.0' }), /形状不对/);
  assert.throws(() => resolveBuildVersion({ requested: null, pkgVersion: 'nope' }), /package\.json 的版本号形状不对/);
});

/**
 * 回归（先红后绿）：v0.2.0-rc.1 那次发版，build 与 verify 全绿，最后一步
 * `gh release create` 死在 "fatal: not a git repository" ——release job 故意不
 * checkout（只要上游 artifact），而 gh 会去 .git 里推断仓库。这种错只在**真推 tag**
 * 时才暴露，是最贵的暴露位置，所以拿一条用例把它钉住。
 *
 * 判据用文本切 job 而不是解析 YAML（零依赖，没有 yaml parser）：按两空格缩进的
 * job 名切段，段内出现 `gh ` 命令的，必须要么自带 checkout，要么显式给 GH_REPO。
 */
test('管道断裂的码表：只吞这三个，真写失败照抛', () => {
  for (const code of ['EPIPE', 'ERR_STREAM_DESTROYED', 'ERR_STREAM_WRITE_AFTER_END']) {
    assert.equal(isBrokenPipe({ code }), true, code);
  }
  for (const err of [{ code: 'ENOSPC' }, { code: 'EACCES' }, new Error('无码'), null, undefined]) {
    assert.equal(isBrokenPipe(err), false, `不该吞：${err?.code ?? err}`);
  }
});

test('silenceBrokenPipe：EPIPE 不炸，其余仍然抛出去', () => {
  const stream = new EventEmitter();
  silenceBrokenPipe([stream]);
  stream.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
  assert.throws(
    () => stream.emit('error', Object.assign(new Error('磁盘满了'), { code: 'ENOSPC' })),
    /磁盘满了/,
  );
});

/**
 * required check 必须真能在 PR 上产生，否则合入会永久卡在「等一个永不到来的检查」。
 *
 * 这条判据是 CI 成本管控的安全带：PR 只跑 ubuntu、合入后才补 macOS，省下来的是
 * 每个 PR 两次 macOS。代价是矩阵与 ruleset 从此耦合——谁改矩阵不改 ruleset（或反之），
 * 后果不是 CI 变红而是 PR 合不进去，这种故障最难自证，所以钉在这里。
 *
 * 同样是文本判据（零依赖无 yaml parser）：只认两种矩阵形状，形状变了就红，
 * 逼人回来重新核对 required_status_checks。
 */
export function prMatrixOsList(chunk) {
  const line = /^\s*os:\s*(.+)$/m.exec(chunk)?.[1]?.trim() ?? '';
  // 形状 A：静态列表 `os: [a, b]` —— PR 上两个都跑
  if (line.startsWith('[')) return JSON.parse(line.replace(/'/g, '"'));
  // 形状 B：按事件分流的表达式 —— 取 pull_request 那一支
  const m = /event_name\s*==\s*'pull_request'\s*&&\s*fromJSON\('(\[[^']*\])'\)/.exec(line);
  return m ? JSON.parse(m[1]) : null;
}

test('required check 与 PR 上真会跑的矩阵一致（改一边忘另一边就红）', () => {
  const ruleset = JSON.parse(fs.readFileSync(path.join(ROOT, '.github', 'rulesets', 'main.json'), 'utf8'));
  const checks = ruleset.rules.find((r) => r.type === 'required_status_checks');
  const contexts = checks.parameters.required_status_checks.map((c) => c.context);
  assert.ok(contexts.length > 0, 'main 分支一个 required check 都没有，闸门等于没设');

  const text = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.match(text.slice(0, text.indexOf('jobs:')), /pull_request/, 'CI 必须在 PR 上触发');

  const osList = prMatrixOsList(text.slice(text.indexOf('\njobs:')));
  assert.ok(osList, 'ci.yml 的 os 矩阵不是已知形状，请回来核对 required_status_checks');
  assert.deepEqual(
    [...contexts].sort(),
    osList.map((o) => `check (${o})`).sort(),
    'required check 与 PR 上真会跑的 job 名对不上：合入会卡在等一个永不到来的检查',
  );
});

test('workflow 里用 gh 的 job：要么有 checkout，要么显式给 GH_REPO', () => {
  const dir = path.join(ROOT, '.github', 'workflows');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.yml'));
  assert.ok(files.length >= 2, `只找到 ${files.length} 个 workflow，判据恐怕在空转`);

  const problems = [];
  for (const file of files) {
    const text = fs.readFileSync(path.join(dir, file), 'utf8');
    const jobsAt = text.indexOf('\njobs:');
    if (jobsAt === -1) continue;

    // 段头 = 两空格缩进的键（jobs 下的 job 名）
    const body = text.slice(jobsAt);
    const heads = [...body.matchAll(/^ {2}([A-Za-z0-9_-]+):$/gm)];
    for (const [i, head] of heads.entries()) {
      const from = head.index;
      const to = i + 1 < heads.length ? heads[i + 1].index : body.length;
      const chunk = body.slice(from, to);
      if (!/(^|\s)gh\s+\w/.test(chunk)) continue;
      if (/actions\/checkout@/.test(chunk) || /GH_REPO:/.test(chunk)) continue;
      problems.push(`${file} 的 job「${head[1]}」跑了 gh 却既没 checkout 也没给 GH_REPO`);
    }
  }
  assert.deepEqual(problems, []);
});

/**
 * CI 上偶发「Chrome 未在 20s 内报出调试端口」判红，本机从不复现——共享 runner 的
 * 冷启动能被 IO 拖到二十几秒。放宽之外更要紧的是：超时消息必须把 Chrome 自己的
 * stderr 带出来，否则分不清是慢、是缺库、还是沙箱起不来（那三种处置完全不同）。
 */
/**
 * Chrome 起不来时，最有价值的信息在它自己的 stderr 里（缺库 / 沙箱 / 权限，
 * 三种处置完全不同）。这条用例走「说完就退」这条确定性路径：
 * 早先版本靠掐表等超时，全量并发跑时 spawn 自己就能吃掉那点预算，红得毫无信息量。
 */
test('launchChrome 失败：错误里带上 Chrome 自己的输出', async (t) => {
  const { launchChrome } = await import('../scripts/lib/browser.mjs');
  const fake = path.join(tmpdir(t), 'fake-chrome');
  fs.writeFileSync(fake, '#!/bin/sh\necho "libnss3.so: cannot open shared object file" >&2\nexit 127\n');
  fs.chmodSync(fake, 0o755);

  await assert.rejects(
    () => launchChrome({ env: { DSHC_CHROME: fake } }),
    (err) => {
      assert.match(err.message, /Chrome 退出（code 127）/, '该说清是退出了、退了几号');
      assert.match(err.message, /Chrome 说：/, '没把 Chrome 的自述带出来');
      assert.match(err.message, /libnss3/, '丢了真正有诊断价值的那一行');
      return true;
    },
  );
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
