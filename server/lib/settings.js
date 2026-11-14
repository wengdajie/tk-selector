'use strict';
/**
 * 运行时设置：环境变量是「出厂默认」，管理员在界面里改的值存 DB、立即生效。
 * 存 NULL 表示清空回退到默认。
 */
const db = require('../db');
const config = require('../config');

const getStmt = db.prepare('SELECT value FROM settings WHERE key = ?');
const insStmt = db.prepare(`
  INSERT INTO settings (key, value, updated_by, updated_at) VALUES (@k, @v, @u, @t)
  ON CONFLICT(key) DO UPDATE SET value = @v, updated_by = @u, updated_at = @t
`);

/** 读原始值：null / 未写入 = 未设置（回退环境变量）；'' = 管理员明确清空 */
const raw = key => getStmt.get(key)?.value ?? null;

/** AI 超时范围：30 秒 ~ 15 分钟 */
const clampMs = v => Math.min(900000, Math.max(30000, Number(v) || 300000));

/** 写入；null = 清除并回退默认；'' = 明确置空（仅 Key 这类敏感项用） */
function set(key, value, userId = null) {
  insStmt.run({ k: key, v: value ?? null, u: userId, t: Date.now() });
}

/** AI 相关的有效配置（每次调用都现读，改完不用重启） */
function getAi() {
  const clampFrames = v => Math.min(10, Math.max(3, Number(v) || 6));
  return {
    enabled: (raw('ai_enabled') ?? (config.ai.enabled ? '1' : '0')) !== '0',
    baseUrl: (raw('ai_base_url') || config.ai.baseUrl).replace(/\/+$/, ''),
    // Key 例外：管理员清空存的是 ''（明确不用 Key），只有 null 才回退环境变量
    apiKey: raw('ai_api_key') ?? config.ai.apiKey,
    model: raw('ai_model') || config.ai.model,
    frames: clampFrames(raw('ai_frames') ?? config.ai.frames),
    timeoutMs: clampMs(raw('ai_timeout_ms') ?? config.ai.timeoutMs),
  };
}

/** AI 设置项列表（值未写 DB 的项返回 null，前端据此显示「默认」） */
function aiOverlay() {
  return {
    ai_enabled: raw('ai_enabled'),
    ai_base_url: raw('ai_base_url'),
    ai_api_key: raw('ai_api_key'),
    ai_model: raw('ai_model'),
    ai_frames: raw('ai_frames'),
    ai_timeout_ms: raw('ai_timeout_ms'),
  };
}

const NOTIFY_TYPES = ['wecom', 'feishu', 'dingtalk'];
function getNotify() {
  const t = raw('notify_type');
  return {
    enabled: (raw('notify_enabled') ?? (config.notify.enabled ? '1' : '0')) !== '0',
    type: NOTIFY_TYPES.includes(t) ? t : config.notify.type,
    url: (raw('notify_url') ?? (config.notify.url || '')).trim(),
    // 密钥同 Key 的语义：null=未设置（回退 env），''=明确不加签
    secret: raw('notify_secret') ?? config.notify.secret,
    onUpload: (raw('notify_on_upload') ?? (config.notify.onUpload ? '1' : '0')) !== '0',
    onComment: (raw('notify_on_comment') ?? (config.notify.onComment ? '1' : '0')) !== '0',
    publicBase: ((raw('notify_public_base') ?? config.notify.publicBase) || '').trim().replace(/\/+$/, ''),
    // 跳转链接地址：可填内网 IP（如 http://192.168.1.4:8899），不填则用公网地址
    linkBase: (((raw('notify_link_base') ?? config.notify.linkBase) || '').trim() || '').replace(/\/+$/, ''),
  };
}

/** 通知设置项列表（值未写 DB 的项返回 null） */
function notifyOverlay() {
  return {
    notify_enabled: raw('notify_enabled'),
    notify_type: raw('notify_type'),
    notify_url: raw('notify_url'),
    notify_secret: raw('notify_secret'),
    notify_on_upload: raw('notify_on_upload'),
    notify_on_comment: raw('notify_on_comment'),
    notify_public_base: raw('notify_public_base'),
    notify_link_base: raw('notify_link_base'),
  };
}

module.exports = { get: raw, set, getAi, aiOverlay, getNotify, notifyOverlay };
