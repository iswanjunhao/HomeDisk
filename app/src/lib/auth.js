/**
 * 管理员认证与会话
 * - 密码用 scrypt 哈希存储，比对时用 timingSafeEqual 防时序攻击
 * - 会话是服务端 Map + httpOnly Cookie，登出即失效（不像 JWT 那样无法吊销）
 * - 登录失败限流：同一 IP 5 次/分钟，超限锁定 10 分钟，挡住暴力破解
 */

const config = require('./config');

const sessions = new Map();       // token -> { exp, ip }
const failures = new Map();       // ip -> { count, firstAt, lockedUntil }

const MAX_FAILURES = 5;
const FAIL_WINDOW_MS = 60 * 1000;      // 1 分钟
const LOCK_MS = 10 * 60 * 1000;        // 锁定 10 分钟
const COOKIE_NAME = 'hc_sid';

/** 判断请求是否具备管理员权限 */
function isAdmin(req) {
  const token = req.cookies && req.cookies[COOKIE_NAME];
  if (!token) return false;
  const s = sessions.get(token);
  if (!s) return false;
  if (Date.now() > s.exp) {
    sessions.delete(token);
    return false;
  }
  return true;
}

/** 校验密码并下发会话；带失败限流 */
function login(req, res, password) {
  const ip = req.ip || 'unknown';
  const rec = failures.get(ip);
  if (rec && rec.lockedUntil && Date.now() < rec.lockedUntil) {
    const mins = Math.ceil((rec.lockedUntil - Date.now()) / 60000);
    return { ok: false, error: `尝试次数过多，请 ${mins} 分钟后再试` };
  }

  const cfg = config.get();
  if (!cfg.adminPasswordHash) {
    return { ok: false, error: '尚未设置管理员密码，请先在服务器上运行：node server.js --set-password <密码>' };
  }
  if (!config.verifyPassword(password, cfg.adminPasswordHash)) {
    const now = Date.now();
    let r = failures.get(ip);
    if (!r || now - r.firstAt > FAIL_WINDOW_MS) {
      r = { count: 0, firstAt: now, lockedUntil: 0 };
    }
    r.count++;
    if (r.count >= MAX_FAILURES) {
      r.lockedUntil = now + LOCK_MS;
      r.count = 0;
      r.firstAt = now;
      failures.set(ip, r);
      return { ok: false, error: '密码错误次数过多，已锁定 10 分钟' };
    }
    failures.set(ip, r);
    return { ok: false, error: `密码错误，还可尝试 ${MAX_FAILURES - r.count} 次` };
  }

  failures.delete(ip);
  const hours = Number(cfg.sessionHours) || 8;
  const token = require('crypto').randomBytes(32).toString('hex');
  sessions.set(token, { exp: Date.now() + hours * 3600 * 1000, ip });
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,               // JS 读不到，降低 XSS 危害
    sameSite: 'lax',
    maxAge: hours * 3600 * 1000,
  });
  return { ok: true };
}

function logout(req, res) {
  const token = req.cookies && req.cookies[COOKIE_NAME];
  if (token) sessions.delete(token);
  res.clearCookie(COOKIE_NAME);
}

/** 要求管理员权限的中间件：未登录直接返回 401，前端会弹密码框 */
function requireAdmin(req, res, next) {
  if (isAdmin(req)) return next();
  return res.status(401).json({ error: '需要管理员密码', needAuth: true });
}

/** 定期清理过期会话，避免 Map 无限增长 */
setInterval(() => {
  const now = Date.now();
  for (const [token, s] of sessions) {
    if (now > s.exp) sessions.delete(token);
  }
}, 10 * 60 * 1000).unref();

/** 判断客户端 IP 是否为局域网私有地址 */
function isPrivateIp(ip) {
  if (!ip) return false;
  const v4 = ip.replace(/^::ffff:/, '');
  if (v4 === '127.0.0.1' || v4 === '::1') return true;
  const m = v4.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

module.exports = { isAdmin, login, logout, requireAdmin, isPrivateIp, COOKIE_NAME };
