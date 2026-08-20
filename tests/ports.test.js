import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import * as store from '../src/store.js';
import { ensureLocalPort, isFree, _setProbe } from '../src/ports.js';
import { CONFIG_VERSION, resolvePaths } from '../src/defaults.js';
import { _resetForTest } from '../src/lib/bus.js';

const hostCfg = (localPort = null) => ({
  enabled: true, autoStart: false, localPort, remoteWebPort: null,
  inject: { env: {}, extraArgs: [], patches: [] },
});

async function fixture(t, hosts, range = [17701, 17705]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-ports-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    configVersion: CONFIG_VERSION,
    setupCompleted: true,
    manager: { port: 7788 },
    defaults: { remoteWebPort: 8899, localPortRange: range },
    hosts,
  }));
  const paths = resolvePaths({ DSHC_HOME: dir }, os.homedir());
  t.mock.method(console, 'log', () => {});
  t.after(() => {
    store._reset();
    _resetForTest();
    _setProbe((port) => new Promise((resolve) => {
      const srv = net.createServer();
      srv.once('error', () => resolve(false));
      srv.once('listening', () => srv.close(() => resolve(true)));
      srv.listen(port, '127.0.0.1');
    }));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await store.init({ pathsOverride: paths });
  return { paths };
}

test('config 已有 localPort → 直接返回，不重新分配', async (t) => {
  const { paths } = await fixture(t, { a: hostCfg(17750) });
  _setProbe(() => { throw new Error('不应探测'); });
  assert.equal(await ensureLocalPort('a'), 17750);
  assert.equal(JSON.parse(fs.readFileSync(paths.config, 'utf8')).hosts.a.localPort, 17750);
});

test('区间内取第一个可用端口并回写 config', async (t) => {
  const { paths } = await fixture(t, { a: hostCfg() });
  _setProbe(async () => true);

  assert.equal(await ensureLocalPort('a'), 17701);
  assert.equal(JSON.parse(fs.readFileSync(paths.config, 'utf8')).hosts.a.localPort, 17701);
});

test('跳过 config 已占用的端口', async (t) => {
  await fixture(t, { a: hostCfg(17701), b: hostCfg(17702), c: hostCfg() });
  _setProbe(async () => true);
  assert.equal(await ensureLocalPort('c'), 17703);
});

test('跳过本机已监听的端口', async (t) => {
  await fixture(t, { a: hostCfg() });
  const busy = new Set([17701, 17702]);
  _setProbe(async (port) => !busy.has(port));
  assert.equal(await ensureLocalPort('a'), 17703);
});

test('区间耗尽 → PORT_EXHAUSTED，detail 列出已占用', async (t) => {
  await fixture(t, {
    a: hostCfg(17701), b: hostCfg(17702), c: hostCfg(17703),
    d: hostCfg(17704), e: hostCfg(17705), f: hostCfg(),
  });
  _setProbe(async () => true);

  await assert.rejects(
    () => ensureLocalPort('f'),
    (err) => {
      assert.equal(err.code, 'PORT_EXHAUSTED');
      assert.match(err.message, /17701-17705 已耗尽/);
      assert.match(err.detail, /17701, 17702, 17703, 17704, 17705/);
      return true;
    },
  );
});

test('本机全部监听时也报耗尽', async (t) => {
  await fixture(t, { a: hostCfg() });
  _setProbe(async () => false);
  await assert.rejects(() => ensureLocalPort('a'), (e) => e.code === 'PORT_EXHAUSTED');
});

test('未知主机 → NOT_FOUND', async (t) => {
  await fixture(t, { a: hostCfg() });
  await assert.rejects(() => ensureLocalPort('nope'), (e) => e.code === 'NOT_FOUND');
});

test('多主机连续分配互不冲突', async (t) => {
  await fixture(t, { a: hostCfg(), b: hostCfg(), c: hostCfg() });
  _setProbe(async () => true);
  assert.equal(await ensureLocalPort('a'), 17701);
  assert.equal(await ensureLocalPort('b'), 17702);
  assert.equal(await ensureLocalPort('c'), 17703);
});

test('isFree 真实探测：被占端口返回 false', async (t) => {
  await fixture(t, { a: hostCfg() });
  const srv = net.createServer();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  t.after(() => srv.close());

  assert.equal(await isFree(port), false);

  // 「空闲端口」得由内核给：port+1 可能正被并行的用例占着，那样断言会假红
  const scout = net.createServer();
  await new Promise((r) => scout.listen(0, '127.0.0.1', r));
  const freed = scout.address().port;
  await new Promise((r) => scout.close(r));
  assert.equal(await isFree(freed), true);
});
