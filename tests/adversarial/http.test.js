/**
 * 本机 HTTP 面回放（harness 支柱 D）。
 *
 * 跨站、DNS rebinding、目录穿越、原型污染、setup 门禁绕行——每条语料一次真请求，
 * 双 oracle：
 *   业务码   状态码与 code 逐条对上（403/404/400/409 各有各的语义，不许混）
 *   金丝雀   攻击者提供的串不许出现在响应里（连报错都不许复述攻击者的域名）
 * 再加一层副作用判据：被拒的写操作不许把主机拉起来（`phaseUnchanged`）。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';

import { bootServer, waitPhase } from '../integration/helpers.js';
import { canaryOf, loadCorpus } from './corpus.js';

const corpus = loadCorpus('http');

/** 语料的 entry → 请求头/请求体。加注入点要同时在这里落地。 */
function headersFor(entry) {
  switch (entry.entry) {
    case 'origin': return { origin: entry.payload };
    case 'host': return { host: entry.payload };
    default: return {};
  }
}

/**
 * 原始请求：语料里的 path 可能带非法编码，不能经 URL 归一化，故绕开 helpers 的客户端。
 * @returns {Promise<{status:number, text:string, json:any}>}
 */
function rawRequest(base, { method, path: target, headers = {}, body = null }) {
  const url = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: url.hostname,
      port: url.port,
      path: target,
      method,
      headers: {
        ...(body === null ? {} : {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        }),
        ...headers,
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
    if (body !== null) req.write(body);
    req.end();
  });
}

function bodyFor(entry) {
  const request = entry.request ?? {};
  if (typeof request.rawBody === 'string') return request.rawBody;
  if (request.body !== undefined) return JSON.stringify(request.body);
  return null;
}

async function replay(ctx, entry) {
  const request = entry.request ?? {};
  const res = await rawRequest(ctx.base, {
    method: request.method,
    path: request.path,
    headers: headersFor(entry),
    body: bodyFor(entry),
  });

  if (entry.expect.statusIn) {
    assert.ok(
      entry.expect.statusIn.includes(res.status),
      `${entry.id} 状态码应属 ${entry.expect.statusIn.join('/')}，实得 ${res.status}：${res.text.slice(0, 200)}`,
    );
  } else {
    assert.equal(res.status, entry.expect.status, `${entry.id} 状态码不符：${res.text.slice(0, 200)}`);
  }
  if (entry.expect.code) {
    assert.equal(res.json?.code, entry.expect.code, `${entry.id} 错误码不符：${res.text.slice(0, 200)}`);
  }
  if (res.status >= 400 && res.json !== null) {
    assert.ok(typeof res.json.error === 'string' && res.json.error.length > 0, `${entry.id} 错误体缺人话`);
  }

  const canary = canaryOf(entry);
  if (entry.expect.noReflect && canary) {
    assert.equal(
      res.text.includes(canary),
      false,
      `${entry.id} 把攻击者提供的串原样写回了响应：${res.text.slice(0, 200)}`,
    );
  }
  return res;
}

test('已初始化态：全部 ready 语料逐条回放', async (t) => {
  const ctx = await bootServer(t);
  await ctx.api('POST', '/api/hosts/gpu-1/probe');
  await waitPhase(ctx, 'gpu-1', ['ready']);

  const entries = corpus.filter((entry) => entry.boot === 'ready');
  assert.ok(entries.length >= 8, `ready 语料只有 ${entries.length} 条`);

  for (const entry of entries) {
    // eslint-disable-next-line no-await-in-loop -- 逐条语料串行：共用同一台主机，要能断言副作用
    await replay(ctx, entry);

    if (entry.expect.phaseUnchanged) {
      // eslint-disable-next-line no-await-in-loop -- 同上
      const host = (await ctx.get('/api/hosts')).json.hosts.find((h) => h.name === 'gpu-1');
      assert.equal(host.phase, 'ready', `${entry.id} 被拒的写操作还是留下了副作用（phase=${host.phase}）`);
    }
    if (entry.expect.noPrototypePollution) {
      assert.equal({}.polluted, undefined, `${entry.id} 原型被污染了`);
      assert.equal(Object.prototype.polluted, undefined, `${entry.id} 原型被污染了`);
    }
  }

  // 拦的是攻击形态，不是「所有请求」：自己人照常
  assert.equal((await ctx.get('/api/hosts')).status, 200);
});

test('引导态：setup 门禁语料逐条回放（含放行的白名单反面算例）', async (t) => {
  const ctx = await bootServer(t, { setupCompleted: false });
  const entries = corpus.filter((entry) => entry.boot === 'setup-gate');
  assert.ok(entries.length >= 2, `setup-gate 语料只有 ${entries.length} 条`);
  assert.equal(ctx.setupGate, true, 'boot 出来的应是引导态');

  for (const entry of entries) {
    // eslint-disable-next-line no-await-in-loop -- 逐条
    await replay(ctx, entry);
  }
});
