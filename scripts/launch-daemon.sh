#!/bin/bash
# launch-daemon.sh — 通过 launchd 启动完全脱离 exec 会话的后台进程
#
# 解决核心问题：exec 工具的默认 timeout (~5min) 会杀死所有子进程，
# 包括 nohup、fork+setsid 也无法逃脱。
# launchd 是系统级进程管理器，exec 工具无法影响它管理的进程。
#
# 用法: ./scripts/launch-daemon.sh <label> <workdir> <logfile> <command...>
#
# 示例:
#   ./scripts/launch-daemon.sh daily-workflow \
#     ~/.qclaw/skills/wechat-article-surfer \
#     /tmp/daily-workflow.log \
#     node scripts/daily-workflow.js
#
# 查看进度: tail -f <logfile>
# 停止任务: launchctl remove <label>

set -euo pipefail

LABEL="$1"
WORKDIR="$2"
LOGFILE="$3"
shift 3

if [ -z "$LABEL" ] || [ -z "$WORKDIR" ] || [ -z "$LOGFILE" ] || [ $# -eq 0 ]; then
    echo "用法: $0 <label> <workdir> <logfile> <command...>" >&2
    exit 1
fi

# ── 确保日志目录存在 ──
mkdir -p "$(dirname "$LOGFILE")"

# ── 清理同 label 的旧任务 ──
launchctl remove "$LABEL" 2>/dev/null || true

# ── 自动解析命令路径 ──
# launchctl submit 不支持参数中的空格，所以需要解析成不带空格的实际路径
RAW_CMD="$1"
RESOLVED_CMD=""
if [[ "$RAW_CMD" == *" "* ]]; then
    # 命令路径包含空格 → 用 mktemp 创建 symlink
    TMP_LINK=$(mktemp /tmp/launchd-cmd-XXXXXX)
    rm -f "$TMP_LINK"
    ln -s "$RAW_CMD" "$TMP_LINK"
    RESOLVED_CMD="$TMP_LINK"
    echo "   (路径含空格，已创建 symlink: $RAW_CMD → $TMP_LINK)" >&2
else
    # which 查找（如果是不含路径的裸命令名）
    if [[ "$RAW_CMD" != /* ]]; then
        RESOLVED_CMD=$(which "$RAW_CMD" 2>/dev/null || echo "$RAW_CMD")
    else
        RESOLVED_CMD="$RAW_CMD"
    fi
fi

# ── 组装参数 ──
shift
CMD_ARGS=("$RESOLVED_CMD" "$@")

# ── 通过 launchctl submit 启动（启动独立 session） ──
launchctl submit -l "$LABEL" -o "$LOGFILE" -e "$LOGFILE" -- \
    /bin/bash -c 'cd "$1" && shift && exec "$@" 2>&1 | cat' \
    "bash" "$WORKDIR" "${CMD_ARGS[@]}" || {
    echo "❌ launchctl submit 失败" >&2
    exit 1
}

# ── 输出状态 ──
PID=$(launchctl list | grep -E "^[0-9].*$LABEL$" | awk '{print $1}' || echo "?")
echo "✅ launchd 已启动: $LABEL"
echo "   PID : $PID"
echo "   日志: $LOGFILE"
echo "   CWD : $WORKDIR"
echo "   CMD : ${CMD_ARGS[*]}"
echo ""
echo "   查看进度: tail -f $LOGFILE"
echo "   停止任务: launchctl remove $LABEL"
