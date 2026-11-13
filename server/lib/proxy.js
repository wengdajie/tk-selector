'use strict';
/**
 * 播放代理（Playback Proxy）
 *
 * 问题：手机原片几乎都是 HEVC / H.265（常见 10-bit、1080x1920@60、15Mbps）。
 *   - 安卓 Chrome / 微信内置浏览器基本不支持 HEVC，桌面 Chrome 也多数不支持 → 卡顿、黑屏、转圈
 *   - 并且多数文件 moov 在尾部（非 faststart），起播前要先拉完整个文件
 *
 * 解法：入库后（或首次播放时）用 ffmpeg 生成一份 H.264 + faststart 的播放版存到 /data/media/proxies/<id>.mp4，
 *   播放接口优先发代理版，**下载仍发原片**（保留原始画质）。
 * 队列串行执行（一次 1 条），避免低功耗 NAS 的 CPU 被转码打满影响其他操作。
 */
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const db = require('../db');
const config = require('../config');

const state = { running: false, queued: 0, done: 0, failed: 0, lastError: null, lastAt: null };

const proxyDir = path.join(config.mediaDir, 'proxies');
fs.mkdirSync(proxyDir, { recursive: true });

const proxyFile = id => path.join(proxyDir, `${id}.mp4`);
const isReady = id => {
  const p = proxyFile(id);
  try { return fs.existsSync(p) && fs.statSync(p).size > 4096; } catch { return false; }
};

const setState = (id, st) => db.prepare('UPDATE videos SET proxy_state = ? WHERE id = ?').run(st, id);

/** 目标：短边不超过 720 / 长边不超过 1280，H.264 High + faststart，音频 AAC */
const ffmpegArgs = (src, out) => [
  '-hide_banner', '-loglevel', 'error', '-y',
  '-i', src,
  '-map', '0:v:0', '-map', '0:a:0?',
  '-vf', 'scale=-2:min(1280\\,ih)',
  '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
  '-maxrate', '2500k', '-bufsize', '5000k',
  '-profile:v', 'high', '-level', '4.0', '-pix_fmt', 'yuv420p',
  '-c:a', 'aac', '-b:a', '128k', '-ac', '2',
  '-movflags', '+faststart',
  '-f', 'mp4', out,
];

/** 判断是否值得转：已是 H.264 且不重（≤4.5Mbps）且不高（≤1080）→ 直接播原片 */
function needsProxy(v) {
  const dur = Number(v.duration) || 0;
  const bps = dur > 0 ? (Number(v.size) * 8) / dur : 0;
  const tall = Math.max(Number(v.width) || 0, Number(v.height) || 0);
  if (String(v.codec || '') === 'h264' && tall > 0 && tall <= 1080 && bps <= 4500000) return false;
  return true;
}

const running = new Set();
const waiting = new Map();   // id -> resolver[]

function runOne(id) {
  return new Promise(resolve => {
    const v = db.prepare('SELECT * FROM videos WHERE id = ?').get(id);
    if (!v) return resolve({ ok: false, error: '素材不存在' });
    if (!needsProxy(v)) { setState(id, 'skipped'); return resolve({ ok: true, skipped: true }); }
    if (isReady(id)) { setState(id, 'done'); return resolve({ ok: true, cached: true }); }

    const src = path.join(config.mediaDir, v.file_path);
    if (!fs.existsSync(src)) { setState(id, 'failed'); return resolve({ ok: false, error: '源文件不存在' }); }

    const out = proxyFile(id);
    const tmpOut = out + '.tmp.mp4';
    setState(id, 'running');
    const started = Date.now();
    const ff = spawn('ffmpeg', ffmpegArgs(src, tmpOut), { stdio: ['ignore', 'ignore', 'pipe'] });
    let errBuf = '';
    ff.stderr.on('data', d => { errBuf += d.toString(); if (errBuf.length > 4000) errBuf = errBuf.slice(-2000); });
    ff.on('error', e => {
      setState(id, 'failed');
      state.failed++;
      state.lastError = e.message;
      resolve({ ok: false, error: e.message });
    });
    ff.on('close', code => {
      if (code === 0 && fs.existsSync(tmpOut) && fs.statSync(tmpOut).size > 4096) {
        try { fs.renameSync(tmpOut, out); } catch (e) {
          setState(id, 'failed');
          return resolve({ ok: false, error: e.message });
        }
        setState(id, 'done');
        state.done++;
        state.lastAt = Date.now();
        console.log(`[proxy] ${id} 播放版就绪（${Math.round((Date.now() - started) / 1000)}s）`);
        resolve({ ok: true, path: out });
      } else {
        try { fs.rmSync(tmpOut, { force: true }); } catch { /* ignore */ }
        setState(id, 'failed');
        state.failed++;
        state.lastError = errBuf.trim().split('\n').pop() || `ffmpeg 退出码 ${code}`;
        console.warn(`[proxy] 转码失败 ${id}: ${state.lastError}`);
        resolve({ ok: false, error: state.lastError });
      }
    });
  });
}

let ticking = false;
async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    while (true) {
      const v = db.prepare(
        "SELECT * FROM videos WHERE proxy_state IN ('pending') ORDER BY created_at DESC LIMIT 1"
      ).get();
      if (!v) break;
      if (running.has(v.id)) break;
      running.add(v.id);
      state.running = true;
      try { await runOne(v.id); } finally {
        running.delete(v.id);
        const waiters = waiting.get(v.id) || [];
        waiting.delete(v.id);
        waiters.forEach(fn => fn());
      }
      state.queued = db.prepare("SELECT COUNT(*) c FROM videos WHERE proxy_state = 'pending'").get().c;
    }
  } finally {
    state.running = running.size > 0;
    ticking = false;
  }
}

/** 入队（幂等）；返回 Promise 在完成时 resolve（最多等 maxWaitMs） */
function queue(id, { maxWaitMs = 0 } = {}) {
  const v = db.prepare('SELECT * FROM videos WHERE id = ?').get(id);
  if (!v) return Promise.resolve({ ok: false, error: '素材不存在' });
  if (isReady(id)) return Promise.resolve({ ok: true, cached: true });
  if (!needsProxy(v)) { setState(id, 'skipped'); return Promise.resolve({ ok: true, skipped: true }); }
  if (!v.proxy_state || v.proxy_state === 'failed') setState(id, 'pending');
  tick().catch(() => {});

  if (!maxWaitMs) return Promise.resolve({ ok: true, queued: true });
  return new Promise(resolve => {
    const list = waiting.get(id) || [];
    list.push(() => resolve({ ok: isReady(id), timedOut: !isReady(id) }));
    waiting.set(id, list);
    tick().catch(() => {});
    setTimeout(() => {
      const l = waiting.get(id) || [];
      const i = l.indexOf(list[list.length - 1]);
      if (i >= 0) l.splice(i, 1);
      resolve({ ok: isReady(id), timedOut: true });
    }, maxWaitMs);
  });
}

/** 启动时把「转码中」的残留状态复位（进程被杀的情况） */
function recoverStale() {
  const r = db.prepare("UPDATE videos SET proxy_state = 'pending' WHERE proxy_state = 'running'").run();
  if (r.changes) console.log(`[proxy] 复位 ${r.changes} 条中断的转码任务`);
}

module.exports = { queue, tick, isReady, needsProxy, proxyFile, state, recoverStale, proxyDir };
