import { api, getUser, setUser, storedUid, mediaUrl, uploadFiles, setUnauthorizedHandler } from './api.js';
import {
  el, $, esc, toast, openModal, closeModal, confirmDialog, fmtDuration, fmtBytes,
  fmtDate, timeAgo, dayLabel, ymd, avatar, avatarMini, emptyState, skeleton, debounce, initials,
  roleLabel, animateNumber, delta, shortDate, weekdayOf,
} from './util.js';
import { videoCard, videoRow, requestCard, downloadBatch, statCard, icon, starIcon, QC_LABELS, qcFlags } from './render.js';
import { openFeed } from './feed.js';

/** 手机端（触屏或窄屏）：点素材卡片直接进 TikTok 式竖滑播放器 */
const isMobileLike = () => matchMedia('(pointer: coarse)').matches || innerWidth < 768;

/* ========================= 主题 ========================= */
const THEME_KEY = 'tk.theme';

function currentTheme() {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

function applyTheme(theme, persist = true) {
  document.documentElement.dataset.theme = theme;
  if (persist) localStorage.setItem(THEME_KEY, theme);
  for (const id of ['themeBtn', 'authTheme']) {
    const btn = document.getElementById(id);
    if (!btn) continue;
    btn.innerHTML = '';
    btn.append(icon(theme === 'light' ? 'sun' : 'moon', 15));
    btn.title = theme === 'light' ? '切换到深色' : '切换到亮色';
  }
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme === 'light' ? '#F4F6FB' : '#07080D');
}

function initTheme() {
  const urlTheme = new URLSearchParams(location.search).get('theme');
  if (urlTheme === 'light' || urlTheme === 'dark') {
    applyTheme(urlTheme);
    return;
  }
  const saved = localStorage.getItem(THEME_KEY);
  const sys = window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  applyTheme(saved || sys, false);
}

function toggleTheme() {
  applyTheme(currentTheme() === 'light' ? 'dark' : 'light');
}

const S = {
  user: null,
  view: 'dashboard',
  space: 'daily',
  date: '',
  from: '',
  to: '',
  q: '',
  filter: 'all',        // all | new | notDownloaded | picked | hasComments | starred | star4 | star5
  stage: '',
  pipeline: null,
  tag: '',
  sort: 'newest',
  layout: 'grid',
  selected: new Set(),
  items: [],
  dates: [],
  tags: [],
  total: 0,
  offset: 0,
  loading: false,
  stats: null,
  dash: null,
  requests: [],
  reqCounts: {},
  reqFilter: 'active',
  members: [],
  scripts: [],
  scriptCounts: {},
  scriptFilter: 'all',
  drawerScripts: [],
  ai: null,
};

const VIEW_META = {
  dashboard: { title: '工作仪表盘', sub: '团队今天干了什么，数据说话' },
  daily: { title: '每日选片', sub: '拍摄投递的素材，挑一条开干' },
  library: { title: '素材库', sub: '沉淀下来的通用素材，随时取用' },
  requests: { title: '视频需求', sub: '运营发需求，拍摄认领交付' },
  scripts: { title: '脚本库', sub: 'AI 把成片拆成钩子、分镜和口播稿' },
  records: { title: '下载记录', sub: '谁在什么时候拿走了哪条素材' },
  members: { title: '成员', sub: '团队账号与分工' },
  settings: { title: '系统设置', sub: '管理员统一管理 AI 拆解等配置' },
};

/* 选片流水线：与 server/lib/scoring.js 保持一致 */
const STAGES = [
  { key: 'new', label: '新入库' },
  { key: 'screened', label: '初筛' },
  { key: 'shortlisted', label: '复选' },
  { key: 'final', label: '定稿' },
  { key: 'rejected', label: '淘汰' },
];

const DIMS = [
  { key: 'hook', label: '前 3 秒钩子', hint: '开场能不能抓住人' },
  { key: 'visual', label: '画面质感', hint: '构图、光线、清晰度' },
  { key: 'point', label: '卖点清晰', hint: '产品卖点是否一眼看懂' },
  { key: 'pace', label: '节奏', hint: '信息密度、是否拖沓' },
  { key: 'compliance', label: '合规口播', hint: '无极限词、无误导表述' },
];

const stageLabel = k => STAGES.find(s => s.key === k)?.label || k;
const parseScores = s => {
  if (!s) return {};
  if (typeof s === 'object') return s;
  try { return JSON.parse(s); } catch { return {}; }
};

/* ========================= 启动 ========================= */
init();

async function init() {
  initTheme();
  setUnauthorizedHandler(() => {
    setUser(null);
    showAuth();
  });
  bindAuth();
  bindGlobal();

  const params = new URLSearchParams(location.search);
  const layoutParam = params.get('layout');
  if (layoutParam === 'list' || layoutParam === 'grid') S.layout = layoutParam;

  const uid = storedUid();
  if (uid) {
    try {
      const r = await api('/me', { headers: { 'x-user-id': uid } });
      const view = params.get('view');
      enterApp(r.user, VIEW_META[view] ? view : 'dashboard');
      const openId = params.get('open');
      if (openId) setTimeout(() => openVideo(openId), 400);
      const scriptId = params.get('script');
      if (scriptId) setTimeout(() => openScript(scriptId), 400);
      if (params.get('panel') === 'upload') setTimeout(() => openUploader(), 500);
      return;
    } catch { /* 登录态失效，走登录页 */ }
  }
  showAuth();
}

function bindAuth() {
  const tabs = document.getElementById('authTabs');
  const ind = tabs.querySelector('.tab-ind');
  const loginForm = document.getElementById('loginForm');
  const registerForm = document.getElementById('registerForm');

  // 给所有密码框加「显示 / 隐藏」按钮
  document.querySelectorAll('.auth-form input[type="password"]').forEach(inp => {
    if (inp.parentElement.classList.contains('pw-wrap')) return;
    const btn = el('button', { type: 'button', class: 'pw-eye' }, '显示');
    btn.addEventListener('click', () => {
      const show = inp.type === 'password';
      inp.type = show ? 'text' : 'password';
      btn.textContent = show ? '隐藏' : '显示';
    });
    const wrap = el('div', { class: 'pw-wrap' });
    inp.replaceWith(wrap);
    wrap.append(inp, btn);
  });

  tabs.addEventListener('click', e => {
    const btn = e.target.closest('.tab');
    if (!btn) return;
    const isReg = btn.dataset.tab === 'register';
    tabs.querySelectorAll('.tab').forEach(t => t.classList.toggle('on', t === btn));
    ind.classList.toggle('right', isReg);
    loginForm.hidden = isReg;
    registerForm.hidden = !isReg;
    setTimeout(() => (isReg ? document.getElementById('regName') : document.getElementById('loginName'))?.focus(), 60);
  });

  document.getElementById('rolePick').addEventListener('click', e => {
    const btn = e.target.closest('.role');
    if (!btn) return;
    document.querySelectorAll('#rolePick .role').forEach(b => b.classList.toggle('on', b === btn));
  });

  loginForm.addEventListener('submit', async e => {
    e.preventDefault();
    const err = document.getElementById('loginErr');
    const btn = document.getElementById('loginBtn');
    const name = document.getElementById('loginName').value.trim();
    const password = document.getElementById('loginPass').value;
    err.hidden = true;
    btn.disabled = true;
    btn.textContent = '登录中…';
    try {
      const r = await api('/login', { method: 'POST', body: { name, password } });
      enterApp(r.user, 'dashboard');
      toast(`欢迎回来，${r.user.name}`);
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
      btn.disabled = false;
      btn.textContent = '进入工作台';
    }
  });

  registerForm.addEventListener('submit', async e => {
    e.preventDefault();
    const err = document.getElementById('regErr');
    const btn = document.getElementById('regBtn');
    const name = document.getElementById('regName').value.trim();
    const password = document.getElementById('regPass').value;
    const password2 = document.getElementById('regPass2').value;
    const role = document.querySelector('#rolePick .role.on')?.dataset.role || 'ops';
    err.hidden = true;
    if (password !== password2) {
      err.textContent = '两次输入的密码不一致';
      err.hidden = false;
      return;
    }
    btn.disabled = true;
    btn.textContent = '创建中…';
    try {
      const r = await api('/users', { method: 'POST', body: { name, role, password } });
      enterApp(r.user, 'dashboard');
      toast('账号已创建，欢迎加入');
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
      btn.disabled = false;
      btn.textContent = '创建账号并进入';
    }
  });

  document.getElementById('authTheme').addEventListener('click', toggleTheme);
}

function bindGlobal() {
  document.getElementById('themeBtn').addEventListener('click', toggleTheme);
  document.getElementById('uploadBtn').addEventListener('click', openUploader);
  document.getElementById('meBtn').addEventListener('click', openMeMenu);
  document.getElementById('scanBtn').addEventListener('click', runScan);

  const onNav = e => {
    const btn = e.target.closest('button[data-view]');
    if (btn) switchView(btn.dataset.view);
  };
  document.getElementById('nav').addEventListener('click', onNav);
  document.getElementById('navMain').addEventListener('click', onNav);
  document.getElementById('navAdmin').addEventListener('click', onNav);
  document.getElementById('mobileNav').addEventListener('click', onNav);

  document.getElementById('searchInput').addEventListener('input', debounce(e => {
    S.q = e.target.value.trim();
    reload();
  }, 300));
  document.getElementById('bulkbar').addEventListener('click', onBulkAction);
}

/* ========================= 身份 ========================= */
function showAuth() {
  document.getElementById('app').hidden = true;
  document.getElementById('auth').hidden = false;
  document.getElementById('drawer').hidden = true;
  document.getElementById('bulkbar').hidden = true;
  setTimeout(() => document.getElementById('loginName')?.focus(), 120);
}

function enterApp(user, view = 'dashboard') {
  setUser(user);
  S.user = user;
  if (!S.date) S.date = ymd();
  applyRoleUi();
  document.getElementById('auth').hidden = true;
  document.getElementById('app').hidden = false;
  const av = $('#meAvatar');
  av.textContent = initials(user.name);
  av.style.background = user.color;
  $('#meName').textContent = user.name;
  S.view = '';
  switchView(view === 'settings' && user.role !== 'admin' ? 'dashboard' : view, true);
}

/** 管理员专属入口（系统设置 / 下载记录）按角色显隐 */
function applyRoleUi() {
  const isAdmin = S.user?.role === 'admin';
  const group = document.getElementById('adminNav');
  if (group) group.hidden = !isAdmin;
  // 下载记录：非管理员隐藏入口（侧边栏 + 底部移动导航）
  for (const recBtn of document.querySelectorAll('button[data-view="records"]')) {
    if (recBtn.closest('#mobileNav')) recBtn.hidden = !isAdmin;
    else recBtn.style.display = isAdmin ? '' : 'none';
  }
  const m = document.querySelector('#mobileNav [data-view="settings"]');
  if (m) m.hidden = !isAdmin;
  const mnav = document.getElementById('mobileNav');
  if (mnav) {
    const cols = mnav.querySelectorAll('button:not([hidden])').length;
    mnav.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
  }
}

function openMeMenu() {
  const foot = [
    el('button', { class: 'btn btn-ghost', onclick: () => { closeModal(); openPasswordModal(); } }, '修改密码'),
    el('button', { class: 'btn btn-danger', onclick: () => { closeModal(); logout(); } }, '退出登录'),
  ];

  openModal({
    title: '我的账号',
    body: el('div', { class: 'modal-body' },
      el('div', { style: { display: 'flex', alignItems: 'center', gap: '14px' } },
        avatar(S.user.name, S.user.color, 48),
        el('div', {},
          el('div', { style: { fontSize: '15px', fontWeight: 700 } }, S.user.name),
          el('div', { style: { fontSize: '11.5px', color: 'var(--tx3)', marginTop: '2px' } },
            `${roleLabel(S.user.role)} · 加入于 ${new Date(S.user.created_at).toLocaleDateString('zh-CN')}`),
        ),
      ),
      el('div', { class: 'mine-grid', style: { marginTop: '6px' } },
        ...Object.entries({
          评论: S.dash?.mine?.comments ?? 0,
          下载: S.dash?.mine?.downloads ?? 0,
          评分: S.dash?.mine?.ratings ?? 0,
          上传: S.dash?.mine?.uploads ?? 0,
        }).map(([k, v]) => el('div', { class: 'mine-item' }, el('b', {}, String(v)), el('span', {}, k))),
      ),
      el('p', { style: { fontSize: '11px', color: 'var(--tx3)', lineHeight: 1.7 } },
        '身份用于标记谁上传、谁下载、谁评论。退出后需要重新输入密码。'),
    ),
    footer: foot,
  });
}

function openPasswordModal() {
  const oldPass = el('input', { type: 'password', placeholder: '当前密码', autocomplete: 'current-password' });
  const newPass = el('input', { type: 'password', placeholder: '至少 6 位', autocomplete: 'new-password' });
  const newPass2 = el('input', { type: 'password', placeholder: '再输入一次', autocomplete: 'new-password' });

  openModal({
    title: '修改密码',
    body: el('div', { class: 'modal-body' },
      el('div', { class: 'field' }, el('label', {}, '当前密码'), oldPass),
      el('div', { class: 'field' }, el('label', {}, '新密码'), newPass),
      el('div', { class: 'field' }, el('label', {}, '确认新密码'), newPass2),
    ),
    footer: [
      el('button', { class: 'btn btn-ghost', onclick: () => closeModal() }, '取消'),
      el('button', {
        class: 'btn btn-primary',
        onclick: async () => {
          if (newPass.value !== newPass2.value) return toast('两次输入的新密码不一致', 'err');
          try {
            await api(`/users/${S.user.id}/password`, {
              method: 'POST',
              body: { oldPassword: oldPass.value, newPassword: newPass.value },
            });
            closeModal();
            toast('密码已更新');
          } catch (e) { toast(e.message, 'err'); }
        },
      }, '保存'),
    ],
  });
  setTimeout(() => oldPass.focus(), 60);
}

function logout() {
  setUser(null);
  S.user = null;
  S.dash = null;
  showAuth();
}

/* ========================= 视图切换 ========================= */
function switchView(view, force = false) {
  if (S.view === view && !force) return;
  if (view === 'settings' && S.user?.role !== 'admin') {
    toast('系统设置只有管理员能看', 'err');
    view = 'dashboard';
  }
  if (view === 'records' && S.user?.role !== 'admin') {
    toast('下载记录只有管理员能看', 'err');
    view = 'dashboard';
  }
  S.view = view;
  S.selected.clear();
  if (view === 'library') S.space = 'library';
  else if (view === 'daily') S.space = 'daily';
  updateBulkBar();
  const meta = VIEW_META[view] || VIEW_META.dashboard;
  $('#viewTitle').textContent = meta.title;
  $('#viewSub').textContent = meta.sub;
  document.querySelectorAll('#nav button, #navMain button, #mobileNav button')
    .forEach(b => b.classList.toggle('on', b.dataset.view === view));
  const showSearch = ['daily', 'library', 'requests', 'scripts'].includes(view);
  const searchBox = document.querySelector('.search');
  if (searchBox) searchBox.style.display = showSearch ? '' : 'none';
  $('#uploadBtn').style.display = ['dashboard', 'records', 'members', 'scripts', 'settings'].includes(view) ? 'none' : '';
  S.offset = 0;
  renderToolbar();
  reload();
  refreshStats();
}

/* ========================= 工具栏 ========================= */
function renderToolbar() {
  const bar = $('#toolbar');
  bar.innerHTML = '';
  if (S.view === 'daily' || S.view === 'library') {
    if (S.view === 'daily') bar.append(renderDateBar());
    bar.append(renderStageBar());
    bar.append(renderFilterBar());
  }
  if (S.view === 'requests') bar.append(renderReqFilter());
  if (S.view === 'scripts') bar.append(renderScriptBar());
}

function renderDateBar() {
  const wrap = el('div', { class: 'datebar' });
  const allCount = S.dates.reduce((a, d) => a + d.count, 0);
  const ranged = !!(S.from || S.to);

  wrap.append(el('button', {
    class: 'datechip' + (S.date === '' && !ranged ? ' on' : ''),
    onclick: () => { S.date = ''; S.from = ''; S.to = ''; renderToolbar(); reload(); },
  },
    el('b', {}, '全部'),
    el('span', {}, `${allCount} 条`),
  ));

  wrap.append(el('button', {
    class: 'datechip' + (ranged ? ' range' : ''),
    onclick: openRangePicker,
  },
    el('b', {}, ranged ? '日期范围' : '选范围'),
    el('span', {}, ranged
      ? `${(S.from || '…').slice(5)} ~ ${(S.to || '…').slice(5)}`
      : '按区间筛选'),
  ));

  for (const d of S.dates) {
    const chip = el('button', {
      class: 'datechip' + (S.date === d.date && !ranged ? ' on' : ''),
      onclick: () => { S.date = d.date; S.from = ''; S.to = ''; renderToolbar(); reload(); },
    },
      el('b', {}, dayLabel(d.date)),
      el('span', {}, `${d.date.slice(5)} · ${d.count} 条`),
    );
    if (d.fresh > 0) {
      chip.style.position = 'relative';
      chip.append(el('i', { class: 'badge-new' }));
    }
    wrap.append(chip);
  }
  if (!S.dates.length) {
    wrap.append(el('span', { style: { fontSize: '11px', color: 'var(--tx3)', padding: '8px 4px' } }, '暂无收录日期'));
  }
  return wrap;
}

