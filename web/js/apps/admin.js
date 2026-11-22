import {
  DEFAULT_BRANDING,
  api,
  applyBranding,
  confirmDialog,
  esc,
  fmtBytes,
  fmtDate,
  fmtDuration,
  icon,
  brandLockup,
  shade,
  openModal,
  state,
  toast
} from '../core.js';
import { openTab, refreshBrand, refreshSession } from '../shell.js';

const ACCENTS = [
  ['#0b5fb0', 'Blue'],
  ['#0079c1', 'Sky'],
  ['#1f4e79', 'Navy'],
  ['#0b3a5c', 'Midnight'],
  ['#2f6f9f', 'Steel'],
  ['#4a7fb5', 'Mist'],
  ['#0f2437', 'Ink']
];

export default function mount(root, ctx) {
  let section = 'overview';
  let overview = null;
  let users = [];
  let apps = [];
  let look = { accent: DEFAULT_BRANDING.accent, logo: '' };

  root.innerHTML = `<div class="page">
    <header class="page-head">
      <div>
        <h1 class="page-title">Admin</h1>
        <p class="page-sub">Users, server health, applications and configuration.</p>
      </div>
      <div class="page-actions">
        <button class="btn quiet sm" id="to-store">${icon('fa-solid fa-store')} App Store</button>
        <button class="btn quiet sm" id="refresh">${icon('fa-solid fa-rotate')} Refresh</button>
      </div>
    </header>

    <div class="admin-shell">
      <nav class="admin-nav" id="admin-nav">
        <button data-section="overview" aria-current="true">${icon('fa-solid fa-chart-line')} Overview</button>
        <button data-section="appearance">${icon('fa-solid fa-palette')} Personalization</button>
        <button data-section="users">${icon('fa-solid fa-users')} Users</button>
        <button data-section="teams">${icon('fa-solid fa-user-group')} Teams</button>
        <button data-section="apps">${icon('fa-solid fa-cubes')} Apps</button>
        <button data-section="config">${icon('fa-solid fa-sliders')} Config</button>
        <button data-section="backup">${icon('fa-solid fa-database')} Backup</button>
        <button data-section="audit">${icon('fa-solid fa-clipboard-list')} Audit</button>
        <button data-section="logs">${icon('fa-solid fa-terminal')} Logs</button>
      </nav>
      <section id="admin-panel"><div class="skeleton" style="height:280px"></div></section>
    </div>
  </div>`;

  const panel = root.querySelector('#admin-panel');

  root.querySelector('#admin-nav').addEventListener('click', (event) => {
    const button = event.target.closest('[data-section]');
    if (!button) return;
    section = button.dataset.section;
    root.querySelectorAll('[data-section]').forEach((node) => node.setAttribute('aria-current', node === button ? 'true' : 'false'));
    render();
  });
  root.querySelector('#to-store').addEventListener('click', () => openTab('store'));
  root.querySelector('#refresh').addEventListener('click', () => render(true));

  async function load() {
    try {
      const [ov, us, ap] = await Promise.all([
        api('/api/admin/overview'),
        api('/api/admin/users'),
        api('/api/admin/apps')
      ]);
      overview = ov;
      users = us.users;
      apps = ap.apps;
    } catch (err) {
      toast(err.message, 'error');
      panel.innerHTML = `<div class="note error">${icon('fa-solid fa-triangle-exclamation')} ${esc(err.message)}</div>`;
      return;
    }
    render();
  }

  function render(showSkeleton = false) {
    if (showSkeleton) panel.innerHTML = '<div class="skeleton" style="height:280px"></div>';
    if (section === 'overview') return renderOverview();
    if (section === 'appearance') return renderAppearance();
    if (section === 'users') return renderUsers();
    if (section === 'teams') return renderTeams();
    if (section === 'apps') return renderApps();
    if (section === 'config') return renderConfig();
    if (section === 'backup') return renderBackup();
    if (section === 'audit') return renderAudit();
    if (section === 'logs') return renderLogs();
  }

  /* ------------------------------- overview ------------------------------- */
  function renderOverview() {
    const s = overview.server;
    const c = overview.counts;
    const storage = overview.storage;
    const percent = storage.limit ? Math.min(100, Math.round((storage.used / storage.limit) * 100)) : null;
    panel.innerHTML = `<div class="stack-4">
      <div class="stat-grid">
        <div class="stat-card"><div class="k">Users</div><div class="v">${c.users}</div><div class="s">${c.admins} admin${c.admins === 1 ? '' : 's'} · ${c.activeUsers} active</div></div>
        <div class="stat-card"><div class="k">Storage used</div><div class="v">${fmtBytes(storage.used)}</div><div class="s">${
          storage.limit ? `of ${fmtBytes(storage.limit)}` : 'Unlimited'
        }</div></div>
        <div class="stat-card"><div class="k">Uptime</div><div class="v">${fmtDuration(s.uptime)}</div><div class="s">since ${fmtDate(s.startedAt, { time: true })}</div></div>
        <div class="stat-card"><div class="k">Sessions</div><div class="v">${c.sessions}</div><div class="s">${c.enabledApps} of ${c.apps} apps enabled</div></div>
      </div>

      <div class="bento" style="gap:14px">
        <div class="widget b-span-5">
          <div class="widget-head"><span class="widget-title">${icon('fa-solid fa-server')} Server</span></div>
          <div class="kv-list">
            <div class="kv"><span class="k">Node</span><span class="v">${esc(s.node)}</span></div>
            <div class="kv"><span class="k">Platform</span><span class="v">${esc(s.platform)} ${esc(s.arch)}</span></div>
            <div class="kv"><span class="k">CPUs</span><span class="v">${s.cpus}</span></div>
            <div class="kv"><span class="k">Load</span><span class="v">${s.load.join(' / ')}</span></div>
            <div class="kv"><span class="k">Memory (RSS)</span><span class="v">${fmtBytes(s.memory.rss)}</span></div>
            <div class="kv"><span class="k">Database</span><span class="v">${fmtBytes(storage.dbSize)}</span></div>
            <div class="kv"><span class="k">Public URL</span><span class="v">${esc(overview.config.publicUrl || '—')}</span></div>
          </div>
        </div>

        <div class="widget b-span-4">
          <div class="widget-head"><span class="widget-title">${icon('fa-solid fa-hard-drive')} Storage</span></div>
          <p class="mini-stat-value" style="font-size:26px">${fmtBytes(storage.used)}</p>
          ${
            storage.limit
              ? `<div class="progress"><span style="width:${percent}%"></span></div><p class="hint">${percent}% of ${fmtBytes(
                  storage.limit
                )} used</p>`
              : `<p class="hint">Unlimited — CoolCloud takes what the machine allows.</p>`
          }
          <div class="kv-list">
            <div class="kv"><span class="k">Mode</span><span class="v">${esc(storage.mode)}</span></div>
            <div class="kv"><span class="k">Default quota</span><span class="v">${
              storage.userQuotaMb ? `${storage.userQuotaMb} MB` : 'None'
            }</span></div>
            <div class="kv"><span class="k">Account limit</span><span class="v">${
              overview.config.limits.maxUsers || 'Unlimited'
            }</span></div>
          </div>
        </div>

        <div class="widget b-span-3">
          <div class="widget-head"><span class="widget-title">${icon('fa-solid fa-clock-rotate-left')} Activity</span></div>
          <div class="stack-2">${
            overview.audit.length
              ? overview.audit
                  .slice(0, 6)
                  .map(
                    (item) => `<div class="task-line" style="border-top:0;padding:3px 0">
                      <div class="grow"><div class="tiny strong">${esc(item.action)}</div>
                      <div class="tiny dim">${esc(item.detail || '')} · ${fmtDate(item.created_at, { time: true })}</div></div>
                    </div>`
                  )
                  .join('')
              : '<p class="hint">No activity yet.</p>'
          }</div>
        </div>
      </div>

      <div class="widget">
        <div class="widget-head"><span class="widget-title">${icon('fa-solid fa-triangle-exclamation')} Recent errors</span>
          <button class="widget-link" data-goto-logs>Open logs</button></div>
        <pre class="log-box" style="max-height:200px">${esc(overview.errors || 'No errors logged.')}</pre>
      </div>
    </div>`;
    panel.querySelector('[data-goto-logs]').addEventListener('click', () => {
      section = 'logs';
      root.querySelectorAll('[data-section]').forEach((node) => node.setAttribute('aria-current', node.dataset.section === 'logs' ? 'true' : 'false'));
      render();
    });
  }

  /* ---------------------------- personalization ---------------------------- */
  function renderAppearance() {
    const cfg = overview.config;
    const brand = { ...DEFAULT_BRANDING, ...(cfg.branding || {}) };
    look = { accent: brand.accent, logo: brand.logo || '' };
    const enterprise = (cfg.edition || 'community') === 'enterprise';

    panel.innerHTML = `<form id="look-form" class="stack-4" style="max-width:820px">
      <div class="note">${icon(
        'fa-solid fa-circle-info'
      )}<span>Applied to every page and open tab when you save. The wordmark plate is derived from the accent, so the whole product changes together.</span></div>

      ${
        enterprise
          ? `<section class="widget">
        <div class="widget-head"><span class="widget-title">${icon('fa-solid fa-signature')} Wordmark</span><span class="badge accent">Enterprise</span></div>
        <div class="stack-3">
          <div class="field-row">
            <div class="field">
              <label class="label">Product name</label>
              <input class="input" name="name" value="${esc(cfg.name)}" maxlength="60" />
              <span class="hint">Browser title and sign-in heading.</span>
            </div>
            <div class="field">
              <label class="label">Word on the plate</label>
              <input class="input" name="logoWord" value="${esc(brand.logoWord)}" maxlength="12" />
              <span class="hint">Follows the C &#8734; L mark.</span>
            </div>
          </div>
          <div class="brand-preview" id="look-preview"></div>
          <p class="hint">The plate uses a darker shade of the accent, the same colour as the browser icon.</p>
        </div>
      </section>`
          : `<section class="widget">
        <div class="widget-head"><span class="widget-title">${icon('fa-solid fa-signature')} Wordmark and logo</span><span class="badge">Enterprise</span></div>
        <p class="small" style="line-height:1.65;margin:0">Community keeps the CoolCloud name and mark on every page. CoolCloud Enterprise lets you replace both with your own company wordmark and logo.</p>
        <div class="row" style="gap:8px;flex-wrap:wrap;margin-top:12px">
          <a class="btn quiet sm" href="https://openhcat.github.io/cc-appregistry/" target="_blank" rel="noopener noreferrer">${icon('fa-solid fa-arrow-up-right-from-square')} CoolCloud Enterprise</a>
        </div>
      </section>`
      }

      <section class="widget">
        <div class="widget-head"><span class="widget-title">${icon('fa-solid fa-droplet')} Accent</span></div>
        <div class="row wrap" style="gap:14px">
          <input class="color-input" type="color" name="accent" value="${esc(look.accent)}" aria-label="Accent colour" />
          <div class="swatches">
            ${ACCENTS.map(
              ([hex, name]) =>
                `<button type="button" class="swatch" data-accent="${hex}" title="${name}" aria-label="${name}" aria-pressed="${
                  hex.toLowerCase() === look.accent.toLowerCase()
                }" style="background:${hex}"></button>`
            ).join('')}
          </div>
          <span class="grow"></span>
          <button type="button" class="btn ghost sm" id="look-reset">${icon(
            'fa-solid fa-rotate-left'
          )} Reset</button>
        </div>
        <p class="hint" style="margin-top:8px">Drives buttons, links, focus rings, the active tab and the plate. Label colour is chosen for contrast.</p>
      </section>

      ${
        enterprise
          ? `<section class="widget">
        <div class="widget-head"><span class="widget-title">${icon('fa-solid fa-image')} Custom logo</span></div>
        <div class="upload-box">
          <span class="logo-seal" id="look-logo" style="width:auto;height:26px"></span>
          <span class="grow">${
            look.logo ? 'Custom image replaces the wordmark.' : 'PNG, SVG or WebP under 120 KB. Optional.'
          }</span>
          <input type="file" id="logo-file" accept="image/png,image/jpeg,image/webp,image/svg+xml" class="hidden" />
          <button type="button" class="btn quiet sm" id="logo-pick">${icon('fa-solid fa-arrow-up-from-bracket')} Choose</button>
          <button type="button" class="btn ghost sm" id="logo-clear">${icon('fa-solid fa-xmark')} Clear</button>
        </div>
        <p class="hint" style="margin-top:8px">A wide wordmark works best. The same image becomes the browser icon.</p>
      </section>`
          : ''
      }

      <div class="row" style="justify-content:flex-end">
        <button class="btn primary" type="submit">Save personalization</button>
      </div>
    </form>`;

    const form = panel.querySelector('#look-form');
    const preview = panel.querySelector('#look-preview');
    const logoSlot = panel.querySelector('#look-logo');

    const paint = () => {
      const name = form.name?.value.trim() || 'CoolCloud';
      const word = form.logoWord?.value.trim() || 'Cloud';
      if (preview) preview.style.setProperty('--brand', shade(look.accent, 0.6));
      if (preview) preview.innerHTML = `${brandLockup({ word, logo: look.logo, title: name })}
        <div style="min-width:0">
          <div class="bp-name">${esc(name)}</div>
          <div class="bp-tag">Browser title, sign-in, sidebar</div>
        </div>`;
      if (logoSlot) logoSlot.innerHTML = look.logo
        ? `<img src="${esc(look.logo)}" alt="" style="height:26px;display:block;border-radius:4px" />`
        : brandLockup({ word, title: name });
      panel.querySelectorAll('[data-accent]').forEach((node) => {
        node.setAttribute('aria-pressed', String(node.dataset.accent.toLowerCase() === look.accent.toLowerCase()));
      });
      form.accent.value = look.accent;
    };

    form.addEventListener('input', (event) => {
      if (event.target.name === 'accent') look.accent = event.target.value;
      paint();
    });
    panel.querySelectorAll('[data-accent]').forEach((node) => {
      node.addEventListener('click', () => {
        look.accent = node.dataset.accent;
        paint();
      });
    });
    panel.querySelector('#logo-pick')?.addEventListener('click', () => panel.querySelector('#logo-file').click());
    panel.querySelector('#logo-file')?.addEventListener('change', (event) => {
      const file = event.target.files?.[0];
      if (!file) return;
      if (file.size > 120000) return toast('Use an image under 120 KB', 'error');
      const reader = new FileReader();
      reader.onload = () => {
        look.logo = String(reader.result || '');
        paint();
      };
      reader.readAsDataURL(file);
    });
    panel.querySelector('#logo-clear')?.addEventListener('click', () => {
      look.logo = '';
      if (panel.querySelector('#logo-file')) panel.querySelector('#logo-file').value = '';
      paint();
    });
    panel.querySelector('#look-reset').addEventListener('click', () => {
      if (form.name) form.name.value = 'CoolCloud';
      if (form.logoWord) form.logoWord.value = DEFAULT_BRANDING.logoWord;
      look = { accent: DEFAULT_BRANDING.accent, logo: '' };
      paint();
    });

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      try {
        await api('/api/admin/config', {
          method: 'PATCH',
          body: enterprise
            ? {
                name: form.name.value.trim(),
                branding: {
                  logoWord: form.logoWord.value.trim(),
                  accent: look.accent,
                  logo: look.logo
                }
              }
            : { branding: { accent: look.accent } }
        });
        toast('Personalization saved');
        const session = await refreshSession();
        applyBranding(session.server.branding, session.server.name);
        refreshBrand();
        load();
      } catch (err) {
        toast(err.message, 'error');
      }
    });

    paint();
  }

  /* --------------------------------- users -------------------------------- */
  function renderUsers() {
    panel.innerHTML = `<div class="stack-4">
      <div class="spread">
        <p class="small muted">${users.length} account${users.length === 1 ? '' : 's'} on this server.</p>
        <button class="btn primary sm" id="add-user">${icon('fa-solid fa-user-plus')} Add user</button>
      </div>
      <div class="file-table" style="overflow:auto">
        <table class="table">
          <thead><tr><th>User</th><th>Role</th><th>Email</th><th>Sessions</th><th>Last login</th><th class="actions">Actions</th></tr></thead>
          <tbody>${users
            .map(
              (user) => `<tr data-user="${user.id}">
                <td><div class="row-tight"><span class="avatar sm">${esc(
                  (user.name || user.username)
                    .split(/\s+/)
                    .slice(0, 2)
                    .map((part) => part[0]?.toUpperCase() || '')
                    .join('')
                )}</span><div><div class="strong small">${esc(user.name)}</div>
                <div class="tiny dim">@${esc(user.username)}${user.active ? '' : ' · disabled'}</div></div></div></td>
                <td><span class="badge ${user.role === 'admin' ? 'accent' : ''}">${esc(user.role)}</span></td>
                <td class="small muted">${esc(user.email || '—')}</td>
                <td class="mono">${user.sessions}</td>
                <td class="small dim">${user.lastLogin ? fmtDate(user.lastLogin, { time: true }) : 'Never'}</td>
                <td class="actions">
                  <button class="btn ghost icon sm" data-edit title="Edit">${icon('fa-solid fa-pen')}</button>
                  <button class="btn ghost icon sm" data-revoke title="Sign out everywhere">${icon('fa-solid fa-arrow-right-from-bracket')}</button>
                  <button class="btn ghost icon sm" data-delete title="Delete">${icon('fa-solid fa-trash-can')}</button>
                </td>
              </tr>`
            )
            .join('')}</tbody>
        </table>
      </div>
    </div>`;

    panel.querySelector('#add-user').addEventListener('click', () => userModal());
    panel.querySelectorAll('[data-user]').forEach((row) => {
      const user = users.find((item) => String(item.id) === row.dataset.user);
      row.querySelector('[data-edit]').addEventListener('click', () => userModal(user));
      row.querySelector('[data-revoke]').addEventListener('click', async () => {
        await api(`/api/admin/users/${user.id}/revoke`, { method: 'POST' });
        toast('Sessions revoked');
        load();
      });
      row.querySelector('[data-delete]').addEventListener('click', async () => {
        const ok = await confirmDialog({
          title: `Delete ${user.name}?`,
          message: 'Their calendar, contacts, tasks and mail settings are removed. Files are shared and stay.'
        });
        if (!ok) return;
        try {
          await api(`/api/admin/users/${user.id}`, { method: 'DELETE' });
          toast('User deleted');
          load();
        } catch (err) {
          toast(err.message, 'error');
        }
      });
    });
  }

  async function renderTeams() {
    panel.innerHTML = '<div class="empty">Loading teams…</div>';
    let data;
    let directory;
    try {
      [data, directory] = await Promise.all([api('/api/admin/teams'), api('/api/directory')]);
    } catch (err) {
      panel.innerHTML = `<div class="empty">${esc(err.message)}</div>`;
      return;
    }
    panel.innerHTML = `<div class="stack-4">
      <div class="spread"><p class="small muted">${data.teams.length} team${data.teams.length === 1 ? '' : 's'} · folder grants are shown per team.</p></div>
      ${data.teams.length
        ? data.teams
            .map(
              (team) => `<section class="card admin-team" data-team="${team.id}">
                <div class="spread"><div><h3>${esc(team.name)}</h3><p class="small muted">Owner ${esc(team.owner)} · ${team.members.length} member${team.members.length === 1 ? '' : 's'}${team.inactiveMembers ? ` · ${team.inactiveMembers} disabled` : ''}</p></div>
                <div class="row-tight">${team.inactiveMembers ? `<button class="btn sm" data-cleanup>Remove disabled</button>` : ''}<button class="btn danger sm" data-delete-team>Delete team</button></div></div>
                <div class="stack-2" style="margin-top:12px">${team.grants.length
                  ? team.grants.map((grant) => `<div class="acl-grant"><span class="file-ico">${icon('fa-regular fa-folder')}</span><span class="grow"><span class="strong small">${esc(grant.path || 'Files')}</span><span class="tiny dim" style="display:block">${esc(grant.role)}${grant.expiresAt ? ` · expires ${fmtDate(grant.expiresAt)}` : ''}</span></span></div>`).join('')
                  : '<p class="hint">No folder grants.</p>'}</div>
                <div class="field" style="margin-top:12px"><label class="label">Members</label><div class="row-tight" style="flex-wrap:wrap">${team.members
                  .map((member) => `<span class="attachment-chip">${esc(member.name)}${member.id === team.ownerId ? '' : `<button type="button" data-remove-member="${member.id}" aria-label="Remove ${esc(member.name)}">${icon('fa-solid fa-xmark')}</button>`}</span>`)
                  .join('')}</div></div>
                <div class="row" style="gap:8px;margin-top:10px"><select class="select grow" multiple size="4" data-team-people>${directory.people
                  .filter((person) => !team.members.some((member) => member.id === person.id))
                  .map((person) => `<option value="${person.id}">${esc(person.name)}</option>`)
                  .join('')}</select><button class="btn sm" data-add-members>${icon('fa-solid fa-user-plus')} Add selected</button></div>
                ${team.members.some((member) => member.id !== team.ownerId) ? `<div class="row" style="gap:8px;margin-top:8px"><select class="select grow" multiple size="3" data-team-remove-people>${team.members
                  .filter((member) => member.id !== team.ownerId)
                  .map((member) => `<option value="${member.id}">${esc(member.name)}</option>`)
                  .join('')}</select><button class="btn ghost sm" data-remove-selected>${icon('fa-solid fa-user-minus')} Remove selected</button></div>` : ''}
              </section>`
            )
            .join('')
        : '<div class="empty">No teams yet. Create one from Files → More → Folder access.</div>'}
    </div>`;

    panel.querySelectorAll('[data-team]').forEach((card) => {
      const team = data.teams.find((item) => String(item.id) === card.dataset.team);
      card.querySelector('[data-delete-team]')?.addEventListener('click', async () => {
        const ok = await confirmDialog({ title: `Delete ${team.name}?`, message: 'Folder grants for this team are removed. Members and files stay.' });
        if (!ok) return;
        try {
          await api(`/api/teams/${team.id}`, { method: 'DELETE' });
          toast('Team deleted');
          renderTeams();
        } catch (err) {
          toast(err.message, 'error');
        }
      });
      card.querySelector('[data-cleanup]')?.addEventListener('click', async () => {
        try {
          const result = await api(`/api/admin/teams/${team.id}/cleanup`, { method: 'POST' });
          toast(`${result.removed} disabled member${result.removed === 1 ? '' : 's'} removed`);
          renderTeams();
        } catch (err) {
          toast(err.message, 'error');
        }
      });
      card.querySelector('[data-add-members]')?.addEventListener('click', async () => {
        const userIds = [...card.querySelector('[data-team-people]').selectedOptions].map((option) => Number(option.value));
        if (!userIds.length) return toast('Select at least one person', 'error');
        try {
          await api(`/api/teams/${team.id}/members`, { method: 'POST', body: { userIds } });
          toast('Members added');
          renderTeams();
        } catch (err) {
          toast(err.message, 'error');
        }
      });
      card.querySelectorAll('[data-remove-member]').forEach((node) => {
        node.addEventListener('click', async () => {
          try {
            await api(`/api/teams/${team.id}/members/${node.dataset.removeMember}`, { method: 'DELETE' });
            renderTeams();
          } catch (err) {
            toast(err.message, 'error');
          }
        });
      });
      card.querySelector('[data-remove-selected]')?.addEventListener('click', async () => {
        const ids = [...card.querySelector('[data-team-remove-people]').selectedOptions].map((option) => Number(option.value));
        if (!ids.length) return toast('Select at least one member', 'error');
        try {
          await Promise.all(ids.map((id) => api(`/api/teams/${team.id}/members/${id}`, { method: 'DELETE' })));
          toast('Members removed');
          renderTeams();
        } catch (err) {
          toast(err.message, 'error');
        }
      });
    });
  }

  function userModal(existing = null) {
    openModal({
      title: existing ? `Edit ${existing.username}` : 'Add user',
      wide: true,
      body: `<form id="user-form" class="stack-3">
        <div class="row" style="gap:10px">
          <div class="field grow"><label class="label">Username</label><input class="input" name="username" value="${esc(
            existing?.username || ''
          )}" ${existing ? 'readonly' : ''} required /></div>
          <div class="field grow"><label class="label">Display name</label><input class="input" name="name" value="${esc(
            existing?.name || ''
          )}" /></div>
        </div>
        <div class="field"><label class="label">Email</label><input class="input" type="email" name="email" value="${esc(
          existing?.email || ''
        )}" /></div>
        <div class="row" style="gap:10px">
          <div class="field grow"><label class="label">Role</label>
            <select class="select" name="role"><option value="user" ${
              existing?.role !== 'admin' ? 'selected' : ''
            }>Member</option><option value="admin" ${existing?.role === 'admin' ? 'selected' : ''}>Administrator</option></select>
          </div>
          <div class="field grow"><label class="label">Quota (MB)</label><input class="input" name="quotaMb" type="number" min="0" value="${
            existing?.quotaMb || ''
          }" placeholder="Unlimited" /></div>
        </div>
        <div class="field"><label class="label">${existing ? 'New password (optional)' : 'Password'}</label>
          <input class="input" type="password" name="password" ${existing ? '' : 'required'} minlength="8" autocomplete="new-password" />
          <p class="hint">At least 8 characters. Leave blank to keep the current password.</p></div>
        ${
          existing
            ? `<label class="check"><input type="checkbox" name="active" ${existing.active ? 'checked' : ''} /> Account can sign in</label>`
            : ''
        }
      </form>`,
      actions: [
        { label: 'Cancel', kind: 'ghost' },
        {
          label: existing ? 'Save user' : 'Create user',
          kind: 'primary',
          onClick: async ({ dialog }) => {
            const data = new FormData(dialog.querySelector('#user-form'));
            const payload = {
              username: data.get('username'),
              name: data.get('name'),
              email: data.get('email'),
              role: data.get('role'),
              quotaMb: data.get('quotaMb') ? Number(data.get('quotaMb')) : null
            };
            if (data.get('password')) payload.password = data.get('password');
            try {
              if (existing) {
                payload.active = existing ? data.get('active') === 'on' : true;
                await api(`/api/admin/users/${existing.id}`, { method: 'PATCH', body: payload });
                toast('User updated');
              } else {
                await api('/api/admin/users', { method: 'POST', body: payload });
                toast('User created');
              }
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

  /* ---------------------------------- apps -------------------------------- */
  function renderApps() {
    panel.innerHTML = `<div class="stack-4">
      <div class="spread">
        <p class="small muted">Installed apps. Core apps are always available; extras can be toggled.</p>
        <div class="row-tight">
          <button class="btn quiet sm" id="install-git">${icon('fa-solid fa-code-branch')} Install from git</button>
          <button class="btn primary sm" id="install-store">${icon('fa-solid fa-store')} Browse store</button>
        </div>
      </div>
      <div class="stack-2">
        ${apps
          .map(
            (app) => `<div class="task-row" data-app="${esc(app.id)}">
              <span class="app-icon" style="--app:var(--app-${esc(app.accent || 'files')})">${icon(app.icon)}</span>
              <div class="grow" style="min-width:0">
                <div class="strong small">${esc(app.name)} <span class="badge">${esc(app.id)}</span>${
                  app.type === 'widget' ? ' <span class="badge ok">widget</span>' : ''
                }</div>
                <div class="tiny dim truncate">${esc(app.description || 'No description')} · v${esc(app.version)}${
                  app.builtin ? ' · built-in' : ''
                }</div>
              </div>
              <button class="switch" role="switch" aria-checked="${app.enabled}" data-toggle="${esc(app.id)}" aria-label="Toggle ${esc(
                app.name
              )}"></button>
              ${
                app.builtin
                  ? ''
                  : `<button class="btn ghost icon sm" data-remove="${esc(app.id)}" aria-label="Remove">${icon(
                      'fa-solid fa-trash-can'
                    )}</button>`
              }
            </div>`
          )
          .join('')}
      </div>
    </div>`;

    panel.querySelectorAll('[data-toggle]').forEach((node) => {
      node.addEventListener('click', async () => {
        const next = node.getAttribute('aria-checked') !== 'true';
        await api(`/api/admin/apps/${encodeURIComponent(node.dataset.toggle)}/toggle`, { method: 'POST', body: { enabled: next } });
        node.setAttribute('aria-checked', String(next));
        toast(next ? 'App enabled' : 'App disabled');
        await refreshSession();
      });
    });
    panel.querySelectorAll('[data-remove]').forEach((node) => {
      node.addEventListener('click', async () => {
        const ok = await confirmDialog({ title: 'Remove app?', message: 'The app folder is deleted from this instance.' });
        if (!ok) return;
        await api(`/api/admin/apps/${encodeURIComponent(node.dataset.remove)}`, { method: 'DELETE' });
        toast('App removed');
        await refreshSession();
        load();
      });
    });
    panel.querySelector('#install-git').addEventListener('click', () => installGit());
    panel.querySelector('#install-store').addEventListener('click', () => openTab('store'));
  }

  function installGit() {
    openModal({
      title: 'Install from git',
      sub: 'The repository must have a manifest.json at its root.',
      body: `<div class="field"><label class="label">Git URL</label><input class="input" id="git-url" placeholder="https://github.com/acme/coolcloud-notes.git" /></div>
        <div class="field" style="margin-top:10px"><label class="label">Install as</label>
          <select class="select" id="git-type">
            <option value="app">App — opens in its own tab</option>
            <option value="widget">Widget — lives on the home page</option>
          </select>
        </div>
        <p class="hint" style="margin-top:8px">CoolCloud clones into the instance apps folder and validates the manifest before enabling it.</p>`,
      actions: [
        { label: 'Cancel', kind: 'ghost' },
        {
          label: 'Install',
          kind: 'primary',
          onClick: async ({ dialog }) => {
            const git = dialog.querySelector('#git-url').value.trim();
            if (!git) return false;
            try {
              const type = dialog.querySelector('#git-type').value;
              const result = await api('/api/admin/apps/install', { method: 'POST', body: { git, type } });
              toast(`${result.app.name} installed${type === 'widget' ? ' as a widget' : ''}`);
              await refreshSession();
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

  /* --------------------------------- config ------------------------------- */
  function renderConfig() {
    const cfg = overview.config;
    panel.innerHTML = `<form id="config-form" class="stack-4" style="max-width:760px">
      <div class="widget">
        <div class="widget-head"><span class="widget-title">${icon('fa-solid fa-building')} Organization</span></div>
        <div class="row" style="gap:10px">
          <div class="field grow"><label class="label">Organization name</label><input class="input" name="orgName" value="${esc(
            cfg.organization?.name || ''
          )}" placeholder="Acme Collective" /><span class="hint">Shown on the sign-in screen. Set during setup and editable here.</span></div>
          <div class="field grow"><label class="label">Domain (optional)</label><input class="input" name="orgDomain" value="${esc(
            cfg.organization?.domain || ''
          )}" placeholder="acme.example" /></div>
        </div>
      </div>

      <div class="widget">
        <div class="widget-head"><span class="widget-title">${icon('fa-solid fa-server')} Instance</span></div>
        <div class="stack-3">
          <div class="row" style="gap:10px">
            <div class="field grow"><label class="label">Server name</label><input class="input" name="name" value="${esc(cfg.name)}" /></div>
            <div class="field grow"><label class="label">Public URL</label><input class="input" name="publicUrl" value="${esc(
              cfg.publicUrl || ''
            )}" /><span class="hint">A domain, an https:// URL or a DDNS host. Guides: docs/DOMAIN-TLS-DDNS.txt</span></div>
          </div>
          <div class="row" style="gap:10px">
            <div class="field grow"><label class="label">Storage mode</label>
              <select class="select" name="storageMode">
                <option value="unlimited" ${cfg.storage.mode === 'unlimited' ? 'selected' : ''}>Unlimited</option>
                <option value="limited" ${cfg.storage.mode === 'limited' ? 'selected' : ''}>Limited</option>
              </select>
            </div>
            <div class="field grow"><label class="label">Total storage (GB)</label><input class="input" name="totalGb" type="number" min="1" value="${
              cfg.storage.totalGb || ''
            }" placeholder="Only for limited mode" /></div>
            <div class="field grow"><label class="label">Max accounts</label><input class="input" name="maxUsers" type="number" min="0" value="${
              cfg.limits.maxUsers || 0
            }" /><p class="hint">0 means unlimited.</p></div>
          </div>
        </div>
      </div>

      <div class="widget">
        <div class="widget-head"><span class="widget-title">${icon('fa-solid fa-cubes')} Features</span></div>
        <label class="check"><input type="checkbox" name="connect" ${cfg.features.connect ? 'checked' : ''} /> Connect — encrypted messaging and calls</label>
        <label class="check"><input type="checkbox" name="media" ${cfg.features.media ? 'checked' : ''} /> Media — photos and video library</label>
        <label class="check"><input type="checkbox" name="assistant" ${cfg.features.assistant ? 'checked' : ''} /> Assistant (beta) — bring your own key</label>
        <label class="check"><input type="checkbox" name="appstore" ${cfg.features.appstore ? 'checked' : ''} /> App store</label>
      </div>

      <div class="widget">
        <div class="widget-head"><span class="widget-title">${icon('fa-solid fa-file-word')} Editor & office</span></div>
        <div class="row" style="gap:10px">
          <div class="field grow"><label class="label">Office provider</label>
            <select class="select" name="officeProvider">
              <option value="none" ${cfg.editor.officeProvider === 'none' ? 'selected' : ''}>None (text editor only)</option>
              <option value="collabora" ${cfg.editor.officeProvider === 'collabora' ? 'selected' : ''}>Collabora Online</option>
              <option value="onlyoffice" ${cfg.editor.officeProvider === 'onlyoffice' ? 'selected' : ''}>OnlyOffice Docs</option>
              <option value="microsoft" ${cfg.editor.officeProvider === 'microsoft' ? 'selected' : ''}>Microsoft 365 online</option>
            </select>
          </div>
          <div class="field grow"><label class="label">Office server URL</label><input class="input" name="officeUrl" value="${esc(
            cfg.editor.officeUrl || ''
          )}" placeholder="http://localhost:9980" /></div>
        </div>
        <label class="check" style="margin-top:10px"><input type="checkbox" name="autoHost" ${
          cfg.editor.autoHost !== false ? 'checked' : ''
        } /> Host the office server on this machine — CoolCloud starts it when needed</label>
        <div class="row" style="margin-top:10px">
          <button class="btn quiet sm" type="button" id="provision">${icon('fa-brands fa-docker')} Start container</button>
          <button class="btn danger sm" type="button" id="office-delete">${icon('fa-solid fa-trash-can')} Delete office server</button>
          <span class="grow"></span>
          <span class="hint" id="office-status">Checking…</span>
        </div>
        <pre class="log-box hidden" id="provision-log" style="margin-top:10px"></pre>
      </div>

      <div class="row" style="justify-content:flex-end"><button class="btn primary" type="submit">Save configuration</button></div>
    </form>`;

    panel.querySelector('#provision').addEventListener('click', async () => {
      const form = panel.querySelector('#config-form');
      const provider = form.officeProvider.value;
      if (!['collabora', 'onlyoffice'].includes(provider)) return toast('Choose Collabora or OnlyOffice first', 'error');
      const logBox = panel.querySelector('#provision-log');
      logBox.classList.remove('hidden');
      logBox.textContent = 'Pulling the container image. This can take a few minutes…';
      try {
        const result = await api('/api/admin/office/provision', { method: 'POST', body: { provider } });
        logBox.textContent = result.output || (result.ok ? 'Container started.' : 'Provisioning failed.');
        if (result.ok) {
          toast('Office server started');
          form.officeUrl.value = result.url || '';
          load();
        } else {
          toast(result.needsDocker ? 'Docker is not installed' : 'Provisioning failed', 'error');
        }
      } catch (err) {
        logBox.textContent = err.message;
        toast(err.message, 'error');
      }
    });

    const statusEl = panel.querySelector('#office-status');
    const describe = (info) => {
      if (!info || info.provider === 'none') return 'No office server is hosted.';
      const state = info.ready ? 'running' : info.running ? 'starting' : 'stopped';
      return `${info.provider === 'collabora' ? 'Collabora Online' : info.provider} · ${state} · ${info.url || 'no URL'}`;
    };
    api('/api/admin/office')
      .then((info) => {
        statusEl.textContent = describe(info);
      })
      .catch(() => {
        statusEl.textContent = 'Status unavailable';
      });

    panel.querySelector('#office-delete').addEventListener('click', async () => {
      const ok = await confirmDialog({
        title: 'Delete the office server?',
        message:
          'The office container and its compose file are removed and office files go back to download-only. Your documents in Files are not touched.',
        confirmLabel: 'Delete'
      });
      if (!ok) return;
      const logBox = panel.querySelector('#provision-log');
      logBox.classList.remove('hidden');
      logBox.textContent = 'Stopping and removing the container…';
      try {
        const result = await api('/api/admin/office', { method: 'DELETE' });
        logBox.textContent = result.output || 'Office server deleted.';
        statusEl.textContent = 'No office server is hosted.';
        toast('Office server deleted');
        load();
      } catch (err) {
        logBox.textContent = err.message;
        toast(err.message, 'error');
      }
    });

    panel.querySelector('#config-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.target;
      try {
        await api('/api/admin/config', {
          method: 'PATCH',
          body: {
            name: form.name.value,
            publicUrl: form.publicUrl.value,
            organization: { name: form.orgName.value, domain: form.orgDomain.value },
            storage: {
              mode: form.storageMode.value,
              totalGb: form.totalGb.value ? Number(form.totalGb.value) : null
            },
            limits: { maxUsers: Number(form.maxUsers.value || 0) },
            features: {
              connect: form.connect.checked,
              media: form.media.checked,
              assistant: form.assistant.checked,
              appstore: form.appstore.checked
            },
            editor: {
              officeProvider: form.officeProvider.value,
              officeUrl: form.officeUrl.value,
              autoHost: form.autoHost.checked
            }
          }
        });
        toast('Configuration saved');
        await refreshSession();
        load();
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  }

  /* ---------------------------------- logs -------------------------------- */
  function renderBackup() {
    panel.innerHTML = `<div class="stack-4">
      <div class="widget">
        <div class="widget-head"><span class="widget-title">${icon('fa-solid fa-database')} Server backup</span><span class="badge">${fmtBytes(overview.storage.dbSize)} database</span></div>
        <p class="small dim">One ZIP with the SQLite database and every stored file. Keep it somewhere outside this machine. Downloads are audit-logged.</p>
        <div class="row" style="margin-top:12px"><a class="btn primary sm" href="/api/admin/backup" download>${icon('fa-solid fa-download')} Download backup</a><span class="hint">Large instances can take a minute to assemble.</span></div>
      </div>
      <div class="widget">
        <div class="widget-head"><span class="widget-title">${icon('fa-solid fa-hard-drive')} Storage by account</span></div>
        <div id="storage-usage"><div class="skeleton" style="height:120px"></div></div>
      </div>
    </div>`;
    api('/api/admin/storage')
      .then((data) => {
        const rows = data.users || [];
        const total = rows.reduce((sum, row) => sum + (Number(row.used) || 0), 0);
        panel.querySelector('#storage-usage').innerHTML = `<div class="small dim" style="margin-bottom:8px">${fmtBytes(total)} used across ${rows.length} account${rows.length === 1 ? '' : 's'}.</div>
          <div class="stack-2">${rows
            .sort((a, b) => (Number(b.used) || 0) - (Number(a.used) || 0))
            .map((row) => {
              const bytes = Number(row.used) || 0;
              const quota = row.quotaMb ? row.quotaMb * 1024 * 1024 : 0;
              const percent = quota ? Math.min(100, Math.round((bytes / quota) * 100)) : 0;
              return `<div class="storage-row"><div class="spread"><span class="small strong">${esc(row.name || row.username)}</span><span class="tiny dim">${fmtBytes(bytes)}${quota ? ` of ${fmtBytes(quota)}` : ''}</span></div>
                ${quota ? `<div class="progress"><span style="width:${percent}%"></span></div>` : ''}</div>`;
            })
            .join('') || '<p class="hint">No accounts yet.</p>'}</div>`;
      })
      .catch((err) => {
        panel.querySelector('#storage-usage').innerHTML = `<p class="hint">${esc(err.message)}</p>`;
      });
  }

  function renderAudit() {
    panel.innerHTML = `<div class="stack-3">
      <form class="row" id="audit-filters" style="gap:8px">
        <input class="input" name="action" placeholder="Filter action (login, file, backup…)" style="max-width:260px" />
        <input class="input" name="actor" placeholder="User id or detail" style="max-width:220px" />
        <button class="btn quiet sm" type="submit">${icon('fa-solid fa-filter')} Filter</button>
        <span class="grow"></span><button class="btn ghost sm" type="reset" id="audit-reset">Clear</button>
      </form>
      <div class="file-table" style="overflow:auto"><table class="table">
        <thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Detail</th><th>IP</th></tr></thead>
        <tbody id="audit-body"><tr><td colspan="5"><div class="skeleton" style="height:80px"></div></td></tr></tbody>
      </table></div>
    </div>`;
    const body = panel.querySelector('#audit-body');
    const fetchAudit = async () => {
      const form = panel.querySelector('#audit-filters');
      const params = new URLSearchParams({ limit: '250' });
      if (form.action.value.trim()) params.set('action', form.action.value.trim());
      if (form.actor.value.trim()) params.set('actor', form.actor.value.trim());
      try {
        const data = await api(`/api/admin/audit?${params}`);
        body.innerHTML = data.items.length
          ? data.items
              .map(
                (item) => `<tr><td class="small dim">${fmtDate(item.createdAt, { time: true })}</td>
                  <td class="mono small">${item.actorId || '—'}</td><td><span class="badge">${esc(item.action)}</span></td>
                  <td class="small">${esc(item.detail || '')}</td><td class="mono tiny dim">${esc(item.ip || '')}</td></tr>`
              )
              .join('')
          : '<tr><td colspan="5"><p class="hint">No matching activity.</p></td></tr>';
      } catch (err) {
        body.innerHTML = `<tr><td colspan="5"><p class="hint">${esc(err.message)}</p></td></tr>`;
      }
    };
    panel.querySelector('#audit-filters').addEventListener('submit', (event) => {
      event.preventDefault();
      fetchAudit();
    });
    panel.querySelector('#audit-reset').addEventListener('click', () => setTimeout(fetchAudit, 0));
    fetchAudit();
  }

  function renderLogs() {
    panel.innerHTML = `<div class="stack-3">
      <div class="row">
        <div class="segmented" id="log-picker">
          <button data-file="error" aria-selected="true">Errors</button>
          <button data-file="access" aria-selected="false">Access</button>
        </div>
        <span class="grow"></span>
        <button class="btn quiet sm" id="reload-logs">${icon('fa-solid fa-rotate')} Refresh</button>
      </div>
      <pre class="log-box" id="log-text" style="max-height:520px">Loading…</pre>
    </div>`;
    let file = 'error';
    const box = panel.querySelector('#log-text');
    const fetchLogs = async () => {
      try {
        const data = await api(`/api/admin/logs?file=${file}&lines=400`);
        box.textContent = data.text || 'Nothing logged yet.';
      } catch (err) {
        box.textContent = err.message;
      }
    };
    panel.querySelector('#log-picker').addEventListener('click', (event) => {
      const button = event.target.closest('[data-file]');
      if (!button) return;
      file = button.dataset.file;
      panel.querySelectorAll('[data-file]').forEach((node) => node.setAttribute('aria-selected', node === button ? 'true' : 'false'));
      fetchLogs();
    });
    panel.querySelector('#reload-logs').addEventListener('click', fetchLogs);
    fetchLogs();
  }

  load();
}
