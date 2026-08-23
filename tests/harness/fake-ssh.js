/**
 * fake-ssh 垫片（14 §1.1）：还原「目标主机 + 远端脚本 / 转发参数」，按主机名路由到假远端
 * 状态引擎，向 stdout/stderr/退出码回放**逐字节符合 12 §1 协议终稿**的输出。
 *
 * 它同时是协议的可执行规格：协议模板若改变形状，下面的参数抽取会失败并明确报错。
 *
 * 用法（集成测试注入）：DSHC_SSH_BIN="<node> <此文件>"，DSHC_HARNESS_DIR=<状态目录>
 */

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { posixCksum, SETTINGS_MAX_BYTES } from '../../src/settings-file.js';
import { host as hostState, mutate, readState } from './state.js';
import { unshq, unshqWorkdir } from './shell-word.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE_WEB = path.join(HERE, 'fake-dsh-web.js');
/** 假远端的 $HOME 展开值——ps 指纹里出现的绝对路径以此为准。 */
export const REMOTE_HOME = '/root';

const die = (msg) => {
  process.stderr.write(`fake-ssh: ${msg}\n`);
  process.exit(250);
};

// ── argv 还原 ────────────────────────────────────────────────────────────

function parseArgv(argv) {
  const out = { opts: [], forward: null, noExec: false, positional: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '-o') { out.opts.push(argv[i + 1]); i += 1; } else if (a === '-L') { out.forward = argv[i + 1]; i += 1; } else if (a === '-N') { out.noExec = true; } else if (a.startsWith('-')) { /* 忽略其余旗标 */ } else { out.positional.push(a); }
  }
  return out;
}

// ── 协议参数抽取（协议形状的可执行断言） ────────────────────────────────

function must(re, body, what) {
  const m = re.exec(body);
  if (!m) die(`协议形状不符，无法抽取${what}：\n${body}`);
  return m;
}

const logNameOf = (body) => must(/LOG="\$HOME\/\.dsh_center_remote\/([^"]+)"/, body, '日志名')[1];

function classify(body) {
  // settings 模板也含清理函数与大量旧协议关键字，必须先于既有模板判定。
  if (body.includes('SETTINGS_READ_DONE=yes')) return 'settings-read';
  if (body.includes('SETTINGS_WRITE_DONE=yes')) return 'settings-write';
  if (body.includes('PROBE_DONE')) return 'probe';
  if (body.includes('POLL_DONE')) return 'poll';
  if (body.includes('VERIFY_DONE')) return 'verify';
  if (body.includes('STOP_DONE')) return 'stop';
  if (body.includes('CLEAN_DONE')) return 'cleanup';
  if (body.includes('echo "PID=$!"')) return 'launch';
  if (body.startsWith('tail -n ')) return 'logtail';
  return die(`无法识别的协议脚本：\n${body}`);
}

function literalAssignment(body, name, valuePattern, what) {
  const re = new RegExp(`(?:^|; )${name}='(${valuePattern})'(?=; |$)`, 'gu');
  const matches = [...body.matchAll(re)];
  if (matches.length !== 1) {
    die(`协议形状不符，${name} 赋值应恰好出现一次，无法抽取${what}`);
  }
  return matches[0][1];
}

function settingsArgs(body, kind) {
  const txn = literalAssignment(
    body,
    'T',
    '[A-Za-z0-9][A-Za-z0-9_-]{0,63}',
    'settings 事务号',
  );
  if (kind === 'settings-read') return { txn };

  const expect = literalAssignment(body, 'EXPECT', '(?:yes|no)', 'settings EXPECT');
  const baseCrc = literalAssignment(body, 'BASE_CRC', '[0-9]*', 'settings base CRC');
  const baseSize = literalAssignment(body, 'BASE_SIZE', '[0-9]*', 'settings base size');
  if (expect === 'no') {
    if (baseCrc !== '' || baseSize !== '') {
      die('settings EXPECT=no 时 base CRC/size 必须为空');
    }
    return { txn, expect, baseCrc: null, baseSize: null };
  }
  if (
    !/^(?:0|[1-9][0-9]*)$/u.test(baseCrc)
    || !/^(?:0|[1-9][0-9]*)$/u.test(baseSize)
    || Number(baseCrc) > 0xffff_ffff
    || Number(baseSize) > SETTINGS_MAX_BYTES
  ) {
    die('settings EXPECT=yes 时 base CRC/size 形状无效');
  }
  return {
    txn,
    expect,
    baseCrc: Number(baseCrc),
    baseSize: Number(baseSize),
  };
}

