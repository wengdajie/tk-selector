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

/** 直接发一个自定义 payload（钉钉 feedCard 等结构不同于文本） */
async function sendPayload(payload) {
  const cfg = settings.getNotify();
  if (!cfg.enabled || !cfg.url || !TYPES.includes(cfg.type)) return { skipped: true };
  try {
    return await sendRaw(cfg, '', [], payload);
  } catch (e) {
    console.warn('[notify] 推送失败:', e.message);
    return { ok: false, error: e.message };
  }
}

/** 链接落点：优先「跳转地址」（可填内网 IP），否则公网地址 */
const linkBase = cfg => cfg.linkBase || cfg.publicBase || '';

/**
 * 钉钉：把链接包一层 dingtalk:// 协议，强制用系统浏览器打开。
 * 不包的话钉钉会用自己的内置浏览器（webview）打开，视频常播不了、也没法下载。
 * pc_slide=false → PC 端弹系统浏览器；移动端点开后也是系统浏览器。
 */
const dtOpen = url => `dingtalk://dingtalkclient/page/link?url=${encodeURIComponent(url)}&pc_slide=false`;

/** 按平台包装可点击链接：钉钉走 dingtalk://，其它平台直接用 http 链接 */
const openLink = (type, url) => (!url ? '' : type === 'dingtalk' ? dtOpen(url) : url);

/** 素材在网页里的深链（带 ?open=id，点开直接是这条素材的详情抽屉） */
const videoLink = (cfg, v) => {
  const base = linkBase(cfg);
  return base ? `${base}/?open=${v.id}` : '';
};

/** 公网基础地址（缩略图必须公网可达，钉钉/企微客户端要去拉图） */
const publicBase = () => settings.getNotify().publicBase || '';
const thumbUrl = (v, base) => base + '/api/videos/' + v.id + '/thumb';
const streamUrl = (v, base) => base + '/api/videos/' + v.id + '/stream';

/**
 * 发图前先确认公网地址真的活着。Cloudflare 快速隧道重启会换随机域名，
 * 旧域名会让钉钉/企微显示裂图——探测失败就退回纯文字通知，不发包裂图。
 */
async function probePublicBase(base) {
  if (!base) return { ok: false, reason: '未配置公网访问地址' };
  try {
    const res = await fetch(base.replace(/\/+$/, '') + '/healthz', { signal: AbortSignal.timeout(2500) });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    await res.body?.cancel?.();
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e?.name === 'TimeoutError' ? '探测超时（2.5s）' : (e?.message || '无法连接') };
  }
}

/** 真正发包（带一次重试）；「测试」接口用它拿错误信息 */
async function sendRaw(cfg, text, mentions, payloadOverride) {
  let url = cfg.url;
  if (cfg.type === 'dingtalk' && cfg.secret) {
    // 钉钉官方算法：key=密钥，消息体 = `时间戳\n密钥`（注意不是只签时间戳！）
    const ts = Date.now();
    const sign = encodeURIComponent(crypto.createHmac('sha256', cfg.secret).update(`${ts}\n${cfg.secret}`).digest('base64'));
    url += (url.includes('?') ? '&' : '?') + `timestamp=${ts}&sign=${sign}`;
  }
  const payload = payloadOverride || buildPayload(cfg.type, text, mentions);
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
async function onUpload(videos, uploader) {
  if (!videos?.length) return;
  const cfg = settings.getNotify();
  if (!cfg.onUpload) return;
  const who = uploader?.name || '投递目录扫描';
  const space = videos[0].space === 'library' ? '素材库' : '每日选片';
  const base = publicBase();
  const probe = await probePublicBase(base);
  if (base && !probe.ok) console.warn(`[notify] 公网地址不可达（${probe.reason}）：${base}；本次改发纯文字通知`);
  const thumbs = probe.ok ? videos.filter(v => v.thumb_path) : [];
  const titleOf = v => v.title || v.orig_name || '未命名';
  const durOf = v => (v.duration ? ' ' + fmtDur(v.duration) : '');

  // 钉钉：feedCard 缩略图卡片（标题 + 封面图 + 点击直达），最多 8 条
  // 注意：feedCard 不支持 @，入库通知本身也不需要艾特
  if (cfg.type === 'dingtalk' && thumbs.length) {
    const links = videos.slice(0, 8).map(v => ({
      title: '【' + space + '】' + titleOf(v) + durOf(v),
      messageURL: openLink(cfg.type, videoLink(cfg, v) || streamUrl(v, base)),
      picURL: thumbUrl(v, base),
    }));
    return sendPayload({ msgtype: 'feedCard', feedCard: { links } });
  }

  const plain = cfg.type === 'feishu';   // 飞书 text 消息不吃 markdown 和图片
  const lines = videos.slice(0, 5).map(v => {
    const line = `${plain ? '·' : '-'} 《${titleOf(v)}》${durOf(v)}`;
    const href = openLink(cfg.type, videoLink(cfg, v));
    // 钉钉 / 企微 markdown 支持 [文字](链接)；飞书 text 只能贴裸链接
    const linkTxt = !href ? '' : plain ? ` ${href}` : ` [▶ 打开](${href})`;
    // 企业微信 markdown 支持内嵌图片：带公网地址时贴封面缩略图
    const thumb = cfg.type === 'wecom' && thumbs.includes(v) ? '\n![' + titleOf(v) + '](' + thumbUrl(v, base) + ')' : '';
    return line + linkTxt + thumb;
  });
  const more = videos.length > 5 ? `\n…等共 ${videos.length} 条` : '';
  const tip = !base
    ? '\n（配置「公网访问地址」后，钉钉群会直接显示封面缩略图卡片）'
    : (!probe.ok ? `\n（公网地址当前不可达：${base}（${probe.reason}）。已改发纯文字，请检查隧道或更新系统设置里的公网地址）` : '');
  const text = [
    plain ? '📥 素材入库' : '**📥 素材入库**',
    `${who} 新入库 ${videos.length} 条素材到「${space}」`,
    ...lines,
  ].join('\n') + more + tip;
  return send(text, []);
}

/** 新评论（含 @人员）。comment: 评论正文；video: 素材行；author: 评论人 */
function onComment({ body, video, author }) {
  const cfg = settings.getNotify();
  if (!cfg.onComment) return;
  const mentions = resolveMentions(body, author?.id);
  const title = video?.title || video?.orig_name || '未命名素材';
  const href = video ? openLink(cfg.type, videoLink(cfg, video)) : '';
  // 钉钉/企微用 markdown 链接，飞书 text 贴裸链接（否则会显示成一串 Markdown 源码）
  const linkLine = !href ? ''
    : cfg.type === 'feishu' ? `\n${href}` : `\n\n[▶ 打开这条素材](${href})`;
  const text = cfg.type === 'feishu'
    ? `💬 新评论\n${author?.name || '有人'} 在《${title}》里评论：\n${body}${linkLine}`
    : `**💬 新评论**\n${author?.name || '有人'} 在《${title}》里评论：\n> ${body}${linkLine}`;
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

module.exports = { TYPES, send, onUpload, onComment, sendTest, resolveMentions, probePublicBase };
