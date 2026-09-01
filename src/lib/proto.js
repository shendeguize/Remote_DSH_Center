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

function dshPathToken(value) {
  // 省略仅保留给底层模板兼容调用；manager 的 start 路径总会传入已解析绝对路径。
  if (value === undefined) return 'dsh';
  if (value === null || value === '') return '';
  if (typeof value !== 'string' || !/^\/[^\0\r\n]*$/u.test(value)) {
    throw new DshError('VALIDATION', 'dshPath 必须是不含换行的绝对路径');
  }
  return shq(value);
}

/** 已解析绝对路径的所在目录；'dsh' 这类兼容形态没有目录可言，返回 null。 */
function binDir(value) {
  if (typeof value !== 'string' || !value.startsWith('/')) return null;
  const cut = value.lastIndexOf('/');
  return cut <= 0 ? '/' : value.slice(0, cut);
}

/**
 * 手动 dsh web 扫描（进程表 → RUNNING_DSH_WEB 块）。
 *
 * `dsh` 与 `web` 必须紧挨着：宽模式（`[d]sh.*web`）会把「命令行里同时提到 dsh 和
 * web 的进程」全算成实例——本机探测尤甚，Center 派给其他主机的 `ssh <host> sh -c
 * '<本脚本>'` 原样带着 `command -v dsh` 与 `profiles/web`，于是一轮 14 台的探测能在
 * 本机凭空变出五个「手动实例」，还会让本机的一步拉起变成领养对话框。
 *
 * 真实例的命令行里 `dsh web` 是相邻的两个词（`node /opt/homebrew/bin/dsh web …`）；
 * 拉起脚本里的路径经 shq 加了引号（`'/usr/bin/dsh' web …`），因此在飞的拉起 ssh 也
 * 不会被误命中。`[d]sh` 躲开 grep 自己，`$$` 排掉执行本脚本的那层 shell。
 */
export const MANUAL_WEB_GREP = '(^|[ /])[d]sh +web( |$)';

export const MANUAL_WEB_SCAN = `ps -eo pid,args | grep -E "${MANUAL_WEB_GREP}" | grep -v "^ *$$ " || true`;

