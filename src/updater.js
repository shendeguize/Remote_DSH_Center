/**
 * 版本自证与自更新（模块层）。
 *
 * 三种安装通道，判据是落地物而不是猜：
 *   git      —— 仓库 clone（软链安装 / 开发机）：`<root>/.git` 在
 *   bundle   —— 自带 Node 运行时的发布包：`<root>/../BUNDLE_INFO.json` 在
 *   npm      —— `npm i -g @shendeguize/remote-dsh-center` 装出来的包：上级目录叫
 *               `node_modules`，或上级是 `@scope` 且上上级叫 `node_modules`
 *               （npm / pnpm 全局与本地装置的共同形态）；更新归 npm 管，这里不代跑
 * 认不出通道时一律拒绝更新而不是挑一条试——猜错要么白跑，要么把用户的目录搞坏。
 *
 * 更新的两条硬纪律：
 *   1. git 通道只快进（工作区脏、或目标不是当前提交的后代，都拒绝，不用 merge 糊过去）；
 *   2. bundle 通道下载物必须过 SHA256 校验才落盘，且换目录是「先解包到 .new、
 *      再原子改名」——中途失败时原安装仍是完整的。
 *
 * 重启由调用方（cli.js）决定：更新完不自动重启，因为重启会瞬断所有隧道页签，
 * 什么时候断该由人挑时机。
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { DshError } from './lib/errors.js';
import {
  BUNDLE_INFO_FILE, SUMS_FILE, assetName, bundleDirName, normalizeArch, parseSums,
} from './lib/bundle.js';
import {
  compareVersions, isPrerelease, parseVersion, pickLatest,
} from './lib/semver.js';

/** 仓库根（含 package.json）。bundle 安装下它是 `<bundle 根>/app`。 */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** git 通道默认跟的分支——稳定消费口径（尝鲜者显式 `--ref main`）。 */
export const DEFAULT_GIT_REF = 'release';

// ── 通道识别与版本自证 ───────────────────────────────────────────────────

/**
 * @param {string} [repoRoot] 含 package.json 的目录
 * @returns {{channel:'git'|'bundle'|'npm'|'unknown', root:string, repoRoot:string,
 *   bundleInfo:object|null, reason:string|null}}
 *   `root` = 更新时要替换/前进的那个目录：bundle 是 bundle 根，git 是仓库本身，
 *   npm 是包目录（只作展示，更新走 npm 自己）
 */
export function resolveInstall(repoRoot = REPO_ROOT, deps = {}) {
  const exists = deps.existsSync ?? fs.existsSync;
  const read = deps.readFileSync ?? fs.readFileSync;

  const bundleRoot = path.dirname(repoRoot);
  const infoPath = path.join(bundleRoot, BUNDLE_INFO_FILE);
  if (exists(infoPath)) {
    let bundleInfo = null;
    try {
      bundleInfo = JSON.parse(read(infoPath, 'utf8'));
    } catch (err) {
      return {
        channel: 'unknown', root: bundleRoot, repoRoot, bundleInfo: null,
        reason: `${infoPath} 读不出来（${err.message}）——发布包被改过？重装一次最省事`,
      };
    }
    return { channel: 'bundle', root: bundleRoot, repoRoot, bundleInfo, reason: null };
  }

  if (exists(path.join(repoRoot, '.git'))) {
    return { channel: 'git', root: repoRoot, repoRoot, bundleInfo: null, reason: null };
  }

  // npm / pnpm 装置（全局或本地）的共同落地形态：包目录躺在 node_modules 下；
  // scoped 包（@scope/name）中间多一层 @scope 目录
  const parent = path.dirname(repoRoot);
  const parentName = path.basename(parent);
  const inNodeModules = parentName === 'node_modules'
    || (parentName.startsWith('@') && path.basename(path.dirname(parent)) === 'node_modules');
  if (inNodeModules) {
    return { channel: 'npm', root: repoRoot, repoRoot, bundleInfo: null, reason: null };
  }

  return {
    channel: 'unknown',
    root: repoRoot,
    repoRoot,
    bundleInfo: null,
    reason: `${repoRoot} 既不是 git clone（没有 .git），不是发布包（上层没有 ${BUNDLE_INFO_FILE}），`
      + '也不是 npm 装的包（不在 node_modules 下）',
  };
}

function readPackageVersion(repoRoot, read = fs.readFileSync) {
  try {
    return JSON.parse(read(path.join(repoRoot, 'package.json'), 'utf8')).version ?? null;
  } catch {
    return null;
  }
}

