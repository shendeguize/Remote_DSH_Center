/**
 * 版本自证与自更新（`src/updater.js`）。
 *
 * 这条链路的失败方式都很难看：通道认错会动错目录，快进判据松了会把本地提交
 * 冲掉，校验和不核就等于让人装未经核对的二进制。所以三件事各有用例：
 * 通道识别、git 只快进、bundle 校验+原子换目录（含篡改产物必须被拒）。
 *
 * 全程不出网：假 Releases 服务在 127.0.0.1（tests/harness/fake-releases.js），
 * git 通道用临时目录里的本地仓库。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { BUNDLE_INFO_FILE, assetName } from '../src/lib/bundle.js';
import {
  chooseTarget, collectVersionInfo, downloadVerified, installBundle, resolveInstall,
  sha256, swapPaths, updateBundle, updateGit, usableReleases, DEFAULT_GIT_REF,
} from '../src/updater.js';
import { makeBundleTarball, startFakeReleases } from './harness/fake-releases.js';

function tmpdir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-updater-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** 造一个「仓库根」：有 package.json，可选 .git。 */
function makeRepoRoot(dir, { version = '0.1.0', git = false } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify({ name: 'dsh-center', version }, null, 2)}\n`);
  if (git) fs.mkdirSync(path.join(dir, '.git'));
  return dir;
}

/** 造一个 bundle 安装：<root>/BUNDLE_INFO.json + <root>/app/package.json。 */
function makeBundleInstall(root, { version = '0.1.0', arch = 'arm64' } = {}) {
  const app = makeRepoRoot(path.join(root, 'app'), { version });
  fs.writeFileSync(
    path.join(root, BUNDLE_INFO_FILE),
    `${JSON.stringify({ version, arch, tag: `v${version}`, nodeVersion: '22.0.0' }, null, 2)}\n`,
  );
  return { root, app };
}

// ── 通道识别 ─────────────────────────────────────────────────────────────

test('resolveInstall：git clone 认成 git 通道，root 就是仓库本身', (t) => {
  const dir = tmpdir(t);
  const repo = makeRepoRoot(path.join(dir, 'app'), { git: true });
  const got = resolveInstall(repo);
  assert.equal(got.channel, 'git');
  assert.equal(got.root, repo);
  assert.equal(got.bundleInfo, null);
});

test('resolveInstall：发布包认成 bundle 通道，root 上移到 bundle 根', (t) => {
  const dir = tmpdir(t);
  const { root, app } = makeBundleInstall(path.join(dir, 'app'), { version: '0.2.0-rc.1', arch: 'x64' });
  const got = resolveInstall(app);
  assert.equal(got.channel, 'bundle');
  assert.equal(got.root, root, 'bundle 通道要换的是整个 bundle 根，不是里面的 app/');
  assert.equal(got.repoRoot, app);
  assert.equal(got.bundleInfo.version, '0.2.0-rc.1');
  assert.equal(got.bundleInfo.arch, 'x64');
});

test('resolveInstall：两样都没有 → unknown，且说清缺什么（不猜一条试）', (t) => {
  const dir = tmpdir(t);
  const repo = makeRepoRoot(path.join(dir, 'app'));
  const got = resolveInstall(repo);
  assert.equal(got.channel, 'unknown');
  assert.match(got.reason, /\.git/);
  assert.match(got.reason, new RegExp(BUNDLE_INFO_FILE));
});

test('resolveInstall：BUNDLE_INFO.json 坏了算 unknown，不当成好包接着动', (t) => {
  const dir = tmpdir(t);
  const app = makeRepoRoot(path.join(dir, 'app'));
  fs.writeFileSync(path.join(dir, BUNDLE_INFO_FILE), '{ 这不是 json');
  const got = resolveInstall(app);
  assert.equal(got.channel, 'unknown');
  assert.match(got.reason, /读不出来/);
});

test('resolveInstall：躺在 node_modules 下认成 npm 通道（npm i -g 的落地形态）', (t) => {
  const dir = tmpdir(t);
  const repo = makeRepoRoot(path.join(dir, 'node_modules', 'remote-dsh-center'));
  const got = resolveInstall(repo);
  assert.equal(got.channel, 'npm');
  assert.equal(got.root, repo, 'npm 通道 root 就是包目录（只作展示，更新归 npm）');
  assert.equal(got.bundleInfo, null);
  assert.equal(got.reason, null);
});

test('resolveInstall：scoped 包多一层 @scope 目录也认成 npm 通道', (t) => {
  const dir = tmpdir(t);
  const repo = makeRepoRoot(path.join(dir, 'node_modules', '@shendeguize', 'remote-dsh-center'));
  assert.equal(resolveInstall(repo).channel, 'npm');

  // 反例钉死判据边界：上级像 @scope 但上上级不是 node_modules，不算 npm
  const notNpm = makeRepoRoot(path.join(dir, 'somewhere', '@shendeguize', 'remote-dsh-center'));
  assert.equal(resolveInstall(notNpm).channel, 'unknown');
});

test('resolveInstall：npm 判据不抢 bundle / git 的优先级', (t) => {
  const dir = tmpdir(t);

  // node_modules 里带 .git（npm i git+https 或有人 clone 进去）仍算 git——
  // .git 判定在前，这里把顺序钉死
  const gitRepo = makeRepoRoot(path.join(dir, 'node_modules', 'dsh-center'), { git: true });
  assert.equal(resolveInstall(gitRepo).channel, 'git');

  // 上层有 BUNDLE_INFO.json 时 bundle 判定最先，哪怕上层恰好叫 node_modules
  const { app } = makeBundleInstall(path.join(dir, 'b', 'node_modules'));
  assert.equal(resolveInstall(app).channel, 'bundle');
});

test('collectVersionInfo：npm 通道的自证文本给出 npm 更新指引', async (t) => {
  const dir = tmpdir(t);
  const repo = makeRepoRoot(path.join(dir, 'node_modules', '@shendeguize', 'remote-dsh-center'), { version: '0.3.0' });
  const info = await collectVersionInfo({ repoRoot: repo });
  assert.equal(info.channel, 'npm');
  assert.equal(info.version, '0.3.0');
  assert.match(info.channelDetail, /npm i -g @shendeguize\/remote-dsh-center@latest/, '人话里要带出更新的路');
  assert.equal(info.git, null, 'npm 通道不去采 git 事实');
});

/**
 * 真 CLI 在 npm 落地形态下的口径（M4 验收②）：把 src/ 整个摆进
 * <tmp>/node_modules/@shendeguize/remote-dsh-center/ 再 spawn，REPO_ROOT 由
 * cli.js 自身位置推导，不 mock。update 只指路（操作未执行 = 退 1），
 * version 自证 npm 通道（退 0）。
 */
test('npm 通道下的真 CLI：update 只指路退 1，version --json 自证 npm 通道退 0', (t) => {
  const dir = tmpdir(t);
  const repo = path.join(dir, 'node_modules', '@shendeguize', 'remote-dsh-center');
  fs.mkdirSync(repo, { recursive: true });
  fs.cpSync(fileURLToPath(new URL('../src', import.meta.url)), path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'package.json'), `${JSON.stringify({ name: '@shendeguize/remote-dsh-center', version: '9.9.9' }, null, 2)}\n`);
  const cli = path.join(repo, 'src', 'cli.js');
  const env = { ...process.env, DSHC_HOME: path.join(dir, 'home') };

  const update = spawnSync(process.execPath, [cli, 'update'], { env, encoding: 'utf8' });
  assert.equal(update.status, 1, `stdout=${update.stdout} stderr=${update.stderr}`);
  assert.match(update.stderr, /npm i -g @shendeguize\/remote-dsh-center@latest/, '要指出 npm 的更新命令');
  assert.match(update.stderr, /@shendeguize\/remote-dsh-center@next/, '跟预发布的路也要指出来');
  assert.equal(update.stdout, '', '没执行操作就不该在 stdout 冒充成功');

  const version = spawnSync(process.execPath, [cli, 'version', '--json'], { env, encoding: 'utf8' });
  assert.equal(version.status, 0, `stdout=${version.stdout} stderr=${version.stderr}`);
  const info = JSON.parse(version.stdout);
  assert.equal(info.channel, 'npm');
  assert.equal(info.version, '9.9.9');
});

test('collectVersionInfo：三种通道各自的自证文本', async (t) => {
  const dir = tmpdir(t);

  const bundle = makeBundleInstall(path.join(dir, 'b'), { version: '0.2.0-rc.1', arch: 'arm64' });
  const info = await collectVersionInfo({ repoRoot: bundle.app });
  assert.equal(info.version, '0.2.0-rc.1');
  assert.equal(info.channel, 'bundle');
  assert.match(info.channelDetail, /bundle v0\.2\.0-rc\.1（arm64）/);
  assert.equal(info.node.execPath, process.execPath, '运行时路径是 bundle 安装的自证，必须带出来');

  const plain = await collectVersionInfo({ repoRoot: makeRepoRoot(path.join(dir, 'p')) });
  assert.equal(plain.channel, 'unknown');
  assert.match(plain.channelDetail, /认不出/);

  // git 事实取不到时（没装 git / 不是仓库）不该炸，降级成一句话
  const fakeGit = makeRepoRoot(path.join(dir, 'g'), { git: true });
  const degraded = await collectVersionInfo({
    repoRoot: fakeGit,
    exec: async () => ({ code: 127, stdout: '', stderr: 'git: not found' }),
  });
  assert.equal(degraded.channel, 'git');
  assert.equal(degraded.git, null);
  assert.match(degraded.channelDetail, /取不到提交信息/);
});

// ── 目标版本决策 ─────────────────────────────────────────────────────────

test('usableReleases：draft 与非版本号 tag 一律滤掉，pre-release 打标', () => {
  const got = usableReleases([
    { tag_name: 'v0.1.0', assets: [{ name: 'a.tar.gz' }] },
    { tag_name: 'v0.2.0-rc.1', prerelease: true, assets: [] },
    { tag_name: 'v0.3.0', draft: true },
    { tag_name: 'nightly' },
    null,
  ]);
  assert.deepEqual(got.map((r) => r.tag), ['v0.1.0', 'v0.2.0-rc.1']);
  assert.equal(got[0].prerelease, false);
  assert.deepEqual(got[0].assets, ['a.tar.gz']);
  assert.equal(got[1].prerelease, true);
});

test('usableReleases：tag 带 rc 但 Release 没勾 prerelease，也按预发布算', () => {
  // 两个事实源（tag 形状 / Release 标记）只要有一个说是预发布就当预发布——
  // 宁可让稳定用户拿不到，也不能把 rc 推给没要 --pre 的人。
  const got = usableReleases([{ tag_name: 'v0.2.0-rc.1', prerelease: false }]);
  assert.equal(got[0].prerelease, true);
});

test('chooseTarget：稳定口径跳过 rc，--pre 才看得见', () => {
  const releases = usableReleases([
    { tag_name: 'v0.1.0' }, { tag_name: 'v0.2.0-rc.1', prerelease: true },
  ]);
  assert.equal(chooseTarget({ current: '0.1.0', releases }).action, 'up-to-date');
  const pre = chooseTarget({ current: '0.1.0', releases, includePrerelease: true });
  assert.equal(pre.action, 'update');
  assert.equal(pre.target.version, '0.2.0-rc.1');
});

test('chooseTarget：已是最新 / 更旧的远端都不动', () => {
  const releases = usableReleases([{ tag_name: 'v0.1.0' }]);
  assert.equal(chooseTarget({ current: '0.1.0', releases }).action, 'up-to-date');
  assert.equal(
    chooseTarget({ current: '0.2.0', releases }).action,
    'up-to-date',
    '本机比远端还新时也算「无需更新」，不静默降级',
  );
});

test('chooseTarget：本机装着预发布时，把更新的预发布报出来（正式版用户不受打扰）', () => {
  const releases = usableReleases([
    { tag_name: 'v0.1.0' },
    { tag_name: 'v0.2.0-rc.3', prerelease: true },
    { tag_name: 'v0.2.0-rc.4', prerelease: true },
  ]);

  const onRc = chooseTarget({ current: '0.2.0-rc.3', releases });
  assert.equal(onRc.action, 'up-to-date', '正式版 0.1.0 更旧，不降级');
  assert.equal(onRc.newerPrerelease, '0.2.0-rc.4', '跟着预发布的人得知道有新的 rc');

  const onFinal = chooseTarget({ current: '0.1.0', releases });
  assert.equal(onFinal.newerPrerelease, null, '装正式版的人不该被预发布打扰');

  const withPre = chooseTarget({ current: '0.2.0-rc.3', releases, includePrerelease: true });
  assert.equal(withPre.action, 'update', '--pre 本来就会去装，不需要再提示');
  assert.equal(withPre.newerPrerelease, null);

  const newest = chooseTarget({ current: '0.2.0-rc.4', releases });
  assert.equal(newest.newerPrerelease, null, '已经是最新的 rc 就别再提');
});

test('chooseTarget：点名 tag 绕过挑选；点不到给人话', () => {
  const releases = usableReleases([{ tag_name: 'v0.1.0' }, { tag_name: 'v0.2.0-rc.1', prerelease: true }]);
  const pinned = chooseTarget({ current: '0.2.0-rc.1', releases, pinned: 'v0.1.0' });
  assert.equal(pinned.action, 'update', '点名就照办，哪怕是往回装');
  assert.equal(pinned.target.tag, 'v0.1.0');

  const miss = chooseTarget({ current: '0.1.0', releases, pinned: 'v9.9.9' });
  assert.equal(miss.action, 'none');
  assert.match(miss.reason, /没有 v9\.9\.9/);
});

test('chooseTarget：一个 Release 都没有时说清怎么办', () => {
  const empty = chooseTarget({ current: '0.1.0', releases: [] });
  assert.equal(empty.action, 'none');
  assert.match(empty.reason, /--pre/, '只有 rc 的仓库要提示加 --pre');
  assert.match(chooseTarget({ current: null, releases: [], includePrerelease: true }).reason, /还没有任何 Release/);
});

test('swapPaths：只留一代 .prev', () => {
  assert.deepEqual(swapPaths('/x/app'), { root: '/x/app', staging: '/x/app.new', previous: '/x/app.prev' });
});

// ── git 通道 ────────────────────────────────────────────────────────────

/** 本地演练用的一对仓库：origin（有 release 分支）+ 按 install.sh 模型 clone 出的工作副本。 */
function makeGitPair(dir, { versions = ['0.1.0', '0.2.0'] } = {}) {
  const origin = path.join(dir, 'origin');
  makeRepoRoot(origin, { version: versions[0] });
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { stdio: 'pipe' });
  execFileSync('git', ['init', '-q', '-b', 'main', origin], { stdio: 'pipe' });
  git(origin, 'add', '-A');
  git(origin, 'commit', '-q', '-m', 'v1');
  git(origin, 'branch', DEFAULT_GIT_REF);

  const work = path.join(dir, 'app');
  execFileSync('git', ['clone', '-q', '--branch', DEFAULT_GIT_REF, origin, work], { stdio: 'pipe' });
  // install.sh 装出来的是 detached HEAD，更新逻辑必须在这个形态下成立
  execFileSync('git', ['-C', work, 'checkout', '-q', '--detach', 'HEAD'], { stdio: 'pipe' });

  return {
    origin,
    work,
    /** 在 origin 的 release 上再推一版（模拟上游发了新版本）。 */
    advance(version = versions[1]) {
      git(origin, 'checkout', '-q', DEFAULT_GIT_REF);
      fs.writeFileSync(path.join(origin, 'package.json'), `${JSON.stringify({ name: 'dsh-center', version }, null, 2)}\n`);
      git(origin, 'add', '-A');
      git(origin, 'commit', '-q', '-m', `v${version}`);
    },
  };
}

const gitSkip = process.platform === 'win32' ? 'git 演练只在 macOS / Linux 上跑' : false;

test('updateGit：已是最新时报 up-to-date，不动工作区', { skip: gitSkip }, (t) => {
  const pair = makeGitPair(tmpdir(t));
  return updateGit({ root: pair.work }).then((res) => {
    assert.equal(res.ok, true, res.problem);
    assert.equal(res.action, 'up-to-date');
    assert.equal(res.fromVersion, '0.1.0');
    assert.equal(res.from, res.to);
  });
});

test('updateGit：上游有新版本 → 快进，报出 版本 与 提交 双变化', { skip: gitSkip }, async (t) => {
  const pair = makeGitPair(tmpdir(t));
  pair.advance('0.2.0');

  const res = await updateGit({ root: pair.work });
  assert.equal(res.ok, true, res.problem);
  assert.equal(res.action, 'updated');
  assert.equal(res.fromVersion, '0.1.0');
  assert.equal(res.toVersion, '0.2.0', '快进后 package.json 必须真的是新版本');
  assert.notEqual(res.from, res.to);
  assert.equal(JSON.parse(fs.readFileSync(path.join(pair.work, 'package.json'), 'utf8')).version, '0.2.0');
});

test('updateGit：工作区脏就拒，且说清哪儿脏', { skip: gitSkip }, async (t) => {
  const pair = makeGitPair(tmpdir(t));
  pair.advance('0.2.0');
  fs.writeFileSync(path.join(pair.work, 'package.json'), '{"name":"dsh-center","version":"0.1.0","本地改动":true}');

  const res = await updateGit({ root: pair.work });
  assert.equal(res.ok, false);
  assert.match(res.problem, /未提交的改动/);
  assert.match(res.problem, /package\.json/, '要指出是哪个文件脏');
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(pair.work, 'package.json'), 'utf8')).本地改动,
    true,
    '拒了就一个字节都不能动',
  );
});

test('updateGit：目标不是当前提交的后代（非快进）→ 拒，不用 merge 糊过去', { skip: gitSkip }, async (t) => {
  const pair = makeGitPair(tmpdir(t));
  // 本地先自己前进一格：此时本地有 origin/release 没有的提交，快进不成立
  fs.writeFileSync(path.join(pair.work, 'extra.txt'), 'local\n');
  execFileSync('git', ['-C', pair.work, '-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A'], { stdio: 'pipe' });
  execFileSync('git', ['-C', pair.work, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'local'], { stdio: 'pipe' });
  pair.advance('0.2.0');

  const res = await updateGit({ root: pair.work });
  assert.equal(res.ok, false);
  assert.match(res.problem, /不是快进就不动/);
});

test('updateGit：ref 不存在时说清拉不到哪个', { skip: gitSkip }, async (t) => {
  const pair = makeGitPair(tmpdir(t));
  const res = await updateGit({ root: pair.work, ref: 'no-such-branch' });
  assert.equal(res.ok, false);
  assert.match(res.problem, /拉不到 origin\/no-such-branch/);
});

test('updateGit：根本不是 git 仓库时给人话，不抛栈', { skip: gitSkip }, async (t) => {
  const dir = tmpdir(t);
  const res = await updateGit({ root: makeRepoRoot(path.join(dir, 'plain')) });
  assert.equal(res.ok, false);
  assert.match(res.problem, /不像个能用的 git 仓库/);
});

// ── bundle 通道 ─────────────────────────────────────────────────────────

test('downloadVerified：校验和对得上才给字节', async (t) => {
  const dir = tmpdir(t);
  const server = await startFakeReleases([{ version: '0.2.0-rc.1', prerelease: true }], { workDir: dir });
  t.after(() => server.close());

  const name = assetName({ version: '0.2.0-rc.1', arch: 'arm64' });
  const bytes = await downloadVerified({
    assetUrl: server.assetUrlFor({ tag: 'v0.2.0-rc.1', name }),
    sumsUrl: server.sumsUrlFor({ tag: 'v0.2.0-rc.1' }),
    name,
  });
  assert.ok(bytes.length > 0);
  assert.match(sha256(bytes), /^[0-9a-f]{64}$/);
});

test('downloadVerified：产物被篡改（校验和不符）一律拒收', async (t) => {
  const dir = tmpdir(t);
  const server = await startFakeReleases(
    [{ version: '0.2.0', corrupt: true }],
    { workDir: dir },
  );
  t.after(() => server.close());

  const name = assetName({ version: '0.2.0', arch: 'arm64' });
  await assert.rejects(
    downloadVerified({
      assetUrl: server.assetUrlFor({ tag: 'v0.2.0', name }),
      sumsUrl: server.sumsUrlFor({ tag: 'v0.2.0' }),
      name,
    }),
    /校验和不符/,
  );
});

test('downloadVerified：SHA256SUMS 里没这个文件名也不装', async (t) => {
  const dir = tmpdir(t);
  const server = await startFakeReleases([{ version: '0.2.0' }], { workDir: dir });
  t.after(() => server.close());

  await assert.rejects(
    downloadVerified({
      assetUrl: server.assetUrlFor({ tag: 'v0.2.0', name: assetName({ version: '0.2.0', arch: 'arm64' }) }),
      sumsUrl: server.sumsUrlFor({ tag: 'v0.2.0' }),
      name: 'dsh-center-v0.2.0-darwin-x64.tar.gz',
    }),
    /没有 .* 的校验和/,
  );
});

test('downloadVerified：HTTP 不是 200 时报清楚是哪个 URL', async (t) => {
  const dir = tmpdir(t);
  const server = await startFakeReleases([{ version: '0.2.0' }], { workDir: dir });
  t.after(() => server.close());

  await assert.rejects(
    downloadVerified({
      assetUrl: server.assetUrlFor({ tag: 'v0.2.0', name: 'x' }),
      sumsUrl: server.sumsUrlFor({ tag: 'v9.9.9' }),
      name: 'x',
    }),
    /HTTP 404/,
  );
});

test('installBundle：解包 → 原子换目录，旧安装留在 .prev', async (t) => {
  const dir = tmpdir(t);
  const install = makeBundleInstall(path.join(dir, 'app'), { version: '0.1.0' });
  fs.writeFileSync(path.join(install.root, '记号'), '旧安装\n');

  const built = makeBundleTarball({ version: '0.2.0', arch: 'arm64', workDir: dir });
  const tarball = path.join(dir, built.name);
  fs.writeFileSync(tarball, built.bytes);

  const { previous } = await installBundle({
    root: install.root, tarball, version: '0.2.0', arch: 'arm64',
  });

  const info = JSON.parse(fs.readFileSync(path.join(install.root, BUNDLE_INFO_FILE), 'utf8'));
  assert.equal(info.version, '0.2.0', '换完 root 里应是新版本');
  assert.ok(fs.existsSync(path.join(install.root, 'bin', 'dshc')), 'shim 要在位');
  assert.ok(fs.existsSync(path.join(install.root, 'runtime', 'bin', 'node')), '自带运行时要在位');
  assert.ok(fs.existsSync(path.join(previous, '记号')), '旧安装应完整留在 .prev，能手动换回来');
  assert.equal(fs.existsSync(swapPaths(install.root).staging), false, '临时目录要清掉');
});

test('installBundle：包里没有 BUNDLE_INFO.json 就不换，原安装一个字节不动', async (t) => {
  const dir = tmpdir(t);
  const install = makeBundleInstall(path.join(dir, 'app'), { version: '0.1.0' });

  // 造一个结构不对的 tar：顶层目录里没有 BUNDLE_INFO.json
  const stage = path.join(dir, 'bad');
  fs.mkdirSync(path.join(stage, 'dsh-center-v0.2.0-darwin-arm64'), { recursive: true });
  fs.writeFileSync(path.join(stage, 'dsh-center-v0.2.0-darwin-arm64', 'x'), '');
  const tarball = path.join(dir, 'bad.tar.gz');
  execFileSync('tar', ['-czf', tarball, '-C', stage, 'dsh-center-v0.2.0-darwin-arm64']);

  await assert.rejects(
    installBundle({ root: install.root, tarball, version: '0.2.0', arch: 'arm64' }),
    /不像发布包/,
  );
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(install.root, BUNDLE_INFO_FILE), 'utf8')).version,
    '0.1.0',
    '拒了之后原安装必须还是原样',
  );
});

test('updateBundle：查 → 比 → 下 → 校 → 换，全程走通', async (t) => {
  const dir = tmpdir(t);
  const install = makeBundleInstall(path.join(dir, 'app'), { version: '0.1.0', arch: 'arm64' });
  const server = await startFakeReleases([
    { version: '0.1.0' },
    { version: '0.2.0-rc.1', prerelease: true },
  ], { workDir: dir });
  t.after(() => server.close());

  const stable = await updateBundle({
    root: install.root,
    bundleInfo: { version: '0.1.0', arch: 'arm64' },
    releasesUrl: server.releasesUrl,
    assetUrlFor: server.assetUrlFor,
    sumsUrlFor: server.sumsUrlFor,
    tmpDir: dir,
  });
  assert.equal(stable.action, 'up-to-date', '稳定口径下 rc 不该被装上');

  const pre = await updateBundle({
    root: install.root,
    bundleInfo: { version: '0.1.0', arch: 'arm64' },
    releasesUrl: server.releasesUrl,
    assetUrlFor: server.assetUrlFor,
    sumsUrlFor: server.sumsUrlFor,
    includePrerelease: true,
    tmpDir: dir,
  });
  assert.equal(pre.action, 'updated');
  assert.equal(pre.from, '0.1.0');
  assert.equal(pre.to, '0.2.0-rc.1');
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(install.root, BUNDLE_INFO_FILE), 'utf8')).version,
    '0.2.0-rc.1',
  );
});

test('updateBundle：目标 Release 没有本架构产物时说清有哪些', async (t) => {
  const dir = tmpdir(t);
  const install = makeBundleInstall(path.join(dir, 'app'), { version: '0.1.0', arch: 'x64' });
  // 服务端只挂 arm64 的产物
  const server = await startFakeReleases([{ version: '0.2.0', arch: 'arm64' }], { workDir: dir });
  t.after(() => server.close());

  await assert.rejects(
    updateBundle({
      root: install.root,
      bundleInfo: { version: '0.1.0', arch: 'x64' },
      releasesUrl: server.releasesUrl,
      assetUrlFor: server.assetUrlFor,
      sumsUrlFor: server.sumsUrlFor,
      tmpDir: dir,
    }),
    /没有 x64 的产物/,
  );
});

test('updateBundle：架构不认识时先拦住，不去下载', async (t) => {
  const dir = tmpdir(t);
  const install = makeBundleInstall(path.join(dir, 'app'));
  const server = await startFakeReleases([{ version: '0.2.0' }], { workDir: dir });
  t.after(() => server.close());

  await assert.rejects(
    updateBundle({
      root: install.root,
      bundleInfo: { version: '0.1.0', arch: 'riscv64' },
      releasesUrl: server.releasesUrl,
      assetUrlFor: server.assetUrlFor,
      sumsUrlFor: server.sumsUrlFor,
      tmpDir: dir,
    }),
    /不支持的 CPU 架构 riscv64/,
  );
  assert.deepEqual(server.hits, [], '连列表都不该请求');
});

test('updateBundle：篡改过的产物 → 拒装且原安装完好（PV-12）', async (t) => {
  const dir = tmpdir(t);
  const install = makeBundleInstall(path.join(dir, 'app'), { version: '0.1.0' });
  const server = await startFakeReleases([{ version: '0.2.0', corrupt: true }], { workDir: dir });
  t.after(() => server.close());

  await assert.rejects(
    updateBundle({
      root: install.root,
      bundleInfo: { version: '0.1.0', arch: 'arm64' },
      releasesUrl: server.releasesUrl,
      assetUrlFor: server.assetUrlFor,
      sumsUrlFor: server.sumsUrlFor,
      tmpDir: dir,
    }),
    /校验和不符/,
  );
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(install.root, BUNDLE_INFO_FILE), 'utf8')).version,
    '0.1.0',
  );
  assert.equal(fs.existsSync(swapPaths(install.root).previous), false, '没换成就不该留 .prev');
});
