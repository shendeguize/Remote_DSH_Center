/**
 * 本机集成测试脚手架（14 §3）：把 manager 整机跑在进程内，远端换成假装置。
 *
 * 单进程内模块是单例，故每次 boot 前后都要把 store/tunnel/bus/队列 显式复位——
 * 否则跨用例串味（上一例的 phase 会让下一例的 preflight 失败）。
 */

import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { createHarness, newHostState } from '../harness/index.js';
import { assertSseStream, assertShape, errorBody } from '../contract/schemas.js';
import { CONFIG_VERSION } from '../../src/defaults.js';

import * as bus from '../../src/lib/bus.js';
import * as ssh from '../../src/lib/ssh.js';
import * as store from '../../src/store.js';
import * as tunnel from '../../src/tunnel.js';
import * as launcher from '../../src/launcher.js';
import * as ports from '../../src/ports.js';
import * as monitor from '../../src/monitor.js';
import * as server from '../../src/server.js';

export { store, tunnel, launcher, monitor, server, bus };

/** 假远端的启动轮询无需真等 1s + 2s。 */
const FAST_WAIT = (ms) => new Promise((r) => { const t = setTimeout(r, Math.min(ms, 30)); t.unref?.(); });

/**
 * 端口分段：测试文件各自一个进程并行跑，若都从内核借临时端口（49152+）会互相撞——
 * 借到手与真正 bind 之间有窗口，且区间会重叠。改为切出互不重叠的固定段：
 * 本机映射端口一段、假 dsh web 的「远端」端口另一段。
 *
 * 段号**必须真的互斥地占下来**，不能用 `pid % 槽数` 算。pid 取模只是「大概率不同」：
 * 两个同时在跑的测试文件，pid 差正好是槽数的整数倍时就会算出同一段，然后抢同一批
 * 本机端口，表现是某个用例偶发「端口已被占用 → 拉起失败」。文件越多、跑得越久，
 * 撞上的机会越大——这类假红最费人，因为它只在满负载的整套跑里出现，单跑必绿。
 *
 * 段还**必须整体落在临时端口区之下**（见 EPHEMERAL_FLOOR）。互斥只挡得住测试进程
 * 之间的互抢；一旦某个段落进内核的临时端口区，内核就可能把同一个端口发给任何人——
 * 包括另一个测试自己的 `--port 0` 降级重拉。`portFree()` 探完到真正 bind 之间有窗口，
 * 探测再勤也堵不上。原来 remote 段最高摸到 58994，在 macOS（临时端口从 49152 起）上
 * 意味着 184 号往后的段全泡在临时区里，于是「固定端口路径」偶发被降级成 `--port 0`，
 * 断言 actualPort 即约定端口的用例就红了（真出现过：期望 55050，实得 55101）。
 */

// Linux 默认 32768 起、macOS 49152 起，取更小的那个当红线，两边都安全。
const EPHEMERAL_FLOOR = 32_768;
const SLOT_WIDTH = 50;
// 两段各占 SLOT_COUNT * SLOT_WIDTH，全部塞在 20000..EPHEMERAL_FLOOR 之间。
// 120 段远够用：并发上限是 node --test 的 availableParallelism（本机 14、CI 更少）。
const SLOT_COUNT = 120;
const SLOT_DIR = path.join(os.tmpdir(), 'dshc-test-slots');

/** 原子地占一个段号；进程退出时归还。占用者死了的段算空闲（防崩溃后泄漏）。 */
function claimSlot() {
  fs.mkdirSync(SLOT_DIR, { recursive: true });
  const start = process.pid % SLOT_COUNT;
  for (let i = 0; i < SLOT_COUNT; i += 1) {
    const slot = (start + i) % SLOT_COUNT;
    const file = path.join(SLOT_DIR, String(slot));
    try {
      fs.writeFileSync(file, String(process.pid), { flag: 'wx' }); // wx = 原子占位
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (!ownerAlive(file)) {
        fs.rmSync(file, { force: true }); // 前任崩了，回收后让下一轮重试这个段
        i -= 1;
      }
      continue;
    }
    process.on('exit', () => fs.rmSync(file, { force: true }));
    return slot;
  }
  throw new Error(`${SLOT_COUNT} 个测试端口段全被占着——是不是有一堆测试进程没退干净？`);
}

function ownerAlive(file) {
  let pid;
  try {
    pid = Number.parseInt(fs.readFileSync(file, 'utf8'), 10);
  } catch {
    return false; // 读不到（刚被别人回收）就当空闲，下一轮会重新竞争
  }
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0); // 只探活，不发信号
    return true;
  } catch (error) {
    return error.code === 'EPERM'; // 存在但不归我管，仍算活着
  }
}

const LOCAL_ORIGIN = 20_000;
const REMOTE_ORIGIN = LOCAL_ORIGIN + SLOT_COUNT * SLOT_WIDTH; // 26000
const LOCAL_RANGE_WIDTH = 45; // < SLOT_WIDTH，段与段之间留 5 个空档

