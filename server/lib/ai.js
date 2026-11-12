'use strict';
/**
 * OpenAI 兼容中转站客户端（默认 grsai）。
 * 只用最小能力：chat/completions + 图片输入（data URL base64）。
 */
const config = require('../config');

const stripFence = s => String(s || '')
  .replace(/^\s*```(?:json)?\s*/i, '')
  .replace(/\s*```\s*$/, '')
  .trim();

/** 从模型输出里抠出第一个 JSON 对象 */
function extractJson(text) {
  const s = stripFence(text);
  try { return JSON.parse(s); } catch { /* 继续尝试 */ }
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(s.slice(start, end + 1)); } catch { /* ignore */ }
  }
  return null;
}

async function postChat(body) {
  const url = config.ai.baseUrl + '/chat/completions';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), config.ai.timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.ai.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      const err = new Error(`AI 接口 ${res.status}: ${text.slice(0, 300)}`);
      err.status = res.status;
      err.body = text;
      throw err;
    }
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 多模态对话，返回 { text, json, usage, model }
 * @param {{system?:string, prompt:string, images?:string[], json?:boolean}} opts
 */
async function chat({ system, prompt, images = [], json = true }) {
  if (!config.ai.enabled) throw new Error('AI 已通过 AI_ENABLED=0 关闭');
  if (!config.ai.apiKey) throw new Error('未配置 AI_API_KEY（设置环境变量后重启容器）');

  const content = [{ type: 'text', text: prompt }];
  for (const b64 of images) {
    content.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}` } });
  }
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content });

  const base = {
    model: config.ai.model,
    messages,
    temperature: 0.4,
    max_tokens: 2400,
  };

  let data;
  try {
    data = await postChat(json ? { ...base, response_format: { type: 'json_object' } } : base);
  } catch (e) {
    // 有些中转站不支持 response_format，去掉重试一次
    if (e.status === 400 && json) data = await postChat(base);
    else throw e;
  }

  const text = data?.choices?.[0]?.message?.content ?? '';
  return {
    text,
    json: json ? extractJson(text) : null,
    usage: data?.usage || null,
    model: data?.model || config.ai.model,
  };
}

/** 连通性自检：拉模型列表（不是所有中转站都开放，失败也算正常） */
async function status() {
  const info = {
    enabled: config.ai.enabled,
    baseUrl: config.ai.baseUrl,
    model: config.ai.model,
    hasKey: !!config.ai.apiKey,
    reachable: false,
    models: null,
    error: null,
  };
  if (!config.ai.enabled) return info;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(config.ai.baseUrl + '/models', {
      headers: config.ai.apiKey ? { authorization: `Bearer ${config.ai.apiKey}` } : {},
      signal: ctrl.signal,
    });
    clearTimeout(t);
    info.reachable = res.ok;
    if (res.ok) {
      const j = await res.json().catch(() => null);
      info.models = (j?.data || []).map(m => m.id).slice(0, 60);
    } else {
      info.error = `HTTP ${res.status}`;
    }
  } catch (e) {
    info.error = String(e.message).slice(0, 160);
  }
  return info;
}

module.exports = { chat, status, extractJson };
