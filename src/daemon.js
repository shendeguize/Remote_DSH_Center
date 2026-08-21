/**
 * manager 自身的生命周期设施（11 §6.4）：detach 拉起、pidfile、launchd 服务化。
 *
 * 只依赖 defaults（叶子），不 import server/store——「谁拉起谁」这件事必须能在
 * server 尚未存在的情况下完成（dshc up 的第一拍）。
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { LAUNCHD_LABEL, resolvePaths } from './defaults.js';
import { DshError } from './lib/errors.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SERVER_ENTRY = path.join(HERE, 'server.js');
export const CLI_ENTRY = path.join(HERE, 'cli.js');

/** @typedef {{pid:number, port:number, mode:'foreground'|'background'|'launchd', startedAt:string}} PidInfo */

function paths() {
  return resolvePaths();
}

/** DSHC_MODE 由拉起方注入（plist / launchDetached）；缺省即前台。 */
export function detectMode(env = process.env) {
  const m = env.DSHC_MODE;
  return m === 'launchd' || m === 'background' ? m : 'foreground';
}

// ── pidfile ──────────────────────────────────────────────────────────────

/** @returns {PidInfo|null} */
export function readPidfile() {
  try {
    const raw = JSON.parse(fs.readFileSync(paths().pidfile, 'utf8'));
    if (!Number.isInteger(raw?.pid)) return null;
    return raw;
  } catch {
    return null;
  }
}

export function writePidfile(info) {
  const p = paths();
  try {
    fs.mkdirSync(p.dir, { recursive: true });
    const tmp = `${p.pidfile}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, `${JSON.stringify(info, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, p.pidfile);
  } catch (err) {
    // 没有 pidfile 就没人能找到这个 manager（stop/restart/CLI 全靠它），故必须硬失败；
    // 但要给人话，别把 Node 的栈直接摔在用户脸上（issue #87）
    throw new DshError('PIDFILE_WRITE_FAILED', 'manager 的运行记录写不进去，没法启动', {
      detail: `文件：${p.pidfile}\n${err.code ?? ''} ${err.message}\n`.trim()
        + '\n常见原因：磁盘满、所在卷变成只读、目录属主不是当前用户（比如被 sudo 跑过一次）。',
      cause: err,
    });
  }
  return info;
}

/** 仅 pid===process.pid 才删（§3.4 竞态防护：别把继任者的 pidfile 删了）。 */
export function removePidfileIfOwn() {
  const info = readPidfile();
  if (info?.pid !== process.pid) return false;
  try {
    fs.rmSync(paths().pidfile, { force: true });
    return true;
  } catch {
    return false;
  }
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM'; // 存在但非本用户
  }
}

/** GET /api/manager/info（不经 store，daemon 要能在 server 之外独立判活）。 */
export function fetchInfo(port, { timeoutMs = 1_500 } = {}) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/api/manager/info', method: 'GET', timeout: timeoutMs },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { text += c; });
        res.on('end', () => {
          if (res.statusCode !== 200) return resolve(null);
          try {
            resolve(JSON.parse(text));
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
    req.end();
  });
}

/**
 * kill(pid,0) + info 双验证（防 PID 复用，02 §9.5）。
 * @returns {Promise<{alive:boolean, stale:boolean, info:PidInfo|null, remote:any|null}>}
 */
export async function aliveCheck() {
  const info = readPidfile();
  if (!info) return { alive: false, stale: false, info: null, remote: null };
  if (!processAlive(info.pid)) return { alive: false, stale: true, info, remote: null };

  const remote = await fetchInfo(info.port);
  if (!remote) return { alive: false, stale: true, info, remote: null };
  if (remote.pid !== info.pid) return { alive: false, stale: true, info, remote };
  return { alive: true, stale: false, info, remote };
}

// ── 后台拉起 ─────────────────────────────────────────────────────────────

