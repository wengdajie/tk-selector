/**
 * AI 脚本拆解 端到端验证
 * 起一个假的 OpenAI 兼容中转站 + 真服务 + 真 ffmpeg 抽帧，全链路跑一遍。
 *   node scripts/verify-scripts.mjs
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
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
  if (req.url === '/__probe') { res.writeHead(200); return res.end('ok'); }   // 端口探测，不计入状态
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
/** 绑一个可用的本地端口：本机偶有安全软件拦特定端口（实测 10080 会 fetch failed），自检不通就换 */
async function listenSafe(server) {
  for (let i = 0; i < 8; i++) {
    await new Promise(r => {
      server.once('error', r);
      server.listen(0, '127.0.0.1', r);
    });
    server.removeAllListeners('error');
    const port = server.address()?.port;
    if (!port) continue;
    try {
      await fetch(`http://127.0.0.1:${port}/__probe`, { signal: AbortSignal.timeout(1500) });
      return port;
    } catch {
      await new Promise(r => server.close(r));
      await sleep(30);
    }
  }
  fail('找不到可用的本地端口（被安全软件拦截？）');
  return null;
}

await listenSafe(mock);
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
  AI_TIMEOUT_MS: '300000',
  PROXY_TIMEOUT_MS: '6000',   // v1.9.0 默认放宽到 5 分钟（慢模型拆解不再 120s 超时）
};
fs.mkdirSync(path.join(tmp, 'data'), { recursive: true });
fs.mkdirSync(path.join(tmp, 'watch'), { recursive: true });

let srv = null;
let log = '';
process.on('exit', () => {
  if (process.env.DUMP_SRV_LOG) console.log('\n--- SERVER LOG TAIL ---\n' + log.slice(-6000));
});
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
const meForToken = await call('/me', { uid });
const mediaToken = meForToken.data?.mediaToken || '';

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
const f0 = await fetch(`${BASE}/api/scripts/${sid}/frames/0?t=${mediaToken}`);
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
const trav = await fetch(`${BASE}/api/scripts/${sid2}/frames/0?t=${mediaToken}`);
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
  if (req.url === '/__probe') { res.writeHead(200); return res.end('ok'); }   // 端口探测，不计入状态
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
await listenSafe(hookSrv);
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
const dingUrl = String(hooks[5]?.url || '');
ok(dingUrl.includes('timestamp=') && dingUrl.includes('sign='), '钉钉加签拼在 URL 上', dingUrl);
// 按钉钉官方公式逐字节比对：key=密钥，消息体 = `时间戳\n密钥`
{
  const dingSecret = 'fei-secret';   // 上面 PUT 只切了类型，密钥沿用
  const ts = new URLSearchParams(dingUrl.split('?')[1]).get('timestamp');
  const got = new URLSearchParams(dingUrl.split('?')[1]).get('sign');
  const want = crypto.createHmac('sha256', dingSecret)
    .update(`${ts}\n${dingSecret}`).digest('base64');
  ok(got === want, '钉钉加签符合官方算法（ts\\nsecret 为消息体）', `got=${got} want=${want}`);
  // 同时证明旧错误算法（只签时间戳）算不出这个值，防止回归到错误实现
  const wrong = encodeURIComponent(crypto.createHmac('sha256', dingSecret)
    .update(String(ts)).digest('base64'));
  ok(got !== wrong, '钉钉加签不是「只签时间戳」的错误实现');
}
// 飞书官方公式：key = `时间戳\n密钥`，消息体为空
ok(fei.sign === crypto.createHmac('sha256', `${fei.timestamp}\nfei-secret`).update('').digest('base64'),
  '飞书加签符合官方算法（ts\\nsecret 为 key）');

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
  if (req.url === '/__probe') { res.writeHead(200); return res.end('ok'); }   // 端口探测
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
await listenSafe(mock2);
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

/* ---------------- v1.9.0：AI 超时可配 / 素材库不体检 / 钉钉缩略图卡片 ---------------- */
console.log('\n== v1.9.0 AI 超时 ==');
const tDef = await call('/settings/ai', { uid });
ok(tDef.data.timeoutMs === 300000, '默认拆解超时 5 分钟', String(tDef.data.timeoutMs));
const tSet = await call('/settings/ai', { method: 'PUT', uid, body: { ai_timeout_ms: '600000' } });
ok(tSet.status === 200 && tSet.data.timeoutMs === 600000, '超时可改到 10 分钟', String(tSet.data.timeoutMs));
const tBad = await call('/settings/ai', { method: 'PUT', uid, body: { ai_timeout_ms: '5000' } });
ok(tBad.status === 400, '超时低于 30 秒被拒', String(tBad.status));
const tSrc = await call('/settings/ai', { uid });
ok(tSrc.data.sources?.ai_timeout_ms === 'db', '超时来源标记为 db');

console.log('\n== v1.9.0 素材库不体检 ==');
const mkSample = (name, size, dur) => {
  const f = path.join(tmp, name);
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi',
    '-i', `testsrc2=size=${size}:rate=24`, '-t', String(dur), '-pix_fmt', 'yuv420p', f]);
  return f;
};
const libSample = mkSample('qc-lib.mp4', '320x240', 1.2);
const thumbSample = mkSample('qc-thumb.mp4', '360x640', 1.5);
const plainSample = mkSample('qc-plain.mp4', '400x400', 1.8);
const qcLib = await (async () => {
  const fd = new FormData();
  fd.append('files', new Blob([fs.readFileSync(libSample)], { type: 'video/mp4' }), 'libqc.mp4');
  fd.append('space', 'library');
  fd.append('title', '素材库体检验证');
  const r = await fetch(BASE + '/api/videos/upload', { method: 'POST', headers: { 'x-user-id': uid }, body: fd });
  return r.json();
})();
const libVid = qcLib.items?.[0]?.id;
ok(!!libVid, '上传一条素材库素材');
await sleep(500);
const libDetail = await call('/videos/' + libVid, { uid });
ok(libDetail.data?.video?.qc_status === 'skipped', '素材库素材下载即标记 skipped（不进体检队列）', libDetail.data?.video?.qc_status);
const libRecheck = await call('/videos/' + libVid + '/qc', { method: 'POST', uid });
ok(libRecheck.status === 200 || libRecheck.status === 400, '素材库「重新体检」不会真正排队', String(libRecheck.status));
await sleep(600);
const libAfter = await call('/videos/' + libVid, { uid });
ok(libAfter.data?.video?.qc_status === 'skipped', '手动体检后仍是 skipped', libAfter.data?.video?.qc_status);

