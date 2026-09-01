/**
 * 固定路径 dsh settings.yaml 领域模块。
 *
 * 内容只在内存与子进程 stdin 中短暂停留；协议错误一律丢弃原始输出，避免把可能含凭据的
 * content/hex/stdin 带进 DshError。远端与 local:true 共用协议、解析器和 hostQueue。
 */

import { randomUUID } from 'node:crypto';

import { DshError } from './lib/errors.js';
import { buildSettingsReadScript, buildSettingsWriteScript } from './lib/proto.js';
import { assertSafeHost } from './lib/shq.js';
import {
  execFailure,
  hostQueue,
  localExec,
  sshExec,
} from './lib/ssh.js';

export const SETTINGS_MAX_BYTES = 512 * 1024;

const CHECKSUM_RE = /^cksum-v1:(0|[1-9][0-9]{0,9}):(0|[1-9][0-9]{0,6})$/u;
const UINT_RE = /^(?:0|[1-9][0-9]*)$/u;
const KV_RE = /^([A-Z][A-Z0-9_]*)=(.*)$/u;
const BLOCK_RE = /^([A-Z][A-Z0-9_]*)<<([A-Z][A-Z0-9_]*)$/u;
const ASCII_WHITESPACE_RE = /[\t\n\v\f\r ]/gu;
const HEX_RE = /^[0-9a-fA-F]*$/u;
const CRC_POLYNOMIAL = 0x04c11db7;
const PROTO_MESSAGE = 'settings.yaml 协议响应无效，请重试';
const activeSettingsHosts = new Set();
const SETTINGS_DOMAIN_EXIT_CODES = new Set([1, 10, 11, 12]);

const CRC_TABLE = Object.freeze(Array.from({ length: 256 }, (_, index) => {
  let crc = (index << 24) >>> 0;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = (crc & 0x80000000) !== 0
      ? (((crc << 1) ^ CRC_POLYNOMIAL) >>> 0)
      : ((crc << 1) >>> 0);
  }
  return crc;
}));

function crcByte(crc, byte) {
  return (((crc << 8) >>> 0) ^ CRC_TABLE[((crc >>> 24) ^ byte) & 0xff]) >>> 0;
}

/**
 * POSIX `cksum` 使用的 CRC（IEEE 1003.1）：数据后追加最低字节优先的文件长度，再逐位取反。
 * 这不是密码学 hash，只用于与目标端 cksum 交叉验证及生成 CAS token。
 */
export function posixCksum(input) {
  if (!Buffer.isBuffer(input) && !(input instanceof Uint8Array)) {
    throw new TypeError('posixCksum input 必须是 Buffer 或 Uint8Array');
  }
  const bytes = Buffer.isBuffer(input)
    ? input
    : Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  let crc = 0;
  for (const byte of bytes) crc = crcByte(crc, byte);
  let length = bytes.byteLength;
  while (length > 0) {
    crc = crcByte(crc, length & 0xff);
    length = Math.floor(length / 256);
  }
  return (~crc) >>> 0;
}

function protocolError(host, operation = 'read') {
  const message = operation === 'write'
    ? 'settings.yaml 保存响应无法确认，保存结果未知，请先重新 GET 后确认实际内容'
    : PROTO_MESSAGE;
  return new DshError('PROTO_PARSE', message, { host });
}

function invalidUtf8Error(host) {
  return new DshError(
    'SETTINGS_INVALID_UTF8',
    'settings.yaml 不是有效的 UTF-8 文本，无法安全编辑',
    { host },
  );
}

function tooLargeError(host) {
  return new DshError(
    'SETTINGS_TOO_LARGE',
    'settings.yaml 超过 512 KiB，无法安全处理',
    { host },
  );
}

function cleanTransportError(operation, host, label, result) {
  const failure = execFailure(host, label, result);
  if (!failure) return protocolError(host, operation);
  // stderr 由对端控制，settings 命令甚至可能错误回显 stdin；领域边界不透传 detail/cause。
  const message = operation === 'write'
    ? `${failure.message}；保存结果未知，请重新 GET 后确认实际内容`
    : failure.message;
  return new DshError(failure.code, message, { host });
}

