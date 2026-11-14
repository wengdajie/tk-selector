'use strict';
/**
 * 播放代理（Playback Proxy）
 *
 * 问题：手机原片几乎都是 HEVC / H.265（常见 10-bit、1080x1920@60、15Mbps）。
 *   - 安卓 Chrome / 微信内置浏览器基本不支持 HEVC，桌面 Chrome 也多数不支持 → 卡顿、黑屏、转圈
 *   - 多数文件 moov 在尾部（非 faststart），起播前要先拉完整个文件
 *
 * 解法：入库后（或首次播放时）用 ffmpeg 生成 H.264 + faststart 的播放版存到 media/proxies/<id>.mp4，
 *   播放接口优先发代理版，**下载仍发原片**（保留原始画质）。
 * 队列串行（一次 1 条），避免低功耗 NAS 的 CPU 被转码打满。
 *
 * v1.11 修复：
 *   - ffmpeg 加硬超时（默认 15 分钟，PROXY_TIMEOUT_MS 可调），坏文件不再永久堵死队列
 *   - 失败/超时清理 .tmp 残留；入队前校验「done 但文件不在」→ 重新排队
 *   - HDR（HLG / PQ）源做 tonemap 转 SDR，避免转出来发灰
 *   - 10/12-bit 源即使编码是 h264 也要转（Chrome 解不了 High10）
 *   - 队列长度上限，防止恶意/误触发把转码排到天荒地老
 *   - 启动 GC：清掉 DB 里不存在的孤儿代理文件
 */
const path = require('path');
const fs = require('fs');
const { spawn, execFileSync } = require('child_process');
const db = require('../db');
const config = require('../config');

const TIMEOUT_MS = Math.max(5000, Number(process.env.PROXY_TIMEOUT_MS) || 15 * 60 * 1000);
const MAX_QUEUE = Math.max(1, Number(process.env.PROXY_MAX_QUEUE) || 30);

const state = { running: false, queued: 0, done: 0, failed: 0, lastError: null, lastAt: null };

const proxyDir = path.join(config.mediaDir, 'proxies');
fs.mkdirSync(proxyDir, { recursive: true });

const proxyFile = id => path.join(proxyDir, `${id}.mp4`);
const isReady = id => {
  const p = proxyFile(id);
  try { return fs.existsSync(p) && fs.statSync(p).size > 4096; } catch { return false; }
};

const setState = (id, st) => db.prepare('UPDATE videos SET proxy_state = ? WHERE id = ?').run(st, id);
const pendingCount = () => db.prepare("SELECT COUNT(*) c FROM videos WHERE proxy_state = 'pending'").get().c;

/** HDR 源（HLG / PQ）需要先 tonemap 到 BT.709 SDR，否则播放版会发灰过曝 */
const isHdr = v => {
  try {
    const out = execFileSync('ffprobe', [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=color_transfer',
      '-of', 'json', path.join(config.mediaDir, v.file_path),
    ], { encoding: 'utf8', timeout: 15000 });
    const tr = String(JSON.parse(out || '{}').streams?.[0]?.color_transfer || '');
    return tr === 'arib-std-b67' || tr === 'smpte2084';
  } catch {
    return false;   // 探测失败按 SDR 处理：宁可轻微偏色，也不要转码失败
  }
};

function videoFilter(v) {
  const base = 'scale=-2:min(1280\\,ih)';
  if (!isHdr(v)) return base;
  // HDR（BT.2020/HLG/PQ）→ SDR（BT.709）
  return 'zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,'
    + 'tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p,' + base;
}

const ffmpegArgs = (v, src, out) => [
  '-hide_banner', '-loglevel', 'error', '-y',
  '-i', src,
  '-map', '0:v:0', '-map', '0:a:0?',
  '-vf', videoFilter(v),
  '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
  '-maxrate', '2500k', '-bufsize', '5000k',
  '-profile:v', 'high', '-level', '4.0', '-pix_fmt', 'yuv420p',
  '-c:a', 'aac', '-b:a', '128k', '-ac', '2',
  '-movflags', '+faststart',
  '-f', 'mp4', out,
];

/** 是否值得转：H.264 + 8-bit + 长边 ≤1080 + ≤4.5Mbps 才直接播原片 */
function needsProxy(v) {
  const dur = Number(v.duration) || 0;
  const bps = dur > 0 ? (Number(v.size) * 8) / dur : 0;
  const tall = Math.max(Number(v.width) || 0, Number(v.height) || 0);
  const pix = String(v.pix_fmt || '');
  const highBit = /1[02]/.test(pix);   // yuv420p10le / p12le：High10 等浏览器解不了
  if (String(v.codec || '') === 'h264' && !highBit && tall > 0 && tall <= 1080 && bps <= 4500000) return false;
  return true;
}

const running = new Set();
const waiting = new Map();   // id -> Set<resolve>

