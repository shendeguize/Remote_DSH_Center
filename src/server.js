/**
 * 服务装配与启动序列（11 §3.1、§3.4）。
 *
 * 启动顺序有因：先 listen（进展经 SSE 可见）→ 写 pidfile → 恢复复核与首轮探测并行 →
 * autoStart → 巡检环 → 信号钩子。退出/自我重启严格按 §3.4 的步序，顺序错了会引发
 * 端口占用与 pidfile 竞态。
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { FACTORY_DEFAULTS, SSH_FANOUT_LIMIT, resolvePaths } from './defaults.js';
import { DshError, asDshError } from './lib/errors.js';
import { isMainEntry } from './lib/entry.js';
import { logEvent } from './lib/bus.js';
import { trimLogFile } from './lib/logfile.js';
import { checkRequestOrigin } from './lib/origin-guard.js';
import { mapPool } from './lib/pool.js';
import { reopenSsh, shutdownSsh } from './lib/ssh.js';
import * as daemon from './daemon.js';
import * as launcher from './launcher.js';
import * as monitor from './monitor.js';
import * as prober from './prober.js';
import * as store from './store.js';
import * as tunnel from './tunnel.js';
import { createHandler } from './api.js';
import { loadHosts } from './ssh-config.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.join(HERE, 'web');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

export const PKG_VERSION = readVersion();

function readVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8')).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** 单进程内的运行时（导出供集成测试直接拿句柄）。 */
export const runtime = {
  /** @type {http.Server|null} */
  httpServer: null,
  /** @type {any} */
  handler: null,
  mode: 'foreground',
  port: null,
  startedAt: null,
  setupGate: false,
  shuttingDown: false,
  /** @type {NodeJS.Timeout|null} */
  logTrimTimer: null,
};

// ── 静态资源（01 文档前端；无构建链，原样吐 ESM） ─────────────────────────

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const target = path.join(WEB_DIR, rel);
  // 目录穿越防护：解析后必须仍在 WEB_DIR 内
  if (!target.startsWith(`${WEB_DIR}${path.sep}`) && target !== WEB_DIR) {
    res.writeHead(403).end('forbidden');
    return;
  }
  fs.readFile(target, (err, data) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found');
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(target).toLowerCase()] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(data);
  });
}

// ── managerCtl（注入 api，禁止 api → server 反向 import） ────────────────

function buildManagerCtl() {
  return {
    info() {
      return {
        version: PKG_VERSION,
        pid: process.pid,
        port: runtime.port,
        mode: runtime.mode,
        startedAt: runtime.startedAt,
        uptimeMs: runtime.startedAt ? Date.now() - Date.parse(runtime.startedAt) : 0,
        setupCompleted: store.isSetupCompleted(),
        setupGateActive: runtime.setupGate,
        hostCounts: store.hostCounts(),
        revision: store.currentRevision(),
      };
    },
    setupGateActive() {
      return runtime.setupGate;
    },
    async restart() {
      return requestRestart();
    },
    async shutdown() {
      setTimeout(() => { gracefulExit('api-shutdown').catch(() => process.exit(1)); }, 50).unref?.();
      return { mode: runtime.mode };
    },
    async applySetup(incoming) {
      return applySetup(incoming);
    },
  };
}

// ── setup（ENG-19 的服务侧） ─────────────────────────────────────────────

