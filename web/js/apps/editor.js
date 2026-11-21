import { api, esc, fileIcon, fmtBytes, fmtDate, icon, openModal, timeAgo, toast } from '../core.js';
import { openTab } from '../shell.js';

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function renderMarkdown(source) {
  const escape = (value) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const lines = escape(source).split('\n');
  const out = [];
  let inCode = false;
  let inList = false;
  const inline = (text) =>
    text
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[\s(])\*([^*]+)\*/g, '$1<em>$2</em>')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

  for (const line of lines) {
    if (/^```/.test(line)) {
      if (inCode) {
        out.push('</pre>');
        inCode = false;
      } else {
        out.push('<pre>');
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      out.push(line);
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }
    const item = /^[-*]\s+(.*)$/.exec(line);
    if (item) {
      if (!inList) {
        out.push('<ul>');
        inList = true;
      }
      out.push(`<li>${inline(item[1])}</li>`);
      continue;
    }
    if (inList) {
      out.push('</ul>');
      inList = false;
    }
    if (/^&gt;\s?/.test(line)) {
      out.push(`<blockquote>${inline(line.replace(/^&gt;\s?/, ''))}</blockquote>`);
      continue;
    }
    if (!line.trim()) {
      out.push('');
      continue;
    }
    out.push(`<p>${inline(line)}</p>`);
  }
  if (inList) out.push('</ul>');
  if (inCode) out.push('</pre>');
  return out.join('\n');
}

export default function mount(root, ctx) {
  let currentPath = ctx.params.get('file') || '';
  let dirty = false;
  let preview = false;
  let content = '';
  let autosaveTimer = null;
  let saving = false;

  root.innerHTML = `<div class="page" style="gap:12px">
    <header class="page-head" style="padding-bottom:2px">
      <div>
        <h1 class="page-title">Editor</h1>
        <p class="page-sub">Write, edit and save documents straight into Files.</p>
      </div>
      <div class="page-actions">
        <button class="btn quiet sm" id="open-file">${icon('fa-regular fa-folder-open')} Open</button>
        <button class="btn quiet sm" id="new-file">${icon('fa-regular fa-file-lines')} New</button>
      </div>
    </header>

    <div class="editor-shell">
      <aside class="editor-side">
        <div class="editor-side-head">
          <span class="card-title" style="margin:0">${icon('fa-regular fa-folder')} Files</span>
          <button class="btn ghost icon sm" id="tree-refresh" title="Refresh">${icon('fa-solid fa-rotate')}</button>
        </div>
        <div class="editor-tree" id="tree"></div>
      </aside>

      <div class="editor-main">
        <div class="editor-bar">
          <span class="editor-file" id="editor-file">No file open</span>
          <span class="grow"></span>
          <button class="btn ghost icon sm" id="find-toggle" title="Find and replace (Ctrl F)" aria-label="Find and replace">${icon(
            'fa-solid fa-magnifying-glass'
          )}</button>
          <button class="btn ghost icon sm" id="outline-toggle" title="Outline" aria-label="Outline">${icon('fa-solid fa-list')}</button>
          <button class="btn ghost icon sm" id="history-toggle" title="Version history" aria-label="Version history">${icon(
            'fa-solid fa-clock-rotate-left'
          )}</button>
          <button class="btn ghost icon sm" id="export" title="Export" aria-label="Export">${icon('fa-solid fa-download')}</button>
          <button class="btn ghost sm" id="preview-toggle" title="Preview Markdown">${icon('fa-regular fa-eye')} Preview</button>
          <button class="btn ghost icon sm" id="office" title="Open office server" hidden>${icon(
            'fa-solid fa-file-word'
          )}</button>
          <button class="btn primary sm" id="save">${icon('fa-solid fa-floppy-disk')} Save</button>
        </div>
        <div class="find-bar hidden" id="find-bar">
          <input class="input" id="find-text" placeholder="Find…" aria-label="Find text" />
          <input class="input" id="replace-text" placeholder="Replace with…" aria-label="Replace text" />
          <button class="btn quiet sm" id="find-next">Next</button>
          <button class="btn quiet sm" id="replace-one">Replace</button>
          <button class="btn quiet sm" id="replace-all">All</button>
          <span class="grow"></span>
          <button class="btn ghost icon sm" id="find-close" aria-label="Close find">${icon('fa-solid fa-xmark')}</button>
        </div>
        <div class="editor-area" id="editor-area">
          <div class="editor-gutter" id="gutter">1</div>
          <textarea class="editor-textarea" id="text" spellcheck="false" placeholder="Open a file to start writing…"></textarea>
        </div>
        <div class="markdown-preview hidden" id="preview"></div>
        <div class="editor-status">
          <span id="status-path">—</span>
          <span id="status-lines">0 lines</span>
          <span id="status-words">0 words</span>
          <span id="status-saved">Saved</span>
        </div>
      </div>
    </div>
  </div>`;

  const textarea = root.querySelector('#text');
  const gutter = root.querySelector('#gutter');
  const fileLabel = root.querySelector('#editor-file');
  const previewEl = root.querySelector('#preview');
  const area = root.querySelector('#editor-area');
  const saveBtn = root.querySelector('#save');
  const previewBtn = root.querySelector('#preview-toggle');
  const treeEl = root.querySelector('#tree');

  /* --------------------------------- tree --------------------------------- */
  async function renderTree(dir = '', container = treeEl, depth = 0) {
    if (depth === 0) container.innerHTML = `<div class="skeleton" style="height:60px;margin:6px"></div>`;
    let data;
    try {
      data = await api(`/api/files?path=${encodeURIComponent(dir)}`);
    } catch (err) {
      container.innerHTML = `<p class="hint" style="padding:8px">${esc(err.message)}</p>`;
      return;
    }
    if (depth === 0) container.innerHTML = '';
    const relevant = data.entries.filter((entry) => entry.dir || entry.kind === 'text' || entry.kind === 'office');
    if (!relevant.length && depth === 0) {
      container.innerHTML = `<p class="hint" style="padding:8px">No documents yet.</p>`;
      return;
    }
    for (const entry of relevant) {
      const row = document.createElement('div');
      row.innerHTML = `<button class="tree-item" style="padding-left:${6 + depth * 12}px" data-path="${esc(entry.path)}" data-dir="${entry.dir}">
          ${icon(entry.dir ? 'fa-solid fa-folder' : fileIcon(entry.kind, entry.name))}
          <span class="truncate">${esc(entry.name)}</span>
        </button>`;
      const button = row.firstElementChild;
      container.appendChild(button);
      if (entry.dir) {
        let childBox = null;
        button.addEventListener('click', async (event) => {
          event.stopPropagation();
          if (childBox) {
            childBox.remove();
            childBox = null;
            return;
          }
          button.querySelector('i')?.classList.replace('fa-folder', 'fa-folder-open');
          childBox = document.createElement('div');
          container.insertBefore(childBox, button.nextSibling);
          await renderTree(entry.path, childBox, depth + 1);
        });
      } else {
        button.addEventListener('click', () => {
          treeEl.querySelectorAll('.tree-item.active').forEach((node) => node.classList.remove('active'));
          button.classList.add('active');
          openPath(entry.path);
        });
      }
    }
  }

  /* -------------------------------- editing -------------------------------- */
  function syncGutter() {
    const lines = textarea.value.split('\n').length;
    if (gutter.childElementCount !== lines) {
      gutter.innerHTML = Array.from({ length: lines }, (_, index) => index + 1).join('<br />');
    }
    root.querySelector('#status-lines').textContent = `${lines} line${lines === 1 ? '' : 's'}`;
    root.querySelector('#status-words').textContent = `${textarea.value.trim() ? textarea.value.trim().split(/\s+/).length : 0} words`;
    if (preview && currentPath.match(/\.(md|markdown)$/i)) {
      previewEl.innerHTML = renderMarkdown(textarea.value);
    }
  }

  function markDirty(value) {
    dirty = value;
    ctx.setTabDirty(ctx.tabId, value);
    root.querySelector('#status-saved').textContent = value ? 'Unsaved changes' : 'Saved';
    root.querySelector('#status-saved').style.color = value ? 'var(--warn)' : 'var(--text-3)';
  }

  textarea.addEventListener('input', () => {
    syncGutter();
    markDirty(true);
    clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(() => save({ silent: true }), 1500);
  });
  textarea.addEventListener('scroll', () => {
    gutter.scrollTop = textarea.scrollTop;
  });
  textarea.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      save();
    }
    if (event.key === 'Tab') {
      event.preventDefault();
      const start = textarea.selectionStart;
      textarea.value = `${textarea.value.slice(0, start)}  ${textarea.value.slice(textarea.selectionEnd)}`;
      textarea.selectionStart = textarea.selectionEnd = start + 2;
      syncGutter();
      markDirty(true);
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
      event.preventDefault();
      toggleFind(true);
    }
  });

  textarea.addEventListener('paste', async (event) => {
    if (!currentPath) return;
    const image = [...(event.clipboardData?.items || [])].find((item) => item.type.startsWith('image/'));
    if (!image) return;
    event.preventDefault();
    const file = image.getAsFile();
    if (!file) return;
    const folder = currentPath.includes('/') ? currentPath.slice(0, currentPath.lastIndexOf('/')) : '';
    const ext = (file.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
    const target = `${folder ? `${folder}/` : ''}assets/pasted-${Date.now()}.${ext}`;
    try {
      await api(`/api/files?path=${encodeURIComponent(target)}`, { method: 'PUT', body: file });
      const insertion = `\n![pasted image](${target})\n`;
      const start = textarea.selectionStart;
      textarea.value = `${textarea.value.slice(0, start)}${insertion}${textarea.value.slice(textarea.selectionEnd)}`;
      textarea.selectionStart = textarea.selectionEnd = start + insertion.length;
      syncGutter();
      markDirty(true);
      toast('Image uploaded and inserted');
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  async function save({ silent = false } = {}) {
    if (!currentPath) {
      if (!silent) toast('Open a file first', 'error');
      return;
    }
    if (saving) return;
    saving = true;
    saveBtn.disabled = true;
    const snapshot = textarea.value;
    try {
      await api('/api/files/text', { method: 'PUT', body: { path: currentPath, content: snapshot } });
      if (textarea.value === snapshot) markDirty(false);
      if (!silent) toast('Saved');
    } catch (err) {
      if (!silent) toast(err.message, 'error');
    } finally {
      saving = false;
      saveBtn.disabled = false;
    }
  }

  async function openPath(path) {
    try {
      clearTimeout(autosaveTimer);
      const data = await api(`/api/files/text?path=${encodeURIComponent(path)}`);
      currentPath = path;
      content = data.content;
      textarea.value = data.content;
      textarea.disabled = false;
      fileLabel.textContent = path;
      ctx.params.set('file', path);
      history.replaceState(null, '', `#/cc:editor?file=${encodeURIComponent(path)}`);
      ctx.setTabTitle(ctx.tabId, path.split('/').pop());
      markDirty(false);
      syncGutter();
      const isMarkdown = /\.(md|markdown)$/i.test(path);
      previewBtn.style.display = isMarkdown ? '' : 'none';
      if (!isMarkdown) preview = false;
      togglePreview(preview && isMarkdown);
      root.querySelector('#status-path').textContent = path;
      textarea.focus();
    } catch (err) {
      if (err.status === 415) {
        openTab(`viewer?path=${encodeURIComponent(path)}`);
        return;
      }
      toast(err.message, 'error');
    }
  }

  function togglePreview(force) {
    preview = force !== undefined ? force : !preview;
    if (preview && !currentPath.match(/\.(md|markdown)$/i)) preview = false;
    area.classList.toggle('hidden', preview);
    previewEl.classList.toggle('hidden', !preview);
    previewBtn.classList.toggle('primary', preview);
    if (preview) previewEl.innerHTML = renderMarkdown(textarea.value);
    previewBtn.innerHTML = preview ? `${icon('fa-solid fa-pen')} Edit` : `${icon('fa-regular fa-eye')} Preview`;
  }

  previewBtn.addEventListener('click', () => togglePreview());
  saveBtn.addEventListener('click', () => save());

  /* ------------------------------ find/replace ----------------------------- */
  const findBar = root.querySelector('#find-bar');
  const findText = root.querySelector('#find-text');
  const replaceText = root.querySelector('#replace-text');
  let findIndex = 0;

  function toggleFind(force) {
    const show = force !== undefined ? force : findBar.classList.contains('hidden');
    findBar.classList.toggle('hidden', !show);
    if (show) {
      findText.focus();
      findText.select();
    } else {
      textarea.focus();
    }
  }

  function findNext() {
    const needle = findText.value;
    if (!needle) return;
    const haystack = textarea.value.toLowerCase();
    const index = haystack.indexOf(needle.toLowerCase(), findIndex);
    const found = index >= 0 ? index : haystack.indexOf(needle.toLowerCase());
    if (found < 0) {
      toast('No matches', 'error');
      return;
    }
    textarea.focus();
    textarea.setSelectionRange(found, found + needle.length);
    findIndex = found + needle.length;
  }

  function replaceOne() {
    const needle = findText.value;
    if (!needle) return;
    const start = textarea.selectionStart;
    if (textarea.value.slice(start, start + needle.length).toLowerCase() === needle.toLowerCase()) {
      textarea.setRangeText(replaceText.value, start, start + needle.length, 'end');
      syncGutter();
      markDirty(true);
    }
    findNext();
  }

  function replaceAll() {
    const needle = findText.value;
    if (!needle) return;
    const pattern = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    const before = textarea.value;
    textarea.value = before.replace(pattern, replaceText.value);
    if (textarea.value !== before) {
      syncGutter();
      markDirty(true);
      toast('Replaced all matches');
    }
  }

  root.querySelector('#find-toggle').addEventListener('click', () => toggleFind());
  root.querySelector('#find-close').addEventListener('click', () => toggleFind(false));
  root.querySelector('#find-next').addEventListener('click', findNext);
  root.querySelector('#replace-one').addEventListener('click', replaceOne);
  root.querySelector('#replace-all').addEventListener('click', replaceAll);
  findText.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      findNext();
    }
  });

  /* -------------------------------- outline -------------------------------- */
  root.querySelector('#outline-toggle').addEventListener('click', () => {
    const headings = textarea.value
      .split('\n')
      .map((line, index) => ({ line, index, match: /^(#{1,4})\s+(.*)$/.exec(line) }))
      .filter((item) => item.match);
    openModal({
      title: 'Outline',
      sub: currentPath || 'No file open',
      body: headings.length
        ? `<div class="outline-list">${headings
            .map(
              (item) => `<button class="outline-row" data-line="${item.index}" style="padding-left:${8 + (item.match[1].length - 1) * 14}px">
                ${icon('fa-solid fa-hashtag')} ${esc(item.match[2])}
              </button>`
            )
            .join('')}</div>`
        : `<div class="empty compact">${icon('fa-solid fa-list')}<p>No Markdown headings yet. Start a line with #.</p></div>`,
      actions: [{ label: 'Close', kind: 'ghost' }],
      onMount: (dialog) => {
        dialog.querySelectorAll('[data-line]').forEach((node) => {
          node.addEventListener('click', () => {
            const line = Number(node.dataset.line);
            const offset = textarea.value.split('\n').slice(0, line).join('\n').length + (line ? 1 : 0);
            textarea.focus();
            textarea.setSelectionRange(offset, offset);
            const lineHeight = parseFloat(getComputedStyle(textarea).lineHeight) || 20;
            textarea.scrollTop = Math.max(0, line * lineHeight - textarea.clientHeight / 3);
            document.querySelector('.modal-backdrop')?.remove();
          });
        });
      }
    });
  });

  /* -------------------------------- history -------------------------------- */
  root.querySelector('#history-toggle').addEventListener('click', async () => {
    if (!currentPath) return toast('Open a file first', 'error');
    let versions = [];
    try {
      versions = (await api(`/api/files/versions?path=${encodeURIComponent(currentPath)}`)).versions || [];
    } catch (err) {
      return toast(err.message, 'error');
    }
    openModal({
      title: 'Version history',
      sub: currentPath,
      wide: true,
      body: versions.length
        ? `<div class="version-list">${versions
            .map(
              (version, index) => `<div class="version-row">
                <span class="file-ico">${icon('fa-solid fa-clock-rotate-left')}</span>
                <span class="grow"><span class="strong small">${index === 0 ? 'Latest save' : 'Earlier save'}</span>
                <span class="tiny dim" style="display:block">${fmtDate(version.at, { time: true })} · ${fmtBytes(version.size)}</span></span>
                <button class="btn quiet sm" data-editor-view="${esc(version.name)}">View</button>
                <button class="btn sm" data-editor-restore="${esc(version.name)}">Restore</button>
              </div>`
            )
            .join('')}</div>`
        : `<div class="empty compact">${icon('fa-solid fa-clock-rotate-left')}<p>No earlier versions yet.</p></div>`,
      actions: [{ label: 'Close', kind: 'ghost' }],
      onMount: (dialog) => {
        dialog.querySelectorAll('[data-editor-view]').forEach((node) => {
          node.addEventListener('click', async () => {
            const data = await api(`/api/files/version?path=${encodeURIComponent(currentPath)}&name=${encodeURIComponent(node.dataset.editorView)}`);
            openModal({ title: 'Version preview', sub: node.dataset.editorView, wide: true, body: `<pre class="log-box" style="max-height:52vh">${esc(data.content)}</pre>`, actions: [{ label: 'Close', kind: 'ghost' }] });
          });
        });
        dialog.querySelectorAll('[data-editor-restore]').forEach((node) => {
          node.addEventListener('click', async () => {
            try {
              await api('/api/files/version/restore', { method: 'POST', body: { path: currentPath, name: node.dataset.editorRestore } });
              toast('Version restored');
              document.querySelector('.modal-backdrop')?.remove();
              openPath(currentPath);
            } catch (err) {
              toast(err.message, 'error');
            }
          });
        });
      }
    });
  });

  /* -------------------------------- export --------------------------------- */
  root.querySelector('#export').addEventListener('click', () => {
    if (!currentPath) return toast('Open a file first', 'error');
    if (/\.(md|markdown)$/i.test(currentPath)) {
      const markup = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(currentPath)}</title><style>body{font-family:system-ui,sans-serif;max-width:760px;margin:48px auto;padding:0 20px;line-height:1.6;color:#16283a}pre{background:#f2f5f8;padding:14px;overflow:auto;border-radius:6px}blockquote{border-left:3px solid #58a9ea;margin:0;padding-left:14px;color:#555}a{color:#0b5fb0}</style></head><body>${renderMarkdown(textarea.value)}</body></html>`;
      const popup = window.open('', '_blank');
      if (!popup) return toast('Allow pop-ups to export', 'error');
      popup.document.write(markup);
      popup.document.close();
      popup.focus();
      popup.print();
      return;
    }
    const blob = new Blob([textarea.value], { type: 'text/plain;charset=utf-8' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = currentPath.split('/').pop() || 'document.txt';
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 2000);
  });
  root.querySelector('#tree-refresh').addEventListener('click', async () => {
    treeEl.innerHTML = '';
    await renderTree();
    if (currentPath) openPath(currentPath);
  });

  root.querySelector('#new-file').addEventListener('click', () => {
    openModal({
      title: 'New document',
      body: `<div class="field"><label class="label">Path</label><input class="input" id="new-path" placeholder="docs/notes.md" value="untitled.md" />
      <p class="hint">Folders are created automatically.</p></div>`,
      actions: [
        { label: 'Cancel', kind: 'ghost' },
        {
          label: 'Create',
          kind: 'primary',
          onClick: async ({ dialog }) => {
            const path = dialog.querySelector('#new-path').value.trim();
            if (!path) return false;
            await api('/api/files/text', { method: 'PUT', body: { path, content: '', create: true } });
            await openPath(path);
            await root.querySelector('#tree-refresh').click();
          }
        }
      ]
    });
  });

  root.querySelector('#open-file').addEventListener('click', () => {
    openModal({
      title: 'Open a file',
      body: `<div class="field"><label class="label">Path in Files</label><input class="input" id="open-path" placeholder="docs/notes.md" /></div>`,
      actions: [
        { label: 'Cancel', kind: 'ghost' },
        {
          label: 'Open',
          kind: 'primary',
          onClick: async ({ dialog }) => {
            const path = dialog.querySelector('#open-path').value.trim();
            if (!path) return false;
            await openPath(path);
          }
        }
      ]
    });
  });

  api('/api/editor')
    .then((config) => {
      const officeButton = root.querySelector('#office');
      if (config.url && config.provider !== 'none') {
        officeButton.hidden = false;
        officeButton.addEventListener('click', () => window.open(config.url, '_blank', 'noopener'));
      }
    })
    .catch(() => {});

  renderTree();
  if (currentPath) openPath(currentPath);
  else {
    textarea.disabled = true;
    textarea.placeholder = 'Choose a file from the left, or create a new one.';
  }

  return () => clearTimeout(autosaveTimer);
}
