#!/usr/bin/env node
/**
 * 零 npm 依赖的 oxlint 入口。
 *
 * 首次运行从 GitHub Release 下载固定版本，校验发布资产的 SHA-256 后解包到
 * `.local/tools/`；后续直接复用本机缓存。下载、解 gzip 与 tar 提取都只用 Node
 * 内置能力，避免把 curl/tar 等机器差异带进质量闸门。
 */

import { spawn } from 'node:child_process';
import { createHash, timingSafeEqual } from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import https from 'node:https';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

import { isMainEntry } from '../src/lib/entry.js';

export const OXLINT_VERSION = '1.79.0';
export const OXLINT_PATHS = Object.freeze(['src', 'scripts', 'tests', 'site']);
/**
 * 基线只能减、不能增。当前 84 条全部是**有意为之**的两类，逐类说明留在这里，
 * 免得后来人拿「按 lint 的建议改一改」当清理：
 *
 *  - 70 条 `no-await-in-loop`：顺序等待就是要的语义（轮询、逐台推进、按序重试）。
 *    照建议改成 Promise.all 会把顺序执行变成并发，是行为变更而不是清理。
 *  - 14 条 `no-useless-spread`：`for (const x of [...coll])` 里的展开是**快照**，
 *    因为循环体会改这个集合（destroy 删 panes、kill 摘 inFlight、removeChild 改
 *    childNodes、监听器在回调里退订）。按建议去掉展开＝边迭代边改，是真缺陷。
 *    这一类是 lint 建议本身在这个代码库里是错的，别照做。
 *
 * 别的类别不该再出现在这张表里：出现了就是真该修，修完把这个数字调下来。
 */
export const OXLINT_MAX_WARNINGS = 84;
export const OXLINT_MAX_REDIRECTS = 5;
export const OXLINT_MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RELEASE_ROOT = 'https://github.com/oxc-project/oxc/releases/download';
const MAX_TAR_BYTES = 96 * 1024 * 1024;

// archiveSha256 逐字取自 apps_v1.79.0 的 GitHub Release 元数据；binarySha256
// 是在 archiveSha256 核验通过后，从各归档的唯一普通文件中提取并计算所得。两层都
// 固定，下载时防供应链漂移，缓存命中时防本机替换（包括伪装版本号的恶意文件）。
const TARGETS = Object.freeze({
  'darwin-arm64': Object.freeze({
    target: 'aarch64-apple-darwin',
    asset: 'oxlint-aarch64-apple-darwin.tar.gz',
    archiveSha256: '930e3656277ca6ad135fe7bda18e1f64886e0f8d0755df8b19cd6b499f12931b',
    binarySha256: '47eb5d3eaa12e2d0257708bee5150f99e6c82dc57ab6f8e6b31012a0d57aa8b1',
  }),
  'darwin-x64': Object.freeze({
    target: 'x86_64-apple-darwin',
    asset: 'oxlint-x86_64-apple-darwin.tar.gz',
    archiveSha256: 'debd377ff3e7929743c440c6f23546a99658f7b0271725718c45197ace49bc5a',
    binarySha256: '2d4cbde77aead322f8f7e15de53b92c345c2c945c14db7a3f8e07472bb71ce8a',
  }),
  'linux-x64': Object.freeze({
    target: 'x86_64-unknown-linux-gnu',
    asset: 'oxlint-x86_64-unknown-linux-gnu.tar.gz',
    archiveSha256: 'c7ddeff22c8d5ebd23648ff0917dd67a85178d86937acc3300ff4e974faaa042',
    binarySha256: '0e3409b31befa3a12a3332c9e222d13704cacc6427f90fbea68b8614aeedd6e1',
  }),
});

export function oxlintReleaseTag(version = OXLINT_VERSION) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`oxlint 版本号形状不对：${version}`);
  }
  return `apps_v${version}`;
}

export function oxlintPlatform(platform = process.platform, arch = process.arch) {
  const info = TARGETS[`${platform}-${arch}`];
  if (!info) {
    throw new Error(
      `当前平台没有可用的 oxlint ${OXLINT_VERSION}：${platform}/${arch}`
      + '（支持 darwin/arm64、darwin/x64、linux/x64）',
    );
  }
  return info.target;
}

export function oxlintAssetName(platform = process.platform, arch = process.arch) {
  oxlintPlatform(platform, arch);
  return TARGETS[`${platform}-${arch}`].asset;
}

