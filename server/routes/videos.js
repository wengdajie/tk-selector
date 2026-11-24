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

const MEDIA_ROOT = path.resolve(config.mediaDir);
const MAX_BULK = 200;
const normalizeIds = raw => [...new Set((Array.isArray(raw) ? raw : []).filter(Boolean).map(String))];

/** 媒体相对路径越界保护：任何 ../ 逃逸都直接拒绝 */
function safeMediaPath(rel) {
  const abs = path.resolve(MEDIA_ROOT, String(rel || ''));
  if (abs !== MEDIA_ROOT && !abs.startsWith(MEDIA_ROOT + path.sep)) throw new Error('媒体路径越界');
  return abs;
}

/** 移动/删除权限：仅上传者本人或管理员 */
const canMove = (user, v) => !!user && (user.role === 'admin' || String(v.uploader_id) === String(user.id));
const MOVE_DENIED = '只能移动自己上传的素材，或由管理员操作';

/**
 * 把原片从 media/<旧空间>/<日期>/ 迁到 media/<新空间>/<日期>/。
 * 源文件不存在直接失败——绝不「假装搬成功」把 DB 改成指向不存在的文件。
 * 跨盘 EXDEV 退化为复制后删除，并记录策略供回滚复用；同名加 -movedN 不覆盖。
 */
function relocateVideoFile(v, space, date) {
  const oldRel = v.file_path;
  if (!oldRel) throw new Error('该素材没有原片路径，无法移动');
  const oldAbs = safeMediaPath(oldRel);
  if (!fs.existsSync(oldAbs) || !fs.statSync(oldAbs).isFile()) throw new Error('原片文件不存在，无法移动');
  const useDate = /^\d{4}-\d{2}-\d{2}$/.test(date || '')
    ? date
    : (/^\d{4}-\d{2}-\d{2}$/.test(v.shoot_date || '') ? v.shoot_date : ymd());
  const destDir = path.join(MEDIA_ROOT, space, useDate);
  fs.mkdirSync(destDir, { recursive: true });
  const base = path.basename(oldRel);
  const ext = path.extname(base);
  const stem = ext ? base.slice(0, -ext.length) : base;
  let destAbs = path.join(destDir, base);
  for (let i = 1; fs.existsSync(destAbs); i++) destAbs = path.join(destDir, `${stem}-moved${i}${ext}`);
  let strategy = 'rename';
  try { fs.renameSync(oldAbs, destAbs); }
  catch (e) {
    if (e.code !== 'EXDEV') throw e;
    strategy = 'copy';
    fs.copyFileSync(oldAbs, destAbs);
    fs.unlinkSync(oldAbs);
  }
  return {
    from: oldAbs, to: destAbs, strategy,
    rel: path.relative(MEDIA_ROOT, destAbs).split(path.sep).join('/'),
  };
}

/** 进素材库不体检；回每日选片则重新排队体检 */
const movedQcStatus = (v, space) =>
  space === 'library' ? 'skipped' : (v.qc_status === 'skipped' ? 'pending' : v.qc_status);

/** 回每日选片时清掉上一轮体检结论，避免新体检完成前展示过期数据 */
const QC_RESET_SQL = `qc_score=NULL, qc_flags='', phash=NULL, sim_of=NULL, sim_dist=NULL,
  lufs=NULL, peak_db=NULL, black_pct=NULL, freeze_pct=NULL, crop=NULL`;

/** 事务失败时按去程策略回滚；任何回滚失败都要打日志，禁止静默吞错 */
function undoMoves(moved) {
  let errors = 0;
  for (const m of moved.slice().reverse()) {
    try {
      if (m.strategy === 'copy') {
        if (fs.existsSync(m.to)) { fs.copyFileSync(m.to, m.from); fs.unlinkSync(m.to); }
      } else if (fs.existsSync(m.to) && !fs.existsSync(m.from)) {
        fs.renameSync(m.to, m.from);
      }
    } catch (e) {
      errors++;
      console.error('[move] 回滚失败:', m.from, '=>', m.to, e.message);
    }
  }
  return errors;
}

