import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as store from '../src/store.js';
import { CONFIG_VERSION, newHostConfig, resolvePaths } from '../src/defaults.js';
import { bus, recentLogs, _resetForTest } from '../src/lib/bus.js';

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
  assert.equal(cfg.hosts.a.local, false, '旧配置缺 local 时补成远端主机');
  assert.deepEqual(cfg.hosts.a.inject, { env: {}, extraArgs: [], patches: [] });

  const onDisk = JSON.parse(fs.readFileSync(paths.config, 'utf8'));
  assert.equal(onDisk.configVersion, CONFIG_VERSION, '迁移结果已回写');
});

test('configVersion 1 旧配置缺 local：加载后行为等价 false 且版本不升', async (t) => {
  const config = fullConfig();
  assert.equal('local' in config.hosts['gpu-1'], false);
  const { paths } = fixture(t, { config });
  await store.init({ pathsOverride: paths });

  assert.equal(CONFIG_VERSION, 1);
  assert.equal(store.getConfig().configVersion, 1);
  assert.equal(store.getConfig().hosts['gpu-1'].local, false);
  assert.equal(store.getHostView('gpu-1').local, false);
  assert.equal(store.getHostView('gpu-1').config.local, false);
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

test('updateConfig 写盘失败 → 内存也不许动，且给人话（校验过了但盘写不进去）', async (t) => {
  const { paths, dir } = fixture(t, { config: fullConfig() });
  await store.init({ pathsOverride: paths });

  // 目录只读：原子写的 open(tmp) 必失败。磁盘满、卷被卸载是同一类。
  fs.chmodSync(dir, 0o500);

  assert.throws(
    () => store.updateConfig((d) => { d.defaults.remoteWebPort = 9001; }),
    (e) => {
      assert.equal(e.code, 'CONFIG_WRITE_FAILED', `code 该是 CONFIG_WRITE_FAILED，实得 ${e.code}`);
      assert.doesNotMatch(e.message, /EACCES|ENOSPC/, 'message 是给人看的，别把 fs 的原始错误当 message');
      assert.doesNotMatch(e.message, new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'message 里别带内部绝对路径');
      assert.match(e.detail ?? '', /EACCES/, '原始错误该留在 detail 里');
      return true;
    },
  );

  // 关键：写盘没成功，内存就不许换。否则跑着的 manager 用新值、重启后静默回退旧值。
  fs.chmodSync(dir, 0o700);
  assert.equal(store.getConfig().defaults.remoteWebPort, 8899, '写盘失败了，内存却已经换成新值');
  assert.equal(JSON.parse(fs.readFileSync(paths.config, 'utf8')).defaults.remoteWebPort, 8899);

  // 权限恢复后照常能写
  store.updateConfig((d) => { d.defaults.remoteWebPort = 9002; });
  assert.equal(store.getConfig().defaults.remoteWebPort, 9002);
  assert.equal(JSON.parse(fs.readFileSync(paths.config, 'utf8')).defaults.remoteWebPort, 9002);
});

test('磁盘上那份被人手改过 → 拒绝写，不拿旧内存盖掉别人的改动', async (t) => {
  const { paths } = fixture(t, { config: fullConfig() });
  await store.init({ pathsOverride: paths });

  // 手改：manager 内存里还是旧的。整份落盘会把这处编辑无声抹掉（issue #65）
  const edited = JSON.parse(fs.readFileSync(paths.config, 'utf8'));
  edited.hosts['gpu-1'].workdir = '/手改痕迹';
  fs.writeFileSync(paths.config, `${JSON.stringify(edited, null, 2)}\n`);

  const seen = [];
  const on = (e) => seen.push(e);
  bus.on('config-changed', on);
  t.after(() => bus.off('config-changed', on));

  assert.throws(
    () => store.updateConfig((d) => { d.defaults.remoteWebPort = 9001; }),
    (e) => {
      assert.equal(e.code, 'CONFIG_STALE', `code 该是 CONFIG_STALE，实得 ${e.code}`);
      assert.match(e.message, /外部|手改|改过/, `message 要说清是文件被外部改过：${e.message}`);
      assert.match(e.message + (e.detail ?? ''), /restart/, '要给出路：重启 manager 读磁盘上的版本');
      return true;
    },
  );

  const onDisk = JSON.parse(fs.readFileSync(paths.config, 'utf8'));
  assert.equal(onDisk.hosts['gpu-1'].workdir, '/手改痕迹', '别人的改动必须一字不动地留在盘上');
  assert.equal(onDisk.defaults.remoteWebPort, 8899, '这次写要整份放弃，不许半写');
  assert.equal(store.getConfig().defaults.remoteWebPort, 8899, '没写成，内存也不许动');
  assert.deepEqual(seen, [], '没生效的东西不许通知出去');
});

test('自己写的连续两次不许误判成外部改动', async (t) => {
  const { paths } = fixture(t, { config: fullConfig() });
  await store.init({ pathsOverride: paths });

  store.updateConfig((d) => { d.defaults.remoteWebPort = 9001; });
  store.updateConfig((d) => { d.defaults.remoteWebPort = 9002; });
  store.updateConfig((d) => { d.hosts['gpu-1'].autoStart = true; });

  const onDisk = JSON.parse(fs.readFileSync(paths.config, 'utf8'));
  assert.equal(onDisk.defaults.remoteWebPort, 9002);
  assert.equal(onDisk.hosts['gpu-1'].autoStart, true);
});

test('写盘失败不发事件（没生效的东西不许通知出去）', async (t) => {
  const { paths, dir } = fixture(t, { config: fullConfig() });
  await store.init({ pathsOverride: paths });

  const seen = [];
  const on = (e) => seen.push(e);
  bus.on('config-changed', on);
  t.after(() => bus.off('config-changed', on));

  fs.chmodSync(dir, 0o500);
  assert.throws(() => store.updateConfig((d) => { d.defaults.remoteWebPort = 9001; }));
  fs.chmodSync(dir, 0o700); // 早点还回来，免得 fixture 清理目录时被自己锁在外面
  assert.deepEqual(seen, [], '写都没写进去，却已经广播「配置变了」');
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

test('state 落盘失败不许掀掉进程：记一条人话、继续跑、恢复后自己写回去（issue #87）', async (t) => {
  const { paths, dir } = fixture(t, { config: fullConfig() });
  await store.init({ pathsOverride: paths });

  const logs = [];
  const on = (e) => logs.push(e);
  bus.on('log-line', on);
  t.after(() => bus.off('log-line', on));

  t.mock.timers.enable({ apis: ['setTimeout'] });

  // 磁盘满 / 卷转只读 / 目录被 root 接管，都落到这同一条路上
  fs.chmodSync(dir, 0o500);
  store.mutateHostState('gpu-1', (e) => { e.web = { pid: 1 }; });
  assert.doesNotThrow(() => t.mock.timers.tick(100), 'debounce 定时器里抛出去 = 未捕获异常 = manager 当场死');

  const failed = logs.filter((l) => l.level === 'warn' || l.level === 'error');
  assert.equal(failed.length, 1, `写不进该报且只报一条，实得 ${failed.length} 条`);
  assert.doesNotMatch(failed[0].msg, /EACCES|ENOSPC/, 'msg 是给人看的，原始 fs 错误留给 detail');
  assert.match(failed[0].msg, /状态|内存|重启/, `要说清后果：${failed[0].msg}`);

  // 还在写不进的时候反复改：不许每次都刷一条同样的日志
  logs.length = 0;
  for (let i = 2; i <= 5; i += 1) {
    store.mutateHostState('gpu-1', (e) => { e.web = { pid: i }; });
    t.mock.timers.tick(100);
  }
  assert.equal(
    logs.filter((l) => l.level === 'warn' || l.level === 'error').length,
    0,
    '同一个毛病反复报就是刷屏，日志会被这条淹掉',
  );

  // 内存照旧可用：manager 得继续管隧道，不能因为写不了状态就装死
  assert.equal(store.getHostView('gpu-1').web.pid, 5);

  fs.chmodSync(dir, 0o700);
  store.mutateHostState('gpu-1', (e) => { e.web = { pid: 6 }; });
  t.mock.timers.tick(100);
  assert.equal(JSON.parse(fs.readFileSync(paths.state, 'utf8')).hosts['gpu-1'].web.pid, 6, '恢复可写后要自己写回去');
  assert.ok(
    logs.some((l) => /恢复|又能写/.test(l.msg)),
    '恢复了也该说一声，否则用户不知道那条 WARN 什么时候过期',
  );
});

test('退出路径的 flush 写不进：只记不抛，别把后面的隧道回收跳过去（issue #87）', async (t) => {
  const { paths, dir } = fixture(t, { config: fullConfig() });
  await store.init({ pathsOverride: paths });

  store.mutateHostState('gpu-1', (e) => { e.web = { pid: 7 }; });
  fs.chmodSync(dir, 0o500);
  assert.doesNotThrow(() => store.flushStateSync(), 'teardown 里抛出来，后面的清理就全跳过了');
  fs.chmodSync(dir, 0o700);
  assert.equal(fs.existsSync(paths.state), false, '写不进就是写不进，不许留半个文件');
});

test('setPhase 守卫非法迁移：抛错且状态零改动', async (t) => {
  const { paths } = fixture(t, { config: fullConfig() });
  await store.init({ pathsOverride: paths });

  assert.equal(store.setPhase('gpu-1', 'ready', 'test'), 'ready');
  assert.throws(
    () => store.setPhase('gpu-1', 'degraded', 'test'),
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

test('clearOrphanedHosts：原子删除配置、调用 state 清理且不影响本机主机', async (t) => {
  const { paths } = fixture(t, { config: fullConfig() });
  await store.init({ pathsOverride: paths });
  store.mergeSshHosts([{ name: 'gpu-1' }]);
  store.updateConfig((draft) => {
    draft.hosts.local = { ...newHostConfig(), local: true, localPort: null };
  });
  store.mutateHostState('gpu-1', (entry) => { entry.marker = 'orphan-state'; });
  store.mergeSshHosts([]);

  assert.deepEqual(store.listOrphanedHostNames(), ['gpu-1']);
  assert.deepEqual(store.clearOrphanedHosts(), ['gpu-1']);
  assert.equal(store.getConfig().hosts['gpu-1'], undefined);
  assert.equal(store.getHostState('gpu-1'), null);
  assert.ok(store.getHostView('local')?.local);
  assert.deepEqual(store.listOrphanedHostNames(), []);
  assert.equal(JSON.parse(fs.readFileSync(paths.config, 'utf8')).hosts['gpu-1'], undefined);
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
    hosts: {
      'gpu-9': { autoStart: true },
      'local-host': { local: true, localPort: null },
    },
    setupCompleted: false,
  });

  assert.equal(store.isSetupCompleted(), true, 'setupCompleted 由后端强制置 true');
  assert.equal(store.getConfig().manager.port, 7799);
  assert.equal(store.getConfig().hosts['gpu-9'].autoStart, true);
  assert.equal(store.getConfig().hosts['gpu-9'].local, false);
  assert.equal(store.getConfig().hosts['gpu-9'].localPort, null);
  assert.equal(store.getConfig().hosts['local-host'].local, true, 'setup 规范化必须保留本机身份');
});

test('HostView 形状符合 13 §1.3：顶层键固定、mappedUrl 仅隧道可用时非 null', async (t) => {
  const { paths } = fixture(t, { config: fullConfig() });
  await store.init({ pathsOverride: paths });
  store.mergeSshHosts([{ name: 'gpu-1', hostName: '10.0.0.1', user: 'root', port: 22 }]);

  const view = store.getHostView('gpu-1');
  assert.deepEqual(Object.keys(view).sort(), [
    'blocked', 'config', 'effectiveRemotePort', 'local', 'manualInstances', 'mappedUrl', 'name',
    'orphaned', 'patchSync', 'phase', 'probe', 'sshInfo', 'tunnel', 'web',
  ]);
  assert.equal(view.blocked, null, '没被名单挡下就是 null');
  assert.equal(view.local, false);
  assert.equal(view.config.local, false);
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

test('HostView 保留 local:true 主机身份', async (t) => {
  const config = fullConfig();
  config.hosts['gpu-1'].local = true;
  config.hosts['gpu-1'].localPort = null;
  const { paths } = fixture(t, { config });
  await store.init({ pathsOverride: paths });

  const view = store.getHostView('gpu-1');
  assert.equal(view.local, true);
  assert.equal(view.config.local, true);
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

// ── 主机名白/黑名单（defaults.hostFilter） ──────────────────────────────

/** 名单相关用例共用：一台正常算力机 + 一台已经躺在 config 里的 git 入口。 */
const filterConfig = (hostFilter) => fullConfig({
  defaults: { remoteWebPort: 8899, localPortRange: [17701, 17799], hostFilter },
  hosts: {
    'gpu-1': newHostConfig(),
    'git.example.com': newHostConfig(),
  },
});

test('名单挡下的 ssh 主机不自动纳管，且照样不算 orphaned', async (t) => {
  // git\..* 只吃「git 后面跟一个真的点」：github.com 得靠自己那条规则，别指望前一条兜住
  const { paths } = fixture(t, {
    config: filterConfig({ allow: [], deny: ['git\\..*', 'github\\.com'] }),
  });
  await store.init({ pathsOverride: paths });

  const merged = store.mergeSshHosts([
    { name: 'gpu-1', hostName: '10.0.0.1' },
    { name: 'gpu-2', hostName: '10.0.0.2' },
    { name: 'git.example.com', hostName: '10.0.0.3' },
    { name: 'github.com', hostName: '140.82.0.1' },
  ]);

  assert.deepEqual(merged.added, ['gpu-2'], '只有没被挡下的新主机进配置');
  assert.deepEqual(merged.filtered, ['github.com'], '挡下的新名字报出来，不静默丢');
  assert.equal(Object.hasOwn(store.getConfig().hosts, 'github.com'), false);

  // 已经在 config 里的那台：留在配置里但带上判定，且不是 orphaned——
  // 它在 ssh config 里确实还在，判定该是「屏蔽」而不是「消失了」
  const view = store.getHostView('git.example.com');
  assert.deepEqual(view.blocked, {
    rule: 'deny',
    pattern: 'git\\..*',
    reason: '命中黑名单 git\\..*',
  });
  assert.equal(view.orphaned, false);
  assert.equal(store.getHostView('gpu-1').blocked, null);
  assert.deepEqual(store.listBlockedHostNames(), ['git.example.com']);
});

test('升级即屏蔽要留痕：启动时把已纳管却被挡下的主机记进事件日志', async (t) => {
  // 只看主机表的人能从「已屏蔽」分组看懂；只用 CLI 的人只有这行日志能解释
  // 「我的 git.example.com 怎么突然不巡检了」。静默改默认行为是最难查的那类问题。
  const { paths } = fixture(t, {
    config: filterConfig({ allow: [], deny: ['git\\..*'] }),
  });
  await store.init({ pathsOverride: paths });

  const line = recentLogs(50).find((entry) => /主机名单挡下/u.test(entry.msg));
  assert.ok(line, `启动日志里应有一行说明屏蔽：${JSON.stringify(recentLogs(50).map((l) => l.msg))}`);
  assert.match(line.msg, /1 台已纳管主机/u);
  assert.match(line.msg, /git\.example\.com（命中黑名单 git\\\.\.\*）/u);
  assert.equal(line.host, null, '这是 manager 级别的一行，不挂在某台主机上');

  // 反面：一台都没挡下时不许留这行，否则日志里天天一条无信息量的噪声
  store._reset();
  _resetForTest(); // 日志缓冲挂在 bus 上，不清就会把上一段的那行算进来
  const clean = fixture(t, { config: filterConfig({ allow: [], deny: [] }) });
  await store.init({ pathsOverride: clean.paths });
  assert.equal(recentLogs(50).filter((entry) => /主机名单挡下/u.test(entry.msg)).length, 0);
});

test('白名单非空即只认名单内的，本机永远豁免', async (t) => {
  const { paths } = fixture(t, {
    config: fullConfig({
      defaults: {
        remoteWebPort: 8899,
        localPortRange: [17701, 17799],
        hostFilter: { allow: ['gpu-.*'], deny: [] },
      },
      hosts: {
        'gpu-1': newHostConfig(),
        jps: newHostConfig(),
        'my-mac': { ...newHostConfig(), local: true, localPort: null },
      },
    }),
  });
  await store.init({ pathsOverride: paths });
  store.mergeSshHosts([{ name: 'gpu-1' }, { name: 'jps' }]);

  assert.equal(store.getHostView('gpu-1').blocked, null);
  assert.equal(store.getHostView('jps').blocked.rule, 'allow');
  assert.equal(store.getHostView('my-mac').blocked, null, '本机不是从 ssh config 扫来的，不参与名单');
});

test('改名单当场生效：不必等下一次 reload', async (t) => {
  const { paths } = fixture(t, { config: filterConfig({ allow: [], deny: [] }) });
  await store.init({ pathsOverride: paths });
  store.mergeSshHosts([{ name: 'gpu-1' }, { name: 'git.example.com' }]);
  assert.deepEqual(store.listBlockedHostNames(), []);

  const changed = [];
  bus.on('host-changed', (host) => changed.push(host));
  store.updateConfig((draft) => {
    draft.defaults.hostFilter.deny = ['git\\..*'];
  });
  assert.deepEqual(store.listBlockedHostNames(), ['git.example.com']);
  await Promise.resolve(); // host-changed 走 microtask 合批
  assert.ok(changed.includes('git.example.com'), '判定变了要发事件，页面才会重画那一行');

  store.updateConfig((draft) => {
    draft.defaults.hostFilter.deny = [];
  });
  assert.deepEqual(store.listBlockedHostNames(), [], '名单撤了就该放回来');
});

test('清理已屏蔽：删配置与运行记录，跑着的一台都不动', async (t) => {
  const { paths } = fixture(t, {
    config: filterConfig({ allow: [], deny: ['git\\..*'] }),
    state: {
      hosts: {
        'git.example.com': { phase: 'ready' },
        'git.running.com': {
          phase: 'running',
          web: { pid: 4242, port: 8899, startedByUs: true, cmdFingerprint: 'dsh web', startedAt: new Date(0).toISOString() },
        },
      },
    },
  });
  await store.init({ pathsOverride: paths });
  store.updateConfig((draft) => {
    draft.hosts['git.running.com'] = newHostConfig();
  });
  store.mergeSshHosts([{ name: 'gpu-1' }, { name: 'git.example.com' }, { name: 'git.running.com' }]);
  assert.deepEqual(store.listBlockedHostNames(), ['git.example.com', 'git.running.com']);

  const { removed, skipped } = store.clearBlockedHosts();
  assert.deepEqual(removed, ['git.example.com']);
  assert.deepEqual(skipped, ['git.running.com'], '有实例在跑就跳过：名单是发现规则，不是关停命令');
  assert.equal(Object.hasOwn(store.getConfig().hosts, 'git.example.com'), false);
  assert.equal(store.getHostState('git.example.com'), null, '运行记录一并清掉');
  assert.ok(store.getHostView('git.running.com'), '跳过的那台原样留着');
  assert.deepEqual(store.clearBlockedHosts(), { removed: [], skipped: ['git.running.com'] },
    '再点一次也只会重复报同一台，不会误删');
});

test('老 config 缺 hostFilter：回填出厂名单，升级即享默认屏蔽', async (t) => {
  const legacy = fullConfig();
  delete legacy.defaults.hostFilter;
  const { paths } = fixture(t, { config: legacy });
  await store.init({ pathsOverride: paths });

  const { hostFilter } = store.getConfig().defaults;
  assert.deepEqual(hostFilter.allow, []);
  assert.ok(hostFilter.deny.includes('github\\.com'), `出厂黑名单应含 github：${hostFilter.deny}`);
  assert.deepEqual(store.mergeSshHosts([{ name: 'gpu-1' }, { name: 'github.com' }]).filtered, ['github.com']);
});

test('名单里的正则写坏了：配置写入整份放弃（校验层就拦住）', async (t) => {
  const { paths } = fixture(t, { config: filterConfig({ allow: [], deny: [] }) });
  await store.init({ pathsOverride: paths });

  for (const bad of ['(', '(a+)+', '', 'x'.repeat(201)]) {
    assert.throws(
      () => store.updateConfig((draft) => { draft.defaults.hostFilter.deny = [bad]; }),
      /校验失败/,
      `应拒绝 ${JSON.stringify(bad)}`,
    );
  }
  assert.deepEqual(store.getConfig().defaults.hostFilter.deny, [], '失败的那次一个字都没写进去');
});
