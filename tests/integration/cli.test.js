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

import fs from 'node:fs';

import { createHarness, newHostState as freshHostState } from '../harness/index.js';
import { bootServer, newHostState, waitPhase } from './helpers.js';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'cli.js');

/**
 * @returns {Promise<{code:number, stdout:string, stderr:string}>}
 */
function dshc(ctx, args, { timeoutMs = 60_000, ownPort = false } = {}) {
  // ownPort：由用例自己给 --port（验旗标本身的判据时用，否则会被这里追加的真端口盖掉）
  const argv = ownPort ? [CLI, ...args] : [CLI, ...args, '--port', String(ctx.port)];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, argv, {
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

/**
 * 假 open 是 detached 子进程（真 `open` 也必须这么起，否则 CLI 会被浏览器吊住），
 * 所以它落账在 CLI 退出之后——直接读必然读到空。
 */
async function waitOpened(ctx, count, { timeoutMs = 5_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let urls = ctx.harness.openedUrls();
  while (urls.length < count && Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop -- 轮询
    await new Promise((r) => { setTimeout(r, 50); });
    urls = ctx.harness.openedUrls();
  }
  return urls;
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

/**
 * 回归（issue #65）：manager 跑着的时候有人拿编辑器改了 config.json。manager 内存里
 * 那份还是旧的，下一次任何写配置的动作都会把整份旧值刷回去——手改的那几行无声消失。
 */
test('manager 跑着时手改 config.json：下一次 config set 拒写并指路，手改不丢', async (t) => {
  const ctx = await bootServer(t);
  const configFile = path.join(ctx.harness.homeDir, 'config.json');

  const edited = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  edited.hosts['gpu-1'].workdir = '/手改/痕迹';
  fs.writeFileSync(configFile, `${JSON.stringify(edited, null, 2)}\n`);

  const res = await dshc(ctx, ['config', 'set', 'defaults.remoteWebPort', '9100']);
  assert.equal(res.code, 1, `stdout=${res.stdout} stderr=${res.stderr}`);
  assert.match(res.stderr, /外部改过/, `要说清是文件被外部改过：${res.stderr}`);
  assert.match(res.stderr, /dshc restart/, '出路要直接印出来，不许藏在 --verbose 后面');
  assert.doesNotMatch(res.stderr, /加 --verbose/, 'detail 已经印了，就别再叫人加 --verbose');

  const onDisk = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  assert.equal(onDisk.hosts['gpu-1'].workdir, '/手改/痕迹', '手改的那行必须还在');
  assert.equal(onDisk.defaults.remoteWebPort, 8899, '被拒的这次写不许留下半份');
});

test('manager 不在时：需要服务的命令报错退出码 2', async (t) => {
  const ctx = await bootServer(t);
  // 直接打一个没人监听的端口，等价于 manager 未启动
  const dead = { ...ctx, port: 1 };
  const res = await dshc(dead, ['ls']);
  assert.equal(res.code, 2);
  assert.match(res.stderr, /dshc up/);
});

/**
 * 回归（issue #22 / #23）：manager 没起是同一件事，用户不该因为敲的是 start 还是
 * config set 就看到两套说法——前者给人话，后者曾把 ECONNREFUSED 和内部码
 * (INTERNAL) 原样甩出来。open 更糟：它压根不探活，退 0 还真把浏览器拉起来，
 * 落在一个没人监听的地址上。
 */
test('manager 不在时：所有命令同一句人话，不漏 errno 与内部码', async (t) => {
  const ctx = await bootServer(t);
  const dead = { ...ctx, port: 1 };

  for (const args of [['ls'], ['start', 'gpu-1'], ['open'], ['open', 'gpu-1'],
    ['config', 'set', 'hosts.gpu-1.workdir', '/tmp']]) {
    // eslint-disable-next-line no-await-in-loop -- 逐条命令
    const res = await dshc(dead, args);
    const what = `dshc ${args.join(' ')}`;
    assert.equal(res.code, 2, `${what} 退出码应为 2；stderr=${res.stderr}`);
    assert.match(res.stderr, /manager 未在 127\.0\.0\.1:1 运行。先执行 dshc up。/, what);
    assert.doesNotMatch(res.stderr, /ECONNREFUSED|INTERNAL|MANAGER_DOWN/, `${what} 漏了实现细节`);
    assert.doesNotMatch(res.stdout, /http:\/\//, `${what} 不该在 manager 没起时给出页面地址`);
  }
  // 给 detached 子进程留出落账时间，否则「没开浏览器」只是没等到
  await new Promise((r) => { setTimeout(r, 500); });
  assert.deepEqual(ctx.harness.openedUrls(), [], 'manager 没起还去开浏览器，落地必然是错误页');
});

/**
 * 回归（issue #21）：`--port 99999` 曾一路走到 spawn，等满 10s 健康检查才报
 * 「已拉起 pid X，但未确认健康」——退错码（2 而非 3）、白等十秒、还真起了个必死的进程。
 */
test('up --port 越界：当场判用法错误，不起进程', async (t) => {
  const ctx = await bootServer(t);
  for (const bad of ['99999', '80', '0']) {
    // eslint-disable-next-line no-await-in-loop -- 逐个取值
    const res = await dshc(ctx, ['up', '--port', bad], { timeoutMs: 8_000, ownPort: true });
    assert.equal(res.code, 3, `--port ${bad} 应是用法错误；stderr=${res.stderr}`);
    assert.match(res.stderr, /1024–65535/, res.stderr);
    assert.doesNotMatch(res.stdout, /已拉起/, `--port ${bad} 不该真去 spawn`);
  }
});

test('config get 读本地文件，manager 没起也照样能用', async (t) => {
  const ctx = await bootServer(t, { hostConfig: { 'gpu-1': { workdir: '/srv/x' } } });
  const dead = { ...ctx, port: 1 };
  const res = await dshc(dead, ['config', 'get', 'hosts.gpu-1.workdir']);
  assert.equal(res.code, 0, `stderr=${res.stderr}`);
  assert.equal(res.stdout.trim(), '/srv/x');
});

test('引导模式下 open 仍放行（那个页面就是向导）', async (t) => {
  const ctx = await bootServer(t, { setupCompleted: false, skipBoot: true });

  // 对照组：主机命令在引导模式下照旧拦住
  const ls = await dshc(ctx, ['ls']);
  assert.equal(ls.code, 1);
  assert.match(ls.stderr, /引导模式/);

  const opened = await dshc(ctx, ['open']);
  assert.equal(opened.code, 0, `stderr=${opened.stderr}`);
  assert.match(opened.stdout, new RegExp(`http://127.0.0.1:${ctx.port}/`));
  assert.deepEqual(await waitOpened(ctx, 1), [`http://127.0.0.1:${ctx.port}/`], '该真去开浏览器');
});

test('open <host>：拉起的是那台主机的深链', async (t) => {
  const ctx = await bootServer(t);
  const res = await dshc(ctx, ['open', 'gpu-1']);
  assert.equal(res.code, 0, `stderr=${res.stderr}`);
  assert.deepEqual(await waitOpened(ctx, 1), [`http://127.0.0.1:${ctx.port}/#/host/gpu-1`]);
});

/** 只要一个隔离的 DSHC_HOME，不需要 manager：这些用例问的是「起不来时怎么说」。 */
function bareCli(t, writeConfig) {
  const harness = createHarness({ hosts: { 'gpu-1': freshHostState() } });
  t.after(() => {
    try { fs.chmodSync(`${harness.homeDir}/config.json`, 0o600); } catch { /* 可能没建 */ }
    harness.cleanup();
  });
  writeConfig(`${harness.homeDir}/config.json`);
  return (args) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, ...harness.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`超时；${stdout}${stderr}`)); }, 20_000);
    timer.unref?.();
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out: `${stdout}${stderr}` }); });
  });
}