/** 留一份运输层账本，供全链用例断言本机没有误起 ssh -L。 */
export function recordTransport(event) {
  const dir = process.env.DSHC_HARNESS_DIR;
  if (!dir) return;
  fs.appendFileSync(path.join(dir, 'transport.ndjson'), `${JSON.stringify(event)}\n`);
}

// ── 协议回放 ─────────────────────────────────────────────────────────────

const out = (s) => process.stdout.write(s);

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on('data', (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    process.stdin.once('error', reject);
    process.stdin.once('end', () => resolve(Buffer.concat(chunks)));
    process.stdin.resume();
  });
}

function sleepBlocking(ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) { /* spin：垫片是短命进程，无需异步 */ }
}

/**
 * 还原远端 `ps -eo pid,args | grep …` 那条流水线。
 *
 * 关键点：真远端的 ps 表里**也有执行本脚本的那层 `sh -c`**，它的命令行就是脚本自身，
 * 于是可能被脚本自己的 grep 命中（真机验收发现的自匹配）。垫片必须一并回放这一行，
 * 否则这类自匹配缺陷在假远端永远测不出来。自身 pid 借用垫片进程号，不会与登记的假
 * 远端 pid 相撞。
 */
function psMatches(h, body) {
  const rows = [];
  for (const [pid, p] of Object.entries(h.processes)) {
    if (alive(Number(pid), h)) rows.push({ pid: Number(pid), args: p.args });
  }
  rows.push({ pid: process.pid, args: `sh -c ${body}` });

  const excludesSelf = body.includes('grep -v "^ *$$ "');
  return rows.filter((r) => /dsh.*web/.test(`${r.pid} ${r.args}`))
    .filter((r) => !(excludesSelf && r.pid === process.pid));
}

function replyProbe(name, body) {
  const st = readState();
  const h = hostState({ hosts: st.hosts ?? {} }, name);
  if (h.faults.slowProbeMs) sleepBlocking(h.faults.slowProbeMs);

  out(`DSH_BIN=${h.dshInstalled ? h.dshPath : 'MISSING'}\n`);
  if (h.dshInstalled) out(`DSH_VERSION=${h.dshVersion}\n`);
  out(`DSH_HOME=${h.dshHome}\n`);
  out(`PROFILE_WEB=${h.profileWeb ? 'yes' : 'no'}\n`);
  out('RUNNING_DSH_WEB<<EOF\n');
  for (const r of psMatches(h, body)) {
    out(`${String(r.pid).padStart(6, ' ')} ${r.args}\n`);
  }
  out('EOF\n');
  out('PROBE_DONE=yes\n');
}

/** 真进程存活 + 引擎登记 双重判定（remote-crash 故障靠删登记生效）。 */
function alive(pid, h) {
  if (!h.processes[String(pid)]) return false;
  if (h.processes[String(pid)].dead) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function logPath(name, logName) {
  const dir = path.join(process.env.DSHC_HARNESS_DIR, 'remote', name);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, logName);
}

/**
 * 启动目录（补丁 01 §4.1）：cd 段可选，缺失即 workdir=null（远端 $HOME 启动）。
 * 段在但形状不符 → die，这正是「协议模板改了形状此处必须跟着改」的断言点。
 */
