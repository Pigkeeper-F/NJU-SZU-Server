#!/usr/bin/env bash
# 研序 · 研究工作台 —— 服务器启动/停止/状态脚本
# 位置：/home/LZ/yanxu/yanxu.sh
#
# 为什么用 tmux 而不是 nohup/systemd：
#   这台机器的 SSH 登录有门禁，会话结束后由它派生的普通后台进程会被回收
#   （实测 nohup 起的监听几秒后消失）。tmux 里的进程挂在独立服务端，
#   不受登录会话生命周期影响；已实测端口在登出后仍然可达。
#   systemd --user 在这台机器上不可靠（无 linger 权限），所以不用。
#
# 用法：
#   ./yanxu.sh start     启动（已在跑就提示，不重复起）
#   ./yanxu.sh stop      停止
#   ./yanxu.sh restart   重启（只改本机文件时用这个）
#   ./yanxu.sh update    从 GitHub 拉最新代码并重启（本地 push 之后用这个）
#   ./yanxu.sh status    看状态
#   ./yanxu.sh logs      看最近日志

set -u
REPO="/home/LZ/yanxu/repo"
SESSION="yanxu"
LOG="$REPO/.workbench/server.log"
mkdir -p "$REPO/.workbench"

# Codex CLI 装在用户级 npm 前缀里（全局前缀 /usr/local/node22 无写权限）。
# tmux 起的进程不读交互式 .bashrc，必须在这里显式加进 PATH，否则
# /api/codex/status 会一直报「Codex 服务断开；请检查 CLI 安装与登录」。
export PATH="/home/LZ/.npm-global/bin:$PATH"

# 从 .env 里读端口，避免脚本里再写一遍
PORT_NUM=$(grep -E '^PORT=' "$REPO/.env" 2>/dev/null | head -1 | cut -d= -f2 | tr -d ' \r')
PORT_NUM=${PORT_NUM:-18700}

running() {
  tmux has-session -t "$SESSION" 2>/dev/null
}

case "${1:-status}" in
  start)
    if running; then
      echo "已经在运行（tmux 会话 $SESSION）。如需重启用 restart。"
      exit 0
    fi
    if [ ! -f "$REPO/server.js" ]; then
      echo "找不到 $REPO/server.js，先确认代码已同步。"
      exit 1
    fi
    if [ ! -f "$REPO/.env" ]; then
      echo "找不到 $REPO/.env，先复制 server.env 过去并核对 PUBLIC_HOSTS。"
      exit 1
    fi
    CHECK=$(cd "$REPO" && /usr/bin/node --check server.js 2>&1)
    if [ -n "$CHECK" ]; then
      echo "server.js 语法检查未通过，未启动："
      echo "$CHECK"
      exit 1
    fi
    # exec 让 node 直接成为 tmux 里的前台进程，日志既能 tee 也能在 tmux 里看
    tmux new-session -d -s "$SESSION" \
      "cd '$REPO' && exec /usr/bin/node server.js 2>&1 | tee -a '$LOG'"
    sleep 3
    if running && curl -s -o /dev/null --max-time 5 "http://127.0.0.1:$PORT_NUM/changelog.html"; then
      echo "已启动：http://127.0.0.1:$PORT_NUM/"
      echo "对外地址见 .env 的 PUBLIC_ORIGINS。日志：$LOG"
    else
      echo "启动后健康检查未通过，查看日志："
      tail -20 "$LOG" 2>/dev/null
      exit 1
    fi
    ;;
  stop)
    if running; then
      tmux kill-session -t "$SESSION"
      echo "已停止。"
    else
      echo "本来就没在运行。"
    fi
    ;;
  restart)
    "$0" stop
    sleep 1
    "$0" start
    ;;
  update)
    # 从 GitHub 拉最新代码并重启；失败时不重启，线上服务保持可用。
    exec /home/LZ/yanxu/yanxu-update.sh "${2:-}"
    ;;
  status)
    if running; then
      echo "运行中（tmux 会话 $SESSION）"
      ss -tln | grep ":${PORT_NUM} " || echo "（端口 $PORT_NUM 未监听，可能正在启动或已崩溃）"
      curl -s -o /dev/null -w "健康检查 HTTP %{http_code}\n" --max-time 5 "http://127.0.0.1:$PORT_NUM/changelog.html"
    else
      echo "未运行"
    fi
    ;;
  logs)
    tail -n "${2:-60}" "$LOG" 2>/dev/null || echo "还没有日志：$LOG"
    ;;
  *)
    echo "用法：$0 {start|stop|restart|status|logs [行数]}"
    exit 2
    ;;
esac
