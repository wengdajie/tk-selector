'use strict';
/**
 * AI 脚本拆解：抽关键帧 → 多模态模型 → 结构化脚本（钩子/分镜/口播/标签）
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const db = require('../db');
const config = require('../config');
const ai = require('./ai');
const { uuid } = require('./util');

const FRAME_W = 720;

function grabFrame(file, atSec, outAbs, timeout = 30_000) {
  return new Promise((resolve, reject) => {
    execFile(config.ffmpegPath, [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
      '-ss', String(Math.max(0, atSec).toFixed(2)),
      '-i', file,
      '-frames:v', '1',
      '-vf', `scale=${FRAME_W}:-2`,
      '-q:v', '3',
      outAbs,
    ], { timeout, windowsHide: true }, err => (err ? reject(err) : resolve(outAbs)));
  });
}

/** 抽 N 帧（避开首尾），返回 [{t, sec, abs, path}] */
async function extractFrames(video, count) {
  const abs = path.join(config.mediaDir, video.file_path);
  if (!fs.existsSync(abs)) throw new Error('源文件不存在，可能已被移动或删除');

  const dur = Number(video.duration) || 0;
  const dirRel = path.join('frames', video.id);
  const dirAbs = path.join(config.mediaDir, dirRel);
  await fs.promises.mkdir(dirAbs, { recursive: true });

  const n = dur > 4 ? count : 1;
  const points = [];
  for (let i = 0; i < n; i++) {
    const frac = n === 1 ? 0.15 : 0.06 + (0.78 * i) / (n - 1);
    points.push(Math.max(0.1, Math.min(Math.max(0.1, dur - 0.3), dur * frac)));
  }

  const out = [];
  for (let i = 0; i < points.length; i++) {
    const rel = path.join(dirRel, `${i}.jpg`).split(path.sep).join('/');
    const absOut = path.join(config.mediaDir, rel);
    try {
      await grabFrame(abs, points[i], absOut);
      out.push({ i, sec: Number(points[i].toFixed(1)), path: rel });
    } catch { /* 单帧失败跳过 */ }
  }
  if (!out.length) throw new Error('抽帧失败，文件可能不可读');
  return out;
}

const mmss = s => {
  const t = Math.max(0, Math.round(Number(s) || 0));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
};

const SYSTEM = '你是资深 TikTok/抖音电商短视频编导，擅长把成片逆向拆解成可复用的拍摄脚本。只输出 JSON，不要任何解释文字。';

function buildPrompt(video, frames) {
  const marks = frames.map(f => `${mmss(f.sec)}（第 ${f.i + 1} 张图）`).join('、');
  return [
    `这是一条来自「${video.space === 'library' ? '素材库' : '每日选片'}」的电商短视频，时长 ${Math.round(video.duration || 0)} 秒，分辨率 ${video.width || '?'}×${video.height || '?'}。`,
    `我按时间顺序给你 ${frames.length} 张截图，时间码分别是：${marks}。`,
    '',
    '请基于画面和常识推断内容，输出严格 JSON（字段全部使用简体中文值）：',
    '{',
    '  "title": "8-16 字的脚本标题，带产品类型",',
    '  "summary": "一句话说清这条视频怎么卖货（30 字内）",',
    '  "hook": "前 3 秒的钩子是什么、为什么能留住人（40 字内）",',
    '  "tags": ["4-6 个标签，如 痛点开场/价格锚点/对比实验/口播带货/ASMR"],',
    '  "segments": [',
    '    {"t": "0:00-0:03", "shot": "画面：镜头/景别/动作/道具", "line": "这一段的字幕或口播，没有就写（无口播，仅画面）"}',
    '  ],',
    '  "script_text": "可直接给拍摄用的完整口播稿，按分段换行，200 字以内",',
    '  "cta": "结尾的行动号召或卖点收口"',
    '}',
    '',
    '要求：',
    '1) segments 至少 4 段，时间码要连贯覆盖整条视频，不要重叠；',
    '2) shot 写具体拍法（如“俯拍特写，手把收纳盒推入抽屉”），不要写“展示产品”这种空话；',
    '3) 不要编造画面里没有的品牌名或价格，不确定就不写；',
    '4) 全部用简体中文。',
  ].join('\n');
}

