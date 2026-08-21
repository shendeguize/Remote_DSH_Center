/**
 * 本机 HTTP 面的跨站防线（纯函数，便于逐条判定）。
 *
 * manager 只监听 127.0.0.1，但「只听本机」挡不住**浏览器**替别人发请求：用户随便打开
 * 一个网页，那个网页就能 `fetch('http://127.0.0.1:<port>/api/hosts/x/start')`。这种简单
 * 请求不触发预检，浏览器照发；攻击者读不到响应，可副作用照样发生——实测里一个陌生
 * origin 的页面真把远端会话拉起来了。
 *
 * 两道闸：
 *
 * 1. `Origin` 在场就必须是 manager 自己的 origin。命令行工具不带这个头，一律放行；
 *    浏览器发跨站请求时必带，于是被挡。
 * 2. `Host` 必须是环回名。DNS rebinding 的落地形态就是「攻击者域名解析到 127.0.0.1」，
 *    那时浏览器认为同源，第 1 道闸失效，只有这道拦得住。
 */

/** 允许出现在 Host / Origin 里的主机名。 */
const LOOPBACK_NAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/** Host 头里取主机名：去掉端口，IPv6 的方括号一并留着比对。 */
export function hostnameOf(hostHeader) {
  const raw = String(hostHeader ?? '').trim();
  if (raw === '') return '';
  if (raw.startsWith('[')) return raw.slice(0, raw.indexOf(']') + 1).toLowerCase();
  const i = raw.lastIndexOf(':');
  return (i === -1 ? raw : raw.slice(0, i)).toLowerCase();
}

export function isLoopbackHost(hostHeader) {
  return LOOPBACK_NAMES.has(hostnameOf(hostHeader));
}

/**
 * @param {{headers:Record<string,string|undefined>, port:number}} req
 * @returns {{ok:true}|{ok:false, status:number, code:string, message:string}}
 */
export function checkRequestOrigin({ headers = {}, port }) {
  const host = headers.host ?? headers.Host;
  if (!isLoopbackHost(host)) {
    return {
      ok: false,
      status: 403,
      code: 'FORBIDDEN_HOST',
      // 不回显攻击者给的域名：这段文本会原样出现在响应体里
      message: 'manager 只接受来自本机的请求（Host 必须是 127.0.0.1 或 localhost）。',
    };
  }

  const origin = headers.origin ?? headers.Origin;
  if (origin === undefined || origin === '') return { ok: true };
  // 'null' 是 file:// 与沙箱 iframe 的 origin，同样不是自己
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    return { ok: false, status: 403, code: 'FORBIDDEN_ORIGIN', message: 'manager 拒绝跨站请求。' };
  }
  const sameOrigin = parsed.protocol === 'http:'
    && LOOPBACK_NAMES.has(parsed.hostname.toLowerCase())
    && parsed.port === String(port);
  return sameOrigin
    ? { ok: true }
    : { ok: false, status: 403, code: 'FORBIDDEN_ORIGIN', message: 'manager 拒绝跨站请求。' };
}
