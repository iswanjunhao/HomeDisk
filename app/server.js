#!/usr/bin/env node
/**
 * HomeCloud 家庭局域网私有网盘 —— 服务入口
 *
 * 启动：node server.js
 * 首次使用：bash setup.sh（自动打开图形初始化向导，按提示点选即可）
 * 设置管理员密码：node server.js --set-password 你的密码
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const express = require('express');
const cookieParser = require('cookie-parser');

const config = require('./src/lib/config');
const guard = require('./src/lib/pathGuard');
const auth = require('./src/lib/auth');
const indexer = require('./src/lib/indexer');
const { isPortFree, resolvePortConflict } = require('./src/lib/portutils');

/* ---------------------------- 命令行：设置密码 ---------------------------- */

if (process.argv.includes('--set-password')) {
  const idx = process.argv.indexOf('--set-password');
  const pwd = process.argv[idx + 1];
  if (!pwd) {
    console.error('用法：node server.js --set-password <你的密码>');
    process.exit(1);
  }
  config.load();
  config.save({ adminPasswordHash: config.hashPassword(pwd) });
  console.log('管理员密码已更新。');
  process.exit(0);
}

/* ------------------------------- 初始化配置 ------------------------------- */

const cfg = config.load();

// 未配置管理员密码 → 首次使用，进入图形初始化向导
const SETUP_MODE = !cfg.adminPasswordHash;

if (SETUP_MODE) {
  // 向导期间不开放任何共享目录，设置完成后才生效
  guard.setRoots([]);
} else {
  guard.setRoots(cfg.disks);

  // 启动时按 .homecloud-disk.json 标记重认共享目录：换机 / 换盘后挂载点变了，自动重新关联
  try {
    const roots = [];
    for (const base of ['/mnt', '/media', '/run/media']) {
      try { for (const e of fs.readdirSync(base)) roots.push(path.join(base, e)); } catch (e) { /* 忽略 */ }
    }
    const markers = guard.scanMarkers(roots);
    let changed = false;
    for (const d of config.getDisks()) {
      if (guard.isDiskAvailable(d.id)) continue;            // 当前已可用，不动
      const m = markers.find((x) => x.id === d.id);
      if (m && m.path !== d.path) { d.path = m.path; changed = true; }
    }
    if (changed) { config.saveDisks(config.getDisks()); }
    guard.setRoots(config.getDisks());
  } catch (e) { /* 重认失败不影响启动 */ }
}

/* --------------------------------- 应用 --------------------------------- */

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);

app.use(cookieParser());
app.use(express.json({ limit: '2mb' }));

function isLocalhost(req) {
  const ra = (req.socket && req.socket.remoteAddress) || '';
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ra);
}

// 访问控制：
//  - 向导模式：初始化只允许在本机操作，局域网其他设备一律拒绝
//  - 正常模式：仅允许局域网网段访问，这是家庭网盘最基本的安全边界
app.use((req, res, next) => {
  if (SETUP_MODE) {
    if (!isLocalhost(req)) {
      return res.status(403).send('初始化只能在服务器本机操作，请在运行服务的电脑上打开向导');
    }
    return next();
  }
  const ip = req.ip || '';
  if (cfg.lanOnly && !auth.isPrivateIp(ip)) {
    return res.status(403).json({ error: '仅允许局域网访问' });
  }
  next();
});

// 静态资源：不做强缓存（每次校验 ETag），避免前端更新后浏览器还拿着旧文件
app.use(express.static(path.join(__dirname, 'public'), { maxAge: 0, etag: true }));

// 首次初始化向导页面与接口
app.get('/setup', (req, res) => {
  if (!SETUP_MODE) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'setup.html'));
});
if (SETUP_MODE) {
  app.get('/', (req, res) => res.redirect('/setup'));
}
// 向导接口挂在 /api/setup 下，避免其总闸（已初始化即 404）误伤 /api 下的正常业务接口。
app.use('/api/setup', require('./src/routes/setup'));

// API 路由
app.use('/api', require('./src/routes/files'));
app.use('/api', require('./src/routes/search'));
app.use('/api', require('./src/routes/shares'));
app.use('/api/upload', require('./src/routes/upload'));
app.use('/api', require('./src/routes/manage'));
app.use('/api', require('./src/routes/auth'));

/* ------------------------------- 错误处理 ------------------------------- */

// 兜底：未匹配到路由时返回中文 404
app.use('/api', (req, res) => {
  res.status(404).json({ error: '接口不存在' });
});

// 统一错误处理：把内部异常转成中文提示，不把堆栈暴露给浏览器
app.use((err, req, res, next) => {
  const status = err.status || 500;
  const message = status === 500 ? '服务器内部错误' : err.message;
  if (status === 500) {
    console.error('[错误]', err);
  }
  if (res.headersSent) return;
  res.status(status).json({ error: message });
});