function run(cmd, args, { cwd = process.cwd(), timeoutMs = 120_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

/** git 事实采集：失败一律给 null，`dshc version` 不该因为没装 git 就报错。 */
async function gitFacts(dir, exec = run) {
  const sha = await exec('git', ['-C', dir, 'rev-parse', '--short', 'HEAD']);
  if (sha.code !== 0) return null;
  const ref = await exec('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD']);
  const contains = await exec('git', ['-C', dir, 'branch', '-r', '--contains', 'HEAD']);
  const branches = contains.code === 0
    ? contains.stdout.split('\n').map((l) => l.trim().replace(/^origin\//, '')).filter(Boolean)
    : [];
  return {
    sha: sha.stdout,
    // 软链安装是 detached HEAD（install.sh 直接 checkout FETCH_HEAD），
    // 此时 abbrev-ref 给 "HEAD"，得靠远端分支反查才知道自己在跟哪条线
    ref: ref.code === 0 && ref.stdout !== 'HEAD' ? ref.stdout : (branches[0] ?? 'detached'),
  };
}

/**
 * `dshc version` 的全部事实。
 * @returns {Promise<{version:string|null, channel:string, channelDetail:string,
 *   node:{version:string, execPath:string}, root:string, repoRoot:string,
 *   bundle:object|null, git:object|null}>}
 */
export async function collectVersionInfo({
  repoRoot = REPO_ROOT, node = process, exec = run, deps = {},
} = {}) {
  const install = resolveInstall(repoRoot, deps);
  const version = readPackageVersion(install.repoRoot, deps.readFileSync);
  const git = install.channel === 'git' ? await gitFacts(install.repoRoot, exec) : null;

  let channelDetail;
  if (install.channel === 'bundle') {
    const info = install.bundleInfo ?? {};
    channelDetail = `bundle ${info.tag ?? `v${info.version ?? '?'}`}（${info.arch ?? '?'}）`;
  } else if (install.channel === 'git') {
    channelDetail = git ? `git ${git.sha}（${git.ref}）` : 'git（取不到提交信息）';
  } else if (install.channel === 'npm') {
    channelDetail = 'npm 全局包（更新走 npm i -g @shendeguize/remote-dsh-center@latest）';
  } else {
    channelDetail = `认不出（${install.reason}）`;
  }

  return {
    version,
    channel: install.channel,
    channelDetail,
    node: { version: node.versions?.node ?? null, execPath: node.execPath ?? null },
    root: install.root,
    repoRoot: install.repoRoot,
    bundle: install.bundleInfo,
    git,
  };
}

// ── 目标版本决策（纯函数） ───────────────────────────────────────────────

/**
 * Release 列表 → 可安装候选。
 * @param {Array<{tag_name?:string, prerelease?:boolean, draft?:boolean, assets?:Array}>} releases
 * @returns {Array<{tag:string, version:string, prerelease:boolean, assets:string[]}>}
 */
export function usableReleases(releases) {
  const out = [];
  for (const r of releases ?? []) {
    if (r?.draft) continue;
    const parsed = parseVersion(r?.tag_name);
    if (!parsed) continue;
    out.push({
      tag: r.tag_name,
      version: parsed.version,
      prerelease: Boolean(r.prerelease) || parsed.prerelease.length > 0,
      assets: (r.assets ?? []).map((a) => a?.name).filter(Boolean),
    });
  }
  return out;
}

/**
 * 该不该更新、更到哪个版本。
 * @param {object} input
 * @param {string|null} input.current            当前版本
 * @param {Array} input.releases                 usableReleases 的产出
 * @param {boolean} [input.includePrerelease]    `--pre`
 * @param {string|null} [input.pinned]           `--ref vX.Y.Z`：点名 tag，跳过挑选
 * @returns {{action:'update'|'up-to-date'|'none', target:object|null, reason:string|null}}
 */
export function chooseTarget({
  current, releases, includePrerelease = false, pinned = null,
}) {
  if (pinned) {
    const hit = releases.find((r) => r.tag === pinned || r.version === parseVersion(pinned)?.version);
    if (!hit) {
      return { action: 'none', target: null, reason: `Release 里没有 ${pinned}` };
    }
    return { action: 'update', target: hit, reason: null };
  }

  const candidates = releases.filter((r) => includePrerelease || !r.prerelease);
  const latest = pickLatest(candidates.map((r) => r.version), { includePrerelease });
  if (!latest) {
    return {
      action: 'none',
      target: null,
      reason: includePrerelease ? '仓库还没有任何 Release' : '仓库还没有正式版 Release（想装预发布加 --pre）',
    };
  }

  const target = candidates.find((r) => r.version === latest);
  if (current && compareVersions(latest, current) <= 0) {
    return {
      action: 'up-to-date', target, reason: null, newerPrerelease: newerPrereleaseThan(current, releases),
    };
  }
  return { action: 'update', target, reason: null, newerPrerelease: null };
}

/**
 * 跟着预发布的人，稳定口径下会一直停在旧 rc 上——正式版比 rc 旧，`update` 只会说
 * 「已是最新」。所以在这种情形下把更新的预发布报出来；装正式版的人不受打扰。
 * @returns {string|null} 更新的预发布版本号，没有则 null
 */
function newerPrereleaseThan(current, releases) {
  if (!isPrerelease(current)) return null;
  const newer = releases
    .filter((r) => r.prerelease && compareVersions(r.version, current) > 0)
    .map((r) => r.version);
  return pickLatest(newer, { includePrerelease: true });
}

/** bundle 通道换目录用的三个路径。只留一代 `.prev`，够回滚又不攒垃圾。 */
export function swapPaths(root) {
  return { root, staging: `${root}.new`, previous: `${root}.prev` };
}

// ── git 通道 ────────────────────────────────────────────────────────────

/**
 * @returns {Promise<{ok:boolean, action:'updated'|'up-to-date', from:string, to:string,
 *   fromVersion:string|null, toVersion:string|null, problem:string|null}>}
 */
export async function updateGit({
  root, ref = DEFAULT_GIT_REF, exec = run, deps = {},
}) {
  const git = (...args) => exec('git', ['-C', root, ...args]);
  const fail = (problem) => ({
    ok: false, action: 'up-to-date', from: '', to: '', fromVersion: null, toVersion: null, problem,
  });

  const dirty = await git('status', '--porcelain');
  if (dirty.code !== 0) return fail(`${root} 不像个能用的 git 仓库：${dirty.stderr || dirty.stdout}`);
  if (dirty.stdout !== '') {
    return fail(`${root} 有未提交的改动，先自行处理再更新：\n${dirty.stdout}`);
  }

  const fetched = await git('fetch', '--quiet', 'origin', ref);
  if (fetched.code !== 0) return fail(`拉不到 origin/${ref}：${fetched.stderr || fetched.stdout}`);

  const before = await git('rev-parse', 'HEAD');
  const target = await git('rev-parse', 'FETCH_HEAD');
  if (before.code !== 0 || target.code !== 0) return fail('取不到当前提交或目标提交');

  const fromVersion = readPackageVersion(root, deps.readFileSync);
  if (before.stdout === target.stdout) {
    return {
      ok: true,
      action: 'up-to-date',
      from: before.stdout,
      to: target.stdout,
      fromVersion,
      toVersion: fromVersion,
      problem: null,
    };
  }

  // 只许快进：目标必须是当前提交的后代，否则就是本地有独有提交或指到了更旧的地方
  const ancestor = await git('merge-base', '--is-ancestor', before.stdout, target.stdout);
  if (ancestor.code !== 0) {
    return fail(
      `origin/${ref}（${target.stdout.slice(0, 8)}）不是当前提交（${before.stdout.slice(0, 8)}）的后代，`
      + '不是快进就不动——本地有独有提交，或者 ref 指到了更旧的位置',
    );
  }

  // 软链安装本就是 detached HEAD（install.sh 的模型），沿用同一形态
  const moved = await git('checkout', '--quiet', '--detach', target.stdout);
  if (moved.code !== 0) return fail(`切到目标提交失败：${moved.stderr || moved.stdout}`);

  return {
    ok: true,
    action: 'updated',
    from: before.stdout,
    to: target.stdout,
    fromVersion,
    toVersion: readPackageVersion(root, deps.readFileSync),
    problem: null,
  };
}

// ── bundle 通道 ─────────────────────────────────────────────────────────

async function fetchOk(url, fetchImpl) {
  const res = await fetchImpl(url, { headers: { accept: 'application/vnd.github+json' } });
  if (!res.ok) {
    throw new DshError('SSH_UNREACHABLE', `取 ${url} 失败：HTTP ${res.status}`);
  }
  return res;
}

/** @returns {Promise<Array>} GitHub Release 列表原始 JSON */
export async function fetchReleases(url, { fetchImpl = fetch } = {}) {
  const res = await fetchOk(url, fetchImpl);
  return res.json();
}

export function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/**
 * 下载并核对校验和。校验不过就不落盘——安装与更新的第一道闸。
 * @returns {Promise<Buffer>}
 */
export async function downloadVerified({
  assetUrl: url, sumsUrl, name, fetchImpl = fetch,
}) {
  const sumsText = await (await fetchOk(sumsUrl, fetchImpl)).text();
  const expected = parseSums(sumsText).get(name);
  if (!expected) {
    throw new DshError('VALIDATION', `${SUMS_FILE} 里没有 ${name} 的校验和，不敢装`);
  }

  const bytes = Buffer.from(await (await fetchOk(url, fetchImpl)).arrayBuffer());
  const actual = sha256(bytes);
  if (actual !== expected) {
    throw new DshError('VALIDATION', `${name} 校验和不符，已丢弃`, {
      detail: `期望 ${expected}\n实际 ${actual}`,
    });
  }
  return bytes;
}

/**
 * 解包 → 原子换目录。失败时保证原安装还在原地。
 * @returns {Promise<{previous:string}>}
 */
export async function installBundle({
  root, tarball, version, arch, exec = run,
}) {
  const { staging, previous } = swapPaths(root);
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });

  const unpacked = await exec('tar', ['-xzf', tarball, '-C', staging]);
  if (unpacked.code !== 0) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw new DshError('INTERNAL', `解包失败：${unpacked.stderr || unpacked.stdout}`);
  }

  // tar 内是带版本号的顶层目录；容错：真出意外时按目录里唯一一项走
  const expectedDir = bundleDirName({ version, arch });
  const entries = fs.readdirSync(staging);
  const inner = entries.includes(expectedDir) ? expectedDir : (entries.length === 1 ? entries[0] : null);
  if (!inner) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw new DshError('INTERNAL', `产物结构不认识：解包后得到 ${entries.join(', ') || '空目录'}`);
  }
  if (!fs.existsSync(path.join(staging, inner, BUNDLE_INFO_FILE))) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw new DshError('INTERNAL', `产物里没有 ${BUNDLE_INFO_FILE}，不像发布包`);
  }

  fs.rmSync(previous, { recursive: true, force: true });
  fs.renameSync(root, previous);
  try {
    fs.renameSync(path.join(staging, inner), root);
  } catch (err) {
    fs.renameSync(previous, root); // 换一半失败要放回去，不能留个空位
    throw new DshError('INTERNAL', `换目录失败，已还原原安装：${err.message}`);
  }
  fs.rmSync(staging, { recursive: true, force: true });
  return { previous };
}