export function oxlintDigests(platform = process.platform, arch = process.arch) {
  const info = targetInfo(platform, arch);
  return {
    archiveSha256: info.archiveSha256,
    binarySha256: info.binarySha256,
  };
}

export function oxlintDownloadUrl({
  version = OXLINT_VERSION,
  platform = process.platform,
  arch = process.arch,
} = {}) {
  const tag = oxlintReleaseTag(version);
  const asset = oxlintAssetName(platform, arch);
  return `${RELEASE_ROOT}/${tag}/${asset}`;
}

function targetInfo(platform, arch) {
  oxlintPlatform(platform, arch);
  return TARGETS[`${platform}-${arch}`];
}

export function oxlintArgs(paths = OXLINT_PATHS) {
  return [`--max-warnings=${OXLINT_MAX_WARNINGS}`, ...paths];
}

export function downloadResponsePolicy({
  url,
  status,
  location = null,
  contentLength = null,
  redirectsLeft = OXLINT_MAX_REDIRECTS,
}) {
  if (status >= 300 && status < 400) {
    if (!location) throw new Error(`下载 oxlint 遇到无地址的 HTTPS ${status} 重定向`);
    if (redirectsLeft <= 0) {
      throw new Error(`下载 oxlint 的 HTTPS 重定向超过 ${OXLINT_MAX_REDIRECTS} 次`);
    }
    let next;
    try {
      next = new URL(location, url);
    } catch (error) {
      throw new Error(`下载 oxlint 收到无效重定向地址：${location}`, { cause: error });
    }
    if (next.protocol !== 'https:') {
      throw new Error(`下载 oxlint 拒绝非 HTTPS 重定向：${next.href}`);
    }
    return { kind: 'redirect', url: next.href, redirectsLeft: redirectsLeft - 1 };
  }

  if (status !== 200) throw new Error(`下载 oxlint 失败：HTTPS ${status || '未知'}（${url}）`);

  let declaredBytes = null;
  if (contentLength !== null && contentLength !== undefined) {
    const text = String(contentLength);
    if (!/^\d+$/.test(text)) throw new Error(`oxlint 下载体积响应头无效：${text}`);
    declaredBytes = Number(text);
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes > OXLINT_MAX_ARCHIVE_BYTES) {
      throw new Error(`oxlint 下载体积异常：${text} 字节，已拒绝`);
    }
  }
  return { kind: 'download', declaredBytes };
}

export function accountDownloadBytes(received, chunkBytes) {
  const next = received + chunkBytes;
  if (
    !Number.isSafeInteger(received)
    || !Number.isSafeInteger(chunkBytes)
    || received < 0
    || chunkBytes < 0
    || next > OXLINT_MAX_ARCHIVE_BYTES
  ) {
    throw new Error(`oxlint 下载超过 ${OXLINT_MAX_ARCHIVE_BYTES} 字节上限，已中止`);
  }
  return next;
}

function openDownload(url, redirectsLeft = OXLINT_MAX_REDIRECTS) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    const request = https.get(url, {
      headers: {
        Accept: 'application/octet-stream',
        'User-Agent': `dsh-center-oxlint/${OXLINT_VERSION}`,
      },
    }, (response) => {
      const status = response.statusCode ?? 0;
      let decision;
      try {
        decision = downloadResponsePolicy({
          url,
          status,
          location: response.headers.location,
          contentLength: response.headers['content-length'],
          redirectsLeft,
        });
      } catch (error) {
        response.resume();
        fail(error);
        return;
      }

      if (decision.kind === 'redirect') {
        response.resume();
        settled = true;
        resolve(openDownload(decision.url, decision.redirectsLeft));
        return;
      }
      settled = true;
      resolve(response);
    });

    request.setTimeout(30_000, () => {
      request.destroy(new Error('下载 oxlint 超时（30 秒内没有网络数据）'));
    });
    request.on('error', fail);
  });
}

async function downloadArchive(url, destination) {
  const response = await openDownload(url);
  let received = 0;
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      try {
        received = accountDownloadBytes(received, chunk.length);
      } catch (error) {
        callback(error);
        return;
      }
      callback(null, chunk);
    },
  });
  await pipeline(response, meter, fsSync.createWriteStream(destination, { flags: 'wx' }));
}