/** 单条 / 批量删除共用的数据库级联（必须在事务里调用） */
function deleteVideoCascade(v) {
  const scripts = db.prepare('SELECT id, frames FROM scripts WHERE video_id = ?').all(v.id);
  db.prepare('DELETE FROM scripts WHERE video_id = ?').run(v.id);
  // 不依赖 frames 字段：正在跑的脚本可能还没写入帧路径
  const frameDirs = new Set(scripts.map(s => `s-${s.id}`));
  for (const s of scripts) {
    try {
      for (const f of s.frames ? JSON.parse(s.frames) : []) {
        const d = String(f?.path || '').split('/')[1];
        if (d && d.startsWith('s-')) frameDirs.add(d);
      }
    } catch { /* 帧字段损坏就跳过 */ }
  }
  // 扫描记录解除关联，否则 SCAN_MODE=copy 时同一源文件会被永久跳过
  db.prepare('UPDATE scan_files SET video_id = NULL WHERE video_id = ?').run(v.id);
  // 相似素材引用置空，避免详情页 similar 查询断裂
  db.prepare('UPDATE videos SET sim_of = NULL, sim_dist = NULL WHERE sim_of = ?').run(v.id);
  db.prepare('DELETE FROM videos WHERE id = ?').run(v.id);
  return { frameDirs: [...frameDirs], files: [v.file_path, v.thumb_path].filter(Boolean) };
}

/** 文件清理放在 DB 提交之后；失败不静默，返回残留清单 */
function cleanupVideoFiles(v, plan) {
  const failed = [];
  for (const d of plan.frameDirs) {
    try { fs.rmSync(path.join(MEDIA_ROOT, 'frames', d), { recursive: true, force: true }); }
    catch (e) { failed.push(`frames/${d}`); console.error('[delete] 关键帧目录清理失败:', d, e.message); }
  }
  for (const rel of plan.files) {
    try { fs.unlinkSync(safeMediaPath(rel)); }
    catch (e) {
      if (e.code !== 'ENOENT') { failed.push(rel); console.error('[delete] 文件清理失败:', rel, e.message); }
    }
  }
  try { require('../lib/proxy').dropOne(v.id); }
  catch (e) { failed.push(`proxies/${v.id}.mp4`); console.error('[delete] 播放版清理失败:', e.message); }
  return failed;
}

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
  const wantStage = normStage(b.stage);
  const wantSpace = b.space === 'library' || b.space === 'daily' ? b.space : null;
  const stageChanged = !!wantStage && wantStage !== v.stage;
  const spaceChanged = !!wantSpace && wantSpace !== v.space;
  // 「移动」类改动（阶段 / 空间）只允许上传者本人或管理员；其它字段维持原有协作口径
  if ((stageChanged || spaceChanged) && !canMove(req.user, v)) {
    return res.status(403).json({ error: MOVE_DENIED });
  }
  const ratingGiven = b.rating !== undefined && b.rating !== null && b.rating !== '';
  const rating = ratingGiven ? Math.max(0, Math.min(5, Math.round(Number(b.rating) || 0))) : v.rating;
  const stage = wantStage || v.stage || 'new';
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
    space: wantSpace || v.space,
    rating,
    rated_by: ratingGiven ? (rating > 0 ? req.user.id : null) : v.rated_by,
    stage,
    scores: Object.keys(scores).length ? JSON.stringify(scores) : '',
    score_content: content,
  };
  let filePath = v.file_path;
  let qcStatus = v.qc_status;
  let qcReset = '';
  if (spaceChanged) {
    qcStatus = movedQcStatus(v, next.space);
    if (next.space === 'daily') qcReset = ', ' + QC_RESET_SQL;
  }
  const moved = [];
  const now = Date.now();
  // 文件搬迁与 DB 更新同生共死：DB 失败就按策略把原片搬回原位
  try {
    db.transaction(() => {
      if (spaceChanged) {
        const m = relocateVideoFile(v, next.space, next.shoot_date);
        moved.push(m);
        filePath = m.rel;
      }
      const info = db.prepare(`UPDATE videos SET title=@title,status=@status,tags=@tags,request_id=@request_id,
        shoot_date=@shoot_date,space=@space,rating=@rating,rated_by=@rated_by,
        stage=@stage,scores=@scores,score_content=@score_content,file_path=@file_path,
        qc_status=@qc_status${qcReset},updated_at=@updated_at
        WHERE id=@id AND updated_at=@oldUpdated AND file_path=@oldPath`)
        .run({ ...next, file_path: filePath, qc_status: qcStatus, updated_at: now,
          oldUpdated: v.updated_at, oldPath: v.file_path, id: v.id });
      if (info.changes !== 1) throw new Error('素材已被其他人修改，请刷新后重试');
    })();
  } catch (e) {
    const undoErrors = undoMoves(moved);
    return res.status(500).json({
      error: '移动失败：' + (e.message || '未知错误') + (undoErrors ? `（${undoErrors} 个文件回滚失败，详见日志）` : ''),
    });
  }
  if (spaceChanged && next.space === 'daily') require('../lib/qcworker').tick().catch(() => {});
  res.json({ video: shape(db.prepare(`${LIST_SELECT} WHERE v.id = ?`).get(v.id)) });
});

