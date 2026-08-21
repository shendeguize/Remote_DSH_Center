/**
 * 远端协议模板构建 + 输出解析（规格 = 12 文档 §1、§3、§7）。
 *
 * 统一包装约定（12 §0）：最终 argv 为 spawn('ssh', [...COMMON_SSH_OPTS, host, 'sh -c ' + shq(body)])。
 * body 为单行 POSIX 脚本，语句以 '; ' 连接；唯一后台化语句 `nohup … &` 必须以 '; ' 与
 * 前文隔离——若用 && 链接，`A && B &` 会把整个 AND 列表放入后台子壳，$! 拿到的是子壳 PID。
 */

import { DshError } from './errors.js';
import { assertEnvKey, assertInt, assertSafeName, shq, workdirToken } from './shq.js';
import { REMOTE_DIR } from '../defaults.js';

/** 超时与轮询参数（12 §3 汇总）——集中此处便于调优。 */
export const PROTO_TIMING = Object.freeze({
  onceTimeoutMs: 15_000, // 单条一次性 ssh 命令（02 §5.3）
  scpTimeoutMs: 60_000, // 每个 patch 文件
  startBudgetMs: 90_000, // start 队列任务总预算
  pollFirstDelayMs: 1_000, // POLL 首拍 T+1s
  pollIntervalMs: 2_000, // 此后每 2s 一拍
  pollMaxAttempts: 5, // 最多 5 拍
  stopGraceSec: 3, // STOP 脚本内 TERM→KILL 间隔
  logTailLines: 50, // FAIL 收尾取日志尾行数
});

const remotePath = (rel) => `$HOME/${REMOTE_DIR}/${rel}`;

// ── §1.1 探测协议 ────────────────────────────────────────────────────────

/** 无注入值，模板为常量。 */
export function buildProbeScript() {
  return [
    'echo "DSH_BIN=$(command -v dsh || echo MISSING)"',
    'if command -v dsh >/dev/null 2>&1; then echo "DSH_VERSION=$(dsh --version 2>/dev/null | head -n 1)"; fi',
    'H="${DSH_HOME:-$HOME/.dsh}"',
    "printf 'DSH_HOME=%s\\n' \"$H\"",
    'if [ -d "$H/profiles/web" ]; then echo "PROFILE_WEB=yes"; else echo "PROFILE_WEB=no"; fi',
    'echo "RUNNING_DSH_WEB<<EOF"',
    // `[d]sh` 只躲过 grep 自己；执行本脚本的那层 sh -c 仍会被命中——它的命令行里
    // 既有 command -v dsh 又有 profiles/web。故再按 $$（本 shell 的 pid，子 shell 中
    // 不变）排掉自身那行，否则每次探测都凭空多出一个「手动实例」。
    'ps -eo pid,args | grep "[d]sh.*web" | grep -v "^ *$$ " || true',
    'echo "EOF"',
    'echo "PROBE_DONE=yes"',
  ].join('; ');
}

// ── §1.2 拉起协议 ────────────────────────────────────────────────────────

/**
 * @param {{logName:string, port:number|'0', env?:Record<string,string>,
 *          patchRemoteNames?:string[], extraArgs?:string[], workdir?:string|null}} p
 */
export function buildLaunchScript({
  logName, port, env = {}, patchRemoteNames = [], extraArgs = [], workdir = null,
}) {
  assertSafeName(logName);
  const portTok = assertInt(port, { min: 1, max: 65535, allowZero: true });

  let envp = '';
  const envEntries = Object.entries(env);
  if (envEntries.length > 0) {
    envp = `env ${envEntries.map(([k, v]) => `${assertEnvKey(k)}=${shq(String(v))}`).join(' ')} `;
  }

  const patchArgs = patchRemoteNames
    .map((n) => ` --patch "${remotePath(`patches/${assertSafeName(n)}`)}"`)
    .join('');
  const extra = extraArgs.map((a) => ` ${shq(String(a))}`).join('');

  // 前置语句以 '; ' 连接到 nohup（12 §0：若用 '&&'，`A && B &` 会把整个 AND 列表放入
  // 后台子壳，$! 拿到的是子壳 PID）。'&' 本身即后台化语句与 echo 之间的分隔符——
  // 其后不能再跟 ';'（POSIX 语法错误）。
  // workdir=null 时整段不生成，模板逐字退回补丁 01 之前的形态（零回归面）。
  // 落地物路径（日志、patches、--patch 参数）全是 $HOME 绝对形态，cd 影响不到它们。
  const cdStmt = workdir === null
    ? null
    : (() => {
      const wd = workdirToken(workdir);
      return `cd -- ${wd} || { echo "ERR=workdir"; printf 'WD=%s\\n' ${wd}; exit 8; }`;
    })();

  const prelude = [
    `mkdir -p "${remotePath('patches')}" || { echo "ERR=mkdir"; exit 9; }`,
    `LOG="${remotePath(logName)}"`,
    ': > "$LOG"',
    ...(cdStmt ? [cdStmt] : []),
  ].join('; ');
  // --patch 是 dsh 启动器自己的旗标，必须紧跟 `web` 排在 web app 旗标之前：真机
  // （dsh 0.1.0-rc.7）上 `dsh web --no-open ... --patch P` 会被 web app 判为
  // unknown option '--patch' 而直接退出。extraArgs 反过来是 app 参数，仍留在尾部。
  const launch = `nohup ${envp}dsh web${patchArgs} --no-open --host 127.0.0.1 --port ${portTok}${extra} > "$LOG" 2>&1 < /dev/null &`;
  return `${prelude}; ${launch} echo "PID=$!"`;
}