function openRangePicker() {
  const from = el('input', { type: 'date', value: S.from || '' });
  const to = el('input', { type: 'date', value: S.to || '' });
  const today = new Date();
  const quick = el('div', { class: 'range-quick' });
  const addQuick = (label, f, t) => quick.append(el('button', {
    class: (S.from === f && S.to === t) ? 'on' : '',
    onclick: () => { from.value = f; to.value = t; },
  }, label));

  addQuick('今天', ymd(today), ymd(today));
  addQuick('近 7 天', ymd(new Date(Date.now() - 6 * 864e5)), ymd(today));
  addQuick('近 30 天', ymd(new Date(Date.now() - 29 * 864e5)), ymd(today));
  addQuick('本月', ymd(new Date(today.getFullYear(), today.getMonth(), 1)), ymd(today));

  const apply = (f, t) => {
    if (f && t && f > t) { toast('开始日期不能晚于结束日期', 'err'); return; }
    S.from = f; S.to = t;
    if (f || t) S.date = '';
    closeModal();
    renderToolbar();
    reload();
  };

  openModal({
    title: '按日期范围筛选',
    body: el('div', { class: 'modal-body' },
      quick,
      el('div', { class: 'field-row' },
        el('div', { class: 'field' }, el('label', {}, '开始日期'), from),
        el('div', { class: 'field' }, el('label', {}, '结束日期'), to),
      ),
      el('p', { style: { fontSize: '11px', color: 'var(--tx3)', lineHeight: 1.7 } },
        '按素材的拍摄日期筛选，只看一端也可以（留空表示不限）。'),
    ),
    footer: [
      el('button', { class: 'btn btn-ghost', onclick: () => apply('', '') }, '清除范围'),
      el('button', { class: 'btn btn-primary', onclick: () => apply(from.value, to.value) }, '应用'),
    ],
  });
}

const FILTERS = [
  ['all', '全部'],
  ['new', '未处理'],
  ['notDownloaded', '未下载'],
  ['picked', '已选'],
  ['starred', '已标星'],
  ['star4', '4星+'],
  ['qcBad', '体检异常'],
  ['hasComments', '有评论'],
];

