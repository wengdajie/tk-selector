'use strict';
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('./config');
const { uuid, ymd } = require('./lib/util');

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
fs.mkdirSync(config.mediaDir, { recursive: true });

const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  role        TEXT NOT NULL DEFAULT 'ops',      -- admin | ops | shooter | viewer
  color       TEXT NOT NULL DEFAULT '#25F4EE',
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS videos (
  id          TEXT PRIMARY KEY,
  space       TEXT NOT NULL DEFAULT 'daily',    -- daily | library
  title       TEXT NOT NULL DEFAULT '',
  orig_name   TEXT NOT NULL DEFAULT '',
  file_path   TEXT NOT NULL,                    -- 相对 mediaDir
  thumb_path  TEXT,
  mime        TEXT NOT NULL DEFAULT 'video/mp4',
  size        INTEGER NOT NULL DEFAULT 0,
  duration    REAL NOT NULL DEFAULT 0,
  width       INTEGER NOT NULL DEFAULT 0,
  height      INTEGER NOT NULL DEFAULT 0,
  shoot_date  TEXT NOT NULL,
  source      TEXT NOT NULL DEFAULT 'upload',   -- scan | upload
  src_path    TEXT,
  uploader_id TEXT,
  status      TEXT NOT NULL DEFAULT 'new',      -- new | picked | archived
  tags        TEXT NOT NULL DEFAULT '',
  request_id  TEXT,
  dedupe_key  TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_videos_space_date ON videos(space, shoot_date DESC);
CREATE INDEX IF NOT EXISTS idx_videos_created ON videos(created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_videos_dedupe ON videos(dedupe_key) WHERE dedupe_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS comments (
  id         TEXT PRIMARY KEY,
  video_id   TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL,
  body       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_comments_video ON comments(video_id, created_at);

CREATE TABLE IF NOT EXISTS downloads (
  id         TEXT PRIMARY KEY,
  video_id   TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL,
  note       TEXT NOT NULL DEFAULT '',
  batch_id   TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_downloads_video ON downloads(video_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_downloads_user ON downloads(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS requests (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  brief      TEXT NOT NULL DEFAULT '',
  priority   TEXT NOT NULL DEFAULT 'normal',    -- high | normal | low
  platform   TEXT NOT NULL DEFAULT 'TikTok',
  due_date   TEXT,
  status     TEXT NOT NULL DEFAULT 'open',      -- open | claimed | done | closed
  tags       TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_requests_status ON requests(status, created_at DESC);

CREATE TABLE IF NOT EXISTS request_claims (
  request_id TEXT NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (request_id, user_id)
);

CREATE TABLE IF NOT EXISTS scan_files (
  path       TEXT PRIMARY KEY,
  size       INTEGER NOT NULL,
  mtime      INTEGER NOT NULL,
  video_id   TEXT,
  scanned_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS scripts (
  id          TEXT PRIMARY KEY,
  video_id    TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending',   -- pending | running | done | failed
  model       TEXT,
  error       TEXT,
  title       TEXT NOT NULL DEFAULT '',
  summary     TEXT NOT NULL DEFAULT '',
  hook        TEXT NOT NULL DEFAULT '',
  segments    TEXT NOT NULL DEFAULT '',          -- JSON [{t,shot,action,line,text,audio,props,cut}]
  shot_setup  TEXT NOT NULL DEFAULT '',          -- JSON {scene,cast,props,light,gear,pace}
  replicate_prompt TEXT NOT NULL DEFAULT '',     -- 可直接喂给 AI 视频工具的复刻提示词
  script_text TEXT NOT NULL DEFAULT '',          -- 完整口播稿
  cta         TEXT NOT NULL DEFAULT '',
  tags        TEXT NOT NULL DEFAULT '',
  frames      TEXT NOT NULL DEFAULT '',          -- JSON [{t,path}]
  raw         TEXT NOT NULL DEFAULT '',
  created_by  TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scripts_video ON scripts(video_id, created_at DESC);

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_by TEXT,
  updated_at INTEGER NOT NULL
);
`);

// ---------- 轻量迁移 ----------
function hasColumn(table, col) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === col);
}
const migrations = [
  ['users', 'password_hash', 'ALTER TABLE users ADD COLUMN password_hash TEXT'],
  ['videos', 'rating', 'ALTER TABLE videos ADD COLUMN rating INTEGER NOT NULL DEFAULT 0'],
  ['videos', 'rated_by', 'ALTER TABLE videos ADD COLUMN rated_by TEXT'],
  // ---- v1.3：投放体检（QC）与感知去重 ----
  ['videos', 'codec', 'ALTER TABLE videos ADD COLUMN codec TEXT'],
  ['videos', 'pix_fmt', 'ALTER TABLE videos ADD COLUMN pix_fmt TEXT'],
  ['videos', 'fps', 'ALTER TABLE videos ADD COLUMN fps REAL'],
  ['videos', 'has_audio', 'ALTER TABLE videos ADD COLUMN has_audio INTEGER NOT NULL DEFAULT 1'],
  ['videos', 'lufs', 'ALTER TABLE videos ADD COLUMN lufs REAL'],
  ['videos', 'peak_db', 'ALTER TABLE videos ADD COLUMN peak_db REAL'],
  ['videos', 'black_pct', 'ALTER TABLE videos ADD COLUMN black_pct REAL'],
  ['videos', 'freeze_pct', 'ALTER TABLE videos ADD COLUMN freeze_pct REAL'],
  ['videos', 'crop', 'ALTER TABLE videos ADD COLUMN crop TEXT'],
  ['videos', 'qc_status', "ALTER TABLE videos ADD COLUMN qc_status TEXT NOT NULL DEFAULT 'pending'"],
  ['videos', 'qc_flags', "ALTER TABLE videos ADD COLUMN qc_flags TEXT NOT NULL DEFAULT ''"],
  ['videos', 'qc_score', 'ALTER TABLE videos ADD COLUMN qc_score INTEGER'],
  ['videos', 'phash', 'ALTER TABLE videos ADD COLUMN phash TEXT'],
  ['videos', 'sim_of', 'ALTER TABLE videos ADD COLUMN sim_of TEXT'],
  ['videos', 'sim_dist', 'ALTER TABLE videos ADD COLUMN sim_dist INTEGER'],
  // ---- v1.4：选片流水线（阶段）+ 分维度评分 ----
  ['videos', 'stage', "ALTER TABLE videos ADD COLUMN stage TEXT NOT NULL DEFAULT 'new'"],
  ['videos', 'scores', "ALTER TABLE videos ADD COLUMN scores TEXT NOT NULL DEFAULT ''"],
  ['videos', 'score_content', 'ALTER TABLE videos ADD COLUMN score_content INTEGER'],
  // ---- v1.5.1：脚本补充动作 / 拍摄设定 / AI 复刻提示词 ----
  ['scripts', 'shot_setup', "ALTER TABLE scripts ADD COLUMN shot_setup TEXT NOT NULL DEFAULT ''"],
  ['scripts', 'replicate_prompt', "ALTER TABLE scripts ADD COLUMN replicate_prompt TEXT NOT NULL DEFAULT ''"],
];
for (const [table, col, sql] of migrations) {
  if (!hasColumn(table, col)) {
    db.exec(sql);
    console.log(`[db] 迁移: ${table}.${col}`);
  }
}

// ---------- 种子数据：保证始终有一个可登录的管理员 ----------
const { hashPassword } = require('./lib/password');

function ensureAdmin() {
  const now = Date.now();
  const admin = db.prepare(
    "SELECT * FROM users WHERE role = 'admin' AND active = 1 ORDER BY created_at LIMIT 1"
  ).get();

  if (!admin) {
    db.prepare(`INSERT INTO users (id,name,role,color,active,created_at,password_hash)
                VALUES (?,?,?,?,1,?,?)`)
      .run(uuid(), config.adminName, 'admin', '#FE2C55', now, hashPassword(config.adminPassword));
    console.log(`[db] 已创建内置管理员 → ${config.adminName} / ${config.adminPassword}`);
    return;
  }

  // 历史库里管理员可能没有密码：补上默认密码，保证统一登录入口可用
  if (!admin.password_hash) {
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?')
      .run(hashPassword(config.adminPassword), admin.id);
    console.log(`[db] 管理员「${admin.name}」已设置默认密码 ${config.adminPassword}`);
  }
}

function ensureLegacyPasswords() {
  // 统一登录后，无密码的老账号无法登录，统一初始化为默认密码并提示修改
  const rows = db.prepare(
    "SELECT id, name FROM users WHERE active = 1 AND (password_hash IS NULL OR password_hash = '')"
  ).all();
  if (!rows.length) return;
  const upd = db.prepare('UPDATE users SET password_hash = ? WHERE id = ?');
  for (const u of rows) upd.run(hashPassword(config.adminPassword), u.id);
  console.log(`[db] ${rows.length} 个历史账号已设初始密码：${rows.map(r => r.name).join('、')}`);
}

ensureAdmin();
ensureLegacyPasswords();

// 兼容老数据：以前「已选」的素材视为进入复选阶段
try {
  const moved = db.prepare(
    "UPDATE videos SET stage = 'shortlisted' WHERE status = 'picked' AND stage = 'new'"
  ).run();
  if (moved.changes) console.log(`[db] ${moved.changes} 条已选素材迁移到「复选」阶段`);
} catch { /* ignore */ }

module.exports = db;
