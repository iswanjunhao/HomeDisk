#!/usr/bin/env bash
# =============================================================================
# HomeCloud 首次初始化向导启动器
#
# 运行：  bash setup.sh
#
# 它会做三件事：
#   1) 检查运行依赖（Node.js）；
#   2) 以「向导模式」启动家庭云盘服务（自动探测一个空闲端口）；
#   3) 自动打开浏览器到图形初始化向导页面。
#
# 之后的一切（选择共享目录、设置端口与密码）都在网页里用鼠标点选完成，
# 不需要在终端里手敲任何命令，也就不会出现「手滑输错导致初始化被取消」的情况。
#
# 重要约定（始终成立）：
#   * 端口【不写】进 config.json；端口只存在于生成的 start.sh（环境变量
#     HOMECLOUD_PORT）。想改端口，编辑 start.sh 那一行数字后重启即可。
#   * 本脚本只在「尚未初始化」时生效。若已初始化，请用 bash start.sh 启动服务；
#     需要重新初始化请先备份并删除 app/data/config.json 再运行本脚本。
# =============================================================================

# 不使用 set -e：启动服务后我们要持续等待，且打开浏览器失败不应中断流程
set -o pipefail

# ----------------------------- 路径定位 -----------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$SCRIPT_DIR/app"
CONFIG_FILE="$APP_DIR/data/config.json"

# ----------------------------- 终端颜色 -----------------------------
if [ -t 1 ]; then
  C_BOLD=$(tput bold 2>/dev/null || true)
  C_CYAN=$(tput setaf 6 2>/dev/null || true)
  C_GREEN=$(tput setaf 2 2>/dev/null || true)
  C_YELLOW=$(tput setaf 3 2>/dev/null || true)
  C_RED=$(tput setaf 1 2>/dev/null || true)
  C_RESET=$(tput sgr0 2>/dev/null || true)
else
  C_BOLD=""; C_CYAN=""; C_GREEN=""; C_YELLOW=""; C_RED=""; C_RESET=""
fi

banner(){ printf '%s%s%s\n' "$C_BOLD$C_CYAN" "$1" "$C_RESET"; }
ok(){ printf '%s✓ %s%s\n' "$C_GREEN" "$1" "$C_RESET"; }
warn(){ printf '%s! %s%s\n' "$C_YELLOW" "$1" "$C_RESET"; }
err(){ printf '%s✗ %s%s\n' "$C_RED" "$1" "$C_RESET"; }

# ----------------------------- 依赖检查 -----------------------------
if ! command -v node >/dev/null 2>&1; then
  err "未检测到 node。请先安装 Node.js 18 或更高版本，再运行本脚本。"
  err "（Linux:  sudo apt install -y nodejs npm   或访问 https://nodejs.org）"
  exit 1
fi
NODE_BIN="$(command -v node)"
NODE_VER="$("$NODE_BIN" -v 2>/dev/null | sed 's/^v//')"
banner "=== HomeCloud 首次初始化向导 ==="
echo "检测到 node: $NODE_BIN (v$NODE_VER)"
echo

# ----------------------------- 是否已初始化 -----------------------------
if [ -f "$CONFIG_FILE" ]; then
  warn "检测到已有配置：$CONFIG_FILE"
  echo "HomeCloud 已完成初始化，本向导只用于首次设置。"
  echo "  · 直接启动服务：        bash start.sh"
  echo "  · 重置管理员密码：      node app/server.js --set-password 你的新密码"
  echo "  · 彻底重新初始化：      先备份并删除 $CONFIG_FILE，再运行 bash setup.sh"
  echo
  exit 0
fi

# ----------------------------- 启动向导模式 -----------------------------
banner "正在以向导模式启动家庭云盘服务……"
cd "$APP_DIR" || exit 1

LOG_FILE="$(mktemp -t homecloud-setup.XXXXXX.log)"
node server.js > "$LOG_FILE" 2>&1 &
SRV_PID=$!

# 等待向导地址出现（服务端会打印 SETUP_WIZARD_URL: <url>）
URL=""
for i in $(seq 1 60); do
  sleep 0.5
  URL="$(grep -m1 'SETUP_WIZARD_URL:' "$LOG_FILE" | sed 's/.*SETUP_WIZARD_URL:[[:space:]]*//')"
  [ -n "$URL" ] && break
  if ! kill -0 "$SRV_PID" 2>/dev/null; then
    err "服务启动失败，最近日志如下："
    tail -n 20 "$LOG_FILE" 2>/dev/null
    rm -f "$LOG_FILE"
    exit 1
  fi
done

if [ -z "$URL" ]; then
  err "未能获取向导地址，请查看日志：$LOG_FILE"
  exit 1
fi

ok "向导已就绪：$URL"
echo "正在尝试打开浏览器……"

# 尽量自动打开浏览器（失败也不影响，地址已打印在上面）
open_browser(){
  local u="$1"
  if command -v xdg-open >/dev/null 2>&1; then
    (xdg-open "$u" >/dev/null 2>&1 &)
  elif command -v open >/dev/null 2>&1; then
    (open "$u" >/dev/null 2>&1 &)
  elif command -v start >/dev/null 2>&1; then
    (start "$u" >/dev/null 2>&1 &)
  else
    warn "未能自动打开浏览器，请手动复制上面的地址到浏览器打开。"
  fi
}
open_browser "$URL"

echo
echo "请在浏览器中完成设置："
echo "  1) 点选要共享到局域网的目录（可添加多个）"
echo "  2) 确认访问端口、设置管理员密码"
echo "  3) 点「完成设置并启动」"
echo
echo "设置完成后，服务会自动以你选定的端口重启并在后台常驻，"
echo "局域网内其他设备即可访问。此时可安全关闭本终端窗口。"
echo

# 等待向导进程：用户完成设置后，向导会退出（真正的服务进程已后台接管）
wait "$SRV_PID" 2>/dev/null
ok "初始化向导已结束。HomeCloud 服务正在后台运行。"
rm -f "$LOG_FILE"
echo "以后启动只需：  bash start.sh"
