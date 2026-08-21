/**
 * install.sh 的端到端测试（PG-11）。
 *
 * 这条链路没法用单元测试糊过去：它的价值全在「干净机器上 curl | bash 真的能用」，
 * 而失败方式是静默的——软链指错、node 版本没拦住、重跑把已有安装搞坏。
 *
 * 不出网：临时目录里 git init 一个「源仓库」（只放安装真正需要的文件），
 * 用 DSHC_REPO_URL 注入进去。HOME / DSHC_HOME / 软链前缀全部指向临时目录，
 * 所以跑测试不会碰到开发机上真实的 ~/.dsh_center 与 ~/.local/bin。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { startFakeReleases } from './harness/fake-releases.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INSTALL_SH = path.join(ROOT, 'install.sh');

/** Windows 上没有 bash，整个文件跳过（本项目只支持 macOS / Linux）。 */
const skip = process.platform === 'win32' ? 'install.sh 只在 macOS / Linux 上有意义' : false;

/** 安装真正需要的最小文件集：CLI 入口 + 它的依赖 + 安装脚本。 */
function makeOriginRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  for (const rel of ['src', 'scripts']) {
    fs.cpSync(path.join(ROOT, rel), path.join(dir, rel), { recursive: true });
  }
  for (const rel of ['package.json', 'LICENSE']) {
    fs.copyFileSync(path.join(ROOT, rel), path.join(dir, rel));
  }
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' });
  execFileSync('git', ['init', '-b', 'main', dir], { stdio: 'pipe' });
  git('add', '-A');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'seed');
  // 真仓库有 main 与 release 两条分支，装的默认是 release。
  // release 先分出去，再让 main 往前走一格：两条分支必须指向**不同**提交，
  // 否则「默认装的是哪条」这件事在测试里根本无从分辨（曾经就是这样空过的）。
  git('branch', 'release');
  fs.writeFileSync(path.join(dir, 'MAIN_ONLY'), 'main 独有\n');
  git('add', '-A');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'main moves on');
  return dir;
}

