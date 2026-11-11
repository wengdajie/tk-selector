'use strict';
const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const db = require('../db');
const config = require('../config');
const media = require('../lib/media');
const { ingest } = require('../lib/store');
const { requireUser } = require('../middleware');
const { uuid, ymd, safeName } = require('../lib/util');

const r = express.Router();

const tmpDir = path.join(config.dataDir, 'tmp');
fs.mkdirSync(tmpDir, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, tmpDir),
    filename: (req, file, cb) => cb(null, `${uuid()}${path.extname(file.originalname).toLowerCase()}`),
  }),
  limits: { fileSize: config.maxUploadBytes, files: 30 },
  fileFilter: (req, file, cb) => {
    if (!media.isVideoFile(file.originalname)) return cb(new Error(`不支持的格式: ${file.originalname}`));
    cb(null, true);
  },
});

const LIST_SELECT = `
  SELECT v.*, u.name AS uploader_name, u.color AS uploader_color,
    (SELECT COUNT(*) FROM comments c WHERE c.video_id = v.id) AS comment_count,
    (SELECT COUNT(*) FROM downloads d WHERE d.video_id = v.id) AS download_count,
    (SELECT u2.name FROM downloads d2 JOIN users u2 ON u2.id = d2.user_id
       WHERE d2.video_id = v.id ORDER BY d2.created_at DESC LIMIT 1) AS last_downloader_name,
    (SELECT d3.created_at FROM downloads d3 WHERE d3.video_id = v.id
       ORDER BY d3.created_at DESC LIMIT 1) AS last_download_at
  FROM videos v LEFT JOIN users u ON u.id = v.uploader_id
`;

function buildFilter(qs) {
  const where = [];
  const p = {};
  const add = (sql, key, val) => { where.push(sql); p[key] = val; };

  if (qs.space && qs.space !== 'all') add('v.space = @space', 'space', qs.space);
  if (qs.date) add('v.shoot_date = @date', 'date', qs.date);
  if (qs.from) add('v.shoot_date >= @from', 'from', qs.from);
  if (qs.to) add('v.shoot_date <= @to', 'to', qs.to);
  if (qs.status) add('v.status = @status', 'status', qs.status);
  if (qs.requestId) add('v.request_id = @requestId', 'requestId', qs.requestId);
  if (qs.uploaderId) add('v.uploader_id = @uploaderId', 'uploaderId', qs.uploaderId);
  if (qs.tag) add("(',' || v.tags || ',') LIKE @tag", 'tag', `%,${qs.tag},%`);
  if (qs.q) add('(v.title LIKE @q OR v.orig_name LIKE @q OR v.tags LIKE @q)', 'q', `%${qs.q}%`);
  if (qs.downloadedBy) add('EXISTS (SELECT 1 FROM downloads d WHERE d.video_id = v.id AND d.user_id = @downloadedBy)', 'downloadedBy', qs.downloadedBy);
  if (qs.hasComments === '1') add('EXISTS (SELECT 1 FROM comments c WHERE c.video_id = v.id)', 'hc', 1);
  if (qs.notDownloaded === '1') add('NOT EXISTS (SELECT 1 FROM downloads d WHERE d.video_id = v.id)', 'nd', 1);
  if (qs.minRating) add('v.rating >= @minRating', 'minRating', Number(qs.minRating));
  if (qs.starred === '1') add('v.rating > 0', 'starred', 1);

  return { clause: where.length ? `WHERE ${where.join(' AND ')}` : '', params: p };
}

const SORTS = {
  newest: 'v.created_at DESC',
  oldest: 'v.created_at ASC',
  duration: 'v.duration DESC',
  shoot: 'v.shoot_date DESC, v.created_at DESC',
  rating: 'v.rating DESC, v.created_at DESC',
}

