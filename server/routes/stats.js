'use strict';
const express = require('express');
const db = require('../db');
const config = require('../config');
const { requireUser } = require('../middleware');
const { ymd } = require('../lib/util');
const scanner = require('../lib/scanner');

const r = express.Router();

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

r.get('/stats', requireUser, (req, res) => {
  const today = ymd();
  const sot = startOfToday();
  const one = (sql, ...p) => db.prepare(sql).get(...p)?.c || 0;

  res.json({
    today,
    scanDir: config.scanDir,
    scanMode: config.scanMode,
    dailyToday: one("SELECT COUNT(*) c FROM videos WHERE space='daily' AND shoot_date=?", today),
    pending: one("SELECT COUNT(*) c FROM videos WHERE space='daily' AND status='new'"),
    library: one("SELECT COUNT(*) c FROM videos WHERE space='library'"),
    requestsOpen: one("SELECT COUNT(*) c FROM requests WHERE status IN ('open','claimed')"),
    requestsMine: one("SELECT COUNT(DISTINCT request_id) c FROM request_claims WHERE user_id=?", req.user.id),
    downloadsToday: one('SELECT COUNT(*) c FROM downloads WHERE created_at >= ?', sot),
    downloadsByMe: one('SELECT COUNT(*) c FROM downloads WHERE user_id=?', req.user.id),
    members: one('SELECT COUNT(*) c FROM users WHERE active=1'),
    commentsTotal: one('SELECT COUNT(*) c FROM comments'),
    scripts: one('SELECT COUNT(*) c FROM scripts'),
    scriptsDone: one("SELECT COUNT(*) c FROM scripts WHERE status='done'"),
    rated: one('SELECT COUNT(*) c FROM videos WHERE rating > 0'),
    avgRating: db.prepare('SELECT ROUND(AVG(rating),1) v FROM videos WHERE rating > 0').get()?.v || 0,
    starred5: one('SELECT COUNT(*) c FROM videos WHERE rating = 5'),
    storageBytes: one('SELECT COALESCE(SUM(size),0) c FROM videos'),
    scan: {
      running: scanner.state.running,
      lastRunAt: scanner.state.lastRunAt,
      lastResult: scanner.state.lastResult,
      lastError: scanner.state.lastError,
    },
  });
});

r.get('/stats/today-downloaders', requireUser, (req, res) => {
  const sot = startOfToday();
  const rows = db.prepare(`
    SELECT u.id, u.name, u.color, COUNT(*) AS count
    FROM downloads d JOIN users u ON u.id = d.user_id
    WHERE d.created_at >= ? GROUP BY u.id ORDER BY count DESC
  `).all(sot);
  res.json({ items: rows });
});

/* ---------------- 成员工作量（业绩分析） ---------------- */

const ROLES = ['shooter', 'ops', 'viewer', 'admin'];

/** 时间范围 → 毫秒区间；from/to 均为本地日期（YYYY-MM-DD） */
function rangeMs(from, to) {
  const f = from ? new Date(from + 'T00:00:00') : new Date(0);
  const t = to ? new Date(to + 'T23:59:59.999') : new Date();
  const a = Number.isNaN(f.getTime()) ? 0 : f.getTime();
  const b = Number.isNaN(t.getTime()) ? Date.now() : t.getTime();
  return a <= b ? [a, b] : [b, a];
}

/**
 * 成员工作量：素材产出 / 入选 / 定稿 / 评分 / 下载 / 评论 / 需求认领
 * 口径：全部按「记录产生时间」(created_at) 落在时间范围内统计，与空间、角色可组合筛选。
 */
