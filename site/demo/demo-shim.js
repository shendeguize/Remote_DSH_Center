/**
 * 假 manager 的浏览器接线（在线 demo 的唯一「作弊」处）。
 *
 * 产品前端只经两个全局与后端说话：`fetch`（REST）与 `EventSource`（SSE）。
 * 把这两个换掉，src/web/** 一个字节不改就能跑在纯静态的 GitHub Pages 上——
 * 这也是 demo 不会和产品漂移的原因：漂移了 demo 自己就先坏。
 *
 * 路由的 14 个端点与 5 类 SSE 帧形状取自 13_api_schema.md；
 * manager 自身的 restart/shutdown 在浏览器里没有对应物，降级为明确的 409 提示。
 */

import { createFakeManager, DEFAULT_TIMING, FakeApiError } from './demo-manager.js';
import { dispatch } from './demo-routes.js';
import { mountDemoBar } from './demo-bar.js';

/** 假网络延迟：让 loading 态真的看得见（真实动作要 5–10s，这里只留一点手感）。 */
const LATENCY_MS = 90;

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };
const TEXT_HEADERS = { 'content-type': 'text/plain; charset=utf-8' };
const WORKSPACE_REQUEST_PATH_RE = /^\/api\/hosts\/[^/]+\/dsh-workspace(?:\/+)?$/u;

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

function jsonResponse(body, status = 200) {
  return new Response(body === null ? '' : JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function errorResponse(err) {
  const status = err instanceof FakeApiError ? err.status : 500;
  const code = err instanceof FakeApiError ? err.code : 'INTERNAL';
  return jsonResponse({ error: err.message, code, detail: err.detail ?? null }, status);
}

/** fetch 替身：解析 URL → 交给路由表 → 把结果包成 Response。 */
export function createApiRouter(manager, {
  latencyMs = LATENCY_MS,
  baseUrl = globalThis.location?.href ?? 'http://127.0.0.1/',
} = {}) {
  return async function route(input, init = {}) {
    const method = (init.method ?? 'GET').toUpperCase();
    const requestUrl = String(typeof input === 'string' ? input : input.url);
    const queryDelimiter = requestUrl.indexOf('?');
    const fragmentDelimiter = requestUrl.indexOf('#');
    const hasQueryDelimiter = queryDelimiter !== -1
      && (fragmentDelimiter === -1 || queryDelimiter < fragmentDelimiter);
    const url = new URL(requestUrl, baseUrl);
    const workspaceRequest = method === 'POST' && WORKSPACE_REQUEST_PATH_RE.test(url.pathname);
    const rawBody = workspaceRequest && init.body !== null ? init.body : undefined;
    const body = workspaceRequest || init.body === undefined || init.body === null
      ? undefined
      : JSON.parse(init.body);

    await sleep(latencyMs);

    try {
      const res = dispatch(manager, {
        method,
        pathname: url.pathname,
        query: url.searchParams,
        hasQueryDelimiter,
        body,
        rawBody,
      });
      if (res.text !== undefined) return new Response(res.text, { status: res.status, headers: TEXT_HEADERS });
      return jsonResponse(res.json, res.status);
    } catch (err) {
      return errorResponse(err);
    }
  };
}

/** EventSource 替身：只实现 sse.js 用到的那点面（addEventListener / readyState / close）。 */
export function createEventSourceClass(manager) {
  return class DemoEventSource {
    static CONNECTING = 0;

    static OPEN = 1;

    static CLOSED = 2;

    constructor(url) {
      this.url = String(url);
      this.readyState = 0;
      this.handlers = new Map();
      this.unsubscribe = null;
      // 真 EventSource 也不是同步就绪的：留一拍，让 connecting 态真实存在
      setTimeout(() => this.open(), 30);
    }

    open() {
      if (this.readyState === 2) return;
      this.readyState = 1;
      this.fire('open', {});
      this.unsubscribe = manager.subscribe((type, data) => {
        if (this.readyState !== 1) return;
        this.fire(type, { data: JSON.stringify(data) });
      });
    }

    addEventListener(type, fn) {
      const set = this.handlers.get(type) ?? new Set();
      set.add(fn);
      this.handlers.set(type, set);
    }

    removeEventListener(type, fn) {
      this.handlers.get(type)?.delete(fn);
    }

    fire(type, ev) {
      for (const fn of [...(this.handlers.get(type) ?? [])]) fn(ev);
    }

    close() {
      this.readyState = 2;
      this.unsubscribe?.();
      this.unsubscribe = null;
    }
  };
}

/**
 * 装上垫片并挂控制栏。返回 manager 句柄（控制栏与冒烟测试都用它）。
 * 必须在 bootApp() 之前 await 完成。
 */
export async function installDemo({ win = globalThis } = {}) {
  const params = new URLSearchParams(win.location.search);
  const wantSetup = params.has('setup');
  const fast = params.has('fast'); // 冒烟测试用：把演示节奏压到最短

  const timing = fast
    ? {
      ...DEFAULT_TIMING,
      startingMs: 300,
      stopMs: 100,
      restartGapMs: 100,
      reconnectMs: 100,
      reconnectBackoffMs: [150, 150, 150],
      probeScale: 0.1,
      autoStartDelayMs: 100,
    }
    : DEFAULT_TIMING;

  const machine = await import('./lib/machine.js');
  const manager = createFakeManager({ machine, timing, setupCompleted: !wantSetup });

  const originalFetch = win.fetch.bind(win);
  const apiRouter = createApiRouter(manager, { baseUrl: win.location.href });
  win.fetch = (input, init) => {
    const href = typeof input === 'string' ? input : input?.url ?? '';
    let pathname;
    try {
      pathname = new URL(href, win.location.href).pathname;
    } catch {
      pathname = '';
    }
    // 只接管 /api/**，静态资源（mock 页、样式、图标）照原样走网络
    if (!pathname.startsWith('/api/')) return originalFetch(input, init);
    return apiRouter(input, init ?? {});
  };
  win.EventSource = createEventSourceClass(manager);

  mountDemoBar({ manager, win, fast });

  // 冒烟测试与控制栏都从这里拿句柄
  win.__demo = { manager, timing, fast };
  return manager;
}
