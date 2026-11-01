/**
 * 路径安全校验 —— 整个服务最重要的一块
 *
 * 威胁模型：客户端可以在 URL / JSON 里塞进任意字符串，试图读到共享盘之外的文件
 * （例如 ../../etc/passwd、URL 编码绕过、符号链接逃逸）。
 * 防御手段：normalize 归一化 → resolve 拼接 → realpath 解析符号链接 → 前缀比对。
 * 任何一步失败都必须拒绝，绝不能"尽力而为"。
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

let ROOT = null;        // 共享盘根目录的绝对路径（已 realpath）
let ROOT_REAL = null;

function setRoot(rootPath) {
  ROOT = path.resolve(rootPath);
  try {
    ROOT_REAL = fs.realpathSync(ROOT);
  } catch (e) {
    // 根目录不存在（比如磁盘没挂载），此时所有请求都会返回明确提示
    ROOT_REAL = null;
  }
  return ROOT_REAL;
}

function getRoot() {
  return ROOT;
}

/** 根目录是否可用（磁盘已挂载且可访问） */
function isRootAvailable() {
  if (!ROOT_REAL) return false;
  try {
    fs.accessSync(ROOT_REAL, fs.constants.R_OK);
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * 把客户端传入的相对路径解析为安全的绝对路径
 * @param {string} rel 客户端传入的路径，如 "/家庭影像/2026" 或 ""
 * @param {object} opts { mustExist: 是否要求路径必须存在（默认 true）, allowRoot: 是否允许指向根目录 }
 * @returns {string} 安全的绝对路径
 */
function resolveSafe(rel, opts = {}) {
  const mustExist = opts.mustExist !== false;
  const allowRoot = opts.allowRoot !== false;

  if (!ROOT_REAL) {
    throw new AppError(503, '共享盘未挂载或不可访问，请检查磁盘挂载状态');
  }
  if (typeof rel !== 'string') {
    throw new AppError(400, '路径参数格式不正确');
  }
  // 空字节可以直接截断 C 层的文件名判断，必须挡掉
  if (rel.indexOf('\0') !== -1) {
    throw new AppError(400, '路径中包含非法字符');
  }

  // 1) 归一化：统一按 POSIX 分隔符处理，把 .. 折叠掉
  const normalized = path.posix.normalize('/' + rel.replace(/\\/g, '/'));

  // 2) 拼接：以根目录为基准，'.' 保证不会把根目录替换掉
  const abs = path.resolve(ROOT_REAL, '.' + normalized);

  // 3) realpath 解析符号链接，杜绝软链接逃出共享盘
  let real;
  try {
    real = fs.realpathSync(abs);
  } catch (e) {
    if (mustExist) throw new AppError(404, '文件或目录不存在：' + rel);
    // 目标还不存在时（例如新建文件），改用其父目录校验
    const parent = path.dirname(abs);
    let parentReal;
    try {
      parentReal = fs.realpathSync(parent);
    } catch (e2) {
      throw new AppError(404, '所在目录不存在：' + rel);
    }
    if (!isInside(parentReal)) throw new AppError(403, '非法路径：超出共享目录范围');
    return abs;
  }

  // 4) 前缀比对：必须在根目录之内（或就是根目录本身）
  if (real === ROOT_REAL) {
    if (!allowRoot) throw new AppError(400, '不允许对共享盘根目录执行此操作');
    return real;
  }
  if (!isInside(real)) {
    throw new AppError(403, '非法路径：超出共享目录范围');
  }
  return real;
}

function isInside(abs) {
  return abs === ROOT_REAL || abs.startsWith(ROOT_REAL + path.sep);
}

/** 绝对路径 → 相对根目录的展示路径（始终以 / 开头） */
function toRel(absPath) {
  const rel = path.relative(ROOT_REAL, absPath);
  if (!rel) return '/';
  return '/' + rel.split(path.sep).join('/');
}

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

module.exports = { AppError, setRoot, getRoot, isRootAvailable, resolveSafe, toRel, safeName, uniqueName };