function renderFilterBar() {
  const bar = el('div', { class: 'filterbar' });

  const seg = el('div', { class: 'seg' });
  for (const [k, label] of FILTERS) {
    seg.append(el('button', {
      class: S.filter === k ? 'on' : '',
      onclick: () => { S.filter = k; renderToolbar(); reload(); },
    }, label));
  }
  bar.append(seg);

  const tags = el('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } });
  if (S.tag) {
    tags.append(el('button', { class: 'tchip on', onclick: () => { S.tag = ''; renderToolbar(); reload(); } }, `${S.tag} ✕`));
  }
  for (const t of S.tags.filter(t => t.name !== S.tag).slice(0, 6)) {
    tags.append(el('button', { class: 'tchip', onclick: () => { S.tag = t.name; renderToolbar(); reload(); } },
      `${t.name}`, el('span', { style: { opacity: .5, marginLeft: '4px' } }, t.count)));
  }
  bar.append(tags);

  bar.append(el('div', { class: 'spacer' }));

  const sortSel = el('select', {
    class: 'sortsel',
    onchange: e => { S.sort = e.target.value; reload(); },
  },
    el('option', { value: 'newest' }, '最新入库'),
    el('option', { value: 'shoot' }, '拍摄日期'),
    el('option', { value: 'rating' }, '评分最高'),
    el('option', { value: 'duration' }, '时长最长'),
  );
  sortSel.value = S.sort;
  bar.append(sortSel);

  const layoutBtn = el('button', {
    class: 'btn btn-ghost sm',
    title: '切换视图',
    onclick: () => { S.layout = S.layout === 'grid' ? 'list' : 'grid'; renderToolbar(); renderList(); },
  }, S.layout === 'grid' ? '▤ 列表' : '▦ 卡片');
  bar.append(layoutBtn);

  bar.append(el('button', {
    class: 'btn btn-ghost sm',
    title: '按当前筛选导出 CSV 清单（投放 / 剪辑交接用）',
    onclick: exportCurrent,
  }, '↓ 导出清单'));

  return bar;
}

/** 按当前筛选条件导出 CSV */
function exportCurrent() {
  const p = new URLSearchParams({ space: S.space, uid: S.user.id });
  if (S.from) p.set('from', S.from);
  if (S.to) p.set('to', S.to);
  if (!S.from && !S.to && S.date) p.set('date', S.date);
  if (S.q) p.set('q', S.q);
  if (S.tag) p.set('tag', S.tag);
  if (S.filter === 'qcBad') p.set('qc', 'bad');
  if (S.filter === 'starred') p.set('starred', '1');
  if (S.filter === 'star4') p.set('minRating', '4');
  const a = document.createElement('a');
  a.href = '/api/export.csv?' + p;
  a.rel = 'noopener';
  document.body.append(a);
  a.click();
  a.remove();
  toast('正在导出当前筛选结果');
}

const REQ_FILTERS = [['active', '进行中'], ['open', '待认领'], ['done', '已完成'], ['all', '全部']];

function renderReqFilter() {
  const bar = el('div', { class: 'filterbar' });
  const seg = el('div', { class: 'seg' });
  for (const [k, label] of REQ_FILTERS) {
    seg.append(el('button', {
      class: S.reqFilter === k ? 'on' : '',
      onclick: () => { S.reqFilter = k; renderToolbar(); loadRequests(); },
    }, label));
  }
  bar.append(seg);
  bar.append(el('div', { class: 'spacer' }));
  bar.append(el('button', { class: 'btn btn-primary', onclick: openRequestModal }, '＋ 发布视频需求'));
  return bar;
}

function renderStageBar() {
  const wrap = el('div', { class: 'stagebar' });
  wrap.append(el('span', { class: 'mini-lbl', style: { alignSelf: 'center', marginRight: '2px' } }, '阶段'));
  const counts = new Map((S.pipeline?.stages || []).map(s => [s.key, s.count]));
  const total = S.pipeline?.total ?? 0;

  wrap.append(el('button', {
    class: 'stagechip' + (S.stage === '' ? ' on' : ''),
    onclick: () => { S.stage = ''; renderToolbar(); reload(); },
  },
    el('b', {}, '全部'),
    el('span', {}, `${total} 条`),
  ));

  for (const s of STAGES) {
    const n = counts.get(s.key) || 0;
    wrap.append(el('button', {
      class: `stagechip st-${s.key}` + (S.stage === s.key ? ' on' : ''),
      onclick: () => {
        S.stage = S.stage === s.key ? '' : s.key;
        renderToolbar();
        reload();
      },
    },
      el('b', {}, s.label),
      el('span', {}, `${n} 条`),
    ));
  }
  return wrap;
}

/* ========================= 数据加载 ========================= */
async function reload() {
  if (S.view === 'dashboard') await loadDashboard();
  else if (S.view === 'daily' || S.view === 'library') await loadVideos();
  else if (S.view === 'requests') await loadRequests();
  else if (S.view === 'scripts') await loadScripts();
  else if (S.view === 'records') await loadRecords();
  else if (S.view === 'members') await loadMembers();
  else if (S.view === 'settings') await loadSettings();
}

/* ========================= 仪表盘 ========================= */
async function loadDashboard() {
  $('#view').replaceChildren(skeleton(6));
  try {
    const [d, pipe] = await Promise.all([
      api('/dashboard?days=14'),
      api('/pipeline').catch(() => null),
    ]);
    S.dash = d;
    if (pipe) S.pipeline = pipe;
    if (S.view === 'dashboard') renderDashboard(d);
  } catch (e) {
    $('#view').replaceChildren(emptyState({ icon: '!', title: '仪表盘加载失败', message: e.message }));
  }
}

function kpiCard({ cls = '', ico, label, value, decimals = 0, unit = '', deltaInfo = null, foot = '' }) {
  const num = el('span', {}, '0');
  const card = el('article', { class: `kpi ${cls}` },
    el('div', { class: 'kpi-top' },
      el('span', { class: 'kpi-ico' }, icon(ico, 14)),
      el('span', { class: 'kpi-lbl' }, label),
    ),
    el('div', { class: 'kpi-val' }, num, unit ? el('span', { class: 'kpi-unit' }, unit) : null),
    (deltaInfo || foot)
      ? el('div', { class: 'kpi-foot' },
          deltaInfo ? el('span', { class: `kpi-delta ${deltaInfo.dir}` }, deltaInfo.text) : null,
          foot ? el('span', {}, foot) : null)
      : null,
  );
  animateNumber(num, value, { decimals });
  return card;
}

function panel(title, sub, body, extra = null) {
  return el('section', { class: 'panel-card' },
    el('div', { class: 'panel-head' },
      el('h3', {}, title),
      sub ? el('span', { class: 'sub' }, sub) : null,
      extra,
    ),
    body,
  );
}

/** 选片流水线漏斗 */
function pipelinePanel() {
  const p = S.pipeline;
  if (!p) return panel('选片流水线', '', emptyState({ icon: '◇', title: '暂无数据', message: '素材入库后会自动进入流水线' }));
  const scale = Math.max(1, p.total);
  const countOf = k => (p.stages || []).find(s => s.key === k)?.count || 0;
  const reviewed = Math.max(0, p.total - countOf('new'));
  const finals = countOf('final');
  const body = el('div', {},
    el('div', { class: 'qc-head' },
      el('div', { class: 'qc-score ' + (p.passRate >= 50 ? 'good' : p.passRate >= 25 ? 'mid' : 'bad') }, String(p.passRate)),
      el('div', { style: { flex: 1, minWidth: 0 } },
        el('div', { class: 'qc-title' }, `通过率 ${p.passRate}%`),
        el('div', { class: 'qc-sub' }, `已评审 ${reviewed} 条 · 定稿 ${finals} 条 · 共 ${p.total} 条`),
      ),
      el('button', { class: 'btn btn-ghost sm', onclick: () => switchView('daily') }, '去选片 →'),
    ),
    el('div', { class: 'dist' },
      ...p.stages.map(s => el('div', { class: 'dist-row' },
        el('span', { style: { fontSize: '11px' } }, s.label),
        el('div', { class: 'dist-bar' },
          el('i', {
            style: {
              width: Math.max(2, Math.round(s.count / scale * 100)) + '%',
              ...(s.key === 'rejected' ? { background: 'var(--danger)' } : {}),
            },
          })),
        el('span', { class: 'dist-num' }, String(s.count)),
      )),
    ),
  );
  return panel('选片流水线', `已评分 ${p.scored} 条`, body);
}

/** 各维度均分 */
function dimsPanel() {
  const p = S.pipeline;
  const has = p && p.dims && p.dims.some(d => d.avg != null);
  const body = has
    ? el('div', { class: 'dist dims' },
        ...p.dims.map(d => el('div', { class: 'dist-row' },
          el('span', { style: { fontSize: '11px' }, title: d.hint }, d.label),
          el('div', { class: 'dist-bar' },
            el('i', {
              style: {
                width: Math.max(2, Math.round((d.avg || 0) / 10 * 100)) + '%',
                background: 'linear-gradient(90deg, var(--brand), var(--brand-2))',
              },
            })),
          el('span', { class: 'dist-num' }, d.avg == null ? '—' : String(d.avg)),
        )),
      )
    : emptyState({ icon: '★', title: '还没有维度评分', message: '打开素材详情，拖动 5 个滑块打分，这里会显示各维度均分' });
  return panel('内容评分维度', '0-10 分，看清团队短板', body);
}

function renderDashboard(d) {
  const k = d.kpi;
  const view = $('#view');
  view.innerHTML = '';
  const root = el('div', { class: 'dash' });

  // ---- 问候 ----
  const hour = new Date().getHours();
  const greet = hour < 6 ? '凌晨好' : hour < 11 ? '早上好' : hour < 14 ? '中午好' : hour < 18 ? '下午好' : '晚上好';
  root.append(el('section', { class: 'greeting' },
    el('div', {
      class: 'avatar-lg',
      style: { background: `linear-gradient(140deg, ${S.user.color}, var(--brand-2))` },
    }, initials(S.user.name)),
    el('div', { class: 'greeting-txt' },
      el('h2', {}, `${greet}，${S.user.name}`),
      el('p', {}, `${d.today} ${weekdayOf(d.today)} · 今日新增素材 ${k.videosToday} 条、评论 ${k.comments.today} 条、下载 ${k.downloads.today} 次`),
    ),
    el('div', { class: 'greeting-side' },
      el('div', {}, el('b', {}, String(k.requests.open + k.requests.claimed)), el('span', {}, '待处理需求')),
      el('div', {}, el('b', {}, String(k.activeMembers)), el('span', {}, '近 7 天活跃')),
      el('div', {}, el('b', {}, String(k.members)), el('span', {}, '团队成员')),
    ),
  ));

  // ---- KPI ----
  root.append(el('div', { class: 'kpi-grid' },
    kpiCard({ ico: 'video', label: '今日新增素材', value: k.videosToday, unit: '条', foot: `总计 ${k.videosTotal} 条` }),
    kpiCard({ cls: 'gd', ico: 'star', label: '平均评分', value: k.ratings.avg, decimals: 1, unit: '/ 5', foot: `${k.ratings.rated} 条已评 · 覆盖 ${k.ratings.coverage}%` }),
    kpiCard({ cls: 'pk', ico: 'comment', label: '评论总数', value: k.comments.total, unit: '条', deltaInfo: delta(k.comments.week, k.comments.prevWeek), foot: '较上周' }),
    kpiCard({ cls: 'cy', ico: 'download', label: '下载次数', value: k.downloads.total, unit: '次', deltaInfo: delta(k.downloads.week, k.downloads.prevWeek), foot: '较上周' }),
    kpiCard({ cls: 'gn', ico: 'check', label: '已完成需求', value: k.requests.done, unit: '个', deltaInfo: delta(k.requests.doneWeek, k.requests.donePrevWeek), foot: `共 ${k.requests.total} 个` }),
    kpiCard({ cls: 'pk', ico: 'flame', label: '体检异常素材', value: k.qc.bad, unit: '条', foot: `平均 ${k.qc.avg || 0} 分 · 待检 ${k.qc.pending} · 相似 ${k.qc.similar}` }),
  ));

  // ---- 趋势 ----
  const maxV = Math.max(1, ...d.trend.flatMap(t => [t.uploads, t.comments, t.downloads]));
  const H = 132;
  const seg = (cls, v) => el('i', {
    class: `bar-seg ${cls}`,
    style: {
      height: (v > 0 ? Math.max(3, Math.round(v / maxV * H)) : 2) + 'px',
      ...(v > 0 ? {} : { background: 'var(--line)' }),
    },
  });
  const chart = el('div', { class: 'chart' },
    ...d.trend.map(t => el('div', { class: 'bar-col', title: `${t.date} · 素材 ${t.uploads} / 评论 ${t.comments} / 下载 ${t.downloads}` },
      el('div', { class: 'bar-stack' },
        seg('up', t.uploads),
        seg('cm', t.comments),
        seg('dl', t.downloads),
      ),
      el('span', { class: 'bar-x' }, shortDate(t.date)),
    )),
  );

  const trendPanel = panel('近 14 天动态', '素材入库 / 评论 / 下载', chart,
    el('div', { class: 'legend' },
      el('span', {}, el('i', { class: 'l-up' }), '素材'),
      el('span', {}, el('i', { class: 'l-cm' }), '评论'),
      el('span', {}, el('i', { class: 'l-dl' }), '下载'),
    ));

  // ---- 评分分布 ----
  const distBody = el('div', { class: 'dist' },
    ...d.ratingDist.map(r => el('div', { class: 'dist-row' },
      el('span', { class: 'dist-star' }, starIcon(11, true), String(r.star)),
      el('div', { class: 'dist-bar' }, el('i', { style: { width: Math.max(1, r.pct) + '%' } })),
      el('span', { class: 'dist-num' }, `${r.count} · ${r.pct}%`),
    )),
  );
  const distPanel = panel('评分分布', `${k.ratings.rated} 条已评 · 平均 ${k.ratings.avg} 星`,
    el('div', {},
      distBody,
      el('div', { style: { display: 'flex', gap: '8px', marginTop: '14px', flexWrap: 'wrap' } },
        el('span', { class: 'pill done' }, `5 星 ${k.ratings.five}`),
        el('span', { class: 'pill claimed' }, `4 星+ ${k.ratings.fourPlus}`),
        el('span', { class: 'pill' }, `未评 ${k.videosTotal - k.ratings.rated}`),
      ),
    ));

  // ---- 高分素材 ----
  const topBody = d.topVideos.length
    ? el('div', { class: 'rank-list' },
        ...d.topVideos.map((v, i) => el('div', {
          class: 'rank-item',
          onclick: () => openVideo(v.id),
        },
          el('span', { class: 'rank-no' }, String(i + 1)),
          el('div', { class: 'rank-thumb' },
            v.thumb_path ? el('img', { src: mediaUrl(`/api/videos/${v.id}/thumb`), loading: 'lazy', alt: '' }) : null),
          el('div', { class: 'rank-info' },
            el('div', { class: 'rank-title' }, v.title || v.orig_name || '未命名素材'),
            el('div', { class: 'rank-meta' },
              el('span', {}, v.uploader_name || '目录投递'),
              el('span', {}, `· ${v.comments} 评论 · ${v.downloads} 下载`),
            ),
          ),
          el('span', { class: 'rank-stars' }, starIcon(10, true), String(v.rating)),
        )),
      )
    : emptyState({ icon: '★', title: '还没有评分', message: '在选片时点星星打分，高分素材会出现在这里' });

  // ---- 团队 ----
  const maxAct = Math.max(1, ...d.team.map(t => t.comments + t.downloads + t.ratings + t.uploads + t.claims));
  const teamBody = el('div', { class: 'team-list' },
    ...d.team.slice(0, 8).map(t => {
      const act = t.comments + t.downloads + t.ratings + t.uploads + t.claims;
      return el('div', { class: 'team-row' },
        el('div', { class: 'team-name' },
          avatarMini(t.name, t.color),
          el('b', {}, t.name),
          el('em', {}, roleLabel(t.role)),
          el('span', { class: 'team-act' }, `${act} 次动作${t.done ? ` · 完成 ${t.done}` : ''}`),
        ),
        el('div', { class: 'team-bar' }, el('i', { style: { width: Math.max(3, Math.round(act / maxAct * 100)) + '%' } })),
      );
    }),
  );

  // ---- 需求概览 ----
  const reqTotalSafe = Math.max(1, k.requests.total);
  const segBar = el('div', { style: { display: 'flex', height: '10px', borderRadius: '99px', overflow: 'hidden', background: 'var(--panel-3)', margin: '4px 0 14px' } },
    el('i', { style: { width: (k.requests.open / reqTotalSafe * 100) + '%', background: 'var(--gold)' } }),
    el('i', { style: { width: (k.requests.claimed / reqTotalSafe * 100) + '%', background: 'var(--cy)' } }),
    el('i', { style: { width: (k.requests.done / reqTotalSafe * 100) + '%', background: 'var(--ok)' } }),
  );
  const reqBody = el('div', {},
    segBar,
    el('div', { class: 'dist' },
      ...[
        ['待认领', k.requests.open, 'var(--gold)'],
        ['进行中', k.requests.claimed, 'var(--cy)'],
        ['已完成', k.requests.done, 'var(--ok)'],
      ].map(([label, val, color]) => el('div', { class: 'dist-row' },
        el('span', { style: { fontSize: '11px', color: 'var(--tx2)' } }, label),
        el('div', { class: 'dist-bar' },
          el('i', { style: { width: Math.max(1, Math.round(val / reqTotalSafe * 100)) + '%', background: color } })),
        el('span', { class: 'dist-num' }, String(val)),
      )),
    ),
    k.requests.overdue > 0
      ? el('div', { style: { marginTop: '12px' } },
          el('span', { class: 'pill high' }, `⚠ ${k.requests.overdue} 个需求已逾期`))
      : el('div', { style: { marginTop: '12px', fontSize: '11px', color: 'var(--tx3)' } }, '没有逾期需求，节奏不错'),
    el('div', { style: { marginTop: '12px' } },
      el('button', { class: 'btn btn-ghost sm', onclick: () => switchView('requests') }, '查看全部需求 →')),
  );

  // ---- 动态流 ----
  const FEED_META = {
    comment: { cls: 'comment', ico: 'comment', verb: '评论了' },
    download: { cls: 'download', ico: 'download', verb: '下载了' },
    rating: { cls: 'rating', ico: 'star', verb: '给' },
    request: { cls: 'request', ico: 'check', verb: '完成了需求' },
  };
  const feedBody = d.activity.length
    ? el('div', { class: 'feed' },
        ...d.activity.map(a => {
          const meta = FEED_META[a.type] || FEED_META.comment;
          return el('div', { class: 'feed-item' },
            el('span', { class: `feed-ico ${meta.cls}` }, icon(meta.ico, 11)),
            el('div', { class: 'feed-body' },
              el('div', { class: 'feed-text' },
                el('b', {}, a.user_name || '有人'), ' ',
                a.type === 'rating'
                  ? ['给了 ', el('span', { class: 'vt' }, a.video_title || '素材'), ` ${a.text} 星`]
                  : a.type === 'request'
                    ? ['完成了需求 ', el('span', { class: 'vt' }, a.text)]
                    : [meta.verb + ' ', el('span', { class: 'vt' }, a.video_title || '素材')],
              ),
              a.type === 'comment' && a.text
                ? el('div', { style: { fontSize: '10.5px', color: 'var(--tx3)', marginTop: '2px' } }, String(a.text).slice(0, 60) + (String(a.text).length > 60 ? '…' : ''))
                : null,
              el('div', { class: 'feed-time' }, timeAgo(a.at)),
            ),
          );
        }),
      )
    : emptyState({ icon: '◔', title: '还没有动态', message: '上传素材、发评论、打分之后，这里会实时出现' });

  // ---- 我的贡献 ----
  const mineBody = el('div', { class: 'mine-grid' },
    ...[
      ['上传素材', d.mine.uploads],
      ['发表评论', d.mine.comments],
      ['素材评分', d.mine.ratings],
      ['下载次数', d.mine.downloads],
      ['认领需求', d.mine.claims],
      ['完成任务', d.mine.done],
    ].map(([label, val]) => el('div', { class: 'mine-item' },
      el('b', {}, String(val)), el('span', {}, label))),
  );

  root.append(el('div', { class: 'dash-cols' }, trendPanel, distPanel));
  root.append(el('div', { class: 'dash-cols' }, panel('高分素材榜', '按评分排序', topBody), panel('团队活跃度', '评论 + 下载 + 评分 + 上传 + 认领', teamBody)));
  root.append(el('div', { class: 'dash-cols' }, pipelinePanel(), dimsPanel()));
  root.append(el('div', { class: 'dash-cols' }, panel('需求概览', '状态分布', reqBody), panel('最近动态', '实时联动', feedBody)));
  root.append(panel('我的贡献', '登录至今的累计数据', mineBody));

  view.append(root);
}

async function loadVideos(append = false) {
  S.loading = true;
  if (!append) $('#view').replaceChildren(skeleton(8));

  const p = new URLSearchParams({ space: S.space, limit: '60', offset: String(S.offset), sort: S.sort });
  if (S.from || S.to) {
    if (S.from) p.set('from', S.from);
    if (S.to) p.set('to', S.to);
  } else if (S.view === 'daily' && S.date) {
    p.set('date', S.date);
  }
  if (S.q) p.set('q', S.q);
  if (S.tag) p.set('tag', S.tag);
  if (S.filter === 'new' || S.filter === 'picked') p.set('status', S.filter);
  if (S.filter === 'notDownloaded') p.set('notDownloaded', '1');
  if (S.filter === 'hasComments') p.set('hasComments', '1');
  if (S.filter === 'starred') p.set('starred', '1');
  if (S.filter === 'star4') p.set('minRating', '4');
  if (S.filter === 'qcBad') p.set('qc', 'bad');
  if (S.stage) p.set('stage', S.stage);

  try {
    const data = await api('/videos?' + p);
    S.items = append ? [...S.items, ...data.items] : data.items;
    S.dates = data.dates;
    S.tags = data.tags;
    S.total = data.total;
    renderToolbar();
    renderList();
  } catch (e) {
    $('#view').replaceChildren(emptyState({ icon: '!', title: '加载失败', message: e.message }));
  } finally {
    S.loading = false;
  }
}

async function loadRequests() {
  $('#view').replaceChildren(skeleton(4));
  try {
    const p = new URLSearchParams();
    if (S.reqFilter !== 'all') p.set('status', S.reqFilter);
    if (S.q) p.set('q', S.q);
    const data = await api('/requests?' + p);
    S.requests = data.items;
    S.reqCounts = data.counts;
    renderRequests();
  } catch (e) {
    $('#view').replaceChildren(emptyState({ icon: '!', title: '加载失败', message: e.message }));
  }
}

async function loadRecords() {
  $('#view').replaceChildren(skeleton(3));
  try {
    const data = await api('/downloads?limit=200');
    renderRecords(data.items);
  } catch (e) {
    $('#view').replaceChildren(emptyState({ icon: '!', title: '加载失败', message: e.message }));
  }
}

async function loadMembers() {
  $('#view').replaceChildren(skeleton(2));
  try {
    const [data, st] = await Promise.all([
      api('/users'),
      api('/stats').catch(() => null),
    ]);
    S.members = data.items;
    if (st) S.stats = st;
    renderMembers();
  } catch (e) {
    $('#view').replaceChildren(emptyState({ icon: '!', title: '加载失败', message: e.message }));
  }
}

/* ========================= 系统设置（管理员） ========================= */
async function loadSettings() {
  $('#view').replaceChildren(skeleton(2));
  try {
    const [ai, notify] = await Promise.all([
      api('/settings/ai'),
      api('/settings/notify').catch(() => null),
    ]);
    if (S.view === 'settings') renderSettings(ai, notify);
  } catch (e) {
    $('#view').replaceChildren(emptyState({ icon: '!', title: '设置加载失败', message: e.message }));
  }
}

/* ---- AI 接口预设方案（国内外主流厂商 + 自定义；全部走 OpenAI 兼容协议） ---- */
const AI_PRESETS = [
  { id: 'grsai', label: 'grsai 中转站（默认）', baseUrl: 'https://api.grsai.com/v1',
    models: ['gpt-4o', 'gpt-4o-mini', 'claude-sonnet-4', 'gemini-2.5-flash'],
    keyHint: '在 grsai.com 控制台生成 API Key；一个 Key 能用多家模型，适合不想分别充值的情况' },
  { id: 'openai', label: 'OpenAI 官方', baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1-mini'],
    keyHint: 'platform.openai.com 生成 Key；国内直连不稳，建议 NAS 配代理或改用中转站' },
  { id: 'deepseek', label: 'DeepSeek（深度求索）', baseUrl: 'https://api.deepseek.com/v1',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    keyHint: 'platform.deepseek.com 生成 Key；注意：DeepSeek 暂无视觉模型，拆解图片请选其他方案' },
  { id: 'dashscope', label: '阿里通义千问', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: ['qwen-vl-max', 'qwen-vl-plus', 'qwen2.5-vl-72b-instruct'],
    keyHint: '阿里云百炼控制台（兼容模式入口）生成 Key；拆解选 qwen-vl 视觉模型' },
  { id: 'zhipu', label: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    models: ['glm-4.5v', 'glm-4v-plus', 'glm-4-flash'],
    keyHint: 'open.bigmodel.cn 生成 Key；拆解选 glm-4v / glm-4.5v 系视觉模型' },
  { id: 'moonshot', label: '月之暗面 Kimi', baseUrl: 'https://api.moonshot.cn/v1',
    models: ['moonshot-v1-8k-vision-preview', 'kimi-latest'],
    keyHint: 'platform.moonshot.cn 生成 Key；拆解选 vision 系模型' },
  { id: 'ark', label: '火山方舟（豆包）', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    models: ['doubao-1.5-vision-pro-32k', 'doubao-seed-1.6-flash'],
    keyHint: '火山方舟控制台生成 Key；模型名也可以填接入点 ID（ep-xxxx）' },
  { id: 'gemini', label: 'Google Gemini（OpenAI 兼容层）', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    models: ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-2.5-pro'],
    keyHint: 'aistudio.google.com 生成 Key；国内访问需代理' },
  { id: 'openrouter', label: 'OpenRouter（海外聚合）', baseUrl: 'https://openrouter.ai/api/v1',
    models: ['openai/gpt-4o', 'google/gemini-2.5-flash', 'anthropic/claude-sonnet-4'],
    keyHint: 'openrouter.ai 生成 Key；模型要写 厂商/模型名 格式' },
  { id: 'siliconflow', label: '硅基流动 SiliconFlow', baseUrl: 'https://api.siliconflow.cn/v1',
    models: ['Qwen/Qwen2.5-VL-72B-Instruct', 'Qwen/Qwen2.5-VL-32B-Instruct'],
    keyHint: 'cloud.siliconflow.cn 生成 Key；Qwen-VL 系有免费额度' },
  { id: 'custom', label: '自定义（任意 OpenAI 兼容接口）', baseUrl: '',
    models: [],
    keyHint: '填任意 OpenAI 兼容服务的 base URL（到 /v1 这一级，结尾不带 /chat/completions），模型与 Key 按该服务的要求填' },
];
const aiPresetBy = url => AI_PRESETS.find(
  p => p.baseUrl && p.baseUrl === String(url || '').replace(/\/+$/, '')
);

function renderSettings(d, nd) {
  const view = $('#view');
  view.innerHTML = '';
  const canEdit = !!d.canEdit;
  const src = d.sources || {};

  const srcDot = key => el('i', {
    class: 'src-dot' + (src[key] === 'db' ? ' on' : ''),
    title: src[key] === 'db' ? '正在用管理员设置值' : '环境变量默认值',
  });

  const statusChip = el('span', { class: 'pill' }, '…');
  const modelList = el('datalist', { id: 'aiModelList' });
  const applyModelList = list => {
    if ((list || []).length) modelList.replaceChildren(...list.slice(0, 40).map(x => el('option', { value: x })));
  };
  const chip = (cls, text, title) => {
    statusChip.className = 'pill ' + cls;
    statusChip.textContent = text;
    statusChip.title = title || '';
  };

  // 进页面只做轻探（不花 token）：地址通不通、能拉到模型列表
  const refreshStatus = async () => {
    statusChip.textContent = '检测中…';
    statusChip.className = 'pill';
    try {
      const st = await api('/settings/ai/test');
      if (!st.enabled) return chip('closed', '已关闭');
      if (!st.reachable) return chip('high', st.error || '不可达');
      if ((st.models || []).length) {
        applyModelList(st.models);
        chip('done', `连通正常 · ${st.models.length} 个模型`);
      } else {
        chip('done', '连通正常（接口未提供模型列表）');
      }
    } catch (e) { chip('high', e.message); }
  };

  // 「测试连接」按钮：连 Key、带模型做一次极小真实调用，几十个 token 以内
  const deepTest = async () => {
    statusChip.textContent = '测试中…（连通 + 模型一起验）';
    statusChip.className = 'pill';
    try {
      const st = await api('/settings/ai/test?deep=1');
      if (!st.enabled) return chip('closed', '已关闭');
      if (!st.reachable) return chip('high', `连不上：${st.error || '不可达'}`);
      if ((st.models || []).length) applyModelList(st.models);
      if (st.modelOk) chip('done', `连通 ✓ 模型 ✓（${st.modelEcho || st.model}）`);
      else chip('high', `连通 ✓ 模型 ✗：${st.modelError || '模型不可用'}`, st.modelError);
    } catch (e) { chip('high', e.message); }
  };
  refreshStatus();

  // 接口方案：预设下拉（当前地址能对上哪个厂商就选哪个，对不上 = 自定义）
  const presetSel = el('select', { disabled: !canEdit },
    ...AI_PRESETS.map(p => el('option', { value: p.id }, p.label)));
  const curPreset = aiPresetBy(d.baseUrl);
  presetSel.value = curPreset?.id || 'custom';
  applyModelList(curPreset?.models);
  const presetHint = el('p', { class: 'sethint' },
    curPreset?.keyHint || AI_PRESETS[AI_PRESETS.length - 1].keyHint);

  const baseUrl = el('input', { value: d.baseUrl || '', disabled: !canEdit, placeholder: 'https://api.grsai.com/v1' });
  const model = el('input', { value: d.model || '', list: 'aiModelList', disabled: !canEdit, placeholder: 'gpt-4o' });
  presetSel.addEventListener('change', () => {
    const p = AI_PRESETS.find(x => x.id === presetSel.value) || AI_PRESETS[AI_PRESETS.length - 1];
    if (p.baseUrl) baseUrl.value = p.baseUrl;
    presetHint.textContent = p.keyHint;
    applyModelList(p.models);
    // 切厂商时旧模型名基本必然失效：换成该方案的推荐模型，用户可再改
    if (p.models?.length && !p.models.includes(model.value.trim())) {
      model.value = p.models[0];
      toast(`已带出推荐模型 ${p.models[0]}，保存后生效`, 'ok', 3600);
    }
  });
  const apiKey = el('input', {
    type: 'password', autocomplete: 'new-password', disabled: !canEdit,
    placeholder: d.apiKeyMasked ? `当前 ${d.apiKeyMasked}（留空 = 保持不变）` : 'sk-…（不填则无法拆解）',
  });
  const keyEye = el('button', {
    class: 'pw-eye', type: 'button',
    onclick: e => {
      e.preventDefault();
      apiKey.type = apiKey.type === 'password' ? 'text' : 'password';
      keyEye.textContent = apiKey.type === 'password' ? '显示' : '隐藏';
    },
  }, '显示');

  const framesSel = el('select', { disabled: !canEdit },
    ...Array.from({ length: 8 }, (_, i) => el('option', { value: String(i + 3) }, `${i + 3} 张`)));
  framesSel.value = String(d.frames || 6);

  const timeoutIn = el('input', { type: 'number', min: '30', max: '900', step: '10', value: String(Math.round((d.timeoutMs || 300000) / 1000)), disabled: !canEdit });

  const enabledCb = el('input', { type: 'checkbox', disabled: !canEdit });
  enabledCb.checked = d.enabled !== false;

  const save = async () => {
    const body = {
      ai_base_url: baseUrl.value.trim(),
      ai_model: model.value.trim(),
      ai_frames: framesSel.value,
      ai_timeout_ms: String(Math.min(900, Math.max(30, Number(timeoutIn.value) || 300)) * 1000),
      ai_enabled: !!enabledCb.checked,
    };
    if (apiKey.value.trim()) body.ai_api_key = apiKey.value.trim();
    try {
      await api('/settings/ai', { method: 'PUT', body });
      toast('已保存，立即生效（无需重启容器）');
      refreshStatus();
      loadSettings();
    } catch (e) { toast(e.message, 'err'); }
  };

  const clearKey = async () => {
    if (!await confirmDialog({
      title: '清除 API Key',
      message: '清除后本系统将不再使用任何 Key（不会回退到环境变量），AI 拆解会不可用，直到重新填写。',
      confirmText: '清除', danger: true,
    })) return;
    try {
      await api('/settings/ai', { method: 'PUT', body: { ai_api_key: null } });
      toast('已清除 API Key');
      loadSettings();
    } catch (e) { toast(e.message, 'err'); }
  };

  const form = el('div', { class: 'setform' },
    el('div', { class: 'setstat' },
      el('span', { class: 'mini-lbl' }, 'AI 接口状态'),
      statusChip,
      canEdit ? el('button', { class: 'btn btn-ghost sm', title: '连通 + API Key + 当前模型各验一遍（消耗几十个 token）', onclick: deepTest }, '⚡ 测试连接') : null,
      el('span', { style: { flex: 1 } }),
      d.apiKeyMasked ? el('span', { class: 'pill' }, `Key ${d.apiKeyMasked}`) : el('span', { class: 'pill high' }, '未配 Key'),
    ),
    el('div', { class: 'field-row' },
      el('div', { class: 'field' },
        el('label', {}, '接口方案（国内外厂商 / 自定义）', srcDot('ai_base_url')),
        presetSel,
        presetHint),
      el('div', { class: 'field' },
        el('label', {}, '接入地址（OpenAI 兼容）', srcDot('ai_base_url')),
        baseUrl,
        el('p', { class: 'sethint' }, '选方案自动带出；也可以直接改地址（改了就按自定义算）。'),
      ),
    ),
    el('div', { class: 'field-row' },
      el('div', { class: 'field' },
        el('label', {}, '模型（需支持图片输入）', srcDot('ai_model')),
        model, modelList,
        el('p', { class: 'sethint' }, '选方案自动带出推荐模型，下拉来自「测试连接」拉到的列表。'),
      ),
      el('div', { class: 'field' },
        el('label', {}, 'API Key', srcDot('ai_api_key')),
        el('div', { class: 'pw-wrap' }, apiKey, keyEye),
        el('p', { class: 'sethint' }, '只存本机数据库、不下发给浏览器；留空保存表示保持不变。'),
      ),
    ),
    el('div', { class: 'field-row' },
      el('div', { class: 'field' },
        el('label', {}, '每条视频抽几张关键帧', srcDot('ai_frames')),
        framesSel,
        el('p', { class: 'sethint' }, '3-10 张；越多拆得越准、每次调用也越贵。'),
      ),
      el('div', { class: 'field' },
        el('label', {}, '单次拆解超时（秒）', srcDot('ai_timeout_ms')),
        timeoutIn,
        el('p', { class: 'sethint' }, '30-900 秒。慢模型 / 多图 + 长 prompt 容易超时，默认 300 秒；拆解报「模型响应超时」就调大。'),
      ),
    ),
    el('label', { class: 'setcheck' },
      enabledCb,
      el('span', {}, '启用 AI 脚本拆解'),
      el('em', {}, '关闭后素材抽屉和批量条里的 AI 拆解入口会给出明确提示'),
    ),
    el('div', { class: 'sacts' },
      canEdit ? el('button', { class: 'btn btn-primary', onclick: save }, '保存设置') : null,
      canEdit && d.apiKeyMasked ? el('button', { class: 'btn btn-ghost', onclick: clearKey }, '清除 Key') : null,
    ),
    !canEdit ? el('p', { class: 'sethint' }, '当前账号不是管理员，这里只读。') : null,
    el('p', { class: 'sethint' },
      '规则：环境变量（AI_BASE_URL / AI_API_KEY / AI_MODEL / AI_FRAMES）是出厂默认；这里保存过的项优先生效，改完立即生效、无需重启容器。'),
  );

  view.append(panel('AI 脚本拆解', '各大厂商接口方案 · 模型 · 密钥，管理员统一管理', form));
  if (nd) view.append(renderNotifyPanel(nd));
}

/* ---- 群通知面板（企业微信 / 飞书 / 钉钉 webhook） ---- */
function renderNotifyPanel(d) {
  const canEdit = !!d.canEdit;
  const src = d.sources || {};
  const srcDot = key => el('i', {
    class: 'src-dot' + (src[key] === 'db' ? ' on' : ''),
    title: src[key] === 'db' ? '正在用管理员设置值' : '环境变量默认值',
  });

  const typeSel = el('select', { disabled: !canEdit },
    el('option', { value: 'wecom' }, '企业微信群机器人'),
    el('option', { value: 'feishu' }, '飞书自定义机器人'),
    el('option', { value: 'dingtalk' }, '钉钉自定义机器人'),
  );
  typeSel.value = d.type || 'wecom';

  const urlIn = el('input', {
    value: d.url || '', disabled: !canEdit,
    placeholder: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…',
  });
  const secretIn = el('input', {
    type: 'password', autocomplete: 'new-password', disabled: !canEdit,
    placeholder: d.secretMasked ? `当前 ${d.secretMasked}（留空 = 保持不变）` : '机器人开了「加签」才需要填',
  });
  const publicIn = el('input', {
    value: d.publicBase || '', disabled: !canEdit,
    placeholder: 'https://tk.example.com（不填则只发文字列表）',
  });
  const linkIn = el('input', {
    value: d.linkBase || '', disabled: !canEdit,
    placeholder: 'http://192.168.1.4:8899（不填则用上面的公网地址）',
  });
  const onUploadCb = el('input', { type: 'checkbox', disabled: !canEdit });
  onUploadCb.checked = d.onUpload !== false;
  const onCommentCb = el('input', { type: 'checkbox', disabled: !canEdit });
  onCommentCb.checked = d.onComment !== false;
  const enabledCb = el('input', { type: 'checkbox', disabled: !canEdit });
  enabledCb.checked = d.enabled !== false;

  const testChip = el('span', { class: 'pill' }, '未测试');
  const runTest = async () => {
    testChip.textContent = '发送中…';
    testChip.className = 'pill';
    try {
      const st = await api('/settings/notify/test');
      if (st.ok) { testChip.className = 'pill done'; testChip.textContent = '已发出，去群里看一眼'; }
      else { testChip.className = 'pill high'; testChip.textContent = st.error || '发送失败'; }
    } catch (e) {
      testChip.className = 'pill high';
      testChip.textContent = e.message;
    }
  };

  const save = async () => {
    const body = {
      notify_type: typeSel.value,
      notify_url: urlIn.value.trim(),
      notify_public_base: publicIn.value.trim(),
      notify_link_base: linkIn.value.trim(),
      notify_enabled: !!enabledCb.checked,
      notify_on_upload: !!onUploadCb.checked,
      notify_on_comment: !!onCommentCb.checked,
    };
    if (secretIn.value.trim()) body.notify_secret = secretIn.value.trim();
    try {
      await api('/settings/notify', { method: 'PUT', body });
      toast('已保存，立即生效（无需重启容器）');
      loadSettings();
    } catch (e) { toast(e.message, 'err'); }
  };

  const clearSecret = async () => {
    if (!await confirmDialog({
      title: '清除加签密钥',
      message: '清除后本系统将不再对 webhook 请求加签（不会回退到环境变量）。机器人安全设置开了「加签」时会推送失败。',
      confirmText: '清除', danger: true,
    })) return;
    try {
      await api('/settings/notify', { method: 'PUT', body: { notify_secret: null } });
      toast('已清除加签密钥');
      loadSettings();
    } catch (e) { toast(e.message, 'err'); }
  };

  const form = el('div', { class: 'setform' },
    el('div', { class: 'setstat' },
      el('span', { class: 'mini-lbl' }, '推送状态'),
      enabledCb.checked ? el('span', { class: 'pill done' }, '已启用') : el('span', { class: 'pill high' }, '未启用'),
      el('button', { class: 'btn btn-ghost sm', onclick: runTest }, '⚡ 发送测试'),
      el('span', { style: { flex: 1 } }),
      testChip,
    ),
    el('div', { class: 'field-row' },
      el('div', { class: 'field' },
        el('label', {}, '机器人类型', srcDot('notify_type')),
        typeSel),
      el('div', { class: 'field' },
        el('label', {}, 'Webhook 地址', srcDot('notify_url')),
        urlIn),
    ),
    el('div', { class: 'field' },
      el('label', {}, '加签密钥（可选）', srcDot('notify_secret')),
      el('div', { class: 'pw-wrap' }, secretIn),
      el('p', { class: 'sethint' }, '钉钉 / 飞书机器人安全设置选了「加签」时才需要；企业微信机器人不用填。'),
    ),
    el('div', { class: 'field' },
      el('label', {}, '跳转地址（点消息里的链接去哪）', srcDot('notify_link_base')),
      linkIn,
      el('p', { class: 'sethint' }, '手机和 NAS 在同一个 WiFi 时，把这个填成内网地址（如 http://192.168.1.4:8899）点开更快；留空则用下面的公网地址。钉钉消息里的链接会自动用系统浏览器打开，不走钉钉内置浏览器。'),
    ),
    el('div', { class: 'field' },
      el('label', {}, '公网访问地址（缩略图卡片需要）', srcDot('notify_public_base')),
      publicIn,
      el('p', { class: 'sethint' }, typeSel.value === 'dingtalk'
        ? '钉钉群里的图片由钉钉客户端从公网拉取，NAS 内网地址它打不开。填好公网域名（DDNS / 反向代理 / 内网穿透任一种，能访问本工作台即可），素材入库通知就会变成带封面缩略图的卡片。'
        : '钉钉缩略图卡片必须能公网访问本工作台；企业微信也会把封面图内嵌进消息。不填则发纯文字列表。'),
    ),
    el('div', { class: 'field-row' },
      el('label', { class: 'setcheck' },
        onUploadCb,
        el('span', {}, '素材入库时推送'),
        el('em', {}, '上传 / NAS 投递目录有新素材，群里收到入库通知'),
      ),
      el('label', { class: 'setcheck' },
        onCommentCb,
        el('span', {}, '新评论时推送'),
        el('em', {}, '评论里 @成员，群里会真实艾特到 TA'),
      ),
    ),
    el('label', { class: 'setcheck' },
      enabledCb,
      el('span', {}, '启用群通知'),
      el('em', {}, '关闭后所有事件都不再推送'),
    ),
    el('div', { class: 'sacts' },
      canEdit ? el('button', { class: 'btn btn-primary', onclick: save }, '保存设置') : null,
      canEdit && d.secretMasked ? el('button', { class: 'btn btn-ghost', onclick: clearSecret }, '清除密钥') : null,
    ),
    !canEdit ? el('p', { class: 'sethint' }, '当前账号不是管理员，这里只读。') : null,
    el('p', { class: 'sethint' },
      '要在群里被真实艾特，还需要到「成员」页给成员配「通知账号」（企业微信 userid / 钉钉手机号 / 飞书 user_id）；没配的成员只会以文字形式出现在消息里。环境变量 NOTIFY_* 是出厂默认，这里保存过的项优先生效。'),
  );

  return panel('群通知', '企业微信 / 飞书 / 钉钉 · 素材入库与新评论推送', form);
}

/* ========================= 脚本库（AI 拆解） ========================= */
const SCRIPT_STATE = {
  pending: { label: '排队中', cls: 'wait' },
  running: { label: '拆解中', cls: 'run' },
  done: { label: '已拆解', cls: 'ok' },
  failed: { label: '失败', cls: 'err' },
};
const scriptState = st => SCRIPT_STATE[st] || { label: st || '未知', cls: 'wait' };
const frameUrl = (s, i) => mediaUrl(`/api/scripts/${s.id}/frames/${i}`);

function scriptBadge(st) {
  const m = scriptState(st);
  return el('span', { class: `sbadge ${m.cls}` },
    (st === 'pending' || st === 'running') ? el('i', { class: 'sdot' }) : null,
    m.label);
}

function renderScriptBar() {
  const bar = el('div', { class: 'filterbar' });
  const c = S.scriptCounts || {};
  const total = Object.values(c).reduce((a, b) => a + b, 0);
  const seg = el('div', { class: 'seg' });
  const items = [
    ['all', '全部', total],
    ['done', '已拆解', c.done || 0],
    ['running', '进行中', (c.pending || 0) + (c.running || 0)],
    ['failed', '失败', c.failed || 0],
  ];
  for (const [k, label, n] of items) {
    seg.append(el('button', {
      class: S.scriptFilter === k ? 'on' : '',
      onclick: () => { S.scriptFilter = k; loadScripts(); },   // loadScripts 内部会刷新工具栏
    }, n ? `${label} ${n}` : label));
  }
  bar.append(seg, el('div', { class: 'spacer' }));
  bar.append(el('button', {
    class: 'btn btn-ghost sm',
    title: '检查中转站连通性与模型配置',
    onclick: openAiPanel,
  }, '◇ AI 状态'));
  return bar;
}

let scriptSeq = 0;   // 请求序号：快速切筛选时丢弃过期响应，避免旧数据覆盖新数据

async function loadScripts() {
  if (!S.scripts.length) $('#view').replaceChildren(skeleton(4));
  const seq = ++scriptSeq;
  try {
    const p = new URLSearchParams();
    if (S.q) p.set('q', S.q);
    if (S.scriptFilter !== 'all') p.set('status', S.scriptFilter);
    const data = await api('/scripts?' + p);
    if (seq !== scriptSeq || S.view !== 'scripts') return;   // 已有更新的请求 / 已切走
    S.scripts = data.items || [];
    S.scriptCounts = data.counts || {};
    renderToolbar();
    renderScripts();
  } catch (e) {
    if (seq !== scriptSeq) return;
    $('#view').replaceChildren(emptyState({ icon: '!', title: '脚本库加载失败', message: e.message }));
  }
}

function renderScripts() {
  const view = $('#view');
  view.innerHTML = '';

  if (!S.scripts.length) {
    view.append(emptyState({
      icon: '✦',
      title: S.q ? '没有匹配的脚本' : '脚本库还是空的',
      message: S.q
        ? '换个关键词，脚本标题、标签和口播稿都会被搜到'
        : '打开任意素材，点一下「AI 拆解」，成片会被拆成钩子、分镜和可直接开拍的口播稿',
      action: el('button', {
        class: 'btn btn-primary',
        onclick: () => switchView(S.space === 'library' ? 'library' : 'daily'),
      }, '去挑素材'),
    }));
    return;
  }

  const wrap = el('div', { class: 'sgrid' });
  for (const s of S.scripts) wrap.append(scriptCard(s));
  view.append(wrap);
}

function scriptCard(s) {
  const frames = s.frames || [];
  const segN = (s.segments || []).length;
  return el('article', {
    class: `scard st-${s.status}`,
    onclick: () => openScript(s.id),
  },
    el('div', { class: 'scard-cover' },
      frames.length
        ? el('img', { src: frameUrl(s, 0), alt: '', loading: 'lazy' })
        : el('div', { class: 'ph' }, '✦'),
      el('div', { class: 'scard-grad' }),
      el('div', { class: 'scard-top' }, scriptBadge(s.status)),
      frames.length > 1
        ? el('div', { class: 'scard-frames' },
            el('b', {}, String(frames.length)), ' 帧',
            segN ? ` · ${segN} 段` : '')
        : null,
    ),
    el('div', { class: 'scard-body' },
      el('h3', {}, s.title || s.video_title || '未命名脚本'),
      s.summary
        ? el('p', { class: 'sum' }, s.summary)
        : (s.status === 'failed' ? el('p', { class: 'sum err' }, s.error || '拆解失败') : null),
      s.hook ? el('p', { class: 'hook' }, el('em', {}, '钩子'), s.hook) : null,
      (s.tagList || []).length
        ? el('div', { class: 'scard-tags' }, ...s.tagList.slice(0, 4).map(t => el('span', { class: 'pill' }, t)))
        : null,
      el('div', { class: 'scard-foot' },
        el('span', { class: 'src', title: s.video_title || '' }, s.video_title || '来源素材已删除'),
        el('span', { class: 'tm' }, timeAgo(s.updated_at || s.created_at)),
      ),
    ),
  );
}

/** 关键帧横向条 */
function frameStrip(s) {
  const frames = s.frames || [];
  if (!frames.length) return null;
  return el('div', { class: 'fstrip' },
    ...frames.map((f, i) => el('button', {
      class: 'fcell',
      title: `第 ${fmtDuration(f.t)} 的关键帧 · 点击看大图`,
      onclick: () => window.open(frameUrl(s, i), '_blank', 'noopener'),
    },
      el('img', { src: frameUrl(s, i), alt: '', loading: 'lazy' }),
      el('span', {}, fmtDuration(f.t)),
    )),
  );
}

/** 复制（http 内网环境下 navigator.clipboard 不可用，走 execCommand 兜底） */
async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* 落到兜底 */ }
  try {
    const ta = el('textarea', { style: { position: 'fixed', top: '-1000px', left: '0', opacity: '0' } });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch { return false; }
}

