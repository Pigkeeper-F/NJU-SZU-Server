#!/usr/bin/env bash
# 开机/掉线后自动把工作台拉起来。
#
# 用法（只需执行一次）：
#   crontab -l 2>/dev/null | grep -v yanxu-autostart > /tmp/ct
#   echo '*/5 * * * * /home/LZ/yanxu/yanxu-autostart.sh >/dev/null 2>&1' >> /tmp/ct
#   crontab /tmp/ct
#
# 逻辑：每 5 分钟探一次端口，没在监听就启动。已经在跑时什么都不做
# （yanxu.sh start 本身也幂等，这里是双保险）。

REPO="/home/LZ/yanxu/repo"
PORT_NUM=$(grep -E '^PORT=' "$REPO/.env" 2>/dev/null | head -1 | cut -d= -f2 | tr -d ' \r')
PORT_NUM=${PORT_NUM:-18700}

# 端口已在监听 → 什么也不做
if ss -tln 2>/dev/null | grep -q ":${PORT_NUM} "; then
  exit 0
fi

# 端口没监听 → 拉起（脚本内部会检查 tmux 会话，避免重复起）
/home/LZ/yanxu/yanxu.sh start >/dev/null 2>&1
