const app = document.querySelector('#app');
const token = new URLSearchParams(location.search).get('t') || '';
let password = sessionStorage.getItem(`cc-share:${token}`) || '';
let currentPath = '';
let data = null;

const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

function bytes(size) {
  const value = Number(size) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10240 ? 1 : 0)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function rawUrl(path, download = false) {
  const params = new URLSearchParams();
  if (path) params.set('path', path);
  if (password) params.set('password', password);
  if (download) params.set('download', '1');
  return `/api/public/share/${encodeURIComponent(token)}/raw?${params}`;
}

function mark() {
  return '<span class="mark"><span>C</span><i></i><span>L</span></span>';
}

function errorView(title, message, retry = false) {
  app.innerHTML = `<div class="share-head">${mark()}<div class="grow"><div class="share-title">Shared with you</div><div class="share-sub">CoolCloud</div></div></div>
    <div class="share-body">
      <h1 class="share-name">${esc(title)}</h1>
      <p class="share-meta">${esc(message)}</p>
      <div class="actions">${retry ? '<button class="btn primary" id="retry-password">Try another password</button>' : ''}<a class="btn ghost" href="/">Open CoolCloud</a></div>
    </div>`;
  app.querySelector('#retry-password')?.addEventListener('click', () => {
    sessionStorage.removeItem(`cc-share:${token}`);
    password = '';
    load();
  });
}

function passwordView(message = '') {
  app.innerHTML = `<div class="share-head">${mark()}<div class="grow"><div class="share-title">Protected link</div><div class="share-sub">CoolCloud</div></div></div>
    <div class="share-body">
      <h1 class="share-name">This link is locked</h1>
      <p class="share-meta">Enter the password the sender shared with you.</p>
      ${message ? `<p class="error">${esc(message)}</p>` : ''}
      <form id="password-form">
        <div class="field"><label class="label" for="share-password">Password</label><input class="input" id="share-password" type="password" autocomplete="current-password" autofocus required /></div>
        <div class="actions"><button class="btn primary" type="submit">Unlock</button></div>
      </form>
      <p class="hint" style="margin-top:14px">CoolCloud never shows the password to anyone, including the sender after they set it.</p>
    </div>`;
  const form = app.querySelector('#password-form');
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    password = form.querySelector('#share-password').value;
    sessionStorage.setItem(`cc-share:${token}`, password);
    load();
  });
  form.querySelector('input').focus();
}

async function load(path = currentPath) {
  if (!token) return errorView('Invalid link', 'This address is missing its share token.');
  app.innerHTML = `<div class="share-loading">${mark()}<p>Opening shared item…</p></div>`;
  const params = new URLSearchParams();
  if (password) params.set('password', password);
  if (path) params.set('path', path);
  let response;
  try {
    response = await fetch(`/api/public/share/${encodeURIComponent(token)}?${params}`);
  } catch {
    return errorView('Could not reach this server', 'Check the connection and try again.');
  }
  let body = {};
  try {
    body = await response.json();
  } catch {
    body = {};
  }
  if (response.status === 401 && body.passwordRequired) return passwordView();
  if (response.status === 403) return passwordView(body.error || 'That password is not correct.');
  if (!response.ok) return errorView('This link is unavailable', body.error || 'The link expired or was removed.');
  data = body;
  currentPath = path;
  render();
}

function fileKindLabel(kind) {
  return (
    {
      image: 'IMG',
      video: 'VID',
      audio: 'AUD',
      pdf: 'PDF',
      text: 'TXT',
      office: 'DOC',
      archive: 'ZIP',
      folder: 'DIR'
    }[kind] || 'FILE'
  );
}