/** 一次往返同时取「URL / 进程存活 / 绑定错误」，驱动 §3 状态机少一半 ssh 轮次。 */
export function buildLaunchPollScript({ logName, pid }) {
  assertSafeName(logName);
  const pidTok = assertInt(pid, { min: 1, max: 4_294_967_295 });
  return [
    `LOG="${remotePath(logName)}"`,
    'U=$(grep -o "dsh web: http://127\\.0\\.0\\.1:[0-9][0-9]*" "$LOG" 2>/dev/null | head -n 1)',
    "if [ -n \"$U\" ]; then printf 'URL=%s\\n' \"$U\"; fi",
    `if kill -0 ${pidTok} 2>/dev/null; then echo "ALIVE=yes"; else echo "ALIVE=no"; fi`,
    'if grep -qiE "EADDRINUSE|address already in use" "$LOG" 2>/dev/null; then echo "BIND_ERR=yes"; else echo "BIND_ERR=no"; fi',
    'echo "POLL_DONE=yes"',
  ].join('; ');
}

/** manager 精析：对 kv.URL 再验并抽取 actualPort（12 §1.2 正则终稿）。 */
const URL_RE = /^dsh web: http:\/\/127\.0\.0\.1:(\d{1,5})$/;

export function parseLaunchUrl(url) {
  const m = URL_RE.exec(String(url).trim());
  if (!m) return null;
  const p = Number(m[1]);
  return p >= 1 && p <= 65535 ? p : null;
}

// ── §1.3 复核与停止协议 ──────────────────────────────────────────────────

/**
 * ALIVE（PID 存活）+ ARGS 块（指纹，manager 侧全等比对）+ LISTEN 三态
 * （ss 非必然存在，unknown 不作否定证据）+ CWD（进程实际工作目录）。
 *
 * CWD 是 best-effort 的**展示与诊断**字段：/proc 不存在或无权读时回 unknown。
 * 它绝不进不误杀判据集——判据只有 PID 存活与 ARGS 逐字全等（12 §1.3）。
 */
export function buildVerifyScript({ pid, port }) {
  const pidTok = assertInt(pid, { min: 1, max: 4_294_967_295 });
  const portTok = assertInt(port, { min: 1, max: 65535 });
  return [
    `A=$(ps -p ${pidTok} -o args= 2>/dev/null)`,
    'if [ -n "$A" ]; then echo "ALIVE=yes"; echo "ARGS<<EOF"; printf \'%s\\n\' "$A"; echo "EOF"; else echo "ALIVE=no"; fi',
    `if command -v ss >/dev/null 2>&1; then if ss -ltn 2>/dev/null | grep -q ":${portTok} "; then echo "LISTEN=yes"; else echo "LISTEN=no"; fi; else echo "LISTEN=unknown"; fi`,
    `if [ -r /proc/${pidTok}/cwd ]; then printf 'CWD=%s\\n' "$(readlink /proc/${pidTok}/cwd 2>/dev/null || echo unknown)"; else echo "CWD=unknown"; fi`,
    'echo "VERIFY_DONE=yes"',
  ].join('; ');
}

/**
 * 校验与 kill 在同一条命令内（03 §4.2 反竞态原则），匹配为与记录指纹**逐字全等**
 * （契约疑议 1 的落地口径）——全等成立必然蕴含「含 dsh」。
 */
