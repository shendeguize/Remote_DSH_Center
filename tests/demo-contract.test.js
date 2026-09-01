/**
 * 在线 demo 的假 manager 契约一致性（PG-14）。
 *
 * demo 之所以可信，靠的不是「看起来像」，而是两条硬约束：
 *   1. 它说的话过 13_api_schema.md 的校验器（就是集成测试用的那一份，
 *      extra=false，多一个键都算失败）——所以 demo 不会展示产品给不出的字段；
 *   2. 它的状态迁移由**产品真身** src/lib/machine.js 裁决——所以 demo 里演得通的
 *      路径在真机上也走得通，非法迁移会当场抛 STATE_ILLEGAL_TRANSITION。
 *
 * 契约上唯一的有意偏离：`mappedUrl` 在 demo 里指向站内的 mock 页而不是
 * `http://127.0.0.1:<port>/`——iframe 得真能加载出东西。下面为它单独立了一条用例，
 * 其余字段一律按原契约校验（校验前把 mappedUrl 归一成真实形态）。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import * as machine from '../src/lib/machine.js';
import { PHASES } from '../src/lib/machine.js';
import { drawerCopy } from '../src/web/components/host-drawer.js';
import { overlayFor } from '../src/web/components/iframe-pane.js';
import { setupPhaseLabel } from '../src/web/components/setup-wizard.js';
import {
  createFakeManager,
  FakeApiError,
  posixCksum as demoPosixCksum,
} from '../site/demo/demo-manager.js';
import { DEGRADED_ROUTES, ROUTE_IDS, dispatch, matchRoute } from '../site/demo/demo-routes.js';
import { createApiRouter } from '../site/demo/demo-shim.js';
import {
  accepted, assertSseStream, assertShape, configBody, errorBody, hostsList, hostView,
  managerInfo, reloadResponse, setupResponse, defaultsPutResponse, hostConfigPutResponse,
  localHostCreateResponse, settingsReadResponse, settingsWriteResponse, syncConfigResponse,
  workspaceRegisterResponse, orphanedClearResponse,
} from './contract/schemas.js';

/** assert.throws 不回传异常对象，而这些用例要逐字段查 status/code/detail。 */
function grab(fn) {
  try {
    fn();
  } catch (err) {
    return err;
  }
  return assert.fail('本该抛错，却正常返回了');
}

/** 演示节奏压到 1ms：状态该怎么迁还怎么迁，只是不用真等 2 秒。 */
const FAST = Object.freeze({
  probeMs: 1,
  probeScale: 0,
  startingMs: 1,
  stopMs: 1,
  restartGapMs: 1,
  reconnectMs: 1,
  reconnectBackoffMs: Object.freeze([1, 1, 1]),
  reconnectSuccessAt: 3,
  autoStartDelayMs: 1,
});

/**
 * 收集所有 SSE 帧的 manager。定时器用真 setTimeout（1ms），
 * 需要等异步动作落地时 await tick()。
 */
function rig({ setupCompleted = true } = {}) {
  const frames = [];
  const manager = createFakeManager({ machine, timing: FAST, setupCompleted });
  const unsubscribe = manager.subscribe((type, data) => frames.push({ type, data }));
  return {
    manager,
    frames,
    unsubscribe,
    /** 让在飞的 1ms 定时器都跑完（链式动作最多三跳，多等几轮） */
    async settle(rounds = 8) {
      for (let i = 0; i < rounds; i += 1) {
        // eslint-disable-next-line no-await-in-loop -- 就是要一轮一轮放行定时器
        await new Promise((r) => { setTimeout(r, 3); });
      }
    },
  };
}

/** demo 的 mappedUrl 指向站内 mock 页；归一成契约形态后再过 HostView 校验。 */
function normalize(host) {
  if (host.mappedUrl === null) return host;
  return { ...host, mappedUrl: `http://127.0.0.1:${host.tunnel.localPort}/` };
}

function assertSyncContract(body, label) {
  assertShape(
    syncConfigResponse,
    { ...body, hosts: body.hosts.map(normalize) },
    label,
  );
  return body.previewToken;
}

const req = (manager, method, pathname, options = {}) => {
  const { body, query } = options;
  return dispatch(manager, {
    method,
    pathname,
    body,
    query: new URLSearchParams(query ?? ''),
    hasQueryDelimiter: options.hasQueryDelimiter ?? Object.hasOwn(options, 'query'),
  });
};

const fetchReq = (manager, method, path, options = {}) => createApiRouter(
  manager,
  { latencyMs: 0 },
)(`http://demo.test${path}`, {
  method,
  ...(Object.hasOwn(options, 'body') ? { body: options.body } : {}),
});

async function fetchJson(manager, method, path, options) {
  const response = await fetchReq(manager, method, path, options);
  return { response, body: await response.json() };
}

function assertDemoError(fn, { status, code, label, message }) {
  const err = grab(fn);
  assert.ok(err instanceof FakeApiError, label);
  assert.equal(err.status, status, label);
  assert.equal(err.code, code, label);
  if (message) assert.match(err.message, message, label);
  assertShape(
    errorBody,
    {
      error: err.message,
      code: err.code,
      ...(err.detail ? { detail: err.detail } : {}),
    },
    `${label} 错误体`,
  );
  return err;
}

// ── 本机文案覆盖 ─────────────────────────────────────────────────────────

test('setup 本机不可用态使用本机文案，远端文案保持原样', () => {
  assert.equal(setupPhaseLabel({ local: true, phase: 'unreachable' }), '本机不可用');
  assert.equal(setupPhaseLabel({ local: true, phase: 'no_dsh' }), '本机未安装或未配置');
  assert.equal(setupPhaseLabel({ local: false, phase: 'unreachable' }), 'SSH 不可达');
  assert.equal(setupPhaseLabel({ local: false, phase: 'no_dsh' }), '未安装/未配置');
});

test('drawer 与 iframe 的本机文案不把本机称作远端或隧道', () => {
  const copy = drawerCopy({ local: true });
  for (const value of Object.values(copy)) {
    assert.doesNotMatch(value, /SSH|远端|隧道/);
  }
  assert.match(copy.probeTitle, /本机探测/);
  assert.match(copy.processLabel, /本机进程/);
  assert.match(copy.workdirLabel, /本机实际工作目录/);
  assert.match(copy.logTitle, /本机日志/);

  for (const phase of ['degraded', 'crashed', 'starting']) {
    const spec = overlayFor({ local: true, phase, mappedUrl: null, tunnel: { suspendedReason: null } });
    assert.doesNotMatch(`${spec.title} ${spec.body}`, /SSH|远端|隧道/, `本机 ${phase} 遮罩不应出现远端运输文案`);
  }
  const waiting = overlayFor({ local: true, phase: 'running', mappedUrl: null });
  assert.doesNotMatch(`${waiting.title} ${waiting.body}`, /SSH|远端|隧道/);

  assert.match(overlayFor({ local: false, phase: 'degraded', tunnel: {} }).title, /隧道断开/);
  assert.match(overlayFor({ local: false, phase: 'crashed' }).title, /远端 dsh web/);
});

// ── 端点覆盖 ─────────────────────────────────────────────────────────────

