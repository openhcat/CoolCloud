import { DEFAULT_BRANDING, brandLockup, esc, icon, state } from '../core.js';

export function renderLogin(root, onSuccess) {
  const branding = { ...DEFAULT_BRANDING, ...(state.branding || {}) };
  const name = state.server?.name || 'CoolCloud';
  const organization = state.server?.organization?.name || '';

  root.innerHTML = `<div class="login-wrap">
    <aside class="login-aside">
      <div class="brand">
        ${brandLockup({ word: branding.logoWord, logo: branding.logo, title: name })}
      </div>
      <div class="stack-6">
        <p class="login-quote">Your cloud, your files, your rules.</p>
        <p class="login-quote-meta">
          Files, calendar, mail, contacts, conversations and documents — on your own machine, under your own accounts.${
            organization ? ` ${esc(organization)} runs this instance.` : ''
          }
        </p>
      </div>
      <div class="login-apps">
        <span class="login-app-chip">${icon('fa-solid fa-folder-open')} Files</span>
        <span class="login-app-chip">${icon('fa-solid fa-calendar')} Calendar</span>
        <span class="login-app-chip">${icon('fa-regular fa-envelope')} Mail</span>
        <span class="login-app-chip">${icon('fa-regular fa-comments')} Connect</span>
        <span class="login-app-chip">${icon('fa-solid fa-list-check')} Tasks</span>
      </div>
    </aside>

    <main class="login-main">
      <form class="login-card" id="login-form" autocomplete="on">
        <div class="stack-2">
          <h1>Sign in</h1>
          <p class="muted small">${
            organization ? `Sign in to ${esc(organization)}.` : 'Use the account your administrator created.'
          }</p>
        </div>
        <div class="field">
          <label class="label" for="username">Username</label>
          <input class="input" id="username" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" required />
        </div>
        <div class="field">
          <label class="label" for="password">Password</label>
          <input class="input" id="password" name="password" type="password" autocomplete="current-password" required />
        </div>
        <p class="login-error hidden" id="login-error"></p>
        <button class="btn primary lg block" type="submit" id="login-btn">Sign in</button>
        <p class="hint" style="text-align:center">Self-hosted. Nothing leaves this machine unless you connect it.</p>
      </form>
    </main>
  </div>`;

  const form = root.querySelector('#login-form');
  const error = root.querySelector('#login-error');
  const button = root.querySelector('#login-btn');
  let pending = '';

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    error.classList.add('hidden');
    button.disabled = true;
    button.innerHTML = '<span class="spinner"></span> Signing in';
    try {
      if (pending) {
        const response = await fetch('/api/auth/totp', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pending, code: form.code?.value || '' })
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || 'That code is not correct');
        const session = await fetch('/api/auth/session', { credentials: 'same-origin' }).then((r) => r.json());
        onSuccess(session);
        return;
      }
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: form.username.value.trim(),
          password: form.password.value
        })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Could not sign in');
      if (data.totpRequired) {
        pending = data.pending;
        form.username.closest('.field').classList.add('hidden');
        form.password.closest('.field').classList.add('hidden');
        const field = document.createElement('div');
        field.className = 'field';
        field.innerHTML = '<label class="label" for="code">Authenticator code</label><input class="input" id="code" name="code" inputmode="numeric" autocomplete="one-time-code" placeholder="000000" maxlength="9" required /><p class="hint">Enter the 6-digit code, or a backup code.</p>';
        form.insertBefore(field, error);
        button.disabled = false;
        button.textContent = 'Verify code';
        form.code.focus();
        return;
      }
      const session = await fetch('/api/auth/session', { credentials: 'same-origin' }).then((r) => r.json());
      onSuccess(session);
    } catch (err) {
      error.textContent = err.message;
      error.classList.remove('hidden');
      button.disabled = false;
      button.textContent = pending ? 'Verify code' : 'Sign in';
      (form.code || form.password).focus();
      form.password.select?.();
    }
  });

  root.querySelector('#username').focus();
}
