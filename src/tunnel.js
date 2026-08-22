/**
 * ssh -L 隧道子进程与本机直连条目管理（11 §5）。
 *
 * 三条边界：
 * 1. 子进程生命周期与退避重连全在本模块（monitor 只做周期探活，见 11 §5.5）。
 * 2. 不 import launcher（防环规则 3）：重连前的远端复核由本模块经 proto + ssh 自理。
 * 3. 隧道存活 == 子进程存活（不用 ssh -f），故 kill 子进程即断隧道。
 */

import net from 'node:net';
import { spawn } from 'node:child_process';

import { logEvent } from './lib/bus.js';
import { DshError } from './lib/errors.js';
import { buildVerifyScript, kvOne, parseProtoOutput } from './lib/proto.js';
import { createGate } from './lib/pool.js';
import { assertSafeHost } from './lib/shq.js';
import { TUNNEL_SSH_OPTS, execFailure, hostQueue, sshBin, sshExec } from './lib/ssh.js';
import { monotonicMs } from './lib/clock.js';
import { SSH_FANOUT_LIMIT } from './defaults.js';
import * as store from './store.js';

export const TUNNEL_TIMING = Object.freeze({
  readyTimeoutMs: 8_000, // §5.2：8s 未就绪即失败
  readyPollMs: 250,
  connectProbeMs: 1_000,
  killGraceMs: 2_000,
  denyWindowMs: 60_000, // §5.3 修正：运行中 stderr 拒绝行的统计窗口
  denyThreshold: 3,
  stderrTailBytes: 4_096,
});

/**
 * §5.4 的 1s,2s,4s,8s,16s,30s,30s… 作为**上界**，实际在半程到满程之间随机取
 * （issue #100）。
 *
 * 为什么必须抖：一起断的主机会一起退避、一起重试。确定值意味着它们从头到尾锁着步，
 * 每一轮都同时撞在跳板机的 `MaxStartups` 上，被拒之后又一起进下一档——永远散不开。
 * 实测 16 台同时断，70 秒后仍有 6 台卡在 degraded，且 attempt 完全相同。
 *
 * 取半程而非全程（full jitter）：全程会让「刚断一下」的常见情形偶尔等满 30s，
 * 体感变差；半程既散得开，又保住了「退避大致翻倍」的可预期节奏。
 * @param {number} attempt
 * @param {() => number} [rand] 注入点：单测要确定值
 */
export function backoffDelay(attempt, rand = Math.random) {
  const ceiling = Math.min(1000 * 2 ** attempt, 30_000);
  return Math.round(ceiling * (0.5 + 0.5 * rand()));
}

const PORT_BUSY_RE = /address already in use|cannot listen to port/i;
const FORWARD_DENIED_RE = /open failed: administratively prohibited|forwarding\b.*(failed|denied|disabled)/i;

/** 运行中 stderr 的单行判据（§5.3 第 3 行），与退出分类共用。 */
export function isForwardDeniedLine(line) {
  return FORWARD_DENIED_RE.test(line);
}

/**
 * §5.3 退出分类（纯函数，喂样本可单测）。优先级：expected > local-port-busy >
 * forward-disabled > network。
 * @param {{killedByUs?:boolean, forcedReason?:string|null, stderrTail?:string}} p
 * @returns {'expected'|'local-port-busy'|'forward-disabled'|'network'}
 */
export function classifyExit({ killedByUs = false, forcedReason = null, stderrTail = '' } = {}) {
  if (killedByUs) return 'expected';
  if (forcedReason) return /** @type {any} */ (forcedReason);
  if (PORT_BUSY_RE.test(stderrTail)) return 'local-port-busy';
  if (FORWARD_DENIED_RE.test(stderrTail)) return 'forward-disabled';
  return 'network';
}

const SUSPEND_REASONS = { 'local-port-busy': 'TUNNEL_PORT_BUSY', 'forward-disabled': 'TUNNEL_FORWARD_DISABLED' };

const SUSPEND_HINT = {
  'local-port-busy': '本机端口已被其他进程占用：释放该端口，或改 config.hosts.<name>.localPort 后重连',
  'forward-disabled': '远端 sshd 禁止端口转发（AllowTcpForwarding no）：需远端放开后重连',
};

/**
 * @typedef {{host:string, localPort:number, remotePort:number, direct:boolean,
 *   child:import('node:child_process').ChildProcess|null,
 *   killedByUs:boolean, forcedReason:string|null, connected:boolean, attempt:number,
 *   suspendedReason:string|null, stderrTail:string, denyStamps:number[],
 *   retryTimer:NodeJS.Timeout|null, readyPending:boolean, closed:boolean}} Entry
 */