test('路由表覆盖 13 §2 的全部端点，且每条都真接了线', () => {
  // 20 个真实实现 + manager 自身 restart/shutdown 两个降级提示
  assert.equal(ROUTE_IDS.length - DEGRADED_ROUTES.length, 20, `实现端点数变了：${ROUTE_IDS.join(', ')}`);
  assert.equal(new Set(ROUTE_IDS).size, ROUTE_IDS.length, '路由 id 有重复');

  const cases = [
    ['GET', '/api/manager/info', 'manager-info'],
    ['GET', '/api/hosts', 'hosts'],
    ['GET', '/api/config', 'config'],
    ['PUT', '/api/config/defaults', 'defaults-put'],
    ['POST', '/api/reload', 'reload'],
    ['POST', '/api/hosts/clear-orphaned', 'clear-orphaned'],
    ['POST', '/api/setup', 'setup'],
    ['POST', '/api/hosts/probe', 'probe-all'],
    ['POST', '/api/hosts/local', 'local-create'],
    ['POST', '/api/hosts/sync-config', 'sync-config'],
    ['POST', '/api/hosts/gpu-a100/probe', 'probe'],
    ['POST', '/api/hosts/gpu-a100/start', 'start'],
    ['POST', '/api/hosts/gpu-a100/stop', 'stop'],
    ['POST', '/api/hosts/gpu-a100/restart', 'restart'],
    ['POST', '/api/hosts/gpu-a100/reconnect', 'reconnect'],
    ['GET', '/api/hosts/gpu-a100/log', 'log'],
    ['GET', '/api/hosts/gpu-a100/dsh-settings', 'dsh-settings-get'],
    ['PUT', '/api/hosts/gpu-a100/dsh-settings', 'dsh-settings-put'],
    ['POST', '/api/hosts/gpu-a100/dsh-workspace', 'dsh-workspace'],
    ['PUT', '/api/hosts/gpu-a100/config', 'host-config-put'],
    ['POST', '/api/manager/restart', 'manager-restart'],
    ['POST', '/api/manager/shutdown', 'manager-shutdown'],
  ];
  for (const [method, pathname, route] of cases) {
    assert.equal(matchRoute(method, pathname)?.route, route, `${method} ${pathname} 没匹配到 ${route}`);
  }
  assert.deepEqual([...ROUTE_IDS].sort(), cases.map((c) => c[2]).sort(), '路由表与用例表不同步');

  // 方法不对不该误命中（真后端也是 404/405，不是「凑合执行」）
  assert.equal(matchRoute('GET', '/api/hosts/gpu-a100/start'), null);
  assert.equal(matchRoute('POST', '/api/nope'), null);
  assert.equal(
    matchRoute('POST', '/api/hosts/gpu-a100/start/')?.route,
    'start',
    '旧端点继续兼容尾斜杠',
  );
  for (const method of ['GET', 'PUT']) {
    const trailing = `/api/hosts/gpu-a100/dsh-settings/`;
    assert.equal(matchRoute(method, trailing), null, `${method} settings 尾斜杠不得 normalize`);
    const err = grab(() => req(rig().manager, method, trailing, {
      ...(method === 'PUT' ? { body: { content: 'synthetic\n', baseChecksum: null } } : {}),
    }));
    assert.equal(err.status, 404);
    assert.equal(err.code, 'NOT_FOUND');
  }

  const malformed = grab(() => matchRoute('GET', '/api/hosts/%E0%A4%A/dsh-settings'));
  assert.equal(malformed.status, 400);
  assert.equal(malformed.code, 'VALIDATION');
  assert.match(malformed.message, /URL 编码/u);

  assert.equal(
    matchRoute('POST', '/api/hosts/gpu-a100/dsh-workspace/'),
    null,
    'Workspace 登记尾斜杠不得 normalize',
  );
});

// ── 读端点：逐个过契约 ────────────────────────────────────────────────────

test('GET /api/manager/info、/api/hosts、/api/config 全过契约校验', () => {
  const { manager } = rig();

  const info = req(manager, 'GET', '/api/manager/info');
  assert.equal(info.status, 200);
  assertShape(managerInfo, info.json, 'GET /api/manager/info');

  const hosts = req(manager, 'GET', '/api/hosts');
  assert.equal(hosts.status, 200);
  assertShape(hostsList, { ...hosts.json, hosts: hosts.json.hosts.map(normalize) }, 'GET /api/hosts');
  assert.equal(hosts.json.hosts.length, 4, 'demo 应有四台假主机');
  assert.deepEqual(
    hosts.json.hosts.map((h) => h.name),
    ['cpu-build', 'gpu-4090-daily', 'gpu-a100', 'legacy-box'],
    '主机列表必须按 name 升序（13 §2.1）',
  );
  assert.equal(
    hosts.json.hosts.some((host) => host.local),
    false,
    '普通已完成 demo 不应静默追加仅供 setup 使用的本机候选',
  );

  const config = req(manager, 'GET', '/api/config');
  assert.equal(config.status, 200);
  assertShape(configBody, config.json, 'GET /api/config');
});

test('GET /api/hosts/:name/log 回裸文本；lines 越界按 VALIDATION 拒掉', () => {
  const { manager } = rig();
  const log = req(manager, 'GET', '/api/hosts/gpu-a100/log', { query: 'lines=20' });
  assert.equal(log.status, 200);
  assert.equal(typeof log.text, 'string');
  assert.match(log.text, /gpu-a100/);

  // 没有受管实例时按协议兜底给 (no log)，而不是报错
  assert.equal(req(manager, 'GET', '/api/hosts/legacy-box/log').text, '(no log)');

  const err = grab(() => req(manager, 'GET', '/api/hosts/gpu-a100/log', { query: 'lines=0' }));
  assert.equal(err.status, 400);
  assert.equal(err.code, 'VALIDATION');
});

// ── 长动作：202 + 状态迁移 + operation-done ───────────────────────────────

test('拉起：202 受理 → starting → running，且恰好一条 operation-done', async () => {
  const r = rig();
  const res = req(r.manager, 'POST', '/api/hosts/gpu-4090-daily/start');
  assert.equal(res.status, 202);
  assertShape(accepted, res.json, 'POST start 的 202 体');
  assert.equal(res.json.host, 'gpu-4090-daily');
  assert.equal(r.manager.getHost('gpu-4090-daily').phase, 'starting', 'hub 一步拉起后必须先进入 starting');
  assert.equal(r.manager.getHost('gpu-4090-daily').mappedUrl, null, 'starting 时 iframe 尚无可加载地址');

  await r.settle();

  const phases = r.frames
    .filter((f) => f.type === 'host-changed' && f.data.host.name === 'gpu-4090-daily')
    .map((f) => f.data.host.phase);
  assert.deepEqual(phases, ['starting', 'running'], `实际迁移：${phases.join(' → ')}`);

  const done = r.frames.filter((f) => f.type === 'operation-done' && f.data.operationId === res.json.operationId);
  assert.equal(done.length, 1, '每个 202 必有且仅有一个 operation-done（13 §3.4）');
  assert.equal(done[0].data.status, 'ok');
  assert.equal(done[0].data.action, 'start');

  const host = r.manager.getHost('gpu-4090-daily');
  assert.equal(host.phase, 'running');
  assert.ok(host.web.startedByUs, '本工具拉起的实例必须标 startedByUs');
  assert.ok(host.tunnel.connected);
  assert.equal(host.config.localPort, 17702, '端口应从区间里分配且避开已占用的 17701');
  assert.match(host.mappedUrl, /mock-dsh-web/, 'running 后才下发 demo iframe 地址');
});

test('重启走 running → ready → starting → running（状态机不许 running 直接回 starting）', async () => {
  const r = rig();
  const res = req(r.manager, 'POST', '/api/hosts/gpu-a100/restart');
  assert.equal(res.status, 202);
  await r.settle();

  const phases = r.frames
    .filter((f) => f.type === 'host-changed' && f.data.host.name === 'gpu-a100')
    .map((f) => f.data.host.phase);
  assert.deepEqual(phases, ['ready', 'starting', 'running'], `实际迁移：${phases.join(' → ')}`);
  assert.equal(r.manager.getHost('gpu-a100').phase, 'running');
});

test('关停：running → ready，web/tunnel/mappedUrl 一起清空', async () => {
  const r = rig();
  req(r.manager, 'POST', '/api/hosts/gpu-a100/stop');
  await r.settle();

  const host = r.manager.getHost('gpu-a100');
  assert.equal(host.phase, 'ready');
  assert.equal(host.web, null);
  assert.equal(host.tunnel, null);
  assert.equal(host.mappedUrl, null, 'phase 不在 running/degraded 时 mappedUrl 必须为 null（13 §5.5）');
});

test('断联注入：running → degraded → 退避重连回 running；degraded 期间仍有 mappedUrl', async () => {
  const r = rig();
  r.manager.injectTunnelDrop('gpu-a100');

  const degraded = r.manager.getHost('gpu-a100');
  assert.equal(degraded.phase, 'degraded');
  assert.equal(degraded.tunnel.connected, false);
  assert.ok(degraded.mappedUrl, 'degraded 期间隧道地址要留着——iframe 不该被清空');

  await r.settle();
  const back = r.manager.getHost('gpu-a100');
  assert.equal(back.phase, 'running');
  assert.equal(back.tunnel.connected, true);
  assert.equal(back.tunnel.reconnectAttempt, 0);
});

test('崩溃注入：running → crashed，mappedUrl 清空但 web 记录留着（供「重启」与不误杀判定）', () => {
  const r = rig();
  r.manager.injectCrash('gpu-a100');
  const host = r.manager.getHost('gpu-a100');
  assert.equal(host.phase, 'crashed');
  assert.equal(host.mappedUrl, null);
  assert.equal(host.tunnel, null);
  assert.ok(host.web?.startedByUs, 'crashed 后仍要知道这进程原本是我们拉起的');
});

test('全量探测：四台各自出结果，probe-all 收一条汇总 operation-done', async () => {
  const r = rig();
  const res = req(r.manager, 'POST', '/api/hosts/probe');
  assert.equal(res.status, 202);
  assertShape(accepted, res.json, 'probe-all 的 202 体');
  assert.equal(res.json.host, null, '全量探测的 host 必须是 null（13 §1.2）');

  await r.settle();
  const done = r.frames.filter((f) => f.type === 'operation-done' && f.data.action === 'probe-all');
  assert.equal(done.length, 1);
  assert.equal(done[0].data.host, null);

  // 探测不得改写在跑的主机（11 §2.2）
  assert.equal(r.manager.getHost('gpu-a100').phase, 'running');
  assert.equal(r.manager.getHost('cpu-build').phase, 'no_dsh');
  assert.equal(r.manager.getHost('legacy-box').phase, 'unreachable');
});

