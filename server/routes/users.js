'use strict';
const express = require('express');
const db = require('../db');
const config = require('../config');
const { uuid } = require('../lib/util');
const { hashPassword, verifyPassword } = require('../lib/password');
const { requireUser, requireAdmin, checkCode } = require('../middleware');
const mediaauth = require('../lib/mediaauth');

const r = express.Router();

const COLORS = ['#25F4EE', '#FE2C55', '#FFC24B', '#3DDC97', '#9B8CFF', '#FF8A5B', '#5BC8FF'];
const ROLE_LABEL = { admin: '管理员', ops: '运营', shooter: '拍摄', viewer: '只读' };
const SELF_SIGNUP_ROLES = ['ops', 'shooter', 'viewer'];

const PUBLIC_FIELDS = `id,name,role,color,active,created_at,notify_key,
  CASE WHEN password_hash IS NOT NULL AND password_hash <> '' THEN 1 ELSE 0 END AS has_password`;

const MIN_PASSWORD = 6;

/** 成员列表：需要登录（登录前的页面不再依赖此接口） */
r.get('/users', requireUser, (req, res) => {
  const rows = db.prepare(
    `SELECT ${PUBLIC_FIELDS} FROM users WHERE active = 1
     ORDER BY CASE role WHEN 'admin' THEN 0 WHEN 'ops' THEN 1 ELSE 2 END, created_at`
  ).all();
  res.json({ items: rows, accessCodeRequired: !!config.accessCode, registrationOpen: true });
});

r.get('/me', requireUser, (req, res) => {
  const u = db.prepare(`SELECT ${PUBLIC_FIELDS} FROM users WHERE id = ?`).get(req.user.id);
  res.json({ user: u, mediaToken: mediaauth.issue(u.id) });
});

/** 注册：名字 + 密码必填，角色限运营/拍摄/只读；管理员只能由管理员创建 */
r.post('/users', (req, res) => {
  if (!checkCode(req, res)) return;
  const name = String(req.body?.name || '').trim().slice(0, 24);
  if (!name) return res.status(400).json({ error: '请填写名字' });

  const password = String(req.body?.password || '');
  if (password.length < MIN_PASSWORD) {
    return res.status(400).json({ error: `密码至少 ${MIN_PASSWORD} 位` });
  }

  const exists = db.prepare('SELECT id FROM users WHERE name = ? AND active = 1').get(name);
  if (exists) return res.status(409).json({ error: '这个名字已经被使用了' });

  const wantAdmin = req.body?.role === 'admin';
  if (wantAdmin) {
    // 仅管理员可以创建管理员
    const requester = db.prepare('SELECT role FROM users WHERE id = ?').get(
      req.get('x-user-id') || req.query.uid || ''
    );
    if (requester?.role !== 'admin') {
      return res.status(403).json({ error: '只有管理员可以创建管理员账号' });
    }
  }

  const count = db.prepare('SELECT COUNT(*) c FROM users WHERE active = 1').get().c;
  const color = COLORS[count % COLORS.length];
  const role = SELF_SIGNUP_ROLES.includes(req.body?.role) || wantAdmin ? req.body.role : 'ops';
  const id = uuid();
  db.prepare(`INSERT INTO users (id,name,role,color,active,created_at,password_hash)
              VALUES (?,?,?,?,1,?,?)`)
    .run(id, name, role, color, Date.now(), hashPassword(password));

  const user = db.prepare(`SELECT ${PUBLIC_FIELDS} FROM users WHERE id = ?`).get(id);
  res.status(201).json({ user });
});

/** 登录：用户名（或 id）+ 密码；带简单的防爆破限制 */
const LOGIN_WINDOW = 10 * 60 * 1000;   // 10 分钟内
const LOGIN_MAX_FAIL = 8;              // 同一来源 + 同一账号最多失败 8 次
const loginFails = new Map();

function failKey(req, name) {
  return `${req.ip || 'unknown'}|${String(name).toLowerCase()}`;
}
function isBlocked(key) {
  const rec = loginFails.get(key);
  if (!rec) return false;
  if (Date.now() - rec.first > LOGIN_WINDOW) { loginFails.delete(key); return false; }
  return rec.count >= LOGIN_MAX_FAIL;
}
function noteFail(key) {
  const rec = loginFails.get(key);
  if (!rec || Date.now() - rec.first > LOGIN_WINDOW) loginFails.set(key, { count: 1, first: Date.now() });
  else rec.count += 1;
  if (loginFails.size > 2000) loginFails.clear(); // 兜底，避免长期运行内存膨胀
}

