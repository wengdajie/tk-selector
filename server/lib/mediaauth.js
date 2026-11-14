'use strict';
/**
 * 媒体访问令牌：<video>/<img> 带不了请求头，只能把身份放 URL。
 * 以前直接把 uid 放 query —— 链接一转发就等于把读取权限送人，且无法撤销。
 * 现在改成签名 token：uid + 过期时间 + HMAC，24 小时一轮换，改了密钥即全量失效。
 */
const crypto = require('crypto');
const db = require('../db');

const TTL_MS = 24 * 3600 * 1000;

function secret() {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'media_secret'").get();
  if (row?.value) return row.value;
  const s = crypto.randomBytes(24).toString('hex');
  db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('media_secret', ?, ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(s, Date.now());
  return s;
}

const sign = payload => crypto.createHmac('sha256', secret()).update(payload).digest('base64url');

/** 签发：返回 `uid.exp.sig` */
function issue(uid) {
  const exp = Date.now() + TTL_MS;
  const payload = `${uid}.${exp}`;
  return `${payload}.${sign(payload)}`;
}

/** 校验：返回 uid 或 null */
function verify(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const [uid, exp, sig] = parts;
  if (!uid || !/^\d+$/.test(exp)) return null;
  if (Number(exp) < Date.now()) return null;
  const want = sign(`${uid}.${exp}`);
  const a = Buffer.from(want);
  const b = Buffer.from(sig);
  if (a.length !== b.length) return null;
  return crypto.timingSafeEqual(a, b) ? uid : null;
}

module.exports = { issue, verify, TTL_MS };
