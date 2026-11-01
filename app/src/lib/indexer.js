/**
 * 后台索引器
 * 1T 盘可能有几十万文件，不可能每次搜索都遍历一遍。
 * 做法：启动时在后台全量扫描一次，结果常驻内存并落盘缓存；之后定时增量刷新。
 * 扫描过程中搜索仍可用（走实时遍历的兜底路径）。
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { classify } = require('./classifier');
const { getRoot, isRootAvailable } = require('./pathGuard');

const CACHE_FILE = path.join(__dirname, '..', '..', 'data', 'index-cache.json');
const MAX_ENTRIES = 300000;      // 索引上限，防止内存被打爆
const SKIP_DIRS = new Set(['$RECYCLE.BIN', 'System Volume Information', '.Trash-1000']);

let entries = [];
let status = {
  building: false,
  scanned: 0,
  startedAt: null,
  finishedAt: null,
  durationMs: 0,
  error: null,
};
let refreshTimer = null;

/** 后台全量扫描（非阻塞，用迭代栈避免深层递归爆栈） */
async function buildIndex() {
  if (status.building) return;
  if (!isRootAvailable()) {
    status.error = '共享盘未挂载，暂无法建立索引';
    return;
  }
  status = { building: true, scanned: 0, startedAt: Date.now(), finishedAt: null, durationMs: 0, error: null };

  const root = getRoot();
  const result = [];
  const stack = [''];
  const started = Date.now();

  try {
    while (stack.length) {
      const relDir = stack.pop();
      const absDir = path.join(root, relDir);
      let dir;
      try {
        dir = await fsp.opendir(absDir);
      } catch (e) {
        continue; // 无权限或已删除，跳过
      }
      for await (const dirent of dir) {
        // 隐藏文件与 NTFS 系统目录不索引
        if (dirent.name.startsWith('.')) continue;
        if (dirent.isDirectory() && SKIP_DIRS.has(dirent.name)) continue;

        const relPath = relDir ? relDir + '/' + dirent.name : dirent.name;
        const item = {
          p: relPath,                       // 相对根目录的路径
          n: dirent.name,                   // 文件名
          d: relDir,                        // 所在目录
          isDir: dirent.isDirectory(),
          s: 0,
          m: 0,
          t: 'other',
        };
        if (!dirent.isDirectory()) {
          try {
            const st = await fsp.stat(path.join(root, relPath));
            item.s = st.size;
            item.m = st.mtimeMs;
            item.t = classify(dirent.name);
          } catch (e) { /* 忽略无法 stat 的文件 */ }
        } else {
          stack.push(relPath);
        }
        result.push(item);
        status.scanned = result.length;

        // 每 40ms 让出一次事件循环，避免索引把 HTTP 请求卡住
        if (result.length % 500 === 0) {
          await new Promise((r) => setImmediate(r));
        }
        if (result.length >= MAX_ENTRIES) {
          stack.length = 0;
          break;
        }
      }
      // 控制扫描节奏：超过 8 分钟的索引自动收敛（避免超大目录拖垮服务）
      if (Date.now() - started > 8 * 60 * 1000) {
        status.error = '目录过大，索引已截断';
        break;
      }
    }
    entries = result;
    status.building = false;
    status.finishedAt = Date.now();
    status.durationMs = status.finishedAt - status.startedAt;
    saveCache();
    console.log(`[索引] 完成，共 ${entries.length} 条，耗时 ${(status.durationMs / 1000).toFixed(1)} 秒`);
  } catch (e) {
    status.building = false;
    status.error = e.message;
    console.error('[索引] 失败：' + e.message);
  }
}

function saveCache() {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify({ updatedAt: Date.now(), entries }), 'utf8');
  } catch (e) {
    console.warn('[索引] 缓存写入失败：' + e.message);
  }
}

function loadCache() {
  try {
    const raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (raw && Array.isArray(raw.entries)) {
      entries = raw.entries;
      status.finishedAt = raw.updatedAt || null;
      console.log(`[索引] 已载入缓存 ${entries.length} 条，将在后台刷新`);
    }
  } catch (e) { /* 无缓存，等后台扫描 */ }
}

/**
 * 搜索
 * @param {string} query 关键词（文件名模糊匹配，不区分大小写）
 * @param {string} scope 限定目录（相对路径，'' 表示全盘）
 * @param {string} category 分类过滤
 * @param {number} limit 结果上限
 */