/** 两段合起来能摸到的最高端口——必须始终低于 EPHEMERAL_FLOOR，有用例钉着。 */
export const PORT_PLAN = Object.freeze({
  ephemeralFloor: EPHEMERAL_FLOOR,
  slotCount: SLOT_COUNT,
  localOrigin: LOCAL_ORIGIN,
  remoteOrigin: REMOTE_ORIGIN,
  ceiling: REMOTE_ORIGIN + (SLOT_COUNT - 1) * SLOT_WIDTH + LOCAL_RANGE_WIDTH - 1,
});

// 开跑就查，别等某个用例偶发红了才回头找：段一旦探进临时端口区，失败会以「随机某个
// 用例偶尔红一次」的形态出现，最难查。
if (PORT_PLAN.ceiling >= EPHEMERAL_FLOOR) {
  throw new Error(
    `测试端口段最高摸到 ${PORT_PLAN.ceiling}，已探进临时端口区（${EPHEMERAL_FLOOR}+）：`
    + '内核会把同一个端口发给别人，固定端口路径会偶发被降级。请调小 SLOT_COUNT 或下移起点。',
  );
}

const SLOT = claimSlot();
const LOCAL_BASE = LOCAL_ORIGIN + SLOT * SLOT_WIDTH;
const REMOTE_BASE = REMOTE_ORIGIN + SLOT * SLOT_WIDTH;

let remoteCursor = 0;

function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}

/** 本段内取下一个空闲端口给假 dsh web 用。 */
async function nextRemotePort() {
  for (let i = 0; i < 50; i += 1) {
    const port = REMOTE_BASE + (remoteCursor % 45);
    remoteCursor += 1;
    // eslint-disable-next-line no-await-in-loop -- 顺序探测
    if (await portFree(port)) return port;
  }
  throw new Error(`测试端口段 ${REMOTE_BASE} 已无空闲端口`);
}

/**
 * @param {import('node:test').TestContext} t
 * @param {{hosts?:Record<string,object>, hostConfig?:Record<string,object>,
 *   defaults?:object, setupCompleted?:boolean, skipBoot?:boolean, quiet?:boolean,
 *   state?:object, localPortRange?:[number,number]}} [opts]
 */
export async function bootServer(t, opts = {}) {
  const {
    hosts = { 'gpu-1': newHostState() },
    hostConfig = {},
    setupCompleted = true,
    skipBoot = false,
    quiet = true,
    state = null,
    localPortRange = null,
  } = opts;

  const range = localPortRange ?? [LOCAL_BASE, LOCAL_BASE + LOCAL_RANGE_WIDTH];

  if (quiet) {
    t.mock.method(console, 'log', () => {});
    t.mock.method(console, 'warn', () => {});
  }

  const harness = createHarness({ hosts });
  const restore = harness.activate();

  const cfgHosts = {};
  for (const name of Object.keys(hosts)) {
    cfgHosts[name] = {
      enabled: true,
      autoStart: false,
      localPort: null,
      // 每台主机一个独占端口：假 dsh web 真的在本机 bind，同端口会互相 EADDRINUSE，
      // 还会被误判成「端口被占降级」路径
      // eslint-disable-next-line no-await-in-loop -- 逐台取一个，数量个位数
      remoteWebPort: await nextRemotePort(),
      workdir: null,
      inject: { env: {}, extraArgs: [], patches: [] },
      ...(hostConfig[name] ?? {}),
    };
  }

  fs.writeFileSync(path.join(harness.homeDir, 'config.json'), `${JSON.stringify({
    configVersion: CONFIG_VERSION,
    setupCompleted,
    // 实际监听端口由 portOverride=0 决定（临时端口），此处只满足 schema
    manager: { port: 7788 },
    defaults: { remoteWebPort: 8899, localPortRange: range, ...(opts.defaults ?? {}) },
    hosts: cfgHosts,
  }, null, 2)}\n`);

  if (state) {
    fs.writeFileSync(path.join(harness.homeDir, 'state.json'), `${JSON.stringify(state, null, 2)}\n`);
  }

  reset();
  launcher._setWait(FAST_WAIT);

  const sseClients = [];

  const ctx = {
    harness,
    port: null,
    base: '',
    setupGate: false,
    hostNames: Object.keys(cfgHosts),
    remotePortOf: (name) => cfgHosts[name].remoteWebPort,
    api: (method, p, body, headers) => request(ctx.base, method, p, body, headers),
    get: (p, headers) => request(ctx.base, 'GET', p, undefined, headers),
    async sse() {
      const c = await openSse(ctx.base);
      sseClients.push(c);
      return c;
    },
    /** 模拟 manager 重启：拆服务（隧道子进程随之被杀）→ 复位单例 → 重跑启动序列。 */
    async reboot() {
      for (const c of sseClients.splice(0)) {
        assertSseStream(c.frames, { label: 'SSE(重启前)' });
        c.close();
      }
      await server._shutdownForTest();
      reset();
      launcher._setWait(FAST_WAIT);
      return start();
    },
    /** 调用方已用 _shutdownForTest 拆服后，在原监听端口重跑启动序列。 */
    async startSamePort() {
      const port = ctx.port;
      reset();
      launcher._setWait(FAST_WAIT);
      return start(port);
    },
  };

  async function start(portOverride = 0) {
    const booted = await server.main({ portOverride, skipBoot });
    ctx.port = booted.port;
    ctx.base = `http://127.0.0.1:${booted.port}`;
    ctx.setupGate = booted.setupGate;
    return booted;
  }

  await start();

  t.after(async () => {
    // 回收必须无条件发生：契约校验一抛，后面的清理若被跳过，假 dsh web 就成了孤儿
    try {
      // 契约校验（TST-05）：本用例收到的每一帧都必须过 13 章的校验器
      for (const [i, c] of sseClients.entries()) {
        assertSseStream(c.frames, { label: `SSE#${i}` });
        c.close();
      }
    } finally {
      for (const c of sseClients) c.close();
      await server._shutdownForTest();
      reset();
      launcher._setWait(null);
      harness.cleanup();
      restore();
    }
  });

  return ctx;
}