/** 配置路径由 manager 注入，其余候选均在目标 shell 内按优先级解析。 */
export function buildProbeScript({ dshPath = null } = {}) {
  const configured = dshPathToken(dshPath);
  return [
    `CONFIG_DSH_PATH=${configured}`,
    'PATH_DSH=; if command -v dsh >/dev/null 2>&1; then PATH_DSH=$(command -v dsh 2>/dev/null | head -n 1); case "$PATH_DSH" in /*) ;; *) PATH_DSH=;; esac; fi',
    'H="${DSH_HOME:-$HOME/.dsh}"',
    "printf 'DSH_HOME=%s\\n' \"$H\"",
    'if [ -d "$H/profiles/web" ]; then echo "PROFILE_WEB=yes"; else echo "PROFILE_WEB=no"; fi',
    "printf 'PROBE_PATH=%s\\n' \"$PATH\"",
    'if command -v bash >/dev/null 2>&1; then echo "HAS_BASH=yes"; else echo "HAS_BASH=no"; fi',
    'if command -v timeout >/dev/null 2>&1; then echo "HAS_TIMEOUT=yes"; else echo "HAS_TIMEOUT=no"; fi',
    'SNIFF_PATH=',
    'echo "DSH_SNIFF<<EOF"',
    // canon 把 dsh 装进自己的 node 前缀（$HOME/.canon/node/bin），既不在非交互 PATH 里，
    // 也没有 /usr/local/bin 的软链——不扫这两个目录，装好的 pod 会被判成「远端未安装」。
    'for D in "$HOME/.local/bin" "$HOME/bin" "$HOME/.npm-global/bin" "$HOME/.canon/node/bin" "$HOME/.canon/bin" /usr/local/bin /usr/bin /usr/sbin /bin /opt/homebrew/bin /snap/bin; do if [ -x "$D/dsh" ]; then printf "%s\\n" "$D/dsh"; if [ -z "$SNIFF_PATH" ]; then SNIFF_PATH="$D/dsh"; fi; fi; done',
    'echo "EOF"',
    'LOGIN_DSH=',
    'if command -v timeout >/dev/null 2>&1 && command -v bash >/dev/null 2>&1; then LOGIN_DSH=$(timeout 5 bash -lc \'command -v dsh\' 2>/dev/null | head -n 1); case "$LOGIN_DSH" in /*) ;; *) LOGIN_DSH=;; esac; fi',
    // 装到交互 rc 里的工具（canon / nvm / asdf…）连 login shell 都看不见：Ubuntu 的
    // ~/.bashrc 顶部就有「非交互直接 return」的守卫，export PATH 那段在 -lc 下根本不执行。
    // 交互 rc 可能先打印横幅，故只收绝对路径行并取最后一行（command -v 的输出在最后）。
    // 上限比 login shell 那次更紧：两次嗅探要挤在同一条 15s 的 ssh 预算里，而慢到 3s
    // 的交互 rc 已属病态——canon 那类装法上面的目录扫描早就命中了。
    'if [ -z "$LOGIN_DSH" ] && command -v timeout >/dev/null 2>&1 && command -v bash >/dev/null 2>&1; then LOGIN_DSH=$(timeout 3 bash -lic \'command -v dsh\' 2>/dev/null | grep "^/" | tail -n 1); case "$LOGIN_DSH" in /*) ;; *) LOGIN_DSH=;; esac; fi',
    'printf "DSH_SNIFF_LOGIN=%s\\n" "$LOGIN_DSH"',
    'RESOLVED_DSH=; if [ -n "$CONFIG_DSH_PATH" ] && [ -x "$CONFIG_DSH_PATH" ]; then RESOLVED_DSH="$CONFIG_DSH_PATH"; elif [ -n "$PATH_DSH" ] && [ -x "$PATH_DSH" ]; then RESOLVED_DSH="$PATH_DSH"; elif [ -n "$SNIFF_PATH" ]; then RESOLVED_DSH="$SNIFF_PATH"; elif [ -n "$LOGIN_DSH" ] && [ -x "$LOGIN_DSH" ]; then RESOLVED_DSH="$LOGIN_DSH"; fi',
    'echo "DSH_BIN=${RESOLVED_DSH:-MISSING}"',
    // dsh 是 `#!/usr/bin/env node` 脚本：解释器和它同住一个 bin 目录，而那个目录不在
    // 非交互 PATH 里。不把它带上，绝对路径调用只会拿到「env: 'node': No such file」。
    'if [ -n "$RESOLVED_DSH" ]; then DSH_DIR="${RESOLVED_DSH%/*}"; echo "DSH_VERSION=$(PATH="${DSH_DIR:-/}:$PATH" "$RESOLVED_DSH" --version 2>/dev/null | head -n 1)"; fi',
    'if [ -z "$SNIFF_PATH" ] && [ -n "$LOGIN_DSH" ]; then SNIFF_PATH="$LOGIN_DSH"; fi',
    'if command -v timeout >/dev/null 2>&1 && [ -n "$SNIFF_PATH" ]; then SNIFF_DIR="${SNIFF_PATH%/*}"; DSH_SNIFF_VERSION=$(PATH="${SNIFF_DIR:-/}:$PATH" timeout 5 "$SNIFF_PATH" --version 2>/dev/null | head -n 1); printf "DSH_SNIFF_VERSION=%s\\n" "$DSH_SNIFF_VERSION"; fi',
    'echo "RUNNING_DSH_WEB<<EOF"',
    MANUAL_WEB_SCAN,
    'echo "EOF"',
    'echo "PROBE_DONE=yes"',
  ].join('; ');
}

/**
 * /proc/net/tcp 的端口是十六进制，而 mawk 没有 strtonum，故自带可移植转换。
 * 非法字符回 -1，落在端口区间校验之外，等同于「未探到」。
 */
const AWK_HEX2DEC = 'function hex2dec(s, i, c, v, d) { v = 0; s = toupper(s);'
  + ' for (i = 1; i <= length(s); i++) { c = substr(s, i, 1);'
  + ' d = index("0123456789ABCDEF", c) - 1; if (d < 0) return -1; v = v * 16 + d }'
  + ' return v }';

