'use strict';
/**
 * 群通知：企业微信 / 飞书 / 钉钉 群机器人 webhook 推送。
 * 触发点：素材入库（网页上传 / NAS 投递目录扫描）、新评论（评论里 @成员 → 群里真实艾特）。
 * 配置来自 lib/settings（env 出厂默认，管理员界面值优先、立即生效）。
 * 通知失败只记日志，绝不影响业务请求。
 */
const crypto = require('crypto');
const db = require('../db');
const settings = require('./settings');

const TYPES = ['wecom', 'feishu', 'dingtalk'];

const fmtDur = s => {
  const t = Math.round(Number(s) || 0);
  return t >= 60 ? `${Math.floor(t / 60)}分${t % 60 ? (t % 60) + '秒' : ''}` : `${t}秒`;
};

/** 评论文本里找出被 @ 到的成员（按名字精确匹配），带上可艾特的外部账号标识 */
function resolveMentions(body, authorId) {
  const text = String(body || '');
  const users = db.prepare('SELECT id, name, notify_key FROM users WHERE active = 1').all();
  return users
    .filter(u => u.id !== authorId && text.includes('@' + u.name))
    .map(u => ({ name: u.name, key: u.notify_key || '' }));
}

/** 把 @提及按平台语法渲染（追加在正文末尾，正文里的 @名字 保持原样） */
function mentionSuffix(type, mentions) {
  if (!mentions?.length) return '';
  const parts = [];
  for (const m of mentions) {
    if (!m.key) continue;   // 没配「通知账号」的成员艾特不到，正文里的 @名字 仍在
    if (type === 'wecom') parts.push(`<@${m.key}>`);
    else if (type === 'feishu') parts.push(`<at user_id="${m.key}"></at>`);
    else parts.push(`@${m.key}`);   // 钉钉：markdown 里艾特手机号
  }
  return parts.length ? '\n' + parts.join(' ') : '';
}

/** 钉钉 atMobiles（只收长得像手机号的 key） */
const atMobiles = mentions => (mentions || [])
  .filter(m => m.key && /^1\d{10}$/.test(m.key))
  .map(m => m.key);

function buildPayload(type, text, mentions) {
  const full = text + mentionSuffix(type, mentions);
  if (type === 'feishu') {
    const payload = { msg_type: 'text', content: { text: full } };
    const secret = settings.getNotify().secret;
    if (secret) {
      // 飞书自定义机器人加签：以「时间戳\n密钥」为 key 做 HMAC-SHA256，消息体为空
      const ts = String(Math.floor(Date.now() / 1000));
      payload.timestamp = ts;
      payload.sign = crypto.createHmac('sha256', `${ts}\n${secret}`).update('').digest('base64');
    }
    return payload;
  }
  if (type === 'dingtalk') {
    return {
      msgtype: 'markdown',
      markdown: { title: '选片通知', text: full },
      at: { atMobiles: atMobiles(mentions), isAtAll: false },
    };
  }
  // 企业微信 markdown
  return { msgtype: 'markdown', markdown: { content: full } };
}

/** 各平台错误码形状不一：errcode / code / StatusCode，非 0 都算失败 */
function checkPlatformResult(text) {
  let data = null;
  try { data = JSON.parse(text); } catch { return; }
  const code = data.errcode ?? data.code ?? data.StatusCode;
  if (typeof code === 'number' && code !== 0) {
    throw new Error(`平台返回 ${code}：${data.errmsg || data.msg || data.StatusMessage || '未知错误'}`);
  }
}

async function postJson(url, payload, timeoutMs = 8000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctl.signal,
    });
    const text = await res.text().catch(() => '');
    if (!res.ok) throw new Error(`HTTP ${res.status} ${text.slice(0, 120)}`);
    checkPlatformResult(text);
    return true;
  } finally {
    clearTimeout(timer);
  }
}

