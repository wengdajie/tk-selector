/**
 * 远程部署到群晖（DSM 7.x）
 *
 * 依赖：npm i -D ssh2
 * 用法：
 *   DEPLOY_HOST=192.168.1.4 DEPLOY_USER=admin DEPLOY_PASS=xxx APP_PORT=88 \
 *   node scripts/deploy-remote.mjs
 *
 * 可选环境变量：
 *   DEPLOY_SSH_PORT  默认 22
 *   APP_DIR          默认 /volume1/docker/tk-selector
 *   TARBALL          默认 /tmp/tk-selector.tgz
 *   SKIP_BUILD=1     不重新 build，只重启
 */
import { Client } from 'ssh2';
import fs from 'node:fs';

const HOST = process.env.DEPLOY_HOST;
const USER = process.env.DEPLOY_USER;
const PASS = process.env.DEPLOY_PASS;
const SSHPORT = Number(process.env.DEPLOY_SSH_PORT || 22);
const APP_PORT = process.env.APP_PORT || '88';
const APP_DIR = process.env.APP_DIR || '/volume1/docker/tk-selector';
const TARBALL = process.env.TARBALL || '/tmp/tk-selector.tgz';

if (!HOST || !USER || !PASS) {
  console.error('缺少 DEPLOY_HOST / DEPLOY_USER / DEPLOY_PASS');
  process.exit(1);
}

const conn = new Client();
let useSudo = false;

const log = (...a) => console.log(...a);

function connect() {
  return new Promise((resolve, reject) => {
    conn.on('ready', resolve)
      .on('error', reject)
      .connect({ host: HOST, port: SSHPORT, username: USER, password: PASS, readyTimeout: 20000 });
  });
}

/** 执行命令，可选 sudo（群晖上 docker 一般要 root） */
function exec(cmd, { sudo = false, timeout = 300000 } = {}) {
  return new Promise((resolve, reject) => {
    const full = sudo ? `sudo -S -p '' bash -lc ${JSON.stringify(cmd)}` : `bash -lc ${JSON.stringify(cmd)}`;
    conn.exec(full, { pty: false }, (err, stream) => {
      if (err) return reject(err);
      let out = '', errOut = '';
      const timer = setTimeout(() => { try { stream.close(); } catch {} reject(new Error('命令超时: ' + cmd.slice(0, 60))); }, timeout);
      stream.on('close', code => {
        clearTimeout(timer);
        resolve({ code, out, err: errOut });
      });
      stream.on('data', d => { out += d.toString(); });
      stream.stderr.on('data', d => {
        const s = d.toString();
        if (s.includes('[sudo]')) { stream.write(PASS + '\n'); return; }
        errOut += s;
      });
      if (sudo) stream.write(PASS + '\n');
    });
  });
}

async function run(cmd, opts = {}) {
  let r = await exec(cmd, { ...opts, sudo: useSudo });
  // sudo 失败（没有 sudo 或密码问题）时，退回普通执行再试一次
  if (useSudo && /sudo:.*(command not found|no tty|a password is required)/i.test(r.err)) {
    r = await exec(cmd, { ...opts, sudo: false });
  }
  return r;
}

function upload(local, remote) {
  return new Promise((resolve, reject) => {
    conn.sftp((err, sftp) => {
      if (err) return reject(err);
      sftp.fastPut(local, remote, e => (e ? reject(e) : resolve()));
    });
  });
}

