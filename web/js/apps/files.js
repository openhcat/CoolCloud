import {
  api,
  closeModal,
  confirmDialog,
  esc,
  fileIcon,
  fmtBytes,
  fmtDate,
  icon,
  openModal,
  timeAgo,
  toast
} from '../core.js';
import { openTab } from '../shell.js';

const SORT_OPTIONS = [
  ['name-asc', 'Name · A to Z'],
  ['name-desc', 'Name · Z to A'],
  ['mtime-desc', 'Newest first'],
  ['mtime-asc', 'Oldest first'],
  ['size-desc', 'Largest first'],
  ['size-asc', 'Smallest first'],
  ['kind-asc', 'Type']
];

function readPref(key, fallback) {
  try {
    return localStorage.getItem(key) || fallback;
  } catch {
    return fallback;
  }
}

function writePref(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

function basename(path) {
  return String(path || '').split('/').pop() || '';
}

function dirname(path) {
  const text = String(path || '');
  return text.includes('/') ? text.slice(0, text.lastIndexOf('/')) : '';
}

function joinPath(parent, name) {
  const base = String(parent || '').replace(/\/+$/, '');
  return base ? `${base}/${name}` : name;
}

function isTyping() {
  const tag = document.activeElement?.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || document.activeElement?.isContentEditable;
}

export default function mount(root, ctx) {
  let current = ctx.params.get('path') || '';
  let entries = [];
  let selected = new Set();
  let lastIndex = 0;
  let filter = '';
  let sort = readPref('cc:filesSort', 'name-asc');
  let view = readPref('cc:filesView', 'list');
  let folders = [];
  let draggedPath = '';

  root.innerHTML = `<div class="page files-page">
    <header class="page-head">
      <div>
        <h1 class="page-title">Files</h1>
        <p class="page-sub">Shared across everyone on this CoolCloud.</p>
      </div>
      <div class="page-actions">
        <button class="btn quiet sm" id="new-doc">${icon('fa-regular fa-file-lines')} New document</button>
        <button class="btn quiet sm" id="new-folder">${icon('fa-regular fa-folder')} New folder</button>
        <button class="btn quiet sm" id="upload-folder">${icon('fa-solid fa-folder-tree')} Upload folder</button>
        <button class="btn quiet sm" id="more-files">${icon('fa-solid fa-ellipsis')} More</button>
        <button class="btn primary sm" id="upload">${icon('fa-solid fa-arrow-up-from-bracket')} Upload</button>
      </div>
    </header>

    <div class="files-bar">
      <div class="crumbs" id="crumbs"></div>
      <span class="grow"></span>
      <div class="input-group files-search">
        ${icon('fa-solid fa-magnifying-glass')}
        <input id="files-filter" placeholder="Filter this folder" aria-label="Filter this folder" autocomplete="off" />
      </div>
      <select class="select files-sort" id="files-sort" aria-label="Sort files">
        ${SORT_OPTIONS.map(
          ([value, label]) => `<option value="${value}" ${sort === value ? 'selected' : ''}>${label}</option>`
        ).join('')}
      </select>
      <div class="segmented files-view" role="group" aria-label="View">
        <button type="button" data-view="list" aria-selected="${view === 'list'}" title="List view">${icon(
          'fa-solid fa-list'
        )}</button>
        <button type="button" data-view="grid" aria-selected="${view === 'grid'}" title="Grid view">${icon(
          'fa-solid fa-table-cells-large'
        )}</button>
      </div>
    </div>

    <div class="files-bulk hidden" id="bulk">
      <span class="files-bulk-count" id="bulk-count"></span>
      <button class="btn quiet sm" data-bulk="move">${icon('fa-solid fa-folder-open')} Move to…</button>
      <button class="btn quiet sm" data-bulk="copy">${icon('fa-regular fa-copy')} Duplicate</button>
      <button class="btn quiet sm" data-bulk="download">${icon('fa-solid fa-file-zipper')} Download ZIP</button>
      <span class="grow"></span>
      <button class="btn quiet sm" data-bulk="clear">Clear</button>
      <button class="btn danger sm" data-bulk="delete">${icon('fa-solid fa-trash-can')} Delete</button>
    </div>

    <div class="file-table ${view === 'grid' ? 'grid-mode' : ''}" id="table">
      <div class="file-drop-overlay" id="drop-overlay">${icon('fa-solid fa-cloud-arrow-up')}<span>Drop to upload</span></div>
      <div class="file-row head" id="file-head">
        <span class="file-check"><input type="checkbox" id="check-all" aria-label="Select all" /></span>
        <button class="file-sort-head" data-sort="name">Name ${icon('fa-solid fa-sort')}</button>
        <button class="file-sort-head" data-sort="size">Size ${icon('fa-solid fa-sort')}</button>
        <button class="file-sort-head" data-sort="mtime">Modified ${icon('fa-solid fa-sort')}</button>
        <span></span>
      </div>
      <div id="rows"><div class="skeleton" style="height:120px;margin:14px"></div></div>
    </div>

    <div class="files-foot">
      <span class="files-hint tiny dim" id="files-hint"></span>
      <span class="files-shortcuts tiny dim">
        <span><span class="kbd">F2</span> rename</span>
        <span><span class="kbd">Del</span> delete</span>
        <span><span class="kbd">Ctrl A</span> select all</span>
        <span>Drag a file onto a folder to move it</span>
      </span>
    </div>

    <div class="upload-queue" id="upload-queue" aria-live="polite"></div>
    <input type="file" id="file-input" multiple hidden />
    <input type="file" id="folder-input" webkitdirectory directory multiple hidden />
  </div>`;

  const rows = root.querySelector('#rows');
  const crumbs = root.querySelector('#crumbs');
  const input = root.querySelector('#file-input');
  const folderInput = root.querySelector('#folder-input');
  const overlay = root.querySelector('#drop-overlay');
  const bulk = root.querySelector('#bulk');
  const hint = root.querySelector('#files-hint');
  const table = root.querySelector('#table');
  const filterInput = root.querySelector('#files-filter');
  const uploadQueue = root.querySelector('#upload-queue');

  /* --------------------------------- data --------------------------------- */

  async function load() {
    try {
      const data = await api(`/api/files?path=${encodeURIComponent(current)}`);
      entries = data.entries;
      selected.clear();
      lastIndex = 0;
      renderCrumbs(data.breadcrumbs);
      renderRows();
      ctx.params.set('path', current);
      history.replaceState(null, '', `#/cc:files${current ? `?path=${encodeURIComponent(current)}` : ''}`);
    } catch (err) {
      rows.innerHTML = `<div class="empty">${icon('fa-solid fa-triangle-exclamation')}<p>${esc(err.message)}</p>${
        err.status === 403 ? `<button class="btn primary sm" id="request-access">${icon('fa-solid fa-key')} Request access</button>` : ''
      }</div>`;
      rows.querySelector('#request-access')?.addEventListener('click', () => requestAccess(current));
    }
  }

  function requestAccess(path) {
    openModal({
      title: 'Request access',
      sub: path || 'Files',
      body: `<div class="field"><label class="label">Message to the owner</label><textarea class="textarea" id="access-note" rows="4" maxlength="500" placeholder="What do you need this folder for?"></textarea></div>`,
      actions: [
        { label: 'Cancel', kind: 'ghost' },
        {
          label: 'Send request',
          kind: 'primary',
          onClick: async ({ dialog }) => {
            try {
              await api('/api/files/acl/request', { method: 'POST', body: { path, note: dialog.querySelector('#access-note').value } });
              toast('Request sent to the folder owner');
            } catch (err) {
              toast(err.message, 'error');
              return false;
            }
          }
        }
      ]
    });
  }

  async function openSharedWithMe() {
    let data;
    try {
      data = await api('/api/files/shared-with-me');
    } catch (err) {
      return toast(err.message, 'error');
    }
    const requests = await api('/api/files/acl/requests').catch(() => ({ requests: [] }));
    openModal({
      title: 'Shared with me',
      sub: 'Folders you can open through a direct or team grant.',
      wide: true,
      body: `<div class="stack-3">
        <div class="stack-2">${data.items.length
          ? data.items
              .map(
                (item) => `<button class="version-row acl-shared-row" data-shared-path="${esc(item.path)}"><span class="file-ico">${icon(item.dir ? 'fa-regular fa-folder' : 'fa-regular fa-file')}</span>
                  <span class="grow" style="min-width:0"><span class="strong small">${esc(item.name)}</span><span class="tiny dim" style="display:block">${esc(item.owner)}${item.team ? ` · via ${esc(item.team)}` : ''} · ${esc(item.role)}${item.expiresAt ? ` · expires ${fmtDate(item.expiresAt)}` : ''}</span></span>
                  <span class="badge">${esc(item.role)}</span></button>`
              )
              .join('')
          : '<p class="hint">Nothing is shared with you yet. Restricted folders you cannot open will show a Request access button.</p>'}</div>
        ${requests.requests?.length ? `<div class="field"><label class="label">Your pending requests</label>${requests.requests.map((request) => `<div class="acl-grant"><span class="file-ico">${icon('fa-solid fa-clock')}</span><span class="grow"><span class="strong small">${esc(request.path || 'Files')}</span><span class="tiny dim" style="display:block">${esc(request.note || 'Waiting for the owner')} · ${timeAgo(request.createdAt)}</span></span><span class="badge warn">Pending</span></div>`).join('')}</div>` : ''}
      </div>`,
      actions: [{ label: 'Close', kind: 'ghost' }],
      onMount: (dialog) => {
        dialog.querySelectorAll('[data-shared-path]').forEach((node) => {
          node.addEventListener('click', () => {
            closeModal();
            current = node.dataset.sharedPath;
            load();
          });
        });
      }
    });
  }

  async function loadFolders() {
    try {
      folders = (await api('/api/files/folders')).folders || [];
    } catch {
      folders = [];
    }
    return folders;
  }

  function visibleEntries() {
    const needle = filter.trim().toLowerCase();
    const list = needle
      ? entries.filter((entry) => `${entry.name} ${entry.tags || ''}`.toLowerCase().includes(needle))
      : [...entries];
    const [key, direction] = sort.split('-');
    const factor = direction === 'desc' ? -1 : 1;
    list.sort((a, b) => {
      if (a.dir !== b.dir) return a.dir ? -1 : 1;
      if (key === 'size') return ((a.size || 0) - (b.size || 0)) * factor;
      if (key === 'mtime') return (new Date(a.mtime) - new Date(b.mtime)) * factor;
      if (key === 'kind') return String(a.kind).localeCompare(String(b.kind)) * factor;
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }) * factor;
    });
    return list;
  }

  function renderCrumbs(breadcrumbs) {
    crumbs.innerHTML = breadcrumbs
      .map(
        (crumb, index) =>
          `${index ? `<span class="crumb-sep">${icon('fa-solid fa-chevron-right')}</span>` : ''}<button class="crumb ${
            index === breadcrumbs.length - 1 ? 'current' : ''
          }" data-crumb="${esc(crumb.path)}" ${index === breadcrumbs.length - 1 ? 'aria-current="page"' : ''}>${esc(
            crumb.name
          )}</button>`
      )
      .join('');
    crumbs.querySelectorAll('[data-crumb]').forEach((node) => {
      node.addEventListener('click', () => {
        current = node.dataset.crumb;
        filter = '';
        filterInput.value = '';
        load();
      });
    });
  }

  function syncBulk() {
    const count = selected.size;
    bulk.classList.toggle('hidden', !count);
    const all = root.querySelector('#check-all');
    const picked = selectedEntries();
    const bytes = picked.reduce((sum, entry) => sum + (entry.size || 0), 0);
    const dirs = picked.filter((entry) => entry.dir).length;
    root.querySelector('#bulk-count').textContent = `${count} selected${
      dirs ? ` · ${dirs} folder${dirs === 1 ? '' : 's'}` : ''
    }${bytes ? ` · ${fmtBytes(bytes)}` : ''}`;
    const list = visibleEntries();
    if (all) {
      all.checked = list.length > 0 && list.every((entry) => selected.has(entry.path));
      all.indeterminate = count > 0 && !all.checked;
    }
    rows.querySelectorAll('[data-path]').forEach((node) => {
      node.classList.toggle('selected', selected.has(node.dataset.path));
      const box = node.querySelector('input[type="checkbox"]');
      if (box) box.checked = selected.has(node.dataset.path);
    });
    const download = root.querySelector('[data-bulk="download"]');
    if (download) {
      const anyFolder = list.some((entry) => entry.dir && selected.has(entry.path));
      download.classList.toggle('hidden', anyFolder);
    }
  }

  function updateSortHeads() {
    const [key, direction] = sort.split('-');
    root.querySelectorAll('[data-sort]').forEach((node) => {
      const active = node.dataset.sort === key;
      node.dataset.active = String(active);
      const glyph = node.querySelector('i');
      if (glyph) glyph.className = `fa-solid ${active ? (direction === 'asc' ? 'fa-sort-up' : 'fa-sort-down') : 'fa-sort'}`;
    });
  }

  function renderRows() {
    const list = visibleEntries();
    updateSortHeads();
    root.querySelector('#file-head').classList.toggle('hidden', view === 'grid');
    table.classList.toggle('grid-mode', view === 'grid');

    if (!list.length) {
      rows.innerHTML = `<div class="empty">${icon('fa-regular fa-folder-open')}<p>${
        filter ? 'Nothing matches that filter.' : 'This folder is empty.'
      }</p><div class="row" style="justify-content:center;gap:8px">${
        filter
          ? `<button class="btn sm" data-clear-filter>Clear filter</button>`
          : `<button class="btn sm" data-empty-upload>Upload a file</button><button class="btn sm" data-empty-folder>New folder</button>`
      }</div></div>`;
      rows.querySelector('[data-empty-upload]')?.addEventListener('click', () => input.click());
      rows.querySelector('[data-empty-folder]')?.addEventListener('click', newFolder);
      rows.querySelector('[data-clear-filter]')?.addEventListener('click', () => {
        filter = '';
        filterInput.value = '';
        renderRows();
      });
      updateHint(list);
      syncBulk();
      return;
    }

    if (view === 'grid') {
      rows.innerHTML = `<div class="file-grid">${list
        .map(
          (entry) => `<div class="file-card ${selected.has(entry.path) ? 'selected' : ''}" data-path="${esc(
            entry.path
          )}" data-dir="${entry.dir}" data-kind="${entry.kind}" draggable="true" tabindex="0">
            <span class="file-check"><input type="checkbox" ${
              selected.has(entry.path) ? 'checked' : ''
            } aria-label="Select ${esc(entry.name)}" /></span>
            <span class="file-card-icon">${icon(fileIcon(entry.kind, entry.name))}</span>
            <span class="file-card-name">${entry.access?.restricted ? `<span class="acl-lock" title="Restricted · ${esc(entry.access.owner || 'owner')}">${icon('fa-solid fa-lock')}</span>` : ''}${esc(entry.name)}</span>
            <span class="file-card-meta">${entry.dir ? 'Folder' : fmtBytes(entry.size)}</span>
            <button class="btn ghost icon sm file-card-menu" data-menu="${esc(entry.path)}" aria-label="Actions for ${esc(
              entry.name
            )}">${icon('fa-solid fa-ellipsis')}</button>
          </div>`
        )
        .join('')}</div>`;
    } else {
      rows.innerHTML = list
        .map(
          (entry) => `<div class="file-row ${selected.has(entry.path) ? 'selected' : ''}" data-path="${esc(
            entry.path
          )}" data-dir="${entry.dir}" data-kind="${entry.kind}" draggable="true" tabindex="0">
            <span class="file-check"><input type="checkbox" ${
              selected.has(entry.path) ? 'checked' : ''
            } aria-label="Select ${esc(entry.name)}" /></span>
            <div class="file-name-cell">
              <span class="file-ico" style="${
                entry.dir ? 'background:var(--accent-soft);color:var(--accent)' : ''
              }">${icon(fileIcon(entry.kind, entry.name))}</span>
              <span class="name">${entry.access?.restricted ? `<span class="acl-lock" title="Restricted · ${esc(entry.access.owner || 'owner')} · ${esc(entry.access.role || '')}">${icon('fa-solid fa-lock')}</span>` : ''}${esc(entry.name)}</span>
            </div>
            <span class="meta">${entry.dir ? 'Folder' : fmtBytes(entry.size)}</span>
            <span class="meta">${timeAgo(entry.mtime)}</span>
            <span class="row-actions">
              <button class="btn ghost icon sm" data-menu="${esc(entry.path)}" aria-label="Actions for ${esc(
                entry.name
              )}">${icon('fa-solid fa-ellipsis')}</button>
            </span>
          </div>`
        )
        .join('');
    }

    rows.querySelectorAll('[data-path]').forEach((row) => {
      const box = row.querySelector('input[type="checkbox"]');
      box.addEventListener('click', (event) => {
        event.stopPropagation();
        toggleSelection(row.dataset.path, { range: event.shiftKey, additive: true });
      });
      row.addEventListener('click', (event) => {
        if (event.target.closest('[data-menu]') || event.target.closest('.file-check')) return;
        toggleSelection(row.dataset.path, { additive: event.metaKey || event.ctrlKey, range: event.shiftKey });
      });
      row.addEventListener('dblclick', (event) => {
        if (event.target.closest('[data-menu]')) return;
        openRow(row);
      });
      row.querySelector('.name')?.addEventListener('click', (event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey) return;
        event.stopPropagation();
        openRow(row);
      });
      row.querySelector('[data-menu]').addEventListener('click', (event) => {
        event.stopPropagation();
        actionMenu(event, row);
      });
      row.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          openRow(row);
        } else if (event.key === ' ') {
          event.preventDefault();
          toggleSelection(row.dataset.path, { additive: true });
        } else if (event.key === 'F2') {
          event.preventDefault();
          rename(row.dataset.path);
        } else if (event.key === 'Delete' && selected.size) {
          event.preventDefault();
          removeSelected();
        }
      });
      row.addEventListener('dragstart', (event) => {
        draggedPath = row.dataset.path;
        row.classList.add('dragging');
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', row.dataset.path);
      });
      row.addEventListener('dragend', () => {
        draggedPath = '';
        row.classList.remove('dragging');
        rows.querySelectorAll('.drop-target').forEach((node) => node.classList.remove('drop-target'));
      });
      if (row.dataset.dir === 'true') {
        row.addEventListener('dragover', (event) => {
          if (!draggedPath || draggedPath === row.dataset.path) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = 'move';
          row.classList.add('drop-target');
        });
        row.addEventListener('dragleave', () => row.classList.remove('drop-target'));
        row.addEventListener('drop', async (event) => {
          const files = event.dataTransfer.files;
          if (files?.length) return;
          event.preventDefault();
          event.stopPropagation();
          row.classList.remove('drop-target');
          const from = event.dataTransfer.getData('text/plain') || draggedPath;
          if (!from || from === row.dataset.path) return;
          await moveOne(from, row.dataset.path);
        });
      }
    });
    updateHint(list);
    syncBulk();
  }

  function updateHint(list) {
    const files = list.filter((entry) => !entry.dir).length;
    const dirs = list.length - files;
    const bytes = list.reduce((sum, entry) => sum + (entry.size || 0), 0);
    hint.textContent = `${list.length} item${list.length === 1 ? '' : 's'}${dirs ? ` · ${dirs} folder${dirs === 1 ? '' : 's'}` : ''}${
      files ? ` · ${files} file${files === 1 ? '' : 's'} · ${fmtBytes(bytes)}` : ''
    }${filter ? ' · filtered' : ''}`;
  }

  /* ------------------------------- selection ------------------------------ */

  function toggleSelection(path, { additive = false, range = false } = {}) {
    const list = visibleEntries();
    const index = list.findIndex((entry) => entry.path === path);
    if (range && lastIndex >= 0) {
      const [start, end] = [Math.min(lastIndex, index), Math.max(lastIndex, index)];
      if (!additive) selected.clear();
      for (const entry of list.slice(start, end + 1)) selected.add(entry.path);
    } else if (additive) {
      if (selected.has(path)) selected.delete(path);
      else selected.add(path);
      lastIndex = index;
    } else {
      selected.clear();
      selected.add(path);
      lastIndex = index;
    }
    syncBulk();
  }

  function selectedEntries() {
    return entries.filter((entry) => selected.has(entry.path));
  }

  /* --------------------------------- open --------------------------------- */

  function openRow(row) {
    const path = row.dataset.path;
    const isDir = row.dataset.dir === 'true';
    if (isDir) {
      current = path;
      filter = '';
      filterInput.value = '';
      load();
      return;
    }
    openPath(path, row.dataset.kind);
  }

  function openPath(path, kind) {
    if (kind === 'text') {
      openTab(`cc:editor?file=${encodeURIComponent(path)}`);
      return;
    }
    openTab(`viewer?path=${encodeURIComponent(path)}`);
  }

  /* --------------------------------- actions ------------------------------- */

  function actionMenu(event, row) {
    const path = row.dataset.path;
    const isDir = row.dataset.dir === 'true';
    const entry = entries.find((item) => item.path === path);
    document.querySelector('.menu')?.remove();
    const menu = document.createElement('div');
    menu.className = 'menu file-actions-menu';
    menu.innerHTML = `
      <button data-act="open">${icon('fa-solid fa-arrow-up-right-from-square')} Open</button>
      ${isDir ? '' : `<button data-act="download">${icon('fa-solid fa-download')} Download</button>`}
      <button data-act="rename">${icon('fa-solid fa-pen')} Rename</button>
      <button data-act="duplicate">${icon('fa-regular fa-copy')} Duplicate</button>
      <button data-act="move">${icon('fa-solid fa-folder-open')} Move to…</button>
      <div class="sep"></div>
      <button data-act="favorite">${icon(entry?.favorite ? 'fa-solid fa-star' : 'fa-regular fa-star')} ${entry?.favorite ? 'Remove star' : 'Star'}</button>
      <button data-act="tags">${icon('fa-solid fa-tag')} Tags</button>
      <button data-act="share">${icon('fa-solid fa-link')} Share…</button>
      ${isDir ? '' : `<button data-act="versions">${icon('fa-solid fa-clock-rotate-left')} Version history</button>`}
      <button data-act="comments">${icon('fa-regular fa-comment')} Comments</button>
      <div class="sep"></div>
      <button data-act="details">${icon('fa-solid fa-circle-info')} Details</button>
      ${isDir ? `<button data-act="zip">${icon('fa-solid fa-file-zipper')} Download ZIP</button>` : `<button data-act="link">${icon('fa-solid fa-link')} Copy link</button>`}
      <div class="sep"></div>
      <button data-act="delete" class="danger">${icon('fa-solid fa-trash-can')} Delete</button>`;
    document.body.appendChild(menu);
    const rect = event.currentTarget.getBoundingClientRect();
    menu.style.top = `${Math.min(window.innerHeight - 340, rect.bottom + 6)}px`;
    menu.style.left = `${Math.min(window.innerWidth - 224, rect.right - 200)}px`;

    const close = () => menu.remove();
    setTimeout(() => document.addEventListener('click', close, { once: true }), 0);

    menu.querySelector('[data-act="open"]').addEventListener('click', () => {
      close();
      if (isDir) {
        current = path;
        filter = '';
        filterInput.value = '';
        load();
        return;
      }
      openPath(path, row.dataset.kind);
    });
    menu.querySelector('[data-act="download"]')?.addEventListener('click', () => {
      close();
      window.open(`/api/files/raw?path=${encodeURIComponent(path)}&download=1`, '_blank');
    });
    menu.querySelector('[data-act="rename"]').addEventListener('click', () => {
      close();
      rename(path);
    });
    menu.querySelector('[data-act="duplicate"]').addEventListener('click', () => {
      close();
      duplicate([path]);
    });
    menu.querySelector('[data-act="move"]').addEventListener('click', () => {
      close();
      moveDialog([path]);
    });
    menu.querySelector('[data-act="details"]').addEventListener('click', () => {
      close();
      details(entry);
    });
    menu.querySelector('[data-act="favorite"]').addEventListener('click', () => {
      close();
      toggleFavorite(entry);
    });
    menu.querySelector('[data-act="tags"]').addEventListener('click', () => {
      close();
      editTags(entry);
    });
    menu.querySelector('[data-act="share"]').addEventListener('click', () => {
      close();
      shareDialog(entry);
    });
    menu.querySelector('[data-act="versions"]')?.addEventListener('click', () => {
      close();
      versionsDialog(entry);
    });
    menu.querySelector('[data-act="comments"]').addEventListener('click', () => {
      close();
      commentsDialog(entry);
    });
    menu.querySelector('[data-act="zip"]')?.addEventListener('click', () => {
      close();
      downloadZip([path]);
    });
    menu.querySelector('[data-act="link"]')?.addEventListener('click', async () => {
      close();
      try {
        await navigator.clipboard.writeText(`${location.origin}/api/files/raw?path=${encodeURIComponent(path)}`);
        toast('Link copied');
      } catch {
        toast('Could not copy the link', 'error');
      }
    });
    menu.querySelector('[data-act="delete"]').addEventListener('click', () => {
      close();
      removePaths([path]);
    });
  }

  function rename(path) {
    const name = basename(path);
    openModal({
      title: 'Rename',
      sub: path,
      body: `<div class="field"><label class="label">New name</label><input class="input" id="rename-input" value="${esc(
        name
      )}" /></div>`,
      actions: [
        { label: 'Cancel', kind: 'ghost' },
        {
          label: 'Rename',
          kind: 'primary',
          onClick: async ({ dialog }) => {
            const value = dialog.querySelector('#rename-input').value.trim();
            if (!value) return false;
            if (/[\\/]/.test(value)) {
              toast('A name cannot contain slashes', 'error');
              return false;
            }
            try {
              await api('/api/files/move', {
                method: 'POST',
                body: { from: path, to: joinPath(dirname(path), value) }
              });
              toast('Renamed');
              load();
            } catch (err) {
              toast(err.message, 'error');
              return false;
            }
          }
        }
      ]
    });
  }

  async function duplicate(paths) {
    let count = 0;
    for (const path of paths) {
      try {
        await api('/api/files/copy', { method: 'POST', body: { from: path, to: dirname(path) } });
        count++;
      } catch (err) {
        toast(`${basename(path)}: ${err.message}`, 'error');
      }
    }
    if (count) toast(`${count} duplicate${count === 1 ? '' : 's'} created`);
    load();
  }

  async function moveOne(from, toFolder) {
    try {
      await api('/api/files/move', { method: 'POST', body: { from, to: joinPath(toFolder, basename(from)) } });
      toast(`Moved ${basename(from)}`);
      load();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function moveDialog(paths) {
    const list = await loadFolders();
    const options = [
      { path: '', label: 'Files (root)' },
      ...list.map((folder) => ({ path: folder.path, label: folder.path }))
    ];
    openModal({
      title: `Move ${paths.length === 1 ? basename(paths[0]) : `${paths.length} items`}`,
      sub: 'Pick a destination folder.',
      body: `<div class="field"><label class="label">Destination</label>
        <select class="select" id="move-target">
          ${options.map((option) => `<option value="${esc(option.path)}">${esc(option.label)}</option>`).join('')}
        </select></div>
        <div class="field" style="margin-top:10px"><label class="label">Or a new folder path</label>
        <input class="input" id="move-custom" placeholder="Projects/2027" /></div>
        <p class="hint" style="margin-top:8px">Moving keeps the file name. Folders cannot be moved inside themselves.</p>`,
      actions: [
        { label: 'Cancel', kind: 'ghost' },
        {
          label: 'Move',
          kind: 'primary',
          onClick: async ({ dialog }) => {
            const custom = dialog.querySelector('#move-custom').value.trim().replace(/^\/+|\/+$/g, '');
            const target = custom || dialog.querySelector('#move-target').value;
            let moved = 0;
            for (const path of paths) {
              try {
                await api('/api/files/move', {
                  method: 'POST',
                  body: { from: path, to: joinPath(target, basename(path)) }
                });
                moved++;
              } catch (err) {
                toast(`${basename(path)}: ${err.message}`, 'error');
              }
            }
            if (moved) toast(`Moved ${moved} item${moved === 1 ? '' : 's'}`);
            load();
          }
        }
      ]
    });
  }

  function details(entry) {
    if (!entry) return;
    const isImage = entry.kind === 'image';
    openModal({
      title: entry.name,
      sub: entry.path,
      body: `<div class="file-details">
        ${
          isImage
            ? `<img class="file-details-img" src="/api/files/raw?path=${encodeURIComponent(entry.path)}" alt="${esc(
                entry.name
              )}" />`
            : `<span class="file-details-icon">${icon(fileIcon(entry.kind, entry.name))}</span>`
        }
        <dl>
          <div><dt>Type</dt><dd>${entry.dir ? 'Folder' : esc(entry.kind)}</dd></div>
          <div><dt>Size</dt><dd>${entry.dir ? '—' : fmtBytes(entry.size)}</dd></div>
          <div><dt>Modified</dt><dd>${fmtDate(entry.mtime, { time: true })}</dd></div>
          <div><dt>Location</dt><dd class="mono">${esc(dirname(entry.path) || 'Files')}</dd></div>
        </dl>
      </div>`,
      actions: [
        { label: 'Close', kind: 'ghost' },
        {
          label: 'Rename',
          kind: 'quiet',
          onClick: () => {
            // Keep this dialog's close from wiping the rename dialog.
            rename(entry.path);
            return false;
          }
        }
      ]
    });
  }

  async function removeSelected() {
    const list = selectedEntries();
    if (!list.length) return;
    await removePaths(list.map((entry) => entry.path), list);
  }

  async function removePaths(paths, list = []) {
    const names = list.length ? list : entries.filter((entry) => paths.includes(entry.path));
    const hasDir = names.some((entry) => entry.dir);
    const ok = await confirmDialog({
      title: paths.length === 1 ? `Delete ${basename(paths[0])}?` : `Delete ${paths.length} items?`,
      message: hasDir
        ? 'Folders and everything inside them move to Trash, where they stay for 30 days.'
        : 'The file moves to Trash, where it stays for 30 days.',
      confirmLabel: 'Move to trash'
    });
    if (!ok) return;
    let deleted = 0;
    for (const path of paths) {
      try {
        await api(`/api/files?path=${encodeURIComponent(path)}`, { method: 'DELETE' });
        deleted++;
      } catch (err) {
        toast(`${basename(path)}: ${err.message}`, 'error');
      }
    }
    if (deleted) toast(`${deleted} item${deleted === 1 ? '' : 's'} deleted`);
    selected.clear();
    load();
  }

  /* --------------------------- metadata and sharing ------------------------ */

  async function toggleFavorite(entry) {
    if (!entry) return;
    try {
      const meta = await api('/api/files/meta', {
        method: 'PATCH',
        body: { path: entry.path, favorite: !entry.favorite }
      });
      entry.favorite = meta.favorite;
      entry.tags = meta.tags;
      toast(meta.favorite ? 'Added to starred' : 'Removed from starred');
      renderRows();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  function editTags(entry) {
    if (!entry) return;
    openModal({
      title: 'Tags',
      sub: entry.path,
      body: `<div class="field"><label class="label">Comma-separated tags</label><input class="input" id="tag-input" value="${esc(
        entry.tags || ''
      )}" placeholder="invoice, 2026, important" /></div><p class="hint" style="margin-top:8px">Tags are searchable from Search and the command palette.</p>`,
      actions: [
        { label: 'Cancel', kind: 'ghost' },
        {
          label: 'Save tags',
          kind: 'primary',
          onClick: async ({ dialog }) => {
            try {
              const meta = await api('/api/files/meta', {
                method: 'PATCH',
                body: { path: entry.path, tags: dialog.querySelector('#tag-input').value }
              });
              entry.tags = meta.tags;
              toast('Tags saved');
              renderRows();
            } catch (err) {
              toast(err.message, 'error');
              return false;
            }
          }
        }
      ]
    });
  }

  function shareDialog(entry) {
    if (!entry) return;
    openModal({
      title: 'Share a link',
      sub: entry.path,
      body: `<form id="share-form" class="stack-3">
        <div class="field"><label class="label">Password (optional)</label><input class="input" id="share-pass" type="password" autocomplete="new-password" placeholder="Leave blank for no password" /></div>
        <div class="field"><label class="label">Expires</label><select class="select" id="share-days"><option value="0">Never</option><option value="1">1 day</option><option value="7">7 days</option><option value="30">30 days</option><option value="90">90 days</option></select></div>
        ${
          entry.dir
            ? '<label class="check"><input type="checkbox" id="share-upload" /> Let visitors upload files into this folder</label>'
            : ''
        }
        <div id="share-result"></div>
      </form>`,
      actions: [
        { label: 'Cancel', kind: 'ghost' },
        {
          label: 'Create link',
          kind: 'primary',
          onClick: async ({ dialog }) => {
            try {
              const data = await api('/api/files/share', {
                method: 'POST',
                body: {
                  path: entry.path,
                  password: dialog.querySelector('#share-pass').value,
                  expiresDays: Number(dialog.querySelector('#share-days').value),
                  allowUpload: Boolean(dialog.querySelector('#share-upload')?.checked)
                }
              });
              const url = `${location.origin}${data.url}`;
              const box = dialog.querySelector('#share-result');
              box.innerHTML = `<div class="note" style="margin-top:10px"><i class="fa-solid fa-link"></i><span class="grow" style="min-width:0"><span class="mono small" style="word-break:break-all">${esc(
                url
              )}</span></span><button class="btn sm" id="copy-share" type="button">Copy</button></div>`;
              box.querySelector('#copy-share').addEventListener('click', async () => {
                try {
                  await navigator.clipboard.writeText(url);
                  toast('Share link copied');
                } catch {
                  toast('Could not copy automatically', 'error');
                }
              });
              toast('Share link created');
              return false;
            } catch (err) {
              toast(err.message, 'error');
              return false;
            }
          }
        }
      ]
    });
  }

  async function versionsDialog(entry) {
    if (!entry) return;
    let versions = [];
    try {
      versions = (await api(`/api/files/versions?path=${encodeURIComponent(entry.path)}`)).versions || [];
    } catch (err) {
      toast(err.message, 'error');
      return;
    }
    openModal({
      title: 'Version history',
      sub: `${entry.name} · up to 20 saves`,
      wide: true,
      body: versions.length
        ? `<div class="version-list">${versions
            .map(
              (version, index) => `<div class="version-row" data-v="${esc(version.name)}">
                <span class="file-ico">${icon('fa-solid fa-clock-rotate-left')}</span>
                <span class="grow"><span class="strong small">${index === 0 ? 'Latest save' : 'Earlier save'}</span>
                <span class="tiny dim" style="display:block">${fmtDate(version.at, { time: true })} · ${fmtBytes(version.size)}</span></span>
                <button class="btn quiet sm" data-view-version="${esc(version.name)}">${icon('fa-regular fa-eye')} View</button>
                <button class="btn sm" data-restore-version="${esc(version.name)}">${icon('fa-solid fa-rotate-left')} Restore</button>
              </div>`
            )
            .join('')}</div>`
        : `<div class="empty compact">${icon('fa-solid fa-clock-rotate-left')}<p>No earlier versions yet. A new one is saved each time you overwrite this file.</p></div>`,
      actions: [{ label: 'Close', kind: 'ghost' }],
      onMount: (dialog) => {
        dialog.querySelectorAll('[data-view-version]').forEach((node) => {
          node.addEventListener('click', async () => {
            try {
              const data = await api(
                `/api/files/version?path=${encodeURIComponent(entry.path)}&name=${encodeURIComponent(node.dataset.viewVersion)}`
              );
              openModal({
                title: 'Version preview',
                sub: `${entry.name} · ${node.dataset.viewVersion}`,
                wide: true,
                body: `<pre class="log-box" style="max-height:52vh">${esc(data.content)}</pre>`,
                actions: [{ label: 'Close', kind: 'ghost' }]
              });
            } catch (err) {
              toast(err.message, 'error');
            }
          });
        });
        dialog.querySelectorAll('[data-restore-version]').forEach((node) => {
          node.addEventListener('click', async () => {
            const ok = await confirmDialog({
              title: 'Restore this version?',
              message: 'The current version is saved to history first, so you can undo this.',
              confirmLabel: 'Restore'
            });
            if (!ok) return;
            try {
              await api('/api/files/version/restore', { method: 'POST', body: { path: entry.path, name: node.dataset.restoreVersion } });
              toast('Version restored');
              load();
            } catch (err) {
              toast(err.message, 'error');
            }
          });
        });
      }
    });
  }

  async function commentsDialog(entry) {
    if (!entry) return;
    const draw = async (dialog) => {
      const target = dialog.querySelector('#comment-list');
      try {
        const data = await api(`/api/files/comments?path=${encodeURIComponent(entry.path)}`);
        target.innerHTML = data.comments.length
          ? data.comments
              .map(
                (comment) => `<div class="comment-row"><span class="avatar sm">${esc(
                  comment.name.split(/\s+/).slice(0, 2).map((part) => part[0] || '').join('').toUpperCase()
                )}</span><span class="grow" style="min-width:0"><span class="strong small">${esc(comment.name)}</span>
                <span class="tiny dim" style="display:block">${fmtDate(comment.createdAt, { time: true })}</span>
                <span class="small" style="display:block;margin-top:4px;white-space:pre-wrap">${esc(comment.body)}</span></span></div>`
              )
              .join('')
          : `<p class="hint" style="padding:10px 0">No comments yet. Start the conversation.</p>`;
      } catch (err) {
        target.innerHTML = `<p class="hint">${esc(err.message)}</p>`;
      }
    };
    openModal({
      title: 'Comments',
      sub: entry.path,
      wide: true,
      body: `<div class="comment-list" id="comment-list"><div class="skeleton" style="height:40px"></div></div>
        <form id="comment-form" class="stack-2" style="margin-top:14px"><textarea class="textarea" id="comment-body" rows="3" placeholder="Add a comment…"></textarea>
        <div class="row" style="justify-content:flex-end"><button class="btn primary sm" type="submit">Post comment</button></div></form>`,
      actions: [{ label: 'Close', kind: 'ghost' }],
      onMount: (dialog) => {
        draw(dialog);
        dialog.querySelector('#comment-form').addEventListener('submit', async (event) => {
          event.preventDefault();
          const body = dialog.querySelector('#comment-body').value.trim();
          if (!body) return;
          try {
            await api('/api/files/comments', { method: 'POST', body: { path: entry.path, body } });
            dialog.querySelector('#comment-body').value = '';
            await draw(dialog);
            toast('Comment posted');
          } catch (err) {
            toast(err.message, 'error');
          }
        });
      }
    });
  }

  async function downloadZip(paths) {
    if (!paths.length) return;
    toast('Building archive…');
    try {
      const data = await api('/api/files/zip', { method: 'POST', body: { paths } });
      const link = document.createElement('a');
      link.href = data.url;
      link.download = 'coolcloud.zip';
      document.body.appendChild(link);
      link.click();
      link.remove();
      toast(`${data.files} file${data.files === 1 ? '' : 's'} packed`);
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  /* ---------------------------- recovery surfaces -------------------------- */

  function openTrash() {
    openModal({
      title: 'Trash',
      sub: 'Deleted items are kept for 30 days, then removed automatically.',
      wide: true,
      body: `<div id="trash-list"><div class="skeleton" style="height:52px"></div></div>`,
      actions: [
        { label: 'Empty trash', kind: 'danger', onClick: () => { emptyAll(); return false; } },
        { label: 'Close', kind: 'ghost' }
      ],
      onMount: (dialog) => drawTrash(dialog)
    });
  }

  async function drawTrash(dialog) {
    const box = dialog.querySelector('#trash-list');
    try {
      const data = await api('/api/files/trash');
      box.innerHTML = data.items.length
        ? data.items
            .map(
              (item) => `<div class="version-row" data-trash="${item.id}">
                <span class="file-ico">${icon('fa-solid fa-trash-can')}</span>
                <span class="grow" style="min-width:0"><span class="strong small truncate" style="display:block">${esc(item.name)}</span>
                <span class="tiny dim" style="display:block">${esc(item.original)} · deleted ${timeAgo(item.deletedAt)}</span></span>
                <button class="btn quiet sm" data-restore="${item.id}">${icon('fa-solid fa-rotate-left')} Restore</button>
                <button class="btn danger sm" data-purge="${item.id}" aria-label="Delete forever">${icon('fa-solid fa-xmark')}</button>
              </div>`
            )
            .join('')
        : `<div class="empty compact">${icon('fa-regular fa-trash-can')}<p>Trash is empty.</p></div>`;
      box.querySelectorAll('[data-restore]').forEach((node) => {
        node.addEventListener('click', async () => {
          try {
            await api('/api/files/trash/restore', { method: 'POST', body: { id: Number(node.dataset.restore) } });
            toast('Restored');
            load();
            drawTrash(dialog);
          } catch (err) {
            toast(err.message, 'error');
          }
        });
      });
      box.querySelectorAll('[data-purge]').forEach((node) => {
        node.addEventListener('click', async () => {
          const ok = await confirmDialog({ title: 'Delete forever?', message: 'This item will not be recoverable.' });
          if (!ok) return;
          try {
            await api(`/api/files/trash/${node.dataset.purge}`, { method: 'DELETE' });
            drawTrash(dialog);
          } catch (err) {
            toast(err.message, 'error');
          }
        });
      });
    } catch (err) {
      box.innerHTML = `<p class="hint">${esc(err.message)}</p>`;
    }
  }

  async function emptyAll() {
    const ok = await confirmDialog({ title: 'Empty trash?', message: 'Everything in the trash is permanently deleted.' });
    if (!ok) return;
    try {
      await api('/api/files/trash', { method: 'DELETE' });
      toast('Trash emptied');
      document.querySelector('#trash-list') && openTrash();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function openStarred() {
    try {
      const data = await api('/api/files/favorites');
      openModal({
        title: 'Starred',
        sub: 'Files you want close at hand.',
        wide: true,
        body: data.favorites.length
          ? `<div class="version-list">${data.favorites
              .map(
                (item) => `<button class="file-line" data-star-path="${esc(item.path)}" data-star-dir="${item.dir}">
                  <span class="file-ico">${icon(fileIcon(item.kind, item.name))}</span>
                  <span class="grow" style="min-width:0"><span class="file-line-name" style="display:block">${esc(item.name)}</span><span class="tiny dim">${esc(item.path)}</span></span>
                  ${item.tags ? `<span class="badge">${esc(item.tags)}</span>` : ''}
                </button>`
              )
              .join('')}</div>`
          : `<div class="empty compact">${icon('fa-regular fa-star')}<p>Nothing starred yet. Use the file menu to add one.</p></div>`,
        actions: [{ label: 'Close', kind: 'ghost' }],
        onMount: (dialog) => {
          dialog.querySelectorAll('[data-star-path]').forEach((node) => {
            node.addEventListener('click', () => {
              if (node.dataset.starDir === 'true') {
                current = node.dataset.starPath;
                filter = '';
                filterInput.value = '';
                load();
              } else {
                openPath(node.dataset.starPath, entries.find((item) => item.path === node.dataset.starPath)?.kind || 'text');
              }
              closeModal();
            });
          });
        }
      });
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function openDuplicates() {
    openModal({
      title: 'Duplicate finder',
      sub: 'Identical files, grouped by content hash.',
      wide: true,
      body: `<div id="dup-list"><div class="skeleton" style="height:56px"></div></div>`,
      actions: [{ label: 'Close', kind: 'ghost' }],
      onMount: async (dialog) => {
        const box = dialog.querySelector('#dup-list');
        try {
          const data = await api('/api/files/duplicates');
          box.innerHTML = data.groups.length
            ? `<p class="hint" style="margin-bottom:10px">${data.groups.length} group${data.groups.length === 1 ? '' : 's'} · ${fmtBytes(data.wasted)} reclaimable</p>${data.groups
                .map(
                  (group, index) => `<div class="dup-group">
                    <div class="dup-head"><span class="badge">${fmtBytes(group.size)} each</span><span class="grow"></span><button class="btn quiet sm" data-dedupe="${index}">Keep first, trash rest</button></div>
                    ${group.files.map((file) => `<button class="file-line" data-dup-open="${esc(file.path)}"><span class="file-ico">${icon(fileIcon('file', file.name))}</span><span class="file-line-name">${esc(file.path)}</span></button>`).join('')}
                  </div>`
                )
                .join('')}`
            : `<div class="empty compact">${icon('fa-solid fa-clone')}<p>No duplicates found. Your files are tidy.</p></div>`;
          box.querySelectorAll('[data-dup-open]').forEach((node) => {
            node.addEventListener('click', () => openTab(`viewer?path=${encodeURIComponent(node.dataset.dupOpen)}`));
          });
          box.querySelectorAll('[data-dedupe]').forEach((node) => {
            node.addEventListener('click', async () => {
              const group = data.groups[Number(node.dataset.dedupe)];
              for (const file of group.files.slice(1)) {
                try {
                  await api(`/api/files?path=${encodeURIComponent(file.path)}`, { method: 'DELETE' });
                } catch (err) {
                  toast(`${file.name}: ${err.message}`, 'error');
                }
              }
              toast('Extras moved to trash');
              load();
              openDuplicates();
            });
          });
        } catch (err) {
          box.innerHTML = `<p class="hint">${esc(err.message)}</p>`;
        }
      }
    });
  }

  async function openAutomations() {
    openModal({
      title: 'Automations',
      sub: 'When something happens, CoolCloud can act for you.',
      wide: true,
      body: `<div id="rule-list"><div class="skeleton" style="height:44px"></div></div>
        <form id="rule-form" class="stack-3" style="margin-top:16px;border-top:1px solid var(--border);padding-top:16px">
          <div class="field-row"><div class="field"><label class="label">Name</label><input class="input" name="name" value="New automation" /></div>
          <div class="field"><label class="label">When</label><select class="select" name="event"><option value="file.upload">A file is uploaded</option><option value="file.delete">A file is deleted</option><option value="task.created">A task is created</option><option value="task.completed">A task is completed</option><option value="event.created">An event is created</option></select></div></div>
          <div class="field-row"><div class="field"><label class="label">Path starts with (optional)</label><input class="input" name="prefix" placeholder="Invoices" /></div>
          <div class="field"><label class="label">Then</label><select class="select" name="action"><option value="notify">Notify me</option><option value="tag">Add tags</option><option value="move">Move to folder</option><option value="copy">Copy to folder</option><option value="task">Create a task</option></select></div>
          <div class="field"><label class="label">Value</label><input class="input" name="value" placeholder="Folder, tags or task text" /></div></div>
          <div class="row" style="justify-content:flex-end"><button class="btn primary sm" type="submit">Add automation</button></div>
        </form>`,
      actions: [{ label: 'Close', kind: 'ghost' }],
      onMount: async (dialog) => {
        const box = dialog.querySelector('#rule-list');
        const draw = async () => {
          try {
            const data = await api('/api/rules');
            box.innerHTML = data.rules.length
              ? data.rules
                  .map(
                    (rule) => `<div class="version-row" data-rule="${rule.id}">
                      <span class="file-ico">${icon('fa-solid fa-bolt')}</span>
                      <span class="grow" style="min-width:0"><span class="strong small">${esc(rule.name)}</span>
                      <span class="tiny dim" style="display:block">${esc(rule.event)} → ${esc(rule.action)}${rule.value ? ` · ${esc(rule.value)}` : ''}</span></span>
                      <button class="switch" role="switch" aria-checked="${rule.enabled}" data-rule-toggle="${rule.id}"></button>
                      <button class="btn ghost icon sm" data-rule-delete="${rule.id}" aria-label="Delete automation">${icon('fa-solid fa-xmark')}</button>
                    </div>`
                  )
                  .join('')
              : `<p class="hint">No automations yet. Add one below.</p>`;
            box.querySelectorAll('[data-rule-toggle]').forEach((node) => {
              node.addEventListener('click', async () => {
                const next = node.getAttribute('aria-checked') !== 'true';
                await api(`/api/rules/${node.dataset.ruleToggle}`, { method: 'PATCH', body: { enabled: next } });
                draw();
              });
            });
            box.querySelectorAll('[data-rule-delete]').forEach((node) => {
              node.addEventListener('click', async () => {
                await api(`/api/rules/${node.dataset.ruleDelete}`, { method: 'DELETE' });
                draw();
              });
            });
          } catch (err) {
            box.innerHTML = `<p class="hint">${esc(err.message)}</p>`;
          }
        };
        dialog.querySelector('#rule-form').addEventListener('submit', async (event) => {
          event.preventDefault();
          const form = new FormData(event.target);
          try {
            await api('/api/rules', {
              method: 'POST',
              body: {
                name: form.get('name'),
                event: form.get('event'),
                match: { pathPrefix: form.get('prefix') },
                action: form.get('action'),
                value: form.get('value')
              }
            });
            event.target.reset();
            toast('Automation added');
            draw();
          } catch (err) {
            toast(err.message, 'error');
          }
        });
        draw();
      }
    });
  }

  async function openShares() {
    openModal({
      title: 'Shared links',
      sub: 'Links you created from this account.',
      wide: true,
      body: `<div id="share-list"><div class="skeleton" style="height:44px"></div></div>`,
      actions: [{ label: 'Close', kind: 'ghost' }],
      onMount: async (dialog) => {
        const box = dialog.querySelector('#share-list');
        try {
          const data = await api('/api/files/shares');
          box.innerHTML = data.shares.length
            ? data.shares
                .map(
                  (share) => `<div class="version-row" data-share="${esc(share.token)}">
                    <span class="file-ico">${icon('fa-solid fa-link')}</span>
                    <span class="grow" style="min-width:0"><span class="strong small truncate" style="display:block">${esc(share.path)}</span>
                    <span class="tiny dim">${share.hasPassword ? 'Password protected · ' : ''}${share.expiresAt ? `expires ${fmtDate(share.expiresAt)}` : 'no expiry'}${share.allowUpload ? ' · uploads on' : ''}</span></span>
                    <button class="btn quiet sm" data-copy-share="${esc(share.url)}">Copy</button>
                    <button class="btn ghost icon sm" data-revoke-share="${esc(share.token)}" aria-label="Revoke">${icon('fa-solid fa-xmark')}</button>
                  </div>`
                )
                .join('')
            : `<div class="empty compact">${icon('fa-solid fa-link')}<p>No shared links yet. Use a file menu to create one.</p></div>`;
          box.querySelectorAll('[data-copy-share]').forEach((node) => {
            node.addEventListener('click', async () => {
              try {
                await navigator.clipboard.writeText(node.dataset.copyShare);
                toast('Link copied');
              } catch {
                toast('Could not copy', 'error');
              }
            });
          });
          box.querySelectorAll('[data-revoke-share]').forEach((node) => {
            node.addEventListener('click', async () => {
              await api(`/api/files/share/${node.dataset.revokeShare}`, { method: 'DELETE' });
              toast('Link revoked');
              openShares();
            });
          });
        } catch (err) {
          box.innerHTML = `<p class="hint">${esc(err.message)}</p>`;
        }
      }
    });
  }

  async function openFolderAccess(path) {
    let acl;
    let teams;
    let directory;
    try {
      [acl, teams, directory] = await Promise.all([
        api(`/api/files/acl?path=${encodeURIComponent(path)}`),
        api('/api/teams'),
        api('/api/directory')
      ]);
    } catch (err) {
      return toast(err.message, 'error');
    }
    let restricted = Boolean(acl.restricted);
    let grants = [
      ...acl.users.map((user) => ({ kind: 'user', id: user.id, name: user.name, role: user.role, expiresAt: user.expiresAt || '' })),
      ...acl.teams.map((team) => ({ kind: 'team', id: team.id, name: team.name, role: team.role, expiresAt: team.expiresAt || '' }))
    ];
    let shares = acl.shares || [];
    let requests = acl.requests || [];

    openModal({
      title: 'Folder access',
      sub: path || 'Files',
      wide: true,
      body: `<div class="stack-3">
        <label class="check"><input type="checkbox" id="acl-restricted" ${restricted ? 'checked' : ''} /> Restrict this folder and everything inside it</label>
        <p class="hint">Unrestricted folders keep the existing workspace-wide sharing. Once restricted, only you, the people and teams below, and administrators can open it.</p>
        <div id="acl-editor" class="stack-3 ${restricted ? '' : 'hidden'}">
          <div class="field"><label class="label">Add a person or team</label>
            <div class="row" style="gap:8px"><select class="select grow" id="acl-principal"></select><button class="btn sm" type="button" id="acl-add">${icon('fa-solid fa-plus')} Add</button></div>
          </div>
          <div class="stack-2" id="acl-grants"></div>
          <div class="acl-public-links" id="acl-public-links"></div>
          <div class="acl-requests" id="acl-requests"></div>
          <div class="acl-new-team"><input class="input" id="acl-team-name" placeholder="New team name" maxlength="80" /><button class="btn quiet sm" type="button" id="acl-team-create">${icon('fa-solid fa-user-group')} Create team</button></div>
          <div class="row-tight"><button class="btn ghost sm" type="button" id="acl-teams-manage">${icon('fa-solid fa-users-gear')} Manage team members</button></div>
        </div>
        ${acl.canManage ? '' : '<div class="note">Only the folder owner or an administrator can change this access list.</div>'}
      </div>`,
      actions: [
        ...(restricted && acl.canManage
          ? [
              {
                label: 'Remove restriction',
                kind: 'danger',
                onClick: async () => {
                  try {
                    await api('/api/files/acl', { method: 'PUT', body: { path, restricted: false } });
                    toast('Folder is shared with the workspace again');
                    load();
                  } catch (err) {
                    toast(err.message, 'error');
                    return false;
                  }
                }
              }
            ]
          : []),
        { label: 'Cancel', kind: 'ghost' },
        {
          label: 'Save access',
          kind: 'primary',
          onClick: async () => {
            if (!acl.canManage) {
              toast('Only the folder owner can change access', 'error');
              return false;
            }
            try {
              await api('/api/files/acl', {
                method: 'PUT',
                body: {
                  path,
                  restricted,
                  users: grants.filter((grant) => grant.kind === 'user').map((grant) => ({ id: grant.id, role: grant.role, expiresAt: grant.expiresAt })),
                  teams: grants.filter((grant) => grant.kind === 'team').map((grant) => ({ id: grant.id, role: grant.role, expiresAt: grant.expiresAt }))
                }
              });
              toast(restricted ? 'Folder access saved' : 'Folder is shared with the workspace');
              load();
            } catch (err) {
              toast(err.message, 'error');
              return false;
            }
          }
        }
      ],
      onMount: (dialog) => {
        const editor = dialog.querySelector('#acl-editor');
        const principal = dialog.querySelector('#acl-principal');
        const grantList = dialog.querySelector('#acl-grants');
        const paint = () => {
          const available = [
            ...directory.people
              .filter((person) => !grants.some((grant) => grant.kind === 'user' && grant.id === person.id))
              .map((person) => ({ value: `user:${person.id}`, label: `Person · ${person.name}` })),
            ...teams.teams
              .filter((team) => !grants.some((grant) => grant.kind === 'team' && grant.id === team.id))
              .map((team) => ({ value: `team:${team.id}`, label: `Team · ${team.name}` }))
          ];
          principal.innerHTML = available.length
            ? available.map((item) => `<option value="${item.value}">${esc(item.label)}</option>`).join('')
            : '<option value="">Everyone already has access</option>';
          dialog.querySelector('#acl-add').disabled = !available.length;
          grantList.innerHTML = grants.length
            ? grants
                .map(
                  (grant, index) => `<div class="acl-grant"><span class="file-ico">${icon(grant.kind === 'team' ? 'fa-solid fa-users' : 'fa-solid fa-user')}</span>
                    <span class="grow"><span class="strong small">${esc(grant.name)}</span><span class="tiny dim" style="display:block">${grant.kind === 'team' ? 'Team' : 'Person'}</span></span>
                    <select class="select acl-role" data-acl-role="${index}" aria-label="Role for ${esc(grant.name)}">
                      ${[['viewer', 'Viewer'], ['commenter', 'Commenter'], ['editor', 'Editor'], ['manager', 'Manager']]
                        .map(([value, label]) => `<option value="${value}" ${grant.role === value ? 'selected' : ''}>${label}</option>`)
                        .join('')}
                    </select>
                    <input class="input acl-expiry" type="date" data-acl-expiry="${index}" value="${grant.expiresAt ? esc(String(grant.expiresAt).slice(0, 10)) : ''}" title="Optional expiry date" aria-label="Expiry for ${esc(grant.name)}" />
                    <button class="btn ghost icon sm" type="button" data-acl-remove="${index}" aria-label="Remove access">${icon('fa-solid fa-xmark')}</button></div>`
                )
                .join('')
            : '<p class="hint">No one else has access yet. Add a person or team above.</p>';
          grantList.querySelectorAll('[data-acl-remove]').forEach((node) => {
            node.addEventListener('click', () => {
              grants.splice(Number(node.dataset.aclRemove), 1);
              paint();
            });
          });
          grantList.querySelectorAll('[data-acl-role]').forEach((node) => {
            node.addEventListener('change', () => {
              grants[Number(node.dataset.aclRole)].role = node.value;
            });
          });
          grantList.querySelectorAll('[data-acl-expiry]').forEach((node) => {
            node.addEventListener('change', () => {
              grants[Number(node.dataset.aclExpiry)].expiresAt = node.value ? new Date(`${node.value}T23:59:59.000Z`).toISOString() : '';
            });
          });
          const links = dialog.querySelector('#acl-public-links');
          links.innerHTML = shares.length
            ? `<div class="field"><label class="label">Public links under this folder</label><p class="hint">These links keep working after a restriction unless you revoke them.</p>${shares
                .map(
                  (share) => `<div class="acl-grant"><span class="file-ico">${icon('fa-solid fa-link')}</span><span class="grow"><span class="strong small">${esc(share.path)}</span><span class="tiny dim" style="display:block">${share.allowUpload ? 'Uploads on · ' : ''}${share.expiresAt ? `expires ${fmtDate(share.expiresAt)}` : 'no expiry'}</span></span><button class="btn danger sm" type="button" data-acl-revoke="${esc(share.token)}">Revoke</button></div>`
                )
                .join('')}</div>`
            : '';
          links.querySelectorAll('[data-acl-revoke]').forEach((node) => {
            node.addEventListener('click', async () => {
              try {
                await api(`/api/files/share/${encodeURIComponent(node.dataset.aclRevoke)}`, { method: 'DELETE' });
                shares = shares.filter((share) => share.token !== node.dataset.aclRevoke);
                paint();
                toast('Link revoked');
              } catch (err) {
                toast(err.message, 'error');
              }
            });
          });
          const requestBox = dialog.querySelector('#acl-requests');
          requestBox.innerHTML = requests.length
            ? `<div class="field"><label class="label">Access requests</label>${requests
                .map(
                  (request) => `<div class="acl-grant"><span class="file-ico">${icon('fa-solid fa-user-clock')}</span><span class="grow"><span class="strong small">${esc(request.name)}</span><span class="tiny dim" style="display:block">${esc(request.note || 'Asked for access')} · ${timeAgo(request.createdAt)}</span></span><select class="select acl-role" data-request-role="${request.id}"><option value="viewer">Viewer</option><option value="commenter">Commenter</option><option value="editor">Editor</option></select><button class="btn sm" type="button" data-request-approve="${request.id}">Approve</button><button class="btn ghost sm" type="button" data-request-reject="${request.id}">Decline</button></div>`
                )
                .join('')}</div>`
            : '';
          requestBox.querySelectorAll('[data-request-approve]').forEach((node) => {
            node.addEventListener('click', async () => {
              const role = requestBox.querySelector(`[data-request-role="${node.dataset.requestApprove}"]`).value;
              try {
                await api(`/api/files/acl/requests/${node.dataset.requestApprove}/resolve`, { method: 'POST', body: { approve: true, role } });
                requests = requests.filter((request) => String(request.id) !== node.dataset.requestApprove);
                paint();
                toast('Access approved');
              } catch (err) {
                toast(err.message, 'error');
              }
            });
          });
          requestBox.querySelectorAll('[data-request-reject]').forEach((node) => {
            node.addEventListener('click', async () => {
              try {
                await api(`/api/files/acl/requests/${node.dataset.requestReject}/resolve`, { method: 'POST', body: { approve: false } });
                requests = requests.filter((request) => String(request.id) !== node.dataset.requestReject);
                paint();
                toast('Request declined');
              } catch (err) {
                toast(err.message, 'error');
              }
            });
          });
        };
        dialog.querySelector('#acl-restricted').addEventListener('change', (event) => {
          restricted = event.target.checked;
          editor.classList.toggle('hidden', !restricted);
        });
        dialog.querySelector('#acl-add').addEventListener('click', () => {
          const [kind, id] = String(principal.value).split(':');
          if (!kind || !id) return;
          if (kind === 'user') {
            const person = directory.people.find((item) => String(item.id) === id);
            if (person) grants.push({ kind: 'user', id: Number(id), name: person.name, role: 'viewer', expiresAt: '' });
          } else {
            const team = teams.teams.find((item) => String(item.id) === id);
            if (team) grants.push({ kind: 'team', id: Number(id), name: team.name, role: 'viewer', expiresAt: '' });
          }
          paint();
        });
        dialog.querySelector('#acl-team-create').addEventListener('click', async () => {
          const name = dialog.querySelector('#acl-team-name').value.trim();
          if (!name) return;
          try {
            const result = await api('/api/teams', { method: 'POST', body: { name } });
            teams.teams.push(result.team);
            grants.push({ kind: 'team', id: result.team.id, name: result.team.name, role: 'viewer', expiresAt: '' });
            dialog.querySelector('#acl-team-name').value = '';
            paint();
            toast(`Team “${result.team.name}” created`);
          } catch (err) {
            toast(err.message, 'error');
          }
        });
        dialog.querySelector('#acl-teams-manage').addEventListener('click', () => {
          closeModal();
          openTeams();
        });
        paint();
      }
    });
  }

  async function openTeams() {
    let teams;
    let directory;
    try {
      [teams, directory] = await Promise.all([api('/api/teams'), api('/api/directory')]);
    } catch (err) {
      return toast(err.message, 'error');
    }
    openModal({
      title: 'Teams',
      sub: 'Teams make it faster to grant folder access to several people.',
      wide: true,
      body: `<div class="stack-3">
        <div class="row" style="gap:8px"><input class="input grow" id="team-name" placeholder="Team name" maxlength="80" /><button class="btn primary sm" id="team-create">${icon('fa-solid fa-plus')} Create team</button></div>
        <div class="stack-2">${teams.teams.length
          ? teams.teams
              .map((team) => {
                const available = directory.people.filter((person) => !team.members.some((member) => member.id === person.id));
                return `<div class="acl-team" data-team="${team.id}"><div class="spread"><span class="strong small">${esc(team.name)}</span><span class="badge">${team.members.length} member${team.members.length === 1 ? '' : 's'}</span></div>
                  <div class="row wrap" style="gap:5px;margin:8px 0">${team.members.map((member) => `<span class="attachment-chip">${esc(member.name)}<button type="button" data-team-remove="${team.id}:${member.id}" aria-label="Remove ${esc(member.name)}">${icon('fa-solid fa-xmark')}</button></span>`).join('')}</div>
                  <div class="row" style="gap:6px"><select class="select grow" data-team-person="${team.id}">${available.map((person) => `<option value="${person.id}">${esc(person.name)}</option>`).join('')}</select><button class="btn quiet sm" data-team-add="${team.id}" ${available.length ? '' : 'disabled'}>Add member</button><button class="btn ghost icon sm" data-team-delete="${team.id}" aria-label="Delete team">${icon('fa-solid fa-trash-can')}</button></div></div>`;
              })
              .join('')
          : '<p class="hint">No teams yet. Create one above, then grant it access to a folder.</p>'}</div>
      </div>`,
      actions: [{ label: 'Close', kind: 'ghost' }],
      onMount: (dialog) => {
        dialog.querySelector('#team-create').addEventListener('click', async () => {
          const name = dialog.querySelector('#team-name').value.trim();
          if (!name) return;
          try {
            await api('/api/teams', { method: 'POST', body: { name } });
            closeModal();
            openTeams();
          } catch (err) {
            toast(err.message, 'error');
          }
        });
        dialog.querySelectorAll('[data-team-add]').forEach((node) => {
          node.addEventListener('click', async () => {
            const select = dialog.querySelector(`[data-team-person="${node.dataset.teamAdd}"]`);
            if (!select?.value) return;
            try {
              await api(`/api/teams/${node.dataset.teamAdd}/members`, { method: 'POST', body: { userId: Number(select.value) } });
              closeModal();
              openTeams();
            } catch (err) {
              toast(err.message, 'error');
            }
          });
        });
        dialog.querySelectorAll('[data-team-remove]').forEach((node) => {
          node.addEventListener('click', async () => {
            const [team, member] = node.dataset.teamRemove.split(':');
            try {
              await api(`/api/teams/${team}/members/${member}`, { method: 'DELETE' });
              closeModal();
              openTeams();
            } catch (err) {
              toast(err.message, 'error');
            }
          });
        });
        dialog.querySelectorAll('[data-team-delete]').forEach((node) => {
          node.addEventListener('click', async () => {
            const ok = await confirmDialog({ title: 'Delete team?', message: 'Folder access granted to this team is removed. The folder itself stays.' });
            if (!ok) return;
            try {
              await api(`/api/teams/${node.dataset.teamDelete}`, { method: 'DELETE' });
              closeModal();
              openTeams();
            } catch (err) {
              toast(err.message, 'error');
            }
          });
        });
      }
    });
  }

  function moreMenu(event) {
    document.querySelector('.menu')?.remove();
    const menu = document.createElement('div');
    menu.className = 'menu';
    menu.innerHTML = `
      <button data-more="starred">${icon('fa-regular fa-star')} Starred</button>
      <button data-more="trash">${icon('fa-regular fa-trash-can')} Trash</button>
      <button data-more="duplicates">${icon('fa-solid fa-clone')} Duplicate finder</button>
      <button data-more="automations">${icon('fa-solid fa-bolt')} Automations</button>
      <button data-more="shares">${icon('fa-solid fa-link')} Shared links</button>
      <button data-more="shared">${icon('fa-solid fa-share-nodes')} Shared with me</button>
      <button data-more="access">${icon('fa-solid fa-user-lock')} Folder access</button>
      <button data-more="teams">${icon('fa-solid fa-users')} Teams</button>
      <div class="sep"></div>
      <button data-more="refresh">${icon('fa-solid fa-rotate')} Refresh</button>`;
    document.body.appendChild(menu);
    const rect = event.currentTarget.getBoundingClientRect();
    menu.style.top = `${Math.min(window.innerHeight - 330, rect.bottom + 6)}px`;
    menu.style.left = `${Math.min(window.innerWidth - 230, rect.right - 200)}px`;
    const close = () => menu.remove();
    setTimeout(() => document.addEventListener('click', close, { once: true }), 0);
    menu.querySelector('[data-more="starred"]').addEventListener('click', () => { close(); openStarred(); });
    menu.querySelector('[data-more="trash"]').addEventListener('click', () => { close(); openTrash(); });
    menu.querySelector('[data-more="duplicates"]').addEventListener('click', () => { close(); openDuplicates(); });
    menu.querySelector('[data-more="automations"]').addEventListener('click', () => { close(); openAutomations(); });
    menu.querySelector('[data-more="shares"]').addEventListener('click', () => { close(); openShares(); });
    menu.querySelector('[data-more="shared"]').addEventListener('click', () => { close(); openSharedWithMe(); });
    menu.querySelector('[data-more="access"]').addEventListener('click', () => { close(); openFolderAccess(current); });
    menu.querySelector('[data-more="teams"]').addEventListener('click', () => { close(); openTeams(); });
    menu.querySelector('[data-more="refresh"]').addEventListener('click', () => { close(); load(); });
  }

  /* -------------------------------- uploads -------------------------------- */

  function newFolder() {
    openModal({
      title: 'New folder',
      body: `<div class="field"><label class="label">Folder name</label><input class="input" id="folder-name" placeholder="Projects" /></div>`,
      actions: [
        { label: 'Cancel', kind: 'ghost' },
        {
          label: 'Create',
          kind: 'primary',
          onClick: async ({ dialog }) => {
            const name = dialog.querySelector('#folder-name').value.trim();
            if (!name) return false;
            if (/[\\/]/.test(name)) {
              toast('A name cannot contain slashes', 'error');
              return false;
            }
            try {
              await api('/api/files/folder', { method: 'POST', body: { path: joinPath(current, name) } });
              toast('Folder created');
              load();
            } catch (err) {
              toast(err.message, 'error');
              return false;
            }
          }
        }
      ]
    });
  }

  function confirmReplace(names) {
    return new Promise((resolve) => {
      openModal({
        title: names.length === 1 ? 'Replace existing file?' : 'Replace existing files?',
        sub: `${names.length} file${names.length === 1 ? '' : 's'} already exist${names.length === 1 ? 's' : ''} in this folder.`,
        body: `<p class="small dim">Uploading replaces the current contents. This cannot be undone.</p>
          <ul class="replace-list">${names
            .slice(0, 6)
            .map((name) => `<li>${esc(name)}</li>`)
            .join('')}${names.length > 6 ? `<li class="dim">and ${names.length - 6} more</li>` : ''}</ul>`,
        actions: [
          { label: 'Cancel', kind: 'ghost', onClick: () => resolve(false) },
          { label: 'Replace', kind: 'danger', onClick: () => resolve(true) }
        ],
        onClose: () => resolve(false)
      });
    });
  }

  const uploadJobs = new Map();

  function paintUploadQueue() {
    uploadQueue.classList.toggle('active', uploadJobs.size > 0);
    uploadQueue.innerHTML = [...uploadJobs.entries()]
      .map(
        ([id, job]) => `<div class="upload-item" data-upload="${id}">
          <span class="upload-name truncate" title="${esc(job.name)}">${esc(job.name)}</span>
          <span class="upload-pct">${job.status === 'error' ? 'Failed' : `${Math.round(job.progress)}%`}</span>
          <div class="progress upload-progress"><span style="width:${job.progress}%"></span></div>
          ${job.status === 'error' ? `<button class="btn ghost icon sm" data-upload-dismiss="${id}" aria-label="Dismiss">${icon('fa-solid fa-xmark')}</button>` : ''}
        </div>`
      )
      .join('');
    uploadQueue.querySelectorAll('[data-upload-dismiss]').forEach((node) =>
      node.addEventListener('click', () => {
        uploadJobs.delete(node.dataset.uploadDismiss);
        paintUploadQueue();
      })
    );
  }

  async function uploadOne(file, target, id) {
    const job = uploadJobs.get(id);
    const setProgress = (value) => {
      if (!uploadJobs.has(id)) return;
      job.progress = Math.max(job.progress, Math.min(100, value));
      paintUploadQueue();
    };
    const chunkSize = 4 * 1024 * 1024;
    if (file.size <= chunkSize) {
      await api(`/api/files?path=${encodeURIComponent(target)}`, { method: 'PUT', body: file });
      setProgress(100);
      return;
    }
    const key = `cc:upload:${target}:${file.size}:${file.lastModified}`;
    let resumeId = '';
    try {
      resumeId = localStorage.getItem(key) || '';
    } catch {
      resumeId = '';
    }
    const init = await api('/api/files/uploads', {
      method: 'POST',
      body: { path: target, size: file.size, resumeId: resumeId || undefined }
    });
    const uploadId = init.id;
    try {
      localStorage.setItem(key, uploadId);
    } catch {
      /* ignore */
    }
    let offset = Number(init.received || 0);
    setProgress((offset / file.size) * 100);
    while (offset < file.size) {
      const chunk = file.slice(offset, Math.min(file.size, offset + chunkSize));
      let response;
      try {
        response = await fetch(`/api/files/uploads/${encodeURIComponent(uploadId)}?offset=${offset}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: chunk,
          credentials: 'same-origin'
        });
      } catch {
        throw new Error('Upload interrupted. Retry to resume.');
      }
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || `Upload failed (${response.status})`);
      }
      const data = await response.json();
      offset = Number(data.received || offset + chunk.size);
      setProgress((offset / file.size) * 100);
    }
    await api(`/api/files/uploads/${encodeURIComponent(uploadId)}/complete`, { method: 'POST', body: {} });
    try {
      localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
    setProgress(100);
  }

  async function uploadFiles(fileList) {
    if (!fileList?.length) return;
    const files = [...fileList];
    const existing = new Set(entries.filter((entry) => !entry.dir).map((entry) => entry.name));
    const clashes = [
      ...new Set(
        files
          .filter((file) => !(file.webkitRelativePath || '').includes('/'))
          .map((file) => file.name)
          .filter((name) => existing.has(name))
      )
    ];
    if (clashes.length && !(await confirmReplace(clashes))) return;
    let uploaded = 0;
    for (const file of files) {
      const relative = file.webkitRelativePath || file.name;
      const target = joinPath(current, relative);
      const id = `u-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      uploadJobs.set(id, { name: file.name, progress: 0, status: 'uploading' });
      paintUploadQueue();
      try {
        await uploadOne(file, target, id);
        uploaded++;
        const job = uploadJobs.get(id);
        job.status = 'done';
        setTimeout(() => {
          uploadJobs.delete(id);
          paintUploadQueue();
        }, 3500);
      } catch (err) {
        const job = uploadJobs.get(id);
        job.status = 'error';
        job.progress = 100;
        toast(`${file.name}: ${err.message}`, 'error');
      }
      paintUploadQueue();
    }
    if (uploaded) toast(`${uploaded} file${uploaded === 1 ? '' : 's'} uploaded`);
    load();
  }

  /* --------------------------------- wiring -------------------------------- */

  root.querySelector('#upload').addEventListener('click', () => input.click());
  root.querySelector('#upload-folder').addEventListener('click', () => folderInput.click());
  root.querySelector('#more-files').addEventListener('click', moreMenu);
  input.addEventListener('change', () => {
    uploadFiles(input.files);
    input.value = '';
  });
  folderInput.addEventListener('change', () => {
    uploadFiles(folderInput.files);
    folderInput.value = '';
  });
  root.querySelector('#new-folder').addEventListener('click', newFolder);

  root.querySelector('#new-doc').addEventListener('click', () => {
    openModal({
      title: 'New document',
      sub: 'Creates a text file and opens it in the Editor.',
      body: `<div class="field"><label class="label">File name</label><input class="input" id="doc-name" placeholder="notes.md" value="untitled.md" /></div>`,
      actions: [
        { label: 'Cancel', kind: 'ghost' },
        {
          label: 'Create',
          kind: 'primary',
          onClick: async ({ dialog }) => {
            const name = dialog.querySelector('#doc-name').value.trim();
            if (!name) return false;
            const target = joinPath(current, name);
            try {
              await api('/api/files/text', { method: 'PUT', body: { path: target, content: '', create: true } });
              load();
              openTab(`cc:editor?file=${encodeURIComponent(target)}`);
            } catch (err) {
              toast(err.message, 'error');
              return false;
            }
          }
        }
      ]
    });
  });

  filterInput.addEventListener('input', () => {
    filter = filterInput.value;
    renderRows();
    // Keep the select-all checkbox honest when the filter hides rows.
    syncBulk();
  });

  root.querySelector('#files-sort').addEventListener('change', (event) => {
    sort = event.target.value;
    writePref('cc:filesSort', sort);
    renderRows();
  });

  root.querySelectorAll('[data-sort]').forEach((node) => {
    node.addEventListener('click', () => {
      const key = node.dataset.sort;
      const [currentKey, direction] = sort.split('-');
      sort = `${key}-${currentKey === key && direction === 'asc' ? 'desc' : 'asc'}`;
      root.querySelector('#files-sort').value = SORT_OPTIONS.some(([value]) => value === sort) ? sort : 'name-asc';
      writePref('cc:filesSort', sort);
      renderRows();
    });
  });

  root.querySelectorAll('[data-view]').forEach((node) => {
    node.addEventListener('click', () => {
      view = node.dataset.view;
      writePref('cc:filesView', view);
      root.querySelectorAll('[data-view]').forEach((button) =>
        button.setAttribute('aria-selected', String(button.dataset.view === view))
      );
      renderRows();
    });
  });

  root.querySelector('#check-all').addEventListener('change', (event) => {
    const list = visibleEntries();
    if (event.target.checked) list.forEach((entry) => selected.add(entry.path));
    else selected.clear();
    syncBulk();
  });

  bulk.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-bulk]');
    if (!button) return;
    const list = selectedEntries();
    const paths = list.map((entry) => entry.path);
    if (!paths.length) return;
    if (button.dataset.bulk === 'clear') {
      selected.clear();
      syncBulk();
      return;
    }
    if (button.dataset.bulk === 'delete') return removeSelected();
    if (button.dataset.bulk === 'move') return moveDialog(paths);
    if (button.dataset.bulk === 'copy') return duplicate(paths);
    if (button.dataset.bulk === 'download') return downloadZip(paths);
  });

  // Dragging files over the table shows one clear drop surface. Folder rows
  // keep their own drop handlers for moving existing files.
  table.addEventListener('dragenter', (event) => {
    if (!event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    overlay.classList.add('active');
  });
  table.addEventListener('dragleave', (event) => {
    // Moving between rows keeps the overlay; leaving the table hides it.
    if (event.relatedTarget && table.contains(event.relatedTarget)) return;
    overlay.classList.remove('active');
  });
  table.addEventListener('dragover', (event) => {
    if (!event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  });
  table.addEventListener('drop', (event) => {
    overlay.classList.remove('active');
    event.preventDefault();
    if (event.dataTransfer.files?.length) uploadFiles(event.dataTransfer.files);
  });

  root.addEventListener('keydown', (event) => {
    if (isTyping()) return;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a') {
      event.preventDefault();
      visibleEntries().forEach((entry) => selected.add(entry.path));
      syncBulk();
      return;
    }
    if (event.key === 'Escape' && selected.size) {
      selected.clear();
      syncBulk();
      return;
    }
    if (event.key === 'Delete' && selected.size) {
      event.preventDefault();
      removeSelected();
    }
  });

  load();
}
