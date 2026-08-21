/**
 * 整机挂载用的公共脚手架（TST-06）：DOM 垫片 + 假 fetch + 假 EventSource。
 *
 * 抽出来是为了让「管理台」与「首启向导」两组挂载用例共用同一套假后端，
 * 避免两处 fixture 各自漂移出不同的契约。
 */

import { installDom } from './dom-shim.js';

export const MANAGER_INFO = {
  version: '0.1.0',
  pid: 4242,
  mode: 'background',
  port: 7788,
  uptimeMs: 65_000,
  setupCompleted: true,
  hostCounts: { total: 2, running: 1, degraded: 0, crashed: 0 },
};

export const DEFAULTS = { remoteWebPort: 8899, localPortRange: [17_701, 17_799] };

export function hostView(name, patch = {}) {
  return {
    name,
    enabled: true,
    orphaned: false,
    config: {
      enabled: true, autoStart: false, localPort: null, remoteWebPort: null, workdir: null, inject: { env: {}, extraArgs: [], patches: [] },
    },
    phase: 'ready',
    effectiveRemotePort: 8899,
    mappedUrl: null,
    probe: { dshPath: '/usr/bin/dsh', version: '0.1.0-rc.7', profileWeb: true, dshHome: '/home/me/.dsh', at: new Date().toISOString(), noDshReason: null, errorSummary: null },
    web: null,
    tunnel: null,
    manualInstances: [],
    sshInfo: { user: 'me', hostName: '10.0.0.1', port: 22 },
    ...patch,
  };
}

export const running = (name) => hostView(name, {
  phase: 'running',
  mappedUrl: 'http://127.0.0.1:17701/',
  web: {
    pid: 999, port: 8899, startedByUs: true, startedAt: new Date().toISOString(), workdir: null,
  },
  tunnel: { localPort: 17_701, reconnectAttempt: 0, suspendedReason: null },
  config: {
    enabled: true, autoStart: true, localPort: 17_701, remoteWebPort: null, workdir: null, inject: { env: {}, extraArgs: [], patches: [] },
  },
});

/** 假 EventSource：测试自己决定何时 open / 发帧。 */
export class FakeEventSource {
  static last = null;

  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.listeners = new Map();
    FakeEventSource.last = this;
  }

  addEventListener(type, fn) {
    const set = this.listeners.get(type) ?? new Set();
    set.add(fn);
    this.listeners.set(type, set);
  }

  open() {
    this.readyState = 1;
    for (const fn of this.listeners.get('open') ?? []) fn({});
  }

  /**
   * 帧名打错会静默无事发生——前端只监听自己认得的那几种，别的一律没人接。
   * 于是用例里一个 `host:changed`（真名是 `host-changed`）就能让整条断言空转，
   * 而它照样是绿的。所以这里对没人监听的帧名直接抛。
   */
  send(type, data) {
    const fns = this.listeners.get(type);
    if (!fns || fns.size === 0) {
      throw new Error(`没人监听 SSE 帧「${type}」——帧名打错了？现有：${[...this.listeners.keys()].join(', ')}`);
    }
    for (const fn of fns) fn({ data: JSON.stringify(data) });
  }

  close() {
    this.readyState = 2;
  }
}

/** 让 boot 里的 await 链跑完。 */
export const flush = () => new Promise((r) => { setTimeout(r, 0); });

/**
 * @param {object} t node:test 的 TestContext（负责收尾还原全局）
 * @param {{hosts?:object[], responder?:Function, hash?:string, info?:object}} [opts]
 */
export async function mount(t, {
  hosts = [hostView('gpu-1'), hostView('gpu-2')], responder = null, hash = null, info = MANAGER_INFO,
} = {}) {
  const dom = installDom();
  if (hash) dom.window.location.hash = hash;
  const calls = [];

  const savedFetch = globalThis.fetch;
  const savedES = globalThis.EventSource;
  FakeEventSource.last = null; // 静态字段会跨用例串味
  globalThis.EventSource = FakeEventSource;
  globalThis.fetch = async (path, init = {}) => {
    const method = init.method ?? 'GET';
    calls.push({ path, method, body: init.body ? JSON.parse(init.body) : null });
    const custom = responder?.({ path, method, body: init.body ? JSON.parse(init.body) : null });
    if (custom) return custom;
    const body = {
      '/api/manager/info': info,
      '/api/hosts': { revision: 1, hosts },
      '/api/config': {
        configVersion: 1, setupCompleted: info.setupCompleted, manager: { port: info.port }, defaults: DEFAULTS, hosts: {},
      },
    }[path] ?? { accepted: true, operationId: 'op-1' };
    return { ok: true, status: path.startsWith('/api/hosts/') && method === 'POST' ? 202 : 200, text: async () => JSON.stringify(body) };
  };

  const { bootApp } = await import('../../src/web/app.js');
  const app = bootApp();
  await flush();

  t.after(() => {
    app.destroy();
    globalThis.fetch = savedFetch;
    if (savedES === undefined) delete globalThis.EventSource;
    else globalThis.EventSource = savedES;
    dom.restore();
  });

  return { app, dom, calls, es: () => FakeEventSource.last };
}

/** 便捷选择器：按可见文本找按钮。 */
export function findButton(scope, label) {
  return scope.querySelectorAll('.btn').find((b) => b.textContent.trim() === label) ?? null;
}
