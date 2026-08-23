/**
 * REST 客户端（10 §2 / UI-02）。同源相对 URL——页面绝不硬编码运行期端口。
 * 错误统一抛 ApiError（携带后端 13 §1.1 的 error/code/detail）。
 */

const JSON_HEADERS = { 'content-type': 'application/json' };
const DEFAULT_TIMEOUT_MS = 15_000;
const SETTINGS_TIMEOUT_MS = 30_000;
const SETTINGS_MUTATION_UNKNOWN_MESSAGE = '保存结果未知，请重新加载后确认';
const SETTINGS_ERROR_MESSAGES = Object.freeze({
  SETTINGS_STALE: 'dsh 配置文件已变化，请重新加载后再保存',
  SETTINGS_TOO_LARGE: 'dsh 配置文件超过大小限制，无法处理',
  SETTINGS_UNSUPPORTED: '该主机不支持安全编辑 dsh 配置文件',
  SETTINGS_INVALID_UTF8: 'dsh 配置文件不是有效的 UTF-8 文本',
  SETTINGS_READ_FAILED: '读取 dsh 配置文件失败，请稍后重试',
  SETTINGS_WRITE_FAILED: '保存 dsh 配置文件失败，请重新加载确认结果',
  SETTINGS_BUSY: '该主机已有 dsh 配置操作正在进行，请稍后重试',
  SSH_TIMEOUT: 'dsh 配置请求超时，请稍后重试',
  SSH_UNREACHABLE: '无法连接目标主机，请稍后重试',
  LOCAL_TIMEOUT: '本机 dsh 配置请求超时，请稍后重试',
  LOCAL_EXEC_FAILED: '本机 dsh 配置操作失败，请稍后重试',
  LOCAL_COPY_FAILED: '本机 dsh 配置传输失败，请稍后重试',
  NOT_FOUND: '目标主机不存在或已被删除',
  VALIDATION: 'dsh 配置请求无效，请检查后重试',
  PROTO_PARSE: 'dsh 配置响应无法解析，请重试',
  INTERNAL: 'dsh 配置请求失败，请稍后重试',
});
const SETTINGS_MUTATION_UNCERTAIN_CODES = new Set([
  'SSH_TIMEOUT',
  'SSH_UNREACHABLE',
  'LOCAL_TIMEOUT',
  'LOCAL_EXEC_FAILED',
  'LOCAL_COPY_FAILED',
  'PROTO_PARSE',
  'INTERNAL',
]);

function safeSettingsHttpError(rawCode, status, mutationResultUnknown) {
  const known = typeof rawCode === 'string'
    && Object.hasOwn(SETTINGS_ERROR_MESSAGES, rawCode);
  const code = known ? rawCode : 'INTERNAL';
  const message = mutationResultUnknown
    && (!known || SETTINGS_MUTATION_UNCERTAIN_CODES.has(code))
    ? SETTINGS_MUTATION_UNKNOWN_MESSAGE
    : (known
      ? SETTINGS_ERROR_MESSAGES[code]
      : `dsh 配置请求失败（HTTP ${status}）`);
  return { code, message };
}

export class ApiError extends Error {
  constructor({ status, code, message, detail }) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code ?? 'INTERNAL';
    this.detail = detail ?? null;
  }
}

async function call(method, path, {
  body,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  as = 'json',
  redactParseError = false,
  redactErrorResponse = false,
  mutationResultUnknown = false,
} = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  let text;
  try {
    res = await fetch(path, {
      method,
      headers: body === undefined ? undefined : JSON_HEADERS,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
      cache: 'no-store',
    });
    text = await res.text();
  } catch (err) {
    const aborted = err?.name === 'AbortError' || controller.signal.aborted;
    if (!aborted && res && !redactErrorResponse) throw err;
    throw new ApiError({
      status: 0,
      code: aborted ? 'SSH_TIMEOUT' : 'INTERNAL',
      message: mutationResultUnknown
        ? SETTINGS_MUTATION_UNKNOWN_MESSAGE
        : redactErrorResponse
        ? (aborted ? SETTINGS_ERROR_MESSAGES.SSH_TIMEOUT : SETTINGS_ERROR_MESSAGES.INTERNAL)
        : (aborted ? `请求超时（${method} ${path}）` : `无法连接 manager：${err.message}`),
      detail: null,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    let payload = null;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
    const rawCode = typeof payload?.code === 'string' ? payload.code : undefined;
    const safeError = redactErrorResponse
      ? safeSettingsHttpError(rawCode, res.status, mutationResultUnknown)
      : null;
    throw new ApiError({
      status: res.status,
      code: safeError?.code ?? rawCode,
      message: redactErrorResponse
        ? safeError.message
        : (payload?.error ?? `${method} ${path} 失败（HTTP ${res.status}）`),
      detail: redactErrorResponse ? null : (payload?.detail ?? (text || null)),
    });
  }

  if (as === 'text') return text;
  if (text === '') {
    if (!redactParseError) return null;
    throw new ApiError({
      status: res.status,
      code: 'PROTO_PARSE',
      message: mutationResultUnknown ? SETTINGS_MUTATION_UNKNOWN_MESSAGE : '响应不是合法 JSON',
      detail: null,
    });
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError({
      status: res.status,
      code: 'PROTO_PARSE',
      message: mutationResultUnknown ? SETTINGS_MUTATION_UNKNOWN_MESSAGE : '响应不是合法 JSON',
      detail: redactParseError ? null : text,
    });
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
  getDshSettings: (name) => call('GET', `/api/hosts/${enc(name)}/dsh-settings`, {
    timeoutMs: SETTINGS_TIMEOUT_MS,
    redactParseError: true,
    redactErrorResponse: true,
  }),
  saveDshSettings: (name, { content, baseChecksum }) => call(
    'PUT',
    `/api/hosts/${enc(name)}/dsh-settings`,
    {
      body: { content, baseChecksum },
      timeoutMs: SETTINGS_TIMEOUT_MS,
      redactParseError: true,
      redactErrorResponse: true,
      mutationResultUnknown: true,
    },
  ),
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
