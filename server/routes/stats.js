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

module.exports = r;
