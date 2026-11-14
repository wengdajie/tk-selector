/**
 * 一次性远程升级 + 存量视频预热播放版。
 */
import { Client } from 'ssh2';

const HOST = '192.168.1.4';
const USER = 'admin';
const PASS = process.env.NAS_PASS;
const TAG = process.env.DEPLOY_TAG || 'v1.10.0';
const IMG = `ghcr.nju.edu.cn/wengdajie/tk-selector:${TAG}`;

const conn = new Client();
const log = (...a) => console.log(...a);
const fail = m => { console.error('[FATAL] ' + m); conn.end(); process.exit(1); };

function exec(cmd, { timeout = 420000 } = {}) {
  return new Promise((resolve) => {
    conn.exec(`sudo -S -p '' bash -lc ${JSON.stringify(cmd)}`, { pty: false }, (err, stream) => {
      if (err) return resolve({ code: -1, out: '', err: String(err) });
      let out = '', errOut = '';
      const timer = setTimeout(() => { try { stream.close(); } catch {} resolve({ code: 124, out, err: errOut + '\n[TIMEOUT]' }); }, timeout);
      stream.on('close', code => { clearTimeout(timer); resolve({ code, out, err: errOut }); });
      stream.on('data', d => { out += d.toString(); });
      stream.stderr.on('data', d => {
        const s = d.toString();
        if (s.includes('[sudo]')) { stream.write(PASS + '\n'); return; }
        errOut += s;
      });
      stream.write(PASS + '\n');
    });
  });
}

const run = async (cmd, opts = {}) => {
  const r = await exec(cmd, opts);
  log(`\n$ ${cmd.slice(0, 110)}${cmd.length > 110 ? ' …' : ''}`);
  const tail = (r.out || '').trim().split('\n').slice(-4).join('\n');
  if (tail) log(tail);
  if ((r.err || '').trim()) log('[stderr] ' + r.err.trim().split('\n').slice(-3).join('\n'));
  return r;
};

conn.on('ready', async () => {
  log(`已连接 ${USER}@${HOST}`);
  try {
    log('\n==> 1/6 拉取镜像 ' + IMG);
    const pull = await run(`docker pull ${IMG} 2>&1 | tail -2`);
    if (!pull.out.trim()) fail('镜像拉取失败');

    log('\n==> 2/6 定位项目并更新 compose');
    const info = await run(`docker inspect tk-selector --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' 2>&1`);
    const projDir = info.out.trim();
    if (!projDir) fail('拿不到 compose 项目目录');
    const yml = `${projDir}/docker-compose.yml`;
    const sed = await run(`sed -i 's#^[[:space:]]*image:.*#    image: ${IMG}#' ${yml} && grep -n 'image:' ${yml} | head -1`);
    if (!sed.out.includes(TAG)) fail('compose image 行修改失败');

    log('\n==> 3/6 重建容器');
    const up = await run(`cd ${projDir} && docker compose up -d 2>&1 | tail -4`);
    if (up.code !== 0) fail('compose up 失败');
    await new Promise(r => setTimeout(r, 10000));

    log('\n==> 4/6 验收版本');
    let ver = await run(`curl -s -m 5 http://127.0.0.1:8899/api/version`);
    log('版本 → ' + ver.out.trim().slice(0, 160));

    log('\n==> 5/6 取管理员 id 并给存量视频排队生成播放版');
    const probe = `const D=require('/app/node_modules/better-sqlite3');const db=new D('/data/app.db',{readonly:true});console.log(db.prepare("SELECT id FROM users WHERE role='admin' AND active=1 LIMIT 1").get().id)`;
    const b64 = Buffer.from(probe).toString('base64');
    let r = await run(`docker exec tk-selector sh -c 'echo ${b64} | base64 -d > /tmp/q.js && node /tmp/q.js'`);
    const auid = r.out.trim();
    if (!auid) fail('取管理员 id 失败');
    r = await run(`curl -s -m 10 -H 'x-user-id: ${auid}' 'http://127.0.0.1:8899/api/videos?space=daily&limit=200' | tr ',' '\\n' | grep -o '"id":"[^"]*"' | cut -d'"' -f4`);
    const ids = r.out.trim().split('\n').filter(Boolean);
    log(`存量素材 ${ids.length} 条，逐条排队转码（后台串行）`);
    for (const id of ids) {
      await run(`curl -s -m 5 -X POST -H 'x-user-id: ${auid}' http://127.0.0.1:8899/api/videos/${id}/proxy > /dev/null; echo queued`);
    }

    log('\n==> 6/6 观察队列（每 15 秒看一次，最多 3 分钟）');
    for (let i = 0; i < 12; i++) {
      r = await run(`docker exec tk-selector sh -c "ls /data/media/proxies/*.mp4 2>/dev/null | wc -l"`);
      const done = r.out.trim();
      r = await run(`docker exec tk-selector node -e "const D=require('better-sqlite3');const db=new D('/data/app.db',{readonly:true});const a=db.prepare(\\\"SELECT proxy_state s, COUNT(*) c FROM videos GROUP BY proxy_state\\\").all();console.log(JSON.stringify(a))" 2>/dev/null`);
      log(`  [${i + 1}] 播放版文件 ${done} 个；状态 ${r.out.trim()}`);
      if (i >= 2 && r.out.includes('"pending"') === false) break;
      await new Promise(x => setTimeout(x, 15000));
    }
    conn.end();
  } catch (e) {
    fail(e.message);
  }
}).on('error', e => {
  console.error('[FATAL] SSH 连接失败：' + e.message);
  process.exit(1);
}).connect({ host: HOST, port: 22, username: USER, password: PASS, readyTimeout: 20000 });
