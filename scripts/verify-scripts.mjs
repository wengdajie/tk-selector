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
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
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
  setup: {
    scene: '出租屋卧室的抽屉柜前，背景是铺灰色床单的床和半开的衣柜',
    cast: '一名 25 岁左右女性，灰色家居服，披发，无明显妆容',
    props: '透明分格收纳盒 ×2、袜子内衣充电线若干、木质抽屉',
    light: '左侧窗户自然光，色温偏冷，暗部有轻微噪点',
    gear: '手机竖屏 9:16，俯拍支架加手持跟随，以特写为主',
    pace: '平均 3 秒一个镜头，重音落在抽屉合上的声音，硬切为主',
  },
  segments: [
    {
      t: '0:00-0:03',
      shot: '俯拍特写，镜头缓慢下压',
      action: '右手抓住抽屉把手，用力拽两次没拉开，肩膀跟着使劲，眉头皱起',
      line: '你家抽屉是不是也这样？',
      text: '大字「你家抽屉也这样？」压在上方三分之一处',
      audio: '抽屉卡住的摩擦声 + 低频鼓点进入',
      props: '木质抽屉',
      cut: '硬切',
    },
    {
      t: '0:03-0:07',
      shot: '中景平视，轻微手持晃动',
      action: '把散落的袜子、充电线一把推到桌面上，手掌摊开指向那堆东西',
      line: '东西一多，找什么都找不到。',
      text: '右侧弹出「找东西 5 分钟」',
      audio: '布料摩擦声，鼓点持续',
      props: '袜子、充电线',
      cut: '叠化',
    },
    {
      t: '0:07-0:12',
      shot: '俯拍特写，镜头跟随手部移动',
      action: '左手扶住收纳盒，右手把袜子一格一格塞进去，动作由快到慢',
      line: '按格子分好，一眼就能看到。',
      text: '「一格一类」贴纸逐格出现',
      audio: '拉链与布料声，BGM 上扬',
      props: '透明分格收纳盒',
      cut: '硬切',
    },
    {
      t: '0:12-0:16',
      shot: '特写，仰拍抽屉口，镜头固定',
      action: '双手扶住抽屉边缘，一推到底，抽屉顺滑合上后手停在把手上两秒',
      line: '推回去，一点不卡。',
      text: '「一推到底」打在画面下方',
      audio: '合上的闷响作为重音，背景音收干',
      props: '木质抽屉',
      cut: '硬切',
    },
    {
      t: '0:16-0:20',
      shot: '正面半身口播，固定机位略低于视线',
      action: '人物正对镜头，右手食指向画面下方指两次，最后摊手收尾',
      line: '链接放下面，颜色自己挑。',
      text: '左下角「颜色可选」角标',
      audio: '口播为主，BGM 回落',
      props: '收纳盒',
      cut: '收尾淡出',
    },
  ],
  script_text: '你家抽屉是不是也这样？\n东西一多，找什么都找不到。\n按格子分好，一眼就能看到。\n推回去，一点不卡。\n链接放下面，颜色自己挑。',
  cta: '结尾口播引导，强调“颜色可选”，不做绝对化表述。',
  replicate_prompt: '9:16 竖屏，10 秒电商短视频。出租屋卧室抽屉柜前，左侧窗户自然光，冷色调，一名 25 岁左右女性穿灰色家居服。镜头一：俯拍特写缓慢下压，右手拽抽屉两次没拉开，肩膀使劲、皱眉；镜头二：中景手持轻晃，把袜子与充电线推到桌面并摊手；镜头三：俯拍特写跟手，左手扶透明分格收纳盒，右手逐格放入袜子；镜头四：仰拍特写固定，双手一推到底合上抽屉；镜头五：正面半身口播，右手指向画面下方。全程不许出现品牌 logo、价格与水印。',
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
    const rawContent = body.messages?.at(-1)?.content ?? [];
    const content = Array.isArray(rawContent) ? rawContent : [];   // 深度测试发的是纯字符串 content
    const images = content.filter(c => c.type === 'image_url');
    const prompt = content.find(c => c.type === 'text')?.text || String(rawContent);
    seen.push({ model: body.model, images: images.length, hasPrompt: !!prompt, prompt });
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

