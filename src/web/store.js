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
    manager: { info: null, configuredPort: null, setupCompleted: null },
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
  // REST / SSE 跨连接会乱序：hosts/config 各自判旧；state.revision 只保留对外最大值。
  const domainRevisions = { hosts: -1, config: -1 };
  // 初始 config REST 还需按字段补缺，旧 snapshot 可能没有 configuredPort。
  const configRevisions = { defaults: -1, manager: -1 };
  const configEpochs = { defaults: 0, manager: 0 };
  let hostsResetEpoch = 0;
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

  const setManagerConfig = (manager, revision = null) => {
    state.manager.configuredPort = manager?.port ?? null;
    configEpochs.manager += 1;
    if (Number.isInteger(revision)) configRevisions.manager = revision;
    emit('manager-config:changed', state.manager.configuredPort);
  };

  const setDefaults = (defaults, revision = null) => {
    state.defaults = defaults ?? null;
    configEpochs.defaults += 1;
    if (Number.isInteger(revision)) configRevisions.defaults = revision;
    emit('defaults:changed', state.defaults);
  };

  /**
   * 初始 GET /api/config 的兜底路径：只合并请求发出后未变化的配置字段。
   * revision 保留 SSE 来源真相；epoch 同时覆盖本地 REST 写入，不能拿本地写入伪造 revision。
   */
  const captureConfigRevisions = () => ({
    defaults: { revision: configRevisions.defaults, epoch: configEpochs.defaults },
    manager: { revision: configRevisions.manager, epoch: configEpochs.manager },
  });

  const mergeFetchedConfig = (config, requestRevisions) => {
    if (config?.defaults !== undefined
      && configRevisions.defaults <= requestRevisions.defaults.revision
      && configEpochs.defaults === requestRevisions.defaults.epoch) {
      setDefaults(config.defaults);
    }
    if (config?.manager !== undefined
      && configRevisions.manager <= requestRevisions.manager.revision
      && configEpochs.manager === requestRevisions.manager.epoch) {
      setManagerConfig(config.manager);
    }
  };

  // ── hosts ─────────────────────────────────────────────────────────────

  const captureHostMergeGuard = () => ({
    startedAt: performance.now(),
    resetEpoch: hostsResetEpoch,
  });

  /**
   * GET /api/hosts 的兜底路径：不覆盖发出请求后到达的更新（10 §4.4 第 3 点）。
   * @param {number} requestStartedAt 必须是 `performance.now()` 的值——这里要跟
   *   `__receivedAt` 比先后，两边得是同一把尺，且不能被墙钟跳变搅乱（issue #104）
   */
  const mergeFetchedHosts = (hosts, revision, requestStartedAt) => {
    for (const host of hosts) {
      const known = state.hosts.get(host.name);
      if (known && known.__receivedAt > requestStartedAt) continue;
      state.hosts.set(host.name, stamp(host));
    }
    if (Number.isInteger(revision)) {
      domainRevisions.hosts = Math.max(domainRevisions.hosts, revision);
      state.revision = Math.max(state.revision, revision);
    }
    state.hostsLoaded = true;
    emit('hosts:reset', [...state.hosts.keys()]);
  };

  /**
   * 写操作响应里的 HostView 是 SSE 丢失时的兜底：请求后若到过完整 snapshot，则整批
   * 响应作废；否则逐主机保护更晚 SSE。响应没有 revision，故绝不推进 domain revision。
   */
  const mergeActionHosts = (hosts, requestGuard) => {
    const resetAfterRequest = hostsResetEpoch !== requestGuard.resetEpoch;
    if (resetAfterRequest) return;
    for (const host of hosts) {
      const known = state.hosts.get(host.name);
      if (known && known.__receivedAt > requestGuard.startedAt) continue;
      state.hosts.set(host.name, stamp(host));
      emit('hosts:changed', host.name);
      settleByPhase(host);
    }
  };

  /** snapshot 帧：整体替换（可安全删除已消失的主机，13 §3.1）。 */
  const applySnapshot = (frame) => {
    state.revision = frame.revision;
    domainRevisions.hosts = frame.revision;
    domainRevisions.config = frame.revision;
    hostsResetEpoch += 1;
    state.hosts = new Map(frame.hosts.map((h) => [h.name, stamp(h)]));
    const hasManager = frame.manager != null;
    const hasConfiguredPort = Object.hasOwn(frame, 'configuredPort');
    // 先同时落状态再通知：订阅任一 manager 事件的组件都不能看到 runtime 已新、
    // configuredPort 仍旧的半帧状态。旧后端没有 configuredPort 时保留已知值。
    if (hasManager) {
      state.manager.info = frame.manager;
      state.manager.setupCompleted = frame.manager.setupCompleted ?? null;
    }
    if (hasConfiguredPort) {
      state.manager.configuredPort = frame.configuredPort ?? null;
      configEpochs.manager += 1;
      configRevisions.manager = frame.revision;
    }
    if (hasManager) emit('manager:changed', frame.manager);
    if (hasConfiguredPort) emit('manager-config:changed', state.manager.configuredPort);
    if (frame.defaults !== undefined) setDefaults(frame.defaults, frame.revision);
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

  /** 清理 orphaned / 已屏蔽响应的前端镜像；只删除当前确实带着该标记的条目。 */
  const removeHosts = (names) => {
    const removed = [];
    for (const name of names ?? []) {
      const host = state.hosts.get(name);
      if ((!host?.orphaned && !host?.blocked) || host.local) continue;
      state.hosts.delete(name);
      removed.push(name);
    }
    if (removed.length > 0) {
      hostsResetEpoch += 1;
      emit('hosts:reset', [...state.hosts.keys()]);
    }
    return removed;
  };

  /** host-changed 帧：旧 revision 丢弃（13 §3.1 的前端规则）。 */
  const applyHostChanged = (frame) => {
    if (frame.revision <= domainRevisions.hosts) return false;
    domainRevisions.hosts = frame.revision;
    state.revision = Math.max(state.revision, frame.revision);
    state.hosts.set(frame.host.name, stamp(frame.host));
    emit('hosts:changed', frame.host.name);
    settleByPhase(frame.host);
    return true;
  };

  const applyConfigChanged = (frame) => {
    if (frame.revision <= domainRevisions.config) return false;
    domainRevisions.config = frame.revision;
    state.revision = Math.max(state.revision, frame.revision);
    if (frame.defaults !== undefined) setDefaults(frame.defaults, frame.revision);
    if (frame.manager !== undefined) setManagerConfig(frame.manager, frame.revision);
    return true;
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
   * 把按钮全灰，否则页面刚打开的一瞬什么都点不了。重连后必须等全量 snapshot
   * 清掉 resyncing，旧页面状态尚未校准时不能提前放开写操作。
   */
  const canWrite = () => {
    const { sse, everOpened, resyncing } = state.connection;
    if (sse === 'open') return !resyncing;
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
      start: ['running'], restart: ['running'], stop: ['ready'], reconnect: ['running'], adopt: ['running'],
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
    setManagerConfig,
    setDefaults,
    captureConfigRevisions,
    mergeFetchedConfig,
    captureHostMergeGuard,
    mergeFetchedHosts,
    mergeActionHosts,
    applySnapshot,
    upsertHost,
    removeHosts,
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
  return { ...host, __receivedAt: performance.now() }; // 单调钟：只与 requestStartedAt 比先后（#104）
}

let eventSeq = 0;

function toEvent(entry, id = (eventSeq += 1)) {
  return {
    id, host: entry.host ?? null, level: entry.level ?? 'info', msg: entry.msg ?? '', ts: entry.ts ?? new Date().toISOString(), detail: entry.detail ?? null,
  };
}
