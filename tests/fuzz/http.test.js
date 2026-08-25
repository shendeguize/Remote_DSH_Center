/**
 * 目标 5：本机 HTTP 写入面（真 manager，真 server，假远端）。
 *
 * 这是唯一「外面能打进来」的面：浏览器页面、CLI、以及任何跑在这台机器上的进程都能
 * 往这些端点发东西。随机 body 打过去，要盯的不是「拒得对不对」（那是 §契约用例的活），
 * 而是**任何输入都不许把 manager 打坏**：
 *
 *   不许 5xx        500 就是可复现的拒绝服务；随机 body 能打出 500 是真事故
 *   拒绝要说人话     ≥400 必须带 code 与非空 error，否则用户只看到一个数字
 *   拒了不许有副作用  被拒的写入不许改 phase、不许把主机拉起来
 *   进程不许被带走    每例之后 manager 必须还能正常应答（GET /api/hosts 200）
 *   原型不许被污染    随机键里 `__proto__` / `constructor` 是常客
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';

import { bootServer, waitPhase } from '../integration/helpers.js';
import { ALPHABETS } from './prng.js';
import { runFuzzTarget } from './runner.js';

const HOST = 'gpu-1';

/** 写入面端点表。加端点要同时在这里登记，否则新面不会被随机 body 碰到。 */
const ENDPOINTS = Object.freeze([
  { id: 'host-config', method: 'PUT', path: `/api/hosts/${HOST}/config` },
  { id: 'defaults', method: 'PUT', path: '/api/config/defaults' },
  { id: 'local-host', method: 'POST', path: '/api/hosts/local' },
  { id: 'sync-config', method: 'POST', path: '/api/hosts/sync-config' },
  { id: 'dsh-settings', method: 'PUT', path: `/api/hosts/${HOST}/dsh-settings` },
  { id: 'dsh-workspace', method: 'POST', path: `/api/hosts/${HOST}/dsh-workspace` },
  { id: 'setup', method: 'POST', path: '/api/setup' },
]);

/**
 * 允许的状态码。刻意不含任何 5xx，也不含 3xx（这些端点不该重定向）。
 * 401/402 一类也不在——本机服务没有认证层，出现就说明有人加了没登记的行为。
 *
 * 2xx 在这里是**允许**而非期望：随机 body 偶尔真的合法（`POST /api/hosts/local`
 * 的合法体就是 `{}`），那时候该成功就成功。这个目标判的是「不许被打坏」，不是「必须被拒」。
 */
const ALLOWED_STATUS = Object.freeze(new Set([200, 201, 204, 400, 403, 404, 405, 409, 413, 415, 422]));

const HOSTILE_KEYS = Object.freeze([
  '__proto__', 'constructor', 'prototype', 'toString',
  'enabled', 'autoStart', 'localPort', 'remoteWebPort', 'workdir', 'inject', 'local',
  'env', 'extraArgs', 'patches', 'content', 'baseChecksum', 'name', 'source', 'targets',
  'dryRun', 'previewToken', 'manager', 'port', 'defaults', 'localPortRange', 'hosts',
  'configVersion', 'setupCompleted',
]);

function gen(rng) {
  // 记端点 id 而不是下标：端点表会增删，存下标会让历史语料悄悄改打别的端点
  const endpoint = rng.pick(ENDPOINTS).id;
  // 一成走「非 JSON 原始体」：body 读取与解析那一层也在攻击面上
  const raw = rng.bool(0.1) ? rawBody(rng) : null;
  return {
    endpoint,
    raw,
    body: raw === null ? randomJson(rng, 0) : null,
    contentType: rng.pickWeighted([
      [8, 'application/json'],
      [1, 'text/plain'],
      [1, ''],
    ]),
  };
}

function rawBody(rng) {
  return rng.pickWeighted([
    [3, () => rng.nasty({ min: 0, max: 40, alphabet: ALPHABETS.json })],
    [2, () => '{'.repeat(rng.int(1, 200))],
    [2, () => `{"a":${'['.repeat(rng.int(1, 200))}`],
    [1, () => ''],
    [1, () => 'null'],
    [1, () => `"${'x'.repeat(rng.int(1, 4_000))}"`],
  ])();
}