export function buildStopScript({ pid, fingerprint }) {
  const pidTok = assertInt(pid, { min: 1, max: 4_294_967_295 });
  if (typeof fingerprint !== 'string' || fingerprint.length === 0) {
    throw new DshError('VALIDATION', '停止协议缺少命令行指纹，拒绝拼装（防误杀）');
  }
  return [
    `A=$(ps -p ${pidTok} -o args= 2>/dev/null)`,
    'if [ -z "$A" ]; then echo "KILLED=already-dead"',
    `elif [ "$A" = ${shq(fingerprint)} ]; then kill ${pidTok} 2>/dev/null; sleep ${PROTO_TIMING.stopGraceSec}; if kill -0 ${pidTok} 2>/dev/null; then kill -9 ${pidTok} 2>/dev/null; echo "KILLED=force"; else echo "KILLED=term"; fi`,
    'else echo "KILLED=no"; echo "REASON=fingerprint-mismatch"; echo "ARGS<<EOF"; printf \'%s\\n\' "$A"; echo "EOF"; fi',
    'echo "STOP_DONE=yes"',
  ].join('; ');
}

// ── §1.4 日志获取 ────────────────────────────────────────────────────────

/** 输出为裸日志文本，不走 KEY=VALUE 解析。 */
export function buildLogTailScript({ logName, lines }) {
  assertSafeName(logName);
  const n = assertInt(lines, { min: 1, max: 10_000 });
  return `tail -n ${n} "${remotePath(logName)}" 2>/dev/null || echo "(no log)"`;
}

// ── §1.5 patch 目录清理 ──────────────────────────────────────────────────

/**
 * 兼职保证 patches/ 目录存在（scp 无 mkdir -p 能力），因此**清理协议先于 scp 执行**。
 * 文件名是 manager 自造 [name] 字符集（无空格无引号），空格包裹匹配法安全。
 */
export function buildPatchCleanupScript({ keepNames = [] }) {
  const keep = keepNames.map((n) => assertSafeName(n)).join(' ');
  return [
    `mkdir -p "${remotePath('patches')}" || { echo "ERR=mkdir"; exit 9; }`,
    `cd "${remotePath('patches')}" || exit 9`,
    `for f in *; do [ -e "$f" ] || continue; case " ${keep} " in *" $f "*) ;; *) rm -f -- "$f" ;; esac; done`,
    'echo "CLEAN_DONE=yes"',
  ].join('; ');
}

// ── §7 协议输出解析器 ────────────────────────────────────────────────────

const KV_RE = /^([A-Z][A-Z0-9_]*)=(.*)$/;
const BLOCK_OPEN_RE = /^([A-Z][A-Z0-9_]*)<<([A-Za-z_]+)$/;

/**
 * @typedef {{kv: Record<string, string[]>, blocks: Record<string, string>, stray: string[]}} ProtoOutput
 * @param {string} stdout
 * @param {{requireDone?:string}} [opts] 如 'PROBE_DONE'——缺哨兵抛 PROTO_PARSE
 * @returns {ProtoOutput}
 */
export function parseProtoOutput(stdout, { requireDone } = {}) {
  const text = String(stdout ?? '').replace(/\r/g, '');
  const lines = text.split('\n');

  /** @type {Record<string,string[]>} */
  const kv = {};
  /** @type {Record<string,string>} */
  const blocks = {};
  const stray = [];

  let blockKey = null;
  let blockDelim = null;
  let blockLines = [];

  for (const line of lines) {
    if (blockKey !== null) {
      if (line === blockDelim) {
        blocks[blockKey] = blockLines.join('\n');
        blockKey = null;
        blockDelim = null;
        blockLines = [];
      } else {
        blockLines.push(line);
      }
      continue;
    }

    if (line === '') continue;

    const open = BLOCK_OPEN_RE.exec(line);
    if (open) {
      blockKey = open[1];
      blockDelim = open[2];
      blockLines = [];
      continue;
    }

    const pair = KV_RE.exec(line);
    if (pair) {
      (kv[pair[1]] ??= []).push(pair[2]);
      continue;
    }

    stray.push(line);
  }

  if (blockKey !== null) {
    throw new DshError('PROTO_PARSE', `远端输出的 ${blockKey} 块未闭合（缺 ${blockDelim} 界符行）`, {
      detail: text,
    });
  }

  if (requireDone && kv[requireDone]?.[0] !== 'yes') {
    throw new DshError('PROTO_PARSE', `远端输出缺少 ${requireDone} 哨兵（输出被截断或连接中断）`, {
      detail: text,
    });
  }

  return { kv, blocks, stray };
}

/** 取单值（重复键取最后一个，缺失返回 fallback）。 */
export function kvOne(out, key, fallback = null) {
  const arr = out.kv[key];
  return arr && arr.length > 0 ? arr[arr.length - 1] : fallback;
}