/** 发一条通知（内部使用；失败记日志，不抛出） */
async function send(text, mentions = []) {
  const cfg = settings.getNotify();
  if (!cfg.enabled || !cfg.url || !TYPES.includes(cfg.type)) return { skipped: true };
  try {
    return await sendRaw(cfg, text, mentions);
  } catch (e) {
    console.warn('[notify] 推送失败:', e.message);
    return { ok: false, error: e.message };
  }
}

/** 真正发包（带一次重试）；「测试」接口用它拿错误信息 */
async function sendRaw(cfg, text, mentions) {
  let url = cfg.url;
  if (cfg.type === 'dingtalk' && cfg.secret) {
    // 钉钉加签：以密钥为 key 对时间戳做 HMAC-SHA256，拼到 URL 上
    const ts = Date.now();
    const sign = encodeURIComponent(crypto.createHmac('sha256', cfg.secret).update(String(ts)).digest('base64'));
    url += (url.includes('?') ? '&' : '?') + `timestamp=${ts}&sign=${sign}`;
  }
  const payload = buildPayload(cfg.type, text, mentions);
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try { return { ok: await postJson(url, payload) }; }
    catch (e) {
      lastErr = e;
      if (e?.name === 'AbortError') break;   // 超时不重试
      if (attempt === 0) await new Promise(r => setTimeout(r, 1500));
    }
  }
  throw lastErr;
}

/* ---------------- 业务事件 ---------------- */

/** 素材入库（上传 / 扫描）。videos: 新入库的素材行；uploader: 触发人（扫描可为空） */
function onUpload(videos, uploader) {
  if (!videos?.length) return;
  const cfg = settings.getNotify();
  if (!cfg.onUpload) return;
  const who = uploader?.name || '投递目录扫描';
  const space = videos[0].space === 'library' ? '素材库' : '每日选片';
  const plain = cfg.type === 'feishu';   // 飞书 text 消息不吃 markdown
  const lines = videos.slice(0, 5).map(v =>
    `${plain ? '·' : '-'} 《${v.title || v.orig_name || '未命名'}》${v.duration ? `（${fmtDur(v.duration)}）` : ''}`);
  const more = videos.length > 5 ? `\n…等共 ${videos.length} 条` : '';
  const text = [
    plain ? '📥 素材入库' : '**📥 素材入库**',
    `${who} 新入库 ${videos.length} 条素材到「${space}」`,
    ...lines,
  ].join('\n') + more;
  return send(text, []);
}

/** 新评论（含 @人员）。comment: 评论正文；video: 素材行；author: 评论人 */
function onComment({ body, video, author }) {
  const cfg = settings.getNotify();
  if (!cfg.onComment) return;
  const mentions = resolveMentions(body, author?.id);
  const title = video?.title || video?.orig_name || '未命名素材';
  const text = cfg.type === 'feishu'
    ? `💬 新评论\n${author?.name || '有人'} 在《${title}》里评论：\n${body}`
    : `**💬 新评论**\n${author?.name || '有人'} 在《${title}》里评论：\n> ${body}`;
  return send(text, mentions);
}

/** 设置页「测试」按钮用：发一条固定的测试消息，返回成败与错误 */
async function sendTest() {
  const cfg = settings.getNotify();
  if (!cfg.enabled) return { ok: false, error: '通知未启用' };
  if (!cfg.url) return { ok: false, error: '未配置 Webhook 地址' };
  const text = cfg.type === 'feishu'
    ? '✅ 选片工作台通知测试\n收到这条说明 webhook 配置正确'
    : '**✅ 选片工作台通知测试**\n收到这条说明 webhook 配置正确';
  try {
    await sendRaw(cfg, text, []);
    return { ok: true };
  } catch (e) {
    const msg = e?.name === 'AbortError' ? '推送超时（8 秒无响应）' : e.message;
    console.warn('[notify] 测试失败:', msg);
    return { ok: false, error: msg };
  }
}

module.exports = { TYPES, send, onUpload, onComment, sendTest, resolveMentions };
