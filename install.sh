#!/usr/bin/env bash
#
# DSH Center 一键安装引导。
#
#   curl -fsSL https://raw.githubusercontent.com/shendeguize/Remote_DSH_Center/main/install.sh | bash
#
# 这个脚本**只做引导**，不复制任何安装逻辑。两条通道，自动选：
#
#   git         有 node ≥ 22 时走这条：clone 到 ~/.dsh_center/app 的 release 分支，
#               软链安装，`git pull` 即升级。
#   standalone  没有 node（或版本过低）时自动降级走这条：从 GitHub Releases 下
#               对应架构的发布包（自带官方 Node 运行时），核对 SHA256 后解包。
#               仅 macOS——Linux 上请自行装 Node ≥ 22 再重跑。
#
# 两条通道最后都交给仓库/包里的 scripts/install.mjs 做真正的安装（软链 dshc 进 PATH）。
# 真正的安装规则（软链而非拷贝、冲突分类、PATH 提示、launchd 服务化）只有一份，
# 在 scripts/install.mjs 里。这里多写一行都是将来对不上的隐患。
#
# 本脚本自己的参数：
#   --standalone     强制走发布包通道（哪怕本机有 node）
#   --git            强制走 git 通道（缺 node 就直接报错，不降级）
#   --pre            允许装预发布版本（默认只认正式版）
#   --version <tag>  钉死某个 Release，如 --version v0.2.0-rc.1
# 其余参数透传给 install.mjs：
#   --prefix <dir>   软链落点（默认 ~/.local/bin）
#   --service        顺带装 launchd 自启（仅 macOS）
# 经管道执行时这样传参：
#   curl -fsSL <url> | bash -s -- --service
#
# 环境变量：
#   DSHC_APP_DIR   代码/包落点（默认 ~/.dsh_center/app）
#   DSHC_REPO      发布仓库 slug（默认 shendeguize/Remote_DSH_Center）
#   DSHC_REPO_URL  clone 源（默认由 DSHC_REPO 推出；测试指向本地 checkout）
#   DSHC_REF       git 通道要检出的分支/标签（默认 release = 最近一个发过版的提交；
#                  想跟开发进度用 DSHC_REF=main，想钉死某版用 DSHC_REF=v0.1.0）
#   DSHC_RELEASE_BASE  Releases 下载前缀（默认 GitHub；测试指向本地 http 服务）
#   DSHC_API_BASE      GitHub API 前缀（同上）

set -euo pipefail

REPO_SLUG="${DSHC_REPO:-shendeguize/Remote_DSH_Center}"
REPO_URL="${DSHC_REPO_URL:-https://github.com/shendeguize/Remote_DSH_Center.git}"
APP_DIR="${DSHC_APP_DIR:-${HOME}/.dsh_center/app}"
REF="${DSHC_REF:-release}"
API_BASE="${DSHC_API_BASE:-https://api.github.com}"
RELEASE_BASE="${DSHC_RELEASE_BASE:-https://github.com/${REPO_SLUG}/releases/download}"
MIN_NODE_MAJOR=22
SUMS_FILE='SHA256SUMS'

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
info() { printf '  %s\n' "$1"; }
die() {
  printf '\n\033[31m安装中止：\033[0m%s\n' "$1" >&2
  exit 1
}

# 用法错误单独退 3，与 dshc 的退出码约定一致（0 成功 / 1 操作失败 / 2 超时 / 3 用法）
die_usage() {
  printf '\n\033[31m用法错误：\033[0m%s\n' "$1" >&2
  exit 3
}

# ── 0. 参数分流（自己的旗标 vs 透传给 install.mjs 的） ──────────────────────

