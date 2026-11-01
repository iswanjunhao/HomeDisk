/**
 * 管理员登录 / 登出
 */

const { Router } = require('express');
const auth = require('../lib/auth');
const config = require('../lib/config');

const router = Router();

router.post('/login', (req, res) => {
  const result = auth.login(req, res, req.body && req.body.password);
  if (!result.ok) {
    return res.status(401).json({ error: result.error, needAuth: true, hasPassword: !!config.get().adminPasswordHash });
  }
  res.json({ ok: true });
});

router.post('/logout', (req, res) => {
  auth.logout(req, res);
  res.json({ ok: true });
});

module.exports = router;