function runInstall(env, args = []) {
  return spawnSync('bash', [INSTALL_SH, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

/** 装一遍并要求成功。装不上时把两路输出都摊出来——CI 上没有第二次现场。 */
function installOk(env, args = [], label = '安装') {
  const res = runInstall(env, args);
  assert.equal(res.status, 0, `${label}失败（退出码 ${res.status}）：\n${res.stdout}\n${res.stderr}`);
  return res;
}

/**
 * 假 Releases 服务跑在**本进程**里，所以碰它的安装必须用异步 spawn：
 * spawnSync 会堵住事件循环，install.sh 里的 curl 永远等不到应答（死锁）。
 */
function runInstallAsync(env, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', [INSTALL_SH, ...args], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

function rig(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-install-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const home = path.join(base, 'home');
  const prefix = path.join(base, 'bin');
  const appDir = path.join(home, '.dsh_center', 'app');
  fs.mkdirSync(home, { recursive: true });
  const origin = makeOriginRepo(path.join(base, 'origin'));
  return {
    base,
    home,
    prefix,
    appDir,
    origin,
    env: {
      HOME: home,
      DSHC_HOME: path.join(home, '.dsh_center'),
      DSHC_APP_DIR: appDir,
      DSHC_REPO_URL: origin,
      DSHC_REF: 'main',
    },
  };
}

test('install.sh：不指定 DSHC_REF 时装的是 release 分支', { skip }, (t) => {
  // 默认渠道是承重的：默认值被改成不存在的分支，所有新装当场失败，
  // 而开发机上谁都不会注意到（大家都显式指定 ref）。
  const r = rig(t);
  const { DSHC_REF: _omitted, ...envWithoutRef } = r.env;
  const res = runInstall(envWithoutRef, ['--prefix', r.prefix]);

  assert.equal(res.status, 0, res.stderr);
  // 装出来的提交必须是 release 那一格，而不是 main 独有的那一格
  assert.equal(
    fs.existsSync(path.join(r.appDir, 'MAIN_ONLY')),
    false,
    '装到了 main：默认 ref 应该是 release',
  );
  const contains = execFileSync('git', ['-C', r.appDir, 'branch', '-a', '--contains', 'HEAD'], { encoding: 'utf8' });
  assert.match(contains, /release/, `装出来的 checkout 应落在 release 上，实际：${contains}`);
});

test('install.sh：显式 DSHC_REF=main 时装的是 main（默认值的对照组）', { skip }, (t) => {
  const r = rig(t);
  installOk(r.env, ['--prefix', r.prefix]);
  assert.ok(
    fs.existsSync(path.join(r.appDir, 'MAIN_ONLY')),
    '指定 main 就该装 main——这条是上一条用例的对照组，两条一起才证明默认值真的生效',
  );
});

test('install.sh：clone → 软链 dshc → 装出来的入口真能跑', { skip }, (t) => {
  const r = rig(t);
  const res = runInstall(r.env, ['--prefix', r.prefix]);
  assert.equal(res.status, 0, `安装失败：\n${res.stdout}\n${res.stderr}`);

  const link = path.join(r.prefix, 'dshc');
  assert.ok(fs.existsSync(link), 'dshc 软链没建出来');
  assert.ok(fs.lstatSync(link).isSymbolicLink(), '应该是软链（这样 git pull 就等于升级）');
  assert.equal(fs.realpathSync(link), fs.realpathSync(path.join(r.appDir, 'src', 'cli.js')));

  const help = spawnSync(link, ['--help'], { encoding: 'utf8', env: { ...process.env, ...r.env } });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /dshc/);

  // 装完必须把「下一步做什么」说清楚，否则用户装完就卡住
  assert.match(res.stdout, /dshc init/);
  assert.match(res.stdout, /dshc up/);
  assert.match(res.stdout, /dshc open/);

  // 但只许说一遍：install.mjs 与 install.sh 各印一份收尾，叠起来啰嗦且说法不一（issue #17）
  const nextSteps = res.stdout.match(/下一步/g) ?? [];
  assert.equal(nextSteps.length, 1, `「下一步」出现了 ${nextSteps.length} 次：\n${res.stdout}`);
});

/**
 * 回归（issue #16）：下游提前关掉管道时，install.mjs 曾把 EPIPE 抛成未捕获异常，
 * 刷一屏 Node 栈——而软链早在报错前就建好了，看到栈的人只会以为装坏了。
 *
 * `| true` 让读端立刻关闭，写第一行就必然撞上 EPIPE，不依赖时序。
 */
test('install.mjs：stdout 被提前关掉不抛栈，且该建的软链照建', { skip }, (t) => {
  const r = rig(t);
  installOk(r.env, ['--prefix', r.prefix], '前置：先正常装一遍');

  const installer = path.join(r.appDir, 'scripts', 'install.mjs');
  const res = spawnSync('sh', ['-c', `"${process.execPath}" "${installer}" --prefix "${r.prefix}" | true`], {
    encoding: 'utf8',
    env: { ...process.env, ...r.env },
  });

  assert.doesNotMatch(res.stderr, /EPIPE/, `管道断裂被抛成异常了：\n${res.stderr}`);
  assert.doesNotMatch(res.stderr, /Unhandled 'error' event/, res.stderr);
  assert.equal(res.status, 0, `退出码 ${res.status}：\n${res.stderr}`);
  assert.ok(fs.existsSync(path.join(r.prefix, 'dshc')), '断了管道也得把活干完');
});

test('install.sh：重跑幂等 —— 第二次走更新路径，软链照旧可用', { skip }, (t) => {
  const r = rig(t);
  const first = runInstall(r.env, ['--prefix', r.prefix]);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /clone 到/);

  const second = runInstall(r.env, ['--prefix', r.prefix]);
  assert.equal(second.status, 0, `重跑失败：\n${second.stdout}\n${second.stderr}`);
  assert.match(second.stdout, /改为更新/, '第二次应识别出已有 clone 并走 pull');

  const link = path.join(r.prefix, 'dshc');
  assert.equal(fs.realpathSync(link), fs.realpathSync(path.join(r.appDir, 'src', 'cli.js')));
  const help = spawnSync(link, ['--help'], { encoding: 'utf8', env: { ...process.env, ...r.env } });
  assert.equal(help.status, 0, `重跑之后入口仍要可用：\n${help.stdout}\n${help.stderr}`);
});

test('install.sh：安装脚本自带的卸载能把软链摘干净', { skip }, (t) => {
  const r = rig(t);
  installOk(r.env, ['--prefix', r.prefix]);
  const link = path.join(r.prefix, 'dshc');
  assert.ok(fs.existsSync(link), '先得真装上，否则这条用例会空过');

  const un = spawnSync(
    process.execPath,
    [path.join(r.appDir, 'scripts', 'install.mjs'), '--uninstall', '--prefix', r.prefix],
    { encoding: 'utf8', env: { ...process.env, ...r.env } },
  );
  assert.equal(un.status, 0, un.stderr);
  assert.equal(fs.existsSync(link), false, '卸载后软链应消失');
});

/** PATH 里放一个假的低版本 node（模拟「机器上有 node，但太老」）。 */
function fakeLowNode(base) {
  const dir = path.join(base, 'fakebin');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'node'), '#!/bin/sh\necho v18.19.0\n');
  fs.chmodSync(path.join(dir, 'node'), 0o755);
  return dir;
}

