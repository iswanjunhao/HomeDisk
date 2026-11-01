/* HomeCloud 家庭云盘 —— 前端主逻辑（原生 JS，无框架、无 CDN 依赖） */

'use strict';

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const CHUNK = 8 * 1024 * 1024;   // 上传分片大小 8MB

const state = {
  path: '/',
  parent: null,
  items: [],
  view: localStorage.getItem('hc.view') || 'grid',
  sort: 'name',
  order: 'asc',
  mode: 'browse',           // browse | search
  query: '',
  selected: new Set(),
  lastAnchor: null,
  admin: false,
  uploadLimit: 1073741824,  // 访客上传上限，启动时由服务端告知
  rootReady: true,
  clipboard: null,          // { paths: [] }
  dragPath: null,
};

/* ============================== 工具函数 ============================== */

function fmtSize(b) {
  if (b === null || b === undefined) return '-';
  if (b < 1024) return b + ' B';
  const u = ['KB', 'MB', 'GB', 'TB'];
  let v = b / 1024, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return (v < 10 ? v.toFixed(1) : Math.round(v)) + ' ' + u[i];
}

function fmtTime(ms) {
  if (!ms) return '-';
  const d = new Date(ms), p = (x) => String(x).padStart(2, '0');
  const today = new Date(); today.setHours(0, 0, 0, 0);
  if (ms >= today.getTime()) return `${p(d.getHours())}:${p(d.getMinutes())}`;
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let toastTimer = null;
function toast(msg, type) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast' + (type ? ' ' + type : '');
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, type === 'err' ? 3600 : 2200);
}

/* ============================== 网络请求 ============================== */

async function api(url, opts) {
  const res = await fetch(url, Object.assign({ credentials: 'same-origin' }, opts || {}));
  let data = {};
  try { data = await res.json(); } catch (e) { /* 非 JSON 响应 */ }
  if (res.status === 401) {
    const e = new Error(data.error || '需要管理员密码');
    e.needAuth = true;
    throw e;
  }
  if (!res.ok) {
    const e = new Error(data.error || ('请求失败（' + res.status + '）'));
    e.status = res.status;
    throw e;
  }
  return data;
}

