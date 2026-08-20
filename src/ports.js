/**
 * 本机映射端口分配（02 §6）：区间内取第一个「config 未占用 ∧ 本机未监听」的端口。
 * 分配即回写 config.hosts[x].localPort，此后固定——保证 iframe 地址与浏览器书签稳定。
 */

import net from 'node:net';

import { DshError } from './lib/errors.js';
import * as store from './store.js';

/** 试绑探测。单测可经 _setProbe 注入假实现。 */
const DEFAULT_PROBE = (port) => new Promise((resolve) => {
  const srv = net.createServer();
  srv.once('error', () => resolve(false));
  srv.once('listening', () => srv.close(() => resolve(true)));
  srv.listen(port, '127.0.0.1');
});

let probeFree = DEFAULT_PROBE;

export function isFree(port) {
  return probeFree(port);
}

/** 测试注入点；传 null/undefined 复位为真实试绑。 */
export function _setProbe(fn) {
  probeFree = typeof fn === 'function' ? fn : DEFAULT_PROBE;
}

/**
 * localPort 决策。config 已有 → 直接返回；否则区间内分配并回写。
 * @param {string} name
 * @returns {Promise<number>}
 * @throws {DshError} PORT_EXHAUSTED
 */
export async function ensureLocalPort(name) {
  const config = store.getConfig();
  const host = config.hosts[name];
  if (!host) throw new DshError('NOT_FOUND', `未知主机：${name}`, { host: name });
  if (host.localPort !== null && host.localPort !== undefined) return host.localPort;

  const [lo, hi] = config.defaults.localPortRange;
  const taken = new Set(
    Object.values(config.hosts)
      .map((h) => h.localPort)
      .filter((p) => Number.isInteger(p)),
  );

  for (let p = lo; p <= hi; p += 1) {
    if (taken.has(p)) continue;
    // eslint-disable-next-line no-await-in-loop -- 顺序探测才能取「第一个」可用端口
    if (!(await isFree(p))) continue;
    store.updateConfig((draft) => {
      draft.hosts[name].localPort = p;
    });
    return p;
  }

  throw new DshError(
    'PORT_EXHAUSTED',
    `本机映射端口区间 ${lo}-${hi} 已耗尽，无法为 ${name} 分配`,
    { host: name, detail: `已占用：${[...taken].sort((a, b) => a - b).join(', ')}` },
  );
}
