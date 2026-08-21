/**
 * 一次性 ssh/scp 执行器 + 每主机串行队列（规格 = 12 文档 §0、§6）。
 *
 * 二进制路径可经 DSHC_SSH_BIN / DSHC_SCP_BIN 覆盖——假远端测试装置（14 §2）据此把
 * ssh/scp 换成本机垫片，无需真机即可跑通全部协议路径。
 */

import { spawn } from 'node:child_process';
import { DshError } from './errors.js';
import { assertSafeHost, shq } from './shq.js';
import { PROTO_TIMING } from './proto.js';

export const COMMON_SSH_OPTS = Object.freeze([
  '-o', 'BatchMode=yes',
  '-o', 'ConnectTimeout=6',
  '-o', 'StrictHostKeyChecking=accept-new',
]);

export const TUNNEL_SSH_OPTS = Object.freeze([
  ...COMMON_SSH_OPTS,
  '-o', 'ServerAliveInterval=15',
  '-o', 'ServerAliveCountMax=3',
  '-o', 'ExitOnForwardFailure=yes',
]);

const KILL_ESCALATE_MS = 2_000;

/**
 * 在飞的一次性子进程。manager 退出时要把它们一并收走：不收就是把 ssh 交给 init
 * 当孤儿，`dshc restart` 之后新老两批命令还会同时打同一台远端（issue #73）。
 * 隧道那条常驻 ssh 不在此列——它由 tunnel.closeAll() 自己关。
 * @type {Set<() => void>} 每个元素就是那条进程的强杀链
 */
const inFlight = new Set();

/** 关停闩：落下之后不许再起新的一次性 ssh。 */
let closed = false;

/**
 * 关停用：收走在飞的一次性 ssh/scp（同一条 TERM → 2s → KILL），并且从此不再起新的。
 *
 * 闩是必须的：每主机队列里往往还压着后续任务（比如页面刚点过一次「全部探测」），
 * 只杀在飞的那批，队列里下一个立刻就顶上来——退出过程会一直有新 ssh 冒出来，
 * 最后照样留一批孤儿。
 */
export function shutdownSsh() {
  closed = true;
  for (const kill of [...inFlight]) kill();
}

/** 判据用：现在挂着几条。收场后必须归零，否则这张账本就是内存泄漏。 */
export function liveChildCount() {
  return inFlight.size;
}

/**
 * 抬闩。`server.main()` 开头调一次——同一个进程里关停后又起来的场合（用例装置、
 * 前台自我重启）不能带着上一轮的闩，否则新 manager 一条远端命令都发不出去。
 */
export function reopenSsh() {
  closed = false;
}

/**
 * 解析可执行覆盖。允许带前导参数（空格分隔），如
 * DSHC_SSH_BIN="/usr/local/bin/node /path/fake-ssh.js" —— 假远端装置据此让 node 成为
 * 直接子进程，信号（TERM/KILL）才能准确落到垫片上（shebang / sh 包装会丢信号）。
 * @returns {{bin:string, prefixArgs:string[]}}
 */
function resolveBin(envValue, fallback) {
  const raw = (envValue || '').trim();
  if (raw === '') return { bin: fallback, prefixArgs: [] };
  const parts = raw.split(/\s+/);
  return { bin: parts[0], prefixArgs: parts.slice(1) };
}

export function sshBin() {
  return resolveBin(process.env.DSHC_SSH_BIN, 'ssh');
}

export function scpBin() {
  return resolveBin(process.env.DSHC_SCP_BIN, 'scp');
}

/**
 * 拉起浏览器用的命令（mac 上是 `open`）。同样允许覆盖——`dshc open` 在测试里必须
 * 能验「到底有没有真去开浏览器」，而不是每跑一次用例就弹一个窗口。
 */
export function openerBin() {
  return resolveBin(process.env.DSHC_OPEN_BIN, 'open');
}

/**
 * @typedef {{code:number|null, signal:string|null, stdout:string, stderr:string, timedOut:boolean, aborted:boolean}} ExecResult
 */

/**
 * 收集子进程输出并管理超时/中止的强杀链：TERM → 2s → KILL。
 * @returns {Promise<ExecResult>} 不 reject；调用方看 code/timedOut 分类
 */