/** 发现 --port 0/缺失端口的手动 dsh web 实例实际监听端口。 */
export function buildManualPortProbeScript(pids) {
  if (!Array.isArray(pids) || pids.length === 0 || pids.length > 256) {
    throw new DshError('VALIDATION', '手动实例 PID 列表无效');
  }
  const pidTokens = pids.map((pid) => assertInt(pid, { min: 1, max: 4_294_967_295 }));
  return [
    'echo "MANUAL_PORTS<<EOF"',
    `for P in ${pidTokens.join(' ')}; do if command -v ss >/dev/null 2>&1; then ss -ltnp 2>/dev/null | awk -v p="$P" 'index($0, "pid=" p ",") || index($0, "pid=" p ")") { n=split($4,a,":"); port=a[n]; gsub(/[^0-9]/, "", port); if (port >= 1 && port <= 65535) print p "=" port; }'; elif command -v lsof >/dev/null 2>&1; then lsof -nP -a -p "$P" -iTCP -sTCP:LISTEN -F n 2>/dev/null | awk -v p="$P" '/^n/ { n=split($0,a,":"); port=a[n]; gsub(/[^0-9]/, "", port); if (port >= 1 && port <= 65535) print p "=" port; }'; elif [ -r /proc/net/tcp ]; then I=$(ls -l /proc/"$P"/fd 2>/dev/null | awk 'match($0, /socket:\\[[0-9]+\\]/) { print substr($0, RSTART + 8, RLENGTH - 9) }' | tr '\\n' ','); if [ -n "$I" ]; then cat /proc/net/tcp /proc/net/tcp6 2>/dev/null | awk -v p="$P" -v ino=",$I" '${AWK_HEX2DEC} $4=="0A" && index(ino, "," $10 ",") { n=split($2,a,":"); port=hex2dec(a[n]); if (port >= 1 && port <= 65535) print p "=" port; }'; fi; fi; done`,
    'echo "EOF"',
    'echo "MANUAL_PORTS_DONE=yes"',
  ].join('; ');
}

/** 解析 MANUAL_PORTS 块；坏行丢弃，探测失败按未知处理。 */
export function parseManualPortBlock(raw) {
  const ports = new Map();
  for (const line of String(raw ?? '').split('\n')) {
    const match = /^\s*(\d+)=(\d{1,5})\s*$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const port = Number(match[2]);
    if (pid > 0 && port >= 1 && port <= 65535) ports.set(pid, port);
  }
  return ports;
}

// ── §1.2 拉起协议 ────────────────────────────────────────────────────────

/**
 * @param {{logName:string, port:number|'0', dshPath:string, env?:Record<string,string>,
 *          patchRemoteNames?:string[], extraArgs?:string[], workdir?:string|null}} p
 */