function normalizeJson(j, video) {
  const tags = Array.isArray(j?.tags) ? j.tags.filter(Boolean).map(String).slice(0, 8) : [];
  const segments = Array.isArray(j?.segments)
    ? j.segments.slice(0, 12).map((s, i) => ({
        t: String(s?.t || `${mmss(i * 3)}-${mmss((i + 1) * 3)}`).slice(0, 24),
        shot: String(s?.shot || '').slice(0, 200),
        line: String(s?.line || '').slice(0, 240),
      }))
    : [];
  return {
    title: String(j?.title || video.title || '').slice(0, 60),
    summary: String(j?.summary || '').slice(0, 120),
    hook: String(j?.hook || '').slice(0, 160),
    tags: tags.join(','),
    segments: JSON.stringify(segments),
    script_text: String(j?.script_text || '').slice(0, 2000),
    cta: String(j?.cta || '').slice(0, 160),
  };
}

const ins = db.prepare(`
  INSERT INTO scripts (id,video_id,status,model,frames,created_by,created_at,updated_at)
  VALUES (@id,@video_id,'pending',@model,@frames,@created_by,@t,@t)
`);
const updDone = db.prepare(`
  UPDATE scripts SET status='done', title=@title, summary=@summary, hook=@hook, segments=@segments,
    script_text=@script_text, cta=@cta, tags=@tags, raw=@raw, model=@model, updated_at=@t WHERE id=@id
`);
const updFail = db.prepare("UPDATE scripts SET status='failed', error=?, updated_at=? WHERE id=?");
const updRunning = db.prepare("UPDATE scripts SET status='running', updated_at=? WHERE id=?");

let active = 0;

/** 创建一个拆解任务（同一素材已有任务则复用，避免重复烧钱） */
function createJob(video, userId) {
  const busy = db.prepare(
    "SELECT * FROM scripts WHERE video_id = ? AND status IN ('pending','running','done') ORDER BY created_at DESC LIMIT 1"
  ).get(video.id);
  if (busy) return busy;

  const id = uuid();
  const now = Date.now();
  ins.run({ id, video_id: video.id, model: config.ai.model, frames: '', created_by: userId, t: now });
  const row = db.prepare('SELECT * FROM scripts WHERE id = ?').get(id);
  runJob(id, video).catch(() => {});
  return row;
}

async function runJob(id, video) {
  if (active >= 2) {
    // 简单排队：等前面跑完再起
    await new Promise(r => setTimeout(r, 1500));
  }
  active++;
  updRunning.run(Date.now(), id);
  try {
    const frames = await extractFrames(video, config.ai.frames);
    db.prepare('UPDATE scripts SET frames = ? WHERE id = ?')
      .run(JSON.stringify(frames.map(f => ({ t: f.sec, path: f.path }))), id);

    const images = frames.map(f => fs.readFileSync(path.join(config.mediaDir, f.path)).toString('base64'));
    const out = await ai.chat({
      system: SYSTEM,
      prompt: buildPrompt(video, frames),
      images,
      json: true,
    });
    if (!out.json) throw new Error('模型没有返回可解析的 JSON');

    const n = normalizeJson(out.json, video);
    updDone.run({ ...n, raw: String(out.text).slice(0, 8000), model: out.model, t: Date.now(), id });
    return db.prepare('SELECT * FROM scripts WHERE id = ?').get(id);
  } catch (e) {
    const msg = String(e.message || '拆解失败').slice(0, 400);
    updFail.run(msg, Date.now(), id);
    console.warn('[script] 失败:', id, msg);
    throw e;
  } finally {
    active--;
  }
}

/** 重新跑一个已有任务（失败重试 / 换模型重拆） */
function restart(scriptId) {
  const row = db.prepare('SELECT * FROM scripts WHERE id = ?').get(scriptId);
  if (!row) return null;
  const v = db.prepare('SELECT * FROM videos WHERE id = ?').get(row.video_id);
  if (!v) return null;
  db.prepare("UPDATE scripts SET status='running', error='', updated_at=? WHERE id=?").run(Date.now(), row.id);
  runJob(row.id, v).catch(() => {});
  return db.prepare('SELECT * FROM scripts WHERE id = ?').get(row.id);
}

module.exports = { createJob, restart, extractFrames };