const notifyWaiters = id => {
  const set = waiting.get(id);
  if (!set) return;
  waiting.delete(id);
  for (const fn of set) { try { fn(); } catch { /* ignore */ } }
};

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
    let settled = false;
    const done = r => { if (!settled) { settled = true; resolve(r); } };

    const ff = spawn('ffmpeg', ffmpegArgs(v, src, tmpOut), { stdio: ['ignore', 'ignore', 'pipe'] });
    // 硬超时：坏文件 / 超长文件不再永久占用串行队列
    const killer = setTimeout(() => {
      try { ff.kill('SIGKILL'); } catch { /* ignore */ }
      state.lastError = `转码超时（${Math.round(TIMEOUT_MS / 1000)}s）`;
      console.warn(`[proxy] 超时终止 ${id}`);
    }, TIMEOUT_MS);

    let errBuf = '';
    ff.stderr.on('data', d => { errBuf += d.toString(); if (errBuf.length > 4000) errBuf = errBuf.slice(-2000); });
    ff.on('error', e => {
      clearTimeout(killer);
      try { fs.rmSync(tmpOut, { force: true }); } catch { /* ignore */ }
      setState(id, 'failed');
      state.failed++;
      state.lastError = e.message;
      done({ ok: false, error: e.message });
    });
    ff.on('close', code => {
      clearTimeout(killer);
      if (code === 0 && fs.existsSync(tmpOut) && fs.statSync(tmpOut).size > 4096) {
        try {
          fs.renameSync(tmpOut, out);
        } catch (e) {
          try { fs.rmSync(tmpOut, { force: true }); } catch { /* ignore */ }
          setState(id, 'failed');
          state.failed++;
          return done({ ok: false, error: e.message });
        }
        setState(id, 'done');
        state.done++;
        state.lastAt = Date.now();
        console.log(`[proxy] ${id} 播放版就绪（${Math.round((Date.now() - started) / 1000)}s）`);
        done({ ok: true, path: out });
      } else {
        try { fs.rmSync(tmpOut, { force: true }); } catch { /* ignore */ }
        setState(id, 'failed');
        state.failed++;
        state.lastError = errBuf.trim().split('\n').pop() || `ffmpeg 退出码 ${code}`;
        console.warn(`[proxy] 转码失败 ${id}: ${state.lastError}`);
        done({ ok: false, error: state.lastError });
      }
    });
  });
}

let ticking = false;
async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    for (;;) {
      const v = db.prepare(
        "SELECT * FROM videos WHERE proxy_state = 'pending' ORDER BY created_at DESC LIMIT 1"
      ).get();
      if (!v) break;
      running.add(v.id);
      state.running = true;
      try { await runOne(v.id); } finally {
        running.delete(v.id);
        notifyWaiters(v.id);
      }
      state.queued = pendingCount();
    }
  } finally {
    state.running = running.size > 0;
    ticking = false;
  }
}

/**
 * 入队（幂等）。maxWaitMs > 0 时最多等这么久看能否转完。
 */
function queue(id, { maxWaitMs = 0, force = false } = {}) {
  const v = db.prepare('SELECT * FROM videos WHERE id = ?').get(id);
  if (!v) return Promise.resolve({ ok: false, error: '素材不存在' });
  if (isReady(id)) return Promise.resolve({ ok: true, cached: true });
  if (!needsProxy(v)) { setState(id, 'skipped'); return Promise.resolve({ ok: true, skipped: true }); }
  // done/skipped 但文件不在了（被清理 / 备份恢复漏了）→ 重新排队，否则永远等不到
  if (!v.proxy_state || v.proxy_state === 'failed' || v.proxy_state === 'done' || v.proxy_state === 'skipped') {
    setState(id, 'pending');
  }
  if (!force && pendingCount() > MAX_QUEUE) {
    return Promise.resolve({ ok: false, busy: true, error: '转码队列已满，先用原片播放' });
  }
  tick().catch(() => {});

  if (!maxWaitMs) return Promise.resolve({ ok: true, queued: true });
  return new Promise(resolve => {
    const set = waiting.get(id) || new Set();
    let finished = false;
    const finish = r => { if (!finished) { finished = true; resolve(r); } };
    const waiter = () => finish({ ok: isReady(id), timedOut: !isReady(id) });
    set.add(waiter);
    waiting.set(id, set);
    tick().catch(() => {});
    setTimeout(() => {
      const cur = waiting.get(id);
      if (cur) { cur.delete(waiter); if (!cur.size) waiting.delete(id); }
      finish({ ok: isReady(id), timedOut: true });
    }, maxWaitMs);
  });
}

/** 清理：删掉 DB 里没有对应素材的孤儿代理文件 + 所有 .tmp 残留 */
function gc() {
  let removed = 0;
  let names = [];
  try { names = fs.readdirSync(proxyDir); } catch { return { removed }; }
  const ids = new Set(db.prepare('SELECT id FROM videos').all().map(r => r.id));
  for (const name of names) {
    const isTmp = name.endsWith('.tmp.mp4');
    const id = name.replace(/\.tmp\.mp4$|\.mp4$/, '');
    if (isTmp || !ids.has(id)) {
      try { fs.rmSync(path.join(proxyDir, name), { force: true }); removed++; } catch { /* ignore */ }
    }
  }
  if (removed) console.log(`[proxy] 清理孤儿播放版 ${removed} 个`);
  return { removed };
}

/** 删除单条视频时顺手删它的代理文件 */
function dropOne(id) {
  try { fs.rmSync(proxyFile(id), { force: true }); } catch { /* ignore */ }
  try { fs.rmSync(proxyFile(id) + '.tmp.mp4', { force: true }); } catch { /* ignore */ }
}

/** 启动时把「转码中」的残留状态复位（进程被杀的情况） */
function recoverStale() {
  const r = db.prepare("UPDATE videos SET proxy_state = 'pending' WHERE proxy_state = 'running'").run();
  if (r.changes) console.log(`[proxy] 复位 ${r.changes} 条中断的转码任务`);
}

module.exports = {
  queue, tick, isReady, needsProxy, proxyFile, state,
  recoverStale, gc, dropOne, proxyDir, TIMEOUT_MS,
};