function assertOnlyKeys(record, allowed) {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw new Error('unexpected protocol key');
  }
}

function oneValue(frame, key) {
  const values = frame.kv[key];
  if (!values || values.length !== 1) throw new Error('missing or repeated protocol key');
  return values[0];
}

function decimal(value, max) {
  if (!UINT_RE.test(value)) throw new Error('invalid protocol integer');
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number > max) throw new Error('protocol integer out of range');
  return number;
}

function decodeHex(raw) {
  const hex = raw.replace(ASCII_WHITESPACE_RE, '');
  if (!HEX_RE.test(hex) || hex.length % 2 !== 0) throw new Error('invalid protocol hex');
  return Buffer.from(hex, 'hex');
}

function decodeUtf8(bytes) {
  // ignoreBOM=true 表示“不把 BOM 当签名吞掉”，从而保持 GET→PUT 字节全等。
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
}

function decodePath(raw) {
  const path = decodeUtf8(decodeHex(raw));
  if (
    path.length === 0
    || !path.startsWith('/')
    || path.includes('\0')
    || !path.endsWith('/settings.yaml')
  ) {
    throw new Error('invalid settings path');
  }
  return path;
}

/**
 * 只解析协议 framing，不把原文装入错误。块允许 POSIX od 的 ASCII 空白，重复块一律拒绝。
 */
function parseFrame(stdout) {
  const lines = String(stdout ?? '').replace(/\r\n/gu, '\n').split('\n');
  const kv = {};
  const blocks = {};

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === '') continue;

    const opener = BLOCK_RE.exec(line);
    if (opener) {
      const [, key, delimiter] = opener;
      if (Object.hasOwn(blocks, key)) throw new Error('repeated protocol block');
      const body = [];
      let closed = false;
      for (index += 1; index < lines.length; index += 1) {
        if (lines[index] === delimiter) {
          closed = true;
          break;
        }
        body.push(lines[index]);
      }
      if (!closed) throw new Error('truncated protocol block');
      blocks[key] = body.join('\n');
      continue;
    }

    const pair = KV_RE.exec(line);
    if (!pair) throw new Error('unexpected protocol line');
    (kv[pair[1]] ??= []).push(pair[2]);
  }

  return { kv, blocks };
}

function assertProtocolIdentity(frame, expectedTxn) {
  if (oneValue(frame, 'SETTINGS_PROTO') !== '1') throw new Error('unsupported protocol version');
  if (oneValue(frame, 'SETTINGS_TXN') !== expectedTxn) throw new Error('settings transaction mismatch');
}

function parseSuccessPath(frame, expectedBlocks) {
  assertOnlyKeys(frame.blocks, expectedBlocks);
  if (!Object.hasOwn(frame.blocks, 'PATH_HEX')) throw new Error('missing path block');
  return decodePath(frame.blocks.PATH_HEX);
}

/**
 * READ 成功结果解析测试缝。调用方只应传执行器的 code=0 ExecResult。
 * 任意 framing/CRC/size/path 故障统一折叠为无 detail/cause 的安全 PROTO_PARSE。
 */