/** @type {Map<string, Entry>} */
const entries = new Map();

/** 重连环的扇出闸（issue #100）。与 #85 的批量扇出共用同一个额度口径。 */
const reconnectGate = createGate(SSH_FANOUT_LIMIT);

function entry(name) {
  return entries.get(name) ?? null;
}

/** @returns {{localPort:number, connected:boolean, reconnectAttempt:number,
 *   suspendedReason:string|null, direct?:true}|null} */
export function status(name) {
  const e = entry(name);
  if (!e || e.closed) return null;
  return {
    localPort: e.localPort,
    connected: e.connected,
    reconnectAttempt: e.attempt,
    suspendedReason: e.suspendedReason,
    ...(e.direct ? { direct: true } : {}),
  };
}

export function isOpen(name) {
  const e = entry(name);
  if (!e || e.closed) return false;
  if (e.direct) return true;
  return Boolean(e.child && e.child.exitCode === null && e.child.signalCode === null);
}

export function listOpen() {
  return [...entries.keys()].filter((n) => isOpen(n));
}

// ── 子进程 ───────────────────────────────────────────────────────────────

function spawnChild(e) {
  assertSafeHost(e.host);
  const { bin, prefixArgs } = sshBin();
  const forward = `127.0.0.1:${e.localPort}:127.0.0.1:${e.remotePort}`;
  const args = [...prefixArgs, '-N', '-L', forward, ...TUNNEL_SSH_OPTS, e.host];

  e.stderrTail = '';
  e.denyStamps = [];
  e.killedByUs = false;
  e.forcedReason = null;

  const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  e.child = child;

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => onStderr(e, chunk));
  child.on('error', (err) => {
    e.stderrTail = `${e.stderrTail}\n${err.message}`.slice(-TUNNEL_TIMING.stderrTailBytes);
  });
  child.on('exit', (code, signal) => {
    if (e.child !== child) return; // 已被 restartChild 换代，旧回调作废
    e.child = null;
    e.connected = false;
    onExit(e, code, signal);
  });
  return child;
}

/** 运行中 stderr：既累积尾部供退出分类，又按 §5.3 修正统计转发被拒次数。 */
function onStderr(e, chunk) {
  e.stderrTail = (e.stderrTail + chunk).slice(-TUNNEL_TIMING.stderrTailBytes);
  const now = monotonicMs(); // 窗口是「过了多久」，不能用墙钟（issue #104）
  for (const line of String(chunk).split('\n')) {
    if (line.trim() === '' || !isForwardDeniedLine(line)) continue;
    e.denyStamps.push(now);
  }
  e.denyStamps = e.denyStamps.filter((t) => now - t <= TUNNEL_TIMING.denyWindowMs);
  if (e.denyStamps.length >= TUNNEL_TIMING.denyThreshold && e.forcedReason === null) {
    // 表面 running 实则不可用：主动杀子进程，转挂起态并明示原因
    e.forcedReason = 'forward-disabled';
    logEvent(e.host, 'error', `隧道转发被远端拒绝 ${e.denyStamps.length} 次，判定为 forward-disabled`, e.stderrTail);
    killChild(e);
  }
}

function killChild(e) {
  const child = e.child;
  if (!child) return;
  child.kill('SIGTERM');
  const t = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }, TUNNEL_TIMING.killGraceMs);
  t.unref?.();
}

/** 单次 TCP 探活：只证明「ssh 已在本机监听」，即隧道已建立。 */
export function probeLocalPort(port, timeoutMs = TUNNEL_TIMING.connectProbeMs) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: '127.0.0.1' });
    const done = (ok) => {
      sock.removeAllListeners();
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

/**
 * 转发通道探活（monitor 用）。
 *
 * connect 成功只说明 ssh 在监听：远端实例死掉之后 ssh 照样 accept，随即因为
 * channel open 失败把连接掐断。所以必须发一个最小请求、等到第一个字节回来，
 * 才算这条转发真的能载数据；accept 后无字节即断 == 远端不在了。
 */
export function probeForward(port, timeoutMs = TUNNEL_TIMING.connectProbeMs) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: '127.0.0.1' });
    const done = (ok) => {
      sock.removeAllListeners();
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once('connect', () => sock.write('HEAD / HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n'));
    sock.once('data', () => done(true));
    sock.once('end', () => done(false));
    sock.once('close', () => done(false));
    sock.once('error', () => done(false));
  });
}