async function applySetup(incoming) {
  const before = runtime.port;
  const saved = store.saveConfigFromSetup(incoming);
  const portChanged = saved.manager.port !== before;

  if (!portChanged) {
    // 端口未变：撤门禁 + 热切换，继续走启动序列 6–9 步
    runtime.setupGate = false;
    logEvent(null, 'info', '初始化配置已保存，门禁解除');
    store.mergeSshHosts(loadHosts());
    void postSetupBoot();
    return { ok: true, port: saved.manager.port, portChanged: false, restartRequired: false, restarting: false };
  }

  if (runtime.mode === 'foreground') {
    // 前台模式不能自我重启（02 §9.4）：如实告知，等人工重启
    logEvent(null, 'warn', `manager 端口已改为 ${saved.manager.port}，前台模式需手动重启生效`);
    return { ok: true, port: saved.manager.port, portChanged: true, restartRequired: true, restarting: false };
  }

  logEvent(null, 'info', `manager 端口已改为 ${saved.manager.port}，正在自我重启`);
  setTimeout(() => { selfRestart().catch(() => process.exit(1)); }, 50).unref?.();
  return { ok: true, port: saved.manager.port, portChanged: true, restartRequired: false, restarting: true };
}

/** setup 完成后的补跑：探测 → autoStart → 巡检。 */
async function postSetupBoot() {
  try {
    await prober.probeAll();
    await runAutoStart();
    monitor.startLoop();
  } catch (err) {
    logEvent(null, 'warn', `初始化后自动流程异常：${asDshError(err).message}`);
  }
}

// ── 启动序列 ─────────────────────────────────────────────────────────────

/** state 里 running/degraded 的主机各自队列内并行复核（§3.1 第 4–5 步）。 */
async function recoverState() {
  const targets = store.listHostNames().filter((n) => ['running', 'degraded'].includes(store.getPhase(n)));
  if (targets.length === 0) return [];
  logEvent(null, 'info', `恢复复核 ${targets.length} 台主机`);
  const results = await mapPool(targets, (n) => launcher.recoverOne(n), SSH_FANOUT_LIMIT);
  return targets.map((name, i) => ({
    name,
    outcome: results[i].status === 'fulfilled' ? results[i].value : 'crashed',
  }));
}

/** autoStart：config.autoStart ∧ 探测后 ready → start（单机失败仅 log-line，不阻塞）。 */
export async function runAutoStart() {
  const cfg = store.getConfig();
  const targets = store.listHostNames().filter((n) => {
    const host = cfg.hosts[n];
    return host?.enabled && host?.autoStart && store.getPhase(n) === 'ready';
  });
  if (targets.length === 0) return [];
  logEvent(null, 'info', `autoStart：${targets.join(', ')}`);
  // 有闸：一次拉起要走 LAUNCH/POLL/VERIFY 数趟 ssh，几十台一起冲最容易把跳板机打爆（issue #85）
  const results = await mapPool(targets, (n) => launcher.start(n), SSH_FANOUT_LIMIT);
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      const e = asDshError(r.reason);
      logEvent(targets[i], 'warn', `autoStart 失败：${e.message}`, e.detail ?? null);
    }
  });
  return targets;
}

/**
 * @param {{portOverride?:number|null, skipBoot?:boolean}} [opts] skipBoot 供集成测试
 *   （只要 HTTP 面，不跑恢复/探测/巡检）
 */
