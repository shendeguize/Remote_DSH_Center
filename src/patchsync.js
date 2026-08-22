/**
 * patch 同步器（12 §4）。
 *
 * 落在业务层而非 src/lib/：它依赖 lib/ssh + lib/proto 两个叶子，放进 lib/ 会破坏
 * 「lib 之间只允许 proto → shq 一条边」的防环规则（11 §1.3）。RMT-07 允许并入
 * launcher.js，此处单独成文件只为可单测。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { DshError } from './lib/errors.js';
import { buildPatchCleanupScript, kvOne, parseProtoOutput } from './lib/proto.js';
import {
  execFailure,
  localCopy,
  prepareLocalCopyTarget,
  scpTo,
  sshExec,
} from './lib/ssh.js';
import { REMOTE_DIR } from './defaults.js';

const HASH_PREFIX_LEN = 12;
const LOCAL_NAME_ATTEMPT_LIMIT = 256;

/** SHA-256；流式读文件，不整读内存。 */
function digestFile(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/** SHA-256 前 12 位 hex。 */
export async function hashFile(file) {
  return (await digestFile(file)).slice(0, HASH_PREFIX_LEN);
}

/** 本地 basename → 远端安全名片段（12 §4.2）。 */
export function safeBase(localPath) {
  let base = path.basename(localPath).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64);
  base = base.replace(/^[-.]+/, '');
  return base === '' ? 'patch' : base;
}

/** 内容变则名变，天然免疫「本地改了远端还是旧的」。 */
export function remoteName(hash, localPath) {
  return `${hash}-${safeBase(localPath)}`;
}

/**
 * 建立本次清单。任一文件不可读即快败（patch 缺失会静默改变 dsh 行为，宁可失败）。
 * @param {string[]} patches 本地绝对路径
 * @returns {Promise<{localPath:string, hash:string, contentHash:string,
 *   size:number, remoteName:string}[]>}
 */
export async function buildManifest(patches) {
  const manifest = [];
  for (const localPath of patches) {
    let stat;
    try {
      fs.accessSync(localPath, fs.constants.R_OK);
      stat = fs.statSync(localPath);
      if (!stat.isFile()) throw new Error('不是普通文件');
    } catch (err) {
      throw new DshError('VALIDATION', `patch 文件不可读：${localPath}`, { detail: String(err.message ?? err) });
    }
    // eslint-disable-next-line no-await-in-loop -- 顺序读文件，避免同时开大量句柄
    const contentHash = await digestFile(localPath);
    const hash = contentHash.slice(0, HASH_PREFIX_LEN);
    manifest.push({
      localPath,
      hash,
      contentHash,
      size: stat.size,
      remoteName: remoteName(hash, localPath),
    });
  }
  return manifest;
}

function localTargetIdentity(target) {
  const lexical = path.resolve(target);
  try {
    fs.lstatSync(lexical);
  } catch (err) {
    if (err?.code === 'ENOENT') return { lexical, real: lexical, exists: false };
    throw new DshError('LOCAL_COPY_FAILED', '本机 patch 目标路径不可访问', {
      detail: `路径：${target}\n${String(err.message ?? err)}`,
      cause: err instanceof Error ? err : undefined,
    });
  }

  try {
    return { lexical, real: fs.realpathSync(lexical), exists: true };
  } catch {
    // dangling symlink / 无权读取的既有项也算占用；不能把它当成空位覆盖。
    return { lexical, real: null, exists: true };
  }
}

async function inspectLocalTarget(remoteName) {
  const rel = `${REMOTE_DIR}/patches/${remoteName}`;
  const { target } = await prepareLocalCopyTarget(rel);
  return { rel, ...localTargetIdentity(target) };
}

function identityKeys(identity) {
  return [...new Set([identity.lexical, identity.real].filter(Boolean))];
}

function sourceIdentity(item) {
  try {
    const lexical = path.resolve(item.localPath);
    const real = fs.realpathSync(item.localPath);
    const key = crypto
      .createHash('sha256')
      .update(lexical)
      .update('\0')
      .update(real)
      .digest('hex')
      .slice(0, 16);
    return { lexical, real, key };
  } catch (err) {
    throw new DshError('VALIDATION', `patch 文件真实路径不可读：${item.localPath}`, {
      detail: String(err.message ?? err),
      cause: err instanceof Error ? err : undefined,
    });
  }
}

function alternateLocalName(item, sourceKey, attempt) {
  const contentKey = item.contentHash.slice(0, 16);
  const ordinal = attempt === 0 ? '' : `-${attempt}`;
  return `${contentKey}-local-${sourceKey}${ordinal}-${safeBase(item.localPath)}`;
}

async function localTargetHasContent(target, item) {
  if (!target.exists || target.real === null) return false;
  try {
    const stat = fs.statSync(target.lexical);
    if (!stat.isFile() || stat.size !== item.size) return false;
    return await digestFile(target.lexical) === item.contentHash;
  } catch {
    // 无法证明内容相同就必须避让，不能覆盖未知既有项。
    return false;
  }
}

function reservationFor(target, reservations, contentHash) {
  const claims = identityKeys(target)
    .map((key) => reservations.get(key))
    .filter(Boolean);
  return {
    conflict: claims.some((claim) => claim !== contentHash),
    matching: claims.some((claim) => claim === contentHash),
  };
}

function reserveTarget(target, reservations, contentHash) {
  for (const key of identityKeys(target)) reservations.set(key, contentHash);
}

