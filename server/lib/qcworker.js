'use strict';
/**
 * 体检队列：入库时不阻塞上传，后台顺序处理 pending 的素材。
 * 一次处理 2 条，避免群晖这种低功耗 CPU 被占满。
 */
const path = require('path');
const fs = require('fs');
const db = require('../db');
const config = require('../config');
const qc = require('./qc');
const phash = require('./phash');

const state = { running: false, lastRunAt: null, pending: 0, lastError: null };

const pickPending = db.prepare(
  "SELECT * FROM videos WHERE qc_status = 'pending' ORDER BY created_at DESC LIMIT 2"
);
const countPending = db.prepare("SELECT COUNT(*) c FROM videos WHERE qc_status = 'pending'");

const updateOk = db.prepare(`
  UPDATE videos SET qc_status='done', qc_flags=@flags, qc_score=@score, lufs=@lufs, peak_db=@peak,
    black_pct=@black, freeze_pct=@freeze, crop=@crop, codec=COALESCE(codec,@codec),
    pix_fmt=COALESCE(pix_fmt,@pixFmt), fps=COALESCE(fps,@fps), has_audio=@hasAudio,
    phash=@phash, sim_of=@simOf, sim_dist=@simDist
  WHERE id=@id
`);
const updateFail = db.prepare("UPDATE videos SET qc_status='failed', qc_flags='qcfailed' WHERE id=?");

/** 找相似素材：时长接近 + 至少 2 帧命中 + 最小距离 */
function findSimilar(v, hashes) {
  if (!hashes.length) return { simOf: null, simDist: null };
  const rows = db.prepare(
    "SELECT id, duration, phash FROM videos WHERE id <> ? AND phash IS NOT NULL AND phash <> ''"
  ).all(v.id);
  const tol = Math.max(1, (Number(v.duration) || 0) * 0.05);
  let best = null;
  for (const r of rows) {
    if (Math.abs((Number(r.duration) || 0) - (Number(v.duration) || 0)) > tol) continue;
    const other = phash.parseHashes(r.phash);
    if (phash.matchCount(hashes, other, 8) < Math.min(2, hashes.length)) continue;
    const dist = phash.bestDistance(hashes, other);
    if (dist > 6) continue;
    if (!best || dist < best.dist) best = { id: r.id, dist };
  }
  return { simOf: best?.id || null, simDist: best?.dist ?? null };
}

async function processOne(v) {
  const abs = path.join(config.mediaDir, v.file_path);
  if (!fs.existsSync(abs)) { updateFail.run(v.id); return; }

  const meta = {
    duration: v.duration, width: v.width, height: v.height,
    codec: v.codec, bitrate: v.bitrate, videoBitrate: v.bitrate,
    hasAudio: v.has_audio !== 0,
  };

  const r = await qc.analyze(abs, meta);
  if (!r.ok) { updateFail.run(v.id); return; }

  let hashes = [];
  try {
    hashes = [...new Set(await phash.videoHashes(abs, v.duration))];
  } catch (e) {
    console.warn('[qc] 感知哈希失败:', v.id, String(e.message).slice(0, 100));
  }
  const sim = findSimilar(v, hashes);

  updateOk.run({
    id: v.id,
    flags: r.flags.join(','),
    score: r.score,
    lufs: r.lufs,
    peak: r.peak,
    black: r.blackPct,
    freeze: r.freezePct,
    crop: r.crop ? `${r.crop.w}x${r.crop.h}` : null,
    codec: meta.codec || null,
    pixFmt: null,
    fps: null,
    hasAudio: meta.hasAudio ? 1 : 0,
    phash: hashes.join(',') || null,
    simOf: sim.simOf,
    simDist: sim.simDist,
  });
}

async function tick() {
  if (state.running) return;
  state.running = true;
  try {
    const rows = pickPending.all();
    for (const v of rows) {
      try { await processOne(v); } catch (e) {
        state.lastError = String(e.message).slice(0, 200);
        console.warn('[qc] 处理失败:', v.id, state.lastError);
        updateFail.run(v.id);
      }
    }
    state.lastRunAt = Date.now();
  } finally {
    state.pending = countPending.get().c;
    state.running = false;
  }
}

/** 单条立即体检（详情页按钮用） */
async function runOne(id) {
  const v = db.prepare('SELECT * FROM videos WHERE id = ?').get(id);
  if (!v) return { ok: false, error: '素材不存在' };
  await processOne(v);
  return { ok: true, video: db.prepare('SELECT * FROM videos WHERE id = ?').get(id) };
}

let timer = null;
function start() {
  if (String(process.env.QC_ENABLED || '1') === '0') {
    console.log('[qc] 已通过 QC_ENABLED=0 关闭');
    return;
  }
  state.pending = countPending.get().c;
  console.log(`[qc] 体检队列启动，待处理 ${state.pending} 条`);
  if (state.pending > 0) setTimeout(() => tick().catch(() => {}), 3000);
  timer = setInterval(() => tick().catch(() => {}), 20_000);
  timer.unref?.();
}

function stop() { if (timer) clearInterval(timer); timer = null; }

module.exports = { start, stop, tick, runOne, state };
