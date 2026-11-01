/**
 * 服务器目录浏览（供图形界面选择要共享的目录）
 * 只返回子目录列表，不返回文件；权限由调用方保证（管理员登录 / 初始化向导仅限本机）。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { quickVolumes } = require('./volumes');

/** 是否为文件系统根目录（Linux: / ；Windows: C:\ 之类盘符根） */
function isFsRoot(p) {
  if (process.platform === 'win32') return /^[a-zA-Z]:\\?$/.test(p);
  return p === '/';
}

/** 列出某个路径下的子目录（含根目录下的已挂载磁盘快捷入口） */
async function listDirs(basePath) {
  let p = String(basePath || '').trim();
  if (!p || p === '~') p = os.homedir() || '/';
  p = path.resolve(p);

  let st;
  try {
    st = fs.statSync(p);
  } catch (e) {
    throw Object.assign(new Error('路径不存在：' + p), { status: 400 });
  }
  if (!st.isDirectory()) {
    throw Object.assign(new Error('不是目录：' + p), { status: 400 });
  }

  let entries = [];
  try {
    entries = fs.readdirSync(p, { withFileTypes: true });
  } catch (e) {
    throw Object.assign(new Error('无法读取该目录（权限不足？）：' + p), { status: 403 });
  }

  const dirs = [];
  const seen = new Set();

  // 文件系统根：先放已挂载磁盘 + 系统盘入口，方便直接选其他硬盘
  if (isFsRoot(p)) {
    try {
      const vols = await quickVolumes();
      for (const v of vols) {
        if (v.path === p) continue;   // 当前就在这个盘的根，无需重复列出
        dirs.push({ name: v.name, path: v.path, kind: v.kind, device: v.device, fstype: v.fstype });
        seen.add(v.path);
      }
    } catch (e) { /* 不影响主流程 */ }
  }

  for (const en of entries) {
    if (!en.isDirectory()) continue;
    // Linux 根目录下跳过系统伪文件系统，避免误选 /proc 之类
    if (p === '/' && ['proc', 'sys', 'dev', 'run'].includes(en.name)) continue;
    const full = path.join(p, en.name);
    if (seen.has(full)) continue;   // 已作为挂载磁盘展示，避免重复
    seen.add(full);
    dirs.push({ name: en.name, path: full });
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }));

  const parent = path.dirname(p) === p ? null : path.dirname(p);
  return { path: p, parent, dirs };
}

/** 目录默认显示名：取路径最后一段 */
function defaultName(p) {
  const base = path.basename(String(p || ''));
  return base || String(p || '');
}

module.exports = { listDirs, defaultName };
