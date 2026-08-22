/**
 * 浏览器内的假 manager（在线 demo 的后端）。
 *
 * 它按 13_api_schema.md 说话：同样的 HostView、同样的 202 受理体、同样的五类 SSE 帧。
 * 状态迁移交给**产品真身** src/lib/machine.js 裁决（经 `machine` 注入），
 * 所以 demo 里走不通的路径在真实环境里也走不通——这是 demo 可信的根据。
 *
 * 硬约束：除同目录的 demo-data.js 外零 import，不碰 DOM、不碰 node API。
 * 于是浏览器能直接跑它，node:test 也能直接 import 它做契约校验。
 */

import { DEMO_DEFAULTS, DEMO_HOSTS, DEMO_MANAGER, SEED_AGE_MS, fakeLog, probeView } from './demo-data.js';

/** 演示节奏（真实动作要 5–10s，压缩到看得下去的长度）。测试里全调成 1ms。 */
export const DEFAULT_TIMING = Object.freeze({
  probeMs: 600,
  // 种子数据里每台主机的探测快慢不同（演示「慢主机不挡着你勾选」），
  // 这个系数统一缩放它们——测试与冒烟把它调到近 0，不用真等 2.7 秒
  probeScale: 1,
  startingMs: 2_000,
  stopMs: 600,
  restartGapMs: 500,
  reconnectMs: 700,
  reconnectBackoffMs: Object.freeze([1_000, 2_000, 4_000]),
  reconnectSuccessAt: 3,
  autoStartDelayMs: 900,
});