function tarString(bytes) {
  const end = bytes.indexOf(0);
  return bytes.subarray(0, end === -1 ? bytes.length : end).toString('utf8');
}

function tarOctal(bytes, label) {
  const text = tarString(bytes).trim();
  if (!/^[0-7]+$/.test(text)) throw new Error(`oxlint 压缩包的 tar ${label} 字段损坏`);
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value)) throw new Error(`oxlint 压缩包的 tar ${label} 字段过大`);
  return value;
}

function tarChecksum(header) {
  let total = 0;
  for (let i = 0; i < header.length; i += 1) {
    total += i >= 148 && i < 156 ? 32 : header[i];
  }
  return total;
}

export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function sha256Equal(actual, expected) {
  if (!/^[a-f0-9]{64}$/.test(actual) || !/^[a-f0-9]{64}$/.test(expected)) return false;
  return timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
}

/**
 * 从受信版本但仍按不可信输入处理的 tar 中只取指定名称的普通文件。
 * 不在磁盘上展开路径，因此 `../`、绝对路径与链接都没有落地机会。
 */
export function extractOxlintFromTar(tar, expectedName = 'oxlint') {
  let offset = 0;
  let binary = null;
  let ended = false;

  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      if (
        offset + 1_024 > tar.length
        || !tar.subarray(offset, offset + 1_024).every((byte) => byte === 0)
        || !tar.subarray(offset + 1_024).every((byte) => byte === 0)
      ) {
        throw new Error('oxlint 压缩包的 tar 结束标记损坏');
      }
      ended = true;
      break;
    }

    const storedChecksum = tarOctal(header.subarray(148, 156), '校验和');
    if (tarChecksum(header) !== storedChecksum) {
      throw new Error('oxlint 压缩包的 tar 头校验和不匹配');
    }

    const name = tarString(header.subarray(0, 100));
    const prefix = tarString(header.subarray(345, 500));
    const fullName = prefix ? `${prefix}/${name}` : name;
    const normalized = path.posix.normalize(fullName);
    if (
      normalized.startsWith('../')
      || normalized.includes('/../')
      || path.posix.isAbsolute(normalized)
    ) {
      throw new Error(`oxlint 压缩包含不安全路径：${fullName}`);
    }

    const size = tarOctal(header.subarray(124, 136), '大小');
    const bodyStart = offset + 512;
    const bodyEnd = bodyStart + size;
    if (bodyEnd > tar.length) throw new Error('oxlint 压缩包的 tar 内容被截断');

    const type = header[156];
    const isRegularFile = type === 0 || type === 48;
    if (normalized === expectedName) {
      if (!isRegularFile) throw new Error('oxlint 压缩包中的目标不是普通文件');
      if (binary) throw new Error('oxlint 压缩包里出现了多个 oxlint 文件');
      if (size === 0 || size > MAX_TAR_BYTES) throw new Error(`oxlint 可执行文件体积异常：${size} 字节`);
      binary = Buffer.from(tar.subarray(bodyStart, bodyEnd));
    }

    offset = bodyStart + Math.ceil(size / 512) * 512;
  }

  if (!ended) throw new Error('oxlint 压缩包的 tar 结束标记缺失');
  if (!binary) throw new Error('oxlint 压缩包里找不到 oxlint 可执行文件');
  return binary;
}

export function decodeOxlintArchive(compressed, expectedName) {
  let tar;
  try {
    tar = gunzipSync(compressed, { maxOutputLength: MAX_TAR_BYTES });
  } catch (error) {
    throw new Error(`oxlint gzip 解压失败：${error.message}`, { cause: error });
  }
  return extractOxlintFromTar(tar, expectedName);
}

function run(binary, args, { capture = false } = {}) {
  return new Promise((resolve) => {
    const child = spawn(binary, args, {
      cwd: REPO,
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'inherit', 'inherit'],
    });
    let output = '';
    if (capture) {
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => { output += chunk; });
      child.stderr.on('data', (chunk) => { output += chunk; });
    }
    child.on('error', (error) => resolve({ code: 127, output: error.message }));
    child.on('close', (code, signal) => resolve({
      code: code ?? 1,
      output,
      signal,
    }));
  });
}