function apiPost(url, body) {
  return api(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
}

/**
 * 执行需要管理员权限的操作
 * 未登录时弹出密码框，验证通过后自动重试原操作，不打断用户流程
 */
async function withAuth(fn, hint) {
  try {
    return await fn();
  } catch (e) {
    if (e && e.needAuth) {
      const ok = await promptPassword(hint || e.message);
      if (!ok) throw e;
      state.admin = true;
      updateAdminBtn();
      return await fn();
    }
    throw e;
  }
}

/* ================================ 图标 ================================ */

const COLOR = {
  folder: '#c98a2e', image: '#1d9e75', video: '#7f77dd',
  audio: '#d4537e', doc: '#378add', archive: '#888780', other: '#888780',
};

function iconSvg(type, size) {
  const s = size || 28, c = COLOR[type] || COLOR.other;
  const paths = {
    folder: `<rect x="2" y="6" width="26" height="19" rx="3" fill="#f4e3c8" stroke="${c}" stroke-width="1.4"/><path d="M2 11h9l2.2-2.2h12.8" fill="none" stroke="${c}" stroke-width="1.4"/>`,
    image: `<rect x="2" y="5" width="26" height="20" rx="3" fill="#dff2ec" stroke="${c}" stroke-width="1.4"/><circle cx="9.5" cy="10.5" r="2" fill="${c}"/><path d="M3.5 22l7.5-7.5 5 5 4-3 6.5 5.5" fill="none" stroke="${c}" stroke-width="1.4" stroke-linejoin="round"/>`,
    video: `<rect x="2" y="5" width="26" height="20" rx="3" fill="#ecebfa" stroke="${c}" stroke-width="1.4"/><path d="M12.5 11l6.5 4-6.5 4z" fill="${c}"/>`,
    audio: `<rect x="2" y="5" width="26" height="20" rx="3" fill="#fbe7ee" stroke="${c}" stroke-width="1.4"/><path d="M11 20v-7l7-2v7" fill="none" stroke="${c}" stroke-width="1.4"/><circle cx="9" cy="20" r="2.2" fill="${c}"/><circle cx="18" cy="18" r="2.2" fill="${c}"/>`,
    doc: `<rect x="4" y="3" width="22" height="24" rx="3" fill="#e7f0fb" stroke="${c}" stroke-width="1.4"/><path d="M8.5 9.5h13M8.5 14h13M8.5 18.5h9" stroke="${c}" stroke-width="1.4" stroke-linecap="round"/>`,
    archive: `<rect x="3" y="5" width="24" height="20" rx="3" fill="#f0efea" stroke="${c}" stroke-width="1.4"/><path d="M15 8v9" stroke="${c}" stroke-width="1.4"/><rect x="14" y="8" width="2" height="4.5" fill="${c}"/><path d="M12.5 17h5v4.5h-5z" fill="${c}"/>`,
    other: `<rect x="4" y="3" width="22" height="24" rx="3" fill="#f0efea" stroke="${c}" stroke-width="1.4"/><path d="M9 12h12M9 16h12M9 20h7" stroke="${c}" stroke-width="1.4" stroke-linecap="round"/>`,
  };
  const body = paths[type] || paths.other;
  return `<svg viewBox="0 0 30 30" width="${s}" height="${s}" aria-hidden="true">${body}</svg>`;
}

/* ============================== 渲染主区 ============================== */

function render() {
  renderBack();
  renderCrumb();
  renderContent();
  renderActionBar();
}

/** 返回上一级按钮：只在文件夹浏览模式且不在根目录时显示 */
function renderBack() {
  const back = $('#btnBack');
  back.hidden = !(state.mode === 'browse' && state.path && state.path !== '/');
}

function renderCrumb() {
  const el = $('#crumb');
  if (state.mode === 'search') {
    el.innerHTML = `<span class="sep">搜索「${esc(state.query)}」的结果</span>`;
    return;
  }
  const parts = state.path.split('/').filter(Boolean);
  let html = `<button data-p="/">共享盘</button>`;
  let acc = '';
  parts.forEach((p) => {
    acc += '/' + p;
    html += `<span class="sep">/</span><button data-p="${esc(acc)}">${esc(p)}</button>`;
  });
  el.innerHTML = html;
  $$('#crumb button').forEach((b) => { b.onclick = () => browse(b.dataset.p); });
}

function renderContent() {
  const c = $('#content');

  if (!state.rootReady) {
    c.innerHTML = `<div class="empty">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 9v4m0 4h.01"/><circle cx="12" cy="12" r="9"/></svg>
      <p>共享盘未挂载或不可访问</p>
      <p>请在这台电脑上运行：<code>~/homecloud/scripts/mount-disk.sh</code></p>
    </div>`;
    return;
  }

  const title = state.mode === 'search'
    ? `搜索「${esc(state.query)}」 · ${state.items.length} 个结果`
    : null;

  if (state.items.length === 0) {
    c.innerHTML = (title ? `<div class="sect-title">${title}</div>` : '') + `
      <div class="empty">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/></svg>
        <p>${state.mode === 'search' ? '没有找到匹配的文件' : '这个文件夹还是空的'}</p>
        <p>${state.mode === 'browse' ? '把文件拖到这里，或点「上传」' : '换个关键词试试'}</p>
      </div>`;
    return;
  }

  const head = title ? `<div class="sect-title">${title}</div>` : '';
  c.innerHTML = head + (state.view === 'grid' ? renderGrid() : renderList());
  bindItems();
}

function thumbHtml(it) {
  if (it.type === 'image') {
    const url = '/api/thumb?path=' + encodeURIComponent(it.path);
    return `<img src="${url}" alt="" loading="lazy" onerror="this.replaceWith(document.createRange().createContextualFragment('${iconSvg('image', 30)}'))">`;
  }
  return iconSvg(it.isDir ? 'folder' : it.type, 30);
}

function renderGrid() {
  return `<div class="grid">` + state.items.map((it, i) => `
    <div class="cell ${state.selected.has(it.path) ? 'sel' : ''}" data-i="${i}" draggable="true">
      <div class="chk"></div>
      <div class="thumb">${thumbHtml(it)}</div>
      <div class="cname">${esc(it.name)}</div>
      <div class="cmeta">${it.isDir ? '文件夹' : fmtSize(it.size)}</div>
    </div>`).join('') + `</div>`;
}

function renderList() {
  return `<div class="rows">` + state.items.map((it, i) => `
    <div class="row ${state.selected.has(it.path) ? 'sel' : ''}" data-i="${i}" draggable="true">
      <div class="chk"></div>
      <div class="fico">${iconSvg(it.isDir ? 'folder' : it.type, 24)}</div>
      <div class="fname">${esc(it.name)}</div>
      <div class="fmeta">${it.isDir ? '—' : fmtSize(it.size)}<br><span style="opacity:.7">${fmtTime(it.mtime)}</span></div>
      <div class="fops">
        ${it.isDir ? '' : `<button data-op="dl">下载</button>`}
        <button data-op="ren">重命名</button>
        ${it.isDir ? `<button data-op="open">打开</button>` : ''}
        <button data-op="del" class="del">删除</button>
      </div>
    </div>`).join('') + `</div>`;
}

function bindItems() {
  const nodes = $$('#content .cell, #content .row');
  nodes.forEach((el) => {
    const i = Number(el.dataset.i);
    const it = state.items[i];

    // 复选框：切换选中，支持 Shift 连选
    el.querySelector('.chk').onclick = (e) => {
      e.stopPropagation();
      toggleSelect(it, i);
    };

    // 主区域点击：文件夹进入，文件直接下载
    el.onclick = (e) => {
      const op = e.target.dataset && e.target.dataset.op;
      if (op) {
        e.stopPropagation();
        if (op === 'dl') downloadFile(it);
        else if (op === 'open') browse(it.path);
        else if (op === 'ren') startRename(i);
        else if (op === 'del') doDelete([it.path], [it.name]);
        return;
      }
      if (e.target.classList.contains('chk')) return;
      if (it.isDir) browse(it.path);
      else downloadFile(it);
    };

    // 拖拽：把条目拖到文件夹上即可移动
    el.ondragstart = () => { state.dragPath = it.path; };
    el.ondragover = (e) => { if (it.isDir && state.dragPath) { e.preventDefault(); el.classList.add('drop'); } };
    el.ondragleave = () => el.classList.remove('drop');
    el.ondrop = async (e) => {
      el.classList.remove('drop');
      if (state.dragPath && it.isDir) {
        const src = state.dragPath; state.dragPath = null;
        await doMove([src], it.path);
      } else if (e.dataTransfer && e.dataTransfer.files.length) {
        e.preventDefault();
        uploadFiles(e.dataTransfer.files);
      }
    };
  });
}

function toggleSelect(it, i) {
  if (state.selected.has(it.path)) {
    state.selected.delete(it.path);
  } else {
    // Shift 连选：从上一次点击的位置到当前位置全选
    if (window.__shift && state.lastAnchor !== null) {
      const a = Math.min(state.lastAnchor, i), b = Math.max(state.lastAnchor, i);
      for (let k = a; k <= b; k++) state.selected.add(state.items[k].path);
    } else {
      state.selected.add(it.path);
    }
  }
  state.lastAnchor = i;
  renderActionBar();
  // 只更新选中样式，避免整页重绘打断滚动位置
  $$('#content .cell, #content .row').forEach((el) => {
    el.classList.toggle('sel', state.selected.has(state.items[Number(el.dataset.i)].path));
  });
}

function clearSelection() {
  state.selected.clear();
  state.lastAnchor = null;
  renderActionBar();
}

function renderActionBar() {
  const bar = $('#actionbar');
  const n = state.selected.size;
  if (n === 0) { bar.hidden = true; return; }
  bar.hidden = false;
  $('#selCount').textContent = `已选 ${n} 项`;
}

/* ============================== 数据加载 ============================== */

async function browse(p) {
  state.mode = 'browse';
  state.path = p || '/';
  $('#search').value = '';
  clearSelection();
  $('#content').innerHTML = `<div class="loading">加载中…</div>`;
  try {
    const d = await api(`/api/list?path=${encodeURIComponent(state.path)}&sort=${state.sort}&order=${state.order}`);
    state.items = d.items;
    state.path = d.path;
    state.parent = d.parent || '/';
    render();
  } catch (e) {
    $('#content').innerHTML = `<div class="empty"><p>${esc(e.message)}</p></div>`;
  }
}

async function doSearch(q) {
  q = String(q || '').trim();
  if (!q) { state.mode = 'browse'; browse(state.path); return; }
  state.mode = 'search';
  state.query = q;
  clearSelection();
  $('#content').innerHTML = `<div class="loading">搜索中…</div>`;
  const scope = $('#searchScope').value === 'current' ? state.path : '';
  try {
    const d = await api(`/api/search?q=${encodeURIComponent(q)}&path=${encodeURIComponent(scope)}`);
    state.items = d.results || [];
    if (d.building) toast('索引建立中，正在实时搜索', 'err');
    render();
  } catch (e) {
    $('#content').innerHTML = `<div class="empty"><p>${esc(e.message)}</p></div>`;
  }
}

async function loadStatus() {
  try {
    const s = await api('/api/status');
    state.admin = !!s.admin;
    state.uploadLimit = s.guestUploadMaxBytes || 1073741824;
    state.rootReady = !!s.rootAvailable;
    updateAdminBtn();
    if (!s.rootReady) render();
  } catch (e) { /* 静默，首页仍可渲染 */ }
}

async function loadUsage() {
  try {
    const u = await api('/api/usage');
    if (!u.total) { $('#usage').innerHTML = '<span>磁盘容量未知</span>'; return; }
    $('#usage').innerHTML = `
      <div>共享盘 ${u.usedText} / ${u.totalText} · 剩余 ${u.freeText}</div>
      <div class="ubar"><i style="width:${u.usedPercent}%"></i></div>`;
  } catch (e) { /* 忽略 */ }
}

/* ============================== 文件操作 ============================== */

function downloadFile(it) {
  window.location.href = '/api/download?path=' + encodeURIComponent(it.path);
}

async function downloadSelected() {
  const paths = Array.from(state.selected);
  if (!paths.length) return;
  if (paths.length === 1) {
    const it = state.items.find((x) => x.path === paths[0]);
    if (it && !it.isDir) return downloadFile(it);
  }
  // 多选或含文件夹：走打包下载
  try {
    const res = await fetch('/api/download-zip', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths }),
    });
    if (!res.ok) { toast('打包下载失败', 'err'); return; }
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = '下载.zip';
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    toast('打包完成', 'ok');
  } catch (e) {
    toast('下载失败：' + e.message, 'err');
  }
}

