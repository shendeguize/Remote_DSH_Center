/**
 * 并行探测（03 §2 / 12 §1.1 协议），驱动 phase: unknown → ready/no_dsh/unreachable。
 */

import { logEvent } from './lib/bus.js';
import { buildProbeScript, kvOne, parseProtoOutput } from './lib/proto.js';
import { hostQueue, sshExec } from './lib/ssh.js';
import { PROBE_PROTECTED_PHASES } from './lib/machine.js';
import { asDshError } from './lib/errors.js';
import { mapPool } from './lib/pool.js';
import { SSH_FANOUT_LIMIT } from './defaults.js';
import * as store from './store.js';

/**
 * @typedef {{ok:boolean, phase:'ready'|'no_dsh'|'unreachable', dshPath:string|null,
 *   version:string|null, dshHome:string|null, profileWeb:boolean, runningRaw:string,
 *   noDshReason:'missing-bin'|'no-web-profile'|null, stderr:string,
 *   manualInstances:{pid:number,args:string}[]}} ProbeResult
 */

/** `ps -eo pid,args` 行 → {pid, args}。 */
export function parseRunningBlock(raw) {
  const out = [];
  for (const line of String(raw ?? '').split('\n')) {
    const m = /^\s*(\d+)\s+(.*\S)\s*$/.exec(line);
    if (!m) continue;
    out.push({ pid: Number(m[1]), args: m[2] });
  }
  return out;
}

/**
 * 把探测 stdout 解析为 ProbeResult（纯函数，喂样本即可单测）。
 * @param {{code:number|null, stdout:string, stderr:string, timedOut:boolean, aborted:boolean}} res
 * @returns {ProbeResult}
 */
export function interpretProbe(res) {
  const base = {
    ok: false,
    phase: 'unreachable',
    dshPath: null,
    version: null,
    dshHome: null,
    profileWeb: false,
    runningRaw: '',
    noDshReason: null,
    stderr: res.stderr ?? '',
    manualInstances: [],
  };

  if (res.timedOut || res.aborted || res.code !== 0) return base;

  let out;
  try {
    out = parseProtoOutput(res.stdout, { requireDone: 'PROBE_DONE' });
  } catch (err) {
    // 协议输出不可解析：不是「连不上」，但也无法判定 dsh 状态 → 按 unreachable 呈现并留证
    return { ...base, stderr: err.detail ?? err.message };
  }

  const bin = kvOne(out, 'DSH_BIN');
  const runningRaw = out.blocks.RUNNING_DSH_WEB ?? '';
  const manualInstances = parseRunningBlock(runningRaw);
  const dshHome = kvOne(out, 'DSH_HOME');
  const profileWeb = kvOne(out, 'PROFILE_WEB') === 'yes';

  if (!bin || bin === 'MISSING') {
    return {
      ...base,
      phase: 'no_dsh',
      noDshReason: 'missing-bin',
      dshHome,
      runningRaw,
      manualInstances,
      stderr: '',
    };
  }

  const common = {
    ok: true,
    dshPath: bin,
    version: kvOne(out, 'DSH_VERSION') || null,
    dshHome,
    profileWeb,
    runningRaw,
    manualInstances,
    stderr: '',
  };

  if (!profileWeb) {
    return { ...base, ...common, ok: false, phase: 'no_dsh', noDshReason: 'no-web-profile' };
  }
  return { ...base, ...common, phase: 'ready' };
}

/**
 * 纯探测（不写 state）。dshc init 第 3 步复用（setup 时 server 尚不存在，
 * 「操作收敛到 server」的前提不成立，见 11 §1.3 例外条款）。
 * @returns {Promise<ProbeResult>}
 */
export async function probeOnce(host, { timeoutMs, signal } = {}) {
  const res = await sshExec(host, buildProbeScript(), { timeoutMs, signal });
  return interpretProbe(res);
}

/** 单行 stderr 摘要（长文本不进环形缓冲，11 §7.2）。 */
function summarize(stderr) {
  const line = String(stderr ?? '')
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l !== '');
  if (!line) return null;
  return line.length > 200 ? `${line.slice(0, 197)}…` : line;
}

/** 队列内探测并应用：probeOnce → setPhase(3 分类) + state.probe + manualInstances 并入。 */
export async function probeHost(name) {
  return hostQueue(name).run('probe', async (signal) => {
    const result = await probeOnce(name, { signal });
    applyProbe(name, result);
    return result;
  });
}

/**
 * 结果应用。starting/running/degraded 期间禁止探测改写 phase——只刷新 manualInstances
 * 与 probe 详情（11 §2.2）。
 */
export function applyProbe(name, result) {
  const phaseNow = store.getPhase(name);
  const protectedPhase = PROBE_PROTECTED_PHASES.includes(phaseNow);

  const managedPid = store.getHostState(name)?.web?.pid ?? null;
  const manual = result.manualInstances.filter((i) => i.pid !== managedPid);

  store.mutateHostState(name, (entry) => {
    entry.probe = {
      dshPath: result.dshPath,
      version: result.version,
      dshHome: result.dshHome,
      profileWeb: result.profileWeb,
      noDshReason: result.noDshReason,
      at: new Date().toISOString(),
      errorSummary: result.phase === 'unreachable' ? summarize(result.stderr) : null,
    };
    entry.manualInstances = manual;
  });

  if (!protectedPhase) {
    store.setPhase(name, result.phase, 'prober.probeHost');
  }
  return result;
}

/**
 * 并行触发全量/指定探测，立即返回（202 语义）；结果经 SSE。
 * @param {string[]|null} names
 * @returns {Promise<PromiseSettledResult<any>[]>} 供 server 启动序列 await
 */
export function probeAll(names = null) {
  const targets = names ?? store.listHostNames();
  // 有闸：主机一多，无闸的扇出会把共用跳板机的 MaxStartups 打爆（issue #85）
  return mapPool(targets, (name) => probeHost(name).catch((err) => {
    const e = asDshError(err);
    logEvent(name, 'warn', `探测失败：${e.message}`, e.detail);
    throw e;
  }), SSH_FANOUT_LIMIT);
}