async function check(input, ctx) {
  const endpoint = ENDPOINTS.find((e) => e.id === input.endpoint);
  assert.ok(endpoint, `语料引用了已不存在的端点 ${JSON.stringify(input.endpoint)}：删端点要同时处理语料`);
  const payload = input.raw === null ? JSON.stringify(input.body) : input.raw;
  const res = await rawRequest(ctx.base, {
    method: endpoint.method,
    path: endpoint.path,
    body: payload,
    contentType: input.contentType,
  });

  assert.ok(
    ALLOWED_STATUS.has(res.status),
    `${endpoint.id} 回了不该出现的状态码 ${res.status}：${res.text.slice(0, 300)}`,
  );
  if (res.status >= 400) {
    assert.notEqual(res.json, null, `${endpoint.id} 的 ${res.status} 不是 JSON 体：${res.text.slice(0, 200)}`);
    assert.equal(typeof res.json.code, 'string', `${endpoint.id} 的错误体缺 code`);
    assert.ok(res.json.code.length > 0, `${endpoint.id} 的 code 是空串`);
    assert.equal(typeof res.json.error, 'string', `${endpoint.id} 的错误体缺 error`);
    assert.ok(res.json.error.length > 0, `${endpoint.id} 的 error 是空串`);
  }

  assert.equal({}.polluted, undefined, `${endpoint.id} 之后原型被污染了`);
  assert.equal(Object.prototype.polluted, undefined, `${endpoint.id} 之后原型被污染了`);
  assert.equal(typeof {}.toString, 'function', `${endpoint.id} 顶掉了 Object.prototype.toString`);

  // manager 还活着，且被拒的写入没有把主机拉起来
  const hosts = await ctx.get('/api/hosts');
  assert.equal(hosts.status, 200, `${endpoint.id} 之后 manager 不应答了`);
  const host = hosts.json.hosts.find((h) => h.name === HOST);
  assert.equal(host?.phase, 'ready', `${endpoint.id} 被拒后主机 phase 变成了 ${host?.phase}`);
}

/** 绕开 helpers 的客户端：要能发非法 JSON、错的 content-type 与空体。 */
function rawRequest(base, {
  method, path: target, body, contentType,
}) {
  const url = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: url.hostname,
      port: url.port,
      path: target,
      method,
      headers: {
        'content-length': Buffer.byteLength(body),
        ...(contentType === '' ? {} : { 'content-type': contentType }),
      },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(text);
        } catch { json = null; }
        resolve({ status: res.statusCode, text, json });
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── 随机 JSON ───────────────────────────────────────────────────────────

const MAX_DEPTH = 4;

function randomJson(rng, depth) {
  if (depth >= MAX_DEPTH) return leaf(rng);
  return rng.pickWeighted([
    [4, () => leaf(rng)],
    [4, () => randomObject(rng, depth)],
    [2, () => randomArray(rng, depth)],
  ])();
}

function leaf(rng) {
  return rng.pickWeighted([
    [3, () => rng.nasty({ max: 12, alphabet: ALPHABETS.json })],
    [2, () => rng.int(-70_000, 70_000)],
    [1, () => rng.float() * 1e9],
    [2, () => rng.bool()],
    [2, () => null],
  ])();
}

function randomObject(rng, depth) {
  const obj = {};
  for (let i = 0; i < rng.int(0, 5); i += 1) {
    const key = rng.bool(0.7) ? rng.pick(HOSTILE_KEYS) : rng.string({ min: 0, max: 6 });
    const value = randomJson(rng, depth + 1);
    if (key === '__proto__') {
      // 直接赋值会去改原型而不是加自有属性，那就测不到「字段名叫 __proto__」这件事
      Object.defineProperty(obj, key, {
        value, enumerable: true, configurable: true, writable: true,
      });
    } else {
      obj[key] = value;
    }
  }
  return obj;
}

function randomArray(rng, depth) {
  return Array.from({ length: rng.int(0, 5) }, () => randomJson(rng, depth + 1));
}

async function setup(t) {
  const ctx = await bootServer(t);
  await ctx.api('POST', `/api/hosts/${HOST}/probe`);
  await waitPhase(ctx, HOST, ['ready']);
  return ctx;
}

test('fuzz：HTTP 写入面（不许 5xx / 拒绝说人话 / 无副作用 / 不污染原型）', async (t) => {
  const stats = await runFuzzTarget(t, {
    target: 'http-body', gen, check, setup, minCorpus: 4,
  });
  assert.ok(stats.corpus + stats.generated > 0, '一个例子都没跑');
});