/**
 * bundle 通道的完整更新流程（查 → 比 → 下 → 校 → 换）。
 * @returns {Promise<{action:'updated'|'up-to-date'|'none', from:string|null,
 *   to:string|null, previous:string|null, reason:string|null}>}
 */
export async function updateBundle({
  root, bundleInfo, releasesUrl: listUrl, assetUrlFor, sumsUrlFor,
  includePrerelease = false, pinned = null, fetchImpl = fetch, exec = run, tmpDir,
}) {
  const current = bundleInfo?.version ?? null;
  const arch = normalizeArch(bundleInfo?.arch ?? process.arch);
  if (!arch) {
    throw new DshError('VALIDATION', `不支持的 CPU 架构 ${bundleInfo?.arch ?? process.arch}：发布包只有 arm64 与 x64`);
  }

  const releases = usableReleases(await fetchReleases(listUrl, { fetchImpl }));
  const decision = chooseTarget({ current, releases, includePrerelease, pinned });
  if (decision.action !== 'update') {
    return {
      action: decision.action, from: current, to: decision.target?.version ?? null,
      previous: null, reason: decision.reason, newerPrerelease: decision.newerPrerelease ?? null,
    };
  }

  const { tag, version } = decision.target;
  const name = assetName({ version, arch });
  if (decision.target.assets.length > 0 && !decision.target.assets.includes(name)) {
    throw new DshError('NOT_FOUND', `${tag} 没有 ${arch} 的产物（${name}）`, {
      detail: `该 Release 的附件：${decision.target.assets.join(', ')}`,
    });
  }

  const bytes = await downloadVerified({
    assetUrl: assetUrlFor({ tag, name }), sumsUrl: sumsUrlFor({ tag }), name, fetchImpl,
  });

  const scratch = fs.mkdtempSync(path.join(tmpDir ?? path.dirname(root), '.dshc-update-'));
  try {
    const tarball = path.join(scratch, name);
    fs.writeFileSync(tarball, bytes);
    const { previous } = await installBundle({ root, tarball, version, arch, exec });
    return { action: 'updated', from: current, to: version, previous, reason: null };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}