async function doMkdir() {
  const name = await promptName('新建文件夹', '请输入文件夹名称', '新建文件夹');
  if (!name) return;
  try {
    await apiPost('/api/mkdir', { path: state.path, name });
    toast('已创建', 'ok');
    refresh();
  } catch (e) {
    toast(e.message, 'err');
  }
}

function startRename(i) {
  const it = state.items[i];
  const nodes = $$('#content .cell, #content .row');
  const el = nodes.find((n) => Number(n.dataset.i) === i);
  if (!el) return;
  const holder = el.querySelector('.cname') || el.querySelector('.fname');
  const old = it.name;
  holder.innerHTML = `<input value="${esc(old)}">`;
  const input = holder.querySelector('input');
  input.focus();
  const idx = old.lastIndexOf('.');
  if (idx > 0) input.setSelectionRange(0, idx);

  let done = false;
  const finish = async (save) => {
    if (done) return; done = true;
    const val = input.value.trim();
    if (!save || !val || val === old) { holder.textContent = old; return; }
    try {
      await withAuth(() => apiPost('/api/rename', { path: it.path, newName: val }));
      toast('已重命名', 'ok');
      refresh();
    } catch (e) {
      holder.textContent = old;
      toast(e.message, 'err');
    }
  };
  input.onkeydown = (e) => {
    if (e.key === 'Enter') finish(true);
    else if (e.key === 'Escape') finish(false);
    e.stopPropagation();
  };
  input.onblur = () => finish(true);
}