/** 整份脚本的纯文本（复制 / 导出共用），含拍摄设定、动作、复刻提示词 */
function scriptPlainText(s) {
  const setup = s.shot_setup || {};
  const segs = s.segments || [];
  const out = [];
  out.push(s.title || '未命名脚本', '');
  if (s.summary) out.push(`一句话：${s.summary}`);
  if (s.hook) out.push(`钩子：${s.hook}`);
  if ((s.tagList || []).length) out.push(`标签：${s.tagList.join(' / ')}`);
  if (s.video_title) out.push(`来源素材：${s.video_title}`);
  out.push('');

  const setupLines = [
    ['scene', '场景'], ['cast', '人物'], ['props', '道具'],
    ['light', '光线'], ['gear', '机位'], ['pace', '节奏'],
  ].filter(([k]) => setup[k]).map(([k, label]) => `${label}：${setup[k]}`);
  if (setupLines.length) out.push('【拍摄设定】', ...setupLines, '');

  if (segs.length) {
    out.push('【分镜】');
    segs.forEach((g, i) => {
      out.push(`${i + 1}. ${g.t || ''}`.trim());
      if (g.shot) out.push(`   画面：${g.shot}`);
      if (g.action) out.push(`   动作：${g.action}`);
      if (g.line) out.push(`   台词：${g.line}`);
      if (g.text) out.push(`   字幕：${g.text}`);
      if (g.audio) out.push(`   声音：${g.audio}`);
      if (g.props) out.push(`   道具：${g.props}`);
      if (g.cut) out.push(`   衔接：${g.cut}`);
    });
    out.push('');
  }

  if (s.script_text) out.push('【口播稿】', s.script_text, '');
  if (s.cta) out.push(`【收口】${s.cta}`, '');
  if (s.replicate_prompt) out.push('【AI 复刻提示词】', s.replicate_prompt);
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function downloadScript(s) {
  const name = String(s.title || '脚本').replace(/[\\/:*?"<>|]/g, '_').slice(0, 40);
  const url = URL.createObjectURL(new Blob([scriptPlainText(s)], { type: 'text/plain;charset=utf-8' }));
  const a = el('a', { href: url, download: `${name}.txt` });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1500);
}

/** 详情内容（按状态分三种形态；stale = 轮询超时后的提示） */
function scriptDetail(s, actions, stale = false) {
  if (s.status === 'pending' || s.status === 'running') {
    return [
      el('div', { class: 'sprog' },
        el('span', { class: 'spin' }),
        el('div', {},
          el('b', {}, s.status === 'pending' ? '排队中，马上开始' : '正在拆解…'),
          el('p', {}, '抽关键帧 → 逐帧看画面 → 归纳钩子与分镜，通常 20~60 秒。'),
        ),
      ),
      frameStrip(s),
      el('p', { class: 'snote' }, stale
        ? '等了 5 分钟还没完成（批量拆解时前面还排着队）。这里不再自动刷新，稍后到「脚本库」看结果。'
        : '关掉这个窗口也没关系，任务在服务端继续跑，完成后到「脚本库」看结果。'),
    ].filter(Boolean);
  }

  if (s.status === 'failed') {
    return [
      el('div', { class: 'sfail' },
        el('b', {}, '拆解失败'),
        el('p', {}, s.error || '模型没有返回可用的结果，可以直接重试'),
      ),
      el('div', { class: 'sacts' },
        el('button', { class: 'btn btn-primary', onclick: actions.retry }, '↻ 重新拆解'),
        el('button', { class: 'btn btn-ghost', onclick: () => { closeModal(); openVideo(s.video_id); } }, '看原素材'),
      ),
    ];
  }

  const segs = s.segments || [];
  const text = s.script_text || '';
  const setup = s.shot_setup || {};
  const SETUP_FIELDS = [
    ['scene', '场景'], ['cast', '人物'], ['props', '道具'],
    ['light', '光线'], ['gear', '机位'], ['pace', '节奏'],
  ];
  const SEG_FIELDS = [
    ['shot', '画面'], ['action', '动作'], ['line', '台词'],
    ['text', '字幕'], ['audio', '声音'], ['props', '道具'],
  ];
  const setupRows = SETUP_FIELDS.filter(([k]) => setup[k]);

  const segCard = (g, i) => {
    const rows = SEG_FIELDS.filter(([k]) => g[k]);
    return el('div', { class: 'segcard' },
      el('div', { class: 'segcard-top' },
        el('span', { class: 'st' }, g.t || `第 ${i + 1} 段`),
        g.cut ? el('span', { class: 'scut' }, `→ ${g.cut}`) : null,
      ),
      el('div', { class: 'segcard-body' },
        ...(rows.length
          ? rows.map(([k, label]) => el('div', { class: `srow f-${k}` },
              el('span', { class: 'k' }, label),
              el('span', { class: 'v' }, g[k])))
          : [el('div', { class: 'srow' },
              el('span', { class: 'v dim' }, '这一段模型没给细节，可以重新拆解一次'))]),
      ),
    );
  };

  return [
    el('div', { class: 'shead' },
      el('div', { class: 'shead-top' },
        el('div', { class: 'stag' },
          ...(s.tagList || []).map(t => el('span', { class: 'pill' }, t))),
        el('span', { class: 'sfrom' },
          '源素材 ', el('b', { title: s.video_title || '' }, s.video_title || '已删除')),
      ),
    ),
    s.summary ? el('p', { class: 'slead' }, s.summary) : null,
    s.hook
      ? el('div', { class: 'shook' },
          el('span', { class: 'mini-lbl' }, '前 3 秒钩子'),
          el('p', {}, s.hook))
      : null,
    setupRows.length
      ? el('div', { class: 'setupgrid' },
          ...setupRows.map(([k, label]) => el('div', { class: 'setupitem' },
            el('span', { class: 'k' }, label),
            el('p', {}, setup[k]))))
      : null,
    frameStrip(s),
    segs.length
      ? el('div', { class: 'seglist' },
          el('div', { class: 'seglbl' },
            el('span', { class: 'mini-lbl' }, `分镜 ${segs.length} 段`),
            el('span', { class: 'snote' }, '照着「动作」这一列就能复现同款镜头')),
          ...segs.map(segCard),
        )
      : el('p', { class: 'snote' }, '模型没有给出分镜，可以重新拆解一次试试。'),
    text
      ? el('div', { class: 'stext' },
          el('div', { class: 'stext-head' },
            el('span', { class: 'mini-lbl' }, '口播稿'),
            el('span', { style: { flex: 1 } }),
            el('button', {
              class: 'btn btn-ghost sm',
              onclick: async () => {
                const ok = await copyText(text);
                toast(ok ? '已复制口播稿' : '复制失败，请手动选中', ok ? 'ok' : 'err');
              },
            }, '复制'),
          ),
          el('pre', {}, text),
        )
      : null,
    s.cta
      ? el('div', { class: 'scta' },
          el('span', { class: 'mini-lbl' }, '收口 / CTA'),
          el('p', {}, s.cta))
      : null,
    s.replicate_prompt
      ? el('div', { class: 'sprompt' },
          el('div', { class: 'sprompt-head' },
            el('span', { class: 'mini-lbl' }, 'AI 复刻提示词'),
            el('span', { class: 'sp-tip' }, '可粘给 Sora / 可灵 / 即梦'),
            el('span', { style: { flex: 1 } }),
            el('button', {
              class: 'btn btn-ghost sm',
              onclick: async () => {
                const ok = await copyText(s.replicate_prompt);
                toast(ok ? '已复制复刻提示词' : '复制失败，请手动选中', ok ? 'ok' : 'err');
              },
            }, '复制'),
          ),
          el('pre', {}, s.replicate_prompt),
        )
      : null,
    el('div', { class: 'sacts' },
      el('button', { class: 'btn btn-primary', onclick: async () => {
        const ok = await copyText(scriptPlainText(s));
        toast(ok ? '已复制整份脚本' : '复制失败，请用 .txt 导出', ok ? 'ok' : 'err');
      } }, '复制整份'),
      el('button', { class: 'btn btn-ghost', onclick: () => downloadScript(s) }, '↓ 导出 .txt'),
      el('button', { class: 'btn btn-ghost', onclick: () => { closeModal(); openVideo(s.video_id); } }, '看原素材'),
      el('button', { class: 'btn btn-ghost', onclick: actions.retry }, '↻ 重新拆解'),
      actions.delBtn,
    ),
    el('p', { class: 'snote' },
      `模型 ${s.model || '—'} · 生成于 ${new Date(s.updated_at || s.created_at).toLocaleString('zh-CN', { hour12: false })}`),
  ].filter(Boolean);
}

function openScript(id) {
  let current = null;
  let timer = null;
  let stopped = false;

  const body = el('div', { class: 'modal-body sdetail' },
    el('div', { class: 'sprog' }, el('span', { class: 'spin' }), el('div', {}, el('b', {}, '正在读取脚本…'))));
  const m = openModal({
    title: '脚本详情',
    body,
    wide: true,
    onClose: () => { stopped = true; clearTimeout(timer); },
  });
  m.card.classList.add('script-modal');

  // 两步确认，避免在弹层里再叠一个确认框
  const delBtn = el('button', { class: 'btn btn-ghost' }, '删除');
  let armed = false;
  delBtn.addEventListener('click', async () => {
    if (!current) return;
    if (!armed) {
      armed = true;
      delBtn.textContent = '确认删除？';
      delBtn.classList.add('btn-danger');
      setTimeout(() => {
        armed = false;
        delBtn.textContent = '删除';
        delBtn.classList.remove('btn-danger');
      }, 4000);
      return;
    }
    try {
      await api('/scripts/' + current.id, { method: 'DELETE' });
      stopped = true;
      clearTimeout(timer);
      closeModal();
      toast('脚本已删除');
      if (S.view === 'scripts') loadScripts();
      refreshStats();
    } catch (e) { toast(e.message, 'err'); }
  });

  const actions = {
    delBtn,
    retry: async () => {
      if (!current) return;
      try {
        await api(`/scripts/${current.id}/retry`, { method: 'POST' });
        toast('已重新提交拆解');
        paint({ ...current, status: 'pending', error: '' });
        poll();
      } catch (e) { toast(e.message, 'err'); }
    },
  };

  function paint(s, stale = false) {
    current = s;
    const h = m.card.querySelector('.modal-head h3');
    if (h) h.textContent = s.title || '脚本详情';
    body.replaceChildren(...scriptDetail(s, actions, stale));
  }

  let polls = 0;
  async function poll() {
    clearTimeout(timer);
    if (stopped) return;
    try {
      const { script } = await api('/scripts/' + id);
      if (stopped) return;
      const overdue = polls >= 120;   // ~5 分钟上限：任务卡死时不再无限轮询
      paint(script, overdue);
      if (script.status === 'pending' || script.status === 'running') {
        if (overdue) return;
        polls++;
        timer = setTimeout(poll, 2600);
      } else {
        refreshStats();
        if (S.view === 'scripts') loadScripts();
      }
    } catch (e) {
      if (!stopped) body.replaceChildren(emptyState({ icon: '!', title: '读取失败', message: e.message }));
    }
  }

  poll();
}

/** 触发拆解：从抽屉或列表调用；给了 scriptId 就是在这条上重拆 */
async function analyzeVideo(v, onNew, scriptId = null) {
  try {
    const r = scriptId
      ? { script: (await api(`/scripts/${scriptId}/retry`, { method: 'POST' })).job }
      : await api(`/videos/${v.id}/analyze`, { method: 'POST' });
    toast(r.script.status === 'done' ? '已生成脚本' : '已提交 AI 拆解');
    onNew?.(r.script);
    openScript(r.script.id);
  } catch (e) { toast(e.message, 'err'); }
}

function aiRow(k, v, cls = '') {
  return el('div', { class: 'ai-row' },
    el('span', { class: 'k' }, k),
    el('span', { class: 'v ' + cls }, v ?? '—'));
}

function openAiPanel() {
  const body = el('div', { class: 'modal-body' },
    el('div', { class: 'sprog' }, el('span', { class: 'spin' }), el('div', {}, el('b', {}, '正在检查中转站…'))));
  openModal({
    title: 'AI 中转站状态',
    body,
    footer: [
      S.user?.role === 'admin'
        ? el('button', { class: 'btn btn-primary', onclick: () => { closeModal(); switchView('settings'); } }, '去设置')
        : null,
      el('button', { class: 'btn btn-ghost', onclick: () => closeModal() }, '关闭'),
    ],
  });
  api('/ai/status').then(st => {
    S.ai = st;
    body.replaceChildren(
      el('div', { class: 'ai-grid' },
        aiRow('接入地址', st.baseUrl),
        aiRow('模型', st.model),
        aiRow('API Key', st.hasKey ? '已配置' : '未配置', st.hasKey ? 'ok' : 'err'),
        aiRow('连通性', st.reachable ? '正常' : (st.error || '不可达'), st.reachable ? 'ok' : 'err'),
      ),
      (st.models || []).length
        ? el('div', {},
            el('div', { class: 'mini-lbl', style: { marginBottom: '7px' } }, `可用模型 ${st.models.length}`),
            el('div', { class: 'ai-models' }, ...st.models.slice(0, 30).map(x => el('span', { class: 'pill' }, x))))
        : null,
      el('p', { class: 'snote' }, st.hasKey
        ? '拆解时只把抽出来的关键帧（base64）发给模型，视频文件不出内网。'
        : '还没配置密钥：管理员到「系统设置 → AI 脚本拆解」填好保存即可，无需重启。'),
    );
  }).catch(e => {
    body.replaceChildren(emptyState({ icon: '!', title: '检查失败', message: e.message }));
  });
}

async function refreshStats() {
  try {
    const [s, pipe] = await Promise.all([
      api('/stats'),
      api('/pipeline?space=' + S.space).catch(() => null),
    ]);
    S.stats = s;
    if (pipe) S.pipeline = pipe;
    document.querySelector('[data-cnt="daily"]').textContent = s.dailyToday || '';
    document.querySelector('[data-cnt="library"]').textContent = s.library || '';
    document.querySelector('[data-cnt="requests"]').textContent = s.requestsOpen || '';
    document.querySelector('[data-cnt="members"]').textContent = s.members || '';
    const scrEl = document.querySelector('[data-cnt="scripts"]');
    if (scrEl) scrEl.textContent = s.scripts || '';
    document.getElementById('todayDl').textContent = s.downloadsToday ?? 0;
    if (s.scanDir) {
      const dirEl = document.getElementById('scanDir');
      dirEl.textContent = s.scanDir;
      dirEl.title = s.scanDir;
    }
    const scan = s.scan || {};
    const box = document.getElementById('scanBox');
    const txt = document.getElementById('scanText');
    if (scan.running) {
      box.classList.add('busy');
      txt.textContent = '扫描中…';
    } else {
      box.classList.remove('busy');
      txt.textContent = scan.lastError
        ? '目录不可读'
        : scan.lastRunAt
          ? `上次 ${timeAgo(scan.lastRunAt)}${scan.lastResult?.added ? ` · 新增 ${scan.lastResult.added}` : ''}`
          : '等待首次扫描';
    }
  } catch { /* 静默 */ }
}

/* ========================= 渲染：视频 ========================= */
function renderList() {
  const view = $('#view');
  view.innerHTML = '';

  if (!S.items.length) {
    view.append(emptyState({
      icon: S.view === 'library' ? '◇' : '▦',
      title: S.q ? '没有匹配的素材' : (S.view === 'library' ? '素材库还是空的' : '这一天还没有素材'),
      message: S.q
        ? '换个关键词，或清空搜索条件试试'
        : (S.view === 'library' ? '把好用的通用素材传进素材库，团队随时取用' : '拍摄投递到 NAS 目录后会自动出现，也可以直接上传'),
      action: el('button', { class: 'btn btn-primary', onclick: openUploader }, '↑ 上传视频'),
    }));
    return;
  }

  const wrap = S.layout === 'grid' ? el('div', { class: 'grid' }) : el('div', { class: 'list' });

  for (const v of S.items) {
    const props = {
      selected: S.selected.has(v.id),
      onToggle: () => toggleSelect(v.id),
      onOpen: () => { isMobileLike() ? openFeed(S.items, v.id) : openVideo(v.id); },
      onRate: (video, rating) => rateVideo(video, rating),
    };
    wrap.append(S.layout === 'grid' ? videoCard(v, props) : videoRow(v, props));
  }
  view.append(wrap);

  if (S.items.length < S.total) {
    view.append(el('div', { style: { display: 'flex', justifyContent: 'center', marginTop: '20px' } },
      el('button', {
        class: 'btn btn-ghost',
        onclick: async () => {
          S.offset = S.items.length;
          await loadVideos(true);
        },
      }, `加载更多（还有 ${S.total - S.items.length} 条）`),
    ));
  }
}

/* ========================= 评分 ========================= */
async function rateVideo(v, rating) {
  const prev = v.rating;
  v.rating = rating;

  const node = document.querySelector(`[data-id="${v.id}"]`);
  const box = node?.querySelector('.card-rating');
  if (box) {
    box.classList.toggle('has', rating > 0);
    [...box.children].forEach((star, idx) => {
      star.classList.toggle('on', rating > idx);
      star.replaceChildren(starIcon(11, rating > idx));
    });
  }

  try {
    await api('/videos/' + v.id, { method: 'PATCH', body: { rating } });
    if (S.filter === 'starred' || S.filter === 'star4') reload();
  } catch (e) {
    v.rating = prev;
    toast(e.message, 'err');
    renderList();
  }
}

function openBulkRate() {
  const ids = [...S.selected];
  if (!ids.length) return;
  let picked = 0;
  const row = el('div', { class: 'stars-lg', style: { justifyContent: 'center', margin: '6px 0 4px' } });
  const label = el('div', { class: 'rate-label', style: { textAlign: 'center', marginTop: '10px' } }, '点星星选择评分');

  const paint = () => {
    row.replaceChildren(...Array.from({ length: 5 }, (_, i) =>
      el('button', {
        class: picked > i ? 'on' : '',
        onclick: () => {
          picked = picked === i + 1 ? 0 : i + 1;
          label.textContent = picked ? `将标记为 ${picked} 星` : '点星星选择评分';
          paint();
        },
      }, starIcon(24, picked > i))));
  };
  paint();

  openModal({
    title: `给 ${ids.length} 条素材评分`,
    body: el('div', { class: 'modal-body', style: { paddingTop: '4px', paddingBottom: '8px' } },
      row,
      label,
      el('p', { style: { fontSize: '11px', color: 'var(--tx3)', textAlign: 'center', marginTop: '14px' } },
        '再点同一颗星可清除评分'),
    ),
    footer: [
      el('button', { class: 'btn btn-ghost', onclick: () => closeModal() }, '取消'),
      el('button', {
        class: 'btn btn-primary',
        onclick: async () => {
          try {
            await api('/videos/bulk-rate', { method: 'POST', body: { ids, rating: picked } });
            closeModal();
            S.selected.clear();
            updateBulkBar();
            toast(picked ? `已标记 ${ids.length} 条为 ${picked} 星` : '已清除评分');
            reload();
          } catch (e) { toast(e.message, 'err'); }
        },
      }, '确定'),
    ],
  });
}

/* ========================= 渲染：需求 ========================= */
function renderRequests() {
  const view = $('#view');
  view.innerHTML = '';

  const c = S.reqCounts || {};
  view.append(el('div', { class: 'stats' },
    statCard('待认领', c.open || 0, 'cy'),
    statCard('进行中', c.claimed || 0, 'am'),
    statCard('已完成', c.done || 0, 'gn'),
    statCard('全部需求', Object.values(c).reduce((a, b) => a + b, 0), ''),
  ));

  if (!S.requests.length) {
    view.append(emptyState({
      icon: '✎',
      title: '还没有视频需求',
      message: '运营可以在这里发布「需要什么样的视频」，拍摄认领后交付，素材自动归到需求下',
      action: el('button', { class: 'btn btn-primary', onclick: openRequestModal }, '＋ 发布第一条需求'),
    }));
    return;
  }

  const grid = el('div', { class: 'req-grid' });
  for (const q of S.requests) {
    grid.append(requestCard(q, {
      me: S.user,
      onOpen: () => openRequestDetail(q.id),
      onClaim: () => claimRequest(q.id),
    }));
  }
  view.append(grid);
}

/* ========================= 渲染：下载记录 ========================= */
function renderRecords(items) {
  const view = $('#view');
  view.innerHTML = '';

  if (!items.length) {
    view.append(emptyState({
      icon: '↓',
      title: '还没有下载记录',
      message: '运营在选片时点「下载」，这里会自动记下是谁、什么时候、拿了哪几条',
    }));
    return;
  }

  const batches = new Map();
  for (const d of items) {
    if (!batches.has(d.batch_id)) batches.set(d.batch_id, []);
    batches.get(d.batch_id).push(d);
  }

  const head = el('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '14px' } },
    el('span', { class: 'mini-lbl' }, `最近 ${batches.size} 次下载 · 共 ${items.length} 条素材`),
  );
  view.append(head);

  for (const [, batch] of batches) {
    view.append(downloadBatch(batch, { onOpenVideo: id => openVideo(id) }));
  }
}

/* ========================= 渲染：成员 ========================= */
function renderMembers() {
  const view = $('#view');
  view.innerHTML = '';
  view.append(el('div', { class: 'stats' },
    statCard('成员', S.members.length, 'cy'),
    statCard('今日下载', S.stats?.downloadsToday ?? 0, 'gn'),
    statCard('评论总数', S.stats?.commentsTotal ?? 0, 'am'),
    statCard('已评分素材', S.stats?.rated ?? 0, ''),
  ));

  const grid = el('div', { class: 'mem-grid' });
  for (const u of S.members) {
    const canManage = S.user.role === 'admin' && u.id !== S.user.id;
    grid.append(el('div', { class: 'mem' },
      avatar(u.name, u.color, 36),
      el('div', { style: { minWidth: 0 } },
        el('div', { class: 'mem-name' }, u.name, u.id === S.user.id
          ? el('span', { style: { fontSize: '10px', color: 'var(--cy)', marginLeft: '6px' } }, '我')
          : null),
        el('div', { class: 'mem-role' },
          { admin: '管理员', ops: '运营', shooter: '拍摄', viewer: '只读' }[u.role] || u.role,
          u.notify_key ? el('span', { class: 'mem-at', title: `通知账号 ${u.notify_key}` }, '可@') : null),
      ),
      S.user.role === 'admin'
        ? el('button', {
            class: 'icon-btn',
            title: u.notify_key ? `通知账号：${u.notify_key}（点击修改）` : '配置通知账号（群里真实艾特用）',
            onclick: () => openNotifyKeyModal(u),
          }, '@')
        : null,
      canManage
        ? el('button', {
            class: 'icon-btn',
            title: '移除成员',
            onclick: async () => {
              if (!await confirmDialog({ title: '移除成员', message: `确认移除「${u.name}」？历史下载与评论记录会保留。`, confirmText: '移除', danger: true })) return;
              try { await api('/users/' + u.id, { method: 'DELETE' }); toast('已移除'); loadMembers(); refreshStats(); }
              catch (e) { toast(e.message, 'err'); }
            },
          }, '✕')
        : null,
    ));
  }
  view.append(grid);

  view.append(el('div', { style: { marginTop: '18px' } },
    el('button', { class: 'btn', onclick: openJoinModal }, '＋ 添加成员'),
  ));
}

/* ---- 管理员配成员通知账号（群机器人真实艾特用的标识） ---- */
async function openNotifyKeyModal(u) {
  let cfg = null;
  try { cfg = await api('/settings/notify'); } catch { /* 通知未配置也能先填 */ }
  const hintText = {
    wecom: '填该成员在企业微信的 userid（企业微信管理后台 → 通讯录可查），群机器人艾特按 userid 匹配。',
    feishu: '填该成员的飞书 user_id / open_id（飞书管理后台或开放平台可查），机器人艾特按它匹配。',
    dingtalk: '填该成员的钉钉手机号（企业通讯录里的手机号），群里艾特按手机号匹配。',
  }[cfg?.type || 'wecom'];
  const input = el('input', {
    type: 'text', value: u.notify_key || '', maxlength: 64,
    placeholder: cfg?.type === 'dingtalk' ? '13xxxxxxxxx' : '如 zhangsan',
  });
  openModal({
    title: `通知账号 · ${u.name}`,
    body: el('div', { class: 'modal-body' },
      el('div', { class: 'field' },
        el('label', {}, '通知账号（群里真实艾特用的标识）'),
        input,
        el('p', { style: { fontSize: '10.5px', color: 'var(--tx3)', lineHeight: 1.6, marginTop: '6px' } },
          cfg?.url ? hintText : '群通知还没配置 webhook，可以先填上；到「系统 → 系统设置 → 群通知」配置后生效。'),
      ),
    ),
    footer: [
      el('button', { class: 'btn btn-ghost', onclick: () => closeModal() }, '取消'),
      el('button', {
        class: 'btn btn-primary',
        onclick: async () => {
          try {
            await api('/users/' + u.id, { method: 'PATCH', body: { notify_key: input.value.trim() } });
            closeModal();
            toast(input.value.trim() ? '通知账号已保存' : '已清空通知账号');
            u.notify_key = input.value.trim() || null;
            loadMembers();
          } catch (e) { toast(e.message, 'err'); }
        },
      }, '保存'),
    ],
  });
  setTimeout(() => input.focus(), 60);
}

/* ---- 管理员添加成员 ---- */
function openJoinModal() {
  const name = el('input', { type: 'text', placeholder: '成员名字', maxlength: 24 });
  const roleSel = el('select', {},
    el('option', { value: 'ops' }, '运营（选片 / 下载 / 发需求）'),
    el('option', { value: 'shooter' }, '拍摄（上传 / 认领需求）'),
    el('option', { value: 'viewer' }, '只读（浏览 / 评论）'),
    el('option', { value: 'admin' }, '管理员（管理成员）'),
  );
  const pw = el('input', { type: 'password', placeholder: '初始密码，至少 6 位', autocomplete: 'new-password' });

  openModal({
    title: '添加成员',
    body: el('div', { class: 'modal-body' },
      el('div', { class: 'field' }, el('label', {}, '名字（登录账号）'), name),
      el('div', { class: 'field' }, el('label', {}, '角色'), roleSel),
      el('div', { class: 'field' },
        el('label', {}, '初始密码'),
        pw,
        el('p', { style: { fontSize: '10.5px', color: 'var(--tx3)', lineHeight: 1.6 } },
          '把名字和密码告诉成员，对方登录后可以自行修改。'),
      ),
    ),
    footer: [
      el('button', { class: 'btn btn-ghost', onclick: () => closeModal() }, '取消'),
      el('button', {
        class: 'btn btn-primary',
        onclick: async () => {
          if (!name.value.trim()) return toast('请填写名字', 'err');
          if (pw.value.length < 6) return toast('密码至少 6 位', 'err');
          try {
            await api('/users', { method: 'POST', body: { name: name.value.trim(), role: roleSel.value, password: pw.value } });
            closeModal();
            toast('成员已添加');
            loadMembers();
            refreshStats();
          } catch (e) { toast(e.message, 'err'); }
        },
      }, '添加'),
    ],
  });
  setTimeout(() => name.focus(), 60);
}

/* ========================= 选择 & 批量 ========================= */
function toggleSelect(id) {
  if (S.selected.has(id)) S.selected.delete(id);
  else S.selected.add(id);
  updateBulkBar();
  const node = document.querySelector(`[data-id="${id}"]`);
  if (node) {
    node.classList.toggle('sel', S.selected.has(id));
    node.querySelector('.cb')?.classList.toggle('on', S.selected.has(id));
  }
}

function updateBulkBar() {
  const bar = document.getElementById('bulkbar');
  if (!S.selected.size) { bar.hidden = true; return; }
  bar.hidden = false;
  document.getElementById('bulkNum').textContent = S.selected.size;
}

async function onBulkAction(e) {
  const act = e.target.closest('button')?.dataset.act;
  if (!act) return;
  const ids = [...S.selected];
  if (act === 'clear') {
    S.selected.clear();
    updateBulkBar();
    renderList();
    return;
  }
  if (act === 'rate') {
    openBulkRate();
    return;
  }
  if (act === 'pick') {
    try {
      await api('/videos/bulk-status', { method: 'POST', body: { ids, status: 'picked' } });
      toast(`已标记 ${ids.length} 条为已选`);
      S.selected.clear();
      updateBulkBar();
      reload();
    } catch (err) { toast(err.message, 'err'); }
    return;
  }
  if (act === 'library') {
    try {
      for (const id of ids) await api('/videos/' + id, { method: 'PATCH', body: { space: 'library' } });
      toast(`已存入素材库 ${ids.length} 条`);
      S.selected.clear();
      updateBulkBar();
      reload();
      refreshStats();
    } catch (err) { toast(err.message, 'err'); }
    return;
  }
  if (act === 'qc') {
    try {
      await api('/videos/bulk-qc', { method: 'POST', body: { ids } });
      toast(`已加入体检队列（${ids.length} 条），稍后刷新可见结果`);
      S.selected.clear();
      updateBulkBar();
    } catch (err) { toast(err.message, 'err'); }
    return;
  }
  if (act === 'analyze') {
    if (!await confirmDialog({
      title: 'AI 批量拆解',
      message: `将把 ${ids.length} 条素材加入拆解队列。每条会抽 6 张关键帧调一次多模态模型，视频多时需要几分钟，完成结果进「脚本库」。`,
      confirmText: '开始拆解',
    })) return;
    S.selected.clear();
    updateBulkBar();
    let ok = 0, bad = 0;
    const queue = [...ids];
    const worker = async () => {
      while (queue.length) {
        const id = queue.shift();
        try { await api(`/videos/${id}/analyze`, { method: 'POST' }); ok++; }
        catch { bad++; }
      }
    };
    toast(`已提交 ${ids.length} 条，正在排队拆解…`, 'ok', 2000);
    await Promise.all([worker(), worker(), worker()]);
    toast(bad ? `提交完成：${ok} 条成功，${bad} 条失败` : `已提交 ${ok} 条，稍后到「脚本库」查看`, bad ? 'err' : 'ok');
    refreshStats();
    return;
  }
  if (act === 'export') {
    const url = `/api/export.csv?ids=${ids.join(',')}&uid=${encodeURIComponent(S.user.id)}`;
    const a = document.createElement('a');
    a.href = url;
    a.rel = 'noopener';
    document.body.append(a);
    a.click();
    a.remove();
    toast(`已导出 ${ids.length} 条素材清单`);
    return;
  }
  if (act === 'zip') {
    await doDownload(ids);
  }
}

async function doDownload(ids, note = '') {
  try {
    toast(ids.length > 1 ? `正在打包 ${ids.length} 条素材…` : '开始下载…', 'ok', 1800);
    const r = await api('/downloads', { method: 'POST', body: { videoIds: ids, note } });
    const url = r.downloadUrl + '?uid=' + encodeURIComponent(S.user.id);
    const a = document.createElement('a');
    a.href = url;
    a.rel = 'noopener';
    document.body.append(a);
    a.click();
    a.remove();
    S.selected.clear();
    updateBulkBar();
    setTimeout(() => { reload(); refreshStats(); }, 1200);
  } catch (e) { toast(e.message, 'err'); }
}

/* ========================= 抽屉：播放 + 详情 + 评论 ========================= */

/* ---- 评论 @ 成员：插入 + 下拉选人（群里推送时真实艾特） ---- */
let atMenuRef = null;   // { el, btn }：当前打开的选人菜单
function closeAtMenu() {
  if (!atMenuRef) return;
  atMenuRef.el.remove();
  atMenuRef = null;
}
document.addEventListener('click', e => {
  if (atMenuRef && !atMenuRef.el.contains(e.target) && !atMenuRef.btn.contains(e.target)) closeAtMenu();
}, true);

function insertAtCursor(input, name) {
  const pos = input.selectionStart ?? input.value.length;
  const before = input.value.slice(0, pos);
  const after = input.value.slice(input.selectionEnd ?? pos);
  const pad = before && !/\s$/.test(before) ? ' ' : '';
  const text = `${pad}@${name} `;
  input.value = before + text + after;
  const np = (before + text).length;
  input.focus();
  input.setSelectionRange(np, np);
}

async function toggleAtMenu(input, btn, anchor) {
  if (atMenuRef) { closeAtMenu(); return; }
  let members = S.members || [];
  if (!members.length) {
    try { members = (await api('/users')).items || []; S.members = members; }
    catch (e) { toast(e.message, 'err'); return; }
  }
  const list = members.filter(u => u.id !== S.user.id);
  if (!list.length) return;
  const menu = el('div', { class: 'at-menu' },
    ...list.map(u => el('button', {
      type: 'button',
      title: u.notify_key ? '已配通知账号：群里能真实艾特到' : '未配通知账号：只会以文字出现',
      onclick: ev => { ev.preventDefault(); ev.stopPropagation(); insertAtCursor(input, u.name); closeAtMenu(); },
    },
      avatarMini(u.name, u.color),
      el('span', { class: 'n' }, u.name),
      u.notify_key ? el('i', { class: 'at-ok' }, '@') : el('i', { class: 'at-no' }, '未配'),
    )));
  anchor.append(menu);
  atMenuRef = { el: menu, btn };
}

/** 评论正文里的 @名字 高亮（不拼 HTML，逐段建节点） */
function cmtBodyNodes(body) {
  return String(body || '')
    .split(/(@[^\s，。,.!?！？、；;:：]{1,24})/g)
    .filter(Boolean)
    .map(part => part.startsWith('@') && part.length > 1
      ? el('span', { class: 'at-hl' }, part)
      : part);
}

async function openVideo(id) {
  const root = document.getElementById('drawer');
  root.hidden = false;
  root.innerHTML = '';
  root.append(
    el('div', { class: 'drawer-mask', onclick: closeDrawer }),
    el('div', { class: 'drawer-panel' }, el('div', { style: { padding: '40px', textAlign: 'center' } }, el('span', { class: 'spin' }))),
  );

  let data;
  try {
    // 素材详情和已有脚本并行拉，抽屉不用多等一拍；脚本接口失败不影响打开
    const [d, sr] = await Promise.all([
      api('/videos/' + id),
      api('/scripts?videoId=' + id).catch(() => ({ items: [] })),
    ]);
    data = d;
    data.scripts = sr.items || [];
  } catch (e) {
    root.innerHTML = '';
    root.append(el('div', { class: 'drawer-mask', onclick: closeDrawer }),
      el('div', { class: 'drawer-panel' }, emptyState({ icon: '!', title: '打开失败', message: e.message })));
    return;
  }
  renderDrawer(data);
}

function closeDrawer() {
  const root = document.getElementById('drawer');
  root.hidden = true;
  root.innerHTML = '';
  S.drawerScripts = [];
}

function renderDrawer({ video: v, comments, downloads, siblings, similar, scripts }) {
  const root = document.getElementById('drawer');
  root.innerHTML = '';
  if (scripts) S.drawerScripts = scripts;
  const myScripts = S.drawerScripts || [];
  const landscape = v.width > v.height;

  const player = el('div', { class: 'player' + (landscape ? ' landscape' : '') });
  const vidEl = el('video', {
    src: mediaUrl(`/api/videos/${v.id}/play`),
    controls: true,
    autoplay: true,
    playsinline: true,
    poster: v.thumb_path ? mediaUrl(`/api/videos/${v.id}/thumb`) : '',
  });
  player.append(vidEl);

  // 手机原片多是 HEVC，浏览器解不了时服务端正在现转 H.264 播放版 → 自动等待重试
  let playRetry = 0;
  vidEl.addEventListener('error', () => {
    if (playRetry >= 4) { toast('这条视频暂时无法播放，稍后再试或先下载', 'err'); return; }
    playRetry++;
    toast('正在生成流畅播放版，稍等几秒…');
    setTimeout(() => {
      vidEl.src = mediaUrl(`/api/videos/${v.id}/play`) + '&_r=' + Date.now();
      vidEl.play?.().catch(() => {});
    }, 4000);
  });
  // 播放版还在转时给个提示（首次可能等十几秒，之后秒开）
  if (v.proxy_state === 'pending' || v.proxy_state === 'running') {
    toast('首次播放会先转出流畅版，稍等一下就好', 'ok', 3200);
  }

  const scroll = el('div', { class: 'drawer-scroll' });

  // ---- 标题与规格 ----
  const sec1 = el('div', { class: 'dsec' },
    el('h3', { class: 'dtitle' }, v.title || v.orig_name),
    el('div', { class: 'dmeta' },
      el('span', {}, '⏱ ', el('b', {}, fmtDuration(v.duration))),
      v.width ? el('span', {}, `${v.width}×${v.height}`) : null,
      el('span', {}, fmtBytes(v.size)),
      el('span', {}, `${v.shoot_date}`),
      el('span', {}, v.source === 'scan' ? '目录投递' : '网页上传'),
    ),
    el('div', { class: 'dmeta', style: { marginTop: '8px' } },
      avatarMini(v.uploader_name || '投递', v.uploader_color || '#5A6376'),
      el('span', {}, v.uploader_name || '目录投递'),
      el('span', { style: { opacity: .4 } }, '·'),
      el('span', {}, `入库 ${timeAgo(v.created_at)}`),
      el('span', { style: { opacity: .4 } }, '·'),
      el('button', {
        class: 'btn btn-ghost sm',
        title: 'TikTok 式竖滑播放 + 可勾选原生界面遮罩',
        onclick: () => openFeed(S.items?.length ? S.items : [v], v.id),
      }, '▶ 竖滑模式'),
    ),
    v.orig_name && v.orig_name !== v.title
      ? el('div', { style: { fontSize: '10.5px', color: 'var(--tx3)', marginTop: '8px', wordBreak: 'break-all' } }, `原文件名：${v.orig_name}`)
      : null,
    el('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', marginTop: '10px' } },
      el('span', { class: 'mini-lbl' }, '标签'),
      v.tags
        ? el('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } },
            ...v.tags.split(',').filter(Boolean).map(t => el('span', { class: 'pill' }, t)))
        : el('span', { style: { fontSize: '11px', color: 'var(--tx3)' } }, '未打标签'),
      el('button', { class: 'btn btn-ghost sm', onclick: () => openEditVideo(v) }, '编辑'),
    ),
  );

  // ---- 操作 ----
  const dlCount = downloads.length;
  const lastDl = downloads[0];

  const rateLabel = el('span', { class: 'rate-label' },
    v.rating ? `${v.rating} 星` : '未评分');
  const starsBox = el('div', { class: 'stars-lg' });
  const paintStars = () => {
    rateLabel.textContent = v.rating ? `${v.rating} 星` : '未评分';
    starsBox.replaceChildren(...Array.from({ length: 5 }, (_, i) =>
      el('button', {
        class: v.rating > i ? 'on' : '',
        title: `${i + 1} 星`,
        onclick: async () => {
          const next = v.rating === i + 1 ? 0 : i + 1;
          v.rating = next;
          paintStars();
          try {
            await api('/videos/' + v.id, { method: 'PATCH', body: { rating: next } });
            if (S.filter === 'starred' || S.filter === 'star4') reload();
          } catch (e) { toast(e.message, 'err'); }
        },
      }, starIcon(20, v.rating > i))));
  };
  paintStars();

  const actSec = el('div', { class: 'dsec' },
    el('div', { class: 'rate-row' },
      el('span', { class: 'mini-lbl' }, '评分'),
      starsBox,
      rateLabel,
    ),
    el('div', { class: 'dactions' },
      el('button', {
        class: 'btn btn-primary',
        onclick: () => doDownload([v.id]),
      }, '↓ 下载'),
      el('button', {
        class: 'btn btn-ghost',
        onclick: async () => {
          const next = v.status === 'picked' ? 'new' : 'picked';
          try {
            await api('/videos/' + v.id, { method: 'PATCH', body: { status: next } });
            v.status = next;
            toast(next === 'picked' ? '已标记为已选' : '已取消标记');
            closeDrawer();
            reload();
          } catch (e) { toast(e.message, 'err'); }
        },
      }, v.status === 'picked' ? '★ 已选' : '☆ 标为已选'),
      el('button', {
        class: 'btn btn-ghost',
        onclick: async () => {
          try {
            await api('/videos/' + v.id, { method: 'PATCH', body: { space: v.space === 'library' ? 'daily' : 'library' } });
            toast(v.space === 'library' ? '已移回每日选片' : '已存入素材库');
            closeDrawer();
            reload();
            refreshStats();
          } catch (e) { toast(e.message, 'err'); }
        },
      }, v.space === 'library' ? '移回每日' : '存素材库'),
      el('button', {
        class: 'btn btn-ghost',
        onclick: () => openEditVideo(v),
      }, '编辑'),
    ),
    el('div', { style: { marginTop: '12px', fontSize: '11.5px', color: 'var(--tx3)' } },
      dlCount
        ? el('span', {}, `已被下载 ${dlCount} 次`, lastDl ? el('span', { style: { color: 'var(--tx2)' } }, ` · 最近：${lastDl.user_name} ${timeAgo(lastDl.created_at)}`) : null)
        : '还没有人下载这条素材',
    ),
  );

  // ---- 投放体检 ----
  const flags = qcFlags(v);
  const scoreCls = v.qc_score == null ? '' : v.qc_score >= 80 ? 'good' : v.qc_score >= 60 ? 'mid' : 'bad';
  const cell = (label, value, hint) => el('div', { class: 'qc-cell', title: hint || '' },
    el('b', {}, value), el('span', {}, label));

  const recheck = async () => {
    toast('正在体检，稍等…', 'ok', 1500);
    try {
      await api(`/videos/${v.id}/qc`, { method: 'POST' });
      const fresh = await api('/videos/' + v.id);
      renderDrawer(fresh);
      reload();
      toast('体检完成');
    } catch (e) { toast(e.message, 'err'); }
  };

  const qcSec = v.space === 'library'
    ? el('div', { class: 'dsec' },
        el('div', { class: 'qc-head' },
          el('div', { class: 'qc-score' }, '—'),
          el('div', { style: { flex: 1, minWidth: 0 } },
            el('div', { class: 'qc-title' }, '素材库资料不参与投放体检'),
            el('div', { class: 'qc-sub' }, '素材库存的是通用素材 / 参考资料；只有「每日选片」里的投放素材才做体检'),
          ),
        ))
    : el('div', { class: 'dsec' },
    el('div', { class: 'qc-head' },
      el('div', { class: `qc-score ${scoreCls}` }, v.qc_status === 'pending' ? '…' : (v.qc_score == null ? '—' : String(v.qc_score))),
      el('div', { style: { flex: 1, minWidth: 0 } },
        el('div', { class: 'qc-title' },
          '投放体检 · ' + (v.qc_status === 'pending' ? '排队中'
            : v.qc_status === 'failed' ? '体检失败（文件可能读不了）'
              : v.qc_score >= 80 ? '各项正常，可以投放'
                : v.qc_score >= 60 ? '有风险项，建议处理后投放'
                  : '问题较多，不建议直接投放')),
        el('div', { class: 'qc-sub' },
          flags.length ? flags.map(f => QC_LABELS[f] || f).join(' · ') : '未发现明显问题'),
      ),
      el('button', { class: 'btn btn-ghost sm', onclick: recheck }, '重新体检'),
    ),
    el('div', { class: 'qc-grid' },
      cell('响度 LUFS', v.has_audio === 0 ? '无音轨' : (v.lufs == null ? '—' : Number(v.lufs).toFixed(1)), 'EBU R128 建议 -16 ~ -12'),
      cell('峰值 dB', v.peak_db == null ? '—' : Number(v.peak_db).toFixed(1), '避免削波'),
      cell('黑边', flags.includes('letterbox') ? (v.crop || '有') : '无', '实际画面区域小于原尺寸 92% 判为有黑边'),
      cell('静止占比', `${Math.round(v.freeze_pct || 0)}%`, '超过 15% 会拉低完播'),
      cell('编码', v.codec ? `${v.codec}${v.codec === 'h264' ? '' : ' ⚠'}` : '—', '浏览器原生支持 H.264'),
      cell('帧率', v.fps ? `${Number(v.fps).toFixed(1)}` : '—', ''),
    ),
    similar && similar.length
      ? el('div', { style: { marginTop: '12px' } },
          el('div', { class: 'mini-lbl', style: { marginBottom: '7px' } }, `相似素材 ${similar.length}`),
          el('div', { class: 'sim-row' },
            ...similar.map(s => el('div', {
              class: 'sim-item',
              title: s.sim_dist != null ? `画面距离 ${s.sim_dist}` : '',
              onclick: () => openVideo(s.id),
            },
              el('div', { class: 'th' },
                s.thumb_path ? el('img', { src: mediaUrl(`/api/videos/${s.id}/thumb`), loading: 'lazy', alt: '' }) : null),
              el('p', {}, s.title || s.orig_name || '—'),
            )),
          ),
        )
      : null,
  );   // 三元结束：素材库（不体检） / 常规体检分支

  // ---- 内容评分（分维度）+ 阶段流转 ----
  const sc = parseScores(v.scores);
  const totalScoreEl = el('div', {
    class: 'qc-score' + (v.score_content == null ? '' : v.score_content >= 80 ? ' good' : v.score_content >= 60 ? ' mid' : ' bad'),
  }, v.score_content == null ? '—' : String(v.score_content));

  const paintTotal = cs => {
    v.score_content = cs;
    totalScoreEl.textContent = cs == null ? '—' : String(cs);
    totalScoreEl.className = 'qc-score ' + (cs == null ? '' : cs >= 80 ? 'good' : cs >= 60 ? 'mid' : 'bad');
  };

  const saveScores = async patch => {
    const merged = { ...sc, ...patch };
    try {
      const res = await api('/videos/' + v.id, { method: 'PATCH', body: { scores: merged } });
      Object.assign(sc, merged);
      paintTotal(res.video.score_content);
    } catch (e) { toast(e.message, 'err'); }
  };

  const scRows = DIMS.map(d => {
    const val = Number(sc[d.key]) || 0;
    const out = el('span', { class: 'sc-val' }, val ? String(val) : '—');
    const range = el('input', {
      type: 'range', min: '0', max: '10', step: '1', value: String(val), class: 'sc-range', title: d.hint,
    });
    range.addEventListener('input', () => { out.textContent = range.value; });
    range.addEventListener('change', () => saveScores({ [d.key]: Number(range.value) }));
    return el('div', { class: 'sc-row' },
      el('span', { class: 'sc-lbl', title: d.hint }, d.label), range, out);
  });

  const stageRow = el('div', { class: 'stagepick' },
    ...STAGES.map(s => el('button', {
      class: 'spick' + (v.stage === s.key ? ' on' : ''),
      onclick: async ev => {
        try {
          await api('/videos/' + v.id, { method: 'PATCH', body: { stage: s.key } });
          v.stage = s.key;
          ev.currentTarget.parentElement.querySelectorAll('.spick')
            .forEach(b => b.classList.toggle('on', b === ev.currentTarget));
          toast(`已移到「${s.label}」`);
          reload();
          refreshStats();
        } catch (e) { toast(e.message, 'err'); }
      },
    }, s.label)));

  const scoreSec = el('div', { class: 'dsec' },
    el('div', { class: 'qc-head' },
      totalScoreEl,
      el('div', { style: { flex: 1, minWidth: 0 } },
        el('div', { class: 'qc-title' }, '内容评分'),
        el('div', { class: 'qc-sub' }, '5 个维度各 0-10 分，综合分 = 均分 ×10；比单一星标更容易定位短板'),
      ),
    ),
    el('div', { class: 'sc-list' }, ...scRows),
    el('div', { class: 'mini-lbl', style: { marginTop: '12px', display: 'block' } }, '流水线阶段'),
    stageRow,
  );

  // ---- 评论 ----
  const cmtList = el('div', {});
  const renderComments = list => {
    cmtList.innerHTML = '';
    if (!list.length) {
      cmtList.append(el('div', { style: { fontSize: '11.5px', color: 'var(--tx3)', padding: '14px 0' } }, '还没有评论，说说这条素材能不能用'));
      return;
    }
    for (const c of list) {
      cmtList.append(el('div', { class: 'cmt' },
        avatar(c.user_name, c.user_color, 28),
        el('div', { class: 'cmt-body' },
          el('div', { class: 'cmt-top' },
            el('span', { class: 'cmt-name' }, c.user_name),
            el('span', { class: 'cmt-time' }, timeAgo(c.created_at)),
            c.user_id === S.user.id || S.user.role === 'admin'
              ? el('span', {
                  class: 'cmt-del',
                  onclick: async () => {
                    try {
                      await api('/comments/' + c.id, { method: 'DELETE' });
                      renderComments(list.filter(x => x.id !== c.id));
                    } catch (e) { toast(e.message, 'err'); }
                  },
                }, '删除')
              : null,
          ),
          el('div', { class: 'cmt-text' }, ...cmtBodyNodes(c.body)),
        ),
      ));
    }
  };
  renderComments(comments);

  const cmtSec = el('div', { class: 'dsec' },
    el('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' } },
      el('span', { class: 'mini-lbl' }, `评论 ${comments.length}`),
    ),
    cmtList,
  );

  // ---- AI 脚本 ----
  const aiList = el('div', { class: 'ai-list' });
  const paintAi = () => {
    if (!myScripts.length) {
      aiList.replaceChildren(el('p', { class: 'ai-empty' },
        '把这条成片交给 AI，拆出钩子、分镜和能直接开拍的口播稿；结果会自动进「脚本库」。'));
      return;
    }
    aiList.replaceChildren(...myScripts.slice(0, 4).map(s => el('button', {
      class: 'ai-item',
      onclick: () => openScript(s.id),
    },
      scriptBadge(s.status),
      el('span', { class: 't' }, s.title || s.video_title || '待生成标题'),
      el('span', { class: 'tm' }, timeAgo(s.updated_at || s.created_at)),
    )));
  };
  paintAi();

  const aiSec = el('div', { class: 'dsec' },
    el('div', { class: 'ai-head' },
      el('span', { class: 'mini-lbl' }, 'AI 脚本'),
      el('span', { style: { flex: 1 } }),
      el('button', {
        class: 'btn btn-ghost sm',
        onclick: () => {
          // 已有结果就在原记录上重拆，没有才新建
          const prev = myScripts.find(x => x.status === 'done' || x.status === 'failed');
          analyzeVideo(v, job => {
            const rest = myScripts.filter(x => x.id !== job.id);
            myScripts.splice(0, myScripts.length, job, ...rest);
            S.drawerScripts = myScripts;
            paintAi();
          }, prev?.id || null);
        },
      }, myScripts.length ? '✦ 再拆一次' : '✦ AI 拆解'),
    ),
    aiList,
  );

  scroll.append(player, sec1, actSec, aiSec, scoreSec, qcSec);
  if (siblings?.length) {
    scroll.append(el('div', { class: 'dsec' },
      el('div', { class: 'mini-lbl', style: { marginBottom: '8px' } }, '同一需求下的其他素材'),
      el('div', { style: { display: 'flex', gap: '8px', overflowX: 'auto' } },
        ...siblings.map(s => el('div', {
          style: { flex: '0 0 96px', cursor: 'pointer' },
          onclick: () => openVideo(s.id),
        },
          el('div', { style: { width: '96px', height: '58px', borderRadius: '7px', overflow: 'hidden', background: '#0A0C11' } },
            s.thumb_path ? el('img', { src: mediaUrl(`/api/videos/${s.id}/thumb`), style: { width: '100%', height: '100%', objectFit: 'cover' } }) : null),
          el('div', { style: { fontSize: '10px', color: 'var(--tx3)', marginTop: '3px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, s.title),
        )),
      ),
    ));
  }
  scroll.append(cmtSec);

  // ---- 评论输入 ----
  const input = el('textarea', { placeholder: '评论这条素材…（回车发送，Shift+回车换行；@ 可艾特成员）' });
  const send = async () => {
    const body = input.value.trim();
    if (!body) return;
    input.value = '';
    try {
      const r = await api(`/videos/${v.id}/comments`, { method: 'POST', body: { body } });
      comments.push(r.comment);
      renderComments(comments);
      scroll.scrollTop = scroll.scrollHeight;
    } catch (e) { toast(e.message, 'err'); input.value = body; }
  };
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
    // @ 后面紧跟的名字按 esc 关闭菜单
    if (e.key === 'Escape') closeAtMenu();
  });

  const form = el('div', { class: 'cmt-form' },
    el('button', {
      class: 'btn btn-ghost sm at-btn',
      type: 'button',
      title: '艾特成员（配了通知账号的成员会在群里被真实艾特）',
      onclick: e => { e.preventDefault(); e.stopPropagation(); toggleAtMenu(input, e.currentTarget, form); },
    }, '@'),
    input,
    el('button', { class: 'btn btn-primary', onclick: send }, '发送'),
  );

  root.append(
    el('div', { class: 'drawer-mask', onclick: closeDrawer }),
    el('div', { class: 'drawer-panel' },
      el('div', { class: 'drawer-head' },
        el('span', { class: 't' }, v.space === 'library' ? '素材库' : '每日选片'),
        el('button', {
          class: 'icon-btn',
          title: '删除',
          onclick: async () => {
            if (!await confirmDialog({ title: '删除素材', message: '会同时删除服务器上的视频文件和所有评论记录，不可恢复。', confirmText: '删除', danger: true })) return;
            try { await api('/videos/' + v.id, { method: 'DELETE' }); toast('已删除'); closeDrawer(); reload(); refreshStats(); }
            catch (e) { toast(e.message, 'err'); }
          },
        }, icon('trash', 14)),
        el('button', { class: 'icon-btn', onclick: closeDrawer }, '✕'),
      ),
      scroll,
      form,
    ),
  );
}

