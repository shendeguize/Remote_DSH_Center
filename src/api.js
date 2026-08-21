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
import { bus, emitOperationDone, logEvent, recentLogs } from './lib/bus.js';
import { assertValid, defaultsPatchSchema, hostConfigPatchSchema, setupBodySchema } from './lib/validate.js';
import * as launcher from './launcher.js';
import * as prober from './prober.js';
import * as store from './store.js';
import * as tunnel from './tunnel.js';

const MAX_BODY_BYTES = 1_048_576;
/**
 * 超限之后还愿意替对面读完的上限（issue #89）。
 * 超一点点多半是「值填大了」，读完再回 400，对面能看到那句人话；
 * 超到这个量级就是在灌了，直接掐——排空不是义务。
 */
const MAX_DRAIN_BYTES = 4 * MAX_BODY_BYTES;
const SSE_HEARTBEAT_MS = 25_000;

/**
 * 一条 SSE 连接的积压上限。客户端不读的时候（标签被系统冻结、笔记本合盖、网络黑洞），
 * `res.write` 只能把帧堆在内存里——manager 是常驻进程，堆着堆着就涨到几个 G，而没人
 * 会想到是「那个后台标签没在读」。实测：一个不读的客户端 + 20000 条 1KB 日志 = 堆从
 * 8MB 涨到 56MB，线性且 GC 收不回（无客户端的对照组恒定 8MB）。
 *
 * 判据是「**一直**积压」，不是「这一下超线」：日志本来就成串来，一个读得很正常的
 * 客户端也可能在一个 tick 里被灌进几 MB，然后几毫秒内就排空。只按瞬时值踢会误伤它。
 * 所以软线（超了开始计时）+ 宽限期（期间排空就一笔勾销）+ 硬顶（再离谱也不许过）。
 *
 * 踢掉是安全的：页面本来就有断线重连，重连首帧是完整 snapshot，状态照样对得上。
 */
const SSE_BACKLOG_SOFT_BYTES = 4_194_304;
const SSE_BACKLOG_HARD_BYTES = 33_554_432;
const SSE_BACKLOG_GRACE_MS = 3_000;

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
    let over = false;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_DRAIN_BYTES) {
        // 排空也得有个头：一直读下去，对面每传 64MB 我们就得吃 64MB 的临时缓冲，
        // 常驻进程的 RSS 会被这么顶上去。到这个量级已经不像「不小心传大了」，掐掉。
        reject(new DshError('VALIDATION', `请求体超过 ${MAX_BODY_BYTES} 字节上限`));
        req.destroy();
        return;
      }
      if (over) return; // 超了就一路丢弃：不攒内存，但也不掐连接
      if (size > MAX_BODY_BYTES) {
        over = true;
        chunks.length = 0; // 已经攒的立刻扔掉，超限的体一个字节也不留在内存里
        return;
      }
      chunks.push(c);
    });
    req.on('error', reject);
    req.on('end', () => {
      // 等它传完再回话。半路 destroy 或半路回话都会让对面拿到 ECONNRESET/EPIPE，
      // 只看到「网络错误」而不知道是体太大（issue #89）。
      if (over) {
        reject(new DshError('VALIDATION', `请求体超过 ${MAX_BODY_BYTES} 字节上限`));
        return;
      }
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

  /** 本轮广播里被踢掉的连接，攒到广播结束再收尾（免得在 for…of 里边改边遍历）。 */
  const dropped = [];

  /** 超了软线的连接：记一个宽限期结束后的复查定时器。排空即撤。 */
  const recheck = new Map();

  const kick = (res) => {
    clients.delete(res);
    clearTimeout(recheck.get(res));
    recheck.delete(res);
    dropped.push(res);
  };

  /**
   * 写一帧，顺手判这条连接是不是已经积压得不像话了；是就踢掉。
   *
   * 量的是 `writableLength`（还没交给内核的字节数），不是 `write()` 的返回值：
   * 返回 false 只说明「这一下超过了 highWaterMark」，读得好好的客户端也常有。
   *
   * 超软线不当场踢，而是挂一次复查——洪峰可能打完就静默，光靠「下一帧再看」会一直
   * 等不到那一帧（心跳 25s 才来一次，这期间那几 MB 就白占着）。
   */
  const push = (res, frame) => {
    res.write(frame);
    const backlog = res.writableLength ?? 0;
    if (backlog >= SSE_BACKLOG_HARD_BYTES) {
      kick(res);
      return;
    }
    if (backlog <= SSE_BACKLOG_SOFT_BYTES) {
      // 排空了，之前那次超线一笔勾销
      clearTimeout(recheck.get(res));
      recheck.delete(res);
      return;
    }
    if (recheck.has(res)) return;
    const timer = setTimeout(() => {
      recheck.delete(res);
      if (!clients.has(res)) return;
      if ((res.writableLength ?? 0) <= SSE_BACKLOG_SOFT_BYTES) return;
      kick(res);
      reapDropped();
    }, SSE_BACKLOG_GRACE_MS);
    timer.unref?.();
    recheck.set(res, timer);
  };

  const reapDropped = () => {
    if (dropped.length === 0) return;
    const n = dropped.length;
    for (const res of dropped.splice(0)) {
      try {
        res.destroy();
      } catch {
        // 已经断了
      }
    }
    // 这行日志本身又要广播一次（log-line）。此时被踢的连接已经不在名单里，
    // 递归只会多走一层就停，且那一层没有可踢的对象。
    logEvent(null, 'warn', `${n} 个页面连接积压过多（不在读），已断开；它们会自行重连并重新同步`);
  };

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
    for (const res of clients) push(res, frame);
    reapDropped();
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
    for (const res of clients) push(res, ':hb\n\n');
    reapDropped();
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
        clearTimeout(recheck.get(res));
        recheck.delete(res);
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
      for (const timer of recheck.values()) clearTimeout(timer);
      recheck.clear();
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

/**
 * 「这个动作只对本 manager 拉起的实例生效」。
 *
 * 两种落空要分开说（issue #98）：远端确实有个不是我们拉的实例，和远端上压根什么都没有。
 * 揉成一句「不动手动实例」，会让一台根本没在跑的主机也收到这句话——把人往
 * 「是不是有个我不知道的进程」上引，而真相只是「它没在跑」。
 */
function requireManaged(view, action) {
  if (view.web?.startedByUs === true) return;
  if ((view.manualInstances?.length ?? 0) > 0 || view.web) {
    throw new DshError('NOT_ALLOWED', `${action} 不动手动实例：${view.name} 上跑的不是本 manager 拉起的`, { host: view.name });
  }
  throw new DshError('NOT_ALLOWED', `${view.name} 上没有本 manager 拉起的实例，无从${action}`, { host: view.name });
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

    ['POST', /^\/api\/reload$/, async (req, res) => {
      const result = store.reloadConfig();
      // 这一趟可能把某台主机从配置里去掉了。它的隧道此刻既看不见也停不掉，
      // 只能由 manager 自己收（issue #96）。
      await tunnel.closeUnconfigured();
      sendJson(res, 200, result);
    }],

    ['POST', /^\/api\/setup$/, async (req, res) => {
      const body = await readJsonBody(req);
      assertValid(setupBodySchema, body, '初始化配置校验失败');
      const result = await managerCtl.applySetup(body);
      await tunnel.closeUnconfigured(); // setup 是整份替换，同上
      sendJson(res, 200, result);
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
