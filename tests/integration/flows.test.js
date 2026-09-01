/**
 * TST-04 主干流程（一）：探测三分类、拉起降级与双失败、停止与拒杀、preflight 门槛、
 * 配置热生效、autoStart 批量。断言三层：HTTP、SSE 序列、假远端引擎终态。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { bootServer, spawnManualWeb, waitPhase } from './helpers.js';
import { SCENARIOS } from '../harness/scenarios.js';
import {
  accepted, assertRest, defaultsPutResponse, hostConfigPutResponse, hostsList, reloadResponse,
} from '../contract/schemas.js';

const byName = (res, name) => res.json.hosts.find((h) => h.name === name);

test('探测三分类：ready / no_dsh(两种原因) / unreachable，且可经 REST 重探', async (t) => {
  const ctx = await bootServer(t, {
    hosts: {
      ok: SCENARIOS.healthy(),
      'no-bin': SCENARIOS['no-dsh-missing-bin'](),
      'no-profile': SCENARIOS['no-dsh-no-profile'](),
      dead: SCENARIOS.unreachable(),
    },
  });

  const listed = await ctx.get('/api/hosts');
  assertRest(listed, { status: 200, schema: hostsList, label: 'GET /api/hosts' });

  assert.equal(byName(listed, 'ok').phase, 'ready');
  assert.equal(byName(listed, 'no-bin').phase, 'no_dsh');
  assert.equal(byName(listed, 'no-bin').probe.noDshReason, 'missing-bin');
  assert.equal(byName(listed, 'no-profile').phase, 'no_dsh');
  assert.equal(byName(listed, 'no-profile').probe.noDshReason, 'no-web-profile');
  assert.equal(byName(listed, 'no-profile').probe.dshPath, '/usr/bin/dsh', 'dsh 在，只是 profile 缺');
  assert.equal(byName(listed, 'dead').phase, 'unreachable');
  assert.match(byName(listed, 'dead').probe.errorSummary, /connect to host dead/);

  // 单机重探：修好远端后应转 ready
  const events = await ctx.sse();
  ctx.harness.scenario('no-bin', 'healthy');
  const probe = await ctx.api('POST', '/api/hosts/no-bin/probe');
  assertRest(probe, { status: 202, schema: accepted, label: 'POST probe' });
  const done = await events.wait((f) => f.type === 'operation-done' && f.data.operationId === probe.json.operationId);
  assert.equal(done.data.status, 'ok');
  assert.equal(done.data.action, 'probe');
  assert.equal((await waitPhase(ctx, 'no-bin', 'ready')).phase, 'ready');

  // 全量重探：一次 202、一条 operation-done（host 为 null）
  const all = await ctx.api('POST', '/api/hosts/probe');
  assertRest(all, { status: 202, schema: accepted, label: 'POST probe-all' });
  assert.equal(all.json.host, null);
  const allDone = await events.wait((f) => f.type === 'operation-done' && f.data.operationId === all.json.operationId);
  assert.equal(allDone.data.action, 'probe-all');
  assert.equal(allDone.data.status, 'ok', '单机 unreachable 不算全量失败');
});

test('端口被占：降级 --port 0 重拉，actualPort 为 OS 分配值', async (t) => {
  const ctx = await bootServer(t, { hosts: { 'gpu-1': SCENARIOS['bind-busy-once']() } });
  const events = await ctx.sse();

  const started = await ctx.api('POST', '/api/hosts/gpu-1/start');
  const done = await events.wait((f) => f.type === 'operation-done' && f.data.operationId === started.json.operationId);
  assert.equal(done.data.status, 'ok', done.data.error ?? '');

  const view = await waitPhase(ctx, 'gpu-1', 'running');
  assert.notEqual(view.web.port, ctx.remotePortOf('gpu-1'), '固定端口被占，落在 OS 分配端口上');
  assert.match(view.web.log, /^web-auto-/, '降级路径用 auto 命名的日志');
  assert.equal(view.tunnel.connected, true);
});

test('两次均被占：LAUNCH_FAILED 经 operation-done 上报，phase 回滚 ready，远端无孤儿', async (t) => {
  const ctx = await bootServer(t, { hosts: { 'gpu-1': SCENARIOS['bind-busy-twice']() } });
  const events = await ctx.sse();

  const started = await ctx.api('POST', '/api/hosts/gpu-1/start');
  assert.equal(started.status, 202, 'preflight 通过，失败只经 SSE');

  const done = await events.wait((f) => f.type === 'operation-done' && f.data.operationId === started.json.operationId);
  assert.equal(done.data.status, 'failed');
  assert.equal(done.data.code, 'LAUNCH_FAILED');
  assert.match(done.data.detail, /第 1 次拉起/);
  assert.match(done.data.detail, /第 2 次拉起/, 'detail 含两份日志尾');

  const view = await waitPhase(ctx, 'gpu-1', 'ready');
  assert.equal(view.web, null);
  assert.equal(view.tunnel, null);
  assert.equal(ctx.harness.liveProcesses('gpu-1').length, 0, '远端不留孤儿');
});

test('启动即崩：S2 快败（不等满 5 拍），回滚 ready', async (t) => {
  const ctx = await bootServer(t, { hosts: { 'gpu-1': SCENARIOS['launch-dies']() } });
  const events = await ctx.sse();

  const started = await ctx.api('POST', '/api/hosts/gpu-1/start');
  const done = await events.wait((f) => f.type === 'operation-done' && f.data.operationId === started.json.operationId);
  assert.equal(done.data.status, 'failed');
  assert.equal(done.data.code, 'LAUNCH_FAILED');
  assert.match(done.data.error, /立即退出/);
  assert.equal((await waitPhase(ctx, 'gpu-1', 'ready')).phase, 'ready');
});

test('停止的不误杀：指纹不符 → KILL_REFUSED，state 与远端进程都不动', async (t) => {
  const ctx = await bootServer(t);
  const events = await ctx.sse();

  await ctx.api('POST', '/api/hosts/gpu-1/start');
  const running = await waitPhase(ctx, 'gpu-1', 'running');

  // 远端同 pid 换了命令行（PID 复用/手动实例场景）
  ctx.harness.reusePid('gpu-1', 'dsh web --no-open --host 127.0.0.1 --port 9999');

  const stopped = await ctx.api('POST', '/api/hosts/gpu-1/stop');
  assert.equal(stopped.status, 202);
  const done = await events.wait((f) => f.type === 'operation-done' && f.data.operationId === stopped.json.operationId);
  assert.equal(done.data.status, 'failed');
  assert.equal(done.data.code, 'KILL_REFUSED');
  assert.match(done.data.detail, /记录指纹/);
  assert.match(done.data.detail, /远端实测/);

  const after = byName(await ctx.get('/api/hosts'), 'gpu-1');
  assert.equal(after.web.pid, running.web.pid, 'state 不清，交人工裁决');
  assert.equal(ctx.harness.liveProcesses('gpu-1').length, 1, '远端进程活着');
});

test('preflight 门槛：未知主机 404、状态不符 409、非受管/停用 409', async (t) => {
  const ctx = await bootServer(t, {
    hosts: { 'gpu-1': SCENARIOS.healthy(), 'no-bin': SCENARIOS['no-dsh-missing-bin']() },
    hostConfig: { 'no-bin': { enabled: false } },
  });

  const unknown = await ctx.api('POST', '/api/hosts/nope/start');
  assert.equal(unknown.status, 404);
  assert.equal(unknown.json.code, 'NOT_FOUND');

  const disabled = await ctx.api('POST', '/api/hosts/no-bin/start');
  assert.equal(disabled.status, 409);
  assert.equal(disabled.json.code, 'NOT_ALLOWED');

  const stopReady = await ctx.api('POST', '/api/hosts/gpu-1/stop');
  assert.equal(stopReady.status, 409);
  assert.equal(stopReady.json.code, 'NOT_ALLOWED', '没有受管实例可停');
  // 上面一个实例都没有，更没有什么手动实例。提「手动实例」会把人往「是不是有个我不知道
  // 的进程」上引，而真相只是「它没在跑」（issue #98）
  assert.doesNotMatch(stopReady.json.error, /手动实例/, `无实例时不许拿手动实例搪塞：${stopReady.json.error}`);
  assert.match(stopReady.json.error, /没有|未/, `要直说没有：${stopReady.json.error}`);

  const reconnectReady = await ctx.api('POST', '/api/hosts/gpu-1/reconnect');
  assert.equal(reconnectReady.status, 409);
  assert.equal(reconnectReady.json.code, 'PHASE_CONFLICT');

  await ctx.api('POST', '/api/hosts/gpu-1/start');
  await waitPhase(ctx, 'gpu-1', 'running');
  const startAgain = await ctx.api('POST', '/api/hosts/gpu-1/start');
  assert.equal(startAgain.status, 409);
  assert.equal(startAgain.json.code, 'PHASE_CONFLICT');

  assert.equal((await ctx.api('GET', '/api/hosts/nope/log')).status, 404);
  assert.equal((await ctx.api('GET', '/api/hosts/gpu-1/log?lines=0')).status, 400);
  assert.equal((await ctx.api('POST', '/api/nope')).status, 404);
});

test('运行中探测不改 phase，只并入手动实例', async (t) => {
  const ctx = await bootServer(t);
  await ctx.api('POST', '/api/hosts/gpu-1/start');
  const running = await waitPhase(ctx, 'gpu-1', 'running');

  const events = await ctx.sse();
  const probe = await ctx.api('POST', '/api/hosts/gpu-1/probe');
  await events.wait((f) => f.type === 'operation-done' && f.data.operationId === probe.json.operationId);

  const after = byName(await ctx.get('/api/hosts'), 'gpu-1');
  assert.equal(after.phase, 'running', '探测不得打断运行态');
  assert.equal(after.web.pid, running.web.pid);
  assert.deepEqual(after.manualInstances, [], '受管 PID 不算手动实例');
  assert.ok(after.probe.at, '探测详情照常刷新');
});

test('多个手动实例：候选清单进错误、盲领养被拒、指定 PID 才登记那一个', async (t) => {
  const ctx = await bootServer(t);
  const manual = await spawnManualWeb('gpu-1', { count: 3 });
  const events = await ctx.sse();

  const probe = await ctx.api('POST', '/api/hosts/gpu-1/probe');
  await events.wait((f) => f.type === 'operation-done' && f.data.operationId === probe.json.operationId);
  const seen = byName(await ctx.get('/api/hosts'), 'gpu-1');
  assert.deepEqual(seen.manualInstances.map((i) => i.pid).sort(), manual.map((i) => i.pid).sort());

  const start = await ctx.api('POST', '/api/hosts/gpu-1/start');
  assert.equal(start.status, 409);
  assert.equal(start.json.code, 'ADOPTION_AVAILABLE');
  for (const item of manual) {
    assert.match(start.json.error, new RegExp(`pid=${item.pid} port=${item.port}`),
      '候选连 PID 带端口一起摆出来，用户才挑得动');
  }

  const blind = await ctx.api('POST', '/api/hosts/gpu-1/adopt', {});
  const blindDone = await events.wait((f) => f.type === 'operation-done' && f.data.operationId === blind.json.operationId);
  assert.equal(blindDone.data.status, 'failed');
  assert.match(blindDone.data.error, /指定 PID/, '多个候选时不许替用户猜一个来杀/登记');
  assert.equal(byName(await ctx.get('/api/hosts'), 'gpu-1').phase, 'ready', '失败的领养不留痕');

  const target = manual[1];
  const picked = await ctx.api('POST', '/api/hosts/gpu-1/adopt', { pid: target.pid });
  assert.equal(picked.status, 202);
  await waitPhase(ctx, 'gpu-1', 'running');

  const after = byName(await ctx.get('/api/hosts'), 'gpu-1');
  assert.equal(after.web.pid, target.pid, '登记的必须是选中的那一个');
  assert.equal(after.web.port, target.port);
  assert.equal(after.web.startedByUs, false, '领养来的实例不许被当成自己拉起的');
  assert.deepEqual(
    after.manualInstances.map((i) => i.pid).sort(),
    manual.filter((i) => i.pid !== target.pid).map((i) => i.pid).sort(),
    '其余手动实例照旧只读挂着，一个都不许被顺手关掉',
  );
  assert.equal(ctx.harness.liveProcesses('gpu-1').length, 3, '领养不碰任何进程');
});

test('配置热生效：PUT 主机配置 / PUT defaults / POST reload', async (t) => {
  const ctx = await bootServer(t);

  const put = await ctx.api('PUT', '/api/hosts/gpu-1/config', {
    autoStart: true,
    inject: { env: { GREETING: 'hi' }, extraArgs: ['--verbose'], patches: [] },
  });
  assertRest(put, { status: 200, schema: hostConfigPutResponse, label: 'PUT host config' });
  assert.equal(put.json.host.config.autoStart, true);
  assert.deepEqual(put.json.host.config.inject.env, { GREETING: 'hi' });

  const bad = await ctx.api('PUT', '/api/hosts/gpu-1/config', { localPort: 20000 });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.code, 'VALIDATION');
  assert.match(bad.json.detail, /localPort/, 'localPort 由 manager 分配，不接受提交');

  const badEnv = await ctx.api('PUT', '/api/hosts/gpu-1/config', {
    inject: { env: { '1bad': 'x' }, extraArgs: [], patches: [] },
  });
  assert.equal(badEnv.status, 400);

  const defaults = await ctx.api('PUT', '/api/config/defaults', { remoteWebPort: 9100 });
  assertRest(defaults, { status: 200, schema: defaultsPutResponse, label: 'PUT defaults' });
  assert.equal(defaults.json.defaults.remoteWebPort, 9100);
  assert.equal(defaults.json.restartRequired, false);

  const managerPort = await ctx.api('PUT', '/api/config/defaults', { manager: { port: 7999 } });
  assert.equal(managerPort.json.restartRequired, true, 'manager 端口改动只落盘，需重启');

  const reload = await ctx.api('POST', '/api/reload');
  assertRest(reload, { status: 200, schema: reloadResponse, label: 'POST reload' });

  // 注入值真的进了远端命令行与指纹
  await ctx.api('POST', '/api/hosts/gpu-1/start');
  const running = await waitPhase(ctx, 'gpu-1', 'running');
  assert.match(running.web.cmdFingerprint, /--verbose$/);
  const [proc] = ctx.harness.liveProcesses('gpu-1');
  assert.deepEqual(proc.env, { GREETING: 'hi' });
});

test('启动目录：null 不生成 cd（回归锁）；配置后进脚本并回写 state 与 HostView', async (t) => {
  const ctx = await bootServer(t);

  await ctx.api('POST', '/api/hosts/gpu-1/start');
  const bare = await waitPhase(ctx, 'gpu-1', 'running');
  assert.equal(bare.config.workdir, null, '出厂默认 = 维持现状');
  assert.equal(bare.web.workdir, null);
  assert.equal(ctx.harness.hostState('gpu-1').workdir, null, '假远端未收到 cd 段');

  await ctx.api('POST', '/api/hosts/gpu-1/stop');
  await waitPhase(ctx, 'gpu-1', 'ready');

  const put = await ctx.api('PUT', '/api/hosts/gpu-1/config', { workdir: '~/proj' });
  assertRest(put, { status: 200, schema: hostConfigPutResponse, label: 'PUT workdir' });
  assert.equal(put.json.host.config.workdir, '~/proj');

  await ctx.api('POST', '/api/hosts/gpu-1/start');
  const running = await waitPhase(ctx, 'gpu-1', 'running');
  assert.equal(running.web.workdir, '~/proj', '本次实例的实际生效值');
  assert.equal(ctx.harness.hostState('gpu-1').workdir, '/root/proj', '~ 由远端展开，不在 manager 侧拼');
  assert.equal(
    running.web.cmdFingerprint.includes('cd '),
    false,
    'cd 不进 ps args，指纹判据不受 workdir 影响（§4.2）',
  );
  assert.equal(running.web.cwd, '/root/proj', 'VERIFY 回带的实测 cwd 已展开 ~');
});

test('启动目录改动是「重启后生效」：运行中改配置不动当前实例', async (t) => {
  const ctx = await bootServer(t, { hostConfig: { 'gpu-1': { workdir: '/root/a' } } });

  await ctx.api('POST', '/api/hosts/gpu-1/start');
  const first = await waitPhase(ctx, 'gpu-1', 'running');
  assert.equal(first.web.workdir, '/root/a');

  const put = await ctx.api('PUT', '/api/hosts/gpu-1/config', { workdir: '/root/b' });
  assert.equal(put.json.host.config.workdir, '/root/b');
  assert.equal(put.json.host.web.workdir, '/root/a', '正在跑的实例不动');
  assert.equal(put.json.host.phase, 'running');

  const restarted = await ctx.api('POST', '/api/hosts/gpu-1/restart');
  const events = await ctx.sse();
  await events.wait((f) => f.type === 'operation-done' && f.data.operationId === restarted.json.operationId);
  const after = await waitPhase(ctx, 'gpu-1', 'running');
  assert.equal(after.web.workdir, '/root/b', 'restart = stop + start，start 读 config 现值');
});

test('启动目录非法值 → 400 VALIDATION，配置不落盘', async (t) => {
  const ctx = await bootServer(t);

  for (const bad of ['relative/path', '', './x', '~user/x']) {
    // eslint-disable-next-line no-await-in-loop -- 逐个断言拒收
    const res = await ctx.api('PUT', '/api/hosts/gpu-1/config', { workdir: bad });
    assert.equal(res.status, 400, `应拒收 ${JSON.stringify(bad)}`);
    assert.equal(res.json.code, 'VALIDATION');
    assert.match(res.json.detail, /workdir/);
  }
  assert.equal(byName(await ctx.get('/api/hosts'), 'gpu-1').config.workdir, null, '拒收即不落盘');
});

test('启动目录不存在：ERR=workdir → LAUNCH_FAILED，phase 回 ready', async (t) => {
  const ctx = await bootServer(t, {
    hosts: { 'gpu-1': SCENARIOS['workdir-missing']() },
    hostConfig: { 'gpu-1': { workdir: '/no/such/dir' } },
  });
  const events = await ctx.sse();

  const started = await ctx.api('POST', '/api/hosts/gpu-1/start');
  assert.equal(started.status, 202, 'preflight 通过，失败只经 SSE');

  const done = await events.wait((f) => f.type === 'operation-done' && f.data.operationId === started.json.operationId);
  assert.equal(done.data.status, 'failed');
  assert.equal(done.data.code, 'LAUNCH_FAILED', '退出码 8 不该被归成不可达');
  assert.match(done.data.error, /工作目录不存在或不可进入/);
  assert.match(done.data.detail, /目标目录：\/no\/such\/dir/);

  const view = await waitPhase(ctx, 'gpu-1', 'ready');
  assert.equal(view.web, null);
  assert.equal(view.config.workdir, '/no/such/dir', '配置留着供用户改');
  assert.equal(ctx.harness.liveProcesses('gpu-1').length, 0);
});

test('autoStart：启动序列自动拉起勾选的主机，失败一台不阻塞其他', async (t) => {
  const ctx = await bootServer(t, {
    hosts: {
      good: SCENARIOS.healthy(),
      bad: SCENARIOS['launch-dies'](),
      idle: SCENARIOS.healthy(),
    },
    hostConfig: {
      good: { autoStart: true },
      bad: { autoStart: true },
      idle: { autoStart: false },
    },
  });

  const listed = await ctx.get('/api/hosts');
  assert.equal(byName(listed, 'good').phase, 'running', 'autoStart 已在启动序列内完成');
  assert.equal(byName(listed, 'bad').phase, 'ready', '失败回滚，不影响别人');
  assert.equal(byName(listed, 'idle').phase, 'ready', '未勾选的不动');
});

test('远端日志端点：裸文本、缺日志兜底', async (t) => {
  const ctx = await bootServer(t);

  const before = await ctx.api('GET', '/api/hosts/gpu-1/log');
  assert.equal(before.status, 200);
  assert.match(before.headers['content-type'], /text\/plain/);
  assert.equal(before.text.trim(), '(no log)');

  await ctx.api('POST', '/api/hosts/gpu-1/start');
  await waitPhase(ctx, 'gpu-1', 'running');

  const after = await ctx.api('GET', '/api/hosts/gpu-1/log?lines=10');
  assert.equal(after.status, 200);
  assert.match(after.text, /dsh web: http:\/\/127\.0\.0\.1:\d+/);
});
