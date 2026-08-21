/**
 * 拉起/停止/重启的远端侧执行器（12 §1.3、§3、§5）+ 编排（02 §3.2/§3.5，见文件后半）。
 */

import { DshError } from './lib/errors.js';
import { logEvent } from './lib/bus.js';
import {
  PROTO_TIMING,
  buildLaunchPollScript,
  buildLaunchScript,
  buildLogTailScript,
  buildStopScript,
  buildVerifyScript,
  kvOne,
  parseLaunchUrl,
  parseProtoOutput,
} from './lib/proto.js';
import {
  execFailure, hostQueue, noteTruncation, sshExec,
} from './lib/ssh.js';
import { ensureLocalPort } from './ports.js';
import { syncPatches } from './patchsync.js';
import * as store from './store.js';
import * as tunnel from './tunnel.js';

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

/** 注入点：测试用假时钟替换等待，避免真等 9 秒。 */
let waitFn = sleep;
export function _setWait(fn) {
  waitFn = typeof fn === 'function' ? fn : sleep;
}

// ── RMT-05 复核与停止 ────────────────────────────────────────────────────

/**
 * @typedef {{alive:boolean, argsRaw:string|null, listen:'yes'|'no'|'unknown',
 *   fingerprintMatch:boolean|null, cwd:string|null}} VerifyResult
 *   cwd = 远端进程实际工作目录，仅供展示；unknown/缺失均归 null，永不作 kill 判据。
 */

/**
 * VERIFY 三项校验（12 §1.3）。指纹全等在 manager 侧判定：
 * 同一台机器、同一 ps 实现、同一 $(…) 尾随换行剥除路径 → 逐字全等成立。
 * @param {{pid:number, port:number, fingerprint?:string|null}} p
 * @returns {Promise<VerifyResult>}
 */
export async function verifyRemote(host, { pid, port, fingerprint = null }, { signal } = {}) {
  const res = await sshExec(host, buildVerifyScript({ pid, port }), { signal });
  const err = execFailure(host, '远端复核', res);
  if (err) throw err;

  const out = parseProtoOutput(res.stdout, { requireDone: 'VERIFY_DONE' });
  const alive = kvOne(out, 'ALIVE') === 'yes';
  const argsRaw = alive ? (out.blocks.ARGS ?? null) : null;
  const listen = /** @type {'yes'|'no'|'unknown'} */ (kvOne(out, 'LISTEN', 'unknown'));
  const cwdRaw = kvOne(out, 'CWD');

  return {
    alive,
    argsRaw,
    listen,
    fingerprintMatch: fingerprint === null || argsRaw === null ? null : argsRaw === fingerprint,
    cwd: cwdRaw === null || cwdRaw === 'unknown' || cwdRaw === '' ? null : cwdRaw,
  };
}

/**
 * 指纹采集（12 §5.2）：用 ps 的**实测输出**，不是 manager 拼装的命令行——
 * nohup/env 均 exec 链传递，最终 args 是 `dsh web …` 形态；`--port 0` 拉起的进程
 * args 里就是 `0`（这正是「命令行含记录端口」不可实现的原因，契约疑议 1）。
 *
 * 顺带回带 cwd（同一次 VERIFY 往返，不多花一趟 ssh）——纯展示用。
 * @returns {Promise<{fingerprint:string, cwd:string|null}>}
 */
export async function captureFingerprint(host, { pid, port }, { signal } = {}) {
  const v = await verifyRemote(host, { pid, port }, { signal });
  if (!v.alive || !v.argsRaw) {
    throw new DshError('LAUNCH_FAILED', `拉起后复核发现进程已消失（pid=${pid}）`, { host });
  }
  return { fingerprint: v.argsRaw, cwd: v.cwd };
}

/**
 * @typedef {{killed:'term'|'force'|'already-dead'|'no', reason:string|null, actualArgs:string|null}} StopResult
 */

/**
 * STOP 四结果分支（12 §1.3）。`no` = 指纹不符：**manager 不清 state、抛 KILL_REFUSED、
 * 附双方指纹供人工裁决**（03 §4.2 原则）。
 * @returns {Promise<StopResult>}
 */
export async function stopRemote(host, { pid, fingerprint }, { signal } = {}) {
  const res = await sshExec(host, buildStopScript({ pid, fingerprint }), { signal });
  const err = execFailure(host, '远端停止', res);
  if (err) throw err;

  const out = parseProtoOutput(res.stdout, { requireDone: 'STOP_DONE' });
  const killed = kvOne(out, 'KILLED');
  if (!['term', 'force', 'already-dead', 'no'].includes(killed)) {
    throw new DshError('PROTO_PARSE', `停止协议返回未知结果：${killed}`, { host, detail: res.stdout });
  }
  return {
    killed,
    reason: kvOne(out, 'REASON'),
    actualArgs: out.blocks.ARGS ?? null,
  };
}

