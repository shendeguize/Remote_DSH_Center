/** 本机 HTTP 面的跨站防线（S1 安全轮）。 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { checkRequestOrigin, hostnameOf, isLoopbackHost } from '../../src/lib/origin-guard.js';

const PORT = 7788;
const check = (headers) => checkRequestOrigin({ headers, port: PORT });

test('Host 里的主机名怎么取', () => {
  assert.equal(hostnameOf('127.0.0.1:7788'), '127.0.0.1');
  assert.equal(hostnameOf('localhost'), 'localhost');
  assert.equal(hostnameOf('LOCALHOST:7788'), 'localhost');
  assert.equal(hostnameOf('[::1]:7788'), '[::1]');
  assert.equal(hostnameOf('  attacker.example:80 '), 'attacker.example');
  assert.equal(hostnameOf(undefined), '');
});

test('只认环回名', () => {
  for (const h of ['127.0.0.1:7788', 'localhost:7788', '[::1]:7788', 'localhost']) {
    assert.equal(isLoopbackHost(h), true, h);
  }
  // 攻击者域名解析到 127.0.0.1（DNS rebinding）后，Host 就是他的域名
  for (const h of ['attacker.example', 'dsh.attacker.example:7788', '127.0.0.1.attacker.example', '']) {
    assert.equal(isLoopbackHost(h), false, h);
  }
});

test('自己页面发的请求放行（带不带 Origin 都算）', () => {
  assert.deepEqual(check({ host: `127.0.0.1:${PORT}` }), { ok: true }, 'CLI 不带 Origin');
  assert.deepEqual(check({ host: `127.0.0.1:${PORT}`, origin: `http://127.0.0.1:${PORT}` }), { ok: true });
  assert.deepEqual(check({ host: `localhost:${PORT}`, origin: `http://localhost:${PORT}` }), { ok: true });
  assert.deepEqual(check({ host: `127.0.0.1:${PORT}`, origin: '' }), { ok: true }, '空 Origin 等于没有');
});

test('别的网站发来的一律 403', () => {
  const cases = [
    'http://evil.example',
    'https://evil.example',
    `https://127.0.0.1:${PORT}`, // 协议不同就不是自己
    `http://127.0.0.1:${PORT + 1}`, // 邻居端口上的另一个服务
    'http://127.0.0.1.evil.example',
    'null', // file:// 与沙箱 iframe
    '不是个 URL',
  ];
  for (const origin of cases) {
    const v = check({ host: `127.0.0.1:${PORT}`, origin });
    assert.equal(v.ok, false, origin);
    assert.equal(v.status, 403);
    assert.equal(v.code, 'FORBIDDEN_ORIGIN', origin);
  }
});

test('Host 不是环回名就 403，且不回显攻击者给的域名', () => {
  const v = check({ host: 'dsh.attacker.example', origin: 'http://dsh.attacker.example' });
  assert.equal(v.ok, false);
  assert.equal(v.status, 403);
  assert.equal(v.code, 'FORBIDDEN_HOST', 'Host 这道闸要先判——rebinding 时 Origin 看着是同源');
  assert.doesNotMatch(v.message, /attacker/, '别把攻击者的域名原样写回响应体');
});

test('大小写与首字母大写的头名都认', () => {
  assert.deepEqual(checkRequestOrigin({ headers: { Host: `127.0.0.1:${PORT}` }, port: PORT }), { ok: true });
  assert.equal(checkRequestOrigin({
    headers: { Host: `127.0.0.1:${PORT}`, Origin: 'http://evil.example' }, port: PORT,
  }).code, 'FORBIDDEN_ORIGIN');
});
