import { el, fmtDuration, fmtBytes, avatarMini, esc, timeAgo, dayLabel } from './util.js';
import { mediaUrl } from './api.js';

const NS = 'http://www.w3.org/2000/svg';
const ICONS = {
  comment: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
  download: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3',
  play: 'M8 5v14l11-7z',
  trash: 'M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6',
  star: 'M12 2.6l2.9 5.9 6.5.95-4.7 4.58 1.11 6.47L12 17.45l-5.81 3.05 1.11-6.47L2.6 9.45l6.5-.95z',
  sun: 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4',
  moon: 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z',
  lock: 'M19 11H5a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7a2 2 0 0 0-2-2zM7 11V7a5 5 0 0 1 10 0v4',
  video: 'M3 7a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM15 10l6-3.5v11L15 14z',
  check: 'M20 6L9 17l-5-5',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3.5 2',
  users: 'M9 11a3.2 3.2 0 1 0 0-6.4A3.2 3.2 0 0 0 9 11zM2.5 20a6.5 6.5 0 0 1 13 0M16 5a3 3 0 0 1 0 5.9M17.5 20a6.4 6.4 0 0 0-2-4.4',
  flame: 'M12 22c4 0 7-2.7 7-6.5 0-4.5-4.5-6-4.5-9.5 0-1.2.4-2.2 1-3-3.8.6-7 3.8-7 8 0 1 .2 1.8.5 2.5-1.4-.6-2.3-2-2.3-3.5C5 13 5 15.5 5 15.5 5 19 8 22 12 22z',
};

const FILLED = new Set(['play', 'star']);

