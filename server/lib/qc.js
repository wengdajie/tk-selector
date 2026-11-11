'use strict';
/**
 * 投放体检（QC）：一次解码跑完多个 ffmpeg 分析滤镜，产出可直接指导投放的判断。
 * 参考业内做法（Rendiff Probe / Mediadeepa 的 QC 分类）：黑帧、冻结帧、黑边、响度、静音。
 */
const fs = require('fs');
const { execFile } = require('child_process');
const config = require('../config');

/**
 * 跑 ffmpeg 并「无论成败」都拿到 stderr —— 黑帧/冻结/响度/黑边全部来自 stderr。
 * （media.run 成功时只回传 stdout，会丢掉这些分析结果）
 */
function runCapture(args, timeout) {
  return new Promise(resolve => {
    execFile(config.ffmpegPath, args, {
      timeout, maxBuffer: 16 * 1024 * 1024, windowsHide: true,
    }, (err, stdout, stderr) => {
      resolve({ err, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

/** 每项检查的权重，用于算 0-100 的体检分 */
const FLAG_META = {
  noaudio: { label: '无音轨', weight: 24, hint: '投流素材几乎必须有声音' },
  lowres: { label: '分辨率偏低', weight: 18, hint: '短边不足 720，竖屏投放会糊' },
  lowbitrate: { label: '码率偏低', weight: 14, hint: '压缩过度，快速运动画面会糊' },
  quiet: { label: '响度偏低', weight: 10, hint: '平台建议 -14 LUFS 左右' },
  loud: { label: '响度偏高', weight: 8, hint: '超过 -9 LUFS 容易被平台压限' },
  letterbox: { label: '画面有黑边', weight: 12, hint: '竖屏投放建议裁满画面' },
  frozen: { label: '画面长时间静止', weight: 14, hint: '超过 15% 时长静止，完播率会掉' },
  blackframes: { label: '含黑场', weight: 8, hint: '黑帧占比偏高，开场可能被跳过' },
  tooshort: { label: '时长过短', weight: 12, hint: '短于 3 秒难以承载卖点' },
  toolong: { label: '时长过长', weight: 6, hint: '超过 3 分钟，不适合信息流投放' },
  noth264: { label: '非 H.264 编码', weight: 16, hint: '浏览器可能无法直接播放，建议转码' },
};

const sum = arr => arr.reduce((a, b) => a + b, 0);

function parseStderr(text) {
  const out = { lufs: null, peak: null, blackPct: 0, freezePct: 0, crop: null, maxFreeze: 0, hasData: false };

  // EBU R128：ebur128 每帧都会打印一次 "I: x LUFS"，最后一次（含 Summary）才是整段结果
  const lufsAll = [...text.matchAll(/I:\s*(-?\d+(?:\.\d+)?)\s*LUFS/g)];
  if (lufsAll.length) out.lufs = Number(lufsAll[lufsAll.length - 1][1]);
  const peakAll = [...text.matchAll(/Peak:\s*(-?\d+(?:\.\d+)?)\s*dBFS/g)];
  if (peakAll.length) out.peak = Number(peakAll[peakAll.length - 1][1]);

  // 黑帧区间
  const blacks = [...text.matchAll(/black_duration:\s*(\d+(?:\.\d+)?)/g)].map(m => Number(m[1]));
  out.blackSec = sum(blacks);

  // 冻结帧
  const freezes = [...text.matchAll(/freeze_duration:\s*(\d+(?:\.\d+)?)/g)].map(m => Number(m[1]));
  out.freezeSec = sum(freezes);
  out.maxFreeze = freezes.length ? Math.max(...freezes) : 0;

  // 黑边（cropdetect 会刷很多行，取最后一次）
  const crops = [...text.matchAll(/crop=(\d+):(\d+):(\d+):(\d+)/g)];
  if (crops.length) {
    const m = crops[crops.length - 1];
    out.crop = { w: Number(m[1]), h: Number(m[2]), x: Number(m[3]), y: Number(m[4]) };
  }

  out.hasData = !!(out.lufs != null || out.peak != null || blacks.length || freezes.length || crops.length);
  return out;
}

/**
 * 跑一次解码分析
 * @returns {{ok:boolean, lufs:number|null, peak:number|null, blackPct:number, freezePct:number, crop:object|null, flags:string[], score:number, error?:string}}
 */
async function analyze(absFile, meta = {}) {
  if (!fs.existsSync(absFile)) {
    return { ok: false, error: '源文件不存在', flags: ['missing'], score: null };
  }
  const duration = Number(meta.duration) || 0;
  const hasAudio = meta.hasAudio !== false;
  const vf = 'blackdetect=d=0.4:pix_th=0.10,freezedetect=n=-60dB:d=1.2,cropdetect=24:16:0';
  const af = 'ebur128=peak=true,silencedetect=n=-45dB:d=1';

  const args = ['-hide_banner', '-nostdin', '-i', absFile, '-map', '0:v:0', '-vf', vf];
  if (hasAudio) args.push('-map', '0:a:0?', '-af', af);
  args.push('-f', 'null', '-');

  const timeout = Math.min(300_000, Math.max(60_000, duration * 4000));
  const { err, stderr } = await runCapture(args, timeout);

  const parsed = parseStderr(stderr);
  if (!parsed.hasData && err) {
    return { ok: false, error: String(err.message).slice(0, 160), flags: ['qcfailed'], score: null };
  }

  const p = parsed;
  const blackPct = duration ? Math.min(100, (p.blackSec || 0) / duration * 100) : 0;
  const freezePct = duration ? Math.min(100, (p.freezeSec || 0) / duration * 100) : 0;

  // ---- 规则判定 ----
  const flags = [];
  const w = Number(meta.width) || 0;
  const h = Number(meta.height) || 0;
  const shortSide = Math.min(w, h);
  const bitrateKbps = (Number(meta.videoBitrate) || Number(meta.bitrate) || 0) / 1000;

  if (!hasAudio) flags.push('noaudio');
  if (shortSide && shortSide < 720) flags.push('lowres');
  if (shortSide >= 720 && bitrateKbps > 0 && bitrateKbps < 900) flags.push('lowbitrate');
  if (p.lufs != null && p.lufs < -24) flags.push('quiet');
  if (p.lufs != null && p.lufs > -9) flags.push('loud');
  if (duration && duration < 3) flags.push('tooshort');
  if (duration > 180) flags.push('toolong');
  if (meta.codec && meta.codec !== 'h264') flags.push('noth264');
  if (blackPct > 6) flags.push('blackframes');
  if (freezePct > 15) flags.push('frozen');

  // 黑边：实际画面区域比原始尺寸小 8% 以上
  if (p.crop && w && h) {
    const areaRatio = (p.crop.w * p.crop.h) / (w * h);
    if (areaRatio < 0.92) flags.push('letterbox');
  }

  let score = 100;
  for (const f of flags) {
    const m = FLAG_META[f];
    score -= m ? m.weight : 6;
  }
  score = Math.max(0, Math.min(100, Math.round(score)));

  return {
    ok: true,
    lufs: p.lufs,
    peak: p.peak,
    blackPct: Number(blackPct.toFixed(2)),
    freezePct: Number(freezePct.toFixed(2)),
    crop: p.crop,
    flags: [...new Set(flags)],
    score,
  };
}

module.exports = { analyze, FLAG_META };
