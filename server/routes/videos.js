'use strict';
const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const db = require('../db');
const config = require('../config');
const media = require('../lib/media');
const notify = require('../lib/notify');
const { ingest } = require('../lib/store');
const { requireUser, requireAdmin } = require('../middleware');
const { uuid, ymd, safeName } = require('../lib/util');
const { STAGES, STAGE_KEYS, DIMS, normalizeScores, contentScore, normStage } = require('../lib/scoring');

const r = express.Router();

const safeParseScores = s => {
  if (!s) return {};
  if (typeof s === 'object') return s;
  try { return JSON.parse(s); } catch { return {}; }
};
/** 对外统一把 scores 序列化成对象，避免调用方再解析字符串 */
const shape = v => (v ? { ...v, scores: safeParseScores(v.scores) } : v);

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

  // 投放体检筛选
  if (qs.qc === 'bad') add('(v.qc_status = \'done\' AND v.qc_score < 80)', 'qcBad', 1);
  if (qs.qc === 'ok') add('(v.qc_status = \'done\' AND v.qc_score >= 80)', 'qcOk', 1);
  if (qs.qc === 'pending') add("v.qc_status = 'pending'", 'qcPend', 1);
  if (qs.similar === '1') add('v.sim_of IS NOT NULL', 'sim', 1);
  if (qs.stage && STAGE_KEYS.includes(qs.stage)) add('v.stage = @stage', 'stage', qs.stage);
  if (qs.scored === '1') add('v.score_content IS NOT NULL', 'scored', 1);

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

  res.json({ items: items.map(shape), total, limit, offset, dates, tags });
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
  // 相似素材：它指向的 + 指向它的
  const similar = db.prepare(`
    SELECT id, title, orig_name, thumb_path, duration, rating, sim_dist FROM videos
    WHERE id = ? OR sim_of = ?
    ORDER BY (id = ?) DESC LIMIT 6
  `).all(v.sim_of || '', v.id, v.sim_of || '');
  res.json({ video: shape(v), comments, downloads, siblings, similar });
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

/** 播放版：优先 H.264 代理（手机流畅），没有就现转或先发原片 */
r.get('/videos/:id/play', requireUser, async (req, res) => {
  const v = db.prepare('SELECT * FROM videos WHERE id = ?').get(req.params.id);
  if (!v) return res.status(404).json({ error: '视频不存在' });
  const abs = path.join(config.mediaDir, v.file_path);
  if (!fs.existsSync(abs)) return res.status(410).json({ error: '源文件已被移动或删除' });
  const proxy = require('../lib/proxy');
  // 首次播放：最多等 4 秒，否则先发原片并告诉前端「正在转码」（前端会自动重试）
  if (!proxy.isReady(v.id) && proxy.needsProxy(v)) {
    await proxy.queue(v.id, { maxWaitMs: 4000 });
  }
  if (proxy.isReady(v.id)) {
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Cache-Control', 'private, max-age=604800');
    res.setHeader('X-Play-Source', 'proxy');
    return res.sendFile(proxy.proxyFile(v.id));
  }
  res.setHeader('Content-Type', v.mime);
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.setHeader('X-Play-Source', 'original');
  if (proxy.needsProxy(v)) res.setHeader('X-Proxy-Pending', '1');   // 前端据此继续重试
  return res.sendFile(abs);
});

/** 手动触发/排队播放版转码 */
r.post('/videos/:id/proxy', requireUser, requireAdmin, (req, res) => {
  const v = db.prepare('SELECT id FROM videos WHERE id = ?').get(req.params.id);
  if (!v) return res.status(404).json({ error: '视频不存在' });
  require('../lib/proxy').queue(v.id, { force: true }).catch(() => {});
  res.json({ ok: true, queued: true });
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
    // 群通知：新素材入库（fire-and-forget，失败只记日志）
    if (added.length) notify.onUpload(added, req.user);
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
  const stage = normStage(b.stage) || v.stage || 'new';
  const scoresGiven = b.scores !== undefined;
  const scores = scoresGiven
    ? { ...safeParseScores(v.scores), ...normalizeScores(b.scores) }
    : safeParseScores(v.scores);
  const content = contentScore(scores);
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
    stage,
    scores: Object.keys(scores).length ? JSON.stringify(scores) : '',
    score_content: content,
  };
  db.prepare(`UPDATE videos SET title=@title,status=@status,tags=@tags,request_id=@request_id,
    shoot_date=@shoot_date,space=@space,rating=@rating,rated_by=@rated_by,
    stage=@stage,scores=@scores,score_content=@score_content,updated_at=@updated_at WHERE id=@id`)
    .run({ ...next, updated_at: Date.now(), id: v.id });
  res.json({ video: shape(db.prepare(`${LIST_SELECT} WHERE v.id = ?`).get(v.id)) });
});