r.get('/videos', requireUser, (req, res) => {
  const { clause, params } = buildFilter(req.query);
  const limit = Math.min(Math.max(Number(req.query.limit) || 60, 1), 200);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const order = SORTS[req.query.sort] || SORTS.newest;

  const total = db.prepare(`SELECT COUNT(*) c FROM videos v ${clause}`).get(params).c;
  const items = db.prepare(`${LIST_SELECT} ${clause} ORDER BY ${order} LIMIT @limit OFFSET @offset`)
    .all({ ...params, limit, offset });

  // 日期分桶（不受 date 条件影响，方便左上角日期切换器）
  const facetQs = { ...req.query };
  delete facetQs.date;
  delete facetQs.from;
  delete facetQs.to;
  const f = buildFilter(facetQs);
  const dates = db.prepare(`
    SELECT v.shoot_date AS date, COUNT(*) AS count,
      SUM(CASE WHEN v.status = 'new' THEN 1 ELSE 0 END) AS fresh
    FROM videos v ${f.clause}
    GROUP BY v.shoot_date ORDER BY v.shoot_date DESC LIMIT 45
  `).all(f.params);

  const tagWhere = clause ? `${clause} AND v.tags <> ''` : "WHERE v.tags <> ''";
  const tagRows = db.prepare(`SELECT tags FROM videos v ${tagWhere}`).all(params);
  const tagCount = new Map();
  for (const row of tagRows) {
    for (const t of String(row.tags).split(',').map(s => s.trim()).filter(Boolean)) {
      tagCount.set(t, (tagCount.get(t) || 0) + 1);
    }
  }
  const tags = [...tagCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 24)
    .map(([name, count]) => ({ name, count }));

  res.json({ items, total, limit, offset, dates, tags });
});

r.get('/videos/:id', requireUser, (req, res) => {
  const v = db.prepare(`${LIST_SELECT} WHERE v.id = ?`).get(req.params.id);
  if (!v) return res.status(404).json({ error: '视频不存在' });
  const comments = db.prepare(`
    SELECT c.*, u.name AS user_name, u.color AS user_color
    FROM comments c LEFT JOIN users u ON u.id = c.user_id
    WHERE c.video_id = ? ORDER BY c.created_at ASC
  `).all(v.id);
  const downloads = db.prepare(`
    SELECT d.*, u.name AS user_name, u.color AS user_color
    FROM downloads d LEFT JOIN users u ON u.id = d.user_id
    WHERE d.video_id = ? ORDER BY d.created_at DESC
  `).all(v.id);
  const siblings = v.request_id
    ? db.prepare('SELECT id,title,thumb_path,duration FROM videos WHERE request_id = ? AND id <> ? LIMIT 8')
        .all(v.request_id, v.id)
    : [];
  res.json({ video: v, comments, downloads, siblings });
});

r.get('/videos/:id/stream', requireUser, (req, res) => {
  const v = db.prepare('SELECT * FROM videos WHERE id = ?').get(req.params.id);
  if (!v) return res.status(404).json({ error: '视频不存在' });
  const abs = path.join(config.mediaDir, v.file_path);
  if (!fs.existsSync(abs)) return res.status(410).json({ error: '源文件已被移动或删除' });
  res.setHeader('Content-Type', v.mime);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.sendFile(abs);
});

r.get('/videos/:id/thumb', (req, res) => {
  const v = db.prepare('SELECT thumb_path FROM videos WHERE id = ?').get(req.params.id);
  if (!v?.thumb_path) return res.status(404).end();
  const abs = path.join(config.mediaDir, v.thumb_path);
  if (!fs.existsSync(abs)) return res.status(404).end();
  res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
  res.sendFile(abs);
});

r.post('/videos/upload', requireUser, (req, res) => {
  upload.array('files', 30)(req, res, async (err) => {
    if (err) {
      return res.status(400).json({ error: err.message || '上传失败' });
    }
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ error: '没有收到文件' });
    const space = req.body.space === 'library' ? 'library' : 'daily';
    const shootDate = /^\d{4}-\d{2}-\d{2}$/.test(req.body.shootDate || '') ? req.body.shootDate : ymd();
    const requestId = req.body.requestId || null;
    const tags = String(req.body.tags || '').split(',').map(s => s.trim()).filter(Boolean).join(',');

    const added = [];
    const duplicates = [];
    const failed = [];
    for (const f of files) {
      try {
        const { video, duplicate } = await ingest({
          srcPath: f.path,
          origName: Buffer.from(f.originalname, 'latin1').toString('utf8'),
          space,
          shootDate,
          uploaderId: req.user.id,
          source: 'upload',
          removeSource: true,
          title: req.body.title ? String(req.body.title).slice(0, 120) : null,
          requestId,
          tags,
        });
        (duplicate ? duplicates : added).push(video);
      } catch (e) {
        failed.push({ name: f.originalname, error: e.message });
        try { fs.unlinkSync(f.path); } catch { /* ignore */ }
      }
    }
    res.status(added.length ? 201 : 200).json({
      added: added.length, duplicates: duplicates.length, failed,
      items: added,
    });
  });
});