test('install.sh --git：node 版本过低时拦住，并说清要多少', { skip }, (t) => {
  // 显式 --git 的语义是「就走 git 通道」，所以过低就该拦住，而不是偷偷换通道。
  // （不带 --git 时会自动降级走发布包通道，另有用例覆盖。）
  const r = rig(t);
  const res = runInstall(
    { ...r.env, PATH: `${fakeLowNode(r.base)}:${process.env.PATH}` },
    ['--git', '--prefix', r.prefix],
  );
  assert.notEqual(res.status, 0, '低版本 node 必须判失败');
  assert.match(res.stderr, /node/);
  assert.match(res.stderr, /22/);
  assert.equal(fs.existsSync(r.appDir), false, '拦住了就不该已经 clone 下来');
});

test('install.sh：缺 git 时说清缺的是 git', { skip }, (t) => {
  const r = rig(t);
  // 只留 node 与基础 shell 工具，PATH 里没有 git
  const stub = path.join(r.base, 'stub');
  fs.mkdirSync(stub, { recursive: true });
  for (const tool of ['bash', 'node', 'uname', 'awk', 'ls', 'mkdir', 'rm', 'dirname']) {
    const found = spawnSync('command', ['-v', tool], { shell: true, encoding: 'utf8' }).stdout.trim();
    if (found) fs.symlinkSync(found, path.join(stub, tool));
  }

  const res = runInstall({ ...r.env, PATH: stub }, ['--prefix', r.prefix]);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /git/);
});

test('install.sh：不认识的旗标当场报用法错误，不按别的意思照做', { skip }, (t) => {
  // 拼错 --standalone 写成 --no-git 的人，本意是「别走 git」，静默忽略的后果是
  // 他拿到 release 分支上的旧版本，还以为 --pre 生效了（issue #55）。
  const r = rig(t);
  const res = runInstall(r.env, ['--no-git', '--prefix', r.prefix]);
  assert.equal(res.status, 3, `用法错误该退 3，实得 ${res.status}；${res.stderr}`);
  assert.match(res.stderr, /--no-git/, '要指出是哪个旗标');
  assert.match(res.stderr, /--standalone|可用|支持/, '要给出可用的写法');
  assert.equal(fs.existsSync(r.appDir), false, '拦住了就不该已经装起来');
});

test('install.mjs：不认识的旗标也拦（它才是最终解析处）', { skip }, (t) => {
  const r = rig(t);
  const res = spawnSync(process.execPath, [
    path.join(ROOT, 'scripts', 'install.mjs'), '--prefix', r.prefix, '--srevice',
  ], { encoding: 'utf8', env: r.env });
  assert.equal(res.status, 3, `实得 ${res.status}；${res.stderr}`);
  assert.match(res.stderr, /--srevice/);
});

// ── standalone（发布包）通道 ─────────────────────────────────────────────
//
// 这条通道的全部价值在「没有 node 的机器上一条命令能装上并跑起来」。
// 所以假 Releases 服务挂的是**真能跑**的包：app/ 是真 src，runtime/bin/node 转发到
// 本机真 node。这样「装完 dshc --help 有输出」是真跑出来的，不是假的。
// 仅 macOS：install.sh 的 standalone 只发 mac（Linux 要求自带 node）。

const standaloneSkip = process.platform !== 'darwin'
  ? 'standalone 通道只发 macOS（Linux 走 git 通道）'
  : skip;

async function releaseRig(t, releases) {
  const r = rig(t);
  const server = await startFakeReleases(releases, {
    workDir: r.base,
    appSource: ROOT,
    nodeExec: process.execPath,
  });
  t.after(() => server.close());
  return {
    ...r,
    server,
    env: {
      ...r.env,
      DSHC_API_BASE: server.base,
      DSHC_RELEASE_BASE: `${server.base}/download`,
    },
  };
}