r.delete('/videos/:id', requireUser, (req, res) => {
  const v = db.prepare('SELECT * FROM videos WHERE id = ?').get(req.params.id);
  if (!v) return res.status(404).json({ error: '视频不存在' });
  if (!canMove(req.user, v)) return res.status(403).json({ error: '只有上传者或管理员可以删除' });
  let plan;
  try { db.transaction(() => { plan = deleteVideoCascade(v); })(); }
  catch (e) { return res.status(500).json({ error: '删除失败：' + (e.message || '未知错误') }); }
  const failed = cleanupVideoFiles(v, plan);
  res.json({ ok: true, failedCleanup: failed });
});

/** 批量删除：与单条共用级联逻辑，全量预检后才动手，不存在「删一半」 */
r.post('/videos/bulk-delete', requireUser, (req, res) => {
  const ids = normalizeIds(req.body?.ids);
  if (!ids.length) return res.status(400).json({ error: '未选择视频' });
  if (ids.length > MAX_BULK) return res.status(400).json({ error: `单次最多删除 ${MAX_BULK} 条` });
  const rows = ids.map(id => db.prepare('SELECT * FROM videos WHERE id = ?').get(id));
  if (rows.some(v => !v)) return res.status(404).json({ error: '部分视频不存在' });
  if (rows.some(v => !canMove(req.user, v))) {
    return res.status(403).json({ error: '只能删除自己上传的素材，或由管理员操作' });
  }
  const plans = [];
  try { db.transaction(() => { for (const v of rows) plans.push(deleteVideoCascade(v)); })(); }
  catch (e) { return res.status(500).json({ error: '批量删除失败：' + (e.message || '未知错误') }); }
  const failedCleanup = [];
  rows.forEach((v, i) => failedCleanup.push(...cleanupVideoFiles(v, plans[i]).map(f => `${v.id}: ${f}`)));
  res.json({ ok: true, count: rows.length, failedCleanup });
});

// 批量评分 / 批量改状态（统一去重、上限与真实变更数）
r.post('/videos/bulk-rate', requireUser, (req, res) => {
  const ids = normalizeIds(req.body?.ids);
  const rating = Math.max(0, Math.min(5, Math.round(Number(req.body?.rating) || 0)));
  if (!ids.length) return res.status(400).json({ error: '未选择视频' });
  if (ids.length > MAX_BULK) return res.status(400).json({ error: `单次最多处理 ${MAX_BULK} 条` });
  if (ids.some(id => !db.prepare('SELECT 1 FROM videos WHERE id = ?').get(id))) {
    return res.status(404).json({ error: '部分视频不存在' });
  }
  const stmt = db.prepare('UPDATE videos SET rating = ?, rated_by = ?, updated_at = ? WHERE id = ?');
  const now = Date.now();
  const by = rating > 0 ? req.user.id : null;
  let changed = 0;
  db.transaction(() => { for (const id of ids) changed += stmt.run(rating, by, now, id).changes; })();
  res.json({ ok: true, count: changed, requested: ids.length, changed, rating });
});