export async function main({ portOverride = null, skipBoot = false } = {}) {
  runtime.mode = daemon.detectMode();
  runtime.startedAt = new Date().toISOString();
  reopenSsh(); // 同进程里关停过又起来的场合（用例装置）不能带着上一轮的关停闩

  await store.init();
  store.setTunnelStatusProvider(tunnel.status);
  // setup 模式也要有主机清单：向导第 3 步要勾选主机（13 §4 允许 GET /api/hosts）
  store.mergeSshHosts(loadHosts());

  runtime.setupGate = !store.isSetupCompleted();
  const cfg = store.getConfig();
  const port = portOverride ?? (runtime.setupGate ? FACTORY_DEFAULTS.manager.port : cfg.manager.port);

  const handler = createHandler({ managerCtl: buildManagerCtl() });
  runtime.handler = handler;

  const httpServer = http.createServer((req, res) => {
    // 跨站防线放在最前面，静态页也要挡：DNS rebinding 是先让攻击者的域名把这个页面
    // 装进他自己的 origin，再从那儿读写 API。
    const verdict = checkRequestOrigin({ headers: req.headers, port: runtime.port });
    if (!verdict.ok) {
      // 错误体沿用全端点统一契约（13 §1.1），连静态页这条路也照办
      const body = JSON.stringify(new DshError(verdict.code, verdict.message).toBody());
      res.writeHead(verdict.status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(body),
        'cache-control': 'no-store',
      });
      res.end(body);
      return;
    }
    const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
    if (pathname.startsWith('/api/')) {
      handler(req, res);
      return;
    }
    serveStatic(req, res, pathname);
  });
  // SSE 长连接不能被 keep-alive 超时掐断
  httpServer.keepAliveTimeout = 0;
  httpServer.requestTimeout = 0;
  httpServer.headersTimeout = 60_000;
  trackSockets(httpServer);
  runtime.httpServer = httpServer;

  await new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, '127.0.0.1', () => {
      httpServer.removeListener('error', reject);
      resolve();
    });
  });
  runtime.port = httpServer.address().port;

  daemon.writePidfile({
    pid: process.pid,
    port: runtime.port,
    mode: runtime.mode,
    startedAt: runtime.startedAt,
  });

  logEvent(null, 'info', `manager 已监听 http://127.0.0.1:${runtime.port}（模式 ${runtime.mode}）`);
  if (runtime.setupGate) {
    logEvent(null, 'warn', '尚未完成首次配置：仅开放引导页与 /api/setup');
  }

  installSignalHooks();
  startLogTrimLoop();

  if (!runtime.setupGate && !skipBoot) {
    const recovered = await recoverState();
    const recoveredNames = new Set(recovered.map((r) => r.name));
    await prober.probeAll(store.listHostNames().filter((n) => !recoveredNames.has(n)));
    await runAutoStart();
    monitor.startLoop();
  }

  return { port: runtime.port, setupGate: runtime.setupGate };
}

// ── 日志封顶（issue #81） ────────────────────────────────────────────────

const LOG_TRIM_INTERVAL_MS = 10 * 60_000;

/**
 * manager.log 只追加、从不回收，而这进程在 launchd 下是 7×24 的：一台链路不稳的主机
 * 实测约 8MB/天。开机看一眼、之后每 10 分钟看一眼，超了就原地截断留尾巴。
 */
function startLogTrimLoop() {
  const once = () => {
    const res = trimLogFile(resolvePaths().log);
    if (res.trimmed) logEvent(null, 'info', `manager.log 到顶，已原地截断（丢掉较早的 ${res.dropped} 字节）`);
  };
  once();
  if (runtime.logTrimTimer) clearInterval(runtime.logTrimTimer);
  runtime.logTrimTimer = setInterval(once, LOG_TRIM_INTERVAL_MS);
  runtime.logTrimTimer.unref?.(); // 它不该成为「进程还有事做」的理由
}

// ── 退出与自我重启（§3.4） ───────────────────────────────────────────────

/** server.close() 需要所有存活 socket 被销毁，否则永不完成。 */
const sockets = new Set();

function trackSockets(server) {
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
}

function destroySockets() {
  for (const s of sockets) s.destroy();
  sockets.clear();
}

/** §3.4 的 2–6 步，gracefulExit 与 selfRestart 共用。 */
async function teardown() {
  monitor.stopLoop();
  if (runtime.logTrimTimer) {
    clearInterval(runtime.logTrimTimer);
    runtime.logTrimTimer = null;
  }
  // 在飞的一次性 ssh（探测 / 拉起 / 回读）也要收，且从此不再起新的：不收就是把它们
  // 交给 init 当孤儿，重启后新老两批命令同时打同一台远端（issue #73）。
  // 隧道由下面的 closeAll 管。
  shutdownSsh();
  await tunnel.closeAll();
  store.flushStateSync();
  runtime.handler?.sseHub?.closeAll();
  if (runtime.httpServer) {
    const closed = new Promise((resolve) => runtime.httpServer.close(resolve));
    destroySockets();
    await closed;
  }
  daemon.removePidfileIfOwn();
}

