#!/usr/bin/env bash
# 研序工作台 —— 从 GitHub 同步更新并重启
# 位置：/home/LZ/yanxu/yanxu-update.sh
#
# 用途：主人本地 push 到 GitHub 后，在服务器上跑这一条就能同步。
#   ~/yanxu/yanxu-update.sh
#
# 安全性：.env / .workbench / .venv 都被 .gitignore 忽略，git 不会碰它们。
#   （.venv 是软链到 /home/LZ/yanxu/.venv，不在仓库内。）
# 失败处理：代码有冲突或语法错误时**不重启**，保留当前正在运行的服务，
#   避免更新把线上服务弄挂。

set -u
REPO="/home/LZ/yanxu/repo"
SERVICE="/home/LZ/yanxu/yanxu.sh"
BRANCH="${1:-}"   # 可选：显式指定分支

cd "$REPO" || { echo "找不到 $REPO"; exit 1; }

# 分支：优先用参数，其次用当前分支
CURRENT=$(git rev-parse --abbrev-ref HEAD)
TARGET="${BRANCH:-$CURRENT}"

echo "分支：$TARGET"
echo "更新前：$(git log --oneline -1)"

# 先确认工作区干净：有本地改动时 git pull 可能冲突，宁可停下问清楚
if [ -n "$(git status --porcelain)" ]; then
  echo "有未提交的本地改动，为避免覆盖已停止："
  git status --short | head -20
  echo
  echo "确认这些改动可以丢弃后，执行："
  echo "  cd $REPO && git checkout -- . && $0"
  exit 1
fi

# 拉取。注意不能用 `if ! git fetch | tail`：管道的退出码是 tail 的，git 失败会被吞掉
# （实测过一次：TLS 断了，脚本却报「已是最新，无需重启」，等于骗人）。
# 这里把输出写进变量、单独取 git 的退出码，失败明确报错。
# GitHub 从这台机器偶尔 TLS 中断（GnuTLS -110），所以重试 3 次。
echo "拉取远程…"
FETCH_OK=0
for attempt in 1 2 3; do
  FETCH_OUT=$(git fetch --prune origin 2>&1)
  FETCH_CODE=$?
  if [ "$FETCH_CODE" = "0" ]; then
    FETCH_OK=1
    break
  fi
  echo "第 $attempt 次拉取失败：$(echo "$FETCH_OUT" | tail -3)"
  [ "$attempt" != "3" ] && { echo "2 秒后重试…"; sleep 2; }
done

if [ "$FETCH_OK" != "1" ]; then
  echo
  echo "拉取失败（已重试 3 次）：连不上 GitHub。代码未改动，服务未重启。"
  echo "排查：curl -I https://github.com   /   git -C $REPO remote -v"
  exit 1
fi

BEFORE=$(git rev-parse HEAD)
MERGE_OUT=$(git merge --ff-only "origin/$TARGET" 2>&1)
MERGE_CODE=$?
echo "$MERGE_OUT" | tail -5
if [ "$MERGE_CODE" != "0" ]; then
  echo
  echo "快进合并失败（本地与远程分叉了）。未改动任何文件，服务未重启。"
  echo "如确认要丢弃服务器上的本地改动：git -C $REPO reset --hard origin/$TARGET"
  exit 1
fi
AFTER=$(git rev-parse HEAD)

if [ "$BEFORE" = "$AFTER" ]; then
  echo "已是最新（$AFTER），无需重启。"
  exit 0
fi

echo
echo "更新内容："
git log --oneline "$BEFORE..$AFTER"

# 语法自检：node 文件有问题就不要重启，避免把线上弄挂
echo
echo "语法检查…"
CHECK_FAILED=0
while IFS= read -r f; do
  if ! /usr/bin/node --check "$f" 2>/dev/null; then
    echo "语法错误：$f"
    /usr/bin/node --check "$f"
    CHECK_FAILED=1
  fi
done < <(git diff --name-only "$BEFORE" "$AFTER" | grep -E '\.js$' || true)

if [ "$CHECK_FAILED" = "1" ]; then
  echo
  echo "语法检查未通过。代码已更新但那台服务仍跑旧版；修好后重跑本脚本或 ./yanxu.sh restart。"
  exit 1
fi

echo "运行重启…"
"$SERVICE" restart
