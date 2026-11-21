import { api, debounce, esc, fileIcon, fmtDate, icon, openModal, toast } from '../core.js';
import { openTab } from '../shell.js';

export default function mount(root, ctx) {
  let query = ctx.params.get('q') || '';
  let results = null;

  root.innerHTML = `<div class="page">
    <header class="page-head">
      <div>
        <h1 class="page-title">Search</h1>
        <p class="page-sub">Files, people, events and tasks. Admins also see server files.</p>
      </div>
    </header>

    <form class="dash-search" id="search-form" style="max-width:none">
      ${icon('fa-solid fa-magnifying-glass')}
      <input id="search-input" data-search-input value="${esc(query)}" placeholder="Search everything in CoolCloud…" autocomplete="off" />
      <button class="btn primary sm" type="submit">Search</button>
    </form>

    <div class="search-layout" id="results"></div>
  </div>`;

  const input = root.querySelector('#search-input');
  const resultsEl = root.querySelector('#results');

  const run = debounce(async () => {
    query = input.value.trim();
    ctx.params.set('q', query);
    history.replaceState(null, '', `#/search${query ? `?q=${encodeURIComponent(query)}` : ''}`);
    if (query.length < 2) {
      resultsEl.innerHTML = `<div class="empty">${icon('fa-solid fa-magnifying-glass')}<p>Type at least two characters.</p></div>`;
      return;
    }
    resultsEl.innerHTML = `<div class="stack-2"><div class="skeleton" style="height:44px"></div><div class="skeleton" style="height:44px"></div></div>`;
    try {
      results = await api(`/api/search?q=${encodeURIComponent(query)}`);
      render();
    } catch (err) {
      resultsEl.innerHTML = `<div class="note error">${icon('fa-solid fa-triangle-exclamation')} ${esc(err.message)}</div>`;
    }
  }, 260);

  input.addEventListener('input', run);
  root.querySelector('#search-form').addEventListener('submit', (event) => {
    event.preventDefault();
    run();
  });

  function render() {
    const groups = [];
    if (results.files.length) {
      groups.push({
        title: `Files · ${results.files.length}`,
        items: results.files.map((file) => ({
          icon: fileIcon(file.kind, file.name),
          name: file.name,
          meta: file.path,
          snippet: file.snippet,
          onClick: () => {
            if (file.kind === 'text') openTab(`cc:editor?file=${encodeURIComponent(file.path)}`);
            else openTab(`viewer?path=${encodeURIComponent(file.path)}`);
          }
        }))
      });
    }
    if (results.system?.length) {
      groups.push({
        title: `Server files (admin) · ${results.system.length}`,
        items: results.system.map((file) => ({
          icon: 'fa-solid fa-server',
          name: file.name,
          meta: file.path,
          snippet: file.snippet,
          onClick: () => viewSystemFile(file)
        }))
      });
    }
    if (results.people.length) {
      groups.push({
        title: `People · ${results.people.length}`,
        items: results.people.map((person) => ({
          icon: 'fa-regular fa-address-book',
          name: person.name,
          meta: person.email || person.organization || '',
          onClick: () => openTab('cc:contacts')
        }))
      });
    }
    if (results.events.length) {
      groups.push({
        title: `Events · ${results.events.length}`,
        items: results.events.map((event) => ({
          icon: 'fa-regular fa-calendar',
          name: event.title,
          meta: fmtDate(event.start, { time: true }),
          onClick: () => openTab('cc:calendar')
        }))
      });
    }
    if (results.tasks.length) {
      groups.push({
        title: `Tasks · ${results.tasks.length}`,
        items: results.tasks.map((task) => ({
          icon: task.done ? 'fa-regular fa-circle-check' : 'fa-regular fa-circle',
          name: task.title,
          meta: task.due ? `Due ${fmtDate(task.due)}` : 'No due date',
          onClick: () => openTab('cc:tasks')
        }))
      });
    }
    if (results.apps.length) {
      groups.push({
        title: 'Apps',
        items: results.apps.map((app) => ({
          icon: app.icon,
          name: app.name,
          meta: app.id,
          onClick: () => openTab(app.id)
        }))
      });
    }

    if (!groups.length) {
      resultsEl.innerHTML = `<div class="empty">${icon('fa-regular fa-face-meh')}<p>Nothing matched “${esc(results.query)}”.</p></div>`;
      return;
    }
    resultsEl.innerHTML = groups
      .map(
        (group) => `<section>
          <p class="search-group-title">${esc(group.title)}</p>
          ${group.items
            .map(
              (item, index) => `<button class="result" data-g="${groups.indexOf(group)}" data-i="${index}">
                <span class="file-ico">${icon(item.icon)}</span>
                <span class="grow" style="min-width:0">
                  <span class="result-name truncate" style="display:block">${esc(item.name)}</span>
                  <span class="result-meta" style="display:block">${esc(item.meta || '')}</span>
                  ${item.snippet ? `<span class="result-snippet">${esc(item.snippet)}</span>` : ''}
                </span>
                ${icon('fa-solid fa-arrow-right', 'color:var(--text-3);font-size:10px')}
              </button>`
            )
            .join('')}
        </section>`
      )
      .join('');

    resultsEl.querySelectorAll('[data-g]').forEach((node) => {
      node.addEventListener('click', () => {
        const group = groups[Number(node.dataset.g)];
        group.items[Number(node.dataset.i)].onClick();
      });
    });
  }

  async function viewSystemFile(file) {
    try {
      const data = await api(`/api/admin/system-file?path=${encodeURIComponent(file.path)}&root=${file.root}`);
      openModal({
        title: file.name,
        sub: file.path,
        wide: true,
        body: `<pre class="log-box" style="max-height:56vh">${esc(data.content)}</pre>
          <p class="hint" style="margin-top:10px">Read-only preview. Edit server files from your terminal.</p>`,
        actions: [{ label: 'Close', kind: 'primary' }]
      });
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  if (query.length >= 2) run();
  else run();
}
