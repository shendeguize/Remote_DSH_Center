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
 * 分配闸（issue #94）。
 *
 * 一次分配是「读 config 算已占用 → await 试绑 → 回写 config」：读在 await 之前、
 * 写在之后。两台同时进来，两边看到的都是同一份旧账，于是分到同一个号。而 localPort
 * 是分配即回写、此后固定的（iframe 地址和书签要稳），撞号会被**永久**写进 config——
 * 后面那几台的隧道每次都撞 `bind: Address already in use`，被判成 local-port-busy 挂起，
 * 提示还让用户去找「占端口的进程」，可占号的正是 manager 自己的另一条隧道。重启修不回来。
 *
 * 跑得到这条路的是 `runAutoStart`/`recoverState`：它们走 mapPool，一次 6 台在飞，
 * 而全新安装的那几台恰好都还没有 localPort。
 * @type {Promise<unknown>}
 */
let allocChain = Promise.resolve();

/**
 * localPort 决策。config 已有 → 直接返回；否则区间内分配并回写（整段串行）。
 * @param {string} name
 * @returns {Promise<number>}
 * @throws {DshError} PORT_EXHAUSTED
 */
export async function ensureLocalPort(name) {
  const host = store.getConfig().hosts[name];
  if (!host) throw new DshError('NOT_FOUND', `未知主机：${name}`, { host: name });
  if (host.localPort !== null && host.localPort !== undefined) return host.localPort;

  // 前序成败都不阻断后续（与 hostQueue 同一套写法）
  const run = () => allocate(name);
  const p = allocChain.then(run, run);
  allocChain = p.then(() => {}, () => {});
  return p;
}

/** 闸内执行：从这里到回写之间没有别的分配能插进来。 */
async function allocate(name) {
  const config = store.getConfig();
  const host = config.hosts[name];
  // 排队期间主机可能被删掉，也可能已由并发的同名请求分到了号——两样都要重查
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
