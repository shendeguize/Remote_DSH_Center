#!/usr/bin/env node
/**
 * 打双架构发布包：产品本体 + 随包自带的官方 Node 运行时。
 *
 * 为什么要自带运行时：本项目零依赖纯 Node，代码本身与 CPU 架构无关——**唯一
 * 与架构相关的东西就是 Node 运行时本身**。所以「支持 mac-intel / mac-arm」的
 * 实现是分架构各带一份官方 Node 二进制，而不是去编译什么东西。这也让没装 node
 * 的机器能一条命令装上（install.sh 的 standalone 通道）。
 *
 * 落地形态（解包后）：
 *   <包名>/bin/dshc              启动器，解析软链后 exec 自带 node
 *   <包名>/runtime/bin/node      官方 Node 发行版二进制（+ LICENSE）
 *   <包名>/app/                  产品本体，内容 = npm pack 的文件清单（同一张白名单）
 *   <包名>/BUNDLE_INFO.json      通道识别标记，dshc version / update 都读它
 *
 * 两条纪律：
 *   1. 下载的 Node 逐字节核对官方 SHASUMS256.txt，对不上就中止——我们把别人的
 *      二进制转发给用户，不核对等于替上游背锅；
 *   2. app/ 的内容不另立白名单，直接用 npm pack 的清单并过 check.mjs 的
 *      verifyPackFiles——否则「发布包里多了 tests/」这种事没人拦。
 *
 * 用法：
 *   node scripts/build-bundle.mjs                        # 双架构，产物进 dist/
 *   node scripts/build-bundle.mjs --arch arm64
 *   node scripts/build-bundle.mjs --out /tmp/x --node-cache ~/.cache/dshc-node
 *   node scripts/build-bundle.mjs --version 0.2.0        # 只作核对：必须与 package.json 相同
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { isMainEntry } from '../src/lib/entry.js';
import {
  BUNDLE_INFO_FILE, BUNDLE_PLATFORM, SUMS_FILE, SUPPORTED_ARCHES,
  assetName, bundleDirName, formatSums, parseSums,
} from '../src/lib/bundle.js';
import { parseVersion } from '../src/lib/semver.js';
import { verifyPackFiles } from './check.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 随包发的 Node 版本。改这里 = 改所有新装用户的运行时，属于要写 CHANGELOG 的事。
 * 必须满足 package.json 的 engines.node（用例盯着），且只挑 LTS。
 */
export const NODE_RUNTIME_VERSION = '22.23.2';

export const nodeDistDirName = ({ version, arch }) => `node-v${version}-${BUNDLE_PLATFORM}-${arch}`;
export const nodeTarballName = (opts) => `${nodeDistDirName(opts)}.tar.gz`;
export const nodeDistUrl = ({ version, arch }) => `https://nodejs.org/dist/v${version}/${nodeTarballName({ version, arch })}`;
export const nodeShasumsUrl = (version) => `https://nodejs.org/dist/v${version}/SHASUMS256.txt`;

/**
 * 启动器脚本。
 *
 * 关键是**必须自己解软链**：装到 PATH 的是 `~/.local/bin/dshc` → 本文件的软链，
 * 而 `$0` 给的是软链自己的路径，直接拿它算 `dirname` 会算到 `~/.local`，
 * 于是找不到 runtime 与 app。macOS 自带的 readlink 没有可靠的 `-f`，所以手动循环解。
 */
export function shimScript() {
  return `#!/bin/sh
# DSH Center 启动器：只用随包自带的 Node，不碰系统 node（装的人可能根本没装 node）。
set -e

# 装到 PATH 的是本文件的软链，$0 是软链路径——必须解到真身才能算出包根
target="$0"
while [ -L "$target" ]; do
  link="$(readlink "$target")"
  case "$link" in
    /*) target="$link" ;;
    *) target="$(dirname "$target")/$link" ;;
  esac
done

DIR="$(cd -- "$(dirname -- "$target")/.." && pwd)"
exec "$DIR/runtime/bin/node" "$DIR/app/src/cli.js" "$@"
`;
}

/** 通道识别标记的内容。 */
export function makeBundleInfo({
  version, arch, nodeVersion = NODE_RUNTIME_VERSION, sourceSha = null, builtAt = new Date().toISOString(),
}) {
  return {
    version,
    tag: `v${version}`,
    platform: BUNDLE_PLATFORM,
    arch,
    nodeVersion,
    sourceSha,
    builtAt,
  };
}

