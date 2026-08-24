#!/usr/bin/env node
/**
 * 插件安装冒烟：把刚发的 npm 包真装一遍（或解开本地 npm pack 产物），
 * 核对「装出去以后还能不能用」的最低事实：
 *
 *   lib/index.js 与 lib/client.js 都在（双半区预构建产物齐，免 allowBuilds）
 *   lib/client.js 含 __ModuleLoader__.load（lazy-CJS factory 指纹——缺它 dsh web
 *     装得上也载不动 browser 半区）
 *   package.json 的 dsh manifest 三件套齐：dsh.engines.dsh / dsh.bundle.patch / dsh.client
 *   cordis.patch.yml 真在包里（`dsh plugin add` 据它叠 bundle layer，缺它不可安装）
 *
 * 两种模式（二选一）：
 *   --version <ver>    从 registry 装 <包名>@<ver> 进临时目录——plugin-publish.yml 的
 *                      smoke job 用；npm install 失败重试 ≤2 次（刚发的包 registry
 *                      同步可能有延迟），每次间隔 10s，绝不无限重试
 *   --tarball <path>   解开本地 npm pack 的 tar.gz 做同样断言（发布前预检、单测用）
 *
 * 插件包名运行期读 plugin/package.json——插件的事实只有一个源，这里不抄第二份。
 * 临时目录无论成败都清理。退出码：0 通过 / 1 断言不过 / 2 安装（网络）失败 / 3 用法错误。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { isMainEntry } from '../src/lib/entry.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 安装失败最多再试 2 次（有界重试，覆盖发后 registry 同步延迟这类瞬时故障）。 */
export const MAX_INSTALL_RETRIES = 2;
const RETRY_DELAY_MS = 10_000;
const CHILD_TIMEOUT_MS = 240_000;

/**
 * 断言口径（纯函数，tests/tooling.test.js 有用例）：吃 readPackageFacts 的产物，
 * 给出全部问题清单——一次报完，不让人修一个再跑一遍才看见下一个。
 * @param {{pkg:object, files:Set<string>, clientJs:string}} facts
 * @param {{expectName?:string|null, expectVersion?:string|null}} [expected]
 * @returns {string[]} 空数组 = 通过
 */
export function auditPackageFacts({ pkg, files, clientJs }, { expectName = null, expectVersion = null } = {}) {
  const problems = [];
  if (expectName && pkg.name !== expectName) {
    problems.push(`包名是 ${pkg.name}，要的是 ${expectName}`);
  }
  if (expectVersion && pkg.version !== expectVersion) {
    problems.push(`装到的版本是 ${pkg.version}，要的是 ${expectVersion}`);
  }
  for (const file of ['lib/index.js', 'lib/client.js', 'cordis.patch.yml']) {
    if (!files.has(file)) problems.push(`包内缺 ${file}`);
  }
  if (files.has('lib/client.js') && !clientJs.includes('__ModuleLoader__.load')) {
    problems.push('lib/client.js 里没有 __ModuleLoader__.load——browser 半区不是 lazy-CJS factory，dsh web 装得上也载不动');
  }
  if (!pkg.dsh?.engines?.dsh) problems.push('manifest 缺 dsh.engines.dsh（dsh 版本下限拦不住漂移）');
  if (!pkg.dsh?.bundle?.patch) problems.push('manifest 缺 dsh.bundle.patch（缺它不可安装）');
  if (!pkg.dsh?.client) problems.push('manifest 缺 dsh.client（browser 半区不会被注入）');
  return problems;
}

/**
 * 从解开的包目录里采集断言要用的事实（文件清单 + package.json + client.js 文本）。
 * @param {string} dir 包根目录（含 package.json）
 * @returns {{pkg:object, files:Set<string>, clientJs:string}}
 */