export function icon(name, size = 11, filled = false) {
  const svg = document.createElementNS(NS, 'svg');
  const solid = filled || FILLED.has(name);
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('fill', solid ? 'currentColor' : 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', solid ? '1' : '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('style', 'flex:0 0 auto');
  const p = document.createElementNS(NS, 'path');
  p.setAttribute('d', ICONS[name] || '');
  svg.append(p);
  return svg;
}

export function starIcon(size = 12, on = false) {
  return icon('star', size, on);
}

export function thumb(v, cls = '') {
  return el('div', { class: 'card-thumb ' + cls },
    v.thumb_path
      ? el('img', { src: mediaUrl(`/api/videos/${v.id}/thumb`), alt: '', loading: 'lazy' })
      : el('div', { class: 'ph' }, '▷'),
    el('div', { class: 'thumb-time' }, fmtDuration(v.duration)),
    el('div', { class: 'thumb-play' }, el('i', {}, '▶')),
  );
}

export function videoCard(v, { selected = false, onToggle, onOpen, onRate }) {
  const card = el('article', {
    class: 'card' + (selected ? ' sel' : ''),
    dataset: { id: v.id },
    onclick: e => {
      if (e.target.closest('.cb') || e.target.closest('.card-rating')) return;
      onOpen?.(v);
    },
  });

  const cb = el('button', {
    class: 'cb' + (selected ? ' on' : ''),
    title: '选择',
    onclick: e => { e.stopPropagation(); onToggle?.(v); },
  });

  const stars = el('div', {
    class: 'card-rating' + (v.rating > 0 ? ' has' : ''),
    title: v.rating ? `已评 ${v.rating} 星 · 再点一次可取消` : '点星评分',
    onclick: e => e.stopPropagation(),
  },
    ...Array.from({ length: 5 }, (_, i) =>
      el('i', {
        class: v.rating > i ? 'on' : '',
        onclick: e => {
          e.stopPropagation();
          onRate?.(v, v.rating === i + 1 ? 0 : i + 1);
        },
      }, starIcon(12, v.rating > i))),
  );

  card.append(
    el('div', { class: 'card-thumb' },
      v.thumb_path
        ? el('img', { src: mediaUrl(`/api/videos/${v.id}/thumb`), alt: '', loading: 'lazy' })
        : el('div', { class: 'ph' }, '▷'),
      el('div', { class: 'thumb-time' }, fmtDuration(v.duration)),
      el('div', { class: 'thumb-play' }, el('i', {}, '▶')),
      cb,
      v.download_count > 0
        ? el('div', { class: 'badge-dl', title: `最近由 ${v.last_downloader_name || '—'} 下载` },
            icon('download', 9), el('b', {}, v.last_downloader_name || '已下载'))
        : (v.status === 'picked' ? el('div', { class: 'badge-status' }, '已选') : null),
      v.tags
        ? el('div', { class: 'card-tags' },
            ...v.tags.split(',').filter(Boolean).slice(0, 2).map(t => el('em', {}, t)))
        : null,
    ),
    el('div', { class: 'card-body' },
      el('div', { class: 'card-head' },
        el('h3', { class: 'card-title' }, v.title || v.orig_name),
        stars,
      ),
      el('div', { class: 'card-meta' },
        el('span', { class: 'who' },
          avatarMini(v.uploader_name || (v.source === 'scan' ? '投递' : '—'), v.uploader_color || '#5A6376'),
          el('span', {}, v.uploader_name || (v.source === 'scan' ? '目录投递' : '未知')),
        ),
        el('span', { class: 'm' },
          v.comment_count > 0 ? el('span', { title: '评论' }, icon('comment', 11), String(v.comment_count)) : null,
          v.download_count > 0 ? el('span', { title: '下载次数' }, icon('download', 11), String(v.download_count)) : null,
        ),
      ),
    ),
  );
  return card;
}

export function videoRow(v, { selected = false, onToggle, onOpen }) {
  return el('div', {
    class: 'list-row' + (selected ? ' sel' : ''),
    dataset: { id: v.id },
    onclick: e => { if (!e.target.closest('.cb')) onOpen?.(v); },
  },
    el('button', {
      class: 'cb' + (selected ? ' on' : ''),
      style: { position: 'static' },
      onclick: e => { e.stopPropagation(); onToggle?.(v); },
    }),
    el('div', { class: 'list-thumb' },
      v.thumb_path
        ? el('img', { src: mediaUrl(`/api/videos/${v.id}/thumb`), alt: '', loading: 'lazy' })
        : el('div', { class: 'ph' }, '▷'),
    ),
    el('div', { style: { minWidth: 0 } },
      el('div', { class: 'list-title' }, v.title || v.orig_name),
      el('div', { class: 'list-sub' }, `${v.width || '?'}×${v.height || '?'} · ${fmtDuration(v.duration)} · ${fmtBytes(v.size)}`),
    ),
    el('div', { class: 'cell hide-sm' },
      avatarMini(v.uploader_name || '投递', v.uploader_color || '#5A6376'),
      el('span', { style: { marginLeft: '6px' } }, v.uploader_name || '目录投递'),
    ),
    el('div', { class: 'cell dim hide-sm' }, v.shoot_date),
    el('div', { class: 'cell hide-sm' },
      v.download_count > 0
        ? el('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '4px' } },
            icon('download', 10), `${v.download_count} · ${v.last_downloader_name || ''}`)
        : '未下载'),
    el('div', { class: 'cell dim' },
      el('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '9px' } },
        v.rating > 0
          ? el('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '2px', color: 'var(--am)' }, title: `${v.rating} 星` },
              starIcon(10, true), String(v.rating))
          : null,
        v.comment_count > 0
          ? el('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '3px' } },
              icon('comment', 10), String(v.comment_count))
          : null,
      )),
  );
}

export function requestCard(q, { me, onOpen, onClaim }) {
  const mine = (q.claim_names || '').split('、').includes(me?.name);
  return el('article', {
    class: `req pri-${q.priority}`,
    onclick: () => onOpen?.(q),
  },
    el('div', { class: 'req-top' },
      el('h3', { class: 'req-title' }, q.title),
      q.priority === 'high' ? el('span', { class: 'pill high' }, '急') : null,
    ),
    q.brief ? el('p', { class: 'req-brief' }, q.brief) : null,
    el('div', { class: 'req-foot' },
      el('span', { class: `pill ${q.status}` },
        { open: '待认领', claimed: '进行中', done: '已完成', closed: '已关闭' }[q.status] || q.status),
      q.due_date ? el('span', { class: 'pill' }, `截止 ${q.due_date.slice(5)}`) : null,
      q.video_count > 0 ? el('span', { class: 'pill' }, `已交 ${q.video_count} 条`) : null,
      el('span', { class: 'req-who' },
        avatarMini(q.creator_name, q.creator_color),
        el('span', {}, q.creator_name || '—'),
      ),
    ),
    q.claim_count > 0
      ? el('div', { style: { fontSize: '10.5px', color: 'var(--tx3)', display: 'flex', gap: '6px', alignItems: 'center' } },
          el('span', {}, '认领：'), el('span', { style: { color: mine ? 'var(--cy)' : 'var(--tx2)' } }, q.claim_names))
      : null,
  );
}

export function downloadBatch(batch, { onOpenVideo }) {
  const first = batch[0];
  return el('section', { class: 'batch' },
    el('div', { class: 'batch-head' },
      avatarMini(first.user_name, first.user_color),
      el('b', {}, first.user_name),
      el('span', { class: 'tm' }, `${timeAgo(first.created_at)} · ${new Date(first.created_at).toLocaleString('zh-CN', { hour12: false })}`),
      el('span', { class: 'ct' }, `${batch.length} 条素材`),
    ),
    el('div', { class: 'batch-items' },
      ...batch.map(d => el('div', {
        class: 'bitem',
        title: d.video_title,
        onclick: () => onOpenVideo?.(d.video_id),
      },
        el('div', { class: 'th' },
          d.thumb_path ? el('img', { src: mediaUrl(`/api/videos/${d.video_id}/thumb`), alt: '', loading: 'lazy' }) : null),
        el('p', {}, d.video_title || '—'),
      )),
    ),
    first.note ? el('div', { class: 'batch-note' }, `备注：${first.note}`) : null,
  );
}

export function statCard(k, v, cls = '') {
  return el('div', { class: 'stat' },
    el('div', { class: 'k' }, k),
    el('div', { class: 'v ' + cls }, String(v)),
  );
}

export { dayLabel, esc };
