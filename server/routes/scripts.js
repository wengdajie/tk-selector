'use strict';
const express = require('express');
const fs = require('fs');
const path = require('path');
const db = require('../db');
const config = require('../config');
const ai = require('../lib/ai');
const scriptgen = require('../lib/scriptgen');
const { requireUser } = require('../middleware');

const r = express.Router();

const parse = (s, fallback) => {
  try { return s ? JSON.parse(s) : fallback; } catch { return fallback; }
};

/** 对外结构：JSON 字段解析成对象 */
function shape(row) {
  if (!row) return row;
  return {
    ...row,
    segments: parse(row.segments, []),
    shot_setup: parse(row.shot_setup, {}),
    frames: parse(row.frames, []),
    tagList: String(row.tags || '').split(',').filter(Boolean),
  };
}

/** AI 配置自检（不消耗 token） */
r.get('/ai/status', requireUser, async (req, res) => {
  res.json(await ai.status());
});

/** 触发拆解 */
r.post('/videos/:id/analyze', requireUser, (req, res) => {
  const v = db.prepare('SELECT * FROM videos WHERE id = ?').get(req.params.id);
  if (!v) return res.status(404).json({ error: '素材不存在' });
  if (!config.ai.enabled) return res.status(400).json({ error: 'AI 已关闭（AI_ENABLED=0）' });
  if (!config.ai.apiKey) return res.status(400).json({ error: '未配置 AI_API_KEY，请设置环境变量后重启容器' });

  const job = scriptgen.createJob(v, req.user.id);
  res.status(201).json({ script: shape(job) });
});

/** 脚本列表（可按素材过滤） */
r.get('/scripts', requireUser, (req, res) => {
  const where = [];
  const p = {};
  if (req.query.videoId) { where.push('s.video_id = @videoId'); p.videoId = req.query.videoId; }
  if (req.query.status === 'running') {
    where.push("s.status IN ('pending','running')");   // 前端把两个中间态合并成「进行中」
  } else if (req.query.status) {
    where.push('s.status = @status');
    p.status = req.query.status;
  }
  if (req.query.q) { where.push('(s.title LIKE @q OR s.summary LIKE @q OR s.tags LIKE @q OR s.script_text LIKE @q)'); p.q = `%${req.query.q}%`; }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const items = db.prepare(`
    SELECT s.*, v.title AS video_title, v.thumb_path, v.duration, v.width, v.height, v.space,
           v.qc_score, v.score_content, u.name AS author_name, u.color AS author_color
    FROM scripts s
    LEFT JOIN videos v ON v.id = s.video_id
    LEFT JOIN users u ON u.id = s.created_by
    ${clause}
    ORDER BY s.created_at DESC LIMIT 200
  `).all(p);

  const counts = db.prepare(`
    SELECT status, COUNT(*) c FROM scripts GROUP BY status
  `).all().reduce((acc, x) => ({ ...acc, [x.status]: x.c }), {});

  res.json({ items: items.map(shape), counts });
});

r.get('/scripts/:id', requireUser, (req, res) => {
  const row = db.prepare(`
    SELECT s.*, v.title AS video_title, v.thumb_path, v.duration, v.width, v.height, v.space,
           u.name AS author_name, u.color AS author_color
    FROM scripts s LEFT JOIN videos v ON v.id = s.video_id
    LEFT JOIN users u ON u.id = s.created_by WHERE s.id = ?
  `).get(req.params.id);
  if (!row) return res.status(404).json({ error: '脚本不存在' });
  res.json({ script: shape(row) });
});

/** 关键帧图片（缩略图级别，用于列表与详情） */
r.get('/scripts/:id/frames/:idx', (req, res) => {
  const row = db.prepare('SELECT frames FROM scripts WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).end();
  const frames = parse(row.frames, []);
  const f = frames[Number(req.params.idx)];
  if (!f?.path) return res.status(404).end();
  const abs = path.join(config.mediaDir, f.path);
  if (!fs.existsSync(abs)) return res.status(410).end();
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.sendFile(abs);
});

/** 重新拆解 */
r.post('/scripts/:id/retry', requireUser, (req, res) => {
  const row = db.prepare('SELECT * FROM scripts WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: '脚本不存在' });
  const v = db.prepare('SELECT * FROM videos WHERE id = ?').get(row.video_id);
  if (!v) return res.status(404).json({ error: '素材已被删除' });
  const job = scriptgen.restart(row.id);
  if (!job) return res.status(400).json({ error: '无法重新拆解' });
  res.json({ ok: true, job: shape(job) });
});

r.delete('/scripts/:id', requireUser, (req, res) => {
  const row = db.prepare('SELECT * FROM scripts WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: '脚本不存在' });
  db.prepare('DELETE FROM scripts WHERE id = ?').run(row.id);
  res.json({ ok: true });
});

module.exports = r;
