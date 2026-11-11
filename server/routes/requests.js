'use strict';
const express = require('express');
const db = require('../db');
const { requireUser } = require('../middleware');
const { uuid } = require('../lib/util');

const r = express.Router();

const SELECT = `
  SELECT q.*, u.name AS creator_name, u.color AS creator_color,
    (SELECT COUNT(*) FROM request_claims c WHERE c.request_id = q.id) AS claim_count,
    (SELECT COUNT(*) FROM videos v WHERE v.request_id = q.id) AS video_count,
    (SELECT GROUP_CONCAT(u2.name, '、') FROM request_claims c2
       JOIN users u2 ON u2.id = c2.user_id WHERE c2.request_id = q.id) AS claim_names
  FROM requests q LEFT JOIN users u ON u.id = q.created_by
`;

r.get('/requests', requireUser, (req, res) => {
  const where = [];
  const p = {};
  if (req.query.status && req.query.status !== 'all') {
    if (req.query.status === 'active') where.push("q.status IN ('open','claimed')");
    else { where.push('q.status = @status'); p.status = req.query.status; }
  }
  if (req.query.q) { where.push('(q.title LIKE @q OR q.brief LIKE @q OR q.tags LIKE @q)'); p.q = `%${req.query.q}%`; }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const order = "ORDER BY CASE q.priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, q.created_at DESC";
  const items = db.prepare(`${SELECT} ${clause} ${order}`).all(p);
  const counts = db.prepare(`
    SELECT status, COUNT(*) c FROM requests GROUP BY status
  `).all().reduce((a, x) => ({ ...a, [x.status]: x.c }), {});
  res.json({ items, counts });
});

r.get('/requests/:id', requireUser, (req, res) => {
  const q = db.prepare(`${SELECT} WHERE q.id = ?`).get(req.params.id);
  if (!q) return res.status(404).json({ error: '需求不存在' });
  const claims = db.prepare(`
    SELECT c.created_at, u.id, u.name, u.color, u.role
    FROM request_claims c JOIN users u ON u.id = c.user_id
    WHERE c.request_id = ? ORDER BY c.created_at
  `).all(q.id);
  const videos = db.prepare(`
    SELECT id,title,thumb_path,duration,shoot_date,status FROM videos
    WHERE request_id = ? ORDER BY created_at DESC LIMIT 24
  `).all(q.id);
  res.json({ request: q, claims, videos });
});

r.post('/requests', requireUser, (req, res) => {
  const title = String(req.body?.title || '').trim().slice(0, 80);
  if (!title) return res.status(400).json({ error: '请填写需求标题' });
  const id = uuid();
  const now = Date.now();
  const priority = ['high', 'normal', 'low'].includes(req.body?.priority) ? req.body.priority : 'normal';
  const due = /^\d{4}-\d{2}-\d{2}$/.test(req.body?.dueDate || '') ? req.body.dueDate : null;
  const tags = String(req.body?.tags || '').split(',').map(s => s.trim()).filter(Boolean).join(',');
  db.prepare(`INSERT INTO requests (id,title,brief,priority,platform,due_date,status,tags,created_by,created_at,updated_at)
              VALUES (?,?,?,?,?,?, 'open', ?,?,?,?)`)
    .run(id, title, String(req.body?.brief || '').slice(0, 2000), priority,
      String(req.body?.platform || 'TikTok').slice(0, 24), due, tags, req.user.id, now, now);
  res.status(201).json({ request: db.prepare(`${SELECT} WHERE q.id = ?`).get(id) });
});

r.patch('/requests/:id', requireUser, (req, res) => {
  const q = db.prepare('SELECT * FROM requests WHERE id = ?').get(req.params.id);
  if (!q) return res.status(404).json({ error: '需求不存在' });
  const isOwner = q.created_by === req.user.id;
  const isAdmin = req.user.role === 'admin';
  const body = req.body || {};

  // 认领人也能改状态（拍摄自己标记完成）
  const claimed = db.prepare('SELECT 1 FROM request_claims WHERE request_id = ? AND user_id = ?')
    .get(q.id, req.user.id);
  const onlyStatus = Object.keys(body).every(k => k === 'status');
  if (!isOwner && !isAdmin && !(claimed && onlyStatus)) {
    return res.status(403).json({ error: '只有需求发起人或管理员可以修改' });
  }

  const next = {
    title: body.title !== undefined ? String(body.title).slice(0, 80) : q.title,
    brief: body.brief !== undefined ? String(body.brief).slice(0, 2000) : q.brief,
    priority: ['high', 'normal', 'low'].includes(body.priority) ? body.priority : q.priority,
    platform: body.platform !== undefined ? String(body.platform).slice(0, 24) : q.platform,
    due_date: body.dueDate !== undefined
      ? (/^\d{4}-\d{2}-\d{2}$/.test(body.dueDate) ? body.dueDate : null)
      : q.due_date,
    status: ['open', 'claimed', 'done', 'closed'].includes(body.status) ? body.status : q.status,
    tags: body.tags !== undefined
      ? String(body.tags).split(',').map(s => s.trim()).filter(Boolean).join(',')
      : q.tags,
  };
  db.prepare(`UPDATE requests SET title=@title,brief=@brief,priority=@priority,platform=@platform,
    due_date=@due_date,status=@status,tags=@tags,updated_at=@updated_at WHERE id=@id`)
    .run({ ...next, updated_at: Date.now(), id: q.id });

  // 有人认领时状态自动推进
  if (next.status === 'open') {
    const c = db.prepare('SELECT COUNT(*) c FROM request_claims WHERE request_id = ?').get(q.id).c;
    if (c > 0) db.prepare("UPDATE requests SET status='claimed' WHERE id=?").run(q.id);
  }
  res.json({ request: db.prepare(`${SELECT} WHERE q.id = ?`).get(q.id) });
});

r.post('/requests/:id/claim', requireUser, (req, res) => {
  const q = db.prepare('SELECT * FROM requests WHERE id = ?').get(req.params.id);
  if (!q) return res.status(404).json({ error: '需求不存在' });
  const action = req.body?.action === 'quit' ? 'quit' : 'join';
  if (action === 'join') {
    db.prepare('INSERT OR IGNORE INTO request_claims (request_id,user_id,created_at) VALUES (?,?,?)')
      .run(q.id, req.user.id, Date.now());
    if (q.status === 'open' || q.status === 'claimed') {
      db.prepare("UPDATE requests SET status='claimed', updated_at=? WHERE id=?").run(Date.now(), q.id);
    }
  } else {
    db.prepare('DELETE FROM request_claims WHERE request_id = ? AND user_id = ?').run(q.id, req.user.id);
    const left = db.prepare('SELECT COUNT(*) c FROM request_claims WHERE request_id = ?').get(q.id).c;
    if (left === 0 && ['open', 'claimed'].includes(q.status)) {
      db.prepare("UPDATE requests SET status='open', updated_at=? WHERE id=?").run(Date.now(), q.id);
    }
  }
  res.json({ request: db.prepare(`${SELECT} WHERE q.id = ?`).get(q.id) });
});

r.delete('/requests/:id', requireUser, (req, res) => {
  const q = db.prepare('SELECT * FROM requests WHERE id = ?').get(req.params.id);
  if (!q) return res.status(404).json({ error: '需求不存在' });
  if (q.created_by !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: '只有发起人或管理员可以删除' });
  }
  db.prepare('DELETE FROM requests WHERE id = ?').run(q.id);
  res.json({ ok: true });
});

module.exports = r;