/**
 * §5.2 就绪确认：`ssh -N` 成功无输出，判据是本地监听可连。
 * 子进程提前退出 → 按 §5.3 分类抛错；8s 未就绪 → 杀子进程并失败。
 */
async function waitReady(e) {
  e.readyPending = true;
  const deadline = monotonicMs() + TUNNEL_TIMING.readyTimeoutMs;
  try {
    for (;;) {
      if (e.child === null) {
        const kind = classifyExit(e);
        throw tunnelError(e, kind);
      }
      // eslint-disable-next-line no-await-in-loop -- 轮询就绪，语义上必须顺序
      if (await probeLocalPort(e.localPort, TUNNEL_TIMING.readyPollMs)) {
        e.connected = true;
        return;
      }
      if (monotonicMs() >= deadline) {
        e.killedByUs = true;
        killChild(e);
        throw new DshError('INTERNAL', `隧道 ${TUNNEL_TIMING.readyTimeoutMs}ms 内未就绪（${e.host}）`, {
          host: e.host,
          detail: e.stderrTail || null,
        });
      }
      // eslint-disable-next-line no-await-in-loop -- 同上
      await sleep(TUNNEL_TIMING.readyPollMs);
    }
  } finally {
    e.readyPending = false;
  }
}

function tunnelError(e, kind) {
  const code = SUSPEND_REASONS[kind] ?? 'INTERNAL';
  const msg = {
    'local-port-busy': `本机端口 ${e.localPort} 已被占用，隧道无法建立`,
    'forward-disabled': `远端拒绝端口转发（${e.host}）`,
    network: `隧道进程异常退出（${e.host}）`,
    expected: `隧道已被主动关闭（${e.host}）`,
  }[kind];
  return new DshError(code, msg, { host: e.host, detail: e.stderrTail || null });
}

const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); });

// ── 打开 / 关闭 ──────────────────────────────────────────────────────────

/**
 * 远端 spawn + 就绪确认；本机只登记恒等映射的直连条目。
 * 失败抛 DshError，并保证不留残留子进程。
 * @param {string} name
 * @param {{localPort:number, remotePort:number, direct?:boolean}} p
 */
export async function open(name, { localPort, remotePort, direct = false }) {
  if (
    direct
    && (
      !Number.isInteger(localPort)
      || localPort < 1
      || localPort > 65_535
      || localPort !== remotePort
    )
  ) {
    throw new DshError(
      'VALIDATION',
      '本机直连端口必须是有效端口，且与 dsh web 实际端口一致',
      { host: name },
    );
  }

  const prev = entry(name);
  if (prev) await close(name);

  /** @type {Entry} */
  const e = {
    host: name,
    localPort,
    remotePort,
    direct,
    child: null,
    killedByUs: false,
    forcedReason: null,
    connected: direct,
    attempt: 0,
    suspendedReason: null,
    stderrTail: '',
    denyStamps: [],
    retryTimer: null,
    readyPending: false,
    closed: false,
  };
  entries.set(name, e);

  if (!direct) {
    spawnChild(e);
    try {
      await waitReady(e);
    } catch (err) {
      e.closed = true;
      entries.delete(name);
      throw err;
    }
  }

  store.mutateHostState(name, (st) => {
    st.tunnel = {
      localPort,
      remotePort,
      ...(direct ? { direct: true } : {}),
      openedAt: new Date().toISOString(),
    };
  });
  logEvent(
    name,
    'info',
    direct
      ? `本机直连已登记 127.0.0.1:${localPort}`
      : `隧道就绪 127.0.0.1:${localPort} → 远端 ${remotePort}`,
  );
  return status(name);
}

/** 主动关闭：打 expected 标记（不触发重连），清定时器。 */
export async function close(name) {
  const e = entry(name);
  if (!e) return;
  e.closed = true;
  clearRetry(e);
  entries.delete(name);
  if (e.direct) {
    e.connected = false;
    return;
  }

  e.killedByUs = true;
  const child = e.child;
  killChild(e);
  if (child) await waitExit(child);
  e.connected = false;
}

/** manager 退出/自我重启：只杀本机子进程，不动远端。 */
export async function closeAll() {
  await Promise.all([...entries.keys()].map((n) => close(n)));
}

/**
 * 收掉「已经不在 config 里」的那些隧道（issue #96）。
 *
 * 主机离开 `config.hosts` 之后（手改配置后 reload，或重跑 setup——它是整份替换），
 * 页面上就看不见它了，`stop`/`reconnect` 一律 404。可这条隧道 ssh 还活着、本机端口
 * 还在转发，而**没有任何入口能碰到它**——那是 manager 自己起的子进程，不收就是泄漏。
 *
 * 只收本机这半边。远端实例不动：删一条配置不等于「把远端那个服务停掉」，按「不误杀」
 * 的底线，没有明确指令就不碰远端；state 记录也留着，主机加回来时还能接管它。
 * 但要在日志里说清远端还在跑、pid 多少——否则用户以为删干净了。
 * @returns {Promise<string[]>} 收掉的主机名
 */