/* --------------------------------- 启动 --------------------------------- */

const PORT = Number(cfg.port) || 8080;

async function start() {
  let bindPort = PORT;

  if (SETUP_MODE) {
    // 向导端口：被占用就顺延，找一个可用端口
    for (let i = 0; i < 20 && !(await isPortFree(bindPort)); i++) {
      console.warn('[向导] 端口 ' + bindPort + ' 被占用，尝试 ' + (bindPort + 1));
      bindPort++;
    }
  } else if (process.env.HOMECLOUD_SKIP_PORTKILL === '1') {
    // 设置完成后的自动重启：稍等旧向导进程退出后重试绑定，不杀任何进程
    for (let i = 0; i < 20 && !(await isPortFree(bindPort)); i++) {
      await new Promise((r) => setTimeout(r, 300));
    }
  } else {
    // 常规启动：端口被占时，若占用者是本家庭云盘服务则自动结束它；
    // 若是其他程序，则明确提示用户更换端口
    const c = await resolvePortConflict(bindPort, { autoKillOurs: true });
    if (c.killed.length) {
      console.log('  检测到端口 ' + bindPort + ' 上有旧的 HomeCloud 服务（PID ' + c.killed.join(', ') + '），已自动停止。');
    }
    if (!c.free) {
      console.error('');
      console.error('  启动失败：端口 ' + bindPort + ' 正被其他程序占用，请更换端口号。');
      for (const p of c.pids) {
        if (!p.ours) console.error('  占用进程：PID ' + p.pid + '  ' + (p.cmd || '(未知程序)'));
      }
      console.error('  换端口方法（任选其一）：');
      if (process.platform === 'win32') {
        console.error('    1. 编辑 start.bat，修改 HOMECLOUD_PORT 后重新运行 start.bat');
        console.error('    2. 临时用其他端口启动：set HOMECLOUD_PORT=其他端口 && node server.js');
      } else {
        console.error('    1. 编辑 start.sh，修改 HOMECLOUD_PORT 后重新运行 ./start.sh');
        console.error('    2. 临时用其他端口启动：HOMECLOUD_PORT=其他端口 node server.js');
      }
      console.error('');
      process.exit(1);
    }
  }

  const server = app.listen(bindPort, '0.0.0.0', () => {
    const urls = lanAddresses().map((ip) => `http://${ip}:${bindPort}`);
    console.log('');
    if (SETUP_MODE) {
      console.log('  HomeCloud 首次初始化向导已启动');
      console.log('  ----------------------------------------');
      console.log('  请在浏览器中完成首次设置（选择共享目录、端口、密码）：');
      console.log('  本机访问：  http://127.0.0.1:' + bindPort + '/setup');
      console.log('  （初始化只能在本机操作，完成后服务将自动以正式端口重启）');
      console.log('  ----------------------------------------');
      console.log('SETUP_WIZARD_URL: http://127.0.0.1:' + bindPort + '/setup');
      console.log('');
    } else {
      console.log('  HomeCloud 家庭云盘已启动');
      console.log('  ----------------------------------------');
      console.log('  本机访问：  http://127.0.0.1:' + bindPort);
      urls.forEach((u) => console.log('  局域网访问：' + u));
      for (const d of config.getDisks()) {
        const ok = guard.isDiskAvailable(d.id);
        console.log('  共享目录：  ' + d.name + ' -> ' + d.path + (ok ? '（已就绪）' : '（不可访问，请检查磁盘是否挂载）'));
      }
      console.log('  访客上传上限：' + (Number(cfg.guestUploadMaxBytes) / 1024 / 1024 / 1024) + ' GB（超出需管理员密码）');
      console.log('  ----------------------------------------');
      console.log('');
      // 后台建立搜索索引
      indexer.start(cfg.indexIntervalMinutes);
    }
  });

  server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE') {
      console.error('');
      console.error('  启动失败：端口 ' + bindPort + ' 已被其他程序占用，请更换端口号');
      if (process.platform === 'win32') {
        console.error('  （编辑 start.bat 里的 HOMECLOUD_PORT，或用 set HOMECLOUD_PORT=其他端口 && node server.js）');
      } else {
        console.error('  （编辑 start.sh 里的 HOMECLOUD_PORT，或用 HOMECLOUD_PORT=其他端口 node server.js）');
      }
      console.error('');
      process.exit(1);
    }
    throw err;
  });
}

start();

/** 枚举局域网 IPv4 地址，方便直接把访问地址打印给用户 */
function lanAddresses() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const list of Object.values(ifaces)) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

// 退出时给个友好提示
process.on('SIGINT', () => {
  console.log('\n已停止 HomeCloud。');
  process.exit(0);
});
