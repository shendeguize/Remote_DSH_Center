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
const SYNC_TARGET_LIMIT = 200;
const SETTINGS_MAX_BYTES = 512 * 1024;
const SETTINGS_BODY_FIELDS = new Set(['content', 'baseChecksum']);
const SETTINGS_CHECKSUM_RE = /^cksum-v1:(0|[1-9][0-9]{0,9}):(0|[1-9][0-9]{0,6})$/u;
const CRC_POLYNOMIAL = 0x04c11db7;
const OPAQUE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const PREVIEW_TOKEN_DOMAIN = 'dsh-center-demo-preview-v1\0';
const SHA256_INITIAL = Object.freeze([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);
const SHA256_ROUNDS = Object.freeze([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
  0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
  0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
  0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
  0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
const SYNC_BODY_FIELDS = new Set(['source', 'targets', 'dryRun', 'previewToken']);
const SYNC_PROFILE_FIELDS = Object.freeze([
  'remoteWebPort',
  'workdir',
  'inject.env',
  'inject.extraArgs',
  'inject.patches',
]);

const CRC_TABLE = Object.freeze(Array.from({ length: 256 }, (_, index) => {
  let crc = (index << 24) >>> 0;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = (crc & 0x80000000) !== 0
      ? (((crc << 1) ^ CRC_POLYNOMIAL) >>> 0)
      : ((crc << 1) >>> 0);
  }
  return crc;
}));

const crcByte = (crc, byte) => (
  (((crc << 8) >>> 0) ^ CRC_TABLE[((crc >>> 24) ^ byte) & 0xff]) >>> 0
);

/**
 * POSIX `cksum` CRC 的纯浏览器实现，仅用于在线 demo 镜像生产 CAS 协议。
 * 它不是密码学 hash，不得用于凭据或安全判定。
 */
export function posixCksum(input) {
  if (!(input instanceof Uint8Array)) {
    throw new TypeError('posixCksum input 必须是 Uint8Array');
  }
  let crc = 0;
  for (const byte of input) crc = crcByte(crc, byte);
  let length = input.byteLength;
  while (length > 0) {
    crc = crcByte(crc, length & 0xff);
    length = Math.floor(length / 256);
  }
  return (~crc) >>> 0;
}

function hasUnpairedSurrogate(content) {
  for (let index = 0; index < content.length; index += 1) {
    const unit = content.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = content.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function settingsValidation(detail) {
  throw new FakeApiError(
    400,
    'VALIDATION',
    'settings.yaml 保存请求校验失败',
    detail,
  );
}

function assertSettingsRequest(request) {
  if (request === null || typeof request !== 'object' || Array.isArray(request)) {
    settingsValidation(`<root>: expected object, got ${request === null ? 'null' : Array.isArray(request) ? 'array' : typeof request}`);
  }
  const errors = [];
  for (const field of SETTINGS_BODY_FIELDS) {
    if (!Object.hasOwn(request, field)) errors.push(`${field}: required`);
  }
  for (const key of Object.keys(request)) {
    if (!SETTINGS_BODY_FIELDS.has(key)) errors.push(`${key}: unknown key`);
  }
  if (Object.hasOwn(request, 'content') && typeof request.content !== 'string') {
    errors.push(`content: expected string, got ${request.content === null ? 'null' : typeof request.content}`);
  }
  if (Object.hasOwn(request, 'baseChecksum') && request.baseChecksum !== null) {
    const match = typeof request.baseChecksum === 'string'
      ? SETTINGS_CHECKSUM_RE.exec(request.baseChecksum)
      : null;
    if (
      !match
      || Number(match[1]) > 0xffff_ffff
      || Number(match[2]) > SETTINGS_MAX_BYTES
    ) {
      errors.push('baseChecksum: 格式无效，应为 cksum-v1:<CRC>:<字节数> 或 null');
    }
  }
  if (errors.length > 0) settingsValidation(errors.join('\n'));
}

function encodeSettingsContent(content) {
  if (hasUnpairedSurrogate(content)) {
    throw new FakeApiError(
      400,
      'VALIDATION',
      'content 含未配对的 Unicode surrogate，无法无损编码为 UTF-8',
    );
  }
  const bytes = new TextEncoder().encode(content);
  if (bytes.byteLength > SETTINGS_MAX_BYTES) {
    throw new FakeApiError(
      413,
      'SETTINGS_TOO_LARGE',
      'settings.yaml 超过 512 KiB，无法安全处理',
    );
  }
  return bytes;
}

const settingsChecksum = (bytes) => `cksum-v1:${posixCksum(bytes)}:${bytes.byteLength}`;

function cloneInject(value) {
  return {
    env: { ...value?.env },
    extraArgs: [...(value?.extraArgs ?? [])],
    patches: [...(value?.patches ?? [])],
  };
}

function syncProfileOf(hostConfig) {
  return {
    remoteWebPort: hostConfig?.remoteWebPort ?? null,
    workdir: hostConfig?.workdir ?? null,
    inject: cloneInject(hostConfig?.inject),
  };
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map((entry) => canonicalize(entry));
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
  );
}

const sameJsonValue = (left, right) => (
  JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right))
);

const profileValueAt = (profile, path) => (
  path.split('.').reduce((value, key) => value?.[key], profile)
);

function changedProfileFields(source, target) {
  return SYNC_PROFILE_FIELDS.filter(
    (path) => !sameJsonValue(profileValueAt(source, path), profileValueAt(target, path)),
  );
}

function randomBytes(length) {
  const bytes = new Uint8Array(length);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  return bytes;
}

const rotateRight = (value, bits) => (value >>> bits) | (value << (32 - bits));

function sha256(bytes) {
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;

  const paddedView = new DataView(padded.buffer);
  const bitLength = bytes.length * 8;
  paddedView.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000), false);
  paddedView.setUint32(paddedLength - 4, bitLength >>> 0, false);

  const state = [...SHA256_INITIAL];
  const words = new Uint32Array(64);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let i = 0; i < 16; i += 1) {
      words[i] = paddedView.getUint32(offset + i * 4, false);
    }
    for (let i = 16; i < words.length; i += 1) {
      const s0 = rotateRight(words[i - 15], 7)
        ^ rotateRight(words[i - 15], 18)
        ^ (words[i - 15] >>> 3);
      const s1 = rotateRight(words[i - 2], 17)
        ^ rotateRight(words[i - 2], 19)
        ^ (words[i - 2] >>> 10);
      words[i] = (words[i - 16] + s0 + words[i - 7] + s1) >>> 0;
    }

    let [a, b, c, d, e, f, g, h] = state;
    for (let i = 0; i < SHA256_ROUNDS.length; i += 1) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choose = (e & f) ^ (~e & g);
      const temp1 = (h + sum1 + choose + SHA256_ROUNDS[i] + words[i]) >>> 0;
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (sum0 + majority) >>> 0;
      [a, b, c, d, e, f, g, h] = [
        (temp1 + temp2) >>> 0,
        a,
        b,
        c,
        (d + temp1) >>> 0,
        e,
        f,
        g,
      ];
    }
    for (let i = 0; i < state.length; i += 1) {
      state[i] = (state[i] + [a, b, c, d, e, f, g, h][i]) >>> 0;
    }
  }

  const digest = new Uint8Array(32);
  const digestView = new DataView(digest.buffer);
  state.forEach((value, i) => digestView.setUint32(i * 4, value, false));
  return digest;
}