console.log('\n== v1.9.0 钉钉缩略图卡片（feedCard） ==');
// 开一个收集器，模拟钉钉
const feedHooks = [];
const feedSrv = http.createServer((req, res) => {
  if (req.url === '/__probe') { res.writeHead(200); return res.end('ok'); }
  let buf = '';
  req.on('data', c => { buf += c; });
  req.on('end', () => {
    let body = {};
    try { body = JSON.parse(buf || '{}'); } catch { /* ignore */ }
    feedHooks.push({ url: req.url, body });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"errcode":0}');
  });
});
await listenSafe(feedSrv);
extraClosers.push(() => feedSrv.close());
const feedUrl = `http://127.0.0.1:${feedSrv.address().port}/hook`;
// 钉钉 + 公网地址（用本机地址模拟公网可达）
await call('/settings/notify', { method: 'PUT', uid, body: {
  notify_type: 'dingtalk', notify_url: feedUrl, notify_public_base: BASE,
  notify_enabled: true, notify_on_upload: true, notify_on_comment: false,
} });
const ffd = new FormData();
ffd.append('files', new Blob([fs.readFileSync(sample), { type: 'video/mp4' }]), 'thumb1.mp4');
ffd.append('space', 'daily');
ffd.append('title', '缩略图卡片验证');
await fetch(BASE + '/api/videos/upload', { method: 'POST', headers: { 'x-user-id': uid }, body: ffd });
await sleep(700);
const fp = feedHooks.at(-1)?.body || {};
ok(fp.msgtype === 'feedCard', '钉钉入库通知用 feedCard 缩略图卡片', fp.msgtype);
const link0 = fp.feedCard?.links?.[0] || {};
ok(!!link0.picURL && link0.picURL.startsWith(BASE + '/api/videos/'), '卡片带封面图 picURL（公网地址）', link0.picURL);
ok(String(link0.messageURL || '').startsWith('dingtalk://dingtalkclient/page/link?url='),
  '卡片链接走 dingtalk:// 协议（强制系统浏览器打开，不走钉钉内置浏览器）', link0.messageURL);
{
  const u = new URL(String(link0.messageURL || '').replace('dingtalk://dingtalkclient/page/link', 'https://x/'));
  const inner = decodeURIComponent(u.searchParams.get('url') || '');
  ok(inner.startsWith(BASE + '/?open='), '链接落点是单素材深链（?open=id）', inner);
  ok(u.searchParams.get('pc_slide') === 'false', 'pc_slide=false（PC 弹系统浏览器）', u.searchParams.get('pc_slide'));
}
ok(String(link0.title || '').includes('缩略图卡片验证'), '卡片标题是素材标题', link0.title);
// 清空公网地址 → 回落到文字列表
await call('/settings/notify', { method: 'PUT', uid, body: { notify_public_base: '' } });
const ffd2 = new FormData();
ffd2.append('files', new Blob([fs.readFileSync(sample2), { type: 'video/mp4' }]), 'nothumb.mp4');
ffd2.append('space', 'daily');
ffd2.append('title', '无公网回落验证');
await fetch(BASE + '/api/videos/upload', { method: 'POST', headers: { 'x-user-id': uid }, body: ffd2 });
await sleep(700);
const fp2 = feedHooks.at(-1)?.body || {};
ok(fp2.msgtype === 'markdown', '没配公网地址时回落到 markdown 文字列表', fp2.msgtype);
ok(String(fp2.markdown?.text || '').includes('公网访问地址'), '回落消息里提示配置公网地址', String(fp2.markdown?.text || '').slice(0, 120));

// 公网地址不可达：改发纯文字，不再给群里发裂图
await call('/settings/notify', { method: 'PUT', uid, body: { notify_public_base: 'https://tk.example.com' } });
const deadSample = mkSample('dead-public.mp4', '260x460', 1.2);
const deadFd = new FormData();
deadFd.append('files', new Blob([fs.readFileSync(deadSample)], { type: 'video/mp4' }), 'dead-public.mp4');
deadFd.append('space', 'daily');
deadFd.append('title', '公网失联验证');
await fetch(BASE + '/api/videos/upload', { method: 'POST', headers: { 'x-user-id': uid }, body: deadFd });
await sleep(1200);
const deadCard = feedHooks.at(-1)?.body || {};
ok(deadCard.msgtype === 'markdown', '公网地址不可达时不发 feedCard（避免裂图）', deadCard.msgtype);
ok(String(deadCard.markdown?.text || '').includes('公网地址当前不可达'),
  '回落文字明确提示公网地址失联', String(deadCard.markdown?.text || '').slice(-120));

// 设置页健康探测
const hBad = await call('/settings/notify/health', { uid });
ok(hBad.status === 200 && hBad.data.ok === false && hBad.data.publicBase === 'https://tk.example.com',
  '健康探测能识别失效的公网地址', JSON.stringify(hBad.data));
await call('/settings/notify', { method: 'PUT', uid, body: { notify_public_base: BASE } });
const hGood = await call('/settings/notify/health', { uid });
ok(hGood.status === 200 && hGood.data.ok === true, '健康探测能识别可达的公网地址');
const notifySrc = fs.readFileSync(path.join(root, 'server', 'lib', 'notify.js'), 'utf8');
ok(notifySrc.includes('AbortSignal.timeout(8000)'), '公网探测超时放宽到 8s，避免冷启动 TLS 误判', '');