/**
 * detach 拉起 server（§3.4 第 7 步同款）。stdout/stderr 以 O_APPEND 重定向到 manager.log，
 * 两进程短暂共写安全。
 *
 * 预算内没确认健康就把它收回来（issue #77）：留着不管的话，命令报了失败，那个进程
 * 还在后台待着——等占着端口的人一走它自己就把端口接过去，用户手上于是有一个
 * 「启动失败过」的 manager 在跑。
 *
 * `entry` / `DSHC_SERVER_ENTRY` 是测试缝（同 `DSHC_SSH_BIN` 的用法）：换一个永远不落
 * pidfile 的假 manager，才能验「没确认健康」这条路。
 * @returns {Promise<{pid:number, port:number|null, confirmed:boolean, reaped:boolean}>}
 */
export async function launchDetached({
  port = null,
  waitMs = Number(process.env.DSHC_UP_WAIT_MS ?? '') || 10_000,
  env = {},
  entry = process.env.DSHC_SERVER_ENTRY || SERVER_ENTRY,
} = {}) {
  const p = paths();
  let fd;
  try {
    fs.mkdirSync(p.dir, { recursive: true });
    // 后台 manager 的 stdout/stderr 就指这个 fd；开不出来它就是个没有现场的黑箱，不如不起
    fd = fs.openSync(p.log, 'a');
  } catch (err) {
    throw new DshError('LOGFILE_OPEN_FAILED', 'manager 的日志文件打不开，没法启动', {
      detail: `文件：${p.log}\n${err.code ?? ''} ${err.message}`.trim()
        + '\n常见原因：磁盘满、所在卷变成只读、目录属主不是当前用户（比如被 sudo 跑过一次）。',
      cause: err,
    });
  }

  const args = [entry];
  if (port !== null) args.push('--port', String(port));

  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: ['ignore', fd, fd],
    env: { ...process.env, ...env, DSHC_MODE: 'background' },
  });
  child.unref();
  fs.closeSync(fd);

  const deadline = Date.now() + waitMs;
  let confirmed = false;
  let seenPort = port;
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop -- 就绪轮询
    await sleep(200);
    const info = readPidfile();
    if (!info) continue;
    // eslint-disable-next-line no-await-in-loop -- 同上
    const remote = await fetchInfo(info.port);
    if (remote?.pid === info.pid) {
      confirmed = true;
      seenPort = info.port;
      break;
    }
  }
  if (confirmed) return { pid: child.pid, port: seenPort, confirmed, reaped: false };
  return { pid: child.pid, port: seenPort, confirmed: false, reaped: await reap(child.pid) };
}

/**
 * 收走一个没确认健康的拉起：TERM → 1s → KILL。
 * @returns {Promise<boolean>} 真的动过手才算 true（它自己已经退了就不算）
 */
async function reap(pid, { graceMs = 1_000 } = {}) {
  if (!processAlive(pid)) return false;
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return false; // 竞态：刚好退了
  }
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline && processAlive(pid)) {
    // eslint-disable-next-line no-await-in-loop -- 等它落幕
    await sleep(50);
  }
  if (processAlive(pid)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // 已退出
    }
  }
  return true;
}

/**
 * 不能 unref：CLI 是短命进程，等待期间事件循环若无句柄会直接退出，
 * launchDetached / stopDaemon 的轮询就永远等不到结果（表现为命令静默返回）。
 */
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

/**
 * dshc down：launchd 实例走 bootout；裸后台走 TERM → 3s → KILL。
 * @returns {Promise<{stopped:boolean, mode:string|null, forced:boolean}>}
 */
