import { api, applyTheme, esc, fmtDate, icon, initials, openModal, readTheme, state, toast } from '../core.js';
import { applySidebarPrefs, openTab } from '../shell.js';

export default function mount(root, ctx) {
  const user = state.user;
  const weather = user.prefs?.weather || {};

  root.innerHTML = `<div class="page">
    <header class="page-head">
      <div>
        <h1 class="page-title">Me</h1>
        <p class="page-sub">Your profile and how CoolCloud looks for you.</p>
      </div>
    </header>

    <div class="profile-grid">
      <section class="widget" style="gap:16px">
        <div class="row" style="gap:14px">
          <span class="avatar xl">${esc(initials(user.name || user.username))}</span>
          <div class="grow" style="min-width:0">
            <h2 style="font-size:18px">${esc(user.name || user.username)}</h2>
            <p class="small dim">@${esc(user.username)}</p>
            <span class="badge accent" style="margin-top:6px">${user.role === 'admin' ? 'Administrator' : 'Member'}</span>
          </div>
        </div>
        <div class="kv-list">
          <div class="kv"><span class="k">Email</span><span class="v">${esc(user.email || '—')}</span></div>
          <div class="kv"><span class="k">Joined</span><span class="v">${fmtDate(user.createdAt)}</span></div>
          <div class="kv"><span class="k">Server</span><span class="v">${esc(state.server?.name || 'CoolCloud')}</span></div>
          <div class="kv"><span class="k">Storage</span><span class="v">${
            state.server?.storage?.mode === 'unlimited'
              ? 'Unlimited'
              : `${esc(String(state.server?.storage?.totalGb || '—'))} GB`
          }</span></div>
        </div>
        ${user.role === 'admin' ? `<button class="btn sm" id="to-admin">${icon('fa-solid fa-sliders')} Open admin</button>` : ''}
      </section>

      <div class="stack-4">
        <section class="widget">
          <div class="widget-head"><span class="widget-title">${icon('fa-regular fa-user')} Profile</span></div>
          <form id="profile-form" class="stack-3">
            <div class="field"><label class="label">Display name</label><input class="input" name="name" value="${esc(user.name || '')}" /></div>
            <div class="field"><label class="label">Email</label><input class="input" type="email" name="email" value="${esc(user.email || '')}" /></div>
            <div class="row" style="justify-content:flex-end"><button class="btn primary sm" type="submit">Save profile</button></div>
          </form>
        </section>

        <section class="widget">
          <div class="widget-head"><span class="widget-title">${icon('fa-regular fa-sun')} Appearance</span></div>
          <div class="pref-row">
            <div><div class="pref-label">Theme</div><div class="pref-hint">Applies to this browser only.</div></div>
            <div class="segmented" id="theme-picker">
              <button data-theme="light" aria-selected="${readTheme() === 'light'}">Light</button>
              <button data-theme="dark" aria-selected="${readTheme() === 'dark'}">Dark</button>
            </div>
          </div>
          <div class="pref-row">
            <div><div class="pref-label">Weather on your dashboard</div><div class="pref-hint" id="weather-hint">${weather.lat ? esc(weather.label || 'Location set') : 'No location set'}</div></div>
            <div class="row-tight">
              <button class="btn sm" id="locate">${icon('fa-solid fa-location-dot')} Use my location</button>
            </div>
          </div>
          <div class="row" style="gap:8px;margin-top:6px">
            <input class="input" id="weather-label" placeholder="Label (Home)" value="${esc(weather.label || '')}" style="max-width:150px" />
            <input class="input" id="weather-lat" placeholder="Latitude" value="${esc(weather.lat ?? '')}" style="max-width:120px" />
            <input class="input" id="weather-lon" placeholder="Longitude" value="${esc(weather.lon ?? '')}" style="max-width:120px" />
            <button class="btn quiet sm" id="save-weather">Save</button>
          </div>
          <div class="pref-row" style="margin-top:12px;border-top:1px solid var(--border);padding-top:12px">
            <div><div class="pref-label">Home wallpaper</div><div class="pref-hint" id="wallpaper-hint">${user.prefs?.wallpaper ? 'Custom image set' : 'Default gradient'}</div></div>
            <div class="row-tight">
              <input type="file" id="wallpaper-file" accept="image/png,image/jpeg,image/webp" hidden />
              <button class="btn sm" id="wallpaper-pick">${icon('fa-regular fa-image')} Choose</button>
              <button class="btn ghost sm" id="wallpaper-clear">${icon('fa-solid fa-xmark')} Clear</button>
            </div>
          </div>
        </section>

        <section class="widget">
          <div class="widget-head"><span class="widget-title">${icon('fa-solid fa-table-columns')} Sidebar &amp; edition</span></div>
          <div class="stack-3">
            <label class="check"><input type="checkbox" data-sidebar-pref="railDefault" ${user.prefs?.railDefault === false ? '' : 'checked'} />
              <span><span class="strong small">Keep the sidebar minimized</span><span class="tiny dim" style="display:block">It opens while you hover, and you can pin it open from the top bar.</span></span></label>
            <label class="check"><input type="checkbox" data-sidebar-pref="railHover" ${user.prefs?.railHover === false ? '' : 'checked'} />
              <span><span class="strong small">Expand on hover</span><span class="tiny dim" style="display:block">Show labels and the edition badge when the pointer is over the sidebar.</span></span></label>
            <label class="check"><input type="checkbox" data-sidebar-pref="editionBadge" ${user.prefs?.editionBadge === false ? '' : 'checked'} />
              <span><span class="strong small">Show the Community/Enterprise badge</span><span class="tiny dim" style="display:block">Links to the Enterprise page for more apps.</span></span></label>
          </div>
        </section>

        <section class="widget">
          <div class="widget-head"><span class="widget-title">${icon('fa-solid fa-lock')} Password</span></div>
          <form id="password-form" class="stack-3">
            <div class="field"><label class="label">Current password</label><input class="input" type="password" name="current" required autocomplete="current-password" /></div>
            <div class="field"><label class="label">New password</label><input class="input" type="password" name="next" required minlength="8" autocomplete="new-password" /></div>
            <div class="row" style="justify-content:flex-end"><button class="btn primary sm" type="submit">Change password</button></div>
          </form>
        </section>

        <section class="widget">
          <div class="widget-head"><span class="widget-title">${icon('fa-solid fa-shield-halved')} Two-factor authentication</span><span class="badge" id="totp-badge">Checking…</span></div>
          <p class="small dim" id="totp-copy">Add a second step to sign-in with an authenticator app.</p>
          <div class="row" style="margin-top:10px"><button class="btn sm" id="totp-action">${icon('fa-solid fa-key')} Set up 2FA</button></div>
        </section>

        <section class="widget">
          <div class="widget-head"><span class="widget-title">${icon('fa-solid fa-display')} Active sessions</span></div>
          <div id="session-list" class="stack-2"><div class="skeleton" style="height:38px"></div></div>
        </section>
      </div>
    </div>
  </div>`;

  root.querySelector('#to-admin')?.addEventListener('click', () => openTab('admin'));

  root.querySelectorAll('[data-sidebar-pref]').forEach((input) =>
    input.addEventListener('change', async () => {
      const prefs = {};
      root.querySelectorAll('[data-sidebar-pref]').forEach((node) => {
        prefs[node.dataset.sidebarPref] = node.checked;
      });
      try {
        const result = await api('/api/me', { method: 'PATCH', body: { prefs } });
        state.user = result.user;
        ctx.user = result.user;
        applySidebarPrefs();
        toast('Sidebar preference saved');
      } catch (err) {
        toast(err.message, 'error');
      }
    })
  );
  let security = null;

  root.querySelector('#profile-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = new FormData(event.target);
    try {
      const result = await api('/api/me', { method: 'PATCH', body: { name: data.get('name'), email: data.get('email') } });
      state.user = result.user;
      ctx.user = result.user;
      toast('Profile saved');
      document.querySelector('.side-user-name').textContent = result.user.name || result.user.username;
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  root.querySelector('#theme-picker').addEventListener('click', (event) => {
    const button = event.target.closest('[data-theme]');
    if (!button) return;
    applyTheme(button.dataset.theme);
    root.querySelectorAll('[data-theme]').forEach((node) => node.setAttribute('aria-selected', node === button ? 'true' : 'false'));
    const toggle = document.querySelector('[data-theme-toggle]');
    if (toggle) toggle.innerHTML = icon(button.dataset.theme === 'dark' ? 'fa-regular fa-sun' : 'fa-regular fa-moon');
  });

  root.querySelector('#locate').addEventListener('click', () => {
    if (!navigator.geolocation) return toast('Geolocation is not available here', 'error');
    navigator.geolocation.getCurrentPosition(
      async (position) => {
        await saveWeather({
          lat: Number(position.coords.latitude.toFixed(3)),
          lon: Number(position.coords.longitude.toFixed(3)),
          label: 'Current location'
        });
      },
      () => toast('Could not read your location. Enter coordinates instead.', 'error')
    );
  });

  root.querySelector('#save-weather').addEventListener('click', () => {
    const lat = Number(root.querySelector('#weather-lat').value);
    const lon = Number(root.querySelector('#weather-lon').value);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return toast('Enter valid coordinates', 'error');
    saveWeather({ lat, lon, label: root.querySelector('#weather-label').value || 'Local' });
  });

  async function saveWeather(payload) {
    try {
      const result = await api('/api/me', { method: 'PATCH', body: { prefs: { weather: payload } } });
      state.user = result.user;
      ctx.user = result.user;
      const hint = root.querySelector('#weather-hint');
      if (hint) hint.textContent = payload.lat ? (payload.label || 'Location set') : 'No location set';
      toast('Weather location saved');
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  root.querySelector('#password-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = new FormData(event.target);
    try {
      await api('/api/auth/password', { method: 'POST', body: { current: data.get('current'), next: data.get('next') } });
      event.target.reset();
      toast('Password changed');
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  root.querySelector('#wallpaper-pick').addEventListener('click', () => root.querySelector('#wallpaper-file').click());
  root.querySelector('#wallpaper-file').addEventListener('change', (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (file.size > 600 * 1024) return toast('Choose an image under 600 KB', 'error');
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const result = await api('/api/me', { method: 'PATCH', body: { prefs: { wallpaper: String(reader.result) } } });
        state.user = result.user;
        ctx.user = result.user;
        root.querySelector('#wallpaper-hint').textContent = 'Custom image set';
        toast('Wallpaper saved for Home');
      } catch (err) {
        toast(err.message, 'error');
      }
    };
    reader.readAsDataURL(file);
    event.target.value = '';
  });
  root.querySelector('#wallpaper-clear').addEventListener('click', async () => {
    try {
      const result = await api('/api/me', { method: 'PATCH', body: { prefs: { wallpaper: '' } } });
      state.user = result.user;
      ctx.user = result.user;
      root.querySelector('#wallpaper-hint').textContent = 'Default gradient';
      toast('Wallpaper cleared');
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  async function loadSecurity() {
    try {
      security = await api('/api/security');
      const enabled = security.totp.enabled;
      root.querySelector('#totp-badge').textContent = enabled ? 'On' : 'Off';
      root.querySelector('#totp-badge').classList.toggle('ok', enabled);
      root.querySelector('#totp-copy').textContent = enabled
        ? 'Sign-in requires a 6-digit code from your authenticator app.'
        : 'Add a second step to sign-in with an authenticator app.';
      root.querySelector('#totp-action').innerHTML = enabled
        ? `${icon('fa-solid fa-shield')} Turn off 2FA`
        : `${icon('fa-solid fa-key')} Set up 2FA`;
      const sessions = security.sessions || [];
      root.querySelector('#session-list').innerHTML = sessions.length
        ? sessions
            .map(
              (session) => `<div class="session-row">
                <div class="grow"><div class="session-label">${esc(session.label || 'Browser')}${session.current ? ' <span class="badge ok">This device</span>' : ''}</div>
                <div class="tiny dim">${esc(session.ip || 'Unknown address')} · ${fmtDate(session.createdAt, { time: true })}</div></div>
                ${session.current ? '' : `<button class="btn ghost sm" data-revoke="${esc(session.id)}">Sign out</button>`}
              </div>`
            )
            .join('')
        : '<p class="hint">No active sessions.</p>';
      root.querySelectorAll('[data-revoke]').forEach((node) => {
        node.addEventListener('click', async () => {
          try {
            await api(`/api/security/sessions/${node.dataset.revoke}`, { method: 'DELETE' });
            toast('Session signed out');
            loadSecurity();
          } catch (err) {
            toast(err.message, 'error');
          }
        });
      });
    } catch (err) {
      root.querySelector('#totp-badge').textContent = 'Unavailable';
      root.querySelector('#session-list').innerHTML = `<p class="hint">${esc(err.message)}</p>`;
    }
  }

  root.querySelector('#totp-action').addEventListener('click', () => {
    if (security?.totp?.enabled) {
      openModal({
        title: 'Turn off two-factor authentication',
        body: `<div class="stack-3">
          <div class="field"><label class="label">Password</label><input class="input" type="password" id="totp-password" autocomplete="current-password" /></div>
          <div class="field"><label class="label">Authenticator or backup code</label><input class="input" id="totp-code" inputmode="numeric" autocomplete="one-time-code" placeholder="123456" /></div>
        </div>`,
        actions: [
          { label: 'Cancel', kind: 'ghost' },
          {
            label: 'Turn off',
            kind: 'danger',
            onClick: async ({ dialog }) => {
              try {
                await api('/api/security/totp/disable', {
                  method: 'POST',
                  body: { password: dialog.querySelector('#totp-password').value, code: dialog.querySelector('#totp-code').value }
                });
                toast('Two-factor authentication is off');
                loadSecurity();
              } catch (err) {
                toast(err.message, 'error');
                return false;
              }
            }
          }
        ]
      });
      return;
    }
    openModal({
      title: 'Set up two-factor authentication',
      sub: 'Confirm your password, then scan the secret with your authenticator app.',
      body: `<div class="field"><label class="label">Current password</label><input class="input" type="password" id="totp-password" autocomplete="current-password" /></div>`,
      actions: [
        { label: 'Cancel', kind: 'ghost' },
        {
          label: 'Continue',
          kind: 'primary',
          onClick: async ({ dialog }) => {
            try {
              const setup = await api('/api/security/totp/setup', {
                method: 'POST',
                body: { password: dialog.querySelector('#totp-password').value }
              });
              showTotpSetup(setup);
            } catch (err) {
              toast(err.message, 'error');
              return false;
            }
          }
        }
      ]
    });
  });

  function showTotpSetup(setup) {
    openModal({
      title: 'Verify your authenticator',
      sub: 'Store the backup codes somewhere safe. Each one works once.',
      body: `<div class="stack-3">
        <div class="field"><label class="label">Secret key</label><code class="totp-secret">${esc(setup.secret)}</code>
          <a class="tiny" href="${esc(setup.otpauth)}">Open in authenticator app</a></div>
        <div class="field"><label class="label">Backup codes</label><div class="backup-codes">${setup.backupCodes
          .map((code) => `<code>${esc(code)}</code>`)
          .join('')}</div></div>
        <div class="field"><label class="label">6-digit code</label><input class="input" id="totp-verify" inputmode="numeric" autocomplete="one-time-code" placeholder="123456" /></div>
      </div>`,
      actions: [
        { label: 'Cancel', kind: 'ghost' },
        {
          label: 'Turn on 2FA',
          kind: 'primary',
          onClick: async ({ dialog }) => {
            try {
              await api('/api/security/totp/enable', { method: 'POST', body: { code: dialog.querySelector('#totp-verify').value } });
              toast('Two-factor authentication is on');
              loadSecurity();
            } catch (err) {
              toast(err.message, 'error');
              return false;
            }
          }
        }
      ]
    });
  }

  loadSecurity();
}