CHANNEL='auto'
ALLOW_PRE='0'
PIN_TAG=''
PASS=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --standalone) CHANNEL='standalone' ;;
    --git)        CHANNEL='git' ;;
    --pre)        ALLOW_PRE='1' ;;
    --version)    PIN_TAG="${2:-}"; [ -n "${PIN_TAG}" ] || die_usage '--version 后面要跟 tag，如 --version v0.2.0-rc.1'; shift ;;
    # 透传给 install.mjs 的那几个（它自己也会再认一遍并拦下不认识的）
    --prefix)     PASS+=("$1" "${2:-}"); [ -n "${2:-}" ] || die_usage '--prefix 后面要跟目录'; shift ;;
    --service|--uninstall|--no-next-steps) PASS+=("$1") ;;
    # 认不出来的一律拦住：静默忽略的后果是「按另一套意思照做」——把 --standalone
    # 拼成 --no-git 的人会拿到 release 分支上的旧版本，还以为 --pre 生效了。
    *)            die_usage "不认识的参数：$1
可用：--standalone | --git | --pre | --version <tag> | --prefix <dir> | --service | --uninstall" ;;
  esac
  shift
done

# ── 1. 环境检查 ───────────────────────────────────────────────────────────

bold 'DSH Center 安装'

OS="$(uname -s)"
case "${OS}" in
  Darwin) info "平台：macOS（完整支持，含 launchd 自启）" ;;
  Linux)  info "平台：Linux（manager 与 CLI 可用；dshc service 是 macOS 专属，用不了）" ;;
  *)      die "不支持的平台 ${OS}：本工具只支持 macOS 与 Linux。" ;;
esac

# 本机 node 够不够用（决定 auto 走哪条通道）
NODE_OK='0'
NODE_VERSION=''
if command -v node >/dev/null 2>&1; then
  NODE_VERSION="$(node --version)"          # 形如 v22.22.0
  NODE_MAJOR="${NODE_VERSION#v}"
  NODE_MAJOR="${NODE_MAJOR%%.*}"
  if [ "${NODE_MAJOR:-0}" -ge "${MIN_NODE_MAJOR}" ]; then NODE_OK='1'; fi
fi

if [ "${CHANNEL}" = 'auto' ]; then
  if [ "${NODE_OK}" = '1' ]; then
    CHANNEL='git'
  elif [ "${OS}" = 'Darwin' ]; then
    CHANNEL='standalone'
    if [ -n "${NODE_VERSION}" ]; then
      info "node ${NODE_VERSION} 低于 ${MIN_NODE_MAJOR}，改走发布包通道（自带运行时，不动你的 node）"
    else
      info "没找到 node，改走发布包通道（自带运行时，无需先装 Node）"
    fi
  else
    die "找不到可用的 node（需要 ≥ ${MIN_NODE_MAJOR}${NODE_VERSION:+，当前 ${NODE_VERSION}}）。
  Linux 暂无发布包，请先装 Node ≥ ${MIN_NODE_MAJOR}（https://nodejs.org/ 或 nvm/fnm）后重跑。"
  fi
fi

# ── 2a. 发布包通道 ────────────────────────────────────────────────────────

