import { api, esc, fmtBytes, fmtDate, icon, toast } from '../core.js';
import { openTab } from '../shell.js';

export default function mount(root, ctx) {
  let items = [];
  let filter = 'all';

  root.innerHTML = `<div class="page">
    <header class="page-head">
      <div>
        <h1 class="page-title">Media</h1>
        <p class="page-sub" id="media-sub">Photos and videos from your Files.</p>
      </div>
      <div class="page-actions">
        <div class="segmented" id="media-filter">
          <button data-filter="all" aria-selected="true">All</button>
          <button data-filter="images" aria-selected="false">Photos</button>
          <button data-filter="videos" aria-selected="false">Videos</button>
        </div>
        <button class="btn quiet sm" id="open-files">${icon('fa-solid fa-arrow-up-from-bracket')} Upload</button>
      </div>
    </header>
    <div class="media-grid" id="grid"></div>
  </div>`;

  const grid = root.querySelector('#grid');

  root.querySelector('#media-filter').addEventListener('click', (event) => {
    const button = event.target.closest('[data-filter]');
    if (!button) return;
    filter = button.dataset.filter;
    root.querySelectorAll('[data-filter]').forEach((node) => node.setAttribute('aria-selected', node === button ? 'true' : 'false'));
    render();
  });
  root.querySelector('#open-files').addEventListener('click', () => openTab('cc:files'));

  async function load() {
    try {
      const data = await api('/api/media?limit=200');
      items = data.media;
      root.querySelector('#media-sub').textContent = `${items.length} item${items.length === 1 ? '' : 's'} in your library`;
    } catch (err) {
      toast(err.message, 'error');
    }
    render();
  }

  function render() {
    const visible = items.filter((item) => (filter === 'all' ? true : filter === 'images' ? item.kind === 'image' : item.kind === 'video'));
    if (!visible.length) {
      grid.innerHTML = `<div class="empty" style="grid-column:1/-1">${icon(
        'fa-regular fa-images'
      )}<p>No media yet. Upload photos or videos into Files and they appear here.</p><button class="btn sm" id="empty-upload">Open Files</button></div>`;
      grid.querySelector('#empty-upload')?.addEventListener('click', () => openTab('cc:files'));
      return;
    }
    grid.innerHTML = visible
      .map(
        (item) => `<button class="media-card" data-path="${esc(item.path)}">
          <div class="frame">
            ${
              item.kind === 'image'
                ? `<img loading="lazy" src="/api/files/raw?path=${encodeURIComponent(item.path)}" alt="${esc(item.name)}" />`
                : `<video src="/api/files/raw?path=${encodeURIComponent(item.path)}" preload="metadata" muted></video><span class="badge-play">${icon(
                    'fa-solid fa-play'
                  )}</span>`
            }
          </div>
          <div class="label">${esc(item.name)}</div>
        </button>`
      )
      .join('');
    grid.querySelectorAll('[data-path]').forEach((node) => {
      node.addEventListener('click', () => openTab(`viewer?path=${encodeURIComponent(node.dataset.path)}`));
    });
  }

  load();
}