function workdirOf(body, home) {
  const seg = /; cd -- (.+?) \|\| \{ echo "ERR=workdir"; printf 'WD=%s\\n' .+?; exit 8; \}/.exec(body);
  if (!seg) {
    if (body.includes('ERR=workdir')) die(`cd 段形状不符，无法抽取启动目录：\n${body}`);
    return null;
  }
  return unshqWorkdir(seg[1], home);
}

function replyLaunch(name, body, { home }) {
  const logName = logNameOf(body);
  const workdir = workdirOf(body, home);
  // 真机形态：--patch（启动器旗标）紧跟 web，--no-open 等 app 旗标在其后
  const patchNames = [...body.matchAll(/--patch "\$HOME\/\.dsh_center_remote\/patches\/([^"]+)"/g)].map((m) => m[1]);
  const portTok = must(/dsh web(?: --patch "[^"]+")* --no-open --host 127\.0\.0\.1 --port (\d+)/, body, '端口')[1];

  const envSeg = /nohup env ((?:[A-Za-z_][A-Za-z0-9_]*='(?:[^']|'\\'')*' )+)dsh web/.exec(body);
  const envPairs = envSeg
    ? [...envSeg[1].matchAll(/([A-Za-z_][A-Za-z0-9_]*)=('(?:[^']|'\\'')*')/g)].map(([, k, v]) => [k, unshq(v)])
    : [];

  const tailSeg = /--port \d+((?: '(?:[^']|'\\'')*')*) > "\$LOG"/.exec(body);
  const extraArgs = tailSeg
    ? [...tailSeg[1].matchAll(/ '((?:[^']|'\\'')*)'/g)].map((m) => unshq(`'${m[1]}'`))
    : [];

  const file = logPath(name, logName);
  fs.writeFileSync(file, ''); // 真脚本里 `: > "$LOG"` 排在 cd 之前，失败也已截断

  // cd 失败：脚本以 8 退出且不产生 PID，日志停留在空文件
  if (workdir !== null && hostState({ hosts: readState().hosts ?? {} }, name).faults.badWorkdir) {
    out('ERR=workdir\n');
    out(`WD=${workdir}\n`);
    process.exit(8);
  }

  // 故障判定按「第几次拉起」而非端口：bindBusyTimes=1 只影响首拍（覆盖降级成功路径），
  // 取大值则连降级的 --port 0 也回放 EADDRINUSE（覆盖 S5 双失败路径）。
  const { forceBindErr, failStart } = mutate((st) => {
    const h = hostState(st, name);
    h.launchCount += 1;
    return {
      forceBindErr: h.launchCount <= (h.faults.bindBusyTimes ?? 0),
      failStart: h.launchCount <= (h.faults.failStartTimes ?? 0),
    };
  });

  const args = [
    FAKE_WEB,
    '--port',
    portTok,
    '--label',
    name,
    '--cwd',
    workdir ?? home,
  ];
  const owner = process.env.DSHC_HARNESS_OWNER_PID;
  if (owner) args.push('--owner-pid', owner);
  if (forceBindErr) args.push('--force-bind-error');
  else if (failStart) args.push('--fail-start');

  const fd = fs.openSync(file, 'a');
  const child = spawn(process.execPath, args, { detached: true, stdio: ['ignore', fd, fd] });
  child.unref();
  fs.closeSync(fd);

  // 合成 ps 指纹：nohup/env 均 exec 链传递，最终 args 是 dsh web … 形态（12 §5.2）
  const fingerprint = [
    'dsh web',
    ...patchNames.map((n) => `--patch ${home}/.dsh_center_remote/patches/${n}`),
    '--no-open --host 127.0.0.1 --port',
    portTok,
    ...extraArgs,
  ].join(' ');

  mutate((st) => {
    const h = hostState(st, name);
    h.workdir = workdir; // 最近一次拉起收到的启动目录（集成测试据此断言协议形状）
    h.processes[String(child.pid)] = {
      args: fingerprint,
      requestedPort: portTok,
      logName,
      env: Object.fromEntries(envPairs),
      patches: patchNames,
      extraArgs,
      workdir,
    };
  });

  out(`PID=${child.pid}\n`);
}

