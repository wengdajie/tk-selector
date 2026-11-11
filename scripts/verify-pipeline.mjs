import fs from 'node:fs';
const BASE = process.argv[2] || 'http://127.0.0.1:8081';
let pass = 0, fail = 0;
const ok = (c, l, e = '') => { c ? (pass++, console.log(`  OK   ${l}`)) : (fail++, console.log(`  FAIL ${l} ${e}`)); };
const call = async (p, { method = 'GET', body, uid } = {}) => {
  const res = await fetch(BASE + '/api' + p, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(uid ? { 'x-user-id': String(uid) } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
};

const login = await call('/login', { method: 'POST', body: { name: '管理员', password: 'tkadmin2026' } });
const uid = login.data.user.id;
const vids = (await call('/videos?limit=3', { uid })).data.items;

const p0 = (await call('/pipeline', { uid })).data;
ok(Array.isArray(p0.stages) && p0.stages.length === 5, '流水线返回 5 个阶段', JSON.stringify(p0.stages?.map(s => s.key)));
ok(typeof p0.passRate === 'number', '通过率为数字', String(p0.passRate));
ok(p0.dims?.length === 5, '返回 5 个评分维度');

const target = vids[0];
const scores = { hook: 9, visual: 7, point: 8, pace: 6, compliance: 10 };
let r = await call('/videos/' + target.id, { method: 'PATCH', body: { scores }, uid });
const sc = r.data.video?.score_content;
ok(sc === 80, '五个维度 9/7/8/6/10 得到综合分 80', String(sc));

r = await call('/videos/' + target.id, { method: 'PATCH', body: { stage: 'shortlisted' }, uid });
ok(r.data.video?.stage === 'shortlisted', '阶段可改为复选', r.data.video?.stage);

r = await call('/videos/' + target.id, { method: 'PATCH', body: { scores: { hook: 99, pace: -3 } }, uid });
ok(r.data.video?.scores?.hook === 10 && r.data.video?.scores?.pace === 6, '越界值被钳制、非法值忽略且其余维度保留', JSON.stringify(r.data.video?.scores));

r = await call('/videos?stage=shortlisted', { uid });
ok(r.data.items?.some(v => v.id === target.id), '按阶段筛选命中');

r = await call('/videos/bulk-stage', { method: 'POST', body: { ids: [target.id], stage: 'final' }, uid });
ok(r.data.ok && r.data.stage === 'final', '批量改阶段');

const p1 = (await call('/pipeline', { uid })).data;
const finalCount = p1.stages.find(s => s.key === 'final')?.count || 0;
ok(finalCount >= 1, '流水线统计反映定稿数量', String(finalCount));
const hookAvg = p1.dims.find(d => d.key === 'hook')?.avg;
ok(hookAvg != null && hookAvg > 0, '维度均分已统计', String(hookAvg));

// 还原
await call('/videos/' + target.id, { method: 'PATCH', body: { stage: 'new' }, uid });
const detail = (await call('/videos/' + target.id, { uid })).data.video;
const detailScores = typeof detail.scores === 'string' ? JSON.parse(detail.scores) : detail.scores;
ok(detailScores && detailScores.hook === 10, '详情返回完整分数对象', JSON.stringify(detail.scores));

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail ? 1 : 0);