test('install.sh --standalone：下载 → 校验 → 解包 → 软链指启动器 → 真能跑', { skip: standaloneSkip }, async (t) => {
  const r = await releaseRig(t, [{ version: '0.9.0', arch: process.arch === 'arm64' ? 'arm64' : 'x64' }]);
  const res = await runInstallAsync(r.env, ['--standalone', '--prefix', r.prefix]);

  assert.equal(res.status, 0, `安装失败：\n${res.stdout}\n${res.stderr}`);
  assert.match(res.stdout, /校验和通过/, '必须核对过校验和才算装');
  assert.ok(fs.existsSync(path.join(r.appDir, 'BUNDLE_INFO.json')), '发布包标记应在位');
  assert.ok(fs.existsSync(path.join(r.appDir, 'runtime', 'bin', 'node')), '自带运行时应在位');

  // 软链必须指启动器，而不是 app/src/cli.js——装的人可能压根没装 node
  const link = path.join(r.prefix, 'dshc');
  assert.equal(fs.realpathSync(link), fs.realpathSync(path.join(r.appDir, 'bin', 'dshc')));

  const help = spawnSync(link, ['--help'], { encoding: 'utf8', env: { ...process.env, ...r.env } });
  assert.equal(help.status, 0, `经软链 → 启动器 → 自带 node 这条链要真能跑：${help.stderr}`);
  assert.match(help.stdout, /dshc/);

  const version = spawnSync(link, ['version', '--json'], { encoding: 'utf8', env: { ...process.env, ...r.env } });
  assert.equal(version.status, 0, version.stderr);
  const info = JSON.parse(version.stdout);
  assert.equal(info.channel, 'bundle', 'dshc version 必须自证是发布包通道');
  assert.equal(info.version, '0.9.0');
});

/**
 * 造一个「只有基础工具、没有 node」的 PATH——即干净 mac 的处境。
 * `readlink` / `dirname` 是启动器解软链要用的，别漏（漏了表现是装完跑不起来）。
 */
function stubPathWithoutNode(base) {
  const stub = path.join(base, 'nonode');
  fs.mkdirSync(stub, { recursive: true });
  const tools = ['bash', 'sh', 'uname', 'curl', 'shasum', 'tar', 'mktemp', 'sed', 'head',
    'grep', 'awk', 'ls', 'mkdir', 'rm', 'mv', 'dirname', 'readlink', 'xattr', 'chmod'];
  for (const tool of tools) {
    const found = spawnSync('command', ['-v', tool], { shell: true, encoding: 'utf8' }).stdout.trim();
    if (found && found.startsWith('/')) {
      try { fs.symlinkSync(found, path.join(stub, tool)); } catch { /* 重名跳过 */ }
    }
  }
  return stub;
}

test('install.sh：没有 node 时自动降级走发布包通道（PV-2 的可自动化部分）', { skip: standaloneSkip }, async (t) => {
  const r = await releaseRig(t, [{ version: '0.9.0', arch: process.arch === 'arm64' ? 'arm64' : 'x64' }]);
  const stub = stubPathWithoutNode(r.base);

  const res = await runInstallAsync({ ...r.env, PATH: stub }, ['--prefix', r.prefix]);
  assert.equal(res.status, 0, `没 node 也该装得上：\n${res.stdout}\n${res.stderr}`);
  assert.match(res.stdout, /没找到 node/, '要说清为什么改走发布包通道');
  assert.ok(fs.existsSync(path.join(r.appDir, 'BUNDLE_INFO.json')));

  // 装完之后，即使 PATH 里仍然没有 node，dshc 也必须能跑（靠自带运行时）
  const help = spawnSync(path.join(r.prefix, 'dshc'), ['--help'], {
    encoding: 'utf8',
    env: { ...process.env, ...r.env, PATH: stub },
  });
  assert.equal(help.status, 0, `自带运行时必须让 dshc 在无 node 环境下可用：${help.stderr}`);
});

test('install.sh：node 过低时也自动降级，且不动本机那个 node', { skip: standaloneSkip }, async (t) => {
  const r = await releaseRig(t, [{ version: '0.9.0', arch: process.arch === 'arm64' ? 'arm64' : 'x64' }]);
  const res = await runInstallAsync(
    { ...r.env, PATH: `${fakeLowNode(r.base)}:${stubPathWithoutNode(r.base)}` },
    ['--prefix', r.prefix],
  );

  assert.equal(res.status, 0, `${res.stdout}\n${res.stderr}`);
  assert.match(res.stdout, /v18\.19\.0 低于 22/, '要说清是因为版本过低才换通道');
  assert.match(res.stdout, /不动你的 node/, '不该让人以为我们会去改他的 node');
  assert.ok(fs.existsSync(path.join(r.appDir, 'runtime', 'bin', 'node')), '装的是自带运行时');
});

