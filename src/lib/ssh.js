/**
 * 一次性 ssh/scp/本机执行器 + 每主机串行队列（规格 = 12 文档 §0、§6）。
 *
 * 二进制路径可经 DSHC_SSH_BIN / DSHC_SCP_BIN 覆盖——假远端测试装置（14 §2）据此把
 * ssh/scp 换成本机垫片，无需真机即可跑通全部协议路径。
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { REMOTE_DIR } from '../defaults.js';
import { createTailCapture } from './capture.js';
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
 * 每条流各自收上来的上限（issue #92）。
 *
 * 2MB 的选法：协议输出（POLL/VERIFY/STOP 的 KEY=VALUE）都在几百字节量级，永远碰不到；
 * 日志抓取是 `tail -n ≤10000`，正常文本行一万行约 1MB 上下，也在里面。
 * 真能撞上这条线的只有非正常输出——带 `\r` 的进度条压成的超长单行、刷屏的 .bashrc。
 * 时间维度另有 onceTimeoutMs 兜着，所以撞线之后照常排空到命令自然结束，不额外掐连接。
 */
export const SSH_OUTPUT_CAP_BYTES = 2 * 1024 * 1024;

/** settings 等敏感内容经 stdin 传输时的 lib 层硬上限（设计 §4.3）。 */
export const SSH_INPUT_CAP_BYTES = 512 * 1024;

/**
 * 在飞的一次性运输操作。manager 退出时要把它们一并收走：不收就是把 ssh/本机 shell
 * 交给 init 当孤儿，`dshc restart` 之后新老两批命令还会同时操作同一台主机（issue #73）。
 * 隧道那条常驻 ssh 不在此列——它由 tunnel.closeAll() 自己关。
 * @type {Set<() => void>} 子进程元素是强杀链，文件复制元素是取消函数
 */
const inFlight = new Set();

/** 关停闩：落下之后不许再起新的一次性 ssh/scp/本机操作。 */
let closed = false;

/**
 * 关停用：收走在飞的一次性运输操作，并且从此不再起新的。
 *
 * 闩是必须的：每主机队列里往往还压着后续任务（比如页面刚点过一次「全部探测」），
 * 只杀在飞的那批，队列里下一个立刻就顶上来——退出过程会一直有新 ssh 冒出来，
 * 最后照样留一批孤儿。本机 shell 复用 TERM → 2s → KILL；copy 的取消函数不提交正式文件。
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

export function localShBin() {
  return resolveBin(process.env.DSHC_LOCAL_SH_BIN, 'sh');
}

/**
 * 拉起浏览器用的命令（mac 上是 `open`）。同样允许覆盖——`dshc open` 在测试里必须
 * 能验「到底有没有真去开浏览器」，而不是每跑一次用例就弹一个窗口。
 */
export function openerBin() {
  return resolveBin(process.env.DSHC_OPEN_BIN, 'open');
}

/**
 * @typedef {{code:number|null, signal:string|null, stdout:string, stderr:string,
 *   stdoutDropped:number, stderrDropped:number, timedOut:boolean, aborted:boolean}} ExecResult
 * `*Dropped` 是封顶时从**头部**丢掉的字符数（issue #92），0 表示这份是全的。
 */

/** 压根没跑起来的那几条早退路径，输出字段一律取这份，省得各处漏填。 */
const EMPTY_OUTPUT = Object.freeze({ stdout: '', stderr: '', stdoutDropped: 0, stderrDropped: 0 });

/**
 * ExecResult 的运输来源不属于公开结果契约，故用不可枚举 symbol 携带：
 * 既让 execFailure 能区分本机/SSH，也不破坏调用方按既有字段 deepEqual/序列化。
 */
const EXEC_ORIGIN = Symbol('execOrigin');

function markExecOrigin(result, origin) {
  Object.defineProperty(result, EXEC_ORIGIN, { value: origin });
  return result;
}

