#!/usr/bin/env bash
#
# DSH Center 一键安装引导。
#
#   curl -fsSL https://raw.githubusercontent.com/shendeguize/Remote_DSH_Center/main/install.sh | bash
#
# 这个脚本**只做引导**，不复制任何安装逻辑：
#   1. 检查 git 与 node ≥ 22（缺了就说清缺哪个、去哪装，不擅自装东西）
#   2. clone 到 ~/.dsh_center/app 的 release 分支；已经在那儿就更新（所以重跑 = 升级）
#   3. 交给仓库里的 scripts/install.mjs 做真正的安装（软链 dshc 进 PATH）
#
# 真正的安装规则（软链而非拷贝、PATH 提示、launchd 服务化）只有一份，
# 在 scripts/install.mjs 里。这里多写一行都是将来对不上的隐患。
#
# 可选参数（透传给 install.mjs）：
#   --prefix <dir>   软链落点（默认 ~/.local/bin）
#   --service        顺带装 launchd 自启（仅 macOS）
# 经管道执行时这样传参：
#   curl -fsSL <url> | bash -s -- --service
#
# 环境变量：
#   DSHC_APP_DIR   代码落点（默认 ~/.dsh_center/app）
#   DSHC_REPO_URL  clone 源（默认 GitHub；CI 的端到端测试指向本地 checkout）
#   DSHC_REF       要检出的分支/标签（默认 release = 最近一个发过版的提交；
#                  想跟开发进度用 DSHC_REF=main，想钉死某版用 DSHC_REF=v0.1.0）

set -euo pipefail

REPO_URL="${DSHC_REPO_URL:-https://github.com/shendeguize/Remote_DSH_Center.git}"
APP_DIR="${DSHC_APP_DIR:-${HOME}/.dsh_center/app}"
REF="${DSHC_REF:-release}"
MIN_NODE_MAJOR=22

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
info() { printf '  %s\n' "$1"; }
die() {
  printf '\n\033[31m安装中止：\033[0m%s\n' "$1" >&2
  exit 1
}

# ── 1. 环境检查 ───────────────────────────────────────────────────────────

bold 'DSH Center 安装'

case "$(uname -s)" in
  Darwin) info "平台：macOS（完整支持，含 launchd 自启）" ;;
  Linux)  info "平台：Linux（manager 与 CLI 可用；dshc service 是 macOS 专属，用不了）" ;;
  *)      die "不支持的平台 $(uname -s)：本工具只支持 macOS 与 Linux。" ;;
esac

command -v git >/dev/null 2>&1 || die "找不到 git。macOS 装 Xcode 命令行工具（xcode-select --install），Linux 用包管理器装 git。"

command -v node >/dev/null 2>&1 || die "找不到 node。需要 Node ≥ ${MIN_NODE_MAJOR}，见 https://nodejs.org/ 或用 nvm/fnm 安装。"

NODE_VERSION="$(node --version)"          # 形如 v22.22.0
NODE_MAJOR="${NODE_VERSION#v}"
NODE_MAJOR="${NODE_MAJOR%%.*}"
if [ "${NODE_MAJOR:-0}" -lt "${MIN_NODE_MAJOR}" ]; then
  die "Node 版本过低：当前 ${NODE_VERSION}，需要 ≥ ${MIN_NODE_MAJOR}（本项目零依赖，全靠 Node 内置能力）。"
fi
info "node ${NODE_VERSION} · git $(git --version | awk '{print $3}')"

# ── 2. 取代码（首次 clone，之后 pull —— 重跑即升级） ───────────────────────

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

# ── 3. 交给仓库自带的安装脚本 ─────────────────────────────────────────────

printf '\n'
node "${APP_DIR}/scripts/install.mjs" "$@"

# ── 4. 下一步 ────────────────────────────────────────────────────────────

printf '\n'
bold '下一步'
info 'dshc init      # 四步向导：本机端口、远端约定端口、纳管哪些主机'
info 'dshc up        # 后台起 manager'
info 'dshc open      # 浏览器打开管理台'
printf '\n'
info "代码在 ${APP_DIR}（软链安装，git pull 即升级；重跑本脚本也一样）"
info '卸载：node '"${APP_DIR}"'/scripts/install.mjs --uninstall'
