'use strict';
const express = require('express');
const db = require('../db');
const config = require('../config');
const { requireUser } = require('../middleware');
const { ymd } = require('../lib/util');

const r = express.Router();

const DAY = 86400000;

/** 本地日期（容器 TZ 已是 Asia/Shanghai） */
function dayKey(ts) {
  const d = new Date(ts);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function startOfDay(back = 0) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime() - back * DAY;
}

const one = (sql, ...p) => db.prepare(sql).get(...p)?.c || 0;
const val = (sql, ...p) => db.prepare(sql).get(...p)?.v || 0;

/** 按天分组的计数，返回 map */
function byDay(sql, sinceTs) {
  const map = new Map();
  for (const row of db.prepare(sql).all(sinceTs)) map.set(row.d, row.c);
  return map;
}

r.get('/dashboard', requireUser, (req, res) => {
  const days = Math.min(60, Math.max(7, Number(req.query.days) || 14));
  const today = ymd();
  const sot = startOfDay(0);
  const week = startOfDay(6);
  const prevWeek = startOfDay(13);
  const month = startOfDay(29);
  const since = startOfDay(days - 1);

  // ---------- KPI ----------
  const videosTotal = one('SELECT COUNT(*) c FROM videos');
  const videosDaily = one("SELECT COUNT(*) c FROM videos WHERE space='daily'");
  const videosLibrary = one("SELECT COUNT(*) c FROM videos WHERE space='library'");
  const videosToday = one('SELECT COUNT(*) c FROM videos WHERE created_at >= ?', sot);
  const videosWeek = one('SELECT COUNT(*) c FROM videos WHERE created_at >= ?', week);
  const videosPrevWeek = one('SELECT COUNT(*) c FROM videos WHERE created_at >= ? AND created_at < ?', prevWeek, week);

  const reqTotal = one('SELECT COUNT(*) c FROM requests');
  const reqOpen = one("SELECT COUNT(*) c FROM requests WHERE status='open'");
  const reqClaimed = one("SELECT COUNT(*) c FROM requests WHERE status='claimed'");
  const reqDone = one("SELECT COUNT(*) c FROM requests WHERE status='done'");
  const reqDoneWeek = one("SELECT COUNT(*) c FROM requests WHERE status='done' AND updated_at >= ?", week);
  const reqDonePrevWeek = one("SELECT COUNT(*) c FROM requests WHERE status='done' AND updated_at >= ? AND updated_at < ?", prevWeek, week);
  const reqOverdue = one("SELECT COUNT(*) c FROM requests WHERE status IN ('open','claimed') AND due_date IS NOT NULL AND due_date < ?", today);

  const commentsTotal = one('SELECT COUNT(*) c FROM comments');
  const commentsToday = one('SELECT COUNT(*) c FROM comments WHERE created_at >= ?', sot);
  const commentsWeek = one('SELECT COUNT(*) c FROM comments WHERE created_at >= ?', week);
  const commentsPrevWeek = one('SELECT COUNT(*) c FROM comments WHERE created_at >= ? AND created_at < ?', prevWeek, week);
  const commentedVideos = one('SELECT COUNT(DISTINCT video_id) c FROM comments');

  const downloadsTotal = one('SELECT COUNT(*) c FROM downloads');
  const downloadsToday = one('SELECT COUNT(*) c FROM downloads WHERE created_at >= ?', sot);
  const downloadsWeek = one('SELECT COUNT(*) c FROM downloads WHERE created_at >= ?', week);
  const downloadsPrevWeek = one('SELECT COUNT(*) c FROM downloads WHERE created_at >= ? AND created_at < ?', prevWeek, week);
  const downloadedVideos = one('SELECT COUNT(DISTINCT video_id) c FROM downloads');

  const ratedCount = one('SELECT COUNT(*) c FROM videos WHERE rating > 0');
  const avgRating = Number(val('SELECT ROUND(AVG(rating),2) v FROM videos WHERE rating > 0'));
  const fiveStar = one('SELECT COUNT(*) c FROM videos WHERE rating = 5');
  const fourPlus = one('SELECT COUNT(*) c FROM videos WHERE rating >= 4');

  const members = one('SELECT COUNT(*) c FROM users WHERE active=1');
  const storageBytes = one('SELECT COALESCE(SUM(size),0) c FROM videos');
  const pickedCount = one("SELECT COUNT(*) c FROM videos WHERE status='picked'");

  // 投放体检
  const qcPending = one("SELECT COUNT(*) c FROM videos WHERE qc_status='pending'");
  const qcBad = one("SELECT COUNT(*) c FROM videos WHERE qc_status='done' AND qc_score < 80");
  const qcOk = one("SELECT COUNT(*) c FROM videos WHERE qc_status='done' AND qc_score >= 80");
  const qcAvg = Number(val("SELECT ROUND(AVG(qc_score),1) v FROM videos WHERE qc_status='done'"));
  const simCount = one('SELECT COUNT(*) c FROM videos WHERE sim_of IS NOT NULL');

  // 近 7 天有行为的成员（上传/评论/下载/评分/认领）
  const activeMembers = one(`
    SELECT COUNT(DISTINCT uid) c FROM (
      SELECT uploader_id uid FROM videos WHERE uploader_id IS NOT NULL AND created_at >= @w
      UNION SELECT user_id FROM comments WHERE created_at >= @w
      UNION SELECT user_id FROM downloads WHERE created_at >= @w
      UNION SELECT rated_by FROM videos WHERE rated_by IS NOT NULL AND updated_at >= @w
      UNION SELECT user_id FROM request_claims WHERE created_at >= @w
    )`, { w: week });

  // ---------- 趋势 ----------
  const upMap = byDay(`SELECT date(created_at/1000,'unixepoch','localtime') d, COUNT(*) c
                       FROM videos WHERE created_at >= ? GROUP BY d`, since);
  const cmMap = byDay(`SELECT date(created_at/1000,'unixepoch','localtime') d, COUNT(*) c
                       FROM comments WHERE created_at >= ? GROUP BY d`, since);
  const dlMap = byDay(`SELECT date(created_at/1000,'unixepoch','localtime') d, COUNT(*) c
                       FROM downloads WHERE created_at >= ? GROUP BY d`, since);
  const dnMap = byDay(`SELECT date(updated_at/1000,'unixepoch','localtime') d, COUNT(*) c
                       FROM requests WHERE status='done' AND updated_at >= ? GROUP BY d`, since);

  const trend = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = dayKey(startOfDay(i));
    trend.push({
      date: d,
      uploads: upMap.get(d) || 0,
      comments: cmMap.get(d) || 0,
      downloads: dlMap.get(d) || 0,
      done: dnMap.get(d) || 0,
    });
  }

  // ---------- 评分分布 ----------
  const distRows = db.prepare(`
    SELECT rating, COUNT(*) c FROM videos WHERE rating BETWEEN 1 AND 5 GROUP BY rating
  `).all();
  const distMap = new Map(distRows.map(x => [x.rating, x.c]));
  const ratingDist = [5, 4, 3, 2, 1].map(star => ({
    star, count: distMap.get(star) || 0,
    pct: ratedCount ? Math.round((distMap.get(star) || 0) / ratedCount * 100) : 0,
  }));

  // ---------- 高分素材 ----------
  const topVideos = db.prepare(`
    SELECT v.id, v.title, v.orig_name, v.thumb_path, v.rating, v.space,
           (SELECT COUNT(*) FROM comments c WHERE c.video_id = v.id) AS comments,
           (SELECT COUNT(*) FROM downloads d WHERE d.video_id = v.id) AS downloads,
           u.name AS uploader_name
    FROM videos v LEFT JOIN users u ON u.id = v.uploader_id
    WHERE v.rating > 0
    ORDER BY v.rating DESC, downloads DESC, v.updated_at DESC
    LIMIT 6
  `).all();

  // ---------- 团队活跃度 ----------
  const team = db.prepare(`
    SELECT u.id, u.name, u.color, u.role,
      (SELECT COUNT(*) FROM comments c WHERE c.user_id = u.id) AS comments,
      (SELECT COUNT(*) FROM downloads d WHERE d.user_id = u.id) AS downloads,
      (SELECT COUNT(*) FROM videos v WHERE v.rated_by = u.id) AS ratings,
      (SELECT COUNT(*) FROM videos v WHERE v.uploader_id = u.id) AS uploads,
      (SELECT COUNT(*) FROM request_claims rc WHERE rc.user_id = u.id) AS claims,
      (SELECT COUNT(DISTINCT r.id) FROM requests r JOIN request_claims rc ON rc.request_id = r.id
        WHERE rc.user_id = u.id AND r.status = 'done') AS done
    FROM users u WHERE u.active = 1
    ORDER BY (comments + downloads + ratings + uploads + claims) DESC, u.created_at
  `).all();

  // ---------- 动态流 ----------
  const recentComments = db.prepare(`
    SELECT 'comment' AS type, c.created_at AS at, u.name AS user_name, u.color AS user_color,
           c.body AS text, v.id AS video_id, COALESCE(NULLIF(v.title,''), v.orig_name) AS video_title
    FROM comments c JOIN users u ON u.id = c.user_id LEFT JOIN videos v ON v.id = c.video_id
    ORDER BY c.created_at DESC LIMIT 8
  `).all();
  const recentDownloads = db.prepare(`
    SELECT 'download' AS type, d.created_at AS at, u.name AS user_name, u.color AS user_color,
           '' AS text, v.id AS video_id, COALESCE(NULLIF(v.title,''), v.orig_name) AS video_title
    FROM downloads d JOIN users u ON u.id = d.user_id LEFT JOIN videos v ON v.id = d.video_id
    ORDER BY d.created_at DESC LIMIT 6
  `).all();
  const recentRatings = db.prepare(`
    SELECT 'rating' AS type, v.updated_at AS at, u.name AS user_name, u.color AS user_color,
           CAST(v.rating AS TEXT) AS text, v.id AS video_id,
           COALESCE(NULLIF(v.title,''), v.orig_name) AS video_title
    FROM videos v LEFT JOIN users u ON u.id = v.rated_by
    WHERE v.rated_by IS NOT NULL AND v.rating > 0
    ORDER BY v.updated_at DESC LIMIT 6
  `).all();
  const recentDone = db.prepare(`
    SELECT 'request' AS type, r.updated_at AS at, u.name AS user_name, u.color AS user_color,
           r.title AS text, NULL AS video_id, r.title AS video_title
    FROM requests r LEFT JOIN users u ON u.id = r.created_by
    WHERE r.status = 'done' ORDER BY r.updated_at DESC LIMIT 6
  `).all();
  const activity = [...recentComments, ...recentDownloads, ...recentRatings, ...recentDone]
    .sort((a, b) => b.at - a.at)
    .slice(0, 12);

  // ---------- 我的贡献 ----------
  const me = req.user.id;
  const mine = {
    comments: one('SELECT COUNT(*) c FROM comments WHERE user_id=?', me),
    downloads: one('SELECT COUNT(*) c FROM downloads WHERE user_id=?', me),
    ratings: one('SELECT COUNT(*) c FROM videos WHERE rated_by=?', me),
    uploads: one('SELECT COUNT(*) c FROM videos WHERE uploader_id=?', me),
    claims: one('SELECT COUNT(*) c FROM request_claims WHERE user_id=?', me),
    done: one(`SELECT COUNT(DISTINCT r.id) c FROM requests r
               JOIN request_claims rc ON rc.request_id = r.id
               WHERE rc.user_id=? AND r.status='done'`, me),
  };

  res.json({
    generatedAt: Date.now(),
    today,
    days,
    scanDir: config.scanDir,
    kpi: {
      videosTotal, videosDaily, videosLibrary, videosToday, videosWeek, videosPrevWeek,
      pics: pickedCount,
      requests: { total: reqTotal, open: reqOpen, claimed: reqClaimed, done: reqDone, doneWeek: reqDoneWeek, donePrevWeek: reqDonePrevWeek, overdue: reqOverdue },
      comments: { total: commentsTotal, today: commentsToday, week: commentsWeek, prevWeek: commentsPrevWeek, videos: commentedVideos },
      downloads: { total: downloadsTotal, today: downloadsToday, week: downloadsWeek, prevWeek: downloadsPrevWeek, videos: downloadedVideos },
      ratings: { rated: ratedCount, avg: avgRating, five: fiveStar, fourPlus, coverage: videosTotal ? Math.round(ratedCount / videosTotal * 100) : 0 },
      qc: { pending: qcPending, bad: qcBad, ok: qcOk, avg: qcAvg, similar: simCount },
      members, activeMembers, storageBytes,
    },
    trend,
    ratingDist,
    topVideos,
    team,
    activity,
    mine,
  });
});

module.exports = r;
