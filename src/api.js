/**
 * HTTP API：REST 路由（ENG-12）+ SSE 推送（ENG-13）。规格＝13_api_schema.md。
 *
 * 两条纪律：
 * 1. 永不 import server.js——manager 自身能力（info/restart/shutdown/setup）由
 *    `managerCtl` 注入（依赖倒置，防环规则 2）。
 * 2. 长动作统一「202 受理 + operation-done 结算」：每个 202 有且仅有一条
 *    operation-done（含失败路径，13 §3.4）。
 */

import crypto from 'node:crypto';

import { DshError, asDshError } from './lib/errors.js';
import { bus, emitOperationDone, recentLogs } from './lib/bus.js';
import { assertValid, defaultsPatchSchema, hostConfigPatchSchema, setupBodySchema } from './lib/validate.js';
import * as launcher from './launcher.js';
import * as prober from './prober.js';
import * as store from './store.js';
import * as tunnel from './tunnel.js';

const MAX_BODY_BYTES = 1_048_576;
const SSE_HEARTBEAT_MS = 25_000;

/** setup 门禁白名单（13 §4）。 */
const SETUP_ALLOWED = [
  'GET /api/manager/info',
  'GET /api/config',
  'GET /api/hosts',
  'GET /api/events',
  'POST /api/hosts/probe',
  'POST /api/setup',
];

// ── 响应工具 ─────────────────────────────────────────────────────────────

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  res.end(text);
}

function sendText(res, status, text) {
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  res.end(text);
}

/** DshError → HTTP（11 §7.2 表）。 */
function sendError(res, err) {
  const e = asDshError(err);
  sendJson(res, e.httpStatus, e.toBody());
  return e;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new DshError('VALIDATION', `请求体超过 ${MAX_BODY_BYTES} 字节上限`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('error', reject);
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (text === '') return resolve({});
      try {
        const parsed = JSON.parse(text);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return reject(new DshError('VALIDATION', '请求体必须是 JSON 对象'));
        }
        resolve(parsed);
      } catch (err) {
        reject(new DshError('VALIDATION', `请求体不是合法 JSON：${err.message}`));
      }
    });
  });
}

// ── SSE hub（13 §3） ─────────────────────────────────────────────────────

export function createSseHub({ managerCtl, heartbeatMs = SSE_HEARTBEAT_MS } = {}) {
  /** @type {Set<import('node:http').ServerResponse>} */
  const clients = new Set();

  const write = (res, type, payload) => {
    // revision 在发送时刻自增：全客户端同帧同值，且天然合并 debounce 窗口内的连续变化
    const data = JSON.stringify({ revision: store.bumpRevision(), ...payload });
    res.write(`event: ${type}\ndata: ${data}\n\n`);
  };

  const broadcast = (type, buildPayload) => {
    if (clients.size === 0) return;
    const payload = buildPayload();
    if (payload === null) return;
    const data = JSON.stringify({ revision: store.bumpRevision(), ...payload });
    const frame = `event: ${type}\ndata: ${data}\n\n`;
    for (const res of clients) res.write(frame);
  };

  const onHostChanged = (name) => broadcast('host-changed', () => {
    const host = store.getHostView(name);
    return host ? { host } : null;
  });
  const onLogLine = (entry) => broadcast('log-line', () => entry);
  const onConfigChanged = (changed) => broadcast('config-changed', () => {
    const cfg = store.getConfig();
    return { defaults: cfg.defaults, manager: cfg.manager, changed: changed ?? [] };
  });
  const onOperationDone = (payload) => broadcast('operation-done', () => payload);

  bus.on('host-changed', onHostChanged);
  bus.on('log-line', onLogLine);
  bus.on('config-changed', onConfigChanged);
  bus.on('operation-done', onOperationDone);

  const heartbeat = setInterval(() => {
    for (const res of clients) res.write(':hb\n\n');
  }, heartbeatMs);
  heartbeat.unref?.();

  return {
    get size() {
      return clients.size;
    },

    /** 新连接：首帧 snapshot（13 §3.2）——前端据此完成首屏同步，无需去抖窗口。 */
    attach(req, res) {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.write(':ok\n\n');
      clients.add(res);

      const cfg = store.getConfig();
      write(res, 'snapshot', {
        manager: managerCtl.info(),
        defaults: cfg?.defaults ?? null,
        hosts: store.listHostViews(),
        logs: recentLogs(50),
      });

      const drop = () => {
        clients.delete(res);
      };
      req.on('close', drop);
      req.on('error', drop);
      res.on('error', drop);
    },

    /** §3.4 优雅退出：不主动断 SSE，server.close() 永不完成。 */
    closeAll() {
      for (const res of clients) {
        try {
          res.end();
        } catch {
          // 已断开
        }
      }
      clients.clear();
    },

    dispose() {
      clearInterval(heartbeat);
      bus.off('host-changed', onHostChanged);
      bus.off('log-line', onLogLine);
      bus.off('config-changed', onConfigChanged);
      bus.off('operation-done', onOperationDone);
      this.closeAll();
    },
  };
}

