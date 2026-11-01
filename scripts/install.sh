#!/usr/bin/env bash
#
# HomeCloud 家庭云盘 —— 一键安装
# 用法：sudo bash scripts/install.sh
#
# 会做五件事：
#   1. 挂载 1T 共享盘到 /mnt/homedisk 并写入 fstab（开机自动挂载）
#   2. 准备 Node.js 运行时（自动探测 / apt 安装 / 内置一份到安装目录）
#   3. 把程序安装到 /opt/homecloud
#   4. 设置管理员密码
#   5. 安装 systemd 服务并设置开机自启
#
# 可重复执行：已挂载、已安装、已有运行时的步骤会自动跳过。
#
set -euo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/app"
INSTALL_DIR="/opt/homecloud"
MOUNT_POINT="/mnt/homedisk"
SERVICE_NAME="homecloud"
PORT="${HOMECLOUD_PORT:-8080}"
RUNTIME_NODE="$INSTALL_DIR/runtime/node"

# ---------- 工具函数 ----------

info() { echo "  $*"; }
step() { echo ""; echo "$*"; }
die() { echo ""; echo "  [出错] $*"; exit 1; }

# 推断"真正的使用者"（服务运行用户），避免脚本在 root shell 里跑时误判成 root
detect_real_user() {
  local u=""
  if [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != "root" ]; then
    echo "$SUDO_USER"; return
  fi
  # 依次尝试：登录用户 -> 脚本文件属主 -> $HOME 属主 -> uid 1000
  u="$(logname 2>/dev/null || true)"
  if [ -z "$u" ] || [ "$u" = "root" ]; then
    u="$(stat -c '%U' "${BASH_SOURCE[0]}" 2>/dev/null || true)"
  fi
  if [ -z "$u" ] || [ "$u" = "root" ]; then
    u="$(stat -c '%U' "${HOME:-/root}" 2>/dev/null || true)"
  fi
  if [ -z "$u" ] || [ "$u" = "root" ]; then
    u="$(getent passwd 1000 2>/dev/null | cut -d: -f1 || true)"
  fi
  echo "${u:-root}"
}

# 在常见位置找一个能实际跑起来的 node
find_node() {
  local c d
  local candidates=(
    "${HOMECLOUD_NODE:-}"
    "$(command -v node 2>/dev/null || true)"
    /usr/bin/node
    /usr/local/bin/node
    /opt/node/bin/node
  )
  # WorkBuddy / nvm / n 等托管的 node
  for d in "${HOME:-/root}"/.workbuddy/binaries/node/versions/*/bin \
           "${HOME:-/root}"/.nvm/versions/node/*/bin \
           /usr/local/n/versions/node/*/bin \
           /root/.nvm/versions/node/*/bin; do
    if [ -x "$d/node" ]; then
      candidates+=("$d/node")
    fi
  done
  for c in "${candidates[@]}"; do
    if [ -n "$c" ] && [ -x "$c" ] && "$c" -v >/dev/null 2>&1; then
      echo "$c"; return 0
    fi
  done
  return 1
}

# ---------- 开场 ----------

RUN_USER="$(detect_real_user)"

echo "=============================================="
echo " HomeCloud 家庭云盘 安装程序"
echo "=============================================="
echo " 安装目录：$INSTALL_DIR"
echo " 共享目录：$MOUNT_POINT"
echo " 运行用户：$RUN_USER"
echo " 访问端口：$PORT"
echo "=============================================="

if [ "$EUID" -ne 0 ]; then
  echo ""
  echo " 请用 sudo 运行： sudo bash $0"
  exit 1
fi

# ---------- 1. 挂载共享盘 ----------

step "[1/5] 挂载共享盘…"
if mountpoint -q "$MOUNT_POINT"; then
  info "$MOUNT_POINT 已经挂载，跳过"
else
  bash "$(dirname "${BASH_SOURCE[0]}")/mount-disk.sh"
fi
mountpoint -q "$MOUNT_POINT" || die "共享盘没有挂载成功，后面的步骤没有意义，已停止。"

# ---------- 2. 准备 Node.js 运行时 ----------

step "[2/5] 准备 Node.js 运行时…"

NODE_BIN="$(find_node || true)"

if [ -z "$NODE_BIN" ]; then
  info "系统里没找到可用的 node，尝试用 apt 安装…"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq >/dev/null 2>&1 || true
  apt-get install -y nodejs >/dev/null 2>&1 || true
  NODE_BIN="$(find_node || true)"
fi

[ -n "$NODE_BIN" ] || die "找不到可用的 Node.js，且 apt 安装失败。
         请手动安装后重试，例如： sudo apt install nodejs"

NODE_VER="$("$NODE_BIN" -v)"
info "找到 Node.js：$NODE_BIN（$NODE_VER）"

# 把 node 内置一份到安装目录：这样服务永远不依赖外部路径，
# 哪怕以后卸载了 WorkBuddy / nvm / apt 的 node，服务照样能起来。
mkdir -p "$INSTALL_DIR/runtime"
if [ -x "$RUNTIME_NODE" ] && "$RUNTIME_NODE" -v >/dev/null 2>&1; then
  info "已内置运行时：$RUNTIME_NODE（$("$RUNTIME_NODE" -v)），跳过复制"
else
  info "复制一份 node 到 $RUNTIME_NODE（约 120MB，保证服务长期可用）…"
  cp -f "$NODE_BIN" "$RUNTIME_NODE"
  chmod 755 "$RUNTIME_NODE"
  "$RUNTIME_NODE" -v >/dev/null 2>&1 || die "复制出来的 node 无法运行，请检查磁盘空间。"
