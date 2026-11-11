'use strict';
const db = require('./db');
const config = require('./config');

/** 免密选身份：客户端用 X-User-Id 头声明自己是谁（内网信任模式） */
function requireUser(req, res, next) {
  const id = req.get('x-user-id') || req.query.uid || req.body?.uid;
  if (!id) return res.status(401).json({ error: '请先选择身份' });
  const user = db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(id);
  if (!user) return res.status(401).json({ error: '身份已失效，请重新选择' });
  req.user = user;
  next();
}

function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: '需要管理员身份' });
  }
  next();
}

/** 可选口令保护：设置了 ACCESS_CODE 才校验 */
function checkCode(req, res) {
  if (!config.accessCode) return true;
  const code = req.get('x-access-code') || req.body?.code || '';
  if (code !== config.accessCode) {
    res.status(403).json({ error: '管理口令不正确' });
    return false;
  }
  return true;
}

module.exports = { requireUser, requireAdmin, checkCode };