export function _parseSettingsReadResult(result, host = null, expectedTxn) {
  try {
    if (
      result?.timedOut
      || result?.aborted
      || result?.code !== 0
      || result?.stdoutDropped !== 0
    ) {
      throw new Error('incomplete read result');
    }
    const frame = parseFrame(result.stdout);
    assertOnlyKeys(frame.kv, new Set([
      'SETTINGS_PROTO',
      'SETTINGS_TXN',
      'EXISTS',
      'SIZE',
      'CRC',
      'SETTINGS_READ_DONE',
    ]));
    assertProtocolIdentity(frame, expectedTxn);
    if (oneValue(frame, 'SETTINGS_READ_DONE') !== 'yes') throw new Error('missing read sentinel');
    const existsValue = oneValue(frame, 'EXISTS');
    if (existsValue !== 'yes' && existsValue !== 'no') throw new Error('invalid exists flag');
    const exists = existsValue === 'yes';
    const size = decimal(oneValue(frame, 'SIZE'), SETTINGS_MAX_BYTES);
    const path = parseSuccessPath(frame, new Set(['PATH_HEX', 'CONTENT_HEX']));
    if (!Object.hasOwn(frame.blocks, 'CONTENT_HEX')) throw new Error('missing content block');
    const contentBytes = decodeHex(frame.blocks.CONTENT_HEX);

    if (!exists) {
      if (size !== 0 || Object.hasOwn(frame.kv, 'CRC') || contentBytes.byteLength !== 0) {
        throw new Error('invalid missing-file shape');
      }
      return { exists: false, path, content: '', checksum: null, size: 0 };
    }

    const crc = decimal(oneValue(frame, 'CRC'), 0xffff_ffff);
    if (contentBytes.byteLength !== size || frame.blocks.CONTENT_HEX.replace(ASCII_WHITESPACE_RE, '').length !== size * 2) {
      throw new Error('content size mismatch');
    }
    if (posixCksum(contentBytes) !== crc) throw new Error('content checksum mismatch');

    let content;
    try {
      content = decodeUtf8(contentBytes);
    } catch {
      throw invalidUtf8Error(host);
    }
    return {
      exists: true,
      path,
      content,
      checksum: `cksum-v1:${crc}:${size}`,
      size,
    };
  } catch (error) {
    if (error instanceof DshError && error.code === 'SETTINGS_INVALID_UTF8') throw error;
    throw protocolError(host);
  }
}

function parseSettingsWriteResult(result, input, host, expectedTxn) {
  try {
    if (
      result?.timedOut
      || result?.aborted
      || result?.code !== 0
      || result?.stdoutDropped !== 0
    ) {
      throw new Error('incomplete write result');
    }
    const frame = parseFrame(result.stdout);
    assertOnlyKeys(frame.kv, new Set([
      'SETTINGS_PROTO',
      'SETTINGS_TXN',
      'NEW_SIZE',
      'NEW_CRC',
      'SETTINGS_WRITE_DONE',
    ]));
    assertProtocolIdentity(frame, expectedTxn);
    if (oneValue(frame, 'SETTINGS_WRITE_DONE') !== 'yes') throw new Error('missing write sentinel');
    const path = parseSuccessPath(frame, new Set(['PATH_HEX']));
    const size = decimal(oneValue(frame, 'NEW_SIZE'), SETTINGS_MAX_BYTES);
    const crc = decimal(oneValue(frame, 'NEW_CRC'), 0xffff_ffff);
    if (size !== input.byteLength || crc !== posixCksum(input)) {
      throw new Error('write verification mismatch');
    }
    return {
      updated: true,
      path,
      checksum: `cksum-v1:${crc}:${size}`,
      size,
    };
  } catch {
    throw protocolError(host, 'write');
  }
}

function hasExpectedTransaction(stdout, expectedTxn) {
  const lines = String(stdout ?? '').split(/\r?\n/u);
  return lines.some((line) => line === `SETTINGS_TXN=${expectedTxn}`);
}

