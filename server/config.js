'use strict';
const path = require('path');

const root = path.resolve(__dirname, '..');
const dataDir = path.resolve(process.env.DATA_DIR || path.join(root, 'data'));

module.exports = {
  root,
  port: Number(process.env.PORT || 8080),
  host: process.env.HOST || '0.0.0.0',

  dataDir,
  dbPath: path.resolve(process.env.DB_PATH || path.join(dataDir, 'app.db')),
  mediaDir: path.resolve(process.env.MEDIA_DIR || path.join(dataDir, 'media')),

  // 拍摄投递目录（NAS 共享文件夹，只读挂载）
  scanDir: path.resolve(process.env.SCAN_DIR || path.join(dataDir, 'watch')),
  // copy | move | link   扫描入库时的落盘方式
  scanMode: process.env.SCAN_MODE || 'copy',
  // 扫描间隔秒，0 = 只手动扫描
  scanInterval: Number(process.env.SCAN_INTERVAL ?? 300),
  // 群晖等 NAS 的系统目录，必须跳过
  scanIgnore: (process.env.SCAN_IGNORE ||
    '@eaDir,#recycle,#snapshot,.@__thumb,@Recycle,.DS_Store,Thumbs.db')
    .split(',').map(s => s.trim()).filter(Boolean),

  ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg',
  ffprobePath: process.env.FFPROBE_PATH || 'ffprobe',

  adminName: process.env.ADMIN_NAME || '管理员',
  // 内置管理员默认密码：首次启动自动写入，可用环境变量 ADMIN_PASSWORD 覆盖
  adminPassword: process.env.ADMIN_PASSWORD || 'tkadmin2026',
  // 设置后，成员管理需要输入该口令（免密身份的轻量保护）
  accessCode: process.env.ACCESS_CODE || '',

  maxUploadBytes: Number(process.env.MAX_UPLOAD_MB || 4096) * 1024 * 1024,
  tz: process.env.TZ || 'Asia/Shanghai',

  // ---- AI 脚本拆解（OpenAI 兼容中转站，默认 grsai）----
  ai: {
    enabled: String(process.env.AI_ENABLED || '1') !== '0',
    baseUrl: (process.env.AI_BASE_URL || 'https://api.grsai.com/v1').replace(/\/+$/, ''),
    apiKey: process.env.AI_API_KEY || '',
    model: process.env.AI_MODEL || 'gpt-4o',
    frames: Math.min(10, Math.max(3, Number(process.env.AI_FRAMES || 6))),
    timeoutMs: Number(process.env.AI_TIMEOUT_MS || 300000),   // 拆解一次要传多张图 + 长 prompt，120s 对慢模型不够
  },

  // ---- 群通知（企业微信 / 飞书 / 钉钉 群机器人 webhook）----
  notify: {
    enabled: String(process.env.NOTIFY_ENABLED || '1') !== '0',
    type: ['wecom', 'feishu', 'dingtalk'].includes(process.env.NOTIFY_TYPE) ? process.env.NOTIFY_TYPE : 'wecom',
    url: (process.env.NOTIFY_URL || '').trim(),
    secret: process.env.NOTIFY_SECRET || '',
    onUpload: String(process.env.NOTIFY_ON_UPLOAD ?? '1') !== '0',
    onComment: String(process.env.NOTIFY_ON_COMMENT ?? '1') !== '0',
    // 公网访问地址（如 https://tk.example.com）：钉钉缩略图卡片要从公网拉图，内网地址钉钉拉不到
    publicBase: (process.env.NOTIFY_PUBLIC_BASE || '').replace(/\/+$/, ''),
    // 消息里链接的落点地址（可填内网 IP，手机同 WiFi 时点开更快）
    linkBase: (process.env.NOTIFY_LINK_BASE || '').replace(/\/+$/, ''),
  },
};