// ── 写端点 ───────────────────────────────────────────────────────────────

test('POST /api/hosts/local：缺省/显式名称、多本机实例与 SSE 更新均对齐产品', async () => {
  const defaults = rig();
  const created = req(defaults.manager, 'POST', '/api/hosts/local', { body: {} });
  assert.equal(created.status, 201);
  assertShape(localHostCreateResponse, created.json, 'POST local(default)');
  assert.equal(created.json.host.name, 'local-host');
  assert.equal(created.json.host.local, true);
  assert.equal(created.json.host.config.local, true);
  assert.equal(created.json.host.config.localPort, null);
  assert.equal(created.json.host.sshInfo, null);

  const changed = defaults.frames.filter((f) => f.type === 'host-changed' && f.data.host.name === 'local-host');
  assert.equal(changed.length, 1, '创建响应之外还应广播一次 host-changed');
  assertShape(hostView, changed[0].data.host, 'POST local 的 SSE HostView');
  assert.equal(defaults.manager.config().hosts['local-host'].localPort, null);

  const probe = req(defaults.manager, 'POST', '/api/hosts/local-host/probe');
  assert.equal(probe.status, 202, '前端创建后会立即探测，demo 必须能继续接住');
  await defaults.settle();
  assert.equal(defaults.manager.getHost('local-host').phase, 'ready');

  const second = req(defaults.manager, 'POST', '/api/hosts/local', { body: { name: 'second-local' } });
  assert.equal(second.status, 201);
  assert.equal(second.json.host.local, true);

  const explicit = rig();
  const named = req(explicit.manager, 'POST', '/api/hosts/local', { body: { name: 'workstation' } });
  assert.equal(named.status, 201);
  assert.equal(named.json.host.name, 'workstation');
});

test('demo 添加本机后重跑 setup，HostView 与 config 始终保留 local identity', () => {
  const { manager } = rig();
  req(manager, 'POST', '/api/hosts/local', { body: { name: 'workstation' } });

  const submitted = req(manager, 'GET', '/api/config').json;
  assert.equal(submitted.hosts.workstation.local, true, 'setup 前配置应标记本机');
  const res = req(manager, 'POST', '/api/setup', { body: submitted });
  assert.equal(res.status, 200);

  const host = manager.getHost('workstation');
  const saved = manager.config().hosts.workstation;
  assert.equal(host.local, true, '重跑 setup 不得把候选 HostView 改成远端');
  assert.equal(host.config.local, true, 'HostView.config.local 应与顶层 identity 一致');
  assert.equal(saved.local, true, 'setup 落下的新 config 也应保留本机 identity');
  assert.equal(host.local, host.config.local);
});

test('POST sync-config preview：返回五字段差异与 opaque token，且不改配置、revision 或 SSE', () => {
  const r = rig();
  const secret = 'DEMO-PREVIEW-MUST-NOT-LEAK';
  req(r.manager, 'PUT', '/api/hosts/gpu-a100/config', {
    body: {
      inject: {
        env: { HF_HOME: '/data/hf', API_TOKEN: secret },
        extraArgs: ['--verbose'],
        patches: ['/private/source.patch'],
      },
    },
  });
  const before = r.manager.config();
  const revisionBefore = r.manager.revision;
  const frameCountBefore = r.frames.length;

  const preview = req(r.manager, 'POST', '/api/hosts/sync-config', {
    body: {
      source: 'gpu-a100',
      targets: ['gpu-4090-daily', 'legacy-box'],
      dryRun: true,
    },
  });

  assert.equal(preview.status, 200);
  const token = assertSyncContract(preview.json, 'POST sync-config preview');
  assert.match(token, /^v1\.[A-Za-z0-9_-]{43}$/);
  assert.doesNotMatch(token, new RegExp(secret));
  assert.doesNotMatch(JSON.stringify(preview.json), new RegExp(secret));
  assert.deepEqual(preview.json.targets, [
    {
      name: 'gpu-4090-daily',
      changed: true,
      changedFields: ['workdir', 'inject.env', 'inject.extraArgs', 'inject.patches'],
    },
    {
      name: 'legacy-box',
      changed: true,
      changedFields: ['remoteWebPort', 'workdir', 'inject.env', 'inject.extraArgs', 'inject.patches'],
    },
  ]);
  assert.deepEqual(preview.json.applied, []);
  assert.deepEqual(preview.json.hosts, []);
  assert.deepEqual(r.manager.config(), before);
  assert.equal(r.manager.revision, revisionBefore);
  assert.equal(r.frames.length, frameCountBefore, 'preview 不发 SSE');

  const reordered = req(r.manager, 'POST', '/api/hosts/sync-config', {
    body: {
      source: 'gpu-a100',
      targets: ['legacy-box', 'gpu-4090-daily'],
      dryRun: true,
    },
  });
  assert.equal(reordered.json.previewToken, token, '目标顺序不改变选择集合，token 应保持稳定');
  assert.deepEqual(reordered.json.targets.map(({ name }) => name), ['legacy-box', 'gpu-4090-daily']);
});

test('POST sync-config apply：整单复制 profile，保留身份/启停/端口/运行态并广播目标 HostView', async () => {
  const r = rig();
  const source = r.manager.getHost('legacy-box');
  const before = new Map(
    ['gpu-a100', 'cpu-build'].map((name) => [name, r.manager.getHost(name)]),
  );
  const preview = req(r.manager, 'POST', '/api/hosts/sync-config', {
    body: {
      source: source.name,
      targets: ['gpu-a100', 'cpu-build'],
      dryRun: true,
    },
  });
  const frameStart = r.frames.length;

  const applied = req(r.manager, 'POST', '/api/hosts/sync-config', {
    body: {
      source: source.name,
      targets: ['gpu-a100', 'cpu-build'],
      dryRun: false,
      previewToken: preview.json.previewToken,
    },
  });

  assert.equal(applied.status, 200);
  assert.equal(assertSyncContract(applied.json, 'POST sync-config apply'), undefined);
  assert.deepEqual(applied.json.applied, ['gpu-a100', 'cpu-build']);
  assert.deepEqual(applied.json.hosts.map(({ name }) => name), ['gpu-a100', 'cpu-build']);

  const sourceProfile = {
    remoteWebPort: source.config.remoteWebPort,
    workdir: source.config.workdir,
    inject: source.config.inject,
  };
  for (const name of ['gpu-a100', 'cpu-build']) {
    const oldHost = before.get(name);
    const host = r.manager.getHost(name);
    assert.deepEqual({
      remoteWebPort: host.config.remoteWebPort,
      workdir: host.config.workdir,
      inject: host.config.inject,
    }, sourceProfile, `${name} 应复制完整 profile`);
    for (const field of ['local', 'enabled', 'autoStart', 'localPort']) {
      assert.deepEqual(host.config[field], oldHost.config[field], `${name}.${field} 不得被同步`);
    }
    assert.deepEqual(host.sshInfo, oldHost.sshInfo, `${name} 身份不得变化`);
    assert.equal(host.phase, oldHost.phase, `${name} 运行 phase 不得变化`);
  }

  const runningBefore = before.get('gpu-a100');
  const runningAfter = r.manager.getHost('gpu-a100');
  assert.deepEqual(runningAfter.web, runningBefore.web, '运行中进程继续使用旧启动参数');
  assert.deepEqual(runningAfter.tunnel, runningBefore.tunnel, '运行中隧道不得重建');
  assert.equal(runningAfter.mappedUrl, runningBefore.mappedUrl);
  assert.equal(runningAfter.web.port, 8899);
  assert.equal(runningAfter.effectiveRemotePort, 18899, '新 profile 已供下次拉起使用');

  const syncFrames = r.frames.slice(frameStart);
  assert.deepEqual(
    syncFrames.map((frame) => [frame.type, frame.data.host?.name]),
    [['host-changed', 'gpu-a100'], ['host-changed', 'cpu-build']],
    '与产品 updateConfig 一致：host-only 配置变更只广播受影响 HostView',
  );
  assert.equal(syncFrames.some((frame) => frame.type === 'config-changed'), false);
  assert.equal(syncFrames.some((frame) => frame.type === 'operation-done'), false);

  req(r.manager, 'POST', '/api/hosts/gpu-a100/restart');
  await r.settle();
  assert.equal(r.manager.getHost('gpu-a100').web.port, 18899, '运行中目标应在下次重启使用同步后的端口');
});

test('POST sync-config apply：超过 64 个无关 preview 不得驱逐仍有效 token', () => {
  const r = rig();
  const request = {
    source: 'gpu-a100',
    targets: ['gpu-4090-daily'],
    dryRun: true,
  };
  const previewToken = req(r.manager, 'POST', '/api/hosts/sync-config', {
    body: request,
  }).json.previewToken;

  for (let i = 0; i < 65; i += 1) {
    req(r.manager, 'PUT', '/api/hosts/legacy-box/config', {
      body: { workdir: `/unrelated-preview-${i}` },
    });
    req(r.manager, 'POST', '/api/hosts/sync-config', {
      body: {
        source: 'legacy-box',
        targets: ['cpu-build'],
        dryRun: true,
      },
    });
  }

  const applied = req(r.manager, 'POST', '/api/hosts/sync-config', {
    body: { ...request, dryRun: false, previewToken },
  });
  assert.equal(applied.status, 200);
  assert.deepEqual(applied.json.applied, ['gpu-4090-daily']);
});

