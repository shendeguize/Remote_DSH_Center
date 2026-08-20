/**
 * 静态资源投递（11 §1 serveStatic + UI-01）：页面与其 ESM 依赖必须真能从 manager 取到，
 * 否则「管理台可见」只是本地文件存在的错觉。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { bootServer } from './helpers.js';

test('GET / 返回页面外壳，且引用的模块与样式都可取', async (t) => {
  const ctx = await bootServer(t);

  const index = await ctx.get('/');
  assert.equal(index.status, 200);
  assert.match(index.headers['content-type'], /text\/html/);
  assert.match(index.text, /<div id="app">/);
  assert.match(index.text, /type="module"/);

  const css = await ctx.get('/style.css');
  assert.equal(css.status, 200);
  assert.match(css.headers['content-type'], /text\/css/);

  const app = await ctx.get('/app.js');
  assert.equal(app.status, 200);
  assert.match(app.headers['content-type'], /javascript/);

  // 声明了图标就必须能取到：缺了会在每次访问留一条 404（真浏览器还会自己去要 /favicon.ico）
  const iconHref = index.text.match(/<link rel="icon" href="([^"]+)"/)?.[1];
  assert.ok(iconHref, '页面应声明 favicon，否则浏览器会去要 /favicon.ico 而吃 404');
  const icon = await ctx.get(iconHref);
  assert.equal(icon.status, 200);
  assert.match(icon.headers['content-type'], /svg/);

  // 页面不硬编码运行期端口（UI-02：一切走同源相对路径）
  const api = await ctx.get('/api.js');
  assert.equal(api.status, 200);
  assert.equal(/127\.0\.0\.1:\d+/.test(api.text), false);

  // app.js 的相对 import 逐个可解析——漏文件会让页面白屏
  const imports = [...app.text.matchAll(/from '\.\/([^']+)'/g)].map((m) => m[1]);
  assert.ok(imports.length >= 5, `app.js 应有多个模块依赖，实得 ${imports.length}`);
  for (const rel of imports) {
    // eslint-disable-next-line no-await-in-loop -- 逐个取，个位数
    const dep = await ctx.get(`/${rel}`);
    assert.equal(dep.status, 200, `/${rel} 应可取`);
  }
});

test('目录穿越被拒，未知路径 404', async (t) => {
  const ctx = await bootServer(t);

  const escaped = await ctx.get('/../defaults.js');
  assert.equal(escaped.status === 403 || escaped.status === 404, true, `实得 ${escaped.status}`);

  const missing = await ctx.get('/nope.js');
  assert.equal(missing.status, 404);
});
