/**
 * 守护进程生命周期端到端（TST-08 / ENG-14、ENG-21）：真的用 `dshc up` 起一个后台
 * manager，再 status / restart / down 收掉它。
 *
 * 这条线不能用进程内 bootServer 替代——pidfile、detach、SIGTERM 收尾只有真进程才算数。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { createHarness } from '../harness/index.js';
import { CONFIG_VERSION } from '../../src/defaults.js';
import * as daemon from '../../src/daemon.js';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'cli.js');

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** 起一个隔离环境：空主机清单（本用例只关心 manager 自身生命周期）。 */
async function isolate(t) {
  const harness = createHarness({ hosts: {} });
  const restore = harness.activate();
  const port = await freePort();

  fs.writeFileSync(path.join(harness.homeDir, 'config.json'), `${JSON.stringify({
    configVersion: CONFIG_VERSION,
    setupCompleted: true,
    manager: { port },
    defaults: { remoteWebPort: 8899, localPortRange: [17_701, 17_799] },
    hosts: {},
  }, null, 2)}\n`);

  t.after(async () => {
    await daemon.stopDaemon().catch(() => {});
    restore();
    harness.cleanup();
  });

  return { harness, port };
}

function dshc(env, args, { timeoutMs = 40_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, ...env },
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

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test('dshc up → status → down 走通裸后台模式', async (t) => {
  const { harness, port } = await isolate(t);

  const up = await dshc(harness.env, ['up']);
  assert.equal(up.code, 0, `stdout=${up.stdout} stderr=${up.stderr}`);
  assert.match(up.stdout, new RegExp(String(port)), '应报出实际监听端口');

  const pidfile = daemon.readPidfile();
  assert.ok(pidfile, '后台模式必须落 pidfile');
  assert.equal(pidfile.port, port);
  assert.equal(pidfile.mode, 'background');
  assert.equal(alive(pidfile.pid), true);

  const check = await daemon.aliveCheck();
  assert.equal(check.alive, true);
  assert.equal(check.remote.pid, pidfile.pid, 'pidfile 与 /api/manager/info 必须一致（防 PID 复用）');

  const status = await dshc(harness.env, ['status', '--json']);
  assert.equal(status.code, 0);
  const report = JSON.parse(status.stdout);
  assert.equal(report.running, true);
  assert.equal(report.mode, 'background');
  assert.equal(report.pid, pidfile.pid);

  // 重复 up 不该起第二个实例
  const again = await dshc(harness.env, ['up']);
  assert.equal(again.code, 0);
  assert.match(again.stdout, /已在运行/);
  assert.equal(daemon.readPidfile().pid, pidfile.pid);

  const down = await dshc(harness.env, ['down']);
  assert.equal(down.code, 0, `stderr=${down.stderr}`);
  assert.equal(alive(pidfile.pid), false, 'SIGTERM 后进程应退出');
  assert.equal(daemon.readPidfile(), null, '退出时要清掉 pidfile');

  const after = await dshc(harness.env, ['status']);
  assert.equal(after.code, 1, 'manager 未运行时 status 退出码 1');
  assert.match(after.stdout, /未运行/);
});

test('dshc restart 换一个新 pid 接管同端口', async (t) => {
  const { harness, port } = await isolate(t);
  await dshc(harness.env, ['up']);
  const before = daemon.readPidfile();

  const restarted = await dshc(harness.env, ['restart']);
  assert.equal(restarted.code, 0, `stdout=${restarted.stdout} stderr=${restarted.stderr}`);

  const after = daemon.readPidfile();
  assert.notEqual(after.pid, before.pid, '应是新进程');
  assert.equal(after.port, port, '端口不变');
  assert.equal(alive(before.pid), false, '旧进程必须已退出');

  const info = await daemon.fetchInfo(port);
  assert.equal(info.pid, after.pid);
});

test('stale pidfile：进程已死时 up 能自愈', async (t) => {
  const { harness, port } = await isolate(t);

  // 伪造一份指向不存在进程的 pidfile
  daemon.writePidfile({ pid: 999_999, port, mode: 'background', startedAt: new Date().toISOString() });
  const stale = await daemon.aliveCheck();
  assert.equal(stale.alive, false);
  assert.equal(stale.stale, true);

  const up = await dshc(harness.env, ['up']);
  assert.equal(up.code, 0, `stderr=${up.stderr}`);
  assert.match(up.stdout, /pidfile/, '应说明清理了残留');
  assert.equal((await daemon.aliveCheck()).alive, true);
});

test('POST /api/manager/restart：裸后台模式由继任者接管', async (t) => {
  const { harness, port } = await isolate(t);
  await dshc(harness.env, ['up']);
  const before = daemon.readPidfile();

  const res = await fetch(`http://127.0.0.1:${port}/api/manager/restart`, { method: 'POST' });
  assert.equal(res.status, 202);

  // 继任者需要一点时间释放端口再接管
  const deadline = Date.now() + 20_000;
  let info = null;
  while (Date.now() < deadline) {
    // 不能 unref：这是本用例唯一的活句柄，unref 会让 runner 判定事件循环已空
    // eslint-disable-next-line no-await-in-loop -- 轮询等待继任
    await new Promise((r) => { setTimeout(r, 200); });
    // eslint-disable-next-line no-await-in-loop -- 同上
    info = await daemon.fetchInfo(port);
    if (info && info.pid !== before.pid) break;
  }
  assert.ok(info, '继任者应在同端口起来');
  assert.notEqual(info.pid, before.pid);
  assert.equal(info.mode, 'background');

  // 前任让出端口与它真正落幕之间有个尾巴（flush state、关句柄），给它一点时间
  const exitBy = Date.now() + 5_000;
  while (alive(before.pid) && Date.now() < exitBy) {
    // eslint-disable-next-line no-await-in-loop -- 等前任落幕
    await new Promise((r) => { setTimeout(r, 100); });
  }
  assert.equal(alive(before.pid), false, '前任必须已退出');
});

/**
 * 回归（issue #77）：拉起后没在预算内确认健康，就得把它收回来。留着不管的话，
 * 命令明明报了失败，那个进程还在后台待着——等占着端口的人一走，它自己就把端口
 * 接过去了，用户手上于是有一个「启动失败过」的 manager 在跑，谁也不知道它是谁。
 */
test('拉起后没确认健康：把拉起的进程收回来，不留在后台', async (t) => {
  const { harness } = await isolate(t);

  // 一个永远不落 pidfile、也不监听的「manager」：健康确认必然超时
  const stuck = path.join(harness.homeDir, 'stuck-manager.js');
  fs.writeFileSync(stuck, 'setInterval(() => {}, 1000);\n');

  const res = await daemon.launchDetached({ waitMs: 600, entry: stuck });
  assert.equal(res.confirmed, false, '这个假 manager 压根不该被确认健康');
  assert.equal(res.reaped, true, '未确认就该收走');

  const deadline = Date.now() + 3_000;
  while (alive(res.pid) && Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop -- 等它落幕
    await new Promise((r) => { setTimeout(r, 50); });
  }
  assert.equal(alive(res.pid), false, `pid ${res.pid} 还在跑：这就是没人管的后台进程`);
});

test('dshc up 拉起失败时也照样收：报了失败就不许有进程留着', async (t) => {
  const { harness } = await isolate(t);
  const stuck = path.join(harness.homeDir, 'stuck-manager.js');
  fs.writeFileSync(stuck, 'setInterval(() => {}, 1000);\n');

  const res = await dshc({ ...harness.env, DSHC_SERVER_ENTRY: stuck, DSHC_UP_WAIT_MS: '600' }, ['up']);
  assert.equal(res.code, 2, `stdout=${res.stdout} stderr=${res.stderr}`);
  assert.match(res.stderr, /收走/, `要说清那个进程被收走了：${res.stderr}`);
  assert.match(res.stderr, /manager\.log/, '要指到日志，不然人无从下手');

  const pid = Number(/pid (\d+)/.exec(res.stderr)?.[1]);
  assert.ok(Number.isInteger(pid), `stderr 里要点出是哪个 pid：${res.stderr}`);
  assert.equal(alive(pid), false, '报了失败还留着进程');
});

test('launchd plist 快照：KeepAlive + 前台模式 + DSHC_MODE 注入', () => {
  const plist = daemon.buildPlist({
    logPath: '/tmp/x/manager.log',
    execPath: '/usr/local/bin/node',
    cliEntry: '/repo/src/cli.js',
    home: null,
  });

  assert.match(plist, /<key>Label<\/key><string>com\.dsh-center\.manager<\/string>/);
  assert.match(plist, /<string>\/usr\/local\/bin\/node<\/string><string>\/repo\/src\/cli\.js<\/string>/);
  assert.match(plist, /<string>up<\/string><string>--foreground<\/string>/);
  assert.match(plist, /<key>KeepAlive<\/key><true\/>/, '自动重启靠这一行');
  assert.match(plist, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(plist, /<key>ThrottleInterval<\/key><integer>10<\/integer>/);
  assert.match(plist, /DSHC_MODE<\/key><string>launchd<\/string>/);
  assert.match(plist, /StandardErrorPath<\/key><string>\/tmp\/x\/manager\.log/);
  assert.equal(/DSHC_HOME/.test(plist), false, '没自定义 home 时不写多余环境变量');
});

test('自定义 DSHC_HOME 会写进 plist：否则服务化会悄悄换配置目录', () => {
  const plist = daemon.buildPlist({ home: '/tmp/alt-home' });
  assert.match(plist, /DSHC_HOME<\/key><string>\/tmp\/alt-home<\/string>/);
});

test('dshc service status 在未安装时如实报告（不触碰 launchctl 状态）', async (t) => {
  const { harness } = await isolate(t);
  const res = await dshc(harness.env, ['service', 'status']);
  // 本机可能真装过服务；只断言输出形状与退出码约定，不改动系统状态
  assert.match(res.stdout, /plist：(已|未)安装/);
  assert.equal([0, 1].includes(res.code), true);
});

test('dshc logs 读 manager.log 尾部', async (t) => {
  const { harness } = await isolate(t);
  await dshc(harness.env, ['up']);

  const res = await dshc(harness.env, ['logs', '-n', '20']);
  assert.equal(res.code, 0, `stderr=${res.stderr}`);
  assert.ok(res.stdout.length > 0, 'manager 启动应至少写一行日志');
});