function replyPoll(name, body) {
  const logName = logNameOf(body);
  const pid = Number(must(/kill -0 (\d+)/, body, 'PID')[1]);

  let text = '';
  try {
    text = fs.readFileSync(logPath(name, logName), 'utf8');
  } catch { /* 日志还没落地 */ }

  const url = /dsh web: http:\/\/127\.0\.0\.1:(\d+)/.exec(text);
  if (url) {
    out(`URL=${url[0]}\n`);
    // 记下实际端口，供 VERIFY 的 LISTEN 判据使用
    mutate((s) => {
      const proc = hostState(s, name).processes[String(pid)];
      if (proc) proc.actualPort = Number(url[1]);
    });
  }

  const st = readState();
  out(`ALIVE=${alive(pid, hostState({ hosts: st.hosts ?? {} }, name)) ? 'yes' : 'no'}\n`);
  out(`BIND_ERR=${/EADDRINUSE|address already in use/i.test(text) ? 'yes' : 'no'}\n`);
  out('POLL_DONE=yes\n');
}

function replyVerify(name, body, { home }) {
  const pid = Number(must(/ps -p (\d+) -o args=/, body, 'PID')[1]);
  const port = Number(must(/grep -q ":(\d+) "/, body, '端口')[1]);
  must(/if \[ -r \/proc\/\d+\/cwd \]/, body, 'CWD 回读段');

  const st = readState();
  const h = hostState({ hosts: st.hosts ?? {} }, name);
  const isAlive = alive(pid, h);

  if (isAlive) {
    out('ALIVE=yes\n');
    out('ARGS<<EOF\n');
    out(`${h.processes[String(pid)].args}\n`);
    out('EOF\n');
  } else {
    out('ALIVE=no\n');
  }

  if (h.faults.noSs) {
    out('LISTEN=unknown\n');
  } else {
    out(`LISTEN=${isAlive && listening(port) ? 'yes' : 'no'}\n`);
  }

  // /proc 不可读（非 Linux / 无权限）→ unknown，无害降级
  const wd = h.processes[String(pid)]?.workdir ?? null;
  const readable = isAlive && !h.faults.noProcCwd;
  out(`CWD=${readable ? (wd ?? home) : 'unknown'}\n`);
  out('VERIFY_DONE=yes\n');
}

/**
 * 垫片是同步短命进程，做不了真 TCP 探活，改查引擎登记的实际端口表
 * （由 POLL 在解析到 URL 时写入）。端口未登记时返回 true——对齐 LISTEN 在协议中的
 * 弱校验地位（`unknown` 与 `yes` 都不作否定证据，12 §1.3）。
 */
function listening(port) {
  const st = readState();
  for (const h of Object.values(st.hosts ?? {})) {
    for (const [pid, p] of Object.entries(h.processes)) {
      if (p.actualPort === undefined) continue;
      if (p.actualPort === port && alive(Number(pid), h)) return true;
    }
  }
  return true;
}

function replyStop(name, body) {
  const pid = Number(must(/ps -p (\d+) -o args=/, body, 'PID')[1]);
  const fpWord = must(/\[ "\$A" = ('(?:[^']|'\\'')*') \]/, body, '指纹')[1];
  const expected = unshq(fpWord);

  const st = readState();
  const h = hostState({ hosts: st.hosts ?? {} }, name);

  if (!alive(pid, h)) {
    out('KILLED=already-dead\n');
    out('STOP_DONE=yes\n');
    return;
  }

  const actual = h.processes[String(pid)].args;
  if (actual !== expected) {
    out('KILLED=no\n');
    out('REASON=fingerprint-mismatch\n');
    out('ARGS<<EOF\n');
    out(`${actual}\n`);
    out('EOF\n');
    out('STOP_DONE=yes\n');
    return;
  }

  try { process.kill(pid, 'SIGTERM'); } catch { /* 竞态：刚好死了 */ }
  sleepBlocking(300);
  let stillAlive = true;
  try { process.kill(pid, 0); } catch { stillAlive = false; }
  if (stillAlive) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* ignore */ }
    out('KILLED=force\n');
  } else {
    out('KILLED=term\n');
  }
  mutate((s) => { hostState(s, name).processes[String(pid)].dead = true; });
  out('STOP_DONE=yes\n');
}

