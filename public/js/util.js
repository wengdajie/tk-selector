// ---------- DOM ----------
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(4)) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

export const $ = sel => document.querySelector(sel);
export const $$ = sel => [...document.querySelectorAll(sel)];

// ---------- 格式化 ----------
export function fmtDuration(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  if (!s) return '0:00';
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  const p = n => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${p(m)}:${p(ss)}` : `${m}:${p(ss)}`;
}

export function fmtBytes(n) {
  const b = Number(n) || 0;
  if (b < 1024) return `${b} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let i = -1, v = b;
  do { v /= 1024; i++; } while (v >= 1024 && i < u.length - 1);
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${u[i]}`;
}

export function fmtDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const p = n => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function timeAgo(ts) {
  const diff = Date.now() - ts;
  if (diff < 60e3) return '刚刚';
  if (diff < 3600e3) return `${Math.floor(diff / 60e3)} 分钟前`;
  if (diff < 86400e3) return `${Math.floor(diff / 3600e3)} 小时前`;
  if (diff < 7 * 86400e3) return `${Math.floor(diff / 86400e3)} 天前`;
  return fmtDate(ts);
}

export function dayLabel(ymd) {
  if (!ymd) return '';
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const d = new Date(ymd + 'T00:00:00');
  const diff = Math.round((today - d) / 86400e3);
  if (diff === 0) return '今天';
  if (diff === 1) return '昨天';
  const wd = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()];
  return wd;
}

export function ymd(date = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

export const initials = name => String(name || '?').trim().slice(0, 1);

export const ROLE_LABEL = { admin: '管理员', ops: '运营', shooter: '拍摄', viewer: '只读' };
export const roleLabel = role => ROLE_LABEL[role] || role || '成员';

/** 数字滚动（Q 弹缓动） */
export function animateNumber(node, to, { duration = 760, decimals = 0, suffix = '' } = {}) {
  const target = Number(to) || 0;
  const fmt = v => (decimals ? v.toFixed(decimals) : Math.round(v)) + suffix;
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  if (reduce) { node.textContent = fmt(target); return; }
  const start = performance.now();
  const ease = t => 1 - Math.pow(1 - t, 3);
  const tick = now => {
    const p = Math.min(1, (now - start) / duration);
    node.textContent = fmt(target * ease(p));
    if (p < 1) requestAnimationFrame(tick);
    else node.textContent = fmt(target);
  };
  requestAnimationFrame(tick);
}

/** 环比变化 */
export function delta(cur, prev) {
  const c = Number(cur) || 0, p = Number(prev) || 0;
  if (!p) return { dir: c > 0 ? 'up' : 'flat', text: c > 0 ? `新增 ${c}` : '与上周持平' };
  const diff = c - p;
  const pct = Math.round(Math.abs(diff) / p * 100);
  if (!diff) return { dir: 'flat', text: '与上周持平' };
  return { dir: diff > 0 ? 'up' : 'down', text: `${diff > 0 ? '↑' : '↓'} ${pct}%` };
}

/** MM-DD */
export function shortDate(ymdStr) {
  if (!ymdStr) return '';
  const parts = String(ymdStr).split('-');
  return parts.length === 3 ? `${parts[1]}-${parts[2]}` : ymdStr;
}

export const weekdayOf = ymdStr => {
  const d = new Date(String(ymdStr) + 'T00:00:00');
  return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()] || '';
};


export function avatar(name, color, size = 26) {
  return el('span', {
    class: 'avatar',
    style: {
      width: size + 'px', height: size + 'px', background: color || '#25F4EE',
      fontSize: Math.round(size * 0.42) + 'px',
    },
  }, initials(name));
}

export function avatarMini(name, color) {
  return el('span', {
    class: 'dotm',
    style: { background: color || '#25F4EE' },
    title: name,
  }, initials(name));
}

// ---------- toast ----------
let toastBox;
export function toast(msg, type = 'ok', ms = 2600) {
  if (!toastBox) toastBox = document.getElementById('toast');
  const item = el('div', { class: 'toast-item ' + (type === 'err' ? 'err' : 'ok') }, msg);
  toastBox.append(item);
  setTimeout(() => {
    item.style.transition = 'opacity .2s, transform .2s';
    item.style.opacity = '0';
    item.style.transform = 'translateY(8px)';
    setTimeout(() => item.remove(), 220);
  }, ms);
}

// ---------- modal ----------
let modalRoot;
export function openModal({ title, body, footer, wide = false, onClose }) {
  modalRoot = document.getElementById('modal');
  modalRoot.innerHTML = '';
  modalRoot.hidden = false;
  const close = () => closeModal(onClose);
  const card = el('div', { class: 'modal-card' + (wide ? ' wide' : '') },
    el('div', { class: 'modal-head' },
      el('h3', {}, title || ''),
      el('button', { class: 'icon-btn', onclick: close }, '✕'),
    ),
    body,
    footer ? el('div', { class: 'modal-foot' }, footer) : null,
  );
  modalRoot.append(
    el('div', { class: 'modal-mask', onclick: close }),
    card,
  );
  modalRoot._close = close;
  return { close, card, root: modalRoot };
}

export function closeModal(onClose) {
  if (!modalRoot) return;
  modalRoot.hidden = true;
  modalRoot.innerHTML = '';
  onClose?.();
}

export function confirmDialog({ title, message, confirmText = '确认', danger = false }) {
  return new Promise(resolve => {
    const footer = [
      el('button', { class: 'btn btn-ghost', onclick: () => { closeModal(); resolve(false); } }, '取消'),
      el('button', {
        class: 'btn ' + (danger ? 'btn-danger' : 'btn-primary'),
        onclick: () => { closeModal(); resolve(true); },
      }, confirmText),
    ];
    openModal({
      title,
      body: el('div', { class: 'modal-body' }, el('p', { style: { fontSize: '13px', color: 'var(--tx2)', lineHeight: '1.7' } }, message)),
      footer,
      onClose: () => resolve(false),
    });
  });
}

export function emptyState({ icon = '◇', title, message, action }) {
  return el('div', { class: 'empty' },
    el('div', { class: 'ico' }, icon),
    el('h3', {}, title),
    message ? el('p', {}, message) : null,
    action || null,
  );
}

export function skeleton(n = 8) {
  return el('div', { class: 'skel' }, ...Array.from({ length: n }, () => el('div', { class: 'skel-item' })));
}

export function debounce(fn, ms = 260) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