export async function stopDaemon({ graceMs = 3_000 } = {}) {
  const check = await aliveCheck();
  if (!check.info) return { stopped: false, mode: null, forced: false };

  if (check.info.mode === 'launchd') {
    await serviceUninstall({ keepPlist: true });
    return { stopped: true, mode: 'launchd', forced: false };
  }

  const { pid } = check.info;
  if (!processAlive(pid)) {
    removeForeignPidfile(pid);
    return { stopped: false, mode: check.info.mode, forced: false };
  }

  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // 竞态：刚好退出
  }

  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline && processAlive(pid)) {
    // eslint-disable-next-line no-await-in-loop -- 等待退出
    await sleep(100);
  }
  let forced = false;
  if (processAlive(pid)) {
    forced = true;
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // 已退出
    }
    await sleep(200);
  }
  removeForeignPidfile(pid);
  return { stopped: true, mode: check.info.mode, forced };
}

/** 目标进程已死时清掉它留下的 pidfile（removePidfileIfOwn 只管自己那份）。 */
function removeForeignPidfile(pid) {
  const info = readPidfile();
  if (info?.pid === pid) {
    try {
      fs.rmSync(paths().pidfile, { force: true });
    } catch {
      // 忽略
    }
  }
}

// ── launchd（ENG-15） ────────────────────────────────────────────────────

export function buildPlist({
  logPath = paths().log, execPath = process.execPath, cliEntry = CLI_ENTRY, home = process.env.DSHC_HOME ?? null,
} = {}) {
  // 装服务时若当前用的是自定义 DSHC_HOME，必须一起写进 plist：
  // 否则 launchd 起来的实例会去读默认 ~/.dsh_center，等于悄悄换了一份配置
  const envEntries = [['DSHC_MODE', 'launchd']];
  if (home) envEntries.push(['DSHC_HOME', home]);
  const envXml = envEntries.map(([k, v]) => `<key>${k}</key><string>${v}</string>`).join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key><array>
    <string>${execPath}</string><string>${cliEntry}</string>
    <string>up</string><string>--foreground</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${logPath}</string>
  <key>StandardErrorPath</key><string>${logPath}</string>
  <key>EnvironmentVariables</key><dict>${envXml}</dict>
</dict></plist>
`;
}

function launchctl(args) {
  return new Promise((resolve) => {
    const child = spawn('launchctl', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', (err) => resolve({ code: null, stdout, stderr: String(err.message) }));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

const domain = () => `gui/${process.getuid?.() ?? 501}`;
const serviceTarget = () => `${domain()}/${LAUNCHD_LABEL}`;

/** install：先接管裸后台实例（02 §9.3 无缝接管）→ 写 plist → bootstrap。 */
export async function serviceInstall() {
  const p = paths();
  const check = await aliveCheck();
  if (check.alive && check.info?.mode !== 'launchd') await stopDaemon();

  fs.mkdirSync(path.dirname(p.plist), { recursive: true });
  fs.writeFileSync(p.plist, buildPlist());

  await launchctl(['bootout', serviceTarget()]); // 幂等：已加载则先卸
  const res = await launchctl(['bootstrap', domain(), p.plist]);
  return { ok: res.code === 0, plist: p.plist, stderr: res.stderr.trim() || null };
}

export async function serviceUninstall({ keepPlist = false } = {}) {
  const p = paths();
  const res = await launchctl(['bootout', serviceTarget()]);
  if (!keepPlist) {
    try {
      fs.rmSync(p.plist, { force: true });
    } catch {
      // 忽略
    }
  }
  return { ok: res.code === 0 || /not find|no such/i.test(res.stderr), stderr: res.stderr.trim() || null };
}

/** launchctl print 解析 state/pid。 */
export async function serviceStatus() {
  const p = paths();
  const installed = fs.existsSync(p.plist);
  const res = await launchctl(['print', serviceTarget()]);
  if (res.code !== 0) return { installed, loaded: false, state: null, pid: null };
  const state = /^\s*state\s*=\s*(\S+)/m.exec(res.stdout)?.[1] ?? null;
  const pid = Number(/^\s*pid\s*=\s*(\d+)/m.exec(res.stdout)?.[1] ?? NaN);
  return { installed, loaded: true, state, pid: Number.isInteger(pid) ? pid : null };
}
