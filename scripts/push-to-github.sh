#!/usr/bin/env bash
#
# 把 HomeCloud 推送到 GitHub 新仓库。
#
# 前置条件（在你要执行本脚本的机器上）：
#   1. 已安装 git
#   2. 已安装并登录 GitHub CLI：  gh auth login
#      （如果没有 gh，脚本会改为打印手动步骤）
#
# 用法：
#   bash scripts/push-to-github.sh [仓库名] [public|private]
#   例： bash scripts/push-to-github.sh homecloud-lan-drive public
#
set -euo pipefail

REPO_NAME="${1:-homecloud-lan-drive}"
VIS="${2:-public}"
DESCRIPTION="Family LAN private cloud drive — a self-hosted, NAS-like file manager (cross-platform Node.js)"

cd "$(dirname "${BASH_SOURCE[0]}")/.."   # 切到仓库根目录

echo "当前目录：$(pwd)"
echo "将使用仓库名：$REPO_NAME  （可见性：$VIS）"
echo

# 1) 初始化（若尚未是 git 仓库）
if [ ! -d .git ]; then
  git init -q
  git branch -M main 2>/dev/null || true
fi

# 2) 暂存（.gitignore 已排除 node_modules / data / logs / runtime 等）
git add -A

echo "=== 将要提交的文件（请确认没有 secrets / 大文件）==="
git status --short
echo

read -r -p "确认提交并推送到 GitHub？[y/N] " CONFIRM
if [ "$CONFIRM" != "y" ] && [ "$CONFIRM" != "Y" ]; then
  echo "已取消。"
  exit 1
fi

# 3) 提交
git commit -q -m "HomeCloud: family LAN cloud drive (cross-platform, Node.js)" || echo "（无新改动，跳过提交）"

# 4) 推送
if command -v gh >/dev/null 2>&1; then
  echo "通过 gh 创建并推送仓库…"
  GH_FLAG="--public"; [ "$VIS" = "private" ] && GH_FLAG="--private"
  gh repo create "$REPO_NAME" "$GH_FLAG" --description "$DESCRIPTION" --source . --remote origin --push
  echo
  echo "完成： $(gh repo view --json url -q .url 2>/dev/null || echo "https://github.com/<you>/$REPO_NAME")"
else
  echo "未检测到 gh CLI。请先在 https://github.com/new 手动创建名为 $REPO_NAME 的空仓库，然后执行："
  echo "  git remote add origin https://github.com/<你的用户名>/$REPO_NAME.git"
  echo "  git branch -M main"
  echo "  git push -u origin main"
fi
