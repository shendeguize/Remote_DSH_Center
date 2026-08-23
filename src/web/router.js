/**
 * hash 路由与 setup 守卫（10 §5）。解析部分是纯函数（DOM-free，可单测）；
 * 只有 attachRouter 触碰 location。
 */

import { isHostEnabled } from './host-rules.js';

/**
 * @param {string} hash
 * @returns {{kind:'root'|'hub'|'manage'|'host'|'setup'|'invalid', host:string|null, raw:string}}
 */
export function parseRoute(hash) {
  const raw = typeof hash === 'string' && hash !== '' ? hash : '#/';
  const path = raw.replace(/^#/, '');

  if (path === '' || path === '/') return { kind: 'root', host: null, raw: '#/' };
  if (path === '/hub') return { kind: 'hub', host: null, raw: '#/hub' };
  if (path === '/manage') return { kind: 'manage', host: null, raw: '#/manage' };
  if (path === '/setup') return { kind: 'setup', host: null, raw: '#/setup' };

  const m = /^\/host\/([^/]+)$/.exec(path);
  if (m) {
    let host;
    try {
      host = decodeURIComponent(m[1]);
    } catch {
      return { kind: 'invalid', host: null, raw };
    }
    if (host === '') return { kind: 'invalid', host: null, raw };
    return { kind: 'host', host, raw: `#/host/${m[1]}` };
  }

  return { kind: 'invalid', host: null, raw };
}

export function hostRoute(name) {
  return `#/host/${encodeURIComponent(name)}`;
}

export const LAST_HOST_KEY = 'dshc.lastHost';

/** localStorage 可能被禁用或由隐私策略拒绝，浏览器偏好失败不能阻断路由。 */
export function readLastHost(storage) {
  try {
    const target = storage === undefined ? globalThis.localStorage : storage;
    const value = target?.getItem(LAST_HOST_KEY);
    return typeof value === 'string' && value !== '' ? value : null;
  } catch {
    return null;
  }
}

export function rememberLastHost(name, storage) {
  if (typeof name !== 'string' || name === '') return false;
  try {
    const target = storage === undefined ? globalThis.localStorage : storage;
    if (!target?.setItem) return false;
    target.setItem(LAST_HOST_KEY, name);
    return true;
  } catch {
    return false;
  }
}

/** manager 与主机清单就绪后，为动态根路由选取最终落点。 */
export function rootRouteTarget(hosts, storage) {
  const lastHost = readLastHost(storage);
  if (lastHost) {
    for (const host of hosts) {
      if (host?.name === lastHost && isHostEnabled(host) && canOpenHost(host)) return hostRoute(lastHost);
    }
  }
  return '#/hub';
}

/**
 * setup 守卫（10 §5.2）：未初始化时任何路由都改写到 #/setup；
 * setupCompleted 未知时先渲染骨架，避免主界面闪现。非法路由统一归到 hub。
 * @returns {{route:object, redirectTo:string|null, blocked:boolean}}
 */
export function applyGuard(route, { setupCompleted }) {
  if (setupCompleted === null || setupCompleted === undefined) {
    return { route, redirectTo: null, blocked: true };
  }
  if (setupCompleted === false && route.kind !== 'setup') {
    return { route: { kind: 'setup', host: null, raw: '#/setup' }, redirectTo: '#/setup', blocked: false };
  }
  if (route.kind === 'invalid') {
    return { route: { kind: 'hub', host: null, raw: '#/hub' }, redirectTo: '#/hub', blocked: false };
  }
  return { route, redirectTo: null, blocked: false };
}

/** 主机路由是否可落地：starting 先落占位遮罩，其余三态承载已有/可建 iframe。 */
export function canOpenHost(host) {
  if (!host) return false;
  return ['starting', 'running', 'degraded', 'crashed'].includes(host.phase);
}

/**
 * 绑定 hashchange。返回 detach。
 * @param {(route:object)=>void} onRoute
 */
export function attachRouter(onRoute, { win = window } = {}) {
  const handle = () => onRoute(parseRoute(win.location.hash));
  win.addEventListener('hashchange', handle);
  handle();
  return () => win.removeEventListener('hashchange', handle);
}

export function navigate(to, { win = window, replace = false } = {}) {
  if (win.location.hash === to) {
    win.dispatchEvent(new win.HashChangeEvent('hashchange'));
    return;
  }
  if (replace) win.location.replace(to);
  else win.location.hash = to;
}