export function buildLaunchScript({
  logName, port, dshPath, env = {}, patchRemoteNames = [], extraArgs = [], workdir = null,
}) {
  assertSafeName(logName);
  const portTok = assertInt(port, { min: 1, max: 65535, allowZero: true });
  const dshTok = dshPathToken(dshPath);
  if (!dshTok) throw new DshError('VALIDATION', '拉起协议缺少已解析的 dsh 绝对路径');

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

  // dsh 常常是 `#!/usr/bin/env node` 脚本，解释器与它同住一个 bin 目录（canon 装出来的
  // $HOME/.canon/node/bin 就是如此），而那个目录不在非交互 SSH 的 PATH 里。交互 shell
  // 里能跑的命令，在这里只会把「env: 'node': No such file」写进日志然后当场退出。
  const dshDir = binDir(dshPath);
  const pathStmt = dshDir === null ? null : `PATH=${shq(dshDir)}:"$PATH"; export PATH`;

  const prelude = [
    `mkdir -p "${remotePath('patches')}" || { echo "ERR=mkdir"; exit 9; }`,
    `LOG="${remotePath(logName)}"`,
    ': > "$LOG"',
    ...(cdStmt ? [cdStmt] : []),
    ...(pathStmt ? [pathStmt] : []),
  ].join('; ');
  // --patch 是 dsh 启动器自己的旗标，必须紧跟 `web` 排在 web app 旗标之前：真机
  // （dsh 0.1.0-rc.7）上 `dsh web --no-open ... --patch P` 会被 web app 判为
  // unknown option '--patch' 而直接退出。extraArgs 反过来是 app 参数，仍留在尾部。
  const launch = `nohup ${envp}${dshTok} web${patchArgs} --no-open --host 127.0.0.1 --port ${portTok}${extra} > "$LOG" 2>&1 < /dev/null &`;
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
 * 内核 /proc/net/tcp 的 local_address 端口写法：大写四位十六进制。
 * assertInt 返回的是已校验的字符串，这里显式转数值再取十六进制。
 */
function portHex(port) {
  return Number(port).toString(16).toUpperCase().padStart(4, '0');
}

/**
 * ALIVE（PID 存活）+ ARGS 块（指纹，manager 侧全等比对）+ LISTEN 三态
 * （ss 与 /proc/net/tcp 均不可得时才 unknown，unknown 不作否定证据）
 * + CWD（进程实际工作目录）。
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
    `if command -v ss >/dev/null 2>&1; then if ss -ltn 2>/dev/null | grep -q ":${portTok} "; then echo "LISTEN=yes"; else echo "LISTEN=no"; fi; elif [ -r /proc/net/tcp ]; then if cat /proc/net/tcp /proc/net/tcp6 2>/dev/null | awk -v h="${portHex(portTok)}" '$4=="0A" { n=split($2,a,":"); if (toupper(a[n])==h) f=1 } END { exit f?0:1 }'; then echo "LISTEN=yes"; else echo "LISTEN=no"; fi; else echo "LISTEN=unknown"; fi`,
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

// ── settings.yaml 固定路径读写协议 ───────────────────────────────────────

const SETTINGS_TXN_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const SETTINGS_CHECKSUM_RE = /^cksum-v1:(0|[1-9][0-9]{0,9}):(0|[1-9][0-9]{0,6})$/;

function settingsTxnToken(txn) {
  if (typeof txn !== 'string' || !SETTINGS_TXN_RE.test(txn)) {
    throw new DshError('VALIDATION', `非法 settings 事务号：${JSON.stringify(txn)}`, {
      detail: `事务号须匹配 ${SETTINGS_TXN_RE}`,
    });
  }
  return shq(txn);
}

function settingsBase(baseChecksum) {
  if (baseChecksum === null) {
    return { expect: shq('no'), crc: shq(''), size: shq('') };
  }
  if (typeof baseChecksum !== 'string') {
    throw new DshError('VALIDATION', 'settings baseChecksum 必须是 cksum-v1 token 或 null');
  }
  const match = SETTINGS_CHECKSUM_RE.exec(baseChecksum);
  if (!match || Number(match[1]) > 4_294_967_295 || Number(match[2]) > 524_288) {
    throw new DshError('VALIDATION', `非法 settings checksum：${JSON.stringify(baseChecksum)}`, {
      detail: 'checksum 须为 cksum-v1:<0..4294967295>:<0..524288>，且十进制数不得有前导零',
    });
  }
  return { expect: shq('yes'), crc: shq(match[1]), size: shq(match[2]) };
}

/**
 * 固定读取 `${DSH_HOME:-$HOME/.dsh}/settings.yaml`。
 * 内容经 POSIX od 输出 hex；txn 只派生管理目录内的短命快照名。
 */
export function buildSettingsReadScript({ txn } = {}) {
  const txnTok = settingsTxnToken(txn);
  return [
    'LC_ALL=C',
    'export LC_ALL',
    'umask 077',
    'set -f',
    `T=${txnTok}`,
    'H="${DSH_HOME:-$HOME/.dsh}"',
    'P="$H/settings.yaml"',
    'R="$HOME/.dsh_center_remote"',
    'S="$R/settings-staging"',
    'SNAP="$S/read-$T.data"',
    'HEX_RAW="$S/read-$T.hex-raw"',
    'HEX="$S/read-$T.hex"',
    'unsupported() { echo "ERR=settings-unsupported"; exit 1; }',
    'read_fail() { echo "ERR=settings-read"; exit 1; }',
    'is_uint() { case "$1" in ""|*[!0-9]*) return 1 ;; *) return 0 ;; esac; }',
    'parse_cksum() { set -- $1; [ "$#" -eq 2 ] || return 1; is_uint "$1" || return 1; is_uint "$2" || return 1; CK_CRC=$1; CK_SIZE=$2; }',
    'ensure_dir() { D=$1; if [ -L "$D" ]; then return 1; elif [ -e "$D" ]; then [ -d "$D" ] || return 1; else mkdir "$D" || return 1; fi; chmod 700 "$D" || return 1; }',
    'cleanup_staging() { set +f; rm -f "$S"/read-*.data "$S"/read-*.hex "$S"/read-*.hex-raw "$S"/write-*.data; RC=$?; set -f; return "$RC"; }',
    'cleanup_commit() { set +f; rm -f "$H"/.settings.yaml.dshc-*.tmp; RC=$?; set -f; return "$RC"; }',
    'emit_path() { printf \'%s\' "$P" | od -A n -v -t x1 > "$HEX_RAW" 2>/dev/null || read_fail; tr -d \'[:space:]\' < "$HEX_RAW" > "$HEX" || read_fail; echo "PATH_HEX<<DSHC_PATH"; cat "$HEX" || { echo; echo "DSHC_PATH"; read_fail; }; echo; echo "DSHC_PATH"; }',
    'echo "SETTINGS_PROTO=1"',
    'printf \'SETTINGS_TXN=%s\\n\' "$T"',
    'case "$HOME" in /*) ;; *) unsupported ;; esac',
    'case "$H" in /*) ;; *) unsupported ;; esac',
    'for C in command test printf mkdir chmod rm dd wc cksum od tr cat mv; do command -v "$C" >/dev/null 2>&1 || unsupported; done',
    'OD_PROBE=$(printf \'\\001\\377\' | od -A n -v -t x1 2>/dev/null | tr -d \'[:space:]\') || unsupported',
    '[ "$OD_PROBE" = 01ff ] || unsupported',
    'CK_OUT=$(printf x | cksum 2>/dev/null) || unsupported',
    'parse_cksum "$CK_OUT" || unsupported',
    '[ "$CK_CRC" = 12738659 ] && [ "$CK_SIZE" = 1 ] || unsupported',
    'ensure_dir "$R" || read_fail',
    'ensure_dir "$S" || read_fail',
    'cleanup_staging || read_fail',
    'if [ -d "$H" ]; then cleanup_commit || read_fail; fi',
    'trap \'rm -f "$SNAP" "$HEX_RAW" "$HEX"\' 0',
    'trap \'read_fail\' 1 2 3 15',
    'if [ -L "$P" ]; then read_fail; fi',
    'if [ ! -e "$P" ]; then echo "EXISTS=no"; echo "SIZE=0"; emit_path; echo "CONTENT_HEX<<DSHC_CONTENT"; echo "DSHC_CONTENT"; echo "SETTINGS_READ_DONE=yes"; exit 0; fi',
    '[ -f "$P" ] || read_fail',
    'dd if="$P" of="$SNAP" bs=524289 count=1 2>/dev/null || read_fail',
    'chmod 600 "$SNAP" || read_fail',
    'SIZE_RAW=$(wc -c < "$SNAP" 2>/dev/null) || read_fail',
    'SIZE=$(printf \'%s\' "$SIZE_RAW" | tr -d \'[:space:]\') || read_fail',
    'is_uint "$SIZE" || read_fail',
    '[ "$SIZE" -le 524288 ] || { echo "ERR=settings-too-large"; exit 10; }',
    'CK_OUT=$(cksum < "$SNAP" 2>/dev/null) || read_fail',
    'parse_cksum "$CK_OUT" || read_fail',
    '[ "$CK_SIZE" = "$SIZE" ] || read_fail',
    'echo "EXISTS=yes"',
    'printf \'SIZE=%s\\n\' "$SIZE"',
    'printf \'CRC=%s\\n\' "$CK_CRC"',
    'emit_path',
    'od -A n -v -t x1 "$SNAP" > "$HEX_RAW" 2>/dev/null || read_fail',
    'tr -d \'[:space:]\' < "$HEX_RAW" > "$HEX" || read_fail',
    'HEX_SIZE_RAW=$(wc -c < "$HEX" 2>/dev/null) || read_fail',
    'HEX_SIZE=$(printf \'%s\' "$HEX_SIZE_RAW" | tr -d \'[:space:]\') || read_fail',
    '[ "$HEX_SIZE" -eq "$((SIZE * 2))" ] || read_fail',
    'echo "CONTENT_HEX<<DSHC_CONTENT"',
    'cat "$HEX" || { echo; echo "DSHC_CONTENT"; read_fail; }',
    'echo',
    'echo "DSHC_CONTENT"',
    'echo "SETTINGS_READ_DONE=yes"',
  ].join('; ');
}

/**
 * 从 stdin 接收新内容并以 cksum-v1 双复核 CAS 提交到固定 settings 路径。
 * baseChecksum=null 表示只允许创建；string 表示只允许替换逐字相同的基线 token。
 */
export function buildSettingsWriteScript({ txn, baseChecksum } = {}) {
  const txnTok = settingsTxnToken(txn);
  const base = settingsBase(baseChecksum);
  return [
    'LC_ALL=C',
    'export LC_ALL',
    'umask 077',
    'set -f',
    `T=${txnTok}`,
    `EXPECT=${base.expect}`,
    `BASE_CRC=${base.crc}`,
    `BASE_SIZE=${base.size}`,
    'H="${DSH_HOME:-$HOME/.dsh}"',
    'P="$H/settings.yaml"',
    'R="$HOME/.dsh_center_remote"',
    'S="$R/settings-staging"',
    'B="$R/settings-backup"',
    'STAGE="$S/write-$T.data"',
    'TEMP="$H/.settings.yaml.dshc-$T.tmp"',
    'PREV="$B/previous.yaml"',
    'ABSENT="$B/previous.absent"',
    'BTMP="$B/previous-$T.tmp"',
    'ATMP="$B/absent-$T.tmp"',
    'COMMITTED=no',
    'commit_state() { if [ "$COMMITTED" = no ]; then echo "COMMIT_STATE=not-committed"; else echo "COMMIT_STATE=unknown"; fi; }',
    'unsupported() { echo "ERR=settings-unsupported"; exit 1; }',
    'write_fail() { echo "ERR=settings-write"; commit_state; exit 12; }',
    'stale() { echo "ERR=settings-stale"; commit_state; exit 11; }',
    'too_large() { echo "ERR=settings-too-large"; commit_state; exit 10; }',
    'is_uint() { case "$1" in ""|*[!0-9]*) return 1 ;; *) return 0 ;; esac; }',
    'parse_cksum() { set -- $1; [ "$#" -eq 2 ] || return 1; is_uint "$1" || return 1; is_uint "$2" || return 1; CK_CRC=$1; CK_SIZE=$2; }',
    'ensure_dir() { D=$1; if [ -L "$D" ]; then return 1; elif [ -e "$D" ]; then [ -d "$D" ] || return 1; else mkdir "$D" || return 1; fi; chmod 700 "$D" || return 1; }',
    'cleanup_managed() { set +f; rm -f "$S"/read-*.data "$S"/read-*.hex "$S"/read-*.hex-raw "$S"/write-*.data "$B"/previous-*.tmp "$B"/absent-*.tmp; RC=$?; set -f; return "$RC"; }',
    'cleanup_commit() { set +f; rm -f "$H"/.settings.yaml.dshc-*.tmp; RC=$?; set -f; return "$RC"; }',
    'emit_path() { echo "PATH_HEX<<DSHC_PATH"; if printf \'%s\' "$P" | od -A n -v -t x1; then :; else echo "DSHC_PATH"; write_fail; fi; echo "DSHC_PATH"; }',
    'read_current() { CUR_EXISTS=no; CUR_CRC=; CUR_SIZE=; if [ -L "$P" ]; then return 2; fi; if [ ! -e "$P" ]; then return 0; fi; [ -f "$P" ] || return 2; CUR_RAW=$(wc -c < "$P" 2>/dev/null) || return 3; CUR_SIZE=$(printf \'%s\' "$CUR_RAW" | tr -d \'[:space:]\') || return 3; is_uint "$CUR_SIZE" || return 3; [ "$CUR_SIZE" -le 524288 ] || return 4; CUR_OUT=$(cksum < "$P" 2>/dev/null) || return 3; parse_cksum "$CUR_OUT" || return 3; [ "$CK_SIZE" = "$CUR_SIZE" ] || return 5; CUR_EXISTS=yes; CUR_CRC=$CK_CRC; CUR_SIZE=$CK_SIZE; return 0; }',
    'load_current() { read_current; RC=$?; case "$RC" in 0) return 0 ;; 4) too_large ;; 5) stale ;; *) write_fail ;; esac; }',
    'match_base() { if [ "$EXPECT" = no ]; then [ "$CUR_EXISTS" = no ]; else [ "$CUR_EXISTS" = yes ] && [ "$CUR_CRC" = "$BASE_CRC" ] && [ "$CUR_SIZE" = "$BASE_SIZE" ]; fi; }',
    'echo "SETTINGS_PROTO=1"',
    'printf \'SETTINGS_TXN=%s\\n\' "$T"',
    'case "$HOME" in /*) ;; *) unsupported ;; esac',
    'case "$H" in /*) ;; *) unsupported ;; esac',
    'for C in command test printf mkdir chmod rm dd wc cksum od tr cat mv; do command -v "$C" >/dev/null 2>&1 || unsupported; done',
    'OD_PROBE=$(printf \'\\001\\377\' | od -A n -v -t x1 2>/dev/null | tr -d \'[:space:]\') || unsupported',
    '[ "$OD_PROBE" = 01ff ] || unsupported',
    'CK_OUT=$(printf x | cksum 2>/dev/null) || unsupported',
    'parse_cksum "$CK_OUT" || unsupported',
    '[ "$CK_CRC" = 12738659 ] && [ "$CK_SIZE" = 1 ] || unsupported',
    'ensure_dir "$R" || write_fail',
    'ensure_dir "$S" || write_fail',
    'ensure_dir "$B" || write_fail',
    'for F in "$PREV" "$ABSENT"; do if [ -L "$F" ]; then write_fail; fi; if [ -e "$F" ] && [ ! -f "$F" ]; then write_fail; fi; done',
    'cleanup_managed || write_fail',
    'trap \'rm -f "$STAGE" "$TEMP" "$BTMP" "$ATMP"\' 0',
    'trap \'write_fail\' 1 2 3 15',
    'cat > "$STAGE" || write_fail',
    'chmod 600 "$STAGE" || write_fail',
    'NEW_RAW=$(wc -c < "$STAGE" 2>/dev/null) || write_fail',
    'NEW_SIZE=$(printf \'%s\' "$NEW_RAW" | tr -d \'[:space:]\') || write_fail',
    'is_uint "$NEW_SIZE" || write_fail',
    '[ "$NEW_SIZE" -le 524288 ] || too_large',
    'NEW_OUT=$(cksum < "$STAGE" 2>/dev/null) || write_fail',
    'parse_cksum "$NEW_OUT" || write_fail',
    '[ "$CK_SIZE" = "$NEW_SIZE" ] || write_fail',
    'NEW_CRC=$CK_CRC',
    'NEW_SIZE=$CK_SIZE',
    'load_current',
    'match_base || stale',
    '[ -d "$H" ] || write_fail',
    'cd "$H" || write_fail',
    'cleanup_commit || write_fail',
    'cat "$STAGE" > "$TEMP" || write_fail',
    'chmod 600 "$TEMP" || write_fail',
    'TEMP_OUT=$(cksum < "$TEMP" 2>/dev/null) || write_fail',
    'parse_cksum "$TEMP_OUT" || write_fail',
    '[ "$CK_CRC" = "$NEW_CRC" ] && [ "$CK_SIZE" = "$NEW_SIZE" ] || write_fail',
    'if [ "$CUR_EXISTS" = yes ]; then if [ -L "$P" ] || [ ! -f "$P" ]; then write_fail; fi; cat "$P" > "$BTMP" || write_fail; chmod 600 "$BTMP" || write_fail; BACK_OUT=$(cksum < "$BTMP" 2>/dev/null) || write_fail; parse_cksum "$BACK_OUT" || write_fail; [ "$CK_CRC" = "$BASE_CRC" ] && [ "$CK_SIZE" = "$BASE_SIZE" ] || stale; mv -f "$BTMP" "$PREV" || write_fail; rm -f "$ABSENT" || write_fail; else : > "$ATMP" || write_fail; chmod 600 "$ATMP" || write_fail; mv -f "$ATMP" "$ABSENT" || write_fail; rm -f "$PREV" || write_fail; fi',
    'load_current',
    'match_base || stale',
    'COMMITTED=unknown',
    'mv -f "$TEMP" "$P" || write_fail',
    'COMMITTED=yes',
    'load_current',
    '[ "$CUR_EXISTS" = yes ] || write_fail',
    '[ "$CUR_CRC" = "$NEW_CRC" ] && [ "$CUR_SIZE" = "$NEW_SIZE" ] || stale',
    'emit_path',
    'printf \'NEW_SIZE=%s\\n\' "$NEW_SIZE"',
    'printf \'NEW_CRC=%s\\n\' "$NEW_CRC"',
    'echo "SETTINGS_WRITE_DONE=yes"',
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