function runChild(bin, args, { timeoutMs, signal }) {
  return new Promise((resolve) => {
    if (closed) {
      resolve({
        code: null, signal: null, stdout: '', stderr: 'manager 正在退出，这次远端命令没有发出', timedOut: false, aborted: true,
      });
      return;
    }
    let child;
    try {
      child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ code: null, signal: null, stdout: '', stderr: String(err.message ?? err), timedOut: false, aborted: false });
      return;
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let aborted = false;
    let escalate = null;
    let settled = false;

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });

    const killChain = () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill('SIGTERM');
      escalate = setTimeout(() => child.kill('SIGKILL'), KILL_ESCALATE_MS);
    };

    // 这两个定时器不 unref：它们必须真的能触发（子进程可能挂死且不产生 IO），
    // 由 finish() 的 clearTimeout 负责不拖住退出。
    const timer = timeoutMs > 0
      ? setTimeout(() => { timedOut = true; killChain(); }, timeoutMs)
      : null;

    const onAbort = () => { aborted = true; killChain(); };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    inFlight.add(killChain);

    const finish = (code, sig) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (escalate) clearTimeout(escalate);
      inFlight.delete(killChain);
      signal?.removeEventListener('abort', onAbort);
      resolve({ code, signal: sig, stdout, stderr, timedOut, aborted });
    };

    child.on('error', (err) => {
      stderr += (stderr ? '\n' : '') + String(err.message ?? err);
      finish(null, null);
    });
    child.on('close', (code, sig) => finish(code, sig));
  });
}

/**
 * 一次性远端命令。body 由 lib/proto 产出，此处统一包 `sh -c <shq(body)>`（12 §0）：
 * 远端登录 shell 只负责剥一层引号并交给 sh，保证 POSIX 语义与登录 shell 种类无关。
 * @param {string} host 经 assertSafeHost 校验（防 ssh 参数位注入，12 §2.4）
 * @param {string} remoteCmd
 * @param {{timeoutMs?:number, signal?:AbortSignal, extraOpts?:string[]}} [opts]
 * @returns {Promise<ExecResult>}
 */
export async function sshExec(host, remoteCmd, { timeoutMs = PROTO_TIMING.onceTimeoutMs, signal, extraOpts = [] } = {}) {
  assertSafeHost(host);
  const { bin, prefixArgs } = sshBin();
  const args = [...prefixArgs, ...COMMON_SSH_OPTS, ...extraOpts, host, `sh -c ${shq(remoteCmd)}`];
  return runChild(bin, args, { timeoutMs, signal });
}

/**
 * scp 单文件上载（12 §4）。remoteRelPath 相对远端 $HOME。
 * @returns {Promise<ExecResult>}
 */
export async function scpTo(host, localPath, remoteRelPath, { timeoutMs = PROTO_TIMING.scpTimeoutMs, signal } = {}) {
  assertSafeHost(host);
  const { bin, prefixArgs } = scpBin();
  const args = [...prefixArgs, ...COMMON_SSH_OPTS, '--', localPath, `${host}:${remoteRelPath}`];
  return runChild(bin, args, { timeoutMs, signal });
}

/** 把 ExecResult 的失败面转成 DshError（调用方决定是否抛）。 */
export function execFailure(host, label, res) {
  if (res.timedOut) {
    return new DshError('SSH_TIMEOUT', `${label} 超时（${host}）`, { host, detail: res.stderr || null });
  }
  if (res.aborted) {
    return new DshError('SSH_TIMEOUT', `${label} 被中止（${host}）`, { host, detail: res.stderr || null });
  }
  if (res.code !== 0) {
    return new DshError('SSH_UNREACHABLE', `${label} 失败（${host}，退出码 ${res.code ?? res.signal}）`, {
      host,
      detail: res.stderr || null,
    });
  }
  return null;
}

// ── §6 每台主机操作串行队列 ──────────────────────────────────────────────

/** @type {Map<string, HostQueue>} */
const queues = new Map();

class HostQueue {
  #tail = Promise.resolve();

  #host;

  constructor(host) {
    this.#host = host;
  }

  get host() {
    return this.#host;
  }

  /**
   * @template T
   * @param {string} label 事件/诊断用（'probe'|'start'|'stop'|'verify'|…）
   * @param {(signal:AbortSignal)=>Promise<T>} fn 在队首执行
   * @param {{timeoutMs?:number}} [opts] 默认 30s；start 类传 90s（12 §3 预算）
   * @returns {Promise<T>}
   */
  run(label, fn, { timeoutMs = 30_000 } = {}) {
    const exec = async () => {
      const ac = new AbortController();
      const timeoutErr = new DshError('SSH_TIMEOUT', `${label} 超时 ${timeoutMs}ms`, { host: this.#host });
      const t = setTimeout(() => ac.abort(timeoutErr), timeoutMs);
      try {
        return await fn(ac.signal);
      } finally {
        clearTimeout(t);
      }
    };
    // 前序失败不阻断后续任务
    const p = this.#tail.then(exec, exec);
    // 吞掉尾部 rejection，防 unhandled
    this.#tail = p.then(() => {}, () => {});
    return p;
  }
}

/** 同 host 返回同一实例。 */
export function hostQueue(host) {
  let q = queues.get(host);
  if (!q) {
    q = new HostQueue(host);
    queues.set(host, q);
  }
  return q;
}

/** 测试用。 */
export function _resetQueues() {
  queues.clear();
}
