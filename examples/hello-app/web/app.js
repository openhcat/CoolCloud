/* CoolCloud apps run same-origin and send the signed-in session cookie.
   Call the normal HTTP API with fetch; no SDK or token juggling needed. */

const escapeHtml = (value) =>
  String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

async function load() {
  const card = document.getElementById('files');
  try {
    const response = await fetch('/api/files?path=', { credentials: 'same-origin' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    card.innerHTML = `
      <div class="card-head">
        <span class="card-title"><i class="fa-solid fa-folder-open"></i> Files at the root</span>
        <span class="badge">${data.entries.length} items</span>
      </div>
      <div class="stack-1">
        ${data.entries
          .map(
            (entry) => `<div class="row" style="padding:6px 0">
              <span class="file-ico"><i class="fa-solid ${entry.dir ? 'fa-folder' : 'fa-file'}"></i></span>
              <span class="grow truncate">${escapeHtml(entry.name)}</span>
              <span class="tiny dim">${entry.dir ? 'Folder' : `${Math.ceil(entry.size / 1024)} KB`}</span>
            </div>`
          )
          .join('')}
      </div>`;
  } catch (error) {
    card.innerHTML = `<div class="note error"><i class="fa-solid fa-triangle-exclamation"></i> ${escapeHtml(error.message)}</div>`;
  }
}

document.getElementById('refresh').addEventListener('click', load);
load();

/* Theme: match the parent CoolCloud window when embedded. */
if (window.parent !== window) {
  document.documentElement.dataset.theme = window.parent.document.documentElement.dataset.theme || 'light';
}
