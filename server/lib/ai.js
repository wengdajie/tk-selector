'use strict';
/**
 * OpenAI 兼容中转站客户端（默认 grsai）。
 * 只用最小能力：chat/completions + 图片输入（data URL base64）。
 * 配置来自 lib/settings：环境变量是默认值，管理员界面改的值优先、立即生效。
 */
const settings = require('./settings');

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

async function postChatOnce(body) {
  const ai = settings.getAi();
  const url = ai.baseUrl + '/chat/completions';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ai.timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${ai.apiKey}`,
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

/** 网络抖动 / 限流自动重试一次（超时和参数错误不重试，省额度） */
async function postChat(body) {
  let last;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await postChatOnce(body);
    } catch (e) {
      last = e;
      if (e?.name === 'AbortError') {
        throw new Error(`模型响应超时（${Math.round(settings.getAi().timeoutMs / 1000)} 秒），请稍后重试或调大超时`);
      }
      const retryable = e.status === 429 || (e.status >= 500 && e.status < 600) || e?.name === 'TypeError';
      if (!retryable || attempt === 1) throw e;
      console.warn(`[ai] 调用失败（${e.message.slice(0, 80)}），2 秒后重试一次`);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  throw last;
}

/**
 * 多模态对话，返回 { text, json, usage, model }
 * @param {{system?:string, prompt:string, images?:string[], json?:boolean}} opts
 */
async function chat({ system, prompt, images = [], json = true }) {
  const ai = settings.getAi();
  if (!ai.enabled) throw new Error('AI 已在设置里关闭');
  if (!ai.apiKey) throw new Error('未配置 API Key，请管理员到「设置 → AI 拆解」里填写');

  const content = [{ type: 'text', text: prompt }];
  for (const b64 of images) {
    content.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}` } });
  }
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content });

  const base = {
    model: ai.model,
    messages,
    temperature: 0.4,
    max_tokens: 4000,   // 长脚本（分镜 + 复刻提示词）留足余量，截断会导致 JSON 解析失败
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
    model: data?.model || ai.model,
  };
}

/** 连通性自检：拉模型列表（不是所有中转站都开放，失败也算正常） */
async function status() {
  const ai = settings.getAi();
  const info = {
    enabled: ai.enabled,
    baseUrl: ai.baseUrl,
    model: ai.model,
    hasKey: !!ai.apiKey,
    reachable: false,
    models: null,
    error: null,
  };
  if (!ai.enabled) return info;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(ai.baseUrl + '/models', {
      headers: ai.apiKey ? { authorization: `Bearer ${ai.apiKey}` } : {},
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
    info.error = e?.name === 'AbortError' ? '连接超时（8 秒无响应）' : String(e.message).slice(0, 160);
  }
  return info;
}

module.exports = { chat, status, extractJson };