/** 指纹不符时的统一拒杀错误（含双方指纹）。 */
export function killRefused(host, { pid, expected, actual }) {
  return new DshError(
    'KILL_REFUSED',
    `拒绝关停 pid=${pid}：远端命令行与记录指纹不符（可能已被 PID 复用或为手动实例）`,
    {
      host,
      detail: `记录指纹：\n${expected}\n\n远端实测：\n${actual ?? '(空)'}`,
    },
  );
}

// ── RMT-08 日志获取 ──────────────────────────────────────────────────────

/** logName 取自 state.web.log（manager 自造名，仍过 [name] 校验兜底）。 */
export async function tailRemoteLog(host, { logName, lines = 200 }, { signal } = {}) {
  const res = await sshExec(host, buildLogTailScript({ logName, lines }), { signal });
  const err = execFailure(host, '取远端日志', res);
  if (err) throw err;
  // 行数在远端限了（tail -n），字节数没限：一条带 \r 的进度条就是超长的单行，
  // 撞上封顶只能收到末尾那截。得说一声，否则看的人以为日志本来就长这样（issue #92）。
  return noteTruncation(res.stdout, res.stdoutDropped) ?? '';
}

// ── RMT-06 拉起协议状态机（12 §3 的 S0–S5） ─────────────────────────────

/** 降级拉起的日志名 token：与 pid 同等唯一，且重定向目标必须在拿到 PID 之前确定。 */
export function launchToken() {
  return Date.now().toString(36);
}

export function fixedLogName(port) {
  return `web-${port}.log`;
}

export function autoLogName(token = launchToken()) {
  return `web-auto-${token}.log`;
}

/**
 * 前置语句（mkdir / cd）的失败：脚本以非零码退出，若先过 execFailure 会被归成
 * SSH_UNREACHABLE——「远端连不上」和「目录进不去」对用户是两件事，故先认标记。
 * 用正则而非 parseProtoOutput：此时 stdout 可能只有半截，解析器不该在这里抛。
 * @returns {DshError|null}
 */
function preludeFailure(host, stdout) {
  const marker = /^ERR=(mkdir|workdir)$/m.exec(stdout ?? '');
  if (!marker) return null;
  // message 不带主机名：调用方 failure() 会包成「拉起失败（host）：<message>」
  if (marker[1] === 'workdir') {
    const wd = /^WD=(.*)$/m.exec(stdout)?.[1] ?? '(未回显)';
    return new DshError('LAUNCH_FAILED', '远端工作目录不存在或不可进入', {
      host,
      detail: `目标目录：${wd}\n改主机详情里的「启动目录」，或先在远端建好该目录。`,
    });
  }
  return new DshError('LAUNCH_FAILED', '远端无法创建落地目录 .dsh_center_remote', {
    host,
    detail: stdout,
  });
}

/** S1 LAUNCH：拿 PID。 */
async function launchOnce(host, spec, { signal }) {
  const res = await sshExec(host, buildLaunchScript(spec), { signal });
  const prelude = preludeFailure(host, res.stdout);
  if (prelude) throw prelude;
  const err = execFailure(host, '远端拉起', res);
  if (err) throw err;

  const out = parseProtoOutput(res.stdout);
  const pidRaw = kvOne(out, 'PID');
  const pid = Number(pidRaw);
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new DshError('LAUNCH_FAILED', '远端拉起未返回 PID', { host, detail: res.stdout });
  }
  return pid;
}

/**
 * S2 POLL 环：首拍 T+1s，此后每 2s 一拍，最多 5 拍。
 * @returns {Promise<{outcome:'url'|'bind-err'|'dead'|'timeout', actualPort?:number}>}
 */
