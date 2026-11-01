/**
 * 文件浏览 / 下载 / 缩略图 / 磁盘容量
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const mime = require('mime-types');
const { Router } = require('express');
const archiver = require('archiver');

const guard = require('../lib/pathGuard');
const { AppError, resolveSafe, toRel } = guard;
const { classify } = require('../lib/classifier');
const { formatSize } = require('../lib/format');
const config = require('../lib/config');
const auth = require('../lib/auth');
const indexer = require('../lib/indexer');

const router = Router();

/** 读取单个条目的元信息 */
async function statItem(absPath, relPath) {
  const st = await fsp.stat(absPath);
  const name = path.basename(absPath);
  return {
    name,
    path: relPath,
    isDir: st.isDirectory(),
    size: st.isDirectory() ? null : st.size,
    mtime: st.mtimeMs,
    type: st.isDirectory() ? 'folder' : classify(name),
  };
}

/* ---------------------------------- 目录列表 ---------------------------------- */

router.get('/list', async (req, res, next) => {
  try {
    const rel = req.query.path || '';
    const abs = resolveSafe(rel);
    const sort = req.query.sort || 'name';
    const order = req.query.order === 'desc' ? 'desc' : 'asc';

    const dirents = await fsp.readdir(abs, { withFileTypes: true });
    // 隐藏文件不显示，避免把 .DS_Store、System Volume Information 之类暴露出去
    const visible = dirents.filter((d) => !d.name.startsWith('.'));

    // 并发取 stat，但限制并发数，避免大目录一次性打开几万个 fd
    const items = [];
    const CONCURRENCY = 50;
    for (let i = 0; i < visible.length; i += CONCURRENCY) {
      const batch = visible.slice(i, i + CONCURRENCY);
      const settled = await Promise.all(
        batch.map(async (d) => {
          const childAbs = path.join(abs, d.name);
          const childRel = toRel(childAbs);
          try {
            return await statItem(childAbs, childRel);
          } catch (e) {
            return null; // 权限不足或文件已消失，跳过
          }
        })
      );
      for (const it of settled) if (it) items.push(it);
    }

    const sorted = indexer.sortEntries(
      items.map((it) => ({ n: it.name, s: it.size || 0, m: it.mtime, t: it.type, isDir: it.isDir, _raw: it })),
      sort,
      order
    );

    res.json({
      path: toRel(abs),
      parent: path.posix.dirname(toRel(abs)) === '/' ? null : path.posix.dirname(toRel(abs)),
      items: sorted.map((x) => x._raw),
      total: sorted.length,
    });
  } catch (e) {
    next(e);
  }
});

/* --------------------------------- 磁盘容量 --------------------------------- */

let usageCache = { data: null, at: 0 };

router.get('/usage', async (req, res) => {
  try {
    // 容量查询属于低频操作，缓存 10 秒，避免频繁 statvfs
    if (usageCache.data && Date.now() - usageCache.at < 10000) {
      return res.json(usageCache.data);
    }
    const root = guard.getRoot();
    const st = await fsp.statfs(root);
    const total = st.blocks * st.bsize;
    const free = st.bfree * st.bsize;
    const used = total - free;
    const data = {
      total,
      used,
      free,
      usedPercent: total ? Math.round((used / total) * 100) : 0,
      totalText: formatSize(total),
      usedText: formatSize(used),
      freeText: formatSize(free),
    };
    usageCache = { data, at: Date.now() };
    res.json(data);
  } catch (e) {
    res.json({ total: 0, used: 0, free: 0, usedPercent: 0, error: '无法读取磁盘容量' });
  }
});

/* ---------------------------------- 单文件下载 ---------------------------------- */

router.get('/download', async (req, res, next) => {
  try {
    const abs = resolveSafe(req.query.path || '');
    const st = await fsp.stat(abs);
    if (st.isDirectory()) {
      throw new AppError(400, '这是文件夹，请使用打包下载');
    }
    const name = path.basename(abs);
    const type = mime.lookup(name) || 'application/octet-stream';

    // 断点续传：解析 Range 头，返回 206 + 对应片段（视频拖动、大文件续传都靠这个）
    const range = req.headers.range;
    let head = {
      'Content-Type': type,
      'Content-Disposition': disposition(name),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, max-age=0',
    };

    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
      if (m) {
        let start = m[1] ? parseInt(m[1], 10) : 0;
        let end = m[2] ? parseInt(m[2], 10) : st.size - 1;
        if (Number.isNaN(start) || start < 0) start = 0;
        if (Number.isNaN(end) || end >= st.size) end = st.size - 1;
        if (start > end) {
          res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
          return res.end();
        }
        head['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
        head['Content-Length'] = end - start + 1;
        res.writeHead(206, head);
        fs.createReadStream(abs, { start, end }).pipe(res);
        return;
      }
    }

    head['Content-Length'] = st.size;
    res.writeHead(200, head);
    fs.createReadStream(abs).pipe(res);
  } catch (e) {
    next(e);
  }
});

