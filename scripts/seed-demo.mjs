/**
 * 演示数据：给本地环境造几条需求、评论、下载记录，方便首次预览效果。
 * 用法：node scripts/seed-demo.mjs [baseUrl]
 */
const BASE = process.argv[2] || 'http://127.0.0.1:8080';

const call = async (path, { method = 'GET', body, uid } = {}) => {
  const res = await fetch(BASE + '/api' + path, {
    method,
    headers: { 'content-type': 'application/json', ...(uid ? { 'x-user-id': uid } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path} → ${res.status} ${data.error || ''}`);
  return data;
};

const users = (await call('/users')).items;
const admin = users.find(u => u.role === 'admin') || users[0];
const ops = users.find(u => u.role === 'ops') || admin;
const shooter = users.find(u => u.role === 'shooter') || admin;

const videos = (await call('/videos?space=daily&limit=20', { uid: admin.id })).items;
if (!videos.length) {
  console.error('没有素材，先扫描或上传视频再跑演示数据');
  process.exit(1);
}

// 1) 需求
const reqs = [
  {
    title: '需要 3 条厨房收纳的痛点开场',
    brief: '前 3 秒必须出现「抽屉乱成一团」的画面，后面接产品解决。竖屏 9:16，单条 15-25 秒。\n参考：https://www.tiktok.com/@xxx/video/123\n出镜：不需要真人，只拍手部操作。',
    priority: 'high',
    dueDate: new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10),
    platform: 'TikTok',
    tags: '厨房,痛点开场',
  },
  {
    title: 'LED 灯带夜间氛围素材 5 条',
    brief: '卧室、书桌两个场景各拍 2-3 条，关灯只留灯带光源。要能看到颜色渐变的过程。',
    priority: 'normal',
    dueDate: new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10),
    platform: 'TikTok',
    tags: '灯光,氛围',
  },
  {
    title: '车载吸尘器开箱 + 实测',
    brief: '开箱过程完整，然后拍一段清理座椅缝隙的实测。需要拍清楚吸出来的灰尘。',
    priority: 'low',
    platform: 'TikTok Shop',
    tags: '开箱,实测',
  },
];

const created = [];
for (const r of reqs) {
  const { request } = await call('/requests', { method: 'POST', body: r, uid: ops.id });
  created.push(request);
  console.log('需求:', request.title);
}

// 2) 认领
await call(`/requests/${created[0].id}/claim`, { method: 'POST', body: { action: 'join' }, uid: shooter.id });
await call(`/requests/${created[1].id}/claim`, { method: 'POST', body: { action: 'join' }, uid: ops.id });
console.log('已认领 2 条需求');

// 3) 评论
const comments = [
  [0, ops.id, '这条开场节奏可以，但产品出现太晚了，第 3 秒就该露出来'],
  [0, shooter.id, '收到，明天补拍一版把产品提前'],
  [1, admin.id, '灯带这个颜色我更喜欢暖白，能再拍一条吗'],
  [2, ops.id, '缝隙那段拍得不错，就是手抖了'],
];
for (const [i, uid, body] of comments) {
  if (!videos[i]) continue;
  await call(`/videos/${videos[i].id}/comments`, { method: 'POST', body: { body }, uid });
}
console.log('已写入', comments.length, '条评论');

// 4) 下载记录
const pick = videos.slice(0, 3).map(v => v.id);
const dl = await call('/downloads', {
  method: 'POST',
  body: { videoIds: pick, note: '给 A 组剪 11.11 的素材' },
  uid: ops.id,
});
console.log('下载批次:', dl.batchId, dl.count, '条');

await call(`/videos/${videos[0].id}`, { method: 'PATCH', body: { status: 'picked' }, uid: ops.id });
if (videos[1]) await call(`/videos/${videos[1].id}`, { method: 'PATCH', body: { tags: '厨房,爆款结构' }, uid: ops.id });

console.log('\n完成，打开', BASE, '查看');