test('POST sync-config apply：源/目标 profile 或目标选择变化均整单 CONFIG_STALE', () => {
  const request = {
    source: 'gpu-a100',
    targets: ['gpu-4090-daily'],
    dryRun: true,
  };

  const sourceChanged = rig();
  const sourceToken = req(sourceChanged.manager, 'POST', '/api/hosts/sync-config', { body: request }).json.previewToken;
  req(sourceChanged.manager, 'PUT', '/api/hosts/gpu-a100/config', { body: { workdir: '/changed-source' } });
  const sourceTargetBefore = sourceChanged.manager.getHost('gpu-4090-daily');
  const sourceFrameCount = sourceChanged.frames.length;
  const sourceErr = grab(() => req(sourceChanged.manager, 'POST', '/api/hosts/sync-config', {
    body: { ...request, dryRun: false, previewToken: sourceToken },
  }));
  assert.equal(sourceErr.status, 409);
  assert.equal(sourceErr.code, 'CONFIG_STALE');
  assert.match(sourceErr.message, /重新预览|预览.*过期/);
  assert.ok(sourceErr.detail);
  assert.deepEqual(sourceChanged.manager.getHost('gpu-4090-daily'), sourceTargetBefore);
  assert.equal(sourceChanged.frames.length, sourceFrameCount, 'stale 整单不得发出目标更新');

  const targetChanged = rig();
  const targetToken = req(targetChanged.manager, 'POST', '/api/hosts/sync-config', { body: request }).json.previewToken;
  req(targetChanged.manager, 'PUT', '/api/hosts/gpu-4090-daily/config', { body: { workdir: '/changed-target' } });
  const changedTargetBefore = targetChanged.manager.getHost('gpu-4090-daily');
  const targetErr = grab(() => req(targetChanged.manager, 'POST', '/api/hosts/sync-config', {
    body: { ...request, dryRun: false, previewToken: targetToken },
  }));
  assert.equal(targetErr.status, 409);
  assert.equal(targetErr.code, 'CONFIG_STALE');
  assert.deepEqual(targetChanged.manager.getHost('gpu-4090-daily'), changedTargetBefore);

  const selectionChanged = rig();
  const selectionToken = req(selectionChanged.manager, 'POST', '/api/hosts/sync-config', { body: request }).json.previewToken;
  const selectionBefore = selectionChanged.manager.config();
  const selectionErr = grab(() => req(selectionChanged.manager, 'POST', '/api/hosts/sync-config', {
    body: {
      source: 'gpu-a100',
      targets: ['cpu-build'],
      dryRun: false,
      previewToken: selectionToken,
    },
  }));
  assert.equal(selectionErr.status, 409);
  assert.equal(selectionErr.code, 'CONFIG_STALE');
  assert.deepEqual(selectionChanged.manager.config(), selectionBefore);

  const unrelated = rig();
  const unrelatedToken = req(unrelated.manager, 'POST', '/api/hosts/sync-config', { body: request }).json.previewToken;
  req(unrelated.manager, 'PUT', '/api/hosts/gpu-4090-daily/config', { body: { enabled: false } });
  const unrelatedApply = req(unrelated.manager, 'POST', '/api/hosts/sync-config', {
    body: { ...request, dryRun: false, previewToken: unrelatedToken },
  });
  assert.equal(unrelatedApply.status, 200, '同步范围外字段不应让 preview 过期');
  assert.equal(unrelated.manager.getHost('gpu-4090-daily').config.enabled, false);

  const reset = rig();
  const resetToken = req(reset.manager, 'POST', '/api/hosts/sync-config', { body: request }).json.previewToken;
  reset.manager.reset();
  const resetErr = grab(() => req(reset.manager, 'POST', '/api/hosts/sync-config', {
    body: { ...request, dryRun: false, previewToken: resetToken },
  }));
  assert.equal(resetErr.status, 409, 'demo reset 应更换 session salt，使旧 preview token 失效');
  assert.equal(resetErr.code, 'CONFIG_STALE');
});

test('POST sync-config 边界：schema/语义错误不改状态，no-op 不发事件', () => {
  const r = rig();
  const before = r.manager.config();
  const revisionBefore = r.manager.revision;
  const frameCountBefore = r.frames.length;
  const invalid = [
    [undefined, 400, 'VALIDATION'],
    [{ source: 'gpu-a100', targets: [], dryRun: true }, 400, 'VALIDATION'],
    [{ source: 'gpu-a100', targets: ['gpu-4090-daily'], dryRun: 'true' }, 400, 'VALIDATION'],
    [{ source: 'gpu-a100', targets: ['gpu-4090-daily'], dryRun: true, extra: true }, 400, 'VALIDATION'],
    [{ source: 'gpu-a100', targets: Array(201).fill('cpu-build'), dryRun: true }, 400, 'VALIDATION'],
    [{ source: 'gpu-a100', targets: ['cpu-build', 'cpu-build'], dryRun: true }, 400, 'VALIDATION'],
    [{ source: 'gpu-a100', targets: ['gpu-a100'], dryRun: true }, 400, 'VALIDATION'],
    [{ source: 'missing', targets: ['cpu-build'], dryRun: true }, 404, 'NOT_FOUND'],
    [{ source: 'gpu-a100', targets: ['missing'], dryRun: true }, 404, 'NOT_FOUND'],
    [{ source: 'gpu-a100', targets: ['cpu-build'], dryRun: false }, 400, 'VALIDATION'],
    [{
      source: 'gpu-a100',
      targets: ['cpu-build'],
      dryRun: false,
      previewToken: 'wrong-preview-token',
    }, 409, 'CONFIG_STALE'],
  ];
  for (const [body, status, code] of invalid) {
    const err = grab(() => req(r.manager, 'POST', '/api/hosts/sync-config', { body }));
    assert.equal(err.status, status, JSON.stringify(body));
    assert.equal(err.code, code, JSON.stringify(body));
  }
  assert.deepEqual(r.manager.config(), before);
  assert.equal(r.manager.revision, revisionBefore);
  assert.equal(r.frames.length, frameCountBefore);

  const noOpPreview = req(r.manager, 'POST', '/api/hosts/sync-config', {
    body: { source: 'cpu-build', targets: ['gpu-4090-daily'], dryRun: true },
  });
  const noOp = req(r.manager, 'POST', '/api/hosts/sync-config', {
    body: {
      source: 'cpu-build',
      targets: ['gpu-4090-daily'],
      dryRun: false,
      previewToken: noOpPreview.json.previewToken,
    },
  });
  assert.equal(noOp.status, 200);
  assertSyncContract(noOp.json, 'POST sync-config no-op');
  assert.deepEqual(noOp.json.targets, [{
    name: 'gpu-4090-daily',
    changed: false,
    changedFields: [],
  }]);
  assert.deepEqual(noOp.json.applied, []);
  assert.deepEqual(noOp.json.hosts.map(({ name }) => name), ['gpu-4090-daily']);
  assert.equal(r.manager.revision, revisionBefore);
  assert.equal(r.frames.length, frameCountBefore, 'preview 与 no-op apply 都不发事件');

  const setup = rig({ setupCompleted: false });
  const gated = grab(() => req(setup.manager, 'POST', '/api/hosts/sync-config', {
    body: { source: 'gpu-a100', targets: ['cpu-build'], dryRun: true },
  }));
  assert.equal(gated.status, 409);
  assert.equal(gated.code, 'SETUP_REQUIRED');
});

test('demo POSIX cksum 匹配标准向量，仅作为 settings CAS 协议镜像', () => {
  const bytes = (value) => new TextEncoder().encode(value);
  assert.equal(demoPosixCksum(bytes('')), 4_294_967_295);
  assert.equal(demoPosixCksum(bytes('123456789')), 930_766_865);
  assert.equal(demoPosixCksum(bytes('abc')), 1_219_131_554);
});

