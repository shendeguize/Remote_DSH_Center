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

/**
 * 回归（issue #94）：分配是「读 config 算已占用 → await 试绑 → 回写 config」，
 * 读在 await 之前、写在之后。同时进来两台，两边看到的「已占用」都是旧的，分到同一个号。
 *
 * 真机路径：`runAutoStart`/`recoverState` 现在走 mapPool，一次有 6 台在飞；全新安装
 * 加了几台又开了 autoStart，它们都还没有 localPort，正好一起进分配。
 * 而 localPort 是分配即回写、此后固定的——撞号会被**永久**写进 config，重启也修不回来，
 * 后面那几台的隧道每次都撞 `bind: Address already in use`。
 */
test('并发首次分配不许撞号（issue #94）', async (t) => {
  const names = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  const hosts = Object.fromEntries(names.map((n) => [n, hostCfg()]));
  const { paths } = await fixture(t, hosts, [17701, 17799]);
  // 一次 listen/close 的真实开销量级：正是这段 await 让两台看到同一份旧账
  _setProbe(async () => { await new Promise((r) => { setTimeout(r, 5); }); return true; });

  const got = await Promise.all(names.map((n) => ensureLocalPort(n)));
  assert.equal(new Set(got).size, names.length, `分到的端口不许重复：${got.join(', ')}`);

  const onDisk = JSON.parse(fs.readFileSync(paths.config, 'utf8')).hosts;
  const persisted = names.map((n) => onDisk[n].localPort);
  assert.deepEqual(persisted, got, '回写的和返回的必须是同一份');
  assert.equal(new Set(persisted).size, names.length, '撞号一旦落盘就是永久的，重启也修不回来');
  assert.deepEqual([...got].sort((x, y) => x - y), [17701, 17702, 17703, 17704, 17705, 17706, 17707, 17708]);
});

test('同一台被并发要两次只分一次（issue #94）', async (t) => {
  await fixture(t, { a: hostCfg(), b: hostCfg() });
  _setProbe(async () => { await new Promise((r) => { setTimeout(r, 5); }); return true; });

  const [x, y] = await Promise.all([ensureLocalPort('a'), ensureLocalPort('a')]);
  assert.equal(x, y, '同一台两次要到不同的号，等于把先建的那条隧道的号让出去了');
  assert.equal(await ensureLocalPort('b'), 17702, '也不许白占掉一个号');
});

test('并发分配撞上耗尽：先到的拿满，后到的报 PORT_EXHAUSTED（issue #94）', async (t) => {
  const names = ['a', 'b', 'c', 'd'];
  const hosts = Object.fromEntries(names.map((n) => [n, hostCfg()]));
  await fixture(t, hosts, [17701, 17702]);
  _setProbe(async () => { await new Promise((r) => { setTimeout(r, 5); }); return true; });

  const res = await Promise.allSettled(names.map((n) => ensureLocalPort(n)));
  const ok = res.filter((r) => r.status === 'fulfilled').map((r) => r.value);
  const bad = res.filter((r) => r.status === 'rejected');
  assert.deepEqual([...ok].sort((x, y) => x - y), [17701, 17702], '区间只有两个号，就只能成两台');
  assert.equal(bad.length, 2);
  assert.ok(bad.every((r) => r.reason.code === 'PORT_EXHAUSTED'), '没号了要明说，别让调用方以为分到了');
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