/**
 * 构造 Content-Disposition
 * 同时给 ASCII 兜底名和 RFC 5987 的 UTF-8 名，保证中文文件名在 Windows / macOS 上都不乱码
 */
function disposition(name) {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/* ---------------------------- 多选打包成 ZIP 下载 ---------------------------- */

router.post('/download-zip', async (req, res, next) => {
  try {
    const paths = Array.isArray(req.body.paths) ? req.body.paths : [];
    if (paths.length === 0) throw new AppError(400, '请先选择要下载的文件');
    if (paths.length > 500) throw new AppError(400, '一次最多打包 500 个条目');

    // 全部路径先过安全校验，任何一个非法就整体拒绝
    const absList = paths.map((p) => resolveSafe(p));

    // 打包名：单文件用文件名，多个用所在目录名
    let zipName = '下载';
    if (absList.length === 1) {
      zipName = path.basename(absList[0]);
    } else {
      zipName = path.basename(path.dirname(absList[0])) || '下载';
    }

    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': disposition(zipName + '.zip'),
      'Cache-Control': 'no-store',
    });

    // 流式打包，不落盘临时文件：1T 盘场景下这点很重要
    const archive = archiver('zip', { zlib: { level: 1 } });
    archive.on('error', (err) => {
      console.error('[打包] 失败：' + err.message);
      try { res.end(); } catch (e) { /* 连接已断开 */ }
    });
    archive.pipe(res);

    for (const abs of absList) {
      const st = await fsp.stat(abs);
      if (st.isDirectory()) {
        archive.directory(abs, path.basename(abs));
      } else {
        archive.file(abs, { name: path.basename(abs) });
      }
    }
    await archive.finalize();
  } catch (e) {
    next(e);
  }
});

/* --------------------------------- 图片缩略图 --------------------------------- */

let sharp = null;
try {
  sharp = require('sharp');
} catch (e) {
  console.warn('[缩略图] 未安装 sharp，网格视图将只显示类型图标');
}

const THUMB_CACHE = path.join(__dirname, '..', '..', 'data', 'thumbs');

router.get('/thumb', async (req, res, next) => {
  try {
    const abs = resolveSafe(req.query.path || '');
    if (!sharp) return res.status(404).end();

    const st = await fsp.stat(abs);
    if (st.isDirectory()) return res.status(404).end();
    if (classify(path.basename(abs)) !== 'image') return res.status(404).end();

    // 缓存键带上 mtime，文件更新后缩略图会自动重建
    const key = require('crypto')
      .createHash('md5')
      .update(abs + '|' + st.mtimeMs)
      .digest('hex');
    const cacheFile = path.join(THUMB_CACHE, key.slice(0, 2), key + '.webp');

    try {
      await fsp.mkdir(path.dirname(cacheFile), { recursive: true });
    } catch (e) { /* 只读环境忽略 */ }

    try {
      const cached = await fsp.readFile(cacheFile);
      res.writeHead(200, { 'Content-Type': 'image/webp', 'Cache-Control': 'private, max-age=86400' });
      return res.end(cached);
    } catch (e) { /* 没缓存，生成 */ }

    const buf = await sharp(abs, { failOn: 'none' })
      .rotate()
      .resize(320, 320, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 72 })
      .toBuffer();

    try {
      await fsp.writeFile(cacheFile, buf);
    } catch (e) { /* 缓存写失败不影响显示 */ }

    res.writeHead(200, { 'Content-Type': 'image/webp', 'Cache-Control': 'private, max-age=86400' });
    res.end(buf);
  } catch (e) {
    // 缩略图失败不能影响主流程，返回 404 让前端退回图标
    res.status(404).end();
  }
});

/* ---------------------------------- 全局状态 ---------------------------------- */

router.get('/status', (req, res) => {
  const cfg = config.get();
  res.json({
    admin: auth.isAdmin(req),
    rootAvailable: guard.isRootAvailable(),
    guestUploadMaxBytes: Number(cfg.guestUploadMaxBytes),
    guestUploadMaxText: formatSize(cfg.guestUploadMaxBytes),
    index: indexer.getStatus(),
    version: '1.0.0',
  });
});

module.exports = router;