standalone_install() {
  [ "${OS}" = 'Darwin' ] || die "发布包只发 macOS。Linux 请装 Node ≥ ${MIN_NODE_MAJOR} 后走 git 通道。"
  command -v curl >/dev/null 2>&1 || die '找不到 curl，没法下载发布包。'
  command -v shasum >/dev/null 2>&1 || die '找不到 shasum，没法核对下载物的校验和——宁可不装也不装未核对的二进制。'

  case "$(uname -m)" in
    arm64|aarch64)      ARCH='arm64' ;;
    x86_64|amd64|x64)   ARCH='x64' ;;
    *)                  die "不支持的 CPU 架构 $(uname -m)：发布包只有 arm64 与 x64。" ;;
  esac

  # 版本选择：点名优先；否则 /releases/latest（GitHub 保证跳过 pre-release），
  # --pre 时取列表首条（最近发布的一个）。不用 jq——干净机器上没有。
  #
  # 这两条 curl 都带 `|| true`：仓库还没有正式版时 /releases/latest 就是 404，
  # 而 set -e 会让赋值里的失败直接掀掉脚本，用户只看到 curl 的错误码。
  # 咽下来让 tag 为空，下面那句才能给出「加 --pre」这种能照着做的提示。
  local tag
  if [ -n "${PIN_TAG}" ]; then
    tag="${PIN_TAG}"
  elif [ "${ALLOW_PRE}" = '1' ]; then
    tag="$( { curl -fsSL "${API_BASE}/repos/${REPO_SLUG}/releases?per_page=30" || true; } \
      | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"
  else
    tag="$( { curl -fsSL "${API_BASE}/repos/${REPO_SLUG}/releases/latest" || true; } \
      | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"
  fi
  [ -n "${tag}" ] || die "查不到可装的版本。若目前只有预发布版本，加 --pre 重跑；也可用 --version <tag> 点名。"

  local asset="dsh-center-${tag}-darwin-${ARCH}.tar.gz"
  info "版本 ${tag} · 架构 ${ARCH}"

  local tmp
  tmp="$(mktemp -d)"
  # 现在就把路径写死进 trap（故意不用单引号延迟展开）；挂 EXIT 而不是 RETURN，
  # 因为下面每个 die 都是 exit——挂 RETURN 的话失败路径会留下几十兆的下载物
  # shellcheck disable=SC2064
  trap "rm -rf '${tmp}'" EXIT

  info "下载 ${asset}"
  curl -fsSL -o "${tmp}/${asset}" "${RELEASE_BASE}/${tag}/${asset}" \
    || die "下载失败：${RELEASE_BASE}/${tag}/${asset}
  该版本可能没有 ${ARCH} 的产物，或 tag 写错了。"
  curl -fsSL -o "${tmp}/${SUMS_FILE}" "${RELEASE_BASE}/${tag}/${SUMS_FILE}" \
    || die "取不到 ${SUMS_FILE}，无法核对下载物。"

  # 只核对我们下的那一个（SUMS 里还有另一架构的条目，缺文件会让 shasum -c 报错）
  ( cd "${tmp}" && grep " ${asset}\$" "${SUMS_FILE}" > one.sums \
    && shasum -a 256 -c one.sums >/dev/null 2>&1 ) \
    || die "${asset} 校验和不符，已丢弃——不装未经核对的二进制。"
  info '校验和通过'

  tar -xzf "${tmp}/${asset}" -C "${tmp}" || die '解包失败。'
  local unpacked="${tmp}/dsh-center-${tag}-darwin-${ARCH}"
  [ -f "${unpacked}/BUNDLE_INFO.json" ] || die '产物结构不认识（缺 BUNDLE_INFO.json），不像发布包。'

  # 换目录：先挪走旧的（留一代 .prev 可回滚），失败要放回去
  if [ -e "${APP_DIR}/.git" ]; then
    die "${APP_DIR} 是 git clone（软链安装）。要换成发布包安装，先卸载并删掉它，或换个 DSHC_APP_DIR。"
  fi
  if [ -e "${APP_DIR}" ] && [ ! -f "${APP_DIR}/BUNDLE_INFO.json" ] && [ -n "$(ls -A "${APP_DIR}" 2>/dev/null)" ]; then
    die "${APP_DIR} 已存在且不像本工具的安装。删掉它或换个 DSHC_APP_DIR 后重跑。"
  fi
  mkdir -p "$(dirname "${APP_DIR}")"
  if [ -e "${APP_DIR}" ]; then
    rm -rf "${APP_DIR}.prev"
    mv "${APP_DIR}" "${APP_DIR}.prev"
    info "旧安装留在 ${APP_DIR}.prev"
  fi
  if ! mv "${unpacked}" "${APP_DIR}"; then
    [ -e "${APP_DIR}.prev" ] && mv "${APP_DIR}.prev" "${APP_DIR}"
    die "放置到 ${APP_DIR} 失败，已还原原安装。"
  fi

  # curl 下载不带 com.apple.quarantine，但用户可能是从浏览器拿的包再手动跑本脚本；
  # 有则摘掉，免得 Gatekeeper 拦住自带的 node。摘不掉不算错。
  if command -v xattr >/dev/null 2>&1; then
    xattr -dr com.apple.quarantine "${APP_DIR}" >/dev/null 2>&1 || true
  fi

  NODE_BIN="${APP_DIR}/runtime/bin/node"
  INSTALLER="${APP_DIR}/app/scripts/install.mjs"
  info "已装到 ${APP_DIR}（自带 Node $("${NODE_BIN}" --version 2>/dev/null || echo '?')）"
}