export function readPackageFacts(dir) {
  const files = new Set();
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue; // 装出来的依赖不属于包自身清单
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.add(path.relative(dir, full).split(path.sep).join('/'));
    }
  };
  walk(dir);
  const clientPath = path.join(dir, 'lib', 'client.js');
  return {
    pkg: JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')),
    files,
    clientJs: fs.existsSync(clientPath) ? fs.readFileSync(clientPath, 'utf8') : '',
  };
}

function run(cmd, args, { cwd } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'inherit', 'inherit'] });
    // 网络卡死不能把 CI job 拖到超时——到点直接收掉，按失败算
    const timer = setTimeout(() => child.kill('SIGKILL'), CHILD_TIMEOUT_MS);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: 127, error: err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, error: null });
    });
  });
}

async function installFromRegistry(spec, cwd) {
  for (let attempt = 1; attempt <= 1 + MAX_INSTALL_RETRIES; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop -- 重试本来就是串行的
    const res = await run('npm', ['install', spec, '--no-audit', '--no-fund', '--loglevel', 'error'], { cwd });
    if (res.code === 0) return;
    if (attempt <= MAX_INSTALL_RETRIES) {
      process.stderr.write(`npm install ${spec} 第 ${attempt} 次失败（退出码 ${res.code}），${RETRY_DELAY_MS / 1000}s 后重试\n`);
      // eslint-disable-next-line no-await-in-loop -- 等一拍再试，别立刻砸同一个 registry
      await new Promise((resolve) => { setTimeout(resolve, RETRY_DELAY_MS); });
    }
  }
  throw Object.assign(
    new Error(`npm install ${spec} 连试 ${1 + MAX_INSTALL_RETRIES} 次都失败——多半是网络或 registry 同步延迟，稍后重跑本 job`),
    { exitCode: 2 },
  );
}

async function extractTarball(tarball, destination) {
  const res = await run('tar', ['-xzf', tarball, '-C', destination]);
  if (res.code !== 0) {
    throw Object.assign(new Error(`解包失败（tar 退出码 ${res.code}）：${tarball}`), { exitCode: 1 });
  }
  const root = path.join(destination, 'package'); // npm pack 产物的固定顶层目录
  if (!fs.existsSync(path.join(root, 'package.json'))) {
    throw Object.assign(new Error(`解出来没有 package/package.json——${tarball} 不像 npm pack 产物`), { exitCode: 1 });
  }
  return root;
}

async function main() {
  const argv = process.argv.slice(2);
  const arg = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? null : argv[i + 1];
  };
  const version = arg('version') ?? null;
  const tarball = arg('tarball') ?? null;
  if ((version === null) === (tarball === null)) {
    process.stderr.write('用法：node scripts/plugin-smoke.mjs --version <ver> 或 --tarball <path>（二选一）\n');
    process.exitCode = 3;
    return;
  }

  const pluginPkg = JSON.parse(fs.readFileSync(path.join(REPO, 'plugin', 'package.json'), 'utf8'));
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-plugin-smoke-'));
  try {
    let packageDir;
    if (version !== null) {
      await installFromRegistry(`${pluginPkg.name}@${version}`, scratch);
      packageDir = path.join(scratch, 'node_modules', pluginPkg.name);
    } else {
      packageDir = await extractTarball(path.resolve(tarball), scratch);
    }

    const facts = readPackageFacts(packageDir);
    const problems = auditPackageFacts(facts, {
      expectName: pluginPkg.name,
      // tarball 是从工作区现打的，版本以包内自述为准；registry 安装则必须正是点名的那版
      expectVersion: version,
    });
    if (problems.length > 0) {
      process.stderr.write(`插件冒烟未过：\n${problems.map((p) => `  ✘ ${p}`).join('\n')}\n`);
      process.exitCode = 1;
      return;
    }
    process.stdout.write(
      `插件冒烟通过：${facts.pkg.name}@${facts.pkg.version}（包内 ${facts.files.size} 个文件，manifest 三件套齐）\n`,
    );
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exitCode = err.exitCode ?? 1;
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

if (isMainEntry(import.meta.url)) await main();