console.log('\n== v1.9.1 钉钉链接：跳转地址 + 外部浏览器 ==');
await call('/settings/notify', { method: 'PUT', uid, body: {
  notify_type: 'dingtalk', notify_url: feedUrl, notify_public_base: BASE,
  notify_link_base: 'http://192.168.1.4:8899', notify_enabled: true, notify_on_upload: true, notify_on_comment: true,
} });
const lbSample = mkSample('qc-link.mp4', '280x480', 1.1);
const lbFd = new FormData();
lbFd.append('files', new Blob([fs.readFileSync(lbSample)], { type: 'video/mp4' }), 'link.mp4');
lbFd.append('space', 'daily');
lbFd.append('title', '跳转地址验证');
const lbRes = await (await fetch(BASE + '/api/videos/upload', { method: 'POST', headers: { 'x-user-id': uid }, body: lbFd })).json();
const pvForLink = lbRes.items?.[0]?.id;
await sleep(700);
const lbCard = feedHooks.at(-1)?.body || {};
const lbUrl = new URL(String(lbCard.feedCard?.links?.[0]?.messageURL || '').replace('dingtalk://dingtalkclient/page/link', 'https://x/'));
const lbInner = decodeURIComponent(lbUrl.searchParams.get('url') || '');
ok(lbInner.startsWith('http://192.168.1.4:8899/?open='), '跳转地址可独立配内网 IP（缩略图仍用公网）', lbInner);
ok(String(lbCard.feedCard?.links?.[0]?.picURL || '').startsWith(BASE + '/'), '缩略图仍走公网地址（与跳转地址分离）', lbCard.feedCard?.links?.[0]?.picURL);

// 评论通知也带可点击链接
await call('/settings/notify', { method: 'PUT', uid, body: { notify_on_comment: true } });
ok(!!pvForLink, '取到跳转验证素材 id');
await call('/videos/' + pvForLink + '/comments', { method: 'POST', uid, body: { body: '链接验证评论' } });
await sleep(700);
const cmMsg = String(feedHooks.at(-1)?.body?.markdown?.text || '');
ok(cmMsg.includes('dingtalk://dingtalkclient/page/link'), '评论通知带可点击链接（dingtalk://）', cmMsg.slice(-120));

/* ---------------- v1.10.0 播放代理（HEVC 原片 → H.264 播放版） ---------------- */
console.log('\n== v1.10.0 播放代理 ==');
// 前面「删除素材」用例把 vid 删了，这里另取一条现存素材
const wdb2 = new Database(path.join(env.DATA_DIR, 'app.db'));
const pvRow = wdb2.prepare("SELECT id FROM videos WHERE space='daily' ORDER BY created_at DESC LIMIT 1").get();
const pv = pvRow?.id;
ok(!!pv, '找到一条现存素材用于播放测试');

// 1) 普通 H.264 轻片子：直接播原片，不浪费 CPU 转码
const light = await fetch(`${BASE}/api/videos/${pv}/play?uid=${uid}`, { headers: { 'x-user-id': uid } });
ok(light.status === 200, '播放接口可用', String(light.status));
ok(light.headers.get('x-play-source') === 'original', 'H.264 轻片子直接播原片（不转码）', light.headers.get('x-play-source'));
try { await light.body?.cancel?.(); } catch { /* ignore */ }

