/**
 * config.json / state.json 读写（11 §4）。
 *
 * 三条不变式：
 * 1. 写入一律原子（tmp + fsync + rename）。
 * 2. 事件发射点收敛在 setPhase / mutateHostState / updateConfig 三处——
 *    「凡是持久化了的变化必有事件，凡有事件必已持久化（或已进 debounce 队列）」。
 * 3. phase 迁移只经 setPhase，由 machine 守卫终审。
 */

import fs from 'node:fs';
import path from 'node:path';

import { CONFIG_VERSION, PATHS, newFactoryConfig, newHostConfig, resolvePaths } from './defaults.js';
import { DshError } from './lib/errors.js';
import { assertTransition } from './lib/machine.js';
import { emitConfigChanged, emitHostChanged, logEvent } from './lib/bus.js';
import { configSchema, hostStateSchema, validate } from './lib/validate.js';

const STATE_DEBOUNCE_MS = 100;

/** @type {ReturnType<typeof resolvePaths>} */
let paths = PATHS;

/** @type {any} */
let config = null;
/** @type {{hosts: Record<string, any>}} */
let state = { hosts: {} };
/** ssh config 解析结果（内存，不持久化）。 */
let sshInfoByName = new Map();
/** config 有而 ssh config 无的主机（内存标记，不持久化，不删配置）。 */
let orphaned = new Set();
/** 由 server.js 注入，避免 store → tunnel 依赖（防环规则 3）。 */
let tunnelStatusProvider = () => null;

let revision = 0;
let stateTimer = null;
let stateDirty = false;

// ── 原子写与 debounce（§4.1、§4.2） ─────────────────────────────────────