async function render() {
  const entry = data.entry;
  const share = data.share;
  const isFolder = entry.dir;
  const entries = Array.isArray(entry.entries) ? entry.entries : [];
  const canGoUp = currentPath && currentPath !== entry.path && isFolder;
  let preview = '';
  if (!isFolder && entry.kind === 'image') {
    preview = `<div class="preview"><img src="${rawUrl(entry.path)}" alt="${esc(entry.name)}" /></div>`;
  } else if (!isFolder && entry.kind === 'video') {
    preview = `<div class="preview"><video controls src="${rawUrl(entry.path)}"></video></div>`;
  } else if (!isFolder && entry.kind === 'audio') {
    preview = `<div class="preview"><audio controls src="${rawUrl(entry.path)}" style="width:80%"></audio></div>`;
  } else if (!isFolder && entry.kind === 'pdf') {
    preview = `<div class="preview"><iframe src="${rawUrl(entry.path)}" title="${esc(entry.name)}"></iframe></div>`;
  } else if (!isFolder && entry.kind === 'text' && Number(entry.size) < 300000) {
    try {
      const text = await fetch(rawUrl(entry.path)).then((response) => (response.ok ? response.text() : ''));
      preview = `<div class="preview"><pre>${esc(text.slice(0, 120000))}</pre></div>`;
    } catch {
      preview = '';
    }
  }

  const downloadHref = isFolder ? '' : rawUrl(entry.path, true);
  const parentPath = currentPath && currentPath.includes('/') ? currentPath.slice(0, currentPath.lastIndexOf('/')) : entry.path;
  const listing = isFolder
    ? `<div class="file-list">${canGoUp ? `<a class="file-row" href="#" data-path="${esc(parentPath)}"><span class="kind">UP</span><span class="grow">Back to parent folder</span></a>` : ''}${entries
        .map(
          (item) =>
            item.dir
              ? `<a class="file-row" href="#" data-path="${esc(item.path)}"><span class="kind">DIR</span><span class="grow">${esc(item.name)}</span><span class="size">Folder</span></a>`
              : `<a class="file-row" href="${rawUrl(item.path, true)}"><span class="kind">${fileKindLabel(item.kind)}</span><span class="grow">${esc(item.name)}</span><span class="size">${bytes(item.size)}</span></a>`
        )
        .join('') || '<p class="hint">This folder is empty.</p>'}</div>`
    : '';

  app.innerHTML = `<div class="share-head">${mark()}<div class="grow"><div class="share-title">Shared with you</div><div class="share-sub">${esc(
    share.kind === 'folder' ? 'Shared folder' : 'Shared file'
  )}${share.expiresAt ? ` · expires ${new Date(share.expiresAt).toLocaleDateString()}` : ''}</div></div></div>
    <div class="share-body">
      <h1 class="share-name">${esc(entry.name)}</h1>
      <p class="share-meta">${isFolder ? `${entries.length} item${entries.length === 1 ? '' : 's'}` : bytes(entry.size)} · updated ${new Date(entry.mtime).toLocaleDateString()}</p>
      ${preview}
      ${listing}
      <div class="actions">
        ${isFolder ? '' : `<a class="btn primary" href="${downloadHref}" download>Download</a>`}
        ${share.allowUpload && isFolder ? `<label class="btn">Upload a file<input type="file" id="share-upload" hidden /></label>` : ''}
        <span class="grow"></span><a class="btn ghost" href="/">Open CoolCloud</a>
      </div>
      ${share.allowUpload && isFolder ? '<p class="hint" style="margin-top:10px">Uploads go to the folder owner. Please only add files they expect.</p>' : ''}
    </div>`;

  app.querySelectorAll('[data-path]').forEach((node) => {
    node.addEventListener('click', (event) => {
      event.preventDefault();
      load(node.dataset.path);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  });

  const upload = app.querySelector('#share-upload');
  upload?.addEventListener('change', async () => {
    const file = upload.files?.[0];
    if (!file) return;
    upload.disabled = true;
    try {
      const params = new URLSearchParams({ name: file.name, password });
      const response = await fetch(`/api/public/share/${encodeURIComponent(token)}/upload?${params}`, { method: 'POST', body: file });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || 'Upload failed');
      upload.closest('.actions').insertAdjacentHTML('beforebegin', `<p class="note">${esc(file.name)} uploaded.</p>`);
      load();
    } catch (err) {
      upload.closest('.actions').insertAdjacentHTML('beforebegin', `<p class="error">${esc(err.message)}</p>`);
    } finally {
      upload.disabled = false;
      upload.value = '';
    }
  });
}

load();
