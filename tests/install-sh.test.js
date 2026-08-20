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
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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
  return dir;
}

function runInstall(env, args = []) {
  return spawnSync('bash', [INSTALL_SH, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
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
  assert.equal(help.status, 0, '重跑之后入口仍要可用');
});

test('install.sh：安装脚本自带的卸载能把软链摘干净', { skip }, (t) => {
  const r = rig(t);
  assert.equal(runInstall(r.env, ['--prefix', r.prefix]).status, 0);
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

test('install.sh：node 版本过低时拦住，并说清要多少', { skip }, (t) => {
  const r = rig(t);
  const fakeBin = path.join(r.base, 'fakebin');
  fs.mkdirSync(fakeBin, { recursive: true });
  const fakeNode = path.join(fakeBin, 'node');
  fs.writeFileSync(fakeNode, '#!/bin/sh\necho v18.19.0\n');
  fs.chmodSync(fakeNode, 0o755);

  const res = runInstall({ ...r.env, PATH: `${fakeBin}:${process.env.PATH}` }, ['--prefix', r.prefix]);
  assert.notEqual(res.status, 0, '低版本 node 必须判失败');
  assert.match(res.stderr, /Node/);
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
