/**
 * TikTok 式竖滑播放器（全屏 feed）+ 可勾选的原生界面遮罩。
 * 手机端点素材卡片进入；桌面从抽屉「竖滑预览」进。
 *   openFeed(list, startId)  list: 当前视图的视频行数组
 */
import { el, fmtDuration, timeAgo } from './util.js';
import { mediaUrl, api } from './api.js';

const MASK_KEY = 'tk.selector.tiktokMask';
const loadMask = () => localStorage.getItem(MASK_KEY) !== '0';   // 默认开
const saveMask = on => localStorage.setItem(MASK_KEY, on ? '1' : '0');

let F = null;   // { list, idx, root, video, mask, muted, liked }

/* ---------- 小图标（SVG path） ---------- */
const P = {
  heart: 'M12 21s-6.7-4.35-9.33-8.06C.8 10.2 1.96 6.5 5.05 5.6c1.88-.44 3.75.36 4.95 1.9C11.2 5.96 13.07 5.16 14.95 5.6c3.09.9 4.25 4.6 2.38 7.34C18.7 16.65 12 21 12 21z',
  bubble: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
  star: 'M12 2.5l2.9 5.9 6.5.9-4.7 4.6 1.1 6.5-5.8-3-5.8 3 1.1-6.5L2.6 9.3l6.5-.9z',
  share: 'M14 9V5l7 7-7 7v-4.1c-5 0-8.5 1.6-11 5.1 1-6 4-11 11-12z',
  music: 'M9 18V5l12-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zm12-2a3 3 0 1 1-6 0 3 3 0 0 1 6 0z',
};
const SVG_NS = 'http://www.w3.org/2000/svg';
/** el() 走 createElement，画不了 SVG；图标必须用 createElementNS */
const svgIcon = (p, size = 27) => {
  const i = document.createElement('i');
  i.className = 'fic';
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('fill', 'currentColor');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', p);
  svg.append(path);
  i.append(svg);
  return i;
};

/* ---------- 复制（内网 http 下 clipboard API 不可用，走 execCommand 兜底） ---------- */
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* fallthrough */ }
  try {
    const ta = el('textarea', { style: { position: 'fixed', opacity: 0 } }, text);
    document.body.append(ta); ta.select();
    document.execCommand('copy'); ta.remove(); return true;
  } catch { return false; }
}

const toast = msg => {
  const t = el('div', { class: 'feed-toast' }, msg);
  document.body.append(t);
  setTimeout(() => t.remove(), 1600);
};

/* ---------- 打开 ---------- */
export function openFeed(list, startId) {
  if (!list?.length) return;
  const idx = Math.max(0, list.findIndex(v => v.id === startId));
  closeFeed();
  F = { list, idx, mask: loadMask(), muted: false, liked: new Set() };
  buildDom();
  show(idx, true);
}

export function closeFeed() {
  if (!F) return;
  F.root.remove();
  document.removeEventListener('keydown', onKey);
  F = null;
}

export const feedOpen = () => !!F;

/* ---------- DOM ---------- */
function buildDom() {
  const stage = el('div', { class: 'feed-stage' });
  F.video = el('video', {
    class: 'feed-video', playsinline: true, loop: true, preload: 'auto',
    ontimeupdate: onTime, onended: null, onclick: togglePlay,
  });

  /* 顶部：关闭 / 计数 / 声音 / 遮罩勾选 */
  F.counter = el('b', { class: 'feed-count' });
  F.maskChk = el('input', { type: 'checkbox', checked: F.mask, onchange: e => setMask(e.target.checked) });
  const top = el('div', { class: 'feed-top' },
    el('button', { class: 'feed-x', onclick: closeFeed }, '✕'),
    F.counter,
    el('span', { class: 'feed-top-gap' }),
    el('button', { class: 'feed-mute', onclick: toggleMute, title: '声音' }, '🔊'),
    el('label', { class: 'feed-mask-chk', title: '勾选后展示 TikTok 原生界面效果' },
      F.maskChk, el('span', {}, 'TikTok 遮罩')),
  );

  /* 右侧功能列（遮罩内容，TikTok 原生效果） */
  F.rail = el('div', { class: 'feed-rail' });
  F.info = el('div', { class: 'feed-info' });

  F.maskEl = el('div', { class: 'feed-mask' + (F.mask ? '' : ' off'), onclick: e => {
    if (e.target === F.maskEl) togglePlay();   // 露出的遮罩空白区点击=暂停
  } }, F.rail, F.info);

  /* 进度条 */
  F.prog = el('div', { class: 'feed-prog' }, el('i', {}));
  F.ptime = el('span', { class: 'feed-ptime' });

  /* 手势层：滑切 + 点击暂停 */
  const gesture = el('div', { class: 'feed-gesture' });
  let ty = 0, tx = 0, tStart = 0;
  gesture.addEventListener('touchstart', e => {
    ty = e.touches[0].clientY; tx = e.touches[0].clientX; tStart = Date.now();
  }, { passive: true });
  gesture.addEventListener('touchend', e => {
    const dy = ty - e.changedTouches[0].clientY;
    const dx = Math.abs(tx - e.changedTouches[0].clientX);
    if (Math.abs(dy) > 55 && Math.abs(dy) > dx) { dy > 0 ? step(1) : step(-1); return; }
    if (Math.abs(dy) < 12 && Date.now() - tStart < 350 && dx < 12) togglePlay();
  }, { passive: true });
  let wheelAt = 0;
  gesture.addEventListener('wheel', e => {
    e.preventDefault();
    if (Date.now() - wheelAt < 420) return;
    if (Math.abs(e.deltaY) < 24) return;
    wheelAt = Date.now();
    step(e.deltaY > 0 ? 1 : -1);
  }, { passive: false });

  stage.append(F.video, F.maskEl, gesture);
  F.root = el('div', { class: 'feed-root' }, stage, top, F.prog, F.ptime);
  document.body.append(F.root);
  document.addEventListener('keydown', onKey);
}