r.delete('/videos/:id', requireUser, (req, res) => {
  const v = db.prepare('SELECT * FROM videos WHERE id = ?').get(req.params.id);
  if (!v) return res.status(404).json({ error: '视频不存在' });
  if (req.user.role !== 'admin' && v.uploader_id !== req.user.id) {
    return res.status(403).json({ error: '只有上传者或管理员可以删除' });
  }
  // 级联：素材没了，挂在它名下的脚本（含脚本专属关键帧目录）一起清掉，避免孤儿数据与磁盘泄漏
  const scripts = db.prepare('SELECT id, frames FROM scripts WHERE video_id = ?').all(v.id);
  db.prepare('DELETE FROM scripts WHERE video_id = ?').run(v.id);
  const frameDirs = new Set();
  for (const s of scripts) {
    try {
      for (const f of s.frames ? JSON.parse(s.frames) : []) {
        const d = String(f?.path || '').split('/')[1];
        if (d && d.startsWith('s-')) frameDirs.add(d);
      }
    } catch { /* 帧字段损坏就跳过 */ }
  }
  for (const d of frameDirs) {
    try { fs.rmSync(path.join(config.mediaDir, 'frames', d), { recursive: true, force: true }); }
    catch { /* ignore */ }
  }
  db.prepare('DELETE FROM videos WHERE id = ?').run(v.id);
  for (const rel of [v.file_path, v.thumb_path].filter(Boolean)) {
    try { fs.unlinkSync(path.join(config.mediaDir, rel)); } catch { /* ignore */ }
  }
  // 播放版（代理）跟着一起删，否则磁盘只增不减
  try { require('../lib/proxy').dropOne(v.id); } catch { /* ignore */ }
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

/** 单条素材立即体检（详情页按钮） */
r.post('/videos/:id/qc', requireUser, async (req, res) => {
  try {
    const row = db.prepare('SELECT space FROM videos WHERE id = ?').get(req.params.id);
    if (row?.space === 'library') return res.status(400).json({ error: '素材库资料不参与投放体检（只有每日选片的素材需要）' });
    const { runOne } = require('../lib/qcworker');
    const out = await runOne(req.params.id);
    if (!out.ok) return res.status(404).json({ error: out.error });
    res.json({ video: out.video });
  } catch (e) {
    res.status(500).json({ error: e.message || '体检失败' });
  }
});

/** 批量体检：把选中的素材重新排队 */
r.post('/videos/bulk-qc', requireUser, (req, res) => {
  const ids = (req.body?.ids || []).filter(Boolean);
  if (!ids.length) return res.status(400).json({ error: '未选择视频' });
  // 素材库资料不参与体检
  const stmt = db.prepare("UPDATE videos SET qc_status='pending' WHERE id = ? AND space = 'daily'");
  const tx = db.transaction(() => ids.forEach(id => stmt.run(id)));
  tx();
  require('../lib/qcworker').tick().catch(() => {});
  res.json({ ok: true, count: ids.length });
});

/** 选片清单导出（投放 / 剪辑交接用） */
r.get('/export.csv', requireUser, (req, res) => {
  const ids = String(req.query.ids || '').split(',').map(s => s.trim()).filter(Boolean);
  let rows;
  if (ids.length) {
    const marks = ids.map(() => '?').join(',');
    rows = db.prepare(`${LIST_SELECT} WHERE v.id IN (${marks}) ORDER BY v.shoot_date DESC, v.created_at DESC`).all(...ids);
  } else {
    const { clause, params } = buildFilter(req.query);
    rows = db.prepare(`${LIST_SELECT} ${clause} ORDER BY v.shoot_date DESC, v.created_at DESC LIMIT 500`).all(params);
  }

  const FLAG_LABEL = {
    noaudio: '无音轨', lowres: '分辨率偏低', lowbitrate: '码率偏低', quiet: '响度偏低',
    loud: '响度偏高', letterbox: '有黑边', frozen: '画面静止', tooshort: '时长过短',
    toolong: '时长过长', noth264: '非H.264', blackframes: '含黑场', qcfailed: '体检失败',
  };
  const head = ['素材ID', '标题', '拍摄日期', '时长(秒)', '分辨率', '编码', '码率(kbps)', '帧率',
    '评分', '评论数', '下载次数', '体检分', '体检问题', '疑似重复', '上传人', '原文件名'];
  const lines = [head.join(',')];
  for (const v of rows) {
    const flags = String(v.qc_flags || '').split(',').filter(Boolean).map(f => FLAG_LABEL[f] || f).join(' / ');
    lines.push([
      v.id, v.title || '', v.shoot_date || '', Math.round(v.duration || 0),
      v.width && v.height ? `${v.width}x${v.height}` : '',
      v.codec || '', Math.round((v.bitrate || 0) / 1000), v.fps || '',
      v.rating || 0, v.comment_count || 0, v.download_count || 0,
      v.qc_score == null ? '' : v.qc_score, flags,
      v.sim_of ? '是' : '', v.uploader_name || '', v.orig_name || '',
    ].map(x => `"${String(x).replace(/"/g, '""')}"`).join(','));
  }
  const csv = '\uFEFF' + lines.join('\r\n');
  const name = `TK选片清单_${ymd()}.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="tk-selection-${ymd()}.csv"; filename*=UTF-8''${encodeURIComponent(name)}`);
  res.send(csv);
});

/** 选片流水线：各阶段数量、转化率、各维度均分 */
r.get('/pipeline', requireUser, (req, res) => {
  const space = req.query.space;
  const where = space === 'library' || space === 'daily' ? 'WHERE v.space = @space' : '';
  const params = where ? { space } : {};

  const counts = {};
  for (const row of db.prepare(`SELECT v.stage AS s, COUNT(*) c FROM videos v ${where} GROUP BY v.stage`).all(params)) {
    counts[row.s] = row.c;
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);

  const stages = STAGES.map(s => ({
    key: s.key,
    label: s.label,
    hint: s.hint,
    count: counts[s.key] || 0,
    pct: total ? Math.round((counts[s.key] || 0) / total * 100) : 0,
  }));

  // 通过率：定稿 / 已评审（排除新入库）
  const reviewed = total - (counts.new || 0);
  const passRate = reviewed > 0 ? Math.round((counts.final || 0) / reviewed * 100) : 0;

  const dims = DIMS.map(d => {
    const rows = db.prepare(
      `SELECT v.scores FROM videos v ${where ? where + ' AND' : 'WHERE'} v.scores <> ''`
    ).all(params);
    const vals = [];
    for (const row of rows) {
      const sc = safeParseScores(row.scores);
      if (Number.isFinite(Number(sc[d.key])) && Number(sc[d.key]) > 0) vals.push(Number(sc[d.key]));
    }
    return {
      key: d.key,
      label: d.label,
      hint: d.hint,
      avg: vals.length ? Number((vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(1)) : null,
      count: vals.length,
    };
  });

  const scored = db.prepare(
    `SELECT COUNT(*) c FROM videos v ${where ? where + ' AND' : 'WHERE'} v.score_content IS NOT NULL`
  ).get(params).c;

  res.json({ total, stages, passRate, scored, dims });
});

/** 批量改阶段 */
r.post('/videos/bulk-stage', requireUser, (req, res) => {
  const ids = (req.body?.ids || []).filter(Boolean);
  const stage = normStage(req.body?.stage);
  if (!ids.length) return res.status(400).json({ error: '未选择视频' });
  if (!stage) return res.status(400).json({ error: '阶段不合法' });
  const stmt = db.prepare('UPDATE videos SET stage = ?, updated_at = ? WHERE id = ?');
  const now = Date.now();
  const tx = db.transaction(() => ids.forEach(id => stmt.run(stage, now, id)));
  tx();
  res.json({ ok: true, count: ids.length, stage });
});

module.exports = r;