function replyCleanup(name, body) {
  const keep = new Set(must(/case " ([^"]*) " in/, body, '保留清单')[1].split(' ').filter(Boolean));
  mutate((st) => {
    const h = hostState(st, name);
    for (const f of Object.keys(h.files)) {
      const base = path.basename(f);
      if (f.startsWith('.dsh_center_remote/patches/') && !keep.has(base)) delete h.files[f];
    }
  });
  out('CLEAN_DONE=yes\n');
}

function replyLogTail(name, body) {
  const m = must(/^tail -n (\d+) "\$HOME\/\.dsh_center_remote\/([^"]+)"/, body, '日志参数');
  const lines = Number(m[1]);
  try {
    const text = fs.readFileSync(logPath(name, m[2]), 'utf8');
    out(text.split('\n').slice(-lines).join('\n'));
  } catch {
    out('(no log)\n');
  }
}

function settingsBytes(h) {
  if (!Object.hasOwn(h, 'settingsHex') || h.settingsHex === null) return null;
  if (
    typeof h.settingsHex !== 'string'
    || h.settingsHex.length % 2 !== 0
    || !/^[0-9a-fA-F]*$/u.test(h.settingsHex)
  ) {
    die('假远端 settingsHex 状态不是合法 hex');
  }
  return Buffer.from(h.settingsHex, 'hex');
}

function settingsPath(h) {
  if (typeof h.dshHome !== 'string' || !h.dshHome.startsWith('/')) {
    die('假远端 dshHome 必须是绝对路径');
  }
  return `${h.dshHome}/settings.yaml`;
}

const SETTINGS_STAGING_PREFIX = '.dsh_center_remote/settings-staging/';
const SETTINGS_STAGING_RESERVED_RE = /^(?:read-[^/]*\.(?:data|hex|hex-raw)|write-[^/]*\.data)$/u;

function isReservedSettingsStaging(file) {
  return file.startsWith(SETTINGS_STAGING_PREFIX)
    && SETTINGS_STAGING_RESERVED_RE.test(file.slice(SETTINGS_STAGING_PREFIX.length));
}

function beginSettingsStaging(name, kind, txn, content, { record = true } = {}) {
  const key = `${SETTINGS_STAGING_PREFIX}${kind}-${txn}.data`;
  mutate((state) => {
    const h = hostState(state, name);
    for (const file of Object.keys(h.files)) {
      if (isReservedSettingsStaging(file)) delete h.files[file];
    }
    if (record) h.files[key] = content.toString('hex');
  });
  return key;
}

function clearSettingsStaging(name, key) {
  mutate((state) => {
    delete hostState(state, name).files[key];
  });
}

function settingsHeader(txn) {
  out('SETTINGS_PROTO=1\n');
  out(`SETTINGS_TXN=${txn}\n`);
}

function settingsFailure(txn, marker, code, commitState = null) {
  settingsHeader(txn);
  out(`ERR=${marker}\n`);
  if (commitState !== null) out(`COMMIT_STATE=${commitState}\n`);
  process.exit(code);
}

