/**
 * CLI 端到端（TST-08）：真的 spawn `node src/cli.js`，打到进程内跑着的 manager 上。
 *
 * 关注点是「脚本化可用」——退出码、终态等待、前缀匹配、断连提示，
 * 而不是重复验证 REST 层（那已由 flows/loop 覆盖）。
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { bootServer, newHostState, waitPhase } from './helpers.js';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'cli.js');

/**
 * @returns {Promise<{code:number, stdout:string, stderr:string}>}
 */
function dshc(ctx, args, { timeoutMs = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args, '--port', String(ctx.port)], {
      env: { ...process.env, ...ctx.harness.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`dshc ${args.join(' ')} 超时；stdout=${stdout} stderr=${stderr}`));
    }, timeoutMs);
    timer.unref?.();
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

test('dshc ls：表格与 --json 都能反映 manager 视图', async (t) => {
  const ctx = await bootServer(t, { hosts: { 'gpu-1': newHostState(), 'cpu-1': newHostState() } });
  await ctx.api('POST', '/api/hosts/probe');
  await waitPhase(ctx, 'gpu-1', ['ready']);

  const table = await dshc(ctx, ['ls']);
  assert.equal(table.code, 0);
  assert.match(table.stdout, /gpu-1/);
  assert.match(table.stdout, /可拉起/);

  const json = await dshc(ctx, ['ls', '--json']);
  assert.equal(json.code, 0);
  const hosts = JSON.parse(json.stdout);
  assert.deepEqual(hosts.map((h) => h.name).sort(), ['cpu-1', 'gpu-1']);
});

test('dshc start 等到 running 才退出（退出码 0），stop 回 ready', async (t) => {
  const ctx = await bootServer(t);
  await ctx.api('POST', '/api/hosts/probe');
  await waitPhase(ctx, 'gpu-1', ['ready']);

  const started = await dshc(ctx, ['start', 'gpu-1']);
  assert.equal(started.code, 0, `stdout=${started.stdout} stderr=${started.stderr}`);
  assert.match(started.stdout, /成功/);

  const view = (await ctx.get('/api/hosts')).json.hosts[0];
  assert.equal(view.phase, 'running');
  assert.ok(view.mappedUrl, 'CLI 拉起后应有本机映射');

  const stopped = await dshc(ctx, ['stop', 'gpu-1']);
  assert.equal(stopped.code, 0, `stdout=${stopped.stdout} stderr=${stopped.stderr}`);
  await waitPhase(ctx, 'gpu-1', ['ready']);
});

test('dshc restart <host>：中途掠过 ready 不算失败，等到 running 才退出 0', async (t) => {
  const ctx = await bootServer(t);
  await ctx.api('POST', '/api/hosts/probe');
  await waitPhase(ctx, 'gpu-1', ['ready']);
  const first = await dshc(ctx, ['start', 'gpu-1']);
  assert.equal(first.code, 0, `stdout=${first.stdout} stderr=${first.stderr}`);
  const before = (await ctx.get('/api/hosts')).json.hosts[0];

  // restart = stop→start，中间必然经过一次 ready；ready 在 restart 的 fail 集里，
  // 若不等 starting 就判定，CLI 会在拉起还在后台跑时误报失败（真机 IT-09 踩过）
  const res = await dshc(ctx, ['restart', 'gpu-1']);
  assert.equal(res.code, 0, `stdout=${res.stdout} stderr=${res.stderr}`);
  assert.match(res.stdout, /成功/);

  const after = (await ctx.get('/api/hosts')).json.hosts[0];
  assert.equal(after.phase, 'running');
  assert.notEqual(after.web.pid, before.web.pid, '远端换了新进程');
  assert.equal(after.tunnel.localPort, before.tunnel.localPort, '本机端口固定不变');
});

test('拉起失败 → 退出码 1 并打出错误摘要', async (t) => {
  const ctx = await bootServer(t);
  await ctx.api('POST', '/api/hosts/probe');
  await waitPhase(ctx, 'gpu-1', ['ready']);
  ctx.harness.scenario('gpu-1', 'launch-dies');

  const res = await dshc(ctx, ['start', 'gpu-1']);
  assert.equal(res.code, 1, `stdout=${res.stdout} stderr=${res.stderr}`);
  assert.match(res.stderr, /失败/);
});

test('--no-wait 立即返回 0，不等终态', async (t) => {
  const ctx = await bootServer(t);
  await ctx.api('POST', '/api/hosts/probe');
  await waitPhase(ctx, 'gpu-1', ['ready']);

  const res = await dshc(ctx, ['start', 'gpu-1', '--no-wait']);
  assert.equal(res.code, 0);
  assert.match(res.stdout, /已受理/);

  // 后台仍在推进：等它自己到 running，免得污染 t.after 的清理
  await waitPhase(ctx, 'gpu-1', ['running', 'ready', 'crashed']);
});

