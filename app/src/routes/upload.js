/**
 * 分片上传
 *
 * 为什么不用一次性 multipart：
 * 1. 大文件（几 GB）一次性 POST 失败就得从头再来，体验很差
 * 2. 需要进度条和断点续传
 * 3. 可以在「上传开始前」就根据文件大小判断是否需要管理员密码
 *
 * 流程：init（校验权限 + 预留文件名）→ chunk（逐片追加到 .hcpart）→ done（校验大小 + 改名落定）
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { Router } = require('express');

const { AppError, resolveSafe, toRel, safeName, uniqueName } = require('../lib/pathGuard');
const { classify } = require('../lib/classifier');
const config = require('../lib/config');
const auth = require('../lib/auth');
const indexer = require('../lib/indexer');

const router = Router();
const CHUNK_LIMIT = 20 * 1024 * 1024;   // 单分片上限 20MB
const PART_TTL = 24 * 60 * 60 * 1000;   // 未完成的 .hcpart 保留 24 小时后清理

/** uploadId -> { partPath, finalPath, dir, name, size, received, admin, updatedAt } */
const uploads = new Map();

/* ------------------------------ 第一步：初始化 ------------------------------ */

router.post('/init', async (req, res, next) => {
  try {
    const { name, size } = req.body || {};
    const dirRel = req.body.path || '';
    const dirAbs = resolveSafe(dirRel);

    const st = await fsp.stat(dirAbs);
    if (!st.isDirectory()) throw new AppError(400, '目标不是文件夹');

    const cleanName = safeName(name);
    const fileSize = Number(size);
    if (!Number.isFinite(fileSize) || fileSize < 0) {
      throw new AppError(400, '文件大小参数无效');
    }

    // 权限闸门：超过访客上限的大文件必须管理员才能传
    const limit = Number(config.get().guestUploadMaxBytes) || 0;
    if (fileSize > limit && !auth.isAdmin(req)) {
      return res.status(401).json({
        error: `单个文件超过 ${require('../lib/format').formatSize(limit)}，需要管理员密码`,
        needAuth: true,
        needAuthFor: 'upload',
      });
    }

    // 提前定好最终文件名（含同名自动重命名），避免并发上传互相覆盖
    const finalName = uniqueName(dirAbs, cleanName);
    const finalPath = path.join(dirAbs, finalName);
    const partPath = finalPath + '.hcpart';

    const uploadId = crypto.randomUUID();
    uploads.set(uploadId, {
      partPath,
      finalPath,
      dirAbs,
      name: finalName,
      size: fileSize,
      received: 0,
      admin: auth.isAdmin(req),
      updatedAt: Date.now(),
    });

    res.json({ uploadId, finalName, partPath: toRel(partPath) });
  } catch (e) {
    next(e);
  }
});

/* ------------------------------ 第二步：写分片 ------------------------------ */

router.post(
  '/chunk',
  // type: () => true —— 无条件按原始字节解析。
  // 浏览器上传 Blob 时可能不带 Content-Type（此时 '*/*' 反而匹配不上，会拿到空对象导致崩溃）
  require('express').raw({ type: () => true, limit: CHUNK_LIMIT }),
  async (req, res, next) => {
    try {
      const uploadId = req.query.uploadId;
      const rec = uploads.get(uploadId);
      if (!rec) throw new AppError(400, '上传会话已失效，请重新上传');

      // 中途管理员登录过期且文件超限 → 立即中止，防止绕过大小闸门
      const limit = Number(config.get().guestUploadMaxBytes) || 0;
      if (rec.size > limit && !auth.isAdmin(req)) {
        uploads.delete(uploadId);
        try { await fsp.unlink(rec.partPath); } catch (e) { /* 可能还没创建 */ }
        return res.status(401).json({ error: '需要管理员密码才能上传此文件', needAuth: true });
      }

      // 兜底转换：正常是 Buffer；极端情况下可能是字符串或 JSON 化后的 Buffer
      let buf;
      if (Buffer.isBuffer(req.body)) buf = req.body;
      else if (typeof req.body === 'string') buf = Buffer.from(req.body, 'utf8');
      else if (req.body && req.body.type === 'Buffer' && Array.isArray(req.body.data)) buf = Buffer.from(req.body.data);
      else throw new AppError(400, '分片内容格式异常，请重试');
      if (buf.length === 0) throw new AppError(400, '分片内容为空');

      // 追加写入，fd 用完即关，避免长期占用大量文件句柄
      const fh = await fsp.open(rec.partPath, 'a');
      try {
        await fh.write(buf);
      } finally {
        await fh.close();
      }
      rec.received += buf.length;
      rec.updatedAt = Date.now();

      res.json({ received: rec.received, size: rec.size });
    } catch (e) {
      next(e);
    }
  }
);

/* ------------------------------ 第三步：完成 ------------------------------ */

router.post('/done', async (req, res, next) => {
  try {
    const uploadId = req.body.uploadId;
    const rec = uploads.get(uploadId);
    if (!rec) throw new AppError(400, '上传会话已失效');

    let partStat;
    try {
      partStat = await fsp.stat(rec.partPath);
    } catch (e) {
      throw new AppError(400, '上传数据已丢失，请重新上传');
    }

    // 大小不符说明网络传输有问题，宁可丢弃也不产出坏文件
    if (rec.size > 0 && partStat.size !== rec.size) {
      try { await fsp.unlink(rec.partPath); } catch (e) { /* 忽略 */ }
      uploads.delete(uploadId);
      throw new AppError(400, `文件大小不一致（期望 ${rec.size}，实际 ${partStat.size}），已取消`);
    }

    await fsp.rename(rec.partPath, rec.finalPath);
    uploads.delete(uploadId);
    indexer.invalidate();

    const st = await fsp.stat(rec.finalPath);
    res.json({
      ok: true,
      item: {
        name: rec.name,
        path: toRel(rec.finalPath),
        isDir: false,
        size: st.size,
        mtime: st.mtimeMs,
        type: classify(rec.name),
      },
    });
  } catch (e) {
    next(e);
  }
});

/* ------------------------------ 取消与清理 ------------------------------ */

router.post('/cancel', async (req, res) => {
  const rec = uploads.get(req.body.uploadId);
  if (rec) {
    try { await fsp.unlink(rec.partPath); } catch (e) { /* 忽略 */ }
    uploads.delete(req.body.uploadId);
  }
  res.json({ ok: true });
});

/** 定期清理超时未完成的上传与残留 .hcpart 文件 */
setInterval(async () => {
  const now = Date.now();
  for (const [id, rec] of uploads) {
    if (now - rec.updatedAt > PART_TTL) {
      try { await fsp.unlink(rec.partPath); } catch (e) { /* 忽略 */ }
      uploads.delete(id);
    }
  }
}, 30 * 60 * 1000).unref();

module.exports = router;
