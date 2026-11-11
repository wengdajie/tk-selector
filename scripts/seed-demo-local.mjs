/**
 * 造一份带历史跨度的本地演示数据（仅用于本地预览/截图，切勿对生产库执行）
 * 用法：node scripts/seed-demo-local.mjs <absDataDir>
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const dataDir = process.argv[2];
if (!dataDir) {
  console.error('[FATAL] 需要传入 data 目录绝对路径，例如 /tmp/tkdata');
  process.exit(1);
}
const dbPath = path.join(dataDir, 'app.db');
if (!fs.existsSync(dbPath)) {
  console.error(`[FATAL] 数据库不存在: ${dbPath}`);
  process.exit(1);
}

const db = new Database(dbPath);
db.pragma('foreign_keys = ON');

const DAY = 86400000;
const now = Date.now();
const uid = () => crypto.randomUUID();
const pick = arr => arr[Math.floor(Math.random() * arr.length)];

const users = db.prepare('SELECT * FROM users').all();
const admin = users.find(u => u.role === 'admin');

// 追加两位成员
const extra = [
  { name: '小林', role: 'ops', color: '#25F4EE' },
  { name: '阿哲', role: 'shooter', color: '#FFC24B' },
  { name: '思思', role: 'ops', color: '#9B8CFF' },
];
const insUser = db.prepare(`INSERT OR IGNORE INTO users (id,name,role,color,active,created_at,password_hash)
  VALUES (?,?,?,?,1,?,?)`);
const { hashPassword } = require('../server/lib/password');
for (const u of extra) {
  if (db.prepare('SELECT id FROM users WHERE name=?').get(u.name)) continue;
  insUser.run(uid(), u.name, u.role, u.color, now - 20 * DAY, hashPassword('tkadmin2026'));
}
const allUsers = db.prepare('SELECT * FROM users WHERE active=1').all();

// 生成缩略图
const thumbsDir = path.join(dataDir, 'media', 'thumbs');
fs.mkdirSync(thumbsDir, { recursive: true });

const TITLES = [
  '厨房收纳盒 · 痛点开场', '开箱第一视角 · 桌面好物', '夏日饮品 · 特写转场',
  '通勤包 · 容量实测', '宠物梳毛 · 前后对比', '露营灯 · 夜间氛围',
  '护肤品 · 质地特写', '健身弹力带 · 居家训练', '儿童水杯 · 防漏测试',
  '车载支架 · 高速颠簸', '香薰蜡烛 · 手部特写', '折叠桌椅 · 三秒开合',
  '咖啡机 · 打奶泡近景', '防晒喷雾 · 户外实拍',
];
const TAGS = ['开箱,爆款脚本', '厨房,KOC', '户外,氛围感', '痛点,对比', '特写,细节', ''];

const insVideo = db.prepare(`INSERT INTO videos
  (id,space,title,orig_name,file_path,thumb_path,mime,size,duration,width,height,shoot_date,source,src_path,uploader_id,status,tags,request_id,dedupe_key,created_at,updated_at,rating,rated_by)
  VALUES (@id,@space,@title,@orig_name,@file_path,@thumb_path,'video/mp4',@size,@duration,@width,@height,@shoot_date,'upload',NULL,@uploader_id,@status,@tags,NULL,NULL,@created_at,@updated_at,@rating,@rated_by)`);

const created = [];
for (let i = 0; i < TITLES.length; i++) {
  const daysAgo = Math.floor(i / 2);           // 每两天两条
  const createdAt = now - daysAgo * DAY - Math.floor(Math.random() * 6) * 3600e3;
  const shootDate = new Date(createdAt);
  const p = n => String(n).padStart(2, '0');
  const shoot = `${shootDate.getFullYear()}-${p(shootDate.getMonth() + 1)}-${p(shootDate.getDate())}`;
  const id = uid();
  const thumb = `t${i}.jpg`;
  const rating = i < 9 ? pick([3, 4, 5, 5, 4]) : 0;
  const row = {
    id,
    space: i >= 9 && i % 3 === 0 ? 'library' : 'daily',
    title: TITLES[i],
    orig_name: `DJI_${1000 + i}.mp4`,
    file_path: `daily/${id}.mp4`,
    thumb_path: `thumbs/${thumb}`,
    size: 8 * 1024 * 1024 + Math.round(Math.random() * 40 * 1024 * 1024),
    duration: 8 + Math.round(Math.random() * 40),
    width: i % 3 === 0 ? 720 : 1920,
    height: i % 3 === 0 ? 1280 : 1080,
    shoot_date: shoot,
    uploader_id: pick(allUsers).id,
    status: i < 4 ? 'picked' : 'new',
    tags: pick(TAGS),
    created_at: createdAt,
    updated_at: createdAt + (rating ? 3600e3 : 0),
    rating,
    rated_by: rating ? pick(allUsers).id : null,
  };
  insVideo.run(row);
  created.push(row);
}

// 评论
const COMMENT_TEXTS = ['这条开场够抓人，留着做 A/B', '转场有点急，能再缓 0.5 秒吗',
  '产品细节拍得清楚，可以出片', '背景音乐换一版更贴调性', '光线偏暗，下次补个灯',
  '这个角度很带货，强烈推荐', '时长刚好，适合投流', '封面我想换一版'];
const insComment = db.prepare('INSERT INTO comments (id,video_id,user_id,body,created_at) VALUES (?,?,?,?,?)');
for (let i = 0; i < 26; i++) {
  const v = pick(created);
  insComment.run(uid(), v.id, pick(allUsers).id, pick(COMMENT_TEXTS), now - Math.floor(Math.random() * 13) * DAY - Math.floor(Math.random() * 8) * 3600e3);
}

// 下载
const insDl = db.prepare('INSERT INTO downloads (id,video_id,user_id,note,batch_id,created_at) VALUES (?,?,?,?,?,?)');
for (let i = 0; i < 18; i++) {
  const v = pick(created);
  const batch = i % 4 === 0 ? uid() : db.prepare('SELECT batch_id FROM downloads ORDER BY created_at DESC LIMIT 1').get()?.batch_id || uid();
  insDl.run(uid(), v.id, pick(allUsers.filter(u => u.role !== 'shooter')).id, '', batch,
    now - Math.floor(Math.random() * 13) * DAY - Math.floor(Math.random() * 10) * 3600e3);
}

// 需求
const REQS = [
  ['需要 3 条厨房收纳的痛点开场', 'claimed', 'high'],
  ['夏日饮品露脸口播 15 秒', 'open', 'normal'],
  ['露营装备夜景氛围素材', 'done', 'normal'],
  ['护肤品质地特写 5 条', 'done', 'high'],
  ['健身器材居家场景', 'claimed', 'low'],
  ['儿童水杯防漏实测对比', 'open', 'normal'],
  ['车载支架颠簸测试', 'done', 'normal'],
  ['咖啡机打奶泡近景', 'claimed', 'low'],
];
const insReq = db.prepare(`INSERT INTO requests (id,title,brief,priority,platform,due_date,status,tags,created_by,created_at,updated_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
const insClaim = db.prepare('INSERT OR IGNORE INTO request_claims (request_id,user_id,created_at) VALUES (?,?,?)');
for (const [i, [title, status, priority]] of REQS.entries()) {
  const rid = uid();
  const created_at = now - (12 - i) * DAY;
  const updated_at = status === 'done' ? created_at + 2 * DAY : created_at + 3600e3;
  const due = new Date(created_at + 5 * DAY);
  const p = n => String(n).padStart(2, '0');
  insReq.run(rid, title, '产品、场景、时长按脚本执行，参考附件里的爆款。', priority, 'TikTok',
    `${due.getFullYear()}-${p(due.getMonth() + 1)}-${p(due.getDate())}`, status, '开箱,场景',
    admin.id, created_at, updated_at);
  insClaim.run(rid, pick(allUsers.filter(u => u.role === 'shooter' || u.role === 'ops')).id, created_at + 7200e3);
}

console.log(`[seed] 视频 ${created.length} 条 / 评论 26 / 下载 18 / 需求 ${REQS.length}`);
console.log('[seed] 缩略图目录：' + thumbsDir);
