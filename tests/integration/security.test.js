/**
 * 本机 HTTP 面的跨站防线（S1 安全轮，实测取证见 issue #45）。
 *
 * 「只监听 127.0.0.1」挡不住浏览器替别人发请求：用户随便打开一个网页，那个网页就能
 * `fetch('http://127.0.0.1:<port>/api/hosts/x/start', {mode:'no-cors'})`——简单请求不触发
 * 预检，浏览器照发。真浏览器里实测过，一个陌生 origin 的页面把远端会话拉起来了。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { bootServer, waitPhase } from './helpers.js';

test('跨站 Origin 的写操作被拒，且真的没有副作用', async (t) => {
  const ctx = await bootServer(t);
  await ctx.api('POST', '/api/hosts/gpu-1/probe');
  await waitPhase(ctx, 'gpu-1', ['ready']);

  const res = await ctx.api('POST', '/api/hosts/gpu-1/start', undefined, { origin: 'http://evil.example' });
  assert.equal(res.status, 403, `跨站写操作应被拒，实得 ${res.status} ${res.text}`);
  assert.equal(res.json.code, 'FORBIDDEN_ORIGIN');
  assert.match(res.json.error, /拒绝跨站/, '错误体要有一句人话');

  // 拒了就不能留下半个动作：这里才是真正要守的东西
  const after = await ctx.api('GET', '/api/hosts');
  const host = after.json.hosts.find((h) => h.name === 'gpu-1');
  assert.equal(host.phase, 'ready', '被拒的请求居然还是把主机拉起来了');
});

test('Host 头不是环回名就拒（DNS rebinding 的落地形态），静态页也一样', async (t) => {
  const ctx = await bootServer(t);

  for (const p of ['/api/hosts', '/', '/app.js']) {
    // eslint-disable-next-line no-await-in-loop -- 逐条
    const res = await ctx.get(p, { host: 'dsh.attacker.example' });
    assert.equal(res.status, 403, `${p} 应拒非环回 Host，实得 ${res.status}`);
    assert.doesNotMatch(res.text, /attacker/, '别把攻击者的域名原样写回响应体');
  }

  // 拦的是 Host，不是「所有请求」——自己人照常
  assert.equal((await ctx.get('/api/hosts')).status, 200);
  assert.equal((await ctx.get('/api/hosts', { host: `localhost:${new URL(ctx.base).port}` })).status, 200);
});

test('自己页面与命令行都不受影响', async (t) => {
  const ctx = await bootServer(t);
  const port = new URL(ctx.base).port;

  // 页面发的写操作带自己的 Origin
  const own = await ctx.api('POST', '/api/hosts/probe', undefined, { origin: `http://127.0.0.1:${port}` });
  assert.equal(own.status, 202, `同源写操作被误拦：${own.text}`);

  // CLI / curl 不带 Origin
  assert.equal((await ctx.api('POST', '/api/hosts/probe')).status, 202);
});
