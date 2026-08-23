/**
 * 把当前 dsh web 的实测 CWD 登记为它自己的 Workspace。
 *
 * 路径优先取队首重新读取的 HostView.web.cwd；旧状态缺诊断 CWD 时，才通过同一条
 * 已连通的 127.0.0.1 映射读取官方 host.describe，再调用 workspace.create。
 * 调用方没有任何路径入参。
 */

import { randomUUID } from 'node:crypto';

import { DshError } from './lib/errors.js';
import { hostQueue } from './lib/ssh.js';

export const DSH_WORKSPACE_RESPONSE_MAX_BYTES = 64 * 1024;
export const DSH_WORKSPACE_TIMEOUT_MS = 15_000;

const SAFE_MAPPED_URL_RE = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/$/u;
const activeHosts = new Set();

function workspaceError(code, message, host) {
  return new DshError(code, message, { host });
}

function protocolError(host) {
  return workspaceError(
    'WORKSPACE_REGISTER_FAILED',
    'dsh web 返回的 Workspace 响应无法安全确认，请稍后重试',
    host,
  );
}

function upstreamError(host) {
  return workspaceError(
    'WORKSPACE_REGISTER_FAILED',
    'dsh Workspace 登记失败，请稍后重试',
    host,
  );
}

function timeoutError(host) {
  return workspaceError(
    'WORKSPACE_REGISTER_TIMEOUT',
    'dsh Workspace 登记超时；创建操作是幂等的，可安全重试',
    host,
  );
}

function cwdUnavailableError(host) {
  return workspaceError(
    'WORKSPACE_CWD_UNAVAILABLE',
    '当前 dsh web 的实际工作目录不可用，请重启后再试',
    host,
  );
}