export class FakeApiError extends Error {
  constructor(status, code, message, detail = null) {
    super(message);
    this.name = 'FakeApiError';
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

const iso = (ms) => new Date(ms).toISOString();

function uuid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  // 非安全上下文（http:// 非环回）里 randomUUID 不存在，退回手搓 v4
  const hex = [...Array(32)].map(() => Math.floor(Math.random() * 16).toString(16));
  hex[12] = '4';
  hex[16] = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const s = hex.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

const clone = (v) => structuredClone(v);

const LOG_LIMIT = 50;
const DEFAULT_LOCAL_NAME = 'local-host';
const SAFE_HOST_RE = /^[A-Za-z0-9._-]+$/;

/**
 * @param {{
 *   machine: {assertTransition:Function, canTransition:Function},
 *   timing?: object,
 *   setupCompleted?: boolean,
 *   mockUrl?: (name:string, port:number)=>string,
 *   now?: ()=>number,
 *   schedule?: (fn:Function, ms:number)=>any,
 *   cancel?: (handle:any)=>void,
 * }} deps
 */
export function createFakeManager({
  machine,
  timing = DEFAULT_TIMING,
  setupCompleted = true,
  // iframe 的 src 就是这个值：站内同源假页面，路径相对 /demo/ 上一级
  mockUrl = (name, port) => `../mock-dsh-web/index.html?host=${encodeURIComponent(name)}&port=${port}`,
  now = () => Date.now(),
  schedule = (fn, ms) => setTimeout(fn, ms),
  cancel = (handle) => clearTimeout(handle),
} = {}) {
  const listeners = new Set();
  /** @type {Map<string, object>} name → HostView（对外一律深拷贝） */
  const hosts = new Map();
  /** @type {Map<string, {gen:number, seed:object}>} 私有元信息：不能混进 HostView，会污染契约 */
  const meta = new Map();
  const pendingTimers = new Set();

  let revision = 0;
  let logs = [];
  let config = null;
  let startedAt = now();
  let gateOpen = setupCompleted;
  let nextPid = 61_000;

  // ── 基础设施 ──────────────────────────────────────────────────────────

  const bump = () => (revision += 1);

  function emit(type, data) {
    for (const fn of [...listeners]) fn(type, data);
  }

  function timer(fn, ms) {
    const handle = schedule(() => {
      pendingTimers.delete(handle);
      fn();
    }, ms);
    pendingTimers.add(handle);
    return handle;
  }

  function clearTimers() {
    for (const handle of pendingTimers) cancel(handle);
    pendingTimers.clear();
  }

  /** 单台主机的「世代」：任何抢占式变更都 +1，让在飞的定时回调自己失效。 */
  function gen(name) {
    return meta.get(name)?.gen ?? 0;
  }

  function bumpGen(name) {
    const m = meta.get(name);
    if (m) m.gen += 1;
    return gen(name);
  }

  function pushLog({ host = null, level = 'info', msg, detail = null, ageMs = 0 }) {
    const entry = { host, level, msg, detail, ts: iso(now() - ageMs) };
    logs.push(entry);
    if (logs.length > LOG_LIMIT) logs.shift();
    emit('log-line', { revision: bump(), ...entry });
  }

  function emitHost(name) {
    const host = hosts.get(name);
    if (!host) return;
    emit('host-changed', { revision: bump(), host: clone(host) });
  }

  function setPhase(name, to, cause) {
    const host = hosts.get(name);
    machine.assertTransition(host.phase, to, cause);
    host.phase = to;
  }

  function need(name) {
    const host = hosts.get(name);
    if (!host) throw new FakeApiError(404, 'NOT_FOUND', `主机 ${name} 不存在`);
    return host;
  }

  function gate() {
    if (!gateOpen) throw new FakeApiError(409, 'SETUP_REQUIRED', '尚未完成初始化');
  }

  const accept = (action, host = null) => {
    const operationId = uuid();
    return { operationId, body: { accepted: true, operationId, host } };
  };

  function finish(operationId, { host = null, action, status = 'ok', error = null, code = null, detail = null }) {
    emit('operation-done', {
      revision: bump(), operationId, host, action, status, error, code, detail,
    });
  }

  // ── 端口分配（区间内取第一个没被占的，占了就固定） ───────────────────

  function allocateLocalPort(name) {
    const host = hosts.get(name);
    if (host.config.localPort !== null) return host.config.localPort;
    const [from, to] = config.defaults.localPortRange;
    const taken = new Set([...hosts.values()].map((h) => h.config.localPort).filter((p) => p !== null));
    for (let p = from; p <= to; p += 1) {
      if (!taken.has(p)) {
        host.config.localPort = p;
        config.hosts[name].localPort = p;
        return p;
      }
    }
    throw new FakeApiError(503, 'PORT_EXHAUSTED', '本机映射端口区间已用尽');
  }

  // ── 主机视图装配 ──────────────────────────────────────────────────────

  const seedOf = (name) => meta.get(name)?.seed;

  const probeDelay = (seed) => Math.max(
    1,
    Math.round((seed.probeDelayMs ?? timing.probeMs) * (timing.probeScale ?? 1)),
  );

  const localSeed = (name) => ({
    name,
    local: true,
    sshInfo: null,
    probeResult: 'ready',
    dsh: { dshPath: '/usr/local/bin/dsh', version: '0.1.0-rc.7', dshHome: '/Users/demo/.dsh' },
    autoStart: false,
    localPort: null,
    remoteWebPort: null,
    workdir: null,
    pid: null,
    probeDelayMs: timing.probeMs,
    manualInstances: [],
  });

  function attachRunning(host, seed, { ageMs = 0 } = {}) {
    const localPort = host.local ? host.effectiveRemotePort : allocateLocalPort(host.name);
    const remotePort = host.effectiveRemotePort;
    host.web = {
      pid: seed.pid ?? (nextPid += 1),
      port: remotePort,
      startedByUs: true,
      cmdFingerprint: `dsh web --no-open --host 127.0.0.1 --port ${remotePort}`,
      log: `web-${remotePort}.log`,
      startedAt: iso(now() - ageMs),
      workdir: host.config.workdir,
      cwd: host.config.workdir
        ? host.config.workdir.replace(/^~/, host.local ? '/Users/demo' : `/home/${host.sshInfo.user}`)
        : null,
    };
    host.tunnel = { localPort, connected: true, reconnectAttempt: 0, suspendedReason: null };
    host.mappedUrl = mockUrl(host.name, localPort);
  }

  function buildHost(seed, phase, { persistConfig = true } = {}) {
    const at = iso(now() - SEED_AGE_MS.probe);
    const local = seed.local === true;
    const hostConfig = {
      local,
      enabled: true,
      autoStart: seed.autoStart,
      localPort: seed.localPort,
      remoteWebPort: seed.remoteWebPort,
      workdir: seed.workdir,
      inject: seed.inject ? clone(seed.inject) : { env: {}, extraArgs: [], patches: [] },
    };
    const host = {
      name: seed.name,
      local,
      sshInfo: local ? null : { ...seed.sshInfo },
      orphaned: false,
      config: hostConfig,
      phase,
      effectiveRemotePort: hostConfig.remoteWebPort ?? config.defaults.remoteWebPort,
      mappedUrl: null,
      probe: phase === 'unknown' ? null : probeView(seed, at),
      web: null,
      tunnel: null,
      patchSync: { files: seed.patchSync ? clone(seed.patchSync) : {} },
      manualInstances: seed.manualInstances.map((i) => ({ ...i })),
    };
    hosts.set(seed.name, host);
    meta.set(seed.name, { gen: 0, seed });
    if (persistConfig) config.hosts[seed.name] = clone(hostConfig);
    if (phase === 'running') attachRunning(host, seed, { ageMs: SEED_AGE_MS.web });
    return host;
  }

  /**
   * 回到初始态。`mode: 'setup'` 时所有主机置 unknown 且关掉门禁，
   * 用来演示首启引导（页面会被 setup 守卫强制送到 #/setup）。
   */
  function reset({ mode = 'dashboard' } = {}) {
    clearTimers();
    hosts.clear();
    meta.clear();
    logs = [];
    revision = 0;
    startedAt = now() - SEED_AGE_MS.manager;
    gateOpen = mode !== 'setup';
    nextPid = 61_000;

    config = {
      configVersion: 1,
      setupCompleted: gateOpen,
      manager: { port: DEMO_MANAGER.port },
      defaults: clone(DEMO_DEFAULTS),
      hosts: {},
    };

    for (const seed of DEMO_HOSTS) {
      buildHost(seed, mode === 'setup' ? 'unknown' : seed.initial);
    }

    if (mode === 'setup') {
      // 与产品 server 一致：setup 额外暴露恰好一台只驻内存的本机候选。
      // 它会随 POST /api/setup 被选入 config，但普通已完成 demo 不凭空追加。
      buildHost(localSeed(DEFAULT_LOCAL_NAME), 'unknown', { persistConfig: false });
      // 引导态下不预设分配好的端口，一切由向导落盘后再来
      for (const host of hosts.values()) {
        host.config.localPort = null;
        host.config.autoStart = false;
        const saved = config.hosts[host.name];
        if (saved) {
          saved.localPort = null;
          saved.autoStart = false;
        }
      }
    } else {
      pushLog({
        level: 'info',
        msg: `manager 已启动，监听 127.0.0.1:${config.manager.port}`,
        ageMs: SEED_AGE_MS.manager,
      });
      for (const host of hosts.values()) {
        if (host.phase === 'running') {
          pushLog({
            host: host.name,
            level: 'info',
            msg: `隧道已建立：本机 ${host.tunnel.localPort} ⇆ 远端 ${host.web.port}`,
            ageMs: SEED_AGE_MS.web,
          });
        }
      }
      pushLog({ host: 'gpu-a100', level: 'info', msg: '巡检通过：转发通道有响应，远端进程存活', ageMs: 26_000 });
    }
    emitSnapshot();
  }

  // ── 读接口 ────────────────────────────────────────────────────────────

  function managerInfo() {
    const counts = { total: hosts.size, running: 0, degraded: 0, crashed: 0 };
    for (const h of hosts.values()) {
      if (h.phase in counts) counts[h.phase] += 1;
    }
    return {
      version: DEMO_MANAGER.version,
      pid: DEMO_MANAGER.pid,
      port: config.manager.port,
      mode: DEMO_MANAGER.mode,
      startedAt: iso(startedAt),
      uptimeMs: Math.max(0, now() - startedAt),
      setupCompleted: gateOpen,
      setupGateActive: !gateOpen,
      hostCounts: counts,
      revision,
    };
  }

  const listHosts = () => [...hosts.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((h) => clone(h));

  function emitSnapshot() {
    emit('snapshot', {
      revision,
      manager: managerInfo(),
      defaults: clone(config.defaults),
      hosts: listHosts(),
      logs: logs.map((l) => ({ ...l })),
    });
  }

  // ── 长动作 ────────────────────────────────────────────────────────────

  function doProbe(name, operationId) {
    const seed = seedOf(name);
    const host = need(name);
    const myGen = bumpGen(name);
    timer(() => {
      if (gen(name) !== myGen || !hosts.has(name)) return;
      host.probe = probeView(seed, iso(now()));
      // 探测不得改写在跑的主机（11 §2.2）：只刷新探测信息
      if (!['starting', 'running', 'degraded'].includes(host.phase)) {
        setPhase(name, seed.probeResult, 'probe');
      }
      host.manualInstances = seed.manualInstances.map((i) => ({ ...i }));
      pushLog({
        host: name,
        level: seed.probeResult === 'ready' ? 'info' : 'warn',
        msg: `探测完成：${seed.probeResult}`,
        detail: seed.probeResult === 'unreachable' ? host.probe.errorSummary : null,
      });
      emitHost(name);
      if (operationId) finish(operationId, { host: name, action: 'probe' });
    }, probeDelay(seed));
  }

  function doStart(name, operationId, { action = 'start' } = {}) {
    const seed = seedOf(name);
    const host = need(name);
    setPhase(name, 'starting', action);
    host.mappedUrl = null;
    pushLog({ host: name, level: 'info', msg: `拉起远端 dsh web（端口 ${host.effectiveRemotePort}）` });
    emitHost(name);

    const myGen = bumpGen(name);
    timer(() => {
      if (gen(name) !== myGen || !hosts.has(name)) return;
      setPhase(name, 'running', action);
      attachRunning(host, seed);
      pushLog({ host: name, level: 'info', msg: `已就绪：PID ${host.web.pid}，本机 ${host.tunnel.localPort} ⇆ 远端 ${host.web.port}` });
      emitHost(name);
      if (operationId) finish(operationId, { host: name, action });
    }, timing.startingMs);
  }

  function doStop(name, operationId, { action = 'stop', then = null } = {}) {
    const host = need(name);
    const myGen = bumpGen(name);
    const pid = host.web?.pid;
    timer(() => {
      if (gen(name) !== myGen || !hosts.has(name)) return;
      setPhase(name, 'ready', action);
      host.web = null;
      host.tunnel = null;
      host.mappedUrl = null;
      pushLog({ host: name, level: 'info', msg: `已关停远端进程 ${pid}（指纹校验通过）` });
      emitHost(name);
      if (then) then();
      else if (operationId) finish(operationId, { host: name, action });
    }, timing.stopMs);
  }

  function scheduleReconnect(name, attempt) {
    const delays = timing.reconnectBackoffMs;
    const wait = delays[Math.min(attempt - 1, delays.length - 1)];
    const myGen = gen(name);
    timer(() => {
      const host = hosts.get(name);
      if (!host || gen(name) !== myGen || host.phase !== 'degraded') return;
      host.tunnel.reconnectAttempt = attempt;
      if (attempt >= timing.reconnectSuccessAt) {
        setPhase(name, 'running', 'reconnect');
        host.tunnel.connected = true;
        host.tunnel.reconnectAttempt = 0;
        host.mappedUrl = mockUrl(name, host.tunnel.localPort);
        pushLog({ host: name, level: 'info', msg: `隧道已重连（第 ${attempt} 次尝试）` });
        emitHost(name);
        return;
      }
      pushLog({ host: name, level: 'warn', msg: `隧道重连第 ${attempt} 次失败，继续退避` });
      emitHost(name);
      scheduleReconnect(name, attempt + 1);
    }, wait);
  }

  // ── 对外 API（形状与 13 §2 对齐） ──────────────────────────────────────

  function createLocalHost(requestedName) {
    gate();
    const name = requestedName ?? DEFAULT_LOCAL_NAME;
    if (typeof name !== 'string' || !SAFE_HOST_RE.test(name) || name.startsWith('-')) {
      throw new FakeApiError(400, 'VALIDATION', '本机主机名须由字母、数字、点、下划线或连字符组成，且不以 - 开头');
    }
    if ([...hosts.values()].some((host) => host.local)) {
      throw new FakeApiError(409, 'LOCAL_HOST_EXISTS', '已经存在本机主机，不能重复添加');
    }
    if (hosts.has(name)) {
      throw new FakeApiError(409, 'LOCAL_NAME_CONFLICT', `本机名称 ${name} 已被现有主机使用`);
    }

    const seed = localSeed(name);
    const host = buildHost(seed, 'unknown');
    pushLog({ host: name, level: 'info', msg: `已添加本机 ${name}` });
    emitHost(name);
    return { host: clone(host) };
  }

  function probeAll() {
    const { operationId, body } = accept('probe-all');
    pushLog({ level: 'info', msg: `开始全量探测（${hosts.size} 台）` });
    for (const name of hosts.keys()) doProbe(name, null);
    // 汇总回执要等最慢那台落地：13 §3.4 要求每个 202 恰好一条 operation-done
    const slowest = Math.max(...[...hosts.keys()].map((name) => probeDelay(seedOf(name))));
    timer(() => finish(operationId, { host: null, action: 'probe-all' }), slowest + 20);
    return body;
  }

  function probeHost(name) {
    need(name);
    const { operationId, body } = accept('probe', name);
    doProbe(name, operationId);
    return body;
  }

  function startHost(name) {
    gate();
    const host = need(name);
    if (!host.config.enabled) throw new FakeApiError(403, 'NOT_ALLOWED', `${name} 未纳管`);
    if (!['ready', 'crashed'].includes(host.phase)) {
      throw new FakeApiError(409, 'PHASE_CONFLICT', `${name} 当前状态「${host.phase}」不能拉起`);
    }
    const { operationId, body } = accept('start', name);
    doStart(name, operationId);
    return body;
  }

  function stopHost(name) {
    gate();
    const host = need(name);
    if (!host.web?.startedByUs) throw new FakeApiError(403, 'NOT_ALLOWED', `${name} 上的进程不是本工具拉起的，拒绝关停`);
    if (!['running', 'degraded'].includes(host.phase)) {
      throw new FakeApiError(409, 'PHASE_CONFLICT', `${name} 当前状态「${host.phase}」不能关停`);
    }
    const { operationId, body } = accept('stop', name);
    doStop(name, operationId);
    return body;
  }

  function restartHost(name) {
    gate();
    const host = need(name);
    if (!host.web?.startedByUs) throw new FakeApiError(403, 'NOT_ALLOWED', `${name} 上的进程不是本工具拉起的，拒绝重启`);
    if (!['running', 'degraded', 'crashed'].includes(host.phase)) {
      throw new FakeApiError(409, 'PHASE_CONFLICT', `${name} 当前状态「${host.phase}」不能重启`);
    }
    const { operationId, body } = accept('restart', name);
    // running 不能直接回 starting（状态机不许）：先关停到 ready，再拉起
    if (host.phase === 'crashed') {
      doStart(name, operationId, { action: 'restart' });
    } else {
      doStop(name, null, {
        action: 'restart',
        then: () => timer(() => doStart(name, operationId, { action: 'restart' }), timing.restartGapMs),
      });
    }
    return body;
  }

  function reconnectHost(name) {
    gate();
    const host = need(name);
    if (!['degraded', 'running'].includes(host.phase)) {
      throw new FakeApiError(409, 'PHASE_CONFLICT', `${name} 当前状态「${host.phase}」无需重连`);
    }
    const { operationId, body } = accept('reconnect', name);
    if (host.phase === 'running') {
      timer(() => finish(operationId, { host: name, action: 'reconnect' }), timing.reconnectMs);
      return body;
    }
    const myGen = bumpGen(name);
    timer(() => {
      if (gen(name) !== myGen || hosts.get(name)?.phase !== 'degraded') return;
      setPhase(name, 'running', 'reconnect');
      host.tunnel.connected = true;
      host.tunnel.reconnectAttempt = 0;
      host.mappedUrl = mockUrl(name, host.tunnel.localPort);
      pushLog({ host: name, level: 'info', msg: '隧道已按人工请求重连' });
      emitHost(name);
      finish(operationId, { host: name, action: 'reconnect' });
    }, timing.reconnectMs);
    return body;
  }

  function hostLog(name, lines = 200) {
    gate();
    const host = need(name);
    if (!Number.isInteger(lines) || lines < 1 || lines > 10_000) {
      throw new FakeApiError(400, 'VALIDATION', 'lines 须为 1–10000 的整数');
    }
    if (!host.web) return '(no log)';
    return fakeLog(name, host.web.port, Math.min(lines, 60));
  }

  const PATCHABLE = new Set(['enabled', 'autoStart', 'remoteWebPort', 'workdir', 'inject']);

  function saveHostConfig(name, patch) {
    gate();
    const host = need(name);
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new FakeApiError(400, 'VALIDATION', '请求体须为对象');
    }
    const unknown = Object.keys(patch).filter((k) => !PATCHABLE.has(k));
    if (unknown.length > 0) {
      throw new FakeApiError(400, 'VALIDATION', `不接受的字段：${unknown.join(', ')}`, 'localPort 由 manager 分配，不可提交');
    }
    Object.assign(host.config, clone(patch));
    host.effectiveRemotePort = host.config.remoteWebPort ?? config.defaults.remoteWebPort;
    config.hosts[name] = clone(host.config);
    pushLog({ host: name, level: 'info', msg: `配置已更新：${Object.keys(patch).join('、')}` });
    emitHost(name);
    return { host: clone(host) };
  }

  function saveDefaults(patch) {
    gate();
    const changed = [];
    if (patch.remoteWebPort !== undefined) {
      config.defaults.remoteWebPort = patch.remoteWebPort;
      changed.push('defaults.remoteWebPort');
    }
    if (patch.localPortRange !== undefined) {
      config.defaults.localPortRange = [...patch.localPortRange];
      changed.push('defaults.localPortRange');
    }
    const restartRequired = patch.manager?.port !== undefined && patch.manager.port !== config.manager.port;
    if (patch.manager?.port !== undefined) {
      config.manager.port = patch.manager.port;
      changed.push('manager.port');
    }
    for (const host of hosts.values()) {
      host.effectiveRemotePort = host.config.remoteWebPort ?? config.defaults.remoteWebPort;
    }
    emit('config-changed', {
      revision: bump(),
      defaults: clone(config.defaults),
      manager: { port: config.manager.port },
      changed,
    });
    return { defaults: clone(config.defaults), manager: { port: config.manager.port }, restartRequired };
  }

  function reload() {
    gate();
    pushLog({ level: 'info', msg: '已重载配置（demo 中配置只存在内存里）' });
    return { changed: [] };
  }

  function setup(submitted) {
    if (submitted === null || typeof submitted !== 'object') {
      throw new FakeApiError(400, 'VALIDATION', '请求体须为整份 config');
    }
    const port = submitted.manager?.port ?? config.manager.port;
    config = {
      configVersion: 1,
      setupCompleted: true,
      manager: { port },
      defaults: clone(submitted.defaults ?? config.defaults),
      hosts: {},
    };
    gateOpen = true;

    const autoStarts = [];
    for (const [name, hostCfg] of Object.entries(submitted.hosts ?? {})) {
      const host = hosts.get(name);
      if (!host) continue;
      const local = host.local === true;
      host.config = {
        local,
        enabled: Boolean(hostCfg.enabled),
        autoStart: Boolean(hostCfg.autoStart),
        localPort: hostCfg.localPort ?? null,
        remoteWebPort: hostCfg.remoteWebPort ?? null,
        workdir: hostCfg.workdir ?? null,
        inject: clone(hostCfg.inject ?? { env: {}, extraArgs: [], patches: [] }),
      };
      host.effectiveRemotePort = host.config.remoteWebPort ?? config.defaults.remoteWebPort;
      config.hosts[name] = clone(host.config);
      if (host.config.autoStart && host.phase === 'ready') autoStarts.push(name);
    }

    pushLog({ level: 'info', msg: `初始化完成，纳管 ${Object.keys(config.hosts).length} 台` });
    // 「开启链接」的主机随即批量拉起（01 §2.5 提交后的分流）
    for (const [i, name] of autoStarts.entries()) {
      timer(() => {
        if (hosts.get(name)?.phase === 'ready') doStart(name, null);
      }, timing.autoStartDelayMs * (i + 1));
    }
    return {
      ok: true, port, portChanged: false, restartRequired: false, restarting: false,
    };
  }

  // ── demo 专属：故障注入 ───────────────────────────────────────────────

  /** 隧道断开 → degraded，随后按退避自动重连。 */
  function injectTunnelDrop(name) {
    const host = need(name);
    if (host.phase !== 'running') {
      throw new FakeApiError(409, 'PHASE_CONFLICT', `${name} 不在运行中，无法演示断联`);
    }
    setPhase(name, 'degraded', 'demo:tunnel-drop');
    host.tunnel.connected = false;
    host.tunnel.reconnectAttempt = 0;
    pushLog({ host: name, level: 'warn', msg: '隧道断开（ssh 子进程退出），开始退避重连' });
    emitHost(name);
    bumpGen(name);
    scheduleReconnect(name, 1);
  }

  /** 远端进程消失 → crashed（隧道随之无效，mappedUrl 置空）。 */
  function injectCrash(name) {
    const host = need(name);
    if (!['running', 'degraded'].includes(host.phase)) {
      throw new FakeApiError(409, 'PHASE_CONFLICT', `${name} 不在运行中，无法演示崩溃`);
    }
    bumpGen(name);
    setPhase(name, 'crashed', 'demo:crash');
    host.tunnel = null;
    host.mappedUrl = null;
    pushLog({
      host: name,
      level: 'error',
      msg: `远端 dsh web（PID ${host.web?.pid}）已消失，判定 crashed`,
      detail: '巡检时记录的 PID 不在 ps 输出里，且不是 manager 主动关停的。',
    });
    emitHost(name);
  }

  // ── 订阅 ─────────────────────────────────────────────────────────────

  /** 订阅即先收 snapshot（13 §3.2 首帧约定）。 */
  function subscribe(fn) {
    listeners.add(fn);
    fn('snapshot', {
      revision,
      manager: managerInfo(),
      defaults: clone(config.defaults),
      hosts: listHosts(),
      logs: logs.map((l) => ({ ...l })),
    });
    return () => listeners.delete(fn);
  }

  reset({ mode: setupCompleted ? 'dashboard' : 'setup' });

  return {
    // 读
    managerInfo,
    hosts: () => ({ revision, hosts: listHosts() }),
    config: () => clone(config),
    getHost: (name) => (hosts.has(name) ? clone(hosts.get(name)) : null),
    // 长动作
    probeAll,
    probeHost,
    startHost,
    stopHost,
    restartHost,
    reconnectHost,
    // 其他 REST
    hostLog,
    saveHostConfig,
    saveDefaults,
    reload,
    setup,
    createLocalHost,
    // SSE
    subscribe,
    // demo 控制
    reset,
    injectTunnelDrop,
    injectCrash,
    get revision() { return revision; },
  };
}
