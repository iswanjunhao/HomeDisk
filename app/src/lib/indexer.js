/**
 * 后台索引器（多磁盘版）
 * 1T 盘可能有几十万文件，不可能每次搜索都遍历一遍。
 * 做法：启动时在后台全量扫描所有已启用且已挂载的磁盘，结果常驻内存并落盘缓存；之后定时增量刷新。
 * 扫描过程中搜索仍可用（走实时遍历的兜底路径）。
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { classify } = require('./classifier');
const { getDisks, isDiskAvailable } = require('./pathGuard');

const CACHE_FILE = path.join(__dirname, '..', '..', 'data', 'index-cache.json');
const MAX_ENTRIES = 600000;      // 索引上限，防止内存被打爆
const SKIP_DIRS = new Set(['$RECYCLE.BIN', 'System Volume Information', '.Trash-1000', '.homecloud-disk.json']);

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

/** 当前可索引的磁盘（已启用 + 已挂载） */
function indexableDisks() {
  return getDisks().filter((d) => d.enabled && isDiskAvailable(d.id));
}

/** 把内部索引条目映射成前端需要的 item 形状（带 diskId 前缀路径） */
function toItem(e) {
  return {
    name: e.n,
    path: '/' + e.disk + (e.p ? '/' + e.p : '/'),
    isDir: e.isDir,
    size: e.isDir ? null : e.s,
    mtime: e.m,
    type: e.isDir ? 'folder' : e.t,
  };
}

/** 后台全量扫描（非阻塞，用迭代栈避免深层递归爆栈） */
async function buildIndex() {
  if (status.building) return;
  const disks = indexableDisks();
  if (!disks.length) {
    status.error = '没有已挂载的共享磁盘，暂无法建立索引';
    return;
  }
  status = { building: true, scanned: 0, startedAt: Date.now(), finishedAt: null, durationMs: 0, error: null };

  const result = [];
  const started = Date.now();

  try {
    for (const disk of disks) {
      const root = disk.rootReal;
      const stack = [''];
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
          if (dirent.name.startsWith('.')) continue;
          if (dirent.isDirectory() && SKIP_DIRS.has(dirent.name)) continue;

          const relPath = relDir ? relDir + '/' + dirent.name : dirent.name;
          const item = {
            disk: disk.id,
            p: relPath,                       // 相对该盘根目录的路径
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

          if (result.length % 500 === 0) {
            await new Promise((r) => setImmediate(r));
          }
          if (result.length >= MAX_ENTRIES) {
            stack.length = 0;
            break;
          }
        }
      }
      if (result.length >= MAX_ENTRIES) break;
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
 * 解析搜索作用域：返回 { disk, dir }
 * scope 形如 "<diskId>/目录"；空表示全盘
 */
function parseScope(scope) {
  if (!scope) return { disk: null, dir: '' };
  const clean = String(scope).replace(/^\/+|\/+$/g, '');
  if (!clean) return { disk: null, dir: '' };
  const segs = clean.split('/');
  // 形如 disk1/家庭影像：第一段是 diskId
  return { disk: segs[0], dir: segs.slice(1).join('/') };
}

/**
 * 搜索
 * 索引就绪走内存索引（毫秒级）；索引还在建时用实时遍历兜底，保证任何时刻都搜得动。
 */
function search(query, scope = '', category = 'all', limit = 500) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return { results: [], fromIndex: false, building: status.building };

  const sc = parseScope(scope);
  const out = [];
  for (const e of entries) {
    if (!e.n.toLowerCase().includes(q)) continue;
    if (sc.disk && e.disk !== sc.disk) continue;
    const dir = sc.disk ? sc.dir : e.d;       // 限定了具体盘时，目录相对该盘
    if (sc.disk && dir && !(e.d === dir || e.d.startsWith(dir + '/'))) continue;
    if (category && category !== 'all' && e.t !== category) continue;
    out.push(toItem(e));
    if (out.length >= limit) break;
  }
  return {
    results: out,
    fromIndex: !status.building,
    building: status.building,
    total: entries.length,
  };
}

/** 按分类列出文件 */
function listByCategory(category, scope = '', sort = 'name', order = 'asc', limit = 500) {
  const sc = parseScope(scope);
  const out = entries.filter((e) => {
    if (sc.disk && e.disk !== sc.disk) return false;
    const dir = sc.disk ? sc.dir : e.d;
    if (sc.disk && dir && !(e.d === dir || e.d.startsWith(dir + '/'))) return false;
    if (category === 'all') return true;
    return e.t === category;
  }).map(toItem);
  return { results: sortEntries(out, sort, order, true), building: status.building };
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
    const an = a.name || '';
    const bn = b.name || '';
    switch (sort) {
      case 'size':
        r = (a.size || 0) - (b.size || 0);
        break;
      case 'mtime':
        r = (a.mtime || 0) - (b.mtime || 0);
        break;
      case 'type':
        r = String(a.type).localeCompare(String(b.type));
        break;
      default:
        r = String(an).localeCompare(String(bn), 'zh-CN', { numeric: true, sensitivity: 'base' });
    }
    return r * dir;
  });
  return sorted;
}

/** 索引尚未就绪时，实时遍历某个目录做兜底搜索（覆盖所有可索引磁盘，或限定到 scope 所在盘） */
async function searchLive(query, scopeDir, category = 'all', limit = 500) {
  const q = String(query || '').trim().toLowerCase();
  const sc = parseScope(scopeDir);
  const disks = sc.disk ? getDisks().filter((d) => d.id === sc.disk && isDiskAvailable(d.id)) : indexableDisks();
  const out = [];
  for (const disk of disks) {
    const root = disk.rootReal;
    const startDir = path.join(root, sc.disk ? sc.dir : '');
    const stack = [sc.disk ? sc.dir : ''];
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
        if (dirent.isDirectory()) {
          stack.push(relDir ? relDir + '/' + dirent.name : dirent.name);
          continue;
        }
        const relPath = relDir ? relDir + '/' + dirent.name : dirent.name;
        if (!dirent.name.toLowerCase().includes(q)) continue;
        let st;
        try {
          st = await fsp.stat(path.join(root, relPath));
        } catch (e) {
          continue;
        }
        const t = classify(dirent.name);
        if (category && category !== 'all' && t !== category) continue;
        out.push(toItem({ disk: disk.id, p: relPath, n: dirent.name, d: relDir, isDir: false, s: st.size, m: st.mtimeMs, t }));
        if (out.length >= limit) return { results: out, fromIndex: false, truncated: true };
      }
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
