#!/usr/bin/env bash
#
# 操作员脚本，不是 DSH Center 产品路径。
#
# 只在明确授权的远端执行 bootstrap：每次先重新扫描 SSH 配置；只安装 zstd
# 和用户态 Agent Sidecar；绝不安装 dsh/Python，绝不打开注入，绝不写
# ~/.dsh_center_remote/。普通 teardown 由 real-acceptance.mjs 负责，--deep
# 只删除本脚本创建的用户态 Sidecar 与可选 PATH 片段，使用前必须确认目标机。

set -euo pipefail
IFS=$'\n\t'

readonly VERSION='0.8.0'
readonly PACKAGE='@shendeguize/dsh-agent-sidecar'
readonly REMOTE_DIR='$HOME/.dsh_center_remote'
readonly HELPERS_ROOT="${POD_INIT_SYNC_ROOT:-$HOME/Workspace/Helpers/skills/pod-init-sync}"
DRY_RUN=0
DEEP=0
HOST=

die() { printf 'bootstrap-remote: ERROR: %s\n' "$*" >&2; exit 1; }
note() { printf 'bootstrap-remote: %s\n' "$*"; }

while (($#)); do
    case "$1" in
        --dry-run) DRY_RUN=1; shift ;;
        --deep) DEEP=1; shift ;;
        --help|-h)
            printf '%s\n' \
                'Usage: scripts/bootstrap-remote.sh [--dry-run] [--deep] <ssh-alias>' \
                'Operator-only bootstrap. Rescans ~/.ssh/config before every remote action.' \
                'Installs only zstd and userland Agent Sidecar; never installs dsh or Python.'
            exit 0
            ;;
        -*) die "unknown option: $1" ;;
        *) [[ -z "$HOST" ]] || die 'exactly one SSH alias is required'; HOST=$1; shift ;;
    esac
done
[[ -n "$HOST" ]] || die 'an SSH alias is required'
[[ "$HOST" != -* && "$HOST" =~ ^[A-Za-z0-9._-]+$ ]] || die "unsafe SSH alias: $HOST"

FLEET="${BOOTSTRAP_FLEET_SCRIPT:-$HELPERS_ROOT/scripts/fleet.py}"
SCAN="${BOOTSTRAP_SCAN_SCRIPT:-$HELPERS_ROOT/scripts/scan.sh}"
[[ -f "$FLEET" && -f "$SCAN" ]] || die "SSH rescan helpers not found: $FLEET / $SCAN"

note 'Rescanning SSH config (mandatory fresh state)'
python3 "$FLEET" hosts --hosts "$HOST" >/dev/null
"$SCAN" "$HOST" >/dev/null

ssh_remote() {
    ssh -T -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout="${BOOTSTRAP_SSH_TIMEOUT:-10}" "$HOST" "$1"
}

note 'Read-only remote preflight'
ssh_remote 'set -u; printf "dsh=%s\n" "$(command -v dsh || true)"; printf "python=%s\n" "$(python3 --version 2>&1 || true)"; printf "zstd=%s\n" "$(command -v zstd || true)"; printf "sidecar=%s\n" "$(command -v agent-sidecar || true)"'

if ((DEEP)); then
    note 'Deep teardown: remove only this operator bootstrap state'
    ((DRY_RUN)) || ssh_remote 'rm -f "$HOME/.local/bin/agent-sidecar" "$HOME/.local/bin/.agent-sidecar-bootstrap.pyz"'
    note 'Deep teardown does not edit .bashrc, dsh profiles, or Center state'
    exit 0
fi

if ((DRY_RUN)); then
    note 'DRY-RUN: would install zstd only when absent and Sidecar in ~/.local/bin'
    exit 0
fi

ssh_remote 'if ! command -v zstd >/dev/null 2>&1; then if [ "$(id -u)" -eq 0 ]; then apt-get install -y zstd; elif command -v sudo >/dev/null 2>&1; then sudo -n apt-get install -y zstd; else echo "zstd missing and passwordless sudo unavailable" >&2; exit 1; fi; fi'
ssh_remote 'export PATH="$HOME/.local/bin:$PATH"; if ! command -v agent-sidecar >/dev/null 2>&1; then command -v curl >/dev/null 2>&1 || { echo "curl required for Sidecar installer" >&2; exit 1; }; t=$(mktemp "${TMPDIR:-/tmp}/agent-sidecar.XXXXXX"); trap '"'"'rm -f "$t"'"'"' EXIT; curl --fail --location --proto '"'"'"'"'"'"'=https'"'"'"'"'"'"' --tlsv1.2 --output "$t" https://raw.githubusercontent.com/shendeguize/AgentSideCar/main/install.sh; sh "$t" --version v0.8.0 --prefix "$HOME/.local"; fi'
note 'Completed. dsh and Python were not installed; verify dsh/profile manually, then run dshc probe.'
