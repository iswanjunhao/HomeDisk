#!/usr/bin/env node
/**
 * HomeCloud 家庭局域网私有网盘 —— 服务入口
 *
 * 启动：node server.js
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
guard.setRoot(cfg.root);

// 首次运行自动生成管理员密码并打印，避免"装好了却不知道密码"的尴尬
if (!cfg.adminPasswordHash) {
  const pwd = require('crypto').randomBytes(5).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 8);
  cfg.adminPasswordHash = config.hashPassword(pwd);
  config.save({ adminPasswordHash: cfg.adminPasswordHash });
  console.log('');
  console.log('  ==================================================');
  console.log('  首次启动，已自动生成管理员密码：  ' + pwd);
  console.log('  修改密码： node server.js --set-password <新密码>');
  console.log('  ==================================================');
  console.log('');
}

/* --------------------------------- 应用 --------------------------------- */

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);

app.use(cookieParser());
app.use(express.json({ limit: '2mb' }));

// 仅允许局域网访问：这是家庭网盘最基本的安全边界
app.use((req, res, next) => {
  const ip = req.ip || '';
  if (cfg.lanOnly && !auth.isPrivateIp(ip)) {
    return res.status(403).json({ error: '仅允许局域网访问' });
  }
  next();
});

// 静态资源：不做强缓存（每次校验 ETag），避免前端更新后浏览器还拿着旧文件
app.use(express.static(path.join(__dirname, 'public'), { maxAge: 0, etag: true }));

// API 路由
app.use('/api', require('./src/routes/files'));
app.use('/api', require('./src/routes/search'));
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

app.listen(PORT, '0.0.0.0', () => {
  const urls = lanAddresses().map((ip) => `http://${ip}:${PORT}`);
  console.log('');
  console.log('  HomeCloud 家庭云盘已启动');
  console.log('  ----------------------------------------');
  console.log('  本机访问：  http://127.0.0.1:' + PORT);
  urls.forEach((u) => console.log('  局域网访问：' + u));
  console.log('  共享目录：  ' + cfg.root + (guard.isRootAvailable() ? '（已就绪）' : '（不可用，请检查挂载）'));
  console.log('  访客上传上限：' + (Number(cfg.guestUploadMaxBytes) / 1024 / 1024 / 1024) + ' GB（超出需管理员密码）');
  console.log('  ----------------------------------------');
  console.log('');

  // 后台建立搜索索引
  indexer.start(cfg.indexIntervalMinutes);
});

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