function parseErrorFrame(result, operation, expectedTxn) {
  const frame = parseFrame(result.stdout);
  assertOnlyKeys(frame.kv, new Set(['SETTINGS_PROTO', 'SETTINGS_TXN', 'ERR', 'COMMIT_STATE']));
  assertOnlyKeys(frame.blocks, new Set());
  assertProtocolIdentity(frame, expectedTxn);
  const marker = oneValue(frame, 'ERR');
  const states = frame.kv.COMMIT_STATE;
  const commitState = states === undefined
    ? null
    : states.length === 1 && ['not-committed', 'unknown'].includes(states[0])
      ? states[0]
      : (() => { throw new Error('invalid commit state'); })();

  if (marker === 'settings-unsupported' && result.code === 1 && commitState === null) {
    return { code: 'SETTINGS_UNSUPPORTED', commitState };
  }
  if (operation === 'read') {
    if (commitState !== null) throw new Error('read result has commit state');
    if (marker === 'settings-too-large' && result.code === 10) {
      return { code: 'SETTINGS_TOO_LARGE', commitState };
    }
    if (marker === 'settings-read' && result.code === 1) {
      return { code: 'SETTINGS_READ_FAILED', commitState };
    }
    throw new Error('invalid read error marker');
  }

  if (marker === 'settings-too-large' && result.code === 10 && commitState !== null) {
    return { code: 'SETTINGS_TOO_LARGE', commitState };
  }
  if (marker === 'settings-stale' && result.code === 11 && commitState !== null) {
    return { code: 'SETTINGS_STALE', commitState };
  }
  if (marker === 'settings-write' && result.code === 12 && commitState !== null) {
    return { code: 'SETTINGS_WRITE_FAILED', commitState };
  }
  throw new Error('invalid write error marker');
}

function domainFailure(host, code, commitState) {
  if (commitState === 'unknown') {
    if (code === 'SETTINGS_STALE') {
      return new DshError(
        code,
        'settings.yaml 保存结果未知，请重新 GET 后确认实际内容',
        { host },
      );
    }
    return new DshError(
      'SETTINGS_WRITE_FAILED',
      'settings.yaml 保存结果未知，请重新 GET 后确认实际内容',
      { host },
    );
  }
  if (code === 'SETTINGS_TOO_LARGE') return tooLargeError(host);
  if (code === 'SETTINGS_UNSUPPORTED') {
    return new DshError(
      code,
      '该主机缺少兼容的 POSIX 文件工具，无法编辑 settings.yaml',
      { host },
    );
  }
  if (code === 'SETTINGS_READ_FAILED') {
    return new DshError(
      code,
      'settings.yaml 读取失败，请通过 SSH 检查文件类型与权限',
      { host },
    );
  }
  if (code === 'SETTINGS_STALE') {
    return new DshError(code, 'settings.yaml 已变化，请重新 GET 后再保存', { host });
  }
  return new DshError(code, 'settings.yaml 保存失败，请检查目标目录与文件权限', { host });
}

function assertExecutionSucceeded(operation, host, result, expectedTxn) {
  const label = operation === 'read' ? '读取 settings.yaml' : '保存 settings.yaml';
  if (result?.timedOut || result?.aborted) {
    throw cleanTransportError(operation, host, label, result);
  }
  if (result?.code === 0) return;

  if (
    SETTINGS_DOMAIN_EXIT_CODES.has(result?.code)
    && hasExpectedTransaction(result?.stdout, expectedTxn)
  ) {
    if (result?.stdoutDropped !== 0) throw protocolError(host, operation);
    try {
      const { code, commitState } = parseErrorFrame(result, operation, expectedTxn);
      throw domainFailure(host, code, commitState);
    } catch (error) {
      if (error instanceof DshError) throw error;
      throw protocolError(host, operation);
    }
  }
  throw cleanTransportError(operation, host, label, result);
}

function assertBaseChecksum(baseChecksum) {
  if (baseChecksum === null) return;
  if (typeof baseChecksum !== 'string') {
    throw new DshError(
      'VALIDATION',
      'baseChecksum 必须是 cksum-v1 token 或 null',
    );
  }
  const match = CHECKSUM_RE.exec(baseChecksum);
  if (
    !match
    || Number(match[1]) > 0xffff_ffff
    || Number(match[2]) > SETTINGS_MAX_BYTES
  ) {
    throw new DshError(
      'VALIDATION',
      'baseChecksum 格式无效，应为 cksum-v1:<CRC>:<字节数> 或 null',
    );
  }
}