function replySettingsRead(name, { txn }) {
  const st = readState();
  const h = hostState({ hosts: st.hosts ?? {} }, name);
  if (h.faults.settingsUnsupported) {
    settingsFailure(txn, 'settings-unsupported', 1);
  }

  const content = settingsBytes(h);
  const staging = beginSettingsStaging(
    name,
    'read',
    txn,
    content ?? Buffer.alloc(0),
    { record: content !== null || h.faults.settingsReadFail === true },
  );
  if (h.faults.settingsReadFail) {
    clearSettingsStaging(name, staging);
    settingsFailure(txn, 'settings-read', 1);
  }
  if (content !== null && content.byteLength > SETTINGS_MAX_BYTES) {
    clearSettingsStaging(name, staging);
    settingsFailure(txn, 'settings-too-large', 10);
  }

  settingsHeader(txn);
  if (content === null) {
    out('EXISTS=no\n');
    out('SIZE=0\n');
  } else {
    const crc = posixCksum(content);
    out('EXISTS=yes\n');
    out(`SIZE=${content.byteLength}\n`);
    out(`CRC=${h.faults.settingsProtocolCorrupt ? ((crc + 1) >>> 0) : crc}\n`);
  }
  out('PATH_HEX<<DSHC_PATH\n');
  out(`${Buffer.from(settingsPath(h)).toString('hex')}\n`);
  out('DSHC_PATH\n');
  out('CONTENT_HEX<<DSHC_CONTENT\n');
  if (content !== null && content.byteLength > 0) out(`${content.toString('hex')}\n`);
  out('DSHC_CONTENT\n');
  out('SETTINGS_READ_DONE=yes\n');
  clearSettingsStaging(name, staging);
}

function matchesSettingsBase(content, { expect, baseCrc, baseSize }) {
  if (expect === 'no') return content === null;
  return content !== null
    && content.byteLength === baseSize
    && posixCksum(content) === baseCrc;
}

function replySettingsWrite(name, {
  txn, expect, baseCrc, baseSize, input,
}) {
  const before = readState();
  const initial = hostState({ hosts: before.hosts ?? {} }, name);
  if (initial.faults.settingsUnsupported) {
    settingsFailure(txn, 'settings-unsupported', 1);
  }
  const staging = beginSettingsStaging(name, 'write', txn, input);
  if (initial.faults.settingsCatastrophicAfterStaging) {
    // 模拟 SIGKILL/机器掉电：没有协议结果，也来不及 trap 清理；下次设置操作负责收尸。
    process.exit(99);
  }
  if (input.byteLength > SETTINGS_MAX_BYTES) {
    clearSettingsStaging(name, staging);
    settingsFailure(txn, 'settings-too-large', 10, 'not-committed');
  }
  if (initial.faults.settingsWriteFail) {
    clearSettingsStaging(name, staging);
    settingsFailure(txn, 'settings-write', 12, 'not-committed');
  }

  // 第一次 CAS：核对 base 后发布上一版备份，正式目标仍保持原样。
  const firstCas = mutate((state) => {
    const h = hostState(state, name);
    const current = settingsBytes(h);
    if (current !== null && current.byteLength > SETTINGS_MAX_BYTES) {
      return { stale: false, tooLarge: true, unknownBeforeCommit: false };
    }
    if (!matchesSettingsBase(current, { expect, baseCrc, baseSize })) {
      return { stale: true, tooLarge: false, unknownBeforeCommit: false };
    }
    h.backup = current === null
      ? { previousHex: null, absent: true, mode: 0o600 }
      : { previousHex: current.toString('hex'), absent: false, mode: 0o600 };
    return {
      stale: false,
      tooLarge: false,
      unknownBeforeCommit: h.faults.settingsWriteUnknownBeforeCommit === true,
    };
  });

  if (firstCas.tooLarge) {
    clearSettingsStaging(name, staging);
    settingsFailure(txn, 'settings-too-large', 10, 'not-committed');
  }
  if (firstCas.stale) {
    clearSettingsStaging(name, staging);
    settingsFailure(txn, 'settings-stale', 11, 'not-committed');
  }
  if (firstCas.unknownBeforeCommit) {
    clearSettingsStaging(name, staging);
    settingsFailure(txn, 'settings-write', 12, 'unknown');
  }

  // 外部编辑器恰好在两次 CAS 之间落盘；第二次检查必须看见并拒绝覆盖。
  mutate((state) => {
    const h = hostState(state, name);
    const external = h.faults.settingsChangeBeforeSecondCas;
    if (external === undefined || external === false) return;
    const content = external === true
      ? 'external-second-cas: synthetic\n'
      : String(external);
    h.settingsHex = Buffer.from(content).toString('hex');
    h.settingsMode = 0o600;
  });

  // 第二次 CAS：只有正式目标仍与原 base 一致才到达提交点。
  const secondCas = mutate((state) => {
    const h = hostState(state, name);
    const current = settingsBytes(h);
    if (current !== null && current.byteLength > SETTINGS_MAX_BYTES) {
      return { stale: false, tooLarge: true, unknownAfterCommit: false };
    }
    if (!matchesSettingsBase(current, { expect, baseCrc, baseSize })) {
      return { stale: true, tooLarge: false, unknownAfterCommit: false };
    }
    h.settingsHex = input.toString('hex');
    h.settingsMode = 0o600;
    return {
      stale: false,
      tooLarge: false,
      unknownAfterCommit: h.faults.settingsWriteUnknown === true,
    };
  });

  clearSettingsStaging(name, staging);
  if (secondCas.tooLarge) {
    settingsFailure(txn, 'settings-too-large', 10, 'not-committed');
  }
  if (secondCas.stale) {
    settingsFailure(txn, 'settings-stale', 11, 'not-committed');
  }
  if (secondCas.unknownAfterCommit) {
    settingsFailure(txn, 'settings-write', 12, 'unknown');
  }

  const crc = posixCksum(input);
  settingsHeader(txn);
  out('PATH_HEX<<DSHC_PATH\n');
  out(`${Buffer.from(settingsPath(initial)).toString('hex')}\n`);
  out('DSHC_PATH\n');
  out(`NEW_SIZE=${input.byteLength}\n`);
  out(`NEW_CRC=${crc}\n`);
  out('SETTINGS_WRITE_DONE=yes\n');
}

