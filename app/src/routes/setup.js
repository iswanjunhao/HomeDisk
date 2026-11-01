/**
 * 首次初始化图形向导接口
 *
 * 安全约束：
 *  1. 仅在「尚未配置管理员密码」时可用（配置完成后整个路由 404）；
 *  2. 仅允许本机（127.0.0.1 / ::1）访问 —— 直接看 socket 对端地址，
 *     不受 X-Forwarded-For 伪造影响；
 *  3. 完成设置后：写配置 → 写共享目录标记 → 生成 start.sh →
 *     以用户选定端口后台重启正式服务，本向导进程退出。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { Router } = require('express');

const config = require('../lib/config');
const guard = require('../lib/pathGuard');
const { listDirs, defaultName } = require('../lib/dirbrowse');
const { resolvePortConflict } = require('../lib/portutils');

const router = Router();

/** 是否来自本机（不信任代理头，直接看 socket 对端） */
function isLocalhost(req) {
  const ra = (req.socket && req.socket.remoteAddress) || '';
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ra);
}

// 向导总闸：已完成初始化或非本机访问 → 一律拒绝
router.use((req, res, next) => {
  if (config.get().adminPasswordHash) {
    return res.status(404).json({ error: '已完成初始化，请刷新页面' });
  }
  if (!isLocalhost(req)) {
    return res.status(403).json({ error: '初始化只能在服务器本机操作，请在运行服务的电脑上打开向导' });
  }
  next();
});

/** 向导状态 */
router.get('/state', (req, res) => {
  res.json({ configured: false, home: os.homedir(), platform: process.platform });
});

