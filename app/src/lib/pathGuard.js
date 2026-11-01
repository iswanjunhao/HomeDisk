/**
 * 路径安全校验 —— 整个服务最重要的一块
 *
 * 威胁模型：客户端可以在 URL / JSON 里塞进任意字符串，试图读到共享盘之外的文件
 * （例如 ../../etc/passwd、URL 编码绕过、符号链接逃逸）。
 * 防御手段：normalize 归一化 → resolve 拼接 → realpath 解析符号链接 → 前缀比对。
 * 任何一步失败都必须拒绝，绝不能"尽力而为"。
 *
 * 多磁盘模型：所有客户端路径统一为 /<diskId>/... 形式（磁盘选择器层为 /）。
 * 每块磁盘维护各自的 root / rootReal；resolveSafe / toRel 据此自动归属。
 */

const path = require('path');
const fs = require('fs');

/** 业务异常：带 HTTP 状态码，交给统一错误处理转成中文提示 */
class AppError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// id -> { id, name, path, root, rootReal, enabled }
const DISKS = new Map();

const MARKER = '.homecloud-disk.json';

/** 用后端配置（disks 数组）重建多磁盘表 */
function setRoots(disks) {
  DISKS.clear();
  (disks || []).forEach((d) => {
    const root = path.resolve(d.path || '');
    let rootReal = null;
    try {
      rootReal = fs.realpathSync(root);
    } catch (e) {
      // 磁盘没挂载或路径不存在，记录但允许后续重扫描恢复
      rootReal = null;
    }
    DISKS.set(d.id, {
      id: d.id,
      name: d.name,
      path: d.path,
      root,
      rootReal,
      enabled: d.enabled !== false,
    });
  });
  return getDisks();
}

function getDisks() {
  return Array.from(DISKS.values());
}

function getDisk(id) {
  return DISKS.get(id);
}

/** 仅有一块盘时，用于旧链接（不带 diskId 前缀）的向后兼容 */
function singleDisk() {
  if (DISKS.size === 1) return Array.from(DISKS.values())[0];
  return null;
}

/**
 * 解析客户端相对路径，拆出 diskId 与该盘内的相对路径
 * @returns {{ id: string|null, rest: string }}
 */
function parseDisk(rel) {
  const norm = path.posix.normalize('/' + String(rel || '').replace(/\\/g, '/'));
  const segs = norm.split('/').filter(Boolean);
  if (!segs.length) return { id: null, rest: '' };
  const first = segs[0];
  if (DISKS.has(first)) return { id: first, rest: '/' + segs.slice(1).join('/') };
  // 向后兼容：只有一个盘时，旧链接（不带 diskId 前缀）按该盘处理
  if (DISKS.size === 1) {
    return { id: Array.from(DISKS.keys())[0], rest: norm };
  }
  return { id: null, rest: norm };
}

function insideDisk(abs, disk) {
  return abs === disk.rootReal || abs.startsWith(disk.rootReal + path.sep);
}

/** 在单块盘范围内做安全解析（复用旧逻辑，但作用域限定到 disk.rootReal） */
function resolveWithin(disk, relWithin, opts) {
  const mustExist = opts.mustExist !== false;
  const allowRoot = opts.allowRoot !== false;
  if (!disk.rootReal) {
    throw new AppError(503, `磁盘「${disk.name}」未挂载或不可访问，请检查挂载状态`);
  }
  const normalized = path.posix.normalize('/' + String(relWithin || '').replace(/\\/g, '/'));
  const abs = path.resolve(disk.rootReal, '.' + normalized);

  let real;
  try {
    real = fs.realpathSync(abs);
  } catch (e) {
    if (mustExist) throw new AppError(404, '文件或目录不存在：' + relWithin);
    // 目标还不存在时（例如新建文件），改用其父目录校验
    const parent = path.dirname(abs);
    let parentReal;
    try {
      parentReal = fs.realpathSync(parent);
    } catch (e2) {
      throw new AppError(404, '所在目录不存在：' + relWithin);
    }
    if (!insideDisk(parentReal, disk)) throw new AppError(403, '非法路径：超出共享目录范围');
    return abs;
  }

  if (real === disk.rootReal) {
    if (!allowRoot) throw new AppError(400, '不允许对共享磁盘根目录执行此操作');
    return real;
  }
  if (!insideDisk(real, disk)) {
    throw new AppError(403, '非法路径：超出共享目录范围');
  }
  return real;
}

/**
 * 把客户端传入的相对路径解析为安全的绝对路径
 * 路径须为 /<diskId>/...（磁盘选择层用 /，由调用方单独处理）
 */
function resolveSafe(rel, opts = {}) {
  const { id, rest } = parseDisk(rel);
  const disk = id ? DISKS.get(id) : singleDisk();
  if (!disk) {
    throw new AppError(400, '找不到对应的共享磁盘，请刷新页面或在「管理磁盘」中添加');
  }
  return resolveWithin(disk, rest, opts);
}

