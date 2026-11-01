/**
 * 搜索与分类筛选
 * 索引就绪走内存索引（毫秒级）；索引还在建时用实时遍历兜底，保证任何时刻都搜得动。
 */

const { Router } = require('express');
const path = require('path');

const { resolveSafe, toRel } = require('../lib/pathGuard');
const { listCategories } = require('../lib/classifier');
const indexer = require('../lib/indexer');

const router = Router();

router.get('/categories', (req, res) => {
  res.json({ categories: listCategories() });
});

/**
 * 搜索
 * query: q 关键词, path 限定目录（空=全盘）, category 分类, limit 上限
 */
router.get('/search', async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q) return res.json({ results: [], query: '' });

    // 确定搜索范围：限定目录时校验路径合法性，并转成相对路径
    let scope = '';
    if (req.query.path) {
      const abs = resolveSafe(req.query.path);
      const st = await require('fs').promises.stat(abs);
      if (!st.isDirectory()) return res.json({ results: [], query: q });
      scope = toRel(abs).replace(/^\//, '');
    }
    const category = req.query.category || 'all';
    const limit = Math.min(Number(req.query.limit) || 500, 2000);

    const status = indexer.getStatus();
    let out;
    if (status.total > 0) {
      out = indexer.search(q, scope, category, limit);
    } else {
      // 索引还没建好，实时遍历（结果可能截断，前端会提示）
      out = await indexer.searchLive(q, scope, category, limit);
    }

    res.json({
      query: q,
      scope: scope || '/',
      results: out.results,
      building: out.building || false,
      truncated: out.truncated || false,
      fromIndex: !!out.fromIndex,
    });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