async function pollLaunch(host, { logName, pid }, { signal }) {
  await waitFn(PROTO_TIMING.pollFirstDelayMs);
  for (let attempt = 0; attempt < PROTO_TIMING.pollMaxAttempts; attempt += 1) {
    if (attempt > 0) await waitFn(PROTO_TIMING.pollIntervalMs);

    const res = await sshExec(host, buildLaunchPollScript({ logName, pid }), { signal });
    const err = execFailure(host, '拉起轮询', res);
    if (err) throw err;
    const out = parseProtoOutput(res.stdout, { requireDone: 'POLL_DONE' });

    const url = kvOne(out, 'URL');
    if (url) {
      const actualPort = parseLaunchUrl(url);
      if (actualPort === null) {
        throw new DshError('PROTO_PARSE', `无法从 dsh 输出解析端口：${url}`, { host, detail: res.stdout });
      }
      return { outcome: 'url', actualPort };
    }
    // BIND_ERR 优先于 ALIVE：端口被占时进程可能还没退出
    if (kvOne(out, 'BIND_ERR') === 'yes') return { outcome: 'bind-err' };
    if (kvOne(out, 'ALIVE') === 'no') return { outcome: 'dead' };
  }
  return { outcome: 'timeout' };
}

async function tailQuiet(host, logName, signal) {
  try {
    return await tailRemoteLog(host, { logName, lines: PROTO_TIMING.logTailLines }, { signal });
  } catch (err) {
    return `(取日志失败：${err.message})`;
  }
}

/**
 * S0–S5 全路径。S0（patch 同步）由调用方在此之前完成。
 *
 * @param {string} host
 * @param {{port:number, env?:Record<string,string>, extraArgs?:string[], patchRemoteNames?:string[],
 *          workdir?:string|null}} spec workdir=null 表示不注入 cd（远端 $HOME 启动）
 * @returns {Promise<{pid:number, actualPort:number, logName:string, fingerprint:string, cwd:string|null}>}
 * @throws {DshError} LAUNCH_FAILED（detail 含一到两份日志尾）
 */
export async function runLaunchSequence(host, spec, { signal } = {}) {
  const {
    port, env = {}, extraArgs = [], patchRemoteNames = [], workdir = null,
  } = spec;
  const attempts = [];
  let usePort = port;
  let logName = fixedLogName(port);
  let fallbackUsed = false;

  for (;;) {
    const launchSpec = {
      logName, port: usePort, env, extraArgs, patchRemoteNames, workdir,
    };
    // S1
    let pid;
    try {
      pid = await launchOnce(host, launchSpec, { signal });
    } catch (err) {
      attempts.push({ logName, note: err.message, log: await tailQuiet(host, logName, signal) });
      throw failure(host, attempts, err);
    }

    // S2
    let poll;
    try {
      poll = await pollLaunch(host, { logName, pid }, { signal });
    } catch (err) {
      await orphanCleanup(host, pid, signal);
      attempts.push({ logName, note: err.message, log: await tailQuiet(host, logName, signal) });
      throw failure(host, attempts, err);
    }

    // S3
    if (poll.outcome === 'url') {
      const { fingerprint, cwd } = await captureFingerprint(host, { pid, port: poll.actualPort }, { signal });
      return {
        pid, actualPort: poll.actualPort, logName, fingerprint, cwd,
      };
    }

    // S4：降级重拉（仅允许一次）
    if (poll.outcome === 'bind-err' && !fallbackUsed) {
      // 旧 pid 若仍活着：指纹尚未捕获，以「本次 LAUNCH 拼装的命令行」作临时指纹做全等；
      // 不匹配就放着不杀（12 §5.1 R6：宁可留一个可见的孤儿）
      await orphanCleanup(host, pid, signal);
      attempts.push({ logName, note: `端口 ${usePort} 被占，降级 --port 0 重拉`, log: await tailQuiet(host, logName, signal) });
      fallbackUsed = true;
      usePort = '0';
      logName = autoLogName();
      continue;
    }

    // S5 FAIL 收尾
    await orphanCleanup(host, pid, signal);
    const note = {
      'bind-err': '端口被占且降级重拉后仍被占',
      dead: '远端进程启动后立即退出',
      timeout: `启动超时（${PROTO_TIMING.pollMaxAttempts} 拍内未见监听 URL）`,
    }[poll.outcome];
    attempts.push({ logName, note, log: await tailQuiet(host, logName, signal) });
    throw failure(host, attempts, null);
  }
}

/** S5b：失败但进程残留时尽力清理（指纹未知，只能按 pid 存活与否决定要不要出手）。 */
async function orphanCleanup(host, pid, signal) {
  try {
    const v = await verifyRemote(host, { pid, port: 1 }, { signal });
    if (!v.alive || !v.argsRaw) return;
    await stopRemote(host, { pid, fingerprint: v.argsRaw }, { signal });
  } catch {
    // 清理是 best-effort：失败只会留下一个下轮探测可见的孤儿（12 §5.1 R6/R7）
  }
}