test('GET/PUT dsh-settings：missing→create→read→update→stale，固定路径且内容不进 HostView/SSE', () => {
  const r = rig();
  const route = '/api/hosts/gpu-a100/dsh-settings';
  const initialRevision = r.manager.revision;
  const initialFrames = r.frames.length;

  const missing = req(r.manager, 'GET', route);
  assert.equal(missing.status, 200);
  assertShape(settingsReadResponse, missing.json, 'demo GET missing settings');
  assert.deepEqual(missing.json, {
    exists: false,
    path: '/root/.dsh/settings.yaml',
    content: '',
    checksum: null,
    size: 0,
  });

  const syntheticV1 = 'provider: synthetic-v1\nkey: demo-only-alpha\n';
  const created = req(r.manager, 'PUT', route, {
    body: { content: syntheticV1, baseChecksum: null },
  });
  assert.equal(created.status, 200);
  assertShape(settingsWriteResponse, created.json, 'demo PUT create settings');
  assert.equal(Object.hasOwn(created.json, 'content'), false, 'PUT 成功不得回显 settings 内容');
  const v1Bytes = new TextEncoder().encode(syntheticV1);
  assert.deepEqual(created.json, {
    updated: true,
    path: '/root/.dsh/settings.yaml',
    checksum: `cksum-v1:${demoPosixCksum(v1Bytes)}:${v1Bytes.byteLength}`,
    size: v1Bytes.byteLength,
  });

  const loadedV1 = req(r.manager, 'GET', route);
  assertShape(settingsReadResponse, loadedV1.json, 'demo GET created settings');
  assert.equal(loadedV1.json.content, syntheticV1);
  assert.equal(loadedV1.json.checksum, created.json.checksum);

  const syntheticV2 = 'provider: synthetic-v2\r\nkey: demo-only-beta\r\n';
  const updated = req(r.manager, 'PUT', route, {
    body: { content: syntheticV2, baseChecksum: loadedV1.json.checksum },
  });
  assertShape(settingsWriteResponse, updated.json, 'demo PUT update settings');
  assert.equal(Object.hasOwn(updated.json, 'content'), false);

  const stale = grab(() => req(r.manager, 'PUT', route, {
    body: { content: 'must-not-win: synthetic-stale\n', baseChecksum: loadedV1.json.checksum },
  }));
  assert.equal(stale.status, 409);
  assert.equal(stale.code, 'SETTINGS_STALE');
  assert.match(stale.message, /重新 GET/u);
  assert.equal(req(r.manager, 'GET', route).json.content, syntheticV2, 'stale PUT 不得覆盖当前内容');

  const sideChannels = JSON.stringify({
    hosts: r.manager.hosts(),
    config: r.manager.config(),
    frames: r.frames,
  });
  for (const marker of ['demo-only-alpha', 'demo-only-beta', 'synthetic-stale']) {
    assert.equal(sideChannels.includes(marker), false, `${marker} 不得进入 HostView/config/SSE`);
  }
  const demoManagerSource = fs.readFileSync(new URL('../site/demo/demo-manager.js', import.meta.url), 'utf8');
  assert.doesNotMatch(demoManagerSource, /(?:local|session)Storage/u, 'settings 不得进入浏览器持久存储');
  assert.equal(r.manager.revision, initialRevision, 'settings API 不改变 revision');
  assert.equal(r.frames.length, initialFrames, 'settings API 不产生 SSE');

  r.manager.reset();
  const afterReset = req(r.manager, 'GET', route);
  assert.equal(afterReset.json.exists, false, 'demo reset 后 settings 应消失');
  assert.equal(JSON.stringify(r.frames.at(-1)).includes('demo-only-'), false, 'reset snapshot 不得夹带 settings');
});

test('unreachable 主机的 settings GET/PUT 均报 SSH_UNREACHABLE，且不改变状态', () => {
  const r = rig();
  const route = '/api/hosts/legacy-box/dsh-settings';
  const before = {
    host: r.manager.getHost('legacy-box'),
    config: r.manager.config(),
    revision: r.manager.revision,
    frames: structuredClone(r.frames),
  };

  const unknown = grab(() => req(r.manager, 'PUT', '/api/hosts/not-present/dsh-settings', {
    body: { unknown: true },
  }));
  assert.equal(unknown.status, 404, '未知主机应优先于 body 校验');
  assert.equal(unknown.code, 'NOT_FOUND');

  const invalidBeforeTransport = [
    [{ unknown: true }, 400, 'VALIDATION'],
    [{ content: 'synthetic\n', baseChecksum: 'cksum-v1:01:1' }, 400, 'VALIDATION'],
    [{ content: '\ud800', baseChecksum: null }, 400, 'VALIDATION'],
    [{ content: 'x'.repeat(512 * 1024 + 1), baseChecksum: null }, 413, 'SETTINGS_TOO_LARGE'],
  ];
  for (const [body, status, code] of invalidBeforeTransport) {
    const err = grab(() => req(r.manager, 'PUT', route, { body }));
    assert.equal(err.status, status, `unreachable body priority: ${code}`);
    assert.equal(err.code, code);
  }

  for (const [method, body] of [
    ['GET', undefined],
    ['PUT', { content: 'must-not-store: synthetic-unreachable\n', baseChecksum: null }],
  ]) {
    const err = grab(() => req(r.manager, method, route, { body }));
    assert.equal(err.status, 502);
    assert.equal(err.code, 'SSH_UNREACHABLE');
  }
  assert.deepEqual(r.manager.getHost('legacy-box'), before.host);
  assert.deepEqual(r.manager.config(), before.config);
  assert.equal(r.manager.revision, before.revision);
  assert.deepEqual(r.frames, before.frames, '失败的 settings 请求不得产生 SSE');

  r.manager.reset();
  assert.equal(r.manager.getHost('legacy-box').phase, 'unreachable');
  for (const method of ['GET', 'PUT']) {
    const err = grab(() => req(r.manager, method, route, {
      ...(method === 'PUT' ? {
        body: { content: 'must-not-store-after-reset: synthetic\n', baseChecksum: null },
      } : {}),
    }));
    assert.equal(err.status, 502);
    assert.equal(err.code, 'SSH_UNREACHABLE');
  }
  assert.equal(r.manager.getHost('legacy-box').phase, 'unreachable', '失败与 reset 后 HostView 状态保持不变');
});

test('PUT dsh-settings 严格校验 UTF-8 字节上限、surrogate、CAS body 与 query', () => {
  const { manager } = rig();
  const route = '/api/hosts/cpu-build/dsh-settings';
  const exact = '😀'.repeat((512 * 1024) / 4);
  const exactWrite = req(manager, 'PUT', route, {
    body: { content: exact, baseChecksum: null },
  });
  assert.equal(exactWrite.json.size, 512 * 1024, 'UTF-8 恰好 512 KiB 应允许');
  assert.equal(exactWrite.json.path, '/home/ci/.dsh/settings.yaml');

  const tooLarge = grab(() => req(manager, 'PUT', route, {
    body: { content: `${exact}x`, baseChecksum: exactWrite.json.checksum },
  }));
  assert.equal(tooLarge.status, 413);
  assert.equal(tooLarge.code, 'SETTINGS_TOO_LARGE');

  for (const content of ['\ud800', '\udc00', 'ok\ud800x']) {
    const invalid = grab(() => req(manager, 'PUT', route, {
      body: { content, baseChecksum: exactWrite.json.checksum },
    }));
    assert.equal(invalid.status, 400);
    assert.equal(invalid.code, 'VALIDATION');
    assert.match(invalid.message, /Unicode|surrogate/u);
  }

  const invalidBodies = [
    undefined,
    null,
    { content: 'synthetic\n' },
    { content: 'synthetic\n', baseChecksum: undefined },
    { content: 'synthetic\n', baseChecksum: 'cksum-v1:01:1' },
    { content: 'synthetic\n', baseChecksum: exactWrite.json.checksum, unknown: true },
    { content: 'synthetic\n', baseChecksum: exactWrite.json.checksum, path: '/tmp/settings.yaml' },
  ];
  for (const body of invalidBodies) {
    const invalid = grab(() => req(manager, 'PUT', route, { body }));
    assert.equal(invalid.status, 400, JSON.stringify(body));
    assert.equal(invalid.code, 'VALIDATION', JSON.stringify(body));
  }

  for (const method of ['GET', 'PUT']) {
    const invalid = grab(() => req(manager, method, route, {
      query: 'path=%2Ftmp%2Fsettings.yaml',
      ...(method === 'PUT' ? {
        body: { content: 'synthetic\n', baseChecksum: exactWrite.json.checksum },
      } : {}),
    }));
    assert.equal(invalid.status, 400);
    assert.equal(invalid.code, 'VALIDATION');
    assert.match(invalid.message, /query/u);
  }
  for (const rawQuery of ['?', '?&&']) {
    for (const method of ['GET', 'PUT']) {
      const invalid = grab(() => req(manager, method, route, {
        query: rawQuery.slice(1),
        hasQueryDelimiter: true,
        ...(method === 'PUT' ? {
          body: { content: 'synthetic\n', baseChecksum: exactWrite.json.checksum },
        } : {}),
      }));
      assert.equal(invalid.status, 400, `${method} ${rawQuery}`);
      assert.equal(invalid.code, 'VALIDATION', `${method} ${rawQuery}`);
      assert.match(invalid.message, /query/u);
    }
  }

  const missingHost = grab(() => req(manager, 'GET', '/api/hosts/not-present/dsh-settings'));
  assert.equal(missingHost.status, 404);
  assert.equal(missingHost.code, 'NOT_FOUND');
});