/* ---- 编辑视频信息 ---- */
function openEditVideo(v) {
  const title = el('input', { type: 'text', value: v.title || '', maxlength: 120 });
  const tags = el('input', { type: 'text', value: v.tags || '', placeholder: '用逗号分隔，例如：厨房,爆款脚本' });
  const date = el('input', { type: 'date', value: v.shoot_date });
  const space = el('select', {},
    el('option', { value: 'daily' }, '每日选片'),
    el('option', { value: 'library' }, '素材库'),
  );
  space.value = v.space;

  openModal({
    title: '编辑素材信息',
    body: el('div', { class: 'modal-body' },
      el('div', { class: 'field' }, el('label', {}, '标题'), title),
      el('div', { class: 'field' }, el('label', {}, '标签（逗号分隔）'), tags),
      el('div', { class: 'field-row' },
        el('div', { class: 'field' }, el('label', {}, '拍摄日期'), date),
        el('div', { class: 'field' }, el('label', {}, '所属空间'), space),
      ),
    ),
    footer: [
      el('button', { class: 'btn btn-ghost', onclick: () => closeModal() }, '取消'),
      el('button', {
        class: 'btn btn-primary',
        onclick: async () => {
          try {
            await api('/videos/' + v.id, {
              method: 'PATCH',
              body: { title: title.value, tags: tags.value, shootDate: date.value, space: space.value },
            });
            closeModal();
            closeDrawer();
            toast('已保存');
            reload();
            refreshStats();
          } catch (e) { toast(e.message, 'err'); }
        },
      }, '保存'),
    ],
  });
}

