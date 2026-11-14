'use strict';
const db = require('./db');
const config = require('./config');
const mediaauth = require('./lib/mediaauth');

/** 免密选身份：客户端用 X-User-Id 头声明自己是谁（内网信任模式） */
function requireUser(req, res, next) {
  // 请求头是给 fetch 用的；<video>/<img> 带不了头，走签名 token（t=...）
  let id = req.get('x-user-id');
  if (!id && req.query.t) {
    id = mediaauth.verify(req.query.t);
    if (!id) return res.status(401).json({ error: '播放链接已过期，请刷新页面' });
  }
  if (!id && req.query.uid) return res.status(401).json({ error: '播放链接已过期，请刷新页面' });
  if (!id) id = req.body?.uid;
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
