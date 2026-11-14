const LS_UID = 'tk.selector.uid';

let user = null;
let onUnauthorized = null;

export const getUser = () => user;
export const storedUid = () => localStorage.getItem(LS_UID);
export function setUser(u, mediaToken) {
  user = u ? { ...u, mediaToken: mediaToken || u.mediaToken || null } : null;
  if (u) localStorage.setItem(LS_UID, u.id);
  else localStorage.removeItem(LS_UID);
}
export function setUnauthorizedHandler(fn) { onUnauthorized = fn; }

export async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (user) headers['x-user-id'] = user.id;
  let body = opts.body;
  if (body && !(body instanceof FormData)) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch('/api' + path, { method: opts.method || 'GET', headers, body });
  } catch {
    throw new Error('网络连接失败，请检查服务是否在运行');
  }
  if (res.status === 401 && path !== '/login') {
    onUnauthorized?.();
    throw new Error('登录已失效，请重新登录');
  }
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('application/json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error((data && data.error) || `请求失败 (${res.status})`);
  return data;
}

/** 媒体地址：<video>/<img> 无法带 header，用 query 传身份 */
export function mediaUrl(path, extra = '') {
  const sep = path.includes('?') ? '&' : '?';
  // 优先签名 token（24h 过期、可吊销）；老会话没有 token 时退回 uid（服务端会拒绝）
  const idPart = user?.mediaToken
    ? 't=' + encodeURIComponent(user.mediaToken)
    : 'uid=' + encodeURIComponent(user?.id || '');
  return path + sep + idPart + extra;
}

// ---- 上传（带进度）----
export function uploadFiles({ files, space, shootDate, requestId, tags, title, onProgress }) {
  return new Promise((resolve, reject) => {
    const fd = new FormData();
    for (const f of files) fd.append('files', f);
    fd.append('space', space || 'daily');
    fd.append('shootDate', shootDate || '');
    if (requestId) fd.append('requestId', requestId);
    if (tags) fd.append('tags', tags);
    if (title) fd.append('title', title);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/videos/upload');
    if (user) xhr.setRequestHeader('x-user-id', user.id);
    xhr.upload.onprogress = e => {
      if (e.lengthComputable) onProgress?.(e.loaded / e.total);
    };
    xhr.onload = () => {
      let data;
      try { data = JSON.parse(xhr.responseText); } catch { data = { error: '返回格式错误' }; }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else if (xhr.status === 401) { onUnauthorized?.(); reject(new Error('身份已失效')); }
      else reject(new Error(data.error || `上传失败 (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error('上传中断，请检查网络'));
    xhr.send(fd);
  });
}