/**
 * 同一套协议引擎供 fake-ssh 与 fake-local-sh 共用。运输层只注入主机身份与 HOME；
 * PROBE/LAUNCH/POLL/VERIFY/STOP/LOG/CLEANUP 的解析和状态变更只有这一份。
 */
export function dispatchProtocol(name, body, {
  home = REMOTE_HOME,
  transport = 'ssh',
  input = Buffer.alloc(0),
} = {}) {
  const kind = classify(body);
  const args = kind.startsWith('settings-') ? settingsArgs(body, kind) : null;
  recordTransport({ transport, kind, host: name, home });
  if (kind === 'settings-read') {
    replySettingsRead(name, args);
    return;
  }
  if (kind === 'settings-write') {
    replySettingsWrite(name, { ...args, input });
    return;
  }
  const handlers = {
    probe: replyProbe,
    launch: replyLaunch,
    poll: replyPoll,
    verify: replyVerify,
    stop: replyStop,
    cleanup: replyCleanup,
    logtail: replyLogTail,
  };
  handlers[kind](name, body, { home });
}

// ── 隧道形态（ssh -N -L） ────────────────────────────────────────────────

function runTunnel(name, forward) {
  const m = /^127\.0\.0\.1:(\d+):127\.0\.0\.1:(\d+)$/.exec(forward);
  if (!m) die(`无法解析 -L 参数：${forward}`);
  const localPort = Number(m[1]);
  const remotePort = Number(m[2]);

  const st = readState();
  const h = hostState({ hosts: st.hosts ?? {} }, name);
  const forwardDisabled = h.faults.forwardDisabled === true;

  const server = net.createServer((sock) => {
    if (forwardDisabled) {
      // 11 §5.3 的实现级修正：本地监听照常建立，每次连接才报错并被掐断
      process.stderr.write('channel 2: open failed: administratively prohibited: open failed\n');
      sock.destroy();
      return;
    }
    const upstream = net.connect(remotePort, '127.0.0.1');
    upstream.on('error', () => sock.destroy());
    sock.on('error', () => upstream.destroy());
    sock.pipe(upstream).pipe(sock);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      process.stderr.write(`bind [127.0.0.1]:${localPort}: Address already in use\n`);
      process.stderr.write(`channel_setup_fwd_listener_tcpip: cannot listen to port: ${localPort}\n`);
      process.exit(255);
    }
    process.stderr.write(`${err.message}\n`);
    process.exit(255);
  });

  server.listen(localPort, '127.0.0.1');
  // ssh -N 前台常驻：以子进程存活代表隧道存活

  // tunnel-drop 场景：外部信号让垫片自杀，模拟网络中断
  process.on('SIGUSR1', () => process.exit(255));
  // listener-drop 场景：只关本地监听、进程照活——这正是 monitor 要抓的异常
  // （11 §5.5「TCP 不通但子进程活着」），与真 ssh 转发通道半死时同构。
  // 关掉监听后事件循环就空了，需留一个句柄把进程按在前台，否则退化成 tunnel-drop。
  process.on('SIGUSR2', () => {
    server.close();
    setInterval(() => {}, 3_600_000);
  });
}

