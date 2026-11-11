'use strict';
const express = require('express');
const db = require('../db');
const { requireUser } = require('../middleware');
const { uuid } = require('../lib/util');

const r = express.Router();

r.post('/videos/:id/comments', requireUser, (req, res) => {
  const v = db.prepare('SELECT id FROM videos WHERE id = ?').get(req.params.id);
  if (!v) return res.status(404).json({ error: '视频不存在' });
  const body = String(req.body?.body || '').trim().slice(0, 2000);
  if (!body) return res.status(400).json({ error: '评论内容不能为空' });
  const id = uuid();
  const now = Date.now();
  db.prepare('INSERT INTO comments (id,video_id,user_id,body,created_at) VALUES (?,?,?,?,?)')
    .run(id, v.id, req.user.id, body, now);
  const c = db.prepare(`
    SELECT c.*, u.name AS user_name, u.color AS user_color
    FROM comments c LEFT JOIN users u ON u.id = c.user_id WHERE c.id = ?
  `).get(id);
  res.status(201).json({ comment: c });
});

r.delete('/comments/:id', requireUser, (req, res) => {
  const c = db.prepare('SELECT * FROM comments WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).json({ error: '评论不存在' });
  if (c.user_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: '只能删除自己的评论' });
  }
  db.prepare('DELETE FROM comments WHERE id = ?').run(c.id);
  res.json({ ok: true });
});

r.get('/comments/recent', requireUser, (req, res) => {
  const rows = db.prepare(`
    SELECT c.*, u.name AS user_name, u.color AS user_color, v.title AS video_title, v.thumb_path
    FROM comments c
    JOIN users u ON u.id = c.user_id
    JOIN videos v ON v.id = c.video_id
    ORDER BY c.created_at DESC LIMIT 20
  `).all();
  res.json({ items: rows });
});

module.exports = r;
