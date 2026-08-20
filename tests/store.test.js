import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as store from '../src/store.js';
import { CONFIG_VERSION, resolvePaths } from '../src/defaults.js';
import { bus, _resetForTest } from '../src/lib/bus.js';

function fixture(t, { config, state } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-store-'));
  if (config !== undefined) {
    fs.writeFileSync(path.join(dir, 'config.json'), typeof config === 'string' ? config : JSON.stringify(config, null, 2));
  }
  if (state !== undefined) {
    fs.writeFileSync(path.join(dir, 'state.json'), typeof state === 'string' ? state : JSON.stringify(state, null, 2));
  }
  const paths = resolvePaths({ DSHC_HOME: dir }, os.homedir());
  t.after(() => {
    store._reset();
    _resetForTest();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const silence = (fn) => fn;
  silence(t.mock.method(console, 'log', () => {}));
  silence(t.mock.method(console, 'warn', () => {}));
  silence(t.mock.method(console, 'error', () => {}));
  return { dir, paths };
}

const fullConfig = (extra = {}) => ({
  configVersion: CONFIG_VERSION,
  setupCompleted: true,
  manager: { port: 7788 },
  defaults: { remoteWebPort: 8899, localPortRange: [17701, 17799] },
  hosts: {
    'gpu-1': {
      enabled: true,
      autoStart: false,
      localPort: 17701,
      remoteWebPort: null,
      inject: { env: {}, extraArgs: [], patches: [] },
    },
  },
  ...extra,
});

test('config 不存在 → 出厂默认 + setupCompleted false', async (t) => {
  const { paths } = fixture(t);
  const r = await store.init({ pathsOverride: paths });
  assert.equal(r.fresh, true);
  assert.equal(store.isSetupCompleted(), false);
  assert.equal(store.getConfig().manager.port, 7788);
});

test('config 非法 JSON → 拒绝启动（不静默兜底）', async (t) => {
  const { paths } = fixture(t, { config: '{ not json' });
  await assert.rejects(
    () => store.init({ pathsOverride: paths }),
    (e) => e.code === 'VALIDATION' && /不是合法 JSON/.test(e.message),
  );
});

test('config 校验失败 → 拒绝启动，detail 列出错误路径', async (t) => {
  const bad = fullConfig();
  bad.defaults.localPortRange = [17799, 17701];
  const { paths } = fixture(t, { config: bad });
  await assert.rejects(
    () => store.init({ pathsOverride: paths }),
    (e) => e.code === 'VALIDATION' && /range start must be <= end/.test(e.detail),
  );
});

test('缺 configVersion 视为 1 并补齐默认字段后落盘', async (t) => {
  const partial = { setupCompleted: true, manager: {}, hosts: { a: { enabled: false } } };
  const { paths } = fixture(t, { config: partial });
  await store.init({ pathsOverride: paths });

  const cfg = store.getConfig();
  assert.equal(cfg.configVersion, CONFIG_VERSION);
  assert.equal(cfg.manager.port, 7788);
  assert.equal(cfg.defaults.remoteWebPort, 8899);
  assert.equal(cfg.hosts.a.enabled, false, '用户给的值保留');
  assert.equal(cfg.hosts.a.autoStart, false, '缺的字段补默认');
  assert.deepEqual(cfg.hosts.a.inject, { env: {}, extraArgs: [], patches: [] });

  const onDisk = JSON.parse(fs.readFileSync(paths.config, 'utf8'));
  assert.equal(onDisk.configVersion, CONFIG_VERSION, '迁移结果已回写');
});

test('configVersion 高于本程序 → fatal 拒启', async (t) => {
  const { paths } = fixture(t, { config: fullConfig({ configVersion: 99 }) });
  await assert.rejects(
    () => store.init({ pathsOverride: paths }),
    (e) => e.code === 'VALIDATION' && /高于本程序支持/.test(e.message),
  );
});

test('state 解析失败 → 改名留证 + 空 state 启动', async (t) => {
  const { paths, dir } = fixture(t, { config: fullConfig(), state: 'broken{' });
  await store.init({ pathsOverride: paths });

  assert.equal(store.getPhase('gpu-1'), 'unknown');
  const leftovers = fs.readdirSync(dir).filter((f) => f.includes('state.json.corrupt.'));
  assert.equal(leftovers.length, 1, '原文件被留证');
});

test('state 中非法主机条目被丢弃，合法条目保留', async (t) => {
  const { paths } = fixture(t, {
    config: fullConfig(),
    state: { hosts: { 'gpu-1': { phase: 'running' }, bogus: { phase: 'nonsense' } } },
  });
  await store.init({ pathsOverride: paths });
  assert.equal(store.getPhase('gpu-1'), 'running');
  assert.equal(store.getHostState('bogus'), null);
});

test('启动时清理上次崩溃残留的 *.tmp.<pid>', async (t) => {
  const { paths, dir } = fixture(t, { config: fullConfig() });
  fs.writeFileSync(path.join(dir, 'state.json.tmp.99999'), 'garbage');
  await store.init({ pathsOverride: paths });
  assert.equal(fs.existsSync(path.join(dir, 'state.json.tmp.99999')), false);
});

test('原子写：config 立即落盘且内容完整', async (t) => {
  const { paths } = fixture(t, { config: fullConfig() });
  await store.init({ pathsOverride: paths });

  store.updateConfig((d) => { d.hosts['gpu-1'].autoStart = true; });
  const onDisk = JSON.parse(fs.readFileSync(paths.config, 'utf8'));
  assert.equal(onDisk.hosts['gpu-1'].autoStart, true);
});

test('updateConfig 校验失败 → 放弃写入，内存与磁盘均不变', async (t) => {
  const { paths } = fixture(t, { config: fullConfig() });
  await store.init({ pathsOverride: paths });

  assert.throws(
    () => store.updateConfig((d) => { d.manager.port = 99_999; }),
    (e) => e.code === 'VALIDATION',
  );
  assert.equal(store.getConfig().manager.port, 7788);
  assert.equal(JSON.parse(fs.readFileSync(paths.config, 'utf8')).manager.port, 7788);
});

test('getConfig 返回深冻结快照', async (t) => {
  const { paths } = fixture(t, { config: fullConfig() });
  await store.init({ pathsOverride: paths });
  const cfg = store.getConfig();
  assert.throws(() => { cfg.manager.port = 1; }, TypeError);
  assert.throws(() => { cfg.hosts['gpu-1'].inject.extraArgs.push('x'); }, TypeError);
});

test('state 写入 100ms debounce 合并，flushStateSync 立即落盘', async (t) => {
  const { paths } = fixture(t, { config: fullConfig() });
  await store.init({ pathsOverride: paths });
  t.mock.timers.enable({ apis: ['setTimeout'] });

  store.mutateHostState('gpu-1', (e) => { e.web = { pid: 1 }; });
  store.mutateHostState('gpu-1', (e) => { e.web = { pid: 2 }; });
  assert.equal(fs.existsSync(paths.state), false, 'debounce 窗口内不落盘');

  t.mock.timers.tick(100);
  const written = JSON.parse(fs.readFileSync(paths.state, 'utf8'));
  assert.equal(written.hosts['gpu-1'].web.pid, 2, '窗口内多次写只落最后一次');

  store.mutateHostState('gpu-1', (e) => { e.web = { pid: 3 }; });
  store.flushStateSync();
  assert.equal(JSON.parse(fs.readFileSync(paths.state, 'utf8')).hosts['gpu-1'].web.pid, 3);
});

test('setPhase 守卫非法迁移：抛错且状态零改动', async (t) => {
  const { paths } = fixture(t, { config: fullConfig() });
  await store.init({ pathsOverride: paths });

  assert.equal(store.setPhase('gpu-1', 'ready', 'test'), 'ready');
  assert.throws(
    () => store.setPhase('gpu-1', 'running', 'test'),
    (e) => e.code === 'STATE_ILLEGAL_TRANSITION',
  );
  assert.equal(store.getPhase('gpu-1'), 'ready', '非法迁移不改状态');
});

test('事件发射：setPhase/mutateHostState/updateConfig 各自触发 host-changed', async (t) => {
  const { paths } = fixture(t, { config: fullConfig() });
  await store.init({ pathsOverride: paths });

  const seen = [];
  bus.on('host-changed', (n) => seen.push(n));

  store.setPhase('gpu-1', 'ready', 'test');
  await Promise.resolve();
  assert.deepEqual(seen, ['gpu-1']);

  seen.length = 0;
  store.mutateHostState('gpu-1', (e) => { e.web = { pid: 5 }; });
  await Promise.resolve();
  assert.deepEqual(seen, ['gpu-1']);

  seen.length = 0;
  store.updateConfig((d) => { d.hosts['gpu-1'].autoStart = true; });
  await Promise.resolve();
  assert.deepEqual(seen, ['gpu-1']);
});

test('updateConfig 改全局默认 → config-changed 且带点路径', async (t) => {
  const { paths } = fixture(t, { config: fullConfig() });
  await store.init({ pathsOverride: paths });

  const changes = [];
  bus.on('config-changed', (c) => changes.push(c));
  const { changed } = store.updateConfig((d) => { d.defaults.remoteWebPort = 9000; });

  assert.deepEqual(changed, ['defaults.remoteWebPort']);
  assert.deepEqual(changes, [['defaults.remoteWebPort']]);
});

test('mergeSshHosts：新主机进 config，消失的标 orphaned 但不删配置', async (t) => {
  const { paths } = fixture(t, { config: fullConfig() });
  await store.init({ pathsOverride: paths });

  const r = store.mergeSshHosts([
    { name: 'gpu-1', hostName: '10.0.0.1', user: 'root', port: 22 },
    { name: 'gpu-2', hostName: '10.0.0.2' },
  ]);
  assert.deepEqual(r.added, ['gpu-2']);
  assert.deepEqual(r.orphaned, []);
  assert.equal(store.getConfig().hosts['gpu-2'].enabled, true);

  const r2 = store.mergeSshHosts([{ name: 'gpu-1' }]);
  assert.deepEqual(r2.orphaned, ['gpu-2']);
  assert.ok('gpu-2' in store.getConfig().hosts, 'orphaned 不删配置');
  assert.equal(store.getHostView('gpu-2').orphaned, true);
});

test('reloadConfig 重读外部改动并给出 changed 清单', async (t) => {
  const { paths } = fixture(t, { config: fullConfig() });
  await store.init({ pathsOverride: paths });

  const edited = fullConfig();
  edited.defaults.remoteWebPort = 9100;
  edited.hosts['gpu-1'].autoStart = true;
  fs.writeFileSync(paths.config, JSON.stringify(edited, null, 2));

  const { changed } = store.reloadConfig();
  assert.deepEqual(changed.sort(), ['defaults.remoteWebPort', 'hosts.gpu-1.autoStart']);
  assert.equal(store.getConfig().defaults.remoteWebPort, 9100);
});

test('saveConfigFromSetup 强制 setupCompleted 并补齐主机默认字段', async (t) => {
  const { paths } = fixture(t);
  await store.init({ pathsOverride: paths });

  store.saveConfigFromSetup({
    manager: { port: 7799 },
    defaults: { remoteWebPort: 8899, localPortRange: [17701, 17799] },
    hosts: { 'gpu-9': { autoStart: true } },
    setupCompleted: false,
  });

  assert.equal(store.isSetupCompleted(), true, 'setupCompleted 由后端强制置 true');
  assert.equal(store.getConfig().manager.port, 7799);
  assert.equal(store.getConfig().hosts['gpu-9'].autoStart, true);
  assert.equal(store.getConfig().hosts['gpu-9'].localPort, null);
});

test('HostView 形状符合 13 §1.3：顶层键固定、mappedUrl 仅隧道可用时非 null', async (t) => {
  const { paths } = fixture(t, { config: fullConfig() });
  await store.init({ pathsOverride: paths });
  store.mergeSshHosts([{ name: 'gpu-1', hostName: '10.0.0.1', user: 'root', port: 22 }]);

  const view = store.getHostView('gpu-1');
  assert.deepEqual(Object.keys(view).sort(), [
    'config', 'effectiveRemotePort', 'manualInstances', 'mappedUrl', 'name',
    'orphaned', 'patchSync', 'phase', 'probe', 'sshInfo', 'tunnel', 'web',
  ]);
  assert.equal(view.effectiveRemotePort, 8899, 'null 覆写继承 defaults');
  assert.equal(view.mappedUrl, null, 'unknown 态无映射地址');
  assert.deepEqual(view.patchSync, { files: {} });
  assert.deepEqual(view.manualInstances, []);

  store.setPhase('gpu-1', 'ready', 't');
  store.setPhase('gpu-1', 'starting', 't');
  store.setPhase('gpu-1', 'running', 't');
  store.setTunnelStatusProvider(() => ({ localPort: 17701, connected: true, reconnectAttempt: 0, suspendedReason: null }));
  assert.equal(store.getHostView('gpu-1').mappedUrl, 'http://127.0.0.1:17701/');

  store.setPhase('gpu-1', 'ready', 't');
  assert.equal(store.getHostView('gpu-1').mappedUrl, null, 'ready 态不给映射地址');
});

test('effectiveRemotePort 优先用主机覆写', async (t) => {
  const cfg = fullConfig();
  cfg.hosts['gpu-1'].remoteWebPort = 9999;
  const { paths } = fixture(t, { config: cfg });
  await store.init({ pathsOverride: paths });
  assert.equal(store.getHostView('gpu-1').effectiveRemotePort, 9999);
});

test('listHostViews 按名升序；未知主机返回 null', async (t) => {
  const cfg = fullConfig();
  cfg.hosts.zeta = cfg.hosts['gpu-1'];
  cfg.hosts.alpha = { ...cfg.hosts['gpu-1'], localPort: 17702 };
  const { paths } = fixture(t, { config: cfg });
  await store.init({ pathsOverride: paths });

  assert.deepEqual(store.listHostViews().map((v) => v.name), ['alpha', 'gpu-1', 'zeta']);
  assert.equal(store.getHostView('nope'), null);
});

test('revision 单调递增', async (t) => {
  const { paths } = fixture(t, { config: fullConfig() });
  await store.init({ pathsOverride: paths });
  assert.equal(store.currentRevision(), 0);
  assert.equal(store.bumpRevision(), 1);
  assert.equal(store.bumpRevision(), 2);
  assert.equal(store.currentRevision(), 2);
});

test('hostCounts 统计 running/degraded/crashed', async (t) => {
  const cfg = fullConfig();
  cfg.hosts['gpu-2'] = { ...cfg.hosts['gpu-1'], localPort: 17702 };
  const { paths } = fixture(t, { config: cfg });
  await store.init({ pathsOverride: paths });

  store.setPhase('gpu-1', 'ready', 't');
  store.setPhase('gpu-1', 'starting', 't');
  store.setPhase('gpu-1', 'running', 't');
  store.setPhase('gpu-2', 'ready', 't');
  store.setPhase('gpu-2', 'starting', 't');
  store.setPhase('gpu-2', 'running', 't');
  store.setPhase('gpu-2', 'degraded', 't');

  assert.deepEqual(store.hostCounts(), { total: 2, running: 1, degraded: 1, crashed: 0 });
});
