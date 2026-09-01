/**
 * 并行探测（03 §2 / 12 §1.1 协议），驱动 phase: unknown → ready/no_dsh/unreachable。
 */

import { logEvent } from './lib/bus.js';
import {
  buildManualPortProbeScript,
  buildProbeScript,
  kvOne,
  parseManualPortBlock,
  parseProtoOutput,
} from './lib/proto.js';
import { hostQueue, localExec, sshExec } from './lib/ssh.js';
import { PROBE_PROTECTED_PHASES } from './lib/machine.js';
import { DshError, asDshError } from './lib/errors.js';
import { mapPool } from './lib/pool.js';
import { SSH_FANOUT_LIMIT } from './defaults.js';
import * as store from './store.js';

/**
 * @typedef {{ok:boolean, phase:'ready'|'no_dsh'|'unreachable', dshPath:string|null,
 *   version:string|null, dshHome:string|null, profileWeb:boolean, runningRaw:string,
 *   sniff:{paths:string[], loginPath:string|null, version:string|null, probePath:string|null},
 *   dependencies:{binary:boolean, webProfile:boolean, bash:boolean, timeout:boolean},
 *   noDshReason:'missing-bin'|'no-web-profile'|null, stderr:string,
 *   manualInstances:{pid:number,args:string,port:number|null}[]}} ProbeResult
 */

/** `ps -eo pid,args` 行 → {pid, args}。 */
export function parseRunningBlock(raw) {
  const out = [];
  for (const line of String(raw ?? '').split('\n')) {
    const m = /^\s*(\d+)\s+(.*\S)\s*$/.exec(line);
    if (!m) continue;
    out.push({ pid: Number(m[1]), args: m[2], port: parseManualPort(m[2]) });
  }
  return out;
}

/** 从手动实例 argv 读取固定端口；0/缺失/非法均表示需要监听探测。 */
export function parseManualPort(args) {
  const match = /(?:^|\s)--port(?:=|\s+)(\d+)(?=\s|$)/.exec(String(args ?? ''));
  if (!match) return null;
  const port = Number(match[1]);
  return port >= 1 && port <= 65535 ? port : null;
}