async function doDelete(paths, names) {
  const label = names && names.length === 1
    ? `确定删除「${names[0]}」？`
    : `确定删除选中的 ${paths.length} 个条目？`;
  const ok = await confirmBox('删除', label + (paths.some((p) => true) ? '（文件夹将连同里面的内容一起删除）' : ''));
  if (!ok) return;
  try {
    const r = await withAuth(() => apiPost('/api/delete', { paths }));
    if (r.errors && r.errors.length) {
      toast(`已删除 ${r.deleted.length} 项，${r.errors.length} 项失败`, 'err');
    } else {
      toast(`已删除 ${r.deleted.length} 项`, 'ok');
    }
    clearSelection();
    refresh();
  } catch (e) {
    toast(e.message, 'err');
  }
}

async function doMove(paths, dest) {
  try {
    const r = await withAuth(() => apiPost('/api/move', { paths, dest }));
    if (r.errors && r.errors.length) {
      toast(r.errors[0].error, 'err');
    } else {
      toast(`已移动 ${r.moved.length} 项`, 'ok');
    }
    clearSelection();
    refresh();
  } catch (e) {
    toast(e.message, 'err');
  }
}

function doCut() {
  const paths = Array.from(state.selected);
  if (!paths.length) return;
  state.clipboard = { paths };
  renderPasteBtn();
  toast(`已剪切 ${paths.length} 项，到目标文件夹后点「粘贴」`);
  clearSelection();
}

