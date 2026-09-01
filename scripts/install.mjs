#!/usr/bin/env node
/**
 * 把 dshc 装进 PATH（软链到本仓库/发布包，不复制）。
 *
 * 用软链而不是拷贝，是因为 launchd plist 里写的是入口的绝对路径
 * （见 src/daemon.js buildPlist）——两份代码会立刻对不上。软链意味着
 * `git pull` 即升级，不需要重装。
 *
 * 两种安装通道，链接指向不同：
 *   git 仓库    → `src/cli.js`（shebang 找系统 node）
 *   发布包      → `<包根>/bin/dshc` 启动器（exec 随包自带的 node）
 * 发布包必须指启动器而不是 `app/src/cli.js`：装的人可能压根没装 node，
 * 直接跑 cli.js 会找不到解释器。通道判据与 `dshc update` 共用一份
 * （`src/updater.js` 的 resolveInstall），不在这里另写一遍。
 *
 * 用法：
 *   node scripts/install.mjs                     # 装到 ~/.local/bin（不存在会建）
 *   node scripts/install.mjs --prefix /usr/local/bin
 *   node scripts/install.mjs --service           # 顺带 dshc service install（launchd 自启）
 *   node scripts/install.mjs --uninstall         # 只摘链接，不动 ~/.dsh_center 的配置
 *   node scripts/install.mjs --no-next-steps     # 收尾提示交给上游（install.sh 用）
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { isMainEntry } from '../src/lib/entry.js';
import { resolveInstall } from '../src/updater.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_PREFIX = path.join(os.homedir(), '.local', 'bin');

/**
 * 该把 dshc 软链到哪个文件。
 * @returns {{target:string, channel:string, viaShim:boolean}}
 */
export function linkTarget(repoRoot = REPO, deps = {}) {
  const install = resolveInstall(repoRoot, deps);
  if (install.channel === 'bundle') {
    return { target: path.join(install.root, 'bin', 'dshc'), channel: 'bundle', viaShim: true };
  }
  return { target: path.join(repoRoot, 'src', 'cli.js'), channel: install.channel, viaShim: false };
}

/**
 * 装之前先把链接位置的现状分类，避免把别人的 dshc 覆盖掉。
 * @returns {{action:'create'|'relink'|'noop'|'conflict', current:string|null}}
 */
export function linkPlan(linkPath, target, { lstat = fs.lstatSync, readlink = fs.readlinkSync } = {}) {
  let st;
  try {
    st = lstat(linkPath);
  } catch {
    return { action: 'create', current: null };
  }
  if (!st.isSymbolicLink()) return { action: 'conflict', current: '（不是软链，是真实文件）' };
  const current = readlink(linkPath);
  if (path.resolve(path.dirname(linkPath), current) === target) return { action: 'noop', current };
  return { action: 'relink', current };
}

/** PATH 里有没有这个前缀——没有的话装了也调不到，得当场说清楚。 */
export function prefixInPath(prefix, pathEnv = process.env.PATH ?? '') {
  const norm = (p) => path.resolve(p.replace(/^~(?=$|\/)/, os.homedir()));
  return pathEnv.split(path.delimiter).filter(Boolean).some((p) => norm(p) === path.resolve(prefix));
}

/** 给用户抄的那行（按当前 shell 猜 rc 文件）。 */
export function pathHint(prefix, shell = process.env.SHELL ?? '') {
  const rc = shell.endsWith('zsh') ? '~/.zshrc' : (shell.endsWith('bash') ? '~/.bash_profile' : '你的 shell rc');
  return `echo 'export PATH="${prefix}:$PATH"' >> ${rc} && exec $SHELL -l`;
}

async function installSidecarBestEffort() {
  const existing = await run('agent-sidecar', ['--version']);
  const match = existing.stdout.match(/\b(\d+)\.(\d+)\.(\d+)\b/);
  const compatible = match !== null
    && (
      Number(match[1]) > 0
      || (Number(match[1]) === 0 && Number(match[2]) > 9)
      || (Number(match[1]) === 0 && Number(match[2]) === 9 && Number(match[3]) >= 0)
    );
  if (existing.code === 0 && compatible) {
    process.stdout.write(`Agent Sidecar 已存在：${existing.stdout.trim()}\n`);
    return;
  }
  if (existing.code === 0) process.stdout.write('Agent Sidecar 版本过低，尝试自动升级…\n');
  const installerUrl = process.env.DSH_SIDECAR_INSTALLER_URL
    ?? 'https://raw.githubusercontent.com/shendeguize/AgentSideCar/main/install.sh';
  const temp = path.join(os.tmpdir(), `agent-sidecar-install-${process.pid}.sh`);
  const download = await run('curl', ['-fsSL', '-o', temp, installerUrl]);
  if (download.code !== 0) {
    process.stdout.write('警告：Agent Sidecar 下载失败，Center 安装继续。\n');
    return;
  }
  const installed = await run('sh', [temp, '--prefix', path.join(os.homedir(), '.local')]);
  try { fs.rmSync(temp); } catch { /* best effort cleanup */ }
  if (installed.code === 0) {
    process.stdout.write('Agent Sidecar 已通过官方校验和安装器安装。\n');
  } else {
    process.stdout.write('警告：Agent Sidecar 安装失败，Center 安装继续。\n');
  }
}