test('install.sh --standalone：校验和不符时拒装，且不留半个目录', { skip: standaloneSkip }, async (t) => {
  const r = await releaseRig(t, [
    { version: '0.9.0', arch: process.arch === 'arm64' ? 'arm64' : 'x64', corrupt: true },
  ]);
  const res = await runInstallAsync(r.env, ['--standalone', '--prefix', r.prefix]);

  assert.notEqual(res.status, 0, '校验和不符必须判失败');
  assert.match(res.stderr, /校验和不符/);
  assert.equal(fs.existsSync(r.appDir), false, '拒了就不该留下半个安装');
  assert.equal(fs.existsSync(path.join(r.prefix, 'dshc')), false);
});

test('install.sh --standalone：稳定口径看不见 pre-release，--pre 才装得上', { skip: standaloneSkip }, async (t) => {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const r = await releaseRig(t, [{ version: '0.9.0-rc.1', arch, prerelease: true }]);

  const stable = await runInstallAsync(r.env, ['--standalone', '--prefix', r.prefix]);
  assert.notEqual(stable.status, 0, '只有 rc 时稳定口径应查不到可装版本');
  assert.match(stable.stderr, /--pre/, '要告诉人加 --pre');

  const pre = await runInstallAsync(r.env, ['--standalone', '--pre', '--prefix', r.prefix]);
  assert.equal(pre.status, 0, `--pre 应该装得上：\n${pre.stdout}\n${pre.stderr}`);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(r.appDir, 'BUNDLE_INFO.json'), 'utf8')).version,
    '0.9.0-rc.1',
  );
});

test('install.sh --standalone：重跑升级，旧安装留在 app.prev', { skip: standaloneSkip }, async (t) => {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const r = await releaseRig(t, [{ version: '0.9.0', arch }, { version: '0.9.1', arch }]);

  const first = await runInstallAsync(r.env, ['--standalone', '--version', 'v0.9.0', '--prefix', r.prefix]);
  assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);
  assert.equal(JSON.parse(fs.readFileSync(path.join(r.appDir, 'BUNDLE_INFO.json'), 'utf8')).version, '0.9.0');

  const second = await runInstallAsync(r.env, ['--standalone', '--prefix', r.prefix]);
  assert.equal(second.status, 0, `${second.stdout}\n${second.stderr}`);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(r.appDir, 'BUNDLE_INFO.json'), 'utf8')).version,
    '0.9.1',
    '不点名时应取 latest（跳过 pre-release）',
  );
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(`${r.appDir}.prev`, 'BUNDLE_INFO.json'), 'utf8')).version,
    '0.9.0',
    '上一版要留着可回滚',
  );
});

test('install.sh --standalone：撞上 git 安装时拒绝，不悄悄换通道', { skip: standaloneSkip }, async (t) => {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const r = await releaseRig(t, [{ version: '0.9.0', arch }]);
  // 先按 git 通道装一遍
  const seeded = await runInstallAsync(r.env, ['--git', '--prefix', r.prefix]);
  assert.equal(seeded.status, 0, `${seeded.stdout}\n${seeded.stderr}`);

  const res = await runInstallAsync(r.env, ['--standalone', '--prefix', r.prefix]);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /git clone/);
  assert.ok(fs.existsSync(path.join(r.appDir, '.git')), '原 git 安装必须完好');
});

test('install.sh --git：缺 node 时不降级，直接说清并指路', { skip }, async (t) => {
  const r = rig(t);
  const stub = path.join(r.base, 'nonode');
  fs.mkdirSync(stub, { recursive: true });
  for (const tool of ['bash', 'uname', 'git', 'awk', 'ls', 'mkdir', 'rm', 'dirname']) {
    const found = spawnSync('command', ['-v', tool], { shell: true, encoding: 'utf8' }).stdout.trim();
    if (found && found.startsWith('/')) {
      try { fs.symlinkSync(found, path.join(stub, tool)); } catch { /* 重名跳过 */ }
    }
  }

  const res = await runInstallAsync({ ...r.env, PATH: stub }, ['--git', '--prefix', r.prefix]);
  assert.notEqual(res.status, 0, '显式 --git 就不该偷偷降级');
  assert.match(res.stderr, /node/);
  assert.equal(fs.existsSync(r.appDir), false, '拦住了就不该已经 clone 下来');
});