/** 嗅探块按行收集，空行只表示没有命中。 */
export function parseSniffPaths(raw) {
  return String(raw ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/**
 * 把探测 stdout 解析为 ProbeResult（纯函数，喂样本即可单测）。
 * @param {{code:number|null, stdout:string, stderr:string, timedOut:boolean, aborted:boolean}} res
 * @param {{local?:boolean}} [opts]
 * @returns {ProbeResult}
 */
export function interpretProbe(res, { local = false } = {}) {
  const rawStderr = res.stderr ?? '';
  let failureStderr = rawStderr;
  if (local) {
    const summary = res.timedOut
      ? '本机探测超时'
      : res.aborted
        ? '本机探测被中止'
        : `本机探测命令执行失败（退出码 ${res.code ?? '未知'}）`;
    failureStderr = rawStderr ? `${summary}\n${rawStderr}` : summary;
  }
  const base = {
    ok: false,
    phase: 'unreachable',
    dshPath: null,
    version: null,
    dshHome: null,
    profileWeb: false,
    runningRaw: '',
    sniff: {
      paths: [],
      loginPath: null,
      version: null,
      probePath: null,
    },
    dependencies: {
      binary: false,
      webProfile: false,
      bash: false,
      timeout: false,
    },
    noDshReason: null,
    stderr: failureStderr,
    manualInstances: [],
  };

  if (res.timedOut || res.aborted || res.code !== 0) return base;

  let out;
  try {
    out = parseProtoOutput(res.stdout, { requireDone: 'PROBE_DONE' });
  } catch (err) {
    // 协议输出不可解析：不是「连不上」，但也无法判定 dsh 状态 → 按 unreachable 呈现并留证
    const detail = err.detail ?? err.message;
    return { ...base, stderr: local ? `本机探测输出无法解析：${detail}` : detail };
  }

  const bin = kvOne(out, 'DSH_BIN');
  const runningRaw = out.blocks.RUNNING_DSH_WEB ?? '';
  const manualInstances = parseRunningBlock(runningRaw);
  const dshHome = kvOne(out, 'DSH_HOME');
  const profileWeb = kvOne(out, 'PROFILE_WEB') === 'yes';
  const dependencies = {
    binary: Boolean(bin && bin !== 'MISSING'),
    webProfile: profileWeb,
    bash: kvOne(out, 'HAS_BASH') === 'yes',
    timeout: kvOne(out, 'HAS_TIMEOUT') === 'yes',
  };
  const sniff = {
    paths: parseSniffPaths(out.blocks.DSH_SNIFF),
    loginPath: kvOne(out, 'DSH_SNIFF_LOGIN') || null,
    version: kvOne(out, 'DSH_SNIFF_VERSION') || null,
    probePath: kvOne(out, 'PROBE_PATH') || null,
  };

  if (!bin || bin === 'MISSING') {
    return {
      ...base,
      phase: 'no_dsh',
      noDshReason: 'missing-bin',
      dshHome,
      runningRaw,
      manualInstances,
      dependencies,
      sniff,
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
    dependencies,
    sniff,
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
export async function probeOnce(host, { local = false, timeoutMs, signal, dshPath } = {}) {
  const configuredPath = dshPath === undefined
    ? (store.getHostView(host)?.config?.dshPath ?? null)
    : dshPath;
  const command = buildProbeScript({ dshPath: configuredPath });
  const res = local
    ? await localExec(command, { timeoutMs, signal })
    : await sshExec(host, command, { timeoutMs, signal });
  const result = interpretProbe(res, { local });
  const ambiguous = result.manualInstances.filter((item) => item.port === null);
  if (ambiguous.length === 0) return result;
  const portProbe = local
    ? await localExec(buildManualPortProbeScript(ambiguous.map((item) => item.pid)), { timeoutMs, signal })
    : await sshExec(host, buildManualPortProbeScript(ambiguous.map((item) => item.pid)), { timeoutMs, signal });
  if (portProbe.code !== 0 || portProbe.timedOut || portProbe.aborted) return result;
  let ports;
  try {
    ports = parseManualPortBlock(
      parseProtoOutput(portProbe.stdout, { requireDone: 'MANUAL_PORTS_DONE' }).blocks.MANUAL_PORTS ?? '',
    );
  } catch {
    return result;
  }
  return {
    ...result,
    manualInstances: result.manualInstances.map((item) => (
      item.port === null && ports.has(item.pid)
        ? { ...item, port: ports.get(item.pid) }
        : item
    )),
  };
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
    // 队首才重取 HostView：排队期间 reload 可能已换了配置快照，运输类型只认当前 config。
    const view = store.getHostView(name);
    if (!view) throw new DshError('NOT_FOUND', `未知主机 ${name}`, { host: name });
    if (!view.local && view.orphaned) {
      throw new DshError('NOT_ALLOWED', `主机 ${name} 的 ssh config 已消失，禁止探测`, { host: name });
    }
    const local = view.local === true;
    const result = await probeOnce(name, { local, signal });
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
      sniff: result.sniff,
      dependencies: result.dependencies,
      noDshReason: result.noDshReason,
      at: new Date().toISOString(),
      errorSummary: result.phase === 'unreachable' ? summarize(result.stderr) : null,
    };
    entry.dshPath = result.dshPath;
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
  const targets = (names ?? store.listHostNames())
    .filter((name) => {
      const view = store.getHostView(name);
      return view?.config?.enabled !== false
        && (!view?.orphaned || view?.local);
    });
  // 有闸：主机一多，无闸的扇出会把共用跳板机的 MaxStartups 打爆（issue #85）
  return mapPool(targets, (name) => probeHost(name).catch((err) => {
    const e = asDshError(err);
    logEvent(name, 'warn', `探测失败：${e.message}`, e.detail);
    throw e;
  }), SSH_FANOUT_LIMIT);
}