function onKey(e) {
  if (!F) return;
  if (e.key === 'Escape') closeFeed();
  else if (e.key === 'ArrowDown') step(1);
  else if (e.key === 'ArrowUp') step(-1);
  else if (e.key === ' ') { e.preventDefault(); togglePlay(); }
}

/* ---------- 切换 / 播放 ---------- */
function step(dir) {
  const next = F.idx + dir;
  if (next < 0 || next >= F.list.length) {
    toast(dir > 0 ? '已经到最后一条' : '这是第一条');
    return;
  }
  show(next);
}

function show(idx, first = false) {
  F.idx = idx;
  const v = F.list[idx];
  F.video.src = mediaUrl(`/api/videos/${v.id}/stream`);
  F.video.muted = F.muted;
  F.video.play?.().catch(() => { F.video.muted = true; F.muted = true; F.video.play?.().catch(() => {}); });
  F.counter.textContent = `${idx + 1} / ${F.list.length}`;
  renderMask(v);
  if (!first) toast(dirLabel());   // 切换提示
  else F.video.currentTime = 0;
}
const dirLabel = () => '';

function togglePlay() {
  if (!F) return;
  if (F.video.paused) F.video.play?.().catch(() => {}); else F.video.pause();
}

function toggleMute(e) {
  if (!F) return;
  F.muted = !F.muted;
  F.video.muted = F.muted;
  e.currentTarget.textContent = F.muted ? '🔇' : '🔊';
}

function onTime() {
  const p = F.prog.firstChild;
  if (p && F.video.duration) p.style.width = (F.video.currentTime / F.video.duration * 100) + '%';
  if (F.ptime) F.ptime.textContent = `${fmtDuration(F.video.currentTime)} / ${fmtDuration(F.video.duration || 0)}`;
}

/* ---------- TikTok 遮罩 ---------- */
function setMask(on) {
  F.mask = on; saveMask(on);
  F.maskEl.classList.toggle('off', !on);
  const v = F.list[F.idx];
  if (v) renderMask(v);
}

