/**
 * REST 客户端（10 §2 / UI-02）。同源相对 URL——页面绝不硬编码运行期端口。
 * 错误统一抛 ApiError（携带后端 13 §1.1 的 error/code/detail）。
 */

const JSON_HEADERS = { 'content-type': 'application/json' };
const DEFAULT_TIMEOUT_MS = 15_000;

export class ApiError extends Error {
  constructor({ status, code, message, detail }) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code ?? 'INTERNAL';
    this.detail = detail ?? null;
  }
}

async function call(method, path, { body, timeoutMs = DEFAULT_TIMEOUT_MS, as = 'json' } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: body === undefined ? undefined : JSON_HEADERS,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
      cache: 'no-store',
    });
  } catch (err) {
    clearTimeout(timer);
    const aborted = err.name === 'AbortError';
    throw new ApiError({
      status: 0,
      code: aborted ? 'SSH_TIMEOUT' : 'INTERNAL',
      message: aborted ? `请求超时（${method} ${path}）` : `无法连接 manager：${err.message}`,
      detail: null,
    });
  }
  clearTimeout(timer);

  const text = await res.text();
  if (!res.ok) {
    let payload = null;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
    throw new ApiError({
      status: res.status,
      code: payload?.code,
      message: payload?.error ?? `${method} ${path} 失败（HTTP ${res.status}）`,
      detail: payload?.detail ?? (text || null),
    });
  }

  if (as === 'text') return text;
  if (text === '') return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError({ status: res.status, code: 'PROTO_PARSE', message: '响应不是合法 JSON', detail: text });
  }
}

const enc = encodeURIComponent;

export const api = {
  managerInfo: () => call('GET', '/api/manager/info'),
  hosts: () => call('GET', '/api/hosts'),
  config: () => call('GET', '/api/config'),

  probeAll: () => call('POST', '/api/hosts/probe'),
  createLocalHost: (name) => call('POST', '/api/hosts/local', {
    body: name === undefined ? {} : { name },
  }),
  probeHost: (name) => call('POST', `/api/hosts/${enc(name)}/probe`),
  startHost: (name) => call('POST', `/api/hosts/${enc(name)}/start`),
  stopHost: (name) => call('POST', `/api/hosts/${enc(name)}/stop`),
  restartHost: (name) => call('POST', `/api/hosts/${enc(name)}/restart`),
  reconnectHost: (name) => call('POST', `/api/hosts/${enc(name)}/reconnect`),
  syncHostConfig: ({
    source, targets, dryRun, previewToken,
  }) => call('POST', '/api/hosts/sync-config', {
    body: {
      source,
      targets,
      dryRun,
      ...(previewToken === undefined ? {} : { previewToken }),
    },
  }),

  hostLog: (name, lines = 200) => call('GET', `/api/hosts/${enc(name)}/log?lines=${lines}`, { as: 'text', timeoutMs: 30_000 }),
  saveHostConfig: (name, patch) => call('PUT', `/api/hosts/${enc(name)}/config`, { body: patch }),
  saveDefaults: (patch) => call('PUT', '/api/config/defaults', { body: patch }),
  reload: () => call('POST', '/api/reload'),

  setup: (config) => call('POST', '/api/setup', { body: config, timeoutMs: 30_000 }),
  restartManager: () => call('POST', '/api/manager/restart'),
  shutdownManager: () => call('POST', '/api/manager/shutdown'),

  /** 迁移页用：探测目标 origin 是否已就绪（10 §3.5，端口来自用户提交值）。 */
  probeOrigin: async (origin, { timeoutMs = 2_000 } = {}) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${origin}/api/manager/info`, { signal: controller.signal, cache: 'no-store' });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  },
};

export { call as rawCall };