async function doPaste() {
  if (!state.clipboard) return;
  const paths = state.clipboard.paths;
  state.clipboard = null;
  renderPasteBtn();
  try {
    const r = await withAuth(() => apiPost('/api/move', { paths, dest: state.path }));
    if (r.errors && r.errors.length) toast(r.errors[0].error, 'err');
    else toast(`已移动 ${r.moved.length} 项`, 'ok');
    refresh();
  } catch (e) {
    toast(e.message, 'err');
  }
}

function renderPasteBtn() {
  let btn = $('#btnPaste');
  if (state.clipboard && !btn) {
    btn = document.createElement('button');
    btn.id = 'btnPaste';
    btn.className = 'btn primary';
    btn.textContent = `粘贴 ${state.clipboard.paths.length} 项`;
    btn.onclick = doPaste;
    $('.tools').insertBefore(btn, $('#btnUpload'));
  } else if (!state.clipboard && btn) {
    btn.remove();
  }
}

function refresh() {
  if (state.mode === 'browse') browse(state.path);
  else doSearch(state.query);
}

/* ============================== 上传 ============================== */

function showUploadPanel() {
  $('#uploadPanel').hidden = false;
  if (!$('#uploadPanel h4')) {
    $('#uploadPanel').innerHTML = '<h4>上传中</h4><div id="upList"></div>';
  }
}