function base64Url(bytes) {
  let encoded = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const value = (bytes[i] << 16)
      | ((bytes[i + 1] ?? 0) << 8)
      | (bytes[i + 2] ?? 0);
    encoded += OPAQUE_ALPHABET[(value >>> 18) & 63];
    encoded += OPAQUE_ALPHABET[(value >>> 12) & 63];
    if (i + 1 < bytes.length) encoded += OPAQUE_ALPHABET[(value >>> 6) & 63];
    if (i + 2 < bytes.length) encoded += OPAQUE_ALPHABET[value & 63];
  }
  return encoded;
}

function previewTokenFor(fingerprint, sessionSalt) {
  const message = new TextEncoder().encode(`${PREVIEW_TOKEN_DOMAIN}${fingerprint}`);
  const salted = new Uint8Array(sessionSalt.length + message.length);
  salted.set(sessionSalt);
  salted.set(message, sessionSalt.length);
  return `v1.${base64Url(sha256(salted))}`;
}

function validHostName(value) {
  return typeof value === 'string'
    && value !== ''
    && SAFE_HOST_RE.test(value)
    && !value.startsWith('-');
}

function isAbsolutePath(value) {
  return typeof value === 'string' && value.startsWith('/') && !value.includes('\0');
}

function canonicalWorkspacePath(value) {
  const parts = [];
  for (const part of value.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return `/${parts.join('/')}`;
}

function workspaceTitle(path) {
  return path.slice(path.lastIndexOf('/') + 1);
}

function assertSyncRequest(request) {
  if (request === null || typeof request !== 'object' || Array.isArray(request)) {
    throw new FakeApiError(400, 'VALIDATION', '批量配置同步请求体须为对象');
  }
  const unknown = Object.keys(request).filter((key) => !SYNC_BODY_FIELDS.has(key));
  if (unknown.length > 0) {
    throw new FakeApiError(400, 'VALIDATION', `批量配置同步不接受字段：${unknown.join(', ')}`);
  }
  if (!validHostName(request.source)) {
    throw new FakeApiError(400, 'VALIDATION', '请选择有效的源主机');
  }
  if (!Array.isArray(request.targets) || request.targets.length < 1 || request.targets.length > SYNC_TARGET_LIMIT) {
    throw new FakeApiError(400, 'VALIDATION', `目标主机数量须为 1–${SYNC_TARGET_LIMIT}`);
  }
  if (request.targets.some((name) => !validHostName(name))) {
    throw new FakeApiError(400, 'VALIDATION', '目标主机名格式无效');
  }
  if (typeof request.dryRun !== 'boolean') {
    throw new FakeApiError(400, 'VALIDATION', 'dryRun 须为布尔值');
  }
  if (Object.hasOwn(request, 'previewToken')
    && (typeof request.previewToken !== 'string'
      || request.previewToken.length < 1
      || request.previewToken.length > 200)) {
    throw new FakeApiError(400, 'VALIDATION', 'previewToken 须为 1–200 字符的字符串');
  }
  if (!request.dryRun && !Object.hasOwn(request, 'previewToken')) {
    throw new FakeApiError(400, 'VALIDATION', '应用配置同步前必须提交 previewToken');
  }
}

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
  /** settings 正文只驻留在此私有 Map，不进入 HostView/config/SSE。 */
  const settingsFiles = new Map();
  /** 每台主机的 dsh storage 独立；Workspace 在主机内按当前实测 CWD 幂等登记。 */
  const dshWorkspaces = new Map();
  const pendingTimers = new Set();

  let revision = 0;
  let logs = [];
  let config = null;
  let previewSessionSalt = new Uint8Array();
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

  function needConfigHost(name, role) {
    if (config?.hosts === null
      || typeof config?.hosts !== 'object'
      || !Object.hasOwn(config.hosts, name)
      || !config.hosts[name]) {
      throw new FakeApiError(404, 'NOT_FOUND', `${role} ${name} 不存在`);
    }
    return config.hosts[name];
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
    const home = host.local
      ? '/Users/demo'
      : host.sshInfo.user === 'root'
        ? '/root'
        : `/home/${host.sshInfo.user}`;
    host.web = {
      pid: seed.pid ?? (nextPid += 1),
      port: remotePort,
      startedByUs: true,
      cmdFingerprint: `dsh web --no-open --host 127.0.0.1 --port ${remotePort}`,
      log: `web-${remotePort}.log`,
      startedAt: iso(now() - ageMs),
      workdir: host.config.workdir,
      cwd: host.config.workdir
        ? host.config.workdir.replace(/^~/, home)
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
    settingsFiles.clear();
    dshWorkspaces.clear();
    logs = [];
    revision = 0;
    previewSessionSalt = randomBytes(32);
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
      configuredPort: config.manager.port,
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

  // 收尾回调别叫 then：带 then 的对象一旦被 await 就会被当成 thenable，JS 会拿
  // (resolve, reject) 去调它，这里的回调不认这两个参数，await 就永远不落地。
  function doStop(name, operationId, { action = 'stop', andThen = null } = {}) {
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
      if (andThen) andThen();
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

  function planConfigSync(request) {
    assertSyncRequest(request);
    const { source, targets } = request;
    if (new Set(targets).size !== targets.length) {
      throw new FakeApiError(400, 'VALIDATION', '目标主机不能重复');
    }
    if (targets.includes(source)) {
      throw new FakeApiError(400, 'VALIDATION', '源主机不能同时作为目标主机');
    }

    const profile = syncProfileOf(needConfigHost(source, '源主机'));
    const targetPlans = targets.map((name) => {
      const fields = changedProfileFields(profile, syncProfileOf(needConfigHost(name, '目标主机')));
      return { name, changed: fields.length > 0, changedFields: fields };
    });
    return { source, profile, targets: targetPlans };
  }

  function previewFingerprint(plan) {
    return JSON.stringify(canonicalize({
      source: {
        name: plan.source,
        profile: syncProfileOf(needConfigHost(plan.source, '源主机')),
      },
      targets: plan.targets
        .map(({ name }) => ({
          name,
          profile: syncProfileOf(needConfigHost(name, '目标主机')),
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    }));
  }

  function stalePreview() {
    throw new FakeApiError(
      409,
      'CONFIG_STALE',
      '配置同步预览已过期或无效，请重新预览后再应用',
      '源主机或任一目标主机的同步 profile 可能已变化。',
    );
  }

  function syncHostConfig(request) {
    gate();
    const plan = planConfigSync(request);
    const fingerprint = previewFingerprint(plan);
    if (request.dryRun) {
      return {
        source: plan.source,
        dryRun: true,
        targets: plan.targets,
        applied: [],
        hosts: [],
        previewToken: previewTokenFor(fingerprint, previewSessionSalt),
      };
    }
    if (request.previewToken !== previewTokenFor(fingerprint, previewSessionSalt)) stalePreview();

    // 先验证并组装全部目标的新配置，再统一换入；中途失败时不会留下半单修改。
    const targetHosts = new Map(plan.targets.map(({ name }) => [name, need(name)]));
    const staged = plan.targets
      .filter((target) => target.changed)
      .map(({ name }) => {
        const next = clone(needConfigHost(name, '目标主机'));
        next.remoteWebPort = plan.profile.remoteWebPort;
        next.workdir = plan.profile.workdir;
        next.inject = cloneInject(plan.profile.inject);
        return { name, next };
      });

    for (const { name, next } of staged) {
      config.hosts[name] = clone(next);
      const host = targetHosts.get(name);
      host.config = clone(next);
      host.effectiveRemotePort = host.config.remoteWebPort ?? config.defaults.remoteWebPort;
    }
    for (const { name } of staged) emitHost(name);

    return {
      source: plan.source,
      dryRun: false,
      targets: plan.targets,
      applied: staged.map(({ name }) => name),
      hosts: plan.targets.map(({ name }) => clone(targetHosts.get(name))),
    };
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
        andThen: () => timer(() => doStart(name, operationId, { action: 'restart' }), timing.restartGapMs),
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

  function assertSettingsReachable(host) {
    if (host.phase === 'unreachable') {
      throw new FakeApiError(
        502,
        'SSH_UNREACHABLE',
        `无法通过 SSH 连接主机 ${host.name}`,
      );
    }
  }

  function dshSettingsPath(name, host) {
    const seed = seedOf(name);
    const user = seed?.sshInfo?.user;
    const dshHome = seed?.dsh?.dshHome
      ?? (host.local ? '/Users/demo/.dsh' : user === 'root' ? '/root/.dsh' : `/home/${user}/.dsh`);
    return `${dshHome.replace(/\/+$/u, '')}/settings.yaml`;
  }

  function readDshSettings(name) {
    gate();
    const host = need(name);
    assertSettingsReachable(host);
    const path = dshSettingsPath(name, host);
    if (!settingsFiles.has(name)) {
      return {
        exists: false,
        path,
        content: '',
        checksum: null,
        size: 0,
      };
    }
    const content = settingsFiles.get(name);
    const bytes = encodeSettingsContent(content);
    return {
      exists: true,
      path,
      content,
      checksum: settingsChecksum(bytes),
      size: bytes.byteLength,
    };
  }

  function writeDshSettings(name, request) {
    gate();
    const host = need(name);
    assertSettingsRequest(request);
    const bytes = encodeSettingsContent(request.content);
    assertSettingsReachable(host);
    const path = dshSettingsPath(name, host);
    const currentChecksum = settingsFiles.has(name)
      ? settingsChecksum(encodeSettingsContent(settingsFiles.get(name)))
      : null;
    if (request.baseChecksum !== currentChecksum) {
      throw new FakeApiError(
        409,
        'SETTINGS_STALE',
        'settings.yaml 已变化，请重新 GET 后再保存',
      );
    }
    settingsFiles.set(name, request.content);
    return {
      updated: true,
      path,
      checksum: settingsChecksum(bytes),
      size: bytes.byteLength,
    };
  }

  function registerDshWorkspace(name) {
    gate();
    const host = need(name);
    if (!['running', 'degraded'].includes(host.phase)) {
      throw new FakeApiError(
        409,
        'PHASE_CONFLICT',
        '登记 dsh Workspace 要求主机处于 running/degraded',
      );
    }

    const configuredWorkdir = host.config?.workdir ?? null;
    if (configuredWorkdir === null) {
      throw new FakeApiError(
        400,
        'WORKSPACE_WORKDIR_REQUIRED',
        '请先为主机配置启动目录并重启 dsh web，再登记 Workspace',
      );
    }
    if (host.web?.workdir !== configuredWorkdir) {
      throw new FakeApiError(
        409,
        'PHASE_CONFLICT',
        '启动目录尚未应用到当前实例，请重启此主机的 dsh web 后再登记',
      );
    }

    const cwd = host.web?.cwd;
    if (cwd === null || cwd === undefined || cwd === '') {
      throw new FakeApiError(
        409,
        'WORKSPACE_CWD_UNAVAILABLE',
        '当前 dsh web 的实际工作目录不可用，请重启后再试',
      );
    }
    if (!isAbsolutePath(cwd)) {
      throw new FakeApiError(
        422,
        'WORKSPACE_INVALID_PATH',
        '当前 dsh web 返回的工作目录不是绝对路径，无法登记',
      );
    }

    const path = canonicalWorkspacePath(cwd);
    let hostWorkspaces = dshWorkspaces.get(name);
    if (!hostWorkspaces) {
      hostWorkspaces = new Map();
      dshWorkspaces.set(name, hostWorkspaces);
    }
    const existing = hostWorkspaces.get(path);
    if (existing) return { created: false, ...existing };

    const workspace = {
      workspaceId: uuid(),
      title: workspaceTitle(path),
      path,
    };
    hostWorkspaces.set(path, workspace);
    return { created: true, ...workspace };
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
    return { changed: [], orphaned: [...hosts.values()].filter((host) => host.orphaned).map((host) => host.name) };
  }

  function clearOrphaned() {
    gate();
    const removed = [...hosts.values()]
      .filter((host) => host.orphaned && !host.local)
      .map((host) => host.name);
    for (const name of removed) {
      bumpGen(name);
      hosts.delete(name);
      meta.delete(name);
      delete config.hosts[name];
    }
    return { removed };
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
      configuredPort: config.manager.port,
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
    requireHost: (name) => clone(need(name)),
    // 长动作
    probeAll,
    probeHost,
    startHost,
    stopHost,
    restartHost,
    reconnectHost,
    // 其他 REST
    hostLog,
    readDshSettings,
    writeDshSettings,
    registerDshWorkspace,
    saveHostConfig,
    saveDefaults,
    reload,
    clearOrphaned,
    setup,
    createLocalHost,
    syncHostConfig,
    // SSE
    subscribe,
    // demo 控制
    reset,
    injectTunnelDrop,
    injectCrash,
    get revision() { return revision; },
  };
}