export async function cachedBinaryIsTrusted(binaryPath, expectedSha256, {
  lstat = fs.lstat,
  readFile = fs.readFile,
} = {}) {
  try {
    const stat = await lstat(binaryPath);
    if (!stat.isFile() || (stat.mode & 0o111) === 0) return false;
    return sha256Equal(sha256Hex(await readFile(binaryPath)), expectedSha256);
  } catch {
    return false;
  }
}

/**
 * 安装核心只收一份已固定的资产契约和一个取文件函数。生产传 HTTPS 下载器，测试传
 * 本地小归档；无论来源是什么，最终都从落盘字节重新算归档/二进制摘要并复核缓存。
 */
export async function installCachedOxlint({
  targetDir,
  asset,
  archiveSha256,
  binarySha256,
  fetchArchive,
  log = () => {},
}) {
  if (typeof fetchArchive !== 'function') throw new Error('oxlint 安装缺少归档获取函数');
  const binaryPath = path.join(targetDir, 'oxlint');
  if (await cachedBinaryIsTrusted(binaryPath, binarySha256)) {
    return { binaryPath, reused: true };
  }

  await fs.mkdir(targetDir, { recursive: true });
  // 无论是旧文件、软链还是目录，均先丢弃；绝不在未验证对象上就地修补。
  await fs.rm(binaryPath, { recursive: true, force: true });
  const scratch = await fs.mkdtemp(path.join(targetDir, '.install-'));
  const archivePath = path.join(scratch, asset);
  const stagedBinary = path.join(scratch, 'oxlint');

  try {
    log(`准备 oxlint ${OXLINT_VERSION}（首次运行需下载 ${asset}）...\n`);
    await fetchArchive(archivePath);
    const compressed = await fs.readFile(archivePath);
    if (compressed.length > OXLINT_MAX_ARCHIVE_BYTES) {
      throw new Error(`oxlint 下载超过 ${OXLINT_MAX_ARCHIVE_BYTES} 字节上限，已中止`);
    }
    const archiveDigest = sha256Hex(compressed);
    if (!sha256Equal(archiveDigest, archiveSha256)) {
      throw new Error(`oxlint 下载校验失败：期望 ${archiveSha256}，实际 ${archiveDigest}`);
    }

    const expectedName = asset.slice(0, -'.tar.gz'.length);
    const binary = decodeOxlintArchive(compressed, expectedName);
    const binaryDigest = sha256Hex(binary);
    if (!sha256Equal(binaryDigest, binarySha256)) {
      throw new Error(`oxlint 二进制校验失败：期望 ${binarySha256}，实际 ${binaryDigest}`);
    }
    await fs.writeFile(stagedBinary, binary, { flag: 'wx', mode: 0o755 });
    await fs.chmod(stagedBinary, 0o755);
    if (!await cachedBinaryIsTrusted(stagedBinary, binarySha256)) {
      throw new Error('oxlint 临时文件不是可信的可执行普通文件');
    }
    await fs.rename(stagedBinary, binaryPath);
    if (!await cachedBinaryIsTrusted(binaryPath, binarySha256)) {
      await fs.rm(binaryPath, { recursive: true, force: true });
      throw new Error('oxlint 缓存安装后的文件校验失败');
    }
    return { binaryPath, reused: false };
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
}

export async function ensureOxlint({
  platform = process.platform,
  arch = process.arch,
} = {}) {
  const info = targetInfo(platform, arch);
  const targetDir = path.join(REPO, '.local', 'tools', 'oxlint', OXLINT_VERSION, info.target);
  const result = await installCachedOxlint({
    targetDir,
    asset: info.asset,
    archiveSha256: info.archiveSha256,
    binarySha256: info.binarySha256,
    fetchArchive: (destination) => downloadArchive(
      oxlintDownloadUrl({ platform, arch }),
      destination,
    ),
    log: (message) => process.stdout.write(message),
  });
  return result.binaryPath;
}

async function main() {
  try {
    const binary = await ensureOxlint();
    // 警告完整展示，并用固定版本 + 固定路径得到的平台无关基线兜住：只能减，不能增。
    const result = await run(binary, oxlintArgs());
    if (result.signal) {
      process.stderr.write(`oxlint 被信号 ${result.signal} 中止\n`);
    }
    process.exitCode = result.code;
  } catch (error) {
    process.stderr.write(`oxlint 准备失败：${error.message}\n`);
    process.exitCode = 1;
  }
}

if (isMainEntry(import.meta.url)) await main();
