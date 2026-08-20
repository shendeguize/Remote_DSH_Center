/**
 * hash 路由与 setup 守卫（10 §5）。解析部分是纯函数（DOM-free，可单测）；
 * 只有 attachRouter 触碰 location。
 */

/**
 * @param {string} hash
 * @returns {{kind:'dashboard'|'host'|'setup', host:string|null, raw:string}}
 */
export function parseRoute(hash) {
  const raw = typeof hash === 'string' && hash !== '' ? hash : '#/';
  const path = raw.replace(/^#/, '');

  if (path === '' || path === '/') return { kind: 'dashboard', host: null, raw: '#/' };
  if (path === '/setup') return { kind: 'setup', host: null, raw: '#/setup' };

  const m = /^\/host\/([^/]+)$/.exec(path);
  if (m) {
    let host;
    try {
      host = decodeURIComponent(m[1]);
    } catch {
      return { kind: 'dashboard', host: null, raw: '#/' }; // 坏编码按非法路由处理
    }
    if (host === '') return { kind: 'dashboard', host: null, raw: '#/' };
    return { kind: 'host', host, raw: `#/host/${m[1]}` };
  }

  return { kind: 'dashboard', host: null, raw: '#/' };
}

export function hostRoute(name) {
  return `#/host/${encodeURIComponent(name)}`;
}

/**
 * setup 守卫（10 §5.2）：未初始化时任何路由都改写到 #/setup；
 * setupCompleted 未知时先渲染骨架，避免管理台闪现。
 * @returns {{route:object, redirectTo:string|null, blocked:boolean}}
 */
export function applyGuard(route, { setupCompleted }) {
  if (setupCompleted === null || setupCompleted === undefined) {
    return { route, redirectTo: null, blocked: true };
  }
  if (setupCompleted === false && route.kind !== 'setup') {
    return { route: { kind: 'setup', host: null, raw: '#/setup' }, redirectTo: '#/setup', blocked: false };
  }
  return { route, redirectTo: null, blocked: false };
}

/** 主机路由是否可落地：只有隧道可用（有 mappedUrl）或 crashed 的已开主机才有 iframe。 */
export function canOpenHost(host) {
  if (!host) return false;
  return ['running', 'degraded', 'crashed'].includes(host.phase);
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
