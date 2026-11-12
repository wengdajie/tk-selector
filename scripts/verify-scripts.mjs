/**
 * AI 脚本拆解 端到端验证
 * 起一个假的 OpenAI 兼容中转站 + 真服务 + 真 ffmpeg 抽帧，全链路跑一遍。
 *   node scripts/verify-scripts.mjs
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tk-script-'));
const PORT = 8199;
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0, fail = 0;
const ok = (c, label, extra = '') => {
  if (c) { pass++; console.log(`  OK   ${label}`); }
  else { fail++; console.log(`  FAIL ${label} ${extra}`); }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------------- 1. 假的中转站 ---------------- */
const MOCK = {
  title: '收纳盒痛点开场实测',
  summary: '用乱糟糟的抽屉开场制造痛点，再用对比演示收纳效果带出货。',
  hook: '前三秒是拉不开的抽屉特写，直接命中“家里乱”的痛点。',
  tags: ['痛点开场', '对比实验', '口播带货', '特写细节'],
  segments: [
    { t: '0:00-0:02', shot: '俯拍特写，手用力拽一个塞满杂物的抽屉，抽屉卡住', line: '你家抽屉是不是也这样？' },
    { t: '0:02-0:05', shot: '中景，桌面上散落的杂物被推到一起', line: '东西一多，找什么都找不到。' },
    { t: '0:05-0:09', shot: '手持跟拍，把杂物按格子放进收纳盒', line: '按格子分好，一眼就能看到。' },
    { t: '0:09-0:13', shot: '特写，抽屉一推到底顺滑合上', line: '推回去，一点不卡。' },
    { t: '0:13-0:16', shot: '正面半身口播，手指收纳盒', line: '链接放下面，颜色自己挑。' },
  ],
  script_text: '你家抽屉是不是也这样？\n东西一多，找什么都找不到。\n按格子分好，一眼就能看到。\n推回去，一点不卡。\n链接放下面，颜色自己挑。',
  cta: '结尾口播引导，强调“颜色可选”，不做绝对化表述。',
};
const seen = [];
const mock = http.createServer((req, res) => {
  let buf = '';
  req.on('data', c => { buf += c; });
  req.on('end', () => {
    if (req.url.includes('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'mock-vision' }, { id: 'gpt-4o' }] }));
    }
    let body = {};
    try { body = JSON.parse(buf || '{}'); } catch { /* ignore */ }
    const content = body.messages?.at(-1)?.content || [];
    const images = content.filter(c => c.type === 'image_url');
    seen.push({ model: body.model, images: images.length, hasPrompt: !!content.find(c => c.type === 'text') });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'mock-1',
      model: body.model || 'mock-vision',
      choices: [{ index: 0, message: { role: 'assistant', content: '```json\n' + JSON.stringify(MOCK) + '\n```' } }],
      usage: { total_tokens: 2048 },
    }));
  });
});
await new Promise(r => mock.listen(0, '127.0.0.1', r));
const aiPort = mock.address().port;
console.log(`假中转站 127.0.0.1:${aiPort}\n`);

/* ---------------- 2. 素材 + 服务 ---------------- */
const sample = path.join(tmp, 'sample.mp4');
execFileSync('ffmpeg', [
  '-hide_banner', '-loglevel', 'error', '-y',
  '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25',
  '-f', 'lavfi', '-i', 'sine=frequency=440',
  '-t', '10', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast',
  '-c:a', 'aac', '-shortest', sample,
]);

const env = {
  ...process.env,
  PORT: String(PORT),
  HOST: '127.0.0.1',
  DATA_DIR: path.join(tmp, 'data'),
  SCAN_DIR: path.join(tmp, 'watch'),
  SCAN_INTERVAL: '0',
  AI_BASE_URL: `http://127.0.0.1:${aiPort}/v1`,
  AI_API_KEY: 'sk-mock-key',
  AI_MODEL: 'mock-vision',
  AI_FRAMES: '4',
  AI_TIMEOUT_MS: '30000',
};
fs.mkdirSync(path.join(tmp, 'data'), { recursive: true });
fs.mkdirSync(path.join(tmp, 'watch'), { recursive: true });