function memberRows({ from, to, space, role }) {
  const [ms0, ms1] = rangeMs(from, to);
  const spaceOk = space === 'daily' || space === 'library';
  const sp = spaceOk ? ' AND space = ?' : '';
  const spV = spaceOk ? ' AND v.space = ?' : '';
  const p = spaceOk ? [ms0, ms1, space] : [ms0, ms1];

  const users = db.prepare('SELECT id, name, color, role FROM users WHERE active = 1').all()
    .filter(u => role === 'all' || !ROLES.includes(role) ? true : u.role === role);
  const byId = new Map(users.map(u => [u.id, {
    id: u.id, name: u.name, color: u.color, role: u.role,
    uploads: 0, durationSec: 0, sizeBytes: 0, picked: 0, archived: 0, final: 0,
    avgRating: null, ratedCount: 0, downloadsMade: 0, downloadsReceived: 0,
    comments: 0, claims: 0, claimsDone: 0,
  }]));
  const touch = id => byId.get(id);

  for (const r of db.prepare(`SELECT uploader_id id, COUNT(*) n, COALESCE(SUM(duration),0) dur,
      COALESCE(SUM(size),0) size,
      SUM(CASE WHEN status='picked' THEN 1 ELSE 0 END) picked,
      SUM(CASE WHEN status='archived' THEN 1 ELSE 0 END) archived,
      SUM(CASE WHEN stage='final' THEN 1 ELSE 0 END) finalN,
      SUM(CASE WHEN rating>0 THEN rating ELSE 0 END) ratingSum,
      SUM(CASE WHEN rating>0 THEN 1 ELSE 0 END) ratingN
    FROM videos WHERE created_at BETWEEN ? AND ? ${sp} GROUP BY uploader_id`).all(...p)) {
    const u = touch(r.id); if (!u) continue;
    u.uploads = r.n; u.durationSec = r.dur; u.sizeBytes = r.size;
    u.picked = r.picked; u.archived = r.archived; u.final = r.finalN;
    u.ratedCount = r.ratingN;
    u.avgRating = r.ratingN ? Math.round((r.ratingSum / r.ratingN) * 10) / 10 : null;
  }
  for (const r of db.prepare('SELECT user_id id, COUNT(*) n FROM downloads WHERE created_at BETWEEN ? AND ? GROUP BY user_id').all(ms0, ms1)) {
    const u = touch(r.id); if (u) u.downloadsMade = r.n;
  }
  for (const r of db.prepare(`SELECT v.uploader_id id, COUNT(*) n FROM downloads d
      JOIN videos v ON v.id = d.video_id
      WHERE d.created_at BETWEEN ? AND ? ${spV} GROUP BY v.uploader_id`).all(...p)) {
    const u = touch(r.id); if (u) u.downloadsReceived = r.n;
  }
  for (const r of db.prepare('SELECT user_id id, COUNT(*) n FROM comments WHERE created_at BETWEEN ? AND ? GROUP BY user_id').all(ms0, ms1)) {
    const u = touch(r.id); if (u) u.comments = r.n;
  }
  for (const r of db.prepare('SELECT user_id id, COUNT(*) n FROM request_claims WHERE created_at BETWEEN ? AND ? GROUP BY user_id').all(ms0, ms1)) {
    const u = touch(r.id); if (u) u.claims = r.n;
  }
  for (const r of db.prepare(`SELECT c.user_id id, COUNT(*) n FROM request_claims c
      JOIN requests q ON q.id = c.request_id
      WHERE c.created_at BETWEEN ? AND ? AND q.status = 'done' GROUP BY c.user_id`).all(ms0, ms1)) {
    const u = touch(r.id); if (u) u.claimsDone = r.n;
  }

  const items = [...byId.values()].sort((a, b) => b.uploads - a.uploads || a.name.localeCompare(b.name));
  const totals = items.reduce((t, u) => ({
    uploads: t.uploads + u.uploads,
    durationSec: t.durationSec + u.durationSec,
    sizeBytes: t.sizeBytes + u.sizeBytes,
    picked: t.picked + u.picked,
    final: t.final + u.final,
    downloadsMade: t.downloadsMade + u.downloadsMade,
    downloadsReceived: t.downloadsReceived + u.downloadsReceived,
    comments: t.comments + u.comments,
    claims: t.claims + u.claims,
    claimsDone: t.claimsDone + u.claimsDone,
    ratedCount: t.ratedCount + u.ratedCount,
  }), {
    uploads: 0, durationSec: 0, sizeBytes: 0, picked: 0, final: 0,
    downloadsMade: 0, downloadsReceived: 0, comments: 0, claims: 0, claimsDone: 0, ratedCount: 0,
  });
  const allRated = items.filter(u => u.avgRating != null);
  totals.avgRating = allRated.length
    ? Math.round(allRated.reduce((s2, u) => s2 + u.avgRating, 0) / allRated.length * 10) / 10
    : null;

  return { from: from || null, to: to || null, space: space || 'all', role: role || 'all', items, totals };
}

r.get('/stats/members', requireUser, (req, res) => {
  const data = memberRows({
    from: String(req.query.from || '').slice(0, 10),
    to: String(req.query.to || '').slice(0, 10),
    space: String(req.query.space || 'all'),
    role: String(req.query.role || 'all'),
  });
  data.generatedAt = Date.now();
  res.json(data);
});

/** 同一份数据导出 CSV（业绩考核交接用） */
r.get('/stats/members.csv', requireUser, (req, res) => {
  const d = memberRows({
    from: String(req.query.from || '').slice(0, 10),
    to: String(req.query.to || '').slice(0, 10),
    space: String(req.query.space || 'all'),
    role: String(req.query.role || 'all'),
  });
  const roleName = { admin: '管理员', ops: '运营', shooter: '拍摄', viewer: '只读' };
  const head = ['成员', '角色', '素材条数', '总时长(分钟)', '总大小(GB)', '入选', '定稿', '平均评分', '评分数', '下载次数', '被下载次数', '评论数', '认领需求', '完成需求'];
  const lines = [head.join(',')];
  for (const u of d.items) {
    lines.push([
      u.name, roleName[u.role] || u.role, u.uploads,
      (u.durationSec / 60).toFixed(1), (u.sizeBytes / 1073741824).toFixed(2),
      u.picked, u.final, u.avgRating ?? '', u.ratedCount,
      u.downloadsMade, u.downloadsReceived, u.comments, u.claims, u.claimsDone,
    ].join(','));
  }
  lines.push(['合计', '', d.totals.uploads, (d.totals.durationSec / 60).toFixed(1),
    (d.totals.sizeBytes / 1073741824).toFixed(2), d.totals.picked, d.totals.final,
    d.totals.avgRating ?? '', d.totals.ratedCount, d.totals.downloadsMade,
    d.totals.downloadsReceived, d.totals.comments, d.totals.claims, d.totals.claimsDone].join(','));
  const name = `成员工作量_${d.from || '起始'}_${d.to || '至今'}.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="members.csv"; filename*=UTF-8''${encodeURIComponent(name)}`);
  res.send('\ufeff' + lines.join('\r\n'));
});

module.exports = r;
