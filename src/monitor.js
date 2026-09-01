/**
 * 周期巡检（02 §3.4，边界见 11 §5.5）。
 *
 * 只做两件事：对 running 主机探活本机转发通道；探活失败时经 hostQueue 深复核远端，
 * 死则 crashed、活则委托 tunnel 重建子进程。degraded/crashed 一律跳过——
 * 那是隧道重连环自己的地盘，不重复劳动。
 */

import { logEvent } from './lib/bus.js';
import { buildVerifyScript, kvOne, parseProtoOutput } from './lib/proto.js';
import {
  execFailure, hostQueue, localExec, sshExec,
} from './lib/ssh.js';
import { mapPool } from './lib/pool.js';
import { SSH_FANOUT_LIMIT } from './defaults.js';
import * as store from './store.js';
import * as tunnel from './tunnel.js';

export const MONITOR_INTERVAL_MS = 30_000;
/** 探活要跨 ssh 走一个来回，留够广域网 RTT 的余量。 */
export const MONITOR_PROBE_TIMEOUT_MS = 2_000;

let timer = null;
/** 上一轮尚未结束时跳过本轮，避免慢 ssh 叠加。 */
let running = false;

export function startLoop({ intervalMs = MONITOR_INTERVAL_MS } = {}) {
  if (timer) return;
  timer = setInterval(() => {
    tick().catch((err) => logEvent(null, 'warn', `巡检异常：${err.message}`, err.detail ?? null));
  }, intervalMs);
  timer.unref?.();
}

export function stopLoop() {
  if (timer) clearInterval(timer);
  timer = null;
}

export function isLooping() {
  return timer !== null;
}

/** 一轮巡检（导出供测试直接驱动，无需等 30s）。 */
export async function tick() {
  if (running) return { skipped: true };
  running = true;
  try {
    // 兜一道：配置里没有的主机不该还留着隧道。reload/setup 两条路已各自收过一次，
    // 这里防的是「还有别的路会把主机从配置里拿掉」——巡检本来就是收敛现实与记录的偏差
    // （issue #96）。
    await tunnel.closeUnconfigured();
    const targets = store.listHostNames().filter((n) => store.getPhase(n) === 'running');
    // 有闸：合盖睡醒时所有隧道会一起断，深复核随之一起发——那正是跳板机最忙的时候（issue #85）
    const settled = await mapPool(targets, (n) => checkOne(n), SSH_FANOUT_LIMIT);
    const results = settled.map((r, i) => {
      if (r.status === 'fulfilled') return r.value;
      // 有闸之后单台抛错不再连坐整轮，但也不许悄无声息
      logEvent(targets[i], 'warn', `巡检这一台出错：${r.reason?.message ?? r.reason}`);
      return { host: targets[i], outcome: /** @type {const} */ ('unknown') };
    });
    return { checked: targets.length, results };
  } finally {
    running = false;
  }
}

/** @returns {Promise<{host:string, outcome:'ok'|'no-tunnel'|'restarted'|'unresponsive'|'crashed'|'restart-failed'|'unknown'}>} */
export async function checkOne(name) {
  const t = tunnel.status(name);
  if (!t || t.localPort === null) return { host: name, outcome: 'no-tunnel' };
  if (t.suspendedReason) return { host: name, outcome: 'no-tunnel' };

  if (await tunnel.probeForward(t.localPort, MONITOR_PROBE_TIMEOUT_MS)) {
    return { host: name, outcome: 'ok' };
  }

  logEvent(name, 'warn', `巡检发现本机端口 ${t.localPort} 不通，进入深度复核`);
  const local = store.getHostView(name)?.local === true;
  const alive = await deepCheck(name);

  if (alive === false) {
    const adopted = store.getHostState(name)?.web?.startedByUs === false;
    store.mutateHostState(name, (st) => {
      st.tunnel = null;
      if (adopted) st.web = null;
    });
    await tunnel.close(name);
    if (store.getPhase(name) === 'running') store.setPhase(name, 'crashed', 'monitor.deepCheck');
    logEvent(
      name,
      'error',
      local
        ? adopted
          ? '深度复核：本机领养实例已消失，已解除领养并标记 crashed'
          : '深度复核：本机实例已消失或指纹不符，标记 crashed'
        : adopted
          ? '深度复核：远端领养实例已消失，已解除领养并标记 crashed'
          : '深度复核：远端实例已消失或指纹不符，标记 crashed',
    );
    return { host: name, outcome: 'crashed' };
  }
  if (alive === null) {
    logEvent(
      name,
      'warn',
      local
        ? '深度复核无法判定（本机命令执行故障或无受管记录），本轮不动状态'
        : '深度复核无法判定（ssh 故障或无受管记录），本轮不动状态',
    );
    return { host: name, outcome: 'unknown' };
  }

  // 本机没有运输通道可重建：进程和指纹仍对就保持 running，下一轮继续探活。
  if (local) {
    logEvent(name, 'warn', '深度复核：本机进程和指纹仍在，但 web 端口无响应');
    return { host: name, outcome: 'unresponsive' };
  }

  try {
    await tunnel.restartChild(name);
    logEvent(name, 'info', '远端仍在运行，隧道子进程已重建');
    return { host: name, outcome: 'restarted' };
  } catch (err) {
    logEvent(name, 'error', `隧道重建失败：${err.message}`, err.detail ?? null);
    return { host: name, outcome: 'restart-failed' };
  }
}

/**
 * 深复核：VERIFY 存活 + 指纹全等。
 * @returns {Promise<boolean|null>} null = 无从判断（无受管记录 / ssh 层故障）
 */
async function deepCheck(name) {
  try {
    return await hostQueue(name).run('monitor-verify', async (signal) => {
      // 队首重取 state/config，确保排队期间的 reload 不会留下旧运输类型。
      const web = store.getHostState(name)?.web;
      if (!web?.pid || !web?.cmdFingerprint) return null;
      const local = store.getHostView(name)?.local === true;
      const command = buildVerifyScript({ pid: web.pid, port: web.port ?? 1 });
      const res = local
        ? await localExec(command, { signal })
        : await sshExec(name, command, { signal, user: store.effectiveSshUser(name) });
      if (execFailure(name, '巡检复核', res)) return null;
      const out = parseProtoOutput(res.stdout, { requireDone: 'VERIFY_DONE' });
      if (kvOne(out, 'ALIVE') !== 'yes') return false;
      return (out.blocks.ARGS ?? null) === web.cmdFingerprint;
    });
  } catch {
    return null;
  }
}
