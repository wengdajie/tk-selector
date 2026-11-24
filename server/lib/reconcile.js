'use strict';
/**
 * 启动时对账媒体文件与数据库记录，修复历史上「DB 改了但文件没搬」的残留。
 * 只做有把握的自动修复（目标文件唯一且大小一致）；其余只打印警告，绝不删文件。
 */
const fs = require('fs');
const path = require('path');
const db = require('../db');
const config = require('../config');

const ROOT = path.resolve(config.mediaDir);

function reconcileMedia() {
  const report = { checked: 0, fixed: 0, missing: [], orphans: [] };
  const videos = db.prepare('SELECT id, space, file_path, shoot_date, size FROM videos').all();
  const known = new Set();

  for (const v of videos) {
    report.checked++;
    if (!v.file_path) continue;
    const rel = String(v.file_path).split('\\').join('/');
    known.add(path.basename(rel));
    let abs;
    try { abs = path.resolve(ROOT, rel); } catch { continue; }
    if (abs.startsWith(ROOT + path.sep) && fs.existsSync(abs)) continue;

    const base = path.basename(rel);
    const candidates = [];
    for (const sp of ['daily', 'library']) {
      const p = path.join(ROOT, sp, v.shoot_date || '', base);
      try {
        if (fs.existsSync(p) && Number(fs.statSync(p).size) === Number(v.size)) {
          candidates.push({ p, space: sp, rel: `${sp}/${v.shoot_date}/${base}` });
        }
      } catch { /* ignore */ }
    }
    if (candidates.length === 1) {
      const c = candidates[0];
      db.prepare('UPDATE videos SET space=?, file_path=?, qc_status=? WHERE id=?')
        .run(c.space, c.rel, c.space === 'library' ? 'skipped' : v.qc_status, v.id);
      report.fixed++;
      console.warn(`[reconcile] 已修复 ${v.id}: ${rel} -> ${c.rel}`);
    } else {
      report.missing.push(v.id);
      console.warn(`[reconcile] 原片缺失 ${v.id}: ${rel}（候选 ${candidates.length} 个，需人工确认）`);
    }
  }

  // 孤儿文件只报告不处理：可能是历史 -movedN 副本，删除必须由人确认
  for (const sp of ['daily', 'library']) {
    const dir = path.join(ROOT, sp);
    let dates = [];
    try { dates = fs.readdirSync(dir); } catch { continue; }
    for (const date of dates) {
      const d = path.join(dir, date);
      let files = [];
      try { files = fs.readdirSync(d); } catch { continue; }
      for (const f of files) {
        if (known.has(f)) continue;
        report.orphans.push(`${sp}/${date}/${f}`);
        console.warn(`[reconcile] 未关联文件 ${sp}/${date}/${f}`);
      }
    }
  }

  if (report.fixed || report.missing.length || report.orphans.length) {
    console.warn(`[reconcile] 对账完成：修复 ${report.fixed}，缺失 ${report.missing.length}，未关联 ${report.orphans.length}`);
  }
  return report;
}

module.exports = { reconcileMedia };