/* ========================= 需求 ========================= */
function openRequestModal() {
  const title = el('input', { type: 'text', placeholder: '例如：需要 3 条厨房收纳的痛点开场', maxlength: 80 });
  const brief = el('textarea', { placeholder: '具体要什么：产品、场景、时长、出镜要求、参考视频…' });
  const priority = el('select', {},
    el('option', { value: 'normal' }, '普通'),
    el('option', { value: 'high' }, '紧急'),
    el('option', { value: 'low' }, '不着急'),
  );
  const platform = el('select', {},
    el('option', {}, 'TikTok'), el('option', {}, 'TikTok Shop'), el('option', {}, '通用素材'),
  );
  const due = el('input', { type: 'date' });
  const tags = el('input', { type: 'text', placeholder: '用逗号分隔，例如：厨房,开箱' });

  openModal({
    title: '发布视频需求',
    wide: true,
    body: el('div', { class: 'modal-body' },
      el('div', { class: 'field' }, el('label', {}, '需求标题'), title),
      el('div', { class: 'field' }, el('label', {}, '具体描述'), brief),
      el('div', { class: 'field-row' },
        el('div', { class: 'field' }, el('label', {}, '优先级'), priority),
        el('div', { class: 'field' }, el('label', {}, '截止日期'), due),
      ),
      el('div', { class: 'field-row' },
        el('div', { class: 'field' }, el('label', {}, '投放平台'), platform),
        el('div', { class: 'field' }, el('label', {}, '标签'), tags),
      ),
    ),
    footer: [
      el('button', { class: 'btn btn-ghost', onclick: () => closeModal() }, '取消'),
      el('button', {
        class: 'btn btn-primary',
        onclick: async () => {
          if (!title.value.trim()) return toast('请填写标题', 'err');
          try {
            await api('/requests', {
              method: 'POST',
              body: {
                title: title.value, brief: brief.value, priority: priority.value,
                platform: platform.value, dueDate: due.value, tags: tags.value,
              },
            });
            closeModal();
            toast('需求已发布');
            S.reqFilter = 'active';
            renderToolbar();
            loadRequests();
            refreshStats();
          } catch (e) { toast(e.message, 'err'); }
        },
      }, '发布'),
    ],
  });
  setTimeout(() => title.focus(), 60);
}

