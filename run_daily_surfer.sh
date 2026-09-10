#!/usr/bin/env bash
# run_daily_surfer.sh — 微信公众号每日文章拉取分析 (02:00 cron 入口)
#
# 替换原 OpenClaw cron 9409c123 的 1022 字符 prompt，把 LLM 干的活下沉到 shell：
#   1) 算昨天日期 (shell date)
#   2) 验证 wechat session (check_session.js)
#   3) 后台跑 daily-workflow.js (setsid 脱离父进程)
#   4) 飞书推送启动消息 (send_msg.py)
#
# 飞书表格：https://my.feishu.cn/wiki/GROcwEQiniyPq8kHR7XcRN2snmd
# 知识库：GROcwEQiniyPq8kHR7XcRN2snmd (WIKI space 7612597055546035138)
set -u

# ── 路径自推导 ──
SCRIPT_PATH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="${WAS_SKILL_DIR:-$SCRIPT_PATH}"
SCRIPTS="$SKILL_DIR/scripts"
LOG_DIR="${WAS_LOG_DIR:-/tmp}"
TS_RUN="$(date +%Y%m%d-%H%M%S)"
TARGET_DATE="$(date -v-1d +%Y-%m-%d)"
LOG_FILE="$LOG_DIR/wechat-article-surfer_$TARGET_DATE.log"
RESULT_FILE="$LOG_DIR/wechat-article-surfer_$TARGET_DATE.result.json"
SEND_MSG="${SEND_MSG:-/Users/totti/script/cron/send_msg.py}"

# ── 路径校验 ──
[ ! -d "$SKILL_DIR" ] && { echo "❌ skill 目录不存在: $SKILL_DIR" >&2; exit 1; }
[ ! -f "$SCRIPTS/check_session.js" ] && { echo "❌ check_session.js 缺失" >&2; exit 1; }
[ ! -f "$SCRIPTS/daily-workflow.js" ] && { echo "❌ daily-workflow.js 缺失" >&2; exit 1; }

echo "=== wechat-article-surfer run for $TARGET_DATE ==="
echo "[$(date '+%Y-%m-%d %H:%M:%S')] skill_dir=$SKILL_DIR"
echo "[$(date '+%Y-%m-%d %H:%M:%S')] target_date=$TARGET_DATE"
echo "[$(date '+%Y-%m-%d %H:%M:%S')] log_file=$LOG_FILE"

# ── Step1: 验证 wechat session ──
echo ""
echo "[Step1] check_session.js 验证 cookie..."
SESS_OUT=$(cd "$SKILL_DIR" && node scripts/check_session.js 2>&1)
SESS_RC=$?
echo "$SESS_OUT"

if [ $SESS_RC -ne 0 ]; then
    echo "❌ cookie 失效，需要重新扫码登录"
    MSG="⚠️ **公众号文章拉取失败** — $TARGET_DATE

🔑 **wechat session 已过期**, 请扫码重新登录:

\`\`\`
cd $SKILL_DIR
node src/login-server.js
\`\`\`

登录完成后 cookie 有效期 4 天, 重新触发本次任务。"
    python3 "$SEND_MSG" --agent main --card-title "公众号 session 失效" --card-color "carmine" --text "$MSG" 2>&1 | head -3
    exit 1
fi

# ── Step2: 推送启动消息 ──
echo ""
echo "[Step2] 飞书推送启动消息..."
MSG_START="🚀 **公众号文章拉取已启动** — $TARGET_DATE

⏰ $(date '+%Y-%m-%d %H:%M:%S') 启动
📅 目标日期: $TARGET_DATE (昨天)
🔑 $SESS_OUT
📂 日志: $LOG_FILE

后台进程由 setsid 启动, 完成后会再推一条完成消息."
python3 "$SEND_MSG" --agent main --card-title "公众号拉取启动" --card-color "blue" --text "$MSG_START" 2>&1 | head -3

# ── Step3: 后台跑 daily-workflow.js ──
echo ""
echo "[Step3] setsid 启动 daily-workflow.js ..."
cd "$SKILL_DIR"

# 用 setsid 脱离父进程 (macOS 不需要 launchd)
nohup setsid node scripts/daily-workflow.js --date="$TARGET_DATE" \
    > "$LOG_FILE" 2>&1 < /dev/null &

PID=$!
echo "[Step3] ✅ daily-workflow.js 已后台启动, PID=$PID"
echo "[Step3] 实时进度: tail -f $LOG_FILE"

# 写一个 PID 文件, 方便查询
echo "$PID" > "$LOG_DIR/wechat-article-surfer.pid"

# ── Step4: 退出 (后台进程继续) ──
echo ""
echo "=== wrapper 退出, 后台进程继续运行 ==="
exit 0