/** 浏览服务器目录（只列子目录，供勾选共享；根目录会列出其他已挂载磁盘） */
router.get('/browse', async (req, res) => {
  try {
    res.json(await listDirs(req.query.path || ''));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

/**
 * 端口检查（含自动处理）：
 *  - 空闲 → { free: true }
 *  - 被本家庭云盘占用 → 自动结束旧服务后返回 { free: true, ours: true, killed: [...] }
 *  - 被其他程序占用 → { free: false, pids: [...] }，前端提示用户换端口
 */
router.get('/portcheck', async (req, res) => {
  const port = Number(req.query.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return res.status(400).json({ error: '端口无效（1-65535）' });
  }
  // 向导界面里的「实时检测」只报告占用情况、不杀进程；
  // 真正结束旧服务在 /setup/complete 里进行（autoKillOurs:true）。
  const autoKill = req.query.autoKill === '1';
  try {
    const r = await resolvePortConflict(port, { autoKillOurs: autoKill });
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** 完成设置：写全部配置并自动重启为正式服务 */
router.post('/complete', async (req, res) => {
  try {
    const body = req.body || {};
    const rawShares = Array.isArray(body.shares) ? body.shares : [];
    const port = Number(body.port);
    const password = String(body.password || '');
    const guestGB = Number(body.guestGB);
    const lanOnly = body.lanOnly !== false;

    /* ---------------- 校验 ---------------- */
    if (!rawShares.length) {
      return res.status(400).json({ error: '请至少选择一个要共享的目录' });
    }
    const seen = new Set();
    const shares = [];
    for (const s of rawShares) {
      const p = path.resolve(String(s.path || ''));
      let st;
      try { st = fs.statSync(p); } catch (e) {
        return res.status(400).json({ error: '目录不存在：' + p });
      }
      if (!st.isDirectory()) {
        return res.status(400).json({ error: '不是目录：' + p });
      }
      if (seen.has(p)) continue;   // 去重
      seen.add(p);
      shares.push({ path: p, name: String(s.name || '').trim() || defaultName(p) });
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return res.status(400).json({ error: '端口无效（1-65535）' });
    }
    if (!password) {
      return res.status(400).json({ error: '请设置管理员密码' });
    }

    /* ---------- 端口冲突：自家服务自动结束，其他程序占用则拒绝 ---------- */
    const conflict = await resolvePortConflict(port, { autoKillOurs: true });
    if (!conflict.free) {
      const others = conflict.pids.filter((p) => !p.ours);
      return res.status(409).json({
        error: '端口 ' + port + ' 正被其他程序占用，请更换端口号',
        pids: others.map((p) => ({ pid: p.pid, cmd: p.cmd })),
      });
    }

    /* ---------- 写配置（刻意不含 port：端口只存在于 start.sh） ---------- */
    const disks = shares.map((s) => ({
      id: 'disk_' + Math.random().toString(36).slice(2, 10),
      name: s.name,
      path: s.path,
      enabled: true,
    }));
    // 在每个共享目录根写入身份标记，换机 / 换挂载点后可自动重新关联
    for (const d of disks) guard.writeMarker(d.path, d.id, d.name);

    const cfgJson = {
      adminPasswordHash: config.hashPassword(password),
      guestUploadMaxBytes: Math.round((Number.isFinite(guestGB) && guestGB > 0 ? guestGB : 1) * 1024 * 1024 * 1024),
      sessionHours: 8,
      indexIntervalMinutes: 30,
      trashDir: '',
      lanOnly,
      disks,
    };
    fs.mkdirSync(config.DATA_DIR, { recursive: true });
    fs.writeFileSync(config.CONFIG_FILE, JSON.stringify(cfgJson, null, 2), 'utf8');

    /* ---------- 生成启动器（端口在这里，改端口只改这一行） ---------- */
    const projectRoot = path.join(__dirname, '..', '..', '..');
    if (process.platform === 'win32') {
      // Windows：生成 start.bat（双击即可启动）
      const startBat = [
        '@echo off',
        'chcp 65001 >nul',
        'REM HomeCloud 启动器（由初始化向导生成）',
        'REM 端口等运行参数集中在这里管理，修改端口只需改下一行数字，保存后重新运行。',
        'set HOMECLOUD_PORT=' + port,
        '',
        'cd /d "%~dp0app"',
        'node server.js %*',
        'pause',
        '',
      ].join('\r\n');
      fs.writeFileSync(path.join(projectRoot, 'start.bat'), startBat, 'utf8');
    } else {
      const startSh = [
        '#!/usr/bin/env bash',
        '# HomeCloud 启动器（由初始化向导生成）',
        '# ─────────────────────────────────────────────────────────────',
        '# 端口等运行参数集中在这里管理，方便手动修改，且不写进 config.json。',
        '# 修改端口：直接改下面这一行的数字，然后重启即可。',
        '# ─────────────────────────────────────────────────────────────',
        'export HOMECLOUD_PORT=' + port,
        '',
        '# 如需临时覆盖共享目录（一般不需要，目录已在 config.json 中配置），取消下一行注释：',
        '# export HOMECLOUD_ROOT=""',
        '',
        'SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"',
        'cd "$SCRIPT_DIR/app" || exit 1',
        'exec node server.js "$@"',
        '',
      ].join('\n');
      const startShPath = path.join(projectRoot, 'start.sh');
      fs.writeFileSync(startShPath, startSh, 'utf8');
      try { fs.chmodSync(startShPath, 0o755); } catch (e) { /* 忽略 */ }
    }

    /* ---------- 以正式端口后台重启服务（子进程接管，向导进程退出） ---------- */
    const { spawn } = require('child_process');
    const child = spawn(
      process.execPath,
      [path.join(__dirname, '..', '..', 'server.js')],
      {
        detached: true,
        stdio: 'ignore',
        env: Object.assign({}, process.env, {
          HOMECLOUD_PORT: String(port),
          HOMECLOUD_SKIP_PORTKILL: '1',   // 重启竞态：只等待重试，不杀进程
        }),
      }
    );
    child.unref();

    const urls = ['http://127.0.0.1:' + port];
    for (const list of Object.values(os.networkInterfaces())) {
      for (const ni of list || []) {
        if (ni.family === 'IPv4' && !ni.internal) urls.push('http://' + ni.address + ':' + port);
      }
    }
    res.json({ ok: true, port, urls });

    // 给响应留出发送时间，然后退出让子进程接管端口
    setTimeout(() => process.exit(0), 800);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