async function openRequestDetail(id) {
  let data;
  try { data = await api('/requests/' + id); } catch (e) { return toast(e.message, 'err'); }
  const q = data.request;
  const mine = data.claims.some(c => c.id === S.user.id);

  const body = el('div', { class: 'modal-body' },
    el('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '10px', flexWrap: 'wrap' } },
      el('span', { class: `pill ${q.status}` },
        { open: '待认领', claimed: '进行中', done: '已完成', closed: '已关闭' }[q.status]),
      q.priority === 'high' ? el('span', { class: 'pill high' }, '紧急') : null,
      q.due_date ? el('span', { class: 'pill' }, `截止 ${q.due_date}`) : null,
      el('span', { class: 'pill' }, q.platform),
    ),
    el('h3', { style: { fontSize: '17px', fontWeight: 650, lineHeight: 1.4 } }, q.title),
    q.brief ? el('p', { style: { fontSize: '12.5px', color: 'var(--tx2)', lineHeight: 1.75, marginTop: '10px', whiteSpace: 'pre-wrap' } }, q.brief) : null,
    q.tags ? el('div', { style: { display: 'flex', gap: '6px', marginTop: '12px', flexWrap: 'wrap' } },
      ...q.tags.split(',').filter(Boolean).map(t => el('span', { class: 'pill' }, t))) : null,
    el('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', marginTop: '16px', fontSize: '11.5px', color: 'var(--tx3)' } },
      avatarMini(q.creator_name, q.creator_color),
      el('span', {}, `${q.creator_name} 发起 · ${timeAgo(q.created_at)}`),
    ),
    data.claims.length
      ? el('div', { style: { marginTop: '14px' } },
          el('div', { class: 'mini-lbl', style: { marginBottom: '6px' } }, `认领 ${data.claims.length} 人`),
          el('div', { style: { display: 'flex', gap: '10px', flexWrap: 'wrap' } },
            ...data.claims.map(c => el('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '5px', fontSize: '11.5px', color: 'var(--tx2)' } },
              avatarMini(c.name, c.color), c.name))))
      : el('div', { style: { marginTop: '14px', fontSize: '11.5px', color: 'var(--tx3)' } }, '还没有人认领'),
    data.videos.length
      ? el('div', { style: { marginTop: '16px' } },
          el('div', { class: 'mini-lbl', style: { marginBottom: '8px' } }, `已交付 ${data.videos.length} 条`),
          el('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(88px,1fr))', gap: '8px' } },
            ...data.videos.map(v => el('div', {
              style: { cursor: 'pointer' },
              onclick: () => { closeModal(); openVideo(v.id); },
            },
              el('div', { style: { aspectRatio: '16/10', borderRadius: '7px', overflow: 'hidden', background: '#0A0C11' } },
                v.thumb_path ? el('img', { src: mediaUrl(`/api/videos/${v.id}/thumb`), style: { width: '100%', height: '100%', objectFit: 'cover' } }) : null),
              el('div', { style: { fontSize: '9.5px', color: 'var(--tx3)', marginTop: '3px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, v.title),
            )),
          ),
        )
      : null,
  );

  const footer = [];
  if (['open', 'claimed'].includes(q.status)) {
    footer.push(el('button', {
      class: 'btn ' + (mine ? 'btn-ghost' : 'btn-primary'),
      onclick: async () => {
        try {
          await api(`/requests/${q.id}/claim`, { method: 'POST', body: { action: mine ? 'quit' : 'join' } });
          closeModal();
          toast(mine ? '已取消认领' : '已认领，撸起袖子干');
          loadRequests();
          refreshStats();
        } catch (e) { toast(e.message, 'err'); }
      },
    }, mine ? '取消认领' : '我来拍'));
  }
  if (mine || S.user.role === 'admin' || q.created_by === S.user.id) {
    footer.push(el('button', {
      class: 'btn btn-ghost',
      onclick: async () => {
        try {
          await api('/requests/' + q.id, { method: 'PATCH', body: { status: q.status === 'done' ? 'claimed' : 'done' } });
          closeModal();
          toast(q.status === 'done' ? '已重新打开' : '已标记完成');
          loadRequests();
          refreshStats();
        } catch (e) { toast(e.message, 'err'); }
      },
    }, q.status === 'done' ? '重新打开' : '标记完成'));
  }
  footer.push(el('button', {
    class: 'btn btn-ghost',
    onclick: async () => {
      const action = await confirmDialog({
        title: '上传交付素材',
        message: '将跳转到上传面板，上传的视频会自动关联到这条需求。',
        confirmText: '去上传',
      });
      if (action) { closeModal(); openUploader({ requestId: q.id }); }
    },
  }, '上传交付'));
  if (q.created_by === S.user.id || S.user.role === 'admin') {
    footer.push(el('button', {
      class: 'btn btn-danger',
      onclick: async () => {
        if (!await confirmDialog({ title: '删除需求', message: '需求会被删除，已关联的素材不受影响。', confirmText: '删除', danger: true })) return;
        try { await api('/requests/' + q.id, { method: 'DELETE' }); closeModal(); toast('已删除'); loadRequests(); refreshStats(); }
        catch (e) { toast(e.message, 'err'); }
      },
    }, '删除'));
  }

  openModal({ title: '需求详情', body, footer, wide: true });
}

