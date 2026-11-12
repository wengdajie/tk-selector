'use strict';
const express = require('express');
const path = require('path');
const fs = require('fs');
const config = require('./config');
const scanner = require('./lib/scanner');
const { requireUser, requireAdmin } = require('./middleware');

require('./db'); // 初始化表结构与种子数据

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

// 简单访问日志
app.use((req, res, next) => {
  const t = Date.now();
  res.on('finish', () => {
    if (req.path.startsWith('/api') && res.statusCode >= 400) {
      console.warn(`[http] ${req.method} ${req.path} ${res.statusCode} ${Date.now() - t}ms`);
    }
  });
  next();
});

app.get('/healthz', (req, res) => res.json({ ok: true, ts: Date.now() }));

// 版本自检：用来确认镜像里到底是哪份代码
const pkg = require('../package.json');
app.get('/api/version', (req, res) => {
  let mtime = null;
  try {
    mtime = fs.statSync(path.join(__dirname, '..', 'public', 'index.html')).mtime.toISOString();
  } catch { /* ignore */ }
  res.json({
    name: pkg.name,
    version: pkg.version,
    node: process.version,
    uptimeSec: Math.round(process.uptime()),
    startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
    frontendBuiltAt: mtime,
  });
});

app.use('/api', require('./routes/users'));
app.use('/api', require('./routes/videos'));
app.use('/api', require('./routes/comments'));
app.use('/api', require('./routes/downloads'));
app.use('/api', require('./routes/requests'));
app.use('/api', require('./routes/stats'));
app.use('/api', require('./routes/dashboard'));
app.use('/api', require('./routes/scripts'));
app.use('/api', require('./routes/settings'));

// 服务重启时把卡在 pending/running 的拆解任务标记为失败（否则永远「拆解中」）
require('./lib/scriptgen').recoverStale();

// 手动触发目录扫描
app.post('/api/scan', requireUser, async (req, res) => {
  const result = await scanner.scanNow({ reason: `manual:${req.user.name}`, uploaderId: null });
  res.json({ result, state: scanner.state });
});
app.get('/api/scan/status', requireUser, (req, res) => res.json(scanner.state));

// 静态资源
const publicDir = path.join(config.root, 'public');
app.use(express.static(publicDir, {
  index: false,
  setHeaders(res, filePath) {
    // 前端代码必须每次回源校验，否则升级后浏览器还在用缓存的旧 JS/CSS
    if (/\.(html|css|js|mjs)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    } else {
      res.setHeader('Cache-Control', 'public, max-age=3600');
    }
  },
}));

// SPA 兜底
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  const index = path.join(publicDir, 'index.html');
  if (!fs.existsSync(index)) return res.status(500).send('前端未构建');
  res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  res.sendFile(index);
});

app.use((req, res) => res.status(404).json({ error: '接口不存在' }));

// 统一错误处理
app.use((err, req, res, next) => {
  const status = err.status || (err.code === 'LIMIT_FILE_SIZE' ? 413 : 500);
  if (status >= 500) console.error('[error]', err);
  res.status(status).json({
    error: err.code === 'LIMIT_FILE_SIZE'
      ? `单个文件超过 ${Math.round(config.maxUploadBytes / 1024 / 1024)}MB 限制`
      : err.message || '服务器错误',
  });
});

app.listen(config.port, config.host, () => {
  console.log(`\n  TK 选片工作台 → http://${config.host}:${config.port}`);
  console.log(`  数据目录   ${config.dataDir}`);
  console.log(`  媒体目录   ${config.mediaDir}`);
  console.log(`  扫描目录   ${config.scanDir} (${config.scanMode})`);
  scanner.startScheduler();
  try { require('./lib/qcworker').start(); } catch (e) { console.warn('[qc] 启动失败:', e.message); }
});

module.exports = app;
