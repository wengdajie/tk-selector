'use strict';
/**
 * 系统设置：AI 拆解（管理员统一管理，改完立即生效，不用重启容器）
 * 环境变量是出厂默认；DB 里的值优先。API Key 只回打码后的形态，原文只存不显。
 */
const express = require('express');
const settings = require('../lib/settings');
const ai = require('../lib/ai');
const { requireUser, requireAdmin } = require('../middleware');

const r = express.Router();

const mask = key => {
  const k = String(key || '');
  if (!k) return '';
  if (k.length <= 8) return '••••';
  return `${k.slice(0, 3)}••••${k.slice(-4)}`;
};

/** 当前生效值 + 来源标记（管理员改过的才标记 DB） */
r.get('/settings/ai', requireUser, (req, res) => {
  const aiNow = settings.getAi();
  const overlay = settings.aiOverlay();
  res.json({
    ...aiNow,
    apiKey: undefined,
    apiKeyMasked: mask(aiNow.apiKey),
    canEdit: req.user.role === 'admin',
    sources: Object.fromEntries(
      Object.entries(overlay).map(([k, v]) => [k, v === null ? 'env' : 'db'])
    ),
  });
});

const FIELD_CHECKS = [
  ['ai_base_url', '接入地址', v => /^https?:\/\/.+/.test(v), '要以 http:// 或 https:// 开头'],
  ['ai_model', '模型', v => String(v).trim().length > 0 && String(v).length <= 80, '不能为空'],
  ['ai_api_key', 'API Key', v => String(v).length <= 200, '太长了'],
  ['ai_frames', '抽帧数', v => Number.isInteger(Number(v)) && Number(v) >= 3 && Number(v) <= 10, '3 - 10 之间的整数'],
];

r.put('/settings/ai', requireUser, requireAdmin, (req, res) => {
  const body = req.body || {};
  const errors = [];
  const toSave = {};

  for (const [key, label, check, msg] of FIELD_CHECKS) {
    if (!(key in body)) continue;
    const val = body[key];
    if (val === null || val === '') {
      // Key 是敏感项：清空 = 明确不用（不回退环境变量）；其他字段清空 = 回退环境变量默认
      toSave[key] = key === 'ai_api_key' ? '' : null;
      continue;
    }
    const str = String(val).trim();
    if (!check(str)) { errors.push(`${label}：${msg}`); continue; }
    toSave[key] = str;
  }
  if ('ai_enabled' in body) {
    toSave.ai_enabled = body.ai_enabled ? '1' : '0';
  }
  if (errors.length) return res.status(400).json({ error: errors.join('；') });
  if (!Object.keys(toSave).length) return res.status(400).json({ error: '没有要保存的项' });

  for (const [key, value] of Object.entries(toSave)) {
    settings.set(key, value, req.user.id);
  }
  console.log(`[settings] ${req.user.name} 更新 AI 配置: ${Object.keys(toSave).join(', ')}`);

  const aiNow = settings.getAi();
  res.json({
    ok: true,
    saved: Object.keys(toSave),
    ...aiNow,
    apiKey: undefined,
    apiKeyMasked: mask(aiNow.apiKey),
    sources: Object.fromEntries(
      Object.entries(settings.aiOverlay()).map(([k, v]) => [k, v === null ? 'env' : 'db'])
    ),
  });
});

/** 连通性测试（与脚本库里的 AI 状态一致） */
r.get('/settings/ai/test', requireUser, async (req, res) => {
  res.json(await ai.status());
});

module.exports = r;