r.post('/videos/bulk-status', requireUser, (req, res) => {
  const ids = normalizeIds(req.body?.ids);
  const status = req.body?.status;
  if (!ids.length) return res.status(400).json({ error: '未选择视频' });
  if (ids.length > MAX_BULK) return res.status(400).json({ error: `单次最多处理 ${MAX_BULK} 条` });
  if (!['new', 'picked', 'archived'].includes(status)) return res.status(400).json({ error: '状态不合法' });
  if (ids.some(id => !db.prepare('SELECT 1 FROM videos WHERE id = ?').get(id))) {
    return res.status(404).json({ error: '部分视频不存在' });
  }
  const stmt = db.prepare('UPDATE videos SET status = ?, updated_at = ? WHERE id = ?');
  const now = Date.now();
  let changed = 0;
  db.transaction(() => { for (const id of ids) changed += stmt.run(status, now, id).changes; })();
  res.json({ ok: true, count: changed, requested: ids.length, changed });
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

/** 批量体检：把选中的每日选片素材重新排队，素材库条目明确跳过 */
r.post('/videos/bulk-qc', requireUser, (req, res) => {
  const ids = normalizeIds(req.body?.ids);
  if (!ids.length) return res.status(400).json({ error: '未选择视频' });
  if (ids.length > MAX_BULK) return res.status(400).json({ error: `单次最多处理 ${MAX_BULK} 条` });
  const rows = ids.map(id => db.prepare('SELECT id, space FROM videos WHERE id = ?').get(id));
  const skipped = ids.filter((id, i) => !rows[i] || rows[i].space !== 'daily');
  const targets = ids.filter((id, i) => rows[i]?.space === 'daily');
  const stmt = db.prepare("UPDATE videos SET qc_status='pending', qc_score=NULL, qc_flags='' WHERE id = ?");
  let changed = 0;
  db.transaction(() => { for (const id of targets) changed += stmt.run(id).changes; })();
  if (changed) require('../lib/qcworker').tick().catch(() => {});
  res.json({ ok: true, count: changed, requested: ids.length, changed, skipped });
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

/**
 * 统一移动：一次请求里可同时改阶段和跨空间。
 * 跨空间会同步迁移原片物理文件、修正 file_path，并按目标空间重算体检状态。
 * 权限先全量预检，禁止「部分成功」的半吊子写入。
 */
r.post('/videos/bulk-move', requireUser, (req, res) => {
  const ids = normalizeIds(req.body?.ids);
  const wantStage = req.body?.stage !== undefined && req.body?.stage !== null && req.body?.stage !== '';
  const stage = wantStage ? normStage(req.body.stage) : null;
  const space = ['daily', 'library'].includes(req.body?.space) ? req.body.space : null;
  if (!ids.length) return res.status(400).json({ error: '未选择视频' });
  if (ids.length > MAX_BULK) return res.status(400).json({ error: `单次最多移动 ${MAX_BULK} 条` });
  if (!stage && !space) return res.status(400).json({ error: '请指定目标阶段或目标空间' });
  if (wantStage && !stage) return res.status(400).json({ error: '阶段不合法' });

  const rows = ids.map(id => db.prepare('SELECT * FROM videos WHERE id = ?').get(id));
  if (rows.some(v => !v)) return res.status(404).json({ error: '部分视频不存在' });
  if (rows.some(v => !canMove(req.user, v))) return res.status(403).json({ error: MOVE_DENIED });

  const base = `UPDATE videos SET space=@space, stage=@stage, file_path=@file_path,
    qc_status=@qc_status`;
  const upd = db.prepare(`${base}, updated_at=@updated_at
    WHERE id=@id AND updated_at=@oldUpdated AND file_path=@oldPath`);
  const updReset = db.prepare(`${base}, ${QC_RESET_SQL}, updated_at=@updated_at
    WHERE id=@id AND updated_at=@oldUpdated AND file_path=@oldPath`);

  const moved = [];
  let backToDaily = false;
  try {
    db.transaction(() => {
      const now = Date.now();
      for (const v of rows) {
        let filePath = v.file_path || '';
        let qcStatus = v.qc_status;
        let nextSpace = v.space;
        let reset = false;
        if (space && space !== v.space) {
          const m = relocateVideoFile(v, space, v.shoot_date);
          moved.push(m);
          filePath = m.rel;
          qcStatus = movedQcStatus(v, space);
          nextSpace = space;
          reset = space === 'daily';
          if (reset) backToDaily = true;
        }
        const params = {
          space: nextSpace,
          stage: stage || v.stage || 'new',
          file_path: filePath,
          qc_status: qcStatus,
          updated_at: now,
          oldUpdated: v.updated_at,
          oldPath: v.file_path,
          id: v.id,
        };
        // 乐观锁：预检之后被别人改过就整批失败并回滚文件
        if ((reset ? updReset : upd).run(params).changes !== 1) {
          throw new Error('有素材已被其他人修改，请刷新后重试');
        }
      }
    })();
  } catch (e) {
    const undoErrors = undoMoves(moved);
    return res.status(500).json({
      error: '移动失败：' + (e.message || '未知错误') + (undoErrors ? `（${undoErrors} 个文件回滚失败，详见日志）` : ''),
    });
  }
  if (backToDaily) require('../lib/qcworker').tick().catch(() => {});
  res.json({ ok: true, count: ids.length, stage, space });
});

/** 批量改阶段（兼容旧调用；权限口径与 bulk-move 一致） */
r.post('/videos/bulk-stage', requireUser, (req, res) => {
  const ids = normalizeIds(req.body?.ids);
  const stage = normStage(req.body?.stage);
  if (!ids.length) return res.status(400).json({ error: '未选择视频' });
  if (ids.length > MAX_BULK) return res.status(400).json({ error: `单次最多处理 ${MAX_BULK} 条` });
  if (!stage) return res.status(400).json({ error: '阶段不合法' });
  const rows = ids.map(id => db.prepare('SELECT * FROM videos WHERE id = ?').get(id));
  if (rows.some(v => !v)) return res.status(404).json({ error: '部分视频不存在' });
  if (rows.some(v => !canMove(req.user, v))) return res.status(403).json({ error: MOVE_DENIED });
  const stmt = db.prepare('UPDATE videos SET stage = ?, updated_at = ? WHERE id = ?');
  const now = Date.now();
  db.transaction(() => rows.forEach(v => stmt.run(stage, now, v.id)))();
  res.json({ ok: true, count: ids.length, stage });
});

module.exports = r;
