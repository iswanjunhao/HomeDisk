/**
 * 文件夹与文件管理：新建 / 重命名 / 移动 / 删除
 *
 * 权限约定：
 *  - 新建文件夹：访客可用（用户明确要求"方便新建文件夹"）
 *  - 重命名 / 移动 / 删除：仅管理员
 * 用户还要求这几项操作要"顺手"，所以批量、移动到任意目录、剪贴板都由前端配合实现。
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { Router } = require('express');

const { AppError, resolveSafe, toRel, safeName, uniqueName, getRoot } = require('../lib/pathGuard');
const { classify } = require('../lib/classifier');
const auth = require('../lib/auth');
const config = require('../lib/config');
const indexer = require('../lib/indexer');

const router = Router();

/* -------------------------------- 新建文件夹 -------------------------------- */

router.post('/mkdir', async (req, res, next) => {
  try {
    const dirRel = req.body.path || '';
    const name = safeName(req.body.name);
    const dirAbs = resolveSafe(dirRel);
    const target = path.join(dirAbs, name);

    if (fs.existsSync(target)) throw new AppError(400, `「${name}」已存在`);

    await fsp.mkdir(target, { recursive: false });
    indexer.invalidate();

    const st = await fsp.stat(target);
    res.json({
      ok: true,
      item: { name, path: toRel(target), isDir: true, size: null, mtime: st.mtimeMs, type: 'folder' },
    });
  } catch (e) {
    next(e);
  }
});

/* --------------------------------- 重命名 --------------------------------- */

router.post('/rename', auth.requireAdmin, async (req, res, next) => {
  try {
    const abs = resolveSafe(req.body.path, { allowRoot: false });
    const newName = safeName(req.body.newName);
    const parent = path.dirname(abs);
    const target = path.join(parent, newName);

    if (abs === getRoot()) throw new AppError(400, '不能重命名共享盘根目录');
    if (fs.existsSync(target)) throw new AppError(400, `「${newName}」已存在，换一个名字`);

    await fsp.rename(abs, target);
    indexer.invalidate();

    const st = await fsp.stat(target);
    res.json({
      ok: true,
      item: {
        name: newName,
        path: toRel(target),
        isDir: st.isDirectory(),
        size: st.isDirectory() ? null : st.size,
        mtime: st.mtimeMs,
        type: st.isDirectory() ? 'folder' : classify(newName),
      },
    });
  } catch (e) {
    next(e);
  }
});

/* ---------------------------------- 移动 ---------------------------------- */

router.post('/move', auth.requireAdmin, async (req, res, next) => {
  try {
    const paths = Array.isArray(req.body.paths) ? req.body.paths : [];
    if (paths.length === 0) throw new AppError(400, '请先选择要移动的文件');
    if (paths.length > 300) throw new AppError(400, '一次最多移动 300 个条目');

    const destAbs = resolveSafe(req.body.dest === undefined ? '' : req.body.dest, { mustExist: true });
    const destStat = await fsp.stat(destAbs);
    if (!destStat.isDirectory()) throw new AppError(400, '目标位置必须是文件夹');

    const moved = [];
    const errors = [];

    for (const p of paths) {
      const srcAbs = resolveSafe(p, { allowRoot: false });
      if (srcAbs === getRoot()) {
        errors.push({ path: p, error: '不能移动共享盘根目录' });
        continue;
      }
      // 关键防护：不能把文件夹移动到它自己里面（会造成无限递归 / 数据错乱）
      const srcStat = await fsp.stat(srcAbs);
      if (srcStat.isDirectory()) {
        const inside = destAbs === srcAbs || destAbs.startsWith(srcAbs + path.sep);
        if (inside) {
          errors.push({ path: p, error: '不能把文件夹移动到它自己里面' });
          continue;
        }
      }
      const base = path.basename(srcAbs);
      let target = path.join(destAbs, base);
      if (fs.existsSync(target)) {
        // 目标已有同名条目时自动改名，不覆盖已有数据
        target = path.join(destAbs, uniqueName(destAbs, base));
      }
      try {
        await fsp.rename(srcAbs, target);
        moved.push({ from: toRel(srcAbs), to: toRel(target) });
      } catch (e) {
        errors.push({ path: p, error: e.message });
      }
    }

    indexer.invalidate();
    res.json({ ok: true, moved, errors });
  } catch (e) {
    next(e);
  }
});

/* ---------------------------------- 删除 ---------------------------------- */

router.post('/delete', auth.requireAdmin, async (req, res, next) => {
  try {
    const paths = Array.isArray(req.body.paths) ? req.body.paths : [];
    if (paths.length === 0) throw new AppError(400, '请先选择要删除的文件');
    if (paths.length > 300) throw new AppError(400, '一次最多删除 300 个条目');

    const cfg = config.get();
    const deleted = [];
    const errors = [];

    for (const p of paths) {
      const abs = resolveSafe(p, { allowRoot: false });
      // 红线：绝不允许删掉共享盘根目录本身
      if (abs === getRoot()) {
        errors.push({ path: p, error: '不能删除共享盘根目录' });
        continue;
      }
      try {
        if (cfg.trashDir) {
          // 回收站模式：移动到一个独立目录，误删可救
          await moveToTrash(abs, cfg.trashDir);
        } else {
          await fsp.rm(abs, { recursive: true, force: true });
        }
        deleted.push(toRel(abs));
      } catch (e) {
        errors.push({ path: p, error: e.message });
      }
    }

    indexer.invalidate();
    res.json({ ok: true, deleted, errors, mode: cfg.trashDir ? 'trash' : 'permanent' });
  } catch (e) {
    next(e);
  }
});

/** 把条目移进回收站目录（不存在则创建） */
async function moveToTrash(abs, trashDir) {
  await fsp.mkdir(trashDir, { recursive: true });
  const base = path.basename(abs);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  let target = path.join(trashDir, `${stamp}__${base}`);
  if (fs.existsSync(target)) {
    target = path.join(trashDir, uniqueName(trashDir, `${stamp}__${base}`));
  }
  await fsp.rename(abs, target);
}

/** 列出目录树（供「移动到…」弹窗用），只取两级，避免深目录卡死 */
router.get('/tree', async (req, res, next) => {
  try {
    const rel = req.query.path || '';
    const abs = resolveSafe(rel);
    const dirents = await fsp.readdir(abs, { withFileTypes: true });
    const dirs = dirents.filter((d) => d.isDirectory() && !d.name.startsWith('.'));
    dirs.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }));
    res.json({
      path: toRel(abs),
      dirs: dirs.map((d) => ({ name: d.name, path: toRel(path.join(abs, d.name)) })),
    });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