test('POST dsh-workspace：按当前 CWD 幂等登记，响应过契约且不污染可观察状态', () => {
  const r = rig();
  const route = '/api/hosts/gpu-a100/dsh-workspace';
  const before = {
    hosts: r.manager.hosts(),
    config: r.manager.config(),
    revision: r.manager.revision,
    frames: structuredClone(r.frames),
  };

  assert.equal(r.manager.getHost('gpu-a100').web.cwd, '/root/work/train', 'root 的 ~ 必须展开到 /root');
  const created = req(r.manager, 'POST', route, { body: {} });
  assert.equal(created.status, 200);
  assertShape(workspaceRegisterResponse, created.json, 'demo POST dsh-workspace created');
  assert.deepEqual(created.json, {
    created: true,
    workspaceId: created.json.workspaceId,
    title: 'train',
    path: '/root/work/train',
  });

  const repeated = req(r.manager, 'POST', route, { body: {} });
  assert.equal(repeated.status, 200);
  assertShape(workspaceRegisterResponse, repeated.json, 'demo POST dsh-workspace repeated');
  assert.deepEqual(repeated.json, {
    ...created.json,
    created: false,
  }, '同一当前 CWD 必须返回稳定的 id/title/path');

  assert.deepEqual(r.manager.hosts(), before.hosts, '登记不得改变 HostView');
  assert.deepEqual(r.manager.config(), before.config, '登记不得改变 config');
  assert.equal(r.manager.revision, before.revision, '登记不得改变 revision');
  assert.deepEqual(r.frames, before.frames, '登记不得产生 SSE 或日志帧');
  const visibleState = JSON.stringify({
    hosts: r.manager.hosts(),
    config: r.manager.config(),
    frames: r.frames,
  });
  assert.equal(visibleState.includes(created.json.workspaceId), false, '私有 registry 不得泄漏到状态面');
});

test('POST dsh-workspace fetch shim：setup/query/host/body 按生产顺序校验且隐藏 JSON 解析细节', async () => {
  const gated = rig({ setupCompleted: false });
  const setupMalformed = await fetchJson(
    gated.manager,
    'POST',
    '/api/hosts/gpu-a100/dsh-workspace',
    { body: '{not-json' },
  );
  assert.equal(setupMalformed.response.status, 409);
  assert.equal(setupMalformed.body.code, 'SETUP_REQUIRED');

  const active = rig();
  const queryBadHost = await fetchJson(
    active.manager,
    'POST',
    '/api/hosts/%/dsh-workspace?path=attack',
    { body: '{not-json' },
  );
  assert.equal(queryBadHost.response.status, 400);
  assert.equal(queryBadHost.body.code, 'VALIDATION');
  assert.match(queryBadHost.body.error, /query/u);
  assert.doesNotMatch(queryBadHost.body.error, /URL 编码|SyntaxError|JSON\.parse/u);

  const missingHost = await fetchJson(
    active.manager,
    'POST',
    '/api/hosts/not-present/dsh-workspace',
    { body: '{not-json' },
  );
  assert.equal(missingHost.response.status, 404);
  assert.equal(missingHost.body.code, 'NOT_FOUND');

  const malformed = await fetchJson(
    active.manager,
    'POST',
    '/api/hosts/gpu-a100/dsh-workspace',
    { body: '{not-json' },
  );
  assert.equal(malformed.response.status, 400);
  assert.equal(malformed.body.code, 'VALIDATION');
  assert.doesNotMatch(malformed.body.error, /SyntaxError|JSON\.parse|position \d+/u);

  const trailing = await fetchJson(
    gated.manager,
    'POST',
    '/api/hosts/gpu-a100/dsh-workspace/?path=attack',
    { body: '{not-json' },
  );
  assert.equal(trailing.response.status, 404);
  assert.equal(trailing.body.code, 'NOT_FOUND');
});

test('POST dsh-workspace：严格拒绝请求路径注入并保持 host/body 校验优先级', () => {
  const r = rig();
  const route = '/api/hosts/gpu-a100/dsh-workspace';
  const before = {
    hosts: r.manager.hosts(),
    config: r.manager.config(),
    revision: r.manager.revision,
    frames: structuredClone(r.frames),
  };

  for (const [body, label] of [
    [undefined, '缺少 body'],
    [null, 'null body'],
    [[], '数组 body'],
    [{ path: '/tmp/attack' }, 'path 注入'],
    [{ workdir: '/tmp/attack' }, 'workdir 注入'],
    [{ extra: true }, '未知字段'],
  ]) {
    assertDemoError(
      () => req(r.manager, 'POST', route, { body }),
      { status: 400, code: 'VALIDATION', label },
    );
  }

  assertDemoError(
    () => req(r.manager, 'POST', '/api/hosts/not-present/dsh-workspace', {
      body: { path: '/tmp/attack' },
    }),
    {
      status: 404,
      code: 'NOT_FOUND',
      label: '未知主机优先于 body 校验',
    },
  );
  assertDemoError(
    () => req(r.manager, 'POST', route, {
      query: 'path=%2Ftmp%2Fattack',
      body: {},
    }),
    {
      status: 400,
      code: 'VALIDATION',
      label: 'query 注入',
      message: /query/u,
    },
  );
  assertDemoError(
    () => req(r.manager, 'POST', `${route}/`, { body: {} }),
    {
      status: 404,
      code: 'NOT_FOUND',
      label: '尾斜杠',
    },
  );
  assertDemoError(
    () => req(r.manager, 'POST', '/api/hosts/%/dsh-workspace', { body: {} }),
    {
      status: 400,
      code: 'VALIDATION',
      label: '非法 host URL 编码',
      message: /URL 编码/u,
    },
  );

  assert.deepEqual(r.manager.hosts(), before.hosts);
  assert.deepEqual(r.manager.config(), before.config);
  assert.equal(r.manager.revision, before.revision);
  assert.deepEqual(r.frames, before.frames);
});

test('POST dsh-workspace：要求运行态、已配置且已应用的 workdir 与绝对 CWD', async () => {
  const wrongPhase = rig();
  assertDemoError(
    () => req(wrongPhase.manager, 'POST', '/api/hosts/gpu-4090-daily/dsh-workspace', { body: {} }),
    {
      status: 409,
      code: 'PHASE_CONFLICT',
      label: '非运行态',
      message: /running\/degraded/u,
    },
  );

  const noWorkdir = rig();
  noWorkdir.manager.saveHostConfig('gpu-a100', { workdir: null });
  assertDemoError(
    () => req(noWorkdir.manager, 'POST', '/api/hosts/gpu-a100/dsh-workspace', { body: {} }),
    {
      status: 400,
      code: 'WORKSPACE_WORKDIR_REQUIRED',
      label: '未配置 workdir',
      message: /配置启动目录/u,
    },
  );

  const pending = rig();
  pending.manager.saveHostConfig('gpu-a100', { workdir: '/root/work/next' });
  assertDemoError(
    () => req(pending.manager, 'POST', '/api/hosts/gpu-a100/dsh-workspace', { body: {} }),
    {
      status: 409,
      code: 'PHASE_CONFLICT',
      label: 'workdir 尚未应用',
      message: /尚未应用.*重启/u,
    },
  );

  for (const [workdir, status, code, label] of [
    ['', 409, 'WORKSPACE_CWD_UNAVAILABLE', 'CWD 不可用'],
    ['relative/project', 422, 'WORKSPACE_INVALID_PATH', 'CWD 非绝对路径'],
  ]) {
    const current = rig();
    req(current.manager, 'POST', '/api/hosts/gpu-a100/stop');
    await current.settle();
    current.manager.saveHostConfig('gpu-a100', { workdir });
    req(current.manager, 'POST', '/api/hosts/gpu-a100/start');
    await current.settle();
    assertDemoError(
      () => req(current.manager, 'POST', '/api/hosts/gpu-a100/dsh-workspace', { body: {} }),
      { status, code, label },
    );
  }

  const canonical = rig();
  req(canonical.manager, 'POST', '/api/hosts/gpu-a100/stop');
  await canonical.settle();
  canonical.manager.saveHostConfig('gpu-a100', { workdir: '/root/work/./train/../train/' });
  req(canonical.manager, 'POST', '/api/hosts/gpu-a100/start');
  await canonical.settle();
  const normalized = req(
    canonical.manager,
    'POST',
    '/api/hosts/gpu-a100/dsh-workspace',
    { body: {} },
  ).json;
  assert.equal(normalized.path, '/root/work/train');
  assert.equal(normalized.title, 'train');

  req(canonical.manager, 'POST', '/api/hosts/gpu-a100/stop');
  await canonical.settle();
  canonical.manager.saveHostConfig('gpu-a100', { workdir: '/root/work/train' });
  req(canonical.manager, 'POST', '/api/hosts/gpu-a100/start');
  await canonical.settle();
  const sameCanonicalCwd = req(
    canonical.manager,
    'POST',
    '/api/hosts/gpu-a100/dsh-workspace',
    { body: {} },
  ).json;
  assert.equal(sameCanonicalCwd.created, false);
  assert.equal(sameCanonicalCwd.workspaceId, normalized.workspaceId);
});

