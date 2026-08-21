/**
 * 单一 store 与事件总线（10 §4）。
 *
 * 纪律：本文件不触 DOM、不发请求——只有纯数据变更 + 订阅通知，因此可被 node:test
 * 直接 import（14 §4 的 DOM-free 约定）。组件只能经这里导出的 mutation 改状态。
 */

export const EVENT_BUFFER_LIMIT = 50;
export const TOAST_LIMIT = 4;

/** 各动作的默认超时（10 §4.5）：只解除 loading，绝不擅改 phase。 */
export const ACTION_TIMEOUT_MS = Object.freeze({
  start: 30_000,
  restart: 30_000,
  stop: 20_000,
  reconnect: 20_000,
  probe: 20_000,
  'probe-all': 45_000,
  'manager:restart': 20_000,
  'defaults:save': 20_000,
  'config:save': 20_000,
});

export function pendingKey(action, host = null) {
  return host ? `host:${host}:${action}` : action;
}

function initialState() {
  return {
    manager: { info: null, setupCompleted: null },
    defaults: null,
    hosts: new Map(),
    // 「主机集合已经从后端到过一次」——用来区分「这台不存在」与「还没同步」。
    // 空 Map 本身区分不了这两者，而它们该有的反应完全相反（见 tabbar 的回管理台判据）。
    hostsLoaded: false,
    revision: -1,
    events: [],
    connection: { sse: 'idle', everOpened: false, openedAt: null, lastEventAt: null, resyncing: false },
    route: { kind: 'dashboard', host: null, raw: '#/' },
    pending: new Map(),
    drawer: { open: false, host: null, dirty: false },
    toasts: [],
  };
}

/**
 * @param {object} [preset] 测试用初始片段
 */