function acquireSlot(host) {
  if (activeHosts.has(host)) {
    throw workspaceError(
      'WORKSPACE_BUSY',
      '该主机已有 dsh Workspace 登记正在进行，请稍后重试',
      host,
    );
  }
  activeHosts.add(host);
  return () => activeHosts.delete(host);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasRequiredKeys(value, keys) {
  if (!isRecord(value)) return false;
  return keys.every((key) => Object.hasOwn(value, key));
}

function isAbsolutePath(value) {
  return typeof value === 'string' && value.startsWith('/') && !value.includes('\0');
}

function safeMappedUrl(value) {
  if (typeof value !== 'string') return null;
  const match = SAFE_MAPPED_URL_RE.exec(value);
  if (!match) return null;
  const port = Number(match[1]);
  return port >= 1 && port <= 65535 ? value : null;
}

function resolveCurrentView(host, resolveView) {
  let current;
  try {
    current = resolveView(host);
  } catch (error) {
    if (error instanceof DshError) throw error;
    throw workspaceError('INTERNAL', '读取主机当前状态失败，请稍后重试', host);
  }
  if (current !== null && (typeof current === 'object' || typeof current === 'function')) {
    let then;
    try {
      then = current.then;
    } catch {
      throw workspaceError('INTERNAL', '读取主机当前状态失败，请稍后重试', host);
    }
    if (typeof then === 'function') {
      Promise.resolve(current).catch(() => {});
      throw workspaceError('INTERNAL', '主机状态读取器必须同步返回当前视图', host);
    }
  }
  return current;
}

function requireRunnableView(host, resolveView) {
  const current = resolveCurrentView(host, resolveView);
  if (!current) throw workspaceError('NOT_FOUND', `未知主机 ${host}`, host);
  if (!['running', 'degraded'].includes(current.phase)) {
    throw workspaceError(
      'PHASE_CONFLICT',
      '登记 dsh Workspace 要求主机处于 running/degraded',
      host,
    );
  }

  const configuredWorkdir = current.config?.workdir ?? null;
  if (configuredWorkdir === null) {
    throw workspaceError(
      'WORKSPACE_WORKDIR_REQUIRED',
      '请先为主机配置启动目录并重启 dsh web，再登记 Workspace',
      host,
    );
  }
  if (current.web?.workdir !== configuredWorkdir) {
    throw workspaceError(
      'PHASE_CONFLICT',
      '启动目录尚未应用到当前实例，请重启此主机的 dsh web 后再登记',
      host,
    );
  }
  if (current.tunnel?.connected !== true) {
    throw workspaceError(
      'PHASE_CONFLICT',
      '当前 dsh web 映射尚未连通，请等待连接恢复后再登记 Workspace',
      host,
    );
  }

  const cwd = current.web?.cwd;
  const cwdMissing = cwd === null || cwd === undefined || cwd === '';
  if (!cwdMissing && !isAbsolutePath(cwd)) {
    throw workspaceError(
      'WORKSPACE_INVALID_PATH',
      '当前 dsh web 返回的工作目录不是绝对路径，无法登记',
      host,
    );
  }

  const mappedUrl = safeMappedUrl(current.mappedUrl);
  if (mappedUrl === null) throw protocolError(host);
  return { cwd: cwdMissing ? null : cwd, mappedUrl };
}

function linkSignals(signals) {
  const controller = new AbortController();
  const listeners = [];
  const abortFrom = (source) => {
    if (!controller.signal.aborted) controller.abort(source.reason);
  };
  for (const source of signals.filter(Boolean)) {
    if (source.aborted) {
      abortFrom(source);
      break;
    }
    const listener = () => abortFrom(source);
    source.addEventListener('abort', listener, { once: true });
    listeners.push([source, listener]);
  }
  return {
    signal: controller.signal,
    dispose() {
      for (const [source, listener] of listeners) source.removeEventListener('abort', listener);
    },
  };
}

async function abortable(signal, start) {
  if (signal.aborted) throw signal.reason;
  let onAbort;
  const aborted = new Promise((resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([
      Promise.resolve().then(start),
      aborted,
    ]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

function cancelBody(body) {
  try {
    const cancelled = body?.cancel?.();
    if (cancelled && typeof cancelled.catch === 'function') cancelled.catch(() => {});
  } catch {
    // 丢弃上游正文是尽力清理；清理失败不能覆盖原本的安全错误。
  }
}

async function readCappedJson(response, signal, host) {
  const length = response.headers?.get?.('content-length');
  if (/^[0-9]+$/u.test(length ?? '') && Number(length) > DSH_WORKSPACE_RESPONSE_MAX_BYTES) {
    cancelBody(response.body);
    throw protocolError(host);
  }

  const reader = response.body?.getReader?.();
  if (!reader) throw protocolError(host);
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const part = await abortable(signal, () => reader.read());
      if (!isRecord(part) || typeof part.done !== 'boolean') throw protocolError(host);
      if (part.done) break;
      if (!(part.value instanceof Uint8Array)) throw protocolError(host);
      total += part.value.byteLength;
      if (total > DSH_WORKSPACE_RESPONSE_MAX_BYTES) {
        cancelBody(reader);
        throw protocolError(host);
      }
      chunks.push(part.value);
    }
  } catch (error) {
    if (signal.aborted) cancelBody(reader);
    throw error;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // 已取消或已释放。
    }
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw protocolError(host);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw protocolError(host);
  }
}

function validWorkspace(value) {
  return hasRequiredKeys(value, [
    'workspaceId',
    'path',
    'title',
  ])
    && typeof value.workspaceId === 'string'
    && value.workspaceId.length > 0
    && isAbsolutePath(value.path)
    && typeof value.title === 'string';
}

function parseRpcResult(body, expectedRpcId, host, onError = () => {
  throw upstreamError(host);
}) {
  if (!hasRequiredKeys(body, ['type', 'rpcId', 'result'])) throw protocolError(host);
  if (body.type !== 'server-response' || body.rpcId !== expectedRpcId) throw protocolError(host);

  const { result } = body;
  if (!isRecord(result) || typeof result.ok !== 'boolean') throw protocolError(host);
  if (result.ok === false) {
    if (
      !hasRequiredKeys(result, ['ok', 'error'])
      || !hasRequiredKeys(result.error, ['code'])
      || typeof result.error.code !== 'string'
    ) {
      throw protocolError(host);
    }
    return onError(result.error.code);
  }
  if (!hasRequiredKeys(result, ['ok', 'value'])) throw protocolError(host);
  return result.value;
}

function parseWorkspaceResponse(body, expectedRpcId, host) {
  const value = parseRpcResult(body, expectedRpcId, host, (code) => {
    if (code === 'workspace-invalid-path') {
      throw workspaceError(
        'WORKSPACE_INVALID_PATH',
        'dsh web 无法登记当前实际工作目录，请确认目录仍存在且可访问',
        host,
      );
    }
    throw upstreamError(host);
  });
  if (
    !hasRequiredKeys(value, ['workspace', 'created'])
    || typeof value.created !== 'boolean'
    || !validWorkspace(value.workspace)
  ) {
    throw protocolError(host);
  }

  const { workspace, created } = value;
  return {
    created,
    workspaceId: workspace.workspaceId,
    title: workspace.title,
    path: workspace.path,
  };
}

function parseHostDescribeResponse(body, expectedRpcId, host) {
  const value = parseRpcResult(body, expectedRpcId, host);
  if (!isRecord(value)) throw protocolError(host);
  if (!hasRequiredKeys(value, ['cwd']) || !isAbsolutePath(value.cwd)) {
    throw cwdUnavailableError(host);
  }
  return value.cwd;
}

async function callDshRpc(host, {
  mappedUrl,
  method,
  payload,
  fetchImpl,
  signal,
  parseResponse,
}) {
  const rpcId = randomUUID();
  const body = JSON.stringify({
    type: 'client-request',
    rpcId,
    method,
    payload,
  });

  let response;
  try {
    response = await abortable(signal, () => fetchImpl(
      `${mappedUrl}api/${method}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal,
      },
    ));
  } catch (error) {
    if (signal.aborted || error?.name === 'AbortError' || error?.name === 'TimeoutError') {
      throw timeoutError(host);
    }
    if (error instanceof DshError) throw error;
    throw upstreamError(host);
  }

  if (!isRecord(response) || response.ok !== true) {
    cancelBody(response?.body);
    throw upstreamError(host);
  }

  let parsed;
  try {
    parsed = await readCappedJson(response, signal, host);
  } catch (error) {
    if (signal.aborted || error?.name === 'AbortError' || error?.name === 'TimeoutError') {
      throw timeoutError(host);
    }
    if (error instanceof DshError) throw error;
    throw protocolError(host);
  }
  return parseResponse(parsed, rpcId, host);
}

function callHostDescribeRpc(host, options) {
  return callDshRpc(host, {
    ...options,
    method: 'host.describe',
    payload: {},
    parseResponse: parseHostDescribeResponse,
  });
}

function callWorkspaceRpc(host, { cwd, ...options }) {
  return callDshRpc(host, {
    ...options,
    method: 'workspace.create',
    payload: { path: cwd },
    parseResponse: parseWorkspaceResponse,
  });
}

/**
 * @param {string} host
 * @param {{
 *   resolveView:(host:string)=>any,
 *   fetchImpl?:(url:string, init:object)=>Promise<any>,
 *   signal?:AbortSignal,
 *   timeoutMs?:number,
 * }} deps
 */
export async function registerDshWorkspace(host, {
  resolveView,
  fetchImpl = globalThis.fetch,
  signal,
  timeoutMs = DSH_WORKSPACE_TIMEOUT_MS,
} = {}) {
  if (typeof host !== 'string' || host.length === 0) {
    throw new DshError('VALIDATION', '主机名不能为空');
  }
  if (typeof resolveView !== 'function' || typeof fetchImpl !== 'function') {
    throw new DshError('VALIDATION', 'Workspace 登记缺少主机状态或 HTTP 执行器');
  }
  const boundedTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? Math.min(Math.trunc(timeoutMs), DSH_WORKSPACE_TIMEOUT_MS)
    : DSH_WORKSPACE_TIMEOUT_MS;
  const release = acquireSlot(host);
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(timeoutError(host)), boundedTimeout);
  const operation = linkSignals([deadline.signal, signal]);

  try {
    const queued = hostQueue(host).run('workspace-register', async (queueSignal) => {
      const running = linkSignals([operation.signal, queueSignal]);
      try {
        if (running.signal.aborted) throw timeoutError(host);
        const current = requireRunnableView(host, resolveView);
        const cwd = current.cwd ?? await callHostDescribeRpc(host, {
          mappedUrl: current.mappedUrl,
          fetchImpl,
          signal: running.signal,
        });
        return await callWorkspaceRpc(host, {
          ...current,
          cwd,
          fetchImpl,
          signal: running.signal,
        });
      } finally {
        running.dispose();
      }
    }, { timeoutMs: boundedTimeout });
    try {
      return await abortable(operation.signal, () => queued);
    } catch (error) {
      if (operation.signal.aborted || error?.code === 'SSH_TIMEOUT') throw timeoutError(host);
      throw error;
    }
  } finally {
    clearTimeout(timer);
    operation.dispose();
    release();
  }
}