const srv = spawn(process.execPath, ['server/index.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
srv.stdout.on('data', d => { log += d; });
srv.stderr.on('data', d => { log += d; });

const stop = () => { try { srv.kill(); } catch { /* ignore */ } mock.close(); };

let ready = false;
for (let i = 0; i < 80; i++) {
  try {
    const r = await fetch(BASE + '/api/version');
    if (r.ok) { ready = true; break; }
  } catch { /* 还没起来 */ }
  await sleep(300);
}
if (!ready) {
  console.log('服务没起来：\n' + log.slice(-2000));
  stop();
  process.exit(1);
}

const call = async (p, { method = 'GET', body, uid } = {}) => {
  const res = await fetch(BASE + '/api' + p, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(uid ? { 'x-user-id': uid } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
};

/* ---------------- 3. 断言 ---------------- */
const login = await call('/login', { method: 'POST', body: { name: '管理员', password: 'tkadmin2026' } });
ok(login.status === 200, '管理员登录', String(login.status));
const uid = login.data.user?.id;

const fd = new FormData();
fd.append('files', new Blob([fs.readFileSync(sample)], { type: 'video/mp4' }), 'sample.mp4');
fd.append('space', 'library');
fd.append('shootDate', new Date().toISOString().slice(0, 10));
fd.append('title', 'AI拆解验证素材');
const up = await fetch(BASE + '/api/videos/upload', { method: 'POST', headers: { 'x-user-id': uid }, body: fd });
const upData = await up.json().catch(() => ({}));
const vid = upData.items?.[0]?.id;
ok(up.ok && !!vid, '上传一条素材', String(up.status));

const st = await call('/ai/status', { uid });
ok(st.data.hasKey === true, 'AI 状态：密钥已读到');
ok(st.data.reachable === true, 'AI 状态：中转站可达（/models）', st.data.error || '');
ok((st.data.models || []).includes('mock-vision'), 'AI 状态：读到模型列表');

const an = await call(`/videos/${vid}/analyze`, { method: 'POST', uid });
ok(an.status === 201, '触发拆解返回 201', String(an.status) + (an.data.error || ''));
const sid = an.data.script?.id;
ok(!!sid, '返回任务 id');
ok(['pending', 'running'].includes(an.data.script?.status), '任务处于进行中');

// 没配密钥时应报错（临时关掉校验成本太高，这里只验证正常路径）

let detail = null;
for (let i = 0; i < 60; i++) {
  await sleep(1000);
  const r = await call('/scripts/' + sid, { uid });
  detail = r.data.script;
  if (detail && (detail.status === 'done' || detail.status === 'failed')) break;
}
ok(detail?.status === 'done', '拆解完成', detail?.error || detail?.status || 'timeout');

ok(detail?.title === MOCK.title, '标题解析正确', detail?.title);
ok(detail?.summary?.length > 0, '一句话摘要非空');
ok(detail?.hook?.length > 0, '钩子非空');
ok(Array.isArray(detail?.segments) && detail.segments.length >= 4, '分镜 ≥ 4 段', String(detail?.segments?.length));
ok(detail?.segments?.[0]?.shot?.length > 4 && detail?.segments?.[0]?.line?.length > 0, '分镜含画面与台词');
ok(Array.isArray(detail?.tagList) && detail.tagList.length === 4, '标签解析成数组', JSON.stringify(detail?.tagList));
ok(detail?.script_text?.includes('\n'), '口播稿保留换行');
ok(detail?.cta?.length > 0, '收口非空');
ok(detail?.model === 'mock-vision', '记录实际模型', detail?.model);

ok(Array.isArray(detail?.frames) && detail.frames.length === 4, '抽出 4 张关键帧（AI_FRAMES=4）', String(detail?.frames?.length));
ok((detail?.frames || []).every(f => typeof f.t === 'number' && f.path), '关键帧带时间码与路径');
const f0 = await fetch(`${BASE}/api/scripts/${sid}/frames/0?uid=${uid}`);
const fbuf = Buffer.from(await f0.arrayBuffer());
ok(f0.status === 200 && (f0.headers.get('content-type') || '').includes('image'), '关键帧可访问', String(f0.status));
ok(fbuf.length > 3000, '关键帧是真实图片', fbuf.length + 'B');
ok(fbuf[0] === 0xff && fbuf[1] === 0xd8, '关键帧是 JPEG（magic 0xFFD8）');

ok(seen.length === 1, '模型只被调用一次', String(seen.length));
ok(seen[0]?.images === 4, '模型收到 4 张图', String(seen[0]?.images));
ok(seen[0]?.hasPrompt === true, '模型收到文字提示词');
ok(seen[0]?.model === 'mock-vision', '请求用了配置的模型');

const list = await call('/scripts?videoId=' + vid, { uid });
ok(list.data.items?.length === 1, '按素材筛脚本命中 1 条', String(list.data.items?.length));
ok(list.data.counts?.done >= 1, '状态计数含 done', JSON.stringify(list.data.counts));

const byStatus = await call('/scripts?status=done', { uid });
ok(byStatus.data.items?.some(s => s.id === sid), 'status=done 过滤命中');
const runningList = await call('/scripts?status=running', { uid });
ok(runningList.status === 200 && !runningList.data.items.some(s => s.id === sid), 'status=running 不混入已完成');

const search = await call('/scripts?q=' + encodeURIComponent('收纳盒'), { uid });
ok(search.data.items?.length >= 1, '关键词搜索命中标题');

const stats1 = await call('/stats', { uid });
ok(stats1.data.scripts === 1 && stats1.data.scriptsDone === 1, '统计里的脚本数正确', `${stats1.data.scripts}/${stats1.data.scriptsDone}`);

// 复用：再点一次拆解不应新建任务
const again = await call(`/videos/${vid}/analyze`, { method: 'POST', uid });
ok(again.data.script?.id === sid, '重复触发复用同一条脚本记录（不重复烧钱）');

// 重新拆解
const rt = await call(`/scripts/${sid}/retry`, { method: 'POST', uid });
ok(rt.status === 200, '重新拆解接口可用', String(rt.status));
let redo = null;
for (let i = 0; i < 40; i++) {
  await sleep(800);
  const r = await call('/scripts/' + sid, { uid });
  redo = r.data.script;
  if (redo?.status === 'done') break;
}
ok(redo?.status === 'done', '重新拆解后回到 done');
ok(seen.length === 2, '重拆会再调一次模型', String(seen.length));

// 删除
const del = await call('/scripts/' + sid, { method: 'DELETE', uid });
ok(del.status === 200, '删除脚本');
const after = await call('/scripts?videoId=' + vid, { uid });
ok(after.data.items?.length === 0, '删除后列表为空');
const stats2 = await call('/stats', { uid });
ok(stats2.data.scripts === 0, '删除后统计归零', String(stats2.data.scripts));

// 无 uid 的受保护接口
const noAuth = await call('/scripts');
ok(noAuth.status === 401, '未登录访问脚本列表被拒', String(noAuth.status));

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail) console.log('\n服务端日志片段：\n' + log.slice(-1500));
console.log(`临时目录：${tmp}`);
stop();
process.exit(fail ? 1 : 0);