// ── 长动作：202 受理 + operation-done 结算 ───────────────────────────────

function accept(res, { host, action }, run) {
  const operationId = crypto.randomUUID();
  sendJson(res, 202, { accepted: true, operationId, host: host ?? null });

  Promise.resolve()
    .then(run)
    .then(() => emitOperationDone({
      operationId, host: host ?? null, action, status: 'ok', error: null, code: null, detail: null,
    }))
    .catch((err) => {
      const e = asDshError(err);
      emitOperationDone({
        operationId,
        host: host ?? null,
        action,
        status: 'failed',
        error: e.message,
        code: e.code,
        detail: e.detail,
      });
    });
}

// ── preflight（13 §2.10 / 11 §2.3 第 1 层） ──────────────────────────────

function requireHost(name) {
  const view = store.getHostView(name);
  if (!view) throw new DshError('NOT_FOUND', `未知主机 ${name}`, { host: name });
  return view;
}

function requirePhase(view, allowed, action) {
  if (!allowed.includes(view.phase)) {
    throw new DshError('PHASE_CONFLICT', `${action} 要求主机处于 ${allowed.join('/')}，当前为 ${view.phase}`, {
      host: view.name,
    });
  }
}

function requireManaged(view, action) {
  if (view.web?.startedByUs !== true) {
    throw new DshError('NOT_ALLOWED', `${action} 仅适用于本 manager 拉起的实例（不动手动实例）`, { host: view.name });
  }
}

// ── 路由表 ───────────────────────────────────────────────────────────────

/**
 * @param {{managerCtl:{info:Function, restart:Function, shutdown:Function,
 *   applySetup:Function, setupGateActive:Function}}} deps
 */