/** 绝对路径 → 带 diskId 前缀的展示路径（始终以 / 开头） */
function toRel(absPath) {
  let best = null;
  for (const d of DISKS.values()) {
    if (!d.rootReal) continue;
    if (absPath === d.rootReal || absPath.startsWith(d.rootReal + path.sep)) {
      if (!best || d.rootReal.length > best.rootReal.length) best = d;
    }
  }
  if (!best) throw new AppError(500, '路径不在任何共享磁盘内');
  const rel = path.relative(best.rootReal, absPath);
  if (!rel) return '/' + best.id + '/';
  return '/' + best.id + '/' + rel.split(path.sep).join('/');
}

/* ----------------------------- 可用性 / 根目录判断 ----------------------------- */

/** 单块盘是否可用（已挂载且可读） */
function isDiskAvailable(id) {
  const d = DISKS.get(id);
  if (!d || !d.enabled || !d.rootReal) return false;
  try {
    fs.accessSync(d.rootReal, fs.constants.R_OK);
    return true;
  } catch (e) {
    return false;
  }
}

/** 任意一块盘可用（兼容旧接口） */
function isRootAvailable() {
  for (const d of DISKS.values()) {
    if (d.enabled && isDiskAvailable(d.id)) return true;
  }
  return false;
}

/** 路径是否等于任意一块盘的根目录（用于防删除/防重命名根目录） */
function isAnyDiskRoot(abs) {
  for (const d of DISKS.values()) {
    if (abs === d.rootReal) return true;
  }
  return false;
}

/** 兼容旧代码：返回第一块可用盘的根（无则 null） */
function getRoot() {
  for (const d of DISKS.values()) {
    if (d.enabled && d.rootReal) return d.rootReal;
  }
  const first = DISKS.values().next().value;
  return first ? first.rootReal || first.root : null;
}

/* ----------------------------- 磁盘身份标记（.homecloud-disk.json） ----------------------------- */

/** 读取某挂载根下的磁盘标记；用于换机/换盘后按 id 重新关联 */
function readMarker(diskRoot) {
  try {
    const raw = fs.readFileSync(path.join(diskRoot, MARKER), 'utf8');
    const o = JSON.parse(raw);
    if (o && o.id) return o;
  } catch (e) { /* 无标记 */ }
  return null;
}

/** 在磁盘根写入标记，把本应用的磁盘 id 固化到盘上 */
function writeMarker(diskRoot, id, name) {
  try {
    fs.writeFileSync(
      path.join(diskRoot, MARKER),
      JSON.stringify({ id, name: name || '', createdAt: Date.now() }),
      'utf8'
    );
    return true;
  } catch (e) {
    return false;
  }
}

/** 在给定候选挂载根里扫描标记文件，返回 [{ id, name, path }]（用于重扫描/添加候选） */
function scanMarkers(roots) {
  const found = [];
  for (const r of roots) {
    const m = readMarker(r);
    if (m) found.push({ id: m.id, name: m.name || m.id, path: r });
  }
  return found;
}

module.exports = {
  AppError, setRoots, getDisks, getDisk, parseDisk, resolveSafe, toRel,
  safeName, uniqueName, isRootAvailable, isDiskAvailable, isAnyDiskRoot, getRoot,
  readMarker, writeMarker, scanMarkers, MARKER,
};

/* ----------------------------- 原 safeName / uniqueName（保持不变） ----------------------------- */

/**
 * 清洗文件名/目录名：剔除路径分隔符与控制字符，挡掉 Windows 保留名
 * 上传、新建文件夹、重命名都必须先过这一关
 */
function safeName(name) {
  if (typeof name !== 'string' || name.trim() === '') {
    throw new AppError(400, '名称不能为空');
  }
  let n = name.replace(/[\x00-\x1f\x7f]/g, '');   // 控制字符
  n = n.replace(/[/\\]/g, '_');                    // 路径分隔符，防止跨目录
  n = n.replace(/^\.+/, '');                       // 开头连续的点，防止 . / ..
  n = n.trim();
  if (!n) throw new AppError(400, '名称不能为空');
  // Windows 保留设备名（CON、PRN、AUX、NUL、COM1-9、LPT1-9）在 Windows 下无法创建
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(n)) {
    n = '_' + n;
  }
  if (Buffer.byteLength(n, 'utf8') > 200) {
    // 超长名截断，避免超过 NTFS 255 字节限制
    n = Buffer.from(n, 'utf8').slice(0, 200).toString('utf8');
  }
  return n;
}

/** 目标已存在时自动生成 "xxx (1).txt" 形式的新名字，绝不静默覆盖 */
function uniqueName(dir, name) {
  let candidate = name;
  let i = 1;
  const ext = path.extname(name);
  const base = path.basename(name, ext);
  while (fs.existsSync(path.join(dir, candidate))) {
    candidate = `${base} (${i})${ext}`;
    i++;
    if (i > 9999) break; // 兜底，避免死循环
  }
  return candidate;
}