let srv = null;
let log = '';
const spawnServer = () => {
  const s = spawn(process.execPath, ['server/index.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  s.stdout.on('data', d => { log += d; });
  s.stderr.on('data', d => { log += d; });
  return s;
};
const stop = () => { try { srv?.kill(); } catch { /* ignore */ } mock.close(); extraClosers.forEach(fn => { try { fn(); } catch { /* ignore */ } }); };
const extraClosers = [];   // 通知 webhook 收集器等，结束时一并关掉

const waitReady = async (cycles = 80) => {
  for (let i = 0; i < cycles; i++) {
    try {
      const r = await fetch(BASE + '/api/version');
      if (r.ok) return true;
    } catch { /* 还没起来 */ }
    await sleep(300);
  }
  return false;
};

srv = spawnServer();
if (!await waitReady()) {
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

// ---- v1.5.1：动作细节 / 拍摄设定 / 复刻提示词 ----
const st2 = detail?.shot_setup || {};
ok(typeof st2 === 'object' && st2.scene?.length > 4, '拍摄设定：场景', st2.scene);
ok(['cast', 'props', 'light', 'gear', 'pace'].every(k => (st2[k] || '').length > 2), '拍摄设定六项齐全', Object.keys(st2).join(','));
ok((detail?.segments || []).every(g => g.shot && g.action), '每段都有画面与动作');
ok((detail?.segments || []).some(g => /右手|左手|双手/.test(g.action || '')), '动作写到具体的手/身体', detail?.segments?.[0]?.action);
ok((detail?.segments || []).every(g => g.cut), '每段都有衔接方式');
ok((detail?.segments || []).some(g => g.text && g.audio && g.props), '字幕 / 声音 / 道具齐全');
ok((detail?.segments || []).every(g => !String(g.action).includes('\n')), '动作字段已压成单行');
ok((detail?.replicate_prompt || '').length > 60, '生成 AI 复刻提示词', String(detail?.replicate_prompt?.length));
ok((detail?.replicate_prompt || '').includes('9:16'), '复刻提示词带画幅');
ok((seen[0]?.prompt || '').includes('"action"'), '提示词明确要求 action 字段');
ok((seen[0]?.prompt || '').includes('"replicate_prompt"'), '提示词明确要求复刻提示词字段');
ok((seen[0]?.prompt || '').includes('"setup"'), '提示词要求给出拍摄设定');

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

// ---- v1.6.0：设置由管理员统一管理（界面改，立即生效，不重启） ----
const setRead = await call('/settings/ai', { uid });
ok(setRead.status === 200 && setRead.data.canEdit === true, '管理员可读设置');
ok(setRead.data.apiKey === undefined, '接口不回传原始 Key');
ok(/••••/.test(setRead.data.apiKeyMasked || ''), 'Key 打码显示', setRead.data.apiKeyMasked);
ok(setRead.data.baseUrl?.includes('127.0.0.1'), '设置里读到当前生效地址');
ok(setRead.data.sources?.ai_model === 'env', '未改过的项标记为环境变量默认', JSON.stringify(setRead.data.sources));

const badPut = await call('/settings/ai', {
  method: 'PUT', uid, body: { ai_base_url: 'not-a-url' },
});
ok(badPut.status === 400, '非法地址被拒', JSON.stringify(badPut.data));

const dup = await call('/users', { method: 'POST', body: { name: '设置验证-运营', password: 'op12345678', role: 'ops' } });
const opUid = dup.data.user?.id;
ok(!!opUid, '创建一个普通运营账号');
const opPut = await call('/settings/ai', { method: 'PUT', uid: opUid, body: { ai_model: 'hack' } });
ok(opPut.status === 403, '普通成员改设置被拒', String(opPut.status));
const opRead = await call('/settings/ai', { uid: opUid });
ok(opRead.status === 200 && opRead.data.canEdit === false, '普通成员只读');

// 管理员改成另一个模型 → 不重启，下一次拆解立即用新模型
const setPut = await call('/settings/ai', {
  method: 'PUT', uid, body: { ai_model: 'mock-vision-2', ai_frames: '5' },
});
ok(setPut.status === 200 && setPut.data.model === 'mock-vision-2', '保存新模型立即生效');
ok(setPut.data.sources?.ai_model === 'db', '改过的项标记为管理员设置值', JSON.stringify(setPut.data.sources));

const reAnalyze = await call(`/videos/${vid}/analyze`, { method: 'POST', uid });
const sid2 = reAnalyze.data.script?.id;
let detail2 = null;
for (let i = 0; i < 60; i++) {
  await sleep(1000);
  const r = await call('/scripts/' + sid2, { uid });
  detail2 = r.data.script;
  if (detail2 && (detail2.status === 'done' || detail2.status === 'failed')) break;
}
ok(detail2?.status === 'done' && detail2?.model === 'mock-vision-2', '改设置后拆解直接用新模型（无需重启）', `${detail2?.status}/${detail2?.model}`);
ok(seen.at(-1)?.model === 'mock-vision-2', '请求体里的模型也是新值');
ok((detail2?.frames || []).length === 5, '抽帧数设置生效（AI_FRAMES=5）', String(detail2?.frames?.length));
ok(seen.at(-1)?.images === 5, '新一次调用带 5 张图');

// 清掉 Key → 拆解应明确报错
const clearKey = await call('/settings/ai', { method: 'PUT', uid, body: { ai_api_key: null } });
ok(clearKey.status === 200 && clearKey.data.apiKeyMasked === '', '清除 Key 后显示未配置');
const noKey = await call(`/videos/${vid}/analyze`, { method: 'POST', uid });
ok(noKey.status === 400 && /未配置/.test(noKey.data.error || ''), '无 Key 时拆解给出明确提示', JSON.stringify(noKey.data));
// 还原（给下一段用）
await call('/settings/ai', { method: 'PUT', uid, body: { ai_api_key: 'sk-mock-key', ai_model: 'mock-vision', ai_frames: '4' } });

// 无 uid 的受保护接口
const noAuth = await call('/scripts');
ok(noAuth.status === 401, '未登录访问脚本列表被拒', String(noAuth.status));

// ---- v1.6.1：自审修复 ----
console.log('\n== v1.6.1 自审修复 ==');

// 1) LIKE 通配符转义：用户搜 % 或 _ 不应变成「匹配全部」
const pct = await call('/scripts?q=' + encodeURIComponent('%'), { uid });
ok(pct.data.items?.length === 0, '搜索 % 不再命中全部（LIKE 已转义）', String(pct.data.items?.length));
const und = await call('/scripts?q=' + encodeURIComponent('_'), { uid });
ok(und.data.items?.length === 0, '搜索 _ 不再命中全部');

// 2) 关键帧接口要登录，且路径不许越界
const frameNoAuth = await fetch(`${BASE}/api/scripts/${sid2}/frames/0`);
ok(frameNoAuth.status === 401, '未登录访问关键帧被拒', String(frameNoAuth.status));
const wdb = new Database(path.join(env.DATA_DIR, 'app.db'));
const origFrames = wdb.prepare('SELECT frames FROM scripts WHERE id = ?').get(sid2).frames;
wdb.prepare('UPDATE scripts SET frames = ? WHERE id = ?')
  .run(JSON.stringify([{ t: 1, path: 'frames/../../server/db.js' }]), sid2);
const trav = await fetch(`${BASE}/api/scripts/${sid2}/frames/0?uid=${uid}`);
ok(trav.status === 404, '关键帧路径含 .. 时拒绝返回文件', String(trav.status));
wdb.prepare('UPDATE scripts SET frames = ? WHERE id = ?').run(origFrames, sid2);

// 3) 帧目录按脚本隔离（s- 前缀，多条脚本/重拆不互相覆盖）
ok((detail2?.frames || []).every(f => /^frames\/s-[^/]+\/\d+\.jpg$/.test(f.path)),
  '关键帧存进脚本专属目录（s- 前缀）', JSON.stringify((detail2?.frames || []).map(f => f.path)));
const frameRoot = path.join(env.DATA_DIR, 'media', 'frames');
ok(fs.existsSync(path.join(frameRoot, 's-' + sid2)), '专属帧目录真实存在');

// 4) 防抖：进行中的任务重复触发/重试都复用同一条，不再并发烧钱
wdb.prepare("UPDATE scripts SET status='running', error='' WHERE id = ?").run(sid2);
wdb.close();
const seenBefore = seen.length;
const rRetry = await call(`/scripts/${sid2}/retry`, { method: 'POST', uid });
ok(rRetry.status === 200 && rRetry.data.job?.status === 'running',
  '进行中重试直接复用（不并发重跑）', `${rRetry.status}/${rRetry.data.job?.status}`);
const rAgain = await call(`/videos/${vid}/analyze`, { method: 'POST', uid });
ok(rAgain.data.script?.id === sid2, '进行中重复触发也复用同一条任务');
await sleep(500);
ok(seen.length === seenBefore, '防抖期间模型调用数不增加', `${seenBefore} → ${seen.length}`);

// 5) 服务重启恢复：卡住的任务标 failed（可重试），而不是永远「拆解中」
srv.kill();
await Promise.race([new Promise(r => srv.once('exit', r)), sleep(5000)]);
await sleep(800);   // 等端口释放
srv = spawnServer();
if (!await waitReady()) {
  console.log('服务重启失败：\n' + log.slice(-2000));
  stop();
  process.exit(1);
}
const stale = await call('/scripts/' + sid2, { uid });
ok(stale.data.script?.status === 'failed' && /服务重启/.test(stale.data.script?.error || ''),
  '重启后中断任务标为失败并提示重试', `${stale.data.script?.status}: ${stale.data.script?.error}`);
const rr = await call(`/scripts/${sid2}/retry`, { method: 'POST', uid });
ok(rr.status === 200, '重启后可以重新拆解', String(rr.status));
let redo2 = null;
for (let i = 0; i < 60; i++) {
  await sleep(1000);
  const x = await call('/scripts/' + sid2, { uid });
  redo2 = x.data.script;
  if (redo2 && (redo2.status === 'done' || redo2.status === 'failed')) break;
}
ok(redo2?.status === 'done', '重试后拆解完成', redo2?.error || redo2?.status || 'timeout');
ok(seen.length === seenBefore + 1, '重试恰好多调一次模型', String(seen.length));

// 6) 删脚本清掉自己的关键帧目录（磁盘不泄漏）
ok(fs.existsSync(path.join(frameRoot, 's-' + sid2)), '删除前帧目录存在');
const delS = await call('/scripts/' + sid2, { method: 'DELETE', uid });
ok(delS.status === 200, '删除脚本');
ok(!fs.existsSync(path.join(frameRoot, 's-' + sid2)), '删脚本同时清掉专属帧目录');

// 7) 删素材级联：脚本 + 帧目录一起清，不留孤儿
const an3 = await call(`/videos/${vid}/analyze`, { method: 'POST', uid });
const sid3 = an3.data.script?.id;
ok(!!sid3 && sid3 !== sid2, '删脚本后再拆解会新建任务');
let detail3 = null;
for (let i = 0; i < 60; i++) {
  await sleep(1000);
  const x = await call('/scripts/' + sid3, { uid });
  detail3 = x.data.script;
  if (detail3 && (detail3.status === 'done' || detail3.status === 'failed')) break;
}
ok(detail3?.status === 'done', '新任务拆解完成', detail3?.error || '');
ok(fs.existsSync(path.join(frameRoot, 's-' + sid3)), '新任务帧目录存在');
const delV = await call('/videos/' + vid, { method: 'DELETE', uid });
ok(delV.status === 200, '删除素材');
const left = await call('/scripts?videoId=' + vid, { uid });
ok(left.data.items?.length === 0, '素材删除后脚本级联清空');
ok(!fs.existsSync(path.join(frameRoot, 's-' + sid3)), '级联清理关键帧目录');

// ---- v1.7.0：群通知（企业微信 / 飞书 / 钉钉 webhook） ----
console.log('\n== v1.7.0 群通知 ==');
const hooks = [];
const hookSrv = http.createServer((req, res) => {
  let buf = '';
  req.on('data', c => { buf += c; });
  req.on('end', () => {
    let body = {};
    try { body = JSON.parse(buf || '{}'); } catch { /* ignore */ }
    hooks.push({ url: req.url, body });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"errcode":0}');
  });
});
await new Promise(r => hookSrv.listen(0, '127.0.0.1', r));
extraClosers.push(() => hookSrv.close());
const hookPort = hookSrv.address().port;
const hookUrl = `http://127.0.0.1:${hookPort}/hook`;

// 读取 / 权限 / 校验
const nRead0 = await call('/settings/notify', { uid });
ok(nRead0.status === 200 && nRead0.data.canEdit === true, '管理员可读通知设置');
ok(nRead0.data.url === '' && nRead0.data.secretMasked === '', '出厂默认：未配 webhook');
const nTest0 = await call('/settings/notify/test', { uid });
ok(nTest0.data.ok === false && /未配置/.test(nTest0.data.error || ''), '未配地址时测试给出明确提示', JSON.stringify(nTest0.data));
const nOp = await call('/settings/notify', { method: 'PUT', uid: opUid, body: { notify_type: 'wecom' } });
ok(nOp.status === 403, '普通成员改通知设置被拒', String(nOp.status));
const nBad = await call('/settings/notify', { method: 'PUT', uid, body: { notify_type: 'slack' } });
ok(nBad.status === 400, '不支持的机器人类型被拒', JSON.stringify(nBad.data));
const nBadUrl = await call('/settings/notify', { method: 'PUT', uid, body: { notify_url: 'ftp://x' } });
ok(nBadUrl.status === 400, '非 http 地址被拒');

// 配置企业微信机器人
const nSet = await call('/settings/notify', {
  method: 'PUT', uid,
  body: { notify_type: 'wecom', notify_url: hookUrl, notify_enabled: true, notify_on_upload: true, notify_on_comment: true },
});
ok(nSet.status === 200 && nSet.data.type === 'wecom' && nSet.data.url === hookUrl, '保存 webhook 配置');
ok(nSet.data.sources?.notify_url === 'db', '通知项标记为管理员设置值');

const nTest1 = await call('/settings/notify/test', { uid });
ok(nTest1.data.ok === true, '测试消息发送成功', JSON.stringify(nTest1.data));
await sleep(400);
ok(hooks.length === 1 && hooks[0].body.msgtype === 'markdown', '测试消息是企业微信 markdown 格式', JSON.stringify(hooks[0]?.body));
ok(String(hooks[0]?.body?.markdown?.content || '').includes('通知测试'), '测试消息内容正确');

// 上传素材 → 入库推送（换个内容避免和之前素材命中去重）
const sample2 = path.join(tmp, 'sample-notify.mp4');
execFileSync('ffmpeg', [
  '-hide_banner', '-loglevel', 'error', '-y',
  '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25',
  '-f', 'lavfi', '-i', 'sine=frequency=660',
  '-t', '11', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast',
  '-c:a', 'aac', '-shortest', sample2,
]);
const nfd = new FormData();
nfd.append('files', new Blob([fs.readFileSync(sample2)], { type: 'video/mp4' }), 'notify.mp4');
nfd.append('space', 'library');
nfd.append('title', '通知验证素材');
const nUp = await fetch(BASE + '/api/videos/upload', { method: 'POST', headers: { 'x-user-id': uid }, body: nfd });
const nUpData = await nUp.json().catch(() => ({}));
const nid = nUpData.items?.[0]?.id;
ok(nUp.status === 201 && !!nid, '上传一条新素材', String(nUp.status));
await sleep(600);
ok(hooks.length === 2, '入库后推送了一条通知', String(hooks.length));
ok(String(hooks[1]?.body?.markdown?.content || '').includes('素材入库'), '入库通知内容正确');
ok(String(hooks[1]?.body?.markdown?.content || '').includes('通知验证素材'), '入库通知带素材标题');
ok(String(hooks[1]?.body?.markdown?.content || '').includes('管理员'), '入库通知带上传人');

// 同文件重传（去重）→ 不推送
const dfd2 = new FormData();
dfd2.append('files', new Blob([fs.readFileSync(sample2)], { type: 'video/mp4' }), 'notify.mp4');
dfd2.append('space', 'library');
const nUp2 = await fetch(BASE + '/api/videos/upload', { method: 'POST', headers: { 'x-user-id': uid }, body: dfd2 });
await nUp2.json().catch(() => ({}));
await sleep(600);
ok(hooks.length === 2, '去重的重复上传不推送', String(hooks.length));

// 给「设置验证-运营」配通知账号，评论 @TA → 真实艾特
const nKeyPut = await call('/users/' + opUid, { method: 'PATCH', uid, body: { notify_key: 'wecom-lin' } });
ok(nKeyPut.status === 200 && nKeyPut.data.user?.notify_key === 'wecom-lin', '管理员可配成员通知账号', JSON.stringify(nKeyPut.data.user?.notify_key));
const cmt1 = await call(`/videos/${nid}/comments`, {
  method: 'POST', uid,
  body: { body: '开场不错，@设置验证-运营 你看下节奏' },
});
ok(cmt1.status === 201, '发一条带 @ 的评论');
await sleep(600);
ok(hooks.length === 3, '评论后推送通知', String(hooks.length));
const cmt1Text = String(hooks[2]?.body?.markdown?.content || '');
ok(cmt1Text.includes('新评论') && cmt1Text.includes('开场不错'), '评论通知带正文');
ok(cmt1Text.includes('<@wecom-lin>'), '评论里的 @ 转成了企业微信艾特语法', cmt1Text.slice(-80));

// 无 @ 的评论 → 没有艾特后缀
await call(`/videos/${nid}/comments`, { method: 'POST', uid, body: { body: '好的收到' } });
await sleep(600);
ok(hooks.length === 4, '普通评论也推送');
ok(!String(hooks[3]?.body?.markdown?.content || '').includes('<@'), '无提及时不带艾特语法');

// 切飞书（带加签）
await call('/settings/notify', { method: 'PUT', uid, body: { notify_type: 'feishu', notify_secret: 'fei-secret' } });
await call(`/videos/${nid}/comments`, { method: 'POST', uid, body: { body: '@设置验证-运营 再看一眼结尾' } });
await sleep(600);
ok(hooks.length === 5, '飞书格式推送成功');
const fei = hooks[4]?.body || {};
ok(fei.msg_type === 'text' && typeof fei.content?.text === 'string', '飞书是 text 消息', JSON.stringify(fei).slice(0, 120));
ok(!!fei.timestamp && !!fei.sign, '飞书带加签字段（timestamp/sign）');
ok(String(fei.content?.text || '').includes('<at user_id="wecom-lin"></at>'), '飞书艾特语法正确');

// 切钉钉（带加签 + 手机号艾特）
await call('/settings/notify', { method: 'PUT', uid, body: { notify_type: 'dingtalk' } });
await call('/users/' + opUid, { method: 'PATCH', uid, body: { notify_key: '13800138000' } });
await call(`/videos/${nid}/comments`, { method: 'POST', uid, body: { body: '@设置验证-运营 看完了吗' } });
await sleep(600);
ok(hooks.length === 6, '钉钉格式推送成功');
const ding = hooks[5]?.body || {};
ok(ding.msgtype === 'markdown' && Array.isArray(ding.at?.atMobiles), '钉钉是 markdown + atMobiles', JSON.stringify(ding).slice(0, 120));
ok((ding.at?.atMobiles || []).includes('13800138000'), '钉钉按手机号艾特');
ok(String(ding.markdown?.text || '').includes('@13800138000'), '钉钉正文含手机号艾特');
ok(String(hooks[5]?.url || '').includes('timestamp=') && String(hooks[5]?.url || '').includes('sign='), '钉钉加签拼在 URL 上', hooks[5]?.url);

// 关掉评论事件 → 不再推送
await call('/settings/notify', { method: 'PUT', uid, body: { notify_on_comment: false } });
await call(`/videos/${nid}/comments`, { method: 'POST', uid, body: { body: '这条不该推送' } });
await sleep(900);
ok(hooks.length === 6, '关闭评论事件后不再推送', String(hooks.length));
// 关总开关 → 上传也不推
await call('/settings/notify', { method: 'PUT', uid, body: { notify_enabled: false } });
const nfd3 = new FormData();
nfd3.append('files', new Blob([fs.readFileSync(sample)], { type: 'video/mp4' }), 'notify2.mp4');
nfd3.append('space', 'library');
nfd3.append('title', '关开关后上传');
await fetch(BASE + '/api/videos/upload', { method: 'POST', headers: { 'x-user-id': uid }, body: nfd3 });
await sleep(900);
ok(hooks.length === 6, '关闭总开关后上传不推送', String(hooks.length));

// ---- v1.7.1：AI 接口方案 / 深度连接测试 ----
console.log('\n== v1.7.1 AI 方案与连接测试 ==');
const deepOk = await call('/settings/ai/test?deep=1', { uid });
ok(deepOk.data.reachable === true && deepOk.data.modelOk === true,
  '深度测试：连通 + Key + 模型一起验证通过', JSON.stringify(deepOk.data).slice(0, 200));
ok(String(deepOk.data.modelEcho || '').includes('mock'), '深度测试返回模型回显', String(deepOk.data.modelEcho));

// 「不开放 /models」的厂商（火山方舟等 404）：浅探仍算连通，模型靠真实调用验证
const mock2 = http.createServer((req, res) => {
  let buf = '';
  req.on('data', c => { buf += c; });
  req.on('end', () => {
    if (req.url.includes('/models')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      return res.end('{}');
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ model: 'mock2-vision', choices: [{ message: { role: 'assistant', content: 'ok' } }] }));
  });
});
await new Promise(r => mock2.listen(0, '127.0.0.1', r));
extraClosers.push(() => mock2.close());
const m2port = mock2.address().port;