function renderMask(v) {
  const likeCount = v.comment_count ?? v.comments ?? 0;
  const liked = F.liked.has(v.id);

  /* 头像 + 关注装饰 */
  const avatar = el('div', { class: 'feed-avatar' },
    el('span', { class: 'ava', style: { background: v.uploader_color || '#FE2C55' } },
      String(v.uploader_name || '投').trim().slice(0, 1)),
    el('button', { class: 'feed-follow', title: '关注（演示）', onclick: e => {
      e.stopPropagation();
      e.currentTarget.classList.toggle('did');
      e.currentTarget.textContent = e.currentTarget.classList.contains('did') ? '✓' : '+';
    } }, '+'),
  );

  const railBtn = (icon, num, opts = {}) => el('button', {
    class: 'feed-btn' + (opts.on ? ' on' : ''),
    title: opts.title || '',
    onclick: e => { e.stopPropagation(); opts.onClick?.(e); },
  }, icon, num != null ? el('b', {}, String(num)) : null);

  F.rail.replaceChildren(
    avatar,
    railBtn(svgIcon(P.heart), likeCount + (liked ? 1 : 0),
      { on: liked, title: '点赞（演示）', onClick: () => {
        liked ? F.liked.delete(v.id) : F.liked.add(v.id);
        popHeart();
        renderMask(v);
      } }),
    railBtn(svgIcon(P.bubble), likeCount, { title: '评论', onClick: () => openCmt(v) }),
    railBtn(svgIcon(P.star), null,
      { on: v.stage === 'final', title: v.stage === 'final' ? '已入选，点击取消' : '标记为入选', onClick: async () => {
        try {
          const to = v.stage === 'final' ? 'new' : 'final';
          await api('/videos/' + v.id, { method: 'PATCH', body: { stage: to } });
          v.stage = to;
          renderMask(v);
          toast(to === 'final' ? '已标记入选 ⭐' : '已取消入选');
        } catch (e) { toast(e.message, 'err'); }
      } }),
    railBtn(svgIcon(P.share), null, { title: '复制分享文案', onClick: async () => {
      const link = location.origin + mediaUrl(`/api/videos/${v.id}/stream`);
      const text = `《${v.title || v.orig_name || '未命名'}》 ${link}`;
      toast(await copyText(text) ? '分享文案已复制' : '复制失败');
    } }),
  );

  /* 底部：@用户名 / 标题 / 配乐行 */
  F.info.replaceChildren(
    el('div', { class: 'feed-author' }, '@' + (v.uploader_name || '目录投递')),
    el('div', { class: 'feed-title' }, v.title || v.orig_name || '未命名素材'),
    el('div', { class: 'feed-music' },
      svgIcon(P.music, 12),
      el('span', { class: 'feed-music-txt' }, `原声 - ${v.uploader_name || v.title || v.orig_name || '拍摄现场'}`)),
    // 注意：replaceChildren(null) 会把 null 渲染成文字，必须用数组展开过滤
    ...(v.stage === 'final' ? [el('span', { class: 'feed-final-pill' }, '⭐ 已入选')] : []),
  );
}

function popHeart() {
  if (!F) return;
  const h = el('div', { class: 'feed-heart-pop' }, svgIcon(P.heart, 96));
  F.root.append(h);
  setTimeout(() => h.remove(), 720);
}

/* ---------- 评论浮层 ---------- */
async function openCmt(v) {
  if (F.cmt && F.cmtEl?.isConnected) { F.cmtEl.remove(); return; }
  const list = el('div', { class: 'feed-cmt-list' });
  const input = el('textarea', { class: 'feed-cmt-in', placeholder: '说点什么…', rows: 1 });
  const send = el('button', { class: 'feed-cmt-send', onclick: async () => {
    const body = input.value.trim();
    if (!body) return;
    try {
      await api(`/videos/${v.id}/comments`, { method: 'POST', body: { body } });
      input.value = '';
      v.comment_count = (v.comment_count ?? 0) + 1;
      renderMask(v); openCmtRefresh(v);
    } catch (e) { toast(e.message, 'err'); }
  } }, '发送');

  F.cmtEl = el('div', { class: 'feed-cmt' },
    el('div', { class: 'feed-cmt-head' },
      el('b', {}, `评论 ${v.comment_count ?? 0}`),
      el('button', { class: 'feed-cmt-x', onclick: () => F.cmtEl?.remove() }, '✕')),
    list,
    el('div', { class: 'feed-cmt-form' }, input, send),
  );
  F.root.append(F.cmtEl);
  openCmtRefresh(v);
}

async function openCmtRefresh(v) {
  const box = F?.cmtEl?.querySelector('.feed-cmt-list');
  if (!box) return;
  box.replaceChildren(el('div', { class: 'feed-cmt-load' }, '加载中…'));
  try {
    const d = await api('/videos/' + v.id);
    box.replaceChildren(...(d.comments || []).map(c => el('div', { class: 'feed-cmt-row' },
      el('span', { class: 'dot', style: { background: c.user_color || '#5A6376' } }),
      el('div', {},
        el('b', {}, c.user_name || '成员'),
        el('span', { class: 't' }, timeAgo(c.created_at)),
        el('p', {}, String(c.body || ''))))));
    if (!(d.comments || []).length) box.replaceChildren(el('div', { class: 'feed-cmt-load' }, '还没有评论'));
  } catch (e) {
    box.replaceChildren(el('div', { class: 'feed-cmt-load' }, '加载失败：' + e.message));
  }
}
