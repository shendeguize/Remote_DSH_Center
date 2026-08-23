/**
 * 假 manager 的路由表：`METHOD /path` → 引擎方法。
 *
 * 单独一个文件是为了让 node:test 能直接 import 它，逐端点校验响应形状
 * （tests/demo-contract.test.js）。它不碰 DOM、不碰全局，只做「解析 URL → 调引擎 →
 * 返回 {status, json|text}」，把 Response 的包装留给 demo-shim.js。
 *
 * 端点集合取自 13_api_schema.md §2/§3：18 个真实现，
 * 外加 manager 自身的 restart/shutdown 两个降级提示（浏览器里没有进程可操作）。
 */

import { FakeApiError } from './demo-manager.js';

/** [HTTP 方法, 路径正则, 路由 id]。顺序即匹配优先级。 */
const TABLE = Object.freeze([
  ['GET', /^\/api\/manager\/info$/, 'manager-info'],
  ['POST', /^\/api\/manager\/restart$/, 'manager-restart'],
  ['POST', /^\/api\/manager\/shutdown$/, 'manager-shutdown'],
  ['GET', /^\/api\/hosts$/, 'hosts'],
  ['GET', /^\/api\/config$/, 'config'],
  ['PUT', /^\/api\/config\/defaults$/, 'defaults-put'],
  ['POST', /^\/api\/reload$/, 'reload'],
  ['POST', /^\/api\/setup$/, 'setup'],
  ['POST', /^\/api\/hosts\/probe$/, 'probe-all'],
  ['POST', /^\/api\/hosts\/local$/, 'local-create'],
  ['POST', /^\/api\/hosts\/sync-config$/, 'sync-config'],
  ['POST', /^\/api\/hosts\/([^/]+)\/probe$/, 'probe'],
  ['POST', /^\/api\/hosts\/([^/]+)\/start$/, 'start'],
  ['POST', /^\/api\/hosts\/([^/]+)\/stop$/, 'stop'],
  ['POST', /^\/api\/hosts\/([^/]+)\/restart$/, 'restart'],
  ['POST', /^\/api\/hosts\/([^/]+)\/reconnect$/, 'reconnect'],
  ['GET', /^\/api\/hosts\/([^/]+)\/log$/, 'log'],
  ['GET', /^\/api\/hosts\/([^/]+)\/dsh-settings$/, 'dsh-settings-get'],
  ['PUT', /^\/api\/hosts\/([^/]+)\/dsh-settings$/, 'dsh-settings-put'],
  ['PUT', /^\/api\/hosts\/([^/]+)\/config$/, 'host-config-put'],
]);

/** 全部路由 id（契约测试据此确认一个都没漏接）。 */
export const ROUTE_IDS = Object.freeze(TABLE.map(([, , id]) => id));

/** 浏览器里没有 manager 进程可操作的那两个端点。 */
export const DEGRADED_ROUTES = Object.freeze(['manager-restart', 'manager-shutdown']);

const SETTINGS_TRAILING_SLASH_RE = /^\/api\/hosts\/[^/]+\/dsh-settings\/+$/u;
const SETTINGS_PATH_RE = /^\/api\/hosts\/[^/]+\/dsh-settings$/u;

/**
 * @param {string} method
 * @param {string} pathname
 * @returns {{route:string, name?:string}|null}
 */
export function matchRoute(method, pathname) {
  if (
    (method === 'GET' || method === 'PUT')
    && SETTINGS_TRAILING_SLASH_RE.test(pathname)
  ) {
    return null;
  }
  const p = pathname.replace(/\/+$/, '') || '/';
  for (const [verb, re, route] of TABLE) {
    if (verb !== method) continue;
    const m = re.exec(p);
    if (!m) continue;
    if (m[1] === undefined) return { route };
    try {
      return { route, name: decodeURIComponent(m[1]) };
    } catch {
      throw new FakeApiError(400, 'VALIDATION', '主机名 URL 编码无效');
    }
  }
  return null;
}

/** manager 在浏览器里没有进程可重启：给一个说清缘由的 409，前端照常弹错误 toast。 */
const notInDemo = (what) => new FakeApiError(
  409,
  'NOT_ALLOWED',
  `demo 中不支持${what}`,
  '在线 demo 的 manager 是浏览器里的模拟实现，没有真实进程可以操作。本机运行时该按钮可用。',
);

function rejectQuery(query, hasQueryDelimiter) {
  if (hasQueryDelimiter || query.toString() !== '') {
    throw new FakeApiError(400, 'VALIDATION', '该接口不接受 query 参数');
  }
}

/**
 * 派发一次请求。
 *
 * @param {object} manager createFakeManager 的返回值
 * @param {{
 *   method:string,
 *   pathname:string,
 *   query?:URLSearchParams,
 *   hasQueryDelimiter?:boolean,
 *   body?:any,
 * }} req
 * @returns {{status:number, json?:any, text?:string}}
 * @throws {FakeApiError} 由调用方翻成 §1.1 错误体
 */
export function dispatch(manager, {
  method,
  pathname,
  query = new URLSearchParams(),
  hasQueryDelimiter = false,
  body = undefined,
}) {
  if (
    (method === 'GET' || method === 'PUT')
    && SETTINGS_PATH_RE.test(pathname)
    && manager.managerInfo().setupGateActive
  ) {
    throw new FakeApiError(409, 'SETUP_REQUIRED', '首次配置尚未完成，该接口暂不可用');
  }
  const hit = matchRoute(method, pathname);
  if (!hit) throw new FakeApiError(404, 'NOT_FOUND', `demo 未实现的端点：${method} ${pathname}`);

  switch (hit.route) {
    case 'manager-info': return { status: 200, json: manager.managerInfo() };
    case 'hosts': return { status: 200, json: manager.hosts() };
    case 'config': return { status: 200, json: manager.config() };
    case 'local-create': {
      const request = body ?? {};
      if (typeof request !== 'object' || Array.isArray(request)) {
        throw new FakeApiError(400, 'VALIDATION', '请求体须为对象');
      }
      return { status: 201, json: manager.createLocalHost(request.name) };
    }
    case 'probe-all': return { status: 202, json: manager.probeAll() };
    case 'sync-config': return { status: 200, json: manager.syncHostConfig(body) };
    case 'probe': return { status: 202, json: manager.probeHost(hit.name) };
    case 'start': return { status: 202, json: manager.startHost(hit.name) };
    case 'stop': return { status: 202, json: manager.stopHost(hit.name) };
    case 'restart': return { status: 202, json: manager.restartHost(hit.name) };
    case 'reconnect': return { status: 202, json: manager.reconnectHost(hit.name) };
    case 'log': return { status: 200, text: manager.hostLog(hit.name, Number(query.get('lines') ?? 200)) };
    case 'dsh-settings-get':
      rejectQuery(query, hasQueryDelimiter);
      return { status: 200, json: manager.readDshSettings(hit.name) };
    case 'dsh-settings-put':
      rejectQuery(query, hasQueryDelimiter);
      return { status: 200, json: manager.writeDshSettings(hit.name, body) };
    case 'host-config-put': return { status: 200, json: manager.saveHostConfig(hit.name, body) };
    case 'defaults-put': return { status: 200, json: manager.saveDefaults(body ?? {}) };
    case 'reload': return { status: 200, json: manager.reload() };
    case 'setup': return { status: 200, json: manager.setup(body) };
    case 'manager-restart': throw notInDemo('重启 manager');
    case 'manager-shutdown': throw notInDemo('关停 manager');
    default: throw new FakeApiError(500, 'INTERNAL', `路由 ${hit.route} 未接线`);
  }
}