test('POST dsh-workspace fetch shim：同路径按主机隔离，reset 清空 registry', async () => {
  const r = rig();
  r.manager.saveHostConfig('gpu-4090-daily', { workdir: '/root/work/train' });
  r.manager.startHost('gpu-4090-daily');
  await r.settle();

  const aRoute = '/api/hosts/gpu-a100/dsh-workspace';
  const bRoute = '/api/hosts/gpu-4090-daily/dsh-workspace';
  const firstA = await fetchJson(r.manager, 'POST', aRoute, { body: '{}' });
  const firstB = await fetchJson(r.manager, 'POST', bRoute, { body: '{}' });
  assert.equal(firstA.response.status, 200);
  assert.equal(firstB.response.status, 200);
  assert.equal(firstA.body.created, true);
  assert.equal(firstB.body.created, true);
  assert.equal(firstA.body.path, '/root/work/train');
  assert.equal(firstB.body.path, firstA.body.path);
  assert.notEqual(firstB.body.workspaceId, firstA.body.workspaceId);

  const repeatedA = await fetchJson(r.manager, 'POST', aRoute, { body: '{}' });
  const repeatedB = await fetchJson(r.manager, 'POST', bRoute, { body: '{}' });
  assert.equal(repeatedA.body.created, false);
  assert.equal(repeatedB.body.created, false);
  assert.equal(repeatedA.body.workspaceId, firstA.body.workspaceId);
  assert.equal(repeatedB.body.workspaceId, firstB.body.workspaceId);

  r.manager.reset();
  const afterReset = await fetchJson(r.manager, 'POST', aRoute, { body: '{}' });
  assertShape(workspaceRegisterResponse, afterReset.body, 'demo POST dsh-workspace after reset');
  assert.equal(afterReset.body.created, true);
  assert.equal(afterReset.body.path, firstA.body.path);
  assert.notEqual(afterReset.body.workspaceId, firstA.body.workspaceId);
});

test('POST dsh-workspace：根目录沿用上游空 title', async () => {
  const r = rig();
  r.manager.stopHost('gpu-a100');
  await r.settle();
  r.manager.saveHostConfig('gpu-a100', { workdir: '/' });
  r.manager.startHost('gpu-a100');
  await r.settle();

  const result = await fetchJson(
    r.manager,
    'POST',
    '/api/hosts/gpu-a100/dsh-workspace',
    { body: '{}' },
  );
  assert.equal(result.response.status, 200);
  assertShape(workspaceRegisterResponse, result.body, 'demo root Workspace');
  assert.equal(result.body.path, '/');
  assert.equal(result.body.title, '');
});

test('POST dsh-workspace：setup gate 先于 query、host decode 与 body，尾斜杠仍为 404', () => {
  const { manager } = rig({ setupCompleted: false });
  for (const [pathname, options, label] of [
    ['/api/hosts/gpu-a100/dsh-workspace', { query: 'path=attack', body: { path: '/tmp/attack' } }, 'query/body'],
    ['/api/hosts/%/dsh-workspace', { body: { path: '/tmp/attack' } }, 'host decode'],
    ['/api/hosts/not-present/dsh-workspace', { body: { path: '/tmp/attack' } }, 'host/body'],
  ]) {
    assertDemoError(
      () => req(manager, 'POST', pathname, options),
      {
        status: 409,
        code: 'SETUP_REQUIRED',
        label: `setup gate ${label}`,
      },
    );
  }

  assertDemoError(
    () => req(manager, 'POST', '/api/hosts/gpu-a100/dsh-workspace/', {
      query: 'path=attack',
      body: { path: '/tmp/attack' },
    }),
    {
      status: 404,
      code: 'NOT_FOUND',
      label: 'setup 下尾斜杠不匹配生产路由',
    },
  );
});

test('PUT /api/hosts/:name/config：回传 HostView，且拒收 localPort 与未知键', () => {
  const { manager } = rig();
  const res = req(manager, 'PUT', '/api/hosts/gpu-a100/config', { body: { autoStart: false, workdir: '~/other' } });
  assert.equal(res.status, 200);
  assertShape(hostConfigPutResponse, { host: normalize(res.json.host) }, 'PUT host config 响应');
  assert.equal(res.json.host.config.autoStart, false);
  assert.equal(res.json.host.config.workdir, '~/other');

  for (const bad of [{ localPort: 17777 }, { nope: 1 }]) {
    const err = grab(() => req(manager, 'PUT', '/api/hosts/gpu-a100/config', { body: bad }));
    assert.equal(err.status, 400);
    assert.equal(err.code, 'VALIDATION');
  }
});

test('PUT /api/config/defaults 与 POST /api/reload 过契约；改默认端口会重算 effectiveRemotePort', () => {
  const { manager } = rig();
  const res = req(manager, 'PUT', '/api/config/defaults', { body: { remoteWebPort: 9100 } });
  assert.equal(res.status, 200);
  assertShape(defaultsPutResponse, res.json, 'PUT defaults 响应');
  assert.equal(res.json.restartRequired, false, '只改远端默认端口不需要重启 manager');

  // legacy-box 自带 remoteWebPort 覆写，不该被全局默认带跑
  assert.equal(manager.getHost('cpu-build').effectiveRemotePort, 9100);
  assert.equal(manager.getHost('legacy-box').effectiveRemotePort, 18899);

  const restart = req(manager, 'PUT', '/api/config/defaults', { body: { manager: { port: 7799 } } });
  assert.equal(restart.json.restartRequired, true, '改 manager 端口只落盘，要重启才生效');

  assertShape(reloadResponse, req(manager, 'POST', '/api/reload').json, 'POST reload 响应');
  assertShape(
    orphanedClearResponse,
    req(manager, 'POST', '/api/hosts/clear-orphaned').json,
    'POST clear-orphaned 响应',
  );
});

test('manager 自身的 restart/shutdown 在 demo 里降级为 409，且说清原因', () => {
  const { manager } = rig();
  for (const p of ['/api/manager/restart', '/api/manager/shutdown']) {
    const err = grab(() => req(manager, 'POST', p));
    assert.ok(err instanceof FakeApiError);
    assert.equal(err.status, 409);
    assert.equal(err.code, 'NOT_ALLOWED');
    assert.match(err.message, /demo 中不支持/);
    assert.ok(err.detail, '降级提示必须给出可展开的解释，而不是干巴巴一句拒绝');
    assertShape(errorBody, { error: err.message, code: err.code, detail: err.detail }, '降级错误体');
  }
});

// ── preflight：不该做的动作要按 13 §2.10 拒掉 ─────────────────────────────

test('preflight 拒绝：状态不对给 409 PHASE_CONFLICT，不存在给 404', () => {
  const { manager } = rig();
  const conflicts = [
    ['POST', '/api/hosts/gpu-a100/start', 'running 的主机不能再拉起'],
    ['POST', '/api/hosts/cpu-build/start', 'no_dsh 的主机不能拉起'],
    ['POST', '/api/hosts/gpu-4090-daily/stop', 'ready 的主机没有进程可关'],
    ['POST', '/api/hosts/gpu-4090-daily/reconnect', 'ready 的主机没有隧道可重连'],
  ];
  for (const [method, p, why] of conflicts) {
    const err = grab(() => req(manager, method, p));
    assert.ok(err instanceof FakeApiError, why);
    assert.ok([403, 409].includes(err.status), `${p} 应是 403/409，实际 ${err.status}`);
    assertShape(
      errorBody,
      { error: err.message, code: err.code, ...(err.detail ? { detail: err.detail } : {}) },
      `${p} 错误体`,
    );
  }

  const missing = grab(() => req(manager, 'POST', '/api/hosts/nope/start'));
  assert.equal(missing.status, 404);
  assert.equal(missing.code, 'NOT_FOUND');
});

test('状态机是产品真身：非法迁移会被 assertTransition 挡住', () => {
  const { manager } = rig();
  // ready → degraded 不在 TRANSITIONS 里，注入断联必须被拒（而不是画出一个不可能的状态）
  const err = grab(() => manager.injectTunnelDrop('gpu-4090-daily'));
  assert.equal(err.status, 409);
  assert.equal(machine.canTransition('ready', 'degraded'), false, '前提：这条迁移本就非法');
});

// ── SSE ─────────────────────────────────────────────────────────────────

test('SSE：首帧是 snapshot，五类帧都过契约，revision 单调递增', async () => {
  const r = rig();
  assert.equal(r.frames[0].type, 'snapshot', '订阅即先收 snapshot（13 §3.2）');

  // 把五类帧都逼出来
  req(r.manager, 'POST', '/api/hosts/gpu-4090-daily/start');
  req(r.manager, 'PUT', '/api/config/defaults', { body: { remoteWebPort: 8899 } });
  r.manager.injectTunnelDrop('gpu-a100');
  await r.settle();

  const kinds = new Set(r.frames.map((f) => f.type));
  for (const kind of ['snapshot', 'host-changed', 'operation-done', 'log-line', 'config-changed']) {
    assert.ok(kinds.has(kind), `没产出 ${kind} 帧`);
  }

  // 校验器要求 mappedUrl 是真实形态，逐帧归一后再过
  const normalized = r.frames.map((f) => {
    if (f.type === 'snapshot') return { ...f, data: { ...f.data, hosts: f.data.hosts.map(normalize) } };
    if (f.type === 'host-changed') return { ...f, data: { ...f.data, host: normalize(f.data.host) } };
    return f;
  });
  assertSseStream(normalized, { label: 'demo SSE' });
});