const swapBase = await call('/settings/ai', { method: 'PUT', uid, body: { ai_base_url: `http://127.0.0.1:${m2port}/v1` } });
ok(swapBase.status === 200, '切到自定义接口地址');
const shallow2 = await call('/settings/ai/test', { uid });
ok(shallow2.data.reachable === true && (shallow2.data.models || []).length === 0,
  '「不提供 /models」的接口浅探也算连通', JSON.stringify(shallow2.data).slice(0, 160));
const deep2 = await call('/settings/ai/test?deep=1', { uid });
ok(deep2.data.modelOk === true && deep2.data.modelEcho === 'mock2-vision',
  '无 /models 时深度测试仍能验出模型', JSON.stringify(deep2.data).slice(0, 200));
// 切回原中转站
await call('/settings/ai', { method: 'PUT', uid, body: { ai_base_url: `http://127.0.0.1:${aiPort}/v1` } });
const back = await call('/settings/ai/test', { uid });
ok(back.data.reachable === true && (back.data.models || []).includes('mock-vision'), '切回后恢复原方案');

/* ---------------- 静态资源一致性（防 UI 路径回归） ---------------- */
console.log('\n== 静态资源一致性 ==');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const appjs = fs.readFileSync(path.join(root, 'public', 'js', 'app.js'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const mHtml = html.match(/app\.js\?v=([\w.]+)/);
ok(!!mHtml, 'index.html 引用了带版本号的 app.js', '缺 ?v=');
ok(mHtml && mHtml[1] === pkg.version, '前端版本号与 package.json 一致',
  `html=${mHtml?.[1]} pkg=${pkg.version}`);
for (const navEl of ['nav', 'navMain', 'navAdmin', 'mobileNav']) {
  ok(appjs.includes(`getElementById('${navEl}')`), `侧边栏 ${navEl} 已绑定点击事件`);
}
ok(html.includes('data-view="settings"'), 'index.html 有系统设置入口');
ok(appjs.includes("view === 'settings'"), 'app.js 支持设置视图切换');

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail) console.log('\n服务端日志片段：\n' + log.slice(-1500));
console.log(`临时目录：${tmp}`);
stop();
process.exit(fail ? 1 : 0);
