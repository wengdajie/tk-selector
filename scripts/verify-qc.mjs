import fs from 'node:fs';
const BASE = process.argv[2] || 'http://127.0.0.1:8081';
const T = 'C:/Users/HUATE/AppData/Local/Temp/';
let pass = 0, fail = 0;
const ok = (c, label, extra = '') => { c ? (pass++, console.log(`  OK   ${label}`)) : (fail++, console.log(`  FAIL ${label} ${extra}`)); };
const call = async (p, { method = 'GET', body, uid } = {}) => {
  const res = await fetch(BASE + '/api' + p, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(uid ? { 'x-user-id': uid } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
};
const upload = async (file, title, uid, date) => {
  const fd = new FormData();
  fd.append('files', new Blob([fs.readFileSync(T + file)], { type: 'video/mp4' }), file);
  fd.append('space', 'daily');
  fd.append('shootDate', date || new Date().toISOString().slice(0, 10));
  fd.append('title', title);
  const res = await fetch(BASE + '/api/videos/upload', { method: 'POST', headers: { 'x-user-id': String(uid) }, body: fd });
  return { status: res.status, data: await res.json().catch(() => ({})) };
};

const login = await call('/login', { method: 'POST', body: { name: '管理员', password: 'tkadmin2026' } });
const uid = login.data.user.id;
console.log(`admin=${uid}\n`);

const a = await upload('sample.mp4', 'QC样本A-原始', uid);
const b = await upload('sample_dup.mp4', 'QC样本B-转码版', uid);
const c = await upload('sample_silent.mp4', 'QC样本C-无音轨', uid);
const idA = a.data.items?.[0]?.id, idB = b.data.items?.[0]?.id, idC = c.data.items?.[0]?.id;
ok(!!idA && !!idB && !!idC, '三条测试素材上传成功');

// 立即体检（不依赖后台队列）
for (const id of [idA, idB, idC]) await call(`/videos/${id}/qc`, { method: 'POST', uid });

const A = (await call('/videos/' + idA, { uid })).data.video;
const B = (await call('/videos/' + idB, { uid })).data.video;
const C = (await call('/videos/' + idC, { uid })).data.video;

console.log('\n  A:', { score: A.qc_score, flags: A.qc_flags, lufs: A.lufs, phash: (A.phash || '').split(',').length + '帧' });
console.log('  B:', { score: B.qc_score, flags: B.qc_flags, sim_of: B.sim_of, dist: B.sim_dist });
console.log('  C:', { score: C.qc_score, flags: C.qc_flags, has_audio: C.has_audio });

ok(A.qc_status === 'done' && A.qc_score != null, '体检完成并写入分数');
ok(typeof A.lufs === 'number', '读到 EBU R128 响度', String(A.lufs));
ok((A.phash || '').split(',').filter(Boolean).length >= 2, '生成多帧感知哈希');
ok(B.sim_of === idA || B.sim_of === idC, '转码版被识别为重复素材（文件MD5无法识别）', String(B.sim_of));
ok(B.sim_dist != null && B.sim_dist <= 6, '相似距离在阈值内', String(B.sim_dist));
ok(String(C.qc_flags).includes('noaudio'), '无音轨被标记', C.qc_flags);
ok(C.has_audio === 0, '音频轨标记为无');
ok(A.qc_score >= B.qc_score, '低码率转码版评分不高于原片', `${A.qc_score} vs ${B.qc_score}`);

const bad = await call('/videos?qc=bad', { uid });
ok(bad.data.items?.some(v => v.id === C.id), '按体检异常筛选命中', String(bad.data.items?.length));

const sim = await call('/videos?similar=1', { uid });
ok(sim.data.items?.some(v => v.id === idB), '疑似重复筛选命中');

const csv = await fetch(`${BASE}/api/export.csv?uid=${uid}`);
const text = await csv.text();
ok(csv.status === 200 && text.includes('体检分'), 'CSV 清单可导出');
ok(text.split('\r\n').length >= 4, 'CSV 行数正确', String(text.split('\r\n').length));
console.log('  CSV 表头:', text.split('\r\n')[0].replace('\uFEFF', ''));

const detail = (await call('/videos/' + idB, { uid })).data;
ok(Array.isArray(detail.similar) && detail.similar.length >= 1, '详情返回相似素材列表');

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail ? 1 : 0);