function failure(host, attempts, cause) {
  const detail = attempts
    .map((a, i) => `── 第 ${i + 1} 次拉起（${a.logName}）：${a.note}\n${a.log}`)
    .join('\n\n');
  // 病因的 detail（如 workdir 的 WD= 回显、协议解析的原始 stdout）比日志尾更直指问题
  const cited = cause?.detail ? `${cause.detail}\n\n` : '';
  return new DshError('LAUNCH_FAILED', `拉起失败（${host}）：${attempts.at(-1)?.note ?? '未知原因'}`, {
    host,
    detail: cited + detail,
    cause: cause ?? undefined,
  });
}

// ── ENG-11 编排（02 §3.2 / §3.5 / §3.1 第 2 步） ─────────────────────────

export const START_PHASES = Object.freeze(['ready', 'crashed']);
export const STOP_PHASES = Object.freeze(['running', 'degraded']);

/** 队列内复检（11 §2.3 第 2 层，TOCTOU 防护）：排队期间 phase 可能已被隧道/巡检改掉。 */
function recheckPhase(name, allowed, action) {
  const phase = store.getPhase(name);
  if (!allowed.includes(phase)) {
    const err = new DshError('PHASE_CONFLICT', `${action} 被取消：主机当前状态为 ${phase}`, { host: name });
    logEvent(name, 'warn', err.message);
    throw err;
  }
  return phase;
}

/**
 * 全流程 start（02 §3.2 × 12 §3）。队列内执行；任一步失败回滚 ready 并清远端孤儿。
 * @returns {Promise<{pid:number, actualPort:number, localPort:number}>}
 */
export function start(name) {
  return hostQueue(name).run('start', async (signal) => {
    const view = store.getHostView(name);
    if (!view) throw new DshError('NOT_FOUND', `未知主机 ${name}`, { host: name });
    if (!view.config.enabled) {
      throw new DshError('NOT_ALLOWED', `主机 ${name} 已在配置中停用`, { host: name });
    }
    recheckPhase(name, START_PHASES, '启动');

    store.setPhase(name, 'starting', 'launcher.start');

    /** @type {{pid:number, actualPort:number, logName:string, fingerprint:string, cwd:string|null}|null} */
    let launched = null;
    try {
      const localPort = await ensureLocalPort(name);
      const remotePort = store.effectiveRemotePort(name);

      const sync = await syncPatches(name, view.config.inject.patches, view.patchSync, { signal });
      if (sync.uploaded > 0 || sync.skipped > 0) {
        store.mutateHostState(name, (st) => { st.patchSync = sync.patchSync; });
        logEvent(name, 'info', `patch 同步完成：上载 ${sync.uploaded}、跳过 ${sync.skipped}`);
      }

      // 下次拉起才生效的语义与 inject 完全一致：这里读的是 config 现值
      const workdir = view.config.workdir ?? null;

      launched = await runLaunchSequence(name, {
        port: remotePort,
        env: view.config.inject.env,
        extraArgs: view.config.inject.extraArgs,
        patchRemoteNames: sync.remoteNames,
        workdir,
      }, { signal });

      store.mutateHostState(name, (st) => {
        st.web = {
          pid: launched.pid,
          port: launched.actualPort,
          startedByUs: true,
          cmdFingerprint: launched.fingerprint,
          log: launched.logName,
          startedAt: new Date().toISOString(),
          // 本次实例实际生效值；与 config.workdir 不等 = 前端的「重启后生效」态
          workdir,
          // 远端实测 cwd（best-effort，仅展示与诊断）
          cwd: launched.cwd,
        };
      });

      await tunnel.open(name, { localPort, remotePort: launched.actualPort });

      store.setPhase(name, 'running', 'launcher.start');
      logEvent(name, 'info', `已启动 pid=${launched.pid} 远端端口=${launched.actualPort} 本机端口=${localPort}`);
      return { pid: launched.pid, actualPort: launched.actualPort, localPort };
    } catch (err) {
      await rollbackStart(name, launched, signal);
      const e = err instanceof DshError ? err : new DshError('INTERNAL', err.message, { host: name, cause: err });
      logEvent(name, 'error', `启动失败：${e.message}`, e.detail ?? null);
      throw e;
    }
  }, { timeoutMs: PROTO_TIMING.startBudgetMs });
}

/** 回滚（12 §3.6）：远端已拉起就按指纹停掉，state 清空，phase 回 ready。 */
async function rollbackStart(name, launched, signal) {
  try {
    await tunnel.close(name);
  } catch {
    // 隧道尚未建立或已死，无需处理
  }
  if (launched) {
    try {
      const res = await stopRemote(name, { pid: launched.pid, fingerprint: launched.fingerprint }, { signal });
      if (res.killed === 'no') {
        logEvent(name, 'warn', `回滚时拒杀 pid=${launched.pid}（指纹不符），远端可能留下孤儿实例`);
      }
    } catch (err) {
      logEvent(name, 'warn', `回滚清理远端失败：${err.message}`);
    }
  }
  store.mutateHostState(name, (st) => {
    st.web = null;
    st.tunnel = null;
  });
  if (store.getPhase(name) === 'starting') store.setPhase(name, 'ready', 'launcher.start.rollback');
}