/**
 * 下游不看了（`| head` 之类）属于哪种错。
 *
 * 管道被提前关掉时 Node 默认把 EPIPE 抛成未捕获异常，刷一屏栈——但那不是安装失败，
 * 而且软链早在报错前就建好了，看到栈的人会误以为装坏了（issue #16）。
 * 流被销毁后的后续写入报的是另外两个码，同源同因，一起吞。
 */
export function isBrokenPipe(err) {
  return ['EPIPE', 'ERR_STREAM_DESTROYED', 'ERR_STREAM_WRITE_AFTER_END'].includes(err?.code);
}

/** 吞掉管道断裂，其余照抛（真正的写失败不该被藏起来）。 */
export function silenceBrokenPipe(streams = [process.stdout, process.stderr]) {
  for (const s of streams) {
    s.on('error', (err) => {
      if (!isBrokenPipe(err)) throw err;
    });
  }
}

function run(cmd, args) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', (err) => resolve({ code: 127, stdout, stderr: String(err.message) }));
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

async function main() {
  silenceBrokenPipe();
  const argv = process.argv.slice(2);
  const flag = (name) => argv.includes(`--${name}`);

  // 不认识的旗标当用法错误。只挑认识的、其余不响，等于「按另一套意思照做」：
  // 把 --service 拼成 --srevice 的人以为装了自启，实际什么都没装（issue #55）。
  const KNOWN = new Set(['--prefix', '--service', '--uninstall', '--no-next-steps']);
  const unknown = argv.filter((a, i) => a.startsWith('--') && !KNOWN.has(a)
    // --prefix 的值不是旗标
    && argv[i - 1] !== '--prefix');
  if (unknown.length > 0) {
    process.stderr.write(`不认识的参数：${unknown.join(' ')}\n可用：${[...KNOWN].join(' | ')}\n`);
    process.exitCode = 3;
    return;
  }

  const prefixArg = argv.indexOf('--prefix');
  const prefix = path.resolve(prefixArg === -1 ? DEFAULT_PREFIX : argv[prefixArg + 1]);
  const linkPath = path.join(prefix, 'dshc');
  const { target: entry, viaShim } = linkTarget();

  const major = Number(process.versions.node.split('.')[0]);
  if (major < 22) {
    process.stderr.write(`需要 Node ≥ 22（当前 ${process.versions.node}）：本项目直接用了内置测试运行器与 fetch。\n`);
    process.exitCode = 1;
    return;
  }

  if (flag('uninstall')) {
    const plan = linkPlan(linkPath, entry);
    if (plan.action === 'create') {
      process.stdout.write(`${linkPath} 本来就不存在，无事可做。\n`);
      return;
    }
    if (plan.action === 'conflict') {
      process.stderr.write(`${linkPath} 不是本仓库装的软链，没敢删。\n`);
      process.exitCode = 1;
      return;
    }
    fs.rmSync(linkPath);
    process.stdout.write(`已摘除 ${linkPath}（配置与状态仍在 ~/.dsh_center，未动）。\n`);
    process.stdout.write('如果之前装过 launchd 服务，用 dshc service uninstall 单独摘。\n');
    return;
  }

  if (!fs.existsSync(entry)) {
    process.stderr.write(`找不到入口：${entry}\n`);
    process.exitCode = 1;
    return;
  }
  fs.chmodSync(entry, 0o755);
  fs.mkdirSync(prefix, { recursive: true });

  const plan = linkPlan(linkPath, entry);
  if (plan.action === 'conflict') {
    process.stderr.write(`${linkPath} 已存在且不是软链，请先自行处理再装。\n`);
    process.exitCode = 1;
    return;
  }
  if (plan.action === 'relink') {
    process.stdout.write(`覆盖旧链接（原指向 ${plan.current}）。\n`);
    fs.rmSync(linkPath);
  }
  if (plan.action !== 'noop') fs.symlinkSync(entry, linkPath);

  const probe = await run(linkPath, ['--help']);
  if (probe.code !== 0 || !probe.stdout.includes('dshc')) {
    process.stderr.write(`装好了但跑不通：${linkPath}（退出码 ${probe.code}）${probe.stderr}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`dshc → ${entry}\n已链接到 ${linkPath}\n`);
  if (viaShim) process.stdout.write('（发布包安装：启动器会用随包自带的 Node，与系统 node 无关）\n');

  if (!prefixInPath(prefix)) {
    process.stdout.write(`\n注意：${prefix} 不在 PATH 里，现在敲 dshc 还找不到。加一行：\n  ${pathHint(prefix)}\n`);
  }

  await installSidecarBestEffort();

  if (flag('service')) {
    process.stdout.write('\n装 launchd 服务（开机自启 + 被杀拉回）…\n');
    // plist 里的解释器路径来自跑这条命令的进程的 process.execPath（daemon.buildPlist）。
    // 发布包安装必须经启动器跑，否则 plist 会写上系统 node——而那台机器可能根本没有。
    const res = viaShim
      ? await run(linkPath, ['service', 'install'])
      : await run(process.execPath, [entry, 'service', 'install']);
    process.stdout.write(res.stdout || res.stderr);
    if (res.code !== 0) process.exitCode = res.code;
    return;
  }

  // install.sh 调用时它自己会印一份更详细的收尾，这里就别再来一遍（issue #17）
  if (flag('no-next-steps')) return;
  process.stdout.write('\n下一步：dshc init（首次配置）→ dshc up → dshc open\n');
  process.stdout.write('想开机自启：dshc service install（或重跑本脚本加 --service）\n');
}

if (isMainEntry(import.meta.url)) await main();
