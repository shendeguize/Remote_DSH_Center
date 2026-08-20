/**
 * SemVer 解析与比较（含 pre-release 优先级）—— 纯内核，零 import。
 *
 * 自己写而不抄一份三方实现，是因为零依赖底线；只写更新逻辑真正需要的部分：
 * 解析、比较、从一堆版本里挑最新。唯一不能凭直觉写对的是 pre-release 的优先级
 * （数字段按数值比、字母段按字典序、数字段永远小于字母段、字段少的更小、
 * 正式版大于同核心号的任何预发布），所以每条规则都在 tests/lib/semver.test.js
 * 里有对应用例。build 元数据（`+xxx`）按规范不参与比较。
 */

const SHAPE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/;

/** 数字段不许有前导零——否则 `1.0.01` 与 `1.0.1` 会各自成立，比较结果说不清。 */
const hasLeadingZero = (id) => /^\d+$/.test(id) && id.length > 1 && id.startsWith('0');

/**
 * @param {unknown} input 形如 `0.2.0` / `v0.2.0-rc.1` / `1.0.0+build.5`
 * @returns {{major:number, minor:number, patch:number, prerelease:readonly string[],
 *   build:string|null, version:string}|null} 形状不对给 null（调用方自己决定怎么报错）
 */
export function parseVersion(input) {
  const raw = String(input ?? '').trim();
  const m = SHAPE.exec(raw);
  if (!m) return null;

  const [, major, minor, patch, pre, build] = m;
  if ([major, minor, patch].some(hasLeadingZero)) return null;

  const prerelease = pre === undefined ? [] : pre.split('.');
  if (prerelease.some((id) => id === '' || hasLeadingZero(id))) return null;

  return Object.freeze({
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    prerelease: Object.freeze(prerelease),
    build: build ?? null,
    // 规整形态（去掉 v 前缀与 build 元数据），比较与展示都用它
    version: `${Number(major)}.${Number(minor)}.${Number(patch)}${pre ? `-${pre}` : ''}`,
  });
}

/** @returns {boolean} 合法且带 pre-release 后缀 */
export function isPrerelease(input) {
  const parsed = parseVersion(input);
  return Boolean(parsed) && parsed.prerelease.length > 0;
}

function compareIdentifiers(a, b) {
  const aNum = /^\d+$/.test(a);
  const bNum = /^\d+$/.test(b);
  if (aNum && bNum) return Math.sign(Number(a) - Number(b));
  if (aNum !== bNum) return aNum ? -1 : 1; // 数字段永远小于字母段
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * @param {string} a
 * @param {string} b
 * @returns {-1|0|1}
 * @throws {TypeError} 任一侧不是合法版本号
 */
export function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) throw new TypeError(`不是合法版本号：${pa ? b : a}`);

  for (const key of ['major', 'minor', 'patch']) {
    if (pa[key] !== pb[key]) return pa[key] < pb[key] ? -1 : 1;
  }

  const na = pa.prerelease.length;
  const nb = pb.prerelease.length;
  if (na === 0 && nb === 0) return 0;
  if (na === 0 || nb === 0) return na === 0 ? 1 : -1; // 正式版 > 预发布

  for (let i = 0; i < Math.max(na, nb); i += 1) {
    const x = pa.prerelease[i];
    const y = pb.prerelease[i];
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1; // 字段少的更小
    const verdict = compareIdentifiers(x, y);
    if (verdict !== 0) return verdict;
  }
  return 0;
}

/**
 * 从候选里挑最新的一个。非法版本号一律忽略（Release 页面上难免有杂项 tag）。
 * @param {Iterable<string>} versions
 * @param {{includePrerelease?:boolean}} [opts] 默认只看正式版——「稳定用户不该被动吃到 rc」
 * @returns {string|null} 原样返回入选的那个字符串；无可用候选给 null
 */
export function pickLatest(versions, { includePrerelease = false } = {}) {
  let best = null;
  for (const candidate of versions) {
    const parsed = parseVersion(candidate);
    if (!parsed) continue;
    if (!includePrerelease && parsed.prerelease.length > 0) continue;
    if (best === null || compareVersions(candidate, best) > 0) best = candidate;
  }
  return best;
}
