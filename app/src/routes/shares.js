/**
 * 共享目录管理接口（管理员）
 * GET  /api/shares            —— 列出所有已配置共享目录 + 容量 + 状态（任何人可看，方便前端展示）
 * GET  /api/shares/candidates —— 列出可快速添加的候选卷/挂载点（管理员）
 * GET  /api/browse            —— 浏览服务器目录树，供图形界面选择要共享的文件夹（管理员）
 * POST /api/shares           —— add / toggle / rename / remove / rescan（管理员）
 *
 * 说明：配置内部字段名沿用 disks / diskId（历史兼容，避免破坏已有配置与磁盘标记），
 *       用户可见的概念统一叫「共享目录」。
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { Router } = require('express');

const config = require('../lib/config');
const guard = require('../lib/pathGuard');
const auth = require('../lib/auth');
const { formatSize } = require('../lib/format');
const { listDirs } = require('../lib/dirbrowse');
const { detectVolumes, enumerateMounts } = require('../lib/volumes');

const router = Router();

/** 列出已配置共享目录（含容量与可用性） */
router.get('/shares', async (req, res) => {
  try {
    const out = [];
    for (const d of guard.getDisks()) {
      let usage = { available: false, totalText: '-', usedText: '-', freeText: '-', usedPercent: 0 };
      try {
        if (guard.isDiskAvailable(d.id)) {
          const st = await fsp.statfs(d.rootReal);
          const total = st.blocks * st.bsize;
          const free = st.bfree * st.bsize;
          usage = {
            available: true,
            totalText: formatSize(total),
            usedText: formatSize(total - free),
            freeText: formatSize(free),
            usedPercent: total ? Math.round(((total - free) / total) * 100) : 0,
          };
        }
      } catch (e) { /* 不可读 */ }
      out.push({
        id: d.id, name: d.name, path: d.path, enabled: d.enabled !== false,
        available: usage.available,
        totalText: usage.totalText, usedText: usage.usedText,
        freeText: usage.freeText, usedPercent: usage.usedPercent,
      });
    }
    res.json({ shares: out });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** 浏览服务器目录（图形界面选择要共享的文件夹） */
router.get('/browse', auth.requireAdmin, async (req, res) => {
  try {
    res.json(await listDirs(req.query.path || ''));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

/** 列出候选卷 / 挂载点（供快速添加）—— 不依赖 lsblk，直接从 /proc/mounts 枚举 */
router.get('/shares/candidates', async (req, res) => {
  try {
    const configured = new Set(guard.getDisks().map((d) => d.path));
    const candidates = await detectVolumes({
      configured,
      hasMarker: (p) => !!guard.readMarker(p),
    });
    res.json({ candidates });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** 重扫描：按 .homecloud-disk.json 标记把已配置共享目录重新关联到当前挂载点 */
function rescan() {
  const disks = guard.getDisks();
  // 扫描所有真实挂载点 + 常见挂载目录兜底
  const roots = [];
  return enumerateMounts().then((mounts) => {
    for (const m of mounts) {
      if (m.mountpoint && !m.mountpoint.startsWith('/proc') && !m.mountpoint.startsWith('/sys')) {
        roots.push(m.mountpoint);
      }
    }
    for (const base of ['/mnt', '/media', '/run/media']) {
      try {
        for (const e of fs.readdirSync(base)) roots.push(path.join(base, e));
      } catch (e) { /* 忽略 */ }
    }

    const markers = guard.scanMarkers(roots);
    let changed = 0;
    for (const d of disks) {
      if (guard.isDiskAvailable(d.id)) continue;            // 当前已可用，不动
      const m = markers.find((x) => x.id === d.id);
      if (m && m.path !== d.path) { d.path = m.path; changed++; }
    }
    return { changed, markers };
  });
}

router.post('/shares', auth.requireAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    const action = body.action;
    const disks = config.getDisks();
    let result = {};

    if (action === 'add') {
      const p = String(body.path || '').trim();
      if (!p) return res.status(400).json({ error: '请指定要共享的目录路径' });
      const name = String(body.name || '').trim() || ('共享目录 ' + (disks.length + 1));
      const id = 'disk_' + Math.random().toString(36).slice(2, 10);
      disks.push({ id, name, path: p, enabled: true });
      config.saveDisks(disks);
      guard.writeMarker(p, id, name);
      guard.setRoots(config.getDisks());
      result = { ok: true, id, name, path: p };
    } else if (action === 'toggle') {
      const d = disks.find((x) => x.id === body.id);
      if (!d) return res.status(404).json({ error: '共享目录不存在' });
      d.enabled = !d.enabled;
      config.saveDisks(disks);
      guard.setRoots(config.getDisks());
      result = { ok: true, id: d.id, enabled: d.enabled };
    } else if (action === 'rename') {
      const d = disks.find((x) => x.id === body.id);
      if (!d) return res.status(404).json({ error: '共享目录不存在' });
      d.name = String(body.name || '').trim() || d.name;
      config.saveDisks(disks);
      guard.writeMarker(d.path, d.id, d.name);
      guard.setRoots(config.getDisks());
      result = { ok: true, id: d.id, name: d.name };
    } else if (action === 'remove') {
      const idx = disks.findIndex((x) => x.id === body.id);
      if (idx < 0) return res.status(404).json({ error: '共享目录不存在' });
      disks.splice(idx, 1);
      config.saveDisks(disks);
      guard.setRoots(config.getDisks());
      result = { ok: true, removed: body.id };
    } else if (action === 'rescan') {
      const r = await rescan();
      config.saveDisks(disks);
      guard.setRoots(config.getDisks());
      result = { ok: true, changed: r.changed };
    } else {
      return res.status(400).json({ error: '未知操作' });
    }

    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