async function uploadFiles(files) {
  const list = Array.from(files).filter((f) => f.size !== undefined);
  if (!list.length) return;
  if (state.mode !== 'browse') { toast('请先进入某个文件夹再上传', 'err'); return; }
  showUploadPanel();

  for (const f of list) {
    await uploadOne(f);
  }
  setTimeout(() => {
    const done = Array.from($('#upList').children).every((n) => n.dataset.done === '1');
    if (done) { $('#uploadPanel').hidden = true; $('#upList').innerHTML = ''; }
    refresh();
  }, 600);
}

async function uploadOne(file) {
  const row = document.createElement('div');
  row.className = 'upitem';
  row.innerHTML = `<div class="upname">${esc(file.name)}</div>
    <div class="upbar"><i></i></div>
    <div class="upstat">准备中…</div>`;
  $('#upList').appendChild(row);
  const bar = row.querySelector('i');
  const stat = row.querySelector('.upstat');
  const set = (pct, text) => { bar.style.width = pct + '%'; stat.textContent = text; };

  try {
    // 权限闸门：超过访客上限的文件必须管理员
    if (file.size > state.uploadLimit && !state.admin) {
      const ok = await promptPassword(`「${file.name}」大小 ${fmtSize(file.size)}，超过 ${fmtSize(state.uploadLimit)}，需要管理员密码`);
      if (!ok) { row.classList.add('err'); row.dataset.done = '1'; set(100, '已取消'); return; }
      state.admin = true; updateAdminBtn();
    }

    let init;
    try {
      init = await apiPost('/api/upload/init', { path: state.path, name: file.name, size: file.size });
    } catch (e) {
      if (e.needAuth) {
        const ok = await promptPassword(e.message);
        if (!ok) { row.dataset.done = '1'; row.classList.add('err'); set(100, '已取消'); return; }
        state.admin = true; updateAdminBtn();
        init = await apiPost('/api/upload/init', { path: state.path, name: file.name, size: file.size });
      } else {
        throw e;
      }
    }

    let sent = 0;
    while (sent < file.size) {
      const end = Math.min(sent + CHUNK, file.size);
      const blob = file.slice(sent, end);
      const res = await fetch('/api/upload/chunk?uploadId=' + encodeURIComponent(init.uploadId), {
        method: 'POST', credentials: 'same-origin', body: blob,
      });
      if (!res.ok) {
        let msg = '上传失败';
        try { msg = (await res.json()).error || msg; } catch (e) { /* 忽略 */ }
        throw new Error(msg);
      }
      sent = end;
      const pct = file.size ? Math.round((sent / file.size) * 100) : 100;
      set(pct, `${fmtSize(sent)} / ${fmtSize(file.size)}　${pct}%`);
    }

    await apiPost('/api/upload/done', { uploadId: init.uploadId });
    row.dataset.done = '1';
    set(100, '完成');
  } catch (e) {
    row.dataset.done = '1';
    row.classList.add('err');
    set(100, '失败：' + e.message);
    toast('上传失败：' + e.message, 'err');
  }
}

/* ============================== 弹窗 ============================== */

let pwdResolve = null;
function promptPassword(desc) {
  $('#pwdDesc').textContent = desc || '此操作需要管理员权限';
  $('#pwdErr').textContent = '';
  $('#pwdInput').value = '';
  $('#pwdModal').hidden = false;
  setTimeout(() => $('#pwdInput').focus(), 50);
  return new Promise((resolve) => { pwdResolve = resolve; });
}

function closePwd(result) {
  $('#pwdModal').hidden = true;
  if (pwdResolve) { pwdResolve(result); pwdResolve = null; }
}

let nameResolve = null;
function promptName(title, placeholder, def) {
  $('#nameTitle').textContent = title;
  $('#nameInput').placeholder = placeholder;
  $('#nameInput').value = def || '';
  $('#nameErr').textContent = '';
  $('#nameModal').hidden = false;
  setTimeout(() => { $('#nameInput').focus(); $('#nameInput').select(); }, 50);
  return new Promise((r) => { nameResolve = r; });
}