export async function closeUnconfigured() {
  const known = new Set(store.listHostNames());
  const gone = [...entries.keys()].filter((n) => !known.has(n));
  for (const name of gone) {
    const e = entry(name);
    const port = e?.localPort ?? null;
    const direct = e?.direct === true;
    // eslint-disable-next-line no-await-in-loop -- 逐条收，数量与「刚被删掉的主机数」同阶
    await close(name);
    const pid = store.getHostState(name)?.web?.pid ?? null;
    logEvent(
      name,
      'warn',
      direct
        ? `${name} 已不在配置里，已清除本机直连记录（web 端口 ${port ?? '(未知)'}）`
          + (pid ? `；本机实例还在跑（pid=${pid}），没有动它` : '')
        : `${name} 已不在配置里，已收回它占的本机端口 ${port ?? '(未知)'}`
          + (pid ? `；远端实例还在跑（pid=${pid}），没有动它` : ''),
      pid
        ? direct
          ? '删一条配置不等于要停掉本机受管服务，所以此处不替你杀进程。'
            + '想停掉：把这台主机加回配置再关停，或者手工处理。'
          : '删一条配置不等于要停掉远端那个服务，所以此处不替你杀远端进程。'
            + '想停掉：把这台主机加回配置再关停，或者直接去远端处理。'
        : null,
    );
  }
  return gone;
}

/** monitor 专用：杀 + 重建子进程，不改 phase。 */
export async function restartChild(name) {
  const e = entry(name);
  if (!e) throw new DshError('NOT_FOUND', `主机 ${name} 无隧道记录`, { host: name });
  if (e.direct) {
    throw new DshError('NOT_ALLOWED', '本机主机使用直连，没有隧道子进程可重建', { host: name });
  }
  e.killedByUs = true;
  const old = e.child;
  killChild(e);
  e.child = null;
  if (old) await waitExit(old);

  spawnChild(e);
  await waitReady(e);
  logEvent(name, 'info', '隧道子进程已重建');
  return status(name);
}

function waitExit(child, timeoutMs = TUNNEL_TIMING.killGraceMs + 1_000) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(resolve, timeoutMs);
    t.unref?.();
    child.once('exit', () => { clearTimeout(t); resolve(); });
  });
}

function clearRetry(e) {
  if (e.retryTimer) {
    clearTimeout(e.retryTimer);
    e.retryTimer = null;
  }
}

// ── 意外退出 → 分流（§5.3 / 3.3） ────────────────────────────────────────

function onExit(e, code, signal) {
  if (e.closed) return;
  if (e.readyPending) return; // 就绪等待中的失败由 waitReady 统一处理

  const kind = classifyExit(e);
  if (kind === 'expected') return;

  degrade(e, `隧道断开：${kind}（退出码 ${code ?? signal}）`);

  if (kind === 'local-port-busy' || kind === 'forward-disabled') {
    e.suspendedReason = kind;
    logEvent(e.host, 'error', `隧道挂起（${kind}）：${SUSPEND_HINT[kind]}`, e.stderrTail || null);
    store.mutateHostState(e.host, (st) => { st.tunnel = null; });
    return;
  }
  scheduleRetry(e);
}

/** running → degraded；其它 phase（stop 收尾、starting 回滚）不动。 */
function degrade(e, msg) {
  const phase = store.getPhase(e.host);
  logEvent(e.host, 'warn', msg, e.stderrTail || null);
  if (phase === 'running') store.setPhase(e.host, 'degraded', 'tunnel.onExit');
}

function scheduleRetry(e) {
  clearRetry(e);
  const delay = backoffDelay(e.attempt);
  e.retryTimer = setTimeout(() => {
    e.retryTimer = null;
    reconnectTick(e).catch((err) => {
      logEvent(e.host, 'warn', `重连一拍异常：${err.message}`, err.detail ?? null);
      if (!e.closed && e.suspendedReason === null) {
        e.attempt += 1;
        scheduleRetry(e);
      }
    });
  }, delay);
  e.retryTimer.unref?.();
}

/**
 * 一拍 = 远端复核（经 hostQueue，与用户操作串行）→ spawn → 就绪确认。
 * 远端死/指纹不符 → crashed 并退出环（02 §3.3）。
 */