// ── 主流程 ───────────────────────────────────────────────────────────────

/**
 * sshd 的 `MaxStartups` 只数**尚未完成认证**的连接，认证一过就从额度里摘掉。
 * 额度是所有主机合起来算的（共用跳板机），所以记在全局而非某台的 faults 里。
 * 超额的连接在认证之前就被掐，真 ssh 客户端给的正是下面这句。
 */
const AUTH_WINDOW_MS = 150;

function admitOrDrop() {
  const cap = Number(process.env.DSHC_HARNESS_MAX_STARTUPS ?? '') || 0;
  if (!cap) return;
  const now = mutate((s) => {
    s.inflight = (s.inflight ?? 0) + 1;
    s.peakInflight = Math.max(s.peakInflight ?? 0, s.inflight);
    return s.inflight;
  });
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    mutate((s) => { s.inflight = Math.max(0, (s.inflight ?? 1) - 1); });
  };
  if (now > cap) {
    release();
    process.stderr.write('kex_exchange_identification: Connection closed by remote host\n');
    process.exit(255);
  }
  // 认证窗口一过就还额度。不能挂到进程退出去还——隧道那条 `ssh -N -L` 是常驻的，
  // 那样一条建成的隧道会把额度占一辈子，十条隧道之后谁也连不上了。真 sshd 不是这样：
  // 建成的连接早就不在 startups 账上。（此前正是这个建模错误伪造出「6 台永不自愈」。）
  const t = setTimeout(release, AUTH_WINDOW_MS);
  t.unref?.();
  process.on('exit', release);
}

export async function main(argv = process.argv.slice(2)) {
  const parsed = parseArgv(argv);
  const name = parsed.positional[0];
  if (!name) die('缺少目标主机');

  const input = await readStdin();
  const st0 = readState();
  const h0 = hostState({ hosts: st0.hosts ?? {} }, name);
  admitOrDrop();

  if (h0.faults.hostkeyFail) {
    process.stderr.write('Host key verification failed.\n');
    process.exit(255);
  }
  if (!h0.reachable) {
    process.stderr.write(`ssh: connect to host ${name} port 22: Operation timed out\n`);
    process.exit(255);
  }
  if (h0.faults.connTimeoutMs) {
    // 挂住不返回，供 sshExec/hostQueue 的强杀链与 unreachable 分类使用
    setTimeout(() => process.exit(255), h0.faults.connTimeoutMs);
  } else if (parsed.forward) {
    recordTransport({
      transport: 'ssh', kind: 'tunnel', host: name, forward: parsed.forward,
    });
    runTunnel(name, parsed.forward);
  } else {
    const raw = parsed.positional[1];
    if (raw === undefined) die('缺少远端命令');
    if (!raw.startsWith('sh -c ')) die(`远端命令未按 12 §0 包 sh -c：${raw}`);
    const body = unshq(raw.slice('sh -c '.length));
    dispatchProtocol(name, body, { home: REMOTE_HOME, transport: 'ssh', input });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => die('读取 stdin 失败'));
}