let confirmResolve = null;
function confirmBox(title, desc) {
  $('#confirmTitle').textContent = title;
  $('#confirmDesc').textContent = desc;
  $('#confirmModal').hidden = false;
  return new Promise((r) => { confirmResolve = r; });
}

/* ----------------------- 「移动到」目录选择弹窗 ----------------------- */

let movePath = '/';
async function openMoveModal(paths) {
  movePath = state.path;
  $('#moveErr').textContent = '';
  $('#moveModal').hidden = false;
  $('#moveModal').dataset.paths = JSON.stringify(paths);
  await loadTree(movePath);
}

async function loadTree(p) {
  movePath = p;
  const d = await api('/api/tree?path=' + encodeURIComponent(p));
  const parts = p.split('/').filter(Boolean);
  let html = `<button data-p="/">共享盘</button>`;
  let acc = '';
  parts.forEach((x) => { acc += '/' + x; html += `<span class="sep">/</span><button data-p="${esc(acc)}">${esc(x)}</button>`; });
  $('#moveCrumb').innerHTML = html;
  $$('#moveCrumb button').forEach((b) => { b.onclick = () => loadTree(b.dataset.p); });

  let list = '';
  if (p !== '/') {
    list += `<div class="trow up" data-p="${esc(p.split('/').slice(0, -1).join('/') || '/')}">↑ 返回上一级</div>`;
  }
  list += d.dirs.map((x) => `<div class="trow" data-p="${esc(x.path)}">${iconSvg('folder', 18)} ${esc(x.name)}</div>`).join('');
  if (!d.dirs.length && p === '/') list += `<div class="trow" style="color:var(--text-3)">没有子文件夹</div>`;
  $('#moveList').innerHTML = list;
  $$('#moveList .trow').forEach((el) => {
    el.onclick = () => {
      if (el.classList.contains('up')) loadTree(el.dataset.p);
      else loadTree(el.dataset.p);
    };
  });
}

/* ============================== 管理员按钮 ============================== */

function updateAdminBtn() {
  const b = $('#btnAdmin');
  if (state.admin) {
    b.textContent = '已解锁';
    b.classList.add('primary');
  } else {
    b.textContent = '管理员';
    b.classList.remove('primary');
  }
}

/* ============================== 事件绑定 ============================== */

