import { api, confirmDialog, esc, icon, openModal, toast } from '../core.js';
import { openTab, refreshSession } from '../shell.js';

export default function mount(root, ctx) {
  let data = {
    registries: [],
    installed: [],
    categories: [],
    official: '',
    registryHome: '',
    publishGuide: ''
  };
  let tab = 'explore';
  let registryUrl = '';
  let category = 'All';
  let query = '';

  root.innerHTML = `<div class="page">
    <header class="page-head">
      <div>
        <h1 class="page-title">App Store</h1>
        <p class="page-sub">Apps come from the Official App Registry. Browse by category, or point CoolCloud at your own registry.</p>
      </div>
      <div class="page-actions">
        <button class="btn quiet sm" id="back-admin">${icon('fa-solid fa-sliders')} Admin</button>
        <button class="btn quiet sm" id="tour">${icon('fa-regular fa-circle-question')} How it works</button>
        <button class="btn quiet sm" id="refresh-store">${icon('fa-solid fa-rotate')} Refresh</button>
        <button class="btn primary sm" id="add-registry">${icon('fa-solid fa-link')} Add registry</button>
      </div>
    </header>
    <div class="store-tabs" role="tablist" aria-label="App Store sections">
      <button role="tab" data-tab="explore">${icon('fa-solid fa-compass')} Explore</button>
      <button role="tab" data-tab="installed">${icon('fa-solid fa-box')} Installed</button>
      <button role="tab" data-tab="publish">${icon('fa-solid fa-upload')} Publish</button>
    </div>
    <div id="store-body" class="stack-5"><div class="skeleton" style="height:220px"></div></div>
  </div>
  <style>
    .store-tabs { display:flex; gap:4px; border-bottom:1px solid var(--border); margin-bottom:6px; flex-wrap:wrap; }
    .store-tabs button { border:0; background:none; font:inherit; font-size:12.5px; color:var(--text-3); padding:9px 13px; border-bottom:2px solid transparent; cursor:pointer; display:inline-flex; align-items:center; gap:8px; }
    .store-tabs button:hover { color:var(--text); }
    .store-tabs button[aria-selected="true"] { color:var(--accent); border-bottom-color:var(--accent); font-weight:600; }
    .store-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(282px,1fr)); gap:12px; }
    .store-card { border:1px solid var(--border); background:var(--surface); border-radius:14px; padding:15px; display:flex; flex-direction:column; gap:9px; min-height:168px; }
    .store-card .top { display:flex; gap:10px; align-items:flex-start; }
    .store-card h3 { margin:0; font-size:14px; letter-spacing:-0.01em; }
    .store-card p { margin:0; font-size:12.5px; line-height:1.55; color:var(--text-2); flex:1; }
    .store-card .meta { font-size:10.5px; color:var(--text-3); font-family:var(--font-mono); }
    .store-card .foot { display:flex; gap:6px; align-items:center; flex-wrap:wrap; }
    .store-chips { display:flex; gap:6px; flex-wrap:wrap; }
    .store-chip { border:1px solid var(--border); background:var(--surface); color:var(--text-2); border-radius:999px; padding:5px 11px; font:inherit; font-size:11.5px; cursor:pointer; }
    .store-chip:hover { border-color:var(--accent-line); color:var(--text); }
    .store-chip[aria-pressed="true"] { background:var(--accent); border-color:var(--accent); color:var(--accent-ink); font-weight:600; }
    .store-toolbar { display:flex; gap:10px; align-items:center; flex-wrap:wrap; }
    .store-empty { border:1px dashed var(--border-strong); border-radius:14px; padding:38px 18px; text-align:center; color:var(--text-3); font-size:13px; }
    .store-drawer-scrim { position:fixed; inset:0; z-index:120; background:rgba(6,18,30,.42); display:flex; justify-content:flex-end; }
    .store-drawer { width:min(410px,100%); height:100%; overflow:auto; background:var(--panel-strong); border-left:1px solid var(--panel-border); box-shadow:var(--shadow-lg); padding:20px; display:flex; flex-direction:column; gap:14px; }
    .store-drawer h2 { margin:0; font-size:18px; letter-spacing:-0.01em; }
    .store-drawer .desc { margin:0; color:var(--text-2); font-size:13px; line-height:1.6; }
    .store-drawer .kv-list { gap:8px; }
    .store-drawer .kv { font-size:12.5px; }
    .store-drawer .foot { display:flex; gap:8px; flex-wrap:wrap; margin-top:auto; padding-top:10px; border-top:1px solid var(--border); }
    .store-tour { position:fixed; inset:0; z-index:130; background:rgba(6,18,30,.5); display:flex; align-items:center; justify-content:center; padding:18px; }
    .store-tour-card { width:min(520px,100%); background:var(--panel-strong); border:1px solid var(--panel-border); border-radius:16px; box-shadow:var(--shadow-lg); padding:22px; }
    .store-tour-card h2 { margin:0 0 4px; font-size:19px; letter-spacing:-0.01em; }
    .store-tour-card .step { display:flex; gap:10px; padding:9px 0; border-top:1px solid var(--border); font-size:12.5px; }
    .store-tour-card .step:first-of-type { border-top:0; }
    .store-tour-card .step b { display:block; font-size:12.5px; }
    .store-tour-card .step span { color:var(--text-3); font-size:12px; line-height:1.5; }
    .store-tour-card .actions { display:flex; justify-content:space-between; gap:8px; margin-top:16px; flex-wrap:wrap; }
  </style>`;

  const body = root.querySelector('#store-body');

  async function load() {
    try {
      data = { ...data, ...(await api('/api/admin/store')) };
      if (!registryUrl || !data.registries.some((registry) => registry.url === registryUrl)) {
        registryUrl = data.registries.find((registry) => registry.official)?.url || data.registries[0]?.url || '';
      }
    } catch (err) {
      body.innerHTML = `<div class="note error">${icon('fa-solid fa-triangle-exclamation')} ${esc(err.message)}</div>`;
      return;
    }
    render();
  }

  function tabs() {
    root.querySelectorAll('[data-tab]').forEach((node) => node.setAttribute('aria-selected', String(node.dataset.tab === tab)));
  }

  function activeRegistry() {
    return data.registries.find((registry) => registry.url === registryUrl) || data.registries[0] || null;
  }

  function render() {
    tabs();
    if (tab === 'explore') return renderExplore();
    if (tab === 'installed') return renderInstalled();
    return renderPublish();
  }

  function registryApps() {
    const registry = activeRegistry();
    if (!registry) return [];
    return (registry.apps || []).filter((app) => category === 'All' || app.category === category).filter((app) => {
      if (!query) return true;
      return [app.id, app.name, app.description, app.category, ...(app.tags || [])]
        .join(' ')
        .toLowerCase()
        .includes(query);
    });
  }

  function renderExplore() {
    const registry = activeRegistry();
    if (!data.registries.length) {
      body.innerHTML = `<div class="card store-empty">
        ${icon('fa-solid fa-store')}
        <p style="margin:10px 0 12px">No registries yet. The official registry is added on install; you can add any JSON registry now.</p>
        <button class="btn primary sm" id="add-first">${icon('fa-solid fa-link')} Add the Official App Registry</button>
      </div>`;
      wire();
      return;
    }

    const apps = registryApps();
    body.innerHTML = `
      <section class="stack-3">
        <div class="spread" style="gap:10px;flex-wrap:wrap">
          <div>
            <h2 style="font-size:15px;margin:0">${esc(registry.name || 'Registry')} ${registry.official ? '<span class="badge accent">Official</span>' : ''}</h2>
            <p class="tiny dim mono" style="margin:4px 0 0">${esc(registry.url)} · ${registry.apps.length} app${registry.apps.length === 1 ? '' : 's'}${registry.official ? ' · default' : ''}</p>
          </div>
          ${data.registries.length > 1 ? `<div class="store-chips">${data.registries
            .map(
              (item) => `<button class="store-chip" data-registry="${esc(item.url)}" aria-pressed="${String(item.url === registryUrl)}">${esc(item.name || item.url)}</button>`
            )
            .join('')}</div>` : ''}
        </div>
        ${registry.error ? `<div class="note error">${icon('fa-solid fa-triangle-exclamation')} ${esc(registry.error)}</div>` : ''}
        <div class="store-toolbar">
          <label class="search" style="flex:1;min-width:220px;display:flex;align-items:center;gap:8px;border:1px solid var(--border);background:var(--surface);border-radius:9px;padding:0 11px;height:38px">
            ${icon('fa-solid fa-magnifying-glass')}
            <input id="store-search" placeholder="Search apps, tags or ids..." value="${esc(query)}" style="border:0;background:none;outline:0;font:inherit;font-size:13px;width:100%" aria-label="Search apps" />
          </label>
          <span class="badge">${apps.length} shown</span>
        </div>
        <div class="store-chips">
          ${['All', ...data.categories]
            .map((name) => `<button class="store-chip" data-category="${esc(name)}" aria-pressed="${String(name === category)}">${esc(name)}</button>`)
            .join('')}
        </div>
        <div class="store-grid">
          ${
            apps.length
              ? apps
                  .map(
                    (app) => `<article class="store-card">
                      <div class="top">
                        <span class="app-icon" style="--app:var(--app-${esc(app.accent || 'files')})">${icon(app.icon || 'fa-solid fa-cube')}</span>
                        <div class="grow" style="min-width:0">
                          <h3>${esc(app.name)}</h3>
                          <div class="meta">${esc(app.id)} · v${esc(app.version || '1.0.0')}</div>
                        </div>
                      </div>
                      <p>${esc(app.description || '')}</p>
                      <div class="foot">
                        ${app.category ? `<span class="badge">${esc(app.category)}</span>` : ''}
                        ${app.runtime === 'core' || app.builtin ? '<span class="badge ok">core</span>' : ''}
                        ${app.essentials ? '<span class="badge accent">essentials</span>' : ''}
                        ${app.beta ? '<span class="badge">beta</span>' : ''}
                        ${app.type === 'widget' ? '<span class="badge">widget</span>' : ''}
                        ${app.enterpriseOnly || app.enterprise ? '<span class="badge" style="border-color:var(--accent-line);color:var(--accent)">ENTERPRISE ONLY</span>' : ''}
                      </div>
                      <div class="foot">
                        ${
                          app.installed
                            ? `<span class="badge ok">${icon('fa-solid fa-check')} Installed</span>`
                            : app.enterpriseOnly || app.enterprise
                              ? `<a class="btn quiet sm" href="${esc(app.contact || 'mailto:coolcloud.getenterprise@hatcat.me')}" target="_blank" rel="noopener noreferrer">${icon('fa-solid fa-building')} Contact us</a>`
                              : `<button class="btn primary sm" data-install="${esc(app.id)}" data-type="${esc(app.type || 'app')}">${icon('fa-solid fa-download')} Install</button>`
                        }
                        <button class="btn ghost sm" data-details="${esc(app.id)}">${icon('fa-solid fa-circle-info')} Details</button>
                      </div>
                    </article>`
                  )
                  .join('')
              : `<div class="store-empty">No app matches that filter. <button class="store-chip" data-category="All">Clear</button></div>`
          }
        </div>
      </section>

      <section class="widget" style="margin-top:18px">
        <div class="widget-head"><span class="widget-title">${icon('fa-solid fa-upload')} Publish to the registry</span></div>
        <p class="hint" style="margin:0 0 10px">An app is a folder with a manifest.json and a web entry point. Test it with <span class="mono">coolcloud --install you:app dir=./app</span>, then open a pull request to the registry.</p>
        <div class="row" style="gap:8px;flex-wrap:wrap">
          <a class="btn quiet sm" href="${esc(data.publishGuide || data.registryHome || '#')}" target="_blank" rel="noopener noreferrer">${icon('fa-solid fa-book')} Publishing guide</a>
          <a class="btn ghost sm" href="${esc(data.registryHome || data.publishGuide || '#')}" target="_blank" rel="noopener noreferrer">${icon('fa-solid fa-globe')} Browse the registry</a>
        </div>
      </section>`;
    wire();
    body.querySelector('#store-search')?.addEventListener('input', (event) => {
      query = event.target.value.trim().toLowerCase();
      render();
      const input = body.querySelector('#store-search');
      if (input) {
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      }
    });
  }

  function renderInstalled() {
    body.innerHTML = `
      <section class="stack-3">
        <div class="spread">
          <h2 style="font-size:15px;margin:0">Installed apps and widgets</h2>
          <span class="badge">${data.installed.length} installed</span>
        </div>
        <div class="stack-2">
          ${
            data.installed.length
              ? data.installed
                  .map(
                    (app) => `<div class="task-row">
                      <span class="app-icon" style="--app:var(--app-${esc(app.accent || 'files')})">${icon(app.icon)}</span>
                      <div class="grow" style="min-width:0">
                        <div class="strong small">${esc(app.name)}${app.type === 'widget' ? ' <span class="badge">widget</span>' : ''}</div>
                        <div class="tiny dim mono">${esc(app.id)} · v${esc(app.version)}${app.kind === 'builtin' ? ' · core' : ''}</div>
                      </div>
                      ${app.permissions?.length ? `<span class="badge" title="${esc(app.permissions.join(', '))}">${app.permissions.length} scope${app.permissions.length === 1 ? '' : 's'}</span>` : ''}
                      <span class="badge ${app.enabled ? 'ok' : ''}">${app.enabled ? 'Enabled' : 'Disabled'}</span>
                      ${
                        app.kind === 'external'
                          ? `<button class="btn quiet sm" data-grants="${esc(app.id)}">${icon('fa-solid fa-shield-halved')} Permissions</button><button class="btn ghost icon sm" data-remove-app="${esc(app.id)}" aria-label="Remove">${icon('fa-solid fa-trash-can')}</button>`
                          : ''
                      }
                    </div>`
                  )
                  .join('')
              : '<p class="hint">No apps installed yet. Explore the registry to add some.</p>'
          }
        </div>
      </section>

      <section class="stack-3" style="margin-top:18px">
        <h2 style="font-size:15px;margin:0">Install from a git repository</h2>
        <form class="dash-search" id="git-form" style="max-width:none">
          ${icon('fa-solid fa-code-branch')}
          <input id="git-url" placeholder="https://github.com/you/coolcloud-app.git" autocomplete="off" />
          <select class="select" id="git-type" aria-label="Install as" style="flex:none;width:170px">
            <option value="app">Install as app</option>
            <option value="widget">Install as widget</option>
          </select>
          <button class="btn primary sm" type="submit">Install</button>
        </form>
        <p class="hint">A shallow clone, then manifest.json is validated before anything is enabled. Widgets render on the home page instead of opening a tab.</p>
      </section>`;
    wire();
  }

  function renderPublish() {
    body.innerHTML = `
      <section class="widget">
        <div class="widget-head"><span class="widget-title">${icon('fa-solid fa-upload')} Publish an app</span></div>
        <p class="small" style="line-height:1.65;margin:0 0 12px">Apps live in the registry, not in the CoolCloud repository. A manifest plus a web entry point is the whole package; the installer downloads only the files your entry lists.</p>
        <div class="stack-2" style="margin-bottom:14px">
          <div class="task-row"><span class="badge accent">1</span><div class="grow"><div class="strong small">Build the folder</div><div class="tiny dim">manifest.json · README.md · web/index.html</div></div></div>
          <div class="task-row"><span class="badge accent">2</span><div class="grow"><div class="strong small">Test it locally</div><div class="tiny dim mono">coolcloud --install you:app dir=./your-app</div></div></div>
          <div class="task-row"><span class="badge accent">3</span><div class="grow"><div class="strong small">Add it to the registry</div><div class="tiny dim">A pull request to the registry repository adds your entry to registry.json</div></div></div>
        </div>
        <div class="row" style="gap:8px;flex-wrap:wrap">
          <a class="btn primary sm" href="${esc(data.publishGuide || data.registryHome || '#')}" target="_blank" rel="noopener noreferrer">${icon('fa-solid fa-book')} Open the publishing guide</a>
          <a class="btn ghost sm" href="${esc(data.registryHome || '#')}" target="_blank" rel="noopener noreferrer">${icon('fa-solid fa-globe')} Registry home</a>
        </div>
      </section>

      <section class="stack-3" style="margin-top:18px">
        <h2 style="font-size:15px;margin:0">Registries this server reads</h2>
        <div class="stack-2">
          ${data.registries
            .map(
              (registry) => `<div class="task-row">
                <span class="app-icon" style="--app:var(--app-files)">${icon('fa-solid fa-link')}</span>
                <div class="grow" style="min-width:0">
                  <div class="strong small">${esc(registry.name || registry.url)} ${registry.official ? '<span class="badge accent">Official</span>' : ''}</div>
                  <div class="tiny dim mono truncate">${esc(registry.url)}</div>
                </div>
                <span class="badge">${registry.apps.length} apps</span>
                ${registry.official ? '' : `<button class="btn ghost icon sm" data-remove-registry="${esc(registry.url)}" aria-label="Remove registry">${icon('fa-solid fa-link-slash')}</button>`}
              </div>`
            )
            .join('')}
        </div>
        <p class="hint">Any static JSON with a schema name and an apps array works. Internal registries never need to be public.</p>
      </section>`;
    wire();
  }

  function wire() {
    body.querySelectorAll('[data-details]').forEach((node) =>
      node.addEventListener('click', () => {
        const registry = activeRegistry();
        const app = (registry?.apps || []).find((item) => item.id === node.dataset.details);
        if (app) showDetails(app);
      })
    );
    root.querySelectorAll('[data-tab]').forEach((node) => {
      node.onclick = () => {
        tab = node.dataset.tab;
        render();
      };
    });

    body.querySelectorAll('[data-registry]').forEach((node) =>
      node.addEventListener('click', () => {
        registryUrl = node.dataset.registry;
        category = 'All';
        render();
      })
    );
    body.querySelectorAll('[data-category]').forEach((node) =>
      node.addEventListener('click', () => {
        category = node.dataset.category;
        render();
      })
    );
    body.querySelectorAll('[data-install]').forEach((node) => {
      node.addEventListener('click', async () => {
        node.disabled = true;
        node.innerHTML = '<span class="spinner"></span>';
        try {
          const result = await api('/api/admin/store/install', {
            method: 'POST',
            body: { id: node.dataset.install, type: node.dataset.type || '' }
          });
          toast(`${result.app.name} installed`);
          await refreshSession();
          load();
        } catch (err) {
          toast(err.message, 'error');
          node.disabled = false;
          node.textContent = 'Install';
        }
      });
    });
    body.querySelectorAll('[data-remove-registry]').forEach((node) => {
      node.addEventListener('click', async () => {
        await api(`/api/admin/store/registries?url=${encodeURIComponent(node.dataset.removeRegistry)}`, { method: 'DELETE' });
        toast('Registry removed');
        load();
      });
    });
    body.querySelectorAll('[data-remove-app]').forEach((node) => {
      node.addEventListener('click', async () => {
        const ok = await confirmDialog({ title: 'Remove app?', message: 'Its folder is deleted from this instance.' });
        if (!ok) return;
        await api(`/api/admin/apps/${encodeURIComponent(node.dataset.removeApp)}`, { method: 'DELETE' });
        await refreshSession();
        load();
      });
    });
    body.querySelectorAll('[data-grants]').forEach((node) => {
      node.addEventListener('click', () => manageGrants(data.installed.find((app) => app.id === node.dataset.grants), node.dataset.grants));
    });
    body.querySelector('#git-form')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const url = body.querySelector('#git-url').value.trim();
      if (!url) return;
      try {
        const type = body.querySelector('#git-type').value;
        const result = await api('/api/admin/apps/install', { method: 'POST', body: { git: url, type } });
        toast(`${result.app.name} installed${type === 'widget' ? ' as a widget' : ''}`);
        await refreshSession();
        load();
      } catch (err) {
        toast(err.message, 'error');
      }
    });
    body.querySelector('#add-first')?.addEventListener('click', () => {
      const url = data.official || 'https://raw.githubusercontent.com/openhcat/cc-appregistry/main/registry.json';
      addRegistry(url);
    });
  }

  async function manageGrants(app, id) {
    if (!app) return;
    let grant;
    try {
      grant = await api(`/api/apps/${encodeURIComponent(id)}/grants`);
    } catch (err) {
      return toast(err.message, 'error');
    }
    if (!grant.permissions.length) {
      openModal({
        title: `${app.name} permissions`,
        body: '<p class="hint">This app requests no permissions. It runs in a sandboxed frame and cannot read your data.</p>',
        actions: [{ label: 'Close', kind: 'ghost' }]
      });
      return;
    }
    openModal({
      title: `${app.name} permissions`,
      sub: 'Only grant what the app needs. You can revoke access at any time.',
      body: `<div class="stack-2">${grant.permissions
        .map(
          (scope) => `<label class="check"><input type="checkbox" value="${esc(scope)}" ${grant.scopes.includes(scope) ? 'checked' : ''} />
            <span><span class="strong small">${esc(scope)}</span><span class="tiny dim" style="display:block">${esc(
              { storage: 'Store app data linked to your account', files: 'Read files you choose', mail: 'Read mail you choose', calendar: 'Read your calendar', tasks: 'Read your tasks', contacts: 'Read your contacts' }[scope] || 'App-specific access'
            )}</span></span></label>`
        )
        .join('')}</div>`,
      actions: [
        {
          label: 'Revoke all',
          kind: 'danger',
          onClick: async () => {
            await api(`/api/apps/${encodeURIComponent(id)}/grants`, { method: 'DELETE' });
            toast('Access revoked');
          }
        },
        { label: 'Cancel', kind: 'ghost' },
        {
          label: 'Save access',
          kind: 'primary',
          onClick: async ({ dialog }) => {
            const scopes = [...dialog.querySelectorAll('input[type="checkbox"]:checked')].map((node) => node.value);
            try {
              await api(`/api/apps/${encodeURIComponent(id)}/grants`, { method: 'POST', body: { scopes } });
              toast('App access saved');
            } catch (err) {
              toast(err.message, 'error');
              return false;
            }
          }
        }
      ]
    });
  }

  function addRegistry(preset = '') {
    openModal({
      title: 'Add a registry',
      sub: 'A JSON file with a schema name, categories and an apps array.',
      body: `<div class="field"><label class="label">Registry URL</label><input class="input" id="registry-url" value="${esc(preset)}" placeholder="https://example.com/coolcloud-registry.json" /></div>
        <p class="hint" style="margin-top:8px">The registry is fetched server-side and cached. See docs/APPSTORE-REGISTRY.txt for the format.</p>`,
      actions: [
        { label: 'Cancel', kind: 'ghost' },
        {
          label: 'Add registry',
          kind: 'primary',
          onClick: async ({ dialog }) => {
            const url = dialog.querySelector('#registry-url').value.trim();
            if (!url) return false;
            try {
              const result = await api('/api/admin/store/registries', { method: 'POST', body: { url } });
              toast(`Registry added · ${result.apps} apps`);
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

  function showDetails(app) {
    const installed = data.installed.find((item) => item.id === app.id);
    const permissions = installed?.permissions || app.permissions || [];
    const scrim = document.createElement('div');
    scrim.className = 'store-drawer-scrim';
    scrim.innerHTML = `<aside class="store-drawer" role="dialog" aria-modal="true" aria-label="${esc(app.name)} details">
      <div class="spread" style="align-items:flex-start">
        <div class="row" style="gap:10px;min-width:0">
          <span class="app-icon" style="--app:var(--app-${esc(app.accent || 'files')})">${icon(app.icon || 'fa-solid fa-cube')}</span>
          <div style="min-width:0"><h2>${esc(app.name)}</h2><div class="tiny dim mono">${esc(app.id)}</div></div>
        </div>
        <button class="btn ghost icon sm" data-close aria-label="Close details">${icon('fa-solid fa-xmark')}</button>
      </div>
      <p class="desc">${esc(app.description || 'No description yet.')}</p>
      <div class="kv-list">
        <div class="kv"><span class="k">Version</span><span class="v">v${esc(app.version || '1.0.0')}</span></div>
        <div class="kv"><span class="k">Requires CoolCloud</span><span class="v">v${esc(app.minVersion || app.requires || '2.0.0')} or newer</span></div>
        <div class="kv"><span class="k">Category</span><span class="v">${esc(app.category || 'Uncategorised')}</span></div>
        <div class="kv"><span class="k">Kind</span><span class="v">${app.runtime === 'core' || app.builtin ? 'Core app' : app.type === 'widget' ? 'Widget' : 'External app'}</span></div>
        <div class="kv"><span class="k">Permissions</span><span class="v">${permissions.length ? esc(permissions.join(', ')) : 'None'}</span></div>
        <div class="kv"><span class="k">Registry</span><span class="v">${esc(activeRegistry()?.name || 'Official')}</span></div>
      </div>
      ${(app.tags || []).length ? `<div class="store-chips">${app.tags.map((tagName) => `<span class="badge">${esc(tagName)}</span>`).join('')}</div>` : ''}
      <div class="foot">
        ${
          app.enterpriseOnly || app.enterprise
            ? `<a class="btn primary sm" href="${esc(app.contact || 'mailto:coolcloud.getenterprise@hatcat.me')}" target="_blank" rel="noopener noreferrer">${icon('fa-solid fa-building')} Get Enterprise</a><span class="badge">Enterprise only</span>`
            : app.installed
              ? `<span class="badge ok">${icon('fa-solid fa-check')} Installed</span>`
              : `<button class="btn primary sm" data-detail-install="${esc(app.id)}" data-type="${esc(app.type || 'app')}">${icon('fa-solid fa-download')} Install</button>`
        }
        <a class="btn ghost sm" href="${esc(data.publishGuide || data.registryHome || '#')}" target="_blank" rel="noopener noreferrer">${icon('fa-solid fa-book')} Publishing guide</a>
      </div>
    </aside>`;
    root.appendChild(scrim);
    const close = () => scrim.remove();
    scrim.addEventListener('click', (event) => {
      if (event.target === scrim) close();
    });
    scrim.querySelector('[data-close]').addEventListener('click', close);
    scrim.querySelector('[data-detail-install]')?.addEventListener('click', async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      button.innerHTML = '<span class="spinner"></span>';
      try {
        const result = await api('/api/admin/store/install', { method: 'POST', body: { id: app.id, type: button.dataset.type || '' } });
        toast(`${result.app.name} installed`);
        close();
        await refreshSession();
        load();
      } catch (err) {
        toast(err.message, 'error');
        button.disabled = false;
        button.textContent = 'Install';
      }
    });
  }

  function showTour() {
    if (root.querySelector('.store-tour')) return;
    const overlay = document.createElement('div');
    overlay.className = 'store-tour';
    overlay.innerHTML = `<div class="store-tour-card" role="dialog" aria-modal="true" aria-label="How the App Store works">
      <h2>Welcome to the App Store</h2>
      <p class="hint" style="margin:0 0 8px">A quick tour. You can skip it and open it again from “How it works”.</p>
      <div class="step"><span class="badge accent">1</span><div><b>Browse the registry</b><span>Core apps, the Essentials Pack and community apps arrive from registries you choose.</span></div></div>
      <div class="step"><span class="badge accent">2</span><div><b>Open Details</b><span>See the version, the CoolCloud release it needs, permissions and its tags before you install.</span></div></div>
      <div class="step"><span class="badge accent">3</span><div><b>Install, then grant</b><span>An app only reads what you allow. Manage scopes from Installed at any time.</span></div></div>
      <div class="step"><span class="badge accent">4</span><div><b>Enterprise apps</b><span>Marked ENTERPRISE ONLY. They ship with CoolCloud Enterprise; contact us to get them.</span></div></div>
      <div class="actions"><button class="btn ghost" data-skip>Skip</button><button class="btn primary" data-done>Start exploring</button></div>
    </div>`;
    root.appendChild(overlay);
    const close = () => {
      try {
        localStorage.setItem('cc:store-tour', '1');
      } catch {
        /* ignore */
      }
      overlay.remove();
    };
    overlay.querySelector('[data-skip]').addEventListener('click', close);
    overlay.querySelector('[data-done]').addEventListener('click', close);
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) close();
    });
  }

  root.querySelector('#tour').addEventListener('click', showTour);
  root.querySelector('#refresh-store').addEventListener('click', async () => {
    const button = root.querySelector('#refresh-store');
    button.disabled = true;
    try {
      const result = await api('/api/admin/store/refresh', { method: 'POST' });
      toast(`Refreshed ${result.updated} of ${result.total} registries`);
      await load();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      button.disabled = false;
    }
  });
  root.querySelector('#add-registry').addEventListener('click', () => addRegistry());
  root.querySelector('#back-admin').addEventListener('click', () => openTab('admin'));

  load().then(() => {
    let seen = false;
    try {
      seen = localStorage.getItem('cc:store-tour') === '1';
    } catch {
      seen = true;
    }
    if (!seen) showTour();
  });
}