export function createStore(preset = {}) {
  const state = { ...initialState(), ...preset };
  /** @type {Map<string, Set<Function>>} */
  const listeners = new Map();
  let seq = 0;

  const on = (type, fn) => {
    const set = listeners.get(type) ?? new Set();
    set.add(fn);
    listeners.set(type, set);
    return () => set.delete(fn);
  };

  const emit = (type, detail) => {
    for (const fn of [...(listeners.get(type) ?? [])]) fn(detail, state);
    for (const fn of [...(listeners.get('*') ?? [])]) fn(type, detail, state);
  };

  // ── manager / defaults ────────────────────────────────────────────────

  const setManagerInfo = (info) => {
    state.manager.info = info;
    state.manager.setupCompleted = info?.setupCompleted ?? null;
    emit('manager:changed', info);
  };

  const setDefaults = (defaults) => {
    state.defaults = defaults ?? null;
    emit('defaults:changed', state.defaults);
  };

  // ── hosts ─────────────────────────────────────────────────────────────

  /** GET /api/hosts 的兜底路径：不覆盖发出请求后到达的更新（10 §4.4 第 3 点）。 */
  const mergeFetchedHosts = (hosts, revision, requestStartedAt) => {
    for (const host of hosts) {
      const known = state.hosts.get(host.name);
      if (known && known.__receivedAt > requestStartedAt) continue;
      state.hosts.set(host.name, stamp(host));
    }
    if (Number.isInteger(revision) && revision > state.revision) state.revision = revision;
    state.hostsLoaded = true;
    emit('hosts:reset', [...state.hosts.keys()]);
  };

  /** snapshot 帧：整体替换（可安全删除已消失的主机，13 §3.1）。 */
  const applySnapshot = (frame) => {
    state.revision = frame.revision;
    state.hosts = new Map(frame.hosts.map((h) => [h.name, stamp(h)]));
    if (frame.manager) setManagerInfo(frame.manager);
    if (frame.defaults !== undefined) setDefaults(frame.defaults);
    if (Array.isArray(frame.logs)) {
      state.events = frame.logs.slice(-EVENT_BUFFER_LIMIT).map(toEvent);
      emit('events:changed', state.events);
    }
    state.connection.resyncing = false;
    state.hostsLoaded = true;
    // 重连后按快照结算在飞的写操作：它们的 operation-done 帧是在页面失联期间发出的，
    // 永远不会再来。不结算的话，那一行的按钮要一直禁到动作超时，末了还多弹一条假的
    // 超时提示——而快照里那台主机明明已经在运行了。
    for (const host of state.hosts.values()) settleByPhase(host);
    emit('hosts:reset', [...state.hosts.keys()]);
    emit('connection:changed', state.connection);
  };

  /** REST 响应回传的 HostView（PUT config 等）：不参与 revision 排序，直接落地。 */
  const upsertHost = (host) => {
    state.hosts.set(host.name, stamp(host));
    emit('hosts:changed', host.name);
    settleByPhase(host);
  };

  /** host-changed 帧：旧 revision 丢弃（13 §3.1 的前端规则）。 */
  const applyHostChanged = (frame) => {
    if (frame.revision <= state.revision) return false;
    state.revision = frame.revision;
    state.hosts.set(frame.host.name, stamp(frame.host));
    emit('hosts:changed', frame.host.name);
    settleByPhase(frame.host);
    return true;
  };

  const applyConfigChanged = (frame) => {
    if (frame.revision > state.revision) state.revision = frame.revision;
    setDefaults(frame.defaults);
    if (frame.manager && state.manager.info) {
      state.manager.info = { ...state.manager.info, ...frame.manager };
      emit('manager:changed', state.manager.info);
    }
  };

  // ── 事件流（环形缓冲 50） ─────────────────────────────────────────────

  const appendEvent = (entry) => {
    state.events.push(toEvent(entry, (seq += 1)));
    if (state.events.length > EVENT_BUFFER_LIMIT) state.events.shift();
    emit('events:changed', state.events);
  };

  const clearEvents = () => {
    state.events = [];
    emit('events:changed', state.events);
  };

  // ── 连接态 ───────────────────────────────────────────────────────────

  const setConnection = (patch) => {
    Object.assign(state.connection, patch);
    if (patch.sse === 'open') {
      state.connection.everOpened = true;
      state.connection.openedAt = Date.now();
    }
    emit('connection:changed', state.connection);
  };

  /**
   * 写操作是否可用（10 §3.2）。禁写只针对「曾连上又断了」——首屏还在建连时不该
   * 把按钮全灰，否则页面刚打开的一瞬什么都点不了。
   */
  const canWrite = () => {
    const { sse, everOpened } = state.connection;
    if (sse === 'open') return true;
    return !everOpened && sse !== 'offline';
  };

  // ── 路由 / 抽屉 ──────────────────────────────────────────────────────

  const setRoute = (route) => {
    state.route = route;
    emit('route:changed', route);
  };

  const setDrawer = (patch) => {
    Object.assign(state.drawer, patch);
    emit('drawer:changed', state.drawer);
  };

  // ── pending（202 + operationId 结算，13 §3.4） ────────────────────────

  const beginPending = ({ action, host = null }) => {
    const key = pendingKey(action, host);
    const entry = {
      key, host, action, operationId: null, status: 'requesting', acceptedAt: Date.now(), timeoutId: null,
    };
    state.pending.set(key, entry);
    emit('pending:changed', key);
    return entry;
  };

  const acceptPending = (key, operationId, onTimeout = null) => {
    const entry = state.pending.get(key);
    if (!entry) return null;
    entry.status = 'accepted';
    entry.operationId = operationId ?? null;
    if (onTimeout) {
      const ms = ACTION_TIMEOUT_MS[entry.action] ?? 30_000;
      entry.timeoutId = setTimeout(() => {
        entry.status = 'timed-out';
        emit('pending:changed', key);
        onTimeout(entry);
        state.pending.delete(key);
        emit('pending:changed', key);
      }, ms);
      // 浏览器里 setTimeout 返回 number（无 unref）；node 单测里 unref 防止 30s 空等
      entry.timeoutId?.unref?.();
    }
    emit('pending:changed', key);
    return entry;
  };

  const settlePending = (key) => {
    const entry = state.pending.get(key);
    if (!entry) return null;
    if (entry.timeoutId) clearTimeout(entry.timeoutId);
    state.pending.delete(key);
    emit('pending:changed', key);
    return entry;
  };

  /** operation-done 帧的精确结算（替代 phase 启发式）。 */
  const settleByOperation = (operationId) => {
    for (const [key, entry] of state.pending) {
      if (entry.operationId === operationId) return settlePending(key);
    }
    return null;
  };

  /** 兜底：动作已到终态而 operation-done 迟到/丢失时也让按钮解锁。 */
  function settleByPhase(host) {
    const terminal = {
      start: ['running'], restart: ['running'], stop: ['ready'], reconnect: ['running'],
    };
    for (const [key, entry] of state.pending) {
      if (entry.host !== host.name) continue;
      if ((terminal[entry.action] ?? []).includes(host.phase)) settlePending(key);
    }
  }

  const isPending = (action, host = null) => state.pending.has(pendingKey(action, host));

  const hostBusy = (name) => {
    for (const entry of state.pending.values()) if (entry.host === name) return true;
    return false;
  };

  // ── toast ────────────────────────────────────────────────────────────

  const addToast = ({ level = 'info', summary, detail = null, timeoutMs = null }) => {
    const last = state.toasts.at(-1);
    if (last && last.summary === summary && last.level === level) {
      last.count += 1;
      emit('toasts:changed', state.toasts);
      return last;
    }
    const toast = { id: (seq += 1), level, summary, detail, count: 1, at: Date.now(), timeoutMs };
    state.toasts.push(toast);
    while (state.toasts.length > TOAST_LIMIT) state.toasts.shift();
    emit('toasts:changed', state.toasts);
    return toast;
  };

  const dismissToast = (id) => {
    state.toasts = state.toasts.filter((t) => t.id !== id);
    emit('toasts:changed', state.toasts);
  };

  return {
    state,
    on,
    emit,
    setManagerInfo,
    setDefaults,
    mergeFetchedHosts,
    applySnapshot,
    upsertHost,
    applyHostChanged,
    applyConfigChanged,
    appendEvent,
    clearEvents,
    setConnection,
    canWrite,
    setRoute,
    setDrawer,
    beginPending,
    acceptPending,
    settlePending,
    settleByOperation,
    isPending,
    hostBusy,
    addToast,
    dismissToast,
    getHost: (name) => state.hosts.get(name) ?? null,
    listHosts: () => [...state.hosts.values()].sort((a, b) => a.name.localeCompare(b.name)),
  };
}

/** 记录本地接收时刻：GET 兜底与 SSE 竞速时用它判新旧（10 §4.4）。 */
function stamp(host) {
  return { ...host, __receivedAt: Date.now() };
}

let eventSeq = 0;

function toEvent(entry, id = (eventSeq += 1)) {
  return {
    id, host: entry.host ?? null, level: entry.level ?? 'info', msg: entry.msg ?? '', ts: entry.ts ?? new Date().toISOString(), detail: entry.detail ?? null,
  };
}