test('snapshot 自带 manager/defaults/hosts/logs 四件套，phase 都是合法枚举', () => {
  const r = rig();
  const snap = r.frames[0].data;
  assertShape(managerInfo, snap.manager, 'snapshot.manager');
  assert.ok(Array.isArray(snap.logs) && snap.logs.length > 0, 'snapshot 该带最近日志，首屏事件面板才不是空的');
  for (const host of snap.hosts) {
    assert.ok(PHASES.includes(host.phase), `未知 phase：${host.phase}`);
    assertShape(hostView, normalize(host), `snapshot 里的 ${host.name}`);
  }
});

test('mappedUrl 的有意偏离仅此一处：非 null 时必与 localPort、phase 自洽', async () => {
  const r = rig();
  req(r.manager, 'POST', '/api/hosts/gpu-4090-daily/start');
  await r.settle();

  for (const host of r.manager.hosts().hosts) {
    if (host.mappedUrl === null) {
      assert.ok(!['running', 'degraded'].includes(host.phase), `${host.name} 在 ${host.phase} 却没有 mappedUrl`);
      continue;
    }
    assert.ok(['running', 'degraded'].includes(host.phase));
    // demo 版形态：站内 mock 页 + 主机名 + 本机端口（真机是 http://127.0.0.1:<port>/）
    assert.match(host.mappedUrl, /^\.\.\/mock-dsh-web\/index\.html\?host=/);
    assert.ok(
      host.mappedUrl.endsWith(`&port=${host.tunnel.localPort}`),
      `${host.name} 的 mappedUrl 与 tunnel.localPort 不一致：${host.mappedUrl}`,
    );
    assert.ok(host.mappedUrl.includes(encodeURIComponent(host.name)), 'mappedUrl 必须带上主机名，否则四个 iframe 会互相串页');
  }
});

test('mock dsh web 是独立侧栏工作区轮廓，并保留 query 与 keep-alive 观察钩子', () => {
  const html = fs.readFileSync(new URL('../site/mock-dsh-web/index.html', import.meta.url), 'utf8');

  assert.match(html, /data-mock-dsh-web/, 'iframe 内容应有稳定的 Mock 根标记');
  assert.match(html, /演示内容 · Mock dsh web/, '必须明确标注这是演示内容');
  for (const copy of ['新会话', '工作区', '设置', '今天想在远端工作区完成什么？', '模式']) {
    assert.match(html, new RegExp(copy), `mock 缺少 dsh web 轮廓：${copy}`);
  }
  for (const id of ['hostName', 'conn', 'draft', 'keepNote', 'term', 'foot']) {
    assert.match(html, new RegExp(`id="${id}"`), `既有可观察钩子 #${id} 不得丢失`);
  }
  assert.match(html, /params\.get\('host'\)/, '应继续从 query 显示 host');
  assert.match(html, /params\.get\('port'\)/, '应继续从 query 显示 port');
  assert.match(html, /keepaliveForm/, '输入框必须属于不会触发页面跳转的演示表单');
  assert.doesNotMatch(html, /(?:src|href)="https?:\/\//, 'mock 页面不得加载外部资源');
});

// ── setup 模式（首启引导） ────────────────────────────────────────────────

test('setup 模式：门禁生效时只放行白名单，setup 提交后自动拉起勾了自启的主机', async () => {
  const r = rig({ setupCompleted: false });

  const info = req(r.manager, 'GET', '/api/manager/info');
  assertShape(managerInfo, info.json, 'setup 模式的 manager info');
  assert.equal(info.json.setupCompleted, false);
  assert.equal(info.json.setupGateActive, true);

  // 白名单外的一律 SETUP_REQUIRED
  const blocked = grab(() => req(r.manager, 'POST', '/api/hosts/gpu-a100/start'));
  assert.equal(blocked.status, 409);
  assert.equal(blocked.code, 'SETUP_REQUIRED');

  // settings route 的 setup gate 必须早于 host decode、query 与 handler/body；
  // 尾斜杠不匹配生产 route，因此仍由路由层给 404。
  const settingsGateCases = [
    ['GET', '/api/hosts/gpu-a100/dsh-settings', { query: 'path=synthetic' }],
    ['PUT', '/api/hosts/gpu-a100/dsh-settings', {
      query: '',
      hasQueryDelimiter: true,
      body: { unknown: true },
    }],
    ['GET', '/api/hosts/%/dsh-settings', { query: 'x=1' }],
    ['PUT', '/api/hosts/%/dsh-settings', { body: { unknown: true } }],
  ];
  for (const [method, pathname, options] of settingsGateCases) {
    const gated = grab(() => req(r.manager, method, pathname, options));
    assert.equal(gated.status, 409, `${method} ${pathname} 应先过 setup gate`);
    assert.equal(gated.code, 'SETUP_REQUIRED');
  }
  for (const method of ['GET', 'PUT']) {
    const trailing = grab(() => req(r.manager, method, '/api/hosts/gpu-a100/dsh-settings/', {
      query: 'x=1',
      ...(method === 'PUT' ? { body: { unknown: true } } : {}),
    }));
    assert.equal(trailing.status, 404, `${method} settings 尾斜杠不应进入 setup gate`);
    assert.equal(trailing.code, 'NOT_FOUND');
  }

  // 白名单内可用：主机清单（SSH + 恰好一台只驻内存的本机候选）+ 全量探测
  const hosts = req(r.manager, 'GET', '/api/hosts');
  assert.equal(hosts.status, 200);
  const localCandidates = hosts.json.hosts.filter((host) => host.local);
  assert.equal(localCandidates.length, 1, 'setup 应与产品 server 一样提供恰好一台本机候选');
  const [localCandidate] = localCandidates;
  assert.equal(localCandidate.config.local, true);
  assert.equal(localCandidate.config.localPort, null);
  assert.equal(localCandidate.sshInfo, null);
  assert.equal(localCandidate.orphaned, false);
  assert.equal(
    Object.hasOwn(req(r.manager, 'GET', '/api/config').json.hosts, localCandidate.name),
    false,
    'setup 本机候选只驻内存，提交前不应进入 config',
  );
  for (const host of hosts.json.hosts) {
    assert.equal(host.phase, 'unknown', '引导态下主机应从「等待探测」起步');
  }
  const createBlocked = grab(() => req(r.manager, 'POST', '/api/hosts/local', { body: {} }));
  assert.equal(createBlocked.status, 409, 'setup 门禁仍应拒绝普通创建本机 API');
  assert.equal(createBlocked.code, 'SETUP_REQUIRED');

  req(r.manager, 'POST', '/api/hosts/probe');
  await r.settle();
  assert.equal(r.manager.getHost('gpu-a100').phase, 'ready');

  const submitted = req(r.manager, 'GET', '/api/config').json;
  submitted.hosts[localCandidate.name] = structuredClone(localCandidate.config);
  submitted.hosts['gpu-a100'].autoStart = true;
  const res = req(r.manager, 'POST', '/api/setup', { body: submitted });
  assert.equal(res.status, 200);
  assertShape(setupResponse, res.json, 'POST /api/setup 响应');

  await r.settle(12);
  assert.equal(r.manager.managerInfo().setupCompleted, true, '门禁应已撤除');
  assert.equal(r.manager.getHost('gpu-a100').phase, 'running', '勾了开启链接的主机要被自动拉起');
  assert.equal(r.manager.getHost(localCandidate.name).local, true, 'setup 提交应兑现候选的本机身份');
  assert.equal(r.manager.config().hosts[localCandidate.name].local, true);
  assert.equal(r.manager.config().hosts[localCandidate.name].localPort, null);
});

// ── 重置 ─────────────────────────────────────────────────────────────────

test('重置回到初始态：状态、端口分配与日志都复位', async () => {
  const r = rig();
  req(r.manager, 'POST', '/api/hosts/gpu-4090-daily/start');
  await r.settle();
  assert.equal(r.manager.getHost('gpu-4090-daily').phase, 'running');

  r.manager.reset({ mode: 'dashboard' });
  assert.equal(r.manager.getHost('gpu-4090-daily').phase, 'ready');
  assert.equal(r.manager.getHost('gpu-4090-daily').config.localPort, null, '端口分配也要复位');
  assert.equal(r.manager.getHost('gpu-a100').phase, 'running');

  // 重置会重新广播 snapshot，前端据此整体替换（13 §3.1）
  assert.equal(r.frames.at(-1).type, 'snapshot');
});