export function createHandler({ managerCtl }) {
  const sseHub = createSseHub({ managerCtl });

  const routes = [
    ['GET', /^\/api\/hosts$/, (req, res) => {
      sendJson(res, 200, { revision: store.currentRevision(), hosts: store.listHostViews() });
    }],

    ['GET', /^\/api\/config$/, (req, res) => {
      sendJson(res, 200, store.getConfig());
    }],

    ['GET', /^\/api\/manager\/info$/, (req, res) => {
      sendJson(res, 200, managerCtl.info());
    }],

    ['GET', /^\/api\/events$/, (req, res) => {
      sseHub.attach(req, res);
    }],

    ['GET', /^\/api\/hosts\/([^/]+)\/log$/, async (req, res, [name], url) => {
      const view = requireHost(decodeURIComponent(name));
      const raw = url.searchParams.get('lines');
      const lines = raw === null ? 200 : Number(raw);
      if (!Number.isInteger(lines) || lines < 1 || lines > 10_000) {
        throw new DshError('VALIDATION', 'lines 需为 1..10000 的整数');
      }
      const logName = view.web?.log ?? null;
      if (!logName) return sendText(res, 200, '(no log)\n');
      const text = await launcher.tailRemoteLog(view.name, { logName, lines });
      sendText(res, 200, text);
    }],

    ['PUT', /^\/api\/hosts\/([^/]+)\/config$/, async (req, res, [name]) => {
      const view = requireHost(decodeURIComponent(name));
      const body = await readJsonBody(req);
      assertValid(hostConfigPatchSchema, body, '主机配置校验失败（localPort 由 manager 分配，不接受提交）');

      store.updateConfig((draft) => {
        const host = draft.hosts[view.name];
        if ('enabled' in body) host.enabled = body.enabled;
        if ('autoStart' in body) host.autoStart = body.autoStart;
        if ('remoteWebPort' in body) host.remoteWebPort = body.remoteWebPort;
        // 与 inject 同款语义：落盘即生效于「下一次拉起」，不动正在跑的实例
        if ('workdir' in body) host.workdir = body.workdir;
        if ('inject' in body) {
          host.inject = {
            env: { ...body.inject.env },
            extraArgs: [...body.inject.extraArgs],
            patches: [...body.inject.patches],
          };
        }
      });
      sendJson(res, 200, { host: store.getHostView(view.name) });
    }],

    ['PUT', /^\/api\/config\/defaults$/, async (req, res) => {
      const body = await readJsonBody(req);
      assertValid(defaultsPatchSchema, body, 'defaults 校验失败');

      store.updateConfig((draft) => {
        if ('remoteWebPort' in body) draft.defaults.remoteWebPort = body.remoteWebPort;
        if ('localPortRange' in body) draft.defaults.localPortRange = [...body.localPortRange];
        if (body.manager && 'port' in body.manager) draft.manager.port = body.manager.port;
      });
      const cfg = store.getConfig();
      // manager.port 只落盘不热切换（13 §2.6）
      const restartRequired = Boolean(body.manager && body.manager.port !== managerCtl.info().port);
      sendJson(res, 200, { defaults: cfg.defaults, manager: cfg.manager, restartRequired });
    }],

    ['POST', /^\/api\/reload$/, (req, res) => {
      sendJson(res, 200, store.reloadConfig());
    }],

    ['POST', /^\/api\/setup$/, async (req, res) => {
      const body = await readJsonBody(req);
      assertValid(setupBodySchema, body, '初始化配置校验失败');
      sendJson(res, 200, await managerCtl.applySetup(body));
    }],

    ['POST', /^\/api\/manager\/restart$/, async (req, res) => {
      const result = await managerCtl.restart();
      sendJson(res, 202, { accepted: true, ...result });
    }],

    ['POST', /^\/api\/manager\/shutdown$/, async (req, res) => {
      const result = await managerCtl.shutdown();
      sendJson(res, 202, { accepted: true, ...result });
    }],

    ['POST', /^\/api\/hosts\/probe$/, (req, res) => {
      accept(res, { host: null, action: 'probe-all' }, () => prober.probeAll());
    }],

    ['POST', /^\/api\/hosts\/([^/]+)\/probe$/, (req, res, [name]) => {
      const view = requireHost(decodeURIComponent(name));
      accept(res, { host: view.name, action: 'probe' }, () => prober.probeHost(view.name));
    }],

    ['POST', /^\/api\/hosts\/([^/]+)\/start$/, (req, res, [name]) => {
      const view = requireHost(decodeURIComponent(name));
      if (!view.config.enabled) {
        throw new DshError('NOT_ALLOWED', `主机 ${view.name} 已在配置中停用`, { host: view.name });
      }
      requirePhase(view, ['ready', 'crashed'], '启动');
      accept(res, { host: view.name, action: 'start' }, () => launcher.start(view.name));
    }],

    ['POST', /^\/api\/hosts\/([^/]+)\/stop$/, (req, res, [name]) => {
      const view = requireHost(decodeURIComponent(name));
      requireManaged(view, '关停');
      requirePhase(view, ['running', 'degraded'], '关停');
      accept(res, { host: view.name, action: 'stop' }, () => launcher.stop(view.name));
    }],

    ['POST', /^\/api\/hosts\/([^/]+)\/restart$/, (req, res, [name]) => {
      const view = requireHost(decodeURIComponent(name));
      requireManaged(view, '重启');
      requirePhase(view, ['running', 'degraded', 'crashed'], '重启');
      accept(res, { host: view.name, action: 'restart' }, () => launcher.restart(view.name));
    }],

    ['POST', /^\/api\/hosts\/([^/]+)\/reconnect$/, (req, res, [name]) => {
      const view = requireHost(decodeURIComponent(name));
      requirePhase(view, ['degraded', 'running'], '重连');
      accept(res, { host: view.name, action: 'reconnect' }, () => tunnel.requestReconnect(view.name));
    }],
  ];

  /** @type {import('node:http').RequestListener & {sseHub:any}} */
  const handler = async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const method = req.method === 'HEAD' ? 'GET' : req.method;

    for (const [m, re, fn] of routes) {
      if (m !== method) continue;
      const match = re.exec(url.pathname);
      if (!match) continue;

      const key = `${m} ${url.pathname.replace(/\/api\/hosts\/[^/]+\//, '/api/hosts/:name/')}`;
      const generic = `${m} ${url.pathname}`;
      if (managerCtl.setupGateActive() && !SETUP_ALLOWED.includes(key) && !SETUP_ALLOWED.includes(generic)) {
        return sendError(res, new DshError('SETUP_REQUIRED', '首次配置尚未完成，该接口暂不可用'));
      }

      try {
        await fn(req, res, match.slice(1), url);
      } catch (err) {
        if (res.headersSent) {
          res.end();
          return;
        }
        sendError(res, err);
      }
      return;
    }

    if (url.pathname.startsWith('/api/')) {
      sendError(res, new DshError('NOT_FOUND', `未知接口 ${method} ${url.pathname}`));
      return;
    }
    // 非 /api/ 前缀交由 server.js 的静态处理器（此处返回 false 语义用 404 兜底）
    sendError(res, new DshError('NOT_FOUND', `未知路径 ${url.pathname}`));
  };

  handler.sseHub = sseHub;
  return handler;
}

export { readJsonBody, sendError, sendJson, sendText, SETUP_ALLOWED, MAX_BODY_BYTES };