function reset() {
  store._reset();
  tunnel._reset();
  monitor.stopLoop();
  ssh._resetQueues();
  bus._resetForTest();
  ports._setProbe(null);
}

// ── HTTP 客户端 ──────────────────────────────────────────────────────────

/** @returns {Promise<{status:number, headers:object, text:string, json:any}>} */
export function request(base, method, p, body, extraHeaders = {}) {
  const url = new URL(p, base);
  const payload = body === undefined ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers: {
        ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
        ...extraHeaders,
      },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
        // 错误体的形状是全端点统一契约（13 §1.1），无需用例逐个声明即可自动校验
        if (res.statusCode >= 400 && json !== null) {
          assertShape(errorBody, json, `${method} ${p} 错误体`);
        }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** 裸 HTTP GET（隧道连通性验证用：目标是假 dsh web，不是 manager）。 */
export function fetchText(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject);
  });
}

// ── SSE 客户端（手写分帧解析器，CLI 侧 §6.2 同款） ───────────────────────

export function openSse(base) {
  const url = new URL('/api/events', base);
  return new Promise((resolve, reject) => {
    const req = http.get({ host: url.hostname, port: url.port, path: url.pathname }, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`SSE 连接失败 ${res.statusCode}`));
        return;
      }
      const frames = [];
      const waiters = new Set();
      let buffer = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buffer += chunk;
        let idx = buffer.indexOf('\n\n');
        while (idx !== -1) {
          const raw = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const frame = parseFrame(raw);
          if (frame) {
            frames.push(frame);
            for (const w of [...waiters]) {
              if (w.match(frame)) {
                waiters.delete(w);
                w.resolve(frame);
              }
            }
          }
          idx = buffer.indexOf('\n\n');
        }
      });

      resolve({
        frames,
        of: (type) => frames.filter((f) => f.type === type),
        /** @param {(f:{type:string,data:any})=>boolean} match */
        wait(match, { timeoutMs = 20_000 } = {}) {
          const hit = frames.find(match);
          if (hit) return Promise.resolve(hit);
          return new Promise((res2, rej2) => {
            const w = { match, resolve: res2 };
            waiters.add(w);
            const timer = setTimeout(() => {
              waiters.delete(w);
              rej2(new Error(`SSE 等待超时 ${timeoutMs}ms；已收到：${frames.map((f) => f.type).join(',')}`));
            }, timeoutMs);
            timer.unref?.();
          });
        },
        close() {
          req.destroy();
          res.destroy();
        },
      });
    });
    req.on('error', reject);
  });
}

function parseFrame(raw) {
  let type = 'message';
  const dataLines = [];
  for (const line of raw.split('\n')) {
    if (line.startsWith(':')) continue; // 心跳注释
    if (line.startsWith('event:')) type = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
  }
  if (dataLines.length === 0) return null;
  try {
    return { type, data: JSON.parse(dataLines.join('\n')) };
  } catch {
    return null;
  }
}

// ── 轮询断言 ─────────────────────────────────────────────────────────────

/** 等某主机进入目标 phase（比 SSE 更适合「不关心中间过程」的断言）。 */
export async function waitPhase(ctx, name, phases, { timeoutMs = 20_000 } = {}) {
  const want = Array.isArray(phases) ? phases : [phases];
  const deadline = Date.now() + timeoutMs;
  let last = null;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop -- 轮询
    const res = await ctx.get('/api/hosts');
    last = res.json.hosts.find((h) => h.name === name);
    if (last && want.includes(last.phase)) return last;
    if (Date.now() > deadline) {
      throw new Error(`等待 ${name} 进入 ${want.join('/')} 超时，当前 ${last?.phase}`);
    }
    // eslint-disable-next-line no-await-in-loop -- 同上
    await new Promise((r) => { const t = setTimeout(r, 50); t.unref?.(); });
  }
}

export { newHostState };
