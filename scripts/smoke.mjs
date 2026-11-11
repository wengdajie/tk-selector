/**
 * 接口冒烟测试：node scripts/smoke.mjs [baseUrl] [账号] [密码]
 * 覆盖登录鉴权、列表、评论、下载、需求流转、评分、权限、注册改密、仪表盘。
 */
const BASE = process.argv[2] || 'http://127.0.0.1:8080';
const ADMIN_USER = process.argv[3] || '管理员';
const ADMIN_PASS = process.argv[4] || 'tkadmin2026';
let pass = 0, fail = 0;

const call = async (path, { method = 'GET', body, uid, raw } = {}) => {
  const res = await fetch(BASE + '/api' + path, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(uid ? { 'x-user-id': uid } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (raw) return { status: res.status, buf: Buffer.from(await res.arrayBuffer()) };
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
};

const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label} ${extra}`); }
};

const run = async () => {
  console.log(`\n冒烟测试 → ${BASE}\n`);

  // ---------- 鉴权 ----------
  let r = await call('/videos');
  ok(r.status === 401, '未登录时拒绝访问接口', r.status);

  r = await call('/users');
  ok(r.status === 401, '成员列表未登录不可读', r.status);

  r = await call('/login', { method: 'POST', body: { name: ADMIN_USER, password: 'wrong-password' } });
  ok(r.status === 401, '错误密码被拒绝', r.status);

  r = await call('/login', { method: 'POST', body: { name: ADMIN_USER, password: ADMIN_PASS } });
  ok(r.status === 200 && r.data.user?.role === 'admin', `内置管理员可登录（${ADMIN_USER}）`, r.status);
  const admin = r.data.user;
  if (!admin) { console.log('\n无法登录，后续用例跳过\n'); return finish(); }

  r = await call('/me', { uid: admin.id });
  ok(r.status === 200 && r.data.user.id === admin.id, '登录态可读取自己');

  const users = (await call('/users', { uid: admin.id })).data.items || [];
  const ops = users.find(u => u.role === 'ops') || admin;
  ok(users.length >= 1, `读到成员 ${users.length} 人`);

  // ---------- 列表 ----------
  r = await call('/videos?space=daily&limit=5', { uid: admin.id });
  ok(r.status === 200 && Array.isArray(r.data.items), '素材列表可读');
  const sample = r.data.items[0];
  if (!sample) {
    console.log('  ! 库里还没有素材，跳过素材相关用例');
    return finish();
  }
  ok(r.data.dates?.[0]?.date, `日期分桶 ${r.data.dates?.length} 个`);

  r = await call(`/videos/${sample.id}`, { uid: admin.id });
  ok(r.status === 200 && r.data.video.id === sample.id, '素材详情可读');

  // ---------- 评论 ----------
  r = await call(`/videos/${sample.id}/comments`, { method: 'POST', body: { body: '冒烟测试评论' }, uid: ops.id });
  ok(r.status === 201, '可以发评论');
  const cmtId = r.data.comment?.id;
  r = await call(`/comments/${cmtId}`, { method: 'DELETE', uid: admin.id });
  ok(r.status === 200, '管理员可删评论');
  r = await call(`/videos/${sample.id}/comments`, { method: 'POST', body: { body: '' }, uid: ops.id });
  ok(r.status === 400, '空评论被拒绝', r.status);

  // ---------- 播放 / 下载 ----------
  r = await call('/videos/' + sample.id + '/stream', { uid: admin.id, raw: true });
  ok(r.status === 200 && r.buf.length > 0, '视频流可读');

  r = await call('/downloads', { method: 'POST', body: { videoIds: [sample.id], note: '冒烟测试' }, uid: ops.id });
  ok(r.status === 201 && r.data.batchId, '创建下载批次 + 记录下载人');
  const batchId = r.data.batchId;
  r = await call(`/downloads/${batchId}/file`, { uid: ops.id, raw: true });
  ok(r.status === 200 && r.buf.length > 1000, `下载文件 ${r.buf.length} 字节`);
  r = await call('/downloads?limit=5', { uid: admin.id });
  ok(r.data.items?.some(d => d.batch_id === batchId && d.user_name), '下载记录带下载人姓名');

  // ---------- 需求 ----------
  r = await call('/requests', { method: 'POST', body: { title: '冒烟测试需求', brief: '自动化测试创建', priority: 'low' }, uid: ops.id });
  ok(r.status === 201, '发布需求');
  const reqId = r.data.request?.id;
  r = await call(`/requests/${reqId}/claim`, { method: 'POST', body: { action: 'join' }, uid: admin.id });
  ok(r.status === 200 && r.data.request.status === 'claimed', '认领后状态变为进行中');
  r = await call(`/requests/${reqId}`, { method: 'PATCH', body: { status: 'done' }, uid: admin.id });
  ok(r.status === 200 && r.data.request.status === 'done', '标记需求完成');
  r = await call(`/requests/${reqId}`, { method: 'DELETE', uid: ops.id });
  ok(r.status === 200, '发起人可删需求');

  // ---------- 权限 ----------
  const other = users.find(u => u.id !== sample.uploader_id && u.role !== 'admin');
  if (other && sample.uploader_id) {
    r = await call(`/videos/${sample.id}`, { method: 'DELETE', uid: other.id });
    ok(r.status === 403, '非上传者不能删素材', r.status);
  }

  // ---------- 评分 ----------
  r = await call('/videos/' + sample.id, { method: 'PATCH', body: { rating: 5 }, uid: admin.id });
  ok(r.status === 200 && r.data.video.rating === 5, '可以打 5 星');
  r = await call('/videos?minRating=5', { uid: admin.id });
  ok(r.data.items?.some(v => v.id === sample.id), '按评分下限筛选命中');
  r = await call('/videos/' + sample.id, { method: 'PATCH', body: { rating: 0 }, uid: admin.id });
  ok(r.data.video.rating === 0, '清除评分');

  // ---------- 日期范围 ----------
  const d0 = sample.shoot_date;
  r = await call(`/videos?space=daily&from=${d0}&to=${d0}`, { uid: admin.id });
  ok(r.status === 200 && r.data.items.every(v => v.shoot_date === d0), '按起止日期筛选');
  r = await call('/videos?space=daily&from=2099-01-01&to=2099-12-31', { uid: admin.id });
  ok(r.data.total === 0, '未来区间返回空');

  // ---------- 仪表盘 ----------
  r = await call('/dashboard', { uid: admin.id });
  ok(r.status === 200 && r.data.trend?.length >= 7, '仪表盘返回趋势数据');
  ok(typeof r.data.kpi?.requests?.done === 'number' && typeof r.data.kpi?.comments?.total === 'number', '仪表盘 KPI 完整');
  ok(r.data.ratingDist?.length === 5, '评分分布 5 档');
  ok(Array.isArray(r.data.activity) && Array.isArray(r.data.team), '团队与动态数据可用');
  const kpiSum = r.data.trend.reduce((a, t) => a + t.uploads, 0);
  ok(kpiSum >= 0, `趋势合计上传 ${kpiSum} 条`);

  // ---------- 注册 / 改密 ----------
  const uniq = 'smoke' + Date.now().toString().slice(-6);
  r = await call('/users', { method: 'POST', body: { name: uniq, role: 'ops', password: 'abc123' } });
  ok(r.status === 201 && r.data.user.has_password === 1, '注册需密码且成功');
  const newId = r.data.user.id;

  r = await call('/users', { method: 'POST', body: { name: uniq + 'x', role: 'ops', password: '12' } });
  ok(r.status === 400, '过短密码被拒绝', r.status);

  r = await call('/users', { method: 'POST', body: { name: uniq + 'y', role: 'admin', password: 'abc123' } });
  ok(r.status === 403, '未登录不能注册管理员', r.status);

  r = await call('/login', { method: 'POST', body: { name: uniq, password: 'abc123' } });
  ok(r.status === 200 && r.data.user.id === newId, '新账号可用名字登录');

  r = await call(`/users/${newId}/password`, { method: 'POST', body: { oldPassword: 'abc123', newPassword: 'newpass' }, uid: newId });
  ok(r.status === 200, '本人可改密码');
  r = await call('/login', { method: 'POST', body: { name: uniq, password: 'newpass' } });
  ok(r.status === 200, '新密码生效');

  r = await call(`/users/${newId}`, { method: 'DELETE', uid: admin.id });
  ok(r.status === 200, '管理员可移除测试账号');

  finish();
};

const finish = () => {
  console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail ? 1 : 0);
};

run().catch(e => { console.error('测试异常:', e.message); process.exit(1); });