function search(query, scope = '', category = 'all', limit = 500) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return { results: [], fromIndex: false, building: status.building };

  const prefix = normalizeScope(scope);
  const out = [];
  for (const e of entries) {
    if (!e.n.toLowerCase().includes(q)) continue;
    if (prefix && !(e.d === prefix || e.d.startsWith(prefix + '/'))) continue;
    if (category && category !== 'all' && e.t !== category) continue;
    out.push(e);
    if (out.length >= limit) break;
  }
  return {
    results: out,
    fromIndex: !status.building,
    building: status.building,
    total: entries.length,
  };
}

/** 按分类列出文件（用于顶部"图片/视频…"筛选页） */
function listByCategory(category, scope = '', sort = 'name', order = 'asc', limit = 500) {
  const prefix = normalizeScope(scope);
  let out = entries.filter((e) => {
    if (prefix && !(e.d === prefix || e.d.startsWith(prefix + '/'))) return false;
    if (category === 'all') return true;
    return e.t === category;
  });
  out = sortEntries(out, sort, order, true);
  return { results: out.slice(0, limit), building: status.building };
}

function normalizeScope(scope) {
  if (!scope) return '';
  return String(scope).replace(/^\/+|\/+$/g, '');
}

function sortEntries(list, sort = 'name', order = 'asc', flat = false) {
  const dir = order === 'desc' ? -1 : 1;
  const sorted = list.slice().sort((a, b) => {
    // 文件夹置顶（扁平列表模式下不置顶，避免分类页全是文件夹）
    if (!flat && a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    let r = 0;
    switch (sort) {
      case 'size':
        r = (a.s || 0) - (b.s || 0);
        break;
      case 'mtime':
        r = (a.m || 0) - (b.m || 0);
        break;
      case 'type':
        r = String(a.t).localeCompare(String(b.t));
        break;
      default:
        // 中文友好：用 localeCompare 的 numeric 模式，"文件2" 会排在 "文件10" 前面
        r = String(a.n).localeCompare(String(b.n), 'zh-CN', { numeric: true, sensitivity: 'base' });
    }
    return r * dir;
  });
  return sorted;
}

/** 索引尚未就绪时，实时遍历某个目录做兜底搜索 */
async function searchLive(query, scopeDir, category = 'all', limit = 500) {
  const root = getRoot();
  const startDir = path.join(root, scopeDir || '');
  const q = String(query || '').trim().toLowerCase();
  const out = [];
  const stack = [scopeDir || ''];
  while (stack.length) {
    const relDir = stack.pop();
    let dir;
    try {
      dir = await fsp.opendir(path.join(root, relDir));
    } catch (e) {
      continue;
    }
    for await (const dirent of dir) {
      if (dirent.name.startsWith('.')) continue;
      const relPath = relDir ? relDir + '/' + dirent.name : dirent.name;
      if (dirent.isDirectory()) {
        stack.push(relPath);
        continue;
      }
      if (!dirent.name.toLowerCase().includes(q)) continue;
      let st;
      try {
        st = await fsp.stat(path.join(root, relPath));
      } catch (e) {
        continue;
      }
      const t = classify(dirent.name);
      if (category && category !== 'all' && t !== category) continue;
      out.push({ p: relPath, n: dirent.name, d: relDir, isDir: false, s: st.size, m: st.mtimeMs, t });
      if (out.length >= limit) return { results: out, fromIndex: false, truncated: true };
    }
  }
  return { results: out, fromIndex: false, truncated: false };
}

function getStatus() {
  return {
    building: status.building,
    scanned: status.scanned,
    total: entries.length,
    finishedAt: status.finishedAt,
    durationMs: status.durationMs,
    error: status.error,
  };
}

/** 启动索引：先读缓存，再后台刷新，并按间隔定时重建 */
function start(intervalMinutes = 30) {
  loadCache();
  setTimeout(() => { buildIndex(); }, 1500);   // 延后一点，先让服务把首页响应出去
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(() => { buildIndex(); }, Math.max(5, intervalMinutes) * 60 * 1000);
  refreshTimer.unref();
}

/** 文件变更后让索引立刻失效（新建/删除/移动都会触发下一次定时重建） */
function invalidate() {
  status.finishedAt = null;
}

module.exports = { start, buildIndex, search, searchLive, listByCategory, sortEntries, getStatus, invalidate };