function hasUnpairedSurrogate(content) {
  for (let index = 0; index < content.length; index += 1) {
    const unit = content.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = content.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function validateSettingsContent(content, host) {
  if (typeof content !== 'string') {
    throw new DshError('VALIDATION', 'content 必须是 string', { host });
  }
  if (hasUnpairedSurrogate(content)) {
    throw new DshError(
      'VALIDATION',
      'content 含未配对的 Unicode surrogate，无法无损编码为 UTF-8',
      { host },
    );
  }
  const size = Buffer.byteLength(content, 'utf8');
  if (size > SETTINGS_MAX_BYTES) throw tooLargeError(host);
  return size;
}

function assertResolveLocal(resolveLocal) {
  if (typeof resolveLocal !== 'function') {
    throw new DshError(
      'VALIDATION',
      'settings 操作必须提供 resolveLocal 以在队首读取最新主机配置',
    );
  }
}

function currentLocal(host, resolveLocal) {
  const local = resolveLocal(host);
  if (local !== null && (typeof local === 'object' || typeof local === 'function')) {
    let then;
    try {
      then = local.then;
    } catch {
      throw new DshError('INTERNAL', 'resolveLocal 返回值无法安全检查', { host });
    }
    if (typeof then === 'function') {
      // resolver 契约是同步的，但调用方若误传已拒绝 Promise，仍须立即挂 rejection handler，
      // 否则我们虽同步抛 VALIDATION，原 Promise 会在下一轮触发 unhandledRejection。
      Promise.resolve(local).catch(() => {});
      throw new DshError('VALIDATION', 'resolveLocal 必须是同步 resolver，不能返回 Promise', { host });
    }
  }
  if (typeof local !== 'boolean') {
    throw new DshError('VALIDATION', 'resolveLocal 必须返回 boolean', { host });
  }
  return local;
}

function acquireSettingsSlot(host) {
  if (activeSettingsHosts.has(host)) {
    throw new DshError(
      'SETTINGS_BUSY',
      '该主机已有 settings.yaml 操作正在进行，请稍后重试',
      { host },
    );
  }
  activeSettingsHosts.add(host);
  return () => activeSettingsHosts.delete(host);
}

function settingsTransaction(operation) {
  return `${operation}-${randomUUID()}`;
}

async function execute(host, local, command, { signal, input, user = null } = {}) {
  return local
    ? localExec(command, { signal, input })
    : sshExec(host, command, { signal, input, user });
}

/** 读取固定 `${DSH_HOME:-$HOME/.dsh}/settings.yaml`。 */
export async function readDshSettings(host, { resolveLocal, user = null } = {}) {
  assertSafeHost(host);
  assertResolveLocal(resolveLocal);
  const release = acquireSettingsSlot(host);
  try {
    return await hostQueue(host).run('settings-read', async (signal) => {
      const local = currentLocal(host, resolveLocal);
      const txn = settingsTransaction('read');
      const command = buildSettingsReadScript({ txn });
      const result = await execute(host, local, command, { signal, user });
      assertExecutionSucceeded('read', host, result, txn);
      return _parseSettingsReadResult(result, host, txn);
    });
  } finally {
    release();
  }
}

/**
 * 以 baseChecksum 做 CAS，原样写入固定 settings.yaml；成功响应不回显 content。
 */
export async function writeDshSettings(
  host,
  { resolveLocal, content, baseChecksum, user = null } = {},
) {
  assertSafeHost(host);
  assertResolveLocal(resolveLocal);
  assertBaseChecksum(baseChecksum);
  validateSettingsContent(content, host);
  const release = acquireSettingsSlot(host);
  try {
    // 512 KiB Buffer 只在成功占位后创建；排队上限由 activeSettingsHosts 保证为每主机一份。
    const input = Buffer.from(content, 'utf8');
    return await hostQueue(host).run('settings-write', async (signal) => {
      const local = currentLocal(host, resolveLocal);
      const txn = settingsTransaction('write');
      const command = buildSettingsWriteScript({
        txn,
        baseChecksum,
      });
      const result = await execute(host, local, command, { signal, input, user });
      assertExecutionSucceeded('write', host, result, txn);
      return parseSettingsWriteResult(result, input, host, txn);
    });
  } finally {
    release();
  }
}
