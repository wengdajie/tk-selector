'use strict';
const express = require('express');
const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const db = require('../db');
const config = require('../config');
const { requireUser, requireAdmin } = require('../middleware');
const { uuid, ymd } = require('../lib/util');

const r = express.Router();

/** 创建下载批次：先落记录，再让浏览器去取文件 */
r.post('/downloads', requireUser, (req, res) => {
  const ids = [...new Set((req.body?.videoIds || []).filter(Boolean))];
  if (!ids.length) return res.status(400).json({ error: '请先选择视频' });
  const note = String(req.body?.note || '').slice(0, 200);
  const batchId = uuid();
  const now = Date.now();

  const getV = db.prepare('SELECT id, title, orig_name, file_path FROM videos WHERE id = ?');
  const ins = db.prepare(
    'INSERT INTO downloads (id,video_id,user_id,note,batch_id,created_at) VALUES (?,?,?,?,?,?)'
  );
  const valid = [];
  const tx = db.transaction(() => {
    for (const id of ids) {
      const v = getV.get(id);
      if (!v) continue;
      const abs = path.join(config.mediaDir, v.file_path);
      if (!fs.existsSync(abs)) continue;
      ins.run(uuid(), v.id, req.user.id, note, batchId, now);
      valid.push(v);
    }
  });
  tx();

  if (!valid.length) return res.status(400).json({ error: '所选视频的源文件都不存在了' });
  res.status(201).json({
    batchId,
    count: valid.length,
    skipped: ids.length - valid.length,
    downloadUrl: `/api/downloads/${batchId}/file`,
  });
});

r.get('/downloads/:batchId/file', requireUser, (req, res) => {
  const rows = db.prepare(`
    SELECT v.id, v.title, v.orig_name, v.file_path, v.mime
    FROM downloads d JOIN videos v ON v.id = d.video_id
    WHERE d.batch_id = ? GROUP BY v.id
  `).all(req.params.batchId);
  if (!rows.length) return res.status(404).json({ error: '下载批次不存在或已失效' });

  const files = rows
    .map(v => ({ ...v, abs: path.join(config.mediaDir, v.file_path) }))
    .filter(v => fs.existsSync(v.abs));
  if (!files.length) return res.status(410).json({ error: '源文件已被移动或删除' });

  if (files.length === 1) {
    const f = files[0];
    const name = f.orig_name || `${f.title}${path.extname(f.file_path) || '.mp4'}`;
    return res.download(f.abs, name);
  }

  const zipName = `TK选片_${ymd()}_${files.length}个.zip`;
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="tk-selection-${ymd()}.zip"; filename*=UTF-8''${encodeURIComponent(zipName)}`
  );
  const archive = archiver('zip', { zlib: { level: 0 } });
  archive.on('warning', err => console.warn('[zip]', err.message));
  archive.on('error', err => {
    console.error('[zip] 打包失败:', err.message);
    res.destroy(err);
  });
  archive.pipe(res);

  const used = new Map();
  for (const f of files) {
    let name = f.orig_name || `${f.title}${path.extname(f.file_path) || '.mp4'}`;
    const n = used.get(name) || 0;
    used.set(name, n + 1);
    if (n > 0) {
      const ext = path.extname(name);
      name = `${path.basename(name, ext)} (${n + 1})${ext}`;
    }
    archive.file(f.abs, { name });
  }
  archive.finalize();
});

r.get('/downloads', requireUser, requireAdmin, (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 80, 1), 300);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const where = [];
  const p = { limit, offset };
  if (req.query.mine === '1') { where.push('d.user_id = @uid'); p.uid = req.user.id; }
  if (req.query.userId) { where.push('d.user_id = @userId'); p.userId = req.query.userId; }
  if (req.query.videoId) { where.push('d.video_id = @videoId'); p.videoId = req.query.videoId; }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const rows = db.prepare(`
    SELECT d.id, d.batch_id, d.note, d.created_at, d.video_id, d.user_id,
           u.name AS user_name, u.color AS user_color,
           v.title AS video_title, v.thumb_path, v.duration, v.space, v.shoot_date
    FROM downloads d
    JOIN users u ON u.id = d.user_id
    JOIN videos v ON v.id = d.video_id
    ${clause}
    ORDER BY d.created_at DESC LIMIT @limit OFFSET @offset
  `).all(p);
  const total = db.prepare(`SELECT COUNT(*) c FROM downloads d ${clause}`).get(p).c;
  res.json({ items: rows, total, limit, offset });
});

r.get('/downloads/:batchId', requireUser, requireAdmin, (req, res) => {
  const rows = db.prepare(`
    SELECT d.*, u.name AS user_name, u.color AS user_color,
           v.title AS video_title, v.thumb_path, v.duration, v.orig_name
    FROM downloads d
    JOIN users u ON u.id = d.user_id
    JOIN videos v ON v.id = d.video_id
    WHERE d.batch_id = ? ORDER BY d.created_at
  `).all(req.params.batchId);
  if (!rows.length) return res.status(404).json({ error: '批次不存在' });
  res.json({ batchId: req.params.batchId, items: rows });
});

module.exports = r;