// 2) Range 分片：移动端拖进度条、iOS 起播都依赖 206
const ranged = await fetch(`${BASE}/api/videos/${pv}/play?uid=${uid}`, {
  headers: { 'x-user-id': uid, Range: 'bytes=0-1023' },
});
ok(ranged.status === 206, '支持 Range 分片（206）', String(ranged.status));
ok(/bytes 0-1023\//.test(ranged.headers.get('content-range') || ''), '返回 Content-Range', ranged.headers.get('content-range'));
try { await ranged.body?.cancel?.(); } catch { /* ignore */ }

// 3) 模拟手机 HEVC 原片 → 触发转码 → 播放源切到 proxy
wdb2.prepare("UPDATE videos SET codec='hevc', width=1080, height=1920, proxy_state=NULL WHERE id=?").run(pv);
const queued = await call('/videos/' + pv + '/proxy', { method: 'POST', uid });
ok(queued.status === 200, '可手动排队转码', String(queued.status));

let proxyState = '';
for (let i = 0; i < 60; i++) {
  await sleep(1000);
  const d = await call('/videos/' + pv, { uid });
  proxyState = d.data?.video?.proxy_state || '';
  if (proxyState === 'done' || proxyState === 'failed') break;
}
ok(proxyState === 'done', '播放版转码完成', proxyState);

const proxied = await fetch(`${BASE}/api/videos/${pv}/play?uid=${uid}`, { headers: { 'x-user-id': uid } });
ok(proxied.headers.get('x-play-source') === 'proxy', 'HEVC 原片自动改播 H.264 播放版', proxied.headers.get('x-play-source'));
ok(/video\/mp4/.test(proxied.headers.get('content-type') || ''), '播放版是 video/mp4', proxied.headers.get('content-type'));
const buf = Buffer.from(await proxied.arrayBuffer());
ok(buf.subarray(0, 2048).includes(Buffer.from('moov')) || buf.subarray(0, 1024 * 1024).includes(Buffer.from('moov')),
  '播放版是 faststart（moov 在前 1MB 内）');
ok(buf.length > 1000, '播放版文件非空', String(buf.length));
wdb2.close();


const uuidv4Like = () => crypto.randomUUID();
const ymdLocal = () => new Date().toISOString().slice(0, 10);
/* ---------------- v1.11 媒体令牌与代理健壮性 ---------------- */
console.log('\n== v1.11 媒体令牌 ==');
ok(!!mediaToken, '/me 下发媒体令牌', String(mediaToken).slice(0, 12) + '…');
const onlyUid = await fetch(`${BASE}/api/videos/${pv}/play?uid=${uid}`);
ok(onlyUid.status === 401, '旧式「裸 uid」链接被拒（防转发泄露）', String(onlyUid.status));
try { await onlyUid.body?.cancel?.(); } catch { /* ignore */ }
const withTok = await fetch(`${BASE}/api/videos/${pv}/play?t=${encodeURIComponent(mediaToken)}`);
ok(withTok.status === 200 || withTok.status === 206, '签名令牌可访问媒体', String(withTok.status));
try { await withTok.body?.cancel?.(); } catch { /* ignore */ }
const badTok = await fetch(`${BASE}/api/videos/${pv}/play?t=${encodeURIComponent(mediaToken.slice(0, -3) + 'abc')}`);
ok(badTok.status === 401, '篡改令牌被拒', String(badTok.status));
try { await badTok.body?.cancel?.(); } catch { /* ignore */ }

console.log('\n== v1.11 代理健壮性 ==');
// 3) 删除素材 → 播放版文件一并删除（磁盘不再泄漏）
const delSample = mkSample('qc-del.mp4', '300x500', 1.3);
const delFd = new FormData();
delFd.append('files', new Blob([fs.readFileSync(delSample)], { type: 'video/mp4' }), 'del.mp4');
delFd.append('space', 'daily');
delFd.append('title', '删除级联验证');
const delRes = await (await fetch(BASE + '/api/videos/upload', { method: 'POST', headers: { 'x-user-id': uid }, body: delFd })).json();
const delId = delRes.items?.[0]?.id;
ok(!!delId, '上传删除级联验证素材');
{
  // 小样片是 H.264 轻片会被「无需转码」跳过 → 标成 HEVC 强制走转码，验证删除级联
  const wdbDel = new Database(path.join(env.DATA_DIR, 'app.db'));
  wdbDel.prepare("UPDATE videos SET codec='hevc', pix_fmt='yuv420p10le', width=1080, height=1920, proxy_state=NULL WHERE id=?").run(delId);
  wdbDel.close();
}
await call('/videos/' + delId + '/proxy', { method: 'POST', uid });
let delProxy = '';
for (let i = 0; i < 40; i++) {
  await sleep(700);
  const d = await call('/videos/' + delId, { uid });
  delProxy = d.data?.video?.proxy_state || '';
  if (delProxy === 'done' || delProxy === 'failed') break;
}
ok(delProxy === 'done', '转码完成（删除前）', delProxy);
const proxyPathAfter = path.join(env.DATA_DIR, 'media', 'proxies', delId + '.mp4');
ok(fs.existsSync(proxyPathAfter), '播放版文件存在');
await call('/videos/' + delId, { method: 'DELETE', uid });
ok(!fs.existsSync(proxyPathAfter), '删除素材后播放版文件被清理（不再泄漏磁盘）');

// 4) done 但文件丢了 → /play 应重新转（不再固定等满超时）
const wdb3 = new Database(path.join(env.DATA_DIR, 'app.db'));
const lostRow = wdb3.prepare("SELECT id FROM videos WHERE proxy_state='done' LIMIT 1").get();
const lostId = lostRow?.id;
ok(!!lostId, '找到一条已完成转码的素材');
const lostPath = path.join(env.DATA_DIR, 'media', 'proxies', lostId + '.mp4');
fs.rmSync(lostPath, { force: true });
wdb3.close();
const t0lost = Date.now();
const relost = await fetch(`${BASE}/api/videos/${lostId}/play?t=${encodeURIComponent(mediaToken)}`);
const costLost = Date.now() - t0lost;
const srcLost = relost.headers.get('x-play-source');
ok((srcLost === 'original' || srcLost === 'proxy') && costLost < 8000,
  '文件缺失时不再固定等 25 秒（≤8s 内给出响应）', `${srcLost} ${costLost}ms`);
if (srcLost === 'original') {
  ok(relost.headers.get('x-proxy-pending') === '1', '发原片时告知前端「转码中」', relost.headers.get('x-proxy-pending'));
}
try { await relost.body?.cancel?.(); } catch { /* ignore */ }
let reformed = false;
for (let i = 0; i < 40; i++) {
  await sleep(700);
  if (fs.existsSync(lostPath)) { reformed = true; break; }
}
ok(reformed, '缺失的播放版会自动重转（状态不会卡在 done）');

// 5) 坏文件：转码失败但不能堵住队列
const badId = uuidv4Like();
const badRel = 'daily/' + ymdLocal() + '/' + badId + '.mp4';
const badAbs = path.join(env.DATA_DIR, 'media', badRel);
fs.mkdirSync(path.dirname(badAbs), { recursive: true });
fs.writeFileSync(badAbs, Buffer.alloc(2048, 7));   // 垃圾字节，ffmpeg 必失败
const wdb4 = new Database(path.join(env.DATA_DIR, 'app.db'));
wdb4.prepare(`INSERT INTO videos (id,space,title,orig_name,file_path,mime,size,duration,width,height,
  shoot_date,source,uploader_id,status,tags,dedupe_key,created_at,updated_at,codec,pix_fmt,fps,has_audio,qc_status,proxy_state)
  VALUES (?, 'daily','坏文件验证','bad.mp4',?,'video/mp4',2048,5,1080,1920,?,'upload',?,'new','',?,?,?,'hevc','yuv420p10le',30,1,'skipped','pending')`)
  .run(badId, badRel, ymdLocal(), uid, 'bad-' + badId, Date.now(), Date.now());
wdb4.close();
await call('/videos/' + badId + '/proxy', { method: 'POST', uid });   // 触发队列
let badState = '';
for (let i = 0; i < 40; i++) {
  await sleep(800);
  const d = await call('/videos/' + badId, { uid });
  badState = d.data?.video?.proxy_state || '';
  if (badState === 'failed') break;
}
ok(badState === 'failed', '坏文件转码失败并标记 failed（不会永久 running）', badState);
// 队列继续工作：再触发一条正常素材，应能转完
const afterId = pv;
fs.rmSync(path.join(env.DATA_DIR, 'media', 'proxies', afterId + '.mp4'), { force: true });
await call('/videos/' + afterId + '/proxy', { method: 'POST', uid });
let afterDone = false;
for (let i = 0; i < 40; i++) {
  await sleep(800);
  if (fs.existsSync(path.join(env.DATA_DIR, 'media', 'proxies', afterId + '.mp4'))) { afterDone = true; break; }
}
ok(afterDone, '坏文件之后队列仍能继续转（未被堵死）');

// 6) 没配任何地址时不应产生空链接
await call('/settings/notify', { method: 'PUT', uid, body: { notify_public_base: '', notify_link_base: '', notify_on_comment: true } });
const beforeCnt = feedHooks.length;
await call('/videos/' + pv + '/comments', { method: 'POST', uid, body: { body: '空链接兜底验证' } });
await sleep(800);
const emptyMsg = String(feedHooks.at(-1)?.body?.markdown?.text || '');
ok(feedHooks.length > beforeCnt, '仍能推送（只是没链接）', String(feedHooks.length));
ok(!emptyMsg.includes('url=&'), '未配地址时不生成空链接', emptyMsg.slice(-80));

/* ---------------- v1.11.1 下载/导出链接也要令牌 ---------------- */
console.log('\n== v1.11.1 下载链接令牌 ==');
const dlVid = pv;
const batch = await call('/downloads', { method: 'POST', uid, body: { videoIds: [dlVid], note: '令牌验证' } });
ok([200, 201].includes(batch.status) && !!batch.data?.downloadUrl, '创建下载批次', String(batch.status));
const dlUrl = batch.data?.downloadUrl || '';

const dlBare = await fetch(BASE + dlUrl + '?uid=' + uid);
ok(dlBare.status === 401, '下载链接泄露的裸 uid 被拒', String(dlBare.status));
try { await dlBare.body?.cancel?.(); } catch { /* ignore */ }

const dlTok = await fetch(`${BASE}${dlUrl}?t=${encodeURIComponent(mediaToken)}`);
ok(dlTok.status === 200, '带令牌可正常下载', String(dlTok.status));
const dlType = dlTok.headers.get('content-type') || '';
ok(/zip|octet-stream|video\/mp4/.test(dlType), '下载返回文件（单条直接发原片 / 多条打 zip）', dlType);
try { await dlTok.body?.cancel?.(); } catch { /* ignore */ }

const csvBare = await fetch(BASE + '/api/export.csv?ids=' + dlVid + '&uid=' + uid);
ok(csvBare.status === 401, '导出 CSV 裸 uid 被拒', String(csvBare.status));
try { await csvBare.body?.cancel?.(); } catch { /* ignore */ }
const csvTok = await fetch(`${BASE}/api/export.csv?ids=${dlVid}&t=${encodeURIComponent(mediaToken)}`);
ok(csvTok.status === 200, '导出 CSV 带令牌可用', String(csvTok.status));
const csvBody = await csvTok.text();
ok(csvBody.includes(',') && csvBody.split('\n').length >= 2, 'CSV 内容非空', csvBody.slice(0, 40));

/* ---------------- v1.12 成员工作量（业绩分析） ---------------- */
console.log('\n== v1.12 成员工作量 ==');
const mb = await call('/stats/members', { uid });
ok(mb.status === 200 && Array.isArray(mb.data?.items), '成员工作量接口可用', String(mb.status));
const adminRow = (mb.data.items || []).find(u => u.id === uid);
ok(!!adminRow, '返回管理员这一行');
ok((adminRow?.uploads || 0) > 0, '统计到素材产出', String(adminRow?.uploads));
ok(typeof adminRow?.durationSec === 'number' && adminRow.durationSec >= 0, '统计到总时长', String(adminRow?.durationSec));
ok(typeof adminRow?.sizeBytes === 'number' && adminRow.sizeBytes >= 0, '统计到总体积', String(adminRow?.sizeBytes));
ok((mb.data.totals?.uploads || 0) >= (adminRow?.uploads || 0), '合计不小于个人', String(mb.data.totals?.uploads));

// 空间过滤：素材库单独看
const mbLib = await call('/stats/members?space=library', { uid });
ok(mbLib.status === 200, '按空间筛选可用', String(mbLib.status));
const adminLib = (mbLib.data.items || []).find(u => u.id === uid);
ok((adminLib?.uploads || 0) < (adminRow?.uploads || 0), '素材库口径明显小于全部', `${adminLib?.uploads} < ${adminRow?.uploads}`);

// 时间过滤：未来区间应为 0
const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
const mbFuture = await call(`/stats/members?from=${tomorrow}&to=${tomorrow}`, { uid });
const fRow = (mbFuture.data.items || []).find(u => u.id === uid);
ok((fRow?.uploads || 0) === 0, '未来时间区间统计为 0', String(fRow?.uploads));

// 角色过滤：只读角色应看不到人（测试库里没有 viewer）
const mbViewer = await call('/stats/members?role=viewer', { uid });
ok(Array.isArray(mbViewer.data?.items) && mbViewer.data.items.length === 0, '按角色筛选生效（无 viewer 则空）', String(mbViewer.data?.items?.length));
// 拍摄产出面板：只统计拍摄成员
const mbShoot = await call('/stats/members?role=shooter', { uid });
ok(Array.isArray(mbShoot.data?.items) && mbShoot.data.items.every(u => u.role === 'shooter'),
  '只统计拍摄成员（不含运营/管理员/只读）', JSON.stringify((mbShoot.data?.items || []).map(u => u.role)));
ok((mbShoot.data?.totals?.uploads || 0) >= 0, '拍摄口径合计可用', String(mbShoot.data?.totals?.uploads));

// CSV 导出
const csvRes = await fetch(`${BASE}/api/stats/members.csv?t=${encodeURIComponent(mediaToken)}`);
ok(csvRes.status === 200, 'CSV 导出可用', String(csvRes.status));
const csvText = await csvRes.text();
ok(csvText.includes('成员') && csvText.includes('素材条数'), 'CSV 表头正确', csvText.slice(0, 60));
ok(csvText.split('\n').length >= 3, 'CSV 含表头+数据+合计', String(csvText.split('\n').length));

/* ---------------- v1.13.0 统一移动（阶段 + 空间 + 权限 + 原片迁移） ---------------- */
console.log('\n== v1.13.0 移动功能 ==');
const mvOwner = await call('/users', { method: 'POST', body: { name: '移动验证上传者', password: 'mv12345678', role: 'shooter' } });
const ownerUid = mvOwner.data?.user?.id;
const mvOther = await call('/users', { method: 'POST', body: { name: '移动验证路人', password: 'mv12345678', role: 'shooter' } });
const otherUid = mvOther.data?.user?.id;
ok(mvOwner.status === 201 && !!ownerUid && mvOther.status === 201 && !!otherUid,
  '准备上传者与路人两个非管理员账号', `${mvOwner.status}/${mvOther.status}`);

const mvSample = path.join(tmp, 'move-sample.mp4');
execFileSync('ffmpeg', [
  '-hide_banner', '-loglevel', 'error', '-y',
  '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=20',
  '-t', '3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast', mvSample,
]);
const mvFd = new FormData();
mvFd.append('files', new Blob([fs.readFileSync(mvSample)], { type: 'video/mp4' }), 'move-sample.mp4');
mvFd.append('space', 'daily');
mvFd.append('shootDate', ymdLocal());
mvFd.append('title', '移动验证素材');
const mvUp = await fetch(BASE + '/api/videos/upload', { method: 'POST', headers: { 'x-user-id': ownerUid }, body: mvFd });
const mvUpData = await mvUp.json().catch(() => ({}));
const mvId = mvUpData.items?.[0]?.id;
ok(mvUp.ok && !!mvId, '上传者上传一条每日选片素材', String(mvUp.status));

const openMvDb = () => new Database(path.join(env.DATA_DIR, 'app.db'));
const mvRow = id => { const d = openMvDb(); const r = d.prepare('SELECT * FROM videos WHERE id = ?').get(id); d.close(); return r; };
const mediaAbs = rel => path.join(env.DATA_DIR, 'media', rel || '');
const before = mvRow(mvId);
ok(before?.space === 'daily' && String(before.file_path).startsWith('daily/'),
  '初始状态：空间与物理目录都是 daily', String(before?.file_path));
ok(fs.existsSync(mediaAbs(before.file_path)), '初始原片文件存在', before?.file_path);

// 权限：非上传者不能移动（批量与单条 PATCH 都要挡住）
const denyBulk = await call('/videos/bulk-move', { method: 'POST', uid: otherUid, body: { ids: [mvId], stage: 'final' } });
ok(denyBulk.status === 403, '路人批量移动被拒', String(denyBulk.status));
const denyPatch = await call('/videos/' + mvId, { method: 'PATCH', uid: otherUid, body: { space: 'library' } });
ok(denyPatch.status === 403, '路人通过 PATCH 改空间也被拒', String(denyPatch.status));
ok(mvRow(mvId).stage === before.stage && mvRow(mvId).space === 'daily', '越权请求没有产生部分写入');

// 部分越权：一人是自己的、一人不是，整批拒绝
const adminSample = path.join(tmp, 'move-admin.mp4');
execFileSync('ffmpeg', [
  '-hide_banner', '-loglevel', 'error', '-y',
  '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=20',
  '-f', 'lavfi', '-i', 'sine=frequency=880',
  '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-preset', 'ultrafast', adminSample,
]);
const adminFd = new FormData();
adminFd.append('files', new Blob([fs.readFileSync(adminSample)], { type: 'video/mp4' }), 'move-admin.mp4');
adminFd.append('space', 'daily');
adminFd.append('shootDate', ymdLocal());
adminFd.append('title', '移动验证管理员素材');
const adminUp = await fetch(BASE + '/api/videos/upload', { method: 'POST', headers: { 'x-user-id': uid }, body: adminFd });
const adminMvId = (await adminUp.json().catch(() => ({}))).items?.[0]?.id;
ok(adminUp.ok && !!adminMvId, '管理员上传一条素材用于混合批次验证', String(adminUp.status));
const adminVidBefore = mvRow(adminMvId);
const mixed = await call('/videos/bulk-move', { method: 'POST', uid: ownerUid, body: { ids: [mvId, adminMvId], stage: 'final' } });
ok(mixed.status === 403, '混合批次含他人素材时整批拒绝', String(mixed.status));
ok(mvRow(adminMvId).stage === adminVidBefore.stage, '混合批次中他人素材未被改动', String(mvRow(adminMvId)?.stage));

// 参数校验
ok((await call('/videos/bulk-move', { method: 'POST', uid, body: { ids: [] } })).status === 400, '空选移动返回 400');
ok((await call('/videos/bulk-move', { method: 'POST', uid, body: { ids: [mvId], stage: 'bogus' } })).status === 400, '非法阶段返回 400');
ok((await call('/videos/bulk-move', { method: 'POST', uid, body: { ids: [mvId] } })).status === 400, '未指定目标返回 400');

// 上传者本人：一次请求同时改阶段和空间
const moved = await call('/videos/bulk-move', { method: 'POST', uid: ownerUid, body: { ids: [mvId], stage: 'screened', space: 'library' } });
ok(moved.status === 200 && moved.data?.count === 1, '上传者可一次移动阶段与空间', String(moved.status));
const inLib = mvRow(mvId);
ok(inLib.space === 'library' && inLib.stage === 'screened', '数据库空间与阶段均已更新', `${inLib.space}/${inLib.stage}`);
ok(String(inLib.file_path).startsWith('library/'), 'file_path 同步到 library 目录', inLib.file_path);
ok(!fs.existsSync(mediaAbs(before.file_path)) && fs.existsSync(mediaAbs(inLib.file_path)),
  '原片物理文件已迁移（旧路径消失、新路径存在）', inLib.file_path);
ok(inLib.qc_status === 'skipped', '进入素材库后跳过体检', String(inLib.qc_status));

// 管理员：移回每日选片，体检状态重新排队
const backMove = await call('/videos/bulk-move', { method: 'POST', uid, body: { ids: [mvId], stage: 'shortlisted', space: 'daily' } });
ok(backMove.status === 200, '管理员可移回每日选片', String(backMove.status));
const inDaily = mvRow(mvId);
ok(inDaily.space === 'daily' && inDaily.stage === 'shortlisted', '移回后空间与阶段正确', `${inDaily.space}/${inDaily.stage}`);
ok(String(inDaily.file_path).startsWith('daily/') && fs.existsSync(mediaAbs(inDaily.file_path)),
  '原片物理文件回到 daily 且仍可访问', inDaily.file_path);
ok(inDaily.qc_status === 'pending', '回到每日选片后重新排队体检', String(inDaily.qc_status));

// 兼容路径：单条 PATCH 改空间也要搬文件
const patchSpace = await call('/videos/' + mvId, { method: 'PATCH', uid, body: { space: 'library' } });
ok(patchSpace.status === 200, '单条 PATCH 改空间仍可用', String(patchSpace.status));
const patchRow = mvRow(mvId);
ok(String(patchRow.file_path).startsWith('library/') && fs.existsSync(mediaAbs(patchRow.file_path)),
  'PATCH 改空间也同步迁移原片', patchRow.file_path);
ok(patchRow.stage === inDaily.stage, 'PATCH 只改空间时不误改阶段', patchRow.stage);

// 移动后媒体仍可下载
const mvDl = await call('/downloads', { method: 'POST', uid, body: { videoIds: [mvId], note: '移动后下载' } });
ok([200, 201].includes(mvDl.status) && !!mvDl.data?.downloadUrl, '移动后可正常创建下载', String(mvDl.status));
const mvDlRes = await fetch(`${BASE}${mvDl.data?.downloadUrl || ''}?t=${encodeURIComponent(mediaToken)}`);
ok(mvDlRes.status === 200, '移动后下载链接仍指向有效文件', String(mvDlRes.status));
try { await mvDlRes.body?.cancel?.(); } catch { /* ignore */ }

/* ---------------- v1.13.1 深度审查修复 + 批量删除 ---------------- */
console.log('\n== v1.13.1 批量删除与一致性 ==');
const hugeIds = Array.from({ length: 201 }, (_, i) => 'x' + i);
ok((await call('/videos/bulk-move', { method: 'POST', uid, body: { ids: hugeIds, stage: 'final' } })).status === 400,
  'bulk-move 超过 200 条返回 400');
ok((await call('/videos/bulk-delete', { method: 'POST', uid, body: { ids: hugeIds } })).status === 400,
  'bulk-delete 超过 200 条返回 400');

// 批量体检要如实报告跳过项
const qcMix = await call('/videos/bulk-qc', { method: 'POST', uid, body: { ids: [mvId, adminMvId] } });
ok(qcMix.status === 200 && (qcMix.data.skipped || []).includes(mvId),
  'bulk-qc 对素材库条目明确返回 skipped', JSON.stringify(qcMix.data.skipped));
ok((qcMix.data.changed || 0) >= 1, 'bulk-qc 返回真实变更数', String(qcMix.data.changed));

// 移回每日选片：清掉上一轮体检结论
const wqc = openMvDb();
wqc.prepare('UPDATE videos SET qc_score=88, qc_flags=?, sim_of=? WHERE id=?').run('loud', adminMvId, mvId);
wqc.close();
const resetMove = await call('/videos/bulk-move', { method: 'POST', uid, body: { ids: [mvId], space: 'daily' } });
ok(resetMove.status === 200, '移回每日选片成功', String(resetMove.status));
const afterReset = mvRow(mvId);
ok(afterReset.qc_score == null && !afterReset.qc_flags, '移回每日选片清空过期体检数据', `${afterReset.qc_score}/${afterReset.qc_flags}`);

// 并发反向移动：最终 DB 空间与文件实际位置必须一致
const race = await Promise.all([
  call('/videos/bulk-move', { method: 'POST', uid, body: { ids: [mvId], space: 'library' } }),
  call('/videos/bulk-move', { method: 'POST', uid, body: { ids: [mvId], space: 'daily' } }),
]);
ok(race.every(r => [200, 500].includes(r.status)), '并发移动不会崩溃（乐观锁冲突返回 500）', race.map(r => r.status).join('/'));
const raced = mvRow(mvId);
ok(String(raced.file_path).startsWith(raced.space + '/') && fs.existsSync(mediaAbs(raced.file_path)),
  '并发后 DB 空间与文件实际位置一致', `${raced.space}/${raced.file_path}`);

// 源文件缺失必须 fail loud，不能把 DB 改成指向不存在的文件
const beforeMiss = mvRow(mvId);
const fakeRel = (beforeMiss.space === 'library' ? 'daily' : 'library') + '/' + beforeMiss.shoot_date + '/missing-' + mvId + '.mp4';
const wm = openMvDb();
wm.prepare('UPDATE videos SET file_path=? WHERE id=?').run(fakeRel, mvId);
wm.close();
const missMove = await call('/videos/bulk-move', {
  method: 'POST', uid, body: { ids: [mvId], space: beforeMiss.space === 'library' ? 'daily' : 'library' },
});
ok(missMove.status === 500 && String(missMove.data.error).includes('原片文件不存在'),
  '原片缺失时移动失败并明确报错（不再静默改写 DB）', String(missMove.data.error));
ok(mvRow(mvId).file_path === fakeRel, '失败后 DB 路径保持不变', mvRow(mvId).file_path);
const wr = openMvDb();
wr.prepare('UPDATE videos SET file_path=? WHERE id=?').run(beforeMiss.file_path, mvId);
wr.close();

// PATCH 同时改拍摄日期与空间：文件要落到新日期目录
const dateMove = await call('/videos/' + mvId, { method: 'PATCH', uid, body: { shootDate: '2020-01-02', space: 'library' } });
ok(dateMove.status === 200, 'PATCH 同时改日期与空间成功', String(dateMove.status));
const dated = mvRow(mvId);
ok(String(dated.file_path).includes('/2020-01-02/') && fs.existsSync(mediaAbs(dated.file_path)),
  '原片落到新拍摄日期目录', dated.file_path);

// 批量删除权限
const delDeny = await call('/videos/bulk-delete', { method: 'POST', uid: otherUid, body: { ids: [mvId] } });
ok(delDeny.status === 403, '路人批量删除被拒', String(delDeny.status));
ok(!!mvRow(mvId), '越权删除后素材仍在');

// 批量删除：级联脚本、关键帧、scan_files、相似引用、原片
const bulkDelId = adminMvId;
// 等播放版转码结束再删，避免 Windows 上 ffmpeg 还占着原片导致 unlink 偶发失败
for (let i = 0; i < 40; i++) {
  const st = mvRow(bulkDelId)?.proxy_state;
  if (st !== 'running') break;
  await sleep(500);
}
const bulkDelRow = mvRow(bulkDelId);
const bulkDelAbs = mediaAbs(bulkDelRow.file_path);
const bulkSid = 's-del-' + uuidv4Like();
const bulkFrameDir = path.join(env.DATA_DIR, 'media', 'frames', 's-' + bulkSid);
fs.mkdirSync(bulkFrameDir, { recursive: true });
fs.writeFileSync(path.join(bulkFrameDir, '0.jpg'), Buffer.alloc(16, 1));
const wbdel = openMvDb();
wbdel.prepare('INSERT INTO scripts (id,video_id,status,frames,created_at,updated_at) VALUES (?,?,\'done\',?,?,?)')
  .run(bulkSid, bulkDelId, JSON.stringify([{ path: `frames/s-${bulkSid}/0.jpg` }]), Date.now(), Date.now());
wbdel.prepare('INSERT INTO scan_files (path,size,mtime,video_id,scanned_at) VALUES (?,?,?,?,?)')
  .run('/tmp/del-source.mp4', 1234, Date.now(), bulkDelId, Date.now());
wbdel.prepare('UPDATE videos SET sim_of=? WHERE id=?').run(bulkDelId, mvId);
wbdel.close();
const bulkDelRes = await call('/videos/bulk-delete', { method: 'POST', uid, body: { ids: [bulkDelId] } });
ok(bulkDelRes.status === 200 && bulkDelRes.data.count === 1, '批量删除成功', JSON.stringify(bulkDelRes.data));
ok((bulkDelRes.data.failedCleanup || []).length === 0, '批量删除没有文件清理残留',
  JSON.stringify(bulkDelRes.data.failedCleanup));
ok(!mvRow(bulkDelId) && !fs.existsSync(bulkDelAbs), 'DB 记录与原片文件都已删除',
  `db=${!!mvRow(bulkDelId)} file=${fs.existsSync(bulkDelAbs)} path=${bulkDelAbs}`);
ok(!fs.existsSync(bulkFrameDir), '脚本关键帧目录已删除（含未写入 frames 字段的目录）');
const wdc = openMvDb();
ok(!wdc.prepare('SELECT 1 FROM scripts WHERE video_id=?').get(bulkDelId), '脚本记录已级联删除');
const sf = wdc.prepare('SELECT video_id FROM scan_files WHERE path=?').get('/tmp/del-source.mp4');
ok(sf && sf.video_id == null, 'scan_files 关联已解除（源文件可重新入库）');
ok(!wdc.prepare('SELECT 1 FROM videos WHERE sim_of=?').get(bulkDelId), '相似素材引用已清空');
wdc.close();

// 启动对账：DB 指向错位目录时按真实文件修复
const recRow = mvRow(mvId);
const wrongSpace = recRow.space === 'library' ? 'daily' : 'library';
const wrongRel = wrongSpace + '/' + recRow.shoot_date + '/' + path.basename(recRow.file_path);
const wr2 = openMvDb();
wr2.prepare('UPDATE videos SET file_path=? WHERE id=?').run(wrongRel, mvId);
wr2.close();
// reconcile 模块读 process.env；测试进程要临时指向同一 DATA_DIR，否则会打开默认库
const savedDataDir = process.env.DATA_DIR;
process.env.DATA_DIR = env.DATA_DIR;
const { reconcileMedia } = require(path.join(root, 'server', 'lib', 'reconcile.js'));
const rep = reconcileMedia();
if (savedDataDir === undefined) delete process.env.DATA_DIR;
else process.env.DATA_DIR = savedDataDir;
const fixedRow = mvRow(mvId);
ok(rep.fixed >= 1 && fixedRow.file_path === recRow.file_path,
  '启动对账修复 DB 与文件错位', `${wrongRel} -> ${fixedRow.file_path}`);
ok(fs.existsSync(mediaAbs(fixedRow.file_path)), '对账后路径指向真实文件', fixedRow.file_path);

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
ok(html.includes('data-act="move"'), '批量操作条有「移动」入口');
ok(html.includes('data-act="delete"'), '批量操作条有「删除」入口');
ok(!html.includes('data-act="library"'), '旧「存入素材库」按钮已收进移动菜单');
ok(appjs.includes('/videos/bulk-move') && appjs.includes('openMoveMenu'), '前端统一移动菜单调用 bulk-move');
ok(appjs.includes('/videos/bulk-delete') && appjs.includes('canManage'), '前端批量删除带权限预判');
ok(appjs.includes("window.addEventListener('pagehide', closeMoveMenu)"), '菜单在页面离开时统一清理');
ok(appjs.includes('/settings/notify/health') && appjs.includes('healthChip'), '设置页展示公网地址健康状态');

/* ---------------- v1.8.0 下载记录权限 + TikTok 竖滑播放器 ---------------- */
console.log('\n== v1.8.0 记录权限收口 ==');
const opList = await call('/downloads', { uid: opUid });
ok(opList.status === 403, '非管理员查下载记录 → 403', String(opList.status) + (opList.data?.error || ''));
const admList = await call('/downloads', { uid });
ok(admList.status === 200 && Array.isArray(admList.data?.items), '管理员可查下载记录', String(admList.status));
const opPost = await call('/downloads', { method: 'POST', uid: opUid, body: { ids: [] } });
ok(opPost.status === 400, '非管理员下载动作本身不受限（空 ids 校验 400 而非 403）', String(opPost.status));

console.log('\n== v1.8.0 竖滑播放器（静态结构） ==');
ok(fs.existsSync(path.join(root, 'public', 'js', 'feed.js')), 'feed.js 存在');
ok(appjs.includes("from './feed.js'"), 'app.js 引入 feed 模块');
const feedjs = fs.readFileSync(path.join(root, 'public', 'js', 'feed.js'), 'utf8');
ok(feedjs.includes('export function openFeed'), 'feed 导出 openFeed');
ok(feedjs.includes('feed-mask-chk') && feedjs.includes('MASK_KEY'), '遮罩勾选可记忆');
ok(feedjs.includes('feed-rail') && feedjs.includes('feed-info'), '遮罩含功能列与文案区');
ok(feedjs.includes('touchend') && feedjs.includes('wheel'), '支持滑动/滚轮切换');
ok(feedjs.includes("PATCH"), '收藏(星标)走 PATCH 真实接口');
const cssAll = fs.readFileSync(path.join(root, 'public', 'css', 'app.css'), 'utf8');
ok(cssAll.includes('.feed-root') && cssAll.includes('.feed-rail'), 'feed 样式已就位');
ok(appjs.includes("view === 'records'"), 'app.js 记录视图有非管理员守卫');
ok(appjs.includes('openFeed(S.items') && appjs.includes('isMobileLike'), '手机端点卡片进竖滑模式');

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail) console.log('\n服务端日志片段：\n' + log.slice(-1500));
console.log(`临时目录：${tmp}`);
stop();
process.exit(fail ? 1 : 0);
