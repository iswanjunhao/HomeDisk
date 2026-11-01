#!/usr/bin/env bash
#
# 挂载 1T 共享盘到 /mnt/homedisk
# 用法：sudo bash scripts/mount-disk.sh [设备路径]
# 不传参数时自动查找第一块 NTFS 数据盘
#
set -euo pipefail

MOUNT_POINT="/mnt/homedisk"
DEVICE="${1:-}"

echo "=== HomeCloud 共享盘挂载 ==="

# ---------- 1. 确定设备 ----------
if [ -z "$DEVICE" ]; then
  echo "自动查找 NTFS 数据盘…"
  # 找出所有 NTFS 分区，排除已经挂载在系统关键位置上的
  CANDIDATES=$(lsblk -ln -o NAME,FSTYPE,SIZE,MOUNTPOINT | awk '$2=="ntfs" && $4=="" {print "/dev/"$1}')
  if [ -z "$CANDIDATES" ]; then
    echo "没有找到未挂载的 NTFS 分区。当前磁盘情况："
    lsblk -o NAME,SIZE,FSTYPE,MOUNTPOINT
    echo ""
    echo "请手动指定，例如： sudo bash $0 /dev/sda2"
    exit 1
  fi
  echo "找到候选分区："
  echo "$CANDIDATES"
  DEVICE=$(echo "$CANDIDATES" | head -1)
fi

if [ ! -b "$DEVICE" ]; then
  echo "错误：$DEVICE 不是有效的块设备"
  exit 1
fi
echo "使用设备：$DEVICE"

# ---------- 2. 取 UUID ----------
UUID=$(blkid -s UUID -o value "$DEVICE" || true)
if [ -z "$UUID" ]; then
  echo "警告：读不到 UUID，fstab 将改用设备路径（插拔顺序变化后可能失效）"
  FSTAB_SRC="$DEVICE"
else
  FSTAB_SRC="UUID=$UUID"
  echo "UUID：$UUID"
fi

# ---------- 3. 创建挂载点 ----------
mkdir -p "$MOUNT_POINT"

# ---------- 4. 选择挂载驱动 ----------
# 优先用内核 ntfs3（性能好）；若失败则退回 ntfs-3g（兼容性更好）
REAL_UID=$(id -u "${SUDO_USER:-$USER}" 2>/dev/null || echo 1000)
REAL_GID=$(id -g "${SUDO_USER:-$USER}" 2>/dev/null || echo 1000)
# noacsrules：忽略 Windows 的 ACL（权限规则）。
# 不加这个选项，Windows 系统留下的目录（如 WindowsApps）会保留 TrustedInstaller 权限，
# 导致 Linux 上的服务用户删不掉、改不动。
OPTS="rw,nofail,uid=${REAL_UID},gid=${REAL_GID},umask=022,iocharset=utf8,noacsrules"

# 已经挂载过就先卸载，确保新的挂载选项生效
if mountpoint -q "$MOUNT_POINT"; then
  echo "$MOUNT_POINT 已挂载，先卸载以应用新的挂载选项…"
  umount "$MOUNT_POINT" 2>/dev/null || umount -l "$MOUNT_POINT" 2>/dev/null || true
fi

DRIVER=""

echo "尝试用 ntfs3 挂载…"
if mount -t ntfs3 -o "$OPTS" "$DEVICE" "$MOUNT_POINT" 2>/dev/null; then
  DRIVER="ntfs3"
  echo "  ntfs3 挂载成功（已忽略 Windows ACL）"
else
  # 少数内核版本不支持 noacsrules，退回不带该选项再试一次
  echo "  带 noacsrules 失败，尝试不带该选项…"
  OPTS="rw,nofail,uid=${REAL_UID},gid=${REAL_GID},umask=022,iocharset=utf8"
  if mount -t ntfs3 -o "$OPTS" "$DEVICE" "$MOUNT_POINT" 2>/dev/null; then
    DRIVER="ntfs3"
    echo "  ntfs3 挂载成功"
  fi
fi

if [ -z "$DRIVER" ]; then
  echo "  ntfs3 失败，改用 ntfs-3g…"
  OPTS="rw,nofail,uid=${REAL_UID},gid=${REAL_GID},umask=022,big_writes"
  if mount -t ntfs-3g -o "$OPTS" "$DEVICE" "$MOUNT_POINT"; then
    DRIVER="ntfs-3g"
    echo "  ntfs-3g 挂载成功"
  else
    echo ""
    echo "挂载失败。常见原因："
    echo "  1. 这块盘是 Windows 系统盘且启用了「快速启动」"
    echo "     → 进 Windows：控制面板 → 电源选项 → 取消勾选「启用快速启动」，再关机重启到 Linux"
    echo "  2. 文件系统有错误 → 在 Windows 里运行： chkdsk /f X:"
    echo "  3. 没有安装 ntfs-3g → sudo apt install ntfs-3g"
    exit 1
  fi
fi

# ---------- 5. 写入 fstab 实现开机自动挂载 ----------
FSTAB_LINE="$FSTAB_SRC  $MOUNT_POINT  $DRIVER  $OPTS  0  0"
# 已存在旧记录就整行替换，保证 fstab 与本次实际挂载选项一致
# （否则改了挂载选项，重启后又被旧配置覆盖回去）
if grep -qE "^[^#]*[[:space:]]${MOUNT_POINT}[[:space:]]" /etc/fstab; then
  echo ""
  echo "更新 /etc/fstab 中的旧记录："
  echo "  $FSTAB_LINE"
  cp /etc/fstab "/etc/fstab.bak.$(date +%Y%m%d%H%M%S)"
  grep -vE "^[^#]*[[:space:]]${MOUNT_POINT}[[:space:]]" /etc/fstab > /tmp/fstab.new
  echo "$FSTAB_LINE" >> /tmp/fstab.new
  mv /tmp/fstab.new /etc/fstab
  echo "已更新（原文件已备份为 /etc/fstab.bak.*）"
else
  echo ""
  echo "准备写入 /etc/fstab："
  echo "  $FSTAB_LINE"
  cp /etc/fstab "/etc/fstab.bak.$(date +%Y%m%d%H%M%S)"
  echo "$FSTAB_LINE" >> /etc/fstab
  echo "已写入（原文件已备份为 /etc/fstab.bak.*）"
fi

# ---------- 6. 验证 ----------
echo ""
echo "=== 挂载结果 ==="
df -h "$MOUNT_POINT"
echo ""
if touch "$MOUNT_POINT/.homecloud_write_test" 2>/dev/null; then
  rm -f "$MOUNT_POINT/.homecloud_write_test"
  echo "读写权限：正常（可写）"
else
  echo "读写权限：只读（无法写入，上传功能会失败）"
fi
echo ""
echo "挂载点内容预览："
ls -la "$MOUNT_POINT" | head -15