export async function gracefulExit(reason, { exit = true } = {}) {
  if (runtime.shuttingDown) return;
  runtime.shuttingDown = true;
  logEvent(null, 'info', `manager 退出（${reason}）`);
  try {
    await teardown();
  } catch (err) {
    logEvent(null, 'warn', `退出清理异常：${asDshError(err).message}`);
  }
  if (exit) process.exit(0);
}

/** 裸后台：teardown 后 detach 继任者（§3.4 第 7 步）。 */
export async function selfRestart() {
  if (runtime.shuttingDown) return;
  runtime.shuttingDown = true;
  logEvent(null, 'info', 'manager 自我重启');
  await teardown();
  const res = await daemon.launchDetached({ waitMs: 5_000 });
  if (!res.confirmed) {
    // 前任已无服务能力，不回滚——交给 dshc status 诊断（§3.4 第 7 步注）
    console.error('继任者未在 5s 内确认健康，请检查 manager.log 与 dshc status');
  }
  process.exit(0);
}

/** POST /api/manager/restart 的三模式分流（02 §9.4）。 */
async function requestRestart() {
  if (runtime.mode === 'foreground') {
    const err = asDshError(new Error('前台模式不支持自我重启：请在终端 Ctrl-C 后重新执行 dshc up'));
    err.code = 'NOT_ALLOWED';
    throw err;
  }
  if (runtime.mode === 'launchd') {
    // KeepAlive 会把进程拉回来，退出即重启
    setTimeout(() => { gracefulExit('launchd-restart').catch(() => process.exit(1)); }, 50).unref?.();
    return { mode: 'launchd' };
  }
  setTimeout(() => { selfRestart().catch(() => process.exit(1)); }, 50).unref?.();
  return { mode: 'background' };
}

let hooksInstalled = false;

function installSignalHooks() {
  if (hooksInstalled) return;
  hooksInstalled = true;
  process.on('SIGTERM', () => { gracefulExit('SIGTERM').catch(() => process.exit(1)); });
  process.on('SIGINT', () => { gracefulExit('SIGINT').catch(() => process.exit(1)); });
  process.on('exit', () => {
    // 同步兜底：debounce 里的 state 与自己的 pidfile
    try {
      store.flushStateSync();
    } catch {
      // 忽略
    }
    daemon.removePidfileIfOwn();
  });
}

/** 集成测试用：拆掉服务但不退出进程。 */
export async function _shutdownForTest() {
  monitor.stopLoop();
  if (runtime.logTrimTimer) {
    clearInterval(runtime.logTrimTimer);
    runtime.logTrimTimer = null;
  }
  shutdownSsh(); // 与 teardown 同一条：用例进程里留下的孤儿会跨用例互相干扰
  await tunnel.closeAll();
  runtime.handler?.sseHub?.dispose();
  if (runtime.httpServer) {
    const closed = new Promise((resolve) => runtime.httpServer.close(resolve));
    destroySockets();
    await closed;
  }
  daemon.removePidfileIfOwn();
  store.flushStateSync();
  runtime.httpServer = null;
  runtime.handler = null;
  runtime.port = null;
  runtime.shuttingDown = false;
}

// 直接 `node src/server.js` 即前台/后台运行（daemon.launchDetached 走这条）
if (isMainEntry(import.meta.url)) {
  const idx = process.argv.indexOf('--port');
  const portOverride = idx !== -1 ? Number(process.argv[idx + 1]) : null;
  main({ portOverride: Number.isInteger(portOverride) ? portOverride : null }).catch((err) => {
    const e = asDshError(err);
    console.error(`manager 启动失败：${e.message}`);
    if (e.detail) console.error(e.detail);
    process.exit(1);
  });
}