function noSafeLocalTarget(item) {
  const sourceKey = crypto
    .createHash('sha256')
    .update(path.resolve(item.localPath))
    .digest('hex')
    .slice(0, HASH_PREFIX_LEN);
  return new DshError('LOCAL_COPY_FAILED', '本机 patch 找不到不会覆盖既有文件的安全目标', {
    detail: `源：${item.localPath}\n已检查初始目标与 ${LOCAL_NAME_ATTEMPT_LIMIT} 个稳定候选（源摘要 ${sourceKey}）`,
  });
}

/**
 * 本机源与生成物共用 patches/ 命名空间。既有目标只有在与当前源是同一真实文件、
 * 或逐内容摘要相等时才可复用；否则依次尝试由内容+源身份摘要生成的稳定安全名。
 * 整个计划完成前不复制任何文件，故不会因执行顺序覆盖后续源。
 */
async function planLocalManifest(manifest) {
  const sources = manifest.map(sourceIdentity);
  const reservations = new Map();
  const planned = [];

  for (let index = 0; index < manifest.length; index += 1) {
    const item = manifest[index];
    const source = sources[index];
    let selected = null;

    for (let attempt = -1; attempt < LOCAL_NAME_ATTEMPT_LIMIT; attempt += 1) {
      const selectedName = attempt < 0
        ? item.remoteName
        : alternateLocalName(item, source.key, attempt);
      // eslint-disable-next-line no-await-in-loop -- 候选必须逐个查真实路径与内容，且循环有硬上限
      const target = await inspectLocalTarget(selectedName);
      const reservation = reservationFor(target, reservations, item.contentHash);
      if (reservation.conflict) continue;

      if (target.exists) {
        const sameSource = target.real !== null && target.real === source.real;
        // eslint-disable-next-line no-await-in-loop -- 已存在候选必须先证明内容相同，绝不盲目覆盖
        if (!sameSource && !(await localTargetHasContent(target, item))) continue;
        selected = { ...item, remoteName: selectedName, copyNeeded: false };
      } else {
        selected = {
          ...item,
          remoteName: selectedName,
          copyNeeded: !reservation.matching,
        };
      }

      reserveTarget(target, reservations, item.contentHash);
      break;
    }

    if (selected === null) throw noSafeLocalTarget(item);
    planned.push(selected);
  }
  return planned;
}

/**
 * 同步流程（12 §4.3）：清单 → 远端清理协议（本机永久跳过）→ 只传 hash 变更文件 →
 * 返回新的 patchSync 记录与 PATCH_ARGS 用的目标名清单（按 manifest 顺序）。
 *
 * 本机 patches/ 与用户文件共用命名空间，无法可靠区分旧生成物和用户源，所以只由
 * localCopy 原子覆盖当前目标，绝不主动删除目录内其他文件；远端仍先清理旧目标。
 *
 * @param {string} host
 * @param {string[]} patches
 * @param {{files:Record<string,{hash:string,remoteName:string,syncedAt:string|null}>}} previous
 * @param {{signal?:AbortSignal, local?:boolean}} [opts]
 */
export async function syncPatches(
  host,
  patches,
  previous = { files: {} },
  { signal, local = false } = {},
) {
  const baseManifest = await buildManifest(patches);
  const manifest = local ? await planLocalManifest(baseManifest) : baseManifest;
  const keepNames = manifest.map((m) => m.remoteName);

  if (!local) {
    // 远端清理先行：删除旧 hash 与已移除项，并兼职保证目录存在。
    const cleanup = buildPatchCleanupScript({ keepNames });
    const cleanRes = await sshExec(host, cleanup, { signal });
    const cleanErr = execFailure(host, 'patch 目录清理', cleanRes);
    if (cleanErr) throw cleanErr;
    const cleanOut = parseProtoOutput(cleanRes.stdout, { requireDone: 'CLEAN_DONE' });
    if (kvOne(cleanOut, 'ERR') === 'mkdir') {
      throw new DshError('INTERNAL', `远端无法创建 patch 目录（${host}）`, {
        host,
        detail: cleanRes.stdout,
      });
    }
  }

  const files = {};
  let uploaded = 0;
  let skipped = 0;

  for (const item of manifest) {
    const prior = previous?.files?.[item.localPath];
    if (local && !item.copyNeeded) {
      const samePrior = prior
        && prior.hash === item.hash
        && prior.remoteName === item.remoteName
        && prior.syncedAt;
      files[item.localPath] = samePrior
        ? { ...prior, remoteName: item.remoteName }
        : {
          hash: item.hash,
          remoteName: item.remoteName,
          syncedAt: new Date().toISOString(),
        };
      skipped += 1;
      continue;
    }
    if (
      prior
      && prior.hash === item.hash
      && !local
      && prior.syncedAt
    ) {
      files[item.localPath] = { ...prior, remoteName: item.remoteName };
      skipped += 1;
      continue;
    }
    const rel = `${REMOTE_DIR}/patches/${item.remoteName}`;
    // eslint-disable-next-line no-await-in-loop -- 逐文件上载，失败即整体快败
    const res = local
      ? await localCopy(item.localPath, rel, { signal })
      : await scpTo(host, item.localPath, rel, { signal });
    const err = execFailure(host, `patch 上载 ${path.basename(item.localPath)}`, res);
    if (err) throw err;
    files[item.localPath] = {
      hash: item.hash,
      remoteName: item.remoteName,
      syncedAt: new Date().toISOString(),
    };
    uploaded += 1;
  }

  return { patchSync: { files }, remoteNames: keepNames, uploaded, skipped };
}