/**
 * stop（02 §3.5）：隧道先关 → 停止协议（指纹全等）→ 清 state.web → ready。
 * KILLED=no → 抛 KILL_REFUSED 且 state 不动（人工裁决，README 不误杀契约）。
 */
export function stop(name) {
  return hostQueue(name).run('stop', async (signal) => {
    const st = store.getHostState(name);
    if (!store.getHostView(name)) throw new DshError('NOT_FOUND', `未知主机 ${name}`, { host: name });
    if (!st?.web?.startedByUs) {
      throw new DshError('NOT_ALLOWED', `主机 ${name} 上没有由本 manager 拉起的实例，拒绝关停`, { host: name });
    }
    recheckPhase(name, STOP_PHASES, '关停');

    const { pid, cmdFingerprint } = st.web;
    await tunnel.close(name);

    const res = await stopRemote(name, { pid, fingerprint: cmdFingerprint }, { signal });
    if (res.killed === 'no') {
      const err = killRefused(name, { pid, expected: cmdFingerprint, actual: res.actualArgs });
      logEvent(name, 'error', err.message, err.detail);
      throw err;
    }

    store.mutateHostState(name, (entry) => {
      entry.web = null;
      entry.tunnel = null;
    });
    store.setPhase(name, 'ready', 'launcher.stop');
    logEvent(name, 'info', `已关停 pid=${pid}（${res.killed}）`);
    return { killed: res.killed };
  }, { timeoutMs: PROTO_TIMING.onceTimeoutMs + 10_000 });
}

/** stop → start，复用同一 localPort（config 中已固定）。 */
export async function restart(name) {
  const phase = store.getPhase(name);
  if (STOP_PHASES.includes(phase)) await stop(name);
  return start(name);
}

/**
 * 启动恢复复核（02 §3.1 第 2 步）：state 里 running/degraded 的主机是否还真活着。
 * @returns {Promise<'running'|'crashed'>}
 */
export async function recoverOne(name) {
  return hostQueue(name).run('recover', async (signal) => {
    const st = store.getHostState(name);
    // 上一代 manager 的隧道子进程随其退出而死：state 里的隧道记录一律作废（契约疑议 3 口径）
    if (st?.tunnel) store.mutateHostState(name, (e) => { e.tunnel = null; });

    const web = st?.web;
    if (!web?.pid || !web?.cmdFingerprint) {
      logEvent(name, 'warn', '恢复复核：state 无受管实例记录，标记 crashed');
      return toCrashed(name);
    }

    let v;
    try {
      v = await verifyRemote(name, { pid: web.pid, port: web.port ?? 1, fingerprint: web.cmdFingerprint }, { signal });
    } catch (err) {
      logEvent(name, 'warn', `恢复复核失败（${err.message}），标记 crashed`, err.detail ?? null);
      return toCrashed(name);
    }

    if (!v.alive || v.fingerprintMatch === false) {
      logEvent(name, 'warn', v.alive ? '恢复复核：指纹不符，标记 crashed' : '恢复复核：远端进程已消失，标记 crashed');
      return toCrashed(name);
    }

    // 接管的是上一代 manager 拉起的进程：config.workdir 未必是它的实际 cwd，
    // 把实测值记下来给抽屉显示（不校验、不据此拒绝接管，§4.3）
    store.mutateHostState(name, (e) => { e.web = { ...e.web, cwd: v.cwd }; });

    try {
      const localPort = await ensureLocalPort(name);
      await tunnel.open(name, { localPort, remotePort: web.port });
    } catch (err) {
      logEvent(name, 'error', `恢复隧道失败：${err.message}`, err.detail ?? null);
      return toCrashed(name);
    }

    store.setPhase(name, 'running', 'launcher.recoverOne');
    logEvent(name, 'info', `恢复接管 pid=${web.pid}，隧道已重建`);
    return 'running';
  }, { timeoutMs: PROTO_TIMING.startBudgetMs });
}

function toCrashed(name) {
  const phase = store.getPhase(name);
  if (phase !== 'crashed') store.setPhase(name, 'crashed', 'launcher.recoverOne');
  return 'crashed';
}