async function reconnectTick(e) {
  if (e.closed || e.suspendedReason !== null) return;
  // 每台主机各有一个退避定时器，网络整体回来时它们会挤在同一刻。#85 给探测/恢复/自启/
  // 巡检都上了闸，唯独这个环没有——而它正是那一瞬最先集体触发的（issue #100）。
  return reconnectGate.run(() => reconnectBody(e));
}

async function reconnectBody(e) {
  // 排队期间关停可能已经过去了
  if (e.closed || e.suspendedReason !== null) return;

  const alive = await verifyRemoteAlive(e.host);
  if (alive === false) {
    store.mutateHostState(e.host, (st) => { st.tunnel = null; });
    clearRetry(e);
    e.closed = true;
    entries.delete(e.host);
    const phase = store.getPhase(e.host);
    if (phase === 'degraded' || phase === 'running') store.setPhase(e.host, 'crashed', 'tunnel.reconnect');
    logEvent(e.host, 'error', '重连前复核失败：远端实例已消失或指纹不符，标记 crashed');
    return;
  }

  // 复核那一步是要等远端的，这段等待里 close/closeAll 可能已经过去了（关停、stop）。
  // 不复查就会在关停之后再 spawn 一条隧道 ssh——没人再来收它，成孤儿（issue #74）。
  if (e.closed || e.suspendedReason !== null) return;

  logEvent(e.host, 'info', `隧道重连尝试 ${e.attempt + 1}`);
  spawnChild(e);
  try {
    await waitReady(e);
  } catch (err) {
    if (e.closed) return;
    if (err.code === 'TUNNEL_PORT_BUSY' || err.code === 'TUNNEL_FORWARD_DISABLED') {
      e.suspendedReason = err.code === 'TUNNEL_PORT_BUSY' ? 'local-port-busy' : 'forward-disabled';
      logEvent(e.host, 'error', `隧道挂起（${e.suspendedReason}）：${SUSPEND_HINT[e.suspendedReason]}`, err.detail);
      return;
    }
    e.attempt += 1;
    scheduleRetry(e);
    return;
  }

  e.attempt = 0;
  store.mutateHostState(e.host, (st) => {
    st.tunnel = { localPort: e.localPort, remotePort: e.remotePort, openedAt: new Date().toISOString() };
  });
  logEvent(e.host, 'info', '隧道已恢复');
  if (store.getPhase(e.host) === 'degraded') store.setPhase(e.host, 'running', 'tunnel.reconnect');
}

/**
 * 重连前复核（02 §3.3）。本模块自理，不 import launcher（防环规则 3）。
 * @returns {Promise<boolean|null>} true=活且指纹符；false=死或指纹不符；null=无从判断（无 web 记录/ssh 故障）
 */
async function verifyRemoteAlive(name) {
  const web = store.getHostState(name)?.web;
  if (!web?.pid || !web?.cmdFingerprint) return null;

  try {
    return await hostQueue(name).run('tunnel-verify', async (signal) => {
      const res = await sshExec(name, buildVerifyScript({ pid: web.pid, port: web.port ?? 1 }), { signal });
      if (execFailure(name, '重连前复核', res)) return null; // ssh 层故障：不定罪远端，继续重连
      const out = parseProtoOutput(res.stdout, { requireDone: 'VERIFY_DONE' });
      if (kvOne(out, 'ALIVE') !== 'yes') return false;
      return (out.blocks.ARGS ?? null) === web.cmdFingerprint;
    });
  } catch {
    return null; // 队列超时/解析失败：同上，宁可多试一拍
  }
}

/** POST /reconnect：清挂起、attempt 归零、立即试一拍。 */
export async function requestReconnect(name) {
  const e = entry(name);
  if (!e || e.closed) {
    throw new DshError('NOT_FOUND', `主机 ${name} 当前无隧道可重连（请先启动）`, { host: name });
  }
  if (e.direct) {
    throw new DshError('NOT_ALLOWED', '本机主机使用直连，没有隧道可重连', { host: name });
  }
  e.suspendedReason = null;
  e.attempt = 0;
  clearRetry(e);
  if (isOpen(name) && e.connected) return status(name);
  await reconnectTick(e);
  return status(name);
}

/** 测试用：隧道子进程 pid（模拟「隧道被外力打断」需要它）。 */
export function _childPid(name) {
  return entry(name)?.child?.pid ?? null;
}

/** 测试用：丢弃全部内存态（不杀子进程，调用方自理）。 */
export function _reset() {
  for (const e of entries.values()) clearRetry(e);
  entries.clear();
}