fi

# 顺手给命令行也装一个，方便以后 node / npm 直接敲
if ! command -v node >/dev/null 2>&1; then
  if install -m 755 "$RUNTIME_NODE" /usr/local/bin/node 2>/dev/null; then
    info "已提供命令行命令：/usr/local/bin/node"
  else
    info "（可选）命令行想直接用 node，执行： sudo cp $RUNTIME_NODE /usr/local/bin/node"
  fi
fi

# ---------- 3. 安装程序 ----------

step "[3/5] 安装程序到 $INSTALL_DIR …"
mkdir -p "$INSTALL_DIR"
cp -r "$SRC_DIR"/. "$INSTALL_DIR/"
rm -rf "$INSTALL_DIR/data" "$INSTALL_DIR/logs"
mkdir -p "$INSTALL_DIR/data" "$INSTALL_DIR/logs"

if [ -d "$INSTALL_DIR/node_modules" ]; then
  info "依赖已存在，跳过 npm install"
else
  info "安装依赖（首次可能需要几分钟，因为要下载图片处理库）…"
  if command -v npm >/dev/null 2>&1; then
    (cd "$INSTALL_DIR" && npm install --omit=dev --no-audit --no-fund) >/dev/null 2>&1 \
      || info "npm install 未完全成功，继续尝试用已带依赖运行"
  else
    info "未找到 npm，将使用源码目录自带的依赖"
  fi
fi

# 关键冒烟测试：sharp 是原生模块，起不来整个缩略图功能就废了
if [ -d "$INSTALL_DIR/node_modules" ]; then
  if "$RUNTIME_NODE" -e "require('$INSTALL_DIR/node_modules/sharp')" >/dev/null 2>&1; then
    info "依赖冒烟测试通过（sharp 可加载）"
  else
    info "注意：sharp 未能加载，图片缩略图可能不可用（文件浏览/上传/下载不受影响）"
  fi
fi

chown -R "$RUN_USER":"$RUN_USER" "$INSTALL_DIR"
chmod 700 "$INSTALL_DIR/data"
info "完成"

# ---------- 4. 设置管理员密码 ----------

step "[4/5] 设置管理员密码"
info "这个密码用于：删除、重命名、移动文件，以及上传超过 1GB 的文件。"

ADMIN_PWD="${HOMECLOUD_ADMIN_PWD:-}"
if [ -z "$ADMIN_PWD" ]; then
  read -r -s -p "  请输入管理员密码（输入时不显示）：" ADMIN_PWD
  echo ""
  [ -n "$ADMIN_PWD" ] || die "密码不能为空，已取消安装。"
  read -r -s -p "  请再输入一次确认：" ADMIN_PWD2
  echo ""
  [ "$ADMIN_PWD" = "$ADMIN_PWD2" ] || die "两次输入不一致，已取消安装。"
fi

cd "$INSTALL_DIR"
sudo -u "$RUN_USER" "$RUNTIME_NODE" server.js --set-password "$ADMIN_PWD" >/dev/null \
  || die "密码写入失败，请检查 $INSTALL_DIR/data 目录权限。"
info "密码已设置"

# ---------- 5. 安装 systemd 服务 ----------

step "[5/5] 安装 systemd 服务…"
cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<EOF
[Unit]
Description=HomeCloud 家庭局域网私有网盘
After=network-online.target local-fs.target
Wants=network-online.target

[Service]
Type=simple
User=${RUN_USER}
WorkingDirectory=${INSTALL_DIR}
Environment=HOMECLOUD_ROOT=${MOUNT_POINT}
Environment=HOMECLOUD_PORT=${PORT}
Environment=HOME=/home/${RUN_USER}
ExecStart=${RUNTIME_NODE} ${INSTALL_DIR}/server.js
Restart=always
RestartSec=3
StandardOutput=append:${INSTALL_DIR}/logs/homecloud.log
StandardError=append:${INSTALL_DIR}/logs/homecloud.log

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "$SERVICE_NAME" >/dev/null 2>&1
systemctl restart "$SERVICE_NAME"
sleep 2

if systemctl is-active --quiet "$SERVICE_NAME"; then
  info "服务运行中，并已设为开机自启"
else
  echo ""
  echo "  [出错] 服务没能启动。请查看日志："
  echo "     journalctl -u $SERVICE_NAME -n 50 --no-pager"
  echo "     tail -n 50 $INSTALL_DIR/logs/homecloud.log"
  exit 1
fi

# ---------- 收尾 ----------

IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
echo ""
echo "=============================================="
echo " 安装完成！"
echo "=============================================="
echo " 在任意连着家里 WiFi 的设备上打开浏览器访问："
echo ""
echo "     http://${IP}:${PORT}"
echo ""
echo " 常用命令："
echo "   查看状态： sudo systemctl status $SERVICE_NAME"
echo "   重启服务： sudo systemctl restart $SERVICE_NAME"
echo "   停止服务： sudo systemctl stop $SERVICE_NAME"
echo "   查看日志： tail -f $INSTALL_DIR/logs/homecloud.log"
echo "   修改密码： sudo -u $RUN_USER $RUNTIME_NODE $INSTALL_DIR/server.js --set-password 新密码"
echo ""
echo " 运行用户：$RUN_USER    Node.js：$RUNTIME_NODE（$NODE_VER）"
echo ""
echo " 安全提醒：请不要把 $PORT 端口映射到公网，也不要做内网穿透。"
echo "           这套系统只设计给家庭局域网内部使用。"
echo "=============================================="