const steps = [];
const step = (name, ok, detail = '') => {
  steps.push({ name, ok, detail });
  log(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
};

(async () => {
  log(`\n连接 ${USER}@${HOST}:${SSHPORT} …`);
  await connect();
  step('SSH 连接', true);

  // 1. 环境探测
  const who = await run('id -u; id -gn; uname -m');
  const [uid, gname, arch] = who.out.trim().split('\n');
  step('登录身份', true, `uid=${uid} group=${gname} arch=${arch}`);

  let docker = await run('docker version --format "{{.Server.Version}}" 2>&1');
  if (docker.code !== 0 || !/\d+\.\d+/.test(docker.out)) {
    useSudo = true;
    docker = await run('docker version --format "{{.Server.Version}}" 2>&1');
  }
  if (!/\d+\.\d+/.test(docker.out)) {
    step('Docker 可用', false, (docker.err || docker.out).trim().slice(0, 160));
    throw new Error('Docker 不可用或当前账号无权限，请确认是 administrators 组账号且 Container Manager 已安装');
  }
  step('Docker 可用', true, docker.out.trim().split('\n').pop());

  // 2. compose 命令
  let composeCmd = 'docker compose';
  let cv = await run('docker compose version 2>&1');
  if (!/v?\d+\.\d+/.test(cv.out)) {
    cv = await run('docker-compose version 2>&1');
    if (!/v?\d+\.\d+/.test(cv.out)) {
      step('Compose 可用', false, (cv.err || cv.out).trim().slice(0, 160));
      throw new Error('没有 docker compose / docker-compose');
    }
    composeCmd = 'docker-compose';
  }
  step('Compose 可用', true, composeCmd);

  // 3. 端口占用
  const listen = await run(`netstat -tln 2>/dev/null | grep -E '[:.]${APP_PORT}[[:space:]]' | head -3`);
  const portFree = !listen.out.trim() || listen.out.includes('dockerd') || listen.out.includes('docker');
  step(`端口 ${APP_PORT}`, portFree, portFree ? '可用' : '已有进程监听：' + listen.out.trim().split('\n')[0]);

  // 4. 上传并解包
  const size = fs.statSync(TARBALL).size;
  log(`\n上传 ${(size / 1024).toFixed(0)} KB …`);
  await upload(TARBALL, '/tmp/tk-selector.tgz');
  step('上传部署包', true, `${(size / 1024).toFixed(0)} KB`);

  const mk = await run(`mkdir -p ${APP_DIR} && tar xzf /tmp/tk-selector.tgz -C ${APP_DIR} --strip-components=1 && ls ${APP_DIR}`);
  if (mk.code !== 0) {
    step('解压', false, (mk.err || mk.out).slice(0, 200));
    throw new Error('解压失败，检查目录权限');
  }
  step('解压到 ' + APP_DIR, true);

  // 5. 写 compose 覆盖（PUID/PGID/端口），不覆盖用户已有数据目录
  const compose = `services:
  tk-selector:
    build: .
    image: tk-selector:1.1
    container_name: tk-selector
    restart: unless-stopped
    ports:
      - "${APP_PORT}:8080"
    environment:
      TZ: Asia/Shanghai
      PUID: "${uid}"
      PGID: "100"
      SCAN_DIR: /watch
      SCAN_MODE: copy
      SCAN_INTERVAL: "300"
      ADMIN_NAME: 管理员
      MAX_UPLOAD_MB: "8192"
    volumes:
      - ./data:/data
      - /volume1/拍摄投递:/watch:ro
`;
  const b64 = Buffer.from(compose).toString('base64');
  const written = await run(`echo '${b64}' | base64 -d > ${APP_DIR}/docker-compose.yml && mkdir -p ${APP_DIR}/data && echo ok`);
  step('写入 compose 配置', written.out.includes('ok'), `PUID=${uid} 端口=${APP_PORT}`);

  // 6. 构建并启动
  log('\n构建镜像（首次可能要几分钟，ffmpeg 层较大）…\n');
  const buildFlag = process.env.SKIP_BUILD === '1' ? '' : '--build';
  const up = await run(`cd ${APP_DIR} && ${composeCmd} up -d ${buildFlag} 2>&1`, { timeout: 900000 });
  const upTail = (up.out + up.err).trim().split('\n').slice(-6).join('\n');
  if (up.code !== 0) {
    step('启动容器', false, upTail.slice(0, 500));
    throw new Error('docker compose up 失败');
  }
  step('启动容器', true, upTail.split('\n').pop());

  // 7. 健康检查
  log('\n等待健康检查 …');
  let healthy = false;
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 3000));
    const h = await run(`curl -s -m 3 -o /dev/null -w '%{http_code}' http://127.0.0.1:${APP_PORT}/healthz || true`);
    if (h.out.trim() === '200') { healthy = true; break; }
    const ps = await run(`docker inspect -f '{{.State.Status}}' tk-selector 2>/dev/null`);
    if (ps.out.includes('restarting') || ps.out.includes('exited')) {
      const logs = await run('docker logs --tail 25 tk-selector 2>&1');
      step('健康检查', false, '容器异常退出\n' + logs.out.slice(-800));
      break;
    }
  }
  if (healthy) step('健康检查', true, `HTTP 200 @ :${APP_PORT}`);

  // 8. 汇总
  const ipOut = await run(`ip -4 addr show 2>/dev/null | grep -oE 'inet [0-9.]+' | head -1`);
  log('\n========== 部署结果 ==========');
  for (const s of steps) log(`${s.ok ? '✓' : '✗'} ${s.name}${s.detail ? ' — ' + s.detail : ''}`);
  log(`\n访问： http://${HOST}:${APP_PORT}`);
  log(`目录： ${APP_DIR}`);
  log(`\n常用命令：`);
  log(`  sudo docker logs -f tk-selector`);
  log(`  cd ${APP_DIR} && sudo ${composeCmd} restart`);

  conn.end();
  process.exit(healthy ? 0 : 2);
})().catch(async e => {
  console.error('\n部署中断：', e.message);
  try { conn.end(); } catch {}
  process.exit(1);
});
