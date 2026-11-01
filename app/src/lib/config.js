/**
 * 配置管理
 * 所有可调项集中在这里：共享盘根目录、端口、管理员密码哈希、访客上传上限等
 * 配置持久化在 app/data/config.json，可用环境变量临时覆盖（方便测试）
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

// 跨平台默认共享根目录：
// Linux 上默认用挂载点 /mnt/homedisk；Windows 上默认用 D: 盘根。
// 无论如何，都推荐用环境变量 HOMECLOUD_ROOT 显式指定真正的共享目录。
const IS_WIN = process.platform === 'win32';
const DEFAULT_ROOT = IS_WIN ? 'D:\\' : '/mnt/homedisk';

// 默认配置
const DEFAULTS = {
  root: DEFAULT_ROOT,                 // 共享根目录（兼容旧版：等于第一块盘的路径）
  port: 8080,                        // 监听端口
  adminPasswordHash: '',             // 管理员密码哈希，格式 salt:hash（scrypt）
  guestUploadMaxBytes: 1024 * 1024 * 1024, // 访客免密码上传的单文件上限：1GB
  sessionHours: 8,                   // 管理员登录有效期（小时）
  indexIntervalMinutes: 30,          // 全盘索引刷新间隔（分钟）
  trashDir: '',                      // 回收站目录，留空表示直接删除
  lanOnly: true,                     // 仅允许局域网网段访问
  disks: null,                       // 多磁盘：[{ id, name, path, enabled }]，null 表示用 root 兼容
};

let config = null;

/**
 * 把"旧版单 root"或已有 disks 归一化成规范的 disks 数组
 * 兼容性：历史配置里只有 root 时，把它当作第一块盘；disks 已有则直接清洗。
 */
function normalizeDisks(saved) {
  let disks = Array.isArray(saved && saved.disks) ? saved.disks : null;
  if (!disks || !disks.length) {
    const r = (saved && saved.root) || DEFAULT_ROOT;
    disks = [{ id: 'disk1', name: '共享盘', path: r, enabled: true }];
  }
  return disks.map((d, i) => ({
    id: String(d.id || ('disk' + (i + 1))),
    name: d.name || ('磁盘 ' + (i + 1)),
    path: String(d.path || ''),
    enabled: d.enabled !== false,
  }));
}

/** 加载配置（文件 + 环境变量覆盖） */
function load() {
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (e) {
    // 首次运行没有配置文件，用默认值
  }
  config = Object.assign({}, DEFAULTS, saved || {});
  config.disks = normalizeDisks(saved || {});

  // 环境变量优先，便于在没有写权限的环境里临时改配置
  if (process.env.HOMECLOUD_ROOT) {
    config.disks[0] = Object.assign({}, config.disks[0], { path: process.env.HOMECLOUD_ROOT });
    config.root = process.env.HOMECLOUD_ROOT;
  }
  if (process.env.HOMECLOUD_PORT) config.port = Number(process.env.HOMECLOUD_PORT);
  if (process.env.HOMECLOUD_UPLOAD_LIMIT) {
    config.guestUploadMaxBytes = Number(process.env.HOMECLOUD_UPLOAD_LIMIT);
  }
  if (process.env.HOMECLOUD_TRASH) config.trashDir = process.env.HOMECLOUD_TRASH;
  // 环境变量直接指定明文密码时，用它覆盖（方便部署脚本一次性设定）
  if (process.env.HOMECLOUD_PASSWORD) {
    config.adminPasswordHash = hashPassword(process.env.HOMECLOUD_PASSWORD);
  }

  // root 始终与"第一块盘"保持同步，兼容 install.sh / systemd 里读 root 的旧逻辑
  config.root = config.disks[0] ? config.disks[0].path : DEFAULT_ROOT;

  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (e) { /* 只读环境下忽略 */ }

  return config;
}

function get() {
  if (!config) return load();
  return config;
}

function save(patch) {
  config = Object.assign(get(), patch || {});
  // 写回前保持 root 与 disks[0] 同步
  if (Array.isArray(config.disks) && config.disks[0]) {
    config.root = config.disks[0].path;
  }
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
  } catch (e) {
    console.warn('[配置] 写入失败：' + e.message);
  }
  return config;
}

/** 读取（已归一化的）磁盘列表 */
function getDisks() {
  const c = get();
  return Array.isArray(c.disks) && c.disks.length ? c.disks : normalizeDisks(c);
}

/** 持久化磁盘列表（并同步 root） */
function saveDisks(disks) {
  return save({ disks: normalizeDisks({ disks: disks || [] }) });
}

/** 用 scrypt 生成密码哈希，格式 salt:hash */
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return salt + ':' + hash;
}

/** 校验密码（用 timingSafeEqual 防止时序侧信道） */
function verifyPassword(password, stored) {
  if (!stored || !password) return false;
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const candidate = crypto.scryptSync(String(password), salt, 64);
  const expected = Buffer.from(hash, 'hex');
  if (candidate.length !== expected.length) return false;
  return crypto.timingSafeEqual(candidate, expected);
}

module.exports = { load, get, save, getDisks, saveDisks, normalizeDisks, hashPassword, verifyPassword, DEFAULTS, CONFIG_FILE, DATA_DIR };
