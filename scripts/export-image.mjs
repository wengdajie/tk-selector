'use strict';
/**
 * 把 GHCR 上的镜像下载并打包成 docker load 可用的离线 tar（解决 NAS 直拉 GHCR 断流）。
 *
 * 用法：
 *   node scripts/export-image.mjs [repo] [tag] [outFile]
 *   默认：wengdajie/tk-selector v1.7.1 dist/tk-selector-v1.7.1-image.tar
 *
 * 原理：匿名 token 拉 manifest（兼容 OCI index，自动选 linux/amd64）→
 * 逐层下载 blob 并校验 sha256 → 组装 legacy docker archive → tar 打包。
 * NAS 上：sudo docker load -i xxx.tar，或 Container Manager「映像 → 新增 → 从文件添加」。
 */
import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const REPO = process.argv[2] || 'wengdajie/tk-selector';
const TAG = process.argv[3] || 'v1.7.1';
const OUT = process.argv[4] || `dist/${REPO.split('/').pop()}-${TAG}-image.tar`;
const WORK = OUT.replace(/\.tar$/, '.work');
const BASE = process.env.GHCR_BASE || 'https://ghcr.io';

const fail = msg => { console.error(`[FATAL] ${msg}`); process.exit(1); };

/** 国内镜像站直连更快；只有官方 ghcr.io 才走系统代理 */
const PROXY_ARGS = BASE.includes('ghcr.io') ? [] : ['--noproxy', '*'];

/** curl 带重试；出文件或返回文本 */
function ghcrFetch(urlPath, { accept, outFile, resume = false } = {}) {
  const url = urlPath.startsWith('http') ? urlPath : `${BASE}/v2/${REPO}/${urlPath}`;
  const args = [...PROXY_ARGS, '-sSL', '--retry', '4', '--retry-delay', '2', '--retry-all-errors',
    ...(resume ? ['-C', '-'] : []),
    ...(TOKEN ? ['-H', 'Authorization: Bearer ' + TOKEN] : []),
    ...(accept ? ['-H', 'Accept: ' + accept] : []),
    url];
  if (outFile) { args.push('-o', outFile); execFileSync('curl', args, { stdio: 'inherit' }); return null; }
  return execFileSync('curl', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

const sha256File = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const fmtMB = n => (n / 1024 / 1024).toFixed(1) + 'MB';

console.log(`==> 获取匿名 token（${REPO}）`);
let TOKEN = '';
try {
  const tokenService = BASE.replace(/^https?:\/\//, '');
  const tokenRaw = execFileSync('curl', [...PROXY_ARGS, '-sSL', '--retry', '3',
    `${BASE}/token?scope=repository:${REPO}:pull&service=${tokenService}`], { encoding: 'utf8' });
  TOKEN = JSON.parse(tokenRaw).token || '';
} catch { /* 部分国内镜像站（如 ghcr.nju.edu.cn）完全免鉴权，token 拿不到也没关系 */ }
console.log(TOKEN ? '    已获取 token' : '    匿名模式（镜像站不需要 token）');

console.log(`==> 拉取 manifest: ${REPO}:${TAG}`);
const ACCEPT_ALL = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');
let manifest = JSON.parse(ghcrFetch(`manifests/${TAG}`, { accept: ACCEPT_ALL }));

// buildx 推的多架构 index：挑出 linux/amd64 的单平台 manifest
if (manifest.manifests) {
  const m = manifest.manifests.find(x => x.platform?.architecture === 'amd64' && x.platform?.os === 'linux')
    || fail('manifest index 里没有 linux/amd64');
  console.log(`    index -> amd64 子 manifest ${m.digest.slice(7, 27)}…`);
  manifest = JSON.parse(ghcrFetch(`manifests/${m.digest}`, { accept: ACCEPT_ALL }));
}
const configDigest = manifest.config?.digest || fail('manifest 里没有 config');
const layers = manifest.layers || [];
if (!layers.length) fail('manifest 里没有层');
console.log(`    config ${configDigest.slice(7, 27)}…，共 ${layers.length} 层，` +
  `合计 ${fmtMB(layers.reduce((a, l) => a + l.size, 0))}`);

fs.mkdirSync(path.join(WORK, 'layers'), { recursive: true });

console.log('==> 下载 config（校验 sha256）');
const configFile = 'config.json';
ghcrFetch(`blobs/${configDigest}`, { outFile: path.join(WORK, configFile) });
if (sha256File(path.join(WORK, configFile)) !== configDigest.replace('sha256:', '')) {
  fail('config sha256 不匹配，下载不完整');
}

const layerPaths = [];
layers.forEach((l, i) => {
  const file = path.join(WORK, 'layers', `${String(i + 1).padStart(3, '0')}-${l.digest.slice(7, 19)}.tar.gz`);
  if (!fs.existsSync(file) || sha256File(file) !== l.digest.replace('sha256:', '')) {
    console.log(`==> 下载第 ${i + 1}/${layers.length} 层（${fmtMB(l.size)}），带断点重试`);
    ghcrFetch(`blobs/${l.digest}`, { outFile: file, resume: true });
    const got = sha256File(file);
    if (got !== l.digest.replace('sha256:', '')) {
      fs.rmSync(file, { force: true });
      fail(`第 ${i + 1} 层 sha256 不匹配（下载被截断）`);
    }
  } else {
    console.log(`    第 ${i + 1} 层已存在且校验通过（支持中断续跑）`);
  }
  layerPaths.push('layers/' + path.basename(file));
  console.log(`    第 ${i + 1} 层校验通过`);
});

console.log('==> 组装 docker archive');
const dockerManifest = [{
  Config: configFile,
  RepoTags: [`ghcr.io/${REPO}:${TAG}`, `ghcr.io/${REPO}:latest`],
  Layers: layerPaths,
}];
fs.writeFileSync(path.join(WORK, 'manifest.json'), JSON.stringify(dockerManifest, null, 2));

fs.mkdirSync(path.dirname(OUT), { recursive: true });
try { fs.rmSync(OUT, { force: true }); } catch { /* ignore */ }
// 相对路径打包，docker load 要求 manifest.json 里引用的路径与 tar 内一致
// --force-local：Windows 盘符路径（K:\...）里的冒号会被 tar 当成远程主机名
execFileSync('tar', ['--force-local', '-cf', path.resolve(OUT), '-C', WORK,
  'manifest.json', 'config.json', 'layers'], { stdio: 'inherit' });
fs.rmSync(WORK, { recursive: true, force: true });

const size = fs.statSync(OUT).size;
console.log(`\n完成：${OUT}（${fmtMB(size)}）`);
console.log(`NAS 上导入：sudo docker load -i /path/to/${path.basename(OUT)}`);