function claimRequest(id) {
  api(`/requests/${id}/claim`, { method: 'POST', body: { action: 'join' } })
    .then(() => { toast('已认领'); loadRequests(); refreshStats(); })
    .catch(e => toast(e.message, 'err'));
}

/* ========================= 上传 ========================= */
function openUploader(opts = {}) {
  const root = document.getElementById('uploader');
  root.hidden = false;
  root.innerHTML = '';

  const fileInput = el('input', { type: 'file', accept: 'video/*', multiple: true, style: { display: 'none' } });
  const fileList = el('div', { class: 'up-list' });
  const progress = el('div', { class: 'progress', style: { display: 'none' } }, el('i', {}));
  let files = [];

  const space = el('select', {},
    el('option', { value: 'daily' }, '每日选片（拍摄投递）'),
    el('option', { value: 'library' }, '素材库（通用素材）'),
  );
  if (S.view === 'library') space.value = 'library';

  const date = el('input', { type: 'date', value: ymd() });
  const tags = el('input', { type: 'text', placeholder: '逗号分隔，例如：厨房,开箱' });

  const drop = el('div', {
    class: 'drop',
    onclick: () => fileInput.click(),
    ondragover: e => { e.preventDefault(); drop.classList.add('over'); },
    ondragleave: () => drop.classList.remove('over'),
    ondrop: e => {
      e.preventDefault();
      drop.classList.remove('over');
      addFiles([...e.dataTransfer.files]);
    },
  },
    el('div', { class: 'big' }, '↑'),
    el('b', {}, '拖视频到这里，或点击选择'),
    el('span', {}, '支持 mp4 / mov / mkv / avi，可多选'),
  );

  function addFiles(list) {
    files = [...files, ...list.filter(f => f.type.startsWith('video/') || /\.(mp4|mov|m4v|mkv|avi|webm|flv)$/i.test(f.name))];
    renderFiles();
  }

  function renderFiles() {
    fileList.innerHTML = '';
    files.forEach((f, i) => {
      fileList.append(el('div', { class: 'up-item' },
        el('span', { class: 'nm' }, f.name),
        el('span', { class: 'sz' }, fmtBytes(f.size)),
        el('button', {
          class: 'icon-btn', style: { width: '20px', height: '20px', fontSize: '11px' },
          onclick: () => { files.splice(i, 1); renderFiles(); },
        }, '✕'),
      ));
    });
  }

  const submitBtn = el('button', { class: 'btn btn-primary' }, '开始上传');
  submitBtn.addEventListener('click', async () => {
    if (!files.length) return toast('先选择视频文件', 'err');
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<span class="spin"></span> 上传中';
    progress.style.display = '';
    try {
      const r = await uploadFiles({
        files, space: space.value, shootDate: date.value,
        requestId: opts.requestId || '', tags: tags.value,
        onProgress: p => { progress.firstChild.style.width = Math.round(p * 100) + '%'; },
      });
      toast(`上传完成：新增 ${r.added} 条${r.duplicates ? `，${r.duplicates} 条重复已跳过` : ''}${r.failed?.length ? `，${r.failed.length} 条失败` : ''}`);
      closeUploader();
      if (r.added && space.value !== S.space) {
        switchView(space.value === 'library' ? 'library' : 'daily');
      } else {
        reload();
      }
      refreshStats();
    } catch (e) {
      toast(e.message, 'err');
      submitBtn.disabled = false;
      submitBtn.textContent = '开始上传';
      progress.style.display = 'none';
    }
  });

  const card = el('div', { class: 'modal-card wide' },
    el('div', { class: 'modal-head' },
      el('h3', {}, opts.requestId ? '上传交付素材' : '上传视频'),
      el('button', { class: 'icon-btn', onclick: closeUploader }, '✕'),
    ),
    el('div', { class: 'modal-body' },
      drop,
      fileInput,
      fileList,
      progress,
      el('div', { style: { height: '14px' } }),
      el('div', { class: 'field-row' },
        el('div', { class: 'field' }, el('label', {}, '归属'), space),
        el('div', { class: 'field' }, el('label', {}, '拍摄日期'), date),
      ),
      el('div', { class: 'field' }, el('label', {}, '标签'), tags),
      opts.requestId ? el('div', { style: { fontSize: '11px', color: 'var(--cy)' } }, '✓ 将自动关联到当前需求') : null,
    ),
    el('div', { class: 'modal-foot' },
      el('button', { class: 'btn btn-ghost', onclick: closeUploader }, '取消'),
      submitBtn,
    ),
  );

  root.innerHTML = '';
  root.append(el('div', { class: 'modal-mask', onclick: closeUploader }), card);
  fileInput.addEventListener('change', () => addFiles([...fileInput.files]));
}

function closeUploader() {
  const root = document.getElementById('uploader');
  root.hidden = true;
  root.innerHTML = '';
}

/* ========================= 扫描 ========================= */
async function runScan() {
  const btn = document.getElementById('scanBtn');
  btn.disabled = true;
  btn.textContent = '扫描中…';
  try {
    const r = await api('/scan', { method: 'POST' });
    const res = r.result;
    if (res.error) toast(`扫描失败：${res.error}`, 'err', 4000);
    else if (res.skipped) toast('已有扫描在进行中');
    else toast(`扫描完成：目录 ${res.scanned} 个视频，新增 ${res.added} 条${res.duplicate ? `，跳过重复 ${res.duplicate}` : ''}${res.failed ? `，失败 ${res.failed}` : ''}`, 'ok', 3600);
    reload();
    refreshStats();
  } catch (e) {
    toast(e.message, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = '立即扫描投递目录';
  }
}

// 全局快捷键
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if (!document.getElementById('drawer').hidden) closeDrawer();
    else if (!document.getElementById('modal').hidden) closeModal();
    else if (!document.getElementById('uploader').hidden) closeUploader();
  }
});
