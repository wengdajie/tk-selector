import fs from 'node:fs';

const BASE = process.argv[2] || 'http://192.168.1.4:8899';
const F1 = 'C:/Users/HUATE/AppData/Local/Temp/sample.mp4';
const F2 = 'C:/Users/HUATE/AppData/Local/Temp/sample2.mp4';
let pass = 0, fail = 0;
const ok = (c, label, extra = '') => {
  if (c) { pass++; console.log(`  OK   ${label}`); }
  else { fail++; console.log(`  FAIL ${label} ${extra}`); }
};
const call = async (p, { method = 'GET', body, uid } = {}) => {
  const res = await fetch(BASE + '/api' + p, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(uid ? { 'x-user-id': String(uid) } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
};
const upload = async (paths, uid, extra = {}) => {
  const fd = new FormData();
  for (const [i, p] of paths.entries()) {
    fd.append('files', new Blob([fs.readFileSync(p)], { type: 'video/mp4' }), p.split('/').pop());
  }
  fd.append('space', extra.space || 'daily');
  fd.append('shootDate', new Date().toISOString().slice(0, 10));
  if (extra.title) fd.append('title', extra.title);
  const res = await fetch(BASE + '/api/videos/upload', { method: 'POST', headers: { 'x-user-id': String(uid) }, body: fd });
  return { status: res.status, data: await res.json().catch(() => ({})) };
};

const run = async () => {
  console.log(`\n端到端验证 -> ${BASE}\n`);
  const ADMIN_USER = process.env.ADMIN_USER || '管理员';
  const ADMIN_PASS = process.env.ADMIN_PASS || 'tkadmin2026';
  const login = await call('/login', { method: 'POST', body: { name: ADMIN_USER, password: ADMIN_PASS } });
  if (login.status !== 200) {
    console.error(`  登录失败（${ADMIN_USER}）: ${login.data.error || login.status}`);
    process.exit(1);
  }
  const admin = login.data.user;
  const users = (await call('/users', { uid: admin.id })).data.items;
  const ops = users.find(u => u.role === 'ops') || admin;
  console.log(`  身份: ${admin.name}(admin/${admin.id})  ${ops.name}(ops/${ops.id})\n`);

  // ---- 1. 上传 + 指纹去重（同一文件传两次）----
  const up1 = await upload([F1, F1], admin.id, { title: '端到端测试A' });
  ok(up1.status === 201 && up1.data.added === 1, '上传入库 1 个', JSON.stringify(up1.data).slice(0, 160));
  ok(up1.data.duplicates === 1, '同一文件重复上传被指纹去重');
  const a = up1.data.items?.[0];
  if (!a) { console.log('上传失败终止'); process.exit(1); }
  console.log(`  A: id=${a.id} ${a.width}x${a.height} ${a.duration}s thumb=${a.thumb_path ? '有' : '无'}`);

  // ---- 2. ffprobe / ffmpeg 产物 ----
  ok(a.duration >= 2.5 && a.duration <= 3.5, 'ffprobe 时长 ≈3s', String(a.duration));
  ok(a.width === 640 && a.height === 360, 'ffprobe 分辨率 640x360', `${a.width}x${a.height}`);
  ok(!!a.thumb_path, 'ffmpeg 生成缩略图');
  if (a.thumb_path) {
    const t = await fetch(`${BASE}/api/videos/${a.id}/thumb?uid=${admin.id}`);
    const tb = Buffer.from(await t.arrayBuffer());
    const isJpg = tb[0] === 0xFF && tb[1] === 0xD8;
    const isPng = tb[0] === 0x89 && tb[1] === 0x50;
    ok(t.status === 200 && tb.length > 1000 && (isJpg || isPng), '缩略图是有效图片', `${tb.length}B jpg=${isJpg} png=${isPng}`);
  }

  // ---- 3. 第二个视频（竖屏，用于 ZIP 打包）----
  const up2 = await upload([F2], ops.id, { title: '端到端测试B' });
  ok(up2.status === 201 && up2.data.added === 1, '第二个视频入库');
  const b = up2.data.items?.[0];
  ok(b?.width === 720 && b?.height === 1280, '竖屏 720x1280 正确识别', `${b?.width}x${b?.height}`);

  // ---- 4. 列表 / 日期分桶 / 上传人 ----
  const list = await call('/videos?space=daily&limit=20', { uid: admin.id });
  ok(list.data.items?.some(v => v.id === a.id), '每日列表可查到 A');
  ok((list.data.dates?.length || 0) > 0, '日期分桶已生成', String(list.data.dates?.length));
  const rowA = list.data.items.find(v => v.id === a.id);
  ok(rowA?.uploader_name === admin.name, '列表带上传人姓名', rowA?.uploader_name);

  // ---- 5. 视频流 + Range ----
  const raw = fs.readFileSync(F1);
  const s1 = await fetch(`${BASE}/api/videos/${a.id}/stream`, { headers: { 'x-user-id': String(admin.id) } });
  const s1b = Buffer.from(await s1.arrayBuffer());
  ok(s1.status === 200 && s1b.length === raw.length, '视频流完整可读', `${s1b.length}/${raw.length}B`);
  const s2 = await fetch(`${BASE}/api/videos/${a.id}/stream`, { headers: { 'x-user-id': String(admin.id), range: 'bytes=0-1023' } });
  ok(s2.status === 206, 'Range 分段请求 206（进度条可拖）', String(s2.status));

  // ---- 6. 评论 / 评分 ----
  const c = await call(`/videos/${a.id}/comments`, { method: 'POST', body: { body: '端到端测试评论' }, uid: ops.id });
  ok(c.status === 201, '运营可发评论');
  const cid = c.data.comment?.id;
  const rt = await call(`/videos/${a.id}`, { method: 'PATCH', body: { rating: 4 }, uid: ops.id });
  ok(rt.data.video?.rating === 4, '可打 4 星');
  const f5 = await call('/videos?minRating=4', { uid: admin.id });
  ok(f5.data.items?.some(v => v.id === a.id), '按评分下限筛选命中');

  // ---- 7. 下载记账（单文件 + 批量 ZIP）----
  const dl = await call('/downloads', { method: 'POST', body: { videoIds: [a.id], note: '端到端测试' }, uid: ops.id });
  ok(dl.status === 201 && dl.data.batchId, '创建单个下载批次');
  const f = await fetch(`${BASE}/api/downloads/${dl.data.batchId}/file`, { headers: { 'x-user-id': String(ops.id) } });
  const fb = Buffer.from(await f.arrayBuffer());
  ok(f.status === 200 && fb.length === raw.length, '单文件下载字节数一致', `${fb.length}B`);
  const rec = await call('/downloads?limit=20', { uid: admin.id });
  ok(rec.data.items?.some(d => d.batch_id === dl.data.batchId && d.user_name === ops.name), '下载记录带下载人姓名');

  const dl2 = await call('/downloads', { method: 'POST', body: { videoIds: [a.id, b.id], note: 'ZIP 测试' }, uid: ops.id });
  const zf = await fetch(`${BASE}/api/downloads/${dl2.data.batchId}/file`, { headers: { 'x-user-id': String(ops.id) } });
  const zb = Buffer.from(await zf.arrayBuffer());
  ok(zf.status === 200 && zb[0] === 0x50 && zb[1] === 0x4B, '两个文件打包为有效 ZIP', `${zb.length}B`);

  // ---- 8. 需求流转 ----
  const rq = await call('/requests', { method: 'POST', body: { title: '端到端测试需求', brief: '自动化', priority: 'low' }, uid: ops.id });
  ok(rq.status === 201, '发布视频需求');
  const rid = rq.data.request?.id;
  const cl = await call(`/requests/${rid}/claim`, { method: 'POST', body: { action: 'join' }, uid: admin.id });
  ok(cl.data.request?.status === 'claimed', '认领后进入进行中');
  const dn = await call(`/requests/${rid}`, { method: 'PATCH', body: { status: 'done' }, uid: admin.id });
  ok(dn.data.request?.status === 'done', '标记需求完成');

  // ---- 9. 统计 ----
  const st = await call('/stats', { uid: admin.id });
  ok(st.status === 200 && typeof st.data.dailyToday === 'number', '统计接口正常');
  console.log(`  统计: 今日 ${st.data.dailyToday} / 素材库 ${st.data.library} / 已评分 ${st.data.rated} / 平均 ${st.data.avgRating}`);

  // ---- 10. 注册 / 登录 / 改密 ----
  const uniq = 'e2e' + Date.now().toString().slice(-6);
  const reg = await call('/users', { method: 'POST', body: { name: uniq, role: 'ops', password: 'abc123' } });
  ok(reg.status === 201 && reg.data.user?.has_password === 1, '注册新用户并设密码');
  const nid = reg.data.user?.id;
  ok((await call('/login', { method: 'POST', body: { userId: nid, password: 'wrong' } })).status === 401, '错误密码被拒绝');
  ok((await call('/login', { method: 'POST', body: { userId: nid, password: 'abc123' } })).status === 200, '正确密码登录成功');
  ok((await call(`/users/${nid}/password`, { method: 'POST', body: { oldPassword: 'abc123', newPassword: 'newpass' }, uid: nid })).status === 200, '本人可改密码');
  ok((await call(`/users/${nid}`, { method: 'DELETE', uid: admin.id })).status === 200, '管理员可移除账号');

  // ---- 清理 ----
  if (cid) await call(`/comments/${cid}`, { method: 'DELETE', uid: admin.id });
  await call(`/requests/${rid}`, { method: 'DELETE', uid: ops.id });
  await call(`/videos/${a.id}`, { method: 'DELETE', uid: admin.id });
  await call(`/videos/${b.id}`, { method: 'DELETE', uid: admin.id });
  const after = await call('/videos?space=daily&limit=200', { uid: admin.id });
  ok(!after.data.items?.some(v => v.id === a.id || v.id === b.id), '测试上传的两条已从库中移除');

  console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail ? 1 : 0);
};

run().catch(e => { console.error('异常:', e); process.exit(1); });
