import { api, esc, icon } from '../core.js';
import { openTab } from '../shell.js';

const OFFICE = ['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp'];
const IMAGE = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'svg'];
const VIDEO = ['mp4', 'webm', 'ogv', 'mov'];
const AUDIO = ['mp3', 'wav', 'ogg', 'flac', 'm4a'];

function extOf(name = '') {
  const index = name.lastIndexOf('.');
  return index === -1 ? '' : name.slice(index + 1).toLowerCase();
}

function fileGlyph(ext) {
  if (IMAGE.includes(ext)) return 'fa-regular fa-image';
  if (VIDEO.includes(ext)) return 'fa-solid fa-film';
  if (AUDIO.includes(ext)) return 'fa-solid fa-volume-high';
  if (ext === 'pdf') return 'fa-regular fa-file-pdf';
  if (['doc', 'docx', 'odt'].includes(ext)) return 'fa-regular fa-file-word';
  if (['xls', 'xlsx', 'ods'].includes(ext)) return 'fa-regular fa-file-excel';
  if (['ppt', 'pptx', 'odp'].includes(ext)) return 'fa-regular fa-file-powerpoint';
  return 'fa-regular fa-file';
}

export default function mount(root, ctx) {
  const path = ctx.params.get('path') || '';
  if (!path) {
    root.innerHTML = `<div class="page"><div class="empty">${icon('fa-regular fa-eye')}<p>Nothing to preview.</p></div></div>`;
    return;
  }
  const name = path.split('/').pop();
  const ext = extOf(name);
  const raw = `/api/files/raw?path=${encodeURIComponent(path)}`;
  const download = `${raw}&download=1`;
  const folder = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  const isImage = IMAGE.includes(ext);
  const isVideo = VIDEO.includes(ext);
  const isAudio = AUDIO.includes(ext);
  const isPdf = ext === 'pdf';
  const isOffice = OFFICE.includes(ext);

  const crumbs = path
    .split('/')
    .map((segment, index, all) => {
      const target = all.slice(0, index + 1).join('/');
      return `<button data-dir="${esc(target)}">${esc(segment)}</button>`;
    })
    .join('<span> / </span>');

  root.innerHTML = `<div class="viewer-shell">
    <header class="viewer-bar">
      <span class="file-ico">${icon(fileGlyph(ext))}</span>
      <div class="viewer-id">
        <span class="viewer-name" title="${esc(name)}">${esc(name)}</span>
        <span class="viewer-path" title="${esc(path)}">${crumbs}</span>
      </div>
      <div class="viewer-actions">
        <button class="btn ghost sm" id="fullscreen" title="Full screen">${icon('fa-solid fa-expand')}</button>
        <button class="btn ghost sm" id="new-window" title="Open in a new window">${icon(
          'fa-solid fa-arrow-up-right-from-square'
        )}</button>
        <a class="btn quiet sm" href="${download}" download>${icon('fa-solid fa-download')} Download</a>
      </div>
    </header>
    <div class="viewer-body${isOffice ? ' office' : ''}" id="viewer-body">
      ${
        isImage
          ? `<img src="${raw}" alt="${esc(name)}" />`
          : isVideo
          ? `<video src="${raw}" controls autoplay playsinline></video>`
          : isAudio
          ? `<div class="viewer-doc">${icon('fa-solid fa-volume-high', 'font-size:34px;color:var(--text-3)')}<p>${esc(
              name
            )}</p><audio src="${raw}" controls autoplay></audio></div>`
          : isPdf
          ? `<iframe src="${raw}" title="${esc(name)}"></iframe>`
          : isOffice
          ? officePlaceholder('Connecting to the office server…')
          : `<div class="viewer-doc">
              ${icon(fileGlyph(ext), 'font-size:32px;color:var(--text-3)')}
              <p><strong>${esc(name)}</strong></p>
              <p>This file type has no preview. Download it to open it on your machine.</p>
              <a class="btn primary sm" href="${download}">Download file</a>
            </div>`
      }
    </div>
  </div>`;

  const body = root.querySelector('#viewer-body');
  root.querySelectorAll('[data-dir]').forEach((node) => {
    node.addEventListener('click', () => openTab(`cc:files?path=${encodeURIComponent(node.dataset.dir)}`));
  });
  root.querySelector('#new-window').addEventListener('click', () => window.open(raw, '_blank', 'noopener'));
  root.querySelector('#fullscreen').addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else body.requestFullscreen?.();
  });

  if (isOffice) loadOffice(body, name, path, folder);
}

function officePlaceholder(message) {
  return `<div class="viewer-doc" id="office-status">
    ${icon('fa-regular fa-file-word', 'font-size:32px;color:var(--text-3)')}
    <p id="office-status-text">${esc(message)}</p>
    <p id="office-status-hint"></p>
  </div>`;
}

async function loadOffice(body, name, path, folder) {
  let attempts = 0;
  let firstStart = false;

  const fallback = (message, url = '') => {
    body.innerHTML = `<div class="viewer-doc">
      ${icon('fa-regular fa-file-word', 'font-size:32px;color:var(--text-3)')}
      <p><strong>${esc(name)}</strong> could not be opened in the editor.</p>
      <p>${esc(message)}</p>
      <div class="row">
        ${url ? `<a class="btn quiet sm" href="${esc(url)}" target="_blank" rel="noopener">Open office server</a>` : ''}
        <a class="btn primary sm" href="/api/files/raw?path=${encodeURIComponent(path)}&download=1">Download file</a>
        ${
          folder
            ? `<button class="btn ghost sm" data-back>${icon('fa-solid fa-folder-open')} Back to folder</button>`
            : ''
        }
      </div>
    </div>`;
    body.querySelector('[data-back]')?.addEventListener('click', () =>
      openTab(`cc:files?path=${encodeURIComponent(folder)}`)
    );
  };

  const tick = async () => {
    let session;
    try {
      session = await api(`/api/office/session?path=${encodeURIComponent(path)}`);
    } catch (err) {
      fallback(err.message);
      return;
    }
    if (session.ready && session.embed && session.url) {
      body.innerHTML = `<iframe src="${esc(session.url)}" title="${esc(
        name
      )}" allow="clipboard-read; clipboard-write" referrerpolicy="no-referrer"></iframe>`;
      return;
    }
    if (!session.embed) {
      fallback(session.reason || 'Office editing is not configured.', session.url);
      return;
    }
    if (attempts === 0) {
      firstStart = true;
      const text = body.querySelector('#office-status-text');
      const hint = body.querySelector('#office-status-hint');
      if (text) text.textContent = 'Starting the office server…';
      if (hint) {
        hint.textContent =
          'The first document open downloads the office image and can take a minute or two. This page loads as soon as it answers.';
      }
    }
    attempts += 1;
    if (attempts > 90) {
      fallback(
        'The office server did not answer. Check Admin → Config → Editor & office, or start it with Docker on this machine.'
      );
      return;
    }
    setTimeout(tick, firstStart && attempts < 4 ? 3000 : 2500);
  };

  tick();
}