/**
 * input 只接受明确的二进制类型，并在最靠近 spawn 的 lib 边界再次限长。
 * 返回 Buffer view 供 stdin.end 使用；不转字符串，避免内容进入诊断文本。
 */
function normalizeChildInput(input) {
  if (input === undefined) return null;
  if (!Buffer.isBuffer(input) && !(input instanceof Uint8Array)) {
    throw new TypeError('input 必须是 Buffer 或 Uint8Array');
  }
  if (input.byteLength > SSH_INPUT_CAP_BYTES) {
    throw new DshError('VALIDATION', 'input 不得超过 512 KiB');
  }
  return Buffer.isBuffer(input)
    ? input
    : Buffer.from(input.buffer, input.byteOffset, input.byteLength);
}

/**
 * 收集子进程输出并管理超时/中止的强杀链：TERM → 2s → KILL。
 * @returns {Promise<ExecResult>} 不 reject；调用方看 code/timedOut 分类
 */
function runChild(bin, args, {
  timeoutMs,
  signal,
  closedMessage = 'manager 正在退出，这次远端命令没有发出',
  origin = 'ssh',
  input,
}) {
  const childInput = normalizeChildInput(input);
  return new Promise((resolve) => {
    if (closed) {
      resolve(markExecOrigin({
        ...EMPTY_OUTPUT,
        code: null,
        signal: null,
        stderr: closedMessage,
        timedOut: false,
        aborted: true,
      }, origin));
      return;
    }
    let child;
    try {
      child = spawn(bin, args, { stdio: [childInput === null ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    } catch (err) {
      resolve(markExecOrigin({
        ...EMPTY_OUTPUT, code: null, signal: null, stderr: String(err.message ?? err), timedOut: false, aborted: false,
      }, origin));
      return;
    }

    const stdout = createTailCapture(SSH_OUTPUT_CAP_BYTES);
    const stderr = createTailCapture(SSH_OUTPUT_CAP_BYTES);
    let timedOut = false;
    let aborted = false;
    let escalate = null;
    let settled = false;

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => stdout.push(d));
    child.stderr.on('data', (d) => stderr.push(d));

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
      resolve(markExecOrigin({
        code,
        signal: sig,
        stdout: stdout.text(),
        stderr: stderr.text(),
        stdoutDropped: stdout.dropped(),
        stderrDropped: stderr.dropped(),
        timedOut,
        aborted,
      }, origin));
    };

    child.on('error', (err) => {
      stderr.push((stderr.text() ? '\n' : '') + String(err.message ?? err));
      finish(null, null);
    });
    child.on('close', (code, sig) => finish(code, sig));

    if (childInput !== null) {
      // 对端可能在 input 尚未写完前退出；pipe 的 EPIPE/ERR_STREAM_DESTROYED 不能成为
      // manager 的未处理异常。命令成败仍由 close/code、timeout/abort 和协议输出判定。
      child.stdin.on('error', () => {});
      try {
        child.stdin.end(childInput);
      } catch {
        // 极早退出也可能让 end 同步拒绝；不得把 input 或 stream 异常抛出执行器边界。
      }
    }
  });
}

/**
 * 一次性远端命令。body 由 lib/proto 产出，此处统一包 `sh -c <shq(body)>`（12 §0）：
 * 远端登录 shell 只负责剥一层引号并交给 sh，保证 POSIX 语义与登录 shell 种类无关。
 * @param {string} host 经 assertSafeHost 校验（防 ssh 参数位注入，12 §2.4）
 * @param {string} remoteCmd
 * @param {{timeoutMs?:number, signal?:AbortSignal, extraOpts?:string[],
 *   input?:Buffer|Uint8Array}} [opts]
 * @returns {Promise<ExecResult>}
 */
export async function sshExec(
  host,
  remoteCmd,
  {
    timeoutMs = PROTO_TIMING.onceTimeoutMs,
    signal,
    extraOpts = [],
    input,
  } = {},
) {
  assertSafeHost(host);
  const { bin, prefixArgs } = sshBin();
  const args = [...prefixArgs, ...COMMON_SSH_OPTS, ...extraOpts, host, `sh -c ${shq(remoteCmd)}`];
  return runChild(bin, args, { timeoutMs, signal, input });
}

/**
 * 本机一次性命令。command 是 lib/proto 产出的原始模板文本；spawn 的 argv 边界已经
 * 保住整段文本，因此这里只加一层 `-c`，不能再套远端运输使用的 `sh -c <quoted>`。
 * @param {string} command
 * @param {{timeoutMs?:number, signal?:AbortSignal, input?:Buffer|Uint8Array}} [opts]
 * @returns {Promise<ExecResult>}
 */
export async function localExec(
  command,
  { timeoutMs = PROTO_TIMING.onceTimeoutMs, signal, input } = {},
) {
  const { bin, prefixArgs } = localShBin();
  return runChild(bin, [...prefixArgs, '-c', command], {
    timeoutMs,
    signal,
    input,
    closedMessage: 'manager 正在退出，这次本机命令没有执行',
    origin: 'local-exec',
  });
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

/** @returns {ExecResult} */
function copyResult({
  code = null,
  stderr = '',
  timedOut = false,
  aborted = false,
} = {}) {
  return markExecOrigin({
    ...EMPTY_OUTPUT,
    code,
    signal: null,
    stderr,
    timedOut,
    aborted,
  }, 'local-copy');
}

/**
 * 把远端 HOME 相对路径收紧到本机 HOME/.dsh_center_remote/ 内。
 * 这里只做词法判定；后续 prepareLocalCopyTarget 负责逐段核对真实文件系统。
 * @returns {{home:string, target:string}}
 */
function localCopyTarget(remoteRelPath) {
  if (typeof remoteRelPath !== 'string' || remoteRelPath.includes('\0')) {
    throw new DshError('VALIDATION', '本机复制目标路径不合法');
  }
  if (path.isAbsolute(remoteRelPath) || remoteRelPath.split(/[\\/]+/u).includes('..')) {
    throw new DshError('VALIDATION', '本机复制目标必须位于 ~/.dsh_center_remote/ 内');
  }

  const home = process.env.HOME;
  if (!home) {
    throw new DshError('LOCAL_COPY_FAILED', '本机复制失败：HOME 未设置');
  }
  const root = path.resolve(home, REMOTE_DIR);
  const target = path.resolve(home, remoteRelPath);
  const relative = path.relative(root, target);
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new DshError('VALIDATION', '本机复制目标必须严格位于 ~/.dsh_center_remote/ 内');
  }
  return { home: path.resolve(home), target };
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === ''
    || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function localPathError(message, filePath, cause = null) {
  return new DshError('LOCAL_COPY_FAILED', message, {
    detail: [filePath ? `路径：${filePath}` : null, cause ? String(cause.message ?? cause) : null]
      .filter(Boolean)
      .join('\n') || null,
    cause: cause instanceof Error ? cause : undefined,
  });
}

/**
 * 从真实 HOME 下的 REMOTE_DIR 起逐段 lstat。缺目录逐个 mkdir，绝不让 recursive mkdir
 * 帮我们悄悄穿过 symlink；每段再 realpath 回读，保证最终仍是刚核过的物理路径。
 */
async function checkLocalDirectoryChain(root, parent, { createMissing }) {
  if (!isWithin(root, parent)) {
    throw localPathError('本机复制目标目录越过了 ~/.dsh_center_remote', parent);
  }

  const base = path.dirname(root);
  const segments = path.relative(base, parent).split(path.sep).filter(Boolean);
  let current = base;
  for (const segment of segments) {
    current = path.join(current, segment);
    let stat;
    try {
      // eslint-disable-next-line no-await-in-loop -- 必须按父→子顺序核验，不能并发越级
      stat = await fs.lstat(current);
    } catch (err) {
      if (err?.code !== 'ENOENT' || !createMissing) {
        throw localPathError('本机复制目标目录不可访问', current, err);
      }
      try {
        // eslint-disable-next-line no-await-in-loop -- 只建当前这一段，随后立即 lstat/realpath 回读
        await fs.mkdir(current, { mode: 0o700 });
      } catch (mkdirErr) {
        if (mkdirErr?.code !== 'EEXIST') {
          throw localPathError('本机复制目标目录创建失败', current, mkdirErr);
        }
      }
      // mkdir 与 EEXIST 都必须重新读取，EEXIST 可能正是竞争者塞进来的 symlink。
      // eslint-disable-next-line no-await-in-loop -- 同上，逐段安全检查
      stat = await fs.lstat(current);
    }

    if (stat.isSymbolicLink()) {
      throw localPathError('本机复制目标目录包含符号链接，已拒绝写入', current);
    }
    if (!stat.isDirectory()) {
      throw localPathError('本机复制目标路径中的中间项不是目录', current);
    }
    // eslint-disable-next-line no-await-in-loop -- lstat 后逐段 realpath 回读是同一项安全检查
    const actual = await fs.realpath(current);
    if (actual !== current || !isWithin(root, actual)) {
      throw localPathError('本机复制目标目录的真实路径越界，已拒绝写入', current);
    }
  }
}

/**
 * 供 localCopy 与本机 patch cleanup 共用：解析真实 HOME、安全创建父目录并回传物理路径。
 * @returns {Promise<{root:string,target:string,parent:string}>}
 */
export async function prepareLocalCopyTarget(remoteRelPath) {
  const lexical = localCopyTarget(remoteRelPath);
  let realHome;
  try {
    realHome = await fs.realpath(lexical.home);
  } catch (err) {
    throw localPathError('本机复制失败：HOME 不可访问', lexical.home, err);
  }

  const relativeFromHome = path.relative(lexical.home, lexical.target);
  const root = path.resolve(realHome, REMOTE_DIR);
  const target = path.resolve(realHome, relativeFromHome);
  const parent = path.dirname(target);
  if (!isWithin(root, target) || target === root) {
    throw new DshError('VALIDATION', '本机复制目标必须严格位于 ~/.dsh_center_remote/ 内');
  }
  await checkLocalDirectoryChain(root, parent, { createMissing: true });
  return { root, target, parent };
}

/**
 * 本机单文件复制。先写同目录临时文件，再原子 rename；rename 成功即提交点，之后抵达的
 * 中止/超时只能视为迟到，必须返回成功且不得删除正式目标。提交前取消只清临时文件。
 * 文件系统 API 本身不能强杀，因此 cancel 会落状态，待当前内核操作返回后收敛。
 * @param {string} localPath
 * @param {string} remoteRelPath 相对本机 HOME，且必须位于 REMOTE_DIR 内
 * @param {{timeoutMs?:number, signal?:AbortSignal}} [opts]
 * @returns {Promise<ExecResult>}
 */
export async function localCopy(
  localPath,
  remoteRelPath,
  { timeoutMs = PROTO_TIMING.scpTimeoutMs, signal } = {},
) {
  if (closed) {
    return copyResult({
      stderr: 'manager 正在退出，这次本机文件复制没有执行',
      aborted: true,
    });
  }
  let prepared;
  try {
    prepared = await prepareLocalCopyTarget(remoteRelPath);
  } catch (err) {
    if (err?.code === 'VALIDATION') throw err;
    return copyResult({
      stderr: [err?.message, err?.detail].filter(Boolean).join('\n') || String(err),
    });
  }
  const { root, target, parent } = prepared;
  if (signal?.aborted) {
    return copyResult({ stderr: '本机文件复制被中止', aborted: true });
  }

  const temporary = `${target}.dshc-copy-${process.pid}-${randomUUID()}`;
  let timedOut = false;
  let aborted = false;
  let cancelled = false;
  const cancel = () => {
    aborted = true;
    cancelled = true;
  };
  const onAbort = () => cancel();
  const timer = timeoutMs > 0
    ? setTimeout(() => {
      timedOut = true;
      cancelled = true;
    }, timeoutMs)
    : null;
  signal?.addEventListener('abort', onAbort, { once: true });
  inFlight.add(cancel);

  try {
    if (cancelled) {
      return copyResult({
        stderr: timedOut ? '本机文件复制超时' : '本机文件复制被中止',
        timedOut,
        aborted,
      });
    }
    await checkLocalDirectoryChain(root, parent, { createMissing: false });
    await fs.copyFile(localPath, temporary, fs.constants.COPYFILE_EXCL);
    if (cancelled) {
      await fs.rm(temporary, { force: true });
      return copyResult({
        stderr: timedOut ? '本机文件复制超时' : '本机文件复制被中止',
        timedOut,
        aborted,
      });
    }
    await checkLocalDirectoryChain(root, parent, { createMissing: false });
    if (cancelled) {
      await fs.rm(temporary, { force: true });
      return copyResult({
        stderr: timedOut ? '本机文件复制超时' : '本机文件复制被中止',
        timedOut,
        aborted,
      });
    }
    await fs.rename(temporary, target);
    // commit point：rename 已原子替换正式目标；迟到的 abort/timeout 不得回滚。
    return copyResult({ code: 0 });
  } catch (err) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    return copyResult({
      stderr: String(err?.message ?? err),
      timedOut,
      aborted,
    });
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    inFlight.delete(cancel);
  }
}

/**
 * 截断告知（issue #92）。detail 会原样进错误框和日志，被截过还不说，看的人会以为
 * 对端就只说了这么多——而真正的头几行（往往正是原因）已经被丢掉了。
 * @returns {string|null}
 */
export function noteTruncation(text, dropped, scope = '远端') {
  const body = text || '';
  if (!dropped) return body || null;
  return `（${scope}输出过大，已丢弃开头 ${dropped} 字符，以下是末尾部分）\n${body}`;
}

/** 把 ExecResult 的失败面转成 DshError（调用方决定是否抛）。 */
export function execFailure(host, label, res) {
  const origin = res?.[EXEC_ORIGIN] ?? 'ssh';
  const local = origin === 'local-exec' || origin === 'local-copy';
  const readableLabel = local ? String(label).replace(/远端/gu, '本机') : label;
  const detail = noteTruncation(res.stderr, res.stderrDropped, local ? '本机' : '远端');
  if (local) {
    if (res.timedOut) {
      return new DshError('LOCAL_TIMEOUT', `${readableLabel}超时（本机）`, { host, detail });
    }
    if (res.aborted) {
      return new DshError('LOCAL_TIMEOUT', `${readableLabel}被中止（本机）`, { host, detail });
    }
    if (res.code !== 0) {
      const code = origin === 'local-copy' ? 'LOCAL_COPY_FAILED' : 'LOCAL_EXEC_FAILED';
      const kind = origin === 'local-copy' ? '文件复制' : '命令执行';
      return new DshError(
        code,
        `${readableLabel}失败（本机${kind}，退出码 ${res.code ?? res.signal}）`,
        { host, detail },
      );
    }
    return null;
  }

  if (res.timedOut) {
    return new DshError('SSH_TIMEOUT', `${label} 超时（${host}）`, { host, detail });
  }
  if (res.aborted) {
    return new DshError('SSH_TIMEOUT', `${label} 被中止（${host}）`, { host, detail });
  }
  if (res.code !== 0) {
    return new DshError('SSH_UNREACHABLE', `${label} 失败（${host}，退出码 ${res.code ?? res.signal}）`, {
      host,
      detail,
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
