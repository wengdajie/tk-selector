'use strict';
const fs = require('fs');
const path = require('path');
const db = require('../db');
const config = require('../config');
const media = require('./media');
const notify = require('./notify');
const { ingest } = require('./store');
const { ymd } = require('./util');

const state = {
  running: false,
  lastRunAt: null,
  lastResult: null,
  lastError: null,
};

function parseDateFromPath(rel, mtimeMs) {
  const text = rel.replace(/\\/g, '/');
  const m = text.match(/(20\d{2})[-_.年]?(\d{1,2})[-_.月]?(\d{1,2})/);
  if (m) {
    const y = +m[1], mo = +m[2], d = +m[3];
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
      const p = n => String(n).padStart(2, '0');
      return `${y}-${p(mo)}-${p(d)}`;
    }
  }
  return ymd(new Date(mtimeMs));
}

const ignored = new Set(config.scanIgnore.map(s => s.toLowerCase()));

async function walk(dir, out = [], depth = 0) {
  if (depth > 8) return out;
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (e) {
    console.warn('[scan] 无法读取目录:', dir, e.code);
    return out;
  }
  for (const ent of entries) {
    const name = ent.name;
    if (name.startsWith('.') || ignored.has(name.toLowerCase())) continue;
    const full = path.join(dir, name);
    if (ent.isDirectory()) {
      await walk(full, out, depth + 1);
    } else if (ent.isFile() && media.isVideoFile(name)) {
      out.push(full);
    }
  }
  return out;
}

const getScanFile = db.prepare('SELECT * FROM scan_files WHERE path = ?');
const putScanFile = db.prepare(`
  INSERT INTO scan_files (path,size,mtime,video_id,scanned_at) VALUES (?,?,?,?,?)
  ON CONFLICT(path) DO UPDATE SET size=excluded.size, mtime=excluded.mtime,
    video_id=excluded.video_id, scanned_at=excluded.scanned_at
`);

async function scanNow({ reason = 'manual', uploaderId = null } = {}) {
  if (state.running) return { skipped: true, reason: '扫描进行中', state };
  state.running = true;
  const started = Date.now();
  const result = { reason, scanned: 0, added: 0, duplicate: 0, failed: 0, errors: [] };
  try {
    if (!fs.existsSync(config.scanDir)) {
      throw Object.assign(new Error(`扫描目录不存在: ${config.scanDir}`), { code: 'ENOENT' });
    }
    const files = await walk(config.scanDir);
    result.scanned = files.length;
    const addedVideos = [];

    for (const file of files) {
      try {
        const stat = await fs.promises.stat(file);
        const prev = getScanFile.get(file);
        if (prev && prev.size === stat.size && prev.mtime === Math.floor(stat.mtimeMs)) {
          continue; // 未变化，跳过
        }
        const rel = path.relative(config.scanDir, file);
        const shootDate = parseDateFromPath(rel, stat.mtimeMs);
        const { video, duplicate } = await ingest({
          srcPath: file,
          origName: path.basename(file),
          space: 'daily',
          shootDate,
          uploaderId,
          source: 'scan',
          removeSource: config.scanMode === 'move',
          // 不传 dedupeKey：走内容指纹，同一素材被改名/重传也能识别
        });
        putScanFile.run(file, stat.size, Math.floor(stat.mtimeMs), video.id, Date.now());
        if (duplicate) result.duplicate++;
        else { result.added++; addedVideos.push(video); }
      } catch (e) {
        result.failed++;
        if (result.errors.length < 20) result.errors.push(`${path.basename(file)}: ${e.message}`);
        console.warn('[scan] 入库失败:', file, e.message);
      }
    }
    // 群通知：投递目录有新素材入库（定时扫描没有触发人，显示为「投递目录扫描」）
    if (addedVideos.length) {
      const trigger = uploaderId
        ? db.prepare('SELECT name FROM users WHERE id = ?').get(uploaderId)
        : null;
      notify.onUpload(addedVideos, trigger);
    }
    state.lastResult = result;
    state.lastError = null;
  } catch (e) {
    state.lastError = e.message;
    result.error = e.message;
    console.warn('[scan] 扫描中止:', e.message);
  } finally {
    state.running = false;
    state.lastRunAt = Date.now();
    state.lastDurationMs = Date.now() - started;
  }
  return result;
}

function startScheduler() {
  if (!config.scanInterval || config.scanInterval <= 0) {
    console.log('[scan] 定时扫描已关闭（SCAN_INTERVAL=0）');
    return;
  }
  setTimeout(() => { scanNow({ reason: 'startup' }).catch(() => {}); }, 4000);
  setInterval(() => {
    scanNow({ reason: 'cron' }).catch(() => {});
  }, config.scanInterval * 1000);
  console.log(`[scan] 每 ${config.scanInterval}s 扫描 ${config.scanDir}`);
}

module.exports = { scanNow, state, walk, parseDateFromPath, startScheduler };