r.patch('/videos/:id', requireUser, (req, res) => {
  const v = db.prepare('SELECT * FROM videos WHERE id = ?').get(req.params.id);
  if (!v) return res.status(404).json({ error: '视频不存在' });
  const b = req.body || {};
  const ratingGiven = b.rating !== undefined && b.rating !== null && b.rating !== '';
  const rating = ratingGiven ? Math.max(0, Math.min(5, Math.round(Number(b.rating) || 0))) : v.rating;
  const next = {
    title: b.title !== undefined ? String(b.title).slice(0, 120) : v.title,
    status: ['new', 'picked', 'archived'].includes(b.status) ? b.status : v.status,
    tags: b.tags !== undefined
      ? String(b.tags).split(',').map(s => s.trim()).filter(Boolean).join(',')
      : v.tags,
    request_id: b.requestId !== undefined ? (b.requestId || null) : v.request_id,
    shoot_date: /^\d{4}-\d{2}-\d{2}$/.test(b.shootDate || '') ? b.shootDate : v.shoot_date,
    space: b.space === 'library' || b.space === 'daily' ? b.space : v.space,
    rating,
    rated_by: ratingGiven ? (rating > 0 ? req.user.id : null) : v.rated_by,
  };
  db.prepare(`UPDATE videos SET title=@title,status=@status,tags=@tags,request_id=@request_id,
    shoot_date=@shoot_date,space=@space,rating=@rating,rated_by=@rated_by,updated_at=@updated_at WHERE id=@id`)
    .run({ ...next, updated_at: Date.now(), id: v.id });
  res.json({ video: db.prepare(`${LIST_SELECT} WHERE v.id = ?`).get(v.id) });
});

r.delete('/videos/:id', requireUser, (req, res) => {
  const v = db.prepare('SELECT * FROM videos WHERE id = ?').get(req.params.id);
  if (!v) return res.status(404).json({ error: '视频不存在' });
  if (req.user.role !== 'admin' && v.uploader_id !== req.user.id) {
    return res.status(403).json({ error: '只有上传者或管理员可以删除' });
  }
  db.prepare('DELETE FROM videos WHERE id = ?').run(v.id);
  for (const rel of [v.file_path, v.thumb_path].filter(Boolean)) {
    try { fs.unlinkSync(path.join(config.mediaDir, rel)); } catch { /* ignore */ }
  }
  res.json({ ok: true });
});

// 批量评分 / 批量改状态
r.post('/videos/bulk-rate', requireUser, (req, res) => {
  const ids = (req.body?.ids || []).filter(Boolean);
  const rating = Math.max(0, Math.min(5, Math.round(Number(req.body?.rating) || 0)));
  if (!ids.length) return res.status(400).json({ error: '未选择视频' });
  const stmt = db.prepare('UPDATE videos SET rating = ?, rated_by = ?, updated_at = ? WHERE id = ?');
  const now = Date.now();
  const by = rating > 0 ? req.user.id : null;
  const tx = db.transaction(() => ids.forEach(id => stmt.run(rating, by, now, id)));
  tx();
  res.json({ ok: true, count: ids.length, rating });
});

r.post('/videos/bulk-status', requireUser, (req, res) => {
  const ids = (req.body?.ids || []).filter(Boolean);
  const status = req.body?.status;
  if (!ids.length) return res.status(400).json({ error: '未选择视频' });
  if (!['new', 'picked', 'archived'].includes(status)) return res.status(400).json({ error: '状态不合法' });
  const stmt = db.prepare('UPDATE videos SET status = ?, updated_at = ? WHERE id = ?');
  const now = Date.now();
  const tx = db.transaction(() => ids.forEach(id => stmt.run(status, now, id)));
  tx();
  res.json({ ok: true, count: ids.length });
});

module.exports = r;
