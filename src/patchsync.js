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
import { execFailure, scpTo, sshExec } from './lib/ssh.js';
import { REMOTE_DIR } from './defaults.js';

const HASH_PREFIX_LEN = 12;

/** SHA-256 前 12 位 hex；流式读文件，不整读内存。 */
export function hashFile(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex').slice(0, HASH_PREFIX_LEN)));
  });
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
 * @returns {Promise<{localPath:string, hash:string, remoteName:string}[]>}
 */
export async function buildManifest(patches) {
  const manifest = [];
  for (const localPath of patches) {
    try {
      fs.accessSync(localPath, fs.constants.R_OK);
      if (!fs.statSync(localPath).isFile()) throw new Error('不是普通文件');
    } catch (err) {
      throw new DshError('VALIDATION', `patch 文件不可读：${localPath}`, { detail: String(err.message ?? err) });
    }
    // eslint-disable-next-line no-await-in-loop -- 顺序读文件，避免同时开大量句柄
    const hash = await hashFile(localPath);
    manifest.push({ localPath, hash, remoteName: remoteName(hash, localPath) });
  }
  return manifest;
}

/**
 * 同步流程（12 §4.3）：清单 → 清理协议（先行，兼职 mkdir -p）→ 只传 hash 变更文件 →
 * 返回新的 patchSync 记录与 PATCH_ARGS 用的远端名清单（按 manifest 顺序）。
 *
 * @param {string} host
 * @param {string[]} patches
 * @param {{files:Record<string,{hash:string,remoteName:string,syncedAt:string|null}>}} previous
 * @param {{signal?:AbortSignal}} [opts]
 */
export async function syncPatches(host, patches, previous = { files: {} }, { signal } = {}) {
  const manifest = await buildManifest(patches);
  const keepNames = manifest.map((m) => m.remoteName);

  // 清理先行：删远端非清单文件（旧 hash 版本、已从 config 移除的 patch），并保证目录存在
  const cleanRes = await sshExec(host, buildPatchCleanupScript({ keepNames }), { signal });
  const cleanErr = execFailure(host, 'patch 目录清理', cleanRes);
  if (cleanErr) throw cleanErr;
  const cleanOut = parseProtoOutput(cleanRes.stdout, { requireDone: 'CLEAN_DONE' });
  if (kvOne(cleanOut, 'ERR') === 'mkdir') {
    throw new DshError('INTERNAL', `远端无法创建 patch 目录（${host}）`, { host, detail: cleanRes.stdout });
  }

  const files = {};
  let uploaded = 0;
  let skipped = 0;

  for (const item of manifest) {
    const prior = previous?.files?.[item.localPath];
    if (prior && prior.hash === item.hash && prior.syncedAt) {
      files[item.localPath] = { ...prior, remoteName: item.remoteName };
      skipped += 1;
      continue;
    }
    const rel = `${REMOTE_DIR}/patches/${item.remoteName}`;
    // eslint-disable-next-line no-await-in-loop -- 逐文件上载，失败即整体快败
    const res = await scpTo(host, item.localPath, rel, { signal });
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
