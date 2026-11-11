'use strict';
/**
 * 选片流水线 + 分维度评分
 * 借鉴电商运营中台的「多轮筛选 + 维度量化」：单靠 1-5 星信息量太低，
 * 拆成 5 个内容维度（0-10）后，综合分才具备可比性，也能定位短板。
 */

const STAGES = [
  { key: 'new', label: '新入库', hint: '刚进来，还没人看' },
  { key: 'screened', label: '初筛', hint: '看过一遍，基本可用' },
  { key: 'shortlisted', label: '复选', hint: '进候选池，准备投放' },
  { key: 'final', label: '定稿', hint: '已确认，可交付' },
  { key: 'rejected', label: '淘汰', hint: '不用于投放' },
];

const STAGE_KEYS = STAGES.map(s => s.key);

const DIMS = [
  { key: 'hook', label: '前 3 秒钩子', hint: '开场能不能抓住人' },
  { key: 'visual', label: '画面质感', hint: '构图、光线、清晰度' },
  { key: 'point', label: '卖点清晰', hint: '产品卖点是否一眼看懂' },
  { key: 'pace', label: '节奏', hint: '信息密度、是否拖沓' },
  { key: 'compliance', label: '合规口播', hint: '无极限词、无误导表述' },
];

const DIM_KEYS = DIMS.map(d => d.key);

/** 把 {hook:8,...} 规范化为 0-10 的整数；非法值丢弃，0 表示「清零该维度」 */
function normalizeScores(input) {
  const out = {};
  if (!input || typeof input !== 'object') return out;
  for (const k of DIM_KEYS) {
    const raw = Number(input[k]);
    if (Number.isFinite(raw) && raw >= 0) out[k] = Math.max(0, Math.min(10, Math.round(raw)));
  }
  return out;
}

/** 综合内容分：0-100，未评分返回 null */
function contentScore(scores) {
  const vals = DIM_KEYS.map(k => Number(scores?.[k])).filter(v => Number.isFinite(v) && v > 0);
  if (!vals.length) return null;
  return Math.round(vals.reduce((a, b) => a + b, 0) / vals.length * 10);
}

const normStage = s => (STAGE_KEYS.includes(s) ? s : null);

module.exports = { STAGES, STAGE_KEYS, DIMS, DIM_KEYS, normalizeScores, contentScore, normStage };
