'use strict';
/**
 * 感知哈希（dHash）：抽 3 帧 → 缩到 9x8 灰度 → 相邻像素比大小得到 64 bit。
 * 用途：识别「转码 / 改分辨率 / 改名 / 剪掉片头片尾」后的重复素材，
 * 这些情况文件级 MD5 完全识别不出来。
 * 参考做法：memedup / videodedup 的「按比例抽帧 + 最佳配对 + quorum」策略。
 */
const { execFile } = require('child_process');
const fs = require('fs');
const config = require('../config');

const W = 9;
const H = 8;

function grabFrame(file, atSec, timeout = 30_000) {
  return new Promise((resolve, reject) => {
    execFile(
      config.ffmpegPath,
      [
        '-hide_banner', '-loglevel', 'error', '-nostdin',
        '-ss', String(Math.max(0, atSec).toFixed(2)),
        '-i', file,
        '-frames:v', '1',
        '-vf', `scale=${W}:${H}:flags=area,format=gray`,
        '-f', 'rawvideo', '-pix_fmt', 'gray',
        'pipe:1',
      ],
      { encoding: 'buffer', timeout, maxBuffer: 1024 * 1024, windowsHide: true },
      (err, stdout) => {
        if (err) return reject(err);
        if (!stdout || stdout.length < W * H) return reject(new Error('frame too small'));
        resolve(stdout);
      },
    );
  });
}

function dhashFromGray(buf) {
  let bits = '';
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W - 1; x++) {
      const a = buf[y * W + x];
      const b = buf[y * W + x + 1];
      bits += a > b ? '1' : '0';
    }
  }
  let hex = '';
  for (let i = 0; i < bits.length; i += 4) {
    hex += parseInt(bits.slice(i, i + 4).padEnd(4, '0'), 2).toString(16);
  }
  return hex; // 16 位十六进制 = 64 bit
}

/** 按 25% / 50% / 75% 抽帧，返回 3 个 hash（失败的位置为 null） */
async function videoHashes(file, duration) {
  if (!fs.existsSync(file)) return [];
  const d = Number(duration) || 0;
  const points = d > 0.5 ? [d * 0.25, d * 0.5, d * 0.75] : [0];
  const out = [];
  for (const t of points) {
    try {
      const buf = await grabFrame(file, t);
      out.push(dhashFromGray(buf));
    } catch {
      out.push(null);
    }
  }
  return out.filter(Boolean);
}

function hamming(a, b) {
  if (!a || !b || a.length !== b.length) return 64;
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (x) { d += x & 1; x >>= 1; }
  }
  return d;
}

/** 两组 hash 的最佳配对距离：插入片头/裁剪会让位置错位，所以取每种配对里的最小值 */
function bestDistance(a, b) {
  if (!a?.length || !b?.length) return 64;
  let best = 64;
  for (const x of a) for (const y of b) best = Math.min(best, hamming(x, y));
  return best;
}

/** 差值 ≤ quorum 的帧数 */
function matchCount(a, b, threshold = 8) {
  if (!a?.length || !b?.length) return 0;
  let n = 0;
  const used = new Set();
  for (const x of a) {
    let hit = -1;
    let best = threshold + 1;
    b.forEach((y, i) => {
      if (used.has(i)) return;
      const d = hamming(x, y);
      if (d < best) { best = d; hit = i; }
    });
    if (hit >= 0) { used.add(hit); n++; }
  }
  return n;
}

const parseHashes = s => (s ? String(s).split(',').filter(Boolean) : []);

module.exports = { videoHashes, hamming, bestDistance, matchCount, parseHashes };
