/**
 * POSIX 单引号转义与命名校验（12 §2）。
 *
 * 转义防不了的两件事（12 §2.4，设计边界）：
 * 1. 参数语义注入：extraArgs 里的 '--port 9999' 转义后仍是合法参数，会与 manager 的
 *    --port 冲突。不禁止（用户自担），launcher 拼装时发 warn；actualPort 以日志解析为准。
 * 2. ssh 参数位注入：Host 名以 '-' 开头会被 ssh 当选项。由 assertSafeHost 统一把关。
 */

import { DshError } from './errors.js';

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SAFE_NAME_RE = /^[A-Za-z0-9._-]+$/;
const SAFE_HOST_RE = /^[A-Za-z0-9._-]+$/;
const INT_RE = /^[1-9][0-9]{0,9}$/;

/**
 * 任意字符串 → 可作为单个 shell 单词安全嵌入。
 * 算法：两端加 '，内部每个 ' 替换为 '\''（关引-转义引-开引）。
 * @param {string} s 任意 JS 字符串（含空串、换行、任意 Unicode）
 * @returns {string} 保证经任何 POSIX sh 解析后逐字还原 s
 */
export function shq(s) {
  if (typeof s !== 'string') throw new DshError('VALIDATION', `shq 只接受字符串，收到 ${typeof s}`);
  return `'${s.split("'").join("'\\''")}'`;
}

/**
 * env 键白名单校验。键不做转义——转义救不了不合法键，因为 `env K='v'` 的 `K=` 段在引号外。
 * @throws {DshError} VALIDATION
 */
export function assertEnvKey(k) {
  if (typeof k !== 'string' || !ENV_KEY_RE.test(k)) {
    throw new DshError('VALIDATION', `非法环境变量名：${JSON.stringify(k)}`, {
      detail: `环境变量名须匹配 ${ENV_KEY_RE}`,
    });
  }
  return k;
}

/** manager 自造文件名校验（logName / patch 远端名）。 */
export function assertSafeName(n) {
  if (typeof n !== 'string' || !SAFE_NAME_RE.test(n) || n.startsWith('-') || n.startsWith('.')) {
    throw new DshError('VALIDATION', `非法远端文件名：${JSON.stringify(n)}`, {
      detail: `文件名须匹配 ${SAFE_NAME_RE} 且不以 - 或 . 开头`,
    });
  }
  return n;
}

/** ssh Host 名校验（12 §2.4 第 2 条）。 */
export function assertSafeHost(h) {
  if (typeof h !== 'string' || !SAFE_HOST_RE.test(h) || h.startsWith('-')) {
    throw new DshError('VALIDATION', `主机名不适合作为 ssh 参数：${JSON.stringify(h)}`, {
      detail: `主机名须匹配 ${SAFE_HOST_RE} 且不以 - 开头（改 ~/.ssh/config 里的 Host 名）`,
    });
  }
  return h;
}

/**
 * 远端启动目录（工作区根）的形态判定。
 * 只认绝对路径与 `~` 前缀：相对路径「相对于什么」在 sshd 侧无从定义，拦在此处比
 * 让用户对着 `ERR=workdir` 猜要省心。其余字符 shq 都能安全引用，故不再多设字符集限制。
 */
export function isWorkdirPath(p) {
  if (typeof p !== 'string' || p.length === 0) return false;
  if (/[\0\n\r]/.test(p)) return false;
  return p.startsWith('/') || p === '~' || p.startsWith('~/');
}

/** @throws {DshError} VALIDATION */
export function assertWorkdir(p) {
  if (!isWorkdirPath(p)) {
    throw new DshError('VALIDATION', `非法远端启动目录：${JSON.stringify(p)}`, {
      detail: '须为绝对路径（/ 开头）或 ~、~/… 形态；不接受相对路径、空串与含换行/NUL 的值',
    });
  }
  return p;
}

/**
 * workdir → 可嵌入 `cd -- <TOK>` 的单个 shell 词。
 * `~` 不能进单引号（引号内不展开），改用 `"$HOME"` 与 shq 段相邻拼接——
 * POSIX 相邻字符串自然连成一个词，展开永远发生在远端。
 */
export function workdirToken(p) {
  assertWorkdir(p);
  if (p === '~') return '"$HOME"';
  if (p.startsWith('~/')) return `"$HOME"${shq(p.slice(1))}`;
  return shq(p);
}

/**
 * 整数校验后原样拼接（12 §1 的 [int] 标注）。数字不需转义，校验杜绝一切非数字。
 * @param {number|string} v
 * @param {{min?:number, max?:number, allowZero?:boolean}} [opts]
 */
export function assertInt(v, { min = 1, max = 65535, allowZero = false } = {}) {
  const s = String(v);
  if (allowZero && s === '0') return '0';
  if (!INT_RE.test(s)) {
    throw new DshError('VALIDATION', `期望整数，收到 ${JSON.stringify(v)}`);
  }
  const n = Number(s);
  if (n < min || n > max) {
    throw new DshError('VALIDATION', `整数越界：${n} 不在 ${min}..${max}`);
  }
  return s;
}

export { ENV_KEY_RE, SAFE_NAME_RE, SAFE_HOST_RE };