# ── 2b. git 通道（首次 clone，之后 pull —— 重跑即升级） ─────────────────────

git_install() {
  command -v git >/dev/null 2>&1 || die "找不到 git。macOS 装 Xcode 命令行工具（xcode-select --install），Linux 用包管理器装 git。"
  [ "${NODE_OK}" = '1' ] || die "git 通道需要 node ≥ ${MIN_NODE_MAJOR}${NODE_VERSION:+（当前 ${NODE_VERSION}）}。
  macOS 上可以不带 --git 重跑，会自动改走自带运行时的发布包通道。"
  info "node ${NODE_VERSION} · git $(git --version | awk '{print $3}')"

  if [ -e "${APP_DIR}/.git" ]; then
    info "已存在：${APP_DIR}，改为更新"
    git -C "${APP_DIR}" remote set-url origin "${REPO_URL}"
    if ! FETCH_ERR="$(git -C "${APP_DIR}" fetch --quiet origin "${REF}" 2>&1)"; then
      die "取不到 ${REF}（${REPO_URL}）：${FETCH_ERR}"
    fi
    # 本地有改动就别硬来，交回给人处理
    if ! git -C "${APP_DIR}" diff --quiet HEAD 2>/dev/null; then
      die "${APP_DIR} 有未提交的本地改动，先自行处理后重跑（或换个 DSHC_APP_DIR）。"
    fi
    git -C "${APP_DIR}" checkout --quiet FETCH_HEAD
    info "已更新到 $(git -C "${APP_DIR}" rev-parse --short HEAD)"
  elif [ -d "${APP_DIR}" ] && [ -n "$(ls -A "${APP_DIR}" 2>/dev/null)" ]; then
    die "${APP_DIR} 已存在且不是本仓库的 clone。删掉它或换个 DSHC_APP_DIR 后重跑。"
  else
    info "clone 到 ${APP_DIR}"
    mkdir -p "$(dirname "${APP_DIR}")"
    # clone 失败不留半个目录，免得下次重跑撞上「已存在且不是 clone」。
    # git 的原话要留着：「分支不存在」与「连不上」得让人一眼分得清。
    if ! CLONE_ERR="$(git clone --quiet --depth 1 --branch "${REF}" "${REPO_URL}" "${APP_DIR}" 2>&1)"; then
      rm -rf "${APP_DIR}"
      die "clone 失败：${REPO_URL}（ref ${REF}）：${CLONE_ERR}"
    fi
    info "已取到 $(git -C "${APP_DIR}" rev-parse --short HEAD)"
  fi

  NODE_BIN='node'
  INSTALLER="${APP_DIR}/scripts/install.mjs"
}

if [ "${CHANNEL}" = 'standalone' ]; then
  standalone_install
else
  git_install
fi

# ── 3. 交给自带的安装脚本 ─────────────────────────────────────────────────

printf '\n'
# --no-next-steps：收尾提示由下面第 4 段统一印，别让 install.mjs 再来一份（issue #17）
"${NODE_BIN}" "${INSTALLER}" --no-next-steps ${PASS[@]+"${PASS[@]}"}

# ── 4. 下一步 ────────────────────────────────────────────────────────────

printf '\n'
bold '下一步'
info 'dshc init      # 四步向导：本机端口、远端约定端口、纳管哪些主机'
info 'dshc up        # 后台起 manager'
info 'dshc open      # 浏览器打开管理台'
printf '\n'
if [ "${CHANNEL}" = 'standalone' ]; then
  info "发布包在 ${APP_DIR}（自带 Node 运行时）"
  info '升级：dshc update（会核对校验和，上一版留在 app.prev）'
else
  info "代码在 ${APP_DIR}（软链安装，git pull 即升级；重跑本脚本也一样）"
  info '升级：dshc update（跟 release 分支，只快进）'
fi
info "卸载：${NODE_BIN} ${INSTALLER} --uninstall"
