import { api, confirmDialog, esc, icon, openModal, toast } from '../core.js';
import { openTab, refreshSession } from '../shell.js';

export default function mount(root, ctx) {
  let registries = [];
  let installed = [];

  root.innerHTML = `<div class="page">
    <header class="page-head">
      <div>
        <h1 class="page-title">App Store</h1>
        <p class="page-sub">Point CoolCloud at any registry JSON. No central service required.</p>
      </div>
      <div class="page-actions">
        <button class="btn quiet sm" id="back-admin">${icon('fa-solid fa-sliders')} Admin</button>
        <button class="btn primary sm" id="add-registry">${icon('fa-solid fa-link')} Add registry</button>
      </div>
    </header>
    <div id="store-body" class="stack-5"><div class="skeleton" style="height:200px"></div></div>
  </div>`;

  const body = root.querySelector('#store-body');

  async function load() {
    try {
      const data = await api('/api/admin/store');
      registries = data.registries || [];
      installed = data.installed || [];
    } catch (err) {
      body.innerHTML = `<div class="note error">${icon('fa-solid fa-triangle-exclamation')} ${esc(err.message)}</div>`;
      return;
    }
    render();
  }

  function render() {
    body.innerHTML = `
      ${
        registries.length
          ? registries
              .map(
                (registry) => `<section class="stack-3">
                  <div class="spread">
                    <div>
                      <h2 style="font-size:15px">${esc(registry.name || registry.url)}</h2>
                      <p class="tiny dim mono">${esc(registry.url)} · ${registry.apps.length} app${registry.apps.length === 1 ? '' : 's'}</p>
                    </div>
                    <button class="btn ghost sm" data-remove-registry="${esc(registry.url)}">${icon('fa-solid fa-link-slash')} Remove</button>
                  </div>
                  ${registry.error ? `<div class="note error">${esc(registry.error)}</div>` : ''}
                  <div class="stack-2">
                    ${
                      registry.apps.length
                        ? registry.apps
                            .map(
                              (app) => `<div class="task-row">
                                <span class="app-icon" style="--app:var(--app-editor)">${icon(app.icon || 'fa-solid fa-cube')}</span>
                                <div class="grow" style="min-width:0">
                                  <div class="strong small">${esc(app.name)} <span class="badge">v${esc(
                                  app.version || '1.0.0'
                                )}</span>${app.type === 'widget' ? ' <span class="badge ok">widget</span>' : ''}</div>
                                  <div class="tiny dim">${esc(app.description || '')}</div>
                                  <div class="tiny dim mono">${esc(app.id)} · ${esc(app.repo)}</div>
                                </div>
                                ${
                                  app.installed
                                    ? `<span class="badge ok">${icon('fa-solid fa-check')} Installed</span>`
                                    : `<button class="btn primary sm" data-install="${esc(app.id)}" data-type="${esc(
                                        app.type || 'app'
                                      )}">${icon('fa-solid fa-download')} Install</button>`
                                }
                              </div>`
                            )
                            .join('')
                        : '<p class="hint">This registry lists no apps yet.</p>'
                    }
                  </div>
                </section>`
              )
              .join('')
          : `<div class="empty card">${icon(
              'fa-solid fa-store'
            )}<p>No registries yet. Add the URL of any JSON registry to browse its apps.</p><button class="btn sm" id="add-first">Add your first registry</button></div>`
      }

      <section class="stack-3">
        <div class="spread">
          <h2 style="font-size:15px">Install from a git repository</h2>
        </div>
        <form class="dash-search" id="git-form" style="max-width:none">
          ${icon('fa-solid fa-code-branch')}
          <input id="git-url" placeholder="https://github.com/you/coolcloud-app.git" autocomplete="off" />
          <select class="select" id="git-type" aria-label="Install as" style="flex:none;width:180px">
            <option value="app">Install as app</option>
            <option value="widget">Install as widget</option>
          </select>
          <button class="btn primary sm" type="submit">Install</button>
        </form>
        <p class="hint">A shallow clone, then manifest.json is validated before anything is enabled. Widgets render on the home page instead of opening a tab.</p>
      </section>

      <section class="stack-3">
        <h2 style="font-size:15px">Installed apps and widgets</h2>
        <div class="stack-2">
          ${installed
            .map(
              (app) => `<div class="task-row">
                <span class="app-icon" style="--app:var(--app-${esc(app.accent || 'files')})">${icon(app.icon)}</span>
                <div class="grow"><div class="strong small">${esc(app.name)}${
                  app.type === 'widget' ? ' <span class="badge">widget</span>' : ''
                }</div>
                <div class="tiny dim mono">${esc(app.id)} · v${esc(app.version)}</div></div>
                ${app.permissions?.length ? `<span class="badge" title="${esc(app.permissions.join(', '))}">${app.permissions.length} scope${app.permissions.length === 1 ? '' : 's'}</span>` : ''}
                ${app.signedBy ? `<span class="badge ok" title="Manifest signed by ${esc(app.signedBy)}">Signed</span>` : ''}
                <span class="badge ${app.enabled ? 'ok' : ''}">${app.enabled ? 'Enabled' : 'Disabled'}</span>
                ${
                  app.kind === 'external'
                    ? `<button class="btn quiet sm" data-grants="${esc(app.id)}" aria-label="Permissions">${icon('fa-solid fa-shield-halved')} Permissions</button><button class="btn ghost icon sm" data-remove-app="${esc(app.id)}" aria-label="Remove">${icon(
                        'fa-solid fa-trash-can'
                      )}</button>`
                    : ''
                }
              </div>`
            )
            .join('')}
        </div>
      </section>`;
    wire();
  }

  function wire() {
    body.querySelectorAll('[data-install]').forEach((node) => {
      node.addEventListener('click', async () => {
        node.disabled = true;
        node.innerHTML = '<span class="spinner"></span>';
        try {
          const result = await api('/api/admin/store/install', {
            method: 'POST',
            body: { id: node.dataset.install, type: node.dataset.type || '' }
          });
          toast(`${result.app.name} installed${result.app.type === 'widget' ? ' as a widget' : ''}`);
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
      node.addEventListener('click', () => manageGrants(installed.find((app) => app.id === node.dataset.grants), node.dataset.grants));
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
    body.querySelector('#add-first')?.addEventListener('click', addRegistry);
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

  function addRegistry() {
    openModal({
      title: 'Add a registry',
      sub: 'A JSON file with a schema name and an apps array.',
      body: `<div class="field"><label class="label">Registry URL</label><input class="input" id="registry-url" placeholder="https://example.com/coolcloud-registry.json" /></div>
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

  root.querySelector('#add-registry').addEventListener('click', addRegistry);
  root.querySelector('#back-admin').addEventListener('click', () => openTab('admin'));

  load();
}