test('主机名前缀：唯一命中通过，歧义退出码 3 并列候选', async (t) => {
  const ctx = await bootServer(t, { hosts: { 'gpu-1': newHostState(), 'gpu-12': newHostState() } });
  await ctx.api('POST', '/api/hosts/probe');
  await waitPhase(ctx, 'gpu-1', ['ready']);

  const ambiguous = await dshc(ctx, ['probe', 'gpu']);
  assert.equal(ambiguous.code, 3);
  assert.match(ambiguous.stderr, /gpu-1, gpu-12/);

  const exact = await dshc(ctx, ['probe', 'gpu-1']);
  assert.equal(exact.code, 0, `stderr=${exact.stderr}`);

  const missing = await dshc(ctx, ['probe', 'zzz']);
  assert.equal(missing.code, 3);
});

test('dshc probe 无参触发全量探测', async (t) => {
  const ctx = await bootServer(t, { hosts: { 'gpu-1': newHostState(), 'cpu-1': newHostState() } });

  const res = await dshc(ctx, ['probe']);
  assert.equal(res.code, 0);
  assert.match(res.stdout, /全量探测/);
  await waitPhase(ctx, 'cpu-1', ['ready']);
});

test('dshc log 透传远端日志尾部', async (t) => {
  const ctx = await bootServer(t);
  await ctx.api('POST', '/api/hosts/probe');
  await waitPhase(ctx, 'gpu-1', ['ready']);
  await dshc(ctx, ['start', 'gpu-1']);

  const res = await dshc(ctx, ['log', 'gpu-1', '-n', '50']);
  assert.equal(res.code, 0, `stderr=${res.stderr}`);
  assert.match(res.stdout, /dsh web/);
});

test('dshc status：运行中三方核对通过', async (t) => {
  const ctx = await bootServer(t);
  const res = await dshc(ctx, ['status', '--json']);
  assert.equal(res.code, 0);
  const report = JSON.parse(res.stdout);
  assert.equal(report.running, true);
  assert.equal(report.port, ctx.port);
  assert.equal(report.setupCompleted, true);
});

test('dshc config get 读点路径；set 走 API 且提示重启需求', async (t) => {
  const ctx = await bootServer(t);

  const got = await dshc(ctx, ['config', 'get', 'defaults.remoteWebPort']);
  assert.equal(got.code, 0);
  assert.equal(got.stdout.trim(), '8899');

  const set = await dshc(ctx, ['config', 'set', 'defaults.remoteWebPort', '9100']);
  assert.equal(set.code, 0, `stderr=${set.stderr}`);
  assert.equal((await ctx.get('/api/config')).json.defaults.remoteWebPort, 9100);

  const portSet = await dshc(ctx, ['config', 'set', 'manager.port', '7999']);
  assert.equal(portSet.code, 0);
  assert.match(portSet.stdout, /需重启/);

  const refused = await dshc(ctx, ['config', 'set', 'hosts.gpu-1.autoStart', 'true']);
  assert.equal(refused.code, 3, '不在白名单的键不许乱写');
  assert.match(refused.stderr, /hosts\.<主机>\.workdir/, '错误提示要列出可写的主机级键');
});

test('dshc config set hosts.<主机>.workdir：落盘、清空与非法值三分支', async (t) => {
  const ctx = await bootServer(t);

  const set = await dshc(ctx, ['config', 'set', 'hosts.gpu-1.workdir', '~/proj']);
  assert.equal(set.code, 0, `stderr=${set.stderr}`);
  assert.match(set.stdout, /下次拉起时生效/);
  assert.equal((await ctx.get('/api/config')).json.hosts['gpu-1'].workdir, '~/proj');

  // 主机名前缀匹配与其他主机命令同款
  const byPrefix = await dshc(ctx, ['config', 'get', 'hosts.gpu-1.workdir']);
  assert.equal(byPrefix.stdout.trim(), '~/proj');

  const cleared = await dshc(ctx, ['config', 'set', 'hosts.gpu-1.workdir', 'null']);
  assert.equal(cleared.code, 0, `stderr=${cleared.stderr}`);
  assert.equal((await ctx.get('/api/config')).json.hosts['gpu-1'].workdir, null);

  const bad = await dshc(ctx, ['config', 'set', 'hosts.gpu-1.workdir', 'relative/dir']);
  assert.equal(bad.code, 1, `stdout=${bad.stdout}`);
  assert.match(bad.stderr, /VALIDATION/);

  const unknownHost = await dshc(ctx, ['config', 'set', 'hosts.zzz.workdir', '/tmp']);
  assert.equal(unknownHost.code, 3);
});

test('manager 不在时：需要服务的命令报错退出码 2', async (t) => {
  const ctx = await bootServer(t);
  // 直接打一个没人监听的端口，等价于 manager 未启动
  const dead = { ...ctx, port: 1 };
  const res = await dshc(dead, ['ls']);
  assert.equal(res.code, 2);
  assert.match(res.stderr, /dshc up/);
});