/**
 * npm pack 的 JSON 输出 → 要进 app/ 的文件清单（顺带过一遍打包白名单）。
 * @param {string} json `npm pack --dry-run --json` 的 stdout
 * @returns {string[]}
 * @throws {Error} 清单缺必需文件或混进了不该发的
 */
export function packFileList(json) {
  let files;
  try {
    files = JSON.parse(json)[0].files.map((f) => f.path);
  } catch {
    throw new Error('npm pack --json 输出无法解析');
  }
  const verdict = verifyPackFiles(files);
  if (verdict.missing.length > 0) throw new Error(`产物缺文件：${verdict.missing.join(', ')}`);
  if (verdict.leaked.length > 0) throw new Error(`产物混入了不该发的：${verdict.leaked.slice(0, 5).join(', ')}`);
  return files;
}

// ── 以下是 IO ───────────────────────────────────────────────────────────

function run(cmd, args, { cwd = REPO } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
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

const log = (line) => process.stdout.write(`${line}\n`);
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

async function getBytes(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}：${url}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * 取官方 Node tar.gz 并核对 SHASUMS256.txt。缓存命中时也照样核对——
 * 缓存目录被人动过的情况，正是校验存在的理由。
 */
async function fetchNodeRuntime({ version, arch, cacheDir }) {
  const name = nodeTarballName({ version, arch });
  const cached = cacheDir ? path.join(cacheDir, name) : null;

  const sums = parseSums(await (await fetch(nodeShasumsUrl(version)).then((r) => {
    if (!r.ok) throw new Error(`取不到 SHASUMS256.txt：HTTP ${r.status}`);
    return r;
  })).text());
  const expected = sums.get(name);
  if (!expected) throw new Error(`官方 SHASUMS256.txt 里没有 ${name}——版本号或架构写错了？`);

  let bytes;
  if (cached && fs.existsSync(cached)) {
    bytes = fs.readFileSync(cached);
    log(`  运行时：缓存命中 ${name}`);
  } else {
    log(`  运行时：下载 ${name}`);
    bytes = await getBytes(nodeDistUrl({ version, arch }));
    if (cached) {
      fs.mkdirSync(cacheDir, { recursive: true });
      fs.writeFileSync(cached, bytes);
    }
  }

  const actual = sha256(bytes);
  if (actual !== expected) {
    throw new Error(`${name} 校验和不符，已中止\n  期望 ${expected}\n  实际 ${actual}`);
  }
  log(`  运行时：校验通过 ${expected.slice(0, 16)}…`);
  return bytes;
}

async function buildOne({
  version, arch, outDir, scratch, files, nodeCache, sourceSha,
}) {
  log(`\n▸ ${arch}`);
  const dirName = bundleDirName({ version, arch });
  const root = path.join(scratch, dirName);
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(root, 'runtime', 'bin'), { recursive: true });

  // 1. 运行时
  const nodeBytes = await fetchNodeRuntime({ version: NODE_RUNTIME_VERSION, arch, cacheDir: nodeCache });
  const nodeStage = path.join(scratch, `node-${arch}`);
  fs.rmSync(nodeStage, { recursive: true, force: true });
  fs.mkdirSync(nodeStage, { recursive: true });
  const nodeTar = path.join(nodeStage, 'node.tar.gz');
  fs.writeFileSync(nodeTar, nodeBytes);
  const untar = await run('tar', ['-xzf', nodeTar, '-C', nodeStage]);
  if (untar.code !== 0) throw new Error(`解开 Node 发行版失败：${untar.stderr}`);

  const distDir = path.join(nodeStage, nodeDistDirName({ version: NODE_RUNTIME_VERSION, arch }));
  fs.copyFileSync(path.join(distDir, 'bin', 'node'), path.join(root, 'runtime', 'bin', 'node'));
  fs.chmodSync(path.join(root, 'runtime', 'bin', 'node'), 0o755);
  // 转发别人的二进制，许可证要跟着走
  fs.copyFileSync(path.join(distDir, 'LICENSE'), path.join(root, 'runtime', 'LICENSE'));
  fs.rmSync(nodeStage, { recursive: true, force: true });

  // 2. 产品本体：逐个照 npm pack 的清单拷
  for (const rel of files) {
    const to = path.join(root, 'app', rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(REPO, rel), to);
  }
  fs.chmodSync(path.join(root, 'app', 'src', 'cli.js'), 0o755);
  log(`  本体：${files.length} 个文件`);

  // 3. 启动器与标记
  fs.writeFileSync(path.join(root, 'bin', 'dshc'), shimScript(), { mode: 0o755 });
  fs.writeFileSync(
    path.join(root, BUNDLE_INFO_FILE),
    `${JSON.stringify(makeBundleInfo({ version, arch, sourceSha }), null, 2)}\n`,
  );

  // 4. 打包
  const asset = assetName({ version, arch });
  const target = path.join(outDir, asset);
  const packed = await run('tar', ['-czf', target, '-C', scratch, dirName]);
  if (packed.code !== 0) throw new Error(`打包失败：${packed.stderr}`);
  fs.rmSync(root, { recursive: true, force: true });

  const bytes = fs.readFileSync(target);
  log(`  产物：${asset}（${(bytes.length / 1024 / 1024).toFixed(1)} MiB）`);
  return [asset, sha256(bytes)];
}