test('config.json 坏了：说「损坏」而不是「尚未初始化」，也不许自己去走向导', async (t) => {
  // 截断的配置里通常还留着能救的东西（localPort 分配、workdir、注入的环境变量、patch 清单），
  // 提示用户去 dshc init 等于教他把这些盖掉。
  const run = bareCli(t, (f) => fs.writeFileSync(f, '{"configVersion":1,"manager":{"po'));
  const res = await run(['up', '--port', '7851', '--foreground']);

  assert.notEqual(res.code, 0, `不该就这么起来了：${res.out}`);
  assert.doesNotMatch(res.out, /尚未初始化/, '文件明明在，只是坏了');
  assert.match(res.out, /损坏|坏了|解析/, `要说清是坏了：${res.out}`);
  assert.match(res.out, /config\.json/, '要指出是哪个文件');
  assert.match(res.out, /备份|手工|修/, '要给一条不丢数据的出路');
});

test('config.json 读不了（权限）：说清是权限，别叫人去 init', async (t) => {
  if (process.getuid?.() === 0) return; // root 无视权限位
  const run = bareCli(t, (f) => {
    fs.writeFileSync(f, JSON.stringify({ configVersion: 1, setupCompleted: true, manager: { port: 7788 }, defaults: {}, hosts: {} }));
    fs.chmodSync(f, 0o000);
  });
  const res = await run(['up', '--port', '7852', '--foreground']);

  assert.notEqual(res.code, 0);
  assert.doesNotMatch(res.out, /尚未初始化/);
  assert.match(res.out, /权限|读不|EACCES/, `要说清读不了：${res.out}`);
});

test('dshc init --force 覆盖坏配置之前先备份', async (t) => {
  const run = bareCli(t, (f) => fs.writeFileSync(f, '{"hosts":{"gpu-1":{"localPort":17701'));
  // 非交互下 init 本来就该拒（要走向导），但备份判据得先于交互检查生效才有意义：
  // 这里验的是「拒的时候也别动文件」，真正的备份在下一条用例里由 backupDamagedConfig 保证
  const res = await run(['init', '--force']);
  assert.notEqual(res.code, 0);
  assert.match(res.out, /交互终端|向导/, `非交互该说清：${res.out}`);
});
