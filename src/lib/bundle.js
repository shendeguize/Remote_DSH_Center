/**
 * 发布产物的命名与校验和口径 —— 纯内核，零 import。
 *
 * 构建端（scripts/build-bundle.mjs）产出什么名字、消费端（src/updater.js 与
 * install.sh 的 standalone 通道）去下载什么名字，必须是同一份规则：这类「两边各写一份
 * 字符串拼接」的地方一旦漂移，表现是 404 而不是报错，最难查。
 *
 * 落地形态（解包后）：
 *   <bundle 名>/bin/dshc            三行 shim，exec 自带 node 跑 app/src/cli.js
 *   <bundle 名>/runtime/bin/node    官方 Node 发行版二进制
 *   <bundle 名>/app/                产品本体（内容 = check.mjs 的 PACK_RULES 白名单）
 *   <bundle 名>/BUNDLE_INFO.json    通道识别标记（版本 / 架构 / 运行时版本 / 来源）
 */

/** 发布仓库（tag、Release、下载都指向它）。install.sh 有一份同值的默认，用例盯着两处一致。 */
export const RELEASE_REPO = 'shendeguize/Remote_DSH_Center';

/** 只发 mac：Linux 走 git 通道（本来就要求有 node），Windows 不支持。 */
export const BUNDLE_PLATFORM = 'darwin';

export const SUPPORTED_ARCHES = Object.freeze(['arm64', 'x64']);

export const SUMS_FILE = 'SHA256SUMS';

export const BUNDLE_INFO_FILE = 'BUNDLE_INFO.json';

/**
 * `uname -m` / `process.arch` 的各种写法归一到发布口径。
 * @returns {'arm64'|'x64'|null} 不支持的架构给 null，由调用方给人话提示
 */
export function normalizeArch(raw) {
  const arch = String(raw ?? '').trim().toLowerCase();
  if (arch === 'arm64' || arch === 'aarch64') return 'arm64';
  if (arch === 'x64' || arch === 'x86_64' || arch === 'amd64') return 'x64';
  return null;
}

/** 解包后的顶层目录名，也是 tar.gz 的主干名。 */
export function bundleDirName({ version, arch }) {
  return `dsh-center-v${version}-${BUNDLE_PLATFORM}-${arch}`;
}

/** Release 附件名。 */
export function assetName({ version, arch }) {
  return `${bundleDirName({ version, arch })}.tar.gz`;
}

/**
 * `shasum -a 256` 的输出格式：`<64 位十六进制><空白>[*]<文件名>`。
 * @returns {Map<string,string>} 文件名 → 小写 sha256
 */
export function parseSums(text) {
  const sums = new Map();
  for (const line of String(text ?? '').split('\n')) {
    const m = /^([0-9a-fA-F]{64})\s+\*?(\S.*)$/.exec(line.trim());
    if (m) sums.set(m[2].trim(), m[1].toLowerCase());
  }
  return sums;
}

/**
 * 反向：写 SHA256SUMS 文件。与 `shasum -a 256 -c` 兼容（两空格分隔）。
 * @param {Iterable<[string,string]>} entries [文件名, sha]
 */
export function formatSums(entries) {
  return `${[...entries].map(([name, sha]) => `${sha}  ${name}`).join('\n')}\n`;
}

/** 某个 tag 的 Release 元信息接口。 */
export function releaseByTagUrl(tag, repo = RELEASE_REPO) {
  return `https://api.github.com/repos/${repo}/releases/tags/${tag}`;
}

/** Release 列表接口（挑 latest / 含 pre-release 时用；GitHub 的 /latest 会跳过 pre-release）。 */
export function releasesUrl(repo = RELEASE_REPO, perPage = 30) {
  return `https://api.github.com/repos/${repo}/releases?per_page=${perPage}`;
}

/** 附件下载地址（走 releases/download，不需要鉴权）。 */
export function assetUrl({ tag, name, repo = RELEASE_REPO }) {
  return `https://github.com/${repo}/releases/download/${tag}/${name}`;
}
