'use strict';
const crypto = require('crypto');

const uuid = () => crypto.randomUUID();

/** 本地时区的 YYYY-MM-DD */
function ymd(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 时间戳 -> 本地 YYYY-MM-DD */
function tsToYmd(ts) {
  return ymd(new Date(ts));
}

/** 秒 -> mm:ss / h:mm:ss */
function fmtDuration(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const p = n => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${p(m)}:${p(ss)}` : `${m}:${p(ss)}`;
}

function safeName(name) {
  return String(name || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

function bytes(n) {
  const b = Number(n) || 0;
  if (b < 1024) return `${b} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let i = -1, v = b;
  do { v /= 1024; i++; } while (v >= 1024 && i < u.length - 1);
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${u[i]}`;
}

module.exports = { uuid, ymd, tsToYmd, fmtDuration, safeName, bytes };