r.post('/login', (req, res) => {
  const name = String(req.body?.name || req.body?.userId || '').trim();
  if (!name) return res.status(400).json({ error: '请输入账号' });
  const password = String(req.body?.password || '');
  if (!password) return res.status(400).json({ error: '请输入密码' });

  const key = failKey(req, name);
  if (isBlocked(key)) {
    return res.status(429).json({ error: '尝试次数过多，请 10 分钟后再试' });
  }

  const u = db.prepare(
    'SELECT * FROM users WHERE active = 1 AND (id = ? OR name = ?) LIMIT 1'
  ).get(name, name);
  if (!u) {
    noteFail(key);
    return res.status(404).json({ error: '账号不存在，或已被移除' });
  }
  if (!u.password_hash) return res.status(403).json({ error: '该账号未设置密码，请联系管理员重置' });
  if (!verifyPassword(password, u.password_hash)) {
    noteFail(key);
    return res.status(401).json({ error: '密码不正确' });
  }
  loginFails.delete(key);
  const user = db.prepare(`SELECT ${PUBLIC_FIELDS} FROM users WHERE id = ?`).get(u.id);
  res.json({ user, mediaToken: mediaauth.issue(user.id) });
});

/** 改密码：本人需提供当前密码；管理员可直接重置任意成员 */
r.post('/users/:id/password', requireUser, (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!u) return res.status(404).json({ error: '账号不存在' });

  const isSelf = u.id === req.user.id;
  const isAdmin = req.user.role === 'admin';
  if (!isSelf && !isAdmin) return res.status(403).json({ error: '只能修改自己的密码' });

  if (isSelf && !isAdmin && u.password_hash) {
    if (!verifyPassword(req.body?.oldPassword, u.password_hash)) {
      return res.status(401).json({ error: '当前密码不正确' });
    }
  }

  const next = String(req.body?.newPassword || '');
  if (next.length < MIN_PASSWORD) return res.status(400).json({ error: `新密码至少 ${MIN_PASSWORD} 位` });

  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(next), u.id);
  res.json({ ok: true, hasPassword: true });
});

/** 自改昵称/头像色（本人） */
r.patch('/users/me', requireUser, (req, res) => {
  const name = req.body?.name !== undefined ? String(req.body.name).trim().slice(0, 24) : req.user.name;
  if (!name) return res.status(400).json({ error: '名字不能为空' });
  const dup = db.prepare('SELECT id FROM users WHERE name = ? AND active = 1 AND id <> ?').get(name, req.user.id);
  if (dup) return res.status(409).json({ error: '这个名字已经被使用了' });
  db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name, req.user.id);
  res.json({ user: db.prepare(`SELECT ${PUBLIC_FIELDS} FROM users WHERE id = ?`).get(req.user.id) });
});

r.patch('/users/:id', requireUser, requireAdmin, (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!u) return res.status(404).json({ error: '成员不存在' });
  const name = req.body?.name !== undefined ? String(req.body.name).trim().slice(0, 24) : u.name;
  const role = Object.keys(ROLE_LABEL).includes(req.body?.role) ? req.body.role : u.role;
  if (!name) return res.status(400).json({ error: '名字不能为空' });
  // 通知账号：群机器人在群里真实艾特这个人用的标识（企业微信 userid / 钉钉手机号 / 飞书 user_id）
  const notifyKey = req.body?.notify_key !== undefined
    ? String(req.body.notify_key).trim().slice(0, 64) : u.notify_key;
  db.prepare('UPDATE users SET name = ?, role = ?, notify_key = ? WHERE id = ?')
    .run(name, role, notifyKey || null, u.id);
  res.json({ user: db.prepare(`SELECT ${PUBLIC_FIELDS} FROM users WHERE id = ?`).get(u.id) });
});

r.delete('/users/:id', requireUser, requireAdmin, (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ error: '不能移除自己' });
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!u) return res.status(404).json({ error: '成员不存在' });
  if (u.role === 'admin') {
    const admins = db.prepare("SELECT COUNT(*) c FROM users WHERE role='admin' AND active=1").get().c;
    if (admins <= 1) return res.status(400).json({ error: '至少保留一位管理员' });
  }
  db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(u.id);
  res.json({ ok: true });
});

module.exports = r;
