'use strict';
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');

const VIDEO_EXT = new Set(['.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi', '.mpg', '.mpeg', '.flv', '.wmv', '.3gp', '.ts']);

const run = (bin, args, timeout = 60_000) =>
  new Promise((resolve, reject) => {
    execFile(bin, args, { timeout, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) return reject(Object.assign(err, { stderr }));
      resolve(stdout);
    });
  });

let ffmpegWarned = false;

/** 读取视频元数据；失败返回 null（不阻断入库，前端显示为未知时长） */
async function probe(file) {
  try {
    const out = await run(config.ffprobePath, [
      '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file,
    ], 30_000);
    const j = JSON.parse(out);
    const v = (j.streams || []).find(s => s.codec_type === 'video') || {};
    const duration = Number(j.format?.duration || v.duration || 0);
    return {
      duration: Number.isFinite(duration) ? duration : 0,
      width: Number(v.width || 0),
      height: Number(v.height || 0),
      codec: v.codec_name || '',
      bitrate: Number(j.format?.bit_rate || 0),
    };
  } catch (e) {
    console.warn('[media] ffprobe 失败，元数据降级为空:', path.basename(file), String(e.message).slice(0, 120));
    return null;
  }
}

/** 抽一帧做封面，返回相对 mediaDir 的路径或 null */
async function thumbnail(file, outAbs, duration = 0) {
  const seek = duration > 3 ? Math.min(2, duration * 0.15) : 0;
  const args = [
    '-y', '-hide_banner', '-loglevel', 'error',
    ...(seek > 0 ? ['-ss', String(seek.toFixed(2))] : []),
    '-i', file,
    '-frames:v', '1',
    '-vf', 'scale=720:-2:flags=lanczos',
    '-q:v', '4',
    outAbs,
  ];
  try {
    await run(config.ffmpegPath, args, 45_000);
    if (!fs.existsSync(outAbs) || fs.statSync(outAbs).size === 0) throw new Error('thumbnail empty');
    return outAbs;
  } catch (e) {
    if (!ffmpegWarned) {
      ffmpegWarned = true;
      console.warn('[media] ffmpeg 抽帧失败（封面将使用占位图）:', String(e.message).slice(0, 160));
    }
    try { fs.unlinkSync(outAbs); } catch { /* ignore */ }
    return null;
  }
}

/** 文件指纹：大小 + 首尾各 1MB 的 md5，跨次复制也能识别同一素材 */
async function fingerprint(file) {
  const size = fs.statSync(file).size;
  const hash = crypto.createHash('md5').update(String(size));
  const fh = await fs.promises.open(file, 'r');
  try {
    const chunk = Math.min(1024 * 1024, size);
    const head = Buffer.alloc(chunk);
    await fh.read(head, 0, chunk, 0);
    hash.update(head);
    if (size > chunk * 2) {
      const tail = Buffer.alloc(chunk);
      await fh.read(tail, 0, chunk, size - chunk);
      hash.update(tail);
    }
  } finally {
    await fh.close();
  }
  return hash.digest('hex');
}

function isVideoFile(name) {
  return VIDEO_EXT.has(path.extname(name).toLowerCase());
}

function mimeOf(name) {
  const ext = path.extname(name).toLowerCase();
  const map = {
    '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime',
    '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo',
  };
  return map[ext] || 'video/mp4';
}

module.exports = { probe, thumbnail, fingerprint, isVideoFile, mimeOf, run, VIDEO_EXT };