/**
 * 要打的版本号。
 *
 * 包里有两处版本：`BUNDLE_INFO.json`（构建时写）与 `app/package.json`（照原样拷）。
 * 它们必须是同一个数——`dshc version` 的「版本」读前者、「安装通道」读后者，
 * 对不上的话输出自相矛盾（实测过：一个说 0.2.0-rc.2，另一个说 v0.1.9），
 * 而拿到这种包的人无从判断自己装的到底是什么。所以 `--version` 只许**复述**
 * package.json 的值（当核对用），要打别的版本就去改 package.json。
 *
 * @param {{requested:string|null, pkgVersion:string}} input
 * @returns {string}
 * @throws {Error} 形状不对，或点名了与 package.json 不同的版本
 */
export function resolveBuildVersion({ requested, pkgVersion }) {
  if (!parseVersion(pkgVersion)) throw new Error(`package.json 的版本号形状不对：${pkgVersion}`);
  if (requested === null || requested === undefined) return pkgVersion;
  if (!parseVersion(requested)) throw new Error(`版本号形状不对：${requested}`);
  if (requested !== pkgVersion) {
    throw new Error(
      `点名的 ${requested} 与 package.json 的 ${pkgVersion} 不一致。\n`
      + '  发布包里的版本只有一个源（package.json）：BUNDLE_INFO.json 与 app/package.json\n'
      + '  对不上时 dshc version 会自相矛盾。要打别的版本，改 package.json。',
    );
  }
  return requested;
}

function arg(argv, name, fallback = null) {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
}

async function main() {
  const argv = process.argv.slice(2);
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  const version = resolveBuildVersion({ requested: arg(argv, 'version'), pkgVersion: pkg.version });

  const arches = (arg(argv, 'arch') ?? SUPPORTED_ARCHES.join(',')).split(',').map((a) => a.trim()).filter(Boolean);
  const bad = arches.filter((a) => !SUPPORTED_ARCHES.includes(a));
  if (bad.length > 0) throw new Error(`不支持的架构：${bad.join(', ')}（可选 ${SUPPORTED_ARCHES.join(', ')}）`);

  const outDir = path.resolve(arg(argv, 'out', path.join(REPO, 'dist')));
  const nodeCache = arg(argv, 'node-cache');
  fs.mkdirSync(outDir, { recursive: true });

  const pack = await run('npm', ['pack', '--dry-run', '--json']);
  if (pack.code !== 0) throw new Error(`npm pack 失败：${pack.stderr.trim().split('\n').pop()}`);
  const files = packFileList(pack.stdout);

  const head = await run('git', ['rev-parse', 'HEAD']);
  const sourceSha = head.code === 0 ? head.stdout.trim() : null;

  log(`打包 v${version}（Node ${NODE_RUNTIME_VERSION}，${arches.join(' + ')}）→ ${outDir}`);

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-bundle-'));
  const sums = [];
  try {
    for (const arch of arches) {
      sums.push(await buildOne({ version, arch, outDir, scratch, files, nodeCache, sourceSha }));
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }

  fs.writeFileSync(path.join(outDir, SUMS_FILE), formatSums(sums));
  log(`\n${SUMS_FILE}：\n${formatSums(sums).trimEnd().split('\n').map((l) => `  ${l}`).join('\n')}`);
  log(`\n共 ${sums.length + 1} 个附件在 ${outDir}`);
}

if (isMainEntry(import.meta.url)) {
  try {
    await main();
  } catch (err) {
    process.stderr.write(`打包失败：${err.message}\n`);
    process.exitCode = 1;
  }
}
