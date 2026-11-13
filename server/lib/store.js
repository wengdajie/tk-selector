'use strict';
const fs = require('fs');
const path = require('path');
const db = require('../db');
const config = require('../config');
const media = require('./media');
const { uuid, ymd, safeName } = require('./util');

const insertVideo = db.prepare(`
  INSERT INTO videos (id,space,title,orig_name,file_path,thumb_path,mime,size,duration,width,height,
                      shoot_date,source,src_path,uploader_id,status,tags,request_id,dedupe_key,created_at,updated_at,
                      codec,pix_fmt,fps,has_audio,qc_status)
  VALUES (@id,@space,@title,@orig_name,@file_path,@thumb_path,@mime,@size,@duration,@width,@height,
          @shoot_date,@source,@src_path,@uploader_id,@status,@tags,@request_id,@dedupe_key,@created_at,@updated_at,
          @codec,@pix_fmt,@fps,@has_audio,@qc_status)
`);

async function copyAcross(src, dest) {
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  try {
    await fs.promises.copyFile(src, dest);
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    await new Promise((res, rej) => {
      const rs = fs.createReadStream(src);
      const ws = fs.createWriteStream(dest);
      rs.on('error', rej);
      ws.on('error', rej);
      ws.on('finish', res);
      rs.pipe(ws);
    });
  }
}

/**
 * 把一个视频文件收纳进媒体库并建立记录。
 * @returns {{video:object, duplicate:boolean}}
 */
async function ingest(opts) {
  const {
    srcPath, origName, space = 'daily', shootDate, uploaderId = null,
    source = 'upload', removeSource = false, dedupeKey = null,
    title = null, requestId = null, tags = '',
  } = opts;

  const name = origName || path.basename(srcPath);
  if (!media.isVideoFile(name)) {
    const err = new Error('不是支持的视频格式'); err.status = 400; throw err;
  }
  const ext = path.extname(name).toLowerCase() || '.mp4';
  const stat = await fs.promises.stat(srcPath);
  if (stat.size === 0) {
    const err = new Error('文件为空'); err.status = 400; throw err;
  }

  const key = dedupeKey || (await media.fingerprint(srcPath));
  const dup = db.prepare('SELECT * FROM videos WHERE dedupe_key = ?').get(key);
  if (dup) {
    if (removeSource) { try { await fs.promises.unlink(srcPath); } catch { /* ignore */ } }
    return { video: dup, duplicate: true };
  }

  const id = uuid();
  const date = shootDate || ymd();
  const relDir = path.join(space, date);
  const relFile = path.join(relDir, `${id}${ext}`);
  const absFile = path.join(config.mediaDir, relFile);

  await fs.promises.mkdir(path.dirname(absFile), { recursive: true });
  if (removeSource) {
    try {
      await fs.promises.rename(srcPath, absFile);
    } catch {
      await copyAcross(srcPath, absFile);
      try { await fs.promises.unlink(srcPath); } catch { /* ignore */ }
    }
  } else {
    await copyAcross(srcPath, absFile);
  }

  const meta = await media.probe(absFile);
  const thumbAbs = path.join(config.mediaDir, 'thumbs', `${id}.jpg`);
  await fs.promises.mkdir(path.dirname(thumbAbs), { recursive: true });
  const thumbOk = await media.thumbnail(absFile, thumbAbs, meta?.duration || 0);

  const now = Date.now();
  const row = {
    id,
    space,
    title: (title || name.replace(/\.[^.]+$/, '')).slice(0, 120),
    orig_name: safeName(name),
    file_path: relFile.split(path.sep).join('/'),
    thumb_path: thumbOk ? `thumbs/${id}.jpg` : null,
    mime: media.mimeOf(name),
    size: stat.size,
    duration: meta?.duration || 0,
    width: meta?.width || 0,
    height: meta?.height || 0,
    shoot_date: date,
    source,
    src_path: srcPath,
    uploader_id: uploaderId,
    status: 'new',
    tags,
    request_id: requestId,
    dedupe_key: key,
    created_at: now,
    updated_at: now,
    codec: meta?.codec || null,
    pix_fmt: meta?.pixFmt || null,
    fps: meta?.fps || null,
    has_audio: meta ? (meta.hasAudio ? 1 : 0) : 1,
    // 体检只针对投放素材（每日选片）；素材库是资料/参考素材，不排体检队列
    qc_status: space === 'library' ? 'skipped' : 'pending',
  };
  try {
    insertVideo.run(row);
  } catch (e) {
    // 并发下唯一索引冲突：删掉刚写入的副本，返回已有记录
    if (String(e.message).includes('UNIQUE')) {
      try { await fs.promises.unlink(absFile); } catch { /* ignore */ }
      const exist = db.prepare('SELECT * FROM videos WHERE dedupe_key = ?').get(key);
      if (exist) return { video: exist, duplicate: true };
    }
    throw e;
  }
  return { video: db.prepare('SELECT * FROM videos WHERE id = ?').get(id), duplicate: false };
}

module.exports = { ingest };