function atomicWrite(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}`; // 同目录保证 rename 同文件系统
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeSync(fd, data);
    fs.fsyncSync(fd); // 显式 fsync，防 rename 后掉电空文件
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

function cleanupTmpLeftovers() {
  try {
    for (const name of fs.readdirSync(paths.dir)) {
      if (/\.tmp\.\d+$/.test(name)) fs.rmSync(path.join(paths.dir, name), { force: true });
    }
  } catch {
    // 目录不存在即无残留
  }
}

function serializeState() {
  return `${JSON.stringify(state, null, 2)}\n`;
}

/**
 * state 落盘写不进时的记账（issue #87）。
 *
 * 这条路不许抛：debounce 的落盘在定时器回调里，抛出去就是未捕获异常，manager 当场死、
 * 所有隧道陪葬，launchd 还会把它拉起来接着死。写不进的正确姿态是继续用内存里的状态跑，
 * 下次状态一变再试——代价只是「manager 重启会回到上次成功落盘的那份」。
 * 同一个毛病只报一次：写不进往往每拍都写不进，逐次报会把日志刷没。
 * @type {string|null} 上次失败的 code，null = 上次是成功的
 */
let stateSaveFailure = null;

/** @returns {boolean} 写进去了没有 */
function trySaveState() {
  try {
    atomicWrite(paths.state, serializeState());
  } catch (err) {
    const code = err.code ?? 'UNKNOWN';
    if (stateSaveFailure !== code) {
      stateSaveFailure = code;
      logEvent(null, 'warn', '运行状态写不进磁盘，manager 照常运行，但重启后会回到上次写成功的那份', 
        `文件：${paths.state}\n${code} ${err.message}\n`
        + '常见原因：磁盘满、所在卷变成只读、目录属主不是当前用户（比如被 sudo 跑过一次）。');
    }
    return false;
  }
  if (stateSaveFailure !== null) {
    stateSaveFailure = null;
    logEvent(null, 'info', '运行状态又能写进磁盘了，已把最新的一份落下去');
  }
  return true;
}

function scheduleStateSave() {
  stateDirty = true;
  stateTimer ??= setTimeout(() => {
    stateTimer = null;
    if (!stateDirty) return;
    stateDirty = false;
    // 没写成就把脏标记还回去：下次状态一变会再排一次，恢复可写时自己就补上了
    if (!trySaveState()) stateDirty = true;
  }, STATE_DEBOUNCE_MS);
}

/** 退出路径：取消 debounce，同步原子写。同样不许抛——抛了后面的隧道回收就跳过去了。 */
export function flushStateSync() {
  if (stateTimer) {
    clearTimeout(stateTimer);
    stateTimer = null;
  }
  if (!stateDirty) return;
  stateDirty = false;
  if (!trySaveState()) stateDirty = true;
}

/**
 * 上一次由我们读入或写出的 config 文本。落盘前拿它跟磁盘上那份比：不一致就是有人
 * 在 manager 跑着的时候手改了文件，这时整份落盘会把他的编辑无声抹掉（issue #65）。
 * @type {string|null} null = 还没读到过（首次落盘，无从比对）
 */
let configOnDiskText = null;

/**
 * 磁盘上那份还是我们上次见到的样子吗。
 * @returns {boolean} true = 没被外部动过（或本来就没有这个文件）
 */
function diskMatchesLastSeen() {
  if (configOnDiskText === null) return true;
  let current;
  try {
    current = fs.readFileSync(paths.config, 'utf8');
  } catch (err) {
    // 文件被删了：让写去重建，不当成外部改动拦下来
    if (err.code === 'ENOENT') return true;
    throw new DshError('CONFIG_WRITE_FAILED', '配置没能写入磁盘，本次修改已放弃', {
      detail: `${err.code ?? ''} ${err.message}`.trim(),
      cause: err,
    });
  }
  return current === configOnDiskText;
}

/**
 * 把一份配置落盘。失败一律翻译成 DshError——fs 的原始错误（`EACCES: permission denied,
 * open '/Users/.../config.json.tmp.123'`）当 message 端给用户既看不懂，又把内部路径抖出去。
 */
function writeConfig(next) {
  if (!diskMatchesLastSeen()) {
    throw new DshError('CONFIG_STALE', '配置文件被外部改过，这次没写——免得拿旧值盖掉你的改动', {
      detail: `文件：${paths.config}\n`
        + '要让 manager 用上磁盘里的版本：dshc restart（会瞬断隧道，页签会自愈重连）。',
    });
  }
  const text = `${JSON.stringify(next, null, 2)}\n`;
  try {
    atomicWrite(paths.config, text);
    configOnDiskText = text;
  } catch (err) {
    throw new DshError('CONFIG_WRITE_FAILED', '配置没能写入磁盘，本次修改已放弃', {
      detail: `${err.code ?? ''} ${err.message}`.trim(),
      cause: err,
    });
  }
}

function writeConfigNow() {
  writeConfig(config);
}

// ── configVersion 迁移器（§4.4） ─────────────────────────────────────────

/** 追加式迁移，禁止改语义。 */
const MIGRATIONS = [
  // { from: 1, to: 2, up(cfg) { cfg.newField ??= …; } },
];

function migrateConfig(raw) {
  const cfg = raw;
  let v = Number.isInteger(cfg.configVersion) ? cfg.configVersion : 1;
  if (v > CONFIG_VERSION) {
    throw new DshError(
      'VALIDATION',
      `config.json 版本 ${v} 高于本程序支持的 ${CONFIG_VERSION}，拒绝启动（请升级 dshc）`,
      { detail: '旧代码写入新配置会造成字段丢失，故硬失败而非降级兜底。' },
    );
  }
  let migrated = false;
  while (v < CONFIG_VERSION) {
    const step = MIGRATIONS.find((m) => m.from === v);
    if (!step) break;
    step.up(cfg);
    v = step.to;
    migrated = true;
  }
  if (cfg.configVersion !== CONFIG_VERSION) {
    cfg.configVersion = CONFIG_VERSION;
    migrated = true;
  }
  // 补默认字段（低版本或手改缺字段）
  const factory = newFactoryConfig();
  cfg.setupCompleted ??= false;
  cfg.manager ??= factory.manager;
  cfg.manager.port ??= factory.manager.port;
  cfg.defaults ??= factory.defaults;
  cfg.defaults.remoteWebPort ??= factory.defaults.remoteWebPort;
  cfg.defaults.localPortRange ??= factory.defaults.localPortRange;
  cfg.hosts ??= {};
  for (const [name, host] of Object.entries(cfg.hosts)) {
    cfg.hosts[name] = { ...newHostConfig(), ...host, inject: { ...newHostConfig().inject, ...(host.inject ?? {}) } };
  }
  return { config: cfg, migrated };
}

// ── 加载（§4.5） ────────────────────────────────────────────────────────

function loadConfigFile() {
  let text;
  try {
    text = fs.readFileSync(paths.config, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      configOnDiskText = null;
      return { config: newFactoryConfig(), fresh: true };
    }
    throw new DshError('INTERNAL', `无法读取 ${paths.config}：${err.message}`, { cause: err });
  }
  configOnDiskText = text;

  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    // config 是用户契约，静默兜底会掩盖手改失误 → 拒绝启动
    throw new DshError('VALIDATION', `config.json 不是合法 JSON：${err.message}`, {
      detail: `文件：${paths.config}`,
    });
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new DshError('VALIDATION', 'config.json 顶层必须是对象', { detail: `文件：${paths.config}` });
  }

  const { config: migrated, migrated: didMigrate } = migrateConfig(raw);
  const { ok, errors } = validate(configSchema, migrated);
  if (!ok) {
    throw new DshError('VALIDATION', 'config.json 校验失败，拒绝启动', { detail: errors.join('\n') });
  }
  return { config: migrated, fresh: false, migrated: didMigrate };
}

function loadStateFile() {
  let text;
  try {
    text = fs.readFileSync(paths.state, 'utf8');
  } catch {
    return { hosts: {} };
  }

  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    const backup = `${paths.state}.corrupt.${Date.now()}`;
    try {
      fs.renameSync(paths.state, backup);
    } catch {
      // 留证失败不阻塞启动
    }
    logEvent(null, 'warn', `state.json 解析失败，已留证为 ${path.basename(backup)}，以空状态启动`);
    return { hosts: {} };
  }

  const hosts = {};
  for (const [name, entry] of Object.entries(raw?.hosts ?? {})) {
    if (validate(hostStateSchema, entry).ok) {
      hosts[name] = entry;
    } else {
      logEvent(name, 'warn', 'state.json 中该主机条目非法，已丢弃');
    }
  }
  return { hosts };
}

/** 加载 + 迁移 + 校验 config；宽容加载 state。 */
export async function init({ pathsOverride } = {}) {
  paths = pathsOverride ?? resolvePaths();
  cleanupTmpLeftovers();

  const loaded = loadConfigFile();
  config = loaded.config;
  if (loaded.migrated && !loaded.fresh) {
    writeConfigNow();
    logEvent(null, 'info', `config.json 已迁移到 configVersion=${CONFIG_VERSION}`);
  }
  state = loadStateFile();
  revision = 0;
  return { fresh: loaded.fresh };
}

/** 测试/重启用：丢弃内存态。 */
export function _reset() {
  if (stateTimer) clearTimeout(stateTimer);
  stateTimer = null;
  stateDirty = false;
  config = null;
  configOnDiskText = null;
  state = { hosts: {} };
  sshInfoByName = new Map();
  orphaned = new Set();
  tunnelStatusProvider = () => null;
  revision = 0;
}

export function getPaths() {
  return paths;
}

// ── revision（13 §3.1） ─────────────────────────────────────────────────

export function currentRevision() {
  return revision;
}

/** 每个对外帧取一个新 revision（api 的 sseHub 广播时调用一次，全客户端同值）。 */
export function bumpRevision() {
  revision += 1;
  return revision;
}

// ── config 读写 ─────────────────────────────────────────────────────────

export function isSetupCompleted() {
  return config?.setupCompleted === true;
}

/** 深冻结快照（防调用方误改内存态）。 */
export function getConfig() {
  return deepFreeze(structuredClone(config));
}

function deepFreeze(o) {
  if (o === null || typeof o !== 'object') return o;
  for (const v of Object.values(o)) deepFreeze(v);
  return Object.freeze(o);
}

/**
 * config 写入唯一入口：mutator 改草稿 → 校验 → 原子写 → 按改动面 emit。
 * @param {(draft:any)=>void} mutator
 * @returns {{changed:string[]}}
 */
export function updateConfig(mutator) {
  const before = structuredClone(config);
  const draft = structuredClone(config);
  mutator(draft);

  const { ok, errors } = validate(configSchema, draft);
  if (!ok) {
    throw new DshError('VALIDATION', '配置修改后校验失败，已放弃本次写入', { detail: errors.join('\n') });
  }

  // 先落盘、成了才换内存。反过来写的后果是：盘写失败（目录只读、磁盘满、卷被卸载）时
  // 请求报 500、用户以为没生效，可跑着的 manager 已经在用新值，重启后又从盘上读回旧值
  // 静默回退——同一时刻三种说法。
  writeConfig(draft);
  config = draft;

  const changed = diffPaths(before, draft);
  const touchedHosts = new Set();
  let globalTouched = false;
  for (const p of changed) {
    const m = /^hosts\.([^.]+)/.exec(p);
    if (m) touchedHosts.add(m[1]);
    else globalTouched = true;
  }
  for (const name of touchedHosts) emitHostChanged(name);
  if (globalTouched) emitConfigChanged(changed);
  return { changed };
}

/** setup 提交专用：整份替换 + setupCompleted:true + 原子写。 */
export function saveConfigFromSetup(incoming) {
  const draft = structuredClone(incoming);
  draft.configVersion = CONFIG_VERSION;
  draft.setupCompleted = true;
  draft.hosts ??= {};
  for (const [name, host] of Object.entries(draft.hosts)) {
    const base = newHostConfig();
    draft.hosts[name] = {
      ...base,
      ...host,
      inject: { ...base.inject, ...(host.inject ?? {}) },
    };
  }

  const { ok, errors } = validate(configSchema, draft);
  if (!ok) {
    throw new DshError('VALIDATION', '初始化配置校验失败', { detail: errors.join('\n') });
  }

  config = draft;
  writeConfigNow();
  emitConfigChanged(['setup']);
  for (const name of Object.keys(config.hosts)) emitHostChanged(name);
  return getConfig();
}

/** POST /api/reload：重读 → diff → emit。 */
export function reloadConfig() {
  const before = structuredClone(config);
  const loaded = loadConfigFile();
  config = loaded.config;
  if (loaded.migrated) writeConfigNow();

  const changed = diffPaths(before, config);
  const touchedHosts = new Set();
  let globalTouched = false;
  for (const p of changed) {
    const m = /^hosts\.([^.]+)/.exec(p);
    if (m) touchedHosts.add(m[1]);
    else globalTouched = true;
  }
  for (const name of touchedHosts) emitHostChanged(name);
  if (globalTouched || changed.length > 0) emitConfigChanged(changed);
  return { changed };
}

/** 逐叶节点比较，产出点路径清单（emit 决策与 /api/reload 响应共用）。 */
function diffPaths(a, b, prefix = '') {
  const out = [];
  const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);
  for (const key of keys) {
    const p = prefix ? `${prefix}.${key}` : key;
    const va = a?.[key];
    const vb = b?.[key];
    const objA = va !== null && typeof va === 'object' && !Array.isArray(va);
    const objB = vb !== null && typeof vb === 'object' && !Array.isArray(vb);
    if (objA && objB) out.push(...diffPaths(va, vb, p));
    else if (JSON.stringify(va) !== JSON.stringify(vb)) out.push(p);
  }
  return out;
}

// ── ssh config 合并（mergeSshHosts） ────────────────────────────────────

/**
 * 启动/reload 时并入 ssh config 清单：新主机以 hostDefaults 写入 config；
 * config 有而 ssh config 无 → 内存标记 orphaned（不持久化，不删配置）。
 * @param {{name:string, hostName?:string, user?:string, port?:number}[]} sshHosts
 */
export function mergeSshHosts(sshHosts) {
  sshInfoByName = new Map(sshHosts.map((h) => [h.name, h]));

  const added = sshHosts.filter((h) => !(h.name in config.hosts)).map((h) => h.name);
  if (added.length > 0) {
    updateConfig((draft) => {
      for (const name of added) draft.hosts[name] = newHostConfig();
    });
  }

  orphaned = new Set(Object.keys(config.hosts).filter((n) => !sshInfoByName.has(n)));
  for (const name of orphaned) emitHostChanged(name);
  return { added, orphaned: [...orphaned] };
}

export function setTunnelStatusProvider(fn) {
  tunnelStatusProvider = typeof fn === 'function' ? fn : () => null;
}

// ── state 读写 ──────────────────────────────────────────────────────────

function ensureHostState(name) {
  state.hosts[name] ??= { phase: 'unknown', probe: null, web: null, tunnel: null, patchSync: { files: {} }, manualInstances: [] };
  return state.hosts[name];
}

export function getHostState(name) {
  return state.hosts[name] ?? null;
}

export function getPhase(name) {
  return state.hosts[name]?.phase ?? 'unknown';
}

/** state 写入唯一入口（phase 除外）。 */
export function mutateHostState(name, mutator) {
  const entry = ensureHostState(name);
  mutator(entry);
  scheduleStateSave();
  emitHostChanged(name);
  return entry;
}

/**
 * phase 迁移唯一入口：machine 守卫 → 写 phase → emitHostChanged。
 * @throws {DshError} STATE_ILLEGAL_TRANSITION
 */
export function setPhase(name, next, cause = 'unknown') {
  const entry = ensureHostState(name);
  const from = entry.phase;
  try {
    assertTransition(from, next, cause);
  } catch (err) {
    logEvent(name, 'error', `拒绝非法状态迁移 ${from} → ${next}（${cause}）`, err.detail ?? null);
    throw err;
  }
  if (from === next) {
    // 自环只刷新数据，仍发事件（视图里的 probe/web 等可能已变）
    emitHostChanged(name);
    return from;
  }
  entry.phase = next;
  scheduleStateSave();
  emitHostChanged(name);
  return next;
}

/** 删除某主机的 state 条目（主机从 config 移除时）。 */
export function dropHostState(name) {
  if (name in state.hosts) {
    delete state.hosts[name];
    scheduleStateSave();
    emitHostChanged(name);
  }
}

// ── HostView（13 §1.3） ─────────────────────────────────────────────────

export function effectiveRemotePort(name) {
  const host = config.hosts[name];
  return host?.remoteWebPort ?? config.defaults.remoteWebPort;
}

/** @returns {any|null} */
export function getHostView(name) {
  const hostConfig = config?.hosts?.[name];
  if (!hostConfig) return null;
  const st = state.hosts[name] ?? {};
  const ssh = sshInfoByName.get(name) ?? null;
  const tunnelRuntime = tunnelStatusProvider(name);

  const localPort = tunnelRuntime?.localPort ?? st.tunnel?.localPort ?? hostConfig.localPort ?? null;
  const phase = st.phase ?? 'unknown';
  const tunnelUsable = (phase === 'running' || phase === 'degraded') && localPort !== null;

  return {
    name,
    sshInfo: ssh
      ? { hostName: ssh.hostName ?? null, user: ssh.user ?? null, port: ssh.port ?? null }
      : null,
    orphaned: orphaned.has(name),
    config: {
      enabled: hostConfig.enabled,
      autoStart: hostConfig.autoStart,
      localPort: hostConfig.localPort,
      remoteWebPort: hostConfig.remoteWebPort,
      // 下次拉起生效值；本次实例的实际值在 web.workdir，两者不等即「重启后生效」
      workdir: hostConfig.workdir ?? null,
      inject: {
        env: { ...hostConfig.inject.env },
        extraArgs: [...hostConfig.inject.extraArgs],
        patches: [...hostConfig.inject.patches],
      },
    },
    phase,
    effectiveRemotePort: effectiveRemotePort(name),
    mappedUrl: tunnelUsable ? `http://127.0.0.1:${localPort}/` : null,
    probe: st.probe ?? null,
    // workdir/cwd 补 null：上一代 manager 写的 state 里没有这两个键（补丁 01 §5.2）
    web: st.web ? { ...st.web, workdir: st.web.workdir ?? null, cwd: st.web.cwd ?? null } : null,
    tunnel: tunnelRuntime
      ? {
        localPort: tunnelRuntime.localPort ?? localPort,
        connected: tunnelRuntime.connected === true,
        reconnectAttempt: tunnelRuntime.reconnectAttempt ?? 0,
        suspendedReason: tunnelRuntime.suspendedReason ?? null,
      }
      : (st.tunnel
        ? { localPort: st.tunnel.localPort ?? null, connected: false, reconnectAttempt: 0, suspendedReason: null }
        : null),
    patchSync: st.patchSync ?? { files: {} },
    manualInstances: st.manualInstances ?? [],
  };
}

/** HostView[]，按 name 升序（GET /api/hosts 与 snapshot 的数据源）。 */
export function listHostViews() {
  return Object.keys(config?.hosts ?? {})
    .sort()
    .map((n) => getHostView(n))
    .filter(Boolean);
}

export function listHostNames() {
  return Object.keys(config?.hosts ?? {}).sort();
}

export function hostCounts() {
  const counts = { total: 0, running: 0, degraded: 0, crashed: 0 };
  for (const name of Object.keys(config?.hosts ?? {})) {
    counts.total += 1;
    const p = getPhase(name);
    if (p in counts) counts[p] += 1;
  }
  return counts;
}

export { STATE_DEBOUNCE_MS };