function bindEvents() {
  // 排序
  $('#sortSel').onchange = () => {
    const [s, o] = $('#sortSel').value.split(':');
    state.sort = s; state.order = o;
    refresh();
  };

  // 视图切换
  $('#btnView').onclick = () => {
    state.view = state.view === 'grid' ? 'list' : 'grid';
    localStorage.setItem('hc.view', state.view);
    renderContent();
  };

  // 返回上一级
  $('#btnBack').onclick = () => browse(state.parent || '/');

  // 搜索
  let searchTimer = null;
  $('#search').oninput = () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => doSearch($('#search').value), 320);
  };
  $('#searchScope').onchange = () => { if ($('#search').value.trim()) doSearch($('#search').value); };

  // 上传
  $('#btnUpload').onclick = () => $('#fileInput').click();
  $('#fabUpload').onclick = () => $('#fileInput').click();
  $('#btnCam').onclick = () => $('#camInput').click();
  $('#btnFolder').onclick = () => $('#folderInput').click();
  $('#fileInput').onchange = (e) => { uploadFiles(e.target.files); e.target.value = ''; };
  $('#camInput').onchange = (e) => { uploadFiles(e.target.files); e.target.value = ''; };
  // 文件夹上传：按钮在工具栏里，选中文件夹后把里面所有文件传上去
  $('#folderInput').onchange = (e) => { uploadFiles(e.target.files); e.target.value = ''; };

  // 新建文件夹
  $('#btnNewFolder').onclick = doMkdir;

  // 选中操作
  $('#btnDl').onclick = downloadSelected;
  $('#btnDel').onclick = () => doDelete(Array.from(state.selected), null);
  $('#btnMove').onclick = () => openMoveModal(Array.from(state.selected));
  $('#btnCut').onclick = doCut;
  $('#btnClear').onclick = () => { clearSelection(); renderContent(); };

  // 管理员按钮：已解锁时点击可退出
  $('#btnAdmin').onclick = async () => {
    if (state.admin) {
      await apiPost('/api/logout', {});
      state.admin = false;
      updateAdminBtn();
      toast('已退出管理员');
    } else {
      const ok = await promptPassword('解锁后可重命名、移动、删除文件');
      closePwd(ok);
    }
  };

  // 密码弹窗
  $('#pwdOk').onclick = async () => {
    const pwd = $('#pwdInput').value;
    if (!pwd) { $('#pwdErr').textContent = '请输入密码'; return; }
    try {
      await apiPost('/api/login', { password: pwd });
      closePwd(true);
    } catch (e) {
      $('#pwdErr').textContent = e.message || '密码错误';
    }
  };
  $('#pwdCancel').onclick = () => closePwd(false);
  $('#pwdInput').onkeydown = (e) => { if (e.key === 'Enter') $('#pwdOk').click(); };

  // 命名弹窗
  $('#nameOk').onclick = () => {
    const v = $('#nameInput').value.trim();
    if (!v) { $('#nameErr').textContent = '名称不能为空'; return; }
    $('#nameModal').hidden = true;
    if (nameResolve) { nameResolve(v); nameResolve = null; }
  };
  $('#nameCancel').onclick = () => { $('#nameModal').hidden = true; if (nameResolve) { nameResolve(null); nameResolve = null; } };
  $('#nameInput').onkeydown = (e) => { if (e.key === 'Enter') $('#nameOk').click(); };

  // 确认弹窗
  $('#confirmOk').onclick = () => { $('#confirmModal').hidden = true; if (confirmResolve) { confirmResolve(true); confirmResolve = null; } };
  $('#confirmCancel').onclick = () => { $('#confirmModal').hidden = true; if (confirmResolve) { confirmResolve(false); confirmResolve = null; } };

  // 移动弹窗
  $('#moveCancel').onclick = () => { $('#moveModal').hidden = true; };
  $('#moveHere').onclick = async () => {
    const paths = JSON.parse($('#moveModal').dataset.paths || '[]');
    $('#moveModal').hidden = true;
    await doMove(paths, movePath);
  };

  // 点击遮罩关闭
  $$('.modal').forEach((m) => {
    m.onclick = (e) => {
      if (e.target === m) {
        m.hidden = true;
        if (m.id === 'pwdModal') closePwd(false);
        if (m.id === 'nameModal' && nameResolve) { nameResolve(null); nameResolve = null; }
        if (m.id === 'confirmModal' && confirmResolve) { confirmResolve(false); confirmResolve = null; }
      }
    };
  });

  // Esc 关闭弹窗
  document.addEventListener('keydown', (e) => {
    window.__shift = e.shiftKey;
    if (e.key === 'Escape') {
      $$('.modal').forEach((m) => { if (!m.hidden) { m.hidden = true; if (m.id === 'pwdModal') closePwd(false); } });
      if (state.selected.size > 0) { clearSelection(); renderContent(); }
    }
  });
  document.addEventListener('keyup', (e) => { window.__shift = e.shiftKey; });

  // 拖拽上传：把文件拖到页面任意位置
  let dragDepth = 0;
  document.addEventListener('dragenter', (e) => {
    if (!(e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files'))) return;
    dragDepth++; document.body.classList.add('dragging');
  });
  document.addEventListener('dragleave', () => {
    dragDepth--; if (dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); }
  });
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => {
    dragDepth = 0; document.body.classList.remove('dragging');
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
      e.preventDefault();
      uploadFiles(e.dataTransfer.files);
    }
  });
}

/* ============================== 启动 ============================== */

async function init() {
  bindEvents();
  await loadStatus();
  await browse('/');
  await loadUsage();
  setInterval(loadUsage, 60000);
}

init();
